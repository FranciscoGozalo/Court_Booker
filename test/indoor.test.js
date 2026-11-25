'use strict';
// The indoor courts at Gorbals and Scotstoun (Glasgow Club): reading what is free, the screens,
// and the taps that lead to the page you book and pay on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const UI = require('../lib/ui');
const G = require('../lib/glasgowclub');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const pad = n => String(n).padStart(2, '0');

// One slot as the site sends it. `hh` is the hour on a UTC clock; `until` is when booking it
// closes (the site sends the slot's own start).
function slot(date, hh, { status = 'Available', before = false, from = '2026-11-10T00:00:00Z', mm = 0, until = null } = {}) {
  const start = `${date}T${pad(hh)}:${pad(mm)}:00Z`;
  return {
    startTime: start, endTime: `${date}T${pad(hh)}:59:59Z`, bookableFrom: from, bookableUntil: until || start,
    isBeforeTimetableSlotBookablePeriod: before, availability: { inCentre: 1, virtual: 0 }, status,
    slotReferences: { inCentre: '{}', virtual: null },
  };
}
// A day's sheet as the site sends it: { 'Tennis Hall Court 1': [slots], ... }
const sheet = (date, courts) => [{ id: 'S0815', name: 'Tennis Bookable', date, siteId: 'SRGLC', locations: Object.entries(courts).map(([name, slots]) => ({ locationNameToDisplay: name, slots })) }];
// The same, as the bot keeps it once read.
const read = (date, courts, now) => G.readDay(sheet(date, courts), date, now);

// ---------- reading the site's answer ----------

test('a day\'s sheet: only free courts still ahead, still bookable, on that day, earliest first', () => {
  const now = at(`${TUE}T12:00:00Z`);
  const got = read(TUE, {
    'Tennis Hall Court 3': [slot(TUE, 18), slot(TUE, 9, { until: `${TUE}T23:00:00Z` }), slot(TUE, 19, { status: 'Unavailable' })],   // 09:00 has started
    'Tennis Hall  Court 1': [slot(TUE, 18), slot(TUE, 13, { until: `${TUE}T11:00:00Z` }), slot(TUE, 14), slot('2026-11-18', 8)],     // 13:00 closed for booking at 11:00; one slot is another day's
    'Reception': [slot(TUE, 18)],                                                                                                     // not a court
  }, now);
  assert.deepEqual(got.slots.map(s => [s.start, s.end, s.court, s.opensAt]), [[840, 900, 1, null], [1080, 1140, 1, null], [1080, 1140, 3, null]]);
  assert.equal(got.slots[0].name, 'Tennis Hall Court 1');
  assert.equal(got.listed, 8);
  // A sheet with nothing on it is told apart from a sheet with nothing free.
  assert.deepEqual(G.readDay({ locations: [] }, TUE, now), { slots: [], listed: 0 });
  assert.deepEqual(G.readDay([], TUE, now), { slots: [], listed: 0 });
});

test('an answer that is not a sheet is never passed off as "nothing free"', () => {
  const now = at(`${TUE}T12:00:00Z`);
  for (const json of ['<html>', null, 7, {}, { message: 'nope' }, [{ id: 'S0815' }], [null]]) {
    assert.throws(() => G.readDay(json, TUE, now), e => e.kind === 'odd', JSON.stringify(json));
  }
  // The site changes how it names courts, or stops sending a status: the sheet no longer reads.
  assert.throws(() => read(TUE, { 'Main hall, left': [slot(TUE, 18)] }, now), e => e.kind === 'odd' && /no longer read/.test(e.message));
  assert.throws(() => G.readDay(sheet(TUE, { 'Tennis Court 1': [{ startTime: `${TUE}T18:00:00Z`, state: 'Free' }] }), TUE, now), e => e.kind === 'odd');
  assert.throws(() => G.readDay(sheet(TUE, { 'Tennis Court 1': [{ status: 'Available', start: '18:00' }, null] }), TUE, now), e => e.kind === 'odd');
});

test('a day that is not open yet: its courts are listed with when they open', () => {
  const now = at('2026-11-19T16:00:00Z');
  const opens = '2026-11-20T00:00:00Z';
  const got = read('2026-11-27', { 'Tennis Court 5': [slot('2026-11-27', 18, { before: true, from: opens }), slot('2026-11-27', 7, { from: opens })] }, now);
  assert.deepEqual(got.slots.map(s => [s.start, s.court, s.opensAt]), [[420, 5, at(opens)], [1080, 5, at(opens)]]);      // either sign counts: the flag, or a later date
});

test('times are shown on a Glasgow clock, in summer too, and a slot may end at midnight', () => {
  const now = at('2026-06-10T08:00:00Z');
  const from = '2026-06-05T00:00:00Z';
  const got = read('2026-06-12', { 'Tennis Court 2': [slot('2026-06-12', 17, { from }), slot('2026-06-12', 22, { from }), slot('2026-06-12', 23, { from, mm: 30 })] }, now);
  assert.deepEqual(got.slots.map(s => [s.start, s.end]), [[1080, 1140], [1380, 1440]]);     // 17:00 UTC is 18:00 in Glasgow; 23:30 UTC is already the 13th
});

// ---------- asking the site ----------

// A stand-in for the site: `answers` are handed out in turn to the day's-sheet calls.
function fakeSite(answers, { session = true } = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  async function fetchImpl(url, init = {}) {
    const path = url.replace(G.BASE, '');
    calls.push({ path, headers: init.headers || {}, signal: init.signal });
    if (path === '/api/samlauthentication/anonymous') {
      const headers = new Headers();
      if (session) headers.append('set-cookie', `Jwt=visitor${calls.filter(c => c.path === path).length}; expires=Fri, 20 Nov 2026 16:43:20 GMT; path=/; secure; httponly`);
      headers.append('set-cookie', 'SERVERID=web2; path=/');
      return new Response('', { status: 200, headers });
    }
    const next = answers.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return json(next === undefined ? [] : next);
  }
  return { fetchImpl, calls, json, sessions: () => calls.filter(c => c.path === '/api/samlauthentication/anonymous').length };
}
const html = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });

test('reading a day: a visitor\'s session first, then the sheet, and not again within a minute', async () => {
  const clock = { t: at(`${TUE}T12:00:00Z`) };
  const site = fakeSite([sheet(TUE, { 'Tennis Hall Court 3': [slot(TUE, 18)] }), sheet(TUE, { 'Tennis Hall Court 3': [] })]);
  const gc = G.createGlasgowClub({ fetchImpl: site.fetchImpl, now: () => clock.t });
  assert.equal(gc.health(), null);
  assert.equal(gc.peek('g', TUE), null);
  const got = await gc.day('g', TUE);
  assert.deepEqual(got.slots.map(s => [s.start, s.court]), [[1080, 3]]);
  assert.deepEqual([got.at, got.listed], [clock.t, 1]);
  assert.deepEqual(site.calls.map(c => c.path), [
    '/api/samlauthentication/anonymous',
    `/api/availability/V2/sessions?webBookableOnly=true&activityIds=S0815&siteIds=SRGLC&activityGroupIds=SA004&dateFrom=${TUE}T00:00:00.000Z&dateTo=${TUE}T23:59:59.999Z`,
  ]);
  assert.equal(site.calls[0].headers['x-use-sso'], '1');
  assert.equal(site.calls[1].headers.cookie, 'Jwt=visitor1; SERVERID=web2');           // the visitor's session, nothing of yours
  assert.ok(site.calls[0].signal instanceof AbortSignal);
  assert.equal(site.calls[0].signal, site.calls[1].signal);                           // one time limit for the whole read
  assert.deepEqual(gc.health(), { ok: true, at: clock.t, via: 'direct' });
  // Asked again within the minute: what it already knows.
  clock.t += 30000;
  assert.equal(await gc.day('g', TUE), got);
  assert.equal(gc.peek('g', TUE), got);
  assert.equal(site.calls.length, 2);
  // Refresh within ten seconds of a read is the same answer too; after that it asks.
  assert.equal(gc.peek('g', TUE, { fresh: true }), null);
  const again = await gc.day('g', TUE, { fresh: true });
  assert.deepEqual([again.slots, again.listed], [[], 0]);
  assert.equal(site.calls.length, 3);                                                   // the session was kept
  assert.equal(await gc.day('g', TUE, { fresh: true }), again);
  assert.equal(site.calls.length, 3);
  // Scotstoun has its own codes.
  await gc.day('s', TUE);
  assert.match(site.calls.at(-1).path, /activityIds=SA011&siteIds=SRSLC&activityGroupIds=SA004/);
  await assert.rejects(gc.day('x', TUE), e => e.kind === 'odd');
  await assert.rejects(gc.day('g', '17 nov'), e => e.kind === 'odd');
});

test('the visitor\'s session: one read for two asks, renewed once when it has run out, and after six hours', async () => {
  const clock = { t: at(`${TUE}T12:00:00Z`) };
  const site = fakeSite([new Response('', { status: 401 }), sheet(TUE, { 'Tennis Hall Court 1': [slot(TUE, 20)] }), [], new Response('', { status: 404 }), []]);
  const gc = G.createGlasgowClub({ fetchImpl: site.fetchImpl, now: () => clock.t });
  const [a, b] = await Promise.all([gc.day('g', TUE), gc.day('g', TUE)]);
  assert.equal(a, b);
  assert.deepEqual(a.slots.map(s => s.start), [1200]);
  assert.deepEqual(site.calls.map(c => c.path.split('?')[0]), ['/api/samlauthentication/anonymous', '/api/availability/V2/sessions', '/api/samlauthentication/anonymous', '/api/availability/V2/sessions']);
  assert.equal(site.calls[3].headers.cookie, 'Jwt=visitor2; SERVERID=web2');
  // Kept for six hours, then a new one is asked for.
  clock.t += 6 * 3600 * 1000 + 1;
  await gc.day('g', TUE);
  assert.equal(site.sessions(), 3);
  // The site refuses the sheet some other way: the next read starts from a new session.
  clock.t += 61000;
  await assert.rejects(gc.day('g', TUE), e => e.kind === 'http' && /HTTP 404/.test(e.message));
  clock.t += 11000;
  await gc.day('g', TUE);
  assert.equal(site.sessions(), 4);
  // No session at all comes back: said as that, and no sheet is asked for.
  const none = fakeSite([], { session: false });
  await assert.rejects(G.createGlasgowClub({ fetchImpl: none.fetchImpl, now: () => clock.t }).day('g', TUE), e => e.kind === 'odd' && /no visitor session/.test(e.message));
  assert.equal(none.calls.length, 1);
});

test('a "checking your browser" page, or "too many requests", stops all asking for an hour; nothing gets round it', async () => {
  for (const [answer, kind] of [
    [() => html(403, '<html><title>Just a moment...</title></html>'), 'challenge'],
    [() => html(503, '<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></html>'), 'challenge'],
    [() => new Response('{}', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'application/json' } }), 'challenge'],
    [() => new Response('{"message":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } }), 'challenge'],     // a plain refusal
    [() => html(403, '<html>Access denied</html>'), 'challenge'],
    [() => new Response('slow down', { status: 429 }), 'limit'],
  ]) {
    const clock = { t: at(`${TUE}T12:00:00Z`) };
    const site = fakeSite([answer(), sheet(TUE, {})]);
    const logs = [];
    const gc = G.createGlasgowClub({ fetchImpl: site.fetchImpl, now: () => clock.t, log: l => logs.push(l) });
    await assert.rejects(gc.day('g', TUE), e => e.kind === kind && e.route === 'direct', kind);
    assert.deepEqual(gc.health(), { ok: false, at: clock.t, via: 'direct', why: kind });
    const asked = site.calls.length;
    clock.t += 59 * 60 * 1000;
    await assert.rejects(gc.day('g', TUE), e => e.kind === kind);
    await assert.rejects(gc.day('s', '2026-11-18'), e => e.kind === kind);                // the other centre and other days too
    await assert.rejects(gc.day('g', TUE, { fresh: true }), e => e.kind === kind);        // and Refresh
    assert.equal(site.calls.length, asked);                                              // not one request in that time
    clock.t += 2 * 60 * 1000;
    assert.deepEqual((await gc.day('g', TUE)).slots, []);
    assert.equal(logs.length, 1);
  }
  assert.match(G.whyText({ kind: 'challenge' }), /turns this server away[\s\S]*an hour/);
  assert.match(G.whyText({ kind: 'challenge', route: 'pc' }), /from your home connection[\s\S]*your PC cannot read[\s\S]*an hour/);
  assert.match(G.whyText({ kind: 'limit' }), /asked too often[\s\S]*an hour/);
  assert.equal(G.whyText({ kind: 'challenge', say: 'In other words.' }), 'In other words.');
});

test('a site that does not answer is left alone for half a minute, whichever day is asked for', async () => {
  const clock = { t: at(`${TUE}T12:00:00Z`) };
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const site = fakeSite([timeout, new Error('getaddrinfo ENOTFOUND'), sheet(TUE, {})]);
  const gc = G.createGlasgowClub({ fetchImpl: site.fetchImpl, now: () => clock.t });
  await assert.rejects(gc.day('g', TUE), e => e.kind === 'timeout');
  const asked = site.calls.length;
  clock.t += 29000;
  await assert.rejects(gc.day('g', '2026-11-18'), e => e.kind === 'timeout');             // another day: no twelve-second wait again
  await assert.rejects(gc.day('s', TUE), e => e.kind === 'timeout');
  assert.equal(site.calls.length, asked);
  clock.t += 2000;
  await assert.rejects(gc.day('g', TUE), e => e.kind === 'network');
  clock.t += 31000;
  assert.deepEqual((await gc.day('g', TUE)).slots, []);
  assert.match(G.whyText({ kind: 'timeout' }), /did not answer in time/);
  assert.match(G.whyText({ kind: 'network' }), /could not reach/);
});

test('other failures are about the one read: named, and not repeated at once', async () => {
  const clock = { t: at(`${TUE}T12:00:00Z`) };
  const site = fakeSite([new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } }), sheet('2026-11-18', {}),
    html(503, '<html>maintenance</html>'), new Response('not json', { status: 200 }), { message: 'nope' }, sheet(TUE, {})]);
  const gc = G.createGlasgowClub({ fetchImpl: site.fetchImpl, now: () => clock.t });
  await assert.rejects(gc.day('g', TUE), e => e.kind === 'http' && /HTTP 500/.test(e.message));
  const asked = site.calls.length;
  await assert.rejects(gc.day('g', TUE), e => e.kind === 'http');                          // within ten seconds: the same answer, no request
  assert.equal(site.calls.length, asked);
  assert.deepEqual((await gc.day('g', '2026-11-18')).slots, []);                           // another day is still asked for
  for (const kind of ['http', 'odd', 'odd']) {                                             // a maintenance page is not taken for a visitor check
    clock.t += 11000;
    await assert.rejects(gc.day('g', TUE), e => e.kind === kind, kind);
  }
  assert.match(G.whyText({ kind: 'http', message: 'HTTP 500' }), /\(HTTP 500\)/);
  clock.t += 11000;
  assert.deepEqual((await gc.day('g', TUE)).slots, []);
  assert.deepEqual(gc.health(), { ok: true, at: clock.t, via: 'direct' });
});

// What your PC sends for a day (lib/indoor.js in the booker): each court as { n, s }, a slot as
// [startTime, endTime, bookableFrom, bookableUntil, not open yet, status].
const fromPc = (date, courts) => Object.entries(courts).map(([n, slots]) => ({ n, s: slots.map(s => [s.startTime, s.endTime, s.bookableFrom, s.bookableUntil, s.isBeforeTimetableSlotBookablePeriod ? 1 : 0, s.status]) }));

test('a sheet passed on by your PC reads exactly as one read from here', () => {
  const now = at(`${TUE}T12:00:00Z`);
  const courts = {
    'Tennis Hall Court 3': [slot(TUE, 18), slot(TUE, 9), slot(TUE, 19, { status: 'Unavailable' })],
    'Tennis Hall Court 1': [slot(TUE, 18), slot('2026-11-18', 8), slot(TUE, 20, { before: true, from: '2026-11-18T00:00:00Z' })],
    'Reception': [slot(TUE, 18)],
  };
  assert.deepEqual(G.readDay(G.sheetFromPc(fromPc(TUE, courts)), TUE, now), read(TUE, courts, now));
  assert.deepEqual(G.readDay(G.sheetFromPc([]), TUE, now), { slots: [], listed: 0 });
  for (const bad of [null, 'x', {}, [null], [{ n: 'Court 1' }], [{ n: 'Court 1', s: [{}] }], Array.from({ length: 61 }, () => ({ n: 'Court 1', s: [] }))]) {
    assert.throws(() => G.sheetFromPc(bad), e => e.kind === 'odd', JSON.stringify(bad).slice(0, 40));
  }
  // Slots that say nothing readable are a sheet that no longer reads, not "nothing free".
  assert.throws(() => G.readDay(G.sheetFromPc([{ n: 'Tennis Court 1', s: [[null, null, null, null, 0, null]] }]), TUE, now), e => e.kind === 'odd');
});

test('reading by way of your PC: the same cache, its own back-off, and no request from here', async () => {
  const clock = { t: at(`${TUE}T12:00:00Z`) };
  const site = fakeSite([html(403, '<html><title>Just a moment...</title></html>')]);
  const logs = [];
  const gc = G.createGlasgowClub({ fetchImpl: site.fetchImpl, now: () => clock.t, log: l => logs.push(l) });
  const asked = [];
  const answers = [G.sheetFromPc(fromPc(TUE, { 'Tennis Hall Court 3': [slot(TUE, 18)] })), G.problem('challenge', 'the site is checking its visitors'), G.sheetFromPc([])];
  const via = async (centre, dateIso) => { asked.push(`${centre.key}:${dateIso}`); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  const got = await gc.day('g', TUE, { via });
  assert.deepEqual(got.slots.map(s => [s.start, s.court]), [[1080, 3]]);
  assert.deepEqual(gc.health(), { ok: true, at: clock.t, via: 'pc' });
  assert.equal(await gc.day('g', TUE), got);                                               // known now, whichever way it is asked for
  assert.deepEqual([asked, site.calls.length], [[`g:${TUE}`], 0]);
  // The site turns this server away: that stops asking from here, not by way of the PC.
  await assert.rejects(gc.day('s', TUE), e => e.kind === 'challenge' && e.route === 'direct');
  const direct = site.calls.length;
  // And when it turns the PC away, the PC is left alone for an hour, for every day and centre.
  await assert.rejects(gc.day('s', TUE, { via }), e => e.kind === 'challenge' && e.route === 'pc');
  assert.deepEqual(gc.health(), { ok: false, at: clock.t, via: 'pc', why: 'challenge' });
  clock.t += 59 * 60 * 1000;
  await assert.rejects(gc.day('g', '2026-11-18', { via }), e => e.kind === 'challenge' && e.route === 'pc');
  assert.equal(asked.length, 2);
  assert.equal(site.calls.length, direct);
  clock.t += 2 * 60 * 1000;
  assert.deepEqual((await gc.day('g', '2026-11-18', { via })).slots, []);
  // Anything the PC says that is not a known kind of failure is just "odd".
  await assert.rejects(gc.day('s', '2026-11-19', { via: async () => { throw new Error('boom'); } }), e => e.kind === 'odd' && e.route === 'pc');
  assert.match(logs.join('\n'), /could not be read by your PC: the site is checking its visitors/);
  assert.match(logs.join('\n'), /could not be read from here: the site is checking its visitors/);
});

// ---------- the screens ----------

const ctxAt = t => ({ cfg: { plan: {}, once: [], order: [3, 4, 5, 2, 1, 6], releaseMin: 1320, daysAhead: 7 }, now: at(t), paused: false, results: {}, lastSeen: null, linked: true });
const flat = scr => scr.keyboard.inline_keyboard.flat();
const fits = scr => {
  assert.ok(scr.caption.length <= 1024, scr.caption);
  for (const row of scr.keyboard.inline_keyboard) assert.ok(row.length > 0);
  for (const b of flat(scr)) {
    assert.ok(b.text.length > 0);
    assert.equal(!!b.url, !b.callback_data);                                               // a link or a button, never both
    if (b.url) assert.match(b.url, /^https:\/\/glasgowclub\.gladstonego\.cloud\/book\/calendar\/(S0815|SA011|SA008)\?activityDate=\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    else assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  }
};

test('where to book: Kelvingrove, Gorbals, or Scotstoun indoor or outdoor', () => {
  const s = UI.venues();
  assert.deepEqual(flat(s).map(b => [b.text, b.callback_data]), [['Kelvingrove Park', 'bk'], ['Gorbals · indoor', 'g:g'], ['Scotstoun · indoor', 'g:s'], ['Scotstoun · outdoor', 'g:o'], ['Menu', 'h']]);
  assert.match(s.caption, /^<b>Book a court<\/b>\nWhere\?/);
  assert.match(s.caption, /outdoor at Scotstoun too/);
  fits(s);
});

test('Scotstoun\'s outdoor courts: their own days, day, time and hold screens, by their own name, with their own sheet', () => {
  const ctx = ctxAt(`${TUE}T12:00:00Z`);
  const days = UI.indoorDays(ctx, 'o');
  assert.match(days.caption, /^<b>Scotstoun · outdoor tennis<\/b>\nPick a day\./);
  assert.deepEqual(flat(days).filter(b => b.callback_data.startsWith('gd:')).map(b => b.callback_data).slice(0, 2), ['gd:o:20261117', 'gd:o:20261118']);
  fits(days);
  const got = { at: at(`${TUE}T12:00:05Z`), ...read('2026-11-20', { 'Outdoor Tennis Court 1': [slot('2026-11-20', 8), slot('2026-11-20', 17)], 'Outdoor Tennis Court 2': [slot('2026-11-20', 17)] }, ctx.now) };
  const day = UI.indoorDay(ctx, 'o', '2026-11-20', got);
  assert.equal(day.caption, '<b>Scotstoun outdoor · Fri 20 Nov</b>\nUpdated 12:00. One hour each.');
  assert.deepEqual(flat(day).map(b => [b.text, b.callback_data || b.url]), [
    ['08:00', 'gt:o:20261120:0800'], ['17:00', 'gt:o:20261120:1700'],
    ['Refresh', 'gr:o:20261120'], ['Open the sheet', 'https://glasgowclub.gladstonego.cloud/book/calendar/SA008?activityDate=2026-11-20T00:00:00.000Z'],
    ['Back', 'g:o'], ['Menu', 'h'],
  ]);
  fits(day);
  const time = UI.indoorSlot(ctx, 'o', '2026-11-20', 1020, got);
  assert.match(time.caption, /^<b>Scotstoun outdoor · Fri 20 Nov · 17:00–18:00<\/b>\nFree: courts 1 and 2,/);
  assert.deepEqual(flat(time).filter(b => (b.callback_data || '').startsWith('gh:')).map(b => [b.text, b.callback_data]), [['Hold court 1', 'gh:o:20261120:1700:1'], ['Hold court 2', 'gh:o:20261120:1700:2']]);
  assert.ok(flat(time).some(b => b.text === 'Open the Scotstoun outdoor sheet' && /\/SA008\?/.test(b.url)));
  fits(time);
  const held = UI.indoorHold(ctx, { id: 'a1b2c3d4e5f6', key: 'o', date: '2026-11-20', start: 1020, court: 2, stage: 'asked', end: null, order: null, by: 'telegram', price: null, until: null, heard: ctx.now });
  assert.match(held.caption, /^<b>Scotstoun outdoor · Fri 20 Nov · 17:00–18:00 · Court 2<\/b>/);
});

test('an indoor centre: today and the eight days after', () => {
  const s = UI.indoorDays(ctxAt(`${TUE}T12:00:00Z`), 's');
  assert.match(s.caption, /^<b>Scotstoun · indoor tennis<\/b>\nPick a day\. Glasgow Club opens each day for booking a week ahead, at midnight\.$/);
  const days = flat(s).filter(b => b.callback_data.startsWith('gd:'));
  assert.deepEqual(days.map(b => b.text), ['Today', 'Wed 18 Nov', 'Thu 19 Nov', 'Fri 20 Nov', 'Sat 21 Nov', 'Sun 22 Nov', 'Mon 23 Nov', 'Tue 24 Nov', 'Wed 25 Nov']);
  assert.equal(days[0].callback_data, 'gd:s:20261117');
  assert.equal(days[8].callback_data, 'gd:s:20261125');
  assert.deepEqual(flat(s).slice(-2).map(b => b.callback_data), ['b', 'h']);
  fits(s);
  // Late in the evening in summer, "today" is still Glasgow's today.
  assert.equal(flat(UI.indoorDays(ctxAt('2026-06-10T23:30:00Z'), 'g'))[0].callback_data, 'gd:g:20260611');
});

test('a day at a centre: its free start times as buttons, with the sheet one tap away', () => {
  const ctx = ctxAt(`${TUE}T12:00:00Z`);
  const readAt = at(`${TUE}T12:00:05Z`);
  const got = { at: readAt, ...read('2026-11-20', {
    'Tennis Hall Court 1': [slot('2026-11-20', 18), slot('2026-11-20', 7)],
    'Tennis Hall Court 3': [slot('2026-11-20', 18), slot('2026-11-20', 19)],
  }, ctx.now) };
  const s = UI.indoorDay(ctx, 'g', '2026-11-20', got);
  assert.equal(s.caption, '<b>Gorbals · Fri 20 Nov</b>\nUpdated 12:00. One hour each.');
  assert.deepEqual(flat(s).map(b => [b.text, b.callback_data || b.url]), [
    ['07:00', 'gt:g:20261120:0700'], ['18:00', 'gt:g:20261120:1800'], ['19:00', 'gt:g:20261120:1900'],
    ['Refresh', 'gr:g:20261120'], ['Open the sheet', 'https://glasgowclub.gladstonego.cloud/book/calendar/S0815?activityDate=2026-11-20T00:00:00.000Z'],
    ['Back', 'g:g'], ['Menu', 'h'],
  ]);
  fits(s);
  // Courts on the sheet, none of them free.
  const none = UI.indoorDay(ctx, 's', '2026-11-20', { at: readAt, ...read('2026-11-20', { 'Tennis Court 1': [slot('2026-11-20', 18, { status: 'Unavailable' })] }, ctx.now) });
  assert.equal(none.caption, '<b>Scotstoun · Fri 20 Nov</b>\nUpdated 12:00.\nNo court free that day.');
  assert.deepEqual(flat(none).map(b => b.text), ['Refresh', 'Open the sheet', 'Back', 'Menu']);
  assert.match(flat(none)[1].url, /\/SA011\?/);
  fits(none);
  // No courts on the sheet at all: said as that.
  const bare = UI.indoorDay(ctx, 's', '2026-11-20', { at: readAt, slots: [], listed: 0 });
  assert.equal(bare.caption, '<b>Scotstoun · Fri 20 Nov</b>\nUpdated 12:00.\nGlasgow Club lists no courts that day. Open the sheet to check.');
  // A full day of sixteen hours on six courts still fits.
  const full = {};
  for (let c = 1; c <= 6; c++) full[`Tennis Court ${c}`] = Array.from({ length: 16 }, (_, i) => slot('2026-11-20', 6 + i));
  const busy = UI.indoorDay(ctx, 's', '2026-11-20', { at: readAt, ...read('2026-11-20', full, ctx.now) });
  assert.equal(flat(busy).filter(b => (b.callback_data || '').startsWith('gt:')).length, 16);
  fits(busy);
});

test('a day that has not opened says when it does, and offers no times to tap', () => {
  const ctx = ctxAt('2026-11-19T16:00:00Z');
  const opens = '2026-11-20T00:00:00Z';
  const full = {};
  for (let c = 1; c <= 6; c++) full[`Tennis Court ${c}`] = Array.from({ length: 16 }, (_, i) => slot('2026-11-27', 6 + i, { before: true, from: opens }));
  const s = UI.indoorDay(ctx, 's', '2026-11-27', { at: ctx.now, ...read('2026-11-27', full, ctx.now) });
  assert.equal(s.caption, [
    '<b>Scotstoun · Fri 27 Nov</b>',
    'Updated 16:00.',
    'Not open for booking yet: Glasgow Club opens it at 00:00 on Fri 20 Nov (the midnight after Thu 19 Nov).',
    'Free as it stands: 06:00, 07:00, 08:00, 09:00, 10:00, 11:00, 12:00, 13:00, 14:00, 15:00, 16:00, 17:00, 18:00, 19:00, 20:00, 21:00.',
  ].join('\n'));
  assert.deepEqual(flat(s).map(b => b.text), ['Refresh', 'Open the sheet', 'Back', 'Menu']);
  fits(s);
});

test('when the site cannot be read, the sheet\'s link is still handed over', () => {
  const s = UI.indoorDay(ctxAt(`${TUE}T12:00:00Z`), 'g', '2026-11-20', null, G.problem('timeout', 'aborted'));
  assert.equal(s.caption, '<b>Gorbals · Fri 20 Nov</b>\nGlasgow Club\'s site did not answer in time.\nThe sheet itself still opens from the button below.');
  assert.deepEqual(flat(s).map(b => [b.text, b.callback_data || 'link']), [['Try again', 'gr:g:20261120'], ['Open the sheet', 'link'], ['Back', 'g:g'], ['Menu', 'h']]);
  // Whatever the site said goes out as text, never as formatting.
  assert.match(UI.indoorDay(ctxAt(`${TUE}T12:00:00Z`), 'g', '2026-11-20', null, G.problem('http', '<b>HTTP 500</b>')).caption, /\(&lt;b&gt;HTTP 500&lt;\/b&gt;\)/);
  fits(s);
});

test('one start time: which courts are free, whether the next hour is too, and the page to book and pay on', () => {
  const ctx = ctxAt(`${TUE}T12:00:00Z`);
  const got = { at: at(`${TUE}T12:00:05Z`), ...read('2026-11-20', {
    'Tennis Hall Court 1': [slot('2026-11-20', 18)],
    'Tennis Hall Court 3': [slot('2026-11-20', 18), slot('2026-11-20', 19)],
    'Tennis Hall Court 4': [slot('2026-11-20', 18), slot('2026-11-20', 19), slot('2026-11-20', 21)],
    'Tennis Hall Court 2': [slot('2026-11-20', 19)],
  }, ctx.now) };
  const s = UI.indoorSlot(ctx, 'g', '2026-11-20', 1080, got);
  assert.equal(s.caption, [
    '<b>Gorbals · Fri 20 Nov · 18:00–19:00</b>',
    'Free: courts 1, 3 and 4, as Glasgow Club showed it at 12:00.',
    'Free for the hour after as well, to 20:00: courts 3 and 4.',
    '<b>Hold</b> one and your PC signs in to Glasgow Club, puts it in your basket and opens the payment page. Then pay from the app (your PC pays with the card it keeps) or at your PC. I never see a card.',
    'Or book it yourself: open the sheet, press 18:00 under a free court, then Book and Continue to payment, and pay by card there. It asks you to sign in.',
    'The price shows before you pay. The court is yours once the payment has gone through.',
  ].join('\n'));
  assert.deepEqual(flat(s).map(b => [b.text, b.callback_data || b.url]), [
    ['Hold court 1', 'gh:g:20261120:1800:1'], ['Hold court 3', 'gh:g:20261120:1800:3'], ['Hold court 4', 'gh:g:20261120:1800:4'],
    ['Open the Gorbals sheet', 'https://glasgowclub.gladstonego.cloud/book/calendar/S0815?activityDate=2026-11-20T00:00:00.000Z'],
    ['Other times', 'gd:g:20261120'], ['Menu', 'h'],
  ]);
  assert.deepEqual(s.keyboard.inline_keyboard.map(r => r.length), [2, 1, 1, 2]);       // two holds to a row
  fits(s);
  // One court, and nothing after it.
  const one = UI.indoorSlot(ctx, 'g', '2026-11-20', 1260, got);
  assert.match(one.caption, /\nFree: court 4, as Glasgow Club showed it at 12:00\.\n<b>Hold<\/b> one/);
  assert.deepEqual(flat(one).map(b => b.text), ['Hold court 4', 'Open the Gorbals sheet', 'Other times', 'Menu']);
  // With no PC linked there is nothing that could hold a court: the link alone, as before.
  const alone = UI.indoorSlot({ ...ctx, linked: false }, 'g', '2026-11-20', 1260, got);
  assert.match(alone.caption, /\nFree: court 4, as Glasgow Club showed it at 12:00\.\nTo book it: open the sheet/);
  assert.deepEqual(flat(alone).map(b => b.text), ['Open the Gorbals sheet', 'Other times', 'Menu']);
  assert.equal(UI.indoorSlot(ctx, 'g', '2026-11-20', 1200, got), null);                    // nothing free at 20:00
});

// ---------- the taps ----------

function makeApp(t0, days = {}, { env = {} } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  // A stand-in for lib/glasgowclub.js: `days` maps "g:2026-11-20" to its free slots, or to an Error.
  const glasgow = {
    asked: [], answeredFirst: [], known: new Set(), last: null,
    async day(key, dateIso, opts = {}) {
      glasgow.asked.push(`${key}:${dateIso}${opts.fresh ? ':fresh' : ''}`);
      glasgow.answeredFirst.push(tg.answers.length);                 // how many taps had been answered when the site was asked
      const v = days[`${key}:${dateIso}`];
      if (v instanceof Error) { glasgow.last = { ok: false, at: clock.t, why: v.kind }; throw v; }
      glasgow.known.add(`${key}:${dateIso}`);
      glasgow.last = { ok: true, at: clock.t };
      return { at: clock.t, slots: v || [], listed: (v || []).length + 1 };
    },
    peek: (key, dateIso, opts = {}) => (!opts.fresh && glasgow.known.has(`${key}:${dateIso}`) ? {} : null),
    health: () => glasgow.last,
  };
  const logs = [];
  const app = createApp({ now: () => clock.t, tg, store: memStore({ owner: OWNER, order: [3, 4, 5, 2, 1, 6] }), pictures: PICTURES, linked: true, glasgow, log: l => logs.push(l), env });
  return { app, tg, clock, glasgow, days, logs };
}
let tapId = 1;
const tap = (app, data, messageId, { chat = OWNER, text = undefined } = {}) => app.handleUpdate({
  update_id: 1, callback_query: { id: String(tapId++), data, from: { id: chat }, message: { message_id: messageId, chat: { id: chat, type: 'private' }, ...(text === undefined ? {} : { text }) } },
});
const buttons = call => call.extra.reply_markup.inline_keyboard.flat();
const find = (call, text) => buttons(call).find(b => b.text === text);
const second = c => c.text.split('\n')[1];
const FRI = '2026-11-20';
const friday = () => read(FRI, { 'Tennis Hall Court 1': [slot(FRI, 18)], 'Tennis Hall Court 3': [slot(FRI, 18), slot(FRI, 19)] }, at(`${TUE}T12:00:00Z`)).slots;

test('booking an indoor court by tapping: menu, where, Gorbals, day, time, and the link to pay on', async () => {
  const { app, tg, glasgow } = makeApp(`${TUE}T12:00:00Z`, { [`g:${FRI}`]: friday() });
  await app.handleUpdate(say(OWNER, '/menu'));
  const card = tg.last().id;
  await tap(app, find(tg.last(), 'Book a date').callback_data, card);
  assert.match(tg.last().text, /^<b>Book a court<\/b>/);
  assert.equal(tg.last().id, card);
  await tap(app, find(tg.last(), 'Gorbals · indoor').callback_data, card);
  assert.match(tg.last().text, /^<b>Gorbals · indoor tennis<\/b>/);
  assert.deepEqual(glasgow.asked, []);                                             // nothing is read until a day is picked
  tg.clear();
  const answered = tg.answers.length;
  await tap(app, 'gd:g:20261120', card);
  // The card says it is reading, then shows the times.
  assert.deepEqual(tg.calls.map(second), ['Reading Glasgow Club\'s sheet…', 'Updated 12:00. One hour each.']);
  assert.deepEqual(tg.calls.map(c => [c.method, c.id]), [['caption', card], ['caption', card]]);
  assert.deepEqual(glasgow.asked, [`g:${FRI}`]);
  // The tap was answered once, without words, and before the wait for the site.
  assert.deepEqual(tg.answers.slice(answered), [null]);
  assert.deepEqual(glasgow.answeredFirst, [answered + 1]);
  await tap(app, find(tg.last(), '18:00').callback_data, card);
  assert.match(tg.last().text, /^<b>Gorbals · Fri 20 Nov · 18:00–19:00<\/b>\nFree: courts 1 and 3, as Glasgow Club showed it at 12:00\.\nFree for the hour after as well, to 20:00: court 3\./);
  assert.equal(find(tg.last(), 'Open the Gorbals sheet').url, `https://glasgowclub.gladstonego.cloud/book/calendar/S0815?activityDate=${FRI}T00:00:00.000Z`);
  assert.deepEqual(buttons(tg.last()).slice(0, 2).map(b => b.callback_data), ['gh:g:20261120:1800:1', 'gh:g:20261120:1800:3']);
  assert.equal(tg.answers.length, answered + 2);
  // Only the one card throughout, and nothing was added to the Kelvingrove requests.
  assert.equal(tg.calls.filter(c => c.method === 'photo').length, 0);
  assert.deepEqual(app.state.once, []);
  // Other times goes back to the day without the "reading" step (it is known already).
  tg.clear();
  await tap(app, find({ extra: { reply_markup: UI.indoorSlot({ now: at(`${TUE}T12:00:00Z`) }, 'g', FRI, 1080, { at: at(`${TUE}T12:00:00Z`), slots: friday() }).keyboard } }, 'Other times').callback_data, card);
  assert.equal(tg.calls.length, 1);
  assert.match(tg.last().text, /Updated \d\d:\d\d\. One hour each\./);
});

test('Refresh reads the day afresh; a time that has gone says so and shows what is left', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { [`g:${FRI}`]: friday() });
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  assert.match(t.tg.last().text, /^<b>Gorbals · indoor tennis<\/b>/);
  const card = t.tg.last().id;
  await tap(t.app, 'gd:g:20261120', card);
  t.tg.clear();
  await tap(t.app, 'gr:g:20261120', card);
  assert.deepEqual(t.glasgow.asked, [`g:${FRI}`, `g:${FRI}:fresh`]);
  assert.deepEqual(t.tg.calls.map(second), ['Reading Glasgow Club\'s sheet…', 'Updated 12:00. One hour each.']);   // a refresh is a read, so it says so
  // Someone takes the 19:00 court in the meantime.
  t.days[`g:${FRI}`] = friday().filter(s => s.start !== 1140);
  await tap(t.app, 'gt:g:20261120:1900', card);
  assert.match(t.tg.last().text, /^<b>Gorbals · Fri 20 Nov<\/b>\nNo court is free at 19:00 any more\.\nUpdated 12:00\. One hour each\./);
  assert.deepEqual(buttons(t.tg.last()).filter(b => (b.callback_data || '').startsWith('gt:')).map(b => b.text), ['18:00']);
});

test('when Glasgow Club cannot be read the card says why and still carries the link', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { [`s:${FRI}`]: G.problem('challenge', 'the site is checking its visitors') });
  await t.app.handleUpdate(say(OWNER, '/scotstoun'));
  assert.match(t.tg.last().text, /^<b>Scotstoun · indoor tennis<\/b>/);
  assert.ok(buttons(t.tg.last()).filter(b => b.callback_data.startsWith('gd:')).every(b => b.callback_data.startsWith('gd:s:')));
  const card = t.tg.last().id;
  await tap(t.app, 'gd:s:20261120', card);
  // The PC is not awake, and the site turns this server away: said as that, with the link.
  assert.match(t.tg.last().text, /^<b>Scotstoun · Fri 20 Nov<\/b>\nYour PC reads Glasgow Club’s courts, and it isn’t awake\. Wake it and try again, or open the sheet\.\nThe sheet itself still opens from the button below\.$/);
  assert.equal(find(t.tg.last(), 'Open the sheet').url, `https://glasgowclub.gladstonego.cloud/book/calendar/SA011?activityDate=${FRI}T00:00:00.000Z`);
  assert.deepEqual(buttons(t.tg.last()).map(b => b.text), ['Try again', 'Open the sheet', 'Back', 'Menu']);       // waking is not set up here, so no Wake button
  // A time tapped on an old card, with the site unreadable: the same card, no crash.
  await tap(t.app, 'gt:s:20261120:1800', card);
  assert.match(t.tg.last().text, /and it isn’t awake/);
  // /status says how the last look went.
  await t.app.handleUpdate(say(OWNER, '/status'));
  assert.match(t.tg.last().text, /\nIndoor courts \(Glasgow Club\): could not be read from this server at 12:00:00 \(its site was checking visitors\)\n/);
  // Any other failure keeps its own words.
  const slow = makeApp(`${TUE}T12:00:00Z`, { [`g:${FRI}`]: G.problem('timeout', 'aborted') });
  await slow.app.handleUpdate(say(OWNER, '/gorbals'));
  await tap(slow.app, 'gd:g:20261120', slow.tg.last().id);
  assert.match(slow.tg.last().text, /\nGlasgow Club's site did not answer in time\.\n/);
});

test('days that are no longer on offer, and taps that make no sense, lead back to the list of days', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`);
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  const card = t.tg.last().id;
  for (const data of ['gd:g:20261116', 'gd:g:20261126', 'gd:g:20261340', 'gt:g:20261120', 'gd:g:20261120:1800']) {
    t.tg.clear();
    await tap(t.app, data, card);
    assert.match(t.tg.last().text, /^<b>Gorbals · indoor tennis<\/b>/, data);
    assert.equal(t.tg.answers.at(-1), 'That day is no longer on offer. Pick again.', data);
  }
  assert.deepEqual(t.glasgow.asked, []);
  // Nonsense is turned away like any other out-of-date button.
  await tap(t.app, 'gd:x:20261120', card);
  assert.equal(t.tg.answers.at(-1), 'That button is out of date. Send /menu.');
  // Someone else's tap never reaches Glasgow Club.
  await tap(t.app, 'gd:g:20261120', card, { chat: 999 });
  assert.equal(t.tg.answers.at(-1), 'This bot is private.');
  assert.deepEqual(t.glasgow.asked, []);
  // A date that does not exist, though the day it would roll over to is on offer (31 Nov: 1 Dec).
  const late = makeApp('2026-11-25T12:00:00Z');
  await late.app.handleUpdate(say(OWNER, '/gorbals'));
  await tap(late.app, 'gd:g:20261131', late.tg.last().id);
  assert.equal(late.tg.answers.at(-1), 'That day is no longer on offer. Pick again.');
  assert.deepEqual(late.glasgow.asked, []);
  await tap(late.app, 'gd:g:20261201', late.tg.last().id);
  assert.deepEqual(late.glasgow.asked, ['g:2026-12-01']);
});

test('a card Telegram will not change: one new card takes over, and the times land on it', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { [`g:${FRI}`]: friday() });
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  const old = t.tg.last().id;
  t.tg.clear();
  t.tg.failEdit = { code: 400, message: 'Bad Request: message to edit not found', once: true };
  await tap(t.app, 'gd:g:20261120', old);
  assert.deepEqual(t.tg.calls.map(c => c.method), ['photo', 'caption']);              // one new card, then the same one changed
  assert.equal(t.tg.calls[1].id, t.tg.calls[0].id);
  assert.notEqual(t.tg.calls[0].id, old);
  assert.deepEqual(t.tg.calls.map(second), ['Reading Glasgow Club\'s sheet…', 'Updated 12:00. One hour each.']);
});

test('a failure after the tap was answered is said in a message, not swallowed', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { [`g:${FRI}`]: friday() });
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  const card = t.tg.last().id;
  t.tg.clear();
  const answered = t.tg.answers.length;
  t.tg.failEdit = { code: 429, message: 'Too Many Requests: retry after 5' };
  await tap(t.app, 'gd:g:20261120', card);
  assert.deepEqual(t.tg.answers.slice(answered), [null]);                              // a tap can be answered only once
  assert.deepEqual(t.tg.calls.map(c => [c.method, c.text]), [['send', 'That did not work: I could not update the card. Send /menu to start again.']]);
  assert.match(t.logs.at(-1), /^Indoor button failed: Too Many Requests/);
});

test('indoor buttons on a wide (text) card, and with the "new card" mark, behave like the rest', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { [`g:${FRI}`]: friday() }, { env: { RAILWAY_PUBLIC_DOMAIN: 'bot.example.app' } });
  await t.app.handleUpdate(say(OWNER, '/wide'));
  const wide = t.tg.last().id;
  t.tg.clear();
  await tap(t.app, 'gd:g:20261120', wide, { text: 'x' });
  assert.deepEqual(t.tg.calls.map(c => [c.method, c.id]), [['edit', wide], ['edit', wide]]);       // the text card is edited as text, both times
  assert.match(t.tg.last().text, /Updated \d\d:\d\d\. One hour each\./);
  assert.equal(t.tg.last().extra.link_preview_options.url, 'https://bot.example.app/card/home-offline?v=hash-home-offline');
  // "n:" keeps the message that was tapped and opens a card for the answer.
  t.tg.clear();
  await tap(t.app, 'n:gt:g:20261120:1800', 555);
  assert.deepEqual(t.tg.calls.map(c => c.method), ['photo']);                                       // known already, so no "reading" step
  assert.notEqual(t.tg.last().id, 555);
  assert.match(t.tg.last().text, /^<b>Gorbals · Fri 20 Nov · 18:00–19:00<\/b>/);
  t.clock.t += 61000; t.glasgow.known.clear();
  t.tg.clear();
  await tap(t.app, 'n:gd:g:20261120', 555);
  assert.deepEqual(t.tg.calls.map(c => c.method), ['photo', 'caption']);
  assert.equal(t.tg.calls[1].id, t.tg.calls[0].id);
});

test('Kelvingrove is one tap further on, and everything about it is as before', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`);
  await t.app.handleUpdate(say(OWNER, '/book'));
  assert.match(t.tg.last().text, /^<b>Book a court<\/b>/);
  const card = t.tg.last().id;
  await tap(t.app, find(t.tg.last(), 'Kelvingrove Park').callback_data, card);
  assert.match(t.tg.last().text, /^<b>Book a date<\/b>/);
  assert.deepEqual(buttons(t.tg.last()).slice(-2).map(b => [b.text, b.callback_data]), [['Back', 'b'], ['Menu', 'h']]);
  await tap(t.app, 'ok:20261125:1900:2', card);
  assert.deepEqual(t.app.state.once, [{ date: '2026-11-25', start: 1140, hours: 2 }]);
  // "Book another" stays with Kelvingrove: straight back to its calendar.
  await tap(t.app, find(t.tg.last(), 'Book another').callback_data, card);
  assert.match(t.tg.last().text, /^<b>Book a date<\/b>/);
  // Typed, a Kelvingrove date still goes straight in.
  await t.app.handleUpdate(say(OWNER, '/book 26 nov 18:00'));
  assert.equal(t.app.state.once.length, 2);
  // What your PC is handed has nothing indoor in it.
  const jobs = t.app.jobsForAgent({}, { run: false });
  assert.deepEqual(Object.keys(jobs).sort(), ['daysAhead', 'jobs', 'order', 'releaseMin']);
  assert.deepEqual(t.glasgow.asked, []);
  await t.app.handleUpdate(say(OWNER, '/help'));
  assert.match(t.tg.last().text, /\/gorbals {2}and {2}\/scotstoun/);
  await t.app.handleUpdate(say(OWNER, '/status'));
  assert.match(t.tg.last().text, /\(version 2\.12\.0\)[\s\S]*\nIndoor courts \(Glasgow Club\): not looked up since the last restart\n/);
});

test('the look at Glasgow Club on start-up is said in the log, whichever way it goes, and /status has it', async () => {
  const wed = read('2026-11-18', { 'Tennis Hall Court 1': [slot('2026-11-18', 18), slot('2026-11-18', 19)], 'Tennis Hall Court 2': [slot('2026-11-18', 18)] }, at(`${TUE}T12:00:00Z`)).slots;
  const ok = makeApp(`${TUE}T12:00:00Z`, { 'g:2026-11-18': wed });
  assert.equal(await ok.app.checkIndoor(), true);
  assert.deepEqual(ok.logs, ['Glasgow Club answers from here: Gorbals on Wed 18 Nov has 2 start times with a free court.']);
  await ok.app.handleUpdate(say(OWNER, '/status'));
  assert.match(ok.tg.last().text, /\nIndoor courts \(Glasgow Club\): last read from this server at 12:00:00\n/);
  const bad = makeApp(`${TUE}T12:00:00Z`, { 'g:2026-11-18': G.problem('challenge', 'x') });
  assert.equal(await bad.app.checkIndoor(), false);
  assert.equal(bad.logs[0], 'Glasgow Club does not answer from here (challenge). Your PC reads its free courts instead, while it is awake.');
});

// ---------- your PC does the reading ----------

// The bot with the real reader: from here the site answers with a "checking your browser" page
// (as it does to Railway), so the only way to the sheet is your PC.
function makePcApp(t0, { pcLookMs = 2000, env = {}, state = {} } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const site = fakeSite([]);
  const fetchImpl = async (url, init) => { site.calls.push({ path: url.replace(G.BASE, ''), headers: (init && init.headers) || {} }); return html(403, '<html><title>Just a moment...</title></html>'); };
  const logs = [];
  const glasgow = G.createGlasgowClub({ fetchImpl, now: () => clock.t, log: l => logs.push(l) });
  const app = createApp({ now: () => clock.t, tg, store: memStore({ owner: OWNER, order: [3, 4, 5, 2, 1, 6], ...state }), pictures: PICTURES, linked: true, glasgow, log: l => logs.push(l), env, pcLookMs });
  return { app, tg, clock, site, logs };
}
const fridayFromPc = () => fromPc(FRI, { 'Tennis Hall Court 1': [slot(FRI, 18)], 'Tennis Hall Court 3': [slot(FRI, 18), slot(FRI, 19)] });

test('while your PC is awake it reads Glasgow Club for the bot: asked on its ping, answered on /agent/look', async () => {
  const t = makePcApp(`${TUE}T12:00:00Z`);
  await t.app.pingFromAgent({ ip: '81.2.69.142' });                     // the PC is in touch: awake
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  const card = t.tg.last().id;
  t.tg.clear();
  const ping = t.app.pingFromAgent({ ip: '81.2.69.142' }, { wait: 5 });  // the PC's ping, held open for something to do
  const tapped = tap(t.app, 'gd:g:20261120', card);
  const order = await ping;
  assert.deepEqual(Object.keys(order).sort(), ['look', 'ok']);
  assert.deepEqual([order.look.key, order.look.date], ['g', FRI]);
  assert.match(order.look.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(t.app.lookFromAgent({ id: order.look.id, ok: true, sheet: fridayFromPc() }), { ok: true });
  await tapped;
  assert.deepEqual(t.tg.calls.map(second), ['Reading Glasgow Club\'s sheet…', 'Updated 12:00. One hour each.']);
  assert.deepEqual(buttons(t.tg.last()).filter(b => (b.callback_data || '').startsWith('gt:')).map(b => b.text), ['18:00', '19:00']);
  assert.equal(t.site.calls.length, 0);                                 // nothing was asked of the site from here
  // The time's screen comes from what the PC read; no second look within the minute.
  const idle = t.app.pingFromAgent({}, { wait: 0 });
  await tap(t.app, 'gt:g:20261120:1800', card);
  assert.match(t.tg.last().text, /^<b>Gorbals · Fri 20 Nov · 18:00–19:00<\/b>\nFree: courts 1 and 3/);
  assert.deepEqual(await idle, { ok: true });
  await t.app.handleUpdate(say(OWNER, '/status'));
  assert.match(t.tg.last().text, /\nIndoor courts \(Glasgow Club\): last read by your PC at 12:00:00\n/);
  // An answer nobody is waiting for is dropped without fuss.
  assert.deepEqual(t.app.lookFromAgent({ id: order.look.id, ok: true, sheet: [] }), { ok: true, late: true });
  assert.deepEqual(t.app.lookFromAgent(null), { ok: true, late: true });
});

test('a look goes before a request to sleep, and each is handed over once', async () => {
  const t = makePcApp(`${TUE}T12:00:00Z`);
  await t.app.pingFromAgent();
  await t.app.handleUpdate(say(OWNER, '/sleep'));
  const tapped = tap(t.app, 'gd:s:20261120', 1);
  await new Promise(r => setTimeout(r, 20));                            // the tap has got as far as asking the PC
  const first = await t.app.pingFromAgent({}, { wait: 5 });
  assert.deepEqual([first.look.key, first.look.date, first.sleep], ['s', FRI, undefined]);
  t.app.lookFromAgent({ id: first.look.id, ok: true, sheet: [] });
  await tapped;
  assert.deepEqual(await t.app.pingFromAgent({}, { wait: 5 }), { ok: true, sleep: true });
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });
});

test('your PC does not answer, or is turned away itself: said as that, with the link, and it is not asked again at once', async () => {
  const t = makePcApp(`${TUE}T12:00:00Z`, { pcLookMs: 30 });
  await t.app.pingFromAgent();
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  const card = t.tg.last().id;
  await tap(t.app, 'gd:g:20261120', card);                              // no ping collects it within the 30 ms it gets here
  assert.match(t.tg.last().text, /^<b>Gorbals · Fri 20 Nov<\/b>\nYour PC did not answer in time, so I could not read Glasgow Club's free courts\.\nThe sheet itself still opens from the button below\.$/);
  assert.deepEqual(buttons(t.tg.last()).map(b => b.text), ['Try again', 'Open the sheet', 'Back', 'Menu']);
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });          // the look that ran out is not handed over later
  await t.app.handleUpdate(say(OWNER, '/status'));
  assert.match(t.tg.last().text, /\nIndoor courts \(Glasgow Club\): could not be read by your PC at 12:00:00 \(your PC did not answer in time\)\n/);
  // For the next half minute another day gets the same answer at once, with no second wait.
  t.clock.t += 20000;
  await t.app.pingFromAgent();
  const waiting = t.app.pingFromAgent({}, { wait: 0.05 });
  const before = Date.now();
  await tap(t.app, 'gd:s:20261121', card);
  assert.ok(Date.now() - before < 25, 'no second wait');
  assert.match(t.tg.last().text, /^<b>Scotstoun · Sat 21 Nov<\/b>\nYour PC did not answer in time/);
  assert.deepEqual(await waiting, { ok: true });
  // The PC answers that the site turned it away: your home connection is left alone for an hour.
  t.clock.t += 11000;
  const ping = t.app.pingFromAgent({}, { wait: 5 });
  const tapped = tap(t.app, 'gd:g:20261120', card);
  const order = await ping;
  t.app.lookFromAgent({ id: order.look.id, ok: false, kind: 'challenge', why: 'the site is checking its visitors' });
  await tapped;
  assert.match(t.tg.last().text, /\nGlasgow Club's site is checking visitors from your home connection just now, so your PC cannot read the free courts\. It will not be asked again for an hour\.\n/);
  t.clock.t += 30 * 60 * 1000;
  await t.app.pingFromAgent();
  const later = t.app.pingFromAgent({}, { wait: 1 });
  await tap(t.app, 'gd:s:20261121', card);
  assert.match(t.tg.last().text, /from your home connection/);
  assert.deepEqual(await later, { ok: true });                          // no look was asked of the PC
  assert.equal(t.site.calls.length, 0);
  // A reason the PC makes up is still only text.
  t.clock.t += 31 * 60 * 1000;
  await t.app.pingFromAgent();
  const ping2 = t.app.pingFromAgent({}, { wait: 5 });
  const tapped2 = tap(t.app, 'gd:g:20261120', card);
  t.app.lookFromAgent({ id: (await ping2).look.id, ok: false, kind: 'pc', why: '<b>x</b>' });
  await tapped2;
  assert.match(t.tg.last().text, /did not give me the free courts \(&lt;b&gt;x&lt;\/b&gt;\)/);
});

test('close to a Kelvingrove booking nothing is asked of your PC', async () => {
  const t = makePcApp(`${TUE}T21:52:00Z`, { state: { plan: { tue: { start: 960, hours: 2 } } } });      // Tuesdays are booked tonight at 22:00
  await t.app.pingFromAgent();
  const held = t.app.pingFromAgent({}, { wait: 1 });
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  await tap(t.app, 'gd:g:20261120', t.tg.last().id);
  assert.match(t.tg.last().text, /^<b>Gorbals · Fri 20 Nov<\/b>\nNot available until 22:10, around the nightly booking\.\nThe sheet itself still opens from the button below\.$/);
  assert.deepEqual(await held, { ok: true });
  assert.equal(t.site.calls.length, 0);
  // The same on a night when no day opens: the run still starts at 21:55.
  const quietNight = makePcApp(`${TUE}T21:56:00Z`);
  await quietNight.app.pingFromAgent();
  await tap(quietNight.app, 'gd:g:20261120', 1);
  assert.match(quietNight.tg.last().text, /Not available until 22:10, around the nightly booking/);
  // Before and after that window it is asked as usual.
  for (const when of [`${TUE}T21:49:00Z`, `${TUE}T22:10:30Z`]) {
    const u = makePcApp(when, { state: { plan: { tue: { start: 960, hours: 2 } } } });
    await u.app.pingFromAgent();
    const ping = u.app.pingFromAgent({}, { wait: 5 });
    const tapped = tap(u.app, 'gd:g:20261120', 1);
    u.app.lookFromAgent({ id: (await ping).look.id, ok: true, sheet: fridayFromPc() });
    await tapped;
    assert.match(u.tg.last().text, /Updated \d\d:\d\d\. One hour each\./, when);
  }
});

test('after a start, when this server is turned away, the way by your PC is tried once and said in the log', async () => {
  const t = makePcApp(`${TUE}T12:00:00Z`);
  // Before the look from here has been made, a ping that could carry the question carries none.
  assert.deepEqual(await t.app.pingFromAgent({}, { wait: 0.05 }), { ok: true });
  assert.equal(await t.app.checkIndoor(), false);                       // from here: turned away
  const order = await t.app.pingFromAgent({}, { wait: 5 });              // the PC's next ping carries the question
  assert.deepEqual([order.look.key, order.look.date], ['g', '2026-11-18']);
  t.app.lookFromAgent({ id: order.look.id, ok: true, sheet: fromPc('2026-11-18', { 'Tennis Hall Court 1': [slot('2026-11-18', 18), slot('2026-11-18', 19)] }) });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(t.logs.at(-1), 'Your PC read Glasgow Club for me: Gorbals on Wed 18 Nov has 2 start times with a free court.');
  // Only once: the next pings are left in peace, also after this server has been turned away again.
  assert.deepEqual(await t.app.pingFromAgent({}, { wait: 0.05 }), { ok: true });
  t.clock.t += 10 * 60 * 1000;                                          // the PC has been quiet: it counts as asleep
  await tap(t.app, 'gd:s:20261120', 1);                                  // so this look goes from here, and is turned away
  assert.match(t.tg.last().text, /and it isn’t awake/);
  assert.deepEqual(await t.app.pingFromAgent({}, { wait: 0.05 }), { ok: true });
  // And when the PC cannot either, that is said too.
  const u = makePcApp(`${TUE}T12:00:00Z`);
  await u.app.checkIndoor();
  const o = await u.app.pingFromAgent({}, { wait: 5 });
  u.app.lookFromAgent({ id: o.look.id, ok: false, kind: 'timeout', why: 'The operation was aborted due to timeout' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(u.logs.at(-1), 'Your PC could not read Glasgow Club for me (timeout): The operation was aborted due to timeout.');
  // Close to a booking it waits for a later ping.
  const v = makePcApp(`${TUE}T21:55:00Z`, { state: { plan: { tue: { start: 960, hours: 2 } } } });
  await v.app.checkIndoor();
  assert.deepEqual(await v.app.pingFromAgent({}, { wait: 0.05 }), { ok: true });
  // A request to sleep that is waiting for the PC goes alone; the look waits for a later ping.
  const w = makePcApp(`${TUE}T12:00:00Z`);
  await w.app.pingFromAgent();
  await w.app.handleUpdate(say(OWNER, '/sleep'));
  await w.app.checkIndoor();
  assert.deepEqual(await w.app.pingFromAgent({}, { wait: 0.05 }), { ok: true, sleep: true });
  w.clock.t += 1000;
  assert.deepEqual(Object.keys(await w.app.pingFromAgent({}, { wait: 5 })).sort(), ['look', 'ok']);
});

test('with your PC asleep the card offers to wake it, when waking is set up', async () => {
  const t = makePcApp(`${TUE}T12:00:00Z`, { env: { WAKE_MAC: 'AA:BB:CC:DD:EE:FF' } });
  await t.app.pingFromAgent({ ip: '81.2.69.142' });                     // in touch once: home is known
  t.clock.t += 10 * 60 * 1000;                                          // and then quiet: asleep
  await t.app.handleUpdate(say(OWNER, '/gorbals'));
  await tap(t.app, 'gd:g:20261120', t.tg.last().id);
  assert.match(t.tg.last().text, /Your PC reads Glasgow Club’s courts, and it isn’t awake\. Wake it and try again, or open the sheet\./);
  assert.deepEqual(buttons(t.tg.last()).map(b => [b.text, b.callback_data || 'link']), [['Wake my PC', 'wk'], ['Try again', 'gr:g:20261120'], ['Open the sheet', 'link'], ['Back', 'g:g'], ['Menu', 'h']]);
  assert.equal(t.site.calls.length, 1);                                 // one try from here, turned away
  // Asked again within the hour: no second request from here.
  t.clock.t += 20 * 60 * 1000;
  await tap(t.app, 'gr:g:20261120', t.tg.last().id);
  assert.match(t.tg.last().text, /and it isn’t awake/);
  assert.equal(t.site.calls.length, 1);
  // A PC that still counts as awake but does not answer gets the same offer.
  const u = makePcApp(`${TUE}T12:00:00Z`, { env: { WAKE_MAC: 'AA:BB:CC:DD:EE:FF' }, pcLookMs: 30 });
  await u.app.pingFromAgent({ ip: '81.2.69.142' });
  await tap(u.app, 'gd:g:20261120', 1);
  assert.match(u.tg.last().text, /Your PC did not answer in time/);
  assert.deepEqual(buttons(u.tg.last()).map(b => b.text), ['Wake my PC', 'Try again', 'Open the sheet', 'Back', 'Menu']);
});
