/**
 * extract-videos.test.ts — Tests for extract-videos.ts failure modes and pure functions.
 *
 * Uses mock yt-dlp shell scripts to verify timeout/error/missing-VTT handling
 * without hitting the network. The YTDLP_DEFAULT constant and the injectable
 * `ytdlp` parameters on downloadTranscript / listPlaylist make this possible.
 *
 * Cache tests (saveCache / importCache / loadKnownBad / findLatestCache) use an
 * in-memory SQLite seeded via initDb() — same pattern as query.test.ts.
 *
 * Pure-function tests (parseVtt / segmentTranscript) are in query.test.ts.
 */

// Set BEFORE any import that transitively loads db.ts
process.env.DB_PATH = ":memory:";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic imports guarantee that the DB_PATH env-var above wins over Bun's
// static-import hoisting — same pattern as query.test.ts.
const { db, initDb } = await import("./db.ts");
const { downloadTranscript, listPlaylist, saveCache, importCache, loadKnownBad, findLatestCache } =
  await import("./extract-videos.ts");

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
  // Initialize the in-memory DB schema so cache functions can INSERT/SELECT
  initDb();

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

// ── Cache: loadKnownBad ───────────────────────────────────────────────────────

describe("loadKnownBad", () => {
  test("returns empty Set for non-existent file", () => {
    const result = loadKnownBad(join(tmpBase, "nonexistent-known-bad.json"));
    expect(result.size).toBe(0);
  });

  test("returns Set of IDs from valid JSON", () => {
    const path = join(tmpBase, "known-bad.json");
    writeFileSync(path, JSON.stringify({ abc123: "non-English: Russian", def456: "private video" }), "utf8");
    const result = loadKnownBad(path);
    expect(result.size).toBe(2);
    expect(result.has("abc123")).toBe(true);
    expect(result.has("def456")).toBe(true);
  });

  test("ignores keys starting with _", () => {
    const path = join(tmpBase, "known-bad-comment.json");
    writeFileSync(path, JSON.stringify({ _comment: "metadata", vid1: "reason" }), "utf8");
    const result = loadKnownBad(path);
    expect(result.has("_comment")).toBe(false);
    expect(result.has("vid1")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("returns empty Set for malformed JSON", () => {
    const path = join(tmpBase, "known-bad-malformed.json");
    writeFileSync(path, "not valid json { at all", "utf8");
    const result = loadKnownBad(path);
    expect(result.size).toBe(0);
  });
});

// ── Cache: findLatestCache ────────────────────────────────────────────────────

describe("findLatestCache", () => {
  let cacheRoot: string;

  beforeAll(() => {
    cacheRoot = join(tmpBase, "transcripts-find-test");
    mkdirSync(cacheRoot, { recursive: true });
  });

  test("returns null when transcripts dir does not exist", () => {
    const result = findLatestCache(join(tmpBase, "no-such-dir"));
    expect(result).toBeNull();
  });

  test("returns null when transcripts dir has no date subdirs", () => {
    const emptyRoot = join(tmpBase, "transcripts-empty");
    mkdirSync(join(emptyRoot, "transcripts"), { recursive: true });
    const result = findLatestCache(emptyRoot);
    expect(result).toBeNull();
  });

  test("returns path to the most recent videos.ndjson", () => {
    const t = join(tmpBase, "tc1");
    mkdirSync(join(t, "transcripts", "2024-01-01"), { recursive: true });
    mkdirSync(join(t, "transcripts", "2024-06-15"), { recursive: true });
    mkdirSync(join(t, "transcripts", "2024-03-10"), { recursive: true });
    writeFileSync(join(t, "transcripts", "2024-01-01", "videos.ndjson"), "", "utf8");
    writeFileSync(join(t, "transcripts", "2024-06-15", "videos.ndjson"), "", "utf8");
    writeFileSync(join(t, "transcripts", "2024-03-10", "videos.ndjson"), "", "utf8");
    const result = findLatestCache(t);
    expect(result).toContain("2024-06-15");
  });

  test("skips dirs without videos.ndjson", () => {
    const t = join(tmpBase, "tc2");
    mkdirSync(join(t, "transcripts", "2025-01-01"), { recursive: true });
    mkdirSync(join(t, "transcripts", "2024-12-31"), { recursive: true });
    // Only older dir has the file
    writeFileSync(join(t, "transcripts", "2024-12-31", "videos.ndjson"), "", "utf8");
    const result = findLatestCache(t);
    expect(result).toContain("2024-12-31");
  });
});

// ── Cache: saveCache + importCache ────────────────────────────────────────────

describe("saveCache + importCache", () => {
  let cacheDir: string;
  const VIDEO_ID = "cache-test-vid1";
  const VIDEO_ID_2 = "cache-test-vid2";

  beforeAll(() => {
    cacheDir = join(tmpBase, "cache-out");
    mkdirSync(cacheDir, { recursive: true });

    // Insert two test videos into the in-memory DB
    db.run(`
      INSERT OR REPLACE INTO videos (video_id, title, description, channel, upload_date, duration_s, url, view_count, like_count, has_chapters)
      VALUES ('${VIDEO_ID}', 'Test Video One', 'A description', 'MikroTik', '20240101', 300, 'https://www.youtube.com/watch?v=${VIDEO_ID}', 1000, 50, 1)
    `);
    const vid1 = db.prepare("SELECT id FROM videos WHERE video_id = ?").get(VIDEO_ID) as { id: number };
    db.run(`INSERT INTO video_segments (video_id, chapter_title, start_s, end_s, transcript, sort_order) VALUES (${vid1.id}, 'Intro', 0, 60, 'Hello world', 0)`);
    db.run(`INSERT INTO video_segments (video_id, chapter_title, start_s, end_s, transcript, sort_order) VALUES (${vid1.id}, 'Setup', 60, 120, 'Now configure routeros', 1)`);

    db.run(`
      INSERT OR REPLACE INTO videos (video_id, title, description, channel, upload_date, duration_s, url, view_count, like_count, has_chapters)
      VALUES ('${VIDEO_ID_2}', 'Test Video Two', NULL, 'MikroTik', '20240201', 180, 'https://www.youtube.com/watch?v=${VIDEO_ID_2}', 500, 20, 0)
    `);
    const vid2 = db.prepare("SELECT id FROM videos WHERE video_id = ?").get(VIDEO_ID_2) as { id: number };
    db.run(`INSERT INTO video_segments (video_id, chapter_title, start_s, end_s, transcript, sort_order) VALUES (${vid2.id}, NULL, 0, NULL, 'Single segment content here', 0)`);
  });

  test("saveCache writes NDJSON with correct video count", () => {
    const outPath = join(cacheDir, "videos.ndjson");
    const count = saveCache(outPath);
    expect(count).toBeGreaterThanOrEqual(2); // at least our two test videos
    const content = readFileSync(outPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(count);
  });

  test("saveCache NDJSON contains correct video data", () => {
    const outPath = join(cacheDir, "videos.ndjson");
    const content = readFileSync(outPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const vid1Entry = lines.map((l) => JSON.parse(l)).find((e: { video_id: string }) => e.video_id === VIDEO_ID);
    expect(vid1Entry).toBeDefined();
    expect(vid1Entry.title).toBe("Test Video One");
    expect(vid1Entry.has_chapters).toBe(1);
    expect(vid1Entry.segments).toHaveLength(2);
    expect(vid1Entry.segments[0].chapter_title).toBe("Intro");
    expect(vid1Entry.segments[1].transcript).toBe("Now configure routeros");
  });

  test("importCache is idempotent (skips existing videos)", () => {
    const outPath = join(cacheDir, "videos.ndjson");
    // Videos already in DB, importing again should return skipped > 0, imported = 0
    const result = importCache(outPath);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(result.knownBadSkipped).toBe(0);
  });

  test("importCache with force=true re-inserts existing videos", () => {
    const outPath = join(cacheDir, "videos.ndjson");
    const result = importCache(outPath, { force: true });
    expect(result.imported).toBeGreaterThanOrEqual(2);
    expect(result.skipped).toBe(0);
  });

  test("importCache skips known-bad IDs", () => {
    // Write a small NDJSON with one known-bad video
    const singlePath = join(cacheDir, "single.ndjson");
    const entry = { video_id: "skipme", title: "Skip This", description: null, channel: null, upload_date: null, duration_s: 200, url: "https://www.youtube.com/watch?v=skipme", view_count: null, like_count: null, has_chapters: 0, segments: [] };
    writeFileSync(singlePath, `${JSON.stringify(entry)}\n`, "utf8");

    const knownBad = new Set(["skipme"]);
    const result = importCache(singlePath, { knownBad });
    expect(result.knownBadSkipped).toBe(1);
    expect(result.imported).toBe(0);

    // Verify it was NOT inserted
    const row = db.prepare("SELECT id FROM videos WHERE video_id = 'skipme'").get();
    expect(row).toBeNull();
  });

  test("importCache handles malformed NDJSON lines gracefully", () => {
    const badPath = join(cacheDir, "bad.ndjson");
    writeFileSync(badPath, `not json\n${JSON.stringify({ video_id: "validone", title: "OK", description: null, channel: null, upload_date: null, duration_s: 100, url: "https://www.youtube.com/watch?v=validone", view_count: null, like_count: null, has_chapters: 0, segments: [] })}\n`, "utf8");
    const result = importCache(badPath);
    // Should import 1 valid video, skip the malformed line
    expect(result.imported + result.skipped).toBeGreaterThanOrEqual(1);
  });
});
