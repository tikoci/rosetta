// Force in-memory DB before importing extract-docusaurus.ts (which transitively imports
// db.ts) — same guard as extract-dude.test.ts. See BACKLOG.md "Test DB-leak guards".
process.env.DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
} = await import("./extract-docusaurus.ts");

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "docusaurus");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf-8");

const dhcpMd = read("dhcp.md");
const smsMd = read("sms.md");
const dot1xMd = read("dot1x.md");
const addressListsMd = read("address-lists.md");

const DHCP_URL = "https://manual.mikrotik.com/docs/network-management/dhcp";
const SMS_URL = "https://manual.mikrotik.com/docs/mobile-networking/sms";
const ADDRESS_LISTS_URL = "https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/address-lists";

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

  test("a page whose only headings are the duplicated title yields zero sections (content stays in page text)", () => {
    // address-lists.md has no h2/h3 at all — both its headings are the "Address-lists"
    // title duplicate, so both get dropped. Matches extract-html.ts's own behavior for
    // Confluence pages with no id-bearing headings: sections == [], full text elsewhere.
    const sections = parseSections(addressListsMd, "Address-lists");
    expect(sections).toEqual([]);
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
    expect(page.sections).toEqual([]); // see parseSections' dedicated test for why
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
