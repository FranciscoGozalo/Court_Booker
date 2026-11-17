'use strict';
// Reading what the owner types: days, times, lengths and court order.

const { DAY_KEYS, DAY_LONG, hhmm } = require('./time');

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

module.exports = { parseDay, parseTime, parseHours, parseOrder, parsePlan, cleanPlan, cleanOrder, slotEnd, slotText };
