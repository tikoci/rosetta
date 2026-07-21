import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cliRefSlug, parsePage } from "./extract-cliref.ts";

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
  test("a #-prefixed line inside a fenced code block is not a heading", () => {
    // disk's fenced transcript contains "#   NAME" — it must stay in the description,
    // never become a fourth entry.
    expect(page.entries.length).toBe(3);
    const disk = page.entries[2];
    expect(disk.descriptionMarkdown).toContain("#   NAME");
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

  test("fails loud on an unknown ArgTable header", () => {
    const bad =
      "# T\n\nimport {ArgTable} from 'x';\n\n---\n\n## foo\n\n**Type:** Command\n\n<ArgTable c1=\"Nonsense\">\n<ArgTableRow arg=\"a\" typ=\"b\">c</ArgTableRow>\n</ArgTable>\n";
    expect(() => parsePage("bad", bad, "bad")).toThrow(/unknown ArgTable c1 header/);
  });
});
