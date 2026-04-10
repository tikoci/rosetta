import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { extractPlainText, sanitizeExtractedText } from "./extract-html.ts";

describe("sanitizeExtractedText", () => {
  it("removes Confluence TOC CDATA style blocks", () => {
    const input = `
Intro
/*<![CDATA[*/
div.rbtoc1774430868497 {padding: 0px;}
div.rbtoc1774430868497 ul {margin-left: 0px;}
div.rbtoc1774430868497 li {margin-left: 0px;padding-left: 0px;}
/*]]>*/
Basic Setup
`;

    const out = sanitizeExtractedText(input);
    expect(out).toContain("Intro");
    expect(out).toContain("Basic Setup");
    expect(out).not.toContain("rbtoc1774430868497");
    expect(out).not.toContain("/*<![CDATA[*/");
    expect(out).not.toContain("/*]]>*/");
  });

  it("removes bare rbtoc css lines without wrappers", () => {
    const input = `
Top

div.rbtoc1234 {padding: 0px;}
div.rbtoc1234 ul {margin-left: 0px;}

after
`;

    const out = sanitizeExtractedText(input);
    expect(out).toContain("Top");
    expect(out).toContain("after");
    expect(out).not.toContain("div.rbtoc1234");
  });

  it("keeps normal RouterOS content", () => {
    const input = "/interface vrrp add interface=ether1 vrid=49 priority=254";
    const out = sanitizeExtractedText(input);
    expect(out).toBe(input);
  });
});

describe("extractPlainText", () => {
  it("keeps heading and paragraph separated", () => {
    const { document } = parseHTML("<div><h1>Basic Setup</h1><p>This is the basic VRRP configuration example.</p></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("Basic Setup\nThis is the basic VRRP configuration example.");
    expect(out).not.toContain("Basic SetupThis");
  });

  it("keeps subsection heading boundaries", () => {
    const { document } = parseHTML("<div><h2>Overview</h2><p>The Point-to-Point Protocol (PPP) provides...</p></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("Overview\nThe Point-to-Point Protocol (PPP) provides...");
    expect(out).not.toContain("OverviewThe");
  });
});
