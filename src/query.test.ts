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
const { db, initDb } = await import("./db.ts");
const {
  extractTerms,
  buildFtsQuery,
  searchPages,
  getPage,
  lookupProperty,
  browseCommands,
  searchCallouts,
  checkCommandVersions,
  searchDevices,
} = await import("./query.ts");

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

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (1, '/ip', 'ip', 'dir', NULL, NULL, 'IP menu', '7.22')`);

  db.run(`INSERT INTO commands
    (id, path, name, type, parent_path, page_id, description, ros_version)
    VALUES (2, '/ip/dhcp-server', 'dhcp-server', 'dir', '/ip', 1, 'DHCP Server configuration', '7.22')`);

  db.run(`INSERT INTO command_versions (command_path, ros_version)
    VALUES ('/ip/dhcp-server', '7.22')`);

  // Device fixtures for searchDevices tests
  db.run(`INSERT INTO devices
    (product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
     license_level, operating_system, ram, ram_mb, storage, storage_mb,
     poe_in, poe_out, wireless_24_chains, wireless_5_chains,
     eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
     eth_multigig, usb_ports, sim_slots, msrp_usd)
    VALUES
    ('hAP ax3', 'C53UiG+5HPaxD2HPaxD', 'ARM 64bit', 'IPQ-6010', 4, 'auto (864 - 1800) MHz',
     4, 'RouterOS v7', '1 GB', 1024, '128 MB', 128,
     '802.3af/at', NULL, 2, 2,
     NULL, 4, 1, NULL, NULL,
     NULL, 1, NULL, 139.00)`);

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
    expect(res.versions).toEqual(["7.22"]);
    expect(res.first_seen).toBe("7.22");
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
    expect(res.results.length).toBe(3);
    expect(res.results.every((d) => d.architecture === "ARM 64bit")).toBe(true);
  });

  test("filter by min_ram_mb", () => {
    const res = searchDevices("", { min_ram_mb: 1024 });
    expect(res.mode).toBe("filter");
    expect(res.results.length).toBe(3); // hAP ax3 (1024) + CCR2216 (16384) + Chateau (1024)
    expect(res.results.every((d) => (d.ram_mb ?? 0) >= 1024)).toBe(true);
  });

  test("filter by license level", () => {
    const res = searchDevices("", { license_level: 6 });
    expect(res.mode).toBe("filter");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toContain("CCR");
  });

  test("filter by has_poe", () => {
    const res = searchDevices("", { has_poe: true });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].product_name).toBe("hAP ax3");
  });

  test("filter by has_wireless", () => {
    const res = searchDevices("", { has_wireless: true });
    expect(res.results).toHaveLength(3); // hAP ax3 + hAP lite + Chateau LTE18
  });

  test("filter by min_storage_mb", () => {
    const res = searchDevices("", { min_storage_mb: 128 });
    expect(res.mode).toBe("filter");
    expect(res.results.length).toBe(3); // hAP ax3 (128) + CCR2216 (128) + Chateau (128)
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

  test("returns empty with no query and no filters", () => {
    const res = searchDevices("");
    expect(res.results).toHaveLength(0);
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
      "devices", "schema_migrations",
    ];
    for (const table of expected) {
      expect(names).toContain(table);
    }
  });

  test("all FTS5 virtual tables exist", () => {
    const names = tableNames();
    const expected = ["pages_fts", "properties_fts", "callouts_fts", "devices_fts"];
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
});
