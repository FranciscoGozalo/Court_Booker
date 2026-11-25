'use strict';
// Telegram switched off (2.13): no TELEGRAM_BOT_TOKEN, and the iPhone app is the way in. The bot books as
// ever, says nothing in Telegram, and a phone is linked with a code from a phone linked already or from
// your PC (POST /agent/pair, signed), instead of /app in Telegram.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createServer } = require('../lib/server');
const { createQuietTelegram } = require('../lib/telegram');
const { serverFor } = require('../index');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const NOON = '2026-11-17T12:00:00Z';         // a Tuesday; UK on GMT
const AGENT = 'a-long-random-line-for-testing-only';
const settle = () => new Promise(r => setTimeout(r, 5));

// The bot as index.js starts it without TELEGRAM_BOT_TOKEN (or, with `telegram`, with it): `store` is its
// settings file, the same one again being the bot after a restart.
function makeBot({ store = memStore(null), env = {}, telegram = false, t0 = NOON } = {}) {
  const clock = { t: at(t0) };
  const tg = telegram ? fakeTelegram(clock) : createQuietTelegram();
  const logs = [], pushes = [];
  const glasgow = { asked: [], day: async () => ({ at: clock.t, slots: [], listed: 0 }), peek: () => null, health: () => null };
  const app = createApp({ now: () => clock.t, tg, store, pictures: PICTURES, linked: true, env, glasgow, log: l => logs.push(l),
    push: async (tokens, message) => { pushes.push({ tokens, ...message }); }, wake: async () => 3 });
  return { app, tg, clock, store, logs, pushes };
}
// A phone linked with a code from your PC, as node book.js --pair-phone asks for one.
function linkByPc(t, name = 'iPhone') {
  const { code } = t.app.pairFromAgent({});
  const r = t.app.appPair({ code, name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.device.id, device: t.app.appAuth(r.body.token) };
}
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);

test('the quiet stand-in takes everything the bot would say in Telegram, and says it nowhere', async () => {
  const tg = createQuietTelegram();
  assert.equal(tg.quiet, true);
  const a = await tg.send(42, 'hello'), b = await tg.sendPhoto(42, { buf: Buffer.from('x'), name: 'p.jpg' }, { caption: 'c' });
  assert.deepEqual([a, b], [{ message_id: 1 }, { message_id: 2 }]);          // an id each, and no picture sizes (no picture id is kept)
  assert.equal(await tg.edit(42, 1, 'x'), true);
  assert.deepEqual(await tg.editCaption(42, 2, 'x'), { message_id: 2 });
  assert.deepEqual(await tg.editMedia(42, 2, 'id'), { message_id: 2 });
  assert.deepEqual(await tg.getUpdates(0, 50), []);
  assert.equal(await tg.answer('q'), true);
  assert.equal(await tg.call('getMe'), true);
  assert.equal(tg.skewMs(), null);
});

test('with Telegram off and no owner, the bot answers to the app alone, books for it, and a restart keeps it so', async () => {
  const t = makeBot();
  assert.equal(t.app.quiet, true);
  assert.equal(t.app.owner(), 0);
  assert.equal(t.store.load().owner, 0);
  assert.ok(t.logs.includes('This bot answers to the iPhone app alone (Telegram is off).'));
  await t.app.announce();
  assert.match(t.logs[t.logs.length - 1], /^Telegram is off \(no TELEGRAM_BOT_TOKEN\): the iPhone app is the way in\. No phone is linked yet: on your PC, node book\.js --pair-phone gives a code for the app\.$/);
  const phone = linkByPc(t);
  assert.equal(t.app.state.apps[0].owner, 0);
  // It books: a weekly time from the app is handed to the PC at its release, as with an owner in Telegram.
  assert.equal((await ask(t, phone, 'plan', { day: 'tue', start: 1140, hours: 1 })).status, 200);
  t.clock.t = at('2026-11-17T21:56:00Z');
  const jobs = await t.app.jobsForAgent({ ip: '81.2.69.142' }, { run: true, venues: true });
  assert.deepEqual(jobs.jobs.map(j => j.id), ['2026-11-24@19:00']);
  const s = t.app.appState(phone.device).state;
  assert.equal(s.telegram, false);
  // Started again on the same settings: the same owner, and the phone still linked.
  const again = makeBot({ store: t.store });
  assert.equal(again.app.owner(), 0);
  assert.ok(again.app.appAuth(phone.token));
  assert.ok(!again.logs.includes('This bot answers to the iPhone app alone (Telegram is off).'));      // said once, when it began
  await again.app.announce();
  assert.match(again.logs[again.logs.length - 1], /One phone is linked\.$/);
});

test('a bot whose owner is a Telegram chat keeps that owner, and its phones, with Telegram off', async () => {
  const before = makeBot({ store: memStore({ v: 4, owner: OWNER }), telegram: true });
  await before.app.handleUpdate(say(OWNER, '/app'));
  const code = /Code: <code>(\d{6})<\/code>/.exec(before.tg.last().text)[1];
  const r = before.app.appPair({ code, name: 'iPhone' });
  assert.equal(r.status, 200);
  const off = makeBot({ store: before.store });
  assert.equal(off.app.owner(), OWNER);
  assert.ok(off.app.appAuth(r.body.token));
  assert.equal(off.store.load().owner, OWNER);
  assert.ok(!off.logs.some(l => /answers to the iPhone app alone/.test(l)));
});

test('TELEGRAM_CHAT_ID takes over a bot that answered to the app alone, with the phones linked to it', async () => {
  const t = makeBot();
  const phone = linkByPc(t);
  const on = makeBot({ store: t.store, env: { TELEGRAM_CHAT_ID: String(OWNER) }, telegram: true });
  assert.equal(on.app.owner(), OWNER);
  assert.equal(on.store.load().owner, OWNER);
  assert.ok(on.app.appAuth(phone.token));
  assert.equal(on.store.load().apps[0].owner, OWNER);
  assert.ok(on.logs.some(l => /^TELEGRAM_CHAT_ID now names the owner of this bot/.test(l)));
  // A chat that is not the owner cannot claim a bot that answers to the app alone with /start.
  const claim = makeBot({ store: t.store, telegram: true });
  await claim.app.handleUpdate(say(777, '/start'));
  assert.equal(claim.app.owner(), OWNER);
});

test('with Telegram on and the app alone the owner, /start claims nothing', async () => {
  const t = makeBot();
  const on = makeBot({ store: t.store, telegram: true });
  await on.app.handleUpdate(say(777, '/start'));
  assert.equal(on.app.owner(), 0);
  assert.equal(on.tg.last().text, 'This bot is private.');
});

test('a phone linked already gives a code for another; the new one is said to the phones before it; and one unlinks another', async () => {
  const t = makeBot();
  const first = linkByPc(t, 'iPhone');
  await ask(t, first, 'push', { token: 'ExponentPushToken[first-phone]' });
  const r = await ask(t, first, 'pair/code');
  assert.equal(r.status, 200);
  assert.match(r.body.pair.code, /^\d{6}$/);
  assert.deepEqual({ ...r.body.pair, code: null, until: null }, { code: null, until: null, minutes: 10, linked: 1, max: 5 });
  assert.equal(r.body.pair.until, at(NOON) + 10 * 60000);
  assert.ok(r.body.state, 'the state comes with it, as with every request');
  assert.ok(t.logs.includes('A code for linking a phone was given to a linked phone (iPhone).'));
  const second = t.app.appPair({ code: r.body.pair.code, name: 'iPad' });
  assert.equal(second.status, 200);
  await settle();
  assert.deepEqual(t.pushes, [{ tokens: ['ExponentPushToken[first-phone]'], title: 'Phone linked', body: 'iPad can now reach your bot. Not yours? Unlink it in Settings.' }]);
  // The code worked once.
  assert.equal(t.app.appPair({ code: r.body.pair.code, name: 'Another' }).status, 400);
  // The first phone unlinks the second: its token opens nothing any more.
  const ipad = second.body.device.id;
  assert.deepEqual((await ask(t, first, 'unpair/other', { id: 'nothing!' })).body, { ok: false, why: 'To unlink another phone, send its id, as the state\'s devices list it.' });
  assert.deepEqual((await ask(t, first, 'unpair/other', { id: first.id })).body, { ok: false, why: 'That phone is not linked.' });      // itself: that is unpair
  const gone = await ask(t, first, 'unpair/other', { id: ipad });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.state.devices.map(d => d.name), ['iPhone']);
  assert.equal(t.app.appAuth(second.body.token), null);
  assert.ok(t.logs.includes('A phone was unlinked from the app by another (iPhone): iPad.'));
  assert.deepEqual((await ask(t, first, 'unpair/other', { id: ipad })).body, { ok: false, why: 'That phone is not linked.' });
});

test('your PC\'s code: forget unlinks every phone first; a new code takes the place of the one waiting', async () => {
  const t = makeBot();
  const a = linkByPc(t, 'A');
  const one = t.app.pairFromAgent({});
  const two = t.app.pairFromAgent({ forget: 'yes' });                      // only true unlinks
  assert.equal(two.forgot, undefined);
  assert.equal(t.app.appPair({ code: one.code === two.code ? 'x' : one.code, name: 'B' }).status, 400);        // replaced
  assert.ok(t.app.appAuth(a.token));
  const three = t.app.pairFromAgent({ forget: true });
  assert.deepEqual({ linked: three.linked, max: three.max, forgot: three.forgot, minutes: three.minutes }, { linked: 0, max: 5, forgot: 1, minutes: 10 });
  assert.equal(t.app.appAuth(a.token), null);
  assert.ok(t.logs.includes('Unlinked the phone linked to the app (asked by your PC).'));
  assert.equal(t.app.appPair({ code: three.code, name: 'B' }).status, 200);
});

test('POST /agent/pair: only for your PC, by its own door, and a 404 from a server without it', async () => {
  const t = makeBot();
  const server = serverFor(t.app, { token: AGENT });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, auth) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    assert.equal((await post('/agent/pair', '{}')).status, 401);
    const phone = linkByPc(t);
    assert.equal((await post('/agent/pair', '{}', `Bearer ${phone.token}`)).status, 401);          // a phone's token opens nothing of the PC's
    const got = await post('/agent/pair', '{}', `Bearer ${AGENT}`);
    assert.equal(got.status, 200);
    assert.match(got.json.code, /^\d{6}$/);
    assert.deepEqual({ ...got.json, code: null, until: null }, { ok: true, code: null, until: null, minutes: 10, linked: 1, max: 5 });
    assert.equal((await post('/agent/pair', '', `Bearer ${AGENT}`)).status, 200);                      // no body is no forget
    assert.equal((await post('/agent/pair', 'nope', `Bearer ${AGENT}`)).status, 400);
    assert.ok(t.app.appAuth(phone.token));
    const forgot = await post('/agent/pair', '{"forget":true}', `Bearer ${AGENT}`);
    assert.equal(forgot.json.forgot, 1);
    assert.equal(t.app.appAuth(phone.token), null);
  } finally { await new Promise(r => server.close(r)); }
  // A server built without the handler says there is no such thing.
  const bare = createServer({ getJobs: () => ({ jobs: [] }), onResult: () => ({ ok: true }), token: AGENT });
  await new Promise(r => bare.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${bare.address().port}/agent/pair`, { method: 'POST', headers: { authorization: `Bearer ${AGENT}` }, body: '{}' });
    assert.equal(res.status, 404);
  } finally { await new Promise(r => bare.close(r)); }
});

test('with Telegram off, a booking\'s result is still a note and a notification, and nothing waits on Telegram', async () => {
  const t = makeBot({ store: memStore({ v: 4, owner: OWNER }) });
  const phone = linkByPc(t);
  await ask(t, phone, 'push', { token: 'ExponentPushToken[the-phone]' });
  t.clock.t = at('2026-11-17T22:00:10Z');
  assert.deepEqual(await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 }), { ok: true });
  await settle();
  const s = t.app.appState(phone.device).state;
  assert.deepEqual(s.notes.map(n => [n.kind, n.title]), [['booked', 'Court 3 booked']]);
  assert.equal(s.results.find(r => r.id === '2026-11-24@16:00').status, 'booked');
  assert.deepEqual(t.pushes.map(p => p.title), ['Court 3 booked']);
});
