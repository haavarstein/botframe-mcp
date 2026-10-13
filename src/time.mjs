export function pad(n) {
  return String(n).padStart(2, '0');
}

export function addDays(wall, days) {
  const utc = Date.UTC(wall.y, wall.mo - 1, wall.d + days);
  const d = new Date(utc);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

export function zonedToUtc(y, mo, d, h, mi, s, timeZone) {
  const want = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  let utc = want;
  for (let i = 0; i < 8; i++) {
    const p = tzParts(new Date(utc), timeZone);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const diff = want - got;
    if (diff === 0) return utc;
    utc += diff;
  }
  return utc;
}
