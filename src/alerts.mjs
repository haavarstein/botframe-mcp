import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeSecret, redactSecrets } from './secrets.mjs';
import { addDays, pad, tzParts, zonedToUtc } from './time.mjs';

// Alerts an agent puts on the frame.
// whisper is a short line in the corner.
// nudge is a card that leaves on its own.
// urgent is a full notice that stays until someone taps it.
// The frame receives the text, the sender's display name, and the timing.

export const LEVELS = new Set(['whisper', 'nudge', 'urgent']);
export const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID_RE = /^[a-f0-9]{12}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const TEXT_MAX = 140;
const TTL_MIN_S = 10;
const TTL_MAX_S = 2 * 60 * 60;
export const DEFAULT_TTL_S = { whisper: 10 * 60, nudge: 60 };
const KEEP_MAX = 20;
const RATE_MAX = 30;
const RATE_MS = 60 * 1000;
export const DEDUPE_MS = 15 * 60 * 1000;
export const DEFAULT_URGENT_SOURCES = 'ops,daily,desk,watch';

const NAMES = {
  ops: 'Ops',
  daily: 'Daily',
  desk: 'Desk',
  watch: 'Watch',
  coder: 'Coder',
};

export function sourceName(id) {
  if (!id) return '';
  if (NAMES[id]) return NAMES[id];
  return id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function cleanText(value) {
  const cleaned = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_MAX)
    .trim();
  return redactSecrets(cleaned);
}

export function isAlertId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function parseHm(value, defaultH, defaultM) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? '' : value).trim());
  if (!match) return { h: defaultH, m: defaultM };
  return { h: Number(match[1]), m: Number(match[2]) };
}

export function urgentSourcesFromEnv(value) {
  const raw = value == null || value === '' ? DEFAULT_URGENT_SOURCES : String(value);
  return new Set(raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean));
}

export function quietHoursConfig(env) {
  const src = env || process.env;
  let start = parseHm(src.AGENT_QUIET_START, 23, 0);
  let end = parseHm(src.AGENT_QUIET_END, 7, 0);
  const span = String(src.AGENT_QUIET_HOURS || '').trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/.exec(span);
  if (match) {
    start = { h: Number(match[1]), m: Number(match[2]) };
    end = { h: Number(match[3]), m: Number(match[4]) };
  }
  return {
    timeZone: src.AGENT_QUIET_TZ || src.DISPLAY_TZ || src.TIMEZONE || 'America/New_York',
    start,
    end,
    endLabel: pad(end.h) + ':' + pad(end.m),
  };
}

export function inQuietHours(nowMs, cfg) {
  if (!cfg) return false;
  const startMin = cfg.start.h * 60 + cfg.start.m;
  const endMin = cfg.end.h * 60 + cfg.end.m;
  if (startMin === endMin) return false;
  const p = tzParts(new Date(nowMs), cfg.timeZone);
  const minutes = p.h * 60 + p.mi;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

export function nextQuietEnd(nowMs, cfg) {
  const p = tzParts(new Date(nowMs), cfg.timeZone);
  const startMin = cfg.start.h * 60 + cfg.start.m;
  const endMin = cfg.end.h * 60 + cfg.end.m;
  const nowMin = p.h * 60 + p.mi;
  let wall = { y: p.y, mo: p.mo, d: p.d };
  if (startMin > endMin) {
    if (nowMin >= startMin) wall = addDays(wall, 1);
  } else if (nowMin >= endMin) {
    wall = addDays(wall, 1);
  }
  return zonedToUtc(wall.y, wall.mo, wall.d, cfg.end.h, cfg.end.m, 0, cfg.timeZone);
}

export function prepareAlert(alert, options) {
  const opts = options || {};
  const now = opts.now != null ? opts.now : alert.at;
  const allow = opts.urgentSources || urgentSourcesFromEnv();
  const next = Object.assign({}, alert);
  let downgraded = false;
  let queued = false;
  if (next.level === 'urgent' && !allow.has(next.source)) {
    next.level = 'nudge';
    next.expiresAt = next.at + DEFAULT_TTL_S.nudge * 1000;
    downgraded = true;
  }
  if (next.level === 'nudge' && opts.quiet && inQuietHours(now, opts.quiet)) {
    const until = nextQuietEnd(now, opts.quiet);
    const ttl = next.expiresAt != null ? next.expiresAt - next.at : DEFAULT_TTL_S.nudge * 1000;
    next.hiddenUntil = until;
    next.expiresAt = until + ttl;
    queued = true;
  }
  return { alert: next, downgraded, queued };
}

export function parseAlert(body, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the alert must be a JSON object' };
  const allowed = new Set(['text', 'level', 'source', 'ttl_s', 'key']);
  const extra = Object.keys(body).filter((key) => !allowed.has(key));
  if (extra.length) return { error: 'unknown field ' + extra.join(', ') };
  if (looksLikeSecret(body.text) || (body.key && looksLikeSecret(body.key))) {
    return { error: 'text looks like a secret' };
  }
  const text = cleanText(body.text);
  if (!text) return { error: 'text is required' };
  const level = body.level == null ? 'nudge' : String(body.level);
  if (!LEVELS.has(level)) return { error: 'level must be whisper, nudge or urgent' };
  const source = body.source == null ? '' : String(body.source).toLowerCase();
  if (source && !SOURCE_RE.test(source)) return { error: 'source must be lower case letters, digits and dashes, up to 32 characters' };
  let key = '';
  if (body.key != null && body.key !== '') {
    key = String(body.key);
    if (!KEY_RE.test(key)) return { error: 'key must be letters, digits, and ._:-, up to 64 characters' };
  }
  let ttlS = DEFAULT_TTL_S[level] || 0;
  if (body.ttl_s != null && level !== 'urgent') {
    const n = Number(body.ttl_s);
    if (!Number.isInteger(n) || n < TTL_MIN_S || n > TTL_MAX_S) return { error: 'ttl_s must be a whole number from ' + TTL_MIN_S + ' to ' + TTL_MAX_S };
    ttlS = n;
  }
  const alert = {
    id: randomBytes(6).toString('hex'),
    level,
    text,
    source,
    at: nowMs,
    expiresAt: level === 'urgent' ? null : nowMs + ttlS * 1000,
  };
  if (key) alert.key = key;
  return { alert };
}

function dedupeKey(row) {
  return (row.source || '') + '\n' + (row.key ? 'k:' + row.key : 't:' + row.text);
}

export class AlertBoard {
  constructor(options) {
    this.file = options.file;
    this.now = options.now || (() => Date.now());
    this.quiet = options.quiet !== undefined ? options.quiet : quietHoursConfig();
    this.urgentSources = options.urgentSources || urgentSourcesFromEnv(process.env.AGENT_URGENT_SOURCES);
    this.rateMax = options.rateMax != null ? options.rateMax : RATE_MAX;
    this.items = [];
    this.rate = new Map();
    this.loaded = false;
    this.updatedLast = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = (Array.isArray(saved.items) ? saved.items : [])
        .filter((row) => row && isAlertId(row.id) && LEVELS.has(row.level) && typeof row.text === 'string')
        .slice(-KEEP_MAX);
    } catch {
      /* first run */
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items }));
      fs.renameSync(tmp, this.file);
    } catch {
      /* keep the in-memory state */
    }
  }

  allow(source) {
    const key = source || '(none)';
    const now = this.now();
    const row = this.rate.get(key);
    if (!row || now - row.start >= RATE_MS) {
      this.rate.set(key, { start: now, count: 1 });
      return true;
    }
    row.count += 1;
    return row.count <= this.rateMax;
  }

  get(id) {
    this.load();
    this.prune();
    return this.items.find((row) => row.id === id) || null;
  }

  add(alert) {
    this.load();
    this.prune();
    this.updatedLast = false;
    const now = this.now();
    const want = dedupeKey(alert);
    const existing = this.items.find((row) => dedupeKey(row) === want && now - row.at < DEDUPE_MS);
    if (existing) {
      existing.text = alert.text;
      existing.level = alert.level;
      existing.expiresAt = alert.expiresAt;
      existing.at = now;
      existing.source = alert.source;
      if (alert.key) existing.key = alert.key;
      if (alert.hiddenUntil != null) existing.hiddenUntil = alert.hiddenUntil;
      else delete existing.hiddenUntil;
      this.items = this.items.filter((row) => row !== existing);
      this.items.push(existing);
      this.updatedLast = true;
      this.save();
      return existing;
    }
    this.items.push(alert);
    while (this.items.length > KEEP_MAX) {
      const index = this.items.findIndex((row) => row.level !== 'urgent');
      this.items.splice(index === -1 ? 0 : index, 1);
    }
    this.save();
    return alert;
  }

  dismiss(id) {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((row) => row.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  prune() {
    const now = this.now();
    const before = this.items.length;
    this.items = this.items.filter((row) => {
      if (row.hiddenUntil != null && row.hiddenUntil > now) return true;
      return row.expiresAt == null || row.expiresAt > now;
    });
    if (this.items.length !== before) this.save();
  }

  publicBody() {
    this.load();
    this.prune();
    const now = this.now();
    const quiet = inQuietHours(now, this.quiet);
    return {
      alerts: this.items.slice().reverse().filter((row) => {
        if (row.hiddenUntil != null && row.hiddenUntil > now) return false;
        if (quiet && row.level === 'nudge') return false;
        return true;
      }).map((row) => {
        const out = {
          id: row.id,
          level: row.level,
          text: row.text,
          source: sourceName(row.source),
          at: new Date(row.at).toISOString(),
          remainingMs: row.expiresAt == null ? null : Math.max(0, row.expiresAt - now),
          ttlMs: row.expiresAt == null ? null : row.expiresAt - row.at,
        };
        if (quiet && row.level === 'urgent') out.silent = true;
        return out;
      }),
    };
  }
}
