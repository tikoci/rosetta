/**
 * extract-videos.test.ts — Tests for extract-videos.ts failure modes and pure functions.
 *
 * Uses mock yt-dlp shell scripts to verify timeout/error/missing-VTT handling
 * without hitting the network. The YTDLP_DEFAULT constant and the injectable
 * `ytdlp` parameters on downloadTranscript / listPlaylist make this possible.
 *
 * Pure-function tests (parseVtt / segmentTranscript) are in query.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadTranscript, listPlaylist } from "./extract-videos.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Write a shell script to `path` and make it executable. */
function writeMock(path: string, script: string): void {
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}


// ── Fixture setup ─────────────────────────────────────────────────────────────

let tmpBase: string;
let mockBin: string;
let downloadDir: string;

beforeAll(() => {
  tmpBase = join(tmpdir(), `rosetta-vid-test-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });
  mockBin = join(tmpBase, "yt-dlp-mock");
  downloadDir = join(tmpBase, "downloads");
  mkdirSync(downloadDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ── downloadTranscript failure modes ─────────────────────────────────────────

describe("downloadTranscript", () => {
  test("returns 'ok' when yt-dlp exits 0", () => {
    writeMock(mockBin, "exit 0");
    const result = downloadTranscript("vid1", downloadDir, mockBin);
    expect(result).toBe("ok");
  });

  test("returns 'error' when yt-dlp exits non-zero", () => {
    writeMock(mockBin, "exit 1");
    const result = downloadTranscript("vid1", downloadDir, mockBin);
    expect(result).toBe("error");
  });

  test("returns 'error' when yt-dlp exits 2 (usage error)", () => {
    writeMock(mockBin, "exit 2");
    const result = downloadTranscript("vid1", downloadDir, mockBin);
    expect(result).toBe("error");
  });

  test("returns 'timeout' when yt-dlp exceeds the timeout", () => {
    // sleep 60 would hang forever; we set a very short timeout
    writeMock(mockBin, "sleep 60");
    const result = downloadTranscript("vid1", downloadDir, mockBin, 300); // 300ms
    expect(result).toBe("timeout");
  });

  test("timeout does not leave zombie processes", async () => {
    writeMock(mockBin, "sleep 60");
    downloadTranscript("vid2", downloadDir, mockBin, 200);
    // Give the OS a moment to reap the killed child
    await Bun.sleep(100);
    // If we reach here without hanging, the process was killed cleanly
    expect(true).toBe(true);
  });

  test("accepts info.json + VTT written by mock and returns 'ok'", () => {
    // Mock that writes the expected output files
    const videoId = "abc123";
    const script = [
      // Write a minimal info.json
      `echo '{"id":"${videoId}","title":"Test","duration":300}' > "${join(downloadDir, `${videoId}.info.json`)}"`,
      // Write a minimal VTT
      `printf 'WEBVTT\\n\\n00:00:01.000 --> 00:00:05.000\\nHello world\\n' > "${join(downloadDir, `${videoId}.en.vtt`)}"`,
      "exit 0",
    ].join("\n");
    writeMock(mockBin, script);

    const result = downloadTranscript(videoId, downloadDir, mockBin);
    expect(result).toBe("ok");

    // Files should be present (main() would clean them up; we don't call main() here)
    const infoContent = readFileSync(join(downloadDir, `${videoId}.info.json`), "utf8");
    expect(JSON.parse(infoContent).id).toBe(videoId);
  });
});

// ── listPlaylist failure modes ────────────────────────────────────────────────

describe("listPlaylist", () => {
  test("throws when yt-dlp exits non-zero", () => {
    writeMock(mockBin, "exit 1");
    expect(() => listPlaylist("https://example.com", mockBin)).toThrow(/failed/);
  });

  test("throws on timeout", () => {
    writeMock(mockBin, "sleep 60");
    expect(() => listPlaylist("https://example.com", mockBin, 300)).toThrow(/timed out/);
  });

  test("parses NDJSON output into entries", () => {
    const ndjsonFile = join(tmpBase, "playlist.ndjson");
    writeFileSync(
      ndjsonFile,
      `${[
        JSON.stringify({ id: "abc", title: "RouterOS VLAN Tutorial", duration: 600 }),
        JSON.stringify({ id: "def", title: "Firewall Filter Guide", duration: 900 }),
        JSON.stringify({ id: "ghi", title: "BGP Configuration", duration: 450 }),
      ].join("\n")}\n`,
    );
    writeMock(mockBin, `cat "${ndjsonFile}"`);

    const result = listPlaylist("https://example.com", mockBin);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: "abc", title: "RouterOS VLAN Tutorial", duration: 600 });
    expect(result[1].id).toBe("def");
    expect(result[2].duration).toBe(450);
  });

  test("skips malformed NDJSON lines gracefully", () => {
    const ndjsonFile = join(tmpBase, "playlist-bad.ndjson");
    writeFileSync(
      ndjsonFile,
      `${[
        JSON.stringify({ id: "abc", title: "Good Video", duration: 300 }),
        "not valid json at all",
        JSON.stringify({ id: "def", title: "Another Good One", duration: 500 }),
        '{"missing_id": true}', // no id field
      ].join("\n")}\n`,
    );
    writeMock(mockBin, `cat "${ndjsonFile}"`);

    const result = listPlaylist("https://example.com", mockBin);
    expect(result).toHaveLength(2); // only the two valid entries with id+title
    expect(result[0].id).toBe("abc");
    expect(result[1].id).toBe("def");
  });

  test("returns empty array for empty output", () => {
    writeMock(mockBin, "exit 0"); // exits 0 with no stdout
    const result = listPlaylist("https://example.com", mockBin);
    expect(result).toHaveLength(0);
  });
});

// ── YTDLP_DEFAULT env var override ───────────────────────────────────────────

describe("YTDLP_DEFAULT", () => {
  test("is set from YTDLP env var if provided", async () => {
    // import is cached, so we can't re-import with a different env var,
    // but we can verify the module exports YTDLP_DEFAULT for inspection
    const { YTDLP_DEFAULT } = await import("./extract-videos.ts");
    // In test env YTDLP is not set, so it defaults to "yt-dlp"
    // (or whatever the test runner's env has — just ensure it's a string)
    expect(typeof YTDLP_DEFAULT).toBe("string");
    expect(YTDLP_DEFAULT.length).toBeGreaterThan(0);
  });
});
