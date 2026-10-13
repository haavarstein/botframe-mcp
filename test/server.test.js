import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashToken } from '../src/agent-tokens.mjs';
import { AlertBoard } from '../src/alerts.mjs';
import { RateLimiter } from '../src/guard.mjs';
import { createServer, isLoopbackHost, listen, TOKENS_FILE_ERROR, validateStartup } from '../src/server.mjs';
import { AgentWall } from '../src/status.mjs';

const TOKEN = '0123456789abcdef';
const FRAME = 'frame-token-value1';
const AGENT = 'a'.repeat(32);
const NOW = Date.parse('2026-10-12T14:00:00Z');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frame-srv-'));
}

function board() {
  const dir = tmpDir();
  const now = () => NOW;
  return {
    alerts: new AlertBoard({ file: path.join(dir, 'alerts.json'), now, quiet: null }),
    agentWall: new AgentWall({ file: path.join(dir, 'agent-wall.json'), now }),
    now,
  };
}

function start(extra) {
  const ctx = board();
  const server = createServer({
    token: TOKEN,
    frameToken: FRAME,
    alerts: ctx.alerts,
    agentWall: ctx.agentWall,
    now: ctx.now,
    ...extra,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, alerts: ctx.alerts, agentWall: ctx.agentWall }));
  });
}

async function post(port, pathname, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch('http://127.0.0.1:' + port + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text };
}

test('the frame page and alert read need no token, and notify requires one', async () => {
  const { server, port } = await start();
  try {
    const page = await fetch('http://127.0.0.1:' + port + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /api\/alerts/);
    assert.match(html, /Alert frame/);
    const open = await fetch('http://127.0.0.1:' + port + '/api/alerts');
    assert.deepEqual(await open.json(), { alerts: [] });
    const missing = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(missing.status, 401);
    const listed = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, TOKEN);
    assert.equal(listed.status, 200);
    assert.match(listed.text, /frame_notify/);
    const shown = await post(port, '/api/alerts', { text: 'Backup finished', level: 'nudge', source: 'coder' }, TOKEN);
    assert.equal(shown.status, 200);
    const id = JSON.parse(shown.text).id;
    const live = await fetch('http://127.0.0.1:' + port + '/api/alerts').then((res) => res.json());
    assert.equal(live.alerts[0].text, 'Backup finished');
    assert.equal(live.alerts[0].source, 'Coder');
    const noDismiss = await post(port, '/api/alerts/dismiss', { id });
    assert.equal(noDismiss.status, 401);
    const gone = await post(port, '/api/alerts/dismiss', { id }, FRAME);
    assert.equal(gone.status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unset agent token hides the notify endpoints', async () => {
  const ctx = board();
  const server = createServer({ token: '', frameToken: FRAME, alerts: ctx.alerts, agentWall: ctx.agentWall });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const hidden = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN);
    assert.equal(hidden.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dismiss requires a frame token and is hidden when it is unset', async () => {
  const ctx = board();
  const withFrame = createServer({ token: TOKEN, frameToken: FRAME, alerts: ctx.alerts, agentWall: ctx.agentWall, now: ctx.now });
  await new Promise((resolve) => withFrame.listen(0, '127.0.0.1', resolve));
  const port = withFrame.address().port;
  try {
    const shown = await post(port, '/api/alerts', { text: 'tap me', source: 'coder' }, TOKEN);
    const id = JSON.parse(shown.text).id;
    assert.equal((await post(port, '/api/alerts/dismiss', { id }, TOKEN)).status, 401);
    assert.equal((await post(port, '/api/alerts/dismiss', { id }, FRAME)).status, 204);
  } finally {
    await new Promise((resolve) => withFrame.close(resolve));
  }
  const ctx2 = board();
  const noFrame = createServer({ token: TOKEN, frameToken: '', alerts: ctx2.alerts, agentWall: ctx2.agentWall, now: ctx2.now });
  await new Promise((resolve) => noFrame.listen(0, '127.0.0.1', resolve));
  const port2 = noFrame.address().port;
  try {
    const shown = await post(port2, '/api/alerts', { text: 'tap me', source: 'coder' }, TOKEN);
    const id = JSON.parse(shown.text).id;
    assert.equal((await post(port2, '/api/alerts/dismiss', { id }, FRAME)).status, 404);
  } finally {
    await new Promise((resolve) => noFrame.close(resolve));
  }
});

test('write endpoints are rate limited', async () => {
  const { server, port } = await start({
    writeLimit: new RateLimiter({ max: 1, windowMs: 60_000, now: () => NOW }),
    dismissLimit: new RateLimiter({ max: 1, windowMs: 60_000, now: () => NOW }),
    mcpLimit: new RateLimiter({ max: 1, windowMs: 60_000, now: () => NOW }),
  });
  try {
    const first = await post(port, '/api/alerts', { text: 'one', source: 'coder' }, TOKEN);
    assert.equal(first.status, 200);
    const second = await post(port, '/api/alerts', { text: 'two', source: 'coder' }, TOKEN);
    assert.equal(second.status, 429);
    const mcp1 = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN);
    assert.equal(mcp1.status, 200);
    const mcp2 = await post(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'ping' }, TOKEN);
    assert.equal(mcp2.status, 429);
    const id = JSON.parse(first.text).id;
    const d1 = await post(port, '/api/alerts/dismiss', { id }, FRAME);
    assert.equal(d1.status, 204);
    const d2 = await post(port, '/api/alerts/dismiss', { id }, FRAME);
    assert.equal(d2.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the HTTP alert path rejects secret-looking text and binds a per-source token', async () => {
  const { server, port } = await start({
    token: '',
    sourceTokens: { ops: hashToken(AGENT) },
  });
  try {
    const secret = await post(port, '/api/alerts', { text: 'sk-live-secret', source: 'ops' }, AGENT);
    assert.equal(secret.status, 400);
    assert.match(secret.text, /secret/);
    const wrong = await post(port, '/api/alerts', { text: 'hello', source: 'coder' }, AGENT);
    assert.equal(wrong.status, 403);
    const ok = await post(port, '/api/alerts', { text: 'hello', source: 'ops' }, AGENT);
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HOST defaults to 127.0.0.1', async () => {
  const dir = tmpDir();
  const prev = process.env.FRAME_HOST;
  delete process.env.FRAME_HOST;
  const server = await listen({
    cwd: dir,
    envFile: '',
    tokensFile: '',
    port: 0,
    token: TOKEN,
    frameToken: FRAME,
    alerts: new AlertBoard({ file: '', quiet: null }),
    agentWall: new AgentWall({ file: '' }),
  });
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    if (prev == null) delete process.env.FRAME_HOST;
    else process.env.FRAME_HOST = prev;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('validateStartup refuses a mixed legacy token and hash file', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-tokens.json');
  fs.writeFileSync(file, JSON.stringify({ ops: hashToken(AGENT) }) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.throws(() => validateStartup({ tokensFile: file, envFile: '', legacyToken: TOKEN }), /legacy/);
});

test('validateStartup refuses a tokens file that is not mode 600', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-tokens.json');
  fs.writeFileSync(file, JSON.stringify({ ops: hashToken(AGENT) }) + '\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => validateStartup({ tokensFile: file, envFile: '', legacyToken: '' }), /mode 600/);
});

test('listen refuses to start when a tokens file is not mode 600', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-tokens.json');
  fs.writeFileSync(file, JSON.stringify({ ops: hashToken(AGENT) }) + '\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  await assert.rejects(() => listen({ cwd: dir, envFile: '', tokensFile: file, port: 0 }), /mode 600/);
});

test('a non-object JSON body gets 400 instead of hanging', async () => {
  const { server, port } = await start();
  try {
    for (const pathname of ['/api/alerts', '/api/agents/events']) {
      const res = await post(port, pathname, null, TOKEN);
      assert.equal(res.status, 400);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a malformed request target gets 400 instead of an unhandled rejection', async () => {
  const { server, port } = await start();
  try {
    const line = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      socket.once('data', (data) => { resolve(data.toString().split('\r\n')[0]); socket.destroy(); });
      socket.once('error', reject);
    });
    assert.match(line, / 400 /);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('agent events and wall are available over HTTP', async () => {
  const { server, port } = await start();
  try {
    const posted = await post(port, '/api/agents/events', { agent: 'coder', kind: 'running', line: 'working' }, TOKEN);
    assert.equal(posted.status, 204);
    const wall = await fetch('http://127.0.0.1:' + port + '/api/agents/wall').then((res) => res.json());
    assert.equal(wall.working[0].id, 'coder');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function writeTokensFile(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent-tokens.json');
  fs.writeFileSync(file, body, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

test('validateStartup refuses a tokens file that is malformed or has no valid hashes', () => {
  const dir = tmpDir();
  const empty = writeTokensFile(dir, '{}\n');
  assert.throws(() => validateStartup({ tokensFile: empty, envFile: '', legacyToken: TOKEN }), new RegExp(TOKENS_FILE_ERROR));
  const malformed = writeTokensFile(dir, '{');
  assert.throws(() => validateStartup({ tokensFile: malformed, envFile: '', legacyToken: TOKEN }), new RegExp(TOKENS_FILE_ERROR));
  const noneValid = writeTokensFile(dir, JSON.stringify({ 'Bad Source': hashToken(AGENT) }) + '\n');
  assert.throws(() => validateStartup({ tokensFile: noneValid, envFile: '', legacyToken: '' }), new RegExp(TOKENS_FILE_ERROR));
});

test('validateStartup refuses a configured tokens path that is missing', () => {
  const missing = path.join(tmpDir(), 'missing.json');
  assert.throws(
    () => validateStartup({ tokensFile: missing, tokensFileConfigured: true, envFile: '', legacyToken: TOKEN }),
    new RegExp(TOKENS_FILE_ERROR),
  );
});

test('listen refuses when the default tokens file exists but is empty', async () => {
  const dir = tmpDir();
  writeTokensFile(path.join(dir, 'config'), '{}\n');
  const prev = process.env.AGENT_SOURCE_TOKENS_FILE;
  delete process.env.AGENT_SOURCE_TOKENS_FILE;
  try {
    await assert.rejects(
      () => listen({
        cwd: dir,
        envFile: '',
        port: 0,
        token: TOKEN,
        frameToken: FRAME,
        alerts: new AlertBoard({ file: '', quiet: null }),
        agentWall: new AgentWall({ file: '' }),
      }),
      new RegExp(TOKENS_FILE_ERROR),
    );
  } finally {
    if (prev == null) delete process.env.AGENT_SOURCE_TOKENS_FILE;
    else process.env.AGENT_SOURCE_TOKENS_FILE = prev;
  }
});

test('a broken tokens file refuses all agent auth and never falls back to the legacy token', async () => {
  const file = writeTokensFile(tmpDir(), JSON.stringify({ ops: hashToken(AGENT) }) + '\n');
  const ctx = board();
  const errors = [];
  const orig = console.error;
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    orig.apply(console, args);
  };
  const server = createServer({
    token: TOKEN,
    frameToken: FRAME,
    tokensFile: file,
    alerts: ctx.alerts,
    agentWall: ctx.agentWall,
    now: ctx.now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await post(port, '/api/alerts', { text: 'hello', source: 'ops' }, AGENT);
    assert.equal(ok.status, 200);
    fs.writeFileSync(file, '{not json', { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    const withLegacy = await post(port, '/api/alerts', { text: 'hello', source: 'ops' }, TOKEN);
    assert.equal(withLegacy.status, 401);
    const withAgent = await post(port, '/api/alerts', { text: 'hello', source: 'ops' }, AGENT);
    assert.equal(withAgent.status, 401);
    const status = await post(port, '/api/agents/events', { agent: 'ops', kind: 'running', line: 'working' }, TOKEN);
    assert.equal(status.status, 401);
    const mcp = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, TOKEN);
    assert.equal(mcp.status, 401);
    const ours = errors.filter((line) => line.includes(TOKENS_FILE_ERROR));
    assert.ok(ours.length);
    for (const line of ours) {
      assert.equal(line.includes('?'), false);
      assert.equal(line.includes('/api/'), false);
      assert.equal(line.includes(TOKEN), false);
      assert.equal(line.includes(AGENT), false);
    }
  } finally {
    console.error = orig;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an empty tokens file at runtime does not fall back to the legacy token', async () => {
  const file = path.join(tmpDir(), 'agent-tokens.json');
  const ctx = board();
  const errors = [];
  const orig = console.error;
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    orig.apply(console, args);
  };
  const server = createServer({
    token: TOKEN,
    frameToken: FRAME,
    tokensFile: file,
    alerts: ctx.alerts,
    agentWall: ctx.agentWall,
    now: ctx.now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const before = await post(port, '/api/alerts', { text: 'hello', source: 'coder' }, TOKEN);
    assert.equal(before.status, 200);
    fs.writeFileSync(file, '{}\n', { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    const after = await post(port, '/api/alerts', { text: 'hello', source: 'coder' }, TOKEN);
    assert.equal(after.status, 401);
    assert.ok(errors.some((line) => line.includes(TOKENS_FILE_ERROR)));
  } finally {
    console.error = orig;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the frame token can dismiss and cannot post or set status', async () => {
  const { server, port } = await start();
  try {
    const shown = await post(port, '/api/alerts', { text: 'tap me', source: 'coder' }, TOKEN);
    assert.equal(shown.status, 200);
    const id = JSON.parse(shown.text).id;
    const posted = await post(port, '/api/alerts', { text: 'from frame', source: 'coder' }, FRAME);
    assert.equal(posted.status, 401);
    const status = await post(port, '/api/agents/events', { agent: 'coder', kind: 'running', line: 'working' }, FRAME);
    assert.equal(status.status, 401);
    const mcp = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, FRAME);
    assert.equal(mcp.status, 401);
    const gone = await post(port, '/api/alerts/dismiss', { id }, FRAME);
    assert.equal(gone.status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the frame page reads token from the query and strips it with replaceState', async () => {
  const { server, port } = await start();
  try {
    const html = await fetch('http://127.0.0.1:' + port + '/').then((res) => res.text());
    assert.match(html, /params\.get\('token'\)/);
    assert.match(html, /params\.delete\('token'\)/);
    assert.match(html, /history\.replaceState/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('isLoopbackHost accepts loopback addresses only', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.255.255.255'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('::'), false);
});

test('listen warns when HOST is not loopback', async () => {
  const dir = tmpDir();
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
    orig.apply(console, args);
  };
  const server = await listen({
    cwd: dir,
    envFile: '',
    tokensFile: '',
    host: '0.0.0.0',
    port: 0,
    token: TOKEN,
    frameToken: FRAME,
    alerts: new AlertBoard({ file: '', quiet: null }),
    agentWall: new AgentWall({ file: '' }),
  });
  try {
    assert.ok(warnings.some((line) => /loopback/.test(line)));
    for (const line of warnings) {
      assert.equal(line.includes('?'), false);
      assert.equal(line.includes('/api/'), false);
    }
  } finally {
    console.warn = orig;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('deleting a tokens file that existed at startup revokes all agent auth', async () => {
  const file = path.join(tmpDir(), 'agent-tokens.json');
  const agentToken = 'a'.repeat(48);
  fs.writeFileSync(file, JSON.stringify({ coder: hashToken(agentToken) }) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  const ctx = board();
  const orig = console.error;
  console.error = () => {};
  const server = createServer({
    token: TOKEN,
    frameToken: FRAME,
    tokensFile: file,
    sourceTokens: { coder: hashToken(agentToken) },
    alerts: ctx.alerts,
    agentWall: ctx.agentWall,
    now: ctx.now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const before = await post(port, '/api/alerts', { text: 'hello', source: 'coder' }, agentToken);
    assert.equal(before.status, 200);
    fs.unlinkSync(file);
    const after = await post(port, '/api/alerts', { text: 'hello', source: 'coder' }, agentToken);
    assert.equal(after.status, 401);
    const legacy = await post(port, '/api/alerts', { text: 'hello', source: 'coder' }, TOKEN);
    assert.equal(legacy.status, 401);
  } finally {
    console.error = orig;
    await new Promise((resolve) => server.close(resolve));
  }
});
