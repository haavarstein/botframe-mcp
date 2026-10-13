import { inQuietHours, isAlertId, parseAlert, prepareAlert } from './alerts.mjs';
import { parseEvent } from './status.mjs';

// MCP over streamable HTTP, JSON responses only. Notifications only:
// show an alert, take it down, and read what is on the frame.

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'alert-frame', title: 'Alert frame', version: '0.1.0' };
const INSTRUCTIONS = 'Use frame_notify to put a short message on the wall frame, frame_dismiss to take it down, and frame_state to see the alerts that are up. '
  + 'Prefer whisper or nudge. Nudge is a card that leaves on its own. Urgent is a full notice that stays until someone taps it. '
  + 'Use frame_agent_status for a heartbeat; running with no update goes stale, then offline. '
  + 'Do not send secrets, prompts, commands, or file contents.';

export const TOOLS = [
  {
    name: 'frame_notify',
    title: 'Show an alert on the frame',
    description: 'Put a short message on the wall frame. whisper is a small line in the corner. nudge is a card that leaves on its own. '
      + 'urgent is a full notice and stays until someone taps it. Same source+key (or text) within 15 minutes updates the existing alert. Links and line breaks are removed. Returns the alert id.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 140, description: 'The message, up to 140 characters.' },
        level: { type: 'string', enum: ['whisper', 'nudge', 'urgent'], description: 'Defaults to nudge.' },
        source: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$', description: 'Who is sending it, for example coder.' },
        ttl_s: { type: 'integer', minimum: 10, maximum: 7200, description: 'Seconds on screen. Defaults to 600 for whisper and 60 for nudge. Urgent ignores it.' },
        key: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,64}$', description: 'Dedupe key. Same source+key within 15 minutes updates the existing alert instead of stacking.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'frame_dismiss',
    title: 'Remove an alert',
    description: 'Take an alert off the frame by the id frame_notify returned.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-f0-9]{12}$', description: 'The 12-character id frame_notify returned.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'frame_agent_status',
    title: 'Report agent status',
    description: 'Show a short status line on the frame. needs_input, started, working, and running are live. finished and failed move to recent. ended takes the session off. running with no update for 15 minutes is marked stale; after 60 minutes it shows as failed/offline.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$', description: 'Your id, for example coder.' },
        kind: { type: 'string', enum: ['needs_input', 'started', 'working', 'running', 'finished', 'failed', 'ended'] },
        vendor: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,19}$' },
        project: { type: 'string', description: 'Only the last folder name is kept.' },
        line: { type: 'string', description: 'One short line, cut to 80 characters.' },
        session: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,64}$', description: 'Groups one run. Do not send a raw session id.' },
      },
      required: ['agent', 'kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'frame_state',
    title: 'Read alerts on the frame',
    description: 'The alerts on the frame now, plus live agent status. Newest first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function reply(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function failure(id, code, message, httpStatus) {
  const out = { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
  if (httpStatus) out.httpStatus = httpStatus;
  return out;
}

function toolText(text, isError) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

function requestSource(input, field) {
  const value = input && input[field];
  if (value == null || value === '') return '';
  return String(value).toLowerCase();
}

function bindSource(input, field, authSource) {
  if (!authSource) return { ok: true, input };
  const given = requestSource(input, field);
  if (given && given !== authSource) return { ok: false };
  const next = Object.assign({}, input);
  next[field] = authSource;
  return { ok: true, input: next };
}

function callTool(name, args, ctx) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const now = ctx.now();
  const authSource = ctx.authSource || null;
  if (name === 'frame_notify') {
    const bound = bindSource(input, 'source', authSource);
    if (!bound.ok) return { forbidden: true };
    const parsed = parseAlert(bound.input, now);
    if (parsed.error) return toolText(parsed.error, true);
    const prepared = prepareAlert(parsed.alert, {
      urgentSources: ctx.urgentSources || ctx.alerts.urgentSources,
      quiet: ctx.quiet || ctx.alerts.quiet,
      now,
    });
    if (!ctx.alerts.allow(prepared.alert.source)) return toolText('Too many alerts from this source in the last minute. Try again shortly.', true);
    const alert = ctx.alerts.add(prepared.alert);
    const quietCfg = ctx.quiet || ctx.alerts.quiet;
    const quietEnd = (quietCfg && quietCfg.endLabel) || '07:00';
    let how;
    if (alert.expiresAt == null) how = 'until someone taps it';
    else if (prepared.queued) how = 'after ' + quietEnd;
    else how = 'for ' + Math.round((alert.expiresAt - alert.at) / 1000) + ' s';
    const bits = [];
    if (ctx.alerts.updatedLast) bits.push('Updated existing alert');
    bits.push('Shown as ' + alert.level + ' ' + how);
    if (prepared.downgraded) bits.push('urgent downgraded to nudge');
    if (prepared.queued) bits.push('queued until ' + quietEnd);
    if (alert.level === 'urgent' && inQuietHours(now, quietCfg)) bits.push('shown silent');
    return toolText(bits.join('. ') + '. Alert id ' + alert.id + '.');
  }
  if (name === 'frame_dismiss') {
    if (!isAlertId(input.id)) return toolText('id must be the 12-character id frame_notify returned', true);
    const row = ctx.alerts.get(input.id);
    if (row && authSource && (row.source || '') !== authSource) return { forbidden: true };
    return ctx.alerts.dismiss(input.id) ? toolText('Removed.') : toolText('No alert with that id is on the frame.', true);
  }
  if (name === 'frame_agent_status') {
    const bound = bindSource(input, 'agent', authSource);
    if (!bound.ok) return { forbidden: true };
    const event = parseEvent(bound.input, now);
    if (!event) return toolText('The status is outside the allowed shape. agent and kind are required; see the input schema.', true);
    if (!ctx.agentWall.allow(event.agent)) return toolText('Too many updates from this agent in the last minute.', true);
    ctx.agentWall.ingest(event);
    return toolText('Shown as ' + event.kind + '.');
  }
  if (name === 'frame_state') {
    const agents = ctx.agentWall ? ctx.agentWall.publicBody() : { needs: [], working: [], recent: [] };
    return toolText(JSON.stringify({ alerts: ctx.alerts.publicBody().alerts, agents }));
  }
  return null;
}

export function handleMcp(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return failure(null, -32600, 'Invalid request');
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (typeof message.method !== 'string') return hasId && ('result' in message || 'error' in message) ? null : failure(message.id, -32600, 'Invalid request');
  if (!hasId) return null;
  const id = message.id;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.indexOf(asked) !== -1 ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const result = callTool(String(params.name || ''), params.arguments, ctx);
      if (result && result.forbidden) return failure(id, -32003, 'source does not match token', 403);
      return result ? reply(id, result) : failure(id, -32602, 'Unknown tool: ' + String(params.name || ''));
    }
    default:
      return failure(id, -32601, 'Method not found: ' + message.method);
  }
}
