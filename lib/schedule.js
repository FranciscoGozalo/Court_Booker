'use strict';
// Which days are booked when, and what the PC at home should book right now.
//
// Kelvingrove opens each day `daysAhead` days ahead at `releaseMin` (22:00), so the release
// on `night` opens `night + daysAhead`. A weekly request for Thursdays is booked at the
// release on the Thursday before; a one-off date is booked at its release, or straight away
// if that day is already open.

const { todayCivil, addDays, londonInstant, dayKey, iso, civil } = require('./time');
const { slotEnd } = require('./plan');

const LATE_MS = 10 * 60 * 1000;     // the PC may still pick up a release's bookings this long after it
const MISSING_MS = 2 * 60 * 1000;   // warn if the PC has not been in touch this long before a release
const SEEN_FRESH_MS = 15 * 60 * 1000; // a check-in counts for tonight if it came this long before the release

const civilOf = isoDate => { const [y, m, d] = isoDate.split('-').map(Number); return civil(y, m, d); };
const jobId = (dateIso, start) => `${dateIso}@${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;

// When a day opens for booking.
function opensAt(date, cfg) {
  return londonInstant(addDays(date, -cfg.daysAhead), cfg.releaseMin);
}

// Everything asked for on one day: that weekday's weekly slot and any one-offs on that date.
function requestsOn(date, cfg) {
  const out = [];
  const add = (e, kind) => {
    if (out.some(o => o.start === e.start)) return;
    out.push({ id: jobId(iso(date), e.start), date: iso(date), start: e.start, end: slotEnd(e.start, e.hours), hours: e.hours, kind });
  };
  const weekly = cfg.plan[dayKey(date)];
  if (weekly) add(weekly, 'weekly');
  for (const o of cfg.once || []) if (o.date === iso(date)) add(o, 'once');
  return out.sort((a, b) => a.start - b.start);
}

// The release on `night`, with what it will book, or null if nothing.
function releaseFor(night, cfg) {
  const playDate = addDays(night, cfg.daysAhead);
  const requests = requestsOn(playDate, cfg);
  if (!requests.length) return null;
  return { night, playDate, releaseAt: londonInstant(night, cfg.releaseMin), requests };
}

// The bookings the PC should make now: those opening at tonight's release (or last night's,
// just after midnight), and one-off dates that are already open and still ahead. Anything
// already booked is left out. Each comes with `releaseAt`, the moment it opens.
function jobsFor(nowMs, cfg, results = {}) {
  const today = todayCivil(nowMs);
  const jobs = [];
  const add = (r, releaseAt) => {
    if (jobs.some(j => j.id === r.id) || (results[r.id] && results[r.id].status === 'booked')) return;
    jobs.push({ ...r, releaseAt });
  };
  for (const night of [addDays(today, -1), today]) {
    const rel = releaseFor(night, cfg);
    if (rel && nowMs < rel.releaseAt + LATE_MS) for (const r of rel.requests) add(r, rel.releaseAt);
  }
  for (const o of cfg.once || []) {
    const date = civilOf(o.date);
    const opens = opensAt(date, cfg);
    if (opens > nowMs || londonInstant(date, o.start) <= nowMs) continue;   // not open yet, or already started
    for (const r of requestsOn(date, cfg)) if (r.start === o.start) add(r, opens);
  }
  return jobs.sort((a, b) => a.releaseAt - b.releaseAt || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start));
}

// The next `count` releases that will book something, soonest first.
function upcoming(nowMs, cfg, count = 3) {
  const today = todayCivil(nowMs);
  const out = [];
  for (let i = -1; i < 400 && out.length < count; i++) {
    const rel = releaseFor(addDays(today, i), cfg);
    if (rel && rel.releaseAt + LATE_MS > nowMs) out.push(rel);
  }
  return out;
}

// Tonight's release (or last night's, just after midnight), if `nowMs` is no more than `beforeMs`
// before it and less than `afterMs` after it. A negative `afterMs` stops short of the release.
function releaseAround(nowMs, cfg, beforeMs, afterMs) {
  const today = todayCivil(nowMs);
  for (const night of [addDays(today, -1), today]) {
    const rel = releaseFor(night, cfg);
    if (rel && nowMs >= rel.releaseAt - beforeMs && nowMs < rel.releaseAt + afterMs) return rel;
  }
  return null;
}

// Tonight's release, if the PC's booking run has not started for it by MISSING_MS before.
// `lastSeen` is when the PC last asked what to book (not its once-a-minute "awake" pings).
function missingFor(nowMs, cfg, lastSeen) {
  const today = todayCivil(nowMs);
  for (const night of [addDays(today, -1), today]) {
    const rel = releaseFor(night, cfg);
    if (!rel || nowMs < rel.releaseAt - MISSING_MS || nowMs >= rel.releaseAt + LATE_MS) continue;
    if (lastSeen && lastSeen >= rel.releaseAt - SEEN_FRESH_MS) continue;
    return rel;
  }
  return null;
}

// How long until the PC would be missed, so the timer can wake then. Null if not within a day.
function msToNextCheck(nowMs, cfg) {
  const today = todayCivil(nowMs);
  let best = null;
  for (const night of [today, addDays(today, 1)]) {
    const rel = releaseFor(night, cfg);
    if (!rel) continue;
    const at = rel.releaseAt - MISSING_MS;
    if (at > nowMs && (best === null || at - nowMs < best)) best = at - nowMs;
  }
  return best;
}

module.exports = { LATE_MS, MISSING_MS, SEEN_FRESH_MS, jobId, opensAt, requestsOn, releaseFor, releaseAround, jobsFor, upcoming, missingFor, msToNextCheck, civilOf };
