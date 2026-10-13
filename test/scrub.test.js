import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('the tree has no personal names, private IPs, or vendor hosts', () => {
  const files = walk(ROOT, []);
  const hits = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === 'LICENSE') continue;
    if (rel === path.join('test', 'scrub.test.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    const checks = [
      [/192\.168\./, '192.168'],
      [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, '10.x'],
      [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'cgnat'],
      [/\.ts\.net\b/i, 'ts.net'],
      [/\/Users\//, '/Users/'],
      [/\/home\//, '/home/'],
    ];
    for (const [re, label] of checks) {
      if (re.test(text)) hits.push(rel + ' ' + label);
    }
  }
  assert.deepEqual(hits, []);
});
