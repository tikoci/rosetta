/**
 * build-cliref-asset.ts — Package the CLI-Reference dataset as its own release asset (#188).
 *
 * Usage: bun run scripts/build-cliref-asset.ts [db] [outDir]
 *   db defaults to ros-help.db, outDir to dist/
 *
 * Produces:
 *   <outDir>/rosetta-cli-reference.tar.gz         — the export's cli-reference/ directory (format 2)
 *   <outDir>/rosetta-cli-reference.tar.gz.sha256  — `sha256sum -c` format
 *
 * The tarball is also next release's retention archive: release.yml unpacks the newest one
 * and passes its cli-reference/ to `extract-cliref --archive`. A DB without the overlay
 * fails here, because every release must ship the asset.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExport } from "../src/export.ts";

export const ASSET_NAME = "rosetta-cli-reference.tar.gz";

export async function buildCliRefAsset(dbPath: string, outDir: string): Promise<{ tarball: string; sha256: string }> {
  const work = mkdtempSync(path.join(tmpdir(), "rosetta-cliref-asset-"));
  // Read-write handle: bun:sqlite cannot open a downloaded WAL-mode DB read-only. Nothing writes.
  const db = new Database(dbPath);
  try {
    const summary = await runExport(work, db);
    if (!summary.files.some((f) => f.name === "cli-reference/trees.tsv")) {
      throw new Error(`${dbPath} has no CLI-Reference overlay — run extract-cliref before packaging ${ASSET_NAME}`);
    }
    const tarball = path.join(path.resolve(outDir), ASSET_NAME);
    await Bun.$`mkdir -p ${path.dirname(tarball)}`;
    await Bun.$`tar -czf ${tarball} -C ${work} cli-reference`;
    const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(tarball).arrayBuffer()).digest("hex");
    writeFileSync(`${tarball}.sha256`, `${sha256}  ${ASSET_NAME}\n`);
    return { tarball, sha256 };
  } finally {
    db.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [dbPath = "ros-help.db", outDir = "dist"] = process.argv.slice(2);
  const { tarball, sha256 } = await buildCliRefAsset(dbPath, outDir);
  console.log(`✓ ${tarball} (sha256 ${sha256})`);
}
