import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_RE, sourceName } from './alerts.mjs';
import { looksLikeSecret, redactSecrets } from './secrets.mjs';

export const KINDS = new Set(['needs_input', 'started', 'working', 'running', 'finished', 'failed', 'ended']);
export const STALE_MS = 15 * 60 * 1000;
export const OFFLINE_MS = 60 * 60 * 1000;
const RATE_MAX = 120;
const RATE_MS = 60 * 1000;
const LINE_MAX = 80;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const VENDOR_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
const RECENT_MAX = 20;

function liveKind(kind) {
  return kind === 'needs_input' || kind === 'started' || kind === 'working' || kind === 'running';
}

function cleanLine(value) {
  const cleaned = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LINE_MAX)
    .trim();
  return redactSecrets(cleaned);
}

function lastFolder(value) {
  const raw = String(value == null ? '' : value).replace(/\\/g, '/');
  const parts = raw.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function parseEvent(body, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const allowed = new Set(['agent', 'kind', 'vendor', 'project', 'line', 'session']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  const agent = String(body.agent || '').toLowerCase();
  if (!SOURCE_RE.test(agent)) return null;
  const kind = String(body.kind || '');
  if (!KINDS.has(kind)) return null;
  if (looksLikeSecret(body.line) || looksLikeSecret(body.project) || looksLikeSecret(body.session)) return null;
  let vendor = '';
  if (body.vendor != null && body.vendor !== '') {
    vendor = String(body.vendor).toLowerCase();
    if (!VENDOR_RE.test(vendor)) return null;
  }
  const project = body.project == null || body.project === '' ? '' : lastFolder(body.project);
  const line = cleanLine(body.line);
  let session = '';
  if (body.session != null && body.session !== '') {
    session = String(body.session);
    if (!SESSION_RE.test(session)) return null;
  }
  return { agent, kind, vendor, project, line, session, at: nowMs };
}

function sameSession(row, event) {
  if (event.session && row.session) return row.session === event.session;
  return row.agent === event.agent;
}

export class AgentWall {
  constructor(options) {
    this.file = options.file;
    this.now = options.now || (() => Date.now());
    this.rateMax = options.rateMax != null ? options.rateMax : RATE_MAX;
    this.items = [];
    this.rate = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = (Array.isArray(saved.items) ? saved.items : []).filter((row) => row && SOURCE_RE.test(row.agent) && KINDS.has(row.kind));
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

  allow(agent) {
    const key = agent || '(none)';
    const now = this.now();
    const row = this.rate.get(key);
    if (!row || now - row.start >= RATE_MS) {
      this.rate.set(key, { start: now, count: 1 });
      return true;
    }
    row.count += 1;
    return row.count <= this.rateMax;
  }

  ingest(event) {
    this.load();
    if (event.kind === 'ended') {
      this.items = this.items.filter((row) => {
        if (!liveKind(row.kind)) return true;
        return !sameSession(row, event);
      });
      this.save();
      return;
    }
    if (liveKind(event.kind)) {
      const index = this.items.findIndex((row) => liveKind(row.kind) && sameSession(row, event));
      if (index !== -1) {
        const prev = this.items[index];
        this.items[index] = {
          agent: event.agent,
          kind: event.kind,
          vendor: event.vendor || prev.vendor,
          project: event.project || prev.project,
          line: event.line,
          session: event.session || prev.session,
          at: event.at,
          since: prev.since || event.at,
        };
      } else {
        this.items.push({
          agent: event.agent,
          kind: event.kind,
          vendor: event.vendor,
          project: event.project,
          line: event.line,
          session: event.session,
          at: event.at,
          since: event.at,
        });
      }
    } else {
      this.items = this.items.filter((row) => !(liveKind(row.kind) && sameSession(row, event)));
      this.items.push({
        agent: event.agent,
        kind: event.kind,
        vendor: event.vendor,
        project: event.project,
        line: event.line,
        session: event.session,
        at: event.at,
        since: event.at,
      });
    }
    const recent = this.items.filter((row) => row.kind === 'finished' || row.kind === 'failed');
    while (recent.length > RECENT_MAX) {
      const oldest = recent.shift();
      this.items = this.items.filter((row) => row !== oldest);
    }
    this.save();
  }

  applyStale() {
    const now = this.now();
    for (const row of this.items) {
      if (!liveKind(row.kind) || row.kind === 'needs_input') {
        delete row.stale;
        continue;
      }
      const age = now - row.at;
      if (age >= OFFLINE_MS) {
        row.kind = 'failed';
        row.line = 'offline';
        row.at = now;
        delete row.stale;
      } else if (age >= STALE_MS) {
        row.stale = true;
      } else {
        delete row.stale;
      }
    }
  }

  view(row) {
    const out = {
      agent: sourceName(row.agent),
      id: row.agent,
      vendor: row.vendor || '',
      project: row.project || '',
      line: row.line || '',
      kind: row.kind,
      at: new Date(row.at).toISOString(),
      since: new Date(row.since || row.at).toISOString(),
    };
    if (row.stale) out.stale = true;
    return out;
  }

  publicBody() {
    this.load();
    this.applyStale();
    this.save();
    const needs = [];
    const working = [];
    const recent = [];
    const rows = this.items.slice().sort((a, b) => b.at - a.at);
    for (const row of rows) {
      const view = this.view(row);
      if (row.kind === 'needs_input') needs.push(view);
      else if (row.kind === 'started' || row.kind === 'working' || row.kind === 'running') working.push(view);
      else if (row.kind === 'finished' || row.kind === 'failed') recent.push(view);
    }
    return { needs, working, recent };
  }
}
