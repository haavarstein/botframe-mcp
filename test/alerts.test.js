import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AlertBoard, DEDUPE_MS, isAlertId, parseAlert, prepareAlert, quietHoursConfig, urgentSourcesFromEnv } from '../src/alerts.mjs';

const NOW = Date.parse('2026-10-12T14:00:00Z');

function boardFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-alerts-')), 'alerts.json');
}

function board(clock) {
  return new AlertBoard({ file: boardFile(), now: () => clock.at, quiet: null });
}

test('alerts outside the allowed shape are refused with a reason', () => {
  assert.match(parseAlert(null, NOW).error, /JSON object/);
  assert.match(parseAlert([], NOW).error, /JSON object/);
  assert.match(parseAlert({ text: '' }, NOW).error, /text is required/);
  assert.match(parseAlert({ text: 'hi', level: 'loud' }, NOW).error, /level/);
  assert.match(parseAlert({ text: 'hi', source: 'Bad Source' }, NOW).error, /source/);
  assert.match(parseAlert({ text: 'hi', ttl_s: 5 }, NOW).error, /ttl_s/);
  assert.match(parseAlert({ text: 'hi', ttl_s: 1.5 }, NOW).error, /ttl_s/);
  assert.match(parseAlert({ text: 'hi', ttl_s: 7201 }, NOW).error, /ttl_s/);
  assert.equal(parseAlert({ text: 'hi', ttl_s: 7200, level: 'whisper' }, NOW).alert.expiresAt, NOW + 7200 * 1000);
  assert.match(parseAlert({ text: 'hi', key: 'no spaces' }, NOW).error, /key/);
  assert.match(parseAlert({ text: 'hi', token: 'secret' }, NOW).error, /unknown field token/);
});

test('secret-looking alert text is rejected', () => {
  assert.match(parseAlert({ text: 'sk-live-secret' }, NOW).error, /secret/);
  assert.match(parseAlert({ text: 'ok', key: 'ghp_abc123def' }, NOW).error, /secret/);
  assert.match(parseAlert({ text: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----' }, NOW).error, /secret/);
  assert.equal(parseAlert({ text: 'Backup finished' }, NOW).error, undefined);
});

test('alert text loses links and control characters and is cut to 140 characters', () => {
  const { alert } = parseAlert({ text: 'Deploy done https://example.com/x?q=1\n' + 'word '.repeat(40), source: 'coder' }, NOW);
  assert.equal(alert.text.indexOf('http'), -1);
  assert.equal(alert.text.indexOf('\n'), -1);
  assert.equal(alert.text.length <= 140, true);
  assert.equal(alert.source, 'coder');
  assert.equal(isAlertId(alert.id), true);
});

test('each level gets its default time on screen and urgent never expires', () => {
  assert.equal(parseAlert({ text: 'a' }, NOW).alert.level, 'nudge');
  assert.equal(parseAlert({ text: 'a' }, NOW).alert.expiresAt, NOW + 60 * 1000);
  assert.equal(parseAlert({ text: 'a', level: 'whisper' }, NOW).alert.expiresAt, NOW + 600 * 1000);
  assert.equal(parseAlert({ text: 'a', ttl_s: 30 }, NOW).alert.expiresAt, NOW + 30 * 1000);
  assert.equal(parseAlert({ text: 'a', level: 'urgent', ttl_s: 30 }, NOW).alert.expiresAt, null);
});

test('the board shows newest first, counts down, and drops expired alerts', () => {
  const clock = { at: NOW };
  const alerts = board(clock);
  alerts.add(parseAlert({ text: 'first', ttl_s: 10 }, NOW).alert);
  alerts.add(parseAlert({ text: 'second', level: 'urgent', source: 'ops' }, NOW).alert);
  let body = alerts.publicBody();
  assert.deepEqual(body.alerts.map((row) => row.text), ['second', 'first']);
  assert.equal(body.alerts[0].source, 'Ops');
  assert.equal(body.alerts[0].remainingMs, null);
  assert.equal(body.alerts[1].remainingMs, 10000);
  assert.equal(body.alerts[1].ttlMs, 10000);
  clock.at = NOW + 4000;
  assert.equal(alerts.publicBody().alerts[1].remainingMs, 6000);
  clock.at = NOW + 10000;
  body = alerts.publicBody();
  assert.deepEqual(body.alerts.map((row) => row.text), ['second']);
});

test('dismiss removes one alert and reports whether it was there', () => {
  const clock = { at: NOW };
  const alerts = board(clock);
  const kept = alerts.add(parseAlert({ text: 'keep' }, NOW).alert);
  const gone = alerts.add(parseAlert({ text: 'go', level: 'urgent' }, NOW).alert);
  assert.equal(alerts.dismiss(gone.id), true);
  assert.equal(alerts.dismiss(gone.id), false);
  assert.deepEqual(alerts.publicBody().alerts.map((row) => row.id), [kept.id]);
});

test('past twenty alerts the oldest that is not urgent goes first', () => {
  const clock = { at: NOW };
  const alerts = board(clock);
  const urgent = alerts.add(parseAlert({ text: 'urgent', level: 'urgent' }, NOW).alert);
  for (let i = 0; i < 25; i++) alerts.add(parseAlert({ text: 'n' + i, ttl_s: 600 }, NOW).alert);
  const texts = alerts.publicBody().alerts.map((row) => row.text);
  assert.equal(texts.length, 20);
  assert.equal(texts.includes('urgent'), true);
  assert.equal(texts.includes('n5'), false);
  assert.equal(texts.includes('n6'), true);
  assert.equal(alerts.publicBody().alerts.some((row) => row.id === urgent.id), true);
});

test('alerts survive a restart, and a damaged file starts empty', () => {
  const file = boardFile();
  const first = new AlertBoard({ file, now: () => NOW, quiet: null });
  first.add(parseAlert({ text: 'still here', level: 'urgent' }, NOW).alert);
  const second = new AlertBoard({ file, now: () => NOW + 60 * 60 * 1000, quiet: null });
  assert.deepEqual(second.publicBody().alerts.map((row) => row.text), ['still here']);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(new AlertBoard({ file, now: () => NOW, quiet: null }).publicBody().alerts, []);
  fs.writeFileSync(file, JSON.stringify({ items: [{ id: 'bad', level: 'urgent', text: 'x' }] }));
  assert.deepEqual(new AlertBoard({ file, now: () => NOW, quiet: null }).publicBody().alerts, []);
});

test('each source can send thirty alerts a minute', () => {
  const clock = { at: NOW };
  const alerts = board(clock);
  for (let i = 0; i < 30; i++) assert.equal(alerts.allow('coder'), true);
  assert.equal(alerts.allow('coder'), false);
  assert.equal(alerts.allow('ops'), true);
  clock.at = NOW + 60 * 1000;
  assert.equal(alerts.allow('coder'), true);
});

test('the same source and key within fifteen minutes updates the existing alert', () => {
  const clock = { at: NOW };
  const alerts = board(clock);
  const first = alerts.add(parseAlert({ text: 'old line', source: 'coder', key: 'job-1' }, NOW).alert);
  const second = alerts.add(parseAlert({ text: 'new line', source: 'coder', key: 'job-1' }, NOW).alert);
  assert.equal(first.id, second.id);
  assert.equal(alerts.updatedLast, true);
  assert.deepEqual(alerts.publicBody().alerts.map((row) => row.text), ['new line']);
  alerts.add(parseAlert({ text: 'other', source: 'coder', key: 'job-2' }, NOW).alert);
  assert.equal(alerts.publicBody().alerts.length, 2);
  clock.at = NOW + DEDUPE_MS;
  const later = alerts.add(parseAlert({ text: 'new line', source: 'coder', key: 'job-1' }, clock.at).alert);
  assert.notEqual(later.id, first.id);
});

test('without a key, the text is the dedupe key', () => {
  const alerts = board({ at: NOW });
  const first = alerts.add(parseAlert({ text: 'Build is green', source: 'coder' }, NOW).alert);
  const second = alerts.add(parseAlert({ text: 'Build is green', source: 'coder' }, NOW).alert);
  assert.equal(first.id, second.id);
  assert.equal(alerts.publicBody().alerts.length, 1);
});

test('urgent from a source not on the allowlist is downgraded to nudge', () => {
  const allow = urgentSourcesFromEnv();
  assert.equal(allow.has('ops'), true);
  const dropped = prepareAlert(parseAlert({ text: 'CI red', level: 'urgent', source: 'coder' }, NOW).alert, { urgentSources: allow });
  assert.equal(dropped.downgraded, true);
  assert.equal(dropped.alert.level, 'nudge');
  assert.equal(dropped.alert.expiresAt, NOW + 60 * 1000);
  const kept = prepareAlert(parseAlert({ text: 'Approve', level: 'urgent', source: 'ops' }, NOW).alert, { urgentSources: allow });
  assert.equal(kept.downgraded, false);
  assert.equal(kept.alert.level, 'urgent');
  assert.equal(kept.alert.expiresAt, null);
});

test('quiet hours hide nudges until morning and mark urgent silent', () => {
  const quiet = quietHoursConfig({ AGENT_QUIET_TZ: 'America/New_York', AGENT_QUIET_START: '23:00', AGENT_QUIET_END: '07:00' });
  const night = Date.parse('2026-10-13T03:30:00Z');
  const morning = Date.parse('2026-10-13T11:00:00Z');
  const clock = { at: night };
  const alerts = new AlertBoard({ file: boardFile(), now: () => clock.at, quiet });
  const queued = prepareAlert(parseAlert({ text: 'failed job', level: 'nudge', source: 'coder' }, night).alert, { quiet, now: night });
  assert.equal(queued.queued, true);
  alerts.add(queued.alert);
  alerts.add(parseAlert({ text: 'need you', level: 'urgent', source: 'ops' }, night).alert);
  alerts.add(parseAlert({ text: 'brief done', level: 'whisper', source: 'desk' }, night).alert);
  const nightBody = alerts.publicBody().alerts;
  assert.deepEqual(nightBody.map((row) => row.level), ['whisper', 'urgent']);
  assert.equal(nightBody.find((row) => row.level === 'urgent').silent, true);
  assert.equal(nightBody.find((row) => row.level === 'whisper').silent, undefined);
  clock.at = morning;
  const dayBody = alerts.publicBody().alerts;
  assert.equal(dayBody.some((row) => row.text === 'failed job'), true);
  assert.equal(dayBody.find((row) => row.level === 'urgent').silent, undefined);
});
