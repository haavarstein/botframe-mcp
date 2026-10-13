import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPosixMode600, jsonPostAllowed, RateLimiter, secretsEqual, tokenMatches } from '../src/guard.mjs';

const TOKEN = '0123456789abcdef';

test('tokenMatches uses timing-safe equal-length compares', () => {
  assert.equal(tokenMatches('Bearer ' + TOKEN, TOKEN), true);
  assert.equal(tokenMatches('bearer ' + TOKEN, TOKEN), true);
  assert.equal(tokenMatches('Bearer ' + '0123456789abcdee', TOKEN), false);
  assert.equal(tokenMatches('Bearer short', TOKEN), false);
  assert.equal(tokenMatches('Bearer ' + TOKEN + 'x', TOKEN), false);
  assert.equal(tokenMatches('', TOKEN), false);
  assert.equal(tokenMatches('Bearer ' + TOKEN, ''), false);
  assert.equal(tokenMatches('Bearer ' + TOKEN, 'shorttokenvalue'), false);
  assert.equal(secretsEqual(TOKEN, TOKEN), true);
  assert.equal(secretsEqual(TOKEN, '0123456789abcdee'), false);
  assert.equal(secretsEqual('short', TOKEN), false);
});

test('jsonPostAllowed requires JSON and a same-host Origin when present', () => {
  assert.equal(jsonPostAllowed({ 'content-type': 'application/json', host: '127.0.0.1:8090' }), true);
  assert.equal(jsonPostAllowed({ 'content-type': 'application/json; charset=utf-8', host: '127.0.0.1:8090' }), true);
  assert.equal(jsonPostAllowed({ 'content-type': 'text/plain', host: '127.0.0.1:8090' }), false);
  assert.equal(jsonPostAllowed({
    'content-type': 'application/json',
    host: '127.0.0.1:8090',
    origin: 'http://127.0.0.1:8090',
  }), true);
  assert.equal(jsonPostAllowed({
    'content-type': 'application/json',
    host: '127.0.0.1:8090',
    origin: 'http://example.com',
  }), false);
});

test('RateLimiter uses a fixed window', () => {
  const clock = { at: 1000 };
  const limiter = new RateLimiter({ max: 2, windowMs: 1000, now: () => clock.at });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true);
  clock.at = 2000;
  assert.equal(limiter.allow('a'), true);
});

test('assertPosixMode600 refuses a world-readable file', { skip: process.platform === 'win32' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-mode-')), 'tokens.json');
  fs.writeFileSync(file, '{}\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => assertPosixMode600(file), /mode 600/);
  fs.chmodSync(file, 0o600);
  assert.doesNotThrow(() => assertPosixMode600(file));
});
