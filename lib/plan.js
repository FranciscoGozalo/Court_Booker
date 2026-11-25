'use strict';
// Reading what the owner types: days, times, lengths and court order.

const { DAY_KEYS, DAY_LONG, hhmm, civil, civilParts, addDays } = require('./time');

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

// How long before you play the reminder comes, as typed after /remind: "2h", "1.5h", "90",
// "90 min", "off". A bare number up to 12 is hours, anything larger minutes. Returns minutes
// (0 for off), or null if it makes no sense or is under 15 minutes or over a day.
function parseRemind(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (/^(off|no|none|never|0)$/.test(t)) return 0;
  const m = /^(\d{1,4}(?:\.\d)?)(h|hr|hrs|hour|hours|m|min|mins|minutes)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const hours = m[2] ? m[2].startsWith('h') : n <= 12;
  const minutes = Math.round(hours ? n * 60 : n);
  return minutes >= 15 && minutes <= 1440 ? minutes : null;
}

// What to do when the slot is taken, from storage: both off unless switched on.
const cleanFallback = raw => ({ shorter: !!raw && raw.shorter === true, later: !!raw && raw.later === true });

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
// One-off bookings from storage: [{ date: 'YYYY-MM-DD', start, hours }], sorted by date and time.
function cleanOnce(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) continue;
    const start = Number(e.start);
    if (!Number.isInteger(start) || start < 0 || start > 1439) continue;
    if (out.some(o => o.date === e.date && o.start === start)) continue;
    out.push({ date: String(e.date), start, hours: e.hours === 2 ? 2 : 1 });
  }
  return out.sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
}

module.exports = {
  parseDay, parseTime, parseHours, parseOrder, parsePlan, parseSlot, parseDate, parseBooking, parseRemind,
  cleanPlan, cleanOrder, cleanOnce, cleanFallback, slotEnd, slotText,
};
