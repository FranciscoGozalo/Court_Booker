'use strict';
// Your PC wakes only on the nights with a booking (2.15): the runs it is to wake for (wakesFor),
// handed to a booker that sets its own wake-ups with every answer to its ping, and the wake-up sent
// from here before a run it has not heard of.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/schedule');
const P = require('../lib/plan');
const { createApp } = require('../app');
const { createServer } = require('../lib/server');
const { at, fakeTelegram, memStore, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const HOME = { ip: '2.96.64.17' };
const WAKE = { WAKE_MAC: '44:AF:28:7A:1A:5C', WAKE_PORT: '40009' };
const CFG = { releaseMin: 22 * 60, daysAhead: 7, order: [1, 2, 3, 4, 5, 6] };
const KELVINGROVE_WED = { id: 'aaaaaaa1', venue: 'kelvingrove', day: 'wed', start: 1080, hours: 2, on: true };    // opens Wed 22:00, a week ahead
const GORBALS_WED = { id: 'aaaaaaa3', venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, on: true }; // opens at the midnight after Tuesday
const cfgOf = (weekly, extra = {}) => { const w = P.cleanWeekly(weekly); return { ...CFG, plan: P.planOf(w), weekly: w, once: [], away: [], ...extra }; };
const runs = list => list.map(w => [w.run, new Date(w.at).toISOString().slice(0, 16)]);

test('the runs to wake for: each night with a booking, eight nights ahead, the parks at 21:55 and Glasgow Club at the PC\'s own run', () => {
  const cfg = cfgOf([KELVINGROVE_WED, GORBALS_WED, { id: 'aaaaaaa5', venue: 'maryhill', day: 'fri', start: 1200, hours: 1, on: false }]);
  const now = at(`${TUE}T12:00:00Z`);
  assert.deepEqual(runs(S.wakesFor(now, cfg, { clubRun: 1430 })), [
    ['club', '2026-11-17T23:50'],                       // Gorbals, Wed 25 Nov, opens at the midnight after tonight
    ['parks', '2026-11-18T21:55'],                      // Kelvingrove, Wed 25 Nov, opens Wed 22:00
    ['club', '2026-11-24T23:50'],                       // Gorbals, Wed 2 Dec (Kelvingrove's is past the eight nights)
  ]);
  const [first] = S.wakesFor(now, cfg, { clubRun: 1430 });
  assert.equal(first.rel.club, true);
  assert.equal(first.rel.releaseAt, at('2026-11-18T00:00:00Z'));
  // A booker before 2.12 books Glasgow Club from its 21:55 run.
  assert.deepEqual(runs(S.wakesFor(now, cfg)), [['parks', '2026-11-17T21:55'], ['parks', '2026-11-18T21:55'], ['parks', '2026-11-24T21:55']]);
  // Nothing to book: no night.
  assert.deepEqual(S.wakesFor(now, cfgOf([])), []);
  // Tonight's run, once started, is gone from the list; the next is there.
  assert.deepEqual(runs(S.wakesFor(at('2026-11-18T21:55:00Z'), cfg, { clubRun: 1430 })), [['club', '2026-11-24T23:50'], ['parks', '2026-11-25T21:55']]);
});

test('a one-off date already open is booked by the PC\'s next run before it starts, as when it woke every night', () => {
  const once = { venue: 'queenspark', type: 'outdoor', date: '2026-11-20', start: 600, hours: 1 };   // Fri 20 Nov 10:00, open since Fri 13
  const cfg = cfgOf([], { away: [once] });
  const now = at(`${TUE}T12:00:00Z`);
  const [w] = S.wakesFor(now, cfg, { clubRun: 1430 });
  assert.deepEqual(runs([w]), [['parks', '2026-11-17T21:55']]);
  assert.equal(w.rel, null);
  // After tonight's parks run, Glasgow Club's run at 23:50 is the next.
  assert.deepEqual(runs(S.wakesFor(at(`${TUE}T22:30:00Z`), cfg, { clubRun: 1430 })), [['club', '2026-11-17T23:50']]);
  // Booked: nothing.
  const results = { 'queenspark/2026-11-20@10:00': { id: 'queenspark/2026-11-20@10:00', status: 'booked', date: '2026-11-20', start: 600, venue: 'queenspark' } };
  assert.deepEqual(S.wakesFor(now, cfg, { clubRun: 1430, results }), []);
  // One that starts before any run could book it: nothing.
  assert.deepEqual(S.wakesFor(now, cfgOf([], { away: [{ ...once, date: TUE, start: 1200 }] }), { clubRun: 1430 }), []);
});

function makeApp(t0, { state = {}, env = {} } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const woke = [], logs = [];
  const app = createApp({
    now: () => clock.t, tg, pictures: PICTURES, linked: true, env, log: l => logs.push(l),
    store: memStore({ v: 4, owner: OWNER, weekly: [KELVINGROVE_WED], order: [3, 4, 5, 2, 1, 6], ...state }),
    wake: async to => { woke.push(clock.t); return 3; },
  });
  return { app, tg, clock, woke, logs };
}
const go = async (app, clock, when) => { clock.t = at(when); await app.tick(); };
const asleep = { env: WAKE, state: { lastSeen: at(`${TUE}T18:00:00Z`), home: { ip: HOME.ip, at: at(`${TUE}T18:00:00Z`) } } };

test('a booker that sets its own wake-ups is answered with the nights; one that does not, as before', async () => {
  const { app, logs } = makeApp(`${TUE}T12:00:00Z`);
  assert.deepEqual(await app.pingFromAgent(HOME), { ok: true });                    // a booker before 2.14
  assert.equal(app.state.pcWakes, null);
  const wed = at('2026-11-18T21:55:00Z');
  assert.deepEqual(await app.pingFromAgent(HOME, { wakes: null }), { ok: true, wakes: [{ run: 'parks', at: wed }] });
  assert.equal(app.state.pcWakes, null);                                            // its tasks wake it every night, for now
  await app.pingFromAgent(HOME, { wakes: [{ run: 'parks', at: wed }, { run: 'tennis', at: wed }, 'x'] });
  assert.deepEqual(app.state.pcWakes, [{ run: 'parks', at: wed }]);
  assert.ok(logs.includes('Your PC wakes to book: Wed 18 Nov 21:55.'));
  await app.pingFromAgent(HOME, { wakes: [{ run: 'parks', at: wed }] });
  assert.equal(logs.filter(l => /^Your PC wakes to book/.test(l)).length, 1);        // said when it changes
  app.state.paused = true;
  assert.deepEqual(await app.pingFromAgent(HOME, { wakes: [] }), { ok: true, wakes: [] });
  assert.ok(logs.includes('Your PC wakes to book: no night (nothing to book).'));
});

test('the server passes wakesSet on: a list, null for anything else, and nothing from a booker that does not say it', async () => {
  const got = [];
  const server = createServer({ token: 'a-long-random-line-for-testing-only', getJobs: () => ({}), onResult: async () => ({ ok: true }),
    onPing: async (from, opts) => { got.push(opts.wakes); return {}; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Bearer a-long-random-line-for-testing-only' };
  try {
    for (const body of [{}, { wakesSet: null }, { wakesSet: [{ run: 'club', at: 1 }] }, { wakesSet: 'every night' }]) {
      await fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    }
    assert.deepEqual(got, [undefined, null, [{ run: 'club', at: 1 }], null]);
  } finally { await new Promise(r => server.close(r)); }
});

test('a run the PC has not heard of: woken twenty minutes before it, and again while it has not heard', async () => {
  const { app, tg, clock, woke, logs } = makeApp(`${TUE}T12:00:00Z`, asleep);
  await app.pingFromAgent(HOME, { wakes: [] });                                     // it was told of no night...
  app.state.lastSeen = at(`${TUE}T18:00:00Z`);                                      // ...and has slept since; Wednesday was added meanwhile
  await go(app, clock, '2026-11-18T21:34:59Z');
  assert.deepEqual(woke, []);
  await go(app, clock, '2026-11-18T21:35:00Z');
  assert.deepEqual(woke, [at('2026-11-18T21:35:00Z')]);
  assert.ok(logs.includes('Your PC has not heard of its run at 21:55 on Wed 18 Nov, so I sent it a wake-up.'));
  await go(app, clock, '2026-11-18T21:39:59Z');
  assert.equal(woke.length, 1);
  await go(app, clock, '2026-11-18T21:40:00Z');                                    // the wake-up before every booking, as ever
  await go(app, clock, '2026-11-18T21:44:59Z');
  assert.equal(woke.length, 2);
  await go(app, clock, '2026-11-18T21:45:00Z');
  assert.equal(woke.length, 3);
  // You are told it is not answering, and that its own timer will not wake it for this one.
  assert.equal(tg.last().text, [
    '<b>Your PC is not answering</b>',
    'I sent it a wake-up at 21:40, ahead of tonight\'s booking, and it has not replied.',
    'Booking opens at 22:00 for Wed 25 Nov · 18:00–20:00.',
    'If it restarted, it is waiting for you to sign in to Windows. If it is off, switch it on.',
    'It has not heard of this booking, so its own timer will not wake it: wake it before 21:55. I will tell you at 21:58 if the run has not started.',
  ].join('\n'));
  await go(app, clock, '2026-11-18T21:50:00Z');
  await go(app, clock, '2026-11-18T21:54:00Z');
  assert.equal(woke.length, 4);                                                     // three of its own, and no more
  assert.equal(tg.calls.length, 1);                                                 // told once
});

test('a PC that hears of the run once woken is left to it', async () => {
  const { app, tg, clock, woke } = makeApp(`${TUE}T12:00:00Z`, asleep);
  await app.pingFromAgent(HOME, { wakes: [] });
  app.state.lastSeen = at(`${TUE}T18:00:00Z`);
  await go(app, clock, '2026-11-18T21:35:00Z');
  assert.equal(woke.length, 1);
  clock.t = at('2026-11-18T21:35:40Z');
  const answer = await app.pingFromAgent(HOME, { wakes: [] });                      // awake: it hears of the night...
  assert.deepEqual(answer.wakes, [{ run: 'parks', at: at('2026-11-18T21:55:00Z') }, { run: 'parks', at: at('2026-11-25T21:55:00Z') }]);
  clock.t = at('2026-11-18T21:36:30Z');
  await app.pingFromAgent(HOME, { wakes: answer.wakes });                           // ...sets it, and says so
  for (let m = 37; m <= 54; m++) {                                                  // kept awake for its run, the link pinging away
    clock.t = at(`2026-11-18T21:${m}:00Z`);
    await app.pingFromAgent(HOME, { wakes: answer.wakes });
    await app.tick();
  }
  assert.equal(woke.length, 1);
  assert.equal(tg.calls.length, 0);
});

test('a PC told of the run, or one that wakes every night, is woken only as before', async () => {
  for (const wakes of [[{ run: 'parks', at: at('2026-11-18T21:55:00Z') }], undefined, null]) {
    const { app, clock, woke } = makeApp(`${TUE}T12:00:00Z`, asleep);
    await app.pingFromAgent(HOME, { wakes });
    app.state.lastSeen = at(`${TUE}T18:00:00Z`);
    await go(app, clock, '2026-11-18T21:35:00Z');
    await go(app, clock, '2026-11-18T21:39:00Z');
    assert.deepEqual(woke, [], String(wakes));
    await go(app, clock, '2026-11-18T21:40:00Z');                                  // twenty minutes before the release
    assert.deepEqual(woke, [at('2026-11-18T21:40:00Z')], String(wakes));
    if (wakes) {
      await go(app, clock, '2026-11-18T21:43:00Z');
      assert.doesNotMatch(app.state.notes.map(n => n.body).join('\n'), /has not heard of this booking/);
    }
  }
});

test('Glasgow Club\'s run at 23:50 that the PC has not heard of: woken at 23:30, not at 23:53', async () => {
  const state = { ...asleep.state, weekly: [GORBALS_WED], pcClubRun: 1430 };
  const told = makeApp(`${TUE}T12:00:00Z`, { env: WAKE, state });
  await told.app.pingFromAgent(HOME, { wakes: [{ run: 'club', at: at(`${TUE}T23:50:00Z`) }] });
  told.app.state.lastSeen = at(`${TUE}T18:00:00Z`);
  for (const m of ['23:30', '23:40', '23:52']) await go(told.app, told.clock, `${TUE}T${m}:00Z`);
  assert.deepEqual(told.woke, []);                                                 // its own task wakes it at 23:50
  const untold = makeApp(`${TUE}T12:00:00Z`, { env: WAKE, state });
  await untold.app.pingFromAgent(HOME, { wakes: [] });
  untold.app.state.lastSeen = at(`${TUE}T18:00:00Z`);
  await go(untold.app, untold.clock, `${TUE}T23:29:59Z`);
  assert.deepEqual(untold.woke, []);
  await go(untold.app, untold.clock, `${TUE}T23:30:00Z`);
  assert.deepEqual(untold.woke, [at(`${TUE}T23:30:00Z`)]);
});

test('without a way to wake the PC, nothing is sent and the warnings are as before', async () => {
  const { app, clock, woke } = makeApp(`${TUE}T12:00:00Z`, { state: asleep.state });
  await app.pingFromAgent(HOME, { wakes: [] });
  app.state.lastSeen = at(`${TUE}T18:00:00Z`);
  for (const m of ['21:35', '21:40', '21:45']) await go(app, clock, `2026-11-18T${m}:00Z`);
  assert.deepEqual(woke, []);
});

test('the PC\'s line says its real next wake-up, or that it has nothing to book', () => {
  const UI = require('../lib/ui');
  const base = { linked: true, pc: 'asleep', cfg: { releaseMin: 22 * 60 }, now: at(`${TUE}T12:00:00Z`) };
  assert.equal(UI.pcLine({ ...base, pcWakes: null }), 'Asleep · wakes at 21:55');                       // every night, as before
  assert.equal(UI.pcLine({ ...base, pcWakes: [] }), 'Asleep · nothing to book');
  assert.equal(UI.pcLine({ ...base, pcWakes: [{ run: 'club', at: at(`${TUE}T23:50:00Z`) }] }), 'Asleep · wakes at 23:50');
  assert.equal(UI.pcLine({ ...base, pcWakes: [{ run: 'parks', at: at('2026-11-18T21:55:00Z') }] }), 'Asleep · wakes tomorrow at 21:55');
  assert.equal(UI.pcLine({ ...base, pcWakes: [{ run: 'parks', at: at(`${TUE}T09:55:00Z`) }, { run: 'parks', at: at('2026-11-20T21:55:00Z') }] }), 'Asleep · wakes Fri 20 Nov at 21:55');
  assert.equal(UI.pcLine({ ...base, pc: 'awake', pcWakes: [] }), 'Awake');
});
