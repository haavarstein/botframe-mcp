import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCall, looksLikeSecret, mcpUrl, parseArgs } from '../scripts/frame-notify.mjs';
import { mintAgentToken } from '../scripts/mint-agent-token.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINT = path.join(ROOT, 'scripts', 'mint-agent-token.mjs');
const NOTIFY = path.join(ROOT, 'scripts', 'frame-notify.mjs');

test('looksLikeSecret catches tokens, jwt, and long hex or base64', () => {
  assert.equal(looksLikeSecret('Approve invoice 240'), false);
  assert.equal(looksLikeSecret('CI red on main'), false);
  assert.equal(looksLikeSecret('sk-abc123'), true);
  assert.equal(looksLikeSecret('ghp_abc123'), true);
  assert.equal(looksLikeSecret('xoxb-1234'), true);
  assert.equal(looksLikeSecret('AKIAAAAAAAAA'), true);
  assert.equal(looksLikeSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0'), true);
  assert.equal(looksLikeSecret('token=abc'), true);
  assert.equal(looksLikeSecret('password=secret'), true);
  assert.equal(looksLikeSecret('deadbeefdeadbeefdeadbeefdeadbeef'), true);
  assert.equal(looksLikeSecret('AbCdEfGhIjKlMnOpQrStUvWxYz012345+/=='), true);
});

test('frame-notify maps the four events and appends /mcp', () => {
  assert.deepEqual(buildCall('needs_input', 'daily', 'Approve', 'bill-1'), {
    name: 'frame_notify',
    arguments: { text: 'Approve', level: 'urgent', source: 'daily', key: 'bill-1' },
  });
  assert.deepEqual(buildCall('failed', 'coder', 'CI red'), {
    name: 'frame_notify',
    arguments: { text: 'CI red', level: 'nudge', source: 'coder' },
  });
  assert.deepEqual(buildCall('finished', 'desk', 'Brief ready'), {
    name: 'frame_notify',
    arguments: { text: 'Brief ready', level: 'whisper', source: 'desk', ttl_s: 7200 },
  });
  assert.deepEqual(buildCall('heartbeat', 'watch', 'ok'), {
    name: 'frame_agent_status',
    arguments: { agent: 'watch', kind: 'running', line: 'ok' },
  });
  assert.equal(mcpUrl('https://frame.example.com'), 'https://frame.example.com/mcp');
  assert.equal(mcpUrl('https://frame.example.com/mcp'), 'https://frame.example.com/mcp');
  assert.equal(mcpUrl(''), '');
  assert.equal(mcpUrl('   '), '');
  const opts = parseArgs(['failed', 'coder', 'CI red', '--key', 'job-1', '--url', 'http://127.0.0.1:8090', '--config', 'config.json']);
  assert.deepEqual(opts.rest, ['failed', 'coder', 'CI red']);
  assert.equal(opts.key, 'job-1');
  assert.equal(opts.url, 'http://127.0.0.1:8090');
});

function notifyEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.FRAME_URL;
  delete env.FRAME_AGENT_TOKEN;
  return env;
}

test('frame-notify refuses secret-looking text with exit 2 and prints no token', () => {
  const result = spawnSync(process.execPath, [NOTIFY, 'failed', 'coder', 'sk-live-secret'], {
    encoding: 'utf8',
    env: notifyEnv({ FRAME_AGENT_TOKEN: 'should-not-print' }),
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal((result.stdout + result.stderr).includes('should-not-print'), false);
  assert.equal((result.stdout + result.stderr).includes('sk-live-secret'), false);
});

test('frame-notify exits 2 when FRAME_URL is unset and does not send', () => {
  const result = spawnSync(process.execPath, [NOTIFY, 'failed', 'coder', 'CI red'], {
    encoding: 'utf8',
    env: notifyEnv({ FRAME_AGENT_TOKEN: 'should-not-print' }),
    timeout: 3000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /FRAME_URL is not set/);
  assert.equal((result.stdout + result.stderr).includes('should-not-print'), false);
});

test('mint-agent-token prints only the token and stores a hash at mode 600', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-mint-')), 'agent-tokens.json');
  const result = spawnSync(process.execPath, [MINT, 'daily'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_SOURCE_TOKENS_FILE: file },
  });
  assert.equal(result.status, 0);
  const token = result.stdout.trim();
  assert.equal(result.stdout, token + '\n');
  assert.equal(result.stderr, '');
  assert.equal(token.length, 48);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.daily, createHash('sha256').update(token, 'utf8').digest('hex'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = mintAgentToken('daily', file);
  const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(updated.daily, createHash('sha256').update(again, 'utf8').digest('hex'));
  assert.notEqual(again, token);
});
