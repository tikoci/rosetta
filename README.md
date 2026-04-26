# rosetta

MCP server that gives AI assistants searchable access to the complete [MikroTik RouterOS documentation](https://help.mikrotik.com/docs/spaces/ROS/overview) — 317 pages, 4,860 properties, 40,000-entry command tree, hardware specs for 144 products, 518 YouTube video transcripts, and direct links to help.mikrotik.com.

If you need MikroTik docs, you likely have a MikroTik. Install rosetta once as a container on your router using [RouterOS /app](#install-on-mikrotik-app), and any AI assistant on the network can use it. Or [run it locally](#install-locally-with-bun) on your workstation. **No AI required** — rosetta includes a [terminal browser](#browse-without-ai) for searching the database directly.

### SQL-as-RAG

Instead of vector embeddings, rosetta uses **SQLite [FTS5](https://www.sqlite.org/fts5.html) full-text search** as the retrieval layer — SQL-as-RAG. For structured technical docs, [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function) with [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer) beats vector similarity: terms like `dhcp-snooping` and `/ip/firewall/filter` are exact tokens, not fuzzy embeddings. No API keys, no vector database — just a single SQLite file that searches in milliseconds.

### What's Inside

| Data Source | Coverage |
|-------------|----------|
| Documentation pages | 317 pages (~515K words) from help.mikrotik.com |
| Property definitions | 4,860 with types, defaults, descriptions |
| Command tree | 5,114 commands, 551 dirs, 34K arguments |
| Version history | 46 RouterOS versions tracked (7.9–7.23beta2) |
| Hardware products | 144 devices — specs, pricing, block diagrams |
| Performance benchmarks | 2,874 tests across 125 devices (ethernet + IPSec) |
| YouTube transcripts | 518 videos, ~1,890 chapter-level segments |
| Callout blocks | 1,034 warnings, notes, and tips |

Documentation covers RouterOS **v7 only**, aligned with the long-term release (~7.22) at export time.

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

> **Browse the database from the router:** If rosetta is running as a `/app`, you can use `/container/shell` to access the TUI browser directly:
> ```routeros
> /container/shell app-rosetta
> # /app/rosetta browse
> ```

---

## Install Locally (with Bun)

Run rosetta on your workstation using [Bun](https://bun.sh/). The MCP server runs over stdio — no network configuration needed. The database downloads automatically on first launch (~50 MB compressed).

### Quick setup

```sh
bunx @tikoci/rosetta --setup
```

This downloads the database and prints config snippets for all supported MCP clients. Copy-paste the config for your client and you're done.

Need to force a database reload later? Use:

```sh
bunx @tikoci/rosetta --refresh
```

### Configure your MCP client

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

---

## Browse Without AI

Rosetta includes a terminal-based "card catalog" browser — **no AI assistant or MCP client required**. It searches the same database the MCP tools use, with a keyboard-driven REPL modeled after a 1980s library terminal.

```sh
bunx @tikoci/rosetta browse
```

Type a search query to find documentation pages, then select a numbered result to drill in. Beyond page search, the browser covers every data source in the database:

| Command | What it searches |
|---------|-----------------|
| *(bare text)* | Documentation pages (default) |
| `dev <query>` | Device hardware specs, block diagrams, benchmarks |
| `cmd [path]` | Command tree hierarchy |
| `prop <name>` | Property definitions (scoped to current page when viewing one) |
| `cal [query]` | Warnings, notes, and tips |
| `cl [version]` | Changelogs — `cl breaking` for breaking changes only |
| `vid <query>` | YouTube video transcripts with timestamped chapter links |
| `diff <from> <to>` | Command tree diff between RouterOS versions |
| `tests [type]` | Cross-device performance benchmarks |
| `ver` | Live-fetch current RouterOS versions |

Type `help` for the full command list. URLs are clickable in terminals that support OSC 8 hyperlinks (iTerm2, Windows Terminal, GNOME Terminal, etc.).

The browser is also useful as a test harness — it interacts with the data the same way an AI agent would through MCP, so gaps or rough edges visible here often point to MCP tool improvements too.

> **From a router:** If rosetta is installed as a `/app`, access the browser via `/container/shell app-rosetta` then `/app/rosetta browse`.

---

## Try It

Ask your AI assistant questions like:

- *"What are the DHCP server properties in RouterOS?"*
- *"How do I set up a bridge VLAN?"*
- *"Is the /container command available in RouterOS 7.12?"*
- *"Show me warnings about hardware offloading"*
- *"Which MikroTik routers have L3HW offload, and more than 8 ports of 48V PoE? Include cost."*
- *"Compare the RB5009 and CCR2004 IPSec throughput at 1518-byte packets."*
- *"My BGP routes stopped working after upgrading from 7.15 to 7.22 — what changed in the routing commands?"*

## MCP Tools

The server exposes 14 tools designed to work together — agents start with `routeros_search` and drill into specific data as needed:

| Tool | What it does |
|------|-------------|
| `routeros_search` | **Start here.** Unified search with input classifier — returns pages + related callouts, videos, properties, changelogs, devices, skills |
| `routeros_get_page` | Full page content by ID or title, section-aware for large pages |
| `routeros_lookup_property` | Property by exact name — type, default, description |
| `routeros_explain_command` | Read-only explanation for a CLI command — canonical path/verb, args, warnings, docs, changelogs |
| `routeros_command_tree` | Browse the command hierarchy (`/ip/firewall/filter` style) |
| `routeros_search_changelogs` | Changelogs filtered by version range, category, breaking flag |
| `routeros_command_version_check` | Which RouterOS versions include a command path |
| `routeros_command_diff` | Added/removed commands between two RouterOS versions |
| `routeros_device_lookup` | Hardware specs — filter by architecture, RAM, PoE, wireless, etc. |
| `routeros_search_tests` | Cross-device ethernet and IPSec benchmarks |
| `routeros_dude_search` | FTS across archived Dude wiki docs (separate from RouterOS search) |
| `routeros_dude_get_page` | Full Dude wiki page by ID or title, with screenshot metadata |
| `routeros_stats` | Database health and coverage stats |
| `routeros_current_versions` | Live-fetch current RouterOS versions from MikroTik |

Each tool description includes workflow arrows (`→ next_tool`) and empty-result hints so agents chain tools effectively.

The server also exposes **MCP Resources** for bulk data and supplemental content — CSV datasets (`rosetta://datasets/...`), schema documentation (`rosetta://schema...`), and **agent skill guides** (`rosetta://skills/{name}`) from [tikoci/routeros-skills](https://github.com/tikoci/routeros-skills). Skills are community-created, human-reviewed guides served with provenance attribution. See [MANUAL.md](MANUAL.md) for details.


## RTFM for Details
For additional install options, HTTP transport configuration, data source details, and the database schema, see [MANUAL.md](MANUAL.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building from source, running tests, development setup, and the release process.

## License

MIT
