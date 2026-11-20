'use strict';
// Which days are booked when, and what the PC at home should book right now.
//
// The parks (Kelvingrove and Glasgow Life's other six, on ClubSpark) open each day `daysAhead`
// days ahead at `releaseMin` (22:00), so the release on `night` opens `night + daysAhead`. A
// weekly request for Thursdays is booked at the release on the Thursday before; a one-off date is
// booked at its release, or straight away if that day is already open.
//
// Glasgow Club (Gorbals, Scotstoun indoor and outdoor) opens each day 7 days ahead at 00:00: its
// release belongs to the night before (the PC's nightly run stays awake for it), so the release on
// `night` at midnight opens `night + 8`. Those are "club" releases (`club: true`); everything about
// the parks' releases, and a schedule that has only Kelvingrove in it, is as it always was.

const { todayCivil, addDays, londonInstant, dayKey, iso, civil } = require('./time');
const { slotEnd } = require('./plan');
const V = require('./venues');

const LATE_MS = 10 * 60 * 1000;     // the PC may still pick up a release's bookings this long after it
const CLUB_LATE_MS = 30 * 60 * 1000; // ...and a Glasgow Club release's this long (a payment takes a few minutes)
const MISSING_MS = 2 * 60 * 1000;   // warn if the PC has not been in touch this long before a release
const SEEN_FRESH_MS = 15 * 60 * 1000; // a check-in counts for tonight if it came this long before the release

const civilOf = isoDate => { const [y, m, d] = isoDate.split('-').map(Number); return civil(y, m, d); };
const jobId = (dateIso, start) => `${dateIso}@${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
const venueOf = e => e.venue || V.SCHEDULED;
const isClub = e => !!V.clubOf(venueOf(e));
const lateOf = rel => (rel.club ? CLUB_LATE_MS : LATE_MS);

// When a day opens for booking at the parks.
function opensAt(date, cfg) {
  return londonInstant(addDays(date, -cfg.daysAhead), cfg.releaseMin);
}
// When a day opens for booking at a venue: Glasgow Club's at 00:00 seven days ahead.
function opensAtFor(venue, date, cfg) {
  return V.clubOf(venue) ? londonInstant(addDays(date, -V.CLUB_DAYS_AHEAD), V.CLUB_RELEASE_MIN) : opensAt(date, cfg);
}

// The weekly entries a schedule has: its list (2.10), or else the Kelvingrove plan of old ({ thu:
// { start, hours } }, one a day), as entries.
function weeklyOf(cfg) {
  if (Array.isArray(cfg.weekly)) return cfg.weekly;
  return Object.entries(cfg.plan || {}).map(([day, e]) => ({ venue: V.SCHEDULED, day, start: e.start, hours: e.hours, on: true }));
}
// Its one-off dates: Kelvingrove's (`once`) and the other venues' (`away`).
const oncesOf = cfg => [...(cfg.once || []), ...(cfg.away || [])];

// Everything asked for on one day: that weekday's weekly entries and any one-offs on that date,
// one per venue and start (a weekly entry first). `which`: 'parks' or 'clubs' for those alone.
// A Kelvingrove request is exactly as it always was ({ id, date, start, end, hours, kind }, its id
// "2026-11-26@19:00"); another venue's also has `venue` and `type`, and its id the venue in front.
function requestsOn(date, cfg, which = 'all') {
  const out = [];
  const add = (e, kind) => {
    const venue = venueOf(e);
    if ((which === 'parks' && V.clubOf(venue)) || (which === 'clubs' && !V.clubOf(venue))) return;
    if (out.some(o => venueOf(o) === venue && o.start === e.start)) return;
    const r = { id: V.resultId(venue, iso(date), e.start), date: iso(date), start: e.start, end: slotEnd(e.start, e.hours), hours: e.hours, kind };
    if (venue !== V.SCHEDULED) Object.assign(r, { venue, type: V.typesOf(venue).includes(e.type) ? e.type : V.typesOf(venue)[0] });
    out.push(r);
  };
  const day = dayKey(date);
  for (const w of weeklyOf(cfg)) if (w.on !== false && w.day === day) add(w, 'weekly');
  for (const o of oncesOf(cfg)) if (o.date === iso(date)) add(o, 'once');
  return out.sort((a, b) => a.start - b.start || V.VENUE_KEYS.indexOf(venueOf(a)) - V.VENUE_KEYS.indexOf(venueOf(b)));
}

// The parks' release on `night`, with what it will book, or null if nothing.
function releaseFor(night, cfg) {
  const playDate = addDays(night, cfg.daysAhead);
  const requests = requestsOn(playDate, cfg, 'parks');
  if (!requests.length) return null;
  return { night, playDate, releaseAt: londonInstant(night, cfg.releaseMin), requests };
}
// Glasgow Club's release at the midnight after `night`, with what it will book, or null.
function clubReleaseFor(night, cfg) {
  const opening = addDays(night, 1);
  const playDate = addDays(opening, V.CLUB_DAYS_AHEAD);
  const requests = requestsOn(playDate, cfg, 'clubs');
  if (!requests.length) return null;
  return { night, playDate, releaseAt: londonInstant(opening, V.CLUB_RELEASE_MIN), requests, club: true };
}
// Both of a night's releases, the parks' first.
const releasesOn = (night, cfg) => [releaseFor(night, cfg), clubReleaseFor(night, cfg)].filter(Boolean);

// The bookings the PC should make now: those opening at tonight's releases (or last night's, just
// after them), and one-off dates that are already open and still ahead. Anything already booked
// is left out. Each comes with `releaseAt`, the moment it opens.
function jobsFor(nowMs, cfg, results = {}) {
  const today = todayCivil(nowMs);
  const jobs = [];
  const add = (r, releaseAt) => {
    if (jobs.some(j => j.id === r.id) || (results[r.id] && results[r.id].status === 'booked')) return;
    jobs.push({ ...r, releaseAt });
  };
  for (const night of [addDays(today, -1), today]) {
    for (const rel of releasesOn(night, cfg)) if (nowMs < rel.releaseAt + lateOf(rel)) for (const r of rel.requests) add(r, rel.releaseAt);
  }
  for (const o of oncesOf(cfg)) {
    const date = civilOf(o.date);
    const opens = opensAtFor(venueOf(o), date, cfg);
    if (opens > nowMs || londonInstant(date, o.start) <= nowMs) continue;   // not open yet, or already started
    for (const r of requestsOn(date, cfg)) if (r.start === o.start && venueOf(r) === venueOf(o)) add(r, opens);
  }
  return jobs.sort((a, b) => a.releaseAt - b.releaseAt || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start));
}

// The next `count` releases that will book something, soonest first.
function upcoming(nowMs, cfg, count = 3) {
  const today = todayCivil(nowMs);
  const out = [];
  for (let i = -1; i < 400 && out.length < count; i++) {
    for (const rel of releasesOn(addDays(today, i), cfg)) if (rel.releaseAt + lateOf(rel) > nowMs) out.push(rel);
  }
  return out.sort((a, b) => a.releaseAt - b.releaseAt).slice(0, count);
}

// Tonight's release (or last night's, just after it), if `nowMs` is no more than `beforeMs`
// before it and less than `afterMs` after it. A negative `afterMs` stops short of the release.
// `club`: Glasgow Club's midnight release instead of the parks'; null: either (the parks' first).
function releaseAround(nowMs, cfg, beforeMs, afterMs, club = null) {
  const today = todayCivil(nowMs);
  for (const night of [addDays(today, -1), today]) {
    for (const rel of releasesOn(night, cfg)) {
      if (club !== null && !!rel.club !== club) continue;
      if (nowMs >= rel.releaseAt - beforeMs && nowMs < rel.releaseAt + afterMs) return rel;
    }
  }
  return null;
}

// Tonight's release, if the PC's booking run has not started for it by MISSING_MS before.
// `lastSeen` is when the PC last asked what to book (not its once-a-minute "awake" pings), or
// said how its run is going.
function missingFor(nowMs, cfg, lastSeen) {
  const today = todayCivil(nowMs);
  for (const night of [addDays(today, -1), today]) {
    for (const rel of releasesOn(night, cfg)) {
      if (nowMs < rel.releaseAt - MISSING_MS || nowMs >= rel.releaseAt + LATE_MS) continue;
      if (lastSeen && lastSeen >= rel.releaseAt - SEEN_FRESH_MS) continue;
      return rel;
    }
  }
  return null;
}

// How long until the PC would be missed, so the timer can wake then. Null if not within a day.
function msToNextCheck(nowMs, cfg) {
  const today = todayCivil(nowMs);
  let best = null;
  for (const night of [today, addDays(today, 1)]) {
    for (const rel of releasesOn(night, cfg)) {
      const at = rel.releaseAt - MISSING_MS;
      if (at > nowMs && (best === null || at - nowMs < best)) best = at - nowMs;
    }
  }
  return best;
}

module.exports = {
  LATE_MS, CLUB_LATE_MS, MISSING_MS, SEEN_FRESH_MS, jobId, opensAt, opensAtFor, weeklyOf, oncesOf, requestsOn, releaseFor, clubReleaseFor, releasesOn,
  releaseAround, jobsFor, upcoming, missingFor, msToNextCheck, civilOf, isClub,
};
