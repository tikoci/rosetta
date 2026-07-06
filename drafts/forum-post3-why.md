Some background on *why* the prompts above are shaped the way they are. I had
Claude (Opus) cross-check the three agent answers in post #2 against the live
site and correct what they got wrong — notes below.

### The real problem isn't "too little training" — it's stale, conflicting training

LLMs haven't seen *too little* RouterOS; they've seen too much of the **wrong**
RouterOS. Their data is dominated by:

- `wiki.mikrotik.com` — voluminous, heavily mirrored, **mostly v6**, no longer updated
- the retired Confluence `help.mikrotik.com` site
- ~20 years of forum posts mixing v6 and v7

The new Docusaurus site (`manual.mikrotik.com`) is almost certainly **after most
models' training cutoff**. So the failure mode isn't "I don't know" — it's
confident v6-for-v7 answers and invented properties. That's why the prompts lead
with *"don't trust your memory"* and name the old sites explicitly: you're
overriding bad priors, not filling a blank.

### What the new site changed (and why it matters to an LLM)

MikroTik now emits a machine-readable copy of the docs on every build
(via the `docusaurus-plugin-llms` plugin):

- **`/llms.txt`** — an index of all ~558 pages as `[Title](…​.md): description`
  links, following the [llmstxt.org](https://llmstxt.org) convention. It's a
  clean, noise-free map so the model finds the right page without wading through
  HTML nav/sidebars/scripts.
- **per-page `.md`** — append `.md` to any docs URL for the raw Markdown
  (e.g. `…/docs/introduction.md`). Cheaper to read and far less ambiguous than
  rendered HTML.
- **`/llms-full.txt`** — the entire manual in one file, for bulk ingest / RAG / offline.
- **robots.txt** now explicitly welcomes the AI crawlers (ClaudeBot, GPTBot,
  PerplexityBot, Google-Extended, CCBot…) — so over time this content should
  even reach future *training* runs, not just live browsing.

### The CLI Reference is the highest-value target

Most RouterOS LLM mistakes are property-level: wrong menu path, wrong property
name, a v6-only property, an enum typo, or a flag that simply doesn't exist. The
CLI Reference documents exact menus, properties, argument types and enums — the
structured shape of the commands — which is precisely what models get wrong from
memory. Hence the prompt line *"check the CLI Reference and don't invent properties."*

One honest correction to the post-#2 answers: a couple of agents called the CLI
Reference "machine-generated." MikroTik's own words are more measured — auto-updating
the command reference from RouterOS source is *"partially started in the CLI
reference section"* (@normis). So: increasingly authoritative, not yet fully
generated. Worth checking, not yet blindly trusting for the newest features.

### Honest limits (why post #1 leads with a capability table)

- A prompt **cannot** make a non-browsing model fetch a page. For plain chat
  windows and local models it only induces caution. That's what Option C
  (paste-in / `llms-full.txt`) is for.
- Web-browsing and agentic tools (ChatGPT browsing, Claude.ai/Code, Cursor,
  Perplexity, Copilot) are where the endpoints genuinely shine — they can run
  `llms.txt → .md → cli-reference` on their own.
- Always have the model **cite and quote** the page it read. If it can't, it
  didn't read it.

### Small corrections to the agent answers in post #2

- It's **`/llms.txt`** (plural) and **`/llms-full.txt`** — not "llm.txt". The
  file and the standard are both plural.
- Don't hard-code specific argument-type names in your prompt (one agent guessed
  `iface_enum` / `ipPrefix`). The real page defines its own set (`address`,
  `bool`, `enum`, `ipAddr`, `ipv6Prefix`, …). Telling the model to *"match the
  types and enums the CLI Reference defines"* is safer than naming them.

Net: the supply side is now excellent. These prompts are just about reliably
pointing the model at it — and knowing when your tool can't follow.
