/**
 * Fuzz / robustness tests for canonicalize.ts.
 *
 * These probe the parser against pathological inputs — prose, markdown,
 * malformed scripts, RouterOS scripting constructs — to document where it
 * is robust, where it is wrong-but-quiet, and where the behaviour is
 * underspecified.
 *
 * Inputs originated from `lsp-routeros-ts/docs/canonicalize-audit.md`
 * (2026-04-25 audit) and were ported here so future fixes have a
 * regression surface.
 *
 * Conventions:
 * - `test(...)` — current behaviour (anchor test). Update if a fix
 *   intentionally changes it; add a comment noting the audit finding number.
 * - `test.todo(...)` — known-bad behaviour the audit recommended fixing.
 *   Promote to `test(...)` once the fix lands.
 *
 * Cross-ref:
 * - `lsp-routeros-ts/docs/canonicalize-audit.md` (findings #1–#12, hardenings H1–H8)
 */
import { describe, expect, test } from 'bun:test';
import { canonicalize, extractMentions, extractPaths } from './canonicalize.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paths(input: string, cwd = '/'): string[] {
  return canonicalize(input, cwd).commands.map(c =>
    c.verb ? `${c.path}/${c.verb}` : c.path,
  );
}

// ===========================================================================
// Crash-resistance — none of these may throw
// ===========================================================================
describe('does not crash on malformed input', () => {
  const torture = [
    '',
    '   \t  ',
    '# comment only',
    '/',
    '\n\n\n',
    '/system/script/add source="never ends',  // unclosed quote
    '/ip/address/set [find interface=ether1', // unclosed [
    '/ip/address { print',                    // unclosed {
    '/ip/address/print ]',                    // stray ]
    '/ip/address/print }',                    // stray }
    ';;;;',
    '\\',
    '$$$$',
    ':::::',
    '////',
    '[]{}();',
  ];
  for (const input of torture) {
    test(`no throw: ${JSON.stringify(input).slice(0, 60)}`, () => {
      expect(() => canonicalize(input)).not.toThrow();
    });
  }
});

// ===========================================================================
// H7 — BOM and zero-width characters (FIXED 2026-04-25 in tokenizer)
// ===========================================================================
describe('H7: BOM and zero-width characters', () => {
  test('BOM-prefixed input is stripped before parsing', () => {
    // U+FEFF byte-order mark prepended
    const result = canonicalize('﻿/ip/address/print');
    expect(result.commands.length).toBe(1);
    expect(result.commands[0].path).toBe('/ip/address');
    expect(result.commands[0].verb).toBe('print');
  });

  test('zero-width space is treated as whitespace', () => {
    // U+200B zero-width space between `ip` and `/`
    const result = canonicalize('/ip​/address/print');
    expect(result.commands.length).toBe(1);
    expect(result.commands[0].path).toBe('/ip/address');
    expect(result.commands[0].verb).toBe('print');
  });
});

// ===========================================================================
// Markdown backticks (FIXED 2026-04-25 — backticks now whitespace)
// ===========================================================================
describe('markdown backticks treated as whitespace', () => {
  test('inline backtick-wrapped path extracts cleanly', () => {
    const result = canonicalize('Use `/ip/address/print` to list');
    // "Use" still becomes a phantom (finding #1, see H1 lenient mode).
    // But the backticks no longer pollute the path.
    const cmd = result.commands.find(c => c.verb === 'print');
    expect(cmd).toBeDefined();
    expect(cmd?.path).toContain('/ip/address');
  });

  test('markdown fence wrapper does not break extraction', () => {
    const result = canonicalize('```routeros\n/ip/address/print\n```');
    const cmd = result.commands.find(c => c.verb === 'print');
    expect(cmd?.path).toBe('/ip/address');
  });
});

// ===========================================================================
// Universal verbs added 2026-04-25 — clear, unset, reset-counters,
// reset-counters-all (verified universal in rosetta DB; safe to add)
// ===========================================================================
describe('expanded universal verbs', () => {
  test('unset is recognised', () => {
    const r = canonicalize('/ip/address/unset disabled');
    expect(r.commands[0].path).toBe('/ip/address');
    expect(r.commands[0].verb).toBe('unset');
  });

  test('clear is recognised', () => {
    const r = canonicalize('/system/logging/action/clear name=test');
    const c = r.commands.find(x => x.verb === 'clear');
    expect(c?.path).toBe('/system/logging/action');
  });

  test('reset-counters is recognised', () => {
    const r = canonicalize('/interface/reset-counters ether1');
    expect(r.commands[0].verb).toBe('reset-counters');
    expect(r.commands[0].path).toBe('/interface');
  });

  test('reset-counters-all is recognised', () => {
    const r = canonicalize('/ip/firewall/filter/reset-counters-all');
    expect(r.commands[0].verb).toBe('reset-counters-all');
    expect(r.commands[0].path).toBe('/ip/firewall/filter');
  });
});

// ===========================================================================
// Variables: today they tolerate as-is in args; not mistaken for paths
// when AFTER a verb (because then verb is set and they fall into the
// args branch). This is the safe case.
// ===========================================================================
describe('variables in args (safe positions)', () => {
  test('$var after verb stays in args', () => {
    const r = canonicalize('/ip/address/remove $myAddr');
    expect(r.commands[0].args).toEqual(['$myAddr']);
  });

  test('$var inside subshell after verb', () => {
    const r = canonicalize('/ip/address set [find interface=$iface] disabled=yes');
    const find = r.commands.find(c => c.verb === 'find');
    expect(find?.args.some(a => a.includes('$iface'))).toBe(true);
  });
});

// ===========================================================================
// Common scripting constructs that work today
// ===========================================================================
describe(':foreach extracts inner commands', () => {
  test('extracts find subshell + remove command', () => {
    const r = canonicalize(':foreach i in=[/ip address find] do={ /ip address remove $i }');
    const find = r.commands.find(c => c.verb === 'find' && c.subshell);
    const remove = r.commands.find(c => c.verb === 'remove');
    expect(find?.path).toBe('/ip/address');
    expect(remove?.path).toBe('/ip/address');
  });
});

describe(':do { } while=', () => {
  test('extracts inner run command', () => {
    const r = canonicalize(':do { /system/script/run myscript } while=($i < 5)');
    const run = r.commands.find(c => c.verb === 'run');
    expect(run?.path).toBe('/system/script');
  });
});

describe('scheduler one-liner', () => {
  test('three semicolon-separated commands extract cleanly', () => {
    const ps = paths('/ip/firewall/filter/print; /ip/address/print; /system/identity/print');
    expect(ps).toEqual([
      '/ip/firewall/filter/print',
      '/ip/address/print',
      '/system/identity/print',
    ]);
  });
});

// ===========================================================================
// Anchor tests for known-bad behaviour (audit findings)
// These DOCUMENT current behaviour. When a hardening lands, flip them.
// ===========================================================================
describe('finding #1 — mid-line slash does not restart path (anchor)', () => {
  test('leading prose word becomes phantom path segment', () => {
    // Today: "Run" gets jammed into the path.
    // After H1 (lenient mode): would be dropped.
    const r = canonicalize('Run /ip/address/print');
    expect(r.commands[0].path).toBe('/Run/ip/address');
    expect(r.commands[0].verb).toBe('print');
  });

  test('two paths joined by " and " merge into one command', () => {
    // Today: only the first command is recognised; the second path
    // becomes positional args.
    // After H1 (lenient mode): both should extract independently.
    const r = canonicalize('/ip/address/print and /ip/route/print');
    expect(r.commands.length).toBe(1);
    expect(r.commands[0].path).toBe('/ip/address');
    expect(r.commands[0].args).toContain('and');
  });
});

describe('finding #4 — menu-specific verbs', () => {
  // Today (no resolver): zero commands. /log/info, /log/warning, /log/error
  // are not in the universal verb set so the parser treats them as paths
  // without verbs (and `info`/`warning`/`error` aren't verbs at flush time
  // either). H4 fixed this for callers that wire a resolver.
  test('/log/info "msg" without resolver produces no command (anchor)', () => {
    const r = canonicalize('/log/info "msg"');
    expect(r.commands.length).toBe(0);
  });

  // H4 — supplying a path-aware resolver makes /log/info classify correctly.
  // The resolver returns true for {info, warning, error} at /log only,
  // mirroring what rosetta's DB-backed resolver does.
  const logVerbs = new Set(['info', 'warning', 'error', 'debug']);
  const logResolver = (token: string, parentPath: string) =>
    parentPath === '/log' && logVerbs.has(token);

  test('H4: /log/info "msg" with resolver classifies as cmd', () => {
    const r = canonicalize('/log/info "msg"', '/', { isVerb: logResolver });
    expect(r.commands.length).toBe(1);
    expect(r.commands[0].path).toBe('/log');
    expect(r.commands[0].verb).toBe('info');
  });

  test('H4: /log/warning with resolver classifies as cmd', () => {
    const r = canonicalize('/log/warning "warn"', '/', { isVerb: logResolver });
    expect(r.commands[0].path).toBe('/log');
    expect(r.commands[0].verb).toBe('warning');
  });

  test('H4: /log/error with resolver classifies as cmd', () => {
    const r = canonicalize('/log/error "boom"', '/', { isVerb: logResolver });
    expect(r.commands[0].path).toBe('/log');
    expect(r.commands[0].verb).toBe('error');
  });

  test('H4: /interface/wireless/info with same resolver stays a path (info is a dir there)', () => {
    // Resolver only returns true for `info` at /log, not /interface/wireless.
    // The token `info` at /interface/wireless is therefore navigation, not
    // a verb — exactly the disambiguation H4 enables.
    const r = canonicalize('/interface/wireless/info', '/', { isVerb: logResolver });
    expect(r.commands.length).toBe(0);
    expect(r.finalPath).toBe('/interface/wireless/info');
  });

  test('H4: resolver wins over universal-verb-set when supplied', () => {
    // Even `print` should NOT be a verb when the resolver explicitly
    // refuses it (caller-authoritative semantics). Edge case but documents
    // the contract: resolver is authoritative when wired.
    const r = canonicalize('/ip/address/print', '/', {
      isVerb: () => false,
    });
    // print falls out of explicit-verb identification; flushCommand also
    // calls isVerbAt for the trailing-segment fallback, which also returns
    // false → no verb inferred, /ip/address/print is treated as nav.
    expect(r.commands.length).toBe(0);
    expect(r.finalPath).toBe('/ip/address/print');
  });
});

describe('finding #3 — :if (cond) do={…} swallows body (anchor)', () => {
  test(':if with paren expression loses inner command', () => {
    // Today: ZERO commands. The (...) is not tokenized.
    // After H3 (paren expression scope): /log/info should still be
    // missed (finding #4) but the structure should be preserved for
    // any nested [...] subshells.
    const r = canonicalize(':if ($x = 1) do={ /log/info "yes" }');
    expect(r.commands.length).toBe(0);
  });
});

describe('finding #7 — pure path mention not in extractPaths (anchor)', () => {
  test('bare path mention returns empty extractPaths', () => {
    // extractPaths only includes commands that have a verb. Use
    // extractMentions for navigation-only references — see H6 below.
    const ps = extractPaths('/ip/firewall/filter');
    expect(ps).toEqual([]);
  });
});

// ===========================================================================
// H6 — extractMentions surfaces bare path mentions
// ===========================================================================
describe('H6: extractMentions for navigation-only references', () => {
  test('bare /ip/firewall/filter is reported as a mention', () => {
    const m = extractMentions('/ip/firewall/filter');
    expect(m).toEqual(['/ip/firewall/filter']);
  });

  test('two semicolon-separated bare paths surface both', () => {
    // Note: prose like "See /ip/firewall/filter and /ip/firewall/nat" is
    // still mishandled by the mid-line-slash issue (finding #1, H1). Use
    // explicit separators here — that's what extractMentions can support
    // before lenient mode lands.
    const m = extractMentions('/ip/firewall/filter ; /ip/firewall/nat');
    expect(m).toContain('/ip/firewall/filter');
    expect(m).toContain('/ip/firewall/nat');
  });

  test('command path also surfaces as mention (dir + dir/verb)', () => {
    const m = extractMentions('/ip/address/print');
    // Contains both the verbed path and the dir.
    expect(m).toContain('/ip/address/print');
    expect(m).toContain('/ip/address');
  });

  test('mentions are deduped in order of first appearance', () => {
    const m = extractMentions('/ip/address ; /ip/address/print');
    // /ip/address shows up twice (nav + dir-of-cmd) but is only emitted once.
    expect(m.filter(p => p === '/ip/address').length).toBe(1);
  });
});

describe('finding #8 — source={…} block-as-value misread (anchor)', () => {
  test('outer add command is dropped when source is a block', () => {
    // Today: extracts only the inner /ip/address/print and DROPS the
    // outer /system/script/add.
    // After H5: { after key= should be a quoted block value, not
    // a scope to recurse into.
    const r = canonicalize('/system/script/add name=foo source={ /ip/address/print }');
    const inner = r.commands.find(c => c.verb === 'print');
    const outer = r.commands.find(c => c.verb === 'add');
    expect(inner).toBeDefined();        // current behaviour
    expect(outer).toBeUndefined();      // ← this is the bug
  });
});

// ===========================================================================
// Hardenings not yet shipped — todo() so they show in the runner output
// ===========================================================================
// ===========================================================================
// H8 — confidence flag on each CanonicalCommand
// ===========================================================================
describe('H8: confidence flag', () => {
  test('high: absolute path with explicit verb', () => {
    const r = canonicalize('/ip/address/print');
    expect(r.commands[0].confidence).toBe('high');
  });

  test('medium: relative path with cwd', () => {
    const r = canonicalize('print', '/ip/address');
    expect(r.commands[0].confidence).toBe('medium');
  });

  test('low: verb inferred at flush time when no path context exists', () => {
    // Bare word `print` with cwd='/' gates out of the explicit-verb check
    // (the parser only treats a word as a verb if it has path context).
    // It falls through to the path-segment branch and flushCommand's
    // trailing-segment-as-verb fallback promotes it. That is exactly the
    // looser/prose-shaped path H8 flags as 'low'.
    const r = canonicalize('print');
    expect(r.commands[0]?.verb).toBe('print');
    expect(r.commands[0]?.confidence).toBe('low');
  });

  test('subshell command keeps confidence on the inner command', () => {
    const r = canonicalize('/ip/address set [find interface=ether1] disabled=yes');
    const find = r.commands.find(c => c.subshell);
    const set = r.commands.find(c => c.verb === 'set');
    expect(find?.confidence).toBeDefined();
    expect(set?.confidence).toBe('high');
  });
});

// ===========================================================================
// Hardenings not yet shipped — todo() so they show in the runner output
// ===========================================================================
describe('hardenings not yet shipped', () => {
  test.todo('H1: lenient mode drops leading prose word', () => {
    // const r = canonicalize('Run /ip/address/print', '/', { mode: 'lenient' });
    // expect(r.commands).toEqual([
    //   { path: '/ip/address', verb: 'print', args: [], confidence: 'low' },
    // ]);
  });
  test.todo('H1: lenient mode splits "/a/b/c and /d/e/f" into two commands', () => {});
  test.todo('H2: $variable becomes Tok.Var, never a path segment', () => {});
  test.todo('H3: :if ($x = 1) do={ cmd } parses do block', () => {});
  test.todo('H5: source={ … } in /system/script/add is a value, not a scope', () => {});
});
