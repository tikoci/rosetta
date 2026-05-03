---
description: "canonicalize.ts is a vendored pure module shared by manual diff with lsp-routeros-ts; rosetta-only data wiring lives in the resolver."
applyTo: "src/canonicalize.ts, src/canonicalize-resolver.ts, src/canonicalize.test.ts, src/canonicalize.fuzz.test.ts, src/query.ts, src/classify.ts, DESIGN.md"
---
# Canonicalizer vendoring contract

`src/canonicalize.ts` stays DB-free and mirrorable with `tikoci/lsp-routeros-ts`.

- Parser/tokenizer/path-resolution changes should be easy for the LSP repo to copy by diff.
- Rosetta-specific data access belongs in `src/canonicalize-resolver.ts` or higher-level query wiring, not in the pure module.
- Keep the resolver as an augmentation of the curated universal verb set, not a replacement.
- If an issue #5 hardening lands, update both the focused canonicalizer tests and the matching fuzz anchor.
