/**
 * app-integration.test.ts — RouterOS /app integration harness (#245).
 *
 * Unit tests for the pure helpers in scripts/app-integration.ts (README
 * extraction, substitutions, ui-url rewrite, image-ref parsing, redaction)
 * plus structural checks pinning the app-integration.yml workflow shape.
 * No network, no VMs — just file reads and pure functions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  APP_DISK_GB,
  applyAppAddSubstitutions,
  deriveVersionFromTag,
  extractAppAddBlock,
  isTrustedChallengeRealm,
  logShowsContainerExit,
  parseImageRef,
  parseQemuAccel,
  QUICKCHR_PIN,
  ROS_VERSION_DEFAULT,
  redactCredentials,
  registryApiHost,
  registryCredential,
  rewriteUiUrl,
  writeDiagnosticsBundle,
} from "../scripts/app-integration.ts";
import {
  commandTreeChildCount,
  deviceLookupCount,
  firstSearchPageId,
  pageSectionCount,
  pageTextLength,
  searchPageCount,
} from "../scripts/smoke-oci.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

function readText(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf-8");
}

const SAMPLE_BLOCK = `/app/add use-https=yes disabled=no yaml="name: rosetta
descr: \\"docs\\"
services:
  rosetta:
    image: ghcr.io/tikoci/rosetta:latest
    ports:
      - 9803:8080/tcp:web
"`;

describe("extractAppAddBlock", () => {
  test("finds the one /app/add block among other fences", () => {
    const readme = [
      "# title",
      "",
      "```routeros",
      "/system/identity/print",
      "```",
      "",
      "```routeros",
      SAMPLE_BLOCK,
      "```",
      "",
      "```sh",
      "/app/add use-https=yes",
      "```",
      "",
    ].join("\n");
    expect(extractAppAddBlock(readme)).toBe(SAMPLE_BLOCK);
  });

  test("throws when no /app/add block exists", () => {
    expect(() => extractAppAddBlock("# empty\n")).toThrow(/no fenced routeros block/);
  });

  test("throws when two /app/add blocks exist", () => {
    const readme = `\`\`\`routeros\n${SAMPLE_BLOCK}\n\`\`\`\n\`\`\`routeros\n${SAMPLE_BLOCK}\n\`\`\`\n`;
    expect(() => extractAppAddBlock(readme)).toThrow(/exactly 1/);
  });

  test("the real README has exactly one /app/add block", () => {
    const block = extractAppAddBlock(readText("README.md"));
    expect(block).toContain("use-https=yes");
    expect(block).toContain("ghcr.io/tikoci/rosetta:latest");
  });
});

describe("applyAppAddSubstitutions", () => {
  test("applies exactly the two documented substitutions", () => {
    const out = applyAppAddSubstitutions(SAMPLE_BLOCK, "ghcr.io/tikoci/rosetta:sha-abc123");
    expect(out).toContain("use-https=no");
    expect(out).not.toContain("use-https=yes");
    expect(out).toContain("ghcr.io/tikoci/rosetta:sha-abc123");
    expect(out).not.toContain("ghcr.io/tikoci/rosetta:latest");
    // Everything else is byte-identical to the input.
    expect(out.replace("use-https=no", "use-https=yes").replace("ghcr.io/tikoci/rosetta:sha-abc123", "ghcr.io/tikoci/rosetta:latest")).toBe(
      SAMPLE_BLOCK,
    );
  });

  test("fails unless use-https=yes matches exactly once", () => {
    expect(() => applyAppAddSubstitutions("no match here", "img")).toThrow(/exactly 1/);
    expect(() => applyAppAddSubstitutions("use-https=yes use-https=yes", "img")).toThrow(/exactly 1/);
  });

  test("fails unless the image ref matches exactly once", () => {
    const missing = SAMPLE_BLOCK.replace("ghcr.io/tikoci/rosetta:latest", "other/image:tag");
    expect(() => applyAppAddSubstitutions(missing, "img")).toThrow(/exactly 1/);
    const doubled = SAMPLE_BLOCK.replace("latest", "latest ghcr.io/tikoci/rosetta:latest");
    expect(() => applyAppAddSubstitutions(doubled, "img")).toThrow(/exactly 1/);
  });
});

describe("rewriteUiUrl", () => {
  test("rewrites only host:port", () => {
    expect(rewriteUiUrl("http://10.0.2.15:9803/mcp", 9803)).toBe("http://127.0.0.1:9803/mcp");
    expect(rewriteUiUrl("http://10.0.2.15:9803/mcp", 9999)).toBe("http://127.0.0.1:9999/mcp");
  });

  test("rejects https (wrong leg shape)", () => {
    expect(() => rewriteUiUrl("https://10.0.2.15:9803/mcp", 9803)).toThrow(/must use http/);
  });

  test("rejects a missing /mcp path", () => {
    expect(() => rewriteUiUrl("http://10.0.2.15:9803/", 9803)).toThrow(/\/mcp path/);
  });

  test("rejects garbage", () => {
    expect(() => rewriteUiUrl("", 9803)).toThrow(/not a URL/);
    expect(() => rewriteUiUrl("not a url", 9803)).toThrow(/not a URL/);
  });
});

describe("parseImageRef", () => {
  test("parses registry/repo:tag", () => {
    expect(parseImageRef("ghcr.io/tikoci/rosetta:v0.12.0")).toEqual({
      registry: "ghcr.io",
      repo: "tikoci/rosetta",
      reference: "v0.12.0",
      isDigest: false,
    });
  });

  test("parses repo@digest", () => {
    const parsed = parseImageRef("ghcr.io/tikoci/rosetta@sha256:9fbf37e0");
    expect(parsed.isDigest).toBe(true);
    expect(parsed.reference).toBe("sha256:9fbf37e0");
  });

  test("strips a tag from repo:tag@digest", () => {
    const parsed = parseImageRef("ghcr.io/tikoci/rosetta:v0.12.0@sha256:9fbf37e0");
    expect(parsed.repo).toBe("tikoci/rosetta");
    expect(parsed.reference).toBe("sha256:9fbf37e0");
    expect(parsed.isDigest).toBe(true);
  });

  test("requires a tag or digest", () => {
    expect(() => parseImageRef("ghcr.io/tikoci/rosetta")).toThrow(/must include a tag or digest/);
  });

  test("docker.io gets the library/ prefix", () => {
    expect(parseImageRef("alpine:3.21").repo).toBe("library/alpine");
  });
});

describe("deriveVersionFromTag", () => {
  test("strips a v prefix and keeps prereleases", () => {
    expect(deriveVersionFromTag("v0.12.0")).toBe("0.12.0");
    expect(deriveVersionFromTag("0.12.0")).toBe("0.12.0");
    expect(deriveVersionFromTag("v0.12.0-next.125")).toBe("0.12.0-next.125");
  });

  test("returns null for floating/sha tags", () => {
    expect(deriveVersionFromTag("latest")).toBeNull();
    expect(deriveVersionFromTag("next")).toBeNull();
    expect(deriveVersionFromTag("sha-abc123")).toBeNull();
  });
});

describe("registryApiHost", () => {
  test("maps docker.io to its API host, leaves others alone", () => {
    expect(registryApiHost("docker.io")).toBe("registry-1.docker.io");
    expect(registryApiHost("ghcr.io")).toBe("ghcr.io");
  });
});

describe("registryCredential", () => {
  test("GitHub tokens authenticate only to ghcr.io", () => {
    expect(registryCredential("ghcr.io", "secret")).toBe("secret");
    expect(registryCredential("registry-1.docker.io", "secret")).toBe("");
    expect(registryCredential("example.com", "secret")).toBe("");
    expect(registryCredential("ghcr.io", "")).toBe("");
  });
});

describe("isTrustedChallengeRealm", () => {
  test("trusts an HTTPS realm on the API host itself, nothing else", () => {
    expect(isTrustedChallengeRealm("https://ghcr.io/token", "ghcr.io")).toBe(true);
    expect(isTrustedChallengeRealm("http://ghcr.io/token", "ghcr.io")).toBe(false);
    expect(isTrustedChallengeRealm("https://evil.example/token", "ghcr.io")).toBe(false);
    expect(isTrustedChallengeRealm("not a url", "ghcr.io")).toBe(false);
  });
});

describe("searchPageCount", () => {
  test("counts pages in a search response", () => {
    expect(searchPageCount(JSON.stringify({ pages: [{ id: 1 }, { id: 2 }] }))).toBe(2);
  });

  test("empty pages count zero (metadata alone is not a result)", () => {
    expect(
      searchPageCount(JSON.stringify({ query: "firewall", pages: [], total_pages: 0, related: {}, next_steps: [] })),
    ).toBe(0);
  });

  test("non-JSON content throws", () => {
    expect(() => searchPageCount("plain prose, no results")).toThrow(/non-JSON/);
  });
});

describe("smoke-oci chained checks (#246)", () => {
  test("firstSearchPageId returns the first result id", () => {
    expect(firstSearchPageId(JSON.stringify({ pages: [{ id: 42 }, { id: 7 }] }))).toBe(42);
  });

  test("firstSearchPageId throws on empty pages, a missing id, or non-JSON", () => {
    expect(() => firstSearchPageId(JSON.stringify({ pages: [] }))).toThrow(/no numeric id/);
    expect(() => firstSearchPageId(JSON.stringify({ pages: [{}] }))).toThrow(/no numeric id/);
    expect(() => firstSearchPageId(JSON.stringify({}))).toThrow(/no numeric id/);
    expect(() => firstSearchPageId("not json")).toThrow(/non-JSON/);
  });

  test("pageTextLength sums text + code, missing fields count zero", () => {
    expect(pageTextLength(JSON.stringify({ text: "abc", code: "de" }))).toBe(5);
    expect(pageTextLength(JSON.stringify({ text: "abc" }))).toBe(3);
    expect(pageTextLength(JSON.stringify({ sections: [{ heading: "TOC only" }] }))).toBe(0);
    expect(() => pageTextLength("not json")).toThrow(/non-JSON/);
  });

  test("pageSectionCount counts TOC entries, missing counts zero", () => {
    expect(pageSectionCount(JSON.stringify({ text: "", sections: [{ heading: "a" }, { heading: "b" }] }))).toBe(2);
    expect(pageSectionCount(JSON.stringify({ text: "full text, no TOC" }))).toBe(0);
    expect(() => pageSectionCount("not json")).toThrow(/non-JSON/);
  });

  test("commandTreeChildCount counts array children; the empty prose answer counts zero", () => {
    expect(commandTreeChildCount(JSON.stringify([{ name: "filter" }, { name: "nat" }]))).toBe(2);
    expect(commandTreeChildCount(JSON.stringify([]))).toBe(0);
    expect(commandTreeChildCount("No commands found under: /ip/firewall")).toBe(0);
  });

  test("deviceLookupCount sums matrix results + catalog rows; a hard miss counts zero", () => {
    expect(deviceLookupCount(JSON.stringify({ results: [{ product_name: "RB5009" }], mode: "exact" }))).toBe(1);
    expect(
      deviceLookupCount(JSON.stringify({ results: [{ product_name: "a" }], catalog: [{ name: "b" }] })),
    ).toBe(2);
    expect(deviceLookupCount(JSON.stringify({ results: [], mode: "like" }))).toBe(0);
    expect(deviceLookupCount('No devices matched: "RB5009"')).toBe(0);
  });

  test("the smoke runs the full chain: search → get_page (chained id) → command_tree → device_lookup", () => {
    const src = readText("scripts/smoke-oci.ts");
    // tools/list must carry every tool the session calls.
    for (const tool of ["routeros_stats", "routeros_search", "routeros_get_page", "routeros_command_tree", "routeros_device_lookup"]) {
      expect(src).toContain(`"${tool}"`);
    }
    // get_page chains off the search result — no hardcoded page ids.
    expect(src).toContain("firstSearchPageId(text)");
    expect(src).toContain('{ page: String(firstId) }');
    expect(src).toContain('{ path: "/ip/firewall" }');
    expect(src).toContain('{ query: "RB5009" }');
    // Every call is isError-gated.
    expect(src.match(/\.isError\) throw/g)?.length).toBe(5);
  });
});

describe("writeDiagnosticsBundle", () => {
  test("writes JSON on success, returns false instead of throwing on failure", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "app-integration-"));
    try {
      const okPath = path.join(dir, "bundle.json");
      expect(await writeDiagnosticsBundle(okPath, { outcome: "pass" })).toBe(true);
      expect(JSON.parse(readFileSync(okPath, "utf-8"))).toEqual({ outcome: "pass" });
      expect(await writeDiagnosticsBundle(dir, {})).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("redactCredentials", () => {
  test("redacts credential-shaped keys at any depth, keeps the rest", () => {
    const input = {
      url: "http://127.0.0.1:9110/rest",
      auth: { username: "admin", password: "", header: "Basic eQ==" },
      nested: { token: "abc", port: 9110 },
    };
    expect(redactCredentials(input) as unknown).toEqual({
      url: "http://127.0.0.1:9110/rest",
      auth: "[redacted]",
      nested: { token: "[redacted]", port: 9110 },
    });
    // Input untouched.
    expect(input.auth.header).toBe("Basic eQ==");
  });
});

describe("parseQemuAccel", () => {
  test("reads the -accel flag value", () => {
    expect(parseQemuAccel("qemu-system-x86_64 -accel hvf -m 512")).toBe("hvf");
    expect(parseQemuAccel("qemu-system-aarch64 -accel tcg,tb-size=256 -m 1024")).toBe("tcg");
    expect(parseQemuAccel("qemu-system-x86_64 -accel kvm -cpu host")).toBe("kvm");
    expect(parseQemuAccel("qemu-system-x86_64 -m 512")).toBeNull();
  });
});

describe("logShowsContainerExit", () => {
  test("matches our container's deaths, ignores neighbors", () => {
    const logText = [
      "2026-10-30 container,info,debug app-rosetta: *** started /entrypoint.sh",
      "2026-10-30 container,error,debug app-rosetta: exited with status 1",
      "2026-10-30 container,error,debug other-thing: exited with status 1",
      "2026-10-30 container,error,debug app-rosetta: exited with signal 4 (Illegal instruction)",
    ].join("\n");
    const hits = logShowsContainerExit(logText, "app-rosetta");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain("status 1");
    expect(hits[1]).toContain("signal 4");
  });

  test("empty when nothing died", () => {
    expect(logShowsContainerExit("all quiet", "app-rosetta")).toEqual([]);
  });
});

describe("recipe pins", () => {
  test("RouterOS default is one stable >= 7.22", () => {
    expect(ROS_VERSION_DEFAULT).toMatch(/^7\.(2[2-9]|[3-9]\d)(\.\d+)?$/);
  });

  test("app disk leaves headroom (Phase 1: 2G fails on arm64)", () => {
    expect(APP_DISK_GB).toBeGreaterThanOrEqual(4);
  });
});

describe("app-integration.yml", () => {
  const yml = readText(".github/workflows/app-integration.yml");

  test("workflow file exists and is dispatch-only", () => {
    expect(yml).toContain("workflow_dispatch:");
    // No push/pull_request triggers anywhere in the triggers block: releases
    // are #246's job, and a skipped leg must never pass silently.
    const onBlock = yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("push:");
    expect(onBlock).not.toContain("pull_request:");
  });

  test("both legs run independently (matrix, no fail-fast, no conditions)", () => {
    expect(yml).toContain("fail-fast: false");
    expect(yml).toContain("- arch: x86");
    expect(yml).toContain("- arch: arm64");
    expect(yml).toContain("runs-on: ubuntu-latest");
    expect(yml).toContain("runs-on: ubuntu-24.04-arm");
    expect(yml).not.toContain("continue-on-error");
  });

  test("quickchr install matches the script pin", () => {
    expect(yml).toContain(`@tikoci/quickchr@${QUICKCHR_PIN}`);
  });

  test("x86 leg enables KVM (the Bun binary SIGILLs under TCG)", () => {
    expect(yml).toContain("Enable KVM (x86 leg)");
    expect(yml).toContain("chmod 666 /dev/kvm");
  });

  test("takes the candidate image, ros version, and expected version inputs", () => {
    for (const input of ["image:", "ros_version:", "version:"]) {
      expect(yml).toContain(input);
    }
    // Inputs cross into the shell via env:, never by ${{ }} expansion in run:.
    expect(yml).toContain("APP_IMAGE: $" + "{{ inputs.image }}");
    expect(yml).toContain('--image "$APP_IMAGE"');
    expect(yml).not.toContain("--image $" + "{{ inputs.image }}");
  });

  test("image input has no floating default (defaults must not fail)", () => {
    expect(yml).not.toContain('default: "ghcr.io/tikoci/rosetta:latest"');
  });

  test("diagnostics upload always runs", () => {
    expect(yml).toContain("if: always()");
    expect(yml).toContain("app-integration-*.json");
  });
});

describe("app-integration Makefile target", () => {
  const makefile = readText("Makefile");

  test("target exists with ARCH/IMAGE/ROS_VERSION knobs and IMAGE required", () => {
    expect(makefile).toContain("app-integration:");
    expect(makefile).toContain("ARCH ?= x86");
    expect(makefile).toContain("IMAGE ?=");
    expect(makefile).toContain("ROS_VERSION ?= 7.25");
    expect(makefile).toContain("$(error IMAGE is required");
    expect(makefile).toContain("scripts/app-integration.ts --arch $(ARCH) --image $(IMAGE)");
  });

  test("target is phony", () => {
    const phonyStart = makefile.indexOf(".PHONY:");
    const phonyEnd = makefile.indexOf("\n\n", phonyStart);
    expect(makefile.slice(phonyStart, phonyEnd)).toContain("app-integration");
  });
});
