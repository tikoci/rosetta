import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// extract-cliref.ts imports db.ts, which opens the DB at module scope. Set DB_PATH
// BEFORE that import and load it dynamically so the env-var assignment wins over
// Bun's static-import hoisting — otherwise this file opening db.ts against the real
// on-disk path would trip query.test.ts's singleton guard (order-dependent flake).
process.env.DB_PATH = ":memory:";
const { cliRefSlug, countStructuralMarkers, parsePage, reconcileTrailingDirs } = await import("./extract-cliref.ts");

const FIXTURE = readFileSync(join(import.meta.dirname, "..", "fixtures", "cli-reference", "sample.md"), "utf8");
const page = parsePage("sample", FIXTURE, "Sample");

describe("cliRefSlug", () => {
  test("keeps a real page slug", () => {
    expect(cliRefSlug("https://manual.mikrotik.com/docs/cli-reference/ip/address")).toBe("ip/address");
  });
  test("excludes the section root and trailing-slash category stubs", () => {
    expect(cliRefSlug("https://manual.mikrotik.com/docs/cli-reference/")).toBeNull();
    expect(cliRefSlug("https://manual.mikrotik.com/docs/cli-reference/interface/")).toBeNull();
  });
  test("excludes out-of-section URLs", () => {
    expect(cliRefSlug("https://manual.mikrotik.com/docs/routing/bgp")).toBeNull();
  });

  test("excludes the section landing page's own .md (#137)", () => {
    // /docs/cli-reference/index.md is listed in llms.txt but is the argument-type glossary
    // prose — it has no **Type:** entry, so parsePage would (correctly) reject it.
    expect(cliRefSlug("https://manual.mikrotik.com/docs/cli-reference/index")).toBeNull();
    // …but only at the section root: a real menu may legitimately be named "index" deeper in.
    expect(cliRefSlug("/docs/cli-reference/system/index")).toBe("system/index");
  });

  test("keeps a branching menu's own Directory leaf (#137)", () => {
    // The sitemap serves these menus as trailing-slash category URLs (excluded above), but
    // the menu's Directory entry is published at <dir>/<basename>.md and reaches discovery
    // through llms.txt. The slug itself is ordinary.
    expect(cliRefSlug("https://manual.mikrotik.com/docs/cli-reference/app/app")).toBe("app/app");
    expect(cliRefSlug("/docs/cli-reference/caps-man/interface/interface")).toBe("caps-man/interface/interface");
  });

  test("rejects a cached-sitemap value outside the strict slug grammar", () => {
    expect(cliRefSlug("/docs/cli-reference/ip/address?x=1")).toBeNull();
    expect(cliRefSlug("/docs/cli-reference/ip/%2e%2e/secret")).toBeNull();
    expect(cliRefSlug("/docs/cli-reference/IP/address")).toBeNull();
  });
});

describe("reconcileTrailingDirs (#137 discovery gate)", () => {
  const B = "https://manual.mikrotik.com/docs/cli-reference";
  const locs = [`${B}/`, `${B}/app/`, `${B}/caps-man/interface/`, `${B}/ip/address`];

  test("passes when every category dir contributes its <dir>/<basename> leaf", () => {
    const discovered = new Set(["app/app", "caps-man/interface/interface", "ip/address"]);
    expect(() => reconcileTrailingDirs(locs, discovered)).not.toThrow();
  });

  test("throws when a category dir's Directory leaf is missing — the #137 defect", () => {
    // Exactly what sitemap-only discovery did: the menu's own entry vanishes silently.
    const sitemapOnly = new Set(["ip/address"]);
    expect(() => reconcileTrailingDirs(locs, sitemapOnly)).toThrow(/2 sitemap category dir\(s\)/);
  });

  test("ignores the section root and out-of-section locs", () => {
    expect(() => reconcileTrailingDirs([`${B}/`, "https://manual.mikrotik.com/docs/routing/"], new Set())).not.toThrow();
  });
});

describe("parsePage — structure", () => {
  test("page metadata", () => {
    expect(page.slug).toBe("sample");
    expect(page.sourceTitle).toBe("Sample");
    expect(page.tocName).toBe("Sample");
    expect(page.tocGroup).toBe(""); // top-level slug
    expect(page.sourceMarkdown).toBe(FIXTURE);
    expect(page.sourceSha256).toBe(new Bun.CryptoHasher("sha256").update(FIXTURE).digest("hex"));
  });

  test("three entries with the right kinds", () => {
    expect(page.entries.map((e) => [e.sourcePath, e.sourceType])).toEqual([
      ["ip/address", "Directory"],
      ["ip/address/print", "Command"],
      ["disk", "Settings Directory"],
    ]);
  });

  test("document heading ancestry (source_parent_id)", () => {
    const [addr, print, disk] = page.entries;
    expect(addr.parentLocalId).toBeNull();
    expect(print.parentLocalId).toBe(addr.localId); // h3 under h2
    expect(disk.parentLocalId).toBeNull(); // h2 pops back to root
  });

  test("gate markers parsed onto the entry", () => {
    const addr = page.entries[0];
    expect(addr.conditions).toBe("!smips");
    expect(addr.package).toBeNull();
    const disk = page.entries[2];
    expect(disk.syscap).toBe("storage");
    expect(disk.package).toBe("system");
  });
});

describe("parsePage — fields and flags", () => {
  test("flags land in flags, not fields", () => {
    const addr = page.entries[0];
    expect(addr.flags.map((f) => [f.flag, f.name])).toEqual([
      ["X", "disabled"],
      ["D", "dynamic"],
    ]);
    // fields are only Argument + Read-only Argument, never the flag rows.
    expect(addr.fields.map((f) => f.name)).toEqual(["address", "interface", "actual-interface"]);
  });

  test("field kinds, mandatory, unsettable, per-field syscap", () => {
    const addr = page.entries[0];
    const iface = addr.fields.find((f) => f.name === "interface");
    expect(iface?.fieldKind).toBe("Argument");
    expect(iface?.mandatory).toBe(true);
    expect(addr.fields.find((f) => f.name === "actual-interface")?.fieldKind).toBe("Read-only Argument");
    expect(page.entries[1].fields[0].unsettable).toBe(true); // count-only unset="1"
    expect(page.entries[2].fields[0].syscap).toBe("storage"); // disk slot syscap
  });

  test("multiline field description is NOT whitespace-flattened", () => {
    const iface = page.entries[0].fields.find((f) => f.name === "interface");
    expect(iface?.descriptionMarkdown).toContain("\n");
    expect(iface?.descriptionMarkdown).toContain("Second line of the same description");
  });

  test("entry prose description retained verbatim incl. a list", () => {
    const addr = page.entries[0];
    expect(addr.descriptionMarkdown).toContain("holds IPv4 addresses");
    expect(addr.descriptionMarkdown).toContain("- one\n- two");
  });
});

describe("parsePage — robustness", () => {
  test("nothing inside a fenced code block is parsed as structure", () => {
    // disk's fence contains a "#   NAME" false heading, a fake "**Package:**" gate, and
    // an example <ArgTable>. None may become an entry/gate/field — all stay in the prose.
    expect(page.entries.length).toBe(3);
    const disk = page.entries[2];
    expect(disk.descriptionMarkdown).toContain("#   NAME");
    expect(disk.descriptionMarkdown).toContain("**Package:** not-a-real-gate");
    expect(disk.descriptionMarkdown).toContain("<ArgTable");
    // The real gate wins; the fenced fake one is ignored; no phantom field is created.
    expect(disk.package).toBe("system");
    expect(disk.fields.map((f) => f.name)).toEqual(["slot"]);
  });

  test("source line spans are ordered and non-empty", () => {
    for (const e of page.entries) {
      expect(e.sourceEndLine).toBeGreaterThanOrEqual(e.sourceLine);
    }
  });

  test("fails loud on an unknown entry Type label", () => {
    const bad = "# T\n\nimport {ArgTable} from 'x';\n\n---\n\n## foo\n\n**Type:** Bogus\n";
    expect(() => parsePage("bad", bad, "bad")).toThrow(/unknown entry Type/);
  });

  test("fails loud when an entry Type marker is missing or duplicated", () => {
    const missing = "# T\n\nimport {ArgTable} from 'x';\n\n---\n\n## foo\n\nprose\n";
    expect(() => parsePage("bad", missing, "bad")).toThrow(/has no \*\*Type:\*\* marker/);
    const duplicate =
      "# T\n\nimport {ArgTable} from 'x';\n\n---\n\n## foo\n\n**Type:** Command\n**Type:** Command\n";
    expect(() => parsePage("bad", duplicate, "bad")).toThrow(/duplicate Type marker/);
  });

  test("source marker census ignores fenced examples", () => {
    expect(countStructuralMarkers(FIXTURE)).toEqual({ entries: 3, rows: 7 });
  });

  test("fails loud on an unknown ArgTable header", () => {
    const bad =
      "# T\n\nimport {ArgTable} from 'x';\n\n---\n\n## foo\n\n**Type:** Command\n\n<ArgTable c1=\"Nonsense\">\n<ArgTableRow arg=\"a\" typ=\"b\">c</ArgTableRow>\n</ArgTable>\n";
    expect(() => parsePage("bad", bad, "bad")).toThrow(/unknown ArgTable c1 header/);
  });

  test("fails loud on an ArgTableRow missing a required arg/typ attribute", () => {
    const bad =
      "# T\n\nimport {ArgTable} from 'x';\n\n---\n\n## foo\n\n**Type:** Command\n\n<ArgTable c1=\"Argument\">\n<ArgTableRow typ=\"str\">no arg</ArgTableRow>\n</ArgTable>\n";
    expect(() => parsePage("bad", bad, "bad")).toThrow(/ArgTableRow missing "arg" attribute/);
  });

  test("parses an ArgTableRow whose typ value contains a literal '>' (e.g. iface_enum { <l2tp>: })", () => {
    // interface/pppoe-server ships typ="iface_enum { <l2tp>:0xfffffffe }". A naive
    // `[^>]`/`.*?>` tag matcher stops at the '>' inside <l2tp>, truncating the attributes so
    // typ loses its closing quote and reads as missing (silently stored raw_type="" pre-fix).
    const md =
      '# T\n\nimport {ArgTable} from \'x\';\n\n---\n\n## foo\n\n**Type:** Command\n\n<ArgTable c1="Argument" c2="Type" c3="Description">\n<ArgTableRow arg="interface" typ="iface_enum { <l2tp>:0xfffffffe }" mandatory="1"></ArgTableRow>\n<ArgTableRow arg="mtu" typ="num">the mtu</ArgTableRow>\n</ArgTable>\n';
    const p = parsePage("pppoe", md, "Pppoe");
    expect(p.entries[0].fields.map((f) => [f.name, f.rawType, f.mandatory])).toEqual([
      ["interface", "iface_enum { <l2tp>:0xfffffffe }", true],
      ["mtu", "num", false],
    ]);
  });
});
