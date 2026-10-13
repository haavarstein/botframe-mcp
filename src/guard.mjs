import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function tokenMatches(header, expected) {
  if (!expected || expected.length < 16) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function secretsEqual(given, expected) {
  if (!expected || expected.length < 16) return false;
  const left = Buffer.from(String(given || ''));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

// JSON posts only. A browser Origin must name this same host.
export function jsonPostAllowed(headers) {
  const type = String((headers && headers['content-type']) || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return false;
  const origin = headers && headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(headers.host || '');
  } catch {
    return false;
  }
}

export class RateLimiter {
  constructor(options) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.now = options.now || (() => Date.now());
    this.buckets = new Map();
  }

  allow(key) {
    const now = this.now();
    const row = this.buckets.get(key);
    if (!row || now - row.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    row.count += 1;
    return row.count <= this.max;
  }
}

export function assertPosixMode600(file) {
  if (process.platform === 'win32') return;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error('token/config file ' + path.basename(file) + ' must be mode 600');
  }
}

export function clientKey(req) {
  return (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}
