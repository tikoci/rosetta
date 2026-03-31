# rosetta

MCP server for searching [MikroTik RouterOS documentation](https://help.mikrotik.com/docs/spaces/ROS/overview). Gives your AI assistant searchable access to 317 documentation pages, 4,860 property definitions, 40,000-entry command tree, and 144 hardware product specs — with direct links to help.mikrotik.com.

Tested with **Claude Desktop**, **Claude Code**, **VS Code Copilot** (including Copilot CLI), **Cursor**, and **OpenAI Codex** on macOS, Linux, and Windows.

## What is SQL-as-RAG?

Most retrieval-augmented generation (RAG) systems use vector embeddings to search documentation. This project takes a different approach: **SQLite [FTS5](https://www.sqlite.org/fts5.html) full-text search as the retrieval layer** — what we call SQL-as-RAG.

For structured technical documentation like RouterOS, full-text search with [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function) beats vector similarity. Technical terms like "dhcp-snooping" or "/ip/firewall/filter" are exact tokens — [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer) and proximity matching handle the rest. No embedding pipeline, no vector database, no API keys. Just a single SQLite file that searches in milliseconds.

The data flows: **HTML docs → SQLite extraction → FTS5 indexes → MCP tools → your AI assistant.** The database is built once from MikroTik's official Confluence documentation export, then the MCP server exposes 11 search tools over stdio or HTTP transport.

## What's Inside

- **317 documentation pages** from MikroTik's official help site (~515K words)
- **4,860 property definitions** with types, defaults, and descriptions
- **5,114 commands** in the RouterOS command hierarchy (551 directories, 34K arguments)
- **1,034 callout blocks** — warnings, notes, and tips with important caveats
- **144 hardware products** — CPU, RAM, storage, ports, PoE, wireless, license level, pricing
- **46 RouterOS versions tracked** (7.9 through 7.23beta2) for command history
- Direct links to help.mikrotik.com for every page and section

## Quick Start

## MCP Discovery Status

- GitHub MCP Registry listing: planned
- Official MCP Registry publication: metadata is now prepared in `server.json`

Local install remains the primary path today (`bunx @tikoci/rosetta`).

When ready to publish to the official registry:

```sh
brew install mcp-publisher
mcp-publisher validate server.json
mcp-publisher login github
mcp-publisher publish server.json
```

After publication, the server should be discoverable via:

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.tikoci/rosetta"
```

### Option A: Install with Bun (recommended)

Zero install, zero config, no binary signing issues. Requires [Bun](https://bun.sh/) — no Gatekeeper or SmartScreen warnings since there's no compiled binary to sign.

**1. Install Bun** (if you don't have it):

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

**2. Configure your MCP client** with `bunx @tikoci/rosetta` as the command. No setup step needed — the database downloads automatically on first launch (~50 MB compressed).

<details>
<summary><b>VS Code Copilot</b></summary>

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), choose **"MCP: Add Server…"**, select **"Command (stdio)"**, enter `bunx` as the command, and `@tikoci/rosetta` as the argument.

Or add to User Settings JSON (`Cmd+Shift+P` → "Preferences: Open User Settings (JSON)"):

```json
"mcp": {
  "servers": {
    "rosetta": {
      "command": "bunx",
      "args": ["@tikoci/rosetta"]
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add rosetta -- bunx @tikoci/rosetta
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Edit your Claude Desktop config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add (or merge into existing config):

```json
{
  "mcpServers": {
    "rosetta": {
      "command": "bunx",
      "args": ["@tikoci/rosetta"]
    }
  }
}
```

> **PATH note:** Claude Desktop on macOS doesn't always inherit your shell PATH. If `bunx` isn't found, use the full path — typically `~/.bun/bin/bunx`. Run `which bunx` to find it, or use `bunx @tikoci/rosetta --setup` which prints the full-path config for you.

Then **restart Claude Desktop**.

</details>

<details>
<summary><b>GitHub Copilot CLI</b></summary>

Inside a `copilot` session, type `/mcp add` to open the interactive form:

- **Server Name:** `routeros-rosetta`
- **Server Type:** 2 (STDIO)
- **Command:** `bunx @tikoci/rosetta`

Press <kbd>Tab</kbd> to navigate fields, <kbd>Ctrl+S</kbd> to save.

</details>

<details>
<summary><b>Cursor</b></summary>

Open **Settings → MCP** and add a new server:

```json
{
  "mcpServers": {
    "rosetta": {
      "command": "bunx",
      "args": ["@tikoci/rosetta"]
    }
  }
}
```

</details>

<details>
<summary><b>OpenAI Codex</b></summary>

```sh
codex mcp add rosetta -- bunx @tikoci/rosetta
```

> **Note:** ChatGPT Apps require a remote HTTPS MCP endpoint and cannot use local stdio servers like this one. Codex (CLI and desktop app) supports stdio and works with `bunx`.

</details>

**That's it.** First launch takes a moment to download the database; subsequent starts are instant. The database is stored in `~/.rosetta/ros-help.db`.

> **Verify it works:** Run `bunx @tikoci/rosetta --setup` to see the database status and print config for all MCP clients.
>
> **Auto-update:** `bunx` checks the npm registry each session and uses the latest published version automatically. No manual update needed. (Note: the `~/.rosetta/ros-help.db` database persists across updates — it's re-downloaded only when missing or when you run `--setup --force`.)

### Option B: Pre-built binary (no runtime needed)

Download a compiled binary from [Releases](https://github.com/tikoci/rosetta/releases) — no Bun, Node.js, or other tools required.

**1. Download** the ZIP for your platform from the [latest release](https://github.com/tikoci/rosetta/releases/latest):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `rosetta-macos-arm64.zip` |
| macOS (Intel) | `rosetta-macos-x64.zip` |
| Windows | `rosetta-windows-x64.zip` |
| Linux | `rosetta-linux-x64.zip` |

Extract the ZIP to a permanent location (e.g., `~/rosetta` or `C:\rosetta`).

**2. Run setup** to download the database and see MCP client config:

```sh
./rosetta --setup
```

On Windows: `.\rosetta.exe --setup`

> **macOS Gatekeeper:** If macOS blocks the binary: `xattr -d com.apple.quarantine ./rosetta` or go to **System Settings → Privacy & Security → Allow Anyway**.
>
> **Windows SmartScreen:** Click **More info → Run anyway**.

**3. Configure your MCP client** using the config printed by `--setup`. It uses the full path to the binary — paste it into your MCP client's config as shown.

### Try It

Ask your AI assistant questions like:

- *"What are the DHCP server properties in RouterOS?"*
- *"How do I set up a bridge VLAN?"*
- *"Is the /container command available in RouterOS 7.12?"*
- *"What are the firewall filter default chains?"*
- *"Show me warnings about hardware offloading"*
- *"Which MikroTik routers have L3HW offload, and more than 8 ports of 48V PoE? Include cost."*

## MCP Tools

The server provides 11 tools, designed to work together:

| Tool | What it does |
|------|-------------|
| `routeros_search` | **Start here.** Full-text search across all pages with BM25 ranking |
| `routeros_get_page` | Retrieve full page content by ID or title. Section-aware for large pages |
| `routeros_lookup_property` | Look up a property by exact name (type, default, description) |
| `routeros_search_properties` | Search across 4,860 property names and descriptions |
| `routeros_command_tree` | Browse the `/ip/firewall/filter` style command hierarchy |
| `routeros_search_callouts` | Search warnings, notes, and tips across all pages |
| `routeros_search_changelogs` | Search parsed changelog entries — filter by version range, category, breaking changes |
| `routeros_command_version_check` | Check which RouterOS versions include a command |
| `routeros_device_lookup` | Hardware specs for 144 MikroTik products — filter by architecture, RAM, storage, PoE, wireless, LTE |
| `routeros_stats` | Database health: page/property/command counts, coverage stats |
| `routeros_current_versions` | Fetch current RouterOS versions from MikroTik (live) |

The AI assistant typically starts with `routeros_search`, then drills into specific pages, properties, or the command tree based on what it finds. Each tool's description includes workflow hints (e.g., "→ use `routeros_get_page` to read full content") and empty-result suggestions so the AI knows how to chain tools together — this is where most of the tuning effort goes.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **First launch is slow** | One-time database download (~50 MB). Subsequent starts are instant. |
| **`npx @tikoci/rosetta` fails** | This package requires Bun, not Node.js. Use `bunx` instead of `npx`. |
| **`npm install -g` then `rosetta` fails** | Global npm install works if Bun is on PATH — it delegates to `bun` at runtime. But prefer `bunx` — it's simpler and auto-updates. |
| **ChatGPT Apps can't connect with `bunx @tikoci/rosetta`** | Expected: ChatGPT Apps supports remote HTTPS MCP endpoints, not local stdio command launch. Use OpenAI Codex for local stdio, or deploy/tunnel a remote MCP URL for ChatGPT. |
| **Claude Desktop can't find `bunx`** | Claude Desktop on macOS may not inherit shell PATH. Use the full path to bunx (run `which bunx` to find it, typically `~/.bun/bin/bunx`). `bunx @tikoci/rosetta --setup` prints the full-path config. |
| **macOS Gatekeeper blocks binary** | Use `bunx` install (no Gatekeeper issues), or: `xattr -d com.apple.quarantine ./rosetta` |
| **Windows SmartScreen warning** | Use `bunx` install (no SmartScreen issues), or click **More info → Run anyway** |
| **How to update** | `bunx` always uses the latest published version. For binaries, re-download from [Releases](https://github.com/tikoci/rosetta/releases/latest). |

## HTTP Transport

Most MCP clients use stdio (the default). Some — like the OpenAI platform and remote/LAN setups — require an HTTP endpoint instead. Rosetta supports the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) via the `--http` flag:

```sh
rosetta --http                    # http://localhost:8080/mcp
rosetta --http --port 9090        # custom port
rosetta --http --host 0.0.0.0    # accessible from LAN
```

Then point your MCP client at the URL:

```json
{ "url": "http://localhost:8080/mcp" }
```

**Key facts:**

- **Read-only** — the server queries a local SQLite database. It does not store data, accept uploads, or modify anything.
- **No authentication** — designed for local/trusted-network use. For public exposure, put it behind a reverse proxy (nginx, caddy) with TLS and auth.
- **TLS built-in** — for direct HTTPS without a proxy: `--tls-cert cert.pem --tls-key key.pem` (or `TLS_CERT_PATH` + `TLS_KEY_PATH` env vars)
- **Defaults to localhost** — binding to all interfaces (`--host 0.0.0.0`) requires an explicit flag and logs a warning.
- **Origin validation** — rejects cross-origin requests to prevent DNS rebinding attacks.
- **Stdio remains default** — `--http` is opt-in. Existing stdio configs are unaffected.

The `PORT`, `HOST`, `TLS_CERT_PATH`, and `TLS_KEY_PATH` environment variables are supported (lower precedence than CLI flags).

## Container Images

Release CI publishes multi-arch OCI images to:

- Docker Hub: `ammo74/rosetta`
- GHCR: `ghcr.io/tikoci/rosetta`

Tags per release:

- `${version}` (example: `v0.2.1`)
- `latest`
- `sha-<12-char-commit>`

Container defaults:

- Starts in HTTP mode (`--http`) on `0.0.0.0`
- Uses `PORT` if set, otherwise 8080
- Uses HTTPS only when both `TLS_CERT_PATH` and `TLS_KEY_PATH` are set

Examples:

```sh
docker run --rm -p 8080:8080 ghcr.io/tikoci/rosetta:latest
```

```sh
docker run --rm -p 8443:8443 \
  -e PORT=8443 \
  -e TLS_CERT_PATH=/certs/cert.pem \
  -e TLS_KEY_PATH=/certs/key.pem \
  -v "$PWD/certs:/certs:ro" \
  ghcr.io/tikoci/rosetta:latest
```

## Building from Source

For contributors or when you have access to the MikroTik HTML documentation export.

### Prerequisites

- [Bun](https://bun.sh/) v1.1+
- RouterOS HTML documentation export (Confluence space export)
- Internet access to [tikoci/restraml GitHub Pages](https://tikoci.github.io/restraml/) for command-tree extraction

`make extract` and `make extract-full` fetch `inspect.json` from restraml GitHub Pages by default. You can still pass a local source explicitly:

```sh
bun run src/extract-commands.ts /path/to/restraml/docs/7.22.1/extra/inspect.json
bun run src/extract-all-versions.ts /path/to/restraml/docs
```

### Build

```sh
git clone https://github.com/tikoci/rosetta.git
cd rosetta
bun install
```

Place the Confluence HTML export in `box/documents-export-<date>/ROS/` and symlink `box/latest` to it:

```sh
ln -s documents-export-<date> box/latest
```

Then:

```sh
make extract       # HTML → properties → commands (single version) → link
# or
make extract-full  # Same but with all 46 RouterOS versions
```

### Development

```sh
bun test             # Run tests (in-memory SQLite, no DB needed)
bun run typecheck    # Type check
make lint            # Biome linter
bun run src/mcp.ts   # Start MCP server in dev mode
```

The repo includes `.vscode/mcp.json` — opening the folder in VS Code automatically configures Copilot to use the dev server.

### Creating a Release

The Makefile handles the full release flow — preflight checks, cross-compile, git tag, push, and GitHub Release upload:

```sh
make release VERSION=v0.1.0
```

This cross-compiles to macOS (arm64 + x64), Windows (x64), and Linux (x64), creates ZIP archives, compresses the database, tags the commit, and creates a GitHub Release with all artifacts.

The release workflow also publishes OCI images to Docker Hub (`ammo74/rosetta`) and GHCR (`ghcr.io/tikoci/rosetta`) using crane (no Docker daemon required in CI).

## Project Structure

```text
src/
├── mcp.ts                  # MCP server (11 tools, stdio + HTTP) + CLI dispatch
├── setup.ts                # --setup: DB download + MCP client config
├── query.ts                # NL → FTS5 query planner, BM25 ranking
├── db.ts                   # SQLite schema, WAL mode, FTS5 triggers
├── extract-html.ts         # Confluence HTML → pages + callouts
├── extract-properties.ts   # Property table extraction
├── extract-commands.ts     # inspect.json → commands (version-aware)
├── extract-all-versions.ts # Batch extract all 46 versions
├── extract-devices.ts      # Product matrix CSV → devices table
├── link-commands.ts        # Command ↔ page mapping
└── query.test.ts           # Tests (in-memory SQLite fixtures)

scripts/
└── build-release.ts        # Cross-compile + package releases
└── container-entrypoint.sh # OCI image runtime entrypoint (HTTP default)
```

## Data Sources

The database combines three sources of MikroTik data into a single SQLite file with full-text search ([FTS5](https://www.sqlite.org/fts5.html) with [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer) and [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function)):

- **HTML Documentation** — Confluence space export from help.mikrotik.com (March 2026). The 317 pages are broken out several ways: by section heading, callout boxes (warnings, tips, notes), and property tables (attribute name/type/default/description). This is the richest source — ~515K words of official documentation with direct links back to help.mikrotik.com.

- **Command Tree** — `inspect.json` files from [tikoci/restraml](https://github.com/tikoci/restraml), which runs `/console/inspect` requests (`child`, `syntax`, `completion`) against RouterOS CHR under QEMU via GitHub Actions for every version since 7.9. This gives the MCP server structured knowledge of whether a command or argument exists in a particular version (46 versions tracked: 7.9–7.23beta2). The blind spot: these come from CHR with all extra-packages on x86, so commands from packages not available on CHR (like `zerotier` and Wi-Fi driver packages) are missing — the HTML docs cover those.

- **Product Matrix** — CSV export from mikrotik.com/products/matrix (144 products, 34 columns). Hardware specs, license levels, and pricing — lets the AI answer questions like *"Which routers have L3HW offload and 8+ ports of 48V PoE?"* The CSV requires manual download (the old POST API was removed when the site was redesigned in late 2025).

Documentation covers RouterOS **v7 only** and aligns with the long-term release (~7.22) at export time. v6 had different syntax and major subsystems — answers for v6 are unreliable.

## Database (Standalone)

The SQLite database is distributed separately from the MCP server code via GitHub Releases:

```text
https://github.com/tikoci/rosetta/releases/latest/download/ros-help.db.gz
```

The MCP server downloads this automatically on first run (or via `--setup`), but the database is usable on its own with any SQLite client:

```sh
sqlite3 ros-help.db "SELECT title, url FROM pages_fts WHERE pages_fts MATCH 'DHCP lease' ORDER BY rank LIMIT 5;"
```

### Tables

| Table | Rows | What's in it |
|-------|------|-------------|
| `pages` | 317 | Documentation pages — title, breadcrumb path, full text, code blocks, help.mikrotik.com URL |
| `sections` | 2,984 | Page chunks split by h1–h3 headings, with anchor IDs for deep linking |
| `callouts` | 1,034 | Warning/Note/Info/Tip boxes extracted from Confluence callout macros |
| `properties` | 4,860 | Command properties — name, type, default value, description (from doc tables) |
| `commands` | 40K+ | RouterOS command hierarchy — dirs, commands, arguments from `/console/inspect` |
| `command_versions` | 1.67M | Junction table: which command paths exist in which RouterOS versions (7.9–7.23beta2) |
| `ros_versions` | 46 | Tracked RouterOS versions with channel (stable/development) |
| `devices` | 144 | MikroTik hardware — CPU, RAM, storage, ports, PoE, wireless, license level, MSRP |

Each content table has a corresponding [FTS5](https://www.sqlite.org/fts5.html) index (e.g., `pages_fts`, `properties_fts`, `devices_fts`) using the [porter](https://www.sqlite.org/fts5.html#porter_tokenizer) stemming tokenizer for natural language search with [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function).

## License

MIT
