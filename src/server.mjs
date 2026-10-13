#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authenticateAgent, loadSourceTokens } from './agent-tokens.mjs';
import { AlertBoard, isAlertId, parseAlert, prepareAlert, quietHoursConfig, urgentSourcesFromEnv } from './alerts.mjs';
import { assertPosixMode600, clientKey, jsonPostAllowed, RateLimiter, tokenMatches } from './guard.mjs';
import { handleMcp } from './mcp.mjs';
import { AgentWall, parseEvent } from './status.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(ROOT, 'frame.html'));
const MCP_BODY_MAX = 64 * 1024;
const WRITE_MAX = 60;
const MCP_MAX = 120;
const DISMISS_MAX = 60;
const RATE_MS = 60 * 1000;

function readJson(req, limit) {
  const max = limit || 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('too big'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type, extra) {
  const headers = { 'content-type': type, 'cache-control': 'no-store', ...(extra || {}) };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function bindRequestSource(req, res, raw, field) {
  if (!req.agentAuthSource) return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const given = raw[field] == null || raw[field] === '' ? '' : String(raw[field]).toLowerCase();
  if (given && given !== req.agentAuthSource) {
    sendJson(res, 403, { error: 'source' });
    return null;
  }
  raw[field] = req.agentAuthSource;
  return raw;
}

export const TOKENS_FILE_ERROR = 'agent tokens file is missing, malformed, or has no valid entries';

export function isLoopbackHost(host) {
  const value = String(host == null ? '' : host).trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!octets) return false;
  return octets.slice(1).every((part) => Number(part) <= 255);
}

function tokensFileMustBeValid(tokensFile, configured) {
  if (configured && tokensFile) return true;
  return Boolean(tokensFile && fs.existsSync(tokensFile));
}

export function validateStartup(options) {
  const tokensFile = options.tokensFile || '';
  const envFile = options.envFile || '';
  if (tokensFile && fs.existsSync(tokensFile)) assertPosixMode600(tokensFile);
  if (envFile && fs.existsSync(envFile)) assertPosixMode600(envFile);
  const required = tokensFileMustBeValid(tokensFile, options.tokensFileConfigured === true);
  let sourceTokens;
  if (options.sourceTokens) {
    sourceTokens = options.sourceTokens;
  } else {
    const loaded = loadSourceTokens(tokensFile);
    if (required && !loaded.ok) throw new Error(TOKENS_FILE_ERROR);
    sourceTokens = loaded.tokens;
  }
  if (required && !Object.keys(sourceTokens).length) throw new Error(TOKENS_FILE_ERROR);
  const legacyToken = options.legacyToken || '';
  if (legacyToken && Object.keys(sourceTokens).length) {
    throw new Error('legacy token cannot be set together with per-source token hashes');
  }
  return { sourceTokens, legacyToken: Object.keys(sourceTokens).length ? '' : legacyToken };
}

export function createServer(options) {
  const alerts = options.alerts;
  const agentWall = options.agentWall;
  const now = options.now || (() => Date.now());
  const frameToken = options.frameToken || '';
  const urgentSources = options.urgentSources || alerts.urgentSources;
  const quiet = options.quiet || alerts.quiet;
  const writeLimit = options.writeLimit || new RateLimiter({ max: WRITE_MAX, windowMs: RATE_MS, now });
  const mcpLimit = options.mcpLimit || new RateLimiter({ max: MCP_MAX, windowMs: RATE_MS, now });
  const dismissLimit = options.dismissLimit || new RateLimiter({ max: DISMISS_MAX, windowMs: RATE_MS, now });
  const eventLimit = options.eventLimit || new RateLimiter({ max: MCP_MAX, windowMs: RATE_MS, now });

  const startFile = options.tokensFile || '';
  const fileRequiredAtStart = !!startFile && tokensFileMustBeValid(startFile, options.tokensFileConfigured === true);

  function loadAgentAuth() {
    const file = options.tokensFile || '';
    const configured = options.tokensFileConfigured === true;
    if (file && (fileRequiredAtStart || tokensFileMustBeValid(file, configured))) {
      const loaded = loadSourceTokens(file);
      if (!loaded.ok) return { broken: true, sourceTokens: {}, legacyToken: '' };
      return { broken: false, sourceTokens: loaded.tokens, legacyToken: '' };
    }
    const sourceTokens = options.sourceTokens || {};
    if (Object.keys(sourceTokens).length) {
      return { broken: false, sourceTokens, legacyToken: '' };
    }
    return { broken: false, sourceTokens: {}, legacyToken: options.token || '' };
  }

  function agentTokenOk(req, res) {
    const auth = loadAgentAuth();
    if (auth.broken) {
      console.error(TOKENS_FILE_ERROR + '; refusing agent auth');
      sendJson(res, 401, { error: 'token' });
      return false;
    }
    const result = authenticateAgent(req.headers.authorization, {
      legacyToken: auth.legacyToken,
      sourceTokens: auth.sourceTokens,
    });
    if (!result.ok) {
      if (result.status === 404) {
        send(res, 404, 'Not found', 'text/plain; charset=utf-8');
        return false;
      }
      sendJson(res, 401, { error: 'token' });
      return false;
    }
    req.agentAuthSource = result.source || null;
    return true;
  }

  function frameTokenOk(req, res) {
    if (!frameToken || frameToken.length < 16) {
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return false;
    }
    if (!tokenMatches(req.headers.authorization, frameToken)) {
      sendJson(res, 401, { error: 'token' });
      return false;
    }
    return true;
  }

  function rateOk(res, limiter, key) {
    if (!limiter || limiter.allow(key)) return true;
    sendJson(res, 429, { error: 'slow down' });
    return false;
  }

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      send(res, 400, 'Bad request', 'text/plain; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/frame')) {
      send(res, 200, PAGE, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/alerts') {
      sendJson(res, 200, alerts.publicBody());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/agents/wall') {
      sendJson(res, 200, agentWall ? agentWall.publicBody() : { needs: [], working: [], recent: [] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      if (!jsonPostAllowed(req.headers)) {
        sendJson(res, 403, { error: 'not allowed' });
        return;
      }
      if (!rateOk(res, mcpLimit, clientKey(req))) return;
      if (!agentTokenOk(req, res)) return;
      let message;
      try {
        message = await readJson(req, MCP_BODY_MAX);
      } catch {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const answer = handleMcp(message, {
        alerts,
        agentWall,
        now,
        authSource: req.agentAuthSource || null,
        urgentSources,
        quiet,
      });
      if (!answer) {
        send(res, 202, '', 'text/plain; charset=utf-8');
        return;
      }
      const status = answer.httpStatus || 200;
      if (answer.httpStatus) delete answer.httpStatus;
      sendJson(res, status, answer);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/alerts') {
      if (!jsonPostAllowed(req.headers)) {
        sendJson(res, 403, { error: 'not allowed' });
        return;
      }
      if (!rateOk(res, writeLimit, clientKey(req))) return;
      if (!agentTokenOk(req, res)) return;
      let raw;
      try {
        raw = await readJson(req);
      } catch {
        sendJson(res, 400, { error: 'json' });
        return;
      }
      raw = bindRequestSource(req, res, raw, 'source');
      if (res.headersSent) return;
      const parsed = parseAlert(raw, now());
      if (parsed.error) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      const prepared = prepareAlert(parsed.alert, { urgentSources, quiet, now: now() });
      if (!alerts.allow(prepared.alert.source)) {
        sendJson(res, 429, { error: 'slow down' });
        return;
      }
      const alert = alerts.add(prepared.alert);
      const body = { id: alert.id };
      if (prepared.downgraded) {
        body.level = alert.level;
        body.downgraded = true;
      }
      if (prepared.queued) body.queued = true;
      sendJson(res, 200, body);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/alerts/dismiss') {
      if (!jsonPostAllowed(req.headers)) {
        sendJson(res, 403, { error: 'not allowed' });
        return;
      }
      if (!rateOk(res, dismissLimit, clientKey(req))) return;
      if (!frameTokenOk(req, res)) return;
      let raw;
      try {
        raw = await readJson(req);
      } catch {
        sendJson(res, 400, { error: 'json' });
        return;
      }
      if (!raw || Object.keys(raw).length !== 1 || !isAlertId(raw.id)) {
        sendJson(res, 400, { error: 'id' });
        return;
      }
      alerts.dismiss(raw.id);
      send(res, 204, '', 'text/plain; charset=utf-8');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agents/events') {
      if (!jsonPostAllowed(req.headers)) {
        sendJson(res, 403, { error: 'not allowed' });
        return;
      }
      if (!rateOk(res, eventLimit, clientKey(req))) return;
      if (!agentTokenOk(req, res)) return;
      let raw;
      try {
        raw = await readJson(req);
      } catch {
        sendJson(res, 400, { error: 'json' });
        return;
      }
      raw = bindRequestSource(req, res, raw, 'agent');
      if (res.headersSent) return;
      const event = parseEvent(raw, now());
      if (!event) {
        sendJson(res, 400, { error: 'event' });
        return;
      }
      if (!agentWall.allow(event.agent)) {
        sendJson(res, 429, { error: 'slow down' });
        return;
      }
      agentWall.ingest(event);
      send(res, 204, '', 'text/plain; charset=utf-8');
      return;
    }
    if (url.pathname === '/mcp') {
      send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { allow: 'POST' });
      return;
    }
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  });
}

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] != null) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export async function listen(options = {}) {
  const cwd = options.cwd || process.cwd();
  const envFile = options.envFile !== undefined ? options.envFile : path.join(cwd, '.env');
  if (envFile) loadEnvFile(envFile);
  const envTokensFile = process.env.AGENT_SOURCE_TOKENS_FILE || '';
  const tokensFile = options.tokensFile !== undefined
    ? options.tokensFile
    : (envTokensFile || path.join(cwd, 'config', 'agent-tokens.json'));
  const tokensFileConfigured = options.tokensFile !== undefined
    ? Boolean(options.tokensFile)
    : Boolean(envTokensFile);
  const legacyToken = options.token ?? process.env.AGENT_EVENTS_TOKEN ?? '';
  const checked = validateStartup({
    tokensFile,
    tokensFileConfigured,
    envFile,
    legacyToken,
    sourceTokens: options.sourceTokens,
  });
  const host = options.host || process.env.FRAME_HOST || '127.0.0.1';
  const port = Number(options.port || process.env.FRAME_PORT || 8090);
  const file = options.file || process.env.FRAME_ALERTS_FILE || path.join(cwd, 'data', 'alerts.json');
  const statusFile = options.statusFile || process.env.FRAME_STATUS_FILE || path.join(cwd, 'data', 'agent-wall.json');
  const frameToken = options.frameToken ?? process.env.FRAME_TOKEN ?? '';
  const now = options.now || (() => Date.now());
  const quiet = options.quiet || quietHoursConfig(process.env);
  const urgentSources = options.urgentSources || urgentSourcesFromEnv(process.env.AGENT_URGENT_SOURCES);
  const alerts = options.alerts || new AlertBoard({ file, now, quiet, urgentSources });
  const agentWall = options.agentWall || new AgentWall({ file: statusFile, now });
  const server = createServer({
    token: checked.legacyToken,
    frameToken,
    sourceTokens: checked.sourceTokens,
    tokensFile,
    tokensFileConfigured,
    alerts,
    agentWall,
    now,
    urgentSources,
    quiet,
    writeLimit: options.writeLimit,
    mcpLimit: options.mcpLimit,
    dismissLimit: options.dismissLimit,
    eventLimit: options.eventLimit,
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      if (!isLoopbackHost(host)) {
        console.warn('FRAME_HOST is not loopback; the server is reachable beyond this machine');
      }
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await listen();
    const address = server.address();
    console.log('alert frame on http://' + address.address + ':' + address.port + '/');
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
