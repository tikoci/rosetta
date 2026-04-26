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
import { canonicalize, extractPaths } from './canonicalize.ts';

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

describe('finding #4 — menu-specific verbs (anchor)', () => {
  test('/log/info "msg" produces no command (info not in universal verbs)', () => {
    // Today: zero commands.
    // After H4 (data-driven verb table from rosetta `commands`): would
    // recognise info as a verb under /log.
    const r = canonicalize('/log/info "msg"');
    expect(r.commands.length).toBe(0);
  });

  test('/log/warning produces no command', () => {
    const r = canonicalize('/log/warning "warn"');
    expect(r.commands.length).toBe(0);
  });

  test('/log/error produces no command', () => {
    const r = canonicalize('/log/error "boom"');
    expect(r.commands.length).toBe(0);
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
    // Today: extractPaths only includes commands that have a verb.
    // After H6: navigation-only paths should also surface as
    // "this text references /ip/firewall/filter".
    const ps = extractPaths('/ip/firewall/filter');
    expect(ps).toEqual([]);
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
describe('hardenings not yet shipped', () => {
  test.todo('H1: lenient mode drops leading prose word', () => {
    // const r = canonicalize('Run /ip/address/print', '/', { mode: 'lenient' });
    // expect(r.commands).toEqual([
    //   { path: '/ip/address', verb: 'print', args: [], confidence: 'low' },
    // ]);
  });
  test.todo('H1: lenient mode splits "/a/b/c and /d/e/f" into two commands');
  test.todo('H2: $variable becomes Tok.Var, never a path segment');
  test.todo('H3: :if ($x = 1) do={ cmd } parses do block');
  test.todo('H4: data-driven verb table recognises /log/info');
  test.todo('H4: data-driven verb table does NOT misread /interface/wireless/info as verb');
  test.todo('H5: source={ … } in /system/script/add is a value, not a scope');
  test.todo('H6: bare /ip/firewall/filter mention surfaces in extractMentions()');
  test.todo('H8: confidence flag on each CanonicalCommand');
});
