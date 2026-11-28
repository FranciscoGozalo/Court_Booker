'use strict';
// The booking itself on the Lock Screen (2.16): the card's words at each stage (lib/bookingActivity.js), and the bot
// starting it an hour before the release, keeping it up to date on its own channel and ending it after the result
// (app.js, with a stand-in for Apple's push service).

const test = require('node:test');
const assert = require('node:assert/strict');
const BA = require('../lib/bookingActivity');
const { createApp } = require('../app');
const { createQuietTelegram } = require('../lib/telegram');
const { at, memStore, PICTURES } = require('./helpers');

const OWNER = 42;
const START = 'ab'.repeat(40);
const settle = () => new Promise(r => setTimeout(r, 5));

// Wed 18 Nov's 22:00 release books Kelvingrove's Wed 25 Nov 18:00–20:00.
const REL = { releaseAt: at('2026-11-18T22:00:00Z'), club: false, requests: [{ id: '2026-11-25@18:00', date: '2026-11-25', start: 1080, end: 1200, kind: 'weekly' }] };
const PC_RUN = at('2026-11-18T21:55:00Z');
const ORDER = [3, 4, 5, 2, 1, 6];
const card = (now, over = {}) => BA.cardFor({ rel: REL, now: at(now), pcRunAt: PC_RUN, order: ORDER, ...over });

test('the card\'s words: waiting, awake, signed in, trying again, booking, booked or not, no word', () => {
  const base = { place: 'Kelvingrove', meta: 'Wed 25 Nov · 18:00–20:00' };
  const count = { from: at('2026-11-18T21:00:00Z'), to: REL.releaseAt, bar: true, pillKey: 'COURTS', pillValue: '3, 4, 5' };
  assert.deepEqual(card('2026-11-18T21:00:00Z'), { stage: 'waiting', final: false, props: { ...base, icon: '', big: '', short: '', ...count, label: 'OPENS AT 22:00', tone: 'blue', note: 'Your PC wakes at 21:55.' } });
  const run = { lastRun: at('2026-11-18T21:55:05Z'), note: { stage: 'started', at: at('2026-11-18T21:55:05Z') } };
  assert.equal(card('2026-11-18T21:56:00Z', { run }).props.note, 'Your PC is awake and signing in to ClubSpark.');
  const ready = card('2026-11-18T21:58:00Z', { run: { ...run, note: { stage: 'ready', at: at('2026-11-18T21:57:00Z') } } });
  assert.deepEqual([ready.stage, ready.props.label, ready.props.tone, ready.props.note], ['ready', 'SIGNED IN · READY', 'green', 'Waiting for 22:00. It tries the courts in your order.']);
  const trouble = card('2026-11-18T21:58:00Z', { run: { ...run, note: { stage: 'trouble', at: at('2026-11-18T21:57:00Z'), why: 'the page did not load' } } });
  assert.deepEqual([trouble.props.label, trouble.props.tone, trouble.props.note], ['TRYING AGAIN', 'amber', 'An attempt didn’t work; your PC is trying again.']);
  // An old note (last night's) is not this run's.
  assert.equal(card('2026-11-18T21:56:00Z', { run: { lastRun: run.lastRun, note: { stage: 'ready', at: at('2026-11-17T21:57:00Z') } } }).stage, 'awake');
  // The PC silent two minutes after its run should have started.
  assert.equal(card('2026-11-18T21:57:30Z').stage, 'asleep');
  // Booking.
  const booking = card('2026-11-18T22:00:00Z', { run });
  assert.deepEqual([booking.stage, booking.props.label, booking.props.big, booking.props.note], ['booking', 'BOOKING', 'Court 3…', 'Court 3 first, then 4, then 5.']);
  assert.equal(card('2026-11-18T22:00:00Z').stage, 'nostart');
  // Booked: the court and the gate; a result from last week is not this release's.
  const results = { '2026-11-25@18:00': { id: '2026-11-25@18:00', status: 'booked', court: '3', gate: '2433', at: at('2026-11-18T22:00:12Z') } };
  const booked = card('2026-11-18T22:00:13Z', { run, results });
  assert.deepEqual([booked.stage, booked.final, booked.props.label, booked.props.icon, booked.props.big, booked.props.pillKey, booked.props.pillValue, booked.props.short],
    ['booked', true, 'BOOKED', 'checkmark', 'Court 3', 'GATE', '2433', '2433']);
  const none = card('2026-11-18T22:00:40Z', { run, results: { '2026-11-25@18:00': { status: 'none', why: 'No court free for the whole time.', at: at('2026-11-18T22:00:39Z') } } });
  assert.deepEqual([none.stage, none.props.label, none.props.tone, none.props.big, none.props.note], ['none', 'NOT BOOKED', 'red', 'No court free', 'No court free for the whole time. Tap to try another time.']);
  assert.equal(card('2026-11-18T22:05:00Z', { run, results: { '2026-11-25@18:00': { status: 'none', at: at('2026-11-11T22:00:39Z') } } }).stage, 'booking');
  // Ten minutes on with no word: said so, and over.
  const silent = card('2026-11-18T22:10:00Z', { run });
  assert.deepEqual([silent.stage, silent.final, silent.props.big], ['silent', true, 'No result']);
});

test('Glasgow Club: two courts, paying, your bank asking for five minutes, paid', () => {
  const rel = { releaseAt: at('2026-11-18T00:00:00Z'), club: true, requests: [{ id: 'gorbals/2026-11-25@18:00', venue: 'gorbals', type: 'indoor', date: '2026-11-25', start: 1080, end: 1140, courts: 2 }] };
  const pcRunAt = at('2026-11-17T23:50:00Z');
  const run = { lastRun: at('2026-11-17T23:50:05Z'), note: { stage: 'ready', at: at('2026-11-17T23:55:00Z') } };
  const c = (now, over) => BA.cardFor({ rel, now: at(now), pcRunAt, late: 30 * 60000, run, ...over });
  const waiting = BA.cardFor({ rel, now: at('2026-11-17T23:00:00Z'), pcRunAt, late: 30 * 60000 });
  assert.deepEqual([waiting.props.place, waiting.props.label, waiting.props.pillValue, waiting.props.note], ['Gorbals', 'OPENS AT 00:00', '2', 'Your PC wakes at 23:50 and pays with the card kept on it.']);
  assert.deepEqual([c('2026-11-18T00:00:20Z').props.label, c('2026-11-18T00:00:20Z').props.big], ['BOOKING AND PAYING', 'Booking…']);
  const bank = { at: at('2026-11-18T00:01:00Z'), price: '£46.00' };
  const approve = c('2026-11-18T00:01:30Z', { bank });
  assert.deepEqual([approve.stage, approve.props.label, approve.props.from, approve.props.to, approve.props.pillValue], ['approve', 'APPROVE IN YOUR BANK’S APP', bank.at, bank.at + 5 * 60000, '£46.00']);
  const paid = c('2026-11-18T00:02:00Z', { bank, results: { 'gorbals/2026-11-25@18:00': { status: 'booked', court: '1 & 2', courts: [1, 2], price: '£46.00', paid: true, at: at('2026-11-18T00:01:50Z') } } });
  assert.deepEqual([paid.stage, paid.props.big, paid.props.pillKey, paid.props.pillValue], ['booked', 'Courts 1 & 2', 'PAID', '£46.00']);
});

test('what Apple is sent: a start listening on the channel, with its notification; an update; an end that leaves later', () => {
  const c = card('2026-11-18T21:00:00Z');
  const start = BA.startPayload(c, 'Y2hhbm5lbA==', at('2026-11-18T21:00:00Z'));
  assert.deepEqual(start.aps, {
    timestamp: at('2026-11-18T21:00:00Z') / 1000, event: 'start', 'content-state': { name: 'BookingActivity', props: JSON.stringify(c.props) },
    'attributes-type': 'LiveActivityAttributes', attributes: { url: 'courtbooker:///' }, 'input-push-channel': 'Y2hhbm5lbA==',
    alert: { title: 'Opens at 22:00', body: 'Kelvingrove · Wed 25 Nov · 18:00–20:00' },
  });
  assert.equal(BA.updatePayload(c, at('2026-11-18T21:30:00Z')).aps.event, 'update');
  const end = BA.updatePayload(c, at('2026-11-18T22:01:00Z'), { end: true, dismissAt: at('2026-11-18T22:16:00Z') });
  assert.deepEqual([end.aps.event, end.aps['dismissal-date']], ['end', at('2026-11-18T22:16:00Z') / 1000]);
  assert.ok(JSON.stringify(start).length < 4096, 'well inside what Apple takes');
});

// ---------- the bot (app.js) ----------
function fakeApns({ channel = 'Y2hhbm5lbA==', refuse = null } = {}) {
  const log = [];
  return {
    log,
    send: async (token, payload, opts) => { log.push({ what: 'send', token, event: payload.aps.event, props: JSON.parse(payload.aps['content-state'].props || 'null'), name: payload.aps['content-state'].name, channel: payload.aps['input-push-channel'], opts }); return { status: 200, reason: null }; },
    createChannel: async () => { log.push({ what: 'create' }); return refuse ? { channel: null, status: refuse, reason: 'Forbidden' } : { channel, status: 201, reason: null }; },
    deleteChannel: async ch => { log.push({ what: 'delete', channel: ch }); return { ok: true, status: 204 }; },
    broadcast: async (ch, payload, opts) => { log.push({ what: 'broadcast', channel: ch, event: payload.aps.event, props: JSON.parse(payload.aps['content-state'].props), dismiss: payload.aps['dismissal-date'], opts }); return { status: 200, reason: null }; },
  };
}
function makeBot({ apns = fakeApns(), t0 = '2026-11-18T20:00:00Z', state = {} } = {}) {
  const clock = { t: at(t0) };
  const logs = [];
  const glasgow = { asked: [], day: async () => ({ at: clock.t, slots: [], listed: 0 }), peek: () => null, health: () => null };
  const store = memStore({ v: 4, owner: OWNER, weekly: [{ id: 'aaaaaaa1', venue: 'kelvingrove', type: 'outdoor', day: 'wed', start: 1080, hours: 2, on: true }], order: ORDER, ...state });
  const app = createApp({ now: () => clock.t, tg: createQuietTelegram(), store, pictures: PICTURES, linked: true, glasgow, log: l => logs.push(l), push: async () => {}, wake: async () => 3, apns });
  return { app, clock, store, logs, apns };
}
async function phone(t) {
  const r = t.app.appPair({ code: t.app.pairFromAgent({}).code, name: 'iPhone' });
  const device = t.app.appAuth(r.body.token);
  assert.equal((await t.app.appAsk(device, 'activity/token', { kind: 'start', token: START })).status, 200);
  return device;
}
async function tickAt(t, iso) { t.clock.t = at(iso); await t.app.tick(); await settle(); await settle(); }
const of = (t, what) => t.apns.log.filter(x => x.what === what);

test('an evening: started an hour before on its own channel, each change sent once, ended after the result, the channel deleted after', async () => {
  const t = makeBot();
  await phone(t);
  await tickAt(t, '2026-11-18T20:59:40Z');
  assert.deepEqual(t.apns.log, [], 'not yet');
  await tickAt(t, '2026-11-18T21:00:00Z');
  assert.deepEqual(t.apns.log.map(x => x.what), ['create', 'send']);
  const start = of(t, 'send')[0];
  assert.deepEqual([start.token, start.event, start.name, start.channel, start.props.stage === undefined, start.props.label, start.opts.expiresAt], [START, 'start', 'BookingActivity', 'Y2hhbm5lbA==', true, 'OPENS AT 22:00', REL.releaseAt / 1000]);
  assert.ok(t.logs.includes('The booking at 22:00 is on the Lock Screen of iPhone (waiting).'));
  // Nothing new: nothing sent, minutes on.
  await tickAt(t, '2026-11-18T21:30:00Z');
  assert.equal(t.apns.log.length, 2);
  // The run starts: awake; signed in: ready.
  t.clock.t = at('2026-11-18T21:55:05Z');
  t.app.jobsForAgent({}, { run: true, venues: true, clubRun: 1430 });
  await tickAt(t, '2026-11-18T21:55:06Z');
  assert.equal(of(t, 'broadcast').at(-1).props.note, 'Your PC is awake and signing in to ClubSpark.');
  t.clock.t = at('2026-11-18T21:57:00Z');
  await t.app.progressFromAgent({ stage: 'ready' });
  await tickAt(t, '2026-11-18T21:57:01Z');
  assert.equal(of(t, 'broadcast').at(-1).props.label, 'SIGNED IN · READY');
  // 22:00: booking.
  await tickAt(t, '2026-11-18T22:00:00Z');
  assert.equal(of(t, 'broadcast').at(-1).props.big, 'Court 3…');
  // The result: the card ends with it, leaving the Lock Screen a quarter of an hour later.
  t.clock.t = at('2026-11-18T22:00:12Z');
  await t.app.resultFromAgent({ id: '2026-11-25@18:00', status: 'booked', court: '3', gate: '2433', date: '2026-11-25', start: 1080, end: 1200 });
  await tickAt(t, '2026-11-18T22:00:13Z');
  const end = of(t, 'broadcast').at(-1);
  assert.deepEqual([end.event, end.props.label, end.props.big, end.props.pillValue, end.dismiss], ['end', 'BOOKED', 'Court 3', '2433', at('2026-11-18T22:15:13Z') / 1000]);
  assert.equal(of(t, 'broadcast').length, 4);
  assert.ok(of(t, 'broadcast').every(x => x.channel === 'Y2hhbm5lbA=='));
  // Nothing more for it; its channel deleted once the card has gone.
  await tickAt(t, '2026-11-18T22:05:00Z');
  assert.equal(of(t, 'broadcast').length, 4);
  await tickAt(t, '2026-11-18T22:20:14Z');
  assert.deepEqual(of(t, 'delete'), [{ what: 'delete', channel: 'Y2hhbm5lbA==' }]);
  assert.equal(t.app.state.bookingCard, null);
});

test('a restart neither starts it twice nor loses the channel', async () => {
  const t = makeBot();
  await phone(t);
  await tickAt(t, '2026-11-18T21:00:00Z');
  const again = makeBot({ apns: t.apns, state: t.store.load() });
  again.store = t.store;
  await tickAt(again, '2026-11-18T21:10:00Z');
  assert.deepEqual(t.apns.log.map(x => x.what), ['create', 'send'], 'nothing new');
});

test('Apple will not make a channel (Broadcast Capability off): nothing started, said once, asked again half an hour on', async () => {
  const t = makeBot({ apns: fakeApns({ refuse: 403 }) });
  await phone(t);
  await tickAt(t, '2026-11-18T21:00:00Z');
  await tickAt(t, '2026-11-18T21:10:00Z');
  assert.deepEqual(t.apns.log.map(x => x.what), ['create']);
  assert.equal(t.logs.filter(l => /was not put on the Lock Screen: Apple would not make a channel for it \(Apple answered 403 Forbidden\)\. Switch on Broadcast Capability/.test(l)).length, 1);
  await tickAt(t, '2026-11-18T21:30:00Z');
  assert.deepEqual(t.apns.log.map(x => x.what), ['create', 'create']);
});

test('no card without a phone\'s token, while paused, or on a night with nothing to book', async () => {
  const none = makeBot();
  await tickAt(none, '2026-11-18T21:00:00Z');
  assert.deepEqual(none.apns.log, []);
  const paused = makeBot({ state: { paused: true } });
  await phone(paused);
  await tickAt(paused, '2026-11-18T21:00:00Z');
  assert.deepEqual(paused.apns.log, []);
  const tuesday = makeBot({ t0: '2026-11-17T20:00:00Z' });
  await phone(tuesday);
  await tickAt(tuesday, '2026-11-17T21:00:00Z');
  assert.deepEqual(tuesday.apns.log, []);
});

test('at start-up the bot asks Apple for one channel and says whether the booking can go on the Lock Screen', async () => {
  const on = makeBot();
  assert.equal(await on.app.checkBroadcast(), true);
  assert.deepEqual(on.apns.log.map(x => x.what), ['create', 'delete']);
  assert.ok(on.logs.includes('The booking on the Lock Screen is on: Apple makes channels for the app.'));
  const off = makeBot({ apns: fakeApns({ refuse: 403 }) });
  assert.equal(await off.app.checkBroadcast(), false);
  assert.ok(off.logs.some(l => /The booking on the Lock Screen is off: Apple would not make a channel \(Apple answered 403 Forbidden\)\. Switch on Broadcast Capability/.test(l)));
  assert.equal(await makeBot({ apns: null }).app.checkBroadcast(), null);
});
