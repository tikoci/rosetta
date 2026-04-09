/**
 * extract-videos.ts — Extract MikroTik YouTube channel transcripts into the videos table.
 *
 * Uses yt-dlp (system dependency) to download video metadata and auto-generated
 * subtitles (English VTT), then parses them into the `videos` and `video_segments` tables.
 *
 * Incremental: skips videos already in the DB (use --force to re-extract).
 * NOT part of `make extract` — requires yt-dlp installed separately.
 *
 * Usage:
 *   bun run src/extract-videos.ts                 # full channel, incremental
 *   bun run src/extract-videos.ts --limit=10      # dev: process at most 10 new videos
 *   bun run src/extract-videos.ts --force         # re-extract all (delete + reinsert)
 *   bun run src/extract-videos.ts --playlist=URL  # override channel URL
 *   bun run src/extract-videos.ts --max-duration=600  # cap at 10 min (default: 1500)
 *
 * Requirements:
 *   brew install yt-dlp   # macOS
 *   apt install yt-dlp    # Ubuntu/Debian
 *   pip install yt-dlp    # any platform
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "./db.ts";

// ── Config ──

/** yt-dlp executable — override with YTDLP env var for testing. */
export const YTDLP_DEFAULT = process.env.YTDLP ?? "yt-dlp";

/** Hard timeout per video download (ms). yt-dlp with --retries 2 --socket-timeout 15 should
 *  self-terminate well before this, but this is the absolute backstop. */
const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes

/** Hard timeout for playlist listing (ms). */
const LIST_TIMEOUT_MS = 300_000; // 5 minutes

const CHANNEL_URL = "https://www.youtube.com/@MikroTik/videos";
const DEFAULT_MAX_DURATION = 1500; // 25 minutes — excludes long MUM talks
const MIN_DURATION = 90; // 1.5 minutes — excludes Shorts

/** Title substrings that indicate MUM conference content to skip. */
const MUM_TITLE_PATTERNS = [
  /\bMUM\b/,
  /mikrotik user meeting/i,
  /\bpresentation\b.*\b(mum|meeting)\b/i,
];

// ── CLI flags ──

const rawArgs = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  for (const arg of rawArgs) {
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

const LIMIT = getFlag("limit") ? Number(getFlag("limit")) : undefined;
const FORCE = rawArgs.includes("--force");
const PLAYLIST = getFlag("playlist") ?? CHANNEL_URL;
const MAX_DURATION = getFlag("max-duration") ? Number(getFlag("max-duration")) : DEFAULT_MAX_DURATION;
/** Exit non-zero if any video fails to download.  Use in CI: make extract-videos ARGS=--strict */
const STRICT = rawArgs.includes("--strict");

// ── Types ──

type Chapter = {
  start_time: number;
  end_time: number;
  title: string;
};

type YtVideoInfo = {
  id: string;
  title: string;
  description?: string;
  channel?: string;
  upload_date?: string;
  duration?: number;
  webpage_url?: string;
  view_count?: number;
  like_count?: number;
  chapters?: Chapter[];
};

export type VttCue = {
  start_s: number;
  text: string;
};

export type TranscriptSegment = {
  chapter_title: string | null;
  start_s: number;
  end_s: number | null;
  transcript: string;
};

// ── yt-dlp check ──

function checkYtDlp(ytdlp = YTDLP_DEFAULT): boolean {
  const result = Bun.spawnSync([ytdlp, "--version"], { stdio: ["inherit", "pipe", "pipe"] });
  if (result.exitCode === 0) {
    const version = new TextDecoder().decode(result.stdout).trim();
    console.log(`yt-dlp ${version}`);
    return true;
  }
  console.error(`yt-dlp not found. Install it before running this extractor:

  macOS:   brew install yt-dlp
  Ubuntu:  apt install yt-dlp
  Any:     pip install yt-dlp
  Docs:    https://github.com/yt-dlp/yt-dlp#installation`);
  return false;
}

// ── VTT parsing ──

const VTT_TIMESTAMP_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> /;
const HTML_TAG_RE = /<[^>]+>/g;
// Inline timestamp tags like <00:00:01.234>
const INLINE_TS_RE = /<\d{2}:\d{2}:\d{2}\.\d{3}>/g;

function vttTimestampToSeconds(text: string): number {
  const m = text.match(VTT_TIMESTAMP_RE);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/**
 * Parse a WebVTT string into cues with start time (seconds) and clean text.
 * Auto-generated YouTube VTT has overlapping sliding-window cues — we deduplicate
 * by skipping cues whose text is already a suffix of the accumulated line buffer.
 */
export function parseVtt(vttText: string): VttCue[] {
  const lines = vttText.split("\n");
  const cues: VttCue[] = [];
  let currentStart = 0;
  let currentLines: string[] = [];
  let inCueText = false;
  let prevAccumulated = "";

  function flushCue() {
    if (currentLines.length === 0) return;
    const raw = currentLines.join(" ").trim();
    if (!raw) return;
    // Strip HTML tags and inline timestamp tags
    const clean = raw.replace(INLINE_TS_RE, "").replace(HTML_TAG_RE, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    // Deduplicate: skip if clean text is a suffix of what we've already emitted
    if (prevAccumulated.endsWith(clean)) return;
    cues.push({ start_s: currentStart, text: clean });
    // Track last ~200 chars of accumulated text for dedup check
    prevAccumulated = `${prevAccumulated} ${clean}`.slice(-200);
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/, "");

    if (line.startsWith("WEBVTT") || line.startsWith("Kind:") || line.startsWith("Language:")) {
      inCueText = false;
      continue;
    }

    if (VTT_TIMESTAMP_RE.test(line)) {
      flushCue();
      currentStart = vttTimestampToSeconds(line);
      currentLines = [];
      inCueText = true;
      continue;
    }

    if (line.trim() === "") {
      if (inCueText) flushCue();
      inCueText = false;
      currentLines = [];
      continue;
    }

    // Cue identifier lines (pure numbers or alphanumeric IDs before timestamp)
    if (inCueText) {
      currentLines.push(line);
    }
  }
  flushCue();

  return cues;
}

/**
 * Group VTT cues into segments by chapter.
 * If no chapters provided, returns a single segment covering the whole video.
 */
export function segmentTranscript(cues: VttCue[], chapters?: Chapter[]): TranscriptSegment[] {
  if (!chapters || chapters.length === 0) {
    return [
      {
        chapter_title: null,
        start_s: 0,
        end_s: null,
        transcript: cues.map((c) => c.text).join(" ").trim(),
      },
    ];
  }

  return chapters.map((ch, i) => {
    const next = chapters[i + 1];
    const chCues = cues.filter((c) => c.start_s >= ch.start_time && c.start_s < ch.end_time);
    return {
      chapter_title: ch.title,
      start_s: Math.round(ch.start_time),
      end_s: next ? Math.round(next.start_time) : Math.round(ch.end_time),
      transcript: chCues.map((c) => c.text).join(" ").trim(),
    };
  });
}

// ── Filtering ──

function isMumContent(title: string): boolean {
  return MUM_TITLE_PATTERNS.some((p) => p.test(title));
}

function isInDurationRange(duration: number | undefined): boolean {
  if (duration === undefined) return false;
  return duration >= MIN_DURATION && duration <= MAX_DURATION;
}

// ── yt-dlp invocation helpers ──

/** List all videos in a playlist/channel, return flat metadata entries. */
export function listPlaylist(
  url: string,
  ytdlp = YTDLP_DEFAULT,
  timeoutMs = LIST_TIMEOUT_MS,
): Array<{ id: string; title: string; duration?: number }> {
  console.log(`Listing videos from: ${url}`);
  const result = Bun.spawnSync(
    [ytdlp, "--flat-playlist", "--dump-json", "--socket-timeout", "15", "--retries", "2", "--no-warnings", url],
    { stdio: ["inherit", "pipe", "pipe"], timeout: timeoutMs },
  );
  if (result.exitCode === null) {
    throw new Error(`yt-dlp playlist listing timed out after ${timeoutMs / 1000}s`);
  }
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`yt-dlp playlist listing failed (exit ${result.exitCode}): ${stderr.trim()}`);
  }
  const stdout = new TextDecoder().decode(result.stdout);
  const entries: Array<{ id: string; title: string; duration?: number }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { id?: string; title?: string; duration?: number };
      if (obj.id && obj.title) {
        entries.push({ id: obj.id, title: obj.title, duration: obj.duration });
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/** Download metadata + VTT transcript for one video into tmpDir.
 *  Returns "ok" | "timeout" | "error" — never throws.
 *  The ytdlp and timeoutMs params exist for testing (pass a mock binary path). */
export function downloadTranscript(
  videoId: string,
  tmpDir: string,
  ytdlp = YTDLP_DEFAULT,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): "ok" | "timeout" | "error" {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const result = Bun.spawnSync(
    [
      ytdlp,
      "--skip-download",
      "--write-auto-subs",
      "--write-info-json",
      "--sub-format", "vtt",
      "--sub-langs", "en",
      "--socket-timeout", "15",   // per-connection HTTP timeout (seconds)
      "--retries", "2",          // was default 10 — prevents indefinite retry loops
      "--fragment-retries", "2",
      "--no-warnings",
      "-o", join(tmpDir, "%(id)s.%(ext)s"),
      url,
    ],
    { stdio: ["inherit", "pipe", "pipe"], timeout: timeoutMs },
  );
  if (result.exitCode === null) return "timeout";
  if (result.exitCode !== 0) return "error";
  return "ok";
}

// ── DB helpers ──

function videoExists(videoId: string): boolean {
  const row = db.prepare("SELECT id FROM videos WHERE video_id = ?").get(videoId);
  return row !== null;
}

function deleteVideoData(videoId: string): void {
  const row = db.prepare("SELECT id FROM videos WHERE video_id = ?").get(videoId) as { id: number } | null;
  if (!row) return;
  db.run("DELETE FROM video_segments WHERE video_id = ?", [row.id]);
  db.run("DELETE FROM videos WHERE id = ?", [row.id]);
}

// ── Main ──

async function main() {
  if (!checkYtDlp()) process.exit(1);

  initDb();

  const tmpDir = join(tmpdir(), "rosetta-yt");
  mkdirSync(tmpDir, { recursive: true });

  let listed: Array<{ id: string; title: string; duration?: number }>;
  try {
    listed = listPlaylist(PLAYLIST);
  } catch (err) {
    console.error(`Failed to list playlist: ${err}`);
    process.exit(1);
  }

  // Filter by duration + MUM content
  const filtered = listed.filter(
    (v) => isInDurationRange(v.duration) && !isMumContent(v.title),
  );

  console.log(`\nPlaylist: ${listed.length} total → ${filtered.length} after filter (duration ${MIN_DURATION}–${MAX_DURATION}s, no MUM)`);

  // Apply limit for dev
  const toProcess = LIMIT !== undefined ? filtered.slice(0, LIMIT) : filtered;

  // Cleanup on SIGINT so the temp dir is removed even if the user Ctrl+C's
  process.on("SIGINT", () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(130);
  });

  let newCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let timedOutCount = 0;
  let noTranscriptCount = 0;
  const failedIds: string[] = [];

  const insertVideo = db.prepare(`
    INSERT OR REPLACE INTO videos (video_id, title, description, channel, upload_date, duration_s, url, view_count, like_count, has_chapters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSegment = db.prepare(`
    INSERT INTO video_segments (video_id, chapter_title, start_s, end_s, transcript, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < toProcess.length; i++) {
    const entry = toProcess[i];
    const prefix = `[${i + 1}/${toProcess.length}]`;

    if (!FORCE && videoExists(entry.id)) {
      console.log(`${prefix} skip (already extracted): ${entry.title}`);
      skippedCount++;
      continue;
    }

    const t0 = Date.now();
    console.log(`${prefix} extracting: ${entry.title}`);

    const dlResult = downloadTranscript(entry.id, tmpDir);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (dlResult === "timeout") {
      console.error(`  ✗ TIMEOUT after ${elapsed}s — ${entry.title} (${entry.id})`);
      failedIds.push(entry.id);
      timedOutCount++;
      failedCount++;
      continue;
    }
    if (dlResult === "error") {
      console.error(`  ✗ yt-dlp error after ${elapsed}s — ${entry.title} (${entry.id})`);
      failedIds.push(entry.id);
      failedCount++;
      continue;
    }

    // Find generated files
    const infoPath = join(tmpDir, `${entry.id}.info.json`);
    // yt-dlp may output en.vtt or en-orig.vtt depending on version
    const vttCandidates = [
      join(tmpDir, `${entry.id}.en.vtt`),
      join(tmpDir, `${entry.id}.en-orig.vtt`),
    ];
    const vttPath = vttCandidates.find((p) => existsSync(p));

    if (!existsSync(infoPath)) {
      console.warn(`  ✗ info.json not found for ${entry.id}`);
      failedCount++;
      continue;
    }

    let info: YtVideoInfo;
    try {
      info = JSON.parse(readFileSync(infoPath, "utf8")) as YtVideoInfo;
    } catch {
      console.warn(`  ✗ failed to parse info.json for ${entry.id}`);
      failedCount++;
      continue;
    }

    let segments: TranscriptSegment[] = [];
    if (vttPath && existsSync(vttPath)) {
      const vttText = readFileSync(vttPath, "utf8");
      const cues = parseVtt(vttText);
      segments = segmentTranscript(cues, info.chapters);
    } else {
      console.warn(`  ⚠ no English transcript for ${entry.id} — storing metadata only`);
      noTranscriptCount++;
      // Store a placeholder segment so the video is still discoverable
      segments = [{ chapter_title: null, start_s: 0, end_s: null, transcript: "" }];
    }

    // Skip segments with empty transcripts if we got no VTT at all
    const hasRealTranscript = segments.some((s) => s.transcript.length > 0);
    if (!hasRealTranscript) {
      console.warn(`  ⚠ empty transcript for ${entry.id}, storing metadata only`);
    }

    // Remove old data if --force
    if (FORCE) deleteVideoData(entry.id);

    const hasChapters = (info.chapters?.length ?? 0) > 1 ? 1 : 0;

    db.transaction(() => {
      insertVideo.run(
        info.id,
        info.title,
        info.description ?? null,
        info.channel ?? null,
        info.upload_date ?? null,
        info.duration != null ? Math.round(info.duration) : null,
        info.webpage_url ?? `https://youtu.be/${info.id}`,
        info.view_count ?? null,
        info.like_count ?? null,
        hasChapters,
      );
      const videoRow = db.prepare("SELECT id FROM videos WHERE video_id = ?").get(info.id) as { id: number };
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        insertSegment.run(
          videoRow.id,
          seg.chapter_title,
          seg.start_s,
          seg.end_s,
          seg.transcript,
          si,
        );
      }
    })();

    const chapNote = hasChapters ? ` (${info.chapters?.length} chapters)` : "";
    const segNote = hasRealTranscript ? ` → ${segments.length} segment(s)${chapNote}` : " (no transcript)";
    console.log(`  ✓ ${info.title}${segNote}`);
    newCount++;

    // Clean up temp files for this video
    for (const p of [infoPath, ...vttCandidates]) {
      try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ }
    }
  }

  // Final cleanup of temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\nDone: ${newCount} new, ${skippedCount} skipped, ${noTranscriptCount} no-transcript, ${failedCount} failed (${timedOutCount} timeout)`);

  if (failedIds.length > 0) {
    console.error(`\nFailed video IDs (${failedIds.length}):`);
    for (const id of failedIds) {
      console.error(`  https://www.youtube.com/watch?v=${id}`);
    }
  }

  if (STRICT && failedCount > 0) {
    console.error(`\nExiting non-zero: ${failedCount} video(s) failed and --strict mode is active`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
