'use strict';
// Glasgow Club's indoor tennis courts (Gorbals and Scotstoun), read from its booking site.
//
// The bot only LOOKS: which courts are free on a day. It does not book them, and it could not
// pay for them. Glasgow Club takes payment by card at the moment of booking, its site keeps the
// basket in the browser tab that filled it, and it has saved cards and pay-by-link switched off
// (GladstonePay_AllowMemberWallet and PayByLink_Enabled in the site's own settings, as read on
// 19 Nov 2026). So the booking and the payment are yours to make on Glasgow Club's own page;
// the bot finds the free court and hands you the link to the right sheet.
//
// The free courts come from the two calls the site's own page makes for any visitor: one for a
// visitor's session (a cookie), one for a day's sheet. No login is used. If the site answers
// with a "checking your browser" page, or says it is being asked too often, the bot says so and
// stops asking for a while. It never tries to get round either.
//
// Each day opens for booking a week ahead, at midnight; every slot says when in `bookableFrom`.

const { londonWall, civil, iso } = require('./time');

const BASE = 'https://glasgowclub.gladstonego.cloud';
const CENTRES = {
  g: { key: 'g', name: 'Gorbals', activity: 'S0815', site: 'SRGLC', group: 'SA004' },
  s: { key: 's', name: 'Scotstoun', activity: 'SA011', site: 'SRSLC', group: 'SA004' },
};
const CACHE_MS = 60 * 1000;          // a day's sheet is read at most once a minute...
const REFRESH_MS = 10 * 1000;        // ...or once in ten seconds when you press Refresh
const SESSION_MS = 6 * 3600 * 1000;  // the visitor's session lasts a day; a new one after six hours
const BACKOFF_MS = 10 * 60 * 1000;   // after "checking your browser" or "too many requests": no asking for this long
const QUIET_MS = 30 * 1000;          // after the site could not be reached or did not answer: no asking for this long
const TIMEOUT_MS = 12000;            // for one whole read: the session (when one is needed) and the sheet together
const MAX_BYTES = 4 * 1024 * 1024;

// The page a person books on: that centre's sheet for that day, every hour of it. (For today
// the site itself leaves out the hours that have passed.)
const sheetUrl = (centre, dateIso) => `${BASE}/book/calendar/${centre.activity}?activityDate=${dateIso}T00:00:00.000Z`;

// Something that stopped a read. `kind` is one of: challenge, limit, timeout, network, http, odd.
function problem(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}
const unreachable = e => problem(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network', (e && e.message) || 'no connection');
// The same, in words for you.
function whyText(err) {
  const kind = err && err.kind;
  if (kind === 'challenge') return 'Glasgow Club\'s site is checking its visitors just now, so I cannot read the free courts. I will not ask it again for ten minutes.';
  if (kind === 'limit') return 'Glasgow Club\'s site says it is being asked too often, so I will not ask it again for ten minutes.';
  if (kind === 'timeout') return 'Glasgow Club\'s site did not answer in time.';
  if (kind === 'network') return 'I could not reach Glasgow Club\'s site.';
  return `Glasgow Club's site did not give me the free courts (${(err && err.message) || 'no reason given'}).`;
}

const minutesOf = w => w.hh * 60 + w.mm;

// One day's sheet, from the site's answer: { slots, listed }.
// `slots` are the free ones: [{ start, end, court, name, opensAt }], in minutes on a Glasgow
// clock, earliest first. `opensAt` is null when the slot can be booked now, or the moment it
// opens. Slots that have started, can no longer be booked, or belong to another day are left out.
// `listed` counts every slot the sheet had, free or not: none at all is not the same as none free.
// An answer that is not a sheet, or a sheet that no longer reads as one, is a `problem`, so a
// change on the site is never passed off as "nothing is free".
function readDay(json, dateIso, nowMs) {
  const days = Array.isArray(json) ? json : (json && typeof json === 'object' ? [json] : null);
  if (!days || days.some(d => !d || typeof d !== 'object' || !Array.isArray(d.locations))) throw problem('odd', 'an answer that was not a day\'s sheet');
  const slots = [];
  let listed = 0, understood = 0;
  for (const day of days) {
    for (const loc of day.locations) {
      const name = String((loc && loc.locationNameToDisplay) || '').replace(/\s+/g, ' ').trim();
      const m = /(\d+)$/.exec(name);
      for (const s of (loc && Array.isArray(loc.slots) ? loc.slots : [])) {
        listed++;
        if (!m || !s || typeof s !== 'object' || typeof s.status !== 'string') continue;
        const startMs = Date.parse(s.startTime);
        if (Number.isNaN(startMs)) continue;
        understood++;
        if (s.status !== 'Available' || startMs <= nowMs) continue;
        const until = Date.parse(s.bookableUntil);
        if (!Number.isNaN(until) && until <= nowMs) continue;
        const w = londonWall(startMs);
        if (iso(civil(w.y, w.m, w.d)) !== dateIso) continue;
        const start = minutesOf(w);
        const endMs = Date.parse(s.endTime);                       // "…:59:59": a second short of the hour
        const end = Number.isNaN(endMs) ? start + 60 : (minutesOf(londonWall(endMs + 1000)) || 1440);
        const from = Date.parse(s.bookableFrom);
        const notYet = s.isBeforeTimetableSlotBookablePeriod === true || (!Number.isNaN(from) && from > nowMs);
        slots.push({ start, end: end > start ? end : start + 60, court: Number(m[1]), name, opensAt: notYet ? (Number.isNaN(from) ? nowMs : from) : null });
      }
    }
  }
  if (listed && !understood) throw problem('odd', 'a sheet I can no longer read');
  slots.sort((a, b) => a.start - b.start || a.court - b.court);
  return { slots, listed };
}

function createGlasgowClub({ fetchImpl = fetch, now = Date.now, log = () => {} } = {}) {
  let cookie = null, cookieAt = 0;
  let quiet = null;                     // { until, err }: no asking at all until then
  let health = null;                    // the last read: { ok, at, why }
  const cache = new Map();              // "g:2026-11-25" -> { at, slots, listed }
  const flying = new Map();             // the same key -> a read on its way
  const failed = new Map();             // the same key -> { at, err }: a read that just failed is not tried again at once

  async function get(path, headers, signal) {
    let res;
    try {
      res = await fetchImpl(BASE + path, { headers: { accept: 'application/json', 'x-use-sso': '1', ...headers }, signal });
    } catch (e) {
      throw unreachable(e);
    }
    // A "checking your browser" page is told from any other refusal by what it says.
    let challenged = res.headers.get('cf-mitigated') === 'challenge';
    if (!challenged && (res.status === 403 || res.status === 503) && /text\/html/i.test(String(res.headers.get('content-type') || ''))) {
      const page = await res.text().catch(() => '');
      challenged = /just a moment|challenge-platform|cf-chl|attention required/i.test(page);
      if (!challenged) throw problem('http', `HTTP ${res.status}`);
    }
    if (challenged) throw problem('challenge', 'the site is checking its visitors');
    if (res.status === 429) throw problem('limit', 'HTTP 429');
    return res;
  }

  // A visitor's session, as the site gives any browser: a cookie, and nothing to do with you.
  async function session(renew, signal) {
    if (!renew && cookie && now() - cookieAt < SESSION_MS) return cookie;
    cookie = null;
    const res = await get('/api/samlauthentication/anonymous', {}, signal);
    if (!res.ok) throw problem('http', `HTTP ${res.status} for a visitor's session`);
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const pairs = set.map(c => String(c).split(';')[0].trim()).filter(c => /^[^=\s]+=.+/.test(c));
    if (!pairs.some(p => /^jwt=/i.test(p))) throw problem('odd', 'no visitor session came back');
    cookie = pairs.join('; ');
    cookieAt = now();
    return cookie;
  }

  async function fetchDay(centre, dateIso) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);               // one time limit for the whole read
    const path = `/api/availability/V2/sessions?webBookableOnly=true&activityIds=${centre.activity}&siteIds=${centre.site}&activityGroupIds=${centre.group}`
      + `&dateFrom=${dateIso}T00:00:00.000Z&dateTo=${dateIso}T23:59:59.999Z`;
    let res = await get(path, { cookie: await session(false, signal) }, signal);
    if (res.status === 401) res = await get(path, { cookie: await session(true, signal) }, signal);     // the session ran out: one new one
    if (!res.ok) {
      if (res.status < 500) cookie = null;                         // refused: start from a new session next time
      throw problem('http', `HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw problem('odd', 'an answer far larger than one day\'s sheet');
    let text;
    try { text = await res.text(); } catch (e) { throw unreachable(e); }
    if (text.length > MAX_BYTES) throw problem('odd', 'an answer far larger than one day\'s sheet');
    let json;
    try { json = JSON.parse(text); } catch { throw problem('odd', 'an answer that was not the sheet'); }
    return readDay(json, dateIso, now());
  }

  // One day's sheet at a centre: { at, slots, listed }. Read from the site at most once a minute
  // (`fresh`: once in ten seconds). Throws a `problem` when the site cannot be read.
  async function day(key, dateIso, { fresh = false } = {}) {
    const centre = CENTRES[key];
    if (!centre || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw problem('odd', 'no such centre or day');
    const k = `${key}:${dateIso}`, t = now();
    const hit = cache.get(k);
    if (hit && t - hit.at < (fresh ? REFRESH_MS : CACHE_MS)) return hit;
    if (flying.has(k)) return flying.get(k);
    if (quiet && t < quiet.until) throw quiet.err;
    const fail = failed.get(k);
    if (fail && t - fail.at < REFRESH_MS) throw fail.err;
    const read = fetchDay(centre, dateIso).then(sheet => {
      const got = { at: now(), ...sheet };
      cache.set(k, got);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      failed.delete(k);
      health = { ok: true, at: got.at };
      return got;
    }, err => {
      const at = now();
      // The site as a whole is turning the bot away, or cannot be reached: no asking for any day
      // for a while. Anything else is about this one read.
      if (err.kind === 'challenge' || err.kind === 'limit') quiet = { until: at + BACKOFF_MS, err };
      else if (err.kind === 'timeout' || err.kind === 'network') quiet = { until: at + QUIET_MS, err };
      failed.set(k, { at, err });
      if (failed.size > 40) failed.delete(failed.keys().next().value);
      health = { ok: false, at, why: err.kind || 'odd' };
      log(`Glasgow Club (${centre.name}, ${dateIso}) could not be read: ${err.message}`);
      throw err;
    }).finally(() => flying.delete(k));
    flying.set(k, read);
    return read;
  }

  // What is already known about a day without asking the site, or null.
  function peek(key, dateIso, { fresh = false } = {}) {
    const hit = cache.get(`${key}:${dateIso}`);
    return hit && now() - hit.at < (fresh ? REFRESH_MS : CACHE_MS) ? hit : null;
  }

  return { day, peek, health: () => health };
}

module.exports = { createGlasgowClub, readDay, sheetUrl, whyText, problem, CENTRES, BASE, CACHE_MS, REFRESH_MS, BACKOFF_MS, QUIET_MS, TIMEOUT_MS };
