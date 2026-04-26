/**
 * query.test.ts — Tests for the NL→FTS5 query planner and DB query functions.
 *
 * Pure-function tests (extractTerms, buildFtsQuery) need no database.
 * Integration tests use an in-memory SQLite seeded with fixture data.
 *
 * DB_PATH must be set BEFORE db.ts is first imported; dynamic imports
 * ensure this env-var assignment wins over Bun's static-import hoisting.
 */
import { beforeAll, describe, expect, test } from "bun:test";

// Set BEFORE any import that transitively loads db.ts
process.env.DB_PATH = ":memory:";

// Dynamic imports so the env-var assignment above is visible to db.ts
const { db, initDb, getDbStats, checkSchemaVersion, SCHEMA_VERSION, DB_PATH } = await import("./db.ts");

// Hard guard: if some other test file imported db.ts before us with a real
// path, the singleton will be pointing at the project's ros-help.db and the
// DELETEs in beforeAll() below would wipe it. Fail fast with a clear message
// so this can never silently ship an empty DB again (release v0.7.6 regression).
if (DB_PATH !== ":memory:") {
  throw new Error(
    `query.test.ts: DB singleton is at "${DB_PATH}" — expected ":memory:". ` +
      `Another test file imported db.ts before this one without setting DB_PATH=:memory:. ` +
      `Refusing to run because beforeAll() would DELETE FROM real tables.`,
  );
}
const {
  extractTerms,
  buildFtsQuery,
  exportDevicesCsv,
  exportDeviceTestsCsv,
  searchPages,
  getPage,
  lookupProperty,
  browseCommands,
  searchCallouts,
  searchChangelogs,
  checkCommandVersions,
  diffCommandVersions,
  searchDevices,
  searchDeviceTests,
  getTestResultMeta,
  normalizeDeviceQuery,
  truncateDeviceTestResultsPrefer512,
  searchVideos,
  searchDude,
  getDudePage,
  listSkills,
  getSkill,
  getSkillReference,
  lookupGlossary,
  listGlossary,
  KNOWN_TOPICS,
  searchAll,
  explainCommand,
} = await import("./query.ts");
const { parseChangelog } = await import("./extract-changelogs.ts");
const { parseVtt, segmentTranscript } = await import("./extract-videos.ts");

// ---------------------------------------------------------------------------
// Fixtures: one "DHCP Server" page + one "Firewall Filter" page
// ---------------------------------------------------------------------------

beforeAll(() => {
  initDb();

  // Keep this test deterministic even if another test file initialized db.ts first
  // against a non-empty DB (e.g., workflow-generated ros-help.db).
  db.run("PRAGMA foreign_keys=OFF;");
  db.run("DELETE FROM skill_references");
  db.run("DELETE FROM skills");
  db.run("DELETE FROM dude_images");
  db.run("DELETE FROM dude_pages");
  db.run("DELETE FROM video_segments");
  db.run("DELETE FROM videos");
  db.run("DELETE FROM changelogs");
  db.run("DELETE FROM device_test_results");
  db.run("DELETE FROM devices");
  db.run("DELETE FROM schema_node_presence");
  db.run("DELETE FROM schema_nodes");
  db.run("DELETE FROM command_versions");
  db.run("DELETE FROM commands");
  db.run("DELETE FROM ros_versions");
  db.run("DELETE FROM sections");
  db.run("DELETE FROM callouts");
  db.run("DELETE FROM properties");
  db.run("DELETE FROM pages");
  // Reset autoincrement counters so fixture IDs are deterministic
  db.run("DELETE FROM sqlite_sequence");
  db.run("PRAGMA foreign_keys=ON;");

  db.run(`INSERT INTO pages
    (id, slug, title, path, depth, parent_id, url, text, code, code_lang,
     author, last_updated, word_count, code_lines, html_file)
    VALUES
    (1, 'DHCP', 'DHCP Server', 'RouterOS > IP > DHCP Server', 2, NULL,
     'https://help.mikrotik.com/docs/spaces/ROS/pages/1/DHCP',
     'DHCP server assigns IP addresses to clients on the local network. Configure lease time and address pool.',
     '/ip dhcp-server add name=myserver', NULL, NULL, NULL, 20, 1, 'test.html')`);

  db.run(`INSERT INTO pages
    (id, slug, title, path, depth, parent_id, url, text, code, code_lang,
     author, last_updated, word_count, code_lines, html_file)
    VALUES
    (2, 'Firewall-Filter', 'Firewall Filter', 'RouterOS > IP > Firewall', 2, NULL,
     'https://help.mikrotik.com/docs/spaces/ROS/pages/2/Firewall-Filter',
     'Firewall filter rules control packet forwarding and processing. Add chains and actions.',
     '/ip firewall filter add chain=forward action=drop', NULL, NULL, NULL, 15, 1, 'test2.html')`);

  db.run(`INSERT INTO callouts (id, page_id, type, content, sort_order)
    VALUES (1, 1, 'Note', 'DHCP lease time defaults to 10 minutes on a fresh install', 0)`);

  db.run(`INSERT INTO callouts (id, page_id, type, content, sort_order)
    VALUES (2, 2, 'Warning', 'Dropping all forward traffic will break routing', 0)`);

  db.run(`INSERT INTO properties
    (id, page_id, name, type, default_val, description, section, sort_order)
    VALUES (1, 1, 'lease-time', 'time', '10m', 'Lease duration for DHCP clients', NULL, 0)`);

  db.run(`INSERT INTO properties
    (id, page_id, name, type, default_val, description, section, sort_order)
    VALUES (2, 1, 'address-pool', 'string', '', 'Name of the address pool to use', NULL, 1)`);

  db.run(`INSERT INTO properties
    (id, page_id, name, type, default_val, description, section, sort_order)
    VALUES (3, 2, 'chain', 'string', '', 'Firewall chain to match or create', NULL, 0)`);

  db.run(`INSERT INTO properties
    (id, page_id, name, type, default_val, description, section, sort_order)
    VALUES (4, 2, 'action', 'string', 'accept', 'Action to take when a packet matches the rule', NULL, 1)`);

  db.run(`INSERT INTO ros_versions (version, arch, channel, extra_packages, extracted_at)
    VALUES ('7.22', 'x86', 'stable', 0, '2024-01-01T00:00:00Z')`);
  db.run(`INSERT INTO ros_versions (version, arch, channel, extra_packages, extracted_at)
    VALUES ('7.9', 'x86', 'stable', 0, '2023-01-01T00:00:00Z')`);
  db.run(`INSERT INTO ros_versions (version, arch, channel, extra_packages, extracted_at)
    VALUES ('7.10.2', 'x86', 'stable', 0, '2023-06-01T00:00:00Z')`);

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (1, '/ip', 'ip', 'dir', NULL, NULL, 'IP menu', '7.22')`);

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (2, '/ip/dhcp-server', 'dhcp-server', 'dir', '/ip', 1, 'DHCP Server configuration', '7.22')`);

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (3, '/ip/firewall', 'firewall', 'dir', '/ip', 2, 'Firewall configuration', '7.22')`);

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (4, '/ip/firewall/filter', 'filter', 'dir', '/ip/firewall', 2, 'Firewall filter rules', '7.22')`);

  // schema_nodes for arch-filter tests: shared + x86-only child of /ip
  db.run(`INSERT INTO schema_nodes (path, name, type, parent_path, dir_role, _arch)
    VALUES ('/ip', 'ip', 'dir', NULL, 'namespace', NULL)`);
  db.run(`INSERT INTO schema_nodes (path, name, type, parent_path, dir_role, _arch)
    VALUES ('/ip/dhcp-server', 'dhcp-server', 'dir', '/ip', 'list', NULL)`);
  db.run(`INSERT INTO schema_nodes (path, name, type, parent_path, dir_role, _arch)
    VALUES ('/ip/x86-feature', 'x86-feature', 'cmd', '/ip', NULL, 'x86')`);
  // Also insert a commands row for x86-feature so it participates in browseCommands
  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (99, '/ip/x86-feature', 'x86-feature', 'cmd', '/ip', NULL, 'x86-only', '7.22')`);

  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/dhcp-server', '7.22')`);
  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/dhcp-server', '7.9')`);
  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/firewall/filter', '7.22')`);

  // Extra command_versions entries to support diffCommandVersions tests
  // /ip/dhcp-server/lease only in 7.22 (added)
  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/dhcp-server/lease', '7.22')`);
  // /ip/old-feature only in 7.9 (removed by 7.22)
  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/old-feature', '7.9')`);
  // /other/path only in 7.10.2 (outside /ip prefix for prefix-filter test)
  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/other/path', '7.10.2')`);

  // Device fixtures for searchDevices tests
  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd,
     product_url, block_diagram_url)
    VALUES
    ('hAP ax3', 'C53UiG+5HPaxD2HPaxD', 'ARM 64bit', 'IPQ-6010', 4, 'auto (864 - 1800) MHz',
     4, 'RouterOS v7', '1 GB', 1024, '128 MB', 128,
     '802.3af/at', NULL, 2, 2,
     NULL, 4, 1, NULL, NULL,
     NULL, 1, NULL, 139.00,
     'https://mikrotik.com/product/hap_ax3', 'https://cdn.mikrotik.com/web-assets/product_files/hap_ax3_123.png')`);

  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('CCR2216-1G-12XS-2XQ', 'CCR2216-1G-12XS-2XQ', 'ARM 64bit', 'AL73400', 16, '2000 MHz',
     6, 'RouterOS v7', '16 GB', 16384, '128 MB', 128,
     NULL, NULL, NULL, NULL,
     NULL, 1, NULL, NULL, 12,
     NULL, 1, NULL, 2795.00)`);

  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('hAP lite', 'RB941-2nD', 'SMIPS', 'QCA9533', 1, '650 MHz',
     4, 'RouterOS', '32 MB', 32, '16 MB', 16,
     NULL, NULL, 1, NULL,
     4, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, 24.95)`);

  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('Chateau LTE18 ax', 'S53UG+5HaxD2HaxD-TC&EG18-EA', 'ARM 64bit', 'IPQ-6010', 4, 'auto (864 - 1800) MHz',
     4, 'RouterOS v7', '1 GB', 1024, '128 MB', 128,
     NULL, NULL, 2, 2,
     NULL, 4, 1, NULL, NULL,
     NULL, 1, 2, 599.00)`);

  // Device fixture: model number without hyphens (substring matching needed)
  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('RB1100AHx4', 'RB1100x4', 'ARM 32bit', 'AL21400', 4, '1400 MHz',
     6, 'RouterOS', '1 GB', 1024, '128 MB', 128,
     NULL, NULL, NULL, NULL,
     NULL, 13, NULL, NULL, NULL,
     NULL, NULL, NULL, 299.00)`);

  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('RB1100AHx4 Dude Edition', 'RB1100Dx4', 'ARM 32bit', 'AL21400', 4, '1400 MHz',
     6, 'RouterOS', '1 GB', 1024, '512 MB', 512,
     NULL, NULL, NULL, NULL,
     NULL, 13, NULL, NULL, NULL,
     NULL, NULL, NULL, 369.00)`);

  // Device fixtures: Unicode superscript names (matching production DB naming)
  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd,
     product_url)
    VALUES
    ('hAP ax\u00b2', 'C52iG-5HaxD2HaxD-TC', 'ARM 64bit', 'IPQ-6010', 4, 'auto (864 - 1800) MHz',
     4, 'RouterOS v7', '1 GB', 1024, '128 MB', 128,
     '802.3af/at', NULL, 2, 2,
     NULL, 4, 1, NULL, NULL,
     NULL, 1, NULL, 119.00,
     'https://mikrotik.com/product/hap_ax2')`);

  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('hAP ac\u00b3', 'RBD53iG-5HacD2HnD', 'ARM 64bit', 'IPQ-4019', 4, '716 MHz',
     4, 'RouterOS v7', '256 MB', 256, '128 MB', 128,
     NULL, NULL, 2, 2,
     NULL, 5, NULL, NULL, NULL,
     NULL, 1, NULL, 69.00)`);

  // Device fixtures: RB5009 family for disambiguation testing
  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('RB5009UG+S+IN', 'RB5009UG+S+IN', 'ARM 64bit', 'Marvell 88F7040', 4, '1400 MHz',
     5, 'RouterOS v7', '1 GB', 1024, '1 GB', 1024,
     NULL, NULL, NULL, NULL,
     NULL, 7, 1, NULL, 1,
     NULL, 1, NULL, 219.00)`);

  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('RB5009UPr+S+IN', 'RB5009UPr+S+IN', 'ARM 64bit', 'Marvell 88F7040', 4, '1400 MHz',
     5, 'RouterOS v7', '1 GB', 1024, '1 GB', 1024,
     '802.3af/at', '802.3af/at', NULL, NULL,
     NULL, 7, 1, NULL, 1,
     NULL, 1, NULL, 269.00)`);

  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('RB5009UPr+S+OUT', 'RB5009UPr+S+OUT', 'ARM 64bit', 'Marvell 88F7040', 4, '1400 MHz',
     5, 'RouterOS v7', '1 GB', 1024, '1 GB', 1024,
     '802.3af/at', '802.3af/at', NULL, NULL,
     NULL, 7, 1, NULL, 1,
     NULL, 1, NULL, 299.00)`);

  // Device test results fixtures (hAP ax3 = id 1)
  db.run(`INSERT INTO device_test_results
    (device_id, test_type, mode, configuration, packet_size, throughput_kpps, throughput_mbps)
    VALUES (1, 'ethernet', 'Routing', '25 ip filter rules', 512, 755.9, 3096.2)`);
  db.run(`INSERT INTO device_test_results
    (device_id, test_type, mode, configuration, packet_size, throughput_kpps, throughput_mbps)
    VALUES (1, 'ethernet', 'Routing', 'none (fast path)', 512, 2332.0, 9551.9)`);
  db.run(`INSERT INTO device_test_results
    (device_id, test_type, mode, configuration, packet_size, throughput_kpps, throughput_mbps)
    VALUES (1, 'ipsec', 'Single tunnel', 'AES-128-CBC + SHA1', 1400, 120.9, 1354.1)`);
  // RB5009UG+S+IN = id 9 (9th device inserted)
  db.run(`INSERT INTO device_test_results
    (device_id, test_type, mode, configuration, packet_size, throughput_kpps, throughput_mbps)
    VALUES (9, 'ethernet', 'Routing', 'none (fast path)', 1518, 1613.0, 19577.3)`);

  // Page 3: a "large" page with sections for TOC testing
  // Text is ~200 chars to keep fixture small, but we'll use max_length=50 to trigger truncation
  db.run(`INSERT INTO pages
    (id, slug, title, path, depth, parent_id, url, text, code, code_lang,
     author, last_updated, word_count, code_lines, html_file)
    VALUES
    (3, 'Bridging', 'Bridging and Switching', 'RouterOS > Bridging', 1, NULL,
     'https://help.mikrotik.com/docs/spaces/ROS/pages/3/Bridging',
     'Bridging overview text that is moderately long for testing purposes. It covers bridge setup and VLAN configuration and STP protocol details.',
     '/interface bridge add name=bridge1', NULL, NULL, NULL, 25, 1, 'test3.html')`);

  db.run(`INSERT INTO sections
    (id, page_id, heading, level, anchor_id, text, code, word_count, sort_order)
    VALUES
    (1, 3, 'Summary', 1, 'BridgingandSwitching-Summary',
     'Bridge summary text with basic overview.', '', 6, 0)`);

  db.run(`INSERT INTO sections
    (id, page_id, heading, level, anchor_id, text, code, word_count, sort_order)
    VALUES
    (2, 3, 'Bridge Interface Setup', 1, 'BridgingandSwitching-BridgeInterfaceSetup',
     'Setup instructions for bridge interfaces.', '/interface bridge add name=bridge1', 6, 1)`);

  db.run(`INSERT INTO sections
    (id, page_id, heading, level, anchor_id, text, code, word_count, sort_order)
    VALUES
    (4, 3, 'Port Configuration', 2, 'BridgingandSwitching-PortConfiguration',
     'Add ports to the bridge for switching.', '/interface bridge port add bridge=bridge1 interface=ether2', 7, 2)`);

  db.run(`INSERT INTO sections
    (id, page_id, heading, level, anchor_id, text, code, word_count, sort_order)
    VALUES
    (5, 3, 'VLAN Setup', 2, 'BridgingandSwitching-VLANSetup',
     'Configure VLANs on the bridge.', '/interface bridge vlan add bridge=bridge1 vlan-ids=10', 5, 3)`);

  db.run(`INSERT INTO sections
    (id, page_id, heading, level, anchor_id, text, code, word_count, sort_order)
    VALUES
    (3, 3, 'Spanning Tree Protocol', 1, 'BridgingandSwitching-SpanningTreeProtocol',
     'STP protocol configuration and monitoring.', '', 5, 4)`);

  // Changelog fixtures
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.21', '2025-Oct-15 12:00', 'bgp', 0, 'fixed BGP output sometimes not being cleaned after session restart', 0)`);
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.21', '2025-Oct-15 12:00', 'bridge', 0, 'fixed performance regression in complex setups with vlan-filtering', 1)`);
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.22', '2026-Mar-09 10:38', 'certificate', 1, 'added support for multiple ACME certificates (services that use a previously generated certificate need to be reconfigured after the certificate expires)', 0)`);
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.22', '2026-Mar-09 10:38', 'bgp', 0, 'added BGP unnumbered support', 1)`);
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.22', '2026-Mar-09 10:38', 'bridge', 0, 'added local and static MAC synchronization for MLAG', 2)`);
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.22', '2026-Mar-09 10:38', 'firewall', 0, 'improved firewall filter rule handling', 3)`);
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.22.1', '2026-Apr-01 09:00', 'wifi', 0, 'fixed channel switching for MediaTek access points', 0)`);
  db.run(`INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order)
    VALUES ('7.23.1', '2026-Apr-15 09:00', 'routing', 0, 'fixed route cache after upgrade', 0)`);

  // Video and transcript fixtures for searchVideos tests
  db.run(`INSERT INTO videos
    (id, video_id, title, description, channel, upload_date, duration_s, url, has_chapters)
    VALUES
    (1, 'abc123', 'RouterOS VLAN Tutorial', 'How to configure VLANs on MikroTik', 'MikroTik', '20240101', 600,
     'https://www.youtube.com/watch?v=abc123', 1)`);
  db.run(`INSERT INTO videos
    (id, video_id, title, description, channel, upload_date, duration_s, url, has_chapters)
    VALUES
    (2, 'def456', 'BGP Routing with RouterOS', 'Advanced BGP configuration', 'MikroTik', '20240201', 900,
     'https://www.youtube.com/watch?v=def456', 0)`);
  db.run(`INSERT INTO video_segments
    (id, video_id, chapter_title, start_s, end_s, transcript, sort_order)
    VALUES
    (1, 1, 'Introduction', 0, 120, 'Welcome to the VLAN tutorial. In this video we cover VLAN trunking on MikroTik bridge.', 0)`);
  db.run(`INSERT INTO video_segments
    (id, video_id, chapter_title, start_s, end_s, transcript, sort_order)
    VALUES
    (2, 1, 'Bridge VLAN configuration', 120, 600, 'To set up bridge VLAN filtering enable vlan-filtering on the bridge interface.', 1)`);
  db.run(`INSERT INTO video_segments
    (id, video_id, chapter_title, start_s, end_s, transcript, sort_order)
    VALUES
    (3, 2, NULL, 0, NULL, 'BGP peering and route reflection allow scalable routing in large networks.', 0)`);

  // Dude wiki page fixtures for searchDude tests
  db.run(`INSERT INTO dude_pages
    (id, slug, title, path, version, url, wayback_url, text, code, word_count)
    VALUES
    (1, 'Probes', 'Probes', 'The Dude > v6 > Probes', 'v6',
     'https://wiki.mikrotik.com/wiki/Manual:The_Dude_v6/Probes',
     'https://web.archive.org/web/2024/https://wiki.mikrotik.com/wiki/Manual:The_Dude_v6/Probes',
     'Probes are used to monitor specific services on devices. SNMP probes query MIB values. TCP probes check port availability. The Dude supports custom probe definitions with thresholds and alerts.',
     NULL, 30)`);
  db.run(`INSERT INTO dude_pages
    (id, slug, title, path, version, url, wayback_url, text, code, word_count)
    VALUES
    (2, 'Device_discovery', 'Device Discovery', 'The Dude > v6 > Device Discovery', 'v6',
     'https://wiki.mikrotik.com/wiki/Manual:The_Dude_v6/Device_discovery',
     'https://web.archive.org/web/2024/https://wiki.mikrotik.com/wiki/Manual:The_Dude_v6/Device_discovery',
     'Device discovery scans networks using SNMP, TCP, and ICMP. The Dude can automatically discover routers, switches, and other network devices on specified subnets.',
     '/dude discovery add address=10.0.0.0/24', 25)`);
  db.run(`INSERT INTO dude_pages
    (id, slug, title, path, version, url, wayback_url, text, code, word_count)
    VALUES
    (3, 'Notifications', 'Notifications', 'The Dude > v3 > Notifications', 'v3',
     'https://wiki.mikrotik.com/wiki/Manual:The_Dude/Notifications',
     'https://web.archive.org/web/2024/https://wiki.mikrotik.com/wiki/Manual:The_Dude/Notifications',
     'The Dude can send email and SMS notifications when device status changes. Configure SMTP settings for email alerts.',
     NULL, 20)`);
  db.run(`INSERT INTO dude_images (page_id, filename, alt_text, caption, local_path, original_url, sort_order)
    VALUES (1, 'Dude-probes-all.JPG', 'Probes list', 'All probes view', 'dude/images/Dude-probes-all.JPG',
     'https://wiki.mikrotik.com/wiki/File:Dude-probes-all.JPG', 0)`);
  db.run(`INSERT INTO dude_images (page_id, filename, alt_text, caption, local_path, original_url, sort_order)
    VALUES (1, 'Dude-probe-settings.JPG', 'Probe settings', 'Probe configuration dialog', 'dude/images/Dude-probe-settings.JPG',
     'https://wiki.mikrotik.com/wiki/File:Dude-probe-settings.JPG', 1)`);
  db.run(`INSERT INTO dude_images (page_id, filename, alt_text, caption, local_path, original_url, sort_order)
    VALUES (2, 'Dude-discovery.JPG', 'Discovery settings', NULL, 'dude/images/Dude-discovery.JPG',
     'https://wiki.mikrotik.com/wiki/File:Dude-discovery.JPG', 0)`);
});

// ---------------------------------------------------------------------------
// Pure function: extractTerms
// ---------------------------------------------------------------------------

describe("extractTerms", () => {
  test("lowercases and tokenises", () => {
    expect(extractTerms("DHCP Server")).toEqual(["dhcp", "server"]);
  });

  test("removes stop words", () => {
    // every word here is in the STOP_WORDS set
    expect(extractTerms("how and the with without")).toEqual([]);
  });

  test("drops switch as context for bridge VLAN filtering queries", () => {
    expect(extractTerms("bridge vlan filtering on a switch")).toEqual(["bridge", "vlan", "filtering"]);
  });

  test("filters terms shorter than 2 characters", () => {
    expect(extractTerms("a x y")).toEqual([]);
  });

  test("keeps 2-character terms", () => {
    expect(extractTerms("ip route")).toEqual(["ip", "route"]);
  });

  test("removes punctuation but preserves hyphens", () => {
    // Hyphens are preserved by the regex keep rule /[^\w\s-]/g
    const terms = extractTerms("lease-time (default: 10m)");
    expect(terms).toContain("lease-time");
    expect(terms).not.toContain("default:");
  });

  test("caps at MAX_TERMS (8)", () => {
    const input = "alpha bravo charlie delta echo foxtrot golf hotel india";
    expect(extractTerms(input).length).toBeLessThanOrEqual(8);
  });

  test("returns empty array for empty string", () => {
    expect(extractTerms("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure function: buildFtsQuery
// ---------------------------------------------------------------------------

describe("buildFtsQuery", () => {
  test("single term produces quoted token", () => {
    expect(buildFtsQuery(["dhcp"], "AND")).toBe('"dhcp"');
  });

  test("two unrelated terms joined with AND", () => {
    expect(buildFtsQuery(["bridge", "vlan"], "AND")).toBe('NEAR("bridge" "vlan", 5)');
  });

  test("two unrelated terms joined with OR", () => {
    // 'bridge' + 'vlan' IS a compound term → NEAR even in OR mode
    // Use non-compound pair to test plain OR join
    expect(buildFtsQuery(["lease", "expire"], "OR")).toBe('"lease" OR "expire"');
  });

  test("compound term becomes NEAR expression", () => {
    // "dhcp" + "server" is a registered compound pair
    const q = buildFtsQuery(["dhcp", "server"], "AND");
    expect(q).toBe('NEAR("dhcp" "server", 5)');
  });

  test("compound term plus extra term", () => {
    const q = buildFtsQuery(["firewall", "filter", "chain"], "AND");
    expect(q).toContain('NEAR("firewall" "filter", 5)');
    expect(q).toContain('"chain"');
  });

  test("empty terms array returns empty string", () => {
    expect(buildFtsQuery([], "AND")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// DB integration: searchPages
// ---------------------------------------------------------------------------

describe("searchPages", () => {
  test("returns empty for all-stop-word query", () => {
    const res = searchPages("how the what");
    expect(res.results).toHaveLength(0);
    expect(res.ftsQuery).toBe("");
  });

  test("finds DHCP page", () => {
    const res = searchPages("dhcp lease");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].title).toBe("DHCP Server");
  });

  test("finds firewall page", () => {
    const res = searchPages("firewall filter packet");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].title).toBe("Firewall Filter");
  });

  test("fallback OR mode when AND returns no results", () => {
    // "dhcp" is in page 1, "firewall" in page 2 — AND should fail, OR should return both
    const res = searchPages("dhcp firewall");
    // Depending on FTS index there may or may not be an AND match; the important
    // thing is that we get at least one result (OR fallback kicks in if needed)
    expect(res.results.length).toBeGreaterThan(0);
  });

  test("respects limit parameter", () => {
    const res = searchPages("server filter", 1);
    expect(res.results.length).toBeLessThanOrEqual(1);
  });

  test("returns ftsQuery in response", () => {
    const res = searchPages("dhcp server");
    expect(res.ftsQuery).toBeTruthy();
    expect(res.query).toBe("dhcp server");
  });

  test("returns best_section for pages with matching sections", () => {
    // Page 3 (Bridging and Switching) has sections including "VLAN Setup" with VLAN content
    const res = searchPages("bridge vlan");
    const bridging = res.results.find((r) => r.id === 3);
    expect(bridging).toBeDefined();
    expect(bridging?.best_section).toBeDefined();
    expect(bridging?.best_section?.heading).toBe("VLAN Setup");
    expect(bridging?.best_section?.anchor_id).toBe("BridgingandSwitching-VLANSetup");
    expect(bridging?.best_section?.url).toContain("#BridgingandSwitching-VLANSetup");
  });

  test("omits best_section for pages without sections", () => {
    // Page 1 (DHCP Server) has no sections
    const res = searchPages("dhcp lease");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].best_section).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DB integration: getPage
// ---------------------------------------------------------------------------

describe("getPage", () => {
  test("returns null for unknown numeric ID", () => {
    expect(getPage(9999)).toBeNull();
  });

  test("returns null for unknown title", () => {
    expect(getPage("Nonexistent Page")).toBeNull();
  });

  test("fetches page by numeric ID", () => {
    const page = getPage(1);
    expect(page).not.toBeNull();
    expect(page?.title).toBe("DHCP Server");
  });

  test("fetches page by string-encoded ID", () => {
    const page = getPage("1");
    expect(page?.title).toBe("DHCP Server");
  });

  test("fetches page by title (case-insensitive)", () => {
    const page = getPage("dhcp server");
    expect(page?.title).toBe("DHCP Server");
  });

  test("includes callouts", () => {
    const page = getPage(1);
    expect(page?.callouts).toHaveLength(1);
    expect(page?.callouts[0].type).toBe("Note");
    expect(page?.callouts[0].content).toContain("DHCP lease time");
  });

  test("page with no callouts returns empty callouts array", () => {
    // page 2 has a callout too in our fixture; add a page with none by checking page 2
    const page = getPage(2);
    // page 2 has one callout in fixtures
    expect(Array.isArray(page?.callouts)).toBe(true);
  });

  test("includes code_lines in response", () => {
    const page = getPage(1);
    expect(page?.code_lines).toBe(1);
  });

  test("truncates large pages with max_length", () => {
    const full = getPage(1);
    expect(full).not.toBeNull();
    if (!full) return;
    const fullLen = full.text.length + full.code.length;
    // Request truncation well below actual page size
    const truncated = getPage(1, 50);
    expect(truncated).not.toBeNull();
    if (!truncated) return;
    expect(truncated.truncated).toBeDefined();
    expect(truncated.text.length + truncated.code.length).toBeLessThan(fullLen + 100); // allow for truncation message
    expect(truncated.truncated?.text_total).toBe(full.text.length);
  });

  test("no truncation when page fits within max_length", () => {
    const page = getPage(1, 999999);
    expect(page).not.toBeNull();
    expect(page?.truncated).toBeUndefined();
  });

  test("returns TOC when page would be truncated and has sections", () => {
    // Page 3 has sections + its text is ~135 chars. max_length=50 triggers truncation.
    const result = getPage(3, 50);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sections).toBeDefined();
    expect(result.sections?.length).toBe(5);
    expect(result.sections?.[0].heading).toBe("Summary");
    expect(result.sections?.[0].anchor_id).toBe("BridgingandSwitching-Summary");
    expect(result.sections?.[0].char_count).toBeGreaterThan(0);
    expect(result.sections?.[0].url).toContain("#BridgingandSwitching-Summary");
    expect(result.text).toBe("");
    expect(result.note).toContain("table of contents");
    expect(result.truncated).toBeDefined();
  });

  test("truncates normally when page has no sections", () => {
    // Page 1 has no sections — should truncate the old way
    const result = getPage(1, 50);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sections).toBeUndefined();
    expect(result.truncated).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("returns specific section by heading text", () => {
    const result = getPage(3, undefined, "Summary");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.section).toBeDefined();
    expect(result.section?.heading).toBe("Summary");
    expect(result.text).toContain("Bridge summary");
    expect(result.url).toContain("#BridgingandSwitching-Summary");
  });

  test("returns specific section by anchor_id", () => {
    const result = getPage(3, undefined, "BridgingandSwitching-BridgeInterfaceSetup");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.section?.heading).toBe("Bridge Interface Setup");
    expect(result.text).toContain("Setup instructions");
    expect(result.code).toContain("bridge add");
  });

  test("parent section includes descendant content", () => {
    // "Bridge Interface Setup" (level 1) has two level-2 children: Port Configuration, VLAN Setup
    const result = getPage(3, undefined, "Bridge Interface Setup");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.section?.heading).toBe("Bridge Interface Setup");
    // Should include own content
    expect(result.text).toContain("Setup instructions");
    // Should include child section content
    expect(result.text).toContain("Port Configuration");
    expect(result.text).toContain("Add ports to the bridge");
    expect(result.text).toContain("VLAN Setup");
    expect(result.text).toContain("Configure VLANs");
    // Should include child code
    expect(result.code).toContain("bridge port add");
    expect(result.code).toContain("bridge vlan add");
    // word_count sums parent + children
    expect(result.word_count).toBe(6 + 7 + 5);
  });

  test("leaf section does not include sibling content", () => {
    // "Port Configuration" (level 2) should NOT include VLAN Setup content
    const result = getPage(3, undefined, "Port Configuration");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.section?.heading).toBe("Port Configuration");
    expect(result.text).toContain("Add ports to the bridge");
    expect(result.text).not.toContain("Configure VLANs");
  });

  test("last top-level section has no descendants", () => {
    const result = getPage(3, undefined, "Spanning Tree Protocol");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.section?.heading).toBe("Spanning Tree Protocol");
    expect(result.text).toBe("STP protocol configuration and monitoring.");
    // No child content contamination
    expect(result.text).not.toContain("Port Configuration");
  });

  test("returns section by heading case-insensitive", () => {
    const result = getPage(3, undefined, "summary");
    expect(result).not.toBeNull();
    expect(result?.section?.heading).toBe("Summary");
  });

  test("returns TOC when section not found on page with sections", () => {
    const result = getPage(3, undefined, "Nonexistent Section");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sections).toBeDefined();
    expect(result.sections?.length).toBe(5);
    expect(result.note).toContain("not found");
    expect(result.text).toBe("");
  });

  test("returns full page with note when section not found on page without sections", () => {
    const result = getPage(1, undefined, "Nonexistent Section");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.note).toContain("no sections");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.sections).toBeUndefined();
  });

  test("section response includes callouts", () => {
    const result = getPage(3, undefined, "Summary");
    expect(result).not.toBeNull();
    expect(Array.isArray(result?.callouts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB integration: lookupProperty
// ---------------------------------------------------------------------------

describe("lookupProperty", () => {
  test("finds property by exact name", () => {
    const rows = lookupProperty("lease-time");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toBe("lease-time");
    expect(rows[0].page_title).toBe("DHCP Server");
    expect(rows[0].confidence).toBe("medium");
  });

  test("case-insensitive name lookup", () => {
    const rows = lookupProperty("LEASE-TIME");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.confidence === "medium")).toBe(true);
  });

  test("returns empty for unknown property", () => {
    expect(lookupProperty("nonexistent-prop")).toHaveLength(0);
  });

  test("filters by command path", () => {
    const rows = lookupProperty("lease-time", "/ip/dhcp-server");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toBe("lease-time");
    expect(rows[0].confidence).toBe("high");
  });

  test("marks global fallback low when command path has no linked page", () => {
    const rows = lookupProperty("lease-time", "/ip/unlinked");
    // /ip/unlinked has no page_id → falls through to global search
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.confidence === "low")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB integration: explainCommand
// ---------------------------------------------------------------------------

describe("explainCommand", () => {
  test("returns canonical command, known arg property, pages, changelog hits, and version check", () => {
    const result = explainCommand("/ip firewall filter add chain=forward action=drop", "7.22");

    expect(result.command).toBe("/ip firewall filter add chain=forward action=drop");
    expect(result.canonical).toEqual({
      path: "/ip/firewall/filter",
      verb: "add",
      args: ["chain=forward", "action=drop"],
      confidence: "high",
    });
    expect(result.confidence).toBe("high");
    expect(result.args.map((arg) => arg.name)).toEqual(["chain", "action"]);
    expect(result.args[0].property?.name).toBe("chain");
    expect(result.args[0].property?.confidence).toBe("high");
    expect(result.warnings).toEqual([]);
    expect(result.pages.some((page) => page.title === "Firewall Filter")).toBe(true);
    expect(result.changelog_hits.some((hit) => hit.category === "firewall")).toBe(true);
    expect(result.version_check?.versions).toContain("7.22");
  });

  test("warns for unknown args, absent target versions, and unused model context", () => {
    const result = explainCommand("/ip firewall filter add frobnicate=yes", "7.9", "hAP ax3");

    expect(result.canonical?.path).toBe("/ip/firewall/filter");
    expect(result.confidence).toBe("high");
    expect(result.args[0]).toMatchObject({ name: "frobnicate", value: "yes" });
    expect(result.args[0].property).toBeUndefined();
    expect(result.warnings.map((warning) => warning.kind)).toEqual(
      expect.arrayContaining([
        "unknown-arg",
        "command-not-in-version",
        "model-context-unused",
      ]),
    );
  });

  test("warns on low-confidence canonicalization", () => {
    const result = explainCommand("print");

    expect(result.canonical).toMatchObject({ path: "/", verb: "print", confidence: "low" });
    expect(result.confidence).toBe("low");
    expect(result.warnings.some((warning) => warning.kind === "low-confidence")).toBe(true);
  });

  test("warns when no primary command can be extracted", () => {
    const result = explainCommand("not a routeros command");

    expect(result.canonical).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.args).toEqual([]);
    expect(result.warnings.some((warning) => warning.kind === "no-command")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB integration: browseCommands
// ---------------------------------------------------------------------------

describe("browseCommands", () => {
  test("lists children of /ip", () => {
    const children = browseCommands("/ip");
    expect(children.length).toBeGreaterThan(0);
    const paths = children.map((c) => c.path);
    expect(paths).toContain("/ip/dhcp-server");
  });

  test("returns empty for unknown path", () => {
    expect(browseCommands("/unknown/path")).toHaveLength(0);
  });

  test("includes linked page title", () => {
    const children = browseCommands("/ip");
    const dhcp = children.find((c) => c.path === "/ip/dhcp-server");
    expect(dhcp?.page_title).toBe("DHCP Server");
  });

  test("arch param binds correctly — x86-only node gets NULL enrichment when arch=arm64", () => {
    // /ip/x86-feature has _arch='x86' in schema_nodes; browsing with arch='arm64'
    // should still return the command (LEFT JOIN from commands), but schema enrichment
    // (dir_role) should be NULL since the x86 schema_nodes row doesn't match arm64 filter.
    const children = browseCommands("/ip", "arm64");
    const x86Feature = children.find((c) => c.path === "/ip/x86-feature");
    expect(x86Feature).toBeDefined(); // command still in results (from commands table)
    expect(x86Feature?.dir_role).toBeNull(); // schema enrichment absent for other-arch node

    // dhcp-server (_arch=NULL = shared) still gets enrichment
    const dhcp = children.find((c) => c.path === "/ip/dhcp-server");
    expect(dhcp?.dir_role).toBe("list"); // schema enrichment present for shared node
  });

  test("arch param binds correctly — x86 filter enriches x86-only node", () => {
    const children = browseCommands("/ip", "x86");
    const x86Feature = children.find((c) => c.path === "/ip/x86-feature");
    expect(x86Feature).toBeDefined();
    // x86-feature has _arch='x86', matches the arch='x86' filter, so _arch is populated
    expect(x86Feature?._arch).toBe("x86");
  });
});

// ---------------------------------------------------------------------------
// DB integration: searchCallouts
// ---------------------------------------------------------------------------

describe("searchCallouts", () => {
  test("finds callout by content keyword", () => {
    const rows = searchCallouts("lease time");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].type).toBe("Note");
  });

  test("filters by type", () => {
    const notes = searchCallouts("lease", "Note");
    expect(notes.every((r) => r.type === "Note")).toBe(true);

    const warnings = searchCallouts("dhcp", "Warning");
    // no warning about dhcp in fixtures
    expect(Array.isArray(warnings)).toBe(true);
  });

  test("returns empty for stop-word-only query", () => {
    expect(searchCallouts("how the")).toHaveLength(0);
  });

  test("falls back to OR when AND returns nothing", () => {
    // "lease" is in Note, "routing" is in Warning — no callout has both
    // AND should fail, OR should find both
    const rows = searchCallouts("lease routing");
    expect(rows.length).toBeGreaterThan(0);
  });

  test("type-only browse returns callouts without query", () => {
    const notes = searchCallouts("", "Note");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((r) => r.type === "Note")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB integration: checkCommandVersions
// ---------------------------------------------------------------------------

describe("checkCommandVersions", () => {
  test("returns versions for known command path", () => {
    const res = checkCommandVersions("/ip/dhcp-server");
    expect(res.versions).toEqual(["7.9", "7.22"]);
    expect(res.first_seen).toBe("7.9");
    expect(res.last_seen).toBe("7.22");
  });

  test("returns empty versions for unknown command path", () => {
    const res = checkCommandVersions("/unknown/cmd");
    expect(res.versions).toHaveLength(0);
    expect(res.first_seen).toBeNull();
    expect(res.last_seen).toBeNull();
    expect(res.note).toContain("No version data found");
  });

  test("includes command_path in response", () => {
    const res = checkCommandVersions("/ip/dhcp-server");
    expect(res.command_path).toBe("/ip/dhcp-server");
  });

  test("adds note when command exists at earliest tracked version", () => {
    // Our fixture only has version 7.22, which is the min. Expect note.
    const res = checkCommandVersions("/ip/dhcp-server");
    expect(res.note).toContain("earliest tracked version");
  });
});

// ---------------------------------------------------------------------------
// DB integration: diffCommandVersions
// ---------------------------------------------------------------------------

describe("diffCommandVersions", () => {
  test("detects added command paths", () => {
    // /ip/dhcp-server/lease only in 7.22
    const res = diffCommandVersions("7.9", "7.22");
    expect(res.added).toContain("/ip/dhcp-server/lease");
  });

  test("detects removed command paths", () => {
    // /ip/old-feature only in 7.9
    const res = diffCommandVersions("7.9", "7.22");
    expect(res.removed).toContain("/ip/old-feature");
  });

  test("does not report unchanged commands as added or removed", () => {
    const res = diffCommandVersions("7.9", "7.22");
    // /ip/dhcp-server is in both versions — should not appear in either list
    expect(res.added).not.toContain("/ip/dhcp-server");
    expect(res.removed).not.toContain("/ip/dhcp-server");
  });

  test("returns correct counts", () => {
    const res = diffCommandVersions("7.9", "7.22");
    expect(res.added_count).toBe(res.added.length);
    expect(res.removed_count).toBe(res.removed.length);
  });

  test("path_prefix scopes the diff to a subtree", () => {
    const res = diffCommandVersions("7.9", "7.22", "/ip");
    // /other/path is outside /ip prefix — should not appear
    expect(res.added).not.toContain("/other/path");
    expect(res.removed).not.toContain("/other/path");
    // Results should still include /ip subtree changes
    expect(res.removed).toContain("/ip/old-feature");
  });

  test("returns from_version and to_version in result", () => {
    const res = diffCommandVersions("7.9", "7.22");
    expect(res.from_version).toBe("7.9");
    expect(res.to_version).toBe("7.22");
  });

  test("returns path_prefix in result", () => {
    const res = diffCommandVersions("7.9", "7.22", "/ip/firewall");
    expect(res.path_prefix).toBe("/ip/firewall");
  });

  test("path_prefix null when not provided", () => {
    const res = diffCommandVersions("7.9", "7.22");
    expect(res.path_prefix).toBeNull();
  });

  test("adds note for untracked from_version", () => {
    const res = diffCommandVersions("7.1", "7.22");
    expect(res.note).toContain("7.1");
    expect(res.note).toContain("not in the tracked range");
  });

  test("adds note for untracked to_version", () => {
    const res = diffCommandVersions("7.9", "7.99");
    expect(res.note).toContain("7.99");
  });

  test("returns empty diff for same version", () => {
    const res = diffCommandVersions("7.22", "7.22");
    expect(res.added).toHaveLength(0);
    expect(res.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DB integration: searchDevices
// ---------------------------------------------------------------------------

describe("searchDevices", () => {
  test("exact match by product name", () => {
    const res = searchDevices("hAP ax3");
    expect(res.mode).toBe("exact");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax3");
    expect(res.results[0].ram_mb).toBe(1024);
  });

  test("exact match by product code", () => {
    const res = searchDevices("CCR2216-1G-12XS-2XQ");
    expect(res.mode).toBe("exact");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].license_level).toBe(6);
  });

  test("exact match is case-insensitive", () => {
    const res = searchDevices("hap ax3");
    expect(res.mode).toBe("exact");
    expect(res.results).toHaveLength(1);
  });

  test("FTS search finds devices by CPU", () => {
    const res = searchDevices("IPQ-6010");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].product_name).toBe("hAP ax3");
  });

  test("FTS search by architecture keyword", () => {
    const res = searchDevices("SMIPS");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].architecture).toBe("SMIPS");
  });

  test("filter by architecture", () => {
    const res = searchDevices("", { architecture: "ARM 64bit" });
    expect(res.mode).toBe("filter");
    expect(res.results.length).toBe(8); // hAP ax3 + CCR2216 + Chateau + hAP ax² + hAP ac³ + 3× RB5009
    expect(res.results.every((d) => d.architecture === "ARM 64bit")).toBe(true);
  });

  test("filter by min_ram_mb", () => {
    const res = searchDevices("", { min_ram_mb: 1024 });
    expect(res.mode).toBe("filter");
    expect(res.results.length).toBe(9); // +hAP ax²(1024) +3×RB5009(1024) — not hAP ac³(256)
    expect(res.results.every((d) => (d.ram_mb ?? 0) >= 1024)).toBe(true);
  });

  test("filter by license level", () => {
    const res = searchDevices("", { license_level: 6 });
    expect(res.mode).toBe("filter");
    expect(res.results).toHaveLength(3); // CCR2216 + RB1100AHx4 + RB1100AHx4 Dude
    expect(res.results.every((d) => d.license_level === 6)).toBe(true);
  });

  test("filter by has_poe", () => {
    const res = searchDevices("", { has_poe: true });
    expect(res.results).toHaveLength(4); // hAP ax3 + hAP ax² + RB5009UPr IN + RB5009UPr OUT
    expect(res.results.every((d) => d.poe_in != null || d.poe_out != null)).toBe(true);
  });

  test("filter by has_wireless", () => {
    const res = searchDevices("", { has_wireless: true });
    expect(res.results).toHaveLength(5); // hAP ax3 + hAP lite + Chateau LTE18 + hAP ax² + hAP ac³
  });

  test("filter by min_storage_mb", () => {
    const res = searchDevices("", { min_storage_mb: 128 });
    expect(res.mode).toBe("filter");
    expect(res.results.length).toBe(10); // +hAP ax²(128) +hAP ac³(128) +3×RB5009(1024)
    expect(res.results.every((d) => (d.storage_mb ?? 0) >= 128)).toBe(true);
  });

  test("filter by min_storage_mb excludes low-storage devices", () => {
    const res = searchDevices("", { min_storage_mb: 64 });
    expect(res.results.every((d) => (d.storage_mb ?? 0) >= 64)).toBe(true);
    // hAP lite has 16 MB, should be excluded
    expect(res.results.find((d) => d.product_name === "hAP lite")).toBeUndefined();
  });

  test("filter by has_lte", () => {
    const res = searchDevices("", { has_lte: true });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("Chateau LTE18 ax");
    expect(res.results[0].sim_slots).toBe(2);
  });

  test("combined FTS + filter", () => {
    const res = searchDevices("hAP", { has_wireless: true });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((d) => d.wireless_24_chains != null || d.wireless_5_chains != null)).toBe(true);
  });

  test("returns empty for no match", () => {
    const res = searchDevices("nonexistent-device-xyz");
    expect(res.results).toHaveLength(0);
  });

  test("LIKE match finds substring in product name", () => {
    const res = searchDevices("RB1100");
    expect(res.mode).toBe("like");
    expect(res.results.length).toBe(2);
    expect(res.results.every((d) => d.product_name.includes("RB1100"))).toBe(true);
  });

  test("LIKE match finds substring in product code", () => {
    const res = searchDevices("RB1100D");
    expect(res.mode).toBe("like");
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    expect(res.results[0].product_code).toBe("RB1100Dx4");
  });

  test("LIKE match is case-insensitive", () => {
    const res = searchDevices("rb1100");
    expect(res.mode).toBe("like");
    expect(res.results.length).toBe(2);
  });

  test("natural language query finds device via LIKE", () => {
    // Simulates: "get me the specs for the routerboard model RB1100"
    // After stop word removal, extractTerms gets ["specs", "routerboard", "rb1100"]
    // LIKE matches on "RB1100" substring in product_name
    const res = searchDevices("RB1100");
    expect(res.results.length).toBe(2);
    expect(res.results.some((d) => d.product_name === "RB1100AHx4")).toBe(true);
    expect(res.results.some((d) => d.product_name === "RB1100AHx4 Dude Edition")).toBe(true);
  });

  test("returns empty with no query and no filters", () => {
    const res = searchDevices("");
    expect(res.results).toHaveLength(0);
  });

  test("exact match includes test_results", () => {
    const res = searchDevices("hAP ax3");
    expect(res.mode).toBe("exact");
    expect(res.results).toHaveLength(1);
    const dev = res.results[0];
    const testResults = dev.test_results;
    expect(testResults).toBeDefined();
    expect(testResults?.length).toBe(3);
    expect(testResults?.some((t) => t.test_type === "ethernet")).toBe(true);
    expect(testResults?.some((t) => t.test_type === "ipsec")).toBe(true);
  });

  test("LIKE match with ≤5 results includes test_results", () => {
    const res = searchDevices("RB1100");
    expect(res.mode).toBe("like");
    expect(res.results.length).toBeLessThanOrEqual(5);
    // RB1100 devices have no test results, but the field should still be populated (empty array)
    expect(res.results.every((d) => Array.isArray(d.test_results))).toBe(true);
  });

  test("exact match includes product_url and block_diagram_url", () => {
    const res = searchDevices("hAP ax3");
    expect(res.results[0].product_url).toBe("https://mikrotik.com/product/hap_ax3");
    expect(res.results[0].block_diagram_url).toContain("cdn.mikrotik.com");
  });

  test("devices without product_url return null", () => {
    const res = searchDevices("CCR2216-1G-12XS-2XQ");
    expect(res.results[0].product_url).toBeNull();
    expect(res.results[0].block_diagram_url).toBeNull();
  });

  test("has_more is false when all results fit", () => {
    const res = searchDevices("", { architecture: "ARM 64bit" }, 50);
    expect(res.has_more).toBe(false);
  });

  test("has_more is true when results are truncated", () => {
    // We have multiple devices; limit to 1 with a broad filter
    const res = searchDevices("", { architecture: "ARM 64bit" }, 1);
    expect(res.results).toHaveLength(1);
    expect(res.has_more).toBe(true);
  });

  test("single FTS match attaches test_results", () => {
    // "hAP ax3" as FTS should find exactly one match and attach test results
    const res = searchDevices("hAP ax3");
    if (res.mode === "exact" || res.results.length === 1) {
      expect(res.results[0].test_results).toBeDefined();
    }
  });

  test("LIKE splits on dashes so rb1100-ahx4 finds RB1100AHx4 family via LIKE", () => {
    // Users may type model numbers with dashes as word separators
    const res = searchDevices("RB1100-AHx4");
    expect(res.mode).toBe("like");
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    expect(res.results.every((d) => d.product_name.includes("RB1100"))).toBe(true);
  });

  test("slug-normalized LIKE finds hapax3 → hAP ax3 via product_url", () => {
    // Concatenated slug-style query: spaces dropped, ASCII digit for superscript.
    // Falls through regular LIKE (no match: 'hapax3' not a substring of 'hAP ax3')
    // then slug-normalized path matches product_url /product/hap_ax3 → hap_ax3 stripped.
    const res = searchDevices("hapax3");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax3"); // fixture uses ASCII 3
  });

  test("dash-split LIKE finds hap-ax3 → hAP ax3", () => {
    // Dash as separator: split → ['hap','ax3'] → LIKE '%hap%' AND '%ax3%'
    const res = searchDevices("hap-ax3");
    expect(res.mode).toBe("like");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax3");
  });

  test("underscore-split LIKE finds hap_ax3 → hAP ax3", () => {
    // Underscore-separated slug form
    const res = searchDevices("hap_ax3");
    expect(res.mode).toBe("like");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax3");
  });

  // ── Unicode superscript normalization ──

  test("normalizeDeviceQuery converts superscripts to ASCII", () => {
    expect(normalizeDeviceQuery("hAP ax³")).toBe("hAP ax3");
    expect(normalizeDeviceQuery("hAP ax²")).toBe("hAP ax2");
    expect(normalizeDeviceQuery("hAP ac³")).toBe("hAP ac3");
    expect(normalizeDeviceQuery("no superscripts")).toBe("no superscripts");
  });

  test("exact match with Unicode query hAP ax³ finds ASCII-named hAP ax3", () => {
    // User pastes Unicode name, DB has ASCII variant
    const res = searchDevices("hAP ax\u00B3");
    expect(res.mode).toBe("exact");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax3");
  });

  test("ASCII query hap ax2 finds Unicode-named hAP ax²", () => {
    // User types ASCII digits, DB has Unicode superscript
    const res = searchDevices("hap ax2");
    expect(res.mode).toBe("exact");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax\u00B2");
  });

  test("ASCII query hap ac3 finds Unicode-named hAP ac³", () => {
    const res = searchDevices("hap ac3");
    expect(res.mode).toBe("exact");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ac\u00B3");
  });

  test("single-digit term preserved: hap ax 3 finds hAP ax3 (not 4 results)", () => {
    // Previously: digit '3' was filtered by length >= 2, leaving just 'hap' + 'ax'
    // which matched hAP ax S, hAP ax lite, hAP ax², hAP ax³ (broad).
    // Now: single digits kept when accompanied by longer terms.
    const res = searchDevices("hap ax 3");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax3");
  });

  // ── Multi-match disambiguation ──

  test("RB5009 family query returns all 3 variants with disambiguation note", () => {
    const res = searchDevices("RB5009");
    expect(res.mode).toBe("like");
    expect(res.results).toHaveLength(3);
    expect(res.results.every((d) => d.product_name.includes("RB5009"))).toBe(true);
    // Should include disambiguation note for multi-match
    expect(res.note).toBeDefined();
    expect(res.note).toContain("3 devices");
  });

  test("disambiguation note mentions PoE difference for RB5009 family", () => {
    const res = searchDevices("RB5009");
    expect(res.note).toBeDefined();
    // RB5009UG has no PoE, RB5009UPr has PoE → note should mention it
    expect(res.note).toContain("PoE");
  });

  test("disambiguation note mentions enclosure difference for RB5009 family", () => {
    const res = searchDevices("RB5009");
    expect(res.note).toBeDefined();
    // IN vs OUT enclosures
    expect(res.note).toContain("enclosure");
  });

  test("single LIKE match has no disambiguation note", () => {
    const res = searchDevices("CCR2216");
    expect(res.results).toHaveLength(1);
    expect(res.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// searchDeviceTests: cross-device test queries
// ---------------------------------------------------------------------------

describe("searchDeviceTests", () => {
  test("returns all test results with no filters", () => {
    const res = searchDeviceTests({});
    expect(res.results.length).toBe(4);
    expect(res.total).toBe(4);
  });

  test("filters by test_type", () => {
    const res = searchDeviceTests({ test_type: "ethernet" });
    expect(res.results.every((r) => r.test_type === "ethernet")).toBe(true);
    expect(res.results.length).toBe(3);
  });

  test("filters by test_type and mode", () => {
    const res = searchDeviceTests({ test_type: "ipsec", mode: "Single tunnel" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].configuration).toBe("AES-128-CBC + SHA1");
  });

  test("configuration uses LIKE matching", () => {
    const res = searchDeviceTests({ configuration: "25 ip filter" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].configuration).toBe("25 ip filter rules");
  });

  test("filters by packet_size", () => {
    const res = searchDeviceTests({ packet_size: 512 });
    expect(res.results.every((r) => r.packet_size === 512)).toBe(true);
  });

  test("filters by device name (substring match)", () => {
    const res = searchDeviceTests({ device: "hAP" });
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r) => r.product_name.includes("hAP"))).toBe(true);
  });

  test("device filter combined with test_type", () => {
    const res = searchDeviceTests({ device: "hAP", test_type: "ethernet" });
    expect(res.results).toHaveLength(2);
    expect(res.results.every((r) => r.test_type === "ethernet")).toBe(true);
    expect(res.results.every((r) => r.product_name.includes("hAP"))).toBe(true);
  });

  test("device filter with no matches returns empty", () => {
    const res = searchDeviceTests({ device: "Audience" });
    expect(res.results).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  test("device filter for RB5009 returns its test results", () => {
    const res = searchDeviceTests({ device: "RB5009" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("RB5009UG+S+IN");
    expect(res.results[0].packet_size).toBe(1518);
  });

  test("sorts by mbps descending by default", () => {
    const res = searchDeviceTests({ test_type: "ethernet" });
    if (res.results.length >= 2) {
      const mbps = res.results.map((r) => r.throughput_mbps ?? 0);
      expect(mbps[0]).toBeGreaterThanOrEqual(mbps[1]);
    }
  });

  test("result shape has expected fields and no cpu fields", () => {
    const res = searchDeviceTests({ test_type: "ethernet" });
    const row = res.results[0];
    // Present: device identity + test data
    expect(row.product_name).toBeDefined();
    expect(row.product_code).toBeDefined();
    expect(row.architecture).toBeDefined();
    expect(row.test_type).toBeDefined();
    expect(row.mode).toBeDefined();
    expect(row.configuration).toBeDefined();
    expect(row.packet_size).toBeDefined();
    expect(row.throughput_mbps).toBeDefined();
    // Absent: cpu details (available via device_lookup)
    expect("cpu" in row).toBe(false);
    expect("cpu_cores" in row).toBe(false);
    expect("cpu_frequency" in row).toBe(false);
  });

  test("respects limit", () => {
    const res = searchDeviceTests({}, 1);
    expect(res.results).toHaveLength(1);
    expect(res.total).toBe(4);
  });

  test("prioritizes 512-byte rows when packet_size is unspecified", () => {
    // Fixtures: two 512B ethernet rows + one 1518B ethernet row (higher mbps) + one 1400B ipsec row.
    // Without 512B priority, the 1518B/19577 mbps row would lead. With priority, 512B rows lead.
    const res = searchDeviceTests({ test_type: "ethernet" });
    expect(res.results.length).toBeGreaterThanOrEqual(3);
    // All 512B rows must precede any non-512B row
    let sawNon512 = false;
    for (const row of res.results) {
      if (row.packet_size !== 512) sawNon512 = true;
      else if (sawNon512) {
        throw new Error(`512B row appeared after a non-512B row at packet_size=${row.packet_size}`);
      }
    }
    // Within the 512B bucket, mbps descending
    expect(res.results[0].packet_size).toBe(512);
    expect(res.results[0].throughput_mbps).toBe(9551.9);
  });

  test("explicit packet_size filter overrides 512B priority", () => {
    const res = searchDeviceTests({ packet_size: 1518 });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].packet_size).toBe(1518);
  });
});

describe("dataset CSV exports", () => {
  test("exports full device test results as CSV", () => {
    const csv = exportDeviceTestsCsv();
    const lines = csv.trim().split("\n");

    expect(lines[0]).toBe("product_name,product_code,architecture,cpu,cpu_cores,cpu_frequency,test_type,mode,configuration,packet_size,throughput_kpps,throughput_mbps,product_url");
    expect(lines).toHaveLength(5);
    expect(csv).toContain("hAP ax3");
    expect(csv).toContain("IPQ-6010");
    expect(csv).toContain("RB5009UG+S+IN");
    expect(csv).toContain("https://mikrotik.com/product/hap_ax3");
  });

  test("exports full device catalog as CSV", () => {
    const csv = exportDevicesCsv();
    const lines = csv.trim().split("\n");

    expect(lines[0]).toBe("product_name,product_code,architecture,cpu,cpu_cores,cpu_frequency,license_level,operating_system,ram,ram_mb,storage,storage_mb,dimensions,poe_in,poe_out,max_power_w,wireless_24_chains,wireless_5_chains,eth_fast,eth_gigabit,eth_2500,sfp_ports,sfp_plus_ports,eth_multigig,usb_ports,sim_slots,msrp_usd,product_url,block_diagram_url");
    expect(lines).toHaveLength(12); // header + 11 devices (6 original + 5 new fixtures)
    expect(csv).toContain("CCR2216-1G-12XS-2XQ");
    expect(csv).toContain("https://cdn.mikrotik.com/web-assets/product_files/hap_ax3_123.png");
    expect(lines[0].startsWith("id,")).toBe(false);
  });
});

describe("truncateDeviceTestResultsPrefer512", () => {
  test("keeps all 512B rows when truncating", () => {
    const rows = [
      { packet_size: 1518, id: "a" },
      { packet_size: 512, id: "b" },
      { packet_size: 64, id: "c" },
      { packet_size: 512, id: "d" },
    ];
    const res = truncateDeviceTestResultsPrefer512(rows, 2);

    expect(res.rows.map((r) => r.id)).toEqual(["b", "d"]);
    expect(res.omitted).toBe(2);
  });

  test("fills remaining slots with non-512 rows", () => {
    const rows = [
      { packet_size: 1518, id: "a" },
      { packet_size: 512, id: "b" },
      { packet_size: 64, id: "c" },
      { packet_size: 512, id: "d" },
    ];
    const res = truncateDeviceTestResultsPrefer512(rows, 3);

    expect(res.rows.map((r) => r.id)).toEqual(["b", "d", "a"]);
    expect(res.omitted).toBe(1);
  });

  test("returns all 512B rows even if they exceed maxRows", () => {
    const rows = [
      { packet_size: 512, id: "a" },
      { packet_size: 512, id: "b" },
      { packet_size: 1518, id: "c" },
      { packet_size: 512, id: "d" },
      { packet_size: 64, id: "e" },
    ];
    const res = truncateDeviceTestResultsPrefer512(rows, 2);

    expect(res.rows.map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(res.omitted).toBe(2);
  });
});

describe("getTestResultMeta", () => {
  test("returns distinct values", () => {
    const meta = getTestResultMeta();
    expect(meta.test_types).toContain("ethernet");
    expect(meta.test_types).toContain("ipsec");
    expect(meta.modes).toContain("Routing");
    expect(meta.packet_sizes).toContain(512);
  });
});

// ---------------------------------------------------------------------------
// Changelog Parser: parseChangelog
// ---------------------------------------------------------------------------

describe("parseChangelog", () => {
  test("parses header, regular and breaking entries", () => {
    const text = `What's new in 7.22 (2026-Mar-09 10:38):

!) certificate - added support for multiple ACME certificates
*) bgp - added BGP unnumbered support
*) bridge - added local and static MAC synchronization for MLAG`;

    const entries = parseChangelog(text);
    expect(entries).toHaveLength(3);
    expect(entries[0].version).toBe("7.22");
    expect(entries[0].released).toBe("2026-Mar-09 10:38");
    expect(entries[0].category).toBe("certificate");
    expect(entries[0].is_breaking).toBe(1);
    expect(entries[1].category).toBe("bgp");
    expect(entries[1].is_breaking).toBe(0);
    expect(entries[2].sort_order).toBe(2);
  });

  test("handles multi-line continuation", () => {
    const text = `What's new in 7.22 (2026-Mar-09 10:38):

*) bridge - added MLAG support per bridge interface (/interface/bridge/mlag menu is moved to
/interface/bridge; configuration is automatically updated after upgrade;
downgrading to an older version will result in MLAG configuration loss)`;

    const entries = parseChangelog(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toContain("MLAG configuration loss");
    expect(entries[0].description).toContain("added MLAG support");
  });

  test("extracts category correctly with comma-separated subsystems", () => {
    const text = `What's new in 7.22 (2026-Mar-09 10:38):

*) ike1,ike2 - improved netlink update handling`;

    const entries = parseChangelog(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe("ike1,ike2");
  });

  test("overrides version when expectedVersion is provided and header version differs", () => {
    const text = `What's new in 7.22 (2026-Mar-09 10:38):

*) bgp - some change`;

    const entries = parseChangelog(text, "7.22.1");
    // Header says 7.22, expectedVersion is 7.22.1 — since no entry has version 7.22.1,
    // the override applies
    expect(entries[0].version).toBe("7.22.1");
  });

  test("returns empty for non-changelog text", () => {
    const entries = parseChangelog("This is not a changelog.");
    expect(entries).toHaveLength(0);
  });

  test("handles entry without clear category separator", () => {
    const text = `What's new in 7.22 (2026-Mar-09 10:38):

*) fixed some general issue without a category separator`;

    const entries = parseChangelog(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Changelog Search: searchChangelogs (DB integration)
// ---------------------------------------------------------------------------

describe("searchChangelogs", () => {
  test("FTS search finds entries by keyword", () => {
    const results = searchChangelogs("BGP");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.category === "bgp")).toBe(true);
  });

  test("exact patch version stays exact", () => {
    const results = searchChangelogs("", { version: "7.22.1" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.version).toBe("7.22.1");
    }
  });

  test("major.minor version filter preserves exact rows before patch fallback", () => {
    const results = searchChangelogs("", { version: "7.22" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.version).toBe("7.22");
    }
    expect(results.some((r) => r.version === "7.22.1")).toBe(false);
  });

  test("major.minor version filter falls back to patch rows when exact rows are absent", () => {
    const results = searchChangelogs("", { version: "7.23" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.version === "7.23.1")).toBe(true);
  });

  test("generic major.minor version questions browse fallback patch rows", () => {
    const results = searchChangelogs("what changed in 7.23", { version: "7.23" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.version === "7.23.1")).toBe(true);
  });

  test("version range filter works (from_version exclusive, to_version inclusive)", () => {
    const results = searchChangelogs("", { fromVersion: "7.21", toVersion: "7.22.1" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(["7.22", "7.22.1"]).toContain(r.version);
    }
    // Should not include 7.21 (from_version is exclusive)
    expect(results.some((r) => r.version === "7.21")).toBe(false);
  });

  test("category filter returns only that category", () => {
    const results = searchChangelogs("", { version: "7.22", category: "bgp" });
    expect(results.length).toBe(1);
    expect(results[0].category).toBe("bgp");
  });

  test("breaking_only filter returns only breaking entries", () => {
    const results = searchChangelogs("", { breakingOnly: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.is_breaking).toBe(1);
    }
  });

  test("FTS combined with version range", () => {
    // from_version is exclusive, so use 7.21 to include 7.22
    const results = searchChangelogs("MLAG", { fromVersion: "7.21", toVersion: "7.22" });
    expect(results.length).toBe(1);
    expect(results[0].category).toBe("bridge");
  });

  test("returns empty for non-matching query", () => {
    const results = searchChangelogs("nonexistent-feature-xyz");
    expect(results).toHaveLength(0);
  });

  test("returns empty for version with no data", () => {
    const results = searchChangelogs("", { version: "6.49" });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Schema health: verify initDb creates all expected tables and triggers
// ---------------------------------------------------------------------------

describe("schema", () => {
  function tableNames(): string[] {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  function triggerNames(): string[] {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
    ).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  test("all core tables exist", () => {
    const names = tableNames();
    const expected = [
      "pages", "properties", "callouts", "sections",
      "commands", "command_versions", "ros_versions",
      "devices", "device_test_results", "changelogs", "schema_migrations",
      "videos", "video_segments",
      "skills", "skill_references",
    ];
    for (const table of expected) {
      expect(names).toContain(table);
    }
  });

  test("all FTS5 virtual tables exist", () => {
    const names = tableNames();
    const expected = ["pages_fts", "properties_fts", "callouts_fts", "devices_fts", "changelogs_fts", "videos_fts", "video_segments_fts", "skills_fts"];
    for (const fts of expected) {
      expect(names).toContain(fts);
    }
  });

  test("content-sync triggers exist for pages", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("pages_ai");
    expect(triggers).toContain("pages_ad");
    expect(triggers).toContain("pages_au");
  });

  test("content-sync triggers exist for properties", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("props_ai");
    expect(triggers).toContain("props_ad");
    expect(triggers).toContain("props_au");
  });

  test("content-sync triggers exist for callouts", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("callouts_ai");
    expect(triggers).toContain("callouts_ad");
    expect(triggers).toContain("callouts_au");
  });

  test("content-sync triggers exist for devices", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("devices_ai");
    expect(triggers).toContain("devices_ad");
    expect(triggers).toContain("devices_au");
  });

  test("content-sync triggers exist for changelogs", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("changelogs_ai");
    expect(triggers).toContain("changelogs_ad");
    expect(triggers).toContain("changelogs_au");
  });

  test("content-sync triggers exist for videos", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("videos_ai");
    expect(triggers).toContain("videos_ad");
    expect(triggers).toContain("videos_au");
  });

  test("content-sync triggers exist for video_segments", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("video_segs_ai");
    expect(triggers).toContain("video_segs_ad");
    expect(triggers).toContain("video_segs_au");
  });

  test("content-sync triggers exist for dude_pages", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("dude_pages_ai");
    expect(triggers).toContain("dude_pages_ad");
    expect(triggers).toContain("dude_pages_au");
  });

  test("content-sync triggers exist for skills", () => {
    const triggers = triggerNames();
    expect(triggers).toContain("skills_ai");
    expect(triggers).toContain("skills_ad");
    expect(triggers).toContain("skills_au");
  });

  test("PRAGMA user_version matches SCHEMA_VERSION", () => {
    const result = checkSchemaVersion();
    expect(result.ok).toBe(true);
    expect(result.actual).toBe(SCHEMA_VERSION);
    expect(result.expected).toBe(SCHEMA_VERSION);
  });

  test("db_meta table exists with key/value shape and read/write helpers work", async () => {
    const cols = db.prepare("PRAGMA table_info(db_meta)").all() as Array<{ name: string; type: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("key");
    expect(colNames).toContain("value");

    const { setDbMeta, getDbMeta, getAllDbMeta } = await import("./db.ts");
    setDbMeta("release_tag", "v0.0.0-test");
    setDbMeta("built_at", "2026-04-21T00:00:00Z");
    expect(getDbMeta("release_tag")).toBe("v0.0.0-test");
    expect(getDbMeta("missing_key")).toBeNull();
    // Upsert
    setDbMeta("release_tag", "v0.0.1-test");
    expect(getDbMeta("release_tag")).toBe("v0.0.1-test");
    const all = getAllDbMeta();
    expect(all.release_tag).toBe("v0.0.1-test");
    expect(all.built_at).toBe("2026-04-21T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// getDbStats: version range uses semantic sort (not lexicographic)
// ---------------------------------------------------------------------------

describe("getDbStats", () => {
  test("version range is semantically sorted (7.9 < 7.10.2 < 7.22)", () => {
    const stats = getDbStats();
    // Fixtures have 7.9, 7.10.2, 7.22 — lexicographic MIN would give "7.10.2", not "7.9"
    expect(stats.ros_version_min).toBe("7.9");
    expect(stats.ros_version_max).toBe("7.22");
  });

  test("includes skills count", () => {
    const stats = getDbStats();
    expect(stats).toHaveProperty("skills");
    expect(typeof stats.skills).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Skills: agent guides from tikoci/routeros-skills
// ---------------------------------------------------------------------------

describe("skills", () => {
  // Insert fixture data for skills tests
  beforeAll(() => {
    db.run("DELETE FROM skill_references");
    db.run("DELETE FROM skills");

    db.run(`INSERT INTO skills (name, description, content, source_repo, source_sha, source_url, word_count, extracted_at)
      VALUES ('routeros-test-skill', 'Test skill for unit tests', 'This is test content for the skill.', 'tikoci/routeros-skills', 'abc123', 'https://github.com/tikoci/routeros-skills/blob/abc123/routeros-test-skill/SKILL.md', 7, '2025-01-01T00:00:00Z')`);

    const row = db.prepare("SELECT id FROM skills WHERE name = 'routeros-test-skill'").get() as { id: number };

    db.run(`INSERT INTO skill_references (skill_id, path, filename, content, word_count)
      VALUES (${row.id}, 'references/test-ref.md', 'test-ref.md', 'Reference content here.', 3)`);
  });

  test("listSkills returns all skills", () => {
    const skills = listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const testSkill = skills.find(s => s.name === "routeros-test-skill");
    expect(testSkill).toBeDefined();
    if (!testSkill) throw new Error("Expected test skill to exist");
    expect(testSkill.description).toBe("Test skill for unit tests");
    expect(testSkill.word_count).toBe(7);
    expect(testSkill.ref_count).toBe(1);
  });

  test("getSkill returns full skill with provenance and references", () => {
    const skill = getSkill("routeros-test-skill");
    expect(skill).not.toBeNull();
    if (!skill) throw new Error("Expected skill details to exist");
    expect(skill.name).toBe("routeros-test-skill");
    expect(skill.content).toBe("This is test content for the skill.");
    expect(skill.provenance).toContain("PROVENANCE");
    expect(skill.provenance).toContain("tikoci/routeros-skills");
    expect(skill.source_sha).toBe("abc123");
    expect(skill.references).toHaveLength(1);
    expect(skill.references[0]?.filename).toBe("test-ref.md");
  });

  test("getSkill is case-insensitive", () => {
    const skill = getSkill("ROUTEROS-TEST-SKILL");
    expect(skill).not.toBeNull();
    if (!skill) throw new Error("Expected case-insensitive skill lookup to work");
    expect(skill.name).toBe("routeros-test-skill");
  });

  test("getSkill returns null for nonexistent skill", () => {
    const skill = getSkill("nonexistent-skill");
    expect(skill).toBeNull();
  });

  test("getSkillReference returns a specific reference file", () => {
    const ref = getSkillReference("routeros-test-skill", "test-ref.md");
    expect(ref).not.toBeNull();
    if (!ref) throw new Error("Expected skill reference to exist");
    expect(ref.content).toBe("Reference content here.");
    expect(ref.word_count).toBe(3);
  });

  test("getSkillReference returns null for nonexistent reference", () => {
    const ref = getSkillReference("routeros-test-skill", "nonexistent.md");
    expect(ref).toBeNull();
  });

  test("FTS5 indexes skill content via triggers", () => {
    const results = db.prepare(
      "SELECT rowid FROM skills_fts WHERE skills_fts MATCH 'test'"
    ).all();
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// parseVtt: WebVTT parsing (pure function, no DB)
// ---------------------------------------------------------------------------

describe("parseVtt", () => {
  const SIMPLE_VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
Hello and welcome to the VLAN tutorial.

00:00:04.000 --> 00:00:07.000
Hello and welcome to the VLAN tutorial. Today we will cover trunking.

00:00:07.000 --> 00:00:10.000
Today we will cover trunking. Let us begin.
`;

  test("parses cue start times correctly", () => {
    const cues = parseVtt(SIMPLE_VTT);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[0].start_s).toBe(1);
  });

  test("deduplicates overlapping auto-caption cues", () => {
    // Second cue text is suffix of third — only unique segments should survive
    const cues = parseVtt(SIMPLE_VTT);
    // All cue texts should be unique (no exact duplicates)
    const texts = cues.map((c) => c.text);
    const unique = new Set(texts);
    expect(unique.size).toBe(texts.length);
  });

  test("returns empty array for empty input", () => {
    expect(parseVtt("")).toEqual([]);
  });

  test("returns empty array for header-only VTT", () => {
    expect(parseVtt("WEBVTT\nKind: captions\n")).toEqual([]);
  });

  test("strips HTML tags from cue text", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<b>Bold text</b> and <i>italic</i>.\n`;
    const cues = parseVtt(vtt);
    expect(cues[0].text).not.toContain("<b>");
    expect(cues[0].text).toContain("Bold text");
  });
});

// ---------------------------------------------------------------------------
// segmentTranscript: chapter grouping (pure function, no DB)
// ---------------------------------------------------------------------------

describe("segmentTranscript", () => {
  const cues = [
    { start_s: 0, text: "Introduction begins now." },
    { start_s: 10, text: "This covers the basics." },
    { start_s: 60, text: "Chapter two starts here." },
    { start_s: 90, text: "Configuration details follow." },
  ];

  test("single segment when no chapters provided", () => {
    const segments = segmentTranscript(cues);
    expect(segments).toHaveLength(1);
    expect(segments[0].chapter_title).toBeNull();
    expect(segments[0].start_s).toBe(0);
    expect(segments[0].end_s).toBeNull();
    expect(segments[0].transcript).toContain("Introduction begins now.");
  });

  test("splits by chapter boundaries", () => {
    const chapters = [
      { title: "Introduction", start_time: 0, end_time: 60 },
      { title: "Configuration", start_time: 60, end_time: 120 },
    ];
    const segments = segmentTranscript(cues, chapters);
    expect(segments).toHaveLength(2);
    expect(segments[0].chapter_title).toBe("Introduction");
    expect(segments[1].chapter_title).toBe("Configuration");
  });

  test("cues are assigned to correct chapters", () => {
    const chapters = [
      { title: "Introduction", start_time: 0, end_time: 60 },
      { title: "Configuration", start_time: 60, end_time: 120 },
    ];
    const segments = segmentTranscript(cues, chapters);
    expect(segments[0].transcript).toContain("Introduction begins now.");
    expect(segments[0].transcript).not.toContain("Chapter two");
    expect(segments[1].transcript).toContain("Chapter two starts here.");
  });

  test("chapter start_s and end_s are set correctly", () => {
    const chapters = [
      { title: "Intro", start_time: 0, end_time: 60 },
      { title: "Body", start_time: 60, end_time: 300 },
    ];
    const segments = segmentTranscript(cues, chapters);
    expect(segments[0].start_s).toBe(0);
    expect(segments[0].end_s).toBe(60); // next chapter start
    expect(segments[1].start_s).toBe(60);
    expect(segments[1].end_s).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// searchVideos: FTS against video_segments_fts (integration, uses fixture DB)
// ---------------------------------------------------------------------------

describe("searchVideos", () => {
  test("finds segments matching query", () => {
    const results = searchVideos("VLAN trunking bridge");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("RouterOS VLAN Tutorial");
  });

  test("returns video_id and url", () => {
    const results = searchVideos("VLAN");
    expect(results[0].video_id).toBe("abc123");
    expect(results[0].url).toContain("youtube.com");
  });

  test("returns chapter_title when available", () => {
    const results = searchVideos("vlan filtering bridge");
    const chapterResult = results.find((r) => r.chapter_title !== null);
    expect(chapterResult).toBeDefined();
  });

  test("returns null chapter_title for no-chapter video", () => {
    const results = searchVideos("BGP peering route reflection");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chapter_title).toBeNull();
  });

  test("returns empty array for empty query", () => {
    expect(searchVideos("")).toEqual([]);
  });

  test("respects limit parameter", () => {
    const results = searchVideos("RouterOS", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// searchDude: FTS against dude_pages_fts (integration, uses fixture DB)
// ---------------------------------------------------------------------------

describe("searchDude", () => {
  test("finds pages matching query", () => {
    const results = searchDude("probes SNMP");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("Probes");
  });

  test("returns image_count for pages with images", () => {
    const results = searchDude("probes");
    expect(results[0].image_count).toBe(2);
  });

  test("returns version field", () => {
    const results = searchDude("probes");
    expect(results[0].version).toBe("v6");
  });

  test("finds v3 pages", () => {
    const results = searchDude("notifications email");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].version).toBe("v3");
  });

  test("AND→OR fallback finds results", () => {
    const results = searchDude("device discovery subnet ICMP");
    expect(results.length).toBeGreaterThan(0);
  });

  test("returns empty array for empty query", () => {
    expect(searchDude("")).toEqual([]);
  });

  test("respects limit parameter", () => {
    const results = searchDude("dude", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("searchPages adds a Dude-specific hint for explicit Dude queries", () => {
    const results = searchPages("the dude probes");
    expect(results.note).toContain("routeros_dude_search");
  });
});

// ---------------------------------------------------------------------------
// getDudePage: full page retrieval with images (integration, uses fixture DB)
// ---------------------------------------------------------------------------

describe("getDudePage", () => {
  test("returns page by ID with images", () => {
    const page = getDudePage(1);
    expect(page).not.toBeNull();
    expect(page?.title).toBe("Probes");
    expect(page?.images.length).toBe(2);
    expect(page?.images[0]?.filename).toBe("Dude-probes-all.JPG");
  });

  test("returns page by title", () => {
    const page = getDudePage("Probes");
    expect(page).not.toBeNull();
    expect(page?.id).toBe(1);
  });

  test("returns page by slug", () => {
    const page = getDudePage("Device_discovery");
    expect(page).not.toBeNull();
    expect(page?.title).toBe("Device Discovery");
    expect(page?.images.length).toBe(1);
  });

  test("returns null for non-existent page", () => {
    expect(getDudePage(999)).toBeNull();
    expect(getDudePage("NonExistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// KNOWN_TOPICS
// ---------------------------------------------------------------------------

describe("KNOWN_TOPICS", () => {
  test("contains core RouterOS subsystems", () => {
    expect(KNOWN_TOPICS.has("firewall")).toBe(true);
    expect(KNOWN_TOPICS.has("bridge")).toBe(true);
    expect(KNOWN_TOPICS.has("bgp")).toBe(true);
    expect(KNOWN_TOPICS.has("ospf")).toBe(true);
    expect(KNOWN_TOPICS.has("container")).toBe(true);
    expect(KNOWN_TOPICS.has("wifi")).toBe(true);
    expect(KNOWN_TOPICS.has("ipsec")).toBe(true);
    expect(KNOWN_TOPICS.has("dns")).toBe(true);
  });

  test("contains changelog-derived categories", () => {
    expect(KNOWN_TOPICS.has("winbox")).toBe(true);
    expect(KNOWN_TOPICS.has("hotspot")).toBe(true);
    expect(KNOWN_TOPICS.has("lte")).toBe(true);
    expect(KNOWN_TOPICS.has("wireguard")).toBe(true);
    expect(KNOWN_TOPICS.has("zerotier")).toBe(true);
  });

  test("contains top-level command paths", () => {
    expect(KNOWN_TOPICS.has("ip")).toBe(true);
    expect(KNOWN_TOPICS.has("system")).toBe(true);
    expect(KNOWN_TOPICS.has("interface")).toBe(true);
    expect(KNOWN_TOPICS.has("app")).toBe(true);
  });

  test("does not contain stop words", () => {
    expect(KNOWN_TOPICS.has("the")).toBe(false);
    expect(KNOWN_TOPICS.has("how")).toBe(false);
    expect(KNOWN_TOPICS.has("configure")).toBe(false);
  });

  test("has reasonable size (80-200 entries)", () => {
    expect(KNOWN_TOPICS.size).toBeGreaterThanOrEqual(80);
    expect(KNOWN_TOPICS.size).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

describe("lookupGlossary", () => {
  test("finds exact term match", () => {
    const result = lookupGlossary("chr");
    expect(result).not.toBeNull();
    expect(result?.term).toBe("chr");
    expect(result?.definition).toContain("Cloud Hosted Router");
    expect(result?.category).toBe("product");
  });

  test("case-insensitive lookup", () => {
    const result = lookupGlossary("CHR");
    expect(result).not.toBeNull();
    expect(result?.term).toBe("chr");
  });

  test("finds term by alias", () => {
    const result = lookupGlossary("openvpn");
    expect(result).not.toBeNull();
    expect(result?.term).toBe("ovpn");
  });

  test("returns null for unknown term", () => {
    expect(lookupGlossary("nonexistentterm")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(lookupGlossary("")).toBeNull();
  });

  test("search_hint field is populated", () => {
    const result = lookupGlossary("capsman");
    expect(result).not.toBeNull();
    expect(result?.search_hint).toBeTruthy();
    expect(result?.search_hint).toContain("CAPsMAN");
  });
});

describe("listGlossary", () => {
  test("returns all entries when no category", () => {
    const entries = listGlossary();
    expect(entries.length).toBeGreaterThanOrEqual(40);
  });

  test("filters by category", () => {
    const products = listGlossary("product");
    expect(products.length).toBeGreaterThan(0);
    expect(products.every(e => e.category === "product")).toBe(true);
  });

  test("returns empty for non-existent category", () => {
    expect(listGlossary("nonexistent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchAll — unified entrypoint behavior
// ---------------------------------------------------------------------------

describe("searchAll related block", () => {
  test("exposes command path confidence in classified output", () => {
    const res = searchAll("/ip/dhcp-server");
    expect(res.classified.command_path).toBe("/ip/dhcp-server");
    expect(res.classified.command_path_confidence).toBe("medium");
  });

  test("includes property lookup confidence in related properties", () => {
    const res = searchAll("lease-time");
    expect(res.related.properties?.length).toBeGreaterThan(0);
    expect(res.related.properties?.[0].confidence).toBe("medium");
  });

  test("includes changelogs for major.minor version questions backed only by patch rows", () => {
    const res = searchAll("what changed in 7.23");
    expect(res.classified.version).toBe("7.23");
    expect(res.related.changelogs?.length).toBeGreaterThan(0);
    expect(res.related.changelogs?.every((row) => row.version === "7.23.1")).toBe(true);
  });

  test("includes glossary when input matches a glossary term", () => {
    const res = searchAll("chr");
    expect(res.related).toBeDefined();
    expect(res.related?.glossary).toBeDefined();
    expect(res.related?.glossary?.term).toBe("chr");
  });

  test("does not include glossary for unknown terms", () => {
    const res = searchAll("nonexistentwidgetxyz");
    expect(res.related?.glossary).toBeUndefined();
  });

  test("scales callout cap with limit (hunger knob)", () => {
    // Compare cap behaviour at limit=8 (default) vs limit=30.
    // We don't assert exact counts — fixture data may not have many callouts —
    // but we assert that the higher-limit response doesn't artificially cap
    // BELOW what the lower-limit one returns.
    const small = searchAll("dhcp", 8);
    const big = searchAll("dhcp", 30);
    const smallCallouts = small.related?.callouts?.length ?? 0;
    const bigCallouts = big.related?.callouts?.length ?? 0;
    expect(bigCallouts).toBeGreaterThanOrEqual(smallCallouts);
  });
});
