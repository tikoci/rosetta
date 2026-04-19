#!/usr/bin/env bun
/**
 * extract-skills.ts — Extract agent skill guides from tikoci/routeros-skills.
 *
 * Fetches SKILL.md files and reference documents from GitHub (or a local path),
 * parses YAML frontmatter, and populates skills + skill_references tables.
 *
 * Usage:
 *   bun run src/extract-skills.ts                                    # Fetch from GitHub API
 *   bun run src/extract-skills.ts /path/to/routeros-skills           # Use local directory
 *   bun run src/extract-skills.ts --from-cache                       # Re-extract from cached skills/ dir
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, initDb } from "./db.ts";

// ── Configuration ──

const PROJECT_ROOT = join(import.meta.dirname, "..");
const CACHE_DIR = join(PROJECT_ROOT, "skills");

const GITHUB_REPO = "tikoci/routeros-skills";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}`;

const FROM_CACHE = process.argv.includes("--from-cache");

/** Local path override: first non-flag CLI arg */
const localPath = process.argv.slice(2).find((a) => !a.startsWith("--"));

// ── Types ──

interface SkillData {
  name: string;
  description: string;
  content: string;
  sourceUrl: string;
  references: Array<{
    path: string;
    filename: string;
    content: string;
  }>;
}

// ── YAML frontmatter parsing (minimal — no dependency) ──

function parseFrontmatter(markdown: string): { meta: Record<string, string>; content: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: markdown };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, content: match[2] };
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── GitHub API fetching ──

async function getDefaultBranchSha(): Promise<string> {
  const res = await fetch(`${GITHUB_API_BASE}/commits/HEAD`, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error(`Failed to get HEAD SHA: HTTP ${res.status}`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

async function listSkillDirs(sha: string): Promise<string[]> {
  const res = await fetch(`${GITHUB_API_BASE}/contents/?ref=${sha}`, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error(`Failed to list repo contents: HTTP ${res.status}`);
  const entries = (await res.json()) as Array<{ name: string; type: string }>;
  return entries
    .filter((e) => e.type === "dir" && e.name.startsWith("routeros-"))
    .map((e) => e.name);
}

async function fetchRawFile(sha: string, path: string): Promise<string | null> {
  const url = `${GITHUB_RAW_BASE}/${sha}/${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Failed to fetch ${path}: HTTP ${res.status}`);
  }
  return res.text();
}

async function listReferences(sha: string, skillName: string): Promise<string[]> {
  const res = await fetch(`${GITHUB_API_BASE}/contents/${skillName}/references?ref=${sha}`, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`Failed to list references for ${skillName}: HTTP ${res.status}`);
  }
  const entries = (await res.json()) as Array<{ name: string; type: string }>;
  return entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name);
}

async function extractFromGitHub(): Promise<{ skills: SkillData[]; sha: string }> {
  console.log(`Fetching skills from GitHub: ${GITHUB_REPO}`);
  const sha = await getDefaultBranchSha();
  console.log(`  HEAD SHA: ${sha.slice(0, 12)}`);

  const skillDirs = await listSkillDirs(sha);
  console.log(`  Found ${skillDirs.length} skill directories`);

  const skills: SkillData[] = [];

  for (const dir of skillDirs) {
    const skillMd = await fetchRawFile(sha, `${dir}/SKILL.md`);
    if (!skillMd) {
      console.warn(`  ⚠ ${dir}/SKILL.md not found, skipping`);
      continue;
    }

    const { meta, content } = parseFrontmatter(skillMd);
    const skill: SkillData = {
      name: meta.name || dir,
      description: meta.description || "",
      content,
      sourceUrl: `https://github.com/${GITHUB_REPO}/blob/${sha}/${dir}/SKILL.md`,
      references: [],
    };

    // Fetch references
    const refFiles = await listReferences(sha, dir);
    for (const refFile of refFiles) {
      const refContent = await fetchRawFile(sha, `${dir}/references/${refFile}`);
      if (refContent) {
        skill.references.push({
          path: `references/${refFile}`,
          filename: refFile,
          content: refContent,
        });
      }
    }

    skills.push(skill);
    console.log(`  ✓ ${skill.name} (${countWords(content)} words, ${skill.references.length} refs)`);
  }

  // Cache to skills/ directory
  cacheSkills(skills, sha);

  return { skills, sha };
}

// ── Local path extraction ──

function extractFromLocal(dirPath: string): { skills: SkillData[]; sha: string } {
  console.log(`Extracting skills from local path: ${dirPath}`);

  // Try to get git SHA
  let sha = "local";
  try {
    const gitResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dirPath });
    if (gitResult.exitCode === 0) {
      sha = gitResult.stdout.toString().trim();
      console.log(`  Git SHA: ${sha.slice(0, 12)}`);
    }
  } catch { /* not a git repo, that's fine */ }

  const entries = readdirSync(dirPath, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("routeros-")).map((e) => e.name);
  console.log(`  Found ${skillDirs.length} skill directories`);

  const skills: SkillData[] = [];

  for (const dir of skillDirs) {
    const skillPath = join(dirPath, dir, "SKILL.md");
    if (!existsSync(skillPath)) {
      console.warn(`  ⚠ ${dir}/SKILL.md not found, skipping`);
      continue;
    }

    const skillMd = readFileSync(skillPath, "utf-8");
    const { meta, content } = parseFrontmatter(skillMd);
    const skill: SkillData = {
      name: meta.name || dir,
      description: meta.description || "",
      content,
      sourceUrl: `https://github.com/${GITHUB_REPO}/blob/${sha}/${dir}/SKILL.md`,
      references: [],
    };

    // Load references
    const refsDir = join(dirPath, dir, "references");
    if (existsSync(refsDir)) {
      const refEntries = readdirSync(refsDir, { withFileTypes: true });
      for (const ref of refEntries) {
        if (ref.isFile() && ref.name.endsWith(".md")) {
          skill.references.push({
            path: `references/${ref.name}`,
            filename: ref.name,
            content: readFileSync(join(refsDir, ref.name), "utf-8"),
          });
        }
      }
    }

    skills.push(skill);
    console.log(`  ✓ ${skill.name} (${countWords(content)} words, ${skill.references.length} refs)`);
  }

  // Cache to skills/ directory
  cacheSkills(skills, sha);

  return { skills, sha };
}

// ── Cache management ──

function cacheSkills(skills: SkillData[], sha: string) {
  mkdirSync(CACHE_DIR, { recursive: true });

  // Write metadata
  const metadata = {
    sha,
    extracted_at: new Date().toISOString(),
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      word_count: countWords(s.content),
      ref_count: s.references.length,
    })),
  };
  writeFileSync(join(CACHE_DIR, "metadata.json"), JSON.stringify(metadata, null, 2));

  // Write each skill
  for (const skill of skills) {
    const skillDir = join(CACHE_DIR, skill.name);
    mkdirSync(skillDir, { recursive: true });

    // Write SKILL.md with frontmatter reconstructed
    const frontmatter = `---\nname: ${skill.name}\ndescription: "${skill.description}"\n---\n`;
    writeFileSync(join(skillDir, "SKILL.md"), frontmatter + skill.content);

    // Write references
    if (skill.references.length > 0) {
      const refsDir = join(skillDir, "references");
      mkdirSync(refsDir, { recursive: true });
      for (const ref of skill.references) {
        writeFileSync(join(refsDir, ref.filename), ref.content);
      }
    }
  }

  console.log(`  Cached ${skills.length} skills to ${CACHE_DIR}/`);
}

function extractFromCache(): { skills: SkillData[]; sha: string } {
  console.log(`Extracting skills from cache: ${CACHE_DIR}/`);

  if (!existsSync(join(CACHE_DIR, "metadata.json"))) {
    throw new Error(`No cached skills found at ${CACHE_DIR}/metadata.json — run without --from-cache first`);
  }

  const metadata = JSON.parse(readFileSync(join(CACHE_DIR, "metadata.json"), "utf-8"));
  const sha = metadata.sha || "cached";

  const skills: SkillData[] = [];
  const entries = readdirSync(CACHE_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("routeros-")) continue;

    const skillPath = join(CACHE_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const skillMd = readFileSync(skillPath, "utf-8");
    const { meta, content } = parseFrontmatter(skillMd);
    const skill: SkillData = {
      name: meta.name || entry.name,
      description: meta.description || "",
      content,
      sourceUrl: `https://github.com/${GITHUB_REPO}/blob/${sha}/${entry.name}/SKILL.md`,
      references: [],
    };

    // Load cached references
    const refsDir = join(CACHE_DIR, entry.name, "references");
    if (existsSync(refsDir)) {
      const refEntries = readdirSync(refsDir, { withFileTypes: true });
      for (const ref of refEntries) {
        if (ref.isFile() && ref.name.endsWith(".md")) {
          skill.references.push({
            path: `references/${ref.name}`,
            filename: ref.name,
            content: readFileSync(join(refsDir, ref.name), "utf-8"),
          });
        }
      }
    }

    skills.push(skill);
    console.log(`  ✓ ${skill.name} (${countWords(content)} words, ${skill.references.length} refs)`);
  }

  return { skills, sha };
}

// ── Database population ──

function populateDb(skills: SkillData[], sha: string) {
  const now = new Date().toISOString();

  // Idempotent: delete existing data (respect FK order)
  db.run("DELETE FROM skill_references");
  db.run("DELETE FROM skills");

  const insertSkill = db.prepare(`
    INSERT INTO skills (name, description, content, source_repo, source_sha, source_url, word_count, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRef = db.prepare(`
    INSERT INTO skill_references (skill_id, path, filename, content, word_count)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getSkillId = db.prepare("SELECT id FROM skills WHERE name = ?");

  let totalWords = 0;
  let totalRefs = 0;

  for (const skill of skills) {
    const wordCount = countWords(skill.content);
    totalWords += wordCount;

    insertSkill.run(
      skill.name,
      skill.description,
      skill.content,
      GITHUB_REPO,
      sha,
      skill.sourceUrl,
      wordCount,
      now,
    );

    const row = getSkillId.get(skill.name) as { id: number };
    const skillId = row.id;

    for (const ref of skill.references) {
      const refWordCount = countWords(ref.content);
      totalWords += refWordCount;
      totalRefs++;
      insertRef.run(skillId, ref.path, ref.filename, ref.content, refWordCount);
    }
  }

  console.log(`\nPopulated DB: ${skills.length} skills, ${totalRefs} references, ${totalWords} total words`);
}

// ── Main ──

async function main() {
  initDb();

  let skills: SkillData[];
  let sha: string;

  if (FROM_CACHE) {
    ({ skills, sha } = extractFromCache());
  } else if (localPath) {
    ({ skills, sha } = extractFromLocal(localPath));
  } else {
    ({ skills, sha } = await extractFromGitHub());
  }

  populateDb(skills, sha);
}

await main();
