'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/availability');
const L = require('../lib/links');

const DATE = '2026-11-26';
const SLOT = [1140, 1260];                                   // 19:00 to 21:00
const open = (start, end, extra = {}) => ({ Category: 0, SubCategory: 0, Name: 'Pay and play', StartTime: start, EndTime: end, Interval: 60, Capacity: 1, Restrictions: '', ...extra });
const booking = (start, end, Category = 1000) => ({ Category, Name: 'Booking', StartTime: start, EndTime: end, Capacity: 0 });
// One court as the sheet lists it. ClubSpark gives dates as midnight timestamps.
const court = (n, sessions, date = DATE) => ({ ID: L.COURTS[n], Name: `Court ${n}`, Category: 1, Days: [{ Date: `${date}T00:00:00`, Sessions: sessions }] });
const sheet = resources => ({ TimeZone: 'GMT Standard Time', MinimumInterval: 60, Resources: resources });

test('a court is free only when bookable time covers the whole slot and nothing else is on it', () => {
  const state = sessions => A.slotState(court(1, sessions), DATE, ...SLOT);
  assert.equal(state([open(420, 1320)]), 'free');
  assert.equal(state([open(420, 1200), open(1200, 1320)]), 'free');                 // two price bands meeting at 20:00
  assert.equal(state([open(1200, 1320), open(420, 1200)]), 'free');                 // in any order
  assert.equal(state([open(420, 1140), booking(1080, 1140), open(1140, 1320)]), 'free');   // a booking that ends as the slot starts
  assert.equal(state([open(420, 1320), booking(1260, 1320)]), 'free');              // and one that starts as it ends
  assert.equal(state([open(420, 1320), booking(1200, 1260)]), 'booked');            // the second hour gone
  assert.equal(state([open(420, 1140), booking(1140, 1260), open(1260, 1320)]), 'booked');
  assert.equal(state([open(420, 1320), booking(1140, 1200, 2000)]), 'coaching');
  assert.equal(state([booking(0, 1440, 8000)]), 'closed');
  assert.equal(state([open(420, 1320), booking(1100, 1150, 4000)]), 'taken');       // a kind of session not known here
  assert.equal(state([open(420, 1200)]), 'not bookable');                           // the venue shuts at 20:00
  assert.equal(state([open(420, 1180), open(1200, 1320)]), 'not bookable');         // a gap in the middle
  assert.equal(state([open(420, 1320, { Restrictions: 'Members' })]), 'restricted');
  assert.equal(state([open(420, 1200), open(1200, 1320, { Restrictions: 'Members' })]), 'restricted');
  assert.equal(state([open('420', '1320')]), 'free');                               // numbers sent as text
  assert.equal(state([]), 'unknown');
  assert.equal(A.slotState(court(1, [open(420, 1320)], '2026-11-27'), DATE, ...SLOT), 'unknown');   // another day only
  assert.equal(A.slotState({ ID: 'x' }, DATE, ...SLOT), 'unknown');
  assert.equal(A.slotState(court(1, [null, 5, open(420, 1320)]), DATE, ...SLOT), 'free');   // junk in the list is skipped
});

test('courts are recognised by ID, or by name if the ID is not one of the six', () => {
  assert.equal(A.courtOf({ ID: L.COURTS[4].toUpperCase() }), 4);
  assert.equal(A.courtOf({ ID: 'something-else', Name: 'Court 6' }), 6);
  assert.equal(A.courtOf({ ID: 'something-else', Name: 'Court 9' }), 0);
  assert.equal(A.courtOf({ Name: 'Mini court' }), 0);
  assert.equal(A.courtOf(null), 0);
});

test('the whole sheet: every court, and whether the day showed at all', () => {
  const read = A.readSheet(sheet([
    court(1, [open(420, 1320)]),
    court(2, [open(420, 1320), booking(1140, 1260)]),
    court(3, [open(420, 1320), booking(1200, 1260, 2000)]),
    court(4, [open(420, 1320)]),
    court(5, [booking(0, 1440, 8000)]),
    { ID: 'padel-1', Name: 'Padel', Days: [{ Date: DATE, Sessions: [open(420, 1320)] }] },   // not a tennis court here: ignored
  ]), DATE, ...SLOT);
  assert.deepEqual(read, { courts: { 1: 'free', 2: 'booked', 3: 'coaching', 4: 'free', 5: 'closed', 6: 'unknown' }, visible: true });
  assert.equal(A.readSheet(sheet([]), DATE, ...SLOT).visible, false);
  assert.equal(A.readSheet(sheet([court(1, [])]), DATE, ...SLOT).visible, false);
});

test('how the courts are offered, from what the sheet showed', () => {
  const order = [4, 3, 5, 2, 6, 1];
  const answer = courts => ({ ok: true, visible: true, courts });
  const all = { 1: 'free', 2: 'free', 3: 'free', 4: 'free', 5: 'free', 6: 'free' };
  assert.deepEqual(A.courtView(order, answer(all)), { mode: 'pick', best: 4, others: [3, 5, 2, 6, 1] });
  assert.deepEqual(A.courtView(order, answer({ ...all, 4: 'booked', 5: 'coaching' })), { mode: 'pick', best: 3, others: [2, 6, 1] });
  assert.deepEqual(A.courtView(order, answer({ 1: 'booked', 2: 'booked', 3: 'free', 4: 'booked', 5: 'booked', 6: 'booked' })), { mode: 'pick', best: 3, others: [] });
  const none = answer({ 1: 'booked', 2: 'booked', 3: 'booked', 4: 'booked', 5: 'booked', 6: 'booked' });
  assert.deepEqual(A.courtView(order, none), { mode: 'none' });
  assert.equal(A.courtView(order, none, { released: false }), null);                  // before the release: probably not open yet
  assert.equal(A.courtView(order, { ok: true, visible: false, courts: {} }), null);
  assert.equal(A.courtView(order, null), null);                                      // not read yet
  assert.equal(A.courtView(order, { ok: false, why: 'x' }), null);                   // one failed read is not worth a word
  assert.deepEqual(A.courtView(order, { ok: false, why: 'x' }, { failed: true }), { mode: 'failed' });
  assert.deepEqual(A.courtView(order, answer(all), { failed: true }).mode, 'pick');  // a good read wins
});

// ---------- asking ClubSpark, with a stand-in for the network ----------

function fakeFetch(reply) {
  const f = async (url, init) => { f.calls.push({ url, init }); return reply(url, init); };
  f.calls = [];
  return f;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const page = (html, status, server = 'cloudflare') => new Response(html, { status, headers: { 'content-type': 'text/html', server } });
const clockFrom = start => { let t = start; return () => (t += 150); };

test('the checker asks for the public sheet data for one day, and nothing about the owner', async () => {
  const f = fakeFetch(() => json(sheet([court(4, [open(420, 1320)])])));
  const check = A.createCourtChecker({ fetchImpl: f, now: clockFrom(1000) });
  const answer = await check(DATE, ...SLOT);
  assert.equal(f.calls.length, 1);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://clubspark.lta.org.uk/v0/VenueBooking/KelvingroveParkTennisCourts/GetVenueSessions');
  assert.deepEqual([u.searchParams.get('startDate'), u.searchParams.get('endDate'), u.searchParams.get('resourceID'), u.searchParams.get('roleId')], [DATE, DATE, '', '']);
  assert.match(u.searchParams.get('_'), /^\d+$/);
  const h = f.calls[0].init.headers;
  assert.equal(h['user-agent'], A.USER_AGENT);
  assert.equal(h.referer, L.SHEET);
  assert.deepEqual(Object.keys(h).sort(), ['accept', 'referer', 'user-agent', 'x-requested-with']);   // no cookies, no sign-in
  assert.equal(f.calls[0].init.method, undefined);                                     // a plain GET
  assert.ok(f.calls[0].init.signal);                                                   // with a time limit
  assert.deepEqual(answer, { ok: true, courts: { 1: 'unknown', 2: 'unknown', 3: 'unknown', 4: 'free', 5: 'unknown', 6: 'unknown' }, visible: true, ms: 150 });
});

test('the checker says plainly when ClubSpark will not answer, and whether to try again', async () => {
  const cases = [
    [() => page('<title>Attention Required! | Cloudflare</title> Sorry, you have been blocked', 403), false, true, /turned this server away \(HTTP 403, Cloudflare\)/],
    [() => page('Forbidden', 403, 'nginx'), false, true, /turned this server away \(HTTP 403\)$/],
    [() => page('slow down', 429), false, true, /slow down \(HTTP 429\)/],
    [() => page('<html>Just a moment...</html>', 200), false, true, /a web page instead of the sheet \(a Cloudflare check\)/],
    [() => json({ Message: 'odd' }), false, true, /shape this bot does not know/],
    [() => json(null), false, true, /shape this bot does not know/],
    [() => page('Not found', 404, 'Microsoft-IIS'), false, true, /HTTP 404/],
    [() => page('oops', 502), false, false, /had a problem \(HTTP 502\)/],
    [() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, false, false, /did not answer within 4 s/],
    [() => { throw new TypeError('fetch failed'); }, false, false, /could not reach ClubSpark \(fetch failed\)/],
  ];
  for (const [reply, ok, stop, why] of cases) {
    const answer = await A.createCourtChecker({ fetchImpl: fakeFetch(reply) })(DATE, ...SLOT);
    assert.equal(answer.ok, ok, String(why));
    assert.equal(answer.stop, stop, String(why));
    assert.match(answer.why, why);
  }
});
