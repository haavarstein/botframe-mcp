#!/usr/bin/env node
// Mint a per-source agent token. Prints only the token. Stores the SHA-256 hash.
//
//   node scripts/mint-agent-token.mjs <source>
//
// File: AGENT_SOURCE_TOKENS_FILE, or config/agent-tokens.json. Mode 600.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokensFile() {
  return process.env.AGENT_SOURCE_TOKENS_FILE || path.join(ROOT, 'config', 'agent-tokens.json');
}

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    /* first run or empty */
  }
  return {};
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function mintAgentToken(source, file) {
  const id = String(source || '').toLowerCase();
  if (!SOURCE_RE.test(id)) throw new Error('source');
  const token = randomBytes(24).toString('hex');
  const dest = file || tokensFile();
  const data = load(dest);
  data[id] = hashToken(token);
  save(dest, data);
  return token;
}

function main(argv) {
  const source = String(argv[0] || '').toLowerCase();
  if (!SOURCE_RE.test(source) || argv.length !== 1) {
    process.stderr.write('usage: mint-agent-token.mjs <source>\n');
    return 1;
  }
  try {
    process.stdout.write(mintAgentToken(source) + '\n');
    return 0;
  } catch {
    process.stderr.write('usage: mint-agent-token.mjs <source>\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
