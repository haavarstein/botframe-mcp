import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentWall, OFFLINE_MS, parseEvent, STALE_MS } from '../src/status.mjs';

const NOW = Date.parse('2026-10-12T14:00:00Z');

function wall(clock) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-wall-')), 'agent-wall.json');
  return new AgentWall({ file, now: () => clock.at });
}

test('parseEvent keeps the last folder and refuses extra fields', () => {
  const event = parseEvent({ agent: 'coder', kind: 'running', project: 'workspace/demo-app', line: 'working' }, NOW);
  assert.equal(event.project, 'demo-app');
  assert.equal(event.line, 'working');
  assert.equal(parseEvent({ agent: 'coder', kind: 'running', prompt: 'secret' }, NOW), null);
  assert.equal(parseEvent({ agent: 'coder', kind: 'running', line: 'sk-abc123' }, NOW), null);
});

test('running with no update is stale at 15 minutes and failed/offline at 60', () => {
  const clock = { at: NOW };
  const agents = wall(clock);
  agents.ingest(parseEvent({ agent: 'coder', kind: 'running', line: 'working' }, NOW));
  clock.at = NOW + STALE_MS;
  let body = agents.publicBody();
  assert.equal(body.working[0].stale, true);
  clock.at = NOW + OFFLINE_MS;
  body = agents.publicBody();
  assert.equal(body.working.length, 0);
  assert.equal(body.recent[0].kind, 'failed');
  assert.equal(body.recent[0].line, 'offline');
});

test('needs_input and ended move a session on and off the board', () => {
  const clock = { at: NOW };
  const agents = wall(clock);
  agents.ingest(parseEvent({ agent: 'ops', kind: 'needs_input', line: 'Approve this' }, NOW));
  assert.equal(agents.publicBody().needs[0].agent, 'Ops');
  agents.ingest(parseEvent({ agent: 'ops', kind: 'ended' }, NOW));
  assert.deepEqual(agents.publicBody().needs, []);
});

test('each agent can send 120 status events a minute', () => {
  const clock = { at: NOW };
  const agents = wall(clock);
  for (let i = 0; i < 120; i++) assert.equal(agents.allow('coder'), true);
  assert.equal(agents.allow('coder'), false);
  assert.equal(agents.allow('ops'), true);
});
