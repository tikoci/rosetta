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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
/** Read NDJSON from latest transcripts/ dir and import into DB (no yt-dlp). */
const FROM_CACHE = rawArgs.includes("--from-cache");
/** Write NDJSON to transcripts/YYYY-MM-DD/videos.ndjson after yt-dlp extraction. */
const SAVE_CACHE = rawArgs.includes("--save-cache");
/** Path to known-bad JSON {id: reason} \u2014 skip these video IDs during yt-dlp extraction. */
const KNOWN_BAD_PATH = getFlag("known-bad");

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

// ── Product name normalization ──

/** Map of Unicode superscript/subscript digits → ASCII digits. */
const DIGIT_SUPER_SUB: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
};

/**
 * Normalize Unicode superscript/subscript digits to ASCII digits.
 * e.g. "hAP ax³" → "hAP ax3", "hAP ax²" → "hAP ax2"
 * Preserves null for nullable columns.
 */
function normalizeSuperscripts(s: string): string;
function normalizeSuperscripts(s: string | null): string | null;
function normalizeSuperscripts(s: string | null): string | null {
  if (s === null) return null;
  return s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/g, (c) => DIGIT_SUPER_SUB[c] ?? c);
}

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
    // Strip HTML tags and inline timestamp tags; remove any unmatched angle
    // brackets so malformed captions cannot leave HTML-shaped text behind.
    const clean = raw.replace(INLINE_TS_RE, "").replace(HTML_TAG_RE, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    // Deduplicate: skip if clean text is a suffix of what we've already emitted
    if (prevAccumulated.endsWith(clean)) return;
    cues.push({ start_s: currentStart, text: clean });
    // Track last ~200 chars of accumulated text for dedup check
    prevAccumulated = `${prevAccumulated} ${clean}`.slice(-200);
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, "");

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

// ── Cache: NDJSON export / import ──
//
// Format: one JSON object per line (NDJSON).  Each line is a VideoCacheEntry.
// The transcripts/ directory mirrors the matrix/ pattern:
//   transcripts/YYYY-MM-DD/videos.ndjson   \u2014 committed to git, used by CI
//   transcripts/known-bad.json             \u2014 manually maintained {id: reason}
//
// Workflow:
//   Local:  make extract-videos            # fetch from YouTube, slow (~30\u201360 min)
//           make save-videos-cache         # export DB \u2192 transcripts/YYYY-MM-DD/videos.ndjson
//           git add transcripts/ && git commit
//   CI:     make extract-videos-from-cache # import from committed NDJSON, fast (~5 s)

export type VideoCacheSegment = {
  chapter_title: string | null;
  start_s: number;
  end_s: number | null;
  transcript: string;
  sort_order: number;
};

export type VideoCacheEntry = {
  video_id: string;
  title: string;
  description: string | null;
  channel: string | null;
  upload_date: string | null;
  duration_s: number | null;
  url: string;
  view_count: number | null;
  like_count: number | null;
  has_chapters: number;
  segments: VideoCacheSegment[];
};

/**
 * Export all videos + segments from DB to an NDJSON file.
 * Creates the output directory if needed. Returns the number of videos written.
 */
export function saveCache(outputPath: string): number {
  const videos = db
    .prepare("SELECT video_id, title, description, channel, upload_date, duration_s, url, view_count, like_count, has_chapters FROM videos ORDER BY upload_date DESC, video_id")
    .all() as Omit<VideoCacheEntry, "segments">[];

  type SegRow = VideoCacheSegment & { video_id: string };
  const segRows = db
    .prepare("SELECT v.video_id, vs.chapter_title, vs.start_s, vs.end_s, vs.transcript, vs.sort_order FROM video_segments vs JOIN videos v ON v.id = vs.video_id ORDER BY v.video_id, vs.sort_order")
    .all() as SegRow[];

  // Index segments by video_id string
  const segMap = new Map<string, VideoCacheSegment[]>();
  for (const row of segRows) {
    const segs = segMap.get(row.video_id) ?? [];
    segs.push({ chapter_title: row.chapter_title, start_s: row.start_s, end_s: row.end_s, transcript: row.transcript, sort_order: row.sort_order });
    segMap.set(row.video_id, segs);
  }

  const lines = videos.map((v) => {
    const entry: VideoCacheEntry = { ...v, segments: segMap.get(v.video_id) ?? [] };
    return JSON.stringify(entry);
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  return videos.length;
}

/**
 * Import videos + segments from an NDJSON cache file into the DB.
 * Skips videos already present unless force=true.
 * knownBad is a Set of video IDs to skip entirely.
 * Returns { imported, skipped, knownBadSkipped }.
 */
export function importCache(
  ndjsonPath: string,
  opts: { force?: boolean; knownBad?: Set<string> } = {},
): { imported: number; skipped: number; knownBadSkipped: number } {
  const { force = false, knownBad = new Set<string>() } = opts;

  const text = readFileSync(ndjsonPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());

  const insertVideo = db.prepare(`
    INSERT OR REPLACE INTO videos (video_id, title, description, channel, upload_date, duration_s, url, view_count, like_count, has_chapters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSegment = db.prepare(`
    INSERT INTO video_segments (video_id, chapter_title, start_s, end_s, transcript, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let skipped = 0;
  let knownBadSkipped = 0;

  for (const line of lines) {
    let entry: VideoCacheEntry;
    try {
      entry = JSON.parse(line) as VideoCacheEntry;
    } catch {
      console.warn(`  \u26a0 skipping malformed NDJSON line`);
      continue;
    }

    if (knownBad.has(entry.video_id)) {
      knownBadSkipped++;
      continue;
    }

    if (!force && videoExists(entry.video_id)) {
      skipped++;
      continue;
    }

    if (force) deleteVideoData(entry.video_id);

    db.transaction(() => {
      insertVideo.run(
        entry.video_id, normalizeSuperscripts(entry.title), normalizeSuperscripts(entry.description ?? null), entry.channel,
        entry.upload_date, entry.duration_s, entry.url,
        entry.view_count, entry.like_count, entry.has_chapters,
      );
      const row = db.prepare("SELECT id FROM videos WHERE video_id = ?").get(entry.video_id) as { id: number };
      for (const seg of entry.segments) {
        insertSegment.run(row.id, normalizeSuperscripts(seg.chapter_title), seg.start_s, seg.end_s, seg.transcript, seg.sort_order);
      }
    })();

    imported++;
  }

  return { imported, skipped, knownBadSkipped };
}

/**
 * Load the known-bad map from a JSON file ({id: reason}).
 * Returns an empty Set if the file doesn't exist or can't be parsed.
 * Keys starting with "_" are treated as metadata/comments and ignored.
 */
export function loadKnownBad(jsonPath: string): Set<string> {
  if (!existsSync(jsonPath)) return new Set();
  try {
    const obj = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, string>;
    return new Set(Object.keys(obj).filter((k) => !k.startsWith("_")));
  } catch {
    console.warn(`  ⚠ could not parse known-bad file: ${jsonPath}`);
    return new Set();
  }
}

/**
 * Find the most recent transcripts/YYYY-MM-DD/videos.ndjson under the project root.
 * Returns null if none found.
 */
export function findLatestCache(projectRoot: string): string | null {
  const transcriptsDir = join(projectRoot, "transcripts");
  if (!existsSync(transcriptsDir)) return null;

  const dirs = readdirSync(transcriptsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse(); // newest first

  for (const dir of dirs) {
    const candidate = join(transcriptsDir, dir, "videos.ndjson");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Main ──

async function main() {
  // ── Fast path: --from-cache ──
  if (FROM_CACHE) {
    initDb();
    const projectRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const knownBadPath = KNOWN_BAD_PATH ?? join(projectRoot, "transcripts", "known-bad.json");
    const knownBad = loadKnownBad(knownBadPath);
    const cachePath = findLatestCache(projectRoot);
    if (!cachePath) {
      console.error("No cache found. Run `make save-videos-cache` after a local extraction.");
      process.exit(1);
    }
    console.log(`Importing from cache: ${cachePath}`);
    if (knownBad.size > 0) console.log(`  Skipping ${knownBad.size} known-bad IDs`);
    const result = importCache(cachePath, { force: FORCE, knownBad });
    console.log(`Done: ${result.imported} imported, ${result.skipped} skipped (already present), ${result.knownBadSkipped} known-bad`);
    return;
  }

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

  // Load known-bad list and filter those out too
  const projectRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const knownBadPath = KNOWN_BAD_PATH ?? join(projectRoot, "transcripts", "known-bad.json");
  const knownBad = loadKnownBad(knownBadPath);
  if (knownBad.size > 0) console.log(`Loaded ${knownBad.size} known-bad video IDs from ${knownBadPath}`);

  const afterKnownBad = filtered.filter((v) => !knownBad.has(v.id));
  console.log(`\nPlaylist: ${listed.length} total → ${filtered.length} after filter (duration ${MIN_DURATION}–${MAX_DURATION}s, no MUM)${knownBad.size > 0 ? ` → ${afterKnownBad.length} after known-bad` : ""}`);

  // Apply limit for dev
  const toProcess = LIMIT !== undefined ? afterKnownBad.slice(0, LIMIT) : afterKnownBad;

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
        normalizeSuperscripts(info.title),
        normalizeSuperscripts(info.description ?? null),
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
          normalizeSuperscripts(seg.chapter_title),
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

  // Write NDJSON cache if requested (--save-cache)
  if (SAVE_CACHE) {
    const date = new Date().toISOString().slice(0, 10);
    const outPath = join(projectRoot, "transcripts", date, "videos.ndjson");
    const count = saveCache(outPath);
    console.log(`\nCache written: ${outPath} (${count} videos)`);
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
