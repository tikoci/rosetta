#!/usr/bin/env bun
/**
 * app-integration.ts — one RouterOS /app integration leg (#245 Phase 2).
 *
 * Boots a fresh disposable CHR with the Phase 1 recipe, runs the README's
 * own /app/add block against it (exactly two substitutions), and completes a
 * real MCP session through the app's ui-url. Same script runs locally on a
 * Mac and in CI (app-integration.yml) — the workflow only adds runner setup.
 *
 * Usage:
 *   bun scripts/app-integration.ts --arch <x86|arm64> --image <ref>
 *     [--ros-version <v>] [--version <v>] [--host-port <n>] [--name <n>]
 *     [--diagnostics-file <path>] [--keep]
 *
 *   --arch         Guest arch: x86 or arm64 (required).
 *   --image        Candidate image ref, e.g. ghcr.io/tikoci/rosetta:v0.12.0 (required).
 *   --ros-version  RouterOS version (default: 7.25).
 *   --version      Expected release version for provenance, e.g. 0.12.0.
 *                  Defaults to the version parsed from a vX.Y.Z image tag;
 *                  required for floating/sha tags.
 *   --host-port    Host side of the QEMU port forward (default: 9803).
 *   --name         quickchr machine name (default: auto-generated).
 *   --diagnostics-file  Where to write the JSON evidence bundle
 *                  (default: app-integration-<name>.json in cwd).
 *   --keep         Skip VM cleanup (debugging aid; default cleans up always).
 *
 * Exit codes: 0 pass; 1 integration failure; 2 usage/config error.
 */

import path from "node:path";

/** Pinned quickchr — local and CI must run exactly this (validated in Phase 2). */
export const QUICKCHR_PIN = "0.5.4";
/** Default RouterOS version: one stable >= 7.22, validated in Phase 1. */
export const ROS_VERSION_DEFAULT = "7.25";
/** App-disk size in GB. 4G leaves headroom; 2G fails on arm64 (swap + overlay
 *  copy-up of the ~415MB DB exceed it — see MANUAL "Disk sizing"). */
export const APP_DISK_GB = 4;
/** Guest RAM in MB per arch (Phase 1 measurements). */
export const GUEST_MEM_MB: Record<string, number> = { x86: 512, arm64: 1024 };
/** Guest web port from the README YAML (host side is --host-port). */
export const GUEST_WEB_PORT = 9803;
/** Poll interval while waiting for running=true. */
export const POLL_INTERVAL_MS = 15_000;
/** /app/add → running=true budget per arch (Phase 1: ~1min x86, ~4.5min arm64). */
export const RUNNING_TIMEOUT_MS: Record<string, number> = { x86: 6 * 60_000, arm64: 18 * 60_000 };
/** quickchr start (first boot + provisioning) budget per arch (Phase 1: ~1min / ~3.5min). */
export const START_TIMEOUT_MS: Record<string, number> = { x86: 10 * 60_000, arm64: 20 * 60_000 };

// ── Pure helpers (unit-tested in src/app-integration.test.ts) ───────────────

/** Extract the one fenced block whose first line is the /app/add command. */
export function extractAppAddBlock(readme: string): string {
  const fences = [...readme.matchAll(/```routeros\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const hits = fences.filter((b) => b.trimStart().startsWith("/app/add "));
  if (hits.length === 0) throw new Error("README has no fenced routeros block starting with /app/add");
  if (hits.length > 1) {
    throw new Error(`README has ${hits.length} fenced blocks starting with /app/add (expected exactly 1)`);
  }
  return hits[0];
}

function substituteOnce(haystack: string, needle: string, replacement: string): string {
  const count = haystack.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(
      `Expected exactly 1 occurrence of ${JSON.stringify(needle)} in README /app/add block, found ${count}`,
    );
  }
  return haystack.replace(needle, replacement);
}

/**
 * Apply the two documented substitutions to the README block: HTTP instead of
 * HTTPS (CHR has no /ip/cloud certificates), and the candidate image ref.
 * Anything else must come from the README, never from a second fixture.
 */
export function applyAppAddSubstitutions(block: string, imageRef: string): string {
  const http = substituteOnce(block, "use-https=yes", "use-https=no");
  return substituteOnce(http, "ghcr.io/tikoci/rosetta:latest", imageRef);
}

/**
 * Assert the ui-url is the http://…/mcp shape a use-https=no leg produces,
 * then rewrite only host:port to the QEMU forward.
 */
export function rewriteUiUrl(uiUrl: string, hostPort: number): string {
  let parsed: URL;
  try {
    parsed = new URL(uiUrl.trim());
  } catch {
    throw new Error(`ui-url is not a URL: ${JSON.stringify(uiUrl)}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`ui-url must use http (use-https=no leg), got: ${uiUrl.trim()}`);
  }
  if (!parsed.pathname.startsWith("/mcp")) {
    throw new Error(`ui-url must carry the /mcp path, got: ${uiUrl.trim()}`);
  }
  parsed.hostname = "127.0.0.1";
  parsed.port = String(hostPort);
  return parsed.toString();
}

export interface ParsedImageRef {
  registry: string;
  repo: string;
  /** Tag or digest (digest keeps its "sha256:…" form). */
  reference: string;
  /** True when reference is a digest rather than a tag. */
  isDigest: boolean;
}

/** Split registry/repo:tag[@digest]. A tag or digest is required. */
export function parseImageRef(ref: string): ParsedImageRef {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  let registry = "docker.io";
  let rest = trimmed;
  if (slash !== -1 && (trimmed.slice(0, slash).includes(".") || trimmed.slice(0, slash).includes(":"))) {
    registry = trimmed.slice(0, slash);
    rest = trimmed.slice(slash + 1);
  }
  const at = rest.indexOf("@");
  const colon = rest.lastIndexOf(":");
  let repo = rest;
  let reference = "";
  let isDigest = false;
  if (at !== -1) {
    repo = rest.slice(0, at).replace(/:[^/]*$/, "");
    reference = rest.slice(at + 1);
    isDigest = true;
  } else if (colon !== -1) {
    repo = rest.slice(0, colon);
    reference = rest.slice(colon + 1);
  }
  if (!repo || !reference) throw new Error(`Image ref must include a tag or digest: ${JSON.stringify(ref)}`);
  if (registry === "docker.io" && !repo.includes("/")) repo = `library/${repo}`;
  return { registry, repo, reference, isDigest };
}

/** Derive the bare release version from a vX.Y.Z… tag; null for floating/sha tags. */
export function deriveVersionFromTag(tag: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return match ? match[1] : null;
}

/** Registry API host for a parsed ref (Docker Hub's API host differs). */
export function registryApiHost(registry: string): string {
  return registry === "docker.io" ? "registry-1.docker.io" : registry;
}

/**
 * GitHub tokens authenticate only to GitHub's registry. A local run can point
 * --image at any registry, and those credentials must never leave ghcr.io.
 */
export function registryCredential(registry: string, envToken: string): string {
  return registry === "ghcr.io" ? envToken : "";
}

/** A Bearer challenge realm is trusted for credentials only over HTTPS on the API host itself. */
export function isTrustedChallengeRealm(realm: string, apiHost: string): boolean {
  try {
    const url = new URL(realm);
    return url.protocol === "https:" && url.host === apiHost;
  } catch {
    return false;
  }
}

const SECRET_KEY = /password|passwd|secret|token|authorization|auth|credential|header/i;

/**
 * Write the diagnostics bundle, returning false instead of throwing: an
 * evidence-write failure must never skip the VM cleanup that follows it.
 */
export async function writeDiagnosticsBundle(filePath: string, bundle: unknown): Promise<boolean> {
  try {
    await Bun.write(filePath, `${JSON.stringify(bundle, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Deep-clone with credential-shaped values replaced (diagnostics bundle). */
export function redactCredentials<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactCredentials) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactCredentials(entry);
    }
    return out as T;
  }
  return value;
}

/** Parse `-accel <mode>` from a QEMU process command line (reporting only). */
export function parseQemuAccel(argvText: string): string | null {
  const match = /(?:^|\s)-accel\s+(\S+)/.exec(argvText.replace(/\n/g, " "));
  return match ? match[1].split(",")[0] : null;
}

/** True when a container-log excerpt shows our app's container dying. */
export function logShowsContainerExit(logText: string, containerName: string): string[] {
  const hits: string[] = [];
  for (const line of logText.split("\n")) {
    if (line.includes(containerName) && /exited with (status|signal)/.test(line)) hits.push(line.trim());
  }
  return hits;
}

// ── Runner ───────────────────────────────────────────────────────────────────

interface LegConfig {
  arch: "x86" | "arm64";
  image: ParsedImageRef;
  imageRef: string;
  version: string;
  rosVersion: string;
  hostPort: number;
  machineName: string;
  keep: boolean;
  diagnosticsFile: string;
}

interface DigestRecord {
  indexDigest: string;
  platforms: Array<{ os: string; arch: string; digest: string }>;
}

const startedAt = Date.now();
function log(message: string): void {
  console.log(`[T+${Math.round((Date.now() - startedAt) / 1000)}s] ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

async function runCmd(argv: string[], opts: { timeoutMs?: number } = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
    timer.unref?.();
  }
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

interface RestEndpoint {
  url: string;
  authHeader: string;
}

/** POST one RouterOS script to /rest/execute; returns the console output. */
async function restExecute(endpoint: RestEndpoint, script: string): Promise<string> {
  const res = await fetch(`${endpoint.url}/execute`, {
    method: "POST",
    headers: { Authorization: endpoint.authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ script, "as-string": true }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) fail(`REST /rest/execute HTTP ${res.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text) as { ret?: string } | unknown[];
  if (Array.isArray(body)) return "";
  return (body.ret ?? "").replace(/\r/g, "");
}

function parseWwwAuthenticate(header: string): { realm: string; service: string; scope: string } | null {
  if (!header.startsWith("Bearer ")) return null;
  const params: Record<string, string> = {};
  for (const match of header.slice("Bearer ".length).matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1]] = match[2];
  }
  if (!params.realm) return null;
  return { realm: params.realm, service: params.service ?? "", scope: params.scope ?? "" };
}

/**
 * Resolve the multi-arch manifest digest + per-platform digests over the OCI
 * HTTP API (the no-Docker equivalent of `docker buildx imagetools inspect`,
 * so local and CI runs share one code path). Anonymous first; GITHUB_TOKEN /
 * GH_TOKEN is used when anonymous auth is refused.
 */
async function resolveDigests(image: ParsedImageRef): Promise<DigestRecord> {
  const host = registryApiHost(image.registry);
  const manifestUrl = `https://${host}/v2/${image.repo}/manifests/${image.reference}`;
  const accept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";

  async function getManifest(auth?: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept };
    if (auth) headers.Authorization = auth;
    return fetch(manifestUrl, { headers, signal: AbortSignal.timeout(30_000) });
  }

  // Anonymous first, always. A GitHub token is only ever attached for ghcr.io,
  // and only to a challenge realm on the API host itself — never to a
  // third-party registry or a registry-chosen host.
  const credential = registryCredential(image.registry, envToken);
  let res = await getManifest();
  if (res.status === 401) {
    const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate") ?? "");
    if (!challenge) fail(`Registry ${host} refused anonymous access without a Bearer challenge`);
    const scope = challenge.scope || `repository:${image.repo}:pull`;
    const tokenUrl = `${challenge.realm}?service=${encodeURIComponent(challenge.service)}&scope=${encodeURIComponent(scope)}`;
    const trusted = credential !== "" && isTrustedChallengeRealm(challenge.realm, host);
    let tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(30_000) });
    if (!tokenRes.ok && trusted) {
      tokenRes = await fetch(tokenUrl, {
        headers: { Authorization: `Basic ${Buffer.from(`oauth2:${credential}`).toString("base64")}` },
        signal: AbortSignal.timeout(30_000),
      });
    }
    if (!tokenRes.ok) fail(`Registry token request failed: HTTP ${tokenRes.status}`);
    const { token, access_token } = (await tokenRes.json()) as { token?: string; access_token?: string };
    const bearer = token ?? access_token;
    if (!bearer) fail("Registry token endpoint returned no token");
    res = await getManifest(`Bearer ${bearer}`);
  }
  if (!res.ok) fail(`Registry manifest fetch failed: HTTP ${res.status} for ${image.repo}:${image.reference}`);
  const indexDigest = res.headers.get("docker-content-digest") ?? "";
  if (!indexDigest) fail("Registry response carried no docker-content-digest header");
  const manifest = (await res.json()) as {
    mediaType?: string;
    manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }>;
  };
  const entries = manifest.manifests ?? [];
  if (entries.length === 0) {
    // Single-platform manifest: record it; the CHR run itself proves the platform.
    log(`WARNING: ${image.repo}:${image.reference} resolved to a single manifest, not an index`);
    return { indexDigest, platforms: [{ os: "unknown", arch: "unknown", digest: indexDigest }] };
  }
  return {
    indexDigest,
    platforms: entries.map((e) => ({
      os: e.platform?.os ?? "unknown",
      arch: e.platform?.architecture ?? "unknown",
      digest: e.digest ?? "unknown",
    })),
  };
}

function parseArgs(argv: string[]): LegConfig {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: bun scripts/app-integration.ts --arch <x86|arm64> --image <ref> [--ros-version <v>] [--version <v>] [--host-port <n>] [--name <n>] [--diagnostics-file <path>] [--keep]");
    process.exit(0);
  }
  const arch = get("--arch");
  if (arch !== "x86" && arch !== "arm64") {
    console.error("Missing or invalid --arch (want x86 or arm64). See --help.");
    process.exit(2);
  }
  const imageRef = get("--image");
  if (!imageRef) {
    console.error("Missing --image <ref>, e.g. ghcr.io/tikoci/rosetta:v0.12.0. See --help.");
    process.exit(2);
  }
  const image = parseImageRef(imageRef);
  const tagVersion = !image.isDigest ? deriveVersionFromTag(image.reference) : null;
  const version = (get("--version") || tagVersion || "").replace(/^v/, "");
  if (!version) {
    console.error(`Cannot derive a release version from ${JSON.stringify(image.reference)} — pass --version <v>, e.g. --version 0.12.0.`);
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const machineName = get("--name") ?? `rosetta-app-${arch}-${stamp}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineName)) {
    console.error(`Invalid --name ${JSON.stringify(machineName)} (lowercase letters, digits, dashes).`);
    process.exit(2);
  }
  return {
    arch,
    image,
    imageRef: imageRef.trim(),
    version,
    rosVersion: get("--ros-version") ?? ROS_VERSION_DEFAULT,
    hostPort: Number(get("--host-port") ?? GUEST_WEB_PORT),
    machineName,
    keep: argv.includes("--keep"),
    diagnosticsFile: get("--diagnostics-file") ?? path.join(process.cwd(), `app-integration-${machineName}.json`),
  };
}

async function assertQuickchrPin(): Promise<void> {
  const res = await runCmd(["quickchr", "--version"]);
  const firstLine = res.stdout.split("\n")[0] ?? "";
  const match = /^quickchr (\S+)/.exec(firstLine.trim());
  if (res.exitCode !== 0 || !match) {
    fail(`quickchr not usable: ${res.stderr.slice(0, 300) || res.stdout.slice(0, 300)}`);
  }
  if (match[1] !== QUICKCHR_PIN) {
    fail(`quickchr ${match[1]} found, this harness pins ${QUICKCHR_PIN} — run: bun install -g @tikoci/quickchr@${QUICKCHR_PIN}`);
  }
  log(`quickchr ${match[1]} (pinned)`);
}

async function readAccel(pid: number): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ps = await runCmd(["ps", "-p", String(pid), "-o", "args="]);
    const accel = parseQemuAccel(ps.stdout);
    if (accel) return accel;
    await new Promise((r) => setTimeout(r, 2000));
  }
  log("WARNING: could not read the QEMU -accel flag; recording accel as unknown");
  return "unknown";
}

interface QuickchrInspect {
  pid: number;
  services: {
    "rest-api": { url: string; port: number; auth: { username: string; password: string; header?: string } };
  };
}

async function inspectMachine(name: string): Promise<{ endpoint: RestEndpoint; pid: number; raw: unknown }> {
  const res = await runCmd(["quickchr", "inspect", name, "--json"]);
  if (res.exitCode !== 0) fail(`quickchr inspect failed: ${res.stderr.slice(0, 500)}`);
  const parsed = JSON.parse(res.stdout) as QuickchrInspect;
  const rest = parsed.services["rest-api"];
  const authHeader = rest.auth.header ?? `Basic ${Buffer.from(`${rest.auth.username}:${rest.auth.password}`).toString("base64")}`;
  return { endpoint: { url: rest.url, authHeader }, pid: parsed.pid, raw: parsed };
}

// Signal-safe shutdown shares these with main(): the machine name is recorded
// only after *this* run creates it, so a signal (or the finally block) never
// touches a VM it does not own. Cleared after normal completion.
let ownedMachineName: string | null = null;
let activeBundle: Record<string, unknown> | null = null;
let activeBundlePath: string | null = null;
let keepMachineOnSignal = false;
let signalShuttingDown = false;

async function cleanupMachine(name: string): Promise<void> {
  const stop = await runCmd(["quickchr", "stop", name]).catch(() => null);
  if (stop && stop.exitCode !== 0) log(`cleanup stop warning: ${(stop.stderr || stop.stdout).slice(0, 300)}`);
  const remove = await runCmd(["quickchr", "remove", name]).catch(() => null);
  if (remove && remove.exitCode !== 0) log(`cleanup remove warning: ${(remove.stderr || remove.stdout).slice(0, 300)}`);
}

async function shutdownOnSignal(code: number): Promise<never> {
  if (signalShuttingDown) process.exit(1);
  signalShuttingDown = true;
  try {
    if (activeBundle && activeBundlePath) {
      activeBundle.outcome = "cancelled";
      activeBundle.failure = `interrupted by ${code === 130 ? "SIGINT" : "SIGTERM"}`;
      if (!(await writeDiagnosticsBundle(activeBundlePath, activeBundle))) {
        console.log(`WARNING: could not write diagnostics bundle to ${activeBundlePath}`);
      }
    }
    if (ownedMachineName && !keepMachineOnSignal) {
      console.log(`interrupted — cleaning up ${ownedMachineName}...`);
      await cleanupMachine(ownedMachineName);
    }
  } finally {
    process.exit(code);
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dir, "..");
  const timings: Record<string, number> = {};
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - start;
    }
  };

  const bundle: Record<string, unknown> = {
    outcome: "fail",
    config: {
      arch: config.arch,
      image: config.imageRef,
      version: config.version,
      rosVersion: config.rosVersion,
      hostPort: config.hostPort,
      machineName: config.machineName,
      quickchrPin: QUICKCHR_PIN,
      hostArch: process.arch,
      hostPlatform: process.platform,
    },
  };

  let endpoint: RestEndpoint | undefined;
  activeBundle = bundle;
  activeBundlePath = config.diagnosticsFile;
  keepMachineOnSignal = config.keep;
  const noteFailure = (message: string): never => {
    bundle.failure = message;
    throw new Error(message);
  };

  try {
    // README extraction: the one fenced block starting with /app/add, exactly
    // the two documented substitutions, each matching exactly once.
    const readme = await Bun.file(path.join(repoRoot, "README.md")).text();
    const block = extractAppAddBlock(readme);
    const appAddCommand = applyAppAddSubstitutions(block, config.imageRef);
    log("Substituted /app/add command (README + 2 substitutions):");
    console.log(appAddCommand);
    bundle.substitutedCommand = appAddCommand;

    await phase("preflight", async () => {
      await assertQuickchrPin();
      log(`host ${process.platform}/${process.arch}, guest ${config.arch}, RouterOS ${config.rosVersion}`);
    });

    const digestsBefore = await phase("digests-before", async () => {
      const digests = await resolveDigests(config.image);
      log(`manifest digest: ${digests.indexDigest}`);
      for (const platform of digests.platforms) {
        log(`platform ${platform.os}/${platform.arch}: ${platform.digest}`);
      }
      return digests;
    });
    bundle.digestsBefore = digestsBefore;

    await phase("boot", async () => {
      log(`quickchr add ${config.machineName} (RouterOS ${config.rosVersion} ${config.arch}, ${GUEST_MEM_MB[config.arch]}MB, +${APP_DISK_GB}G disk)`);
      const add = await runCmd([
        "quickchr", "add",
        "--name", config.machineName,
        "--version", config.rosVersion,
        "--arch", config.arch,
        "--mem", String(GUEST_MEM_MB[config.arch]),
        "--add-disk", `${APP_DISK_GB}G`,
        "--add-package", "container",
        "--device-mode-enable", "container",
        "--forward", `mcp:${config.hostPort}:${GUEST_WEB_PORT}/tcp`,
      ]);
      if (add.exitCode !== 0) noteFailure(`quickchr add failed: ${(add.stderr || add.stdout).slice(0, 800)}`);
      ownedMachineName = config.machineName;
      log(`quickchr start ${config.machineName}`);
      const start = await runCmd(["quickchr", "start", config.machineName], {
        timeoutMs: START_TIMEOUT_MS[config.arch],
      });
      if (start.timedOut) {
        await runCmd(["quickchr", "stop", config.machineName]).catch(() => {});
        noteFailure(`quickchr start timed out after ${START_TIMEOUT_MS[config.arch] / 60000}min`);
      }
      if (start.exitCode !== 0) noteFailure(`quickchr start failed: ${(start.stderr || start.stdout).slice(0, 800)}`);
    });

    const inspected = await inspectMachine(config.machineName);
    endpoint = inspected.endpoint;
    bundle.quickchrInspect = redactCredentials(inspected.raw);
    const accel = await readAccel(inspected.pid);
    (bundle.config as Record<string, unknown>).accel = accel;
    log(`accel: ${accel}, REST: ${endpoint.url.replace(/\/\/.*@/, "//")}`);
    if (config.arch === "x86" && accel !== "kvm" && accel !== "hvf" && accel !== "unknown") {
      noteFailure(
        `x86 leg requires hardware accel (kvm/hvf), got ${accel} — the Bun binary SIGILLs under TCG (Phase 1).`,
      );
    }

    await phase("storage", async () => {
      const formatted = await restExecute(endpoint as RestEndpoint, "/disk/format numbers=0 file-system=ext4");
      if (!formatted.includes("format done")) noteFailure(`disk format did not complete: ${formatted.slice(0, 300)}`);
      const disks = await restExecute(endpoint as RestEndpoint, "/disk/print detail");
      const mounts = [...new Set([...disks.matchAll(/mount-point="([^"]+)"/g)].map((m) => m[1]))];
      if (mounts.length !== 1) noteFailure(`Expected exactly 1 mounted disk, found: ${JSON.stringify(mounts)}`);
      const settings = await restExecute(endpoint as RestEndpoint, `/app/settings/set disk=${mounts[0]}\n/app/settings/print`);
      if (!settings.includes(`disk: ${mounts[0]}`)) noteFailure(`/app/settings did not take disk=${mounts[0]}`);
      log(`app disk: ${mounts[0]}`);
    });

    await phase("app-add", async () => {
      const ret = await restExecute(endpoint as RestEndpoint, appAddCommand);
      if (ret.trim() !== "") noteFailure(`/app/add returned an error: ${ret.slice(0, 500)}`);
      log("/app/add accepted");
    });

    const runningBudget = RUNNING_TIMEOUT_MS[config.arch];
    const uiUrl = await phase("wait-running", async () => {
      const deadline = Date.now() + runningBudget;
      for (;;) {
        const state = await restExecute(
          endpoint as RestEndpoint,
          ":put [/app/get rosetta status]\n:put [/app/get rosetta running]\n:put [/app/get rosetta ui-url]",
        );
        const lines = state.split("\n").map((line) => line.trim());
        const status = lines[0] ?? "";
        const running = lines[1] === "true";
        const candidateUrl = lines[2] ?? "";
        if (running && candidateUrl) {
          log(`running=true, ui-url=${candidateUrl}`);
          return candidateUrl;
        }
        const containerLog = await restExecute(endpoint as RestEndpoint, '/log/print where topics~"container"');
        const exits = logShowsContainerExit(containerLog, "app-rosetta");
        if (exits.length > 0) {
          bundle.containerLogTail = containerLog.slice(-3000);
          noteFailure(`Container died while starting (last: ${exits[exits.length - 1]})`);
        }
        if (Date.now() >= deadline) {
          bundle.containerLogTail = containerLog.slice(-3000);
          noteFailure(`Still not running after ${runningBudget / 60000}min (status=${JSON.stringify(status)})`);
        }
        log(`status=${JSON.stringify(status)} running=false — waiting`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    });

    const smokeUrl = rewriteUiUrl(uiUrl, config.hostPort);
    (bundle.config as Record<string, unknown>).uiUrl = uiUrl;
    (bundle.config as Record<string, unknown>).smokeUrl = smokeUrl;
    log(`smoke URL (host:port rewrite only): ${smokeUrl}`);

    await phase("evidence", async () => {
      const appDetail = await restExecute(endpoint as RestEndpoint, "/app/print detail where name=rosetta");
      const containerDetail = await restExecute(endpoint as RestEndpoint, "/container/print detail");
      bundle.appDetail = appDetail;
      bundle.containerDetail = containerDetail;
      const arch = /arch="([^"]+)"/.exec(containerDetail)?.[1] ?? "unknown";
      const imageId = /image-id="([0-9a-f]+)/.exec(containerDetail)?.[1] ?? "unknown";
      (bundle.config as Record<string, unknown>).containerArch = arch;
      (bundle.config as Record<string, unknown>).containerImageId = imageId;
      log(`container arch=${arch} image-id=${imageId.slice(0, 12)}`);
      const digestsAfter = await resolveDigests(config.image);
      bundle.digestsAfter = digestsAfter;
      if (digestsAfter.indexDigest !== digestsBefore.indexDigest) {
        noteFailure(`Candidate tag moved mid-run: ${digestsBefore.indexDigest} -> ${digestsAfter.indexDigest}`);
      }
      log("manifest digest unchanged after the run");
    });

    await phase("smoke", async () => {
      const smoke = await runCmd(
        [process.execPath, path.join(import.meta.dir, "smoke-oci.ts"), smokeUrl, config.version],
        { timeoutMs: 5 * 60_000 },
      );
      bundle.smokeStdout = smoke.stdout;
      bundle.smokeStderr = smoke.stderr;
      console.log(smoke.stdout.trimEnd());
      if (smoke.timedOut) noteFailure("MCP smoke timed out after 5min");
      if (smoke.exitCode !== 0) noteFailure(`MCP smoke failed (exit ${smoke.exitCode}): ${(smoke.stderr || smoke.stdout).slice(0, 800)}`);
    });

    bundle.outcome = "pass";
    bundle.timings = timings;
    log(`APP-INTEGRATION PASS: ${config.arch} serves ${config.imageRef} (provenance v${config.version})`);
  } catch (error) {
    bundle.outcome = "fail";
    bundle.timings = timings;
    if (bundle.failure === undefined) bundle.failure = error instanceof Error ? error.message : String(error);
    await collectFailureDiagnostics(endpoint, bundle).catch((diagnosticError) => {
      log(`Diagnostics collection failed: ${diagnosticError instanceof Error ? diagnosticError.message : diagnosticError}`);
    });
    log(`APP-INTEGRATION FAIL: ${bundle.failure}`);
  } finally {
    bundle.config = redactCredentials(bundle.config);
    if (await writeDiagnosticsBundle(config.diagnosticsFile, bundle)) {
      log(`diagnostics bundle: ${config.diagnosticsFile}`);
    } else {
      log(`WARNING: could not write diagnostics bundle to ${config.diagnosticsFile}`);
    }
    appendStepSummary(config, bundle as { outcome: string; failure?: string; config?: Record<string, unknown>; digestsBefore?: DigestRecord });
    if (!config.keep) {
      if (ownedMachineName) {
        log(`cleanup: quickchr stop/remove ${ownedMachineName}`);
        await cleanupMachine(ownedMachineName);
      } else {
        log("cleanup skipped: this run never created its VM");
      }
    } else {
      log(`--keep: machine ${config.machineName} left running`);
    }
    ownedMachineName = null;
    activeBundle = null;
    activeBundlePath = null;
  }

  if (bundle.outcome !== "pass") process.exit(1);
}

async function collectFailureDiagnostics(endpoint: RestEndpoint | undefined, bundle: Record<string, unknown>): Promise<void> {
  if (!endpoint) {
    log("no REST endpoint — VM never became reachable; skipping router diagnostics");
    return;
  }
  log("collecting failure diagnostics (/app, /container, /log)...");
  const appDetail = await restExecute(endpoint, "/app/print detail where name=rosetta").catch((e) => `unavailable: ${e}`);
  const containerDetail = await restExecute(endpoint, "/container/print detail").catch((e) => `unavailable: ${e}`);
  const routerLog = await restExecute(endpoint, '/log/print where topics~"container"').catch((e) => `unavailable: ${e}`);
  bundle.appDetail = appDetail;
  bundle.containerDetail = containerDetail;
  bundle.containerLogTail = typeof routerLog === "string" ? routerLog.slice(-4000) : routerLog;
  console.log("--- /app/print detail ---\n" + String(appDetail).slice(0, 3000));
  console.log("--- /container/print detail ---\n" + String(containerDetail).slice(0, 4000));
  console.log("--- container log tail ---\n" + String(bundle.containerLogTail).slice(-2000));
}

function appendStepSummary(
  config: LegConfig,
  bundle: { outcome: string; failure?: string; config?: Record<string, unknown>; digestsBefore?: DigestRecord },
): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const rows: Array<[string, string]> = [
    ["arch", config.arch],
    ["image", config.imageRef],
    ["outcome", bundle.outcome],
    ["manifest digest", bundle.digestsBefore?.indexDigest ?? "unknown"],
    ["accel", String(bundle.config?.accel ?? "unknown")],
    ["container arch", String(bundle.config?.containerArch ?? "unknown")],
    ["ui-url", String(bundle.config?.uiUrl ?? "unknown")],
  ];
  if (bundle.failure) rows.push(["failure", String(bundle.failure)]);
  const table = ["| key | value |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
  Bun.write(summaryFile, `\n## app-integration (${config.arch})\n\n${table}\n`).catch(() => {});
}

if (import.meta.main) {
  process.on("SIGINT", () => {
    void shutdownOnSignal(130);
  });
  process.on("SIGTERM", () => {
    void shutdownOnSignal(143);
  });
  await main();
}

