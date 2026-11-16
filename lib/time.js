'use strict';
// UK-time date maths. Everything is worked out on a Glasgow wall clock, whatever
// time zone the server runs in, and stays right across the clock changes.

const TZ = 'Europe/London';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

const wallFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// The clock on a wall in Glasgow at a given instant.
function londonWall(ms) {
  const p = {};
  for (const part of wallFmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, hh: p.hour % 24, mm: p.minute, ss: p.second };
}

// A calendar date, held as UTC noon so adding days never trips on a clock change.
const civil = (y, m, d) => Date.UTC(y, m - 1, d, 12);
const addDays = (c, n) => c + n * DAY_MS;
function civilParts(c) {
  const dt = new Date(c);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}
const pad2 = n => (n < 10 ? '0' : '') + n;
const iso = c => { const p = civilParts(c); return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`; };
const label = c => { const p = civilParts(c); return `${DAY_SHORT[p.dow]} ${p.d} ${MONTHS[p.m - 1]}`; };
const dayKey = c => DAY_KEYS[civilParts(c).dow];
const dayLong = c => DAY_LONG[civilParts(c).dow];
function todayCivil(nowMs) { const w = londonWall(nowMs); return civil(w.y, w.m, w.d); }

// The instant at which a Glasgow wall clock shows `minutes` past midnight on that date.
function londonInstant(c, minutes) {
  const p = civilParts(c);
  const want = Date.UTC(p.y, p.m - 1, p.d, 0, minutes, 0);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const w = londonWall(t);
    t += want - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  }
  return t;
}

const hhmm = minutes => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
// 22:00:00 style clock for an instant, UK time.
function clockAt(ms) { const w = londonWall(ms); return `${pad2(w.hh)}:${pad2(w.mm)}:${pad2(w.ss)}`; }

// "in 30 s", "in 5 min", "in 2 h 10 min", "in 3 days"
function inWords(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `in ${h} h ${m % 60} min` : `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

module.exports = {
  TZ, DAY_KEYS, DAY_SHORT, DAY_LONG, MONTHS, DAY_MS,
  londonWall, civil, addDays, civilParts, pad2, iso, label, dayKey, dayLong, todayCivil,
  londonInstant, hhmm, clockAt, inWords,
};
