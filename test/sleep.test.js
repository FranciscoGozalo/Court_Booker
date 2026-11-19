'use strict';
// Putting your PC to sleep from Telegram: the button, the hand-off to the PC's ping, and the guards.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createServer } = require('../lib/server');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const ENV = { WAKE_MAC: '44:AF:28:7A:1A:5C', WAKE_PORT: '40009' };

function makeApp(t0, state = { owner: OWNER }) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const app = createApp({ now: () => clock.t, tg, store: memStore(state), pictures: PICTURES, linked: true, env: ENV, wake: async () => 3 });
  return { app, tg, clock };
}
let tapId = 1;
const tap = (app, data, messageId) => app.handleUpdate({
  update_id: 1, callback_query: { id: `sl${tapId++}`, data, from: { id: OWNER }, message: { message_id: messageId, chat: { id: OWNER, type: 'private' } } },
});
const top = call => call.extra.reply_markup.inline_keyboard[0][0];

test('Sleep my PC: asked once, collected by the next ping, and the dot turns amber at once', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T12:00:00Z`);
  await app.pingFromAgent({ ip: '2.96.64.17' }); await app.tick();
  await app.handleUpdate(say(OWNER, '/menu'));
  const card = tg.last();
  assert.deepEqual(top(card), { text: 'Sleep my PC', callback_data: 'sl' });
  await tap(app, 'sl', card.id);
  assert.match(tg.last().text, /^<b>Put your PC to sleep\?<\/b>/);
  assert.equal(top(tg.last()).callback_data, 'sl:ok');
  await tap(app, 'sl:ok', card.id);
  assert.equal(tg.answers.at(-1), 'Sleep sent');
  assert.match(tg.last().text, /Sleep sent at 12:00\. Your PC goes to sleep within a few seconds/);
  // The PC's ping collects it, once.
  clock.t += 5000;
  assert.deepEqual(await app.pingFromAgent({ ip: '2.96.64.17' }), { ok: true, sleep: true });
  assert.equal(app.pcState(), 'asleep');
  await app.tick();
  assert.equal(tg.last().photo, 'upload:banner-home-asleep.jpg');
  assert.equal(top(tg.last()).text, 'Wake my PC');
  // Pinging again means it is awake after all (it woke, or did not sleep): green, and no second order.
  clock.t += 60000;
  assert.deepEqual(await app.pingFromAgent({ ip: '2.96.64.17' }), { ok: true });
  assert.equal(app.pcState(), 'awake');
});

test('a waiting ping gets the order within moments of the tap', async () => {
  const { app } = makeApp(`${TUE}T12:00:00Z`);
  await app.pingFromAgent({});
  const started = Date.now();
  const pending = app.pingFromAgent({}, { wait: 5 });
  setTimeout(() => app.handleUpdate(say(OWNER, '/sleep')), 30);
  assert.deepEqual(await pending, { ok: true, sleep: true });
  assert.ok(Date.now() - started < 2000);
  // With nothing to do, a waiting ping just ends after its wait.
  const quiet = Date.now();
  assert.deepEqual(await app.pingFromAgent({}, { wait: 0.05 }), { ok: true });
  assert.ok(Date.now() - quiet >= 40);
});

test('an old request is dropped, so the PC never sleeps the next time it wakes', async () => {
  const { app, clock } = makeApp(`${TUE}T12:00:00Z`);
  await app.pingFromAgent({});
  await app.handleUpdate(say(OWNER, '/sleep'));
  clock.t += 3 * 60000;                                         // nothing collected it in time
  assert.deepEqual(await app.pingFromAgent({}), { ok: true });
  assert.equal(app.pcState(), 'awake');
});

test('no sleeping in the half hour before a booking, or when the PC is not awake', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:35:00Z`, { owner: OWNER, plan: { tue: { start: 1140, hours: 1 } } });
  await app.pingFromAgent({});
  await app.handleUpdate(say(OWNER, '/sleep'));
  assert.match(tg.last().text, /Your PC books at 22:00, so it stays awake until then\./);
  assert.deepEqual(await app.pingFromAgent({}), { ok: true });
  // Just before the half hour it may.
  clock.t = at(`${TUE}T21:29:30Z`);
  await app.pingFromAgent({});
  await app.handleUpdate(say(OWNER, '/sleep'));
  assert.match(tg.last().text, /Sleep sent at 21:29/);
  // But a request still fresh is not handed over once the half hour has begun.
  clock.t = at(`${TUE}T21:30:30Z`);
  assert.deepEqual(await app.pingFromAgent({}), { ok: true });
  assert.equal(app.pcState(), 'awake');
  // Asleep already: nothing to do.
  clock.t += 10 * 60000;
  await app.handleUpdate(say(OWNER, '/sleep'));
  assert.match(tg.last().text, /Your PC is not awake\./);
});

test('the server passes { wait } through and answers when the app does', async () => {
  const got = [];
  const server = createServer({ token: 'a-long-random-line-for-testing-only', getJobs: () => ({}), onResult: async () => ({ ok: true }),
    onPing: async (from, opts) => { got.push([opts.wait, opts.refused]); await new Promise(r => setTimeout(r, 20)); return { sleep: true }; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Bearer a-long-random-line-for-testing-only' };
  try {
    const res = await fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: JSON.stringify({ awake: true, wait: 50 }) });
    assert.deepEqual(await res.json(), { ok: true, sleep: true });
    await fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: JSON.stringify({ wait: 900, refused: 'the nightly booking is running' }) });
    await fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: 'not json' });
    assert.deepEqual(got, [[50, null], [50, 'the nightly booking is running'], [0, null]]);
  } finally { await new Promise(r => server.close(r)); }
});

test('when the PC would not sleep, you are told why, and the dot stays green', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await app.pingFromAgent({});
  await app.handleUpdate(say(OWNER, '/sleep'));
  assert.deepEqual(await app.pingFromAgent({}), { ok: true, sleep: true });
  assert.equal(app.pcState(), 'asleep');
  await app.pingFromAgent({}, { refused: 'the nightly booking task is switched off, so nothing would wake it to book' });
  await new Promise(r => setImmediate(r));
  assert.match(tg.last().text, /^<b>Your PC stayed awake<\/b>\nIt did not go to sleep: the nightly booking task is switched off, so nothing would wake it to book\.$/);
  assert.equal(app.pcState(), 'awake');
});

test('the sleep question says when the PC still wakes itself', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await app.pingFromAgent({});
  await app.handleUpdate(say(OWNER, '/menu'));
  await tap(app, 'sl', tg.last().id);
  assert.match(tg.last().text, /It still wakes itself at 21:55 each night for the booking/);
});
