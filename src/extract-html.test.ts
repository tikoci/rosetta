// Set BEFORE any import that transitively loads db.ts
process.env.DB_PATH = ":memory:";

import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";

// Dynamic import so the DB_PATH assignment above wins over module caching
const { extractPlainText, sanitizeExtractedText } = await import("./extract-html.ts");

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
  it("emits heading markers", () => {
    const { document } = parseHTML("<div><h1>Basic Setup</h1><p>This is the basic VRRP configuration example.</p></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("# Basic Setup\nThis is the basic VRRP configuration example.");
  });

  it("emits h2 markers for subsections", () => {
    const { document } = parseHTML("<div><h2>Overview</h2><p>The Point-to-Point Protocol (PPP) provides...</p></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("## Overview\nThe Point-to-Point Protocol (PPP) provides...");
  });

  it("emits list markers for ul", () => {
    const { document } = parseHTML("<div><ul><li>First item</li><li>Second item</li></ul></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("- First item");
    expect(out).toContain("- Second item");
  });

  it("emits numbered markers for ol", () => {
    const { document } = parseHTML("<div><ol><li>Step one</li><li>Step two</li></ol></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("1. Step one");
    expect(out).toContain("2. Step two");
  });

  it("wraps strong/b in **bold**", () => {
    const { document } = parseHTML("<div><p>The <strong>disabled</strong> property controls this.</p></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("**disabled**");
  });

  it("wraps code in backticks", () => {
    const { document } = parseHTML("<div><p>Use <code>/ip/address</code> to configure.</p></div>");
    const out = extractPlainText(document.querySelector("div"));
    expect(out).toContain("`/ip/address`");
  });
});
