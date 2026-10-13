import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AlertBoard, quietHoursConfig, urgentSourcesFromEnv } from '../src/alerts.mjs';
import { handleMcp, PROTOCOL_VERSIONS, TOOLS } from '../src/mcp.mjs';
import { AgentWall } from '../src/status.mjs';

const NOW = Date.parse('2026-10-12T14:00:00Z');

function context() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-mcp-'));
  const clock = { at: NOW };
  const now = () => clock.at;
  return {
    alerts: new AlertBoard({ file: path.join(dir, 'alerts.json'), now, quiet: null }),
    agentWall: new AgentWall({ file: path.join(dir, 'agent-wall.json'), now }),
    now,
    clock,
  };
}

function call(ctx, name, args, id) {
  return handleMcp({ jsonrpc: '2.0', id: id || 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
}

test('initialize agrees on a known protocol version and offers tools only', () => {
  const ctx = context();
  const known = handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, ctx);
  assert.equal(known.result.protocolVersion, '2025-06-18');
  assert.equal(known.result.serverInfo.name, 'alert-frame');
  const unknown = handleMcp({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } }, ctx);
  assert.equal(unknown.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('notifications and client responses get no reply, and bad requests get JSON-RPC errors', () => {
  const ctx = context();
  assert.equal(handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  assert.equal(handleMcp({ jsonrpc: '2.0', id: 4, result: {} }, ctx), null);
  assert.equal(handleMcp([], ctx).error.code, -32600);
  assert.equal(handleMcp({ id: 1, method: 'ping' }, ctx).error.code, -32600);
  assert.equal(handleMcp({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, ctx).error.code, -32601);
  assert.equal(call(ctx, 'frame_reboot', {}).error.code, -32602);
  assert.deepEqual(handleMcp({ jsonrpc: '2.0', id: 3, method: 'ping' }, ctx), { jsonrpc: '2.0', id: 3, result: {} });
});

test('tools/list names the frame tools with closed input schemas', () => {
  const list = handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, context()).result.tools;
  assert.deepEqual(list.map((tool) => tool.name), ['frame_notify', 'frame_dismiss', 'frame_agent_status', 'frame_state']);
  TOOLS.forEach((tool) => {
    assert.equal(tool.inputSchema.additionalProperties, false);
  });
});

test('frame_notify puts an alert up, frame_state shows it, and frame_dismiss takes it down', () => {
  const ctx = context();
  const shown = call(ctx, 'frame_notify', { text: 'Build is green', level: 'whisper', source: 'coder' });
  assert.equal(shown.result.isError, undefined);
  const id = /Alert id ([a-f0-9]{12})/.exec(shown.result.content[0].text)[1];
  assert.match(shown.result.content[0].text, /whisper for 600 s/);
  const state = JSON.parse(call(ctx, 'frame_state', {}).result.content[0].text);
  assert.equal(state.alerts[0].id, id);
  assert.equal(state.alerts[0].source, 'Coder');
  assert.deepEqual(state.agents.needs, []);
  assert.equal(call(ctx, 'frame_dismiss', { id }).result.content[0].text, 'Removed.');
  assert.equal(call(ctx, 'frame_dismiss', { id }).result.isError, true);
  assert.deepEqual(ctx.alerts.publicBody().alerts, []);
});

test('an urgent alert stays until someone taps it, and a bad level is a tool error', () => {
  const ctx = context();
  ctx.urgentSources = urgentSourcesFromEnv();
  const text = call(ctx, 'frame_notify', { text: 'Door left open', level: 'urgent', source: 'ops' }).result.content[0].text;
  assert.match(text, /Shown as urgent until someone taps it/);
  const bad = call(ctx, 'frame_notify', { text: 'x', level: 'siren' });
  assert.equal(bad.result.isError, true);
  for (let i = 0; i < 30; i++) call(ctx, 'frame_notify', { text: 'n' + i, source: 'coder' });
  assert.match(call(ctx, 'frame_notify', { text: 'one more', source: 'coder' }).result.content[0].text, /Too many alerts/);
});

test('unknown tools and extra fields are refused', () => {
  const ctx = context();
  assert.equal(call(ctx, 'frame_reboot', {}).error.code, -32602);
  assert.equal(call(ctx, 'frame_notify', { text: 'hi', prompt: 'secret' }).result.isError, true);
});

test('secret-looking MCP text is a tool error', () => {
  const ctx = context();
  const secret = call(ctx, 'frame_notify', { text: 'token=super-secret' });
  assert.equal(secret.result.isError, true);
  assert.match(secret.result.content[0].text, /secret/);
});

test('frame_agent_status feeds the status board through the same rules as HTTP events', () => {
  const ctx = context();
  const done = call(ctx, 'frame_agent_status', { agent: 'coder', vendor: 'local', kind: 'needs_input', project: 'workspace/demo', line: 'Waiting for permission' });
  assert.equal(done.result.content[0].text, 'Shown as needs_input.');
  const wall = ctx.agentWall.publicBody();
  assert.equal(wall.needs[0].agent, 'Coder');
  assert.equal(wall.needs[0].project, 'demo');
  const refused = call(ctx, 'frame_agent_status', { agent: 'coder', kind: 'needs_input', prompt: 'secret' });
  assert.equal(refused.result.isError, true);
});

test('a per-source token cannot notify, dismiss, or report status as another source', () => {
  const ctx = context();
  ctx.authSource = 'ops';
  const denied = call(ctx, 'frame_notify', { text: 'hello', source: 'coder' });
  assert.equal(denied.httpStatus, 403);
  assert.equal(denied.error.code, -32003);
  const shown = call(ctx, 'frame_notify', { text: 'Approve this' });
  assert.match(shown.result.content[0].text, /Alert id/);
  assert.equal(ctx.alerts.publicBody().alerts[0].source, 'Ops');
  const other = context();
  const posted = call(other, 'frame_notify', { text: 'coder note', source: 'coder' });
  const id = /Alert id ([a-f0-9]{12})/.exec(posted.result.content[0].text)[1];
  other.authSource = 'ops';
  assert.equal(call(other, 'frame_dismiss', { id }).httpStatus, 403);
  other.authSource = 'coder';
  assert.equal(call(other, 'frame_dismiss', { id }).result.content[0].text, 'Removed.');
  ctx.authSource = 'ops';
  assert.equal(call(ctx, 'frame_agent_status', { agent: 'coder', kind: 'running', line: 'work' }).httpStatus, 403);
  assert.equal(call(ctx, 'frame_agent_status', { kind: 'running', line: 'work' }).result.content[0].text, 'Shown as running.');
});

test('urgent from a source off the allowlist is downgraded, and the same key updates', () => {
  const ctx = context();
  ctx.urgentSources = urgentSourcesFromEnv();
  const dropped = call(ctx, 'frame_notify', { text: 'CI red', level: 'urgent', source: 'coder' });
  assert.match(dropped.result.content[0].text, /Shown as nudge/);
  assert.match(dropped.result.content[0].text, /urgent downgraded to nudge/);
  const kept = call(ctx, 'frame_notify', { text: 'Approve bill', level: 'urgent', source: 'daily' });
  assert.match(kept.result.content[0].text, /Shown as urgent until someone taps it/);
  const first = call(ctx, 'frame_notify', { text: 'old', source: 'coder', key: 'job-1' });
  const id = /Alert id ([a-f0-9]{12})/.exec(first.result.content[0].text)[1];
  const again = call(ctx, 'frame_notify', { text: 'new', source: 'coder', key: 'job-1' });
  assert.match(again.result.content[0].text, /Updated existing alert/);
  assert.match(again.result.content[0].text, new RegExp('Alert id ' + id));
});

test('running with no update is stale at 15 minutes and failed/offline at 60', () => {
  const ctx = context();
  assert.equal(call(ctx, 'frame_agent_status', { agent: 'coder', kind: 'running', line: 'working' }).result.content[0].text, 'Shown as running.');
  ctx.clock.at = NOW + 15 * 60 * 1000;
  let state = JSON.parse(call(ctx, 'frame_state', {}).result.content[0].text);
  assert.equal(state.agents.working[0].stale, true);
  ctx.clock.at = NOW + 60 * 60 * 1000;
  state = JSON.parse(call(ctx, 'frame_state', {}).result.content[0].text);
  assert.equal(state.agents.working.length, 0);
  assert.equal(state.agents.recent[0].kind, 'failed');
  assert.equal(state.agents.recent[0].line, 'offline');
});

test('quiet hours queue a nudge and mark urgent silent', () => {
  const ctx = context();
  ctx.clock.at = Date.parse('2026-10-13T03:30:00Z');
  ctx.quiet = quietHoursConfig({ AGENT_QUIET_TZ: 'America/New_York' });
  ctx.alerts.quiet = ctx.quiet;
  const queued = call(ctx, 'frame_notify', { text: 'failed job', level: 'nudge', source: 'coder' });
  assert.match(queued.result.content[0].text, /queued until 07:00/);
  call(ctx, 'frame_notify', { text: 'need you', level: 'urgent', source: 'ops' });
  const state = JSON.parse(call(ctx, 'frame_state', {}).result.content[0].text);
  assert.equal(state.alerts.some((row) => row.level === 'nudge'), false);
  assert.equal(state.alerts.find((row) => row.level === 'urgent').silent, true);
});
