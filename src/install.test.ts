/** Real package/startup regressions; all downloads use a synthetic SQLite artifact. */
// cspell:words zeroblob
import sqlite from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gzipSync } from "bun";
import { dbRefreshCommand, downloadDb } from "./setup.ts";

const root = path.resolve(import.meta.dirname, "..");
const temp = mkdtempSync(path.join(tmpdir(), "rosetta-install-"));
const userDir = path.join(temp, "user");
const preloadHome = path.join(temp, "fixture-home.ts");
// Builtin mocking needs the initial namespace import. Only child processes use it.
writeFileSync(preloadHome, `import {mock} from "bun:test"; import * as os from "node:os"; mock.module("node:os",()=>({...os,homedir:()=>${JSON.stringify(userDir)}}));`);
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function packageRoot(version: string): string {
  const dir = path.join(temp, version);
  mkdirSync(dir);
  cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true });
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version, type: "module" }));
  return dir;
}

function resolvedPath(dir: string, args: string[] = [], envPath = "", compiled = false): string {
  // Resolve in a subprocess so env/argv tests cannot affect other test files.
  const entry = path.join(dir, "resolve-path.ts");
  writeFileSync(entry, `${compiled ? "globalThis.IS_COMPILED=true;" : ""} const {resolveDbPath}=await import("./src/paths.ts"); console.log(resolveDbPath(${JSON.stringify(path.join(dir, "src"))}));`);
  const result = Bun.spawnSync([process.execPath, "--preload", preloadHome, entry, ...args], { env: { ...process.env, DB_PATH: envPath } });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

async function fixture(version: string): Promise<string> {
  const dbFile = path.join(temp, `artifact-${version}.db`);
  const code = `
    const {db,initDb}=await import(${JSON.stringify(path.join(root, "src/db.ts"))});
    initDb();
    db.transaction(()=>{
      for(let i=0;i<100;i++) db.run(
        "INSERT INTO pages(slug,title,path,depth,url,text,code,word_count,code_lines,html_file) VALUES(?,?,?,0,?,'fixture searchable text','',3,0,'')",
        [String(i),"fixture page",String(i),"https://example.com"]
      );
      for(let i=0;i<1000;i++) db.run("INSERT INTO commands(path,name,type) VALUES(?,?,'cmd')",["/fixture/"+i,String(i)]);
      db.run("INSERT INTO db_meta VALUES('release_tag',?)",[${JSON.stringify(`v${version}`)}]);
      db.run("CREATE TABLE padding(bytes BLOB)");
      db.run("INSERT INTO padding VALUES(zeroblob(52428800))");
    })();
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", code], { env: { ...process.env, DB_PATH: dbFile } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const gzip = `${dbFile}.gz`;
  writeFileSync(gzip, gzipSync(readFileSync(dbFile)));
  return gzip;
}

async function connect(dir: string, artifact: string, args: string[] = [], dbOverride = ""): Promise<Client> {
  const preload = path.join(dir, "fixture-fetch.ts");
  writeFileSync(preload, `globalThis.fetch = async () => new Response(await Bun.file(${JSON.stringify(artifact)}).arrayBuffer());`);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--preload", preloadHome, "--preload", preload, path.join(dir, "src/mcp.ts"), ...args], env: { ...process.env, DB_PATH: dbOverride, ROSETTA_OFFLINE: "" }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "install-regression", version: "1" });
  try { await client.connect(transport); } catch (error) { await transport.close(); throw new Error(`${error}\n${stderr}`); }
  return client;
}

async function releaseTag(client: Client): Promise<string> {
  const result = await client.callTool({ name: "routeros_stats", arguments: {} });
  return JSON.parse((result.content as { text: string }[])[0].text).provenance.release_tag;
}

test("actual resolution separates full versions and preserves dev, --db, and DB_PATH", () => {
  const first = packageRoot(`0.0.0-rc.${process.pid * 10}`);
  const second = packageRoot(`0.0.0-rc.${process.pid * 10 + 1}`);
  const a = resolvedPath(first), b = resolvedPath(second);
  expect(a).toEndWith(`ros-help-0.0.0-rc.${process.pid * 10}.db`);
  expect(b).not.toBe(a);
  expect(resolvedPath(first)).toBe(a);
  expect(resolvedPath(first, ["--db", "relative/custom.db"])).toBe("relative/custom.db");
  expect(resolvedPath(first, ["--db", "ignored.db"], "env/override.db")).toBe("env/override.db");
  expect(resolvedPath(first, [], "", true)).toBe(path.join(path.dirname(process.execPath), "ros-help.db"));
  writeFileSync(path.join(first, ".git"), "fixture");
  expect(resolvedPath(first)).toBe(path.join(first, "ros-help.db"));
  rmSync(path.join(first, ".git"));
  expect(dbRefreshCommand("relative/custom.db", path.join(first, "src"))).toContain(`@0.0.0-rc.${process.pid * 10} --db '${path.resolve("relative/custom.db")}'`);
});

test("both startup overrides create missing parents and serve a downloaded artifact", async () => {
  const version = `0.0.0-rc.${process.pid * 10 + 2}`;
  const dir = packageRoot(version), artifact = await fixture(version);
  for (const override of ["env", "flag"]) {
    const destination = path.join(temp, override, "missing", "help.db");
    const client = await connect(dir, artifact, override === "flag" ? ["--db", destination] : [], override === "env" ? destination : "");
    try { expect(await releaseTag(client)).toBe(`v${version}`); } finally { await client.close(); }
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(`${destination}.lock`)).toBe(false);
  }
}, 30000);

test("two live package versions keep separate WAL files and provenance while querying", async () => {
  const versions = [3, 4].map(i => `0.0.0-rc.${process.pid * 10 + i}`);
  const dirs = versions.map(packageRoot);
  const paths = dirs.map(dir => resolvedPath(dir));
  const clients: Client[] = [];
  // The legacy owner's open WAL connection must survive patched defaults too.
  expect(paths[0]).toStartWith(path.join(userDir, ".rosetta"));
  const legacyPath = path.join(userDir, ".rosetta", "ros-help.db");
  const legacy = new sqlite(legacyPath);
  legacy.run("PRAGMA journal_mode=WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('legacy');");
  try {
    for (let i = 0; i < dirs.length; i++) clients.push(await connect(dirs[i], await fixture(versions[i])));
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < clients.length; i++) {
        expect(await releaseTag(clients[i])).toBe(`v${versions[i]}`);
        const result = await clients[i].callTool({ name: "routeros_search", arguments: { query: "fixture" } });
        expect(result.isError).not.toBe(true);
        expect(existsSync(`${paths[i]}-wal`)).toBe(true);
        expect(existsSync(`${paths[i]}.lock`)).toBe(false);
      }
      expect(legacy.query("SELECT value FROM marker").get()).toEqual({ value: "legacy" });
    }
  } finally { for (const client of clients) await client.close(); legacy.close(); }
}, 30000);


test("failed artifact validation cleans temporary DB and lock in a newly created parent", async () => {
  const version = `0.0.0-rc.${process.pid * 10 + 5}`;
  const compressed = await fixture(version);
  const artifact = compressed.slice(0, -3);
  const db = new sqlite(artifact);
  db.run("PRAGMA user_version=1");
  db.close();
  const url = `data:application/octet-stream;base64,${Buffer.from(gzipSync(readFileSync(artifact))).toString("base64")}`;
  const destination = path.join(temp, "invalid", "missing", "help.db");
  await expect(downloadDb(destination, () => {}, [url])).rejects.toThrow("Downloaded DB schema=1");
  expect(readdirSync(path.dirname(destination))).toEqual([]);
}, 30000);


test("first-launch failure identifies the selected version/path without blaming other clients", async () => {
  const version = `0.0.0-rc.${process.pid * 10 + 6}`;
  const dir = packageRoot(version), artifact = path.join(dir, "invalid.gz");
  writeFileSync(artifact, "invalid gzip");
  const destination = path.join(temp, "first-failure", "help.db");
  let diagnostic = "";
  try { const unexpected = await connect(dir, artifact, [], destination); await unexpected.close(); } catch (error) { diagnostic = String(error); }
  expect(diagnostic).toContain(`@tikoci/rosetta@${version}`);
  expect(diagnostic).toContain(destination);
  expect(diagnostic).not.toContain("Close other rosetta clients");
  expect(diagnostic).not.toContain("@latest");
  expect(existsSync(`${destination}.lock`)).toBe(false);
});
