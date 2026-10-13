#!/usr/bin/env node
// Post a desk event over MCP. No dependencies. Node 18+.
//
//   node scripts/frame-notify.mjs <needs_input|failed|finished|heartbeat> <source> "text" [--key k] [--url url]
//
// Settings: FRAME_URL or --url (required, no default), FRAME_AGENT_TOKEN,
// CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, or --config {url,token,client_id,client_secret}.
// Never prints tokens.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { looksLikeSecret } from '../src/secrets.mjs';

export { looksLikeSecret };

const KINDS = new Set(['needs_input', 'failed', 'finished', 'heartbeat']);
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROTOCOL = '2025-06-18';

export function parseArgs(argv) {
  const out = { rest: [], key: '', config: '', url: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--key' || arg === '--config' || arg === '--url') && i + 1 < argv.length) {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      out.rest.push(arg);
    }
  }
  return out;
}

export function mcpUrl(url) {
  const raw = String(url || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return /\/mcp$/i.test(raw) ? raw : raw + '/mcp';
}

export function buildCall(kind, source, text, key) {
  if (kind === 'heartbeat') {
    const args = { agent: source, kind: 'running', line: text };
    return { name: 'frame_agent_status', arguments: args };
  }
  const level = kind === 'needs_input' ? 'urgent' : kind === 'failed' ? 'nudge' : 'whisper';
  const args = { text, level, source };
  if (kind === 'finished') args.ttl_s = 7200;
  if (key) args.key = key;
  return { name: 'frame_notify', arguments: args };
}

function loadConfig(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return { error: 'cannot read --config file' };
  }
}

function settings(opts) {
  const file = loadConfig(opts.config);
  if (file.error) return file;
  return {
    url: mcpUrl(process.env.FRAME_URL || opts.url || file.url || ''),
    token: String(process.env.FRAME_AGENT_TOKEN || file.token || ''),
    client_id: String(process.env.CF_ACCESS_CLIENT_ID || file.client_id || ''),
    client_secret: String(process.env.CF_ACCESS_CLIENT_SECRET || file.client_secret || ''),
  };
}

function headers(cfg) {
  const out = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
    authorization: 'Bearer ' + cfg.token,
  };
  if (cfg.client_id) out['CF-Access-Client-Id'] = cfg.client_id;
  if (cfg.client_secret) out['CF-Access-Client-Secret'] = cfg.client_secret;
  return out;
}

async function readRpc(response) {
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (!text) return null;
  if (type.includes('text/event-stream')) {
    let last = null;
    text.split(/\r?\n/).forEach((line) => {
      if (line.indexOf('data:') !== 0) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try { last = JSON.parse(payload); } catch { /* ignore a bad SSE line */ }
    });
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function needsInitialize(body) {
  const err = body && body.error;
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return err.code === -32002 || msg.indexOf('initialize') !== -1;
}

let rpcId = 1;

async function rpc(url, hdrs, method, params, withId) {
  const body = { jsonrpc: '2.0', method };
  if (withId) body.id = rpcId++;
  if (params) body.params = params;
  const response = await fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  if (!withId) return { status: response.status, body: null };
  return { status: response.status, body: await readRpc(response) };
}

async function callTool(url, hdrs, name, args) {
  let result = await rpc(url, hdrs, 'tools/call', { name, arguments: args }, true);
  if (needsInitialize(result.body)) {
    await rpc(url, hdrs, 'initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'frame-notify', version: '0.1.0' },
    }, true);
    await rpc(url, hdrs, 'notifications/initialized', {}, false);
    result = await rpc(url, hdrs, 'tools/call', { name, arguments: args }, true);
  }
  return result;
}

function usage() {
  return 'usage: frame-notify.mjs <needs_input|failed|finished|heartbeat> <source> "text" [--key k] [--url url] [--config file]';
}

async function main(argv) {
  const opts = parseArgs(argv);
  const kind = opts.rest[0] || '';
  const source = opts.rest[1] || '';
  const text = opts.rest.slice(2).join(' ');
  if (!KINDS.has(kind) || !SOURCE_RE.test(source) || !text) {
    process.stderr.write(usage() + '\n');
    return 1;
  }
  if (looksLikeSecret(text) || (opts.key && looksLikeSecret(opts.key))) {
    process.stderr.write('refusing to send text that looks like a secret\n');
    return 2;
  }
  const cfg = settings(opts);
  if (cfg.error) {
    process.stderr.write(cfg.error + '\n');
    return 1;
  }
  if (!cfg.url) {
    process.stderr.write('FRAME_URL is not set\n');
    return 2;
  }
  if (!cfg.token) {
    process.stderr.write('FRAME_AGENT_TOKEN is not set\n');
    return 1;
  }
  const call = buildCall(kind, source, text, opts.key);
  const result = await callTool(cfg.url, headers(cfg), call.name, call.arguments);
  if (result.status === 401 || result.status === 403) {
    process.stderr.write('request refused\n');
    return 1;
  }
  const body = result.body;
  if (!body) {
    process.stderr.write('no MCP reply\n');
    return 1;
  }
  if (body.error) {
    process.stderr.write(String(body.error.message || 'MCP error') + '\n');
    return 1;
  }
  const line = body.result && body.result.content && body.result.content[0] && body.result.content[0].text;
  if (line) process.stdout.write(line + (line.endsWith('\n') ? '' : '\n'));
  if (body.result && body.result.isError) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch(() => {
    process.stderr.write('request failed\n');
    process.exit(1);
  });
}
