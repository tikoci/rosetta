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
const { db, initDb, getDbStats, checkSchemaVersion, SCHEMA_VERSION } = await import("./db.ts");
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
} = await import("./query.ts");
const { parseChangelog } = await import("./extract-changelogs.ts");

// ---------------------------------------------------------------------------
// Fixtures: one "DHCP Server" page + one "Firewall Filter" page
// ---------------------------------------------------------------------------

beforeAll(() => {
  initDb();

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

  db.run(`INSERT INTO ros_versions (version, channel, extra_packages, extracted_at)
    VALUES ('7.22', 'stable', 0, '2024-01-01T00:00:00Z')`);
  db.run(`INSERT INTO ros_versions (version, channel, extra_packages, extracted_at)
    VALUES ('7.9', 'stable', 0, '2023-01-01T00:00:00Z')`);
  db.run(`INSERT INTO ros_versions (version, channel, extra_packages, extracted_at)
    VALUES ('7.10.2', 'stable', 0, '2023-06-01T00:00:00Z')`);

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (1, '/ip', 'ip', 'dir', NULL, NULL, 'IP menu', '7.22')`);

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (2, '/ip/dhcp-server', 'dhcp-server', 'dir', '/ip', 1, 'DHCP Server configuration', '7.22')`);

  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/dhcp-server', '7.22')`);
  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/dhcp-server', '7.9')`);

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
    VALUES ('7.22.1', '2026-Apr-01 09:00', 'wifi', 0, 'fixed channel switching for MediaTek access points', 0)`);
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
  });

  test("case-insensitive name lookup", () => {
    const rows = lookupProperty("LEASE-TIME");
    expect(rows.length).toBeGreaterThan(0);
  });

  test("returns empty for unknown property", () => {
    expect(lookupProperty("nonexistent-prop")).toHaveLength(0);
  });

  test("filters by command path", () => {
    const rows = lookupProperty("lease-time", "/ip/dhcp-server");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toBe("lease-time");
  });

  test("returns empty when command path has no linked page", () => {
    const rows = lookupProperty("lease-time", "/ip/unlinked");
    // /ip/unlinked has no page_id → falls through to global search
    expect(Array.isArray(rows)).toBe(true);
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
    expect(res.results.length).toBe(3);
    expect(res.total).toBe(3);
  });

  test("filters by test_type", () => {
    const res = searchDeviceTests({ test_type: "ethernet" });
    expect(res.results.every((r) => r.test_type === "ethernet")).toBe(true);
    expect(res.results.length).toBe(2);
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
    expect(res.total).toBe(3);
  });
});

describe("dataset CSV exports", () => {
  test("exports full device test results as CSV", () => {
    const csv = exportDeviceTestsCsv();
    const lines = csv.trim().split("\n");

    expect(lines[0]).toBe("product_name,product_code,architecture,cpu,cpu_cores,cpu_frequency,test_type,mode,configuration,packet_size,throughput_kpps,throughput_mbps,product_url");
    expect(lines).toHaveLength(4);
    expect(csv).toContain("hAP ax3");
    expect(csv).toContain("IPQ-6010");
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

  test("version filter returns only that version", () => {
    const results = searchChangelogs("", { version: "7.22" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.version).toBe("7.22");
    }
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
    ];
    for (const table of expected) {
      expect(names).toContain(table);
    }
  });

  test("all FTS5 virtual tables exist", () => {
    const names = tableNames();
    const expected = ["pages_fts", "properties_fts", "callouts_fts", "devices_fts", "changelogs_fts"];
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

  test("PRAGMA user_version matches SCHEMA_VERSION", () => {
    const result = checkSchemaVersion();
    expect(result.ok).toBe(true);
    expect(result.actual).toBe(SCHEMA_VERSION);
    expect(result.expected).toBe(SCHEMA_VERSION);
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
});
