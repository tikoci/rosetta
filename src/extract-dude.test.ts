import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDudePage } from "./extract-dude.ts";

const probesHtml = readFileSync(join(import.meta.dirname, "..", "dude", "pages", "Probes.html"), "utf-8");

describe("parseDudePage", () => {
  test("uses the inner article body instead of wiki chrome", () => {
    const parsed = parseDudePage(probesHtml, "https://web.archive.org/web/2024/https://wiki.mikrotik.com/wiki/Manual:The_Dude_v6/Probes");
    expect(parsed.text).not.toContain("Jump to navigation");
    expect(parsed.text).not.toContain("Jump to search");
    expect(parsed.text).not.toContain("Retrieved from");
    expect(parsed.text).not.toContain("FILE ARCHIVED ON");
    expect(parsed.text).not.toContain("Contents");
    expect(parsed.text).toContain("The Probes pane shows the available methods");
  });

  test("extracts useful inline and block code snippets", () => {
    const parsed = parseDudePage(probesHtml, "https://web.archive.org/web/2024/https://wiki.mikrotik.com/wiki/Manual:The_Dude_v6/Probes");
    expect(parsed.code).toContain("Custom_Voltage_Function()");
    expect(parsed.code).toContain('if((oid("1.3.6.1.4.1.14988.1.1.3.8.0")>19),"1", "0")');
  });

  test("keeps content images but skips wiki UI icons", () => {
    const parsed = parseDudePage(probesHtml, "https://web.archive.org/web/2024/https://wiki.mikrotik.com/wiki/Manual:The_Dude_v6/Probes");
    expect(parsed.images.some((img) => img.filename === "Version.png")).toBeFalse();
    expect(parsed.images.some((img) => img.filename === "Dude-probes-all.JPG")).toBeTrue();
  });
});