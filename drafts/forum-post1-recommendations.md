RouterOS is one of the topics LLMs are *worst* at — not because they've seen
too little, but because they've seen too much of the **wrong** material: years
of `wiki.mikrotik.com` (mostly v6) and the retired Confluence help site, plus a
decade of forum snippets. So they confidently hand you v6 syntax for a v7 box,
or invent properties that never existed.

MikroTik's new manual fixes the *supply side* of this: every page is now
published in machine-readable form specifically so assistants can read it. The
job left to us is the *demand side* — telling the LLM to actually go read it.
Here's how, from lightest to heaviest.

> **First, know what your tool can do.** A prompt only helps if the tool can
> fetch a URL. If it can't, the prompt just makes it *more careful* — it can't
> read a page it can't reach.

| Your tool | Fetches live URLs? | Use |
|---|---|---|
| ChatGPT (browsing on), Claude.ai, Gemini, Perplexity, Copilot | Yes | A or B |
| Claude Code/Desktop, Cursor, Codex, custom agents | Yes — best fit | A + D |
| Offline / local models (Ollama, LM Studio), no-browse chat | **No** | C |

---

### A — Paste once into "custom instructions" / system prompt (heavy users)

```text
You are helping with MikroTik RouterOS. Assume RouterOS v7 unless I say otherwise.

Your training data is unreliable for RouterOS: it is dominated by the old
wiki.mikrotik.com (mostly v6) and the retired Confluence help site, so you tend
to mix v6 and v7 syntax and invent commands or properties. Do not trust your
memory for exact syntax.

The current authoritative source is MikroTik's new manual, which publishes a
machine-readable copy of every page:

  - https://manual.mikrotik.com/llms.txt       index of every page (start here)
  - https://manual.mikrotik.com/llms-full.txt  the whole manual in one file
  - add ".md" to any docs URL                  clean Markdown of that page
       e.g. https://manual.mikrotik.com/docs/introduction.md
  - https://manual.mikrotik.com/docs/cli-reference/   command / menu / argument
       reference, increasingly generated from RouterOS itself

For every RouterOS question:
  1. Fetch /llms.txt and pick the relevant page(s).
  2. Fetch the ".md" version of those page(s) for the actual content.
  3. For exact command paths, property names, argument types and enum values,
     check the CLI Reference and match what it defines — do not invent flags.
  4. Cite the page(s) you used.
  5. If you could not fetch the docs, say so and answer from memory only with a
     warning — never present unverified syntax as fact.
```

---

### B — Per-question snippet (when you can't set a system prompt)

```text
Before answering, fetch https://manual.mikrotik.com/llms.txt, find the page that
matches my question, and read its ".md" version (append .md to the URL). For
exact command/property/enum syntax check https://manual.mikrotik.com/docs/cli-reference/
and don't invent properties. Assume RouterOS v7, cite the page you used, and if
you can't reach the docs say so instead of guessing — your RouterOS training data
is mostly old v6 wiki content.

My question: <your question here>
```

---

### C — No web access (offline, local model, or privacy-sensitive)

The prompt can't help a model that can't browse — feed it the docs yourself:

```bash
# whole manual as one file (large) — paste the relevant part as context
curl -L https://manual.mikrotik.com/llms-full.txt -o routeros-manual.txt

# or just the page you need, as clean Markdown
curl -L https://manual.mikrotik.com/docs/<path>.md
```

Paste the relevant section into the chat before your question. The same
`llms-full.txt` is also what you'd index for a local RAG setup.

---

### D — Agentic / MCP tools (where this *really* pays off)

Tools that fetch on a loop — Claude Code/Desktop, Cursor, Codex, Perplexity,
or any custom agent — can run the whole `llms.txt → .md → cli-reference`
workflow themselves, no re-pasting. Option A as the system prompt + any generic
"fetch"/web tool is usually enough.

If you'd rather not have the model crawl HTML at all, there's a ready-made
RouterOS-docs MCP I maintain — **rosetta** (https://github.com/tikoci/rosetta) —
that exposes RouterOS docs, the full command tree across many versions,
changelogs, and hardware specs as MCP search tools:

```bash
bunx @tikoci/rosetta --setup     # local stdio MCP for Claude Code/Desktop, Cursor, Codex…
```

It even installs *on the router* via `/app` (RouterOS 7.22+), so any AI assistant
on your LAN can query it. (Honest note: rosetta still indexes the prior doc export
and is mid-migration to manual.mikrotik.com — but the command tree and version
data come straight from the router.)

---

### One trick: verify it actually read the docs

Ask: *"Which manual.mikrotik.com page did you read, and quote its first line."*
If it can't name a real page or quote it, it answered from memory — treat the
syntax as unverified.

The single highest-value instruction in all of the above is **"check the CLI
Reference and don't invent properties."** Most RouterOS hallucinations are at
the property/path/enum level, and that's exactly what the CLI Reference pins down.
