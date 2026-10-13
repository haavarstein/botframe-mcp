import assert from 'node:assert/strict';
import test from 'node:test';
import { inQuietHours, nextQuietEnd, quietHoursConfig } from '../src/alerts.mjs';
import { pad, zonedToUtc } from '../src/time.mjs';

test('quiet hours wrap midnight and turn off when start equals end', () => {
  const quiet = quietHoursConfig({ AGENT_QUIET_TZ: 'America/New_York', AGENT_QUIET_HOURS: '23:00-07:00' });
  assert.equal(quiet.endLabel, '07:00');
  const night = Date.parse('2026-10-13T03:30:00Z');
  const morning = Date.parse('2026-10-13T11:00:00Z');
  const noon = Date.parse('2026-10-13T16:00:00Z');
  assert.equal(inQuietHours(night, quiet), true);
  assert.equal(inQuietHours(morning, quiet), false);
  assert.equal(inQuietHours(noon, quiet), false);
  assert.equal(nextQuietEnd(night, quiet), Date.parse('2026-10-13T11:00:00Z'));
  const off = quietHoursConfig({ AGENT_QUIET_TZ: 'America/New_York', AGENT_QUIET_START: '08:00', AGENT_QUIET_END: '08:00' });
  assert.equal(inQuietHours(night, off), false);
});

test('zonedToUtc matches a known America/New_York wall time', () => {
  assert.equal(pad(7), '07');
  assert.equal(zonedToUtc(2026, 10, 13, 7, 0, 0, 'America/New_York'), Date.parse('2026-10-13T11:00:00Z'));
});
