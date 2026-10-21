import sqlite from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// extract-cliref.ts imports db.ts, which opens the DB at module scope. Set DB_PATH
// BEFORE that import and load it dynamically so the env-var assignment wins over
// Bun's static-import hoisting — otherwise this file opening db.ts against the real
// on-disk path would trip query.test.ts's singleton guard (order-dependent flake).
process.env.DB_PATH = ":memory:";
const {
  assertNonCliPage,
  cliRefSlug,
  countStructuralMarkers,
  nonCliPageSlug,
  parseCliCompare,
  parseLandingPage,
  parseLlmsToc,
  parsePage,
  reconcileCliCompare,
  reconcileTrailingDirs,
  reconcileTsv,
  treeMismatchCounts,
} = await import("./extract-cliref.ts");

const FIXTURE = readFileSync(join(import.meta.dirname, "..", "fixtures", "cli-reference", "sample.md"), "utf8");
const page = parsePage("sample", FIXTURE, "Sample");

describe("parseLandingPage (#193)", () => {
  const landing = (v: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", "cli-reference", `landing-${v}.md`), "utf8");
  const tally = (rows: ReturnType<typeof parseLandingPage>) =>
    Object.fromEntries(["Argument types", "Standard list entry properties", "Standard print modifiers", "address-flags"].map((s) => [s, rows.filter((r) => r.section === s).length]));

  test("reads every row of the four sections in the default tree (7.26 fixture, 2026-10-21)", () => {
    const rows = parseLandingPage(landing("7.26"));
    expect(tally(rows)).toEqual({ "Argument types": 34, "Standard list entry properties": 4, "Standard print modifiers": 2, "address-flags": 13 });
    const copyFrom = rows.find((r) => r.name === "copy-from");
    expect(copyFrom).toMatchObject({ section: "Standard list entry properties", sourceOrder: 2, sourceLine: 54 });
    // Kept verbatim: which verb takes the name is the consumer's reading of this sentence.
    expect(copyFrom?.descriptionMarkdown).toBe("argument of the `add` command: creates the new entry as a copy of an existing entry");
    expect(rows.find((r) => r.name === "address")?.descriptionMarkdown).toContain("[address flags](#address-flags)");
    expect(rows.filter((r) => r.section === "address-flags").map((r) => r.name).join("")).toBe("46Di/v%RS+:Lm");
  });

  test("reads the 7.24 tree, whose flag table lacks % and whose extra sections stay raw", () => {
    const rows = parseLandingPage(landing("7.24"));
    expect(tally(rows)).toEqual({ "Argument types": 34, "Standard list entry properties": 4, "Standard print modifiers": 2, "address-flags": 12 });
    expect(rows.find((r) => r.section === "address-flags" && r.name === "i")?.descriptionMarkdown).toBe("Interface name");
    expect(rows.some((r) => r.name === "Headings")).toBe(false);
  });

  test("fails loudly on a missing section, a reshaped row, or a repeated name", () => {
    const md = landing("7.26");
    expect(() => parseLandingPage(md.replace("## Standard print modifiers", "## Print modifiers"))).toThrow('section "Standard print modifiers" is missing');
    expect(() => parseLandingPage(md.replace("- **`detail`** — prints", "- `detail`: prints"))).toThrow("does not match");
    expect(() => parseLandingPage(md.replace("| Flag | Meaning |", "| Flag | Description |"))).toThrow("table header");
    // A repeated header is a row off the one-character-flag shape, never a flag "F".
    expect(() => parseLandingPage(md.replace("| m    | multicast address |", "| m    | multicast address |\n| Flag | Meaning |"))).toThrow(
      'row does not match "| flag | meaning |": "| Flag | Meaning |"',
    );
    expect(() => parseLandingPage(md.replace("- **`as-value`**", "- **`detail`**"))).toThrow('"detail" repeats');
  });
});

describe("versioned trees (#188)", () => {
  test("parseLlmsToc reads a versioned tree's pages under its own prefix only", () => {
    const txt =
      "- [/address](https://manual.mikrotik.com/docs/7.24/cli-reference/ip/address.md)\n" +
      "- [/route](https://manual.mikrotik.com/docs/cli-reference/ip/route.md)\n";
    expect([...parseLlmsToc(txt, "/docs/7.24/cli-reference/").names.keys()]).toEqual(["ip/address"]);
    expect([...parseLlmsToc(txt).names.keys()]).toEqual(["ip/route"]);
  });

  test("parseCliCompare accepts the live shape and rejects a malformed one", () => {
    const ok = parseCliCompare(
      JSON.stringify({
        versions: ["7.24", "7.25"],
        commands: { "7.24": 1, "7.25": 1 },
        pairs: { "7.24->7.25": { changedCommands: [{ path: "ip/a", added: { params: ["x"], flags: [] }, removed: { params: [], flags: [] } }], addedCommands: [], removedCommands: [] } },
      }),
    );
    expect(ok.versions).toEqual(["7.24", "7.25"]);
    expect(ok.pairs["7.24->7.25"].changedCommands[0].added.params).toEqual(["x"]);
    expect(() => parseCliCompare("<html>")).toThrow("not JSON");
    expect(() => parseCliCompare(JSON.stringify({ versions: ["../x"], pairs: {} }))).toThrow("version");
    expect(() => parseCliCompare(JSON.stringify({ versions: ["7.24"], pairs: { "a->b": { addedCommands: [] } } }))).toThrow("pair a->b");
  });

  const pageWith = (slug: string, fields: string[], flags: string[] = []): ReturnType<typeof parsePage> => ({
    ...parsePage(slug, `# T\n\n## ${slug}\n\n**Type:** Directory\n`, slug),
    entries: [
      {
        ...parsePage(slug, `# T\n\n## ${slug}\n\n**Type:** Directory\n`, slug).entries[0],
        fields: fields.map((name, i) => ({ fieldKind: "Argument", name, rawType: "str", mandatory: false, unsettable: false, syscap: null, descriptionMarkdown: "", sourceOrder: i, sourceLine: 1 })),
        flags: flags.map((flag, i) => ({ flag, name: flag, descriptionMarkdown: "", sourceOrder: i, sourceLine: 1 })),
      },
    ],
  });

  test("reconcileCliCompare is empty when both sides agree, ignoring the Headings artifact", () => {
    const trees = new Map([
      ["7.24", [pageWith("ip/a", ["x"])]],
      ["7.25", [pageWith("ip/a", ["x", "y"], ["X"]), pageWith("ip/b", [])]],
    ]);
    const compare = {
      versions: ["7.24", "7.25"],
      pairs: {
        "7.24->7.25": {
          changedCommands: [{ path: "ip/a", added: { params: ["y"], flags: ["X"] }, removed: { params: [], flags: [] } }],
          addedCommands: ["ip/b"],
          removedCommands: ["Headings"],
        },
      },
    };
    expect(reconcileCliCompare(trees, compare)).toEqual([]);
  });

  test("reconcileCliCompare names each disagreement and the side that has it", () => {
    const trees = new Map([
      ["7.24", [pageWith("ip/a", ["x"])]],
      ["7.25", [pageWith("ip/a", ["x", "y"])]],
    ]);
    const compare = {
      versions: ["7.24", "7.25"],
      pairs: {
        "7.24->7.25": {
          changedCommands: [{ path: "ip/a", added: { params: ["z"], flags: [] }, removed: { params: [], flags: [] } }],
          addedCommands: ["ip/c"],
          removedCommands: [],
        },
        "7.23->7.25": { changedCommands: [], addedCommands: ["ip/never"], removedCommands: [] },
      },
    };
    const rows = reconcileCliCompare(trees, compare);
    expect(rows).toEqual([
      { pair: "7.24->7.25", kind: "command-added", path: "ip/c", name: "", only_in: "cli-compare" },
      { pair: "7.24->7.25", kind: "param-added", path: "ip/a", name: "y", only_in: "rosetta" },
      { pair: "7.24->7.25", kind: "param-added", path: "ip/a", name: "z", only_in: "cli-compare" },
    ]);
    expect(reconcileTsv(rows).split("\n")[1]).toBe("7.24->7.25\tcommand-added\tip/c\t\tcli-compare");
  });

  test("treeMismatchCounts charges each pair's rows to both trees, and null when nothing was compared", () => {
    const row = (pair: string) => ({ pair, kind: "param-added" as const, path: "ip/a", name: "z", only_in: "cli-compare" as const });
    const pairs = { changedCommands: [], addedCommands: [], removedCommands: [] };
    const compare = { versions: ["7.24", "7.25", "7.26"], pairs: { "7.24->7.25": pairs, "7.25->7.26": pairs, "7.24->7.26": pairs } };
    const counts = treeMismatchCounts([row("7.24->7.25"), row("7.24->7.25"), row("7.25->7.26")], compare, ["7.24", "7.25", "7.26"]);
    expect(Object.fromEntries(counts)).toEqual({ "7.24": 2, "7.25": 3, "7.26": 1 });
    // A tree in no compared pair, or no cli-compare.json at all, is "not checked", never 0.
    expect(Object.fromEntries(treeMismatchCounts([], compare, ["7.25", "7.26", "7.27"]))).toEqual({ "7.25": 0, "7.26": 0, "7.27": null });
    expect(Object.fromEntries(treeMismatchCounts([], null, ["7.26"]))).toEqual({ "7.26": null });
  });
});

describe("assertNonCliPage (#194)", () => {
  // The live compare-versions page as served 2026-10-20: prose plus a widget, no entries.
  const TOOL_PAGE = "# /compare-versions\n\n<CliCompare />\n\n## How the comparison works\n\nVersions are compared by path.\n";

  test("accepts a page with no **Type:** entries", () => {
    expect(() => assertNonCliPage("compare-versions", TOOL_PAGE)).not.toThrow();
  });

  test("fails loudly once an excluded page carries a real entry", () => {
    expect(() => assertNonCliPage("compare-versions", `${TOOL_PAGE}\n## compare-versions\n\n**Type:** Command\n`)).toThrow(
      "remove it from NON_CLI_PAGES",
    );
  });
});

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

  test("excludes the CLI-compare tool page, and only at the section root (#194)", () => {
    expect(cliRefSlug("https://manual.mikrotik.com/docs/cli-reference/compare-versions")).toBeNull();
    expect(nonCliPageSlug("https://manual.mikrotik.com/docs/cli-reference/compare-versions")).toBe("compare-versions");
    expect(nonCliPageSlug("https://manual.mikrotik.com/docs/cli-reference/ip/address")).toBeNull();
    expect(cliRefSlug("/docs/cli-reference/tool/compare-versions")).toBe("tool/compare-versions");
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
  test("ignores a non-CLI page the sitemap lists with a trailing slash (#194)", () => {
    // Live sitemap, 2026-10-21: the tool page is served as …/compare-versions/ and has no leaf.
    const locs = ["https://manual.mikrotik.com/docs/cli-reference/compare-versions/"];
    expect(() => reconcileTrailingDirs(locs, new Set<string>())).not.toThrow();
  });

  const B = "https://manual.mikrotik.com/docs/cli-reference";
  const locs = [`${B}/`, `${B}/app/`, `${B}/caps-man/interface/`, `${B}/ip/address`];

  test("passes when every category dir contributes its <dir> page (shape since 2026-10-06)", () => {
    const discovered = new Set(["app", "caps-man/interface", "ip/address"]);
    expect(() => reconcileTrailingDirs(locs, discovered)).not.toThrow();
  });

  test("passes when every category dir contributes its <dir>/<basename> leaf (shape until 2026-10-06)", () => {
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

  test("parses the rendered-Markdown preamble served since 2026-10-06 (no imports, real blurb)", () => {
    // The title h1 equals the top-level command name, so it must be split off, not walked.
    const md =
      "# app\n\n> RouterOS directory reference for /app.\n\n-----------\n\n## app \n" +
      "**Syscap:** app\n**Package:** container\n**Type:** Directory\n";
    const p = parsePage("app", md, "app");
    expect(p.sourceTitle).toBe("app");
    expect(p.entries.map((e) => [e.sourcePath, e.sourceType, e.headingLevel, e.sourceLine])).toEqual([
      ["app", "Directory", 2, 7],
    ]);
    expect(p.entries[0].package).toBe("container");
    expect(p.entries[0].syscap).toBe("app");
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

describe("live run vs cache (#160)", () => {
  const BASE = "https://manual.mikrotik.com";
  const PREAMBLE = "# T\n\nimport {ArgTable} from 'x';\n\n---\n\n";
  const ROUTE = `${PREAMBLE}## ip/route\n\n**Type:** Directory\n\n<ArgTable c1="Argument" c2="Type" c3="Description">\n<ArgTableRow arg="gateway" typ="str">the gateway</ArgTableRow>\n</ArgTable>\n`;
  // What a months-old cache held for ip/address: a section upstream has since removed (#159).
  const STALE_ADDRESS = `${PREAMBLE}## ip/address/stale-rule\n\n**Type:** Directory\n\nRemoved upstream.\n`;
  const SITEMAP = `<urlset>${["ip/address", "ip/route"].map((s) => `<url><loc>${BASE}/docs/cli-reference/${s}</loc></url>`).join("")}</urlset>`;

  const llms = (version: string, prefix: string, pages: string[]) =>
    `# MikroTik RouterOS Manual\n\nIndex of the RouterOS ${version} manual, in documentation menu order.\n\n${pages
      .map((s) => `- [/${s}](${BASE}${prefix}cli-reference/${s}.md)`)
      .join("\n")}\n`;
  // MikroTik's version list and diff for the two trees below: 7.26 adds ip/route. `Headings`
  // is the 7.24 landing-page artifact the reconciler must ignore.
  const CLI_COMPARE = {
    versions: ["7.24", "7.26"],
    pairs: { "7.24->7.26": { changedCommands: [], addedCommands: ["ip/route"], removedCommands: ["Headings"] } },
  };

  const LANDING = (v: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", "cli-reference", `landing-${v}.md`), "utf8");

  // "Live" manual.mikrotik.com, served to the extractor subprocess by a preloaded fetch stub.
  // A null route is an expected 404; a URL with no route at all is a test bug.
  const ROUTES: Record<string, string | null> = {
    [`${BASE}/docs/cli-reference.md`]: LANDING("7.26"),
    [`${BASE}/docs/7.24/cli-reference.md`]: LANDING("7.24"),
    [`${BASE}/sitemap.xml`]: SITEMAP,
    [`${BASE}/cli-compare.json`]: JSON.stringify(CLI_COMPARE),
    // The default tree (7.26): its own versioned URL is not served, so /docs/ covers it.
    [`${BASE}/llms.txt`]: llms("7.26", "/docs/", ["compare-versions", "ip/address", "ip/route"]),
    [`${BASE}/docs/7.26/llms.txt`]: null,
    [`${BASE}/docs/cli-reference/compare-versions.md`]: "# /compare-versions\n\n<CliCompare />\n\n## How the comparison works\n\nProse.\n",
    [`${BASE}/docs/cli-reference/ip/address.md`]: FIXTURE,
    [`${BASE}/docs/cli-reference/ip/route.md`]: ROUTE,
    // A versioned tree (7.24): llms.txt is its whole inventory.
    [`${BASE}/docs/7.24/llms.txt`]: llms("7.24", "/docs/7.24/", ["ip/address"]),
    [`${BASE}/docs/7.24/cli-reference/ip/address.md`]: FIXTURE,
  };
  const MOCK_FETCH = `const routes = await Bun.file(process.env.MOCK_FETCH_ROUTES).json();
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!(url in routes)) console.error("mock fetch: no route for " + url);
  return url in routes && routes[url] !== null ? new Response(routes[url]) : new Response("not found", { status: 404 });
};
`;

  function extract(dir: string, dbName: string, ...flags: string[]): string {
    return extractExpecting(0, dir, dbName, ...flags);
  }

  function extractExpecting(exitCode: number, dir: string, dbName: string, ...flags: string[]): string {
    const result = Bun.spawnSync(
      [
        process.execPath,
        `--preload=${join(dir, "mock-fetch.js")}`,
        "run",
        join(import.meta.dirname, "extract-cliref.ts"),
        `--cache-dir=${join(dir, "cache")}`,
        ...flags,
      ],
      {
        env: { DB_PATH: join(dir, dbName), MOCK_FETCH_ROUTES: join(dir, "routes.json") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode, output).toBe(exitCode);
    expect(output).not.toContain("no route for");
    return output;
  }

  function query<T>(dbPath: string, sql: string): T[] {
    const db = new sqlite(dbPath, { readonly: true });
    try {
      return db.query(sql).all() as T[];
    } finally {
      db.close();
    }
  }

  const COUNTS = `SELECT (SELECT COUNT(*) FROM cliref_pages) AS pages, (SELECT COUNT(*) FROM cliref_entries) AS entries,
                         (SELECT COUNT(*) FROM cliref_fields) AS fields, (SELECT COUNT(*) FROM cliref_flags) AS flags`;

  function setup(prefix: string, routes: Record<string, string | null> = ROUTES): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    writeFileSync(join(dir, "mock-fetch.js"), MOCK_FETCH);
    writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
    return dir;
  }

  const TREES = "SELECT manual_version, base_url, is_default, retained FROM cliref_trees ORDER BY manual_version";

  test("a live run re-fetches a stale cached page, prunes undiscovered ones, and --from-cache reproduces it", () => {
    const dir = setup("rosetta-cliref-live-");
    try {
      const cache = join(dir, "cache");
      const tree = join(cache, "7.26");
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, "ip__address.md"), STALE_ADDRESS);
      writeFileSync(join(tree, "gone__page.md"), `${PREAMBLE}## gone/page\n\n**Type:** Directory\n`);
      writeFileSync(join(tree, "_sitemap.txt"), `<urlset><url><loc>${BASE}/docs/cli-reference/gone/page</loc></url></urlset>`);
      // Leftovers this run must clear: a pre-#188 flat-layout page, and a tree no longer served.
      writeFileSync(join(cache, "ip__address.md"), STALE_ADDRESS);
      mkdirSync(join(cache, "7.23"));
      writeFileSync(join(cache, "7.23", "_tree.json"), JSON.stringify({ label: "7.23", docsPrefix: "/docs/7.23/", isDefault: false, fetchedAt: "x" }));

      const output = extract(dir, "live.db");
      expect(output).not.toContain("::warning::"); // 7.26's own 404 is the normal state: silent

      const paths = query<{ source_path: string }>(
        join(dir, "live.db"),
        "SELECT e.source_path FROM cliref_entries e JOIN cliref_pages p ON p.id = e.page_id WHERE p.manual_version = '7.26'",
      ).map((r) => r.source_path);
      expect(paths).toContain("ip/address");
      expect(paths).toContain("ip/route");
      expect(paths).not.toContain("ip/address/stale-rule");
      expect(paths).not.toContain("gone/page");

      // #188: one row per tree, keyed by declared version; the default tree read from /docs/.
      expect(query(join(dir, "live.db"), TREES)).toEqual([
        { manual_version: "7.24", base_url: `${BASE}/docs/7.24/`, is_default: 0, retained: 0 },
        { manual_version: "7.26", base_url: `${BASE}/docs/`, is_default: 1, retained: 0 },
      ]);
      expect(
        query(join(dir, "live.db"), "SELECT manual_version, slug FROM cliref_pages ORDER BY manual_version, source_order"),
      ).toEqual([
        { manual_version: "7.24", slug: "ip/address" },
        { manual_version: "7.26", slug: "ip/address" },
        { manual_version: "7.26", slug: "ip/route" },
      ]);
      // The default tree is stored first, so its ids match a single-tree build.
      expect(query(join(dir, "live.db"), "SELECT MIN(id) AS id FROM cliref_pages WHERE manual_version = '7.26'")).toEqual([{ id: 1 }]);

      // The cache now holds exactly this run, one directory per tree.
      expect(readFileSync(join(tree, "ip__address.md"), "utf8")).toBe(FIXTURE);
      expect(readFileSync(join(tree, "_sitemap.txt"), "utf8")).toBe(SITEMAP);
      // compare-versions is listed in llms.txt: fetched and kept only to re-check it is still non-CLI (#194).
      expect(readdirSync(tree).sort()).toEqual(["_landing.md", "_llms.txt", "_sitemap.txt", "_tree.json", "compare-versions.md", "ip__address.md", "ip__route.md"]);
      expect(readdirSync(join(cache, "7.24")).sort()).toEqual(["_landing.md", "_llms.txt", "_tree.json", "ip__address.md"]);

      // #193: each tree keeps its own landing page and its parsed standard rows.
      const STANDARD = "SELECT manual_version, COUNT(*) AS n FROM cliref_standard GROUP BY manual_version ORDER BY manual_version";
      expect(query(join(dir, "live.db"), STANDARD)).toEqual([
        { manual_version: "7.24", n: 52 },
        { manual_version: "7.26", n: 53 },
      ]);
      expect(
        query(join(dir, "live.db"), "SELECT manual_version FROM cliref_trees WHERE landing_markdown LIKE '%## Headings%'"),
      ).toEqual([{ manual_version: "7.24" }]);
      expect(readdirSync(cache).sort()).toEqual(["7.24", "7.26", "_cli-compare.json", "cli-compare-reconcile.tsv"]);
      // The two sides agree once the Headings artifact is set aside: a header-only report.
      expect(readFileSync(join(cache, "cli-compare-reconcile.tsv"), "utf8")).toBe("pair\tkind\tpath\tname\tonly_in\n");
      // ...and each compared tree records that it was checked and agreed, for the export manifest.
      expect(query(join(dir, "live.db"), "SELECT manual_version, cli_compare_mismatches FROM cliref_trees ORDER BY manual_version")).toEqual([
        { manual_version: "7.24", cli_compare_mismatches: 0 },
        { manual_version: "7.26", cli_compare_mismatches: 0 },
      ]);

      extract(dir, "cached.db", "--from-cache");
      expect(query(join(dir, "cached.db"), COUNTS)).toEqual(query(join(dir, "live.db"), COUNTS));
      expect(query(join(dir, "cached.db"), TREES)).toEqual(query(join(dir, "live.db"), TREES));
      expect(query(join(dir, "cached.db"), STANDARD)).toEqual(query(join(dir, "live.db"), STANDARD));

      // #187: both runs stamp the version the cached/live llms.txt header declares.
      for (const name of ["live.db", "cached.db"]) {
        expect(query(join(dir, name), "SELECT value FROM db_meta WHERE key = 'cliref_manual_version'")).toEqual([
          { value: "7.26" },
        ]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to store an overlay from a different manual tree than the prose (#187)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rosetta-cliref-mismatch-"));
    try {
      writeFileSync(join(dir, "mock-fetch.js"), MOCK_FETCH);
      writeFileSync(join(dir, "routes.json"), JSON.stringify(ROUTES));
      const seeded = new sqlite(join(dir, "mixed.db"));
      seeded.run("CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      seeded.run("INSERT INTO db_meta (key, value) VALUES ('docs_manual_version', '7.24')");
      seeded.close();

      const output = extractExpecting(1, dir, "mixed.db");
      expect(output).toContain("cliref_manual_version=7.26 but docs_manual_version=7.24");
      expect(query(join(dir, "mixed.db"), "SELECT COUNT(*) AS n FROM cliref_pages")).toEqual([{ n: 0 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("--from-cache refuses a _tree.json whose prefix is not its own directory's", () => {
    const dir = setup("rosetta-cliref-tampered-");
    try {
      extract(dir, "live.db");
      const meta = join(dir, "cache", "7.24", "_tree.json");
      const original = readFileSync(meta, "utf8");
      writeFileSync(meta, original.replace("/docs/7.24/", "/docs/elsewhere/"));
      expect(extractExpecting(1, dir, "cached.db", "--from-cache")).toContain('has docsPrefix "/docs/elsewhere/", expected /docs/7.24/');
      // Only the default tree may claim /docs/: a non-default one doing so is a cache error,
      // not a duplicate base_url for SQLite to reject.
      writeFileSync(meta, original.replace("/docs/7.24/", "/docs/"));
      expect(extractExpecting(1, dir, "cached.db", "--from-cache")).toContain('has docsPrefix "/docs/", expected /docs/7.24/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a listed tree that returns 404 is skipped with a warning, not a failure (#188)", () => {
    const routes = {
      ...ROUTES,
      [`${BASE}/cli-compare.json`]: JSON.stringify({ ...CLI_COMPARE, versions: ["7.24", "7.25", "7.26"] }),
      [`${BASE}/docs/7.25/llms.txt`]: null,
    };
    const dir = setup("rosetta-cliref-gone-", routes);
    try {
      const output = extract(dir, "gone.db");
      expect(output).toContain("::warning::cli-compare.json lists 7.25, but /docs/7.25/llms.txt returned 404");
      expect(query<{ manual_version: string }>(join(dir, "gone.db"), TREES).map((t) => t.manual_version)).toEqual(["7.24", "7.26"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a served tree without its landing page fails the build (#193)", () => {
    const dir = setup("rosetta-cliref-no-landing-", { ...ROUTES, [`${BASE}/docs/7.24/cli-reference.md`]: null });
    try {
      expect(extractExpecting(1, dir, "no-landing.db")).toContain("served without its landing page");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a served tree whose llms.txt declares another version fails the build (#188)", () => {
    const dir = setup("rosetta-cliref-broken-", { ...ROUTES, [`${BASE}/docs/7.24/llms.txt`]: llms("7.25", "/docs/7.24/", ["ip/address"]) });
    try {
      expect(extractExpecting(1, dir, "broken.db")).toContain("/docs/7.24/llms.txt declares 7.25, not 7.24");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default's own versioned URL, when served, replaces /docs/ as one tree (#188 dedupe)", () => {
    const dir = setup("rosetta-cliref-dedupe-", {
      ...ROUTES,
      [`${BASE}/docs/7.26/llms.txt`]: llms("7.26", "/docs/7.26/", ["ip/address", "ip/route"]),
      [`${BASE}/docs/7.26/cli-reference/ip/address.md`]: FIXTURE,
      [`${BASE}/docs/7.26/cli-reference/ip/route.md`]: ROUTE,
      [`${BASE}/docs/7.26/cli-reference.md`]: LANDING("7.26"),
    });
    try {
      extract(dir, "dedupe.db");
      expect(query(join(dir, "dedupe.db"), TREES)).toEqual([
        { manual_version: "7.24", base_url: `${BASE}/docs/7.24/`, is_default: 0, retained: 0 },
        { manual_version: "7.26", base_url: `${BASE}/docs/7.26/`, is_default: 1, retained: 0 },
      ]);
      // Still the default tree's sitemap ∪ llms.txt inventory, cached for --from-cache.
      expect(readdirSync(join(dir, "cache", "7.26"))).toContain("_sitemap.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the #137 discovery gate still guards the default tree when it is read from /docs/<v>/", () => {
    const orphan = `<urlset><url><loc>${BASE}/docs/cli-reference/orphan/</loc></url></urlset>`;
    const dir = setup("rosetta-cliref-dedupe-gate-", {
      ...ROUTES,
      [`${BASE}/sitemap.xml`]: orphan,
      [`${BASE}/docs/7.26/llms.txt`]: llms("7.26", "/docs/7.26/", ["ip/address"]),
    });
    try {
      expect(extractExpecting(1, dir, "gate.db")).toContain("Discovery shape drift");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
