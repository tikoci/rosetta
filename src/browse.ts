#!/usr/bin/env bun
/**
 * browse.ts — Interactive terminal browser for RouterOS documentation.
 *
 * Card-catalog REPL: search → numbered results → select to drill in → hints lead to next query.
 * Wraps all query functions from query.ts — no new SQL, purely a presentation layer.
 *
 * Usage:
 *   bun run src/browse.ts                     Interactive mode
 *   bun run src/browse.ts "firewall filter"   Search then interactive
 *   bun run src/browse.ts --once "dhcp"       Search, print, exit (for piping)
 */

import * as readline from "node:readline";
import { db, getDbStats, initDb } from "./db.ts";
import { MCP_INSTRUCTIONS, MCP_STATIC_RESOURCES } from "./mcp-meta.ts";
import { resolveVersion } from "./paths.ts";
import type {
  CalloutResult,
  ChangelogResult,
  DeviceResult,
  DeviceTestRow,
  DudeSearchResult,
  GlossaryEntry,
  SearchAllResponse,
  SearchResult,
  SectionTocEntry,
  VideoSearchResult,
} from "./query.ts";
import {
  browseCommands,
  browseCommandsAtVersion,
  checkCommandVersions,
  diffCommandVersions,
  fetchCurrentVersions,
  getDudePage,
  getPage,
  getPageCallouts,
  getSkill,
  getTestResultMeta,
  listGlossary,
  listSkills,
  lookupGlossary,
  lookupProperty,
  searchAll,
  searchCallouts,
  searchChangelogs,
  searchDevices,
  searchDeviceTests,
  searchDude,
  searchProperties,
  searchVideos,
} from "./query.ts";

// ── ANSI utilities (zero deps) ──

const ESC = "\x1b";
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
const _italic = (s: string) => `${ESC}[3m${s}${ESC}[0m`;
const _underline = (s: string) => `${ESC}[4m${s}${ESC}[0m`;
const cyan = (s: string) => `${ESC}[36m${s}${ESC}[0m`;
const yellow = (s: string) => `${ESC}[33m${s}${ESC}[0m`;
const green = (s: string) => `${ESC}[32m${s}${ESC}[0m`;
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;
const magenta = (s: string) => `${ESC}[35m${s}${ESC}[0m`;
const blue = (s: string) => `${ESC}[34m${s}${ESC}[0m`;
const _bgDim = (s: string) => `${ESC}[48;5;236m${s}${ESC}[0m`;

/** OSC 8 clickable hyperlink (iTerm2, macOS Terminal, Windows Terminal, etc.) */
function link(url: string, display?: string): string {
  return `${ESC}]8;;${url}\x07${display ?? url}${ESC}]8;;\x07`;
}

/**
 * Lightweight Markdown → ANSI renderer for text we render in the TUI.
 * Handles **bold**, *italic*, `code`, headings (#/##/###), [text](url), and
 * bullet lists. Skips fenced code blocks (``` ... ```) — they're left as
 * indented dim text so RouterOS CLI snippets stay readable.
 *
 * Not a full Markdown parser. Designed to clean up content stored as Markdown
 * (skill files, callout text) so the source markup tokens don't leak into
 * the rendered output. See BACKLOG "TUI usability improvements".
 */
function mdToAnsi(s: string): string {
  if (!s) return s;
  const lines = s.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(dim(raw.replace(/```\w*/, "```")));
      continue;
    }
    if (inFence) {
      out.push(dim(`  ${raw}`));
      continue;
    }
    // Headings
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      // Insert a blank line before headings (unless one already precedes
      // them) so `══ Summary` doesn't glue onto the previous paragraph.
      if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
      if (level === 1) out.push(bold(`══ ${text}`));
      else if (level === 2) out.push(bold(`── ${text}`));
      else out.push(bold(text));
      out.push("");
      continue;
    }
    // Bullets
    raw = raw.replace(/^(\s*)[-*]\s+/, (_m, sp) => `${sp}${cyan("•")} `);
    // Inline: links, code, bold, italic — order matters.
    raw = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, url) => link(url, cyan(txt)));
    raw = raw.replace(/`([^`]+)`/g, (_m, code) => `${ESC}[48;5;236m ${code} ${ESC}[0m`);
    raw = raw.replace(/\*\*([^*]+)\*\*/g, (_m, t) => bold(t));
    raw = raw.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, t) => `${pre}${ESC}[3m${t}${ESC}[0m`);
    out.push(raw);
  }
  return out.join("\n");
}

/** Terminal width, with fallback */
function termWidth(): number {
  return process.stdout.columns || 80;
}

/** Terminal height, with fallback */
function termHeight(): number {
  return process.stdout.rows || 24;
}

/** Truncate string to width, adding … if needed */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Right-pad to width */
function pad(s: string, w: number): string {
  const visible = stripAnsi(s);
  return visible.length >= w ? s : s + " ".repeat(w - visible.length);
}

/** Strip ANSI escape codes for length calculation */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code matching requires \x1b and \x07
  return s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Format number with comma separators */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Draw a box with unicode box-drawing characters */
function box(lines: string[], title?: string): string {
  const w = termWidth();
  const inner = w - 4;
  const top = title
    ? `╭─ ${bold(title)} ${"─".repeat(Math.max(0, inner - stripAnsi(title).length - 2))}╮`
    : `╭${"─".repeat(w - 2)}╮`;
  const bottom = `╰${"─".repeat(w - 2)}╯`;
  const body = lines.map((l) => {
    const visible = stripAnsi(l);
    const padding = Math.max(0, inner - visible.length);
    return `│ ${l}${" ".repeat(padding)} │`;
  });
  return [top, ...body, bottom].join("\n");
}

/** Format a horizontal rule */
function hr(): string {
  return dim("─".repeat(termWidth()));
}

/** Callout type icon + color */
function calloutPrefix(type: string): string {
  switch (type.toLowerCase()) {
    case "warning": return yellow("⚠ Warning:");
    case "note": return blue("📝 Note:");
    case "info": return cyan("ℹ Info:");
    case "tip": return green("✓ Tip:");
    default: return dim(`[${type}]`);
  }
}

/** Format seconds as HH:MM:SS or MM:SS */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Pager ──

/** Output lines with paging. Returns true if user quit early. */
/**
 * Interactive pager.
 *
 * Keys:
 *   SPACE / f   advance one page
 *   ENTER / j   advance one line
 *   b / <       previous page
 *   g           jump to top
 *   G           jump to bottom
 *   q           quit pager (returns true)
 *
 * Shows a status line with page X/Y and line N/M. Returns true if user quit
 * before EOF, false otherwise.
 */
async function paged(output: string): Promise<boolean> {
  const lines = output.split("\n");
  const pageSize = Math.max(5, termHeight() - 2);
  if (lines.length <= pageSize || !process.stdout.isTTY) {
    process.stdout.write(`${output}\n`);
    return false;
  }
  const totalPages = Math.ceil(lines.length / pageSize);
  let offset = 0;
  while (offset < lines.length) {
    const chunk = lines.slice(offset, offset + pageSize);
    process.stdout.write(`${chunk.join("\n")}\n`);
    const newOffset = offset + pageSize;
    if (newOffset >= lines.length) return false;
    const curPage = Math.floor(newOffset / pageSize);
    const prompt = dim(
      `── page ${curPage}/${totalPages}  line ${newOffset}/${lines.length}  [SPACE next | ENTER line | b back | 1-${Math.min(9, totalPages)} jump | g/G top/end | q quit]`,
    );
    process.stdout.write(prompt);
    const key = await waitForKey();
    process.stdout.write(`\r${" ".repeat(Math.min(termWidth(), stripAnsi(prompt).length))}\r`);
    if (key === "q" || key === "Q") return true;
    if (key === "g") { offset = 0; continue; }
    if (key === "G") { offset = Math.max(0, lines.length - pageSize); continue; }
    if (key === "b" || key === "<" || key === "\x1b[D") {
      offset = Math.max(0, offset - pageSize);
      continue;
    }
    if (key === "\r" || key === "\n" || key === "j" || key === "\x1b[B") {
      offset += 1;
      continue;
    }
    // Digit 1-9 jumps to that page (1-indexed). If the page is past EOF,
    // clamp to the last page.
    if (/^[1-9]$/.test(key)) {
      const target = Number.parseInt(key, 10);
      offset = Math.min(lines.length - pageSize, (target - 1) * pageSize);
      if (offset < 0) offset = 0;
      continue;
    }
    // SPACE / f / anything else → next page
    offset = newOffset;
  }
  return false;
}

function waitForKey(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve("\n"); return; }
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.setRawMode(wasRaw ?? false);
      const ch = data.toString();
      // Ctrl-C / Ctrl-D
      if (ch === "\x03" || ch === "\x04") { process.exit(0); }
      resolve(ch);
    });
  });
}

// ── REPL State ──

type Context =
  | { type: "home" }
  | { type: "search"; response: SearchAllResponse; results: SearchResult[] }
  | { type: "page"; pageId: number; title: string; commandPath?: string }
  | { type: "sections"; pageId: number; title: string; sections: SectionTocEntry[] }
  | { type: "commands"; path: string }
  | { type: "devices"; query: string; results: DeviceResult[] }
  | { type: "device"; device: DeviceResult }
  | { type: "tests" }
  | { type: "callouts"; query: string; results: CalloutResult[] }
  | { type: "changelogs"; results: ChangelogResult[] }
  | { type: "videos"; query: string; results: VideoSearchResult[] }
  | { type: "dude"; query: string; results: DudeSearchResult[] }
  | { type: "skills" }
  | { type: "properties"; query: string; pageId?: number; results: Array<{ name: string; page_id: number; page_title: string }> }
  | { type: "diff" }
  | { type: "vcheck"; path: string };

let ctx: Context = { type: "home" };
const history: Context[] = [];

function pushCtx(next: Context) {
  history.push(ctx);
  ctx = next;
}

function popCtx(): boolean {
  const prev = history.pop();
  if (prev) { ctx = prev; return true; }
  return false;
}

/** Build a context-aware prompt string, mirroring RouterOS [admin@router]> style. */
function buildPrompt(): string {
  const label = contextLabel(ctx);
  if (label) return `${cyan("rosetta")}${dim("[")}${label}${dim("]>")} `;
  return `${cyan("rosetta")}${dim(">")} `;
}

function contextLabel(c: Context): string {
  switch (c.type) {
    case "home": return "";
    case "search": return truncate(`search: "${c.response.query}"`, 30);
    case "page": return truncate(c.title, 30);
    case "sections": return truncate(`${c.title} §`, 30);
    case "properties": return truncate(`prop: "${c.query}"`, 30);
    case "commands": return truncate(`cmd: ${c.path || "/"}`, 30);
    case "devices": return truncate(`dev: "${c.query}"`, 30);
    case "device": return truncate(c.device.product_name, 30);
    case "tests": return "tests";
    case "callouts": return c.query ? truncate(`cal: "${c.query}"`, 30) : "callouts";
    case "changelogs": return "changelogs";
    case "videos": return truncate(`vid: "${c.query}"`, 30);
    case "dude": return truncate(`dude: "${c.query}"`, 30);
    case "skills": return "skills";
    case "diff": return "diff";
    case "vcheck": return truncate(`vc: ${c.path}`, 30);
  }
}

// ── Renderers ──

function renderWelcome(): string {
  const stats = getDbStats();
  const version = resolveVersion(import.meta.dirname);
  const dbWarning = stats.commands < 1000
    ? yellow(`⚠ DB has only ${fmt(stats.commands)} commands — use real DB:  --db ~/.rosetta/ros-help.db`)
    : null;
  const lines = [
    `RouterOS Documentation Browser  ${dim(`v${version}`)}`,
    `${fmt(stats.pages)} pages · ${fmt(stats.properties)} properties · ${fmt(stats.commands)} commands`,
    `${fmt(stats.devices)} devices · ${fmt(stats.callouts)} callouts · ${fmt(stats.ros_versions)} versions`,
    ...(stats.videos > 0 ? [`${fmt(stats.videos)} videos · ${fmt(stats.video_segments)} transcript segments`] : []),
    ...(stats.skills > 0 ? [`${fmt(stats.skills)} agent skills ${dim("(tikoci — community content)")}`] : []),
    "",
    ...(dbWarning ? [dbWarning, ""] : []),
    `Type a search query, command, or ${bold("help")} for full list.`,
  ];
  return box(lines, "rosetta");
}

function renderSearchResults(resp: SearchAllResponse): string {
  const out: string[] = [];
  const modeNote = resp.fallback_mode === "or" ? dim(" (OR fallback)") : "";
  out.push(`  ${bold(String(resp.pages.length))} of ${resp.total_pages} page results for ${cyan(`"${resp.query}"`)}${modeNote}`);

  // Classifier signals — compact one-line summary when anything fired
  const classLine = renderClassified(resp.classified);
  if (classLine) out.push(`  ${dim("classified:")} ${classLine}`);
  if (resp.note) {
    out.push(`  ${yellow("Hint:")} ${resp.note}`);
  }
  out.push("");

  const w = termWidth();
  for (let i = 0; i < resp.pages.length; i++) {
    const r = resp.pages[i];
    const num = dim(`${String(i + 1).padStart(3)}  `);
    const title = bold(truncate(r.title, 30));
    const path = dim(truncate(r.path, Math.max(20, w - 55)));
    const meta = dim(`${fmt(r.word_count)}w`);
    out.push(`${num}${pad(title, 32)} ${pad(path, Math.max(20, w - 55))} ${meta}`);
    if (r.url) {
      out.push(`       ${cyan(link(r.url, dim(r.url)))}`);
    }
    // Show best matching section if available
    if (r.best_section) {
      out.push(`       ${dim("§")} ${r.best_section.heading}`);
    }
    // Show excerpt with highlight markers converted to bold
    const excerpt = r.excerpt.replace(/>>>/g, `${ESC}[1m`).replace(/<<</g, `${ESC}[0m`);
    out.push(`       ${dim(truncate(excerpt, w - 8))}`);
    out.push("");
  }

  // Related block — compact summary of side-query hits
  const related = renderRelated(resp.related, w);
  if (related.length > 0) {
    out.push(`  ${bold("related")}`);
    out.push(...related);
    out.push("");
  }

  // Next-steps block — always render the top 3 suggestions
  if (resp.next_steps.length > 0) {
    out.push(`  ${bold("next")}`);
    for (const step of resp.next_steps.slice(0, 3)) {
      out.push(`       ${dim("→")} ${step}`);
    }
    out.push("");
  }

  // Navigation hints
  const hints = [
    `${cyan("[N]")} view page`,
    `${cyan("[s <query>]")} search`,
    `${cyan("[p <query>]")} properties`,
    `${cyan("[cmd <path>]")} commands`,
  ];
  out.push(`  ${hints.join("  ")}`);
  return out.join("\n");
}

/** One-line summary of classifier output — empty string if nothing fired. */
function renderClassified(c: SearchAllResponse["classified"]): string {
  const parts: string[] = [];
  if (c.command_path) parts.push(`path=${cyan(c.command_path)}`);
  if (c.version) parts.push(`version=${magenta(c.version)}`);
  if (c.device) parts.push(`device=${yellow(c.device)}`);
  if (c.property) parts.push(`property=${green(c.property)}`);
  if (c.topics.length > 0) parts.push(`topics=[${c.topics.join(",")}]`);
  if (c.command_fragment) {
    if (c.command_fragment.verbs.length > 0) parts.push(`verbs=[${c.command_fragment.verbs.join(",")}]`);
    if (c.command_fragment.pairs.length > 0) {
      const pairs = c.command_fragment.pairs.map((p) => `${p.key}=${p.value}`).join(" ");
      parts.push(`args={${pairs}}`);
    }
  }
  return parts.join("  ");
}

/** Render related sections as one line each. */
function renderRelated(related: SearchAllResponse["related"], w: number): string[] {
  const out: string[] = [];
  if (related.command_node) {
    const n = related.command_node;
    const link = n.linked_page ? ` → page #${n.linked_page.id} "${n.linked_page.title}"` : "";
    out.push(`       ${dim("cmd")}  ${cyan(n.path)} (${n.type})${link}`);
  }
  if (related.commands?.length) {
    const names = related.commands.map((c) => c.name).join(", ");
    out.push(`       ${dim("children")}  ${truncate(names, w - 16)}`);
  }
  if (related.properties?.length) {
    const props = related.properties.map((p) => p.name).join(", ");
    out.push(`       ${dim("props")}  ${truncate(props, w - 14)}`);
  }
  if (related.devices?.length) {
    const devs = related.devices.map((d) => d.product_name).join(", ");
    out.push(`       ${dim("devices")}  ${truncate(devs, w - 16)}`);
  }
  if (related.changelogs?.length) {
    const first = related.changelogs[0];
    out.push(`       ${dim("changelog")}  ${first.version} ${first.category}: ${truncate(first.description, w - 40)}`);
  }
  if (related.videos?.length) {
    const v = related.videos[0];
    out.push(`       ${dim("video")}  ${truncate(v.title, w - 14)}`);
  }
  if (related.callouts?.length) {
    const c = related.callouts[0];
    out.push(`       ${dim("callout")}  ${c.type}: ${truncate(c.excerpt, w - 20)}`);
  }
  if (related.skills?.length) {
    out.push(`       ${dim("skill")}  ${related.skills[0].name}`);
  }
  return out;
}

function renderPage(page: NonNullable<ReturnType<typeof getPage>>): string {
  const out: string[] = [];
  const w = termWidth();

  out.push("");
  out.push(`  ${bold("══")} ${bold(page.title)} ${bold("═".repeat(Math.max(0, w - stripAnsi(page.title).length - 8)))}`);
  out.push(`  ${dim(page.path)}`);
  out.push(`  ${cyan(link(page.url))}`);

  const meta: string[] = [`${fmt(page.word_count)} words`];
  if (page.code_lines) meta.push(`${page.code_lines} code lines`);
  if (page.callouts.length > 0) {
    const types: Record<string, number> = {};
    for (const c of page.callouts) types[c.type] = (types[c.type] || 0) + 1;
    const parts = Object.entries(types).map(([t, n]) => {
      const icon = t === "Warning" ? "⚠" : t === "Note" ? "📝" : t === "Info" ? "ℹ" : "✓";
      return `${n}${icon}`;
    });
    meta.push(`${page.callouts.length} callouts (${parts.join(" ")})`);
  }
  out.push(`  ${dim(meta.join(" · "))}`);
  out.push("");

  // Sections TOC (if available)
  if (page.sections && page.sections.length > 0) {
    out.push(`  ${bold("Sections:")}`);
    for (let i = 0; i < page.sections.length; i++) {
      const s = page.sections[i];
      const indent = "  ".repeat(Math.max(0, s.level - 1));
      const num = dim(`${String(i + 1).padStart(3)}  `);
      const chars = dim(`(${fmt(s.char_count)} chars)`);
      out.push(`  ${num}${indent}${s.heading}  ${chars}`);
    }
    out.push("");
    if (page.note) out.push(`  ${dim(page.note)}`);
  }

  // Callout summary or full callouts
  if (page.callout_summary) {
    const cs = page.callout_summary;
    const typeParts = Object.entries(cs.types).map(([t, n]) => `${n} ${t}`).join(", ");
    out.push(`  ${dim(`Callouts: ${cs.count} total (${typeParts}) — view with`)} ${cyan("cal")}`);
    out.push("");
  } else if (page.callouts.length > 0) {
    for (const c of page.callouts) {
      const prefix = calloutPrefix(c.type);
      const content = truncate(c.content, w - 6);
      out.push(`  ${prefix} ${content}`);
    }
    out.push("");
  }

  // Text content (if present and not a TOC-only view)
  if (page.text && !page.sections) {
    out.push(hr());
    out.push(mdToAnsi(page.text));
    if (page.code) {
      out.push("");
      out.push(dim("── code ──"));
      out.push(page.code.split("\n").map((l) => `  ${l}`).join("\n"));
    }
  }

  if (page.truncated) {
    out.push("");
    out.push(dim(`  [truncated: ${fmt(page.truncated.text_total)} text chars, ${fmt(page.truncated.code_total)} code chars]`));
  }

  // Section content (when section was requested)
  if (page.section) {
    out.push(hr());
    out.push(`  ${bold(`§ ${page.section.heading}`)}  ${dim(`(level ${page.section.level})`)}`);
    out.push("");
    if (page.text) out.push(mdToAnsi(page.text));
    if (page.code) {
      out.push("");
      out.push(dim("── code ──"));
      out.push(page.code.split("\n").map((l) => `  ${l}`).join("\n"));
    }
  }

  // Navigation hints
  out.push("");
  const hints: string[] = [];
  if (page.sections && page.sections.length > 0) hints.push(`${cyan("[N]")} section`);
  hints.push(`${cyan("[p]")} properties`);
  hints.push(`${cyan("[cmd]")} command tree`);
  hints.push(`${cyan("[cal]")} callouts`);
  hints.push(`${cyan("[b]")} back`);
  out.push(`  ${hints.join("  ")}`);

  return out.join("\n");
}

function renderProperties(results: Array<{
  name: string;
  type: string | null;
  default_val: string | null;
  description: string;
  section: string | null;
  page_title: string;
  page_url: string;
  excerpt?: string;
}>): string {
  const out: string[] = [];
  if (results.length === 0) {
    out.push(`  ${dim("No properties found.")}`);
    return out.join("\n");
  }
  const w = termWidth();

  for (let i = 0; i < results.length; i++) {
    const p = results[i];
    const num = dim(`${String(i + 1).padStart(3)}  `);
    out.push(`${num}${bold(p.name)}  ${dim(p.type ?? "")}  ${p.default_val ? dim(`default: ${p.default_val}`) : ""}`);
    const desc = truncate(p.description, w - 8);
    out.push(`       ${desc}`);
    out.push(`       ${dim(p.page_title)}  ${cyan(link(p.page_url, dim("→")))}`);
    out.push("");
  }
  return out.join("\n");
}

function renderCommandTree(path: string, children: Array<{
  path: string;
  name: string;
  type: string;
  description: string | null;
  page_title: string | null;
  page_url: string | null;
  dir_role?: string | null;
  data_type?: string | null;
  enum_values?: string | null;
  _arch?: string | null;
  completion?: Record<string, { style?: string; preference?: number; desc?: string }> | null;
}>): string {
  const out: string[] = [];
  out.push(`  ${bold(path || "/")}  ${dim(`(${children.length} children)`)}`);
  out.push("");

  const dirs = children.filter((c) => c.type === "dir");
  const cmds = children.filter((c) => c.type === "cmd");
  const args = children.filter((c) => c.type === "arg");

  let globalIdx = 0;
  for (const group of [
    { items: dirs, icon: "📁" },
    { items: cmds, icon: "⚡" },
    { items: args, icon: dim("·") },
  ]) {
    if (group.items.length === 0) continue;
    for (let i = 0; i < group.items.length; i++) {
      const c = group.items[i];
      globalIdx++;
      const num = dim(`${String(globalIdx).padStart(3)}  `);
      const icon = group.icon;
      const name = c.type === "dir" ? bold(c.name) : c.name;

      // Build type hint: enum values, data_type, or completion-derived values
      let typeHint = "";
      if (c.data_type === "enum" && c.enum_values) {
        try {
          const vals = JSON.parse(c.enum_values) as string[];
          const shown = vals.length > 6 ? `${vals.slice(0, 6).join("|")}|…` : vals.join("|");
          typeHint = shown;
        } catch {
          typeHint = `<${c.data_type}>`;
        }
      } else if (c.data_type === "time" || c.data_type === "integer" || c.data_type === "range") {
        // Already visible via description range — just tag the type
        typeHint = `<${c.data_type}>`;
      } else if (c.data_type) {
        typeHint = `<${c.data_type}>`;
      } else if (c.completion && Object.keys(c.completion).length > 0) {
        // No parsed data_type but completion values exist — surface them
        const keys = Object.keys(c.completion).filter((k) => k !== "");
        if (keys.length > 0) {
          const shown = keys.length > 6 ? `${keys.slice(0, 6).join("|")}|…` : keys.join("|");
          typeHint = shown;
        }
      }

      const parts: string[] = [];
      if (c.description) parts.push(truncate(c.description, 40));
      if (typeHint) parts.push(typeHint);
      if (c.dir_role && c.dir_role !== "namespace") parts.push(`[${c.dir_role}]`);
      const desc = parts.length > 0 ? dim(` — ${parts.join("  ")}`) : "";
      const archTag = c._arch ? yellow(` [${c._arch}]`) : "";
      const pageLink = c.page_url ? `  ${cyan(link(c.page_url, dim("📄")))}` : "";
      out.push(`  ${num}${icon} ${name}${desc}${archTag}${pageLink}`);
    }
    out.push("");
  }

  const hints: string[] = [
    `${cyan("[N]")} select`,
    `${cyan("[cmd <child>]")} drill down`,
    `${cyan("[page <id>]")} view linked page`,
    `${cyan("[b]")} back`,
  ];
  out.push(`  ${hints.join("  ")}`);
  return out.join("\n");
}

function renderDeviceResults(results: DeviceResult[], mode: string, total: number): string {
  const out: string[] = [];
  out.push(`  ${bold(String(results.length))} of ${total} devices ${dim(`(${mode})`)}`);
  out.push("");

  if (results.length === 1) {
    return out.join("\n") + renderDeviceCard(results[0]);
  }

  for (let i = 0; i < results.length; i++) {
    const d = results[i];
    const num = dim(`${String(i + 1).padStart(3)}  `);
    const name = bold(d.product_name);
    const arch = dim(d.architecture ?? "");
    const ram = d.ram_mb ? dim(`${d.ram_mb}MB`) : "";
    const price = d.msrp_usd ? green(`$${d.msrp_usd}`) : "";
    out.push(`${num}${name}  ${arch}  ${ram}  ${price}`);
    const parts: string[] = [];
    if (d.cpu) parts.push(d.cpu);
    if (d.eth_gigabit) parts.push(`${d.eth_gigabit}×GbE`);
    if (d.sfp_plus_ports) parts.push(`${d.sfp_plus_ports}×SFP+`);
    if (d.wireless_5_chains) parts.push(`Wi-Fi`);
    if (parts.length > 0) out.push(`       ${dim(parts.join(" · "))}`);
    out.push("");
  }

  out.push(`  ${cyan("[N]")} view device  ${cyan("[tests]")} benchmarks  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderDeviceCard(d: DeviceResult): string {
  const out: string[] = [];
  out.push(`  ${bold("══")} ${bold(d.product_name)} ${bold("══")}`);
  if (d.product_code) out.push(`  ${dim(`Code: ${d.product_code}`)}`);
  if (d.product_url) out.push(`  ${cyan(link(d.product_url))}`);
  out.push("");

  const kv = (label: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined) return;
    out.push(`  ${dim(pad(label, 20))} ${value}`);
  };

  kv("Architecture", d.architecture);
  kv("CPU", d.cpu);
  if (d.cpu_cores) kv("Cores / Freq", `${d.cpu_cores} × ${d.cpu_frequency ?? "?"}`);
  kv("License Level", d.license_level);
  kv("RAM", d.ram ? `${d.ram} (${d.ram_mb}MB)` : null);
  kv("Storage", d.storage ? `${d.storage} (${d.storage_mb}MB)` : null);
  if (d.eth_fast || d.eth_gigabit || d.eth_2500) {
    const ports: string[] = [];
    if (d.eth_fast) ports.push(`${d.eth_fast}×100M`);
    if (d.eth_gigabit) ports.push(`${d.eth_gigabit}×1G`);
    if (d.eth_2500) ports.push(`${d.eth_2500}×2.5G`);
    kv("Ethernet", ports.join(" + "));
  }
  if (d.sfp_ports || d.sfp_plus_ports) {
    const sfp: string[] = [];
    if (d.sfp_ports) sfp.push(`${d.sfp_ports}×SFP`);
    if (d.sfp_plus_ports) sfp.push(`${d.sfp_plus_ports}×SFP+`);
    kv("SFP", sfp.join(" + "));
  }
  kv("PoE In", d.poe_in);
  kv("PoE Out", d.poe_out);
  kv("Max Power", d.max_power_w ? `${d.max_power_w}W` : null);
  if (d.wireless_24_chains || d.wireless_5_chains) {
    kv("Wireless", `2.4GHz: ${d.wireless_24_chains ?? 0} chains, 5GHz: ${d.wireless_5_chains ?? 0} chains`);
  }
  if (d.usb_ports) kv("USB", d.usb_ports);
  if (d.sim_slots) kv("SIM Slots", d.sim_slots);
  if (d.msrp_usd) kv("MSRP", green(`$${d.msrp_usd}`));
  if (d.block_diagram_url) {
    out.push("");
    out.push(`  ${dim("Block diagram:")} ${cyan(link(d.block_diagram_url, "view"))}`);
  }

  // Test results (attached for exact matches)
  if (d.test_results && d.test_results.length > 0) {
    out.push("");
    out.push(`  ${bold("Benchmarks:")}  ${dim(`(${d.test_results.length} tests)`)}`);
    for (const t of d.test_results.slice(0, 12)) {
      const mbps = t.throughput_mbps ? `${fmt(t.throughput_mbps)} Mbps` : "";
      const kpps = t.throughput_kpps ? `${fmt(t.throughput_kpps)} Kpps` : "";
      out.push(`    ${dim(pad(t.test_type, 9))} ${pad(t.mode, 16)} ${dim(pad(t.configuration, 28))} ${pad(`${t.packet_size}B`, 6)} ${bold(mbps)} ${dim(kpps)}`);
    }
    if (d.test_results.length > 12) {
      out.push(`    ${dim(`... and ${d.test_results.length - 12} more (use`)} ${cyan("tests")} ${dim("for full listing)")}`);
    }
  }

  out.push("");
  out.push(`  ${cyan("[tests]")} benchmarks  ${cyan("[s <query>]")} search docs  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderTests(results: DeviceTestRow[], total: number): string {
  const out: string[] = [];
  out.push(`  ${bold(String(results.length))} of ${total} test results`);
  out.push("");

  // Header
  out.push(`  ${dim(pad("Device", 24))} ${dim(pad("Type", 9))} ${dim(pad("Mode", 16))} ${dim(pad("Config", 28))} ${dim(pad("Pkt", 6))} ${dim(pad("Mbps", 10))} ${dim("Kpps")}`);
  out.push(`  ${dim("─".repeat(Math.min(termWidth() - 4, 105)))}`);

  for (const t of results) {
    const mbps = t.throughput_mbps != null ? fmt(t.throughput_mbps) : "—";
    const kpps = t.throughput_kpps != null ? fmt(t.throughput_kpps) : "—";
    out.push(`  ${pad(truncate(t.product_name, 24), 24)} ${dim(pad(t.test_type, 9))} ${pad(t.mode, 16)} ${dim(pad(truncate(t.configuration, 28), 28))} ${pad(`${t.packet_size}B`, 6)} ${bold(pad(mbps, 10))} ${dim(kpps)}`);
  }

  if (total > results.length) {
    out.push(`  ${dim(`... ${total - results.length} more results`)}`);
  }

  out.push("");
  out.push(`  ${cyan("[dev <name>]")} device details  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderCallouts(results: Array<{
  type: string;
  content: string;
  page_title: string;
  page_url: string;
  page_id: number;
  excerpt: string;
}>): string {
  const out: string[] = [];
  if (results.length === 0) {
    out.push(`  ${dim("No callouts found.")}`);
    return out.join("\n");
  }
  const w = termWidth();

  for (let i = 0; i < results.length; i++) {
    const c = results[i];
    const num = dim(`${String(i + 1).padStart(3)}  `);
    const prefix = calloutPrefix(c.type);
    // Use excerpt if it has highlights, otherwise truncate content
    const text = c.excerpt.includes("**")
      ? c.excerpt.replace(/\*\*/g, `${ESC}[1m`)
      : truncate(c.content, w - 12);
    out.push(`${num}${prefix}`);
    out.push(`       ${text}`);
    out.push(`       ${dim(c.page_title)} ${cyan(link(c.page_url, dim(`[${c.page_id}]`)))}`);
    out.push("");
  }

  out.push(`  ${cyan("[page <id>]")} view page  ${cyan("[s <query>]")} search  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderChangelogs(results: ChangelogResult[]): string {
  const out: string[] = [];
  if (results.length === 0) {
    out.push(`  ${dim("No changelog entries found.")}`);
    return out.join("\n");
  }

  let lastVersion = "";
  for (let i = 0; i < results.length; i++) {
    const c = results[i];
    if (c.version !== lastVersion) {
      out.push("");
      out.push(`  ${bold(c.version)}  ${dim(c.released ?? "")}`);
      lastVersion = c.version;
    }
    const num = dim(`${String(i + 1).padStart(3)}  `);
    const breaking = c.is_breaking ? red("⚠ ") : "";
    const cat = dim(pad(c.category, 14));
    const desc = c.excerpt.includes("**")
      ? c.excerpt.replace(/\*\*/g, `${ESC}[1m`)
      : truncate(c.description, termWidth() - 26);
    out.push(`${num}${breaking}${cat} ${desc}`);
  }

  out.push("");
  out.push(`  ${cyan("[cl breaking]")} breaking only  ${cyan("[cl <ver>]")} specific version  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderVideos(results: VideoSearchResult[]): string {
  const out: string[] = [];
  if (results.length === 0) {
    out.push(`  ${dim("No video results found.")}`);
    return out.join("\n");
  }

  for (let i = 0; i < results.length; i++) {
    const v = results[i];
    const num = dim(`${String(i + 1).padStart(3)}  `);
    const title = bold(truncate(v.title, 60));
    const date = v.upload_date ? dim(v.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")) : "";
    out.push(`${num}${title}  ${date}`);
    if (v.chapter_title) {
      const ts = formatTime(v.start_s);
      out.push(`       ${magenta(`§ ${v.chapter_title}`)}  ${dim(`@ ${ts}`)}`);
    }
    const timeUrl = v.start_s > 0 ? `${v.url}&t=${v.start_s}` : v.url;
    out.push(`       ${cyan(link(timeUrl))}`);
    const excerpt = v.excerpt.replace(/\*\*/g, `${ESC}[1m`);
    out.push(`       ${dim(truncate(excerpt, termWidth() - 8))}`);
    out.push("");
  }

  out.push(`  ${cyan("[s <query>]")} search docs  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderDudeResults(results: DudeSearchResult[]): string {
  const out: string[] = [];
  if (results.length === 0) {
    out.push(`  ${dim("No Dude wiki results found.")}`);
    return out.join("\n");
  }

  for (let i = 0; i < results.length; i++) {
    const d = results[i];
    const num = dim(`${String(i + 1).padStart(3)}  `);
    const title = bold(truncate(d.title, 60));
    const ver = dim(`[${d.version}]`);
    const imgs = d.image_count > 0 ? dim(`📷 ${d.image_count}`) : "";
    out.push(`${num}${title}  ${ver}  ${imgs}`);
    out.push(`       ${dim(d.path)}`);
    const excerpt = d.excerpt.replace(/\*\*/g, `${ESC}[1m`);
    out.push(`       ${dim(truncate(excerpt, termWidth() - 8))}`);
    out.push("");
  }

  out.push(`  ${cyan("[<n>]")} view page  ${cyan("[s <query>]")} search docs  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderDudePage(page: import("./query.ts").DudePageResult): string {
  const out: string[] = [];
  out.push(`  ${bold(page.title)}  ${dim(`[${page.version}]`)}`);
  out.push(`  ${dim(page.path)}`);
  out.push(`  ${cyan(link(page.url))}`);
  if (page.wayback_url) out.push(`  ${dim(`Archived: ${page.wayback_url}`)}`);
  out.push("");

  if (page.images.length > 0) {
    out.push(`  ${bold("Screenshots:")} ${page.images.length}`);
    for (const img of page.images) {
      out.push(`    ${dim("•")} ${img.filename}${img.caption ? `  ${dim(img.caption)}` : ""}`);
      out.push(`      ${dim(img.local_path)}`);
    }
    out.push("");
  }

  // Truncate long pages for TUI display
  const maxChars = 8000;
  const text = page.text.length > maxChars
    ? `${page.text.slice(0, maxChars)}\n\n  ${dim(`... truncated (${page.text.length} chars total)`)}`
    : page.text;
  out.push(text);

  if (page.code) {
    out.push("");
    out.push(`  ${bold("Code:")}`);
    out.push(page.code.length > 2000 ? `${page.code.slice(0, 2000)}\n  ${dim("... truncated")}` : page.code);
  }

  out.push("");
  out.push(`  ${cyan("[dude <query>]")} search dude  ${cyan("[s <query>]")} search docs  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderDiff(result: ReturnType<typeof diffCommandVersions>): string {
  const out: string[] = [];
  out.push(`  ${bold("Command diff:")} ${result.from_version} → ${result.to_version}`);
  if (result.path_prefix) out.push(`  ${dim(`Scope: ${result.path_prefix}`)}`);
  out.push("");

  if (result.added.length > 0) {
    out.push(`  ${green(`+ ${result.added_count} added:`)}`);
    for (const p of result.added.slice(0, 30)) out.push(`    ${green("+")} ${p}`);
    if (result.added.length > 30) out.push(`    ${dim(`... and ${result.added.length - 30} more`)}`);
    out.push("");
  }
  if (result.removed.length > 0) {
    out.push(`  ${red(`- ${result.removed_count} removed:`)}`);
    for (const p of result.removed.slice(0, 30)) out.push(`    ${red("-")} ${p}`);
    if (result.removed.length > 30) out.push(`    ${dim(`... and ${result.removed.length - 30} more`)}`);
    out.push("");
  }
  if (result.added.length === 0 && result.removed.length === 0) {
    out.push(`  ${dim("No structural differences found.")}`);
  }
  if (result.note) out.push(`  ${dim(result.note)}`);

  out.push("");
  out.push(`  ${cyan("[cl <from>..<to>]")} changelogs  ${cyan("[vc <path>]")} version check  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderVersionCheck(result: ReturnType<typeof checkCommandVersions>): string {
  const out: string[] = [];
  out.push(`  ${bold(result.command_path)}`);
  out.push("");

  if (result.versions.length === 0) {
    out.push(`  ${dim("No version data found.")}`);
  } else {
    out.push(`  ${dim("First seen:")} ${bold(result.first_seen ?? "?")}  ${dim("Last seen:")} ${bold(result.last_seen ?? "?")}`);
    out.push(`  ${dim("Present in")} ${bold(String(result.versions.length))} ${dim("versions")}`);
    // Show version range compactly
    const display = result.versions.length <= 10
      ? result.versions.join(", ")
      : `${result.versions.slice(0, 5).join(", ")} … ${result.versions.slice(-3).join(", ")}`;
    out.push(`  ${dim(display)}`);
  }
  if (result.note) {
    out.push("");
    out.push(`  ${dim(result.note)}`);
  }

  out.push("");
  out.push(`  ${cyan("[diff <from> <to>]")} version diff  ${cyan("[cmd <path>]")} command tree  ${cyan("[b]")} back`);
  return out.join("\n");
}

function renderStats(): string {
  const stats = getDbStats();
  const out: string[] = [];
  out.push(`  ${bold("Database Statistics")}`);
  out.push(`  ${dim("Path:")} ${stats.db_path}`);
  if (stats.db_size_bytes != null) {
    const mb = stats.db_size_bytes / (1024 * 1024);
    out.push(`  ${dim("Size:")} ${mb.toFixed(1)} MB`);
  }
  if (stats.schema_version != null) {
    out.push(`  ${dim("Schema:")} v${stats.schema_version}`);
  }
  out.push(`  ${dim("Export:")} ${stats.doc_export}`);
  out.push("");

  const kv = (label: string, value: string | number) => {
    out.push(`  ${dim(pad(label, 24))} ${bold(String(typeof value === "number" ? fmt(value) : value))}`);
  };

  kv("Pages", stats.pages);
  kv("Sections", stats.sections);
  kv("Properties", stats.properties);
  kv("Callouts", stats.callouts);
  kv("Commands", stats.commands);
  kv("Commands linked", stats.commands_linked);
  kv("Devices", stats.devices);
  kv("Device test results", stats.device_test_results);
  kv("Devices with tests", stats.devices_with_tests);
  kv("Changelogs", stats.changelogs);
  kv("Changelog versions", stats.changelog_versions);
  kv("RouterOS versions", stats.ros_versions);
  kv("Videos", stats.videos);
  kv("Video segments", stats.video_segments);
  kv("Version range", `${stats.ros_version_min ?? "?"}–${stats.ros_version_max ?? "?"}`);

  return out.join("\n");
}

function renderHelp(): string {
  const out: string[] = [];
  out.push(`  ${bold("Commands")}  ${dim("(bare text = search)")}`);
  out.push("");

  const cmd = (name: string, alias: string, desc: string, mcp?: string) => {
    const mcpHint = mcp ? `  ${dim(`(${mcp})`)}` : "";
    out.push(`  ${cyan(pad(name, 26))} ${dim(pad(alias, 6))} ${desc}${mcpHint}`);
  };

  cmd("<query>", "", "Search pages (default action)", "routeros_search");
  cmd("search <query>", "s", "Explicit page search", "routeros_search");
  cmd("page <id|title>", "", "View full page", "routeros_get_page");
  cmd("prop <name>", "p", "Look up property (scoped to current page)", "routeros_lookup_property");
  cmd("props <query>", "sp", "Search properties by FTS");
  cmd("glossary [term]", "g", "Look up RouterOS jargon / list glossary");
  cmd("cmd [path]", "tree", "Browse command tree", "routeros_command_tree");
  cmd("device <query>", "dev", "Look up device specs", "routeros_device_lookup");
  cmd("tests [device] [type]", "", "Cross-device benchmarks", "routeros_search_tests");
  cmd("callouts [query]", "cal", "Search callouts (cal warning, or `cal` on a page)");
  cmd("changelog [query]", "cl", "Search changelogs (cl 7.22, cl breaking)", "routeros_search_changelogs");
  cmd("videos <query>", "vid", "Search video transcripts");
  cmd("dude <query>", "", "Search archived Dude wiki docs", "routeros_dude_search");
  cmd("skills", "", "List agent skill guides", "rosetta://skills");
  cmd("skill <name>", "", "View a skill guide", "rosetta://skills/{name}");
  cmd("diff <from> <to> [path]", "", "Command tree diff between versions", "routeros_command_diff");
  cmd("vcheck <path>", "vc", "Version range for a command path", "routeros_command_version_check");
  cmd("versions", "ver", "Live-fetch current RouterOS versions", "routeros_current_versions");
  cmd("stats", "", "Database health / counts", "routeros_stats");
  cmd("back", "b", "Re-render previous view (not just print a breadcrumb)");
  cmd("help", "?", "This help");
  cmd("quit", "q", "Exit");

  out.push("");
  out.push(`  ${bold("MCP probe (dot-commands)")}  ${dim("— see exactly what an agent sees")}`);
  out.push(`  ${cyan(pad(".help", 38))} ${dim("Full list of all 13 tool dot-commands + meta")}`);
  out.push(`  ${cyan(pad(".instructions", 38))} ${dim("MCP server instructions string (sent on init)")}`);
  out.push(`  ${cyan(pad(".resources", 38))} ${dim("Registered MCP resources (rosetta:// URIs)")}`);
  out.push(`  ${cyan(pad(".routeros_search <q> [limit=N]", 38))} ${dim("Raw JSON output, same query path as MCP")}`);
  out.push("");
  out.push(`  ${dim("Navigation: type a number to select from results; in pager, 1–9 jumps to page N.")}`);
  out.push(`  ${dim("After viewing a page, [p] = properties, [cal] = page callouts, [b] = re-render previous view.")}`);
  out.push(`  ${dim("URLs are clickable in supported terminals (iTerm2, etc.).")}`);
  out.push(`  ${dim("cmd supports @version suffix: cmd /ip/address @7.15")}`);
  out.push("");
  out.push(`  ${bold("CLI flags")}`);
  out.push(`  ${cyan(pad("--db <path>", 26))} ${dim("")} Use a specific database file`);
  out.push(`  ${cyan(pad("--once", 26))} ${dim("")} Execute any command once and exit (for piping)`);
  out.push(`  ${cyan(pad("browse <cmd> [args]", 26))} ${dim("")} Pass any TUI command directly from the shell:`)
  out.push(`  ${cyan(pad("", 26))} ${dim("")}   ${dim("browse changelog 7.20..7.22")}`);
  out.push(`  ${cyan(pad("", 26))} ${dim("")}   ${dim("browse cmd /ip/firewall")}`);
  out.push(`  ${cyan(pad("", 26))} ${dim("")}   ${dim("browse .routeros_search vrrp")}`);

  return out.join("\n");
}

// ── MCP probe (dot-commands) ──────────────────────────────────────────────
//
// `.<tool_name> [positional...] [key=value ...]` invokes the same query
// function the MCP server uses and dumps the raw JSON response. Lets a human
// in the TUI see exactly what an agent would see — useful for debugging tool
// descriptions, classifier output, and `related` block contents at any limit.
//
// Format mirrors the MCP tool name (e.g. `.routeros_search dhcp limit=12`).
// Positional tokens are joined into the tool's "primary" argument (query,
// path, name, etc.). `key=value` pairs override or add fields.

type DotArgs = Record<string, string | number | boolean>;

function parseDotArgs(rest: string, primary?: string, aliases?: Record<string, string>): DotArgs {
  const args: DotArgs = {};
  const positional: string[] = [];
  // Split on whitespace but allow key="quoted value"
  const tokens = rest.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  for (const t of tokens) {
    const m = t.match(/^([a-z_]\w*)=(.*)$/);
    if (m) {
      let v: string | number | boolean = m[2].replace(/^"|"$/g, "");
      if (v === "true") v = true;
      else if (v === "false") v = false;
      else if (/^-?\d+$/.test(v)) v = Number.parseInt(v, 10);
      // Normalize alias keys to canonical names so callers can paste the
      // exact form printed in `next_steps` (e.g. `id=N` for get_page).
      const key = aliases?.[m[1]] ?? m[1];
      args[key] = v;
    } else {
      positional.push(t.replace(/^"|"$/g, ""));
    }
  }
  if (primary && positional.length > 0 && args[primary] === undefined) {
    args[primary] = positional.join(" ");
  }
  return args;
}

type DotTool = {
  /** Field name that bare positional tokens are joined into. */
  primary?: string;
  /** Short one-line description shown by `.help`. */
  desc: string;
  /** Optional alias→canonical key map (e.g. `{ id: "page" }` so the form
   *  printed in `next_steps` works verbatim). */
  aliases?: Record<string, string>;
  /** TUI command this tool maps to, for cross-referencing in `.help`. */
  tui?: string;
  /** Run the tool — return any JSON-serializable object. */
  run: (args: DotArgs) => unknown;
};

const dotTools: Record<string, DotTool> = {
  routeros_search: {
    primary: "query",
    tui: "s <query>",
    desc: "Unified search — same as `s <query>` but with raw JSON response",
    run: (a) => searchAll(String(a.query ?? ""), a.limit ? Number(a.limit) : undefined),
  },
  routeros_get_page: {
    primary: "page",
    aliases: { id: "page" },
    tui: "page <id|title>",
    desc: "Full page by id or title (args: page= or id=, max_length=, section=)",
    run: (a) => {
      const p = a.page;
      const id = typeof p === "number" ? p : /^\d+$/.test(String(p)) ? Number.parseInt(String(p), 10) : String(p);
      return getPage(
        id,
        a.max_length !== undefined ? Number(a.max_length) : undefined,
        a.section !== undefined ? String(a.section) : undefined,
      );
    },
  },
  routeros_lookup_property: {
    primary: "name",
    tui: "p <name>",
    desc: "Property by exact name (args: name=, command_path=)",
    run: (a) => lookupProperty(String(a.name ?? ""), a.command_path ? String(a.command_path) : undefined),
  },
  routeros_command_tree: {
    primary: "path",
    tui: "cmd [path]",
    desc: "Browse command tree (args: path=, version=, arch=)",
    run: (a) => {
      const path = String(a.path ?? "");
      if (a.version) return browseCommandsAtVersion(path, String(a.version), a.arch ? String(a.arch) : undefined);
      return browseCommands(path, a.arch ? String(a.arch) : undefined);
    },
  },
  routeros_search_changelogs: {
    primary: "query",
    tui: "cl [query]",
    desc: "Search changelogs (args: query=, version=, from_version=, to_version=, category=, breaking_only=, limit=)",
    run: (a) => searchChangelogs(String(a.query ?? ""), {
      version: a.version ? String(a.version) : undefined,
      fromVersion: a.from_version ? String(a.from_version) : undefined,
      toVersion: a.to_version ? String(a.to_version) : undefined,
      category: a.category ? String(a.category) : undefined,
      breakingOnly: a.breaking_only === true || a.breaking_only === "true",
      limit: a.limit ? Number(a.limit) : undefined,
    }),
  },
  routeros_command_version_check: {
    primary: "command_path",
    tui: "vc <command_path>",
    desc: "Version range for a command path (args: command_path=)",
    run: (a) => {
      const p = String(a.command_path ?? "");
      return checkCommandVersions(p.startsWith("/") ? p : `/${p}`);
    },
  },
  routeros_command_diff: {
    tui: "diff <from> <to> [path]",
    desc: "Diff command tree between versions (args: from_version=, to_version=, path_prefix=, arch=)",
    run: (a) => diffCommandVersions(
      String(a.from_version ?? ""),
      String(a.to_version ?? ""),
      a.path_prefix ? String(a.path_prefix) : undefined,
      a.arch ? String(a.arch) : undefined,
    ),
  },
  routeros_device_lookup: {
    primary: "query",
    tui: "device <query>",
    desc: "Device lookup with FTS+filters (args: query=, architecture=, license_level=, has_wireless=, ...)",
    run: (a) => searchDevices(String(a.query ?? ""), {
      architecture: a.architecture ? String(a.architecture) : undefined,
      license_level: a.license_level ? Number(a.license_level) : undefined,
      has_wireless: a.has_wireless === true || a.has_wireless === "true" ? true : undefined,
      has_poe: a.has_poe === true || a.has_poe === "true" ? true : undefined,
      has_lte: a.has_lte === true || a.has_lte === "true" ? true : undefined,
      min_ram_mb: a.min_ram_mb ? Number(a.min_ram_mb) : undefined,
      min_storage_mb: a.min_storage_mb ? Number(a.min_storage_mb) : undefined,
    }, a.limit ? Number(a.limit) : undefined),
  },
  routeros_search_tests: {
    tui: "tests [device] [type]",
    desc: "Cross-device benchmarks (args: device=, test_type=, mode=, configuration=, packet_size=, sort_by=, limit=)",
    run: (a) => searchDeviceTests({
      device: a.device ? String(a.device) : undefined,
      test_type: a.test_type ? String(a.test_type) : undefined,
      mode: a.mode ? String(a.mode) : undefined,
      configuration: a.configuration ? String(a.configuration) : undefined,
      packet_size: a.packet_size ? Number(a.packet_size) : undefined,
      sort_by: (a.sort_by as "mbps" | "kpps") ?? undefined,
    }, a.limit ? Number(a.limit) : undefined),
  },
  routeros_dude_search: {
    primary: "query",
    tui: "dude <query>",
    desc: "Search archived Dude wiki (args: query=, limit=)",
    run: (a) => searchDude(String(a.query ?? ""), a.limit ? Number(a.limit) : undefined),
  },
  routeros_dude_get_page: {
    primary: "id",
    desc: "Full Dude wiki page (args: id=, max_length=)",
    run: (a) => {
      const id = typeof a.id === "number" ? a.id : /^\d+$/.test(String(a.id)) ? Number.parseInt(String(a.id), 10) : String(a.id);
      return getDudePage(id, a.max_length ? Number(a.max_length) : undefined);
    },
  },
  routeros_stats: {
    tui: "stats",
    desc: "DB health / counts",
    run: () => getDbStats(),
  },
  routeros_current_versions: {
    tui: "versions",
    desc: "Live-fetch RouterOS versions per channel",
    run: async () => await fetchCurrentVersions(),
  },
};

/** Convert FTS5 snippet markers `**word**` inside JSON string values to ANSI
 *  bold so dot-command output highlights matched terms (matching what the
 *  TUI search/changelog/video renderers do). Operates only on quoted JSON
 *  string contents — keys and structure use their own quoting. */
function highlightSnippetMarkers(json: string): string {
  return json.replace(/"((?:\\.|[^"\\])*)"/g, (full, body) => {
    if (!body.includes("**")) return full;
    const replaced = body.replace(/\*\*([^*"]+)\*\*/g, (_m: string, t: string) => `${ESC}[1m${t}${ESC}[0m`);
    return `"${replaced}"`;
  });
}

async function dispatchDotCommand(input: string): Promise<void> {
  // .help / .tools — list all dot-commands
  if (input === ".help" || input === ".?" || input === ".tools") {
    const out: string[] = [];
    out.push(`  ${bold("MCP probe — direct tool invocation")}`);
    out.push(`  ${dim("Format: .<tool_name> [positional...] [key=value ...]")}`);
    out.push(`  ${dim("Output: raw JSON, exactly what an MCP client would receive.")}`);
    out.push("");
    out.push(`  ${bold("Tool dot-commands")} ${dim(`(${Object.keys(dotTools).length} tools)`)}`);
    for (const [name, t] of Object.entries(dotTools)) {
      const tuiHint = t.tui ? `  ${dim(`= ${t.tui}`)}` : "";
      out.push(`  ${cyan(`.${name}`)}${tuiHint}`);
      out.push(`     ${dim(t.desc)}`);
    }
    out.push("");
    out.push(`  ${bold("Meta dot-commands")}`);
    out.push(`  ${cyan(".instructions")}     ${dim("Show MCP server instructions string sent to clients on init")}`);
    out.push(`  ${cyan(".resources")}        ${dim("List MCP resources (rosetta:// URIs)")}`);
    out.push(`  ${cyan(".help")} / ${cyan(".tools")} / ${cyan(".?")}  ${dim("This list")}`);
    out.push("");
    out.push(`  ${dim("Example: .routeros_search firewall filter limit=20")}`);
    out.push(`  ${dim("Example: .routeros_get_page 28282 max_length=4000")}`);
    out.push(`  ${dim("Example: .routeros_get_page id=81362945       (paste from next_steps)")}`);
    out.push(`  ${dim("Example: .routeros_lookup_property name=disabled command_path=/ip/firewall/filter")}`);
    await paged(out.join("\n"));
    return;
  }
  // .instructions — print MCP server `instructions` string
  if (input === ".instructions") {
    const out: string[] = [];
    out.push(`  ${bold("MCP server instructions")} ${dim("(sent to clients on initialize)")}`);
    out.push("");
    out.push(MCP_INSTRUCTIONS);
    await paged(out.join("\n"));
    return;
  }
  // .resources — list registered MCP resources
  if (input === ".resources" || input === ".refs") {
    const out: string[] = [];
    out.push(`  ${bold("MCP resources")} ${dim("(static + per-skill)")}`);
    out.push("");
    for (const r of MCP_STATIC_RESOURCES) {
      out.push(`  ${cyan(r.uri)}`);
      out.push(`     ${bold(r.title)}  ${dim(`[${r.mimeType}]`)}`);
      out.push(`     ${dim(r.description)}`);
    }
    try {
      const skills = listSkills();
      if (skills.length > 0) {
        out.push("");
        out.push(`  ${bold(`Skill resources`)} ${dim(`(${skills.length} from tikoci/routeros-skills — community content, NOT official MikroTik docs)`)}`);
        for (const s of skills) {
          out.push(`  ${cyan(`rosetta://skills/${s.name}`)}  ${dim(`${s.word_count}w`)}  ${dim(s.description)}`);
        }
      }
    } catch {
      // skills table may not exist
    }
    await paged(out.join("\n"));
    return;
  }
  const m = input.match(/^\.([a-z_]\w*)\s*(.*)$/i);
  if (!m) {
    console.log(dim(`  Bad dot-command syntax. Try '.help' for the list.`));
    return;
  }
  const name = m[1];
  const tool = dotTools[name];
  if (!tool) {
    console.log(dim(`  Unknown MCP tool: .${name}. Try '.help' for the list.`));
    return;
  }
  try {
    const args = parseDotArgs(m[2] ?? "", tool.primary, tool.aliases);
    const result = await tool.run(args);
    const json = JSON.stringify(result, null, 2);
    const banner = dim(`── .${name}  args=${JSON.stringify(args)}`);
    await paged(`${banner}\n${highlightSnippetMarkers(json)}`);
  } catch (e) {
    console.log(red(`  Error invoking .${name}: ${(e as Error).message}`));
  }
}

// ── Command dispatcher ──

async function dispatch(input: string): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  // ── MCP probe (dot-command) ──
  if (trimmed.startsWith(".")) {
    await dispatchDotCommand(trimmed);
    return;
  }

  // Parse command + args
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const rest = parts.slice(1).join(" ");

  // ── Bare number: select from current results ──
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10) - 1;
    await handleNumberSelect(idx);
    return;
  }

  // ── Commands ──
  switch (command) {
    case "q":
    case "quit":
    case "exit":
      process.exit(0);
      return; // unreachable — satisfies no-fallthrough lint

    case "?":
    case "help":
      await paged(renderHelp());
      return;

    case "b":
    case "back":
      if (!popCtx()) {
        console.log(dim("  Already at top."));
        return;
      }
      // Re-render the now-current context so the user lands back where
      // they came from instead of dropping to a bare prompt.
      await renderCurrentContext();
      return;

    case "stats":
      await paged(renderStats());
      return;

    case "s":
    case "search":
      if (!rest) { console.log(dim("  Usage: search <query>")); return; }
      await doSearch(rest);
      return;

    case "page": {
      if (!rest) { console.log(dim("  Usage: page <id|title>")); return; }
      await doPage(rest);
      return;
    }

    case "p":
    case "prop": {
      if (!rest) {
        // Context-scoped: show properties for current page
        if (ctx.type === "page") {
          const page = getPage(ctx.pageId, 0); // just get metadata
          if (page) {
            await doPropsForPage(ctx.pageId, ctx.title);
            return;
          }
        }
        console.log(dim("  Usage: prop <name> — or navigate to a page first"));
        return;
      }
      await doLookupProperty(rest);
      return;
    }

    case "sp":
    case "props": {
      if (!rest) { console.log(dim("  Usage: props <query>")); return; }
      await doSearchProperties(rest);
      return;
    }

    case "g":
    case "glossary": {
      await doGlossary(rest);
      return;
    }

    case "cmd":
    case "tree": {
      const path = rest || (ctx.type === "commands" ? ctx.path : "");
      await doCommandTree(path);
      return;
    }

    case "dev":
    case "device": {
      if (!rest) { console.log(dim("  Usage: device <query>")); return; }
      await doDeviceLookup(rest);
      return;
    }

    case "tests": {
      await doTests(rest);
      return;
    }

    case "cal":
    case "callouts": {
      if (!rest && ctx.type === "page") {
        // Page-scoped: query callouts directly by page_id (the
        // FTS-with-empty-query path always returned [] before).
        const pageCallouts = getPageCallouts((ctx as { pageId: number }).pageId);
        if (pageCallouts.length > 0) {
          await paged(renderCallouts(pageCallouts));
          pushCtx({ type: "callouts", query: "", results: pageCallouts });
        } else {
          console.log(dim("  This page has no callouts."));
        }
        return;
      }
      await doSearchCallouts(rest);
      return;
    }

    case "cl":
    case "changelog": {
      await doSearchChangelogs(rest);
      return;
    }

    case "vid":
    case "videos": {
      if (!rest) { console.log(dim("  Usage: videos <query>")); return; }
      await doSearchVideos(rest);
      return;
    }

    case "dude": {
      if (!rest) { console.log(dim("  Usage: dude <query>")); return; }
      await doSearchDude(rest);
      return;
    }

    case "skills": {
      await doListSkills();
      return;
    }

    case "skill": {
      if (!rest) { console.log(dim("  Usage: skill <name>")); return; }
      await doViewSkill(rest);
      return;
    }

    case "diff": {
      const diffParts = rest.split(/\s+/);
      if (diffParts.length < 2) {
        console.log(dim("  Usage: diff <from_version> <to_version> [path_prefix]"));
        return;
      }
      await doDiff(diffParts[0], diffParts[1], diffParts[2]);
      return;
    }

    case "vc":
    case "vcheck": {
      if (!rest) { console.log(dim("  Usage: vcheck <command_path>")); return; }
      await doVersionCheck(rest);
      return;
    }

    case "ver":
    case "versions": {
      await doCurrentVersions();
      return;
    }

    default:
      // Bare text = search
      await doSearch(trimmed);
      return;
  }
}

// ── Number selection handler ──

async function handleNumberSelect(idx: number): Promise<void> {
  if (ctx.type === "search" && ctx.results[idx]) {
    const r = ctx.results[idx];
    await doPage(String(r.id));
    return;
  }
  if (ctx.type === "sections" && ctx.sections[idx]) {
    const s = ctx.sections[idx];
    const page = getPage(ctx.pageId, undefined, s.anchor_id || s.heading);
    if (page) {
      await paged(renderPage(page));
      pushCtx({ type: "page", pageId: ctx.pageId, title: ctx.title });
    }
    return;
  }
  if (ctx.type === "devices" && ctx.results[idx]) {
    const d = ctx.results[idx];
    const lookup = searchDevices(d.product_name, {}, 1);
    if (lookup.results.length > 0) {
      await paged(renderDeviceCard(lookup.results[0]));
      pushCtx({ type: "device", device: lookup.results[0] });
    }
    return;
  }
  if (ctx.type === "callouts" && ctx.results[idx]) {
    const c = ctx.results[idx];
    await doPage(String(c.page_id));
    return;
  }
  if (ctx.type === "videos" && ctx.results[idx]) {
    const v = ctx.results[idx];
    const timeUrl = v.start_s > 0 ? `${v.url}&t=${v.start_s}` : v.url;
    console.log(`\n  ${bold(v.title)}`);
    if (v.chapter_title) console.log(`  ${magenta(`§ ${v.chapter_title}`)}  ${dim(`@ ${formatTime(v.start_s)}`)}`);
    console.log(`  ${cyan(link(timeUrl))}\n`);
    return;
  }
  if (ctx.type === "dude" && ctx.results[idx]) {
    const d = ctx.results[idx];
    const page = getDudePage(d.id);
    if (page) {
      await paged(renderDudePage(page));
      pushCtx({ type: "dude", query: ctx.query, results: ctx.results });
    }
    return;
  }
  if (ctx.type === "skills") {
    const skills = listSkills();
    if (skills[idx]) {
      await doViewSkill(skills[idx].name);
    }
    return;
  }
  if (ctx.type === "commands") {
    // Re-query and navigate to the Nth child (dirs and cmds drill in; args show inline)
    const children = browseCommands(ctx.path);
    const child = children[idx];
    if (child) {
      if (child.type === "dir" || child.type === "cmd") {
        await doCommandTree(child.path);
      } else {
        // arg — display its details inline
        const parts: string[] = [];
        if (child.description) parts.push(child.description);
        if (child.data_type) parts.push(`type: ${child.data_type}`);
        if (child.enum_values) {
          try { parts.push(`values: ${JSON.parse(child.enum_values).join("|")}`); } catch { /* ignore */ }
        } else if (child.completion) {
          const keys = Object.keys(child.completion).filter((k) => k !== "");
          if (keys.length > 0) parts.push(`values: ${keys.join("|")}`);
        }
        console.log(`\n  ${bold(child.name)}  ${dim(`(${child.path})`)}`);
        if (parts.length > 0) console.log(`  ${parts.join("  ·  ")}`);
        console.log("");
      }
      return;
    }
  }
  if (ctx.type === "properties" && ctx.results[idx]) {
    const p = ctx.results[idx];
    await doPage(String(p.page_id));
    return;
  }
  if (ctx.type === "changelogs" && ctx.results[idx]) {
    const c = ctx.results[idx];
    console.log(`\n  ${bold(c.version)}  ${dim(c.released ?? "")}  ${dim(c.category)}${c.is_breaking ? `  ${red("⚠ BREAKING")}` : ""}`);
    console.log(`  ${c.description}\n`);
    return;
  }
  console.log(dim(`  No item #${idx + 1} in current view.`));
}

// ── Action functions ──

/**
 * Re-render the current context, used by `b` / `back` so users land back on
 * the parent view instead of dropping to a bare prompt. Pure rendering — no
 * pushCtx (we just popped).
 */
async function renderCurrentContext(): Promise<void> {
  switch (ctx.type) {
    case "home":
      console.log(dim("  ← back to home. Type 'help' for commands."));
      return;
    case "search":
      await paged(renderSearchResults(ctx.response));
      return;
    case "page":
    case "sections": {
      const page = getPage(ctx.pageId);
      if (page) await paged(renderPage(page));
      return;
    }
    case "commands": {
      const children = browseCommands(ctx.path);
      await paged(renderCommandTree(ctx.path, children));
      return;
    }
    case "devices":
      await paged(renderDeviceResults(ctx.results, "search", ctx.results.length));
      return;
    case "device":
      await paged(renderDeviceCard(ctx.device));
      return;
    case "callouts":
      await paged(renderCallouts(ctx.results));
      return;
    case "changelogs":
      await paged(renderChangelogs(ctx.results));
      return;
    case "videos":
      await paged(renderVideos(ctx.results));
      return;
    case "dude":
      await paged(renderDudeResults(ctx.results));
      return;
    case "skills":
      await doListSkills();
      return;
    case "properties": {
      const lines: string[] = [`  ${bold("Properties")}`, ""];
      for (let i = 0; i < ctx.results.length; i++) {
        const p = ctx.results[i];
        lines.push(`  ${cyan(String(i + 1).padStart(2))}. ${bold(p.name)}  ${dim(`@ ${p.page_title}`)}`);
      }
      await paged(lines.join("\n"));
      return;
    }
    case "tests":
    case "diff":
    case "vcheck":
      console.log(dim(`  ← back to ${ctx.type}. Re-run the command to see the result again.`));
      return;
  }
}

async function doSearch(query: string): Promise<void> {
  const resp = searchAll(query);
  await paged(renderSearchResults(resp));
  pushCtx({ type: "search", response: resp, results: resp.pages });
}

async function doPage(idOrTitle: string, sectionName?: string): Promise<void> {
  const page = getPage(
    /^\d+$/.test(idOrTitle) ? Number.parseInt(idOrTitle, 10) : idOrTitle,
    undefined,
    sectionName,
  );
  if (!page) {
    console.log(dim(`  Page not found: ${idOrTitle}`));
    return;
  }
  await paged(renderPage(page));

  // Determine linked command path (if any)
  let commandPath: string | undefined;
  try {
    const row = db.prepare("SELECT path FROM commands WHERE page_id = ? LIMIT 1").get(page.id) as { path: string } | null;
    if (row) commandPath = row.path;
  } catch {
    // commands table may not exist
  }

  if (page.sections && page.sections.length > 0) {
    pushCtx({ type: "sections", pageId: page.id, title: page.title, sections: page.sections });
  } else {
    pushCtx({ type: "page", pageId: page.id, title: page.title, commandPath });
  }
}

async function doPropsForPage(pageId: number, title: string): Promise<void> {
  // Get all properties for this page
  const results = searchProperties(title, 50);
  const pageProps = results.filter((p) => p.page_title === title);
  if (pageProps.length === 0) {
    console.log(dim(`  No properties found for "${title}".`));
    return;
  }
  await paged(`  ${bold("Properties for")} ${bold(title)}\n\n${renderProperties(pageProps)}`);
  pushCtx({ type: "properties", query: title, pageId, results: pageProps.map(p => ({ name: p.name, page_id: p.page_id ?? pageId, page_title: p.page_title })) });
}

async function doLookupProperty(name: string): Promise<void> {
  const commandPath = ctx.type === "page" ? (ctx as { commandPath?: string }).commandPath : undefined;
  const results = lookupProperty(name, commandPath);
  if (results.length === 0) {
    console.log(dim(`  Property "${name}" not found.`));
    console.log(`  Try: ${cyan("props")} ${name}`);
    return;
  }
  await paged(renderProperties(results));
  pushCtx({ type: "properties", query: name, results: results.map(p => ({ name: p.name, page_id: p.page_id, page_title: p.page_title })) });
}

async function doSearchProperties(query: string): Promise<void> {
  const results = searchProperties(query);
  if (results.length === 0) {
    console.log(dim(`  No properties found for "${query}".`));
    return;
  }
  await paged(`  ${bold(String(results.length))} properties matching ${cyan(`"${query}"`)}\n\n${renderProperties(results)}`);
  pushCtx({ type: "properties", query, results: results.map(p => ({ name: p.name, page_id: p.page_id, page_title: p.page_title })) });
}

async function doGlossary(rest: string): Promise<void> {
  if (!rest) {
    // List all glossary entries grouped by category
    const entries = listGlossary();
    if (entries.length === 0) {
      console.log(dim("  Glossary is empty."));
      return;
    }
    const grouped = new Map<string, GlossaryEntry[]>();
    for (const e of entries) {
      const list = grouped.get(e.category) || [];
      list.push(e);
      grouped.set(e.category, list);
    }
    const lines: string[] = [`  ${bold("Glossary")} ${dim(`(${entries.length} terms)`)}\n`];
    for (const [cat, items] of grouped) {
      lines.push(`  ${yellow(cat.toUpperCase())}`);
      for (const e of items) {
        const aliases = e.aliases ? ` ${dim(`(${e.aliases})`)}` : "";
        lines.push(`    ${cyan(e.term)}${aliases} — ${e.definition}`);
      }
      lines.push("");
    }
    await paged(lines.join("\n"));
    return;
  }
  // Look up a specific term
  const entry = lookupGlossary(rest);
  if (!entry) {
    console.log(dim(`  Term "${rest}" not in glossary.`));
    console.log(`  Try: ${cyan("glossary")} ${dim("(no args)")} to see all terms, or ${cyan("s")} ${rest}`);
    return;
  }
  const aliases = entry.aliases ? `\n  ${dim("Aliases:")} ${entry.aliases}` : "";
  const hint = entry.search_hint ? `\n  ${dim("Search:")} ${cyan(entry.search_hint)}` : "";
  console.log(`\n  ${bold(entry.term)} ${dim(`[${entry.category}]`)}\n  ${mdToAnsi(entry.definition)}${aliases}${hint}\n`);
}

async function doCommandTree(path: string): Promise<void> {
  // Extract optional @version suffix: "cmd /ip/address @7.15" or "cmd /ip add @7.20"
  let version: string | undefined;
  let pathArg = path;
  const versionMatch = path.match(/^(.*?)\s*@(\S+)$/);
  if (versionMatch) {
    pathArg = versionMatch[1].trim();
    version = versionMatch[2];
  }

  let cmdPath: string;
  if (!pathArg) {
    if (ctx.type === "page" && (ctx as { commandPath?: string }).commandPath) {
      // biome-ignore lint/style/noNonNullAssertion: narrowed above
      cmdPath = (ctx as { commandPath?: string }).commandPath!;
    } else if (ctx.type === "commands") {
      cmdPath = ctx.path;
    } else {
      cmdPath = "";
    }
  } else if (pathArg.startsWith("/")) {
    cmdPath = pathArg;
  } else if (ctx.type === "commands") {
    // Relative segment: "cmd add" at /ip/address → /ip/address/add
    cmdPath = `${ctx.path}/${pathArg}`;
  } else {
    cmdPath = `/${pathArg}`;
  }

  const children = version
    ? browseCommandsAtVersion(cmdPath, version)
    : browseCommands(cmdPath);

  if (children.length === 0) {
    // Check if path itself exists as a leaf node
    const vcResult = cmdPath ? checkCommandVersions(cmdPath) : null;
    if (vcResult && vcResult.versions.length > 0) {
      console.log(`  ${bold(cmdPath)}  ${dim("(leaf — no children)")}`);
      console.log(`  ${dim("First seen:")} ${bold(vcResult.first_seen ?? "?")}  ${dim("Last seen:")} ${bold(vcResult.last_seen ?? "?")}`);
      console.log(`  ${dim("Present in")} ${bold(String(vcResult.versions.length))} ${dim("versions")}`);
      if (vcResult.note) console.log(`  ${dim(vcResult.note)}`);
      console.log(`  ${dim("Try:")} ${cyan("b")} ${dim("to go up,  or")} ${cyan(`s ${cmdPath.split("/").pop() ?? ""}`)} ${dim("to search docs")}`);
    } else {
      console.log(dim(`  No results for "${cmdPath}".`));
      const term = cmdPath.split("/").filter(Boolean).pop() ?? "";
      if (term) {
        console.log(`  ${dim("Try:")} ${cyan(`s ${term}`)} ${dim("(search docs)  or")} ${cyan(`vc ${cmdPath}`)} ${dim("(version check)")}`);
      }
    }
    return;
  }
  const label = version ? `${cmdPath} @${version}` : cmdPath;
  await paged(renderCommandTree(label, children));
  pushCtx({ type: "commands", path: cmdPath });
}

async function doDeviceLookup(query: string): Promise<void> {
  const result = searchDevices(query, {});
  if (result.results.length === 0) {
    console.log(dim(`  No devices found for "${query}".`));
    return;
  }
  await paged(renderDeviceResults(result.results, result.mode, result.total));
  if (result.results.length === 1) {
    pushCtx({ type: "device", device: result.results[0] });
  } else {
    pushCtx({ type: "devices", query, results: result.results });
  }
}

async function doTests(argsStr: string): Promise<void> {
  if (!argsStr) {
    // Show available filter values
    const meta = getTestResultMeta();
    console.log(`  ${bold("Test filters:")}`);
    console.log(`  ${dim("Types:")} ${meta.test_types.join(", ")}`);
    console.log(`  ${dim("Modes:")} ${meta.modes.join(", ")}`);
    console.log(`  ${dim("Packet sizes:")} ${meta.packet_sizes.join(", ")}`);
    console.log("");
    console.log(`  ${dim("Usage: tests [device] <type> [mode] [packet_size]")}`);
    console.log(`  ${dim("Example: tests ethernet Routing 1518")}`);
    console.log(`  ${dim("Example: tests rb5009 ethernet 1518")}`);
    return;
  }

  const parts = argsStr.split(/\s+/);
  const filters: Record<string, string | number> = {};

  // Known test types — if parts[0] is not a known type, treat it as a device filter
  const knownTypes = ["ethernet", "ipsec"];
  let offset = 0;
  if (parts[0] && !knownTypes.includes(parts[0].toLowerCase())) {
    filters.device = parts[0];
    offset = 1;
  }
  if (parts[offset]) filters.test_type = parts[offset];
  if (parts[offset + 1]) filters.mode = parts[offset + 1];
  if (parts[offset + 2] && /^\d+$/.test(parts[offset + 2])) filters.packet_size = Number.parseInt(parts[offset + 2], 10);

  const result = searchDeviceTests(filters);
  if (result.results.length === 0) {
    console.log(dim("  No test results matching those filters."));
    return;
  }
  await paged(renderTests(result.results, result.total));
  pushCtx({ type: "tests" });
}

async function doSearchCallouts(query: string): Promise<void> {
  // Parse type filter: "cal warning" or "cal warning dhcp"
  const types = ["note", "warning", "info", "tip"];
  const parts = query.split(/\s+/);
  let type: string | undefined;
  let searchQuery = query;

  if (parts[0] && types.includes(parts[0].toLowerCase())) {
    type = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
    searchQuery = parts.slice(1).join(" ");
  }

  const results = searchCallouts(searchQuery, type);
  if (results.length === 0) {
    console.log(dim(`  No callouts found.`));
    return;
  }
  await paged(`  ${bold(String(results.length))} callouts${type ? ` (${type})` : ""}\n\n${renderCallouts(results)}`);
  pushCtx({ type: "callouts", query, results });
}

async function doSearchChangelogs(query: string): Promise<void> {
  const parts = query.split(/\s+/).filter(Boolean);

  // Parse options
  let breakingOnly = false;
  let version: string | undefined;
  let fromVersion: string | undefined;
  let toVersion: string | undefined;
  let category: string | undefined;
  const searchTerms: string[] = [];

  for (const part of parts) {
    if (part.toLowerCase() === "breaking") { breakingOnly = true; continue; }
    // Version range: "7.20..7.22"
    const rangeMatch = part.match(/^(\d+\.\d+[.\w]*)\.\.(\d+\.\d+[.\w]*)$/);
    if (rangeMatch) { fromVersion = rangeMatch[1]; toVersion = rangeMatch[2]; continue; }
    // Single version: "7.22"
    if (/^\d+\.\d+/.test(part)) { version = part; continue; }
    searchTerms.push(part);
  }

  // If we only got a version and nothing else, browse that version
  const searchQuery = searchTerms.join(" ");

  const results = searchChangelogs(searchQuery, {
    version,
    fromVersion,
    toVersion,
    category,
    breakingOnly,
    limit: 50,
  });

  if (results.length === 0) {
    console.log(dim("  No changelog entries found."));
    return;
  }
  await paged(`  ${bold("Changelogs")}${version ? ` for ${bold(version)}` : ""}${breakingOnly ? ` ${red("(breaking only)")}` : ""}\n\n${renderChangelogs(results)}`);
  pushCtx({ type: "changelogs", results });
}

async function doSearchVideos(query: string): Promise<void> {
  const results = searchVideos(query, 10);
  if (results.length === 0) {
    console.log(dim(`  No video results for "${query}".`));
    return;
  }
  await paged(`  ${bold(String(results.length))} video results for ${cyan(`"${query}"`)}\n\n${renderVideos(results)}`);
  pushCtx({ type: "videos", query, results });
}

async function doSearchDude(query: string): Promise<void> {
  const results = searchDude(query, 10);
  if (results.length === 0) {
    console.log(dim(`  No Dude wiki results for "${query}".`));
    return;
  }
  await paged(`  ${bold(String(results.length))} Dude wiki results for ${cyan(`"${query}"`)}\n\n${renderDudeResults(results)}`);
  pushCtx({ type: "dude", query, results });
}

async function doListSkills(): Promise<void> {
  const skills = listSkills();
  if (skills.length === 0) {
    console.log(dim("  No skills available. Run: make extract-skills"));
    return;
  }
  const out: string[] = [];
  out.push(`  ${bold(`${skills.length} Agent Skills`)}  ${dim("(tikoci/routeros-skills — community content)")}`);
  out.push(`  ${yellow("⚠ AI-generated, human-reviewed. NOT official MikroTik docs.")}`);
  out.push("");
  skills.forEach((s, i) => {
    out.push(`  ${cyan(String(i + 1).padStart(2))}. ${bold(s.name)}  ${dim(`${s.word_count} words, ${s.ref_count} refs`)}`);
    out.push(`      ${s.description}`);
  });
  out.push("");
  out.push(`  ${dim("Type a number to view, or: skill <name>")}`);
  await paged(out.join("\n"));
  pushCtx({ type: "skills" });
}

async function doViewSkill(name: string): Promise<void> {
  const skill = getSkill(name);
  if (!skill) {
    console.log(dim(`  Skill "${name}" not found. Use 'skills' to list available skills.`));
    return;
  }
  const out: string[] = [];
  out.push(`  ${yellow("⚠ PROVENANCE: Community content from tikoci/routeros-skills")}`);
  out.push(`  ${yellow("  NOT official MikroTik documentation. May contain errors.")}`);
  out.push(`  ${dim(`Source: ${link(skill.source_url)}`)}`);
  out.push("");
  out.push(`  ${bold(skill.name)}  ${dim(`${skill.word_count} words`)}`);
  out.push(`  ${skill.description}`);
  out.push("");
  out.push(mdToAnsi(skill.content));
  if (skill.references.length > 0) {
    out.push("");
    out.push(`  ${bold("Reference Files")}  ${dim(`(${skill.references.length} files)`)}`);
    out.push("");
    for (const ref of skill.references) {
      out.push(`  ${cyan("─")} ${bold(ref.filename)}  ${dim(`${ref.word_count} words`)}`);
    }
    out.push("");
    out.push(`  ${dim("To view a reference: skill <name> refs")}`);
  }
  await paged(out.join("\n"));
}

async function doDiff(from: string, to: string, pathPrefix?: string): Promise<void> {
  const result = diffCommandVersions(from, to, pathPrefix);
  await paged(renderDiff(result));
  pushCtx({ type: "diff" });
}

async function doVersionCheck(cmdPath: string): Promise<void> {
  const normalized = cmdPath.startsWith("/") ? cmdPath : `/${cmdPath}`;
  const result = checkCommandVersions(normalized);
  await paged(renderVersionCheck(result));
  pushCtx({ type: "vcheck", path: normalized });
}

async function doCurrentVersions(): Promise<void> {
  console.log(dim("  Fetching current versions from MikroTik..."));
  const result = await fetchCurrentVersions();
  const out: string[] = [];
  out.push(`  ${bold("Current RouterOS Versions")}  ${dim(`(${result.fetched_at})`)}`);
  out.push("");
  for (const [channel, version] of Object.entries(result.channels)) {
    const v = version ?? dim("unavailable");
    const ch = pad(channel, 14);
    out.push(`  ${dim(ch)} ${bold(String(v))}`);
  }
  out.push(`  ${dim(pad("winbox 4", 14))} ${bold(String(result.winbox ?? dim("unavailable")))}`);
  console.log(out.join("\n"));
}

// ── Main REPL ──

async function main() {
  initDb();

  const args = process.argv.slice(2);
  const onceMode = args.includes("--once");
  // Filter out --once, browse, and --db <path> so they don't become search queries
  const dbArgIdx = args.indexOf("--db");
  const queryArgs = args.filter((a, i) => {
    if (a === "--once" || a === "browse") return false;
    if (a === "--db") return false;
    if (dbArgIdx !== -1 && i === dbArgIdx + 1) return false;
    return true;
  });
  const initialQuery = queryArgs.join(" ");

  // Welcome banner (only in interactive mode)
  if (process.stdout.isTTY && !onceMode) {
    console.log(renderWelcome());
    console.log("");
  }

  // Initial command from CLI args — run through the same dispatch as the REPL
  // so any TUI command works, not just searches:
  //   browse changelog 7.20..7.22     → shows changelog range
  //   browse cmd /ip/firewall          → shows command tree
  //   browse .routeros_search vrrp     → MCP probe output
  //   browse dhcp server               → (bare text) search as before
  if (initialQuery) {
    await dispatch(initialQuery);
    if (onceMode) process.exit(0);
  }

  // Non-TTY: exit after initial query or do nothing
  if (!process.stdout.isTTY) {
    if (!initialQuery) {
      console.error("Non-interactive mode requires a query argument.");
      process.exit(1);
    }
    process.exit(0);
  }

  // Interactive REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    try {
      await dispatch(line);
    } catch (err) {
      console.error(red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
    }
    rl.setPrompt(buildPrompt());
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("");
    process.exit(0);
  });
}

main();
