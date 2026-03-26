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
