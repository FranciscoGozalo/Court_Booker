'use strict';
// Reading what the owner types: days, times, lengths and court order; and the schedule's lists
// (weekly bookings at any venue, one-off dates) as they are kept.

const crypto = require('crypto');
const { DAY_KEYS, DAY_LONG, hhmm, civil, civilParts, addDays } = require('./time');
const V = require('./venues');

// "thu", "Thursday", "thurs" -> "thu"
function parseDay(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.,]/g, '');
  if (t.length < 3) return null;
  const key = t.slice(0, 3);
  const i = DAY_KEYS.indexOf(key);
  if (i === -1) return null;
  return DAY_LONG[i].toLowerCase().startsWith(t) || t === key ? key : null;
}

// "19:00", "19.00", "1900", "19", "7pm", "7:30pm" -> minutes after midnight
function parseTime(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// "2h", "2", "2hrs", "2 hours", "1h" -> 1 or 2
function parseHours(text) {
  const m = /^([12])\s*(h|hr|hrs|hour|hours)?$/.exec(String(text || '').trim().toLowerCase());
  return m ? Number(m[1]) : null;
}

// "4 3 5 2 6 1", "4,3,5", "435261" -> all six courts, the ones named first
function parseOrder(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const tokens = /^[1-6]{2,6}$/.test(t) ? t.split('') : t.split(/[\s,;>-]+/).filter(Boolean);
  const seen = [];
  for (const tok of tokens) {
    if (!/^[1-6]$/.test(tok)) return null;
    const n = Number(tok);
    if (seen.includes(n)) return null;
    seen.push(n);
  }
  if (!seen.length) return null;
  for (let n = 1; n <= 6; n++) if (!seen.includes(n)) seen.push(n);
  return seen;
}

const slotEnd = (start, hours) => Math.min(start + (hours === 2 ? 120 : 60), 1440);
const slotText = entry => `${hhmm(entry.start)}–${hhmm(slotEnd(entry.start, entry.hours))}`;

// "thu 19:00 2h, fri 18:00" -> { thu: {start, hours}, fri: {...} }   (used for the COURT_PLAN variable)
function parsePlan(text) {
  const plan = {};
  for (const chunk of String(text || '').split(/[,;\n]+/)) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const day = parseDay(parts[0]);
    const start = parseTime(parts[1]);
    if (!day || start === null) continue;
    plan[day] = { start, hours: parseHours(parts[2]) || 1 };
  }
  return plan;
}

// The start time and length after the day in /set and /book: "19:00 2h", "7pm", "19:00-21:00".
// Returns { start, hours } or { why } saying what was wrong.
function parseSlot(tokens) {
  let start, hours;
  const range = /^(.+?)(?:-|–|to)(.+)$/i.exec(tokens.join(''));
  if (range && parseTime(range[1]) !== null && parseTime(range[2]) !== null) {      // "19:00-21:00"
    start = parseTime(range[1]);
    const len = parseTime(range[2]) - start;
    hours = len === 60 ? 1 : len === 120 ? 2 : null;
    if (!hours) return { why: 'A booking can be one hour or two.' };
  } else {
    start = parseTime(tokens[0]);
    hours = tokens.length > 1 ? parseHours(tokens.slice(1).join(' ')) : 1;
  }
  if (start === null || start === undefined || !hours) return { why: null };
  if (start % 30 !== 0) return { why: 'Slots start on the hour. Try a time like 19:00.' };
  if (start + hours * 60 > 1440) return { why: 'That slot runs past midnight. Try an earlier time.' };
  return { start, hours };
}

const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// A single date for /book, as a calendar date (see time.js), or null. Understands
// "2026-11-25", "25/11", "25/11/2026", "25 nov", "nov 25", "25th november", "today",
// "tomorrow" and a weekday ("wed" = the next Wednesday, today included). A date given
// without a year is the next one from today. Takes the words before the time.
function parseDate(tokens, today) {
  if (tokens.length > 1 && parseDay(tokens[0])) tokens = tokens.slice(1);   // "wed 25 nov": the weekday is just a reminder
  const t = tokens.join(' ').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!t) return null;
  if (t === 'today') return today;
  if (t === 'tomorrow') return addDays(today, 1);
  const day = parseDay(t);
  if (day) {
    const want = DAY_KEYS.indexOf(day);
    for (let i = 0; i < 7; i++) if (civilParts(addDays(today, i)).dow === want) return addDays(today, i);
  }
  let y = null, m = null, d = null, mm;
  if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) [y, m, d] = [+mm[1], +mm[2], +mm[3]];
  else if ((mm = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(t))) [d, m, y] = [+mm[1], +mm[2], mm[3] ? +mm[3] : null];
  else if ((mm = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})(?: (\d{4}))?$/.exec(t))) [d, m, y] = [+mm[1], monthOf(mm[2]), mm[3] ? +mm[3] : null];
  else if ((mm = /^([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t))) [m, d, y] = [monthOf(mm[1]), +mm[2], mm[3] ? +mm[3] : null];
  else return null;
  if (y !== null && y < 100) y += 2000;
  if (!m || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const now = civilParts(today);
  let c = civil(y ?? now.y, m, d);
  if (civilParts(c).d !== d) return null;                                 // e.g. 31 Nov
  if (y === null && c < today) c = civil(now.y + 1, m, d);
  return c;
}
function monthOf(word) {
  const i = MONTH_KEYS.indexOf(word.slice(0, 3));
  return i === -1 ? null : i + 1;
}

// The words after /book: a date, then a slot. Tries each place the date could end (so "nov 5 19:00"
// is not read as 05:00) and takes the first where both make sense.
// Returns { date, start, hours } or { why } (why may be null: then just show the usage).
function parseBooking(tokens, today) {
  let why = null;
  for (let i = 1; i < tokens.length; i++) {
    const date = parseDate(tokens.slice(0, i), today);
    if (date === null) continue;
    const slot = parseSlot(tokens.slice(i));
    if ('start' in slot) return { date, ...slot };
    why = why || slot.why;
  }
  return { why };
}

// Anything from storage or the environment, made safe to use.
function cleanPlan(raw) {
  const plan = {};
  if (!raw || typeof raw !== 'object') return plan;
  for (const k of DAY_KEYS) {
    const e = raw[k];
    if (!e || typeof e !== 'object') continue;
    const start = Number(e.start);
    if (!Number.isInteger(start) || start < 0 || start > 1439) continue;
    plan[k] = { start, hours: e.hours === 2 ? 2 : 1 };
  }
  return plan;
}
function cleanOrder(raw) {
  const good = Array.isArray(raw) && raw.length === 6 && [1, 2, 3, 4, 5, 6].every(n => raw.includes(n));
  return good ? raw.slice() : [1, 2, 3, 4, 5, 6];
}
// The signature the app makes for a weekly booking or a one-off date (2.10.1): 32 lowercase hex
// characters, the start of an HMAC-SHA-512 made with the card's pay key, which only the app and
// your PC know (docs/app-api.md, "Signed bookings"). The bot only keeps it and passes it on: it
// cannot make one, nor check one. Null for anything else.
const AUTH_RE = /^[0-9a-f]{32}$/;
const authOf = v => (typeof v === 'string' && AUTH_RE.test(v) ? v : null);
const withAuth = (entry, raw) => (authOf(raw.auth) ? { ...entry, auth: raw.auth } : entry);
// One-off bookings from storage: [{ date: 'YYYY-MM-DD', start, hours, auth? }], sorted by date and time.
function cleanOnce(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) continue;
    const start = Number(e.start);
    if (!Number.isInteger(start) || start < 0 || start > 1439) continue;
    if (out.some(o => o.date === e.date && o.start === start)) continue;
    out.push(withAuth({ date: String(e.date), start, hours: e.hours === 2 ? 2 : 1 }, e));
  }
  return out.sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
}
// One-off dates at any venue but Kelvingrove (version 2.10): [{ date, start, hours, venue, type }].
// Kept apart from Kelvingrove's (cleanOnce), so that a bot rolled back to an older version, which
// knows Kelvingrove's alone, never takes one of these for a Kelvingrove date. Glasgow Club's are
// an hour long.
function cleanOnceAway(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) continue;
    const venue = String(e.venue || ''), start = Number(e.start);
    if (venue === V.SCHEDULED || !V.isVenue(venue) || !Number.isInteger(start) || start < 0 || start > 1439) continue;
    const type = V.typesOf(venue).includes(e.type) ? e.type : V.typesOf(venue)[0];
    if (out.some(o => o.venue === venue && o.date === e.date && o.start === start)) continue;
    // `at` (2.10.1): when it was added (ms), which decides whether a Glasgow Club one-off is booked
    // straight away (added after its day opened) or only at its midnight (lib/schedule.js jobsFor).
    const at = Number.isInteger(e.at) && e.at > 0 ? { at: e.at } : {};
    out.push(withAuth({ date: String(e.date), start, hours: e.hours === 2 && !V.clubOf(venue) ? 2 : 1, venue, type, ...at }, e));
  }
  return out.sort((a, b) => (a.date === b.date ? a.start - b.start || V.VENUE_KEYS.indexOf(a.venue) - V.VENUE_KEYS.indexOf(b.venue) : a.date < b.date ? -1 : 1));
}

// ---------- weekly bookings at any venue (version 2.10) ----------
// [{ id, venue, type, day, start, hours, on }]: several a day, one venue, day and start once.
// `id`: 8 hex characters, for as long as the entry lasts. `on`: an entry switched off is kept, and
// never booked. Glasgow Club's are an hour long.
const MAX_WEEKLY = 30;
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0].map(i => DAY_KEYS[i]);          // Monday first, as the lists show them
const byWeek = (a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.start - b.start || V.VENUE_KEYS.indexOf(a.venue) - V.VENUE_KEYS.indexOf(b.venue);
function cleanWeekly(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const venue = String(e.venue || ''), start = Number(e.start), id = String(e.id || '');
    if (!/^[0-9a-f]{8}$/.test(id) || !V.isVenue(venue) || !DAY_KEYS.includes(e.day) || !Number.isInteger(start) || start < 0 || start > 1439) continue;
    if (out.some(o => o.id === id || (o.venue === venue && o.day === e.day && o.start === start))) continue;
    const type = V.typesOf(venue).includes(e.type) ? e.type : V.typesOf(venue)[0];
    out.push(withAuth({ id, venue, type, day: e.day, start, hours: e.hours === 2 && !V.clubOf(venue) ? 2 : 1, on: e.on !== false }, e));
    if (out.length >= MAX_WEEKLY) break;
  }
  return out.sort(byWeek);
}
// The id an entry made from Kelvingrove's old weekly plan gets: the same each time, so that the
// plan read again (before the bot has kept its new list) gives the same ids.
const planId = (day, start) => crypto.createHash('sha256').update(`kelvingrove:${day}:${start}`).digest('hex').slice(0, 8);
// The weekly bookings an old plan stands for: Kelvingrove's, one a day, all on.
function weeklyFromPlan(plan) {
  const p = cleanPlan(plan);
  return cleanWeekly(Object.entries(p).map(([day, e]) => ({ id: planId(day, e.start), venue: V.SCHEDULED, type: 'outdoor', day, start: e.start, hours: e.hours, on: true })));
}
// Kelvingrove's weekly bookings that are on, as the old plan: one a day, the earliest. For the
// words and screens that show one Kelvingrove time a day (Telegram's), and for a bot rolled back
// to an older version, which reads only this.
function planOf(weekly) {
  const plan = {};
  for (const w of [...(weekly || [])].sort(byWeek)) {
    if (w.venue !== V.SCHEDULED || w.on === false || plan[w.day]) continue;
    plan[w.day] = { start: w.start, hours: w.hours };
  }
  return plan;
}
// A new entry's id: 8 hex characters no entry has.
function newWeeklyId(weekly, random = () => crypto.randomBytes(4).toString('hex')) {
  for (;;) {
    const id = random();
    if (!(weekly || []).some(w => w.id === id)) return id;
  }
}

module.exports = {
  parseDay, parseTime, parseHours, parseOrder, parsePlan, parseSlot, parseDate, parseBooking,
  cleanPlan, cleanOrder, cleanOnce, cleanOnceAway, cleanWeekly, weeklyFromPlan, planOf, newWeeklyId, slotEnd, slotText,
  MAX_WEEKLY, DAY_ORDER, AUTH_RE, authOf,
};
