// Force in-memory DB before importing extract-docusaurus.ts (which transitively imports
// db.ts) — same guard as extract-dude.test.ts. See BACKLOG.md "Test DB-leak guards".
process.env.DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// query.ts MUST be imported dynamically, not statically: it transitively loads db.ts, and an
// ESM static import is hoisted ABOVE the process.env.DB_PATH assignment above — so a static
// form opens the real on-disk ros-help.db instead of :memory:. That poisons the db.ts
// singleton for every later test file in the same run, which query.test.ts's V-db-wipe-guard
// then trips on ("DB singleton is at .../ros-help.db"). It only surfaces when this file is the
// first to touch db.ts, so it presents as an order-dependent CI flake; bun's file order is not
// stable, so it stays hidden locally. Same rule as the extract-docusaurus.ts import below —
// see .github/instructions/extractor-import-side-effects.instructions.md, hazard 2.
const { EXCERPT_MARK_END, EXCERPT_MARK_START } = await import("./query.ts");

const {
  isInScopeDocsUrl,
  parseProperties,
  parseCallouts,
  parseSections,
  parsePage,
  resolveDescriptionLinks,
  extractCodeBlocks,
  slugify,
  parseLlmsTxtInScopeCount,
  markdownUrlFor,
  expandDocCardLists,
  cardMetaFor,
  directChildIds,
  attributeSection,
  LEAD_ANCHOR,
  splitTableRow,
  parseTables,
  resolvePropertyColumns,
} = await import("./extract-docusaurus.ts");

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "docusaurus");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf-8");

const dhcpMd = read("dhcp.md");
const smsMd = read("sms.md");
const dot1xMd = read("dot1x.md");
const addressListsMd = read("address-lists.md");
const queuesMd = read("queues.md");
const schedulerMd = read("scheduler.md");
const productNamingMd = read("product-naming.md");
// Four "Properties" headings on one page — the natural fixture for issue #90's repeated-heading
// collision, named as such in the issue itself.
const pppAaaMd = read("ppp-aaa.md");
const appsMd = read("apps.md");
const vethMd = read("veth.md");

const DHCP_URL = "https://manual.mikrotik.com/docs/network-management/dhcp";
const SMS_URL = "https://manual.mikrotik.com/docs/mobile-networking/sms";
const ADDRESS_LISTS_URL = "https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/address-lists";
const PPP_AAA_URL = "https://manual.mikrotik.com/docs/authentication-authorization-accounting/ppp-aaa";

describe("isInScopeDocsUrl", () => {
  test("accepts ordinary /docs prose pages", () => {
    expect(isInScopeDocsUrl(DHCP_URL)).toBeTrue();
    expect(isInScopeDocsUrl("/docs/network-management/dhcp")).toBeTrue();
  });

  test("rejects CLI Reference pages", () => {
    expect(isInScopeDocsUrl("https://manual.mikrotik.com/docs/cli-reference/ip/address")).toBeFalse();
  });

  test("rejects tag-index pages, including the bare tags root (no trailing slash — real 404 live)", () => {
    expect(isInScopeDocsUrl("https://manual.mikrotik.com/docs/tags/dhcp")).toBeFalse();
    expect(isInScopeDocsUrl("https://manual.mikrotik.com/docs/tags")).toBeFalse();
  });

  test("rejects non-/docs sections (hardware, changelog, blog)", () => {
    expect(isInScopeDocsUrl("https://manual.mikrotik.com/hardware/rb5009")).toBeFalse();
    expect(isInScopeDocsUrl("https://manual.mikrotik.com/changelog/changelog-2026-05-25")).toBeFalse();
    expect(isInScopeDocsUrl("https://manual.mikrotik.com/blog/news130")).toBeFalse();
  });
});

describe("markdownUrlFor", () => {
  test("appends .md to an ordinary leaf page URL", () => {
    expect(markdownUrlFor(DHCP_URL)).toBe(`${DHCP_URL}.md`);
  });

  test("appends index.md (not .md) to a category/index page URL — real 404 otherwise", () => {
    // Confirmed live 2026-07-07: .../accounting.md 404s, .../accounting/index.md is 200.
    const categoryUrl = "https://manual.mikrotik.com/docs/authentication-authorization-accounting/";
    expect(markdownUrlFor(categoryUrl)).toBe(`${categoryUrl}index.md`);
  });
});

describe("slugify", () => {
  test("produces a github-slugger-style anchor", () => {
    expect(slugify("DHCP Client")).toBe("dhcp-client");
    expect(slugify("Read-only properties")).toBe("read-only-properties");
  });
});

describe("generic pipe-table parsing (issue #92)", () => {
  test("splitTableRow decodes escaped pipes and preserves real leading, interior, and trailing empty cells", () => {
    expect(splitTableRow("| | md5 \\| sha1 | | ")).toEqual(["", "md5 | sha1", ""]);
  });

  test("retains raw Markdown, empty cells, and actual ragged row widths", () => {
    const md = [
      "## Matrix",
      "| A | B | C |",
      "|---|---|---|",
      "| | x \\| y | |",
      "| short | row |",
    ].join("\n");
    const [table] = parseTables(md);
    expect(table.rawMarkdown).toBe(md.split("\n").slice(1).join("\n"));
    expect(table.header.cells).toEqual(["A", "B", "C"]);
    expect(table.rows.map((row) => row.cells)).toEqual([
      ["", "x | y", ""],
      ["short", "row"],
    ]);
    expect(table.columnCount).toBe(3);
    expect(table.dataRowCount).toBe(2);
    expect(table.isRagged).toBeTrue();
    expect(table.sourceHeading).toBe("Matrix");
  });

  test("finds multiple tables in source order and excludes backtick/tilde fenced lookalikes", () => {
    const md = [
      "## Shared",
      "| One |",
      "|---|",
      "| 1 |",
      "```md",
      "| Hidden |",
      "|---|",
      "| no |",
      "```",
      "~~~",
      "| Also hidden |",
      "|---|",
      "| no |",
      "~~~",
      "| Two |",
      "|---|",
      "| 2 |",
    ].join("\n");
    const tables = parseTables(md);
    expect(tables.map((table) => table.header.cells[0])).toEqual(["One", "Two"]);
    expect(tables.map((table) => table.sortOrder)).toEqual([0, 1]);
    expect(tables.map((table) => table.sourceHeading)).toEqual(["Shared", "Shared"]);
    expect(parsePage(md, "https://manual.mikrotik.com/docs/example").tables.map((table) => table.sectionAnchor)).toEqual([
      "shared",
      "shared",
    ]);
  });

  test("tracks a fence opened on a multi-digit ordered-list item instead of hiding later tables", () => {
    const md = [
      "10. ```ros",
      "| Not | A | Table |",
      "|---|---|---|",
      "    ```",
      "| Property | Description |",
      "|---|---|",
      "| **visible** (yes \\| no) | Kept. |",
    ].join("\n");
    const tables = parseTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0].header.cells).toEqual(["Property", "Description"]);
    expect(parseProperties(md).map((property) => property.name)).toEqual(["visible"]);
  });
});

describe("parseProperties — dhcp.md (real malformed-emphasis case, B-0012 H4)", () => {
  const properties = parseProperties(dhcpMd);

  test("finds a realistic number of properties across the whole page", () => {
    // dhcp.md has multiple "### Properties"/"#### Read-only properties" tables
    // (client + server + DHCPv6). Anchor on a floor, not an exact count, so a future
    // MikroTik doc edit doesn't spuriously fail this test the way an exact-count
    // assertion would — matching the "durable, trend toward catching real drift" goal.
    expect(properties.length).toBeGreaterThan(50);
  });

  test("flags check-gateway's malformed bold/italic collision, not just any property", () => {
    const checkGateway = properties.find((p) => p.name === "check-gateway");
    expect(checkGateway).toBeDefined();
    expect(checkGateway?.malformedEmphasis).toBeTrue();
    expect(checkGateway?.defaultVal).toBe("none");
  });

  test("parses a well-formed property cleanly (not flagged malformed)", () => {
    const disabled = properties.find((p) => p.name === "disabled" && p.section === "Properties");
    expect(disabled).toBeDefined();
    expect(disabled?.malformedEmphasis).toBeFalse();
    expect(disabled?.defaultVal).toBe("yes");
    expect(disabled?.rawType).toContain("yes");
  });

  test("attributes properties to the nearest preceding heading as section", () => {
    const readOnly = properties.find((p) => p.section === "Read-only properties");
    expect(readOnly).toBeDefined();
  });

  test("leaves the relative link target as-is at the parseProperties layer (resolution happens in parsePage)", () => {
    const useDns = properties.find((p) => p.name === "use-peer-dns");
    expect(useDns?.description).toContain("./dhcp.md#dhcp-server");
  });
});

describe("parseProperties — sms.md (real 'Parameter' header spelling, not 'Property')", () => {
  test("recognizes the 'Parameter' header spelling used on sms.md", () => {
    const properties = parseProperties(smsMd);
    expect(properties.length).toBeGreaterThan(5);
    expect(properties.some((p) => p.name === "phone-number")).toBeTrue();
  });

  test("handles an empty Default value without crashing or eating the next cell", () => {
    const properties = parseProperties(smsMd);
    const smsc = properties.find((p) => p.name === "smsc");
    expect(smsc).toBeDefined();
    expect(smsc?.defaultVal).toBeNull();
  });
});

describe("parseProperties — address-lists.md (no property table at all)", () => {
  test("returns an empty array rather than a false-positive match", () => {
    expect(parseProperties(addressListsMd)).toEqual([]);
  });
});

describe("resolvePropertyColumns — header-name column resolution (issue #132)", () => {
  const shape = (header: string) => resolvePropertyColumns(splitTableRow(header));

  test("resolves the plain two-column shape that dominates the corpus", () => {
    expect(shape("| Property | Description |")).toEqual({ name: 0, type: null, default: null, description: 1 });
  });

  test("resolves four-column Property/Type/Default/Description", () => {
    expect(shape("| Property | Type | Default | Description |")).toEqual({
      name: 0,
      type: 1,
      default: 2,
      description: 3,
    });
  });

  test("resolves the 'Parameter' header spelling identically to 'Property'", () => {
    expect(shape("| Parameter | Type | Default | Description |")).toEqual({
      name: 0,
      type: 1,
      default: 2,
      description: 3,
    });
  });

  test("resolves three-column Property/Type/Description (route-selection-and-filtering shape)", () => {
    expect(shape("| Property | Type | Description |")).toEqual({ name: 0, type: 1, default: null, description: 2 });
  });

  test("tolerates bold header cells", () => {
    expect(shape("| **Property** | **Description** |")).toEqual({ name: 0, type: null, default: null, description: 1 });
  });

  test("ignores trailing columns it does not recognize (Parameter/Description/Example)", () => {
    expect(shape("| Parameter | Description | Example |")).toEqual({
      name: 0,
      type: null,
      default: null,
      description: 1,
    });
  });

  test("rejects a feature matrix whose first header cell merely contains 'Property' (device-mode)", () => {
    // The real regression: `| **Feature / Property** | **Home** | **Basic** | **Advanced** | **ROSE** |`
    // passed the old header regex and minted 14 rows whose "description" was the Home column.
    expect(shape("| **Feature / Property** | **Home** | **Basic** | **Advanced** | **ROSE** |")).toBeNull();
  });

  test("requires an exact Property/Parameter header even when a Description column is present", () => {
    // The missing-Description rule alone would accept this; the corpus does not contain it
    // today, but the contract is "resolve by header name", not "whatever the corpus happens
    // to hold". Same reason `| Menu | Parameter names | Page link |` must not resolve.
    expect(shape("| Feature / Property | Description |")).toBeNull();
    expect(shape("| Parameter names | Description |")).toBeNull();
  });

  test("rejects a table with no Description column at all", () => {
    expect(shape("| Parameter | Value |")).toBeNull();
    expect(shape("| Menu | Parameter names | Page link |")).toBeNull();
  });

  test("rejects a table whose Description column precedes the name column", () => {
    expect(shape("| Description | Property |")).toBeNull();
  });
});

describe("parseProperties — apps.md (real four-column table, issue #132)", () => {
  const properties = parseProperties(appsMd);

  test("stores the Description column as the description, not the Type column", () => {
    const autoUpdate = properties.find((p) => p.name === "auto-update");
    expect(autoUpdate?.description).toBe(
      "Enables or disables automatic updating when a new container image version is available.",
    );
  });

  test("populates rawType and defaultVal from their own columns", () => {
    const autoUpdate = properties.find((p) => p.name === "auto-update");
    expect(autoUpdate?.rawType).toBe("yes | no");
    expect(autoUpdate?.defaultVal).toBe("no");
  });

  test("decodes the Markdown &#124; pipe escape rather than storing the literal entity", () => {
    expect(properties.some((p) => p.description.includes("&#124;"))).toBeFalse();
    expect(properties.some((p) => (p.rawType ?? "").includes("&#124;"))).toBeFalse();
    const network = properties.find((p) => p.name === "network");
    expect(network?.rawType).toBe("default | lan | internal");
  });

  test("keeps both auto-update records — they are distinct properties, not duplicates", () => {
    // #132 reported these as duplicated rows; they only *looked* identical because the
    // column shift replaced both descriptions with the same Type cell. Do not dedupe.
    const autoUpdates = properties.filter((p) => p.name === "auto-update");
    expect(autoUpdates).toHaveLength(2);
    expect(autoUpdates[0].description).not.toBe(autoUpdates[1].description);
  });

  test("recovers descriptions on rows whose Type cell is empty", () => {
    // `| **app-size** | | | The total size of the application. |` previously stored "".
    const appSize = properties.find((p) => p.name === "app-size");
    expect(appSize?.description).toBe("The total size of the application.");
    expect(appSize?.rawType).toBeNull();
  });
});

describe("parseProperties — veth.md (four-column table with no entity to flag it, issue #132)", () => {
  const properties = parseProperties(vethMd);

  test("stores the prose description, not the Type cell", () => {
    const address = properties.find((p) => p.name === "address");
    expect(address?.description).toBe("IPv4 or IPv6 address that will be assigned to the interface");
    expect(address?.rawType).toBe("IPv4/IPv6 address");
    expect(address?.defaultVal).toBe("None");
  });

  test("extracts every row of the single Parameter table", () => {
    expect(properties.map((p) => p.name)).toEqual([
      "address",
      "gateway",
      "gateway6",
      "mac-address",
      "container-mac-address",
      "dhcp",
      "name",
    ]);
  });
});

describe("parseProperties — synthetic column shapes (issue #132)", () => {
  test("a dedicated Type column wins over a parenthetical annotation in the name cell", () => {
    const md = [
      "| Property | Type | Description |",
      "|---|---|---|",
      "| **speed** (legacy-inline) | *integer* | Link speed. |",
    ].join("\n");
    const [property] = parseProperties(md);
    expect(property.rawType).toBe("integer");
    expect(property.description).toBe("Link speed.");
  });

  test("falls back to the name-cell annotation when the row's Type cell is empty", () => {
    const md = ["| Property | Type | Description |", "|---|---|---|", "| **speed** (integer) | | Link speed. |"].join(
      "\n",
    );
    const [property] = parseProperties(md);
    expect(property.rawType).toBe("integer");
  });

  test("skips a row too short to reach its Description column instead of storing undefined", () => {
    const md = ["| Property | Type | Default | Description |", "|---|---|---|---|", "| **speed** | *integer* |"].join(
      "\n",
    );
    expect(parseProperties(md)).toEqual([]);
  });

  test("yields nothing from a feature matrix even when its name cells are bold kebab-case", () => {
    const md = [
      "| **Feature / Property** | **Home** | **Advanced** |",
      "|---|---|---|",
      "| **containers** (/container) | No | Yes |",
    ].join("\n");
    expect(parseProperties(md)).toEqual([]);
  });

  test("yields nothing from a two-column feature matrix that does have a Description column", () => {
    const md = [
      "| Feature / Property | Description |",
      "|---|---|",
      "| **containers** | Supported feature. |",
    ].join("\n");
    expect(parseProperties(md)).toEqual([]);
  });

  test("strips paired emphasis from Type/Default cells but preserves a literal asterisk", () => {
    const md = [
      "| Property | Type | Default | Description |",
      "|---|---|---|---|",
      "| **match** | *string* | `*` | Wildcard default must survive. |",
      "| **glob** | a*b | **None** | An unpaired interior asterisk is content. |",
    ].join("\n");
    const [match, glob] = parseProperties(md);
    expect(match.rawType).toBe("string");
    expect(match.defaultVal).toBe("`*`");
    expect(glob.rawType).toBe("a*b");
    expect(glob.defaultVal).toBe("None");
  });
});

describe("parseProperties — queues.md (bullet-list properties, issue #20)", () => {
  const properties = parseProperties(queuesMd);

  test("extracts bullet-list properties across multiple sections, not just tables", () => {
    // Real gain for issue #20: Flow Identifiers, Other properties, HTB Properties,
    // Statistics, and PCQ are all bullet-list-only sections with zero table rows.
    expect(properties.filter((p) => p.section === "Other properties").length).toBeGreaterThanOrEqual(5);
    expect(properties.filter((p) => p.section === "HTB Properties").length).toBeGreaterThanOrEqual(14);
    expect(properties.filter((p) => p.section === "Statistics").length).toBeGreaterThanOrEqual(20);
    expect(properties.filter((p) => p.section === "PCQ").length).toBeGreaterThanOrEqual(11);
  });

  test("parses a well-formed bare-paren bullet (queue direction)", () => {
    const direction = properties.find((p) => p.name === "direction");
    expect(direction).toBeDefined();
    expect(direction?.malformedEmphasis).toBeFalse();
    expect(direction?.rawType).toContain("upload");
  });

  test("splits type and default out of a bullet with an inline default", () => {
    const classifier = properties.find((p) => p.name === "pcq-classifier");
    expect(classifier).toBeDefined();
    expect(classifier?.defaultVal).toBe('""');
    expect(classifier?.rawType).toContain("dst-address");
  });

  test("does not mint a fake property from an uppercase-acronym concept bullet (CIR/MIR)", () => {
    // "**CIR** (Committed Information Rate) – (**limit-at** in RouterOS) ..." explains a
    // concept and points at the real property (limit-at), it does not define a property
    // named CIR. Real RouterOS property names are always lowercase kebab-case.
    expect(properties.some((p) => p.name === "CIR" || p.name === "MIR")).toBeFalse();
  });
});

describe("parseProperties — scheduler.md (bullet-list properties, italicized-paren shape)", () => {
  const properties = parseProperties(schedulerMd);

  test("extracts all Properties-section bullets", () => {
    expect(properties.length).toBe(6);
    expect(properties.every((p) => p.section === "Properties")).toBeTrue();
  });

  test("flags the real upstream typo (missing opening paren) as malformed, not silently dropped", () => {
    const name = properties.find((p) => p.name === "name");
    expect(name).toBeDefined();
    expect(name?.malformedEmphasis).toBeTrue();
    expect(name?.rawType).toBeNull();
    expect(name?.description).toBe("Name of the task.");
  });

  test("parses a well-formed italicized-paren bullet with an inline default", () => {
    const interval = properties.find((p) => p.name === "interval");
    expect(interval).toBeDefined();
    expect(interval?.malformedEmphasis).toBeFalse();
    expect(interval?.rawType).toBe("time");
    expect(interval?.defaultVal).toBe("0s");
  });
});

describe("parseProperties — product-naming.md (false-positive guard, issue #20)", () => {
  test("mints no properties from ordinary bold-lead bullets with no parenthetical annotation", () => {
    // "- **band**:" / "- **protocol**:" / nested "- **ac** - For cards with ..." are naming
    // explanations, not property definitions — none carry a `(type)` right after the bold term.
    expect(parseProperties(productNamingMd)).toEqual([]);
  });
});

describe("parseCallouts — dot1x.md (real live :::: fenced admonitions)", () => {
  const callouts = parseCallouts(dot1xMd);

  test("finds every :::: warning block on the page", () => {
    expect(callouts.length).toBe(4);
    expect(callouts.every((c) => c.type === "warning")).toBeTrue();
  });

  test("captures real callout content, not an empty fence", () => {
    expect(callouts[0].content).toContain("not supported on SMIPS devices");
  });
});

describe("parseCallouts — address-lists.md (no admonitions)", () => {
  test("returns an empty array", () => {
    expect(parseCallouts(addressListsMd)).toEqual([]);
  });
});

describe("parseSections", () => {
  test("skips the duplicated title H1 (real quirk: raw .md repeats '# Title' after the summary blockquote)", () => {
    const sections = parseSections(dot1xMd, "Dot1X");
    const topLevel = sections.filter((s) => s.level === 1);
    expect(topLevel.length).toBe(0); // both H1 occurrences are the title; neither should mint a section
  });

  test("splits on h1-h3 but folds deeper headings into the enclosing section's text", () => {
    const sections = parseSections(dhcpMd, "DHCP");
    const summary = sections.find((s) => s.heading === "Summary");
    expect(summary).toBeDefined();
    expect(summary?.level).toBe(3);
  });

  test("de-duplicates colliding anchor ids within a page", () => {
    // dhcp.md has more than one "Example"-style heading across its DHCP Client /
    // DHCPv6 Client / DHCP Server subsections at different heading levels.
    const sections = parseSections(dhcpMd, "DHCP");
    const anchors = sections.map((s) => s.anchorId);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  test("a page whose only headings are the duplicated title yields a single lead (H0) fragment (B-0023)", () => {
    // address-lists.md has no h2/h3 at all — both its headings are the "Address-lists"
    // title duplicate, so both get dropped. Its entire body is therefore lead content:
    // one synthetic lead fragment (anchor "_lead", level 0) so the prose is addressable
    // and rolls up, rather than orphaned as pre-B-0023 (this was the `[]` case before).
    const sections = parseSections(addressListsMd, "Address-lists");
    expect(sections.length).toBe(1);
    expect(sections[0].anchorId).toBe(LEAD_ANCHOR);
    expect(sections[0].level).toBe(0);
    expect(sections[0].wordCount).toBeGreaterThan(0);
    expect(sections[0].text).not.toContain("# Address-lists");
  });

  test("a lead fragment excludes title headings around summary prose and precedes real sections (B-0023)", () => {
    const md = [
      "# Page", // initial title H1 (dropped)
      "",
      "> Summary blockquote about the page.", // lead prose
      "",
      "# Page", // live Docusaurus shape repeats the title after the summary (also dropped)
      "",
      "Intro paragraph before any section.",
      "",
      "## Real Section",
      "body",
    ].join("\n");
    const sections = parseSections(md, "Page");
    expect(sections[0].anchorId).toBe(LEAD_ANCHOR);
    expect(sections[0].level).toBe(0);
    expect(sections[0].sortOrder).toBe(0);
    expect(sections[0].text).toContain("Summary blockquote");
    expect(sections[0].text).toContain("Intro paragraph");
    expect(sections[0].text).not.toContain("# Page");
    // real section follows the lead, renumbered to sort_order 1
    expect(sections[1].anchorId).toBe("real-section");
    expect(sections[1].sortOrder).toBe(1);
  });

  test("a title-only lead (no prose before the first heading) mints no lead fragment (B-0023 empty rule)", () => {
    const md = ["# Page", "", "## First", "body"].join("\n");
    const sections = parseSections(md, "Page");
    expect(sections.map((s) => s.anchorId)).toEqual(["first"]);
    expect(sections[0].sortOrder).toBe(0);
  });
});

// ── Section identity / attribution (issue #90) ──
//
// The shipped v0.11.0-rc.97 artifact stored 4,416 properties from 4,581 parsed: UNIQUE(page_id,
// name, section) plus INSERT OR IGNORE silently destroyed 165 rows, 141 of them genuinely
// distinct properties. These tests pin the two decisions that fixed it — anchor-based identity
// instead of heading text, and folding h4–h6 to the nearest h1–h3 ancestor.

describe("attributeSection — h4–h6 fold to nearest h1–h3 ancestor (issue #90 decision)", () => {
  const md = [
    "# Page", // 0
    "", // 1
    "## Port Settings", // 2  -> section, anchor "port-settings"
    "", // 3
    "#### Port Resources/Usage", // 4  -> h4, NO section row
    "prop-a", // 5
    "", // 6
    "#### Port PFC Stats", // 7  -> h4, NO section row
    "prop-b", // 8
    "", // 9
    "## Other", // 10 -> section, anchor "other"
    "prop-c", // 11
  ].join("\n");
  const sections = parseSections(md, "Page");

  test("both h4 subsections resolve to the enclosing h1–h3 section, not to themselves", () => {
    expect(sections.map((s) => s.anchorId)).toEqual(["port-settings", "other"]);
    expect(attributeSection(5, sections)).toBe("port-settings");
    expect(attributeSection(8, sections)).toBe("port-settings");
  });

  test("a later h1–h3 heading ends the previous section's range", () => {
    expect(attributeSection(11, sections)).toBe("other");
  });

  test("content before the first section is null when there is no lead fragment (title-only lead)", () => {
    // This fixture's only pre-heading line is the title, so no lead fragment is minted and
    // pre-heading content is genuinely unattributed — the honest null (B-0023 empty rule).
    expect(attributeSection(1, sections)).toBeNull();
  });

  test("content before the first section resolves to the lead fragment when the page has one (B-0023)", () => {
    const withLead = parseSections(
      ["# Page", "", "Intro prose before any section.", "", "## Port Settings", "prop"].join("\n"),
      "Page",
    );
    expect(withLead[0].anchorId).toBe(LEAD_ANCHOR);
    // the intro line (line 2) is inside the lead fragment, not orphaned
    expect(attributeSection(2, withLead)).toBe(LEAD_ANCHOR);
  });
});

describe("parsePage — ppp-aaa.md (repeated 'Properties' headings; the real 165-row casualty)", () => {
  const page = parsePage(pppAaaMd, PPP_AAA_URL);

  test("repeated headings mint distinct anchors, which is what makes section identity resolvable", () => {
    // Four "Properties" headings on one page (one h3, three h2). Heading TEXT collides;
    // anchor_id does not — that difference is the whole fix.
    const propsSections = page.sections.filter((s) => s.heading === "Properties");
    expect(propsSections.length).toBe(4);
    expect(propsSections.map((s) => s.anchorId)).toEqual(["properties", "properties-1", "properties-2", "properties-3"]);
  });

  test("same-named properties under different 'Properties' headings all survive with distinct meanings", () => {
    // Under the old UNIQUE(page_id, name, section) only the FIRST of each of these was stored:
    // every later one collided on the literal text "Properties" and was dropped by INSERT OR
    // IGNORE. They are different properties, not duplicates.
    const named = page.properties.filter((p) => p.name === "name");
    expect(named.length).toBeGreaterThanOrEqual(3);

    const anchors = named.map((p) => p.sectionAnchor);
    expect(new Set(anchors).size).toBe(named.length); // each in its own section

    const descriptions = named.map((p) => p.description);
    expect(descriptions).toContain("PPP profile name");
    expect(descriptions).toContain("Name used for authentication"); // destroyed pre-#90
  });

  test("every property on the page carries a section anchor that names a real section", () => {
    const anchors = new Set(page.sections.map((s) => s.anchorId));
    for (const p of page.properties) {
      expect(p.sectionAnchor).not.toBeNull();
      expect(anchors.has(p.sectionAnchor as string)).toBeTrue();
    }
  });

  test("no property is dropped for colliding with another on (name, section-text)", () => {
    // The extractor now INSERTs rather than INSERT OR IGNOREs, so parsed == stored. Guard the
    // parse side of that contract: same-page name+section-text repeats are expected and legal.
    const byNameAndText = new Map<string, number>();
    for (const p of page.properties) {
      const k = `${p.name} ${p.section}`;
      byNameAndText.set(k, (byNameAndText.get(k) ?? 0) + 1);
    }
    const collisions = [...byNameAndText.values()].filter((n) => n > 1);
    expect(collisions.length).toBeGreaterThan(0); // this page is the fixture *because* it collides
  });
});

describe("parsePage — dot1x.md: same name AND same section (why section is not an identity, issue #90)", () => {
  const page = parsePage(dot1xMd, "https://manual.mikrotik.com/docs/authentication-authorization-accounting/dot1x");

  test("one section documents `interface` more than once, with different meanings", () => {
    // This is the case that rules out UNIQUE(page_id, name, section_id) — not just the old
    // heading-text key. dot1x's "Server" section carries a server table AND a client table,
    // each defining `interface`. Re-keying the constraint on section_id would still have
    // destroyed these (74 distinct rows corpus-wide); only removing it stores them all.
    const iface = page.properties.filter((p) => p.name === "interface");
    const underServer = iface.filter((p) => p.sectionAnchor === "server");
    expect(underServer.length).toBeGreaterThan(1);

    // Same name, same section, genuinely different documentation — not duplicates.
    const descriptions = new Set(underServer.map((p) => p.description));
    expect(descriptions.size).toBeGreaterThan(1);
    expect([...descriptions]).toContain("Name of the interface or interface list the server will run on.");
  });
});

describe("parsePage — section attribution of a property under an h4 (issue #90 stated tradeoff)", () => {
  // ppp-aaa's own h4s hold only code, so a synthetic page pins the disagreement precisely.
  const md = [
    "# Page",
    "",
    "## Port Settings",
    "",
    "#### Port PFC Stats",
    "",
    "| Property | Description |",
    "| -------- | ----------- |",
    "| **pfc** (yes \\| no; Default: **no**) | Priority flow control. |",
  ].join("\n");
  const page = parsePage(md, "https://manual.mikrotik.com/docs/example");

  test("`section` keeps the h4 text while `section_id` resolves to the enclosing h1–h3 — they disagree on purpose", () => {
    const pfc = page.properties.find((p) => p.name === "pfc");
    expect(pfc).toBeDefined();
    // Raw nearest heading of ANY level, retained for compatibility: names the h4.
    expect(pfc?.section).toBe("Port PFC Stats");
    // Resolvable identity: the enclosing h1–h3, since no section row exists for an h4.
    expect(pfc?.sectionAnchor).toBe("port-settings");
    // The h4's name is therefore still recoverable, which is what makes the fold reversible.
    expect(pfc?.section).not.toBe(pfc?.sectionAnchor);

    const table = page.tables[0];
    expect(table.sourceHeading).toBe("Port PFC Stats");
    expect(table.sectionAnchor).toBe("port-settings");
    expect(pfc?.sourceTableRowLine).toBe(table.rows[0].line);
  });
});

describe("parsePage — page-level table attribution and property provenance (#92)", () => {
  const page = parsePage(
    [
      "| Property | Description |",
      "|---|---|",
      "| **page-prop** (string) | Before headings. |",
      "",
      "## Properties",
      "- **bullet-prop** (string): From a list.",
    ].join("\n"),
    "https://manual.mikrotik.com/docs/example",
  );

  test("content before the first h1-h3 section attributes to the lead (H0) fragment (B-0023)", () => {
    // The table opens the page (no heading directly above it), so sourceHeading stays null,
    // but the table now lives in the synthetic lead fragment rather than being orphaned —
    // this was the pre-B-0023 `sectionAnchor === null` case.
    expect(page.tables[0].sourceHeading).toBeNull();
    expect(page.tables[0].sectionAnchor).toBe(LEAD_ANCHOR);
  });

  test("table-derived properties carry a source row while bullet properties stay unlinked", () => {
    expect(page.properties.find((property) => property.name === "page-prop")?.sourceTableRowLine).toBe(
      page.tables[0].rows[0].line,
    );
    expect(page.properties.find((property) => property.name === "bullet-prop")?.sourceTableRowLine).toBeNull();
  });
});

describe("parseCallouts — dot1x.md section attribution (pre-#90 callouts had none at all)", () => {
  const page = parsePage(dot1xMd, "https://manual.mikrotik.com/docs/authentication-authorization-accounting/dot1x");

  test("every callout resolves to a real section, and in-section callouts name their section", () => {
    const anchors = new Set(page.sections.map((s) => s.anchorId));
    // Since B-0023 every callout attributes to a section (the opening warning to the lead
    // fragment, the rest to their enclosing h1–h3 section) — none are orphaned.
    for (const c of page.callouts) {
      expect(c.sectionAnchor).not.toBeNull();
      expect(anchors.has(c.sectionAnchor as string)).toBeTrue();
    }
    const inServer = page.callouts.filter((c) => c.sectionAnchor === "server");
    expect(inServer.length).toBeGreaterThanOrEqual(1);
  });

  test("the page-level warning above the first heading resolves to the lead (H0) fragment (B-0023)", () => {
    // dot1x.md opens with a ':::warning' about SMIPS devices before any h2/h3. Pre-B-0023 this
    // was honestly null; now it belongs to the lead fragment so the warning is addressable and
    // rolls up with the rest of the page's lead prose.
    const first = page.callouts[0];
    expect(first.content).toContain("not supported on SMIPS devices");
    expect(first.sectionAnchor).toBe(LEAD_ANCHOR);
  });
});

describe("extractCodeBlocks", () => {
  test("extracts fenced ```ros blocks and records the language", () => {
    const { code, codeLang } = extractCodeBlocks(addressListsMd);
    expect(code).toContain("/ip/firewall/address-list/add");
    expect(codeLang).toBe("ros");
  });
});

describe("resolveDescriptionLinks", () => {
  test("leaves absolute links and same-page anchors untouched", () => {
    const desc = "See [external](https://example.com/x) and [here](#section).";
    expect(resolveDescriptionLinks(desc, DHCP_URL)).toBe(desc);
  });

  test("rewrites a relative .md link to a live manual.mikrotik.com URL", () => {
    const desc = "See [gateway reachability](../user-guides/routing-and-networking-protocols/routing-decision.md).";
    const resolved = resolveDescriptionLinks(desc, DHCP_URL);
    expect(resolved).toBe(
      "See [gateway reachability](https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision).",
    );
  });
});

describe("parsePage — end-to-end shape", () => {
  test("derives rosetta_id, slug, path, and depth from the page URL", () => {
    const page = parsePage(dhcpMd, DHCP_URL);
    expect(page.rosettaId).toBe("docs/network-management/dhcp");
    expect(page.slug).toBe("dhcp");
    expect(page.path).toBe("docs > network-management > dhcp");
    expect(page.depth).toBe(3);
  });

  test("every property on a real page round-trips through parsePage with resolved links", () => {
    const page = parsePage(dhcpMd, DHCP_URL);
    expect(page.properties.length).toBeGreaterThan(50);
    expect(page.properties.filter((p) => p.malformedEmphasis).length).toBeGreaterThanOrEqual(1);

    const useDns = page.properties.find((p) => p.name === "use-peer-dns");
    expect(useDns?.description).toContain("https://manual.mikrotik.com/docs/network-management/dhcp#dhcp-server");
    expect(useDns?.description).not.toContain(".md");
  });

  test("a short page with no properties/callouts still produces a valid page shape", () => {
    const page = parsePage(addressListsMd, ADDRESS_LISTS_URL);
    expect(page.title).toBe("Address-lists");
    expect(page.properties).toEqual([]);
    expect(page.callouts).toEqual([]);
    // One lead (H0) fragment holds the whole body (no h2/h3) — see parseSections' dedicated test.
    expect(page.sections.length).toBe(1);
    expect(page.sections[0].anchorId).toBe(LEAD_ANCHOR);
    expect(page.wordCount).toBeGreaterThan(0);
    expect(page.text).toContain("dynamic address list");
  });

  test("sms.md's 'Parameter'-spelled table still surfaces via parsePage", () => {
    const page = parsePage(smsMd, SMS_URL);
    expect(page.properties.some((p) => p.name === "phone-number")).toBeTrue();
  });
});

describe("parseLlmsTxtInScopeCount (B-0012 H8, V-docusaurus-docs-count)", () => {
  test("counts only in-scope /docs entries, excluding CLI Reference and tags", () => {
    const llmsTxt = [
      "- [DHCP](https://manual.mikrotik.com/docs/network-management/dhcp.md): desc",
      "- [ip/address](https://manual.mikrotik.com/docs/cli-reference/ip/address.md): desc",
      "- [tag](https://manual.mikrotik.com/docs/tags/dhcp.md): desc",
      "- [Dot1X](https://manual.mikrotik.com/docs/authentication-authorization-accounting/dot1x.md): desc",
    ].join("\n");
    expect(parseLlmsTxtInScopeCount(llmsTxt)).toBe(2);
  });
});

describe("DocCardList expansion — bgp.md (real leaked <DocCardList />, issue #65)", () => {
  const bgpMd = read("bgp.md");
  const BGP_URL = "https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/unicast/bgp";
  const BGP_ID = "docs/user-guides/routing-and-networking-protocols/unicast/bgp";
  // The full-tree id set the extractor would hold: parent + direct children + a grandchild.
  const ALL_IDS = [
    BGP_ID,
    `${BGP_ID}/peering-sessions`,
    `${BGP_ID}/understanding-bgp`,
    `${BGP_ID}/faq`,
    `${BGP_ID}/nexthop-selection`,
    `${BGP_ID}/nexthop-selection/deep`, // grandchild — must NOT be listed
    "docs/user-guides/routing-and-networking-protocols/unicast/ospf", // sibling — must NOT be listed
  ];

  test("directChildIds returns only direct children, not grandchildren or siblings", () => {
    expect(directChildIds(BGP_ID, ALL_IDS).sort()).toEqual([
      `${BGP_ID}/faq`,
      `${BGP_ID}/nexthop-selection`,
      `${BGP_ID}/peering-sessions`,
      `${BGP_ID}/understanding-bgp`,
    ]);
  });

  test("cardMetaFor pulls the H1 title and summary blockquote", () => {
    const meta = cardMetaFor(bgpMd, "bgp");
    expect(meta.title).toBe("BGP");
    expect(meta.summary).toContain("Border Gateway Protocol");
  });

  test("expandDocCardLists replaces the tag with child links and drops the import line", () => {
    const out = expandDocCardLists(bgpMd, [
      { title: "FAQ", url: "https://manual.mikrotik.com/docs/.../faq" },
      { title: "Peering Sessions", url: "https://manual.mikrotik.com/docs/.../peering-sessions", summary: "How peering works" },
    ]);
    expect(out).not.toContain("import DocCardList");
    expect(out).not.toContain("<DocCardList");
    expect(out).toContain("- [FAQ](https://manual.mikrotik.com/docs/.../faq)");
    expect(out).toContain("- [Peering Sessions](https://manual.mikrotik.com/docs/.../peering-sessions) — How peering works");
  });

  test("expandDocCardLists leaves md untouched when no children are found (honest fallback)", () => {
    expect(expandDocCardLists(bgpMd, [])).toBe(bgpMd);
  });

  test("a page with no DocCardList is returned unchanged", () => {
    expect(expandDocCardLists(dhcpMd, [{ title: "X", url: "u" }])).toBe(dhcpMd);
  });

  test("end-to-end: parsePage on expanded md surfaces child links and no MDX", () => {
    const children = directChildIds(BGP_ID, ALL_IDS)
      .map((cid) => ({ title: cid.split("/").at(-1) ?? cid, url: `https://manual.mikrotik.com/${cid}` }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const page = parsePage(expandDocCardLists(bgpMd, children), BGP_URL);
    expect(page.text).not.toContain("<DocCardList");
    expect(page.text).not.toContain("import DocCardList");
    expect(page.text).toContain("[peering-sessions]");
    expect(page.text).toContain("[understanding-bgp]");
  });
});

describe("indexed prose never contains FTS snippet sentinel markers (issue #24 corpus safety)", () => {
  // The '>>>'/'<<<' excerpt-highlight markers were chosen because a grep of all
  // 365 in-scope manual.mikrotik.com pages found the literal strings only inside
  // fenced code blocks (api.md's wire-protocol notation) — never in prose. Every
  // real page fixture checked into fixtures/docusaurus/ re-proves that invariant
  // on each run: none of parsePage's prose-bearing fields (text, section text,
  // callout content, property descriptions) may contain the sentinel — only the
  // separate `code` field is allowed to.
  const fixturesDir = join(import.meta.dirname, "..", "fixtures", "docusaurus");
  const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".md"));

  test.each(fixtureFiles)("%s: no sentinel marker in any prose field", (filename) => {
    const md = readFileSync(join(fixturesDir, filename), "utf-8");
    const url = `https://manual.mikrotik.com/docs/test/${filename.replace(/\.md$/, "")}`;
    const page = parsePage(md, url);

    expect(page.text).not.toContain(EXCERPT_MARK_START);
    expect(page.text).not.toContain(EXCERPT_MARK_END);
    for (const section of page.sections) {
      expect(section.text).not.toContain(EXCERPT_MARK_START);
      expect(section.text).not.toContain(EXCERPT_MARK_END);
    }
    for (const callout of page.callouts) {
      expect(callout.content).not.toContain(EXCERPT_MARK_START);
      expect(callout.content).not.toContain(EXCERPT_MARK_END);
    }
    for (const property of page.properties) {
      expect(property.description).not.toContain(EXCERPT_MARK_START);
      expect(property.description).not.toContain(EXCERPT_MARK_END);
    }
  });
});
