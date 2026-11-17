'use strict';
// The link between the home server and Railway, when the two are split: the home server reads
// ClubSpark (which lets a home connection in) and posts what it found here; Railway holds the
// latest reading and hands it to the bot in place of reading ClubSpark itself.
//
// Nothing here contacts ClubSpark. It only keeps the last reading the home server sent, and
// serves the plan so the home server knows which slot to read. Everything is guarded by a
// shared token (AGENT_TOKEN), so only your home server can post or read.

const { COURTS } = require('./links');

const STATES = new Set(['free', 'booked', 'coaching', 'closed', 'taken', 'restricted', 'not bookable', 'unknown']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null));

// Make a posted reading safe to keep: a known date and slot, and either a clean courts map
// (courts 1 to 6, each a state this bot knows) or a plain failure with a reason.
function cleanReading(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = typeof raw.date === 'string' && DATE.test(raw.date) ? raw.date : null;
  const start = int(raw.start), end = int(raw.end);
  if (!date || start === null || end === null || end <= start) return null;
  if (raw.ok === true) {
    const courts = {};
    for (const n of Object.keys(COURTS)) {
      const s = raw.courts && raw.courts[n];
      courts[n] = typeof s === 'string' && STATES.has(s) ? s : 'unknown';
    }
    const visible = raw.visible !== false && Object.values(courts).some(s => s !== 'unknown');
    const ms = int(raw.ms);
    return { date, start, end, ok: true, courts, visible, ms: ms === null ? 0 : ms };
  }
  return { date, start, end, ok: false, stop: raw.stop === true, why: String(raw.why || 'the home server could not read the sheet').slice(0, 200) };
}

// Holds the latest reading per day. `freshMs` is how old a reading may be and still be used:
// older than that and the bot is told the home server has gone quiet, so it falls back to
// offering all six courts (but keeps trying, in case the home server comes back).
function createRelay({ now = Date.now, freshMs = 25000 } = {}) {
  const latest = {};   // date -> cleaned reading + { at }
  let posts = 0, lastPostAt = null;

  function put(raw) {
    const reading = cleanReading(raw);
    if (!reading) return { ok: false, why: 'that reading made no sense' };
    latest[reading.date] = { ...reading, at: now() };
    for (const d of Object.keys(latest)) if (now() - latest[d].at > 6 * 3600000) delete latest[d];
    posts++; lastPostAt = now();
    return { ok: true };
  }

  // The checkCourts the bot uses: the latest reading for this slot, if it is recent enough.
  function checkCourts(dateIso, start, end) {
    const r = latest[dateIso];
    if (!r || r.start !== start || r.end !== end) return { ok: false, stop: false, why: 'no reading from the home server yet' };
    const age = now() - r.at;
    if (age > freshMs) return { ok: false, stop: false, why: `the home server last answered ${Math.round(age / 1000)} s ago` };
    if (!r.ok) return { ok: false, stop: r.stop === true, why: r.why };
    return { ok: true, courts: r.courts, visible: r.visible, ms: r.ms };
  }

  const status = () => ({ posts, lastPostAt, fresh: lastPostAt !== null && now() - lastPostAt <= freshMs });
  return { put, checkCourts, status };
}

module.exports = { createRelay, cleanReading, STATES };
