'use strict';
// Glasgow Club's indoor tennis courts (Gorbals and Scotstoun), read from its booking site.
//
// The bot LOOKS: which courts are free on a day. It cannot pay for one, and nothing here tries:
// Glasgow Club takes payment by card at the moment of booking, and it has saved cards and
// pay-by-link switched off (GladstonePay_AllowMemberWallet and PayByLink_Enabled in the site's
// own settings, as read on 19 Nov 2026). The furthest it goes is "Hold" (app.js): your PC
// signs in and puts a court in your basket, and the payment is yours to make. As read on that
// day the site keeps a basket in the browser that filled it, so the payment page is the one
// open on your PC; whether a phone signed in to the same account also shows the basket had not
// been tried when this was written, and the hold's card says so.
//
// The free courts come from the two calls the site's own page makes for any visitor: one for a
// visitor's session (a cookie), one for a day's sheet. No login is used.
//
// There are two ways to the sheet. From this server ("direct"), which Glasgow Club's site turns
// away when the server is in a cloud (Railway is: it gets a "checking your browser" page, as
// it does from ClubSpark). And by your PC at home, which makes the same two calls from your own
// connection and passes the sheet on (`via`, see askPc in app.js and lib/indoor.js on the PC).
// Either way, a "checking your browser" page or "too many requests" stops all asking that way
// for an hour. Nothing here, or on the PC, tries to get round one.
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
const BACKOFF_MS = 60 * 60 * 1000;   // after "checking your browser" or "too many requests": no asking that way for this long
const QUIET_MS = 30 * 1000;          // after the site could not be reached or did not answer: no asking that way for this long
const TIMEOUT_MS = 12000;            // for one whole direct read: the session (when one is needed) and the sheet together
const MAX_BYTES = 4 * 1024 * 1024;
const KINDS = ['challenge', 'limit', 'timeout', 'network', 'http', 'odd', 'pc'];

// The page a person books on: that centre's sheet for that day, every hour of it. (For today
// the site itself leaves out the hours that have passed.)
const sheetUrl = (centre, dateIso) => `${BASE}/book/calendar/${centre.activity}?activityDate=${dateIso}T00:00:00.000Z`;
// Your basket on Glasgow Club's site, and the site's front page.
const basketUrl = `${BASE}/book/basket`;
const siteUrl = `${BASE}/`;

// Something that stopped a read. `kind` is one of KINDS; `pc` is your PC not answering.
function problem(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}
const unreachable = e => problem(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network', (e && e.message) || 'no connection');
// The same, in words for you. `err.say`, when there is one, is those words already; `err.route`
// says which way the read went ('pc' or 'direct').
function whyText(err) {
  if (err && err.say) return err.say;
  const kind = err && err.kind, home = err && err.route === 'pc';
  if (kind === 'challenge') {
    return home ? 'Glasgow Club\'s site is checking visitors from your home connection just now, so your PC cannot read the free courts. It will not be asked again for an hour.'
      : 'Glasgow Club\'s site is checking its visitors and turns this server away, so I cannot read the free courts from here. I will not ask it again for an hour.';
  }
  if (kind === 'limit') return 'Glasgow Club\'s site says it is being asked too often, so it will not be asked again for an hour.';
  if (kind === 'pc') return 'Your PC did not answer in time, so I could not read Glasgow Club\'s free courts.';
  if (kind === 'timeout') return 'Glasgow Club\'s site did not answer in time.';
  if (kind === 'network') return home ? 'Your PC could not reach Glasgow Club\'s site.' : 'I could not reach Glasgow Club\'s site.';
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

// A day's sheet as your PC passes it on, back in the shape the site sent it. The PC sends each
// court as { n: its name, s: its slots }, a slot as
// [startTime, endTime, bookableFrom, bookableUntil, not open yet (1 or 0), status].
function sheetFromPc(sheet) {
  const bad = () => problem('odd', 'an answer from your PC that was not a day\'s sheet');
  if (!Array.isArray(sheet) || sheet.length > 60) throw bad();
  return {
    locations: sheet.map(loc => {
      if (!loc || typeof loc !== 'object' || !Array.isArray(loc.s) || loc.s.length > 400) throw bad();
      return {
        locationNameToDisplay: String(loc.n || '').slice(0, 80),
        slots: loc.s.map(s => {
          if (!Array.isArray(s)) throw bad();
          return { startTime: s[0], endTime: s[1], bookableFrom: s[2], bookableUntil: s[3], isBeforeTimetableSlotBookablePeriod: s[4] === 1 || s[4] === true, status: s[5] };
        }),
      };
    }),
  };
}

function createGlasgowClub({ fetchImpl = fetch, now = Date.now, log = () => {} } = {}) {
  let cookie = null, cookieAt = 0;
  const quiet = { direct: null, pc: null };   // which way -> { until, err }: no asking that way until then
  let health = null;                          // the last read: { ok, at, via, why }
  const cache = new Map();                    // "g:2026-11-25" -> { at, slots, listed }
  const flying = new Map();                   // the same key -> a read on its way
  const failed = new Map();                   // "pc:g:2026-11-25" -> { at, err }: a read that just failed is not tried again at once

  async function get(path, headers, signal) {
    let res;
    try {
      res = await fetchImpl(BASE + path, { headers: { accept: 'application/json', 'x-use-sso': '1', ...headers }, signal });
    } catch (e) {
      throw unreachable(e);
    }
    // Turned away: a "checking your browser" page (told by its header, or by what it says), or
    // a plain 403. Either way that is the end of it, and of asking this way for an hour.
    const page = /text\/html/i.test(String(res.headers.get('content-type') || ''));
    let checking = res.headers.get('cf-mitigated') === 'challenge';
    if (!checking && page && (res.status === 403 || res.status === 503)) {
      checking = /just a moment|challenge-platform|cf-chl|attention required/i.test(await res.text().catch(() => ''));
      if (!checking && res.status === 503) throw problem('http', 'HTTP 503');          // a maintenance page, say
    }
    if (checking) throw problem('challenge', 'the site is checking its visitors');
    if (res.status === 403) throw problem('challenge', 'the site turned the request away (HTTP 403)');
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
    try { return JSON.parse(text); } catch { throw problem('odd', 'an answer that was not the sheet'); }
  }

  // One day's sheet at a centre: { at, slots, listed }. Read at most once a minute (`fresh`:
  // once in ten seconds). `via`, when given, is your PC doing the reading: a function
  // (centre, dateIso) that resolves to the sheet as the site sent it. Without it the read is
  // made from this server. Throws a `problem` (with `route`) when the sheet cannot be read.
  async function day(key, dateIso, { fresh = false, via = null } = {}) {
    const centre = CENTRES[key];
    if (!centre || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw problem('odd', 'no such centre or day');
    const k = `${key}:${dateIso}`, t = now();
    const hit = cache.get(k);
    if (hit && t - hit.at < (fresh ? REFRESH_MS : CACHE_MS)) return hit;
    if (flying.has(k)) return flying.get(k);
    const route = via ? 'pc' : 'direct';
    if (quiet[route] && t < quiet[route].until) throw quiet[route].err;
    const fail = failed.get(`${route}:${k}`);
    if (fail && t - fail.at < REFRESH_MS) throw fail.err;
    const read = Promise.resolve().then(() => (via ? via(centre, dateIso) : fetchDay(centre, dateIso))).then(json => {
      const got = { at: now(), ...readDay(json, dateIso, now()) };
      cache.set(k, got);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      failed.delete(`${route}:${k}`);
      health = { ok: true, at: got.at, via: route };
      return got;
    }).catch(err => {
      const at = now();
      if (!KINDS.includes(err.kind)) err.kind = 'odd';
      err.route = route;
      // The site as a whole is turning that way away, or cannot be reached that way (the site
      // is not answering, or your PC is not): no asking that way for any day for a while, so a
      // tap on another day does not wait all over again. Anything else is about this one read.
      if (err.kind === 'challenge' || err.kind === 'limit') quiet[route] = { until: at + BACKOFF_MS, err };
      else if (err.kind === 'timeout' || err.kind === 'network' || err.kind === 'pc') quiet[route] = { until: at + QUIET_MS, err };
      failed.set(`${route}:${k}`, { at, err });
      if (failed.size > 40) failed.delete(failed.keys().next().value);
      health = { ok: false, at, via: route, why: err.kind };
      log(`Glasgow Club (${centre.name}, ${dateIso}) could not be read ${via ? 'by your PC' : 'from here'}: ${err.message}`);
      throw err;
    }).finally(() => flying.delete(k));
    flying.set(k, read);
    return read;
  }

  // What is already known about a day without asking anyone, or null.
  function peek(key, dateIso, { fresh = false } = {}) {
    const hit = cache.get(`${key}:${dateIso}`);
    return hit && now() - hit.at < (fresh ? REFRESH_MS : CACHE_MS) ? hit : null;
  }

  // Told from outside that the site turned a way away (your PC met a "checking your browser"
  // page while holding a court): no asking that way for an hour, as after a read that met one.
  function turnedAway(route, message) {
    if (!(route in quiet)) return;
    const err = problem('challenge', message || 'the site is checking its visitors');
    err.route = route;
    quiet[route] = { until: now() + BACKOFF_MS, err };
    health = { ok: false, at: now(), via: route, why: 'challenge' };
  }

  return { day, peek, health: () => health, turnedAway };
}

module.exports = { createGlasgowClub, readDay, sheetFromPc, sheetUrl, basketUrl, siteUrl, whyText, problem, CENTRES, KINDS, BASE, CACHE_MS, REFRESH_MS, BACKOFF_MS, QUIET_MS, TIMEOUT_MS };
