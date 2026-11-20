'use strict';
// Glasgow Life's parks on ClubSpark, from the app (lib/clubspark.js): a day's free courts read by
// your PC, Book now, and everything that keeps the home connection in good standing: the cache,
// the budget of reads, the quiet time around the nightly run, and the two hours after a
// "Just a moment" check. Your PC, Telegram, the push service and the clock are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createServer } = require('../lib/server');
const CS = require('../lib/clubspark');
const V = require('../lib/venues');
const G = require('../lib/glasgowclub');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const FRI = '2026-11-20';
const NOON = `${TUE}T12:00:00Z`;
const HOME = { ip: '81.2.69.142' };
const AGENT = 'a-long-random-line-for-testing-only';
const PUSH_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const MIN = 60 * 1000;
const settle = () => new Promise(r => setTimeout(r, 5));

// The bot with stand-ins. The PC answers a look within `lookWaitMs` (shortened here).
function makeBot(t0 = NOON, { state = {}, linked = true, lookWaitMs = 2000 } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const logs = [], pushes = [];
  const store = memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], ...state });
  const glasgow = { day: async () => { throw G.problem('odd', 'not in these tests'); }, peek: () => null, health: () => null };
  const app = createApp({
    now: () => clock.t, tg, store, pictures: PICTURES, linked, glasgow, log: l => logs.push(l), clubspark: { lookWaitMs },
    push: async (tokens, message) => { pushes.push({ tokens, ...message }); }, wake: async () => 3,
  });
  return { app, tg, clock, store, logs, pushes };
}
async function linkPhone(t, name = 'iPhone') {
  await t.app.handleUpdate(say(OWNER, '/app'));
  const code = /Code: <code>(\d{6})<\/code>/.exec(t.tg.last().text)[1];
  const r = t.app.appPair({ code, name });
  assert.equal(r.status, 200);
  await settle();
  const phone = { token: r.body.token, id: r.body.device.id, device: t.app.appAuth(r.body.token) };
  await t.app.appAsk(phone.device, 'push', { token: PUSH_TOKEN });
  return phone;
}
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);
const refused = (status, why) => ({ status, body: { ok: false, why } });
const stateOf = (t, phone) => t.app.appState(phone.device).state;
const pcSays = (t, kind, raw) => t.app.clubSparkFromAgent(kind, raw);

// A park's day as your PC sends it (tools/clubspark-now.js there): court 1 free at 18:00 and
// 19:00, court 2 at 18:00, court 3 booked all evening; each interval is an hour.
const COURTS = [['id-1', 'Court 1'], ['id-2', 'Court 2'], ['id-3', 'Court 3']];
const sheetOf = (date, free = [[1, 1080], [1, 1140], [2, 1080]]) => ({
  courts: COURTS, free: free.map(([n, start]) => [`booking-id-${n}|${date}|${start}`, start + 60]), intervals: 36, sessions: 12,
});
const SLOTS = [
  { start: 1080, end: 1140, courts: [{ n: 1, name: 'Court 1' }, { n: 2, name: 'Court 2' }] },
  { start: 1140, end: 1200, courts: [{ n: 1, name: 'Court 1' }] },
];
// The app asks for a look; the PC's waiting ping collects it and the PC answers `answer` (or the sheet).
async function lookAnswered(t, phone, body, answer = null) {
  await t.app.pingFromAgent(HOME);
  const ping = t.app.pingFromAgent(HOME, { wait: 5 });
  const looking = ask(t, phone, 'clubspark/look', body);
  const order = await ping;
  assert.ok(order.csLook, JSON.stringify(order));
  assert.deepEqual([order.csLook.venue, order.csLook.date], [body.venue, body.date]);
  assert.match(order.csLook.id, /^[0-9a-f]{12}$/);
  t.clock.t += 3000;
  pcSays(t, 'look', { id: order.csLook.id, ...(answer || { ok: true, sheet: sheetOf(body.date) }) });
  return looking;
}
// The app reads a day: by the PC when that is needed, else from what is known.
async function seeFree(t, phone, venue, date) {
  await t.app.pingFromAgent(HOME);
  const ping = t.app.pingFromAgent(HOME, { wait: 0.1 });
  const looking = ask(t, phone, 'clubspark/look', { venue, date });
  const order = await ping;
  if (order.csLook) { t.clock.t += 3000; pcSays(t, 'look', { id: order.csLook.id, ok: true, sheet: sheetOf(date) }); }
  return looking;
}
// A court the app was shown free, booked now: the look, the request, and the PC's ping collecting it.
async function bookingCollected(t, phone, body = { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 }) {
  assert.equal((await seeFree(t, phone, body.venue, body.date)).status, 200);
  const ping = t.app.pingFromAgent(HOME, { wait: 5 });
  const asked = await ask(t, phone, 'clubspark/book', body);
  const order = await ping;
  return { asked, order, id: order.csBook && order.csBook.id };
}

// ---------- reading what the PC sends ----------

test('a park\'s sheet is read the way the nightly run reads ClubSpark: the free "Book" links, by start time, each court by the number its name ends with', () => {
  const sheet = {
    courts: [['id-1', 'Court 1'], ['id-2', 'Court 2'], ['id-3', 'Court 3'], ['id-x', 'Mini court'], ['id-4a', 'Court 4'], ['id-4b', 'Practice Court 4']],
    free: [
      ['booking-id-2|2026-11-20|1080', 1140], ['booking-id-1|2026-11-20|1080', 1140], ['booking-id-1|2026-11-20|1140', 1200],
      ['booking-id-1|2026-11-21|1080', 1140],                  // another day: left out
      ['booking-id-x|2026-11-20|1080', 1140],                  // a court whose name ends in no number
      ['booking-id-4a|2026-11-20|1080', 1140],                 // two courts end in 4: neither is offered
      ['booking-nobody|2026-11-20|1080', 1140],                // a court the sheet does not list
      ['booking-id-3|2026-11-20|600', null],                   // no end given: an hour
    ],
    intervals: 40, sessions: 10,
  };
  const got = CS.readSheet(sheet, FRI, at(NOON));
  assert.deepEqual(got.slots, [{ start: 600, end: 660, courts: [{ n: 3, name: 'Court 3' }] }, ...SLOTS]);
  assert.equal(got.listed, 40);
  assert.deepEqual([...got.free.entries()].sort(), [['1080:1', 1140], ['1080:2', 1140], ['1140:1', 1200], ['600:3', 660]].sort());
  // Today, what has started is left out.
  assert.deepEqual(CS.readSheet(sheetOf(TUE, [[1, 660], [1, 720], [2, 780]]), TUE, at(NOON)).slots.map(s => s.start), [780]);
  // Intervals, none free: nothing free. A sheet that is not one is a problem, never "nothing is free".
  assert.deepEqual(CS.readSheet({ courts: COURTS, free: [], intervals: 12, sessions: 3 }, FRI, at(NOON)).slots, []);
  for (const bad of [null, 'x', [], {}, { courts: [], free: 'x' }, { courts: [[1, 'Court 1']], free: [] }, { courts: COURTS, free: [['nonsense', 1140]] },
    { courts: COURTS, free: [], sessions: 5, intervals: 0 }, { courts: COURTS, free: ['booking-id-1|2026-11-20|1080'] }]) {
    assert.throws(() => CS.readSheet(bad, FRI, at(NOON)), e => e.kind === 'odd', JSON.stringify(bad));
  }
  assert.equal(CS.courtNumber('Court 12'), 12);
  assert.equal(CS.courtNumber('Court 1 (floodlit)'), null);
});

test('what a look and Book now must look like, with a plain sentence when they do not', () => {
  assert.deepEqual(CS.readLook({ venue: 'queenspark', date: FRI }), { venue: 'queenspark', date: FRI, fresh: false });
  assert.deepEqual(CS.readLook({ venue: 'kelvingrove', date: FRI, fresh: true }), { venue: 'kelvingrove', date: FRI, fresh: true });
  assert.deepEqual(CS.readLook({ venue: 'hampden', date: FRI }), { why: CS.WHY.venue });
  assert.deepEqual(CS.readLook({ venue: 'toString', date: FRI }), { why: CS.WHY.venue });
  assert.deepEqual(CS.readLook({ date: FRI }), { why: CS.WHY.look });
  assert.deepEqual(CS.readLook({ venue: 'maryhill', date: 'friday' }), { why: CS.WHY.look });
  assert.deepEqual(CS.readBook({ venue: 'maryhill', date: FRI, start: 1080, hours: 2, court: 3 }), { venue: 'maryhill', date: FRI, start: 1080, hours: 2, court: 3 });
  for (const bad of [{ venue: 'maryhill', date: FRI, start: 1080, hours: 3, court: 3 }, { venue: 'maryhill', date: FRI, start: '18:00', hours: 1, court: 3 }, { venue: 'maryhill', date: FRI, start: 1080, hours: 1 }]) {
    assert.deepEqual(CS.readBook(bad), { why: CS.WHY.book }, JSON.stringify(bad));
  }
  for (const read of [CS.readLook, CS.readBook]) for (const bad of [null, 'x', 7, [1]]) assert.deepEqual(read(bad), { why: 'The request body must be a JSON object.' });
  assert.match(CS.WHY.venue, /drumchapel, garrowhill, kelvingrove, knightswood, maryhill, queenspark, victoriapark\.$/);
});

// ---------- a look ----------

test('a look: asked on the PC\'s ping, answered with the free courts by start time, the same over HTTP', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const r = await lookAnswered(t, phone, { venue: 'queenspark', date: FRI });
  assert.deepEqual(r, { status: 200, body: { ok: true, look: { venue: 'queenspark', date: FRI, at: at(NOON) + 3000, by: 'pc', note: 'Free courts, as ClubSpark showed it at 12:00.', slots: SLOTS } } });
  assert.match(t.logs.join('\n'), /ClubSpark: asking your PC for Queens Park on 2026-11-20\./);
  // Over HTTP: the app's door, and the PC's.
  const appApi = { hello: t.app.appHello, pair: t.app.appPair, auth: t.app.appAuth, state: t.app.appState, ask: t.app.appAsk };
  const server = createServer({ getJobs: t.app.jobsForAgent, onResult: t.app.resultFromAgent, onPing: t.app.pingFromAgent, onClubSpark: t.app.clubSparkFromAgent, token: AGENT, appApi });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async res => ({ status: res.status, json: await res.json() }));
  try {
    const ping = t.app.pingFromAgent(HOME, { wait: 5 });
    const looking = post('/app/clubspark/look', { venue: 'maryhill', date: '2026-11-21' }, phone.token);
    const order = await ping;
    assert.deepEqual((await post('/agent/clubspark/look', { id: order.csLook.id, ok: true, sheet: sheetOf('2026-11-21', [[2, 600]]) }, AGENT)).json, { ok: true });
    const got = await looking;
    assert.equal(got.status, 200);
    assert.deepEqual(got.json.look.slots, [{ start: 600, end: 660, courts: [{ n: 2, name: 'Court 2' }] }]);
    // The PC's door does not open to the phone, nor the app's to the PC; and a late answer is said to be late.
    assert.equal((await post('/agent/clubspark/look', { id: order.csLook.id, ok: true }, phone.token)).status, 401);
    assert.deepEqual((await post('/app/clubspark/look', { venue: 'maryhill', date: FRI }, AGENT)), { status: 401, json: { ok: false, why: 'unpaired' } });
    assert.deepEqual((await post('/agent/clubspark/look', { id: 'ffffffffffff', ok: true, sheet: sheetOf(FRI) }, AGENT)).json, { ok: true, late: true });
    assert.deepEqual((await post('/app/clubspark/nothing', {}, phone.token)).status, 404);
  } finally { await new Promise(res => { server.closeAllConnections(); server.close(res); }); }
});

test('a day\'s look is kept three minutes, and reused for ten when it is not asked to be fresh', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const first = (await lookAnswered(t, phone, { venue: 'queenspark', date: FRI })).body.look;
  const quiet = () => t.app.pingFromAgent(HOME, { wait: 0.02 });
  // Within three minutes, fresh or not: what was read, and nothing is asked of the PC.
  t.clock.t = first.at + 3 * MIN - 1;
  for (const fresh of [false, true]) {
    const idle = quiet();
    assert.deepEqual((await ask(t, phone, 'clubspark/look', { venue: 'queenspark', date: FRI, fresh })).body.look, first);
    assert.deepEqual(await idle, { ok: true });
  }
  // After three minutes a fresh look reads again; one that is not fresh is answered from the last
  // read for up to ten minutes.
  t.clock.t = first.at + 9 * MIN;
  const idle = quiet();
  assert.deepEqual((await ask(t, phone, 'clubspark/look', { venue: 'queenspark', date: FRI })).body.look, first);
  assert.deepEqual(await idle, { ok: true });
  const again = await lookAnswered(t, phone, { venue: 'queenspark', date: FRI, fresh: true });
  assert.equal(again.body.look.at, t.clock.t);
  t.clock.t += 10 * MIN;
  assert.equal((await lookAnswered(t, phone, { venue: 'queenspark', date: FRI })).status, 200);       // ten minutes on: read again
  // Another park, or another day, is a read of its own.
  assert.equal((await lookAnswered(t, phone, { venue: 'kelvingrove', date: FRI })).body.look.venue, 'kelvingrove');
});

test('at most six fresh reads in any ten minutes, for all the parks and every phone together', async () => {
  const t = makeBot();
  const phone = await linkPhone(t), other = await linkPhone(t, 'iPad');
  const parks = ['drumchapel', 'garrowhill', 'kelvingrove', 'knightswood', 'maryhill', 'queenspark'];
  for (const venue of parks) { assert.equal((await lookAnswered(t, phone, { venue, date: FRI })).status, 200, venue); t.clock.t += 10000; }
  const full = `That is 6 reads of ClubSpark within ten minutes, which is as many as I ask your PC for, to keep your home connection in good standing with ClubSpark. The next can be at 12:10.`;
  const idle = t.app.pingFromAgent(HOME, { wait: 0.02 });
  assert.deepEqual(await ask(t, other, 'clubspark/look', { venue: 'victoriapark', date: FRI }), refused(409, full));
  assert.deepEqual(await ask(t, phone, 'clubspark/look', { venue: 'queenspark', date: '2026-11-21' }), refused(409, full));
  assert.deepEqual(await idle, { ok: true });                                                     // nothing was asked of the PC
  assert.deepEqual(stateOf(t, phone).clubspark.reads, { used: 6, max: 6, nextAt: at(NOON) + 10 * MIN });
  assert.equal(stateOf(t, phone).clubspark.lookNo, full);
  // What is already known is still answered; it asks nothing of anyone.
  assert.equal((await ask(t, phone, 'clubspark/look', { venue: 'queenspark', date: FRI })).status, 200);
  // Ten minutes after the first there is room for one more.
  t.clock.t = at(NOON) + 10 * MIN - 1;
  assert.equal((await ask(t, other, 'clubspark/look', { venue: 'victoriapark', date: FRI })).status, 409);
  t.clock.t = at(NOON) + 10 * MIN;
  assert.equal((await lookAnswered(t, other, { venue: 'victoriapark', date: FRI })).status, 200);
});

test('from 21:30 to 22:30 nothing is read or booked at ClubSpark, nor while the nightly run is still going', async () => {
  const t = makeBot(`${TUE}T21:20:00Z`, { state: { plan: { tue: { start: 960, hours: 2 } } } });
  const phone = await linkPhone(t);
  const known = (await lookAnswered(t, phone, { venue: 'queenspark', date: FRI })).body.look;
  t.clock.t = at(`${TUE}T21:29:59Z`);
  await t.app.pingFromAgent(HOME);
  assert.equal(stateOf(t, phone).clubspark.bookNo, null);
  const night = 'Your PC\'s nightly booking run is at 22:00, so nothing is read or booked at ClubSpark from 21:30 to 22:30.';
  for (const time of ['21:30:00', '21:34:59', '21:55:00', '22:29:59']) {
    t.clock.t = at(`${TUE}T${time}Z`);
    await t.app.pingFromAgent(HOME);
    assert.deepEqual(await ask(t, phone, 'clubspark/look', { venue: 'maryhill', date: FRI, fresh: true }), refused(409, night), time);
    if (time < '21:35') assert.deepEqual(await ask(t, phone, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 }), refused(409, night), time);
    assert.deepEqual([stateOf(t, phone).clubspark.lookNo, stateOf(t, phone).clubspark.bookNo], [night, night]);
  }
  // A look already known is still shown: it asks nothing of anyone.
  t.clock.t = at(`${TUE}T21:30:01Z`);
  assert.deepEqual((await ask(t, phone, 'clubspark/look', { venue: 'queenspark', date: FRI })).body.look.slots, known.slots);
  // Tonight's run started at 21:55 and has not said how it went: after 22:30 it is still going.
  t.clock.t = at(`${TUE}T21:55:00Z`);
  t.app.jobsForAgent(HOME, { run: true });
  t.clock.t = at(`${TUE}T22:31:00Z`);
  await t.app.pingFromAgent(HOME);
  const going = 'Your PC\'s nightly booking run is still going, so nothing else is read or booked at ClubSpark until it has finished.';
  assert.deepEqual(await ask(t, phone, 'clubspark/look', { venue: 'maryhill', date: FRI }), refused(409, going));
  // Once it has reported, the parks are open to the app again.
  await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  assert.equal((await lookAnswered(t, phone, { venue: 'maryhill', date: FRI })).status, 200);
});

test('a "Just a moment" check: two hours of nothing at ClubSpark from the app, said in the look\'s note, in the state and in Telegram', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const known = (await lookAnswered(t, phone, { venue: 'queenspark', date: FRI })).body.look;
  t.tg.clear();
  t.clock.t = at(NOON) + 5 * MIN;
  const r = await lookAnswered(t, phone, { venue: 'maryhill', date: FRI }, { ok: false, kind: 'challenge', why: 'ClubSpark showed a "Just a moment" page' });
  const pausedAt = t.clock.t, until = pausedAt + 2 * 60 * MIN;
  assert.deepEqual(r, refused(409, 'ClubSpark showed your PC a "Just a moment" check just now, so it is left alone until 14:05: nothing is read or booked there from the app until then.'));
  // Said in Telegram once, as a note (and a notification), and in the log.
  await settle();
  const told = t.tg.calls.filter(c => c.method === 'send');
  assert.equal(told.length, 1);
  assert.equal(told[0].text, '<b>ClubSpark is checking your home connection</b>\nYour PC met ClubSpark\'s "Just a moment" check at 12:05, reading Maryhill Park\'s courts. Nothing more is read or booked at ClubSpark from the app until 14:05. Your nightly booking run uses the same connection: if the check is still there at 22:00, that run may not get through.');
  const s = stateOf(t, phone);
  assert.deepEqual([s.notes[0].kind, s.notes[0].title], ['warn', 'ClubSpark is checking your home connection']);
  assert.equal(t.pushes.length, 1);
  assert.match(t.logs.join('\n'), /ClubSpark showed your PC a "Just a moment" check reading Maryhill Park's courts\. Nothing more is read or booked there from the app until 14:05\./);
  // For two hours: no reads, no bookings, and the state says why.
  const quiet = 'ClubSpark showed your PC a "Just a moment" check at 12:05, so it is left alone until 14:05: nothing is read or booked there from the app until then.';
  assert.deepEqual([s.clubspark.quietUntil, s.clubspark.lookNo, s.clubspark.bookNo], [until, quiet, quiet]);
  t.clock.t = until - 1;
  const idle = t.app.pingFromAgent(HOME, { wait: 0.02 });
  assert.deepEqual(await ask(t, phone, 'clubspark/look', { venue: 'victoriapark', date: FRI, fresh: true }), refused(409, quiet));
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 }), refused(409, 'That list is old. Read the day again, then book a court.'));
  assert.deepEqual(await idle, { ok: true });
  // A look known from before still shows, and its note says why nothing newer can be had.
  t.clock.t = pausedAt + 2 * MIN;
  const shown = await ask(t, phone, 'clubspark/look', { venue: 'queenspark', date: FRI });
  assert.deepEqual(shown.body.look.slots, known.slots);
  assert.equal(shown.body.look.note, `Free courts, as ClubSpark showed it at 12:00.\n${quiet}`);
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 }), refused(409, quiet));
  // Two hours on, the parks are open to the app again, and nothing more was said.
  t.clock.t = until;
  assert.equal((await lookAnswered(t, phone, { venue: 'victoriapark', date: FRI })).status, 200);
  assert.equal(t.tg.calls.filter(c => c.method === 'send').length, 1);
  assert.equal(stateOf(t, phone).clubspark.quietUntil, null);
});

test('a check met by a booking, or reported late, pauses the same; a PC that is still pausing after a restart of the bot is believed', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const { id } = await bookingCollected(t, phone);
  pcSays(t, 'book', { id, stage: 'starting' });
  assert.deepEqual(pcSays(t, 'book', { id, stage: 'failed', kind: 'challenge', why: 'ClubSpark showed a "Just a moment" page, so your PC stopped there' }), { ok: true });
  await settle();
  const s = stateOf(t, phone);
  assert.equal(s.clubspark.quietUntil, t.clock.t + 2 * 60 * MIN);
  assert.match(t.tg.calls.find(c => /checking your home connection/.test(c.text)).text, /booking at Queens Park\./);
  assert.deepEqual([s.results[0].status, s.results[0].why], ['failed', 'It did not work: ClubSpark showed a "Just a moment" page, so your PC stopped there.']);
  // A look whose answer came after the bot stopped waiting: a check in it still counts.
  const u = makeBot(NOON, { lookWaitMs: 30 });
  const phoneU = await linkPhone(u);
  await u.app.pingFromAgent(HOME);
  const ping = u.app.pingFromAgent(HOME, { wait: 5 });
  const looking = ask(u, phoneU, 'clubspark/look', { venue: 'maryhill', date: FRI });
  const order = await ping;
  assert.deepEqual(await looking, refused(409, 'Your PC did not answer in time, so I could not read the free courts.'));
  assert.deepEqual(pcSays(u, 'look', { id: order.csLook.id, ok: false, kind: 'challenge', why: 'ClubSpark showed a "Just a moment" page' }), { ok: true, late: true });
  assert.equal(stateOf(u, phoneU).clubspark.quietUntil, u.clock.t + 2 * 60 * MIN);
  // The PC says it is still leaving ClubSpark alone (the bot has restarted since the check).
  const v = makeBot();
  const phoneV = await linkPhone(v);
  const until = v.clock.t + 3000 + 70 * MIN;
  const r = await lookAnswered(v, phoneV, { venue: 'maryhill', date: FRI }, { ok: false, kind: 'quiet', until, why: 'ClubSpark showed it a "Just a moment" page, so it leaves ClubSpark alone until 13:13' });
  assert.equal(r.status, 409);
  assert.equal(stateOf(v, phoneV).clubspark.quietUntil, until);
  assert.equal(v.tg.calls.filter(c => /checking your home connection/.test(c.text || '')).length, 0);       // said when it happened, not again
});

test('a look that cannot be made: the PC asleep or silent, another day being read, a day not on offer', async () => {
  // Asleep: nothing to ask.
  const a = makeBot();
  const phoneA = await linkPhone(a);
  assert.deepEqual(await ask(a, phoneA, 'clubspark/look', { venue: 'maryhill', date: FRI }),
    refused(409, 'Your PC is not awake, and it is your PC that reads ClubSpark. Wake it and try again.'));
  // Silent: the answer that comes later is still kept, and the next look is answered from it.
  const b = makeBot(NOON, { lookWaitMs: 30 });
  const phoneB = await linkPhone(b);
  await b.app.pingFromAgent(HOME);
  const ping = b.app.pingFromAgent(HOME, { wait: 5 });
  const looking = ask(b, phoneB, 'clubspark/look', { venue: 'maryhill', date: FRI });
  const order = await ping;
  assert.deepEqual(await looking, refused(409, 'Your PC did not answer in time, so I could not read the free courts.'));
  assert.deepEqual(pcSays(b, 'look', { id: order.csLook.id, ok: true, sheet: sheetOf(FRI) }), { ok: true, late: true });
  const idle = b.app.pingFromAgent(HOME, { wait: 0.02 });
  assert.deepEqual((await ask(b, phoneB, 'clubspark/look', { venue: 'maryhill', date: FRI })).body.look.slots, SLOTS);
  assert.deepEqual(await idle, { ok: true });
  // One read at a time: the same day joins it, another waits its turn.
  const c = makeBot();
  const phoneC = await linkPhone(c);
  await c.app.pingFromAgent(HOME);
  const pingC = c.app.pingFromAgent(HOME, { wait: 5 });
  const one = ask(c, phoneC, 'clubspark/look', { venue: 'maryhill', date: FRI });
  const two = ask(c, phoneC, 'clubspark/look', { venue: 'maryhill', date: FRI, fresh: true });
  assert.deepEqual(await ask(c, phoneC, 'clubspark/look', { venue: 'maryhill', date: '2026-11-21' }), refused(409, 'Your PC is reading another day at ClubSpark just now. Try again in a moment.'));
  pcSays(c, 'look', { id: (await pingC).csLook.id, ok: true, sheet: sheetOf(FRI) });
  assert.deepEqual((await one).body, (await two).body);
  assert.equal(stateOf(c, phoneC).clubspark.reads.used, 1);
  // The PC would not read it (its own limits), or ClubSpark's page did not load: said in its words.
  assert.deepEqual(await lookAnswered(c, phoneC, { venue: 'garrowhill', date: FRI }, { ok: false, kind: 'busy', why: 'the nightly booking starts in 20 minutes' }),
    refused(409, 'Your PC did not read it: the nightly booking starts in 20 minutes.'));
  assert.deepEqual(await lookAnswered(c, phoneC, { venue: 'garrowhill', date: '2026-11-21' }, { ok: false, kind: 'timeout', why: 'the booking sheet did not show' }),
    refused(409, 'ClubSpark\'s page did not load on your PC in time.'));
  assert.deepEqual(await lookAnswered(c, phoneC, { venue: 'garrowhill', date: '2026-11-22' }, { ok: true, sheet: { courts: COURTS, free: [['what is this', 1]] } }),
    refused(409, 'ClubSpark\'s sheet could not be read (a sheet I can no longer read).'));
  // Days: today up to the last one open (the 24th opens at 22:00 tonight); a day gone, or not a day.
  for (const date of ['2026-11-16', '2026-11-31']) assert.deepEqual(await ask(c, phoneC, 'clubspark/look', { venue: 'maryhill', date }), refused(400, 'That day is no longer on offer. Pick again.'));
  assert.deepEqual(await ask(c, phoneC, 'clubspark/look', { venue: 'maryhill', date: '2026-11-24' }), refused(400, 'That day is not open for booking yet: it opens on Tue 17 Nov at 22:00.'));
  assert.deepEqual(await ask(c, phoneC, 'clubspark/look', { venue: 'kelvingrove', date: '2026-11-30' }),
    refused(400, 'That day is not open for booking yet: it opens on Mon 23 Nov at 22:00. Add it to your list and your PC books it then.'));
  assert.deepEqual(stateOf(c, phoneC).clubspark.days, { first: TUE, last: '2026-11-23' });
  c.clock.t = at(`${TUE}T22:30:00Z`);
  assert.deepEqual(stateOf(c, phoneC).clubspark.days, { first: TUE, last: '2026-11-24' });
  // Not linked: there is no PC to ask.
  const d = makeBot(NOON, { linked: false });
  assert.equal(d.app.appState({ id: 'x' }), null);
});

// ---------- Book now ----------

test('Book now, end to end: asked, collected, each step, the go-ahead, booked; an ordinary result with a card, a note and a push', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const { asked, order, id } = await bookingCollected(t, phone);
  // Asked: the answer is the state, with the booking in it.
  assert.equal(asked.status, 200);
  assert.deepEqual(Object.keys(asked.body), ['ok', 'etag', 'state']);
  const first = asked.body.state.clubspark.book;
  assert.deepEqual(first, {
    id, venue: 'queenspark', venueName: 'Queens Park', date: FRI, start: 1080, end: 1140, hours: 1, court: 1, courtName: 'Court 1',
    stage: 'asked', live: true, ended: null, why: null, gate: null, at: t.clock.t, heardAt: t.clock.t, line: 'Asking your PC to book it.',
  });
  assert.equal(asked.body.state.clubspark.bookNo, 'Your PC is already booking a court.');
  // The ping hands the PC exactly that, once.
  assert.deepEqual(order, { ok: true, csBook: { id, venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 } });
  assert.deepEqual(await t.app.pingFromAgent(HOME), { ok: true });
  const book = () => stateOf(t, phone).clubspark.book;
  assert.equal(book().line, 'Your PC has it and is starting Chrome…');
  for (const [stage, line] of [['starting', 'Your PC is opening ClubSpark…'], ['signing-in', 'Your PC is signing in to ClubSpark…'], ['signed-in', 'Signed in. Looking for court 1 on the sheet…']]) {
    assert.deepEqual(pcSays(t, 'book', { id, stage }), { ok: true });
    assert.deepEqual([book().stage, book().line], [stage, line]);
  }
  // A beat says only that it is still at it; it moves nothing.
  t.clock.t += 20000;
  assert.deepEqual(pcSays(t, 'book', { id, stage: 'signed-in', beat: true }), { ok: true });
  assert.deepEqual([book().stage, book().heardAt], ['signed-in', t.clock.t]);
  // About to press "Continue booking": the go-ahead.
  assert.deepEqual(pcSays(t, 'book', { id, stage: 'booking' }), { ok: true, go: true });
  assert.equal(book().line, 'Booking court 1…');
  t.tg.clear();
  assert.deepEqual(pcSays(t, 'book', { id, stage: 'booked', court: '1', gate: '4821' }), { ok: true });
  await settle();
  // The card in Telegram names the park; the result is an ordinary one, under the park's own id.
  const card = t.tg.calls.find(c => c.method === 'photo');
  assert.equal(card.text, '<b>Booked · Court 1</b>\nQueens Park · Fri 20 Nov · 18:00–19:00\nGate code: <code>4821</code>  (tap to copy)');
  const s = stateOf(t, phone);
  assert.deepEqual(s.results[0], { id: 'queenspark/2026-11-20@18:00', venue: 'queenspark', status: 'booked', date: FRI, start: 1080, end: 1140, court: '1', gate: '4821', why: null, at: t.clock.t, past: false });
  assert.deepEqual([s.notes[0].kind, s.notes[0].title, s.notes[0].body], ['booked', 'Court 1 booked', 'Queens Park · Fri 20 Nov · 18:00–19:00 · gate 4821']);
  assert.deepEqual(t.pushes.map(p => p.title), ['Court 1 booked']);
  assert.deepEqual([s.clubspark.book.live, s.clubspark.book.ended, s.clubspark.book.gate, s.clubspark.book.line], [false, 'booked', '4821', 'Booked: court 1. Gate code 4821.']);
  assert.equal(s.clubspark.bookNo, null);
  // It counts towards the week, and the same court and hour cannot be booked twice.
  assert.equal(s.allowance[0].sessions, 1);
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 2 }),
    refused(409, 'Court 1 is already booked for you at Queens Park on Fri 20 Nov at 18:00.'));
  // A note about a booking this bot does not know, or one given up on, is told so.
  assert.deepEqual(pcSays(t, 'book', { id: 'ffffffffffff', stage: 'booking' }), { ok: true, unknown: true });
  assert.deepEqual(pcSays(t, 'book', { id, stage: 'booking' }), { ok: true, stop: true });
});

test('Kelvingrove booked now is a result under its usual id, so the nightly run does not book that slot again', async () => {
  const t = makeBot(NOON, { state: { once: [{ date: FRI, start: 1080, hours: 1 }] } });
  const phone = await linkPhone(t);
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: false }).jobs.map(j => j.id), ['2026-11-20@18:00']);         // open: the PC would book it tonight
  const { id } = await bookingCollected(t, phone, { venue: 'kelvingrove', date: FRI, start: 1080, hours: 1, court: 1 });
  pcSays(t, 'book', { id, stage: 'starting' });
  pcSays(t, 'book', { id, stage: 'booking' });
  pcSays(t, 'book', { id, stage: 'booked', court: '1', gate: '2433' });
  await settle();
  const r = stateOf(t, phone).results[0];
  assert.deepEqual([r.id, r.venue, r.court], ['2026-11-20@18:00', 'kelvingrove', '1']);
  assert.equal(t.tg.calls.find(c => c.method === 'photo').text.split('\n')[1], 'Fri 20 Nov · 18:00–19:00');
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: false }).jobs, []);
  // A park's booking at the same hour is another session, under another id: the schedule is not touched by it.
  const u = makeBot(NOON, { state: { once: [{ date: FRI, start: 1080, hours: 1 }] } });
  const phoneU = await linkPhone(u);
  const other = await bookingCollected(u, phoneU, { venue: 'maryhill', date: FRI, start: 1080, hours: 1, court: 1 });
  pcSays(u, 'book', { id: other.id, stage: 'booking' });
  pcSays(u, 'book', { id: other.id, stage: 'booked', court: '1' });
  await settle();
  assert.deepEqual(Object.keys(u.app.state.results), ['maryhill/2026-11-20@18:00']);
  assert.deepEqual(u.app.jobsForAgent(HOME, { run: false }).jobs.map(j => j.id), ['2026-11-20@18:00']);
});

test('when the court has gone your PC takes no other, and says so; a refusal, a failure and a tool that quits are results too', async () => {
  const outcome = async (steps, end) => {
    const t = makeBot();
    const phone = await linkPhone(t);
    const { id } = await bookingCollected(t, phone);
    for (const stage of steps) pcSays(t, 'book', { id, stage });
    t.tg.clear();
    pcSays(t, 'book', { id, ...end });
    await settle();
    const s = stateOf(t, phone);
    return { result: s.results[0], book: s.clubspark.book, card: t.tg.calls.find(c => c.method === 'photo'), note: s.notes[0] };
  };
  const gone = await outcome(['starting', 'signing-in', 'signed-in'], { stage: 'gone', why: 'not free at 18:00 any more' });
  assert.deepEqual([gone.result.status, gone.result.why], ['failed', 'It did not work: court 1 was no longer free for that time (not free at 18:00 any more), and your PC takes no other court.']);
  assert.equal(gone.card.text, '<b>Not booked · Queens Park · Fri 20 Nov · 18:00–19:00</b>\nIt did not work: court 1 was no longer free for that time (not free at 18:00 any more), and your PC takes no other court.\nBook by hand on ClubSpark if you still want it.');
  assert.deepEqual([gone.note.kind, gone.note.title], ['missed', 'Not booked']);
  assert.deepEqual([gone.book.ended, gone.book.line], ['gone', 'Not booked: court 1 was no longer free for that time (not free at 18:00 any more), and your PC takes no other court.']);
  const said = async (steps, end) => (await outcome(steps, end)).result.why;
  assert.equal(await said([], { stage: 'refused', why: 'the nightly booking starts in 20 minutes' }), 'It did not work: your PC did not start it: the nightly booking starts in 20 minutes.');
  assert.equal(await said(['starting'], { stage: 'failed', why: 'Sign-in did not finish' }), 'It did not work: Sign-in did not finish.');
  assert.equal(await said(['starting', 'signing-in'], { stage: 'quit', why: 'the booking tool was still running after ten minutes, so it was stopped' }),
    'It did not work: your PC\'s booking stopped before it booked anything (the booking tool was still running after ten minutes, so it was stopped).');
  assert.equal(await said(['starting', 'signing-in', 'signed-in', 'booking'], { stage: 'quit' }), 'It did not work: your PC\'s booking stopped while it was booking court 1: check ClubSpark for it.');
  // A quit after the tool's own word changes nothing.
  const t = makeBot();
  const phone = await linkPhone(t);
  const { id } = await bookingCollected(t, phone);
  pcSays(t, 'book', { id, stage: 'gone', why: 'not free at 18:00 any more' });
  pcSays(t, 'book', { id, stage: 'quit' });
  await settle();
  assert.equal(stateOf(t, phone).clubspark.book.ended, 'gone');
});

test('with nobody to carry it out: not collected, collected and never started, or gone silent; the PC\'s own word still counts after', async () => {
  // Not collected within 25 seconds: nothing was handed over, so nothing was booked.
  const a = makeBot();
  const phoneA = await linkPhone(a);
  assert.equal((await lookAnswered(a, phoneA, { venue: 'maryhill', date: FRI })).status, 200);
  assert.equal((await ask(a, phoneA, 'clubspark/book', { venue: 'maryhill', date: FRI, start: 1080, hours: 1, court: 1 })).status, 200);
  a.clock.t += 24999;
  await a.app.tick();
  assert.equal(stateOf(a, phoneA).clubspark.book.live, true);
  a.clock.t += 1;
  await a.app.tick();
  await settle();
  assert.deepEqual([stateOf(a, phoneA).clubspark.book.ended, stateOf(a, phoneA).results[0].why], ['nopickup', 'It did not work: your PC did not collect it in time, so nothing was booked.']);
  assert.deepEqual(await a.app.pingFromAgent(HOME), { ok: true });                                   // not handed over late
  // Collected, then nothing for a minute and a half: it never started.
  const b = makeBot();
  const phoneB = await linkPhone(b);
  const bb = await bookingCollected(b, phoneB);
  b.clock.t += 90 * 1000;
  await b.app.tick();
  await settle();
  assert.deepEqual([stateOf(b, phoneB).clubspark.book.ended, stateOf(b, phoneB).results[0].why], ['nostart', 'It did not work: your PC collected it but did not start on it, so nothing was booked.']);
  assert.deepEqual(pcSays(b, 'book', { id: bb.id, stage: 'booking' }), { ok: true, stop: true });     // it never gets the go-ahead after that
  // Started, then silent: over a minute, the state says so; four minutes, it is over.
  const c = makeBot();
  const phoneC = await linkPhone(c);
  const cc = await bookingCollected(c, phoneC);
  pcSays(c, 'book', { id: cc.id, stage: 'signing-in' });
  c.clock.t += 75 * 1000;
  await c.app.tick();
  assert.deepEqual([stateOf(c, phoneC).clubspark.book.live, stateOf(c, phoneC).clubspark.book.line], [true, 'No word from your PC for over a minute.']);
  assert.match(stateOf(c, phoneC).pc.sleepWhy, /booking a court for you/);
  c.clock.t += 165 * 1000;
  await c.app.tick();
  await settle();
  assert.deepEqual([stateOf(c, phoneC).clubspark.book.ended, stateOf(c, phoneC).results[0].why],
    ['silent', 'It did not work: no word from your PC, so I stopped following it. It books nothing without my go-ahead, so nothing was booked.']);
  assert.deepEqual(pcSays(c, 'book', { id: cc.id, stage: 'booking' }), { ok: true, stop: true });
  // Silent after the go-ahead: it may have booked. Its own word, when it comes, replaces mine.
  const d = makeBot();
  const phoneD = await linkPhone(d);
  const dd = await bookingCollected(d, phoneD);
  pcSays(d, 'book', { id: dd.id, stage: 'booking' });
  d.clock.t += 4 * MIN;
  await d.app.tick();
  await settle();
  assert.equal(stateOf(d, phoneD).results[0].why, 'It did not work: no word from your PC while it was booking court 1: check ClubSpark for it.');
  assert.deepEqual(pcSays(d, 'book', { id: dd.id, stage: 'booked', court: '1', gate: '9911' }), { ok: true });
  await settle();
  const r = stateOf(d, phoneD).results[0];
  assert.deepEqual([r.status, r.gate, stateOf(d, phoneD).clubspark.book.ended], ['booked', '9911', 'booked']);
  assert.equal(d.tg.calls.filter(x => x.method === 'photo').length, 2);                               // "not booked", then "booked"
});

test('Book now only for a court a look showed the app free in the last fifteen minutes, for the whole time, within the week\'s allowance', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const body = { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 };
  const old = 'That list is old. Read the day again, then book a court.';
  assert.deepEqual(await ask(t, phone, 'clubspark/book', body), refused(409, old));                 // no look at all
  await lookAnswered(t, phone, { venue: 'queenspark', date: FRI });
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { ...body, court: 3 }), refused(409, old));    // court 3 was not free
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { ...body, venue: 'maryhill' }), refused(409, old));   // another park
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { ...body, court: 2, hours: 2 }), refused(409, 'Court 2 is not free for two hours from 18:00. Pick another time or court.'));
  // Things not on offer at all.
  for (const bad of [{ ...body, start: 1083 }, { ...body, court: 21 }, { ...body, start: 1380, hours: 2 }]) assert.deepEqual(await ask(t, phone, 'clubspark/book', bad), refused(400, 'That time is no longer on offer. Pick again.'), JSON.stringify(bad));
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { ...body, date: '2026-11-16' }), refused(400, 'That day is no longer on offer. Pick again.'));
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { ...body, venue: 'hampden' }), refused(400, CS.WHY.venue));
  // Fifteen minutes from the read, the list is old.
  t.clock.t = at(NOON) + 3000 + 15 * MIN;
  assert.deepEqual(await ask(t, phone, 'clubspark/book', body), refused(409, old));
  // The week's allowance: seven sessions already booked in the week of Mon 16 Nov.
  const results = {};
  for (let d = 16; d <= 22; d++) { const id = `maryhill/2026-11-${d}@09:00`; results[id] = { id, status: 'booked', date: `2026-11-${d}`, start: 540, end: 600, court: '1', at: at('2026-11-10T22:00:00Z') }; }
  const full = makeBot(NOON, { state: { results } });
  const phoneF = await linkPhone(full);
  await lookAnswered(full, phoneF, { venue: 'queenspark', date: FRI });
  assert.deepEqual(await ask(full, phoneF, 'clubspark/book', body), refused(409, 'That would be 8 sessions in the week of Mon 16 Nov; the limit is 7.'));
});

test('never alongside a hold, the nightly run, or another booking; at most four an hour; and the PC is not put to sleep meanwhile', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const { id } = await bookingCollected(t, phone);
  pcSays(t, 'book', { id, stage: 'starting' });
  let s = stateOf(t, phone);
  // While it books: no second booking, no look, no hold, no sleep.
  assert.equal(s.clubspark.bookNo, 'Your PC is already booking a court.');
  assert.equal(s.clubspark.lookNo, 'Your PC is booking a court just now. Look again when it has finished.');
  assert.equal(s.indoor.holdNo, 'Your PC is booking a court at a park just now. Hold one when it has finished.');
  await t.app.handleUpdate({ update_id: 1, callback_query: { id: 'q0', data: 'gh:g:20261120:1800:3', from: { id: OWNER }, message: { message_id: 7, chat: { id: OWNER, type: 'private' } } } });
  assert.equal(t.tg.answers[t.tg.answers.length - 1], 'Your PC is booking a court.');
  assert.equal(stateOf(t, phone).hold, null);
  assert.deepEqual(await ask(t, phone, 'pc/sleep'), refused(409, 'Your PC is booking a court for you. Wait for it to finish.'));
  await t.app.handleUpdate(say(OWNER, '/sleep'));
  assert.equal(t.tg.last().text, 'Your PC is booking a court for you. Wait for it to finish.');
  pcSays(t, 'book', { id, stage: 'gone', why: 'not free at 18:00 any more' });
  await settle();
  s = stateOf(t, phone);
  assert.deepEqual([s.clubspark.bookNo, s.indoor.holdNo, s.pc.canSleep], [null, null, true]);
  // Four bookings in an hour, each a sign-in: the fifth waits for the first to leave the hour.
  for (let i = 0; i < 3; i++) {
    const next = await bookingCollected(t, phone, { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 2 });
    assert.equal(next.asked.status, 200, `booking ${i + 2}`);
    pcSays(t, 'book', { id: next.id, stage: 'gone' });
  }
  await t.app.pingFromAgent(HOME);
  assert.equal((await lookAnswered(t, phone, { venue: 'garrowhill', date: FRI })).status, 200);
  assert.deepEqual(await ask(t, phone, 'clubspark/book', { venue: 'garrowhill', date: FRI, start: 1080, hours: 1, court: 1 }),
    refused(409, 'That is 4 bookings within an hour, and each is a sign-in to ClubSpark. The next can start at 13:00.'));
  // A hold under way at Glasgow Club: no booking at a park.
  const h = makeBot();
  const phoneH = await linkPhone(h);
  await lookAnswered(h, phoneH, { venue: 'queenspark', date: FRI });
  await h.app.pingFromAgent(HOME);
  await h.app.handleUpdate({ update_id: 1, callback_query: { id: 'q1', data: 'gh:g:20261120:1800:3', from: { id: OWNER }, message: { message_id: 7, chat: { id: OWNER, type: 'private' } } } });
  assert.equal(stateOf(h, phoneH).hold.live, true);
  assert.deepEqual(await ask(h, phoneH, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 }), refused(409, 'Your PC is holding a court at Glasgow Club. Let it go first.'));
  // The PC asleep: no booking.
  const z = makeBot();
  const phoneZ = await linkPhone(z);
  await lookAnswered(z, phoneZ, { venue: 'queenspark', date: FRI });
  z.clock.t += 4 * MIN;
  assert.deepEqual(await ask(z, phoneZ, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 }),
    refused(409, 'Your PC is not awake, and it is your PC that signs in to ClubSpark and books. Wake it and try again.'));
});

test('a booking asked for just before the quiet time is not handed over in it', async () => {
  const t = makeBot(`${TUE}T21:28:00Z`);
  const phone = await linkPhone(t);
  await lookAnswered(t, phone, { venue: 'queenspark', date: FRI });
  assert.equal((await ask(t, phone, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 })).status, 200);
  t.clock.t = at(`${TUE}T21:30:00Z`);
  assert.deepEqual(await t.app.pingFromAgent(HOME), { ok: true });
  await settle();
  const s = stateOf(t, phone);
  assert.deepEqual([s.clubspark.book.ended, s.results[0].why], ['notsent', 'It did not work: your PC\'s nightly booking run was near, so it was not handed to your PC and nothing was booked.']);
});

// ---------- the venues ----------

test('the venues: seven parks on ClubSpark, Gorbals and Scotstoun at Glasgow Club, Scotstoun\'s outdoor courts not yet', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const venues = stateOf(t, phone).venues;
  assert.deepEqual(venues.map(v => [v.key, v.club, v.types.join('+'), v.centre, v.schedule]), [
    ['drumchapel', 'clubspark', 'outdoor', null, false], ['garrowhill', 'clubspark', 'outdoor', null, false], ['kelvingrove', 'clubspark', 'outdoor', null, true],
    ['knightswood', 'clubspark', 'outdoor', null, false], ['maryhill', 'clubspark', 'outdoor', null, false], ['queenspark', 'clubspark', 'outdoor', null, false],
    ['victoriapark', 'clubspark', 'outdoor', null, false], ['gorbals', 'glasgow', 'indoor', 'g', false], ['scotstoun', 'glasgow', 'indoor', 's', false],
  ]);
  assert.deepEqual(venues[8], {
    key: 'scotstoun', name: 'Scotstoun', club: 'glasgow', types: ['indoor'], centre: 's', schedule: false, notYet: ['outdoor'], note: 'Scotstoun\'s outdoor courts are not available yet.',
    site: `https://glasgowclub.gladstonego.cloud/book/calendar/SA011?activityDate=${TUE}T00:00:00.000Z`,
  });
  assert.equal(venues[5].site, `https://clubspark.lta.org.uk/QueensParkTennisCourtsGlasgow/Booking/BookByDate#?date=${TUE}`);
  // The outdoor sheet's id is one constant, not known yet: nothing reads it, or holds from it.
  assert.equal(G.SCOTSTOUN_OUTDOOR_ACTIVITY, null);
  assert.deepEqual([G.SHEETS.o.venue, G.SHEETS.o.type, G.SHEETS.o.activity], ['scotstoun', 'outdoor', null]);
  assert.deepEqual(Object.keys(G.CENTRES), ['g', 's']);
  assert.deepEqual(Object.values(G.CENTRES).map(c => c.type), ['indoor', 'indoor']);
  // Once it is known, Scotstoun lists both.
  const known = { ...G.SHEETS, o: { ...G.SHEETS.o, activity: 'SA999' } };
  const s = V.venueList(known, TUE, G.sheetUrl).find(v => v.key === 'scotstoun');
  assert.deepEqual([s.types, s.notYet, s.note, s.centre], [['indoor', 'outdoor'], [], null, 's']);
});

test('scheduling stays Kelvingrove\'s: the app is told so if it names another park', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const why = 'Only Kelvingrove Park can be scheduled. Book the other parks with Book now, once their day is open.';
  assert.deepEqual(await ask(t, phone, 'once', { venue: 'queenspark', date: '2026-11-27', start: 1140, hours: 1 }), refused(400, why));
  assert.deepEqual(await ask(t, phone, 'plan', { venue: 'maryhill', day: 'thu', start: 1140, hours: 1 }), refused(400, why));
  assert.equal((await ask(t, phone, 'once', { venue: 'kelvingrove', date: '2026-11-27', start: 1140, hours: 1 })).status, 200);
  assert.equal((await ask(t, phone, 'plan', { day: 'thu', start: 1140, hours: 1 })).status, 200);
  assert.deepEqual(t.app.state.once, [{ date: '2026-11-27', start: 1140, hours: 1 }]);
});

test('a result from another park keeps its park; a made-up park, or Kelvingrove written out, is not a result', async () => {
  const { cleanResult, loadState } = require('../app');
  assert.deepEqual(cleanResult({ id: 'victoriapark/2026-11-20@18:00', status: 'booked', court: 2, end: 1200 }),
    { id: 'victoriapark/2026-11-20@18:00', status: 'booked', date: FRI, start: 1080, end: 1200, venue: 'victoriapark', court: '2' });
  for (const id of ['hampden/2026-11-20@18:00', 'kelvingrove/2026-11-20@18:00', 'Queenspark/2026-11-20@18:00', '/2026-11-20@18:00']) assert.equal(cleanResult({ id, status: 'none' }), null, id);
  const kept = loadState({ v: 4, owner: OWNER, results: { 'maryhill/2026-11-20@18:00': { id: 'maryhill/2026-11-20@18:00', status: 'none', date: FRI, start: 1080, end: 1140, at: 5 } } });
  assert.deepEqual(kept.results['maryhill/2026-11-20@18:00'], { id: 'maryhill/2026-11-20@18:00', status: 'none', date: FRI, start: 1080, end: 1140, venue: 'maryhill', at: 5 });
  assert.equal(V.resultId('kelvingrove', FRI, 1080), '2026-11-20@18:00');
  assert.equal(V.resultId('garrowhill', FRI, 570), 'garrowhill/2026-11-20@09:30');
});
