import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { tokenMatches } from './guard.mjs';

const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function hashesEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length !== 32 || right.length !== 32) return false;
  return timingSafeEqual(left, right);
}

export function sourceTokensFromFile(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    Object.keys(data).forEach((source) => {
      const id = String(source).toLowerCase();
      const hash = String(data[source] || '').toLowerCase();
      if (SOURCE_RE.test(id) && HASH_RE.test(hash)) out[id] = hash;
    });
    return out;
  } catch {
    return {};
  }
}

// Returns { ok, source } on success. source is the bound id for a per-source
// token, or null for the legacy shared secret (any source).
export function authenticateAgent(header, options) {
  const legacyToken = (options && options.legacyToken) || '';
  const sourceTokens = (options && options.sourceTokens) || {};
  const sources = Object.keys(sourceTokens);
  const legacyOk = legacyToken.length >= 16 && sources.length === 0;
  if (!legacyOk && !sources.length) return { ok: false, status: 404 };

  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!match) return { ok: false, status: 401 };

  const given = match[1];
  const givenHash = hashToken(given);
  let bound = '';
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (hashesEqual(givenHash, sourceTokens[source])) bound = source;
  }
  if (bound && given.length >= 16) return { ok: true, source: bound };
  if (legacyOk && tokenMatches(header, legacyToken)) return { ok: true, source: null };
  return { ok: false, status: 401 };
}
