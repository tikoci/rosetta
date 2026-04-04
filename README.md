# rosetta

MCP server that gives AI assistants searchable access to the complete [MikroTik RouterOS documentation](https://help.mikrotik.com/docs/spaces/ROS/overview) — 317 pages, 4,860 properties, 40,000-entry command tree, hardware specs for 144 products, and direct links to help.mikrotik.com.

If you need MikroTik docs, you likely have a MikroTik. Install rosetta once as a container on your router using [RouterOS /app](#install-on-mikrotik-app), and any AI assistant on the network can use it. Or [run it locally](#install-locally-with-bun) on your workstation.

### SQL-as-RAG

Instead of vector embeddings, rosetta uses **SQLite [FTS5](https://www.sqlite.org/fts5.html) full-text search** as the retrieval layer — SQL-as-RAG. For structured technical docs, [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function) with [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer) beats vector similarity: terms like `dhcp-snooping` and `/ip/firewall/filter` are exact tokens, not fuzzy embeddings. No API keys, no vector database — just a single SQLite file that searches in milliseconds.

### What's Inside

- **317 documentation pages** from MikroTik's official help site (~515K words)
- **4,860 property definitions** with types, defaults, and descriptions
- **5,114 commands** in the RouterOS command hierarchy (551 directories, 34K arguments)
- **1,034 callout blocks** — warnings, notes, and tips with important caveats
- **144 hardware products** — CPU, RAM, storage, ports, PoE, wireless, license level, pricing
- **2,874 performance benchmarks** — ethernet and IPSec throughput test results for 125 devices (64/512/1518-byte packets, multiple routing/bridging modes), plus block diagrams for 110
- **46 RouterOS versions tracked** (7.9 through 7.23beta2) for command history
- **2 MCP CSV resources** for bulk reporting workflows: full benchmark dataset and full device catalog
- Direct links to help.mikrotik.com for every page and section

---

## Install on MikroTik (/app)

RouterOS 7.22+ includes the [/app](https://help.mikrotik.com/docs/spaces/ROS/pages/328068) feature for running containers directly on the router. This is the simplest way to deploy rosetta — install once, and any AI assistant on your network can connect to the MCP endpoint URL shown in the router UI.

**Requirements:** RouterOS 7.22+, x86 or ARM64 architecture (CCR, RB5009, hAP ax series, CHR, etc.), container package installed, device-mode enabled.

### 1. Enable containers (two reboots required)

If you haven't already enabled the container package and device-mode:

```routeros
# Install the container package (router reboots automatically)
/system/package/update/check-for-updates duration=10s
/system/package/enable container
# Apply changes restarts the router
```

After reboot:

```routeros
# Enable container device-mode (requires physical power cycle or button press — follow the on-screen prompt)
/system/device-mode/update mode=advanced container=yes
```

See MikroTik's [Container documentation](https://help.mikrotik.com/docs/spaces/ROS/pages/Container) for full prerequisites and troubleshooting.

### 2. Add the rosetta app

```routeros
/app/add use-https=yes disabled=no yaml="name: rosetta
descr: \"RouterOS Docs for AI assistants - use URL as MCP server\"
page: https://tikoci.github.io/p/rosetta
category: development
icon: https://tikoci.github.io/p/rosetta.svg
default-credentials: \"none - just use 'ui-url' as the MCP server in your AI assistant\"
url-path: /mcp
auto-update: true
services:
  rosetta:
    image: ghcr.io/tikoci/rosetta:latest
    container_name: mcp-server
    ports:
      - 9803:8080/tcp:web
"
```

That's it. RouterOS downloads the container image, configures networking and firewall redirects, and starts the MCP server. The `auto-update: true` setting pulls the latest image on each boot.

### 3. Get the MCP endpoint URL

The URL to use with your AI assistant is shown as **UI URL** in WebFig (App → rosetta), or from the CLI:

```routeros
:put [/app/get rosetta ui-url]
```

This URL includes the `/mcp` path and is ready to paste into any MCP client that supports HTTP transport. With `use-https=yes`, the URL uses HTTPS with a MikroTik-managed `*.routingthecloud.net` certificate.

### 4. Configure your AI assistant

Point any HTTP-capable MCP client at the URL from the previous step:

```json
{ "url": "https://app-rosetta.XXX.routingthecloud.net/mcp" }
```

> **CHR note:** Cloud Hosted Router in free or trial mode does not include the `/ip/cloud` service needed for HTTPS certificates. Set `use-https=no` on the /app — the URL will use HTTP instead. The UI URL always reflects the correct protocol.

> **HTTP option:** On any platform, you may choose `use-https=no` if you prefer HTTP or are on an isolated network. 

---

## Install Locally (with Bun)

Run rosetta on your workstation using [Bun](https://bun.sh/). The MCP server runs over stdio — no network configuration needed. The database downloads automatically on first launch (~50 MB compressed).

### Quick setup

```sh
bunx @tikoci/rosetta --setup
```

This downloads the database and prints config snippets for all supported MCP clients. Copy-paste the config for your client and you're done.

### Or configure manually

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

> **PATH note:** Claude Desktop on macOS doesn't always inherit your shell PATH. If `bunx` isn't found, use the full path (typically `~/.bun/bin/bunx`). Run `bunx @tikoci/rosetta --setup` to print the full-path config.

Restart Claude Desktop after editing.

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

> **Note:** ChatGPT Apps require a remote HTTPS MCP endpoint. Use the [MikroTik /app install](#install-on-mikrotik-app) or another container platform for a hosted endpoint, or Codex CLI for local stdio.

</details>

<details>
<summary><b>GitHub Copilot CLI</b></summary>

Inside a `copilot` session, type `/mcp add`:

- **Server Name:** `routeros-rosetta`
- **Server Type:** 2 (STDIO)
- **Command:** `bunx @tikoci/rosetta`

</details>

**Install Bun** (if you don't have it):

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

> **Auto-update:** `bunx` checks the npm registry each session and uses the latest published version automatically. The database in `~/.rosetta/ros-help.db` persists across updates.

### MCP Resources for Reporting

If your MCP client supports resources, rosetta also exposes two read-only CSV datasets for bulk analysis and reporting:

- `rosetta://datasets/device-test-results.csv`
- `rosetta://datasets/devices.csv`

In VS Code Copilot, attach them via **Add Context > MCP Resources** or **MCP: Browse Resources**. Use tools for normal search and drill-down; use resources when you explicitly want the whole dataset as CSV.

---

## Install from Binary

Download a compiled binary from [Releases](https://github.com/tikoci/rosetta/releases) — no Bun, Node.js, or other runtime needed.

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `rosetta-macos-arm64.zip` |
| macOS (Intel) | `rosetta-macos-x64.zip` |
| Windows | `rosetta-windows-x64.zip` |
| Linux | `rosetta-linux-x64.zip` |

```sh
./rosetta --setup    # downloads DB + prints MCP client config
```

> **macOS Gatekeeper:** `xattr -d com.apple.quarantine ./rosetta` or System Settings → Privacy & Security → Allow Anyway.
> **Windows SmartScreen:** Click **More info → Run anyway**.

---

## Try It

Ask your AI assistant questions like:

- *"What are the DHCP server properties in RouterOS?"*
- *"How do I set up a bridge VLAN?"*
- *"Is the /container command available in RouterOS 7.12?"*
- *"What are the firewall filter default chains?"*
- *"Show me warnings about hardware offloading"*
- *"Which MikroTik routers have L3HW offload, and more than 8 ports of 48V PoE? Include cost."*
- *"Compare the RB5009 and CCR2004 IPSec throughput at 1518-byte packets."*

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
| `routeros_device_lookup` | Hardware specs for 144 MikroTik products — filter by architecture, RAM, storage, PoE, wireless, LTE. Includes ethernet/IPSec benchmarks and block diagrams for most devices |
| `routeros_stats` | Database health: page/property/command counts, coverage stats |
| `routeros_current_versions` | Fetch current RouterOS versions from MikroTik (live) |

The AI assistant typically starts with `routeros_search`, then drills into specific pages, properties, or the command tree based on what it finds. Each tool's description includes workflow hints (e.g., "→ use `routeros_get_page` to read full content") and empty-result suggestions so the AI knows how to chain tools together — this is where most of the tuning effort goes.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **First launch is slow** | One-time database download (~50 MB). Subsequent starts are instant. |
| **`npx @tikoci/rosetta` fails** | This package requires Bun, not Node.js. Use `bunx` instead of `npx`. |
| **`npm install -g` then `rosetta` fails** | Global npm install works if Bun is on PATH — it delegates to `bun` at runtime. But prefer `bunx` — it's simpler and auto-updates. |
| **ChatGPT Apps can't connect** | ChatGPT Apps require a remote HTTPS MCP endpoint. Use the [MikroTik /app install](#install-on-mikrotik-app) for a hosted endpoint, or Codex CLI for local stdio. |
| **Claude Desktop can't find `bunx`** | Claude Desktop on macOS may not inherit shell PATH. Use the full path to bunx (run `which bunx` to find it, typically `~/.bun/bin/bunx`). `bunx @tikoci/rosetta --setup` prints the full-path config. |
| **macOS Gatekeeper blocks binary** | Use `bunx` install (no Gatekeeper issues), or: `xattr -d com.apple.quarantine ./rosetta` |
| **Windows SmartScreen warning** | Use `bunx` install (no SmartScreen issues), or click **More info → Run anyway** |
| **How to update** | `bunx` always uses the latest published version. For binaries, re-download from [Releases](https://github.com/tikoci/rosetta/releases/latest). MikroTik /app with `auto-update: true` pulls the latest image on each boot. |

## HTTP Transport

The [MikroTik /app install](#install-on-mikrotik-app) is the easiest way to get an HTTP endpoint. For other setups, rosetta supports the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) via `--http`:

```sh
rosetta --http                    # http://localhost:8080/mcp
rosetta --http --port 9090        # custom port
rosetta --http --host 0.0.0.0    # accessible from LAN
```

Then point your MCP client at the URL:

```json
{ "url": "http://localhost:8080/mcp" }
```

- **Read-only** — queries a local SQLite database, stores nothing.
- **No authentication** — designed for local/trusted-network use. Use a reverse proxy for public exposure.
- **TLS built-in** — `--tls-cert cert.pem --tls-key key.pem` for direct HTTPS without a proxy.
- **Defaults to localhost** — LAN binding (`--host 0.0.0.0`) requires an explicit flag.

## Container Images

Multi-arch OCI images (linux/amd64 + linux/arm64) are published with each release:

- `ghcr.io/tikoci/rosetta` (GitHub Container Registry)
- `ammo74/rosetta` (Docker Hub)

```sh
docker run --rm -p 8080:8080 ghcr.io/tikoci/rosetta:latest
```

These are the same images used by the [MikroTik /app install](#install-on-mikrotik-app). Tags: `latest`, version (e.g., `v0.2.1`), and `sha-<commit>`.

## Data Sources

The database combines multiple MikroTik data sources into a single SQLite file with [FTS5](https://www.sqlite.org/fts5.html) full-text search, [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer), and [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function):

- **HTML Documentation** — Confluence space export from help.mikrotik.com (March 2026). 317 pages broken into sections, callouts, and property tables (~515K words) with links back to help.mikrotik.com.

- **Command Tree** — `inspect.json` from [tikoci/restraml](https://github.com/tikoci/restraml), generated by running `/console/inspect` against RouterOS CHR under QEMU for every version since 7.9 (46 versions tracked: 7.9–7.23beta2).

- **Product Matrix** — CSV export from mikrotik.com/products/matrix (144 products, 34 columns). Hardware specs, license levels, and pricing.

- **Device Benchmarks** — Ethernet bridging/routing and IPSec throughput test results scraped from individual product pages on mikrotik.com (2,874 measurements across 125 devices; 64/512/1518-byte packets, multiple configurations). Also captures block diagram image URLs for 110 devices.

Documentation covers RouterOS **v7 only** and aligns with the long-term release (~7.22) at export time. v6 had different syntax and major subsystems — answers for v6 are unreliable.

## Database (Standalone)

The SQLite database is downloadable on its own from [GitHub Releases](https://github.com/tikoci/rosetta/releases):

```text
https://github.com/tikoci/rosetta/releases/latest/download/ros-help.db.gz
```

Use it with any SQLite client:

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
| `device_test_results` | 2,874 | Ethernet and IPSec throughput benchmarks for 125 devices — packet sizes, modes, Mbps/Kpps |

Each content table has a corresponding FTS5 index (e.g., `pages_fts`, `properties_fts`, `devices_fts`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building from source, running tests, development setup, and the release process.

## License

MIT
