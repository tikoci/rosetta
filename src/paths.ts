/**
 * paths.ts — Shared DB path resolution for all entry points.
 *
 * Three modes:
 *   1. Compiled binary (IS_COMPILED) → next to executable
 *   2. Dev mode (.git exists in project root) → project root
 *   3. Package mode (bunx / bun add -g) → ~/.rosetta/
 *
 * DB_PATH env var overrides all modes.
 * This module must NOT import db.ts or bun:sqlite — it's used before the DB is opened.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

declare const IS_COMPILED: boolean;
declare const VERSION: string;

/** True when running as a compiled binary (bun build --compile) */
export function isCompiled(): boolean {
  try {
    return typeof IS_COMPILED !== "undefined" && IS_COMPILED;
  } catch {
    return false;
  }
}

/** True when running from a git checkout (dev mode) */
function isDevMode(projectRoot: string): boolean {
  return existsSync(path.join(projectRoot, ".git"));
}

/**
 * Resolve the directory where ros-help.db should live.
 * - Compiled: directory containing the executable
 * - Dev: project root (one level up from src/)
 * - Package (bunx / global install): ~/.rosetta/
 */
export function resolveBaseDir(srcDir: string): string {
  if (isCompiled()) {
    return path.dirname(process.execPath);
  }

  const projectRoot = path.resolve(srcDir, "..");
  if (isDevMode(projectRoot)) {
    return projectRoot;
  }

  // Package mode — stable user-local directory
  const dataDir = path.join(homedir(), ".rosetta");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/**
 * Resolve the full path to ros-help.db.
 * DB_PATH env var overrides all detection logic.
 */
export function resolveDbPath(srcDir: string): string {
  const envPath = process.env.DB_PATH?.trim();
  if (envPath) return envPath;
  return path.join(resolveBaseDir(srcDir), "ros-help.db");
}

/** Detect invocation mode: "compiled" | "dev" | "package" */
export type InvocationMode = "compiled" | "dev" | "package";

export function detectMode(srcDir: string): InvocationMode {
  if (isCompiled()) return "compiled";
  const projectRoot = path.resolve(srcDir, "..");
  if (isDevMode(projectRoot)) return "dev";
  return "package";
}

/**
 * Resolve the version string.
 * Compiled mode: injected at build time via --define.
 * Dev/package mode: read from package.json.
 */
export function resolveVersion(srcDir: string): string {
  try {
    if (typeof VERSION !== "undefined") return VERSION;
  } catch {}
  try {
    const pkgPath = path.join(srcDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
