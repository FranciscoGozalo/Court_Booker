'use strict';
// Which Kelvingrove courts are free, read from ClubSpark's public booking sheet.
// Read only: the same data the sheet shows a guest who is not signed in. Nothing here signs in
// or books anything, and nothing about the owner is sent.

const { COURTS, SHEET } = require('./links');

const SESSIONS = 'https://clubspark.lta.org.uk/v0/VenueBooking/KelvingroveParkTennisCourts/GetVenueSessions';
const USER_AGENT = 'CourtAlert/1.4 (personal court reminder; reads the public booking sheet)';

// What each kind of session on the sheet means. Category 0 is time that can be booked;
// anything else on a court is time that cannot.
const CATEGORY = { 1000: 'booked', 2000: 'coaching', 8000: 'closed' };

// The sheet's data for one day. `_` stops anything in between from answering with an old copy.
function sessionsUrl(dateIso, nowMs) {
  return `${SESSIONS}?resourceID=&startDate=${dateIso}&endDate=${dateIso}&roleId=&_=${nowMs}`;
}

// Which court (1 to 6) a resource on the sheet is: by its ID, or failing that by its name.
function courtOf(resource) {
  const id = String((resource && (resource.ID || resource.Id)) || '').toLowerCase();
  const byId = Object.keys(COURTS).find(n => COURTS[n] === id);
  if (byId) return Number(byId);
  const m = /court\s*(\d)\b/i.exec(String((resource && resource.Name) || ''));
  return m && COURTS[m[1]] ? Number(m[1]) : 0;
}

const minutes = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);

// What the sheet says about one court for the slot [start, end) on a day, in minutes after midnight:
//   free        bookable for the whole slot, with nothing else on the court
//   booked, coaching, closed, taken (any other kind of session)
//   restricted  bookable only by certain people (members, staff)
//   not bookable  no bookable time covers the whole slot
//   unknown     the sheet shows nothing for this court on that day
function slotState(resource, dateIso, start, end) {
  const day = Array.isArray(resource && resource.Days)
    ? resource.Days.find(d => String((d && d.Date) || '').startsWith(dateIso)) : null;
  const sessions = day && Array.isArray(day.Sessions) ? day.Sessions.filter(s => s && typeof s === 'object') : [];
  if (!sessions.length) return 'unknown';
  const overlaps = s => minutes(s.StartTime) < end && minutes(s.EndTime) > start;
  for (const s of sessions) {
    if (Number(s.Category) !== 0 && overlaps(s)) return CATEGORY[Number(s.Category)] || 'taken';
  }
  const bookable = sessions.filter(s => Number(s.Category) === 0 && overlaps(s));
  const open = bookable.filter(s => !String(s.Restrictions || '').trim())
    .map(s => [minutes(s.StartTime), minutes(s.EndTime)]).sort((a, b) => a[0] - b[0]);
  let reached = start;                                           // how far the open time covers the slot, without a gap
  for (const [a, b] of open) {
    if (a > reached) break;
    if (b > reached) reached = b;
  }
  if (reached >= end) return 'free';
  return bookable.length > open.length ? 'restricted' : 'not bookable';
}

// Every court's state from the sheet's data. `visible` is false when the sheet showed nothing
// for that day at all (for example, a day that is not open yet).
function readSheet(data, dateIso, start, end) {
  const courts = {};
  for (const n of Object.keys(COURTS)) courts[n] = 'unknown';
  for (const r of data.Resources) {
    const n = courtOf(r);
    if (n) courts[n] = slotState(r, dateIso, start, end);
  }
  return { courts, visible: Object.values(courts).some(s => s !== 'unknown') };
}

// Asks ClubSpark once. Never throws. The answer is one of:
//   { ok: true, courts: { 1: 'free', 2: 'booked', ... }, visible, ms }
//   { ok: false, why, stop }   `stop` means asking again tonight will not help, so do not.
function createCourtChecker({ fetchImpl = fetch, now = Date.now, timeoutMs = 4000 } = {}) {
  return async function checkCourts(dateIso, start, end) {
    const started = now();
    let res, body;
    try {
      res = await fetchImpl(sessionsUrl(dateIso, started), {
        headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest', referer: SHEET, 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.text();
    } catch (e) {
      const slow = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, stop: false, why: slow ? `ClubSpark did not answer within ${timeoutMs / 1000} s` : `could not reach ClubSpark (${(e && e.message) || e})` };
    }
    const cloudflare = /cloudflare/i.test(res.headers.get('server') || '') || /cloudflare/i.test(body.slice(0, 2000));
    if (res.status === 403) return { ok: false, stop: true, why: `ClubSpark turned this server away (HTTP 403${cloudflare ? ', Cloudflare' : ''})` };
    if (res.status === 429) return { ok: false, stop: true, why: 'ClubSpark asked this server to slow down (HTTP 429)' };
    if (res.status >= 500) return { ok: false, stop: false, why: `ClubSpark had a problem (HTTP ${res.status})` };
    if (res.status !== 200) return { ok: false, stop: true, why: `ClubSpark answered HTTP ${res.status}` };
    let data;
    try { data = JSON.parse(body); } catch {
      return { ok: false, stop: true, why: `ClubSpark sent a web page instead of the sheet${cloudflare ? ' (a Cloudflare check)' : ''}` };
    }
    if (!data || !Array.isArray(data.Resources)) return { ok: false, stop: true, why: 'the sheet came back in a shape this bot does not know' };
    return { ok: true, ...readSheet(data, dateIso, start, end), ms: now() - started };
  };
}

// How the courts should be offered, given the latest answer:
//   null                         as always: all six in the owner's order, nothing more said
//   { mode: 'pick', best, others }  the first free court in the owner's order, then the other free ones
//   { mode: 'none' }             nothing shows as free (all six are still offered, in case the sheet is wrong)
//   { mode: 'failed' }           the sheet could not be read (all six are offered)
// Before the release, "nothing free" more likely means "not open yet", so it is not said then.
function courtView(order, answer, { released = true, failed = false } = {}) {
  if (answer && answer.ok && answer.visible) {
    const free = order.filter(n => answer.courts[n] === 'free');
    if (free.length) return { mode: 'pick', best: free[0], others: free.slice(1) };
    return released ? { mode: 'none' } : null;
  }
  return failed ? { mode: 'failed' } : null;
}

module.exports = { SESSIONS, USER_AGENT, sessionsUrl, courtOf, slotState, readSheet, createCourtChecker, courtView };
