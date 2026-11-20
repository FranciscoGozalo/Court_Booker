'use strict';
// Waking your PC from Telegram: the magic packet, where it goes, and the Wake button.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const { readMac, magicPacket, publicIPv4, sendWake } = require('../lib/wake');
const { createApp } = require('../app');
const { createServer } = require('../lib/server');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';
const ENV = { WAKE_MAC: '44:AF:28:7A:1A:5C', WAKE_PORT: '40009' };

test('the network card address is read in the usual spellings, and nothing else', () => {
  assert.equal(readMac('44:AF:28:7A:1A:5C'), '44af287a1a5c');
  assert.equal(readMac('44-af-28-7a-1a-5c'), '44af287a1a5c');
  assert.equal(readMac('44af287a1a5c'), '44af287a1a5c');
  for (const bad of ['', '44:af:28:7a:1a', '44:af-28:7a:1a:5c', 'zz:af:28:7a:1a:5c', '44:af:28:7a:1a:5c:00']) assert.equal(readMac(bad), null, bad);
});

test('the magic packet: six 0xFF bytes, then the card address sixteen times', () => {
  const p = magicPacket('44af287a1a5c');
  assert.equal(p.length, 102);
  assert.ok(p.subarray(0, 6).every(b => b === 0xff));
  for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), '44af287a1a5c');
});

test('only a public IPv4 address counts as home', () => {
  assert.equal(publicIPv4('2.96.64.17'), '2.96.64.17');
  assert.equal(publicIPv4(' 81.2.69.160 '), '81.2.69.160');
  for (const bad of ['192.168.86.130', '10.0.0.1', '172.20.1.1', '127.0.0.1', '100.72.1.1', '169.254.1.1', '0.0.0.0', '239.1.1.1', '2a00:23c7::1', 'nonsense', '']) {
    assert.equal(publicIPv4(bad), null, bad);
  }
});

test('the packet really goes out, three times, to the address and port given', async () => {
  const got = [];
  const listener = dgram.createSocket('udp4');
  listener.on('message', m => got.push(m.toString('hex')));
  await new Promise(r => listener.bind(0, '127.0.0.1', r));
  try {
    const n = await sendWake({ host: '127.0.0.1', port: listener.address().port, mac: '44af287a1a5c' }, { gapMs: 5 });
    assert.equal(n, 3);
    for (let i = 0; i < 50 && got.length < 3; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(got.length, 3);
    assert.equal(got[0], magicPacket('44af287a1a5c').toString('hex'));
  } finally { listener.close(); }
});

// ---------- the Wake button ----------

function makeApp(t0, env = ENV, state = { owner: OWNER }) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const store = memStore(state);
  const woken = [];
  const app = createApp({ now: () => clock.t, tg, store, pictures: PICTURES, linked: true, env, wake: async to => { woken.push(to); return 3; } });
  return { app, tg, clock, store, woken };
}
let tapId = 1;
const tap = (app, data, messageId) => app.handleUpdate({
  update_id: 1, callback_query: { id: `wk${tapId++}`, data, from: { id: OWNER }, message: { message_id: messageId, chat: { id: OWNER, type: 'private' } } },
});
const labels = call => call.extra.reply_markup.inline_keyboard.flat().map(b => b.text);

test('the bot learns home from the PC\'s pings, and offers Wake only while the PC is not awake', async () => {
  const { app, tg, clock, store } = makeApp(`${TUE}T12:00:00Z`);
  app.pingFromAgent({ ip: '192.168.86.130' });                     // not a home address: ignored
  assert.equal(app.wakeState(), 'no-home');
  app.pingFromAgent({ ip: '2.96.64.17' });
  assert.equal(app.wakeState(), 'ready');
  assert.deepEqual(store.load().home, { ip: '2.96.64.17', at: clock.t });
  await app.tick();
  await app.handleUpdate(say(OWNER, '/menu'));
  assert.ok(!labels(tg.last()).includes('Wake my PC'));               // awake: nothing to wake
  // It goes to sleep: the redrawn menu gets the button, first.
  clock.t += 5 * 60000; await app.tick(); await app.tick();
  const card = tg.last();
  assert.equal(card.photo, 'upload:banner-home-asleep.jpg');
  assert.equal(card.extra.reply_markup.inline_keyboard[0][0].callback_data, 'wk');
  // The address is kept across a restart.
  const again = createApp({ now: () => clock.t, tg, store, pictures: PICTURES, linked: true, env: ENV, wake: async () => 3 });
  assert.equal(again.wakeState(), 'ready');
});

test('tapping Wake sends the packet home, says so, and is not repeated straight away', async () => {
  const { app, tg, clock, woken } = makeApp(`${TUE}T12:00:00Z`);
  app.pingFromAgent({ ip: '2.96.64.17' }); await app.tick();
  clock.t += 10 * 60000; await app.tick();                           // asleep
  await app.handleUpdate(say(OWNER, '/menu'));
  const card = tg.last();
  await tap(app, 'wk', card.id);
  assert.deepEqual(woken, [{ host: '2.96.64.17', port: 40009, mac: '44af287a1a5c' }]);
  assert.equal(tg.answers.at(-1), 'Wake-up sent');
  assert.match(tg.last().text, /Wake-up sent at 12:10\. The dot turns green when your PC answers/);
  assert.equal(tg.last().id, card.id);
  await tap(app, 'wk', card.id);
  assert.equal(woken.length, 1);
  assert.equal(tg.answers.at(-1), 'Sent a moment ago. Give it a minute.');
  // The PC answers: green dot, no button, no note.
  clock.t += 40000; app.pingFromAgent({ ip: '2.96.64.17' }); await app.tick();
  assert.equal(tg.last().photo, 'upload:banner-home-awake.jpg');
  assert.match(tg.last().text, /Your PC · Awake$/);
  assert.ok(!labels(tg.last()).includes('Wake my PC'));
  // /wake now just says it is awake.
  await app.handleUpdate(say(OWNER, '/wake'));
  assert.equal(woken.length, 1);
  assert.match(tg.last().text, /Your PC · Awake/);
});

test('without WAKE_MAC, or before the PC has been in touch, waking explains why not', async () => {
  const off = makeApp(`${TUE}T12:00:00Z`, {});
  off.app.pingFromAgent({ ip: '2.96.64.17' });
  off.clock.t += 10 * 60000;
  await off.app.handleUpdate(say(OWNER, '/wake'));
  assert.match(off.tg.last().text, /Waking is not set up: add WAKE_MAC on Railway\./);
  assert.equal(off.woken.length, 0);
  await off.app.handleUpdate(say(OWNER, '/status'));
  assert.match(off.tg.last().text, /Wake from Telegram: not set up/);
  const fresh = makeApp(`${TUE}T12:00:00Z`);
  await fresh.app.handleUpdate(say(OWNER, '/wake'));
  assert.match(fresh.tg.last().text, /Can’t wake your PC: it hasn’t been in touch\./);
  await fresh.app.handleUpdate(say(OWNER, '/status'));
  assert.match(fresh.tg.last().text, /Wake from Telegram: waiting for your PC/);
});

test('a failed send is reported, and can be tried again at once', async () => {
  const clock = { t: at(`${TUE}T12:00:00Z`) };
  const tg = fakeTelegram(clock);
  let fail = true, sent = 0;
  const app = createApp({ now: () => clock.t, tg, store: memStore({ owner: OWNER }), pictures: PICTURES, linked: true, env: ENV,
    wake: async () => { if (fail) throw new Error('EHOSTUNREACH'); sent++; return 3; } });
  app.pingFromAgent({ ip: '2.96.64.17' });
  clock.t += 10 * 60000;
  await app.handleUpdate(say(OWNER, '/wake'));
  assert.match(tg.last().text, /Couldn’t send the wake-up/);
  fail = false;
  await app.handleUpdate(say(OWNER, '/wake'));
  assert.equal(sent, 1);
  assert.match(tg.last().text, /Wake-up sent at/);
});

test('the server hands the caller\'s address (Railway\'s X-Real-IP) to the ping and the jobs', async () => {
  const seen = [];
  const server = createServer({ token: 'a-long-random-line-for-testing-only', getJobs: from => { seen.push(['jobs', from.ip]); return { jobs: [] }; },
    onResult: async () => ({ ok: true }), onPing: from => { seen.push(['ping', from.ip]); return {}; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Bearer a-long-random-line-for-testing-only' };
  try {
    await fetch(`${base}/agent/ping`, { method: 'POST', headers: { ...auth, 'x-real-ip': '2.96.64.17' }, body: '{}' });
    await fetch(`${base}/agent/jobs`, { headers: { ...auth, 'x-forwarded-for': '81.2.69.160, 10.0.0.1' } });
    await fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: '{}' });
    assert.deepEqual(seen, [['ping', '2.96.64.17'], ['jobs', '81.2.69.160'], ['ping', '127.0.0.1']]);
  } finally { await new Promise(r => server.close(r)); }
});
