import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authenticateAgent, hashToken, hashesEqual, loadSourceTokens, sourceTokensFromFile } from '../src/agent-tokens.mjs';

const TOKEN = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

function tmpFile(name, data) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-tokens-')), name);
  if (data !== undefined) fs.writeFileSync(file, data);
  return file;
}

test('per-source tokens match a hash and lock to that source', () => {
  const sourceTokens = { ops: hashToken(TOKEN), daily: hashToken(OTHER) };
  const ops = authenticateAgent('Bearer ' + TOKEN, { sourceTokens });
  assert.deepEqual(ops, { ok: true, source: 'ops' });
  const daily = authenticateAgent('Bearer ' + OTHER, { sourceTokens });
  assert.deepEqual(daily, { ok: true, source: 'daily' });
  const bad = authenticateAgent('Bearer ' + 'c'.repeat(32), { sourceTokens });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

test('the legacy shared token still accepts any source when no hashes are set', () => {
  const legacy = authenticateAgent('Bearer ' + TOKEN, { legacyToken: TOKEN, sourceTokens: {} });
  assert.deepEqual(legacy, { ok: true, source: null });
});

test('legacy is ignored when hashes are present', () => {
  const mixed = authenticateAgent('Bearer ' + TOKEN, { legacyToken: TOKEN, sourceTokens: { ops: hashToken(OTHER) } });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.status, 401);
});

test('no tokens configured is 404, a missing bearer is 401', () => {
  assert.equal(authenticateAgent('Bearer ' + TOKEN, {}).status, 404);
  assert.equal(authenticateAgent('', { legacyToken: TOKEN }).status, 401);
  assert.equal(authenticateAgent('Bearer short', { sourceTokens: { ops: hashToken(TOKEN) } }).ok, false);
});

test('source token file keeps only valid hashes', () => {
  const file = tmpFile('agent-tokens.json', JSON.stringify({
    ops: hashToken(TOKEN),
    'Bad Source': hashToken(TOKEN),
    daily: 'not-a-hash',
  }));
  const map = sourceTokensFromFile(file);
  assert.deepEqual(Object.keys(map), ['ops']);
  assert.equal(sourceTokensFromFile(file + '.missing').ops, undefined);
  assert.equal(hashesEqual(hashToken(TOKEN), map.ops), true);
  assert.equal(hashesEqual('aa', map.ops), false);
  assert.equal(hashesEqual(hashToken(OTHER), map.ops), false);
  assert.equal(createHash('sha256').update(TOKEN).digest('hex'), hashToken(TOKEN));
});

test('loadSourceTokens fails closed on missing, malformed, or empty files', () => {
  assert.equal(loadSourceTokens('').ok, false);
  assert.equal(loadSourceTokens('').reason, 'missing');
  const missing = tmpFile('gone.json') + '.missing';
  assert.equal(loadSourceTokens(missing).ok, false);
  assert.equal(loadSourceTokens(missing).reason, 'missing');
  const malformed = tmpFile('bad.json', '{');
  assert.equal(loadSourceTokens(malformed).ok, false);
  assert.equal(loadSourceTokens(malformed).reason, 'malformed');
  const empty = tmpFile('empty.json', '{}');
  assert.equal(loadSourceTokens(empty).ok, false);
  assert.equal(loadSourceTokens(empty).reason, 'empty');
  const noneValid = tmpFile('none.json', JSON.stringify({ 'Bad Source': hashToken(TOKEN), daily: 'not-a-hash' }));
  assert.equal(loadSourceTokens(noneValid).ok, false);
  assert.equal(loadSourceTokens(noneValid).reason, 'empty');
  const ok = tmpFile('ok.json', JSON.stringify({ ops: hashToken(TOKEN) }));
  assert.equal(loadSourceTokens(ok).ok, true);
  assert.equal(loadSourceTokens(ok).tokens.ops, hashToken(TOKEN));
});
