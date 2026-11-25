'use strict';
// Today's court on the iPhone's Lock Screen (2.14): which court, and its words, exactly as the app works
// them out (lib/activity.js); and the bot starting it by a push with the app closed, and ending it once
// the court shown is another (app.js, with a stand-in for Apple's push service).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createQuietTelegram } = require('../lib/telegram');
const AC = require('../lib/activity');
const V = require('../lib/venues');
const G = require('../lib/glasgowclub');
const { at, memStore, PICTURES } = require('./helpers');

const OWNER = 42;
const NOON = '2026-11-17T12:00:00Z';         // a Tuesday; UK on GMT
const settle = () => new Promise(r => setTimeout(r, 5));
const START_A = 'ab'.repeat(40), START_B = 'cd'.repeat(40);           // push-to-start tokens, as iOS gives them (hex)
const UPDATE = 'ef'.repeat(40), UPDATE_2 = '0f'.repeat(40);           // tokens of activities the app runs
const ACTIVITY_ID = 'F3A1C2D4-1111-2222-3333-444455556666';

// ---------- which court, and its words (lib/activity.js) ----------

// A result as the app is shown it (state.results), at Kelvingrove unless it says otherwise.
const shown = over => ({ id: '2026-11-24@16:00', venue: 'kelvingrove', status: 'booked', date: '2026-11-24', start: 960, end: 1080, court: '3', gate: '2433', why: null, at: 1, past: false, type: 'outdoor', price: null, paid: null, courts: null, ...over });
const appState = results => ({ venue: { name: 'Kelvingrove Park' }, venues: V.venueList(G.SHEETS, '2026-11-24', G.sheetUrl), results });
const TUE_9AM = at('2026-11-24T09:00:00Z');

// What a push is sent with: kept by Apple until a moment (a start: until its court is over; an end: an hour on), for a
// phone out of signal when it goes.
const until = (at, plus = 0) => ({ pushType: 'liveactivity', priority: 10, expiresAt: Date.parse(at) / 1000 + plus });

test('the court on the Lock Screen, in the app\'s own words: a park with a gate code, one without, Glasgow Club paid for one court and for two', () => {
  const card = r => AC.courtActivity(appState([r]), Date.parse(`${r.date}T00:00:00Z`) + r.start * 60000 - 3600000);
  // A park, with its gate code.
  assert.deepEqual(card(shown()), {
    key: '2026-11-24@16:00', startsAt: at('2026-11-24T16:00:00Z'), endsAt: at('2026-11-24T18:00:00Z'), url: 'courtbooker:///ticket?id=2026-11-24%4016%3A00',
    props: { place: 'Kelvingrove', day: 'Tue 24 Nov', time: '16:00–18:00', start: '16:00', court: 'Court 3', pillLabel: 'GATE', pillValue: '2433', startsAt: at('2026-11-24T16:00:00Z'), endsAt: at('2026-11-24T18:00:00Z') },
  });
  // A park whose gate code was not shown: no pill. The place by its full name where the app has no short one.
  assert.deepEqual(card(shown({ id: 'queenspark/2026-11-24@18:00', venue: 'queenspark', start: 1080, end: 1140, court: '2', gate: null })).props,
    { place: 'Queens Park', day: 'Tue 24 Nov', time: '18:00–19:00', start: '18:00', court: 'Court 2', pillLabel: '', pillValue: '', startsAt: at('2026-11-24T18:00:00Z'), endsAt: at('2026-11-24T19:00:00Z') });
  // Glasgow Club, paid: what was paid is the pill. One court...
  const gorbals = shown({ id: 'gorbals/2026-11-24@19:00', venue: 'gorbals', type: 'indoor', start: 1140, end: 1200, court: '3', courts: [3], gate: null, price: '£23.00', paid: true });
  assert.deepEqual(card(gorbals).props,
    { place: 'Gorbals', day: 'Tue 24 Nov', time: '19:00–20:00', start: '19:00', court: 'Court 3', pillLabel: 'PAID', pillValue: '£23.00', startsAt: at('2026-11-24T19:00:00Z'), endsAt: at('2026-11-24T20:00:00Z') });
  assert.equal(card(gorbals).url, 'courtbooker:///ticket?id=gorbals%2F2026-11-24%4019%3A00');
  // ...and two at once, the price their total.
  assert.deepEqual(card(shown({ id: 'scotstoun/2026-11-24@20:00', venue: 'scotstoun', type: 'outdoor', start: 1200, end: 1260, court: '3 & 4', courts: [3, 4], gate: null, price: '£46.00', paid: true })).props,
    { place: 'Scotstoun', day: 'Tue 24 Nov', time: '20:00–21:00', start: '20:00', court: 'Courts 3 & 4', pillLabel: 'PAID', pillValue: '£46.00', startsAt: at('2026-11-24T20:00:00Z'), endsAt: at('2026-11-24T21:00:00Z') });
  // Not paid (or not known to be): no pill. A court named in words, and a court in summer time, as the app says them.
  assert.deepEqual(card(shown({ id: 'gorbals/2026-11-24@19:00', venue: 'gorbals', start: 1140, end: 1200, gate: null, price: '£23.00', paid: 'maybe', courts: [3] })).props.pillValue, '');
  assert.equal(card(shown({ court: 'Court 5', gate: null })).props.court, 'Court Court 5');
  const june = card(shown({ id: 'victoriapark/2027-06-01@18:00', venue: 'victoriapark', date: '2027-06-01', start: 1080, end: 1200 }));
  assert.deepEqual([june.props.place, june.props.day, june.startsAt], ['Victoria Park', 'Tue 1 Jun', at('2027-06-01T17:00:00Z')]);
});

test('which court: the first booked court not over yet, once it starts within eight hours; then the next', () => {
  const s = appState([
    shown({ id: 'gorbals/2026-11-24@19:00', venue: 'gorbals', start: 1140, end: 1200, court: '3', courts: [3], gate: null, price: '£23.00', paid: true }),
    shown(),
    shown({ id: 'maryhill/2026-11-24@10:00', venue: 'maryhill', start: 600, end: 660, status: 'none', court: null, gate: null }),   // not booked: never shown
    shown({ id: '2026-11-23@16:00', date: '2026-11-23', past: true }),                                                         // played
  ]);
  // The eight-hour edge: not a moment before.
  assert.equal(AC.courtActivity(s, at('2026-11-24T08:00:00Z') - 1), null);
  assert.equal(AC.courtActivity(s, at('2026-11-24T08:00:00Z')).key, '2026-11-24@16:00');
  assert.equal(AC.courtActivity(s, TUE_9AM).key, '2026-11-24@16:00');
  assert.equal(AC.courtActivity(s, at('2026-11-24T17:59:59Z')).key, '2026-11-24@16:00', 'still on while it is played');
  assert.equal(AC.courtActivity(s, at('2026-11-24T18:00:00Z')).key, 'gorbals/2026-11-24@19:00', 'then the evening\'s court');
  assert.equal(AC.courtActivity(s, at('2026-11-24T20:00:00Z')), null, 'none after the last');
  assert.deepEqual(AC.courtsAhead(s, TUE_9AM).map(r => r.id), ['2026-11-24@16:00', 'gorbals/2026-11-24@19:00']);
});

test('what Apple is sent: a push-to-start, with its notification, and an end', () => {
  const a = AC.courtActivity(appState([shown()]), TUE_9AM);
  assert.deepEqual(AC.startPayload(a, TUE_9AM + 400), { aps: {
    timestamp: TUE_9AM / 1000, event: 'start',
    'content-state': { name: 'CourtActivity', props: JSON.stringify(a.props) },
    'attributes-type': 'LiveActivityAttributes', attributes: { url: 'courtbooker:///ticket?id=2026-11-24%4016%3A00' },
    'stale-date': at('2026-11-24T18:00:00Z') / 1000,
    alert: { title: 'Court 3 today', body: 'Kelvingrove · 16:00–18:00' },
  } });
  // The props go as one string of JSON, in the app's order, as its own start() sends them.
  assert.equal(AC.startPayload(a, TUE_9AM)['aps']['content-state'].props,
    `{"place":"Kelvingrove","day":"Tue 24 Nov","time":"16:00–18:00","start":"16:00","court":"Court 3","pillLabel":"GATE","pillValue":"2433","startsAt":${at('2026-11-24T16:00:00Z')},"endsAt":${at('2026-11-24T18:00:00Z')}}`);
  // A court early in the morning, put on the Lock Screen before midnight, is tomorrow's.
  const early = AC.courtActivity(appState([shown({ id: 'scotstoun/2026-11-25@07:00', venue: 'scotstoun', date: '2026-11-25', start: 420, end: 480, court: '1', courts: [1], gate: null, price: '£23.00', paid: true })]), at('2026-11-24T23:30:00Z'));
  assert.deepEqual(AC.startPayload(early, at('2026-11-24T23:30:00Z')).aps.alert, { title: 'Court 1 tomorrow', body: 'Scotstoun · 07:00–08:00' });
  // An end: dismissed at once, with the words it showed (or none, once they are not known).
  assert.deepEqual(AC.endPayload('{"x":1}', TUE_9AM + 999), { aps: { timestamp: TUE_9AM / 1000, event: 'end', 'dismissal-date': TUE_9AM / 1000, 'content-state': { name: 'CourtActivity', props: '{"x":1}' } } });
  assert.deepEqual(AC.endPayload(null, TUE_9AM).aps['content-state'], { name: 'CourtActivity' });
});

// ---------- the bot starting it by a push (app.js) ----------

// Today's two courts, as the bot keeps them: Kelvingrove at 16:00 and Gorbals at 19:00 (two courts, paid).
const PARK = { id: '2026-11-17@16:00', status: 'booked', date: '2026-11-17', start: 960, end: 1080, court: '3', gate: '2433', at: at('2026-11-10T22:00:10Z') };
const CLUB = { id: 'gorbals/2026-11-17@19:00', status: 'booked', date: '2026-11-17', start: 1140, end: 1200, court: '3 & 4', courts: [3, 4], type: 'indoor', price: '£46.00', paid: true, at: at('2026-11-17T00:01:00Z') };
const PARK_PROPS = JSON.stringify({ place: 'Kelvingrove', day: 'Tue 17 Nov', time: '16:00–18:00', start: '16:00', court: 'Court 3', pillLabel: 'GATE', pillValue: '2433', startsAt: at('2026-11-17T16:00:00Z'), endsAt: at('2026-11-17T18:00:00Z') });
const CLUB_PROPS = JSON.stringify({ place: 'Gorbals', day: 'Tue 17 Nov', time: '19:00–20:00', start: '19:00', court: 'Courts 3 & 4', pillLabel: 'PAID', pillValue: '£46.00', startsAt: at('2026-11-17T19:00:00Z'), endsAt: at('2026-11-17T20:00:00Z') });

// A stand-in for Apple's push service: what it was sent, and what it answers (200 unless told otherwise).
function fakeApns(answer = () => ({ status: 200, reason: null })) {
  const sent = [];
  return { sent, send: async (token, payload, opts) => { sent.push({ token, payload, opts }); return answer(token, payload); } };
}
function makeBot({ store = memStore({ v: 4, owner: OWNER, results: { [PARK.id]: PARK, [CLUB.id]: CLUB } }), apns = fakeApns(), t0 = NOON } = {}) {
  const clock = { t: at(t0) };
  const logs = [];
  const glasgow = { asked: [], day: async () => ({ at: clock.t, slots: [], listed: 0 }), peek: () => null, health: () => null };
  const app = createApp({ now: () => clock.t, tg: createQuietTelegram(), store, pictures: PICTURES, linked: true, glasgow, log: l => logs.push(l),
    push: async () => {}, wake: async () => 3, apns });
  return { app, clock, store, logs, apns };
}
function link(t, name = 'iPhone') {
  const r = t.app.appPair({ code: t.app.pairFromAgent({}).code, name });
  assert.equal(r.status, 200);
  return { token: r.body.token, id: r.body.device.id, device: t.app.appAuth(r.body.token) };
}
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);
// The timer, at an instant: a tick, and the pushes it started given time to go.
async function tickAt(t, iso) { t.clock.t = typeof iso === 'number' ? iso : at(iso); await t.app.tick(); await settle(); }
const startOf = (props, url, endsAt, now, title, body) => ({ aps: { timestamp: at(now) / 1000, event: 'start', 'content-state': { name: 'CourtActivity', props }, 'attributes-type': 'LiveActivityAttributes', attributes: { url }, 'stale-date': at(endsAt) / 1000, alert: { title, body } } });
const endOf = (props, now) => ({ aps: { timestamp: at(now) / 1000, event: 'end', 'dismissal-date': at(now) / 1000, 'content-state': props ? { name: 'CourtActivity', props } : { name: 'CourtActivity' } } });

test('a phone that gave its push-to-start token is sent today\'s court once, within eight hours of it; a restart sends it no more', async () => {
  const t = makeBot({ t0: '2026-11-17T07:59:30Z' });
  const phone = link(t);
  assert.equal((await ask(t, phone, 'activity/token', { kind: 'start', token: START_A })).status, 200);
  assert.deepEqual(t.app.appState(phone.device).state.activity, { push: true, start: true });
  await tickAt(t, '2026-11-17T07:59:30Z');
  assert.deepEqual(t.apns.sent, [], 'more than eight hours before: nothing');
  await tickAt(t, '2026-11-17T08:00:00Z');
  assert.deepEqual(t.apns.sent, [{ token: START_A, opts: until('2026-11-17T18:00:00Z'),
    payload: startOf(PARK_PROPS, 'courtbooker:///ticket?id=2026-11-17%4016%3A00', '2026-11-17T18:00:00Z', '2026-11-17T08:00:00Z', 'Court 3 today', 'Kelvingrove · 16:00–18:00') }]);
  assert.deepEqual(t.store.load().activitySent, { [phone.id]: PARK.id });
  assert.ok(t.logs.includes('Today\'s court is on the Lock Screen of iPhone (a Live Activity, started by a push).'));
  // Once for that court: not again, minutes or hours on.
  for (const when of ['2026-11-17T08:00:31Z', '2026-11-17T09:00:00Z', '2026-11-17T15:59:00Z']) await tickAt(t, when);
  assert.equal(t.apns.sent.length, 1);
  // A second phone gets its own.
  const ipad = link(t, 'iPad');
  await ask(t, ipad, 'activity/token', { kind: 'start', token: START_B });
  await tickAt(t, '2026-11-17T16:00:00Z');
  assert.deepEqual(t.apns.sent.map(s => [s.token, s.payload.aps.event]), [[START_A, 'start'], [START_B, 'start']]);
  // The bot restarted, on the same settings: nothing is sent twice.
  const again = makeBot({ store: t.store, apns: t.apns, t0: '2026-11-17T16:30:00Z' });
  await tickAt(again, '2026-11-17T16:30:00Z');
  assert.equal(t.apns.sent.length, 2);
  // At 18:00 the next court comes up: each phone is sent that one.
  await tickAt(again, '2026-11-17T18:00:10Z');
  assert.deepEqual(t.apns.sent.slice(2).map(s => [s.token, JSON.parse(s.payload.aps['content-state'].props).court, s.payload.aps.alert.title]), [[START_A, 'Courts 3 & 4', 'Courts 3 & 4 today'], [START_B, 'Courts 3 & 4', 'Courts 3 & 4 today']]);
  // No token, or any length of one, is in the log.
  const logged = [...t.logs, ...again.logs].join('\n');
  for (const token of [START_A, START_B]) assert.ok(!logged.includes(token.slice(0, 16)));
});

test('no push for a court the app started itself; when the court shown changes, the card the app runs is ended', async () => {
  const t = makeBot();
  const phone = link(t);
  await ask(t, phone, 'activity/token', { kind: 'start', token: START_A });
  const r = await ask(t, phone, 'activity/token', { kind: 'update', activity: ACTIVITY_ID, court: PARK.id, token: UPDATE });
  assert.equal(r.status, 200);
  assert.deepEqual(t.store.load().apps[0].activityUpdate, { activity: ACTIVITY_ID, court: PARK.id, token: UPDATE });
  await tickAt(t, NOON);
  assert.deepEqual(t.apns.sent, [], 'the app started it: no push-to-start for it');
  // 18:00: Kelvingrove is over and Gorbals is next. The app's card is ended, with the words it showed; the next court is started by a push.
  await tickAt(t, '2026-11-17T18:00:30Z');
  assert.deepEqual(t.apns.sent, [
    { token: UPDATE, opts: until('2026-11-17T18:00:30Z', 3600), payload: endOf(PARK_PROPS, '2026-11-17T18:00:30Z') },
    { token: START_A, opts: until('2026-11-17T20:00:00Z'),
    payload: startOf(CLUB_PROPS, 'courtbooker:///ticket?id=gorbals%2F2026-11-17%4019%3A00', '2026-11-17T20:00:00Z', '2026-11-17T18:00:30Z', 'Courts 3 & 4 today', 'Gorbals · 19:00–20:00') },
  ]);
  assert.equal(t.store.load().apps[0].activityUpdate, null);
  assert.deepEqual(t.store.load().activitySent, { [phone.id]: CLUB.id });
  // The app learns the token of the card the push started, and says so: no second push for it.
  await ask(t, phone, 'activity/token', { kind: 'update', activity: 'B2', court: CLUB.id, token: UPDATE_2 });
  await tickAt(t, '2026-11-17T19:30:00Z');
  assert.equal(t.apns.sent.length, 2);
  // 20:00: Gorbals is over, and there is no court after it: its card is ended, so a stale one leaves the Lock Screen.
  await tickAt(t, '2026-11-17T20:00:30Z');
  assert.deepEqual(t.apns.sent.slice(2), [{ token: UPDATE_2, opts: until('2026-11-17T20:00:30Z', 3600), payload: endOf(CLUB_PROPS, '2026-11-17T20:00:30Z') }]);
  assert.equal(t.app.state.apps[0].activityUpdate, null);
  await tickAt(t, '2026-11-17T21:00:00Z');
  assert.equal(t.apns.sent.length, 3);
  // A card for a court that is not booked (any more) is ended too, without words; one for a court still ahead,
  // only not within eight hours by this clock, is left to the app.
  await ask(t, phone, 'activity/token', { kind: 'update', activity: 'C3', court: 'maryhill/2026-11-17@10:00', token: UPDATE });
  await tickAt(t, '2026-11-17T21:01:00Z');
  assert.deepEqual(t.apns.sent.slice(3), [{ token: UPDATE, opts: until('2026-11-17T21:01:00Z', 3600), payload: endOf(null, '2026-11-17T21:01:00Z') }]);
  t.app.state.results['2026-11-18@19:00'] = { ...PARK, id: '2026-11-18@19:00', date: '2026-11-18', start: 1140, end: 1200 };
  await ask(t, phone, 'activity/token', { kind: 'update', activity: 'D4', court: '2026-11-18@19:00', token: UPDATE_2 });
  await tickAt(t, '2026-11-17T21:02:00Z');
  assert.equal(t.apns.sent.length, 4);
  assert.equal(t.app.state.apps[0].activityUpdate.court, '2026-11-18@19:00');
});

test('Apple no longer takes a token (410, or 400 BadDeviceToken): it is forgotten; Apple refusing the key (403) stops every push until a restart', async () => {
  for (const [answer, words] of [[{ status: 410, reason: 'Unregistered' }, 'Apple answered 410 Unregistered'], [{ status: 400, reason: 'BadDeviceToken' }, 'Apple answered 400 BadDeviceToken']]) {
    const t = makeBot({ apns: fakeApns(() => answer) });
    const phone = link(t);
    await ask(t, phone, 'activity/token', { kind: 'start', token: START_A });
    await tickAt(t, NOON);
    assert.equal(t.apns.sent.length, 1);
    assert.equal(t.store.load().apps[0].activityStart, null);
    assert.deepEqual(t.app.appState(phone.device).state.activity, { push: true, start: false });
    assert.deepEqual(t.store.load().activitySent, {}, 'not started');
    assert.ok(t.logs.includes(`Apple no longer takes the token iPhone gave for starting Live Activities (${words}): none is started there by push until the app gives a new one.`));
    await tickAt(t, '2026-11-17T12:05:00Z');
    assert.equal(t.apns.sent.length, 1);
  }
  // An activity's own token gone: the card is gone with it, and nothing more is sent to it.
  const ended = makeBot({ apns: fakeApns(() => ({ status: 410, reason: 'Unregistered' })) });
  const p = link(ended);
  await ask(ended, p, 'activity/token', { kind: 'update', activity: ACTIVITY_ID, court: PARK.id, token: UPDATE });
  await tickAt(ended, '2026-11-17T18:00:30Z');
  assert.equal(ended.app.state.apps[0].activityUpdate, null);
  // 403: said once, and nothing more is sent, whatever the app gives, until the bot restarts.
  const t = makeBot({ apns: fakeApns(() => ({ status: 403, reason: 'InvalidProviderToken' })) });
  const phone = link(t);
  await ask(t, phone, 'activity/token', { kind: 'start', token: START_A });
  await tickAt(t, NOON);
  await ask(t, phone, 'activity/token', { kind: 'start', token: START_B });
  for (const when of ['2026-11-17T12:01:00Z', '2026-11-17T12:30:00Z', '2026-11-17T18:00:30Z']) await tickAt(t, when);
  assert.deepEqual(t.apns.sent.map(s => s.token), [START_A]);
  assert.deepEqual(t.logs.filter(l => /Apple refused the key/.test(l)), ['Apple refused the key for Live Activities (InvalidProviderToken): check APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID on Railway. None is sent until the bot restarts.']);
  assert.equal(t.store.load().apps[0].activityStart, START_B, 'the token is kept: the key was the trouble');
  const fixed = makeBot({ store: t.store, t0: '2026-11-17T18:01:00Z' });
  await tickAt(fixed, '2026-11-17T18:01:00Z');
  assert.deepEqual(fixed.apns.sent.map(s => [s.token, s.payload.aps.event]), [[START_B, 'start']]);
});

test('any other failure is tried again once a minute, five times in all, then that court is given up on', async () => {
  const t = makeBot({ apns: fakeApns(() => ({ status: 500, reason: 'InternalServerError' })) });
  const phone = link(t);
  await ask(t, phone, 'activity/token', { kind: 'start', token: START_A });
  for (let s = 0; s <= 10 * 60; s += 10) await tickAt(t, at(NOON) + s * 1000);
  assert.deepEqual(t.apns.sent.map(x => x.payload.aps.timestamp - at(NOON) / 1000), [0, 60, 120, 180, 240]);       // seconds after the first
  assert.deepEqual(t.logs.filter(l => /^Gave up/.test(l)), ['Gave up trying to put today\'s court on the Lock Screen of iPhone after 5 tries (Apple answered 500 InternalServerError).']);
  assert.equal(t.store.load().apps[0].activityStart, START_A, 'the token stays, for the next court');
  assert.deepEqual(t.store.load().activitySent, {});
  // Apple could not be reached at all: the same, and the next court is tried afresh.
  const next = makeBot({ apns: fakeApns(() => ({ status: 0, reason: 'Apple did not answer in time' })) });
  const p = link(next);
  await ask(next, p, 'activity/token', { kind: 'start', token: START_A });
  for (let s = 0; s <= 6 * 60; s += 30) await tickAt(next, at(NOON) + s * 1000);
  assert.equal(next.apns.sent.length, 5);
  assert.ok(next.logs.includes('Gave up trying to put today\'s court on the Lock Screen of iPhone after 5 tries (Apple did not answer in time).'));
  await tickAt(next, '2026-11-17T18:00:30Z');
  assert.equal(next.apns.sent.length, 6);
  assert.equal(JSON.parse(next.apns.sent[5].payload.aps['content-state'].props).court, 'Courts 3 & 4');
  // An end that keeps failing is given up on after five tries too, and the card's token forgotten.
  const end = makeBot({ apns: fakeApns(() => ({ status: 503, reason: 'ServiceUnavailable' })) });
  const e = link(end);
  await ask(end, e, 'activity/token', { kind: 'update', activity: ACTIVITY_ID, court: PARK.id, token: UPDATE });
  for (let s = 0; s <= 6 * 60; s += 30) await tickAt(end, at('2026-11-17T18:00:00Z') + s * 1000);
  assert.equal(end.apns.sent.filter(x => x.token === UPDATE).length, 5);
  assert.equal(end.app.state.apps[0].activityUpdate, null);
  assert.ok(end.logs.includes('Gave up trying to end the card for 2026-11-17@16:00 on the Lock Screen of iPhone after 5 tries (Apple answered 503 ServiceUnavailable).'));
});

test('a push never holds up the timer; without APNS_KEY nothing is sent; a phone unlinked is forgotten', async () => {
  // A push that never comes back: the tick does not wait for it, and no second round starts beside it.
  const stuck = makeBot({ apns: { sent: [], send(token) { this.sent.push(token); return new Promise(() => {}); } } });
  const phone = link(stuck);
  await ask(stuck, phone, 'activity/token', { kind: 'start', token: START_A });
  await tickAt(stuck, NOON);
  for (let s = 30; s <= 5 * 60; s += 30) await tickAt(stuck, at(NOON) + s * 1000);
  assert.deepEqual(stuck.apns.sent, [START_A]);
  // No key: the state says so, the tokens are kept for when there is one, and nothing is tried.
  const off = makeBot({ apns: null });
  const o = link(off);
  assert.equal((await ask(off, o, 'activity/token', { kind: 'start', token: START_A })).status, 200);
  await tickAt(off, NOON);
  assert.deepEqual(off.app.appState(o.device).state.activity, { push: false, start: true });
  assert.equal(off.store.load().apps[0].activityStart, START_A);
  // Unlinked: what was sent to it is forgotten at the next look, on disk too.
  const t = makeBot();
  const a = link(t, 'A'), b = link(t, 'B');
  for (const p of [a, b]) await ask(t, p, 'activity/token', { kind: 'start', token: p === a ? START_A : START_B });
  await tickAt(t, NOON);
  assert.deepEqual(Object.keys(t.store.load().activitySent).sort(), [a.id, b.id].sort());
  await ask(t, a, 'unpair/other', { id: b.id });
  await tickAt(t, '2026-11-17T12:01:00Z');
  assert.deepEqual(t.store.load().activitySent, { [a.id]: PARK.id });
});
