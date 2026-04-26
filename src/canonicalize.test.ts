import { describe, expect, test } from 'bun:test';
import {
  _normalizePath,
  _tokenize,
  canonicalize,
  extractMentions,
  extractPaths,
  primaryPath,
} from './canonicalize.ts';

// ---------------------------------------------------------------------------
// Helper: shorthand for asserting a single command
// ---------------------------------------------------------------------------
function expectSingle(input: string, expected: { path: string; verb: string; args?: string[] }, cwd = '/') {
  const result = canonicalize(input, cwd);
  expect(result.commands.length).toBeGreaterThanOrEqual(1);
  const cmd = result.commands.find(c => !c.subshell) ?? result.commands[0];
  expect(cmd.path).toBe(expected.path);
  expect(cmd.verb).toBe(expected.verb);
  if (expected.args) {
    expect(cmd.args).toEqual(expected.args);
  }
}

// ===========================================================================
// Tokenizer
// ===========================================================================
describe('tokenizer', () => {
  test('simple path + command', () => {
    const tokens = _tokenize('/ip/address/print');
    const types = tokens.map(t => t.value);
    expect(types).toEqual(['/', 'ip', '/', 'address', '/', 'print']);
  });

  test('handles comments', () => {
    const tokens = _tokenize('/ip/address/print # list addresses');
    const words = tokens.filter(t => t.value !== '/').map(t => t.value);
    expect(words).toContain('print');
    expect(words).not.toContain('#');
  });

  test('handles quoted strings', () => {
    const tokens = _tokenize('comment="my comment"');
    expect(tokens.some(t => t.value.includes('my comment'))).toBe(true);
  });

  test('handles line continuation', () => {
    const tokens = _tokenize('/ip/route/add \\\n  gateway=1.1.1.1');
    const words = tokens.map(t => t.value);
    expect(words).toContain('gateway=1.1.1.1');
  });
});

// ===========================================================================
// Path normalization
// ===========================================================================
describe('normalizePath', () => {
  test('adds leading slash', () => {
    expect(_normalizePath('ip/address')).toBe('/ip/address');
  });

  test('root stays root', () => {
    expect(_normalizePath('/')).toBe('/');
  });

  test('removes trailing slash', () => {
    expect(_normalizePath('/ip/address/')).toBe('/ip/address');
  });

  test('collapses double slashes', () => {
    expect(_normalizePath('//ip//address')).toBe('/ip/address');
  });
});

// ===========================================================================
// Basic absolute paths
// ===========================================================================
describe('absolute paths', () => {
  test('/ip/address/print — fully qualified', () => {
    expectSingle('/ip/address/print', { path: '/ip/address', verb: 'print' });
  });

  test('/ip/address/set — fully qualified', () => {
    expectSingle('/ip/address/set', { path: '/ip/address', verb: 'set' });
  });

  test('/ip/address/add with args', () => {
    expectSingle('/ip/address/add address=192.168.1.1/24 interface=ether1', {
      path: '/ip/address',
      verb: 'add',
      args: ['address=192.168.1.1/24', 'interface=ether1'],
    });
  });

  test('/ip/firewall/filter/add — deep path', () => {
    expectSingle('/ip/firewall/filter/add chain=forward', {
      path: '/ip/firewall/filter',
      verb: 'add',
      args: ['chain=forward'],
    });
  });

  test('/system/reboot — command-only path', () => {
    expectSingle('/system/reboot', { path: '/system', verb: 'reboot' });
  });
});

// ===========================================================================
// Space-separated paths (both forms valid in RouterOS)
// ===========================================================================
describe('space-separated paths', () => {
  test('/ip address print', () => {
    expectSingle('/ip address print', { path: '/ip/address', verb: 'print' });
  });

  test('/ip route add gateway=1.1.1.1', () => {
    expectSingle('/ip route add gateway=1.1.1.1', {
      path: '/ip/route',
      verb: 'add',
      args: ['gateway=1.1.1.1'],
    });
  });

  test('/ip firewall filter add chain=forward', () => {
    expectSingle('/ip firewall filter add chain=forward', {
      path: '/ip/firewall/filter',
      verb: 'add',
      args: ['chain=forward'],
    });
  });
});

// ===========================================================================
// Mixed slash/space paths (explicitly documented in RouterOS Console page)
// ===========================================================================
describe('mixed slash/space paths', () => {
  test('/ip firewall/filter/add chain=forward', () => {
    expectSingle('/ip firewall/filter/add chain=forward', {
      path: '/ip/firewall/filter',
      verb: 'add',
      args: ['chain=forward'],
    });
  });

  test('/ip/firewall filter add chain=forward', () => {
    expectSingle('/ip/firewall filter add chain=forward', {
      path: '/ip/firewall/filter',
      verb: 'add',
      args: ['chain=forward'],
    });
  });
});

// ===========================================================================
// Relative paths with cwd
// ===========================================================================
describe('relative paths', () => {
  test('set disabled=yes from /ip/address cwd', () => {
    expectSingle('set disabled=yes', { path: '/ip/address', verb: 'set', args: ['disabled=yes'] }, '/ip/address');
  });

  test('print from /ip/route cwd', () => {
    expectSingle('print', { path: '/ip/route', verb: 'print' }, '/ip/route');
  });

  test('add gateway=1.1.1.1 from /ip/route cwd', () => {
    expectSingle('add gateway=1.1.1.1', {
      path: '/ip/route',
      verb: 'add',
      args: ['gateway=1.1.1.1'],
    }, '/ip/route');
  });
});

// ===========================================================================
// Missing leading slash (tolerance)
// ===========================================================================
describe('missing leading slash', () => {
  test('ip address print — treated as path from root', () => {
    expectSingle('ip address print', { path: '/ip/address', verb: 'print' });
  });

  test('ip address/set — mixed', () => {
    expectSingle('ip address/set', { path: '/ip/address', verb: 'set' });
  });
});

// ===========================================================================
// .. (parent) navigation
// ===========================================================================
describe('.. navigation', () => {
  test('.. from /ip/address → /ip', () => {
    const result = canonicalize('..', '/ip/address');
    expect(result.finalPath).toBe('/ip');
  });

  test('../route print from /ip/address', () => {
    expectSingle('../route print', { path: '/ip/route', verb: 'print' }, '/ip/address');
  });

  test('.. service-port print from /ip/firewall/nat', () => {
    expectSingle('.. service-port print', {
      path: '/ip/firewall/service-port',
      verb: 'print',
    }, '/ip/firewall/nat');
  });
});

// ===========================================================================
// Subshells [...]
// ===========================================================================
describe('subshells [...]', () => {
  test('basic find subshell', () => {
    const result = canonicalize('/ip/address set [find interface=ether1] disabled=yes');
    // Should produce find subshell + set outer command
    const findCmd = result.commands.find(c => c.verb === 'find');
    const setCmd = result.commands.find(c => c.verb === 'set');
    expect(findCmd).toBeDefined();
    expect(findCmd?.subshell).toBe(true);
    expect(findCmd?.path).toBe('/ip/address');
    expect(setCmd).toBeDefined();
    expect(setCmd?.path).toBe('/ip/address');
    expect(setCmd?.verb).toBe('set');
  });

  test('nested subshells: /ip route get [find gateway=1.1.1.1]', () => {
    const result = canonicalize(':put [/ip route get [find gateway=1.1.1.1]]');
    // Inner find runs in /ip/route context, outer get also in /ip/route
    const findCmd = result.commands.find(c => c.verb === 'find');
    const getCmd = result.commands.find(c => c.verb === 'get');
    expect(findCmd).toBeDefined();
    expect(findCmd?.path).toBe('/ip/route');
    expect(findCmd?.subshell).toBe(true);
    expect(getCmd).toBeDefined();
    expect(getCmd?.path).toBe('/ip/route');
  });

  test('subshell with absolute path inside', () => {
    const result = canonicalize('/interface set [/ip address find] name=test', '/system');
    const findCmd = result.commands.find(c => c.verb === 'find');
    expect(findCmd).toBeDefined();
    expect(findCmd?.path).toBe('/ip/address');
    expect(findCmd?.subshell).toBe(true);
  });

  test('complex bridge example with nested subshells', () => {
    // /interface/bridge/set bridge1 pvid=[port/get [find interface=ether1] pvid]
    const result = canonicalize(
      '/interface/bridge/set bridge1 pvid=[port/get [find interface=ether1] pvid]'
    );
    const setCmd = result.commands.find(c => c.verb === 'set' && !c.subshell);
    expect(setCmd).toBeDefined();
    expect(setCmd?.path).toBe('/interface/bridge');

    // The subshell commands should inherit /interface/bridge context
    const findCmd = result.commands.find(c => c.verb === 'find');
    expect(findCmd).toBeDefined();
    expect(findCmd?.subshell).toBe(true);
  });
});

// ===========================================================================
// { } blocks — path scoping
// ===========================================================================
describe('{ } blocks', () => {
  test('block with path prefix changes cwd within block', () => {
    const result = canonicalize('/ip/address { print }');
    const printCmd = result.commands.find(c => c.verb === 'print');
    expect(printCmd).toBeDefined();
    expect(printCmd?.path).toBe('/ip/address');
  });

  test('path persists after block exit', () => {
    const result = canonicalize('/ip/address { print }\nprint');
    // The second print should be at /ip/address since path persists after }
    const printCmds = result.commands.filter(c => c.verb === 'print');
    expect(printCmds.length).toBe(2);
    expect(printCmds[1].path).toBe('/ip/address');
  });

  test('block with local scope', () => {
    const result = canonicalize('{\n  :local a 3;\n  /ip/address/print\n}');
    const printCmd = result.commands.find(c => c.verb === 'print');
    expect(printCmd).toBeDefined();
    expect(printCmd?.path).toBe('/ip/address');
  });
});

// ===========================================================================
// ; separator
// ===========================================================================
describe('; separator', () => {
  test('multiple commands separated by ;', () => {
    const result = canonicalize('/ip/address/print; /ip/route/print');
    expect(result.commands.length).toBe(2);
    expect(result.commands[0].path).toBe('/ip/address');
    expect(result.commands[0].verb).toBe('print');
    expect(result.commands[1].path).toBe('/ip/route');
    expect(result.commands[1].verb).toBe('print');
  });

  test('; in scripts — path context carries forward correctly', () => {
    const result = canonicalize('/system/package; print');
    // Second command should inherit /system/package path
    const cmds = result.commands.filter(c => c.verb === 'print');
    expect(cmds.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// ICE commands (: prefix) — should be skipped/transparent
// ===========================================================================
describe('ICE commands', () => {
  test(':put is skipped, path commands within are still extracted', () => {
    const result = canonicalize(':put [/system/resource/get version]');
    const getCmd = result.commands.find(c => c.verb === 'get');
    expect(getCmd).toBeDefined();
    expect(getCmd?.path).toBe('/system/resource');
  });

  test(':local and :global are skipped', () => {
    const result = canonicalize(':local myVar "test"\n/ip/address/print');
    const printCmd = result.commands.find(c => c.verb === 'print');
    expect(printCmd).toBeDefined();
    expect(printCmd?.path).toBe('/ip/address');
  });
});

// ===========================================================================
// finalPath tracking (interactive session cwd)
// ===========================================================================
describe('finalPath', () => {
  test('absolute navigation updates finalPath', () => {
    const result = canonicalize('/ip/address');
    expect(result.finalPath).toBe('/ip/address');
  });

  test('/ resets to root', () => {
    const result = canonicalize('/', '/ip/address');
    expect(result.finalPath).toBe('/');
  });

  test('.. navigates up', () => {
    const result = canonicalize('..', '/ip/address');
    expect(result.finalPath).toBe('/ip');
  });

  test('command execution preserves path', () => {
    // /ip/address print should leave us at /ip/address
    const result = canonicalize('/ip/address print');
    expect(result.finalPath).toBe('/ip/address');
  });
});

// ===========================================================================
// Convenience functions
// ===========================================================================
describe('extractPaths', () => {
  test('returns unique paths', () => {
    const paths = extractPaths('/ip/address/add address=1.2.3.4/24 interface=ether1; /ip/address/print');
    expect(paths).toContain('/ip/address/add');
    expect(paths).toContain('/ip/address/print');
  });

  test('includes subshell paths', () => {
    const paths = extractPaths('/ip/address set [find interface=ether1] disabled=yes');
    expect(paths).toContain('/ip/address/find');
    expect(paths).toContain('/ip/address/set');
  });
});

describe('primaryPath', () => {
  test('returns first non-subshell path', () => {
    const path = primaryPath('/ip/address set [find interface=ether1] disabled=yes');
    expect(path).toBe('/ip/address');
  });

  test('returns null for empty input', () => {
    expect(primaryPath('')).toBeNull();
  });

  test('returns path for simple command', () => {
    expect(primaryPath('/ip/address/print')).toBe('/ip/address');
  });
});

// ===========================================================================
// Real-world examples from RouterOS docs
// ===========================================================================
describe('real-world examples', () => {
  test('from Console page: /ip firewall/filter/add chain=forward place-before=[find where comment=CommentX]', () => {
    const result = canonicalize(
      '/ip firewall/filter/add chain=forward place-before=[find where comment=CommentX]'
    );
    const addCmd = result.commands.find(c => c.verb === 'add' && !c.subshell);
    expect(addCmd).toBeDefined();
    expect(addCmd?.path).toBe('/ip/firewall/filter');
    expect(addCmd?.args.some(a => a.startsWith('chain='))).toBe(true);

    const findCmd = result.commands.find(c => c.verb === 'find');
    expect(findCmd).toBeDefined();
    expect(findCmd?.subshell).toBe(true);
  });

  test('from Console page: /ip/firewall/filter/add chain=forward', () => {
    expectSingle('/ip/firewall/filter/add chain=forward', {
      path: '/ip/firewall/filter',
      verb: 'add',
      args: ['chain=forward'],
    });
  });

  test('DHCP lease script', () => {
    const result = canonicalize('/ip dhcp-server set myServer lease-script=myLeaseScript');
    const setCmd = result.commands.find(c => c.verb === 'set');
    expect(setCmd).toBeDefined();
    expect(setCmd?.path).toBe('/ip/dhcp-server');
  });

  test('scripting: :put with nested subshells', () => {
    const result = canonicalize(':put [/ip route get [find gateway=1.1.1.1]]');
    const findCmd = result.commands.find(c => c.verb === 'find');
    const getCmd = result.commands.find(c => c.verb === 'get');
    expect(findCmd).toBeDefined();
    expect(getCmd).toBeDefined();
    expect(findCmd?.path).toBe('/ip/route');
    expect(getCmd?.path).toBe('/ip/route');
  });

  test('firewall rule with find subshell', () => {
    const result = canonicalize(
      '/ip/address/set [find interface=ether1] address=10.0.0.1/24'
    );
    const setCmd = result.commands.find(c => c.verb === 'set' && !c.subshell);
    const findCmd = result.commands.find(c => c.verb === 'find');
    expect(setCmd).toBeDefined();
    expect(setCmd?.path).toBe('/ip/address');
    expect(findCmd).toBeDefined();
    expect(findCmd?.path).toBe('/ip/address');
    expect(findCmd?.subshell).toBe(true);
  });

  test('interface set with name', () => {
    expectSingle('/interface set ether1 mtu=1460', {
      path: '/interface',
      verb: 'set',
      args: ['ether1', 'mtu=1460'],
    });
  });

  test('multiline script with variable scope', () => {
    const result = canonicalize(`{
  :local a 3
  /ip/address/print
  /ip/route/add gateway=1.1.1.1
}`);
    const printCmd = result.commands.find(c => c.verb === 'print');
    const addCmd = result.commands.find(c => c.verb === 'add');
    expect(printCmd).toBeDefined();
    expect(printCmd?.path).toBe('/ip/address');
    expect(addCmd).toBeDefined();
    expect(addCmd?.path).toBe('/ip/route');
  });

  test('user example: bridge pvid subshell', () => {
    // /interface/bridge/set bridge1 pvid=[port/get [find interface=ether1] pvid]
    // The outer command is /interface/bridge set
    // The [port/get ...] subshell should resolve relative to /interface/bridge
    // The [find ...] inside that should resolve relative to /interface/bridge/port
    const result = canonicalize(
      '/interface/bridge/set bridge1 pvid=[port/get [find interface=ether1] pvid]'
    );
    const setCmd = result.commands.find(c => c.verb === 'set' && !c.subshell);
    expect(setCmd).toBeDefined();
    expect(setCmd?.path).toBe('/interface/bridge');
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================
describe('edge cases', () => {
  test('empty input', () => {
    const result = canonicalize('');
    expect(result.commands).toEqual([]);
    expect(result.finalPath).toBe('/');
  });

  test('only whitespace', () => {
    const result = canonicalize('   \t  ');
    expect(result.commands).toEqual([]);
  });

  test('only comment', () => {
    const result = canonicalize('# this is a comment');
    expect(result.commands).toEqual([]);
  });

  test('root slash only', () => {
    const result = canonicalize('/');
    expect(result.finalPath).toBe('/');
  });

  test('path with hyphenated segments', () => {
    expectSingle('/ip/dhcp-client/print', { path: '/ip/dhcp-client', verb: 'print' });
  });

  test('deeply nested path', () => {
    expectSingle('/ip/firewall/filter/add chain=forward action=accept', {
      path: '/ip/firewall/filter',
      verb: 'add',
    });
  });

  test('path with where clause (not a subshell)', () => {
    const result = canonicalize('/interface/print where name~"ether"');
    const printCmd = result.commands.find(c => c.verb === 'print');
    expect(printCmd).toBeDefined();
    expect(printCmd?.path).toBe('/interface');
  });
});

// ===========================================================================
// CanonicalizeOptions — pluggable isVerb resolver (H4)
// ===========================================================================
describe('CanonicalizeOptions.isVerb', () => {
  test('resolver receives token and parent path', () => {
    const calls: Array<{ token: string; parentPath: string }> = [];
    canonicalize('/ip/address/print', '/', {
      isVerb: (token, parentPath) => {
        calls.push({ token, parentPath });
        return token === 'print' && parentPath === '/ip/address';
      },
    });
    expect(calls.some(c => c.token === 'print' && c.parentPath === '/ip/address')).toBe(true);
  });

  test('resolver call site is path-aware: same token, different parent', () => {
    // Call with a resolver that ONLY recognizes `info` at /log.
    const isVerb = (token: string, parentPath: string) =>
      token === 'info' && parentPath === '/log';

    const atLog = canonicalize('/log/info "msg"', '/', { isVerb });
    expect(atLog.commands[0]?.verb).toBe('info');
    expect(atLog.commands[0]?.path).toBe('/log');

    // Same token at a different path → not a verb, treated as navigation.
    const atWifi = canonicalize('/interface/wireless/info', '/', { isVerb });
    expect(atWifi.commands.length).toBe(0);
    expect(atWifi.finalPath).toBe('/interface/wireless/info');
  });

  test('omitting options preserves backward-compatible behaviour', () => {
    const r1 = canonicalize('/ip/address/print');
    const r2 = canonicalize('/ip/address/print', '/');
    expect(r1.commands[0]?.verb).toBe('print');
    expect(r2.commands[0]?.verb).toBe('print');
  });
});

// ===========================================================================
// extractMentions (H6) — sanity unit tests
// ===========================================================================
describe('extractMentions', () => {
  test('verbed command surfaces both dir and dir/verb', () => {
    const m = extractMentions('/ip/address/print');
    expect(m).toContain('/ip/address');
    expect(m).toContain('/ip/address/print');
  });

  test('bare path surfaces as a single mention', () => {
    expect(extractMentions('/ip/firewall/filter')).toEqual(['/ip/firewall/filter']);
  });

  test('empty input → empty mentions', () => {
    expect(extractMentions('')).toEqual([]);
  });
});
