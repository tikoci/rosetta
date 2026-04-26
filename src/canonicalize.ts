/**
 * RouterOS CLI path canonicalizer.
 *
 * Maps any CLI-ish input form to canonical `{ path, verb, args }` tuples that
 * rosetta can `WHERE path = ?` on. Handles:
 *
 * - Absolute paths: `/ip/address/set`, `/ip address set`
 * - Relative paths with cwd: `set` with cwd `/ip/address`
 * - Mixed slash/space: `/ip firewall/filter/add`
 * - `..` navigation: `../route print` from `/ip/address`
 * - `[...]` subshells (nested commands inheriting outer path context)
 * - `{ }` blocks (path persists from the prefix before the block)
 * - `;` and newline command separators
 * - Missing leading slash tolerance: `ip address print`
 * - Slash-only shortcut: `/` = root
 *
 * This module is intentionally pure — no DB, no I/O. It knows nothing about
 * REST API mapping. Consumers use the canonical paths for DB lookups.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CanonicalCommand {
  /** Absolute dir path, e.g. '/ip/address'. Always starts with '/'. */
  path: string;
  /** The command verb, e.g. 'set', 'print', 'add'. Empty string for bare navigation. */
  verb: string;
  /** Raw argument tokens after the verb (unparsed key=value pairs, unnamed params, etc.) */
  args: string[];
  /** For subshell commands extracted from [...], this is true */
  subshell?: boolean;
  /**
   * How well-formed the extraction was. Lets consumers filter prose-extracted
   * results when they need higher precision (e.g. LSP hover).
   * - 'high'   — absolute path with directly-identified verb (well-formed CLI)
   * - 'medium' — relative-with-cwd, pure navigation, or block/subshell context
   * - 'low'    — verb was inferred from a trailing path segment at flush time,
   *              i.e. extracted from looser/prose-shaped input
   */
  confidence: 'high' | 'medium' | 'low';
}

export interface ParseResult {
  /** All commands extracted from the input, in order */
  commands: CanonicalCommand[];
  /**
   * Every distinct path the input *referenced* — including bare navigation
   * (e.g. `/ip/firewall/filter` with no verb). Superset of `commands[i].path`.
   * Used by `extractMentions()` for "what does this text reference?" queries.
   */
  mentions: string[];
  /** The cwd after executing all navigation (useful for interactive sessions) */
  finalPath: string;
}

/**
 * Optional behaviour knobs. Keeping the module pure: the resolver is supplied
 * by the caller, never imported. rosetta wires a DB-backed resolver against
 * its `commands` table; lsp-routeros-ts wires a static `verbs.json`-backed
 * one. The built-in universal-verb-set heuristic always remains active so
 * resolvers only need to supply path-specific verbs, not every common command.
 */
export interface CanonicalizeOptions {
  /**
   * Path-aware verb classifier. Called when the parser is deciding whether a
   * token at the end of an in-flight command is a verb or another path
   * segment. Return `true` to treat `token` as the verb.
   *
   * `parentPath` is the absolute dir path the verb would attach to (the
   * resolved path of all path segments seen so far, *without* this token).
   * MUST be synchronous and side-effect-free.
   *
   * The small built-in universal verb set (GENERAL_COMMANDS + EXTRA_VERBS)
   * is checked first; this resolver supplements it for path-context-specific
   * verbs. That keeps callers from having to enumerate ubiquitous helpers
   * like `find` while still allowing DB/live-router precision for ambiguous
   * tokens (see issue #5, finding #4).
   */
  isVerb?: (token: string, parentPath: string) => boolean;
}

// ---------------------------------------------------------------------------
// Known RouterOS general commands (verbs).
// These appear at every menu level.  Used to distinguish "is this token a
// path segment or a command verb?"
// ---------------------------------------------------------------------------

const GENERAL_COMMANDS = new Set([
  'add', 'clear', 'comment', 'disable', 'edit', 'enable', 'export', 'find',
  'get', 'move', 'print', 'remove', 'reset', 'reset-counters',
  'reset-counters-all', 'set', 'unset',
]);

// Verbs that are NOT in this set despite being common at certain menus:
//   'info', 'warning', 'error', 'debug' — used by /log, but `info` is also a
//     dir at /interface/wireless, and /error is itself a top-level cmd.
//     Adding them here would mis-resolve those paths. Use a path-aware verb
//     resolver (see CanonicalizeOptions.isVerb) for menu-specific verbs.

/**
 * Commands that are clearly verbs even though they only appear at certain
 * menu levels.  We keep this small — the heuristic is "if in doubt, treat
 * as path segment" because the DB lookup will resolve ambiguity.
 */
const EXTRA_VERBS = new Set([
  'monitor', 'monitor-traffic', 'scan', 'run', 'start', 'stop',
  'flush', 'release', 'renew', 'upgrade', 'downgrade', 'reboot',
  'shutdown', 'check-for-updates',
]);

function isKnownVerb(token: string): boolean {
  return GENERAL_COMMANDS.has(token) || EXTRA_VERBS.has(token);
}

// ---------------------------------------------------------------------------
// Tokenizer — splits a RouterOS command line into meaningful tokens
// ---------------------------------------------------------------------------

/** Token types emitted by the tokenizer */
enum Tok {
  Word,       // any identifier / path-segment / value
  Slash,      // /
  Semicolon,  // ;
  LBracket,   // [
  RBracket,   // ]
  LBrace,     // {
  RBrace,     // }
  Equals,     // = (attached to preceding word)
  Newline,    // \n
  Colon,      // : (ICE command prefix)
  DotDot,     // ..
}

interface Token {
  type: Tok;
  value: string;
}

/**
 * Tokenize a RouterOS CLI input string.
 * This is intentionally loose — we don't need a full parser, just enough
 * structure to extract paths and verbs.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  // Strip leading BOM (U+FEFF) — common when input is read from a UTF-8 file
  // with a BOM marker. Without this, the BOM ends up embedded in the first
  // path segment.
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // Skip whitespace (except newlines).
    // Backticks (`) are treated as whitespace so markdown-style snippets like
    // `/ip/address/print` extract cleanly from prose.
    // Zero-width space (U+200B) is also stripped — sometimes copy-pasted from
    // documentation and otherwise pollutes path segments.
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '`' || ch === '​') { i++; continue; }

    // Newline
    if (ch === '\n') { tokens.push({ type: Tok.Newline, value: '\n' }); i++; continue; }

    // Line continuation
    if (ch === '\\' && i + 1 < len && input[i + 1] === '\n') { i += 2; continue; }

    // Comments
    if (ch === '#') {
      while (i < len && input[i] !== '\n') i++;
      continue;
    }

    // Structural tokens
    if (ch === '[') { tokens.push({ type: Tok.LBracket, value: '[' }); i++; continue; }
    if (ch === ']') { tokens.push({ type: Tok.RBracket, value: ']' }); i++; continue; }
    if (ch === '{') { tokens.push({ type: Tok.LBrace, value: '{' }); i++; continue; }
    if (ch === '}') { tokens.push({ type: Tok.RBrace, value: '}' }); i++; continue; }
    if (ch === ';') { tokens.push({ type: Tok.Semicolon, value: ';' }); i++; continue; }

    // Slash (path separator or root)
    if (ch === '/') { tokens.push({ type: Tok.Slash, value: '/' }); i++; continue; }

    // .. (parent navigation)
    if (ch === '.' && i + 1 < len && input[i + 1] === '.') {
      tokens.push({ type: Tok.DotDot, value: '..' });
      i += 2;
      continue;
    }

    // : prefix for ICE commands
    if (ch === ':') { tokens.push({ type: Tok.Colon, value: ':' }); i++; continue; }

    // Quoted string — consume as a single word token
    if (ch === '"') {
      let str = '';
      i++; // skip opening quote
      while (i < len && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < len) {
          str += input[i] + input[i + 1];
          i += 2;
        } else {
          str += input[i];
          i++;
        }
      }
      if (i < len) i++; // skip closing quote
      tokens.push({ type: Tok.Word, value: `"${str}"` });
      continue;
    }

    // Word — identifier, number, IP, key=value, etc.
    // A word can contain letters, digits, hyphens, underscores, dots, colons (for IPs),
    // asterisks (for IDs like *1), plus, @, etc.
    // It ends at whitespace, structural chars, or a slash.
    let word = '';
    while (i < len) {
      const c = input[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
      // Treat the same as outer loop: backtick + ZWSP are whitespace inside words too,
      // so trailing markdown markers don't get glued onto path segments.
      if (c === '`' || c === '​') break;
      if (c === '[' || c === ']' || c === '{' || c === '}' || c === ';') break;
      if (c === '#') break;
      // Slash breaks a word UNLESS it's inside a CIDR or we're at a slash
      // that starts a new path segment mid-word (like firewall/filter)
      if (c === '/') {
        // If the previous char was a digit and next is a digit, it's a CIDR mask
        if (word.length > 0 && /\d$/.test(word) && i + 1 < len && /\d/.test(input[i + 1])) {
          word += c;
          i++;
          continue;
        }
        break;
      }
      // Equals sign — if it's part of key=value, include the key part
      if (c === '=') {
        word += c;
        i++;
        // Consume the value after = as part of this word.
        // If the value starts with [ it's a subshell — emit the key= as a word,
        // then let the structural token handler deal with [ and ].
        if (i < len && input[i] === '[') {
          tokens.push({ type: Tok.Word, value: word });
          word = '';
          break;
        }
        // Otherwise consume the plain value up to the next separator
        while (i < len) {
          const vc = input[i];
          if (vc === '"') {
            // consume quoted string
            word += vc;
            i++;
            while (i < len && input[i] !== '"') {
              if (input[i] === '\\' && i + 1 < len) { word += input[i] + input[i + 1]; i += 2; }
              else { word += input[i]; i++; }
            }
            if (i < len) { word += input[i]; i++; }
            continue;
          }
          if (vc === ' ' || vc === '\t' || vc === '\r' || vc === '\n' || vc === ';' || vc === '}' || vc === '{' || vc === '[' || vc === ']') break;
          word += vc;
          i++;
        }
        tokens.push({ type: Tok.Word, value: word });
        word = '';
        break;
      }
      word += c;
      i++;
    }
    if (word.length > 0) {
      tokens.push({ type: Tok.Word, value: word });
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Path normalization helpers
// ---------------------------------------------------------------------------

/** Normalize a path: ensure leading slash, no trailing slash, collapse double slashes */
function normalizePath(p: string): string {
  if (!p || p === '/') return '/';
  let result = p.startsWith('/') ? p : `/${p}`;
  // Collapse double slashes
  result = result.replace(/\/+/g, '/');
  // Remove trailing slash
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

/** Resolve `..` segments in a path */
function resolveParent(base: string): string {
  const parts = base.split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

/** Join two path segments */
function joinPath(base: string, segment: string): string {
  if (base === '/') return `/${segment}`;
  return `${base}/${segment}`;
}

// ---------------------------------------------------------------------------
// Core parser — extracts commands from token stream
// ---------------------------------------------------------------------------

interface ParseContext {
  tokens: Token[];
  pos: number;
  cwd: string;
  commands: CanonicalCommand[];
  subshell: boolean;
  options: CanonicalizeOptions;
  /**
   * Accumulator for paths the input *navigated to* — including bare
   * navigation that doesn't produce a CanonicalCommand. Surfaced via
   * `ParseResult.mentions` and `extractMentions()`.
   */
  mentions: string[];
}

/**
 * Resolve the absolute path for a token's `parentPath` argument when the
 * parser is deciding whether the token is a verb. Mirrors the resolution
 * `flushCommand` would do, *without* including the token itself.
 */
function resolveParentPath(
  commandStartPath: string,
  isAbsolute: boolean,
  pathSegments: string[],
): string {
  let p = isAbsolute ? '/' : commandStartPath;
  for (const seg of pathSegments) {
    if (seg === '..') p = resolveParent(p);
    else p = joinPath(p, seg);
  }
  return normalizePath(p);
}

/**
 * Path-aware verb check. The curated universal verb set remains active even
 * when a resolver is supplied because RouterOS introspection data does not
 * necessarily enumerate helper verbs like `find` at every parent path.
 * Resolver hits add path-specific verbs (for example, `info` at menus where
 * it is actually a command).
 */
function isVerbAt(
  token: string,
  parentPath: string,
  options: CanonicalizeOptions,
): boolean {
  return isKnownVerb(token) || options.isVerb?.(token, parentPath) === true;
}

/**
 * Parse a sequence of tokens into commands, starting from a given cwd.
 * Returns the final cwd after all commands are processed.
 *
 * This handles the RouterOS scoping rules:
 * - `/` at the start of a command resets to root
 * - Path segments before a verb navigate the cwd for that command
 * - `[...]` creates a subshell that inherits the current outer path
 * - `{ }` blocks inherit the path from the prefix before the block
 * - `;` and newline separate commands but DON'T reset path in scripts
 */
function parseCommands(ctx: ParseContext, stopAt?: Tok): string {
  let currentPath = ctx.cwd;
  let commandStartPath = currentPath;

  // Accumulates path segments for the current command line
  let pathSegments: string[] = [];
  let isAbsolute = false;
  let verb = '';
  // True when the verb was directly identified during Word handling (well-formed
  // CLI). False when the verb is inferred from the trailing path segment in
  // flushCommand — that path is prose-shaped / lower confidence.
  let verbExplicit = false;
  let args: string[] = [];
  let inCommand = false; // true once we've seen at least one token in this command
  let inIce = false; // true if we're in an ICE command (: prefix)

  function flushCommand() {
    // Build the resolved path from segments
    let resolvedPath = commandStartPath;
    if (isAbsolute) {
      resolvedPath = '/';
    }
    for (const seg of pathSegments) {
      if (seg === '..') {
        resolvedPath = resolveParent(resolvedPath);
      } else {
        resolvedPath = joinPath(resolvedPath, seg);
      }
    }
    resolvedPath = normalizePath(resolvedPath);

    if (verb || args.length > 0 || pathSegments.length > 0) {
      // If no explicit verb but we have path segments, the last segment might
      // be a verb. Use the resolver-aware check so path-specific verbs resolve
      // when a resolver is wired, while staying conservative when not.
      let verbInferred = false;
      if (!verb && pathSegments.length > 0) {
        const lastSeg = pathSegments[pathSegments.length - 1];
        if (lastSeg !== '..') {
          const parentOfLast = resolveParent(resolvedPath);
          if (isVerbAt(lastSeg, parentOfLast, ctx.options)) {
            verb = lastSeg;
            verbInferred = true;
            // Remove the verb from the resolved path
            resolvedPath = parentOfLast;
          }
        }
      }

      if (verb || args.length > 0) {
        // Confidence:
        //  - 'low'    when the verb was inferred from a trailing path segment
        //             at flush time (looser/prose-shaped input)
        //  - 'high'   absolute path + directly-identified verb (well-formed)
        //  - 'medium' everything else (relative-with-cwd, navigation, blocks)
        let confidence: 'high' | 'medium' | 'low';
        if (verbInferred) {
          confidence = 'low';
        } else if (isAbsolute && verbExplicit) {
          confidence = 'high';
        } else {
          confidence = 'medium';
        }

        ctx.commands.push({
          path: resolvedPath,
          verb,
          args: [...args],
          ...(ctx.subshell ? { subshell: true } : {}),
          confidence,
        });
      }

      // Track every path the input mentions, even when no command is emitted
      // (pure navigation like `/ip/firewall/filter`). Surfaced via
      // ParseResult.mentions and extractMentions().
      if (pathSegments.length > 0 || isAbsolute) {
        ctx.mentions.push(resolvedPath);
      }

      // After a command with a verb, path does NOT change for next command in same scope
      // Only bare navigation (path without verb) changes the cwd
      if (!verb && pathSegments.length > 0) {
        // Pure navigation — update cwd
        currentPath = resolvedPath;
      }
      // If we had a verb + path prefix (like `/ip/address print`), the path prefix
      // also updates cwd for the NEXT command (RouterOS behavior: path changes on cmd line)
      if (verb && (isAbsolute || pathSegments.length > 1)) {
        // The path (without the verb) becomes the new cwd
        currentPath = resolvedPath;
      }
    }

    // Reset for next command
    pathSegments = [];
    isAbsolute = false;
    verb = '';
    verbExplicit = false;
    args = [];
    inCommand = false;
    inIce = false;
    commandStartPath = currentPath;
  }

  while (ctx.pos < ctx.tokens.length) {
    const tok = ctx.tokens[ctx.pos];

    // Stop at enclosing bracket/brace
    if (stopAt !== undefined && tok.type === stopAt) {
      break;
    }

    switch (tok.type) {
      case Tok.Semicolon:
      case Tok.Newline:
        flushCommand();
        ctx.pos++;
        break;

      case Tok.Slash:
        ctx.pos++;
        if (!inCommand) {
          // Leading / — this is an absolute path
          isAbsolute = true;
          inCommand = true;
        } else if (pathSegments.length > 0 || isAbsolute) {
          // Slash in the middle of a path sequence — next word is a path segment
          // (handled naturally by the Word case)
        }
        // Check if bare `/` (no further path tokens) — this is root navigation
        if (isAbsolute && pathSegments.length === 0) {
          const nextPos = ctx.pos;
          // Peek ahead: if next token is a command separator, end-of-input, or stopAt,
          // this is bare root navigation
          if (nextPos >= ctx.tokens.length ||
              ctx.tokens[nextPos].type === Tok.Semicolon ||
              ctx.tokens[nextPos].type === Tok.Newline ||
              (stopAt !== undefined && ctx.tokens[nextPos].type === stopAt)) {
            currentPath = '/';
            commandStartPath = '/';
            isAbsolute = false;
            inCommand = false;
          }
        }
        break;

      case Tok.DotDot:
        ctx.pos++;
        pathSegments.push('..');
        inCommand = true;
        break;

      case Tok.Colon:
        ctx.pos++;
        // ICE command prefix — skip the global/ICE command name
        inIce = true;
        inCommand = true;
        // The next word is the ICE command name (put, local, global, etc.)
        // We don't extract ICE commands as path commands — skip them
        // But they might contain subshells [...]
        if (ctx.pos < ctx.tokens.length && ctx.tokens[ctx.pos].type === Tok.Word) {
          ctx.pos++; // skip ICE command name
        }
        break;

      case Tok.LBracket: {
        ctx.pos++; // consume [
        // Subshell — inherits the in-progress resolved path, not the stale cwd.
        // Resolve what the current path would be from accumulated segments.
        let subshellCwd = commandStartPath;
        if (isAbsolute) subshellCwd = '/';
        for (const seg of pathSegments) {
          if (seg === '..') { subshellCwd = resolveParent(subshellCwd); }
          else { subshellCwd = joinPath(subshellCwd, seg); }
        }
        // If a verb has been identified, the subshell cwd is the dir path (not verb)
        subshellCwd = normalizePath(subshellCwd);
        if (verb) {
          // cwd for the subshell is the path (dir), not including the verb
          // (already computed without verb)
        }
        const subCtx: ParseContext = {
          tokens: ctx.tokens,
          pos: ctx.pos,
          cwd: subshellCwd,
          commands: ctx.commands,
          subshell: true,
          options: ctx.options,
          mentions: ctx.mentions,
        };
        parseCommands(subCtx, Tok.RBracket);
        ctx.pos = subCtx.pos;
        if (ctx.pos < ctx.tokens.length && ctx.tokens[ctx.pos].type === Tok.RBracket) {
          ctx.pos++; // consume ]
        }
        // After ], we're back in the outer command — subshell result is a value
        break;
      }

      case Tok.RBracket:
        // Should be handled by stopAt, but if we hit it unexpectedly, just stop
        flushCommand();
        return currentPath;

      case Tok.LBrace: {
        ctx.pos++; // consume {
        // Block — inherit path from current command prefix
        let blockPath = commandStartPath;
        if (isAbsolute || pathSegments.length > 0) {
          // Resolve the path prefix before the block
          blockPath = isAbsolute ? '/' : commandStartPath;
          for (const seg of pathSegments) {
            if (seg === '..') {
              blockPath = resolveParent(blockPath);
            } else {
              blockPath = joinPath(blockPath, seg);
            }
          }
          blockPath = normalizePath(blockPath);
        }
        const blockCtx: ParseContext = {
          tokens: ctx.tokens,
          pos: ctx.pos,
          cwd: blockPath,
          commands: ctx.commands,
          subshell: ctx.subshell,
          options: ctx.options,
          mentions: ctx.mentions,
        };
        parseCommands(blockCtx, Tok.RBrace);
        ctx.pos = blockCtx.pos;
        if (ctx.pos < ctx.tokens.length && ctx.tokens[ctx.pos].type === Tok.RBrace) {
          ctx.pos++; // consume }
        }
        // After { }, the path set by the prefix persists
        currentPath = blockPath;
        commandStartPath = currentPath;
        // Reset the current command line since the block consumed it
        pathSegments = [];
        isAbsolute = false;
        verb = '';
        args = [];
        inCommand = false;
        break;
      }

      case Tok.RBrace:
        flushCommand();
        return currentPath;

      case Tok.Word: {
        const w = tok.value;
        ctx.pos++;
        inCommand = true;

        if (inIce) {
          // Inside an ICE command — everything is an argument, skip
          // But still handle subshells within arguments
          break;
        }

        // Is this an argument (contains = but isn't a path)?
        if (w.includes('=') && !w.startsWith('/')) {
          args.push(w);
          break;
        }

        // Is this a known verb?
        // Recognized when we have a path prefix (explicit segments or absolute /),
        // OR when cwd is non-root (e.g., inside a subshell or script context).
        // Path-aware: consults the optional resolver against the parent path of
        // segments seen so far (without `w`), so menu-specific commands and
        // same-named directories disambiguate correctly when a resolver is wired.
        if (!verb && (pathSegments.length > 0 || isAbsolute || commandStartPath !== '/')) {
          const parentPath = resolveParentPath(commandStartPath, isAbsolute, pathSegments);
          if (isVerbAt(w, parentPath, ctx.options)) {
            verb = w;
            verbExplicit = true;
            break;
          }
        }

        // Is this an unnamed param (starts with * for item ID, or is a value after a verb)?
        if (verb) {
          args.push(w);
          break;
        }

        // If we already have path segments and this doesn't look like a path segment,
        // it might be a verb we don't know about, or an unnamed param
        if ((pathSegments.length > 0 || isAbsolute) && !w.includes('-') && !w.includes('_') &&
            w === w.toLowerCase() && w.length <= 3 && !/^[a-z]/.test(w)) {
          args.push(w);
          break;
        }

        // Must be a path segment (could also be a verb — we'll resolve at flush time)
        // Handle compound segments like "firewall/filter" (RouterOS allows spaces OR slashes)
        if (w.includes('/')) {
          const subParts = w.split('/').filter(Boolean);
          pathSegments.push(...subParts);
        } else {
          pathSegments.push(w);
        }
        break;
      }

      case Tok.Equals:
        ctx.pos++;
        break;

      default:
        ctx.pos++;
        break;
    }
  }

  // Flush any remaining command
  flushCommand();
  return currentPath;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a RouterOS CLI input string and extract canonical command tuples.
 *
 * @param input - One or more RouterOS command lines (can contain `;`, `\n`,
 *   `[...]` subshells, `{ }` blocks)
 * @param cwd - Current working directory in the menu hierarchy.
 *   Defaults to '/' (root).
 * @returns ParseResult with all extracted commands and the final path
 *
 * @example
 * ```ts
 * canonicalize('/ip/address/set .id=*1 disabled=yes')
 * // => { commands: [{ path: '/ip/address', verb: 'set', args: ['.id=*1', 'disabled=yes'] }], finalPath: '/ip/address' }
 *
 * canonicalize('set disabled=yes', '/ip/address')
 * // => { commands: [{ path: '/ip/address', verb: 'set', args: ['disabled=yes'] }], finalPath: '/ip/address' }
 *
 * canonicalize('/ip/address set [find interface=ether1] disabled=yes')
 * // => { commands: [
 * //   { path: '/ip/address', verb: 'find', args: ['interface=ether1'], subshell: true },
 * //   { path: '/ip/address', verb: 'set', args: ['disabled=yes'] },
 * // ], finalPath: '/ip/address' }
 * ```
 */
export function canonicalize(
  input: string,
  cwd = '/',
  options: CanonicalizeOptions = {},
): ParseResult {
  const tokens = tokenize(input);
  const ctx: ParseContext = {
    tokens,
    pos: 0,
    cwd: normalizePath(cwd),
    commands: [],
    subshell: false,
    options,
    mentions: [],
  };
  const finalPath = parseCommands(ctx);
  // Dedupe mentions in order of first appearance
  const seenMentions = new Set<string>();
  const mentions: string[] = [];
  for (const m of ctx.mentions) {
    if (!seenMentions.has(m)) {
      seenMentions.add(m);
      mentions.push(m);
    }
  }
  return {
    commands: ctx.commands,
    mentions,
    finalPath: normalizePath(finalPath),
  };
}

/**
 * Convenience: extract just the canonical paths from an input.
 * Returns unique paths in order of first appearance.
 * Useful for "what commands does this script reference?" queries.
 *
 * Only includes paths attached to a verb. For navigation-only mentions
 * (e.g. bare `/ip/firewall/filter`), use {@link extractMentions}.
 */
export function extractPaths(
  input: string,
  cwd = '/',
  options: CanonicalizeOptions = {},
): string[] {
  const { commands } = canonicalize(input, cwd, options);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const cmd of commands) {
    const full = cmd.verb ? `${cmd.path}/${cmd.verb}` : cmd.path;
    const normalized = normalizePath(full);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  return paths;
}

/**
 * "What does this text reference?" — every distinct RouterOS path the input
 * mentions, including bare navigation with no verb (e.g. `/ip/firewall/filter`
 * sitting alone in prose). Superset of {@link extractPaths}.
 *
 * Useful for the rosetta classifier, LSP document-link providers, and
 * MCP context feeders that want to surface every path the user gestured at,
 * not just well-formed CLI commands.
 *
 * @example
 * ```ts
 * extractMentions('/ip/firewall/filter ; /ip/firewall/nat')
 * // => ['/ip/firewall/filter', '/ip/firewall/nat']
 * ```
 */
export function extractMentions(
  input: string,
  cwd = '/',
  options: CanonicalizeOptions = {},
): string[] {
  const { commands, mentions } = canonicalize(input, cwd, options);
  const seen = new Set<string>();
  const out: string[] = [];
  // Verbed paths first (commands carry richer signal), then bare mentions.
  for (const cmd of commands) {
    const full = cmd.verb ? `${cmd.path}/${cmd.verb}` : cmd.path;
    const normalized = normalizePath(full);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
    // Also surface the dir path itself (not just path/verb) so
    // /ip/firewall/filter/print also mentions /ip/firewall/filter.
    if (cmd.verb && !seen.has(cmd.path)) {
      seen.add(cmd.path);
      out.push(cmd.path);
    }
  }
  for (const m of mentions) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * Convenience: extract the primary command path (the first non-subshell command).
 * Useful for quick lookup: "what's the main path this user is asking about?"
 */
export function primaryPath(
  input: string,
  cwd = '/',
  options: CanonicalizeOptions = {},
): string | null {
  const { commands } = canonicalize(input, cwd, options);
  const primary = commands.find(c => !c.subshell) ?? commands[0];
  if (!primary) return null;
  return normalizePath(primary.path);
}

// Export for testing
export { normalizePath as _normalizePath, tokenize as _tokenize };
