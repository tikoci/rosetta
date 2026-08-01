import { describe, expect, test } from "bun:test";
import {
  extractMenuPaths,
  isRouterOsPath,
  normalizeMenuPath,
  resolveToDir,
} from "./menu-paths.ts";

// A small stand-in for the `dir` rows the linker loads from the DB.
const DIRS: ReadonlySet<string> = new Set([
  "/interface",
  "/interface/bridge",
  "/interface/bridge/port",
  "/interface/bridge/vlan",
  "/ip",
  "/ip/settings",
  "/certificate",
]);

describe("normalizeMenuPath", () => {
  test("maps the legacy space syntax onto slashes and lowercases", () => {
    expect(normalizeMenuPath("/IP Firewall Filter")).toBe("/ip/firewall/filter");
  });
});

describe("isRouterOsPath", () => {
  test("accepts a known dir and a hardcoded top-level menu", () => {
    expect(isRouterOsPath("/interface/bridge/port", DIRS)).toBe(true);
    expect(isRouterOsPath("/queue/simple", DIRS)).toBe(true); // top-level allowlist, not in DIRS
  });

  test("rejects filesystem paths and unknown roots", () => {
    expect(isRouterOsPath("/dev/null", DIRS)).toBe(false);
    expect(isRouterOsPath("/docs/bridging-and-switching", DIRS)).toBe(false);
  });
});

describe("resolveToDir", () => {
  test("walks a command/arg path back to the menu it belongs to", () => {
    expect(resolveToDir("/interface/bridge/port/add/pvid", DIRS)).toBe("/interface/bridge/port");
  });

  test("resolves the pseudo-path normalizeMenuPath produces from an assignment", () => {
    // `/certificate/import file-name=x` normalizes to a path no menu can accept.
    expect(resolveToDir("/certificate/import/file-name", DIRS)).toBe("/certificate");
  });

  test("returns null when no ancestor is a known menu", () => {
    expect(resolveToDir("/queue/simple", DIRS)).toBeNull();
  });
});

describe("extractMenuPaths", () => {
  test("finds paths in prose and code, de-duplicated", () => {
    const found = extractMenuPaths(
      ["Configure under /interface/bridge/port", "/interface/bridge/port\nadd bridge=br1"],
      DIRS,
    );
    expect([...found]).toEqual(["/interface/bridge/port"]);
  });

  test("skips a bare top-level menu unless allowTopLevel is set", () => {
    // Anchors current linker behaviour: MENU_PATH_RE requires a second segment, so a
    // page whose only mention is `/certificate` never becomes a candidate for it.
    const text = "/certificate\nadd name=CA common-name=CAtemp";
    expect([...extractMenuPaths([text], DIRS)]).toEqual([]);
    expect([...extractMenuPaths([text], DIRS, { allowTopLevel: true })]).toEqual(["/certificate"]);
  });

  test("resolve reduces matches to real menus", () => {
    const text = "/certificate/import file-name=cert.pem";
    expect([...extractMenuPaths([text], DIRS)]).toEqual(["/certificate/import/file-name"]);
    expect([...extractMenuPaths([text], DIRS, { resolve: true })]).toEqual(["/certificate"]);
  });

  test("ignores null and empty inputs", () => {
    expect([...extractMenuPaths([null, undefined, ""], DIRS)]).toEqual([]);
  });
});
