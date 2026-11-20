'use strict';
// The iPhone app's way in (docs/app-api.md): linking a phone, what the app is shown, what it can
// ask for, and the notes and notifications. Whatever the app asks goes through the functions the
// Telegram commands use, so many of these checks put the two side by side.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp, loadState, backupLine } = require('../app');
const { createServer, signedText, readPublicKey } = require('../lib/server');
const { createExpoPush, mask, EXPO_URL, TIMEOUT_MS } = require('../lib/push');
const A = require('../lib/appapi');
const G = require('../lib/glasgowclub');
const M = require('../lib/messages');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const FRI = '2026-11-20';
const NOON = `${TUE}T12:00:00Z`;
const AGENT = 'a-long-random-line-for-testing-only';
const HOME = { ip: '81.2.69.142' };
const WAKE = { WAKE_MAC: '44:AF:28:7A:1A:5C', WAKE_PORT: '40009' };
const SHEET_G = `https://glasgowclub.gladstonego.cloud/book/calendar/S0815?activityDate=${FRI}T00:00:00.000Z`;
const TITLE = 'Gorbals · Fri 20 Nov · 18:00–19:00 · Court 3';
const PUSH_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const settle = () => new Promise(r => setTimeout(r, 5));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// What the stand-in for Glasgow Club shows free on any day: court 3 at 18:00 and 19:00, court 4 at 18:00.
const FREE = [
  { start: 1080, end: 1140, court: 3, name: 'Tennis Hall Court 3', opensAt: null },
  { start: 1080, end: 1140, court: 4, name: 'Tennis Hall Court 4', opensAt: null },
  { start: 1140, end: 1200, court: 3, name: 'Tennis Hall Court 3', opensAt: null },
];
// The bot with stand-ins for Telegram, storage, the clock, Glasgow Club and the push service.
// `store`: the settings file to start from (the same one again is the bot after a restart).
function makeBot(t0 = NOON, { state = {}, env = {}, linked = true, glasgow = null, pcLookMs = 2000, pcHoldMs = 25000, push = null, wake = null, store = null } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const logs = [], pushes = [], woke = [];
  store = store || memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], ...state });
  const reader = glasgow ? glasgow(clock) : { asked: [], day: async (key, date) => { reader.asked.push(`${key}:${date}`); return { at: clock.t, slots: FREE.map(s => ({ ...s })), listed: 12 }; }, peek: () => null, health: () => null };
  const app = createApp({
    now: () => clock.t, tg, store, pictures: PICTURES, linked, env, glasgow: reader, pcLookMs, pcHoldMs, log: l => logs.push(l),
    push: push || (async (tokens, message) => { pushes.push({ tokens, ...message }); }),
    wake: wake || (async to => { woke.push(to); return 3; }),
  });
  return { app, tg, clock, store, logs, pushes, woke, glasgow: reader };
}
// /app in Telegram, and the code it answers with.
async function codeFrom(t) {
  await t.app.handleUpdate(say(OWNER, '/app'));
  return /Code: <code>(\d{6})<\/code>/.exec(t.tg.last().text)[1];
}
const wrongFor = code => (code === '000000' ? '111111' : '000000');
// A phone linked the whole way: /app, the code, the token.
async function linkPhone(t, name = 'Francisco\'s iPhone') {
  const r = t.app.appPair({ code: await codeFrom(t), name });
  assert.equal(r.status, 200);
  await settle();                                              // Telegram is told a phone was linked
  return { token: r.body.token, id: r.body.device.id, device: t.app.appAuth(r.body.token) };
}
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);
// The app reads a day, so it has been shown what is free there (a hold may only be asked for such a court).
async function seeFree(t, phone, centre = 'g', date = FRI) {
  const r = await ask(t, phone, 'indoor/look', { centre, date });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.look;
}
const STATE_KEYS = ['now', 'bot', 'venue', 'venues', 'clubspark', 'allowance', 'paused', 'kept', 'pc', 'release', 'later', 'open', 'plan', 'once', 'order', 'results', 'run', 'indoor', 'card', 'hold', 'notes', 'devices'];
const HOLD_KEYS = ['id', 'startedBy', 'centre', 'centreName', 'date', 'start', 'end', 'court', 'courtName', 'stage', 'live', 'ended', 'price', 'until', 'heardAt', 'title', 'lines', 'can', 'links'];
// The state as a phone is shown it. Whenever it is looked at here, it is also checked to be
// whole: the contract's fields and no others, and nothing that JSON would drop on the way.
const stateOf = (t, phone) => {
  const { etag, state } = t.app.appState(phone.device);
  assert.deepEqual(Object.keys(state), STATE_KEYS);
  if (state.hold) assert.deepEqual(Object.keys(state.hold), HOLD_KEYS);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(etag, A.etagOf(state));
  return state;
};
const refused = (status, why) => ({ status, body: { ok: false, why } });
// Every venue as the state lists it on a day: the seven parks on ClubSpark, then Glasgow Club's two.
const PARK_ADDRESSES = [['drumchapel', 'Drumchapel Park', 'DrumchapelParkTennisCourts'], ['garrowhill', 'Garrowhill Park', 'GarrowhillPark'], ['kelvingrove', 'Kelvingrove Park', 'KelvingroveParkTennisCourts'],
  ['knightswood', 'Knightswood Park', 'KnightswoodParkTennisCourts'], ['maryhill', 'Maryhill Park', 'MaryhillParkTennisCourts'], ['queenspark', 'Queens Park', 'QueensParkTennisCourtsGlasgow'], ['victoriapark', 'Victoria Park', 'VictoriaParkTennis']];
const venuesOn = date => [
  ...PARK_ADDRESSES.map(([key, name, address]) => ({ key, name, club: 'clubspark', types: ['outdoor'], centre: null, schedule: key === 'kelvingrove', notYet: [], note: null,
    site: `https://clubspark.lta.org.uk/${address}/Booking/BookByDate#?date=${date}` })),
  { key: 'gorbals', name: 'Gorbals', club: 'glasgow', types: ['indoor'], centre: 'g', schedule: false, notYet: [], note: null, site: `https://glasgowclub.gladstonego.cloud/book/calendar/S0815?activityDate=${date}T00:00:00.000Z` },
  { key: 'scotstoun', name: 'Scotstoun', club: 'glasgow', types: ['indoor'], centre: 's', schedule: false, notYet: ['outdoor'], note: "Scotstoun's outdoor courts are not available yet.",
    site: `https://glasgowclub.gladstonego.cloud/book/calendar/SA011?activityDate=${date}T00:00:00.000Z` },
];
let tapId = 1;
const tap = (app, data, messageId, { chat = OWNER } = {}) => app.handleUpdate({
  update_id: 1, callback_query: { id: `app${tapId++}`, data, from: { id: chat }, message: { message_id: messageId, chat: { id: chat, type: 'private' } } },
});
const buttons = call => call.extra.reply_markup.inline_keyboard.flat();
const texts = call => buttons(call).map(b => b.text);
const lastAnswer = t => t.tg.answers[t.tg.answers.length - 1];

// The bot's HTTP server with the app's door open, as index.js sets it up. What the server logs
// goes with the bot's own log (t.logs).
async function withServer(t, fn, extra = {}) {
  const a = t.app;
  const appApi = { hello: a.appHello, pair: a.appPair, auth: a.appAuth, state: a.appState, ask: a.appAsk };
  const server = createServer({ getJobs: a.jobsForAgent, onResult: a.resultFromAgent, onPing: a.pingFromAgent, onLook: a.lookFromAgent, onHold: a.holdFromAgent, onProgress: a.progressFromAgent,
    token: AGENT, appApi, appPollMs: 15, log: l => t.logs.push(l), ...(typeof extra === 'function' ? extra(appApi) : extra) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ base, port, server, call, get: (path, opts) => call('GET', path, opts), post: (path, body = {}, opts = {}) => call('POST', path, { ...opts, body }) });
  } finally { await new Promise(r => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }); }
}
// A request written straight onto a socket, for what fetch will not send (half a request, a body
// far too large). Resolves when the server closes the connection, or after `giveUpMs`.
function raw(port, text, giveUpMs = 3000) {
  const net = require('node:net');
  return new Promise(resolve => {
    const began = Date.now();
    const s = net.connect(port, '127.0.0.1');
    let out = '', done = false;
    const end = closed => { if (done) return; done = true; s.destroy(); resolve({ out, closed, ms: Date.now() - began }); };
    s.on('data', d => { out += d; });
    s.on('error', () => {});
    s.on('close', () => end(true));
    s.on('connect', () => s.write(text));
    setTimeout(() => end(false), giveUpMs).unref();
  });
}

// ---------- the pure parts (lib/appapi.js) ----------

test('a caption becomes plain text: the tags go, and what was escaped is itself again', () => {
  assert.equal(A.plain('<b>Booked · Court 3</b>\nGate code: <code>2433</code>  (tap to copy)'), 'Booked · Court 3\nGate code: 2433  (tap to copy)');
  assert.equal(A.plain('It did not work: &lt;b&gt;x&lt;/b&gt; &amp; more.'), 'It did not work: <b>x</b> & more.');
  assert.equal(A.plain('3 &lt; 4, and &amp;lt; stays as typed'), '3 < 4, and &lt; stays as typed');
  assert.equal(A.plain(M.esc('a < b > c & d')), 'a < b > c & d');
  assert.equal(A.plain(null), '');
});

test('a token is 32 random bytes; only its SHA-256 is needed to know the phone again', () => {
  const a = A.newToken(), b = A.newToken();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a.token, 'base64url').length, 32);
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, crypto.createHash('sha256').update(a.token).digest('hex'));
  const devices = [{ id: 'aaaaaaaa', hash: a.hash }, { id: 'bbbbbbbb', hash: b.hash }];
  assert.equal(A.findDevice(devices, a.token).id, 'aaaaaaaa');
  assert.equal(A.findDevice(devices, b.token).id, 'bbbbbbbb');
  for (const bad of [A.newToken().token, a.hash, a.token.slice(1), `${a.token}x`, '', null, undefined, 7, AGENT]) assert.equal(A.findDevice(devices, bad), null);
  assert.equal(A.findDevice([], a.token), null);
  assert.equal(A.findDevice([{ id: 'cccccccc', hash: 'not a hash' }, null], a.token), null);
  assert.equal(A.sameText('482913', '482913'), true);
  assert.equal(A.sameText('482913', '482914'), false);
  assert.equal(A.sameText('', '482913'), false);
});

test('a pairing code: six digits, ten minutes, one use, and five wrong tries cancel it', () => {
  const p = A.createPairing({ random: () => 7 });
  assert.deepEqual(p.check('000007', 0), { why: 'none', left: 0 });                      // no code yet
  assert.deepEqual(p.issue(1000), { code: '000007', until: 1000 + 10 * 60000 });
  assert.deepEqual(p.check('000007', 2000), { why: null, left: 5 });                     // right; still waiting until it is used
  assert.deepEqual(p.check(' 000 007 ', 2000), { why: null, left: 5 });                  // spaces, or a number, are read kindly
  assert.deepEqual(p.check(7, 2000), { why: null, left: 5 });
  assert.equal(p.waiting(2000), true);
  for (const [given, left] of [['000008', 4], [undefined, 3], [null, 2], [{ code: 1 }, 1]]) assert.deepEqual(p.check(given, 3000), { why: 'wrong', left });
  assert.deepEqual(p.check('000007', 3000), { why: null, left: 1 });                     // four wrong tries: the code still stands
  assert.deepEqual(p.check('7', 3000), { why: 'wrong', left: 0 });                       // the fifth cancels it
  assert.deepEqual(p.check('000007', 3000), { why: 'none', left: 0 });
  // Ten minutes, to the millisecond.
  p.issue(0);
  assert.deepEqual(p.check('000007', 10 * 60000 - 1), { why: null, left: 5 });
  assert.deepEqual(p.check('000007', 10 * 60000), { why: 'expired', left: 0 });
  assert.deepEqual(p.check('999999', 11 * 60000), { why: 'expired', left: 0 });
  assert.equal(p.waiting(11 * 60000), false);
  // One use; and a new code replaces the one before.
  p.issue(0); p.use();
  assert.deepEqual(p.check('000007', 1), { why: 'none', left: 0 });
  const real = A.createPairing();
  for (let i = 0; i < 50; i++) assert.match(real.issue(0).code, /^\d{6}$/);
});

test('at most ten tries at pairing in any ten minutes', () => {
  const l = A.createLimiter();
  for (let i = 0; i < 10; i++) assert.equal(l.allow(i * 1000), true, `try ${i + 1}`);
  assert.equal(l.allow(9500), false);
  assert.equal(l.allow(10 * 60000 - 1), false);                // ten minutes after the first, less a millisecond
  assert.equal(l.allow(10 * 60000), true);                     // the first has aged out: one more
  assert.equal(l.allow(10 * 60000 + 1), false);                // tries that were turned away did not count, but this window is full again
  assert.equal(l.allow(10 * 60000 + 1000), true);
});

test('the etag is a fingerprint of the state without the clock', () => {
  const s = { now: 1, bot: '2.8', paused: false, devices: [{ id: 'a', me: true }] };
  assert.match(A.etagOf(s), /^[0-9a-f]{40}$/);
  assert.equal(A.etagOf(s), A.etagOf({ ...s, now: 999 }));
  assert.notEqual(A.etagOf(s), A.etagOf({ ...s, paused: true }));
  assert.notEqual(A.etagOf(s), A.etagOf({ ...s, devices: [{ id: 'a', me: false }] }));
  assert.equal(s.now, 1);                                      // and the state is left as it was
});

test('what each request must look like, with a plain sentence when it does not', () => {
  // A one-off: the same slot rules as /book, in the same words.
  assert.deepEqual(A.readOnce({ date: '2026-11-25', start: 1140, hours: 2 }), { date: '2026-11-25', start: 1140, hours: 2 });
  assert.deepEqual(A.readOnce({ date: '2026-11-25', start: 1170, hours: 1 }), { date: '2026-11-25', start: 1170, hours: 1 });
  assert.deepEqual(A.readOnce({ date: '2026-11-25', start: 1155, hours: 1 }), { why: 'Slots start on the hour. Try a time like 19:00.' });
  assert.deepEqual(A.readOnce({ date: '2026-11-25', start: 1410, hours: 2 }), { why: 'That slot runs past midnight. Try an earlier time.' });
  for (const bad of [{}, { date: '25 nov', start: 1140, hours: 2 }, { date: '2026-11-31', start: 1140, hours: 2 }, { date: '2026-11-25', start: '1140', hours: 2 }, { date: '2026-11-25', start: 1140 },
    { date: '2026-11-25', start: 1140, hours: 3 }, { date: '2026-11-25', start: 1140.5, hours: 1 }, { date: '2026-11-25', start: -60, hours: 1 }, { date: '2026-11-25', start: 1440, hours: 1 }]) {
    assert.deepEqual(A.readOnce(bad), { why: A.WHY.once }, JSON.stringify(bad));
  }
  for (const read of [A.readOnce, A.readOnceRemove, A.readPlan, A.readPlanRemove, A.readOrder, A.readPause, A.readLook, A.readHold, A.readHoldOrder, A.readPush]) {
    for (const bad of [null, undefined, 'x', 7, [1]]) assert.deepEqual(read(bad), { why: 'The request body must be a JSON object.' });
  }
  for (const read of [A.readCard, A.readForget]) {
    for (const bad of [null, undefined, 'x', 7, [1]]) assert.deepEqual(read(bad), { why: 'The request body must be a JSON object.' });
  }
  assert.deepEqual(A.readOnceRemove({ date: '2026-11-25', start: 1140 }), { date: '2026-11-25', start: 1140 });
  assert.deepEqual(A.readOnceRemove({ date: '2026-11-25' }), { why: A.WHY.onceRemove });
  // Every week: as /set.
  assert.deepEqual(A.readPlan({ day: 'thu', start: 1140, hours: 2 }), { day: 'thu', start: 1140, hours: 2 });
  assert.deepEqual(A.readPlan({ day: 'Thursday', start: 1140, hours: 1 }), { day: 'thu', start: 1140, hours: 1 });
  assert.deepEqual(A.readPlan({ day: 'thu', start: 1145, hours: 1 }), { why: 'Slots start on the hour. Try a time like 19:00.' });
  assert.deepEqual(A.readPlan({ day: 'thu', start: 1380, hours: 2 }), { why: 'That slot runs past midnight. Try an earlier time.' });
  for (const bad of [{ day: 'someday', start: 1140, hours: 1 }, { day: 4, start: 1140, hours: 1 }, { day: 'thu', hours: 1 }, { day: 'thu', start: 1140, hours: '2h' }]) assert.deepEqual(A.readPlan(bad), { why: A.WHY.plan });
  assert.deepEqual(A.readPlanRemove({ day: 'thu' }), { day: 'thu' });
  assert.deepEqual(A.readPlanRemove({ day: 'ALL' }), { day: 'all' });
  assert.deepEqual(A.readPlanRemove({ day: 'x' }), { why: A.WHY.planRemove });
  // Court order: as /order. Any left out go last; a court twice, or one that is not a court, is refused.
  assert.deepEqual(A.readOrder({ order: [3, 6, 1, 2, 4, 5] }), { order: [3, 6, 1, 2, 4, 5] });
  assert.deepEqual(A.readOrder({ order: [4, 5] }), { order: [4, 5, 1, 2, 3, 6] });
  for (const bad of [{}, { order: [] }, { order: '345' }, { order: [3, 3] }, { order: [12] }, { order: [0] }, { order: [1, 2, 3, 4, 5, 6, 1] }, { order: ['3'] }, { order: [1.5] }]) assert.deepEqual(A.readOrder(bad), { why: 'Courts 1 to 6, each once.' }, JSON.stringify(bad));
  assert.deepEqual(A.readPause({ paused: true }), { paused: true });
  assert.deepEqual(A.readPause({ paused: 'yes' }), { why: A.WHY.pause });
  // Indoor: only the shapes are judged here; which days and times are on offer is for the bot to say.
  assert.deepEqual(A.readLook({ centre: 'g', date: FRI }), { centre: 'g', date: FRI, fresh: false });
  assert.deepEqual(A.readLook({ centre: 's', date: FRI, fresh: true }), { centre: 's', date: FRI, fresh: true });
  assert.deepEqual(A.readLook({ centre: 'x', date: FRI }), { why: A.WHY.centre });
  assert.deepEqual(A.readLook({ date: FRI }), { why: A.WHY.look });
  assert.deepEqual(A.readLook({ centre: 'g', date: 'friday' }), { why: A.WHY.look });
  assert.deepEqual(A.readHold({ centre: 'g', date: FRI, start: 1080, court: 3 }), { centre: 'g', date: FRI, start: 1080, court: 3 });
  assert.deepEqual(A.readHold({ centre: 'k', date: FRI, start: 1080, court: 3 }), { why: A.WHY.centre });
  for (const bad of [{ centre: 'g', date: FRI, start: 1080 }, { centre: 'g', date: FRI, start: '18:00', court: 3 }, { centre: 'g', start: 1080, court: 3 }, { date: FRI, start: 1080, court: 3 }]) assert.deepEqual(A.readHold(bad), { why: A.WHY.hold });
  assert.deepEqual(A.readHoldOrder({ id: 'a1b2c3d4e5f6', what: 'done' }), { id: 'a1b2c3d4e5f6', what: 'done' });
  for (const bad of [{ id: 'a1b2c3d4e5f6', what: 'paid' }, { id: 'A1B2C3D4E5F6', what: 'done' }, { what: 'release' }, { id: 12, what: 'release' }]) assert.deepEqual(A.readHoldOrder(bad), { why: A.WHY.holdOrder });
  // Pay (version 2.9) has its own fields, and its own sentence; the sealed code is judged by its shape only (test/pay.test.js).
  assert.deepEqual(A.readHoldOrder({ id: 'a1b2c3d4e5f6', what: 'pay' }), { why: A.WHY.pay });
  assert.deepEqual(A.readPush({ token: PUSH_TOKEN }), { token: PUSH_TOKEN });
  assert.deepEqual(A.readPush({ token: 'ExpoPushToken[abc-DEF_123]' }), { token: 'ExpoPushToken[abc-DEF_123]' });
  assert.deepEqual(A.readPush({ token: null }), { token: null });
  for (const bad of [{}, { token: '' }, { token: 'abc' }, { token: 'ExponentPushToken[]' }, { token: 'ExponentPushToken[a b]' }, { token: `${PUSH_TOKEN} ` }, { token: 7 }]) assert.deepEqual(A.readPush(bad), { why: A.WHY.push });
});

// ---------- what is kept ----------

test('settings saved before the app existed load as they were, and the state version is still 4', () => {
  const old = {
    v: 4, owner: OWNER, plan: { thu: { start: 1140, hours: 2 } }, once: [{ date: '2026-11-25', start: 1140, hours: 2 }], order: [4, 3, 5, 2, 6, 1], paused: true,
    results: { '2026-11-19@19:00': { id: '2026-11-19@19:00', status: 'booked', date: '2026-11-19', start: 1140, end: 1260, court: '3', gate: '2433', at: 5 } },
    sent: { 'ready:1': 3 }, pics: { booked: { hash: 'h', id: 'i' } }, lastSeen: 7, lastRun: 6, home: { ip: '81.2.69.142', at: 2 },
  };
  const s = loadState(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(s, { ...old, apps: [], notes: [] });
  assert.equal(s.v, 4);
  assert.equal(loadState(null).v, 4);
  assert.deepEqual([loadState(null).apps, loadState(null).notes], [[], []]);
  // The one-line backup says nothing of the phones: a line that is copied about opens no door.
  const { hash } = A.newToken();
  const linked = loadState({ ...old, apps: [{ id: 'a1b2c3d4', name: 'iPhone', hash, at: 1, seenAt: 2, push: PUSH_TOKEN, owner: OWNER }], notes: [{ id: 'aa11bb22cc', at: 9, kind: 'booked', title: 'Court 3 booked', body: 'x' }] });
  assert.deepEqual(linked.apps, [{ id: 'a1b2c3d4', name: 'iPhone', hash, at: 1, seenAt: 2, push: PUSH_TOKEN, owner: OWNER }]);
  assert.deepEqual(linked.notes, [{ id: 'aa11bb22cc', at: 9, kind: 'booked', title: 'Court 3 booked', body: 'x' }]);
  assert.deepEqual(Object.keys(JSON.parse(backupLine(linked))).sort(), ['once', 'order', 'owner', 'plan', 'v']);
  assert.equal(JSON.parse(backupLine(linked)).v, 4);
  assert.ok(!backupLine(linked).includes(hash));
  // Settings from another version keep the phones (they are checked just as hard) but not the notes.
  const older = loadState({ ...old, v: 3, apps: linked.apps, notes: linked.notes });
  assert.deepEqual([older.apps.length, older.notes, older.results], [1, [], {}]);
});

test('whatever is in the saved file for the phones and the notes is made safe to use', () => {
  const good = { id: 'a1b2c3d4', name: 'iPhone', hash: 'a'.repeat(64), at: 1, seenAt: 2, push: null, owner: OWNER };
  const hash = n => String(n).repeat(64).slice(0, 64);
  for (const junk of [null, 'x', 7, {}, { 0: good }]) assert.deepEqual(loadState({ v: 4, apps: junk }).apps, []);
  const apps = loadState({ v: 4, apps: [
    good,
    null, 'x', 7, [],
    { ...good, id: 'b1b2c3d4', hash: 'short' },                              // no hash to check a token against
    { ...good, id: 'B1B2C3D4', hash: hash(1) },                              // not an id of ours
    { ...good, id: 'a1b2c3d4', hash: hash(2) },                              // the same id twice
    { ...good, id: 'c1b2c3d4' },                                             // the same token twice
    { id: 'd1b2c3d4', hash: hash(3), name: `  <b>Pat's</b>\n\tphone ${'x'.repeat(80)}`, at: 'yesterday', seenAt: {}, push: 'https://evil.example/hook', owner: '42', token: 'kept by mistake', admin: true },
    { id: 'e1b2c3d4', hash: hash(4), name: 12, at: 5, push: PUSH_TOKEN, owner: 4.5 },
    { id: 'f1b2c3d4', hash: hash(5) }, { id: 'f2b2c3d4', hash: hash(6) }, { id: 'f3b2c3d4', hash: hash(7) },
  ] }).apps;
  assert.equal(apps.length, 5);                                              // five phones at most
  assert.deepEqual(apps[0], good);
  assert.deepEqual(apps[1], { id: 'd1b2c3d4', name: '<b>Pat\'s</b> phone '.padEnd(40, 'x'), hash: hash(3), at: 0, seenAt: 0, push: null, owner: null });      // forty characters of a name, and only what a phone is kept as
  assert.deepEqual(apps[2], { id: 'e1b2c3d4', name: 'iPhone', hash: hash(4), at: 5, seenAt: 5, push: PUSH_TOKEN, owner: null });      // whose it is: a chat's number, or not known
  assert.deepEqual(apps.map(d => d.id), ['a1b2c3d4', 'd1b2c3d4', 'e1b2c3d4', 'f1b2c3d4', 'f2b2c3d4']);
  // Notes: only whole ones, of a kind the app knows, the newest first, thirty at most, never too long.
  const note = (n, over = {}) => ({ id: n.toString(16).padStart(10, '0'), at: n, kind: 'warn', title: `t${n}`, body: `b${n}`, ...over });
  for (const junk of [null, 'x', 7, {}]) assert.deepEqual(loadState({ v: 4, notes: junk }).notes, []);
  const notes = loadState({ v: 4, notes: [
    note(1), note(3), note(2), null, 'x', note(4, { kind: 'shout' }), note(5, { at: '5' }), note(6, { title: 6 }), note(7, { body: null }), note(8, { id: '../../etc' }), note(3, { title: 'again' }),
    note(9, { title: 'T'.repeat(500), body: 'B'.repeat(5000), extra: { deep: true } }),
  ] }).notes;
  assert.deepEqual(notes.map(n => n.at), [9, 3, 2, 1]);
  assert.deepEqual([notes[0].title.length, notes[0].body.length, Object.keys(notes[0])], [120, 600, ['id', 'at', 'kind', 'title', 'body']]);
  assert.equal(notes[1].title, 't3');
  assert.equal(loadState({ v: 4, notes: Array.from({ length: 80 }, (_, i) => note(i + 1)) }).notes.length, 30);
  assert.equal(loadState({ v: 4, notes: Array.from({ length: 80 }, (_, i) => note(i + 1)) }).notes[0].at, 80);
});

// ---------- /app in Telegram ----------

test('/app gives a code to link a phone, and /app forget unlinks every phone', async () => {
  const t = makeBot(NOON, { env: { RAILWAY_PUBLIC_DOMAIN: 'court-booker.example.app' } });
  await t.app.handleUpdate(say(OWNER, '/app'));
  const first = t.tg.last().text;
  const code = /Code: <code>(\d{6})<\/code>/.exec(first)[1];
  assert.deepEqual(first.split('\n'), [
    '<b>Link the iPhone app</b>',
    `Code: <code>${code}</code>  (tap to copy)`,
    'Type it into the app within 10 minutes. It works once, and five wrong tries cancel it. A new /app replaces it.',
    'If the app asks where I am: <code>https://court-booker.example.app</code>',
    "The app can do what you do here, and two things more: pay for a court your PC holds, with the card your PC keeps; and see the free courts at Glasgow Life's parks and book one now (at most 4 bookings an hour, only a court it was shown free in the last 15 minutes, never one that costs money).",
    'No phone is linked yet.',
  ]);
  // The code links a phone, and Telegram says so.
  const paired = t.app.appPair({ code, name: 'Pat\'s <iPhone>' });
  assert.equal(paired.status, 200);
  await settle();
  assert.equal(t.tg.last().text, '<b>Phone linked</b>\nPat\'s &lt;iPhone&gt; can now do what you do here, pay for a court your PC holds with the card your PC keeps, and book a court at Glasgow Life\'s parks now (at most 4 an hour, only one it was shown free in the last 15 minutes, never one that costs money). /app forget unlinks every phone.');
  assert.ok(t.logs.includes('A phone was linked to the app: Pat\'s <iPhone>.'));
  // A second /app names the phones linked, and its code replaces the one before.
  const again = await codeFrom(t);
  assert.equal(t.tg.last().text.split('\n')[5], 'Linked now: Pat\'s &lt;iPhone&gt;. /app forget unlinks every phone.');
  const older = await codeFrom(t) === again ? null : again;
  if (older) assert.deepEqual(t.app.appPair({ code: older }).body, { ok: false, why: 'wrong', left: 4 });
  // /app forget: the token is no use any more, and a code that was waiting is cancelled.
  assert.ok(t.app.appAuth(paired.body.token));
  const waiting = await codeFrom(t);
  await t.app.handleUpdate(say(OWNER, '/app forget'));
  assert.equal(t.tg.last().text, 'Unlinked your phone: the app on it can no longer reach me. Send /app to link a phone again.');
  assert.equal(t.app.appAuth(paired.body.token), null);
  assert.deepEqual(t.store.load().apps, []);
  assert.deepEqual(t.app.appPair({ code: waiting }).body, { ok: false, why: 'none', left: 0 });
  await t.app.handleUpdate(say(OWNER, '/app forget'));
  assert.equal(t.tg.last().text, 'No phone was linked. Send /app to link one.');
  await t.app.handleUpdate(say(OWNER, '/app unlink'));
  assert.match(t.tg.last().text, /^Use it like this: {2}\/app /);
  // It is in /help, and only the owner can ask for a code.
  await t.app.handleUpdate(say(OWNER, '/help'));
  assert.match(t.tg.last().text, /\n\/app {2}: link the iPhone app {2}\(\/app forget unlinks every phone\)\n/);
  const calls = t.tg.calls.length;
  await t.app.handleUpdate(say(999, '/app'));
  assert.equal(t.tg.last().text, 'This bot is private.');
  assert.equal(t.tg.calls.length, calls + 1);
});

test('/app says so when nothing could come of it: no PC link, no volume, or five phones already', async () => {
  // The app comes in by the server your PC talks to, which only runs once the PC is linked.
  const alone = makeBot(NOON, { linked: false });
  await alone.app.handleUpdate(say(OWNER, '/app'));
  assert.equal(alone.tg.last().text, 'The app reaches me at the same address as your PC, and that only opens once your PC is linked. Add AGENT_PUBLIC_KEY in Railway first (see the README), then send /app again.');
  assert.deepEqual(alone.app.appPair({ code: '000000' }).body, { ok: false, why: 'none', left: 0 });
  // Settings that do not outlast a restart: the link to a phone would not either.
  const clock = { t: at(NOON) };
  const tg = fakeTelegram(clock);
  const fleeting = createApp({ now: () => clock.t, tg, store: memStore({ owner: OWNER }, false), pictures: PICTURES, linked: true });
  await fleeting.handleUpdate(say(OWNER, '/app'));
  assert.equal(tg.last().text.split('\n').pop(), 'Note: without a Railway volume mounted at /data, the link to a phone is lost each time I restart.');
  // Five phones linked: the code is still given (the app is told "full"), and the message says why.
  const full = makeBot();
  for (let i = 1; i <= 5; i++) await linkPhone(full, `Phone ${i}`);
  await full.app.handleUpdate(say(OWNER, '/app'));
  assert.equal(full.tg.last().text.split('\n').pop(), '5 phones are linked already (Phone 1, Phone 2, Phone 3, Phone 4, Phone 5), and that is as many as I keep, so the app will be turned away. Unlink one in the app on that phone, or send /app forget to unlink them all.');
  await full.app.handleUpdate(say(OWNER, '/app forget'));
  assert.equal(full.tg.last().text, 'Unlinked all 5 phones: the app on them can no longer reach me. Send /app to link a phone again.');
});

// ---------- the door: who is asking ----------

test('hello is open and says nothing private; everything else needs a linked phone\'s token', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await withServer(t, async ({ get, post }) => {
    assert.deepEqual(await get('/app/hello'), { status: 200, json: { ok: true, bot: '2.9.1', api: 2 } });
    const unpaired = { status: 401, json: { ok: false, why: 'unpaired' } };
    assert.deepEqual(await get('/app/state'), unpaired);
    assert.deepEqual(await get('/app/state', { token: A.newToken().token }), unpaired);
    assert.deepEqual(await get('/app/state', { token: phone.token.slice(0, -1) }), unpaired);
    assert.deepEqual(await get('/app/state', { headers: { authorization: phone.token } }), unpaired);          // not as a Bearer token
    assert.deepEqual(await post('/app/pause', { paused: true }), unpaired);
    assert.deepEqual(await post('/app/unpair', {}), unpaired);
    assert.deepEqual(await post('/app/nothing', {}), unpaired);
    assert.equal(t.app.state.paused, false);
    const ok = await get('/app/state', { token: phone.token });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.json), ['ok', 'etag', 'state']);
    // What is not there is said as that, to a linked phone.
    assert.deepEqual(await post('/app/nothing', {}, { token: phone.token }), { status: 404, json: { ok: false, why: 'no such thing here' } });
    assert.deepEqual(await get('/app/pause', { token: phone.token }), { status: 404, json: { ok: false, why: 'no such thing here' } });
    assert.deepEqual(await post('/app/pause', 'not json', { token: phone.token }), { status: 400, json: { ok: false, why: 'The request body must be JSON.' } });
    assert.deepEqual(await post('/app/pause', '[true]', { token: phone.token }), { status: 400, json: { ok: false, why: 'The request body must be a JSON object.' } });
    // Bodies are small: 4 KB at most.
    assert.deepEqual(await post('/app/pause', { paused: true, padding: 'x'.repeat(4096) }, { token: phone.token }), { status: 413, json: { ok: false, why: 'That request is too large.' } });
    assert.equal((await post('/app/pause', { paused: false, padding: 'x'.repeat(3900) }, { token: phone.token })).status, 200);
    assert.equal(t.app.state.paused, false);
  });
});

test('the app\'s door and the PC\'s are apart: a phone\'s token opens nothing of the PC\'s, nor the PC\'s key or token anything of the app\'s', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signed = (method, path, body) => {
    const ms = Date.now();
    return `Signed ${ms}.${crypto.sign(null, Buffer.from(signedText(ms, method, path, body)), privateKey).toString('base64url')}`;
  };
  const seenByPc = [];
  const extra = () => ({ publicKey: readPublicKey(publicKey.export({ type: 'spki', format: 'der' }).toString('base64')), onPing: (from, opts) => { seenByPc.push(opts); return {}; } });
  await withServer(t, async ({ get, post }) => {
    // The PC's two ways in work on its own door...
    assert.equal((await post('/agent/ping', {}, { token: AGENT })).status, 200);
    assert.equal((await post('/agent/ping', '{}', { headers: { authorization: signed('POST', '/agent/ping', '{}') } })).status, 200);
    // ...and a phone's token does not.
    assert.equal((await post('/agent/ping', {}, { token: phone.token })).status, 401);
    assert.equal((await get('/agent/jobs', { token: phone.token })).status, 401);
    assert.equal((await post('/agent/hold', { id: 'a1b2c3d4e5f6', stage: 'held' }, { token: phone.token })).status, 401);
    assert.equal(seenByPc.length, 2);
    // On the app's door neither of the PC's is any use.
    const unpaired = { status: 401, json: { ok: false, why: 'unpaired' } };
    assert.deepEqual(await get('/app/state', { token: AGENT }), unpaired);
    assert.deepEqual(await get('/app/state', { headers: { authorization: AGENT } }), unpaired);
    assert.deepEqual(await get('/app/state', { headers: { authorization: signed('GET', '/app/state', '') } }), unpaired);
    assert.deepEqual(await post('/app/pause', '{"paused":true}', { headers: { authorization: signed('POST', '/app/pause', '{"paused":true}') } }), unpaired);
    assert.deepEqual(await post('/app/pause', { paused: true }, { token: AGENT }), unpaired);
    assert.equal(t.app.state.paused, false);
    assert.equal((await get('/app/state', { token: phone.token })).status, 200);
  }, extra);
  // A server that was not given the app's functions has nothing under /app/ at all.
  const server = createServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), token: AGENT });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [method, path] of [['GET', '/app/hello'], ['POST', '/app/pair'], ['GET', '/app/state']]) {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${phone.token}` } });
      assert.deepEqual([res.status, await res.json()], [404, { ok: false, why: 'no such thing here' }], path);
    }
  } finally { await new Promise(r => server.close(r)); }
});

// ---------- linking a phone ----------

test('pairing: the code from /app is good once, for a token of which only the SHA-256 is kept', async () => {
  const t = makeBot();
  await withServer(t, async ({ get, post }) => {
    assert.deepEqual(await post('/app/pair', { code: '123456', name: 'x' }), { status: 400, json: { ok: false, why: 'none', left: 0 } });      // nobody asked for a code
    const code = await codeFrom(t);
    const r = await post('/app/pair', { code, name: '  Francisco\'s\n iPhone ' });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['ok', 'token', 'device']);
    assert.match(r.json.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(r.json.device.id, /^[0-9a-f]{8}$/);
    assert.deepEqual(r.json.device, { id: r.json.device.id, name: 'Francisco\'s iPhone' });
    const saved = t.store.load();
    assert.deepEqual(saved.apps, [{ id: r.json.device.id, name: 'Francisco\'s iPhone', hash: crypto.createHash('sha256').update(r.json.token).digest('hex'), at: t.clock.t, seenAt: t.clock.t, push: null, owner: OWNER }]);
    assert.ok(!JSON.stringify(saved).includes(r.json.token));
    assert.equal((await get('/app/state', { token: r.json.token })).status, 200);
    assert.equal((await post('/app/pause', { paused: false }, { token: r.json.token })).status, 200);
    // Used twice: there is no code any more.
    assert.deepEqual(await post('/app/pair', { code, name: 'again' }), { status: 400, json: { ok: false, why: 'none', left: 0 } });
    assert.equal(t.store.load().apps.length, 1);
    // A phone that gives no name is an iPhone.
    const second = await post('/app/pair', { code: Number(await codeFrom(t)) });
    assert.equal(second.json.device.name, 'iPhone');
    // After all that, neither token (nor any length of one worth having), nor a token's hash, nor a
    // code is in the log, the server's own included.
    const logged = t.logs.join('\n');
    for (const token of [r.json.token, second.json.token]) for (let i = 0; i + 12 <= token.length; i++) assert.ok(!logged.includes(token.slice(i, i + 12)), 'a piece of a token is in the log');
    assert.ok(!logged.includes(code) && !logged.includes(saved.apps[0].hash));
    assert.ok(logged.includes('From the app: pause'));                                     // and what a phone asked for is named, without what it sent
    assert.ok(!/paused|false/.test(logged));
  });
});

test('pairing: the same right code sent three times at once links one phone', async () => {
  const t = makeBot();
  await withServer(t, async ({ post }) => {
    const code = await codeFrom(t);
    const answers = await Promise.all([1, 2, 3].map(i => post('/app/pair', { code, name: `Phone ${i}` })));
    assert.deepEqual(answers.map(a => `${a.status} ${a.json.why || 'linked'}`).sort(), ['200 linked', '400 none', '400 none']);
    assert.equal(t.app.state.apps.length, 1);
    assert.equal(t.store.load().apps.length, 1);
    await settle();
    assert.equal(t.tg.calls.filter(c => /^<b>Phone linked<\/b>/.test(c.text)).length, 1);
  });
});

test('pairing: a wrong code counts down and the fifth cancels it; a code runs out after ten minutes', async () => {
  const t = makeBot();
  await withServer(t, async ({ post }) => {
    const code = await codeFrom(t);
    for (const left of [4, 3, 2]) assert.deepEqual(await post('/app/pair', { code: wrongFor(code) }), { status: 400, json: { ok: false, why: 'wrong', left } });
    assert.deepEqual(await post('/app/pair', 'not json at all'), { status: 400, json: { ok: false, why: 'wrong', left: 1 } });        // anything that is not the code is a wrong try
    assert.deepEqual(await post('/app/pair', {}), { status: 400, json: { ok: false, why: 'wrong', left: 0 } });
    assert.deepEqual(await post('/app/pair', { code }), { status: 400, json: { ok: false, why: 'none', left: 0 } });                   // the right code, too late
    assert.deepEqual(t.app.state.apps, []);
    assert.ok(t.logs.includes('A wrong code was tried for linking a phone (1 try left on it).'));
    assert.ok(!t.logs.join('\n').includes(wrongFor(code)) && !t.logs.join('\n').includes(code));        // what was tried is not written down, right or wrong
    // Ten minutes on, a code that nobody used has run out; the next /app gives one that works.
    const stale = await codeFrom(t);
    t.clock.t += 10 * 60000;
    assert.deepEqual(await post('/app/pair', { code: stale }), { status: 400, json: { ok: false, why: 'expired', left: 0 } });
    assert.equal((await post('/app/pair', { code: await codeFrom(t) })).status, 200);
    // After a restart of the bot the code is gone with it: "none", not "expired".
    const again = makeBot(NOON, { store: t.store });
    assert.deepEqual(again.app.appPair({ code: stale }).body, { ok: false, why: 'none', left: 0 });
  });
});

test('pairing: five phones at most, and a sixth is told the list is full without losing its code', async () => {
  const t = makeBot();
  const phones = [];
  for (let i = 1; i <= 5; i++) phones.push(await linkPhone(t, `Phone ${i}`));
  const code = await codeFrom(t);
  assert.deepEqual(t.app.appPair({ code: wrongFor(code), name: 'Phone 6' }).body, { ok: false, why: 'wrong', left: 4 });              // "full" is only said to someone with the code
  assert.deepEqual(t.app.appPair({ code, name: 'Phone 6' }), { status: 400, body: { ok: false, why: 'full', left: 4 } });
  assert.equal(t.app.state.apps.length, 5);
  // One phone unlinks itself: the same code now works.
  assert.deepEqual(await ask(t, phones[1], 'unpair'), { status: 200, body: { ok: true } });
  assert.equal(t.app.appPair({ code, name: 'Phone 6' }).status, 200);
  assert.deepEqual(t.app.state.apps.map(d => d.name), ['Phone 1', 'Phone 3', 'Phone 4', 'Phone 5', 'Phone 6']);
});

test('pairing: at most ten tries in any ten minutes at a code that is waiting, whoever makes them', async () => {
  const t = makeBot();
  await withServer(t, async ({ post }) => {
    const slow = { status: 429, json: { ok: false, why: 'slow' } };
    const start = t.clock.t;
    // One: the owner's own phone.
    assert.equal((await post('/app/pair', { code: await codeFrom(t), name: 'mine' })).status, 200);
    // Five more a minute later: a second code, guessed at until it is cancelled.
    t.clock.t = start + 60000;
    const second = await codeFrom(t);
    for (const left of [4, 3, 2, 1, 0]) assert.deepEqual((await post('/app/pair', { code: wrongFor(second) })).json, { ok: false, why: 'wrong', left });
    // Four more a minute after that, at a third code (a new code does not start the count again): that is ten.
    t.clock.t = start + 120000;
    const third = await codeFrom(t);
    for (const left of [4, 3, 2, 1]) assert.deepEqual((await post('/app/pair', { code: wrongFor(third) })).json, { ok: false, why: 'wrong', left });
    // Now even the right code has to wait, and waiting does not use the code up.
    assert.deepEqual(await post('/app/pair', { code: third }), slow);
    assert.deepEqual(await post('/app/pair', { code: wrongFor(third) }), slow);
    t.clock.t = start + 10 * 60000 - 1;
    assert.deepEqual(await post('/app/pair', { code: third }), slow);
    // Ten minutes after the first try there is room for one more: the third code, still good, links a phone.
    t.clock.t = start + 10 * 60000;
    assert.equal((await post('/app/pair', { code: third, name: 'second phone' })).status, 200);
    assert.deepEqual(await post('/app/pair', { code: await codeFrom(t) }), slow);            // and that was the one
    assert.deepEqual(t.store.load().apps.map(d => d.name), ['mine', 'second phone']);
  });
});

test('pairing: a stranger\'s tries while no code is waiting cost nothing, and never keep the owner out', async () => {
  const t = makeBot();
  await withServer(t, async ({ post }) => {
    // Nobody has asked for a code: every try is told "none", and none of them counts.
    for (let i = 0; i < 40; i++) assert.deepEqual(await post('/app/pair', { code: String(i).padStart(6, '0') }), { status: 400, json: { ok: false, why: 'none', left: 0 } });
    assert.equal((await post('/app/pair', { code: await codeFrom(t), name: 'mine' })).status, 200);
    // A stranger asking once a minute, for forty minutes; every seven minutes the owner sends /app
    // and types the right code half a minute after one of the stranger's tries. It is taken every time.
    let taken = 0;
    for (let minute = 0; minute < 40; minute++) {
      assert.equal((await post('/app/pair', { code: 'x' })).json.why, 'none');
      if (minute >= 10 && minute % 7 === 0) {
        t.clock.t += 30000;
        if ((await post('/app/pair', { code: await codeFrom(t), name: `phone ${minute}` })).status === 200) taken++;
        t.clock.t += 30000;
      } else t.clock.t += 60000;
    }
    assert.equal(taken, 4);
    // A code that ran out unused is not something to guess at either: "expired", and not counted.
    const stale = await codeFrom(t);
    t.clock.t += 10 * 60000;
    for (let i = 0; i < 30; i++) assert.deepEqual(await post('/app/pair', { code: 'y' }), { status: 400, json: { ok: false, why: 'expired', left: 0 } });
    assert.deepEqual(await post('/app/pair', { code: stale }), { status: 400, json: { ok: false, why: 'expired', left: 0 } });
    await t.app.handleUpdate(say(OWNER, '/app forget'));
    assert.equal((await post('/app/pair', { code: await codeFrom(t), name: 'again' })).status, 200);
    assert.ok(!t.logs.some(l => /wrong code/.test(l)));                                       // and none of it was a wrong try at anything
  });
});

test('unpair forgets the phone that asked, and only that one', async () => {
  const t = makeBot();
  const mine = await linkPhone(t, 'Mine'), other = await linkPhone(t, 'Other');
  await withServer(t, async ({ get, post }) => {
    assert.deepEqual(await post('/app/unpair', {}, { token: mine.token }), { status: 200, json: { ok: true } });
    assert.deepEqual(await get('/app/state', { token: mine.token }), { status: 401, json: { ok: false, why: 'unpaired' } });
    const left = await get('/app/state', { token: other.token });
    assert.deepEqual(left.json.state.devices, [{ id: other.id, name: 'Other', at: t.clock.t, seenAt: t.clock.t, me: true }]);
    assert.deepEqual(t.store.load().apps.map(d => d.name), ['Other']);
  });
});

test('when a phone was last heard from is noted, once a minute at most', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const linkedAt = t.clock.t;
  const etag = t.app.appState(phone.device).etag;
  t.clock.t += 59999;
  assert.ok(t.app.appAuth(phone.token));
  assert.equal(stateOf(t, phone).devices[0].seenAt, linkedAt);
  assert.equal(t.app.appState(phone.device).etag, etag);                // so a phone that keeps asking does not change its own state
  t.clock.t += 1;
  assert.ok(t.app.appAuth(phone.token));
  assert.deepEqual(stateOf(t, phone).devices, [{ id: phone.id, name: 'Francisco\'s iPhone', at: linkedAt, seenAt: linkedAt + 60000, me: true }]);
  assert.equal(t.store.load().apps[0].seenAt, linkedAt + 60000);
  assert.equal(t.app.appAuth('nonsense'), null);
});

// ---------- what the app is shown ----------

const SEEDED = {
  plan: { tue: { start: 960, hours: 2 }, thu: { start: 1140, hours: 1 } },
  once: [{ date: FRI, start: 1140, hours: 2 }, { date: '2026-11-27', start: 600, hours: 1 }],
  lastSeen: at(`${TUE}T11:59:30Z`),
  home: { ip: HOME.ip, at: at(`${TUE}T11:59:30Z`) },
  results: {
    '2026-11-19@19:00': { id: '2026-11-19@19:00', status: 'booked', date: '2026-11-19', start: 1140, end: 1200, court: '3', gate: '2433', at: at('2026-11-12T22:00:10Z') },
    '2026-11-18@18:00': { id: '2026-11-18@18:00', status: 'none', date: '2026-11-18', start: 1080, end: 1200, at: at('2026-11-11T22:05:00Z') },
    '2026-11-17@09:00': { id: '2026-11-17@09:00', status: 'failed', date: TUE, start: 540, end: 600, why: 'the booking sheet did not load <twice>', at: at('2026-11-10T22:01:00Z') },
    '2026-11-10@16:00': { id: '2026-11-10@16:00', status: 'booked', date: '2026-11-10', start: 960, end: 1080, court: '4', at: at('2026-11-03T22:00:09Z') },
    '2026-11-12@19:00': { id: '2026-11-12@19:00', status: 'failed', date: '2026-11-12', start: 1140, end: 1200, at: at('2026-11-05T22:03:00Z') },
  },
  notes: [{ id: 'aa11bb22cc', at: at('2026-11-12T22:00:10Z'), kind: 'booked', title: 'Court 3 booked', body: 'Thu 19 Nov · 19:00–20:00 · gate 2433' }],
};

test('the state, field by field: a weekly plan, one-offs open and not yet open, results booked, missed and past', async () => {
  const t = makeBot(NOON, { state: SEEDED, env: WAKE });
  const phone = await linkPhone(t), other = await linkPhone(t, 'iPad');
  const { etag, state } = t.app.appState(phone.device);
  assert.deepEqual(state, {
    now: at(NOON),
    bot: '2.9.1',
    venue: { name: 'Kelvingrove Park', short: 'KP', first: 540, last: 1260, lengths: [1, 2], courts: [1, 2, 3, 4, 5, 6], releaseMin: 1320, daysAhead: 7, maxAheadDays: 90 },
    venues: venuesOn(TUE),
    // Nothing stands in the way of a look or Book now at a park: the PC is awake, and it is midday.
    clubspark: { linked: true, days: { first: TUE, last: '2026-11-23' }, quietUntil: null, lookNo: null, bookNo: null, reads: { used: 0, max: 6, nextAt: null }, book: null },
    // This week: Thursday's 19:00 booked, Friday's two hours still to book. Next week: Tuesday and Thursday every week, and Friday the 27th.
    allowance: [
      { week: '2026-11-16', sessions: 1, hours: 1, plannedSessions: 1, plannedHours: 2, maxSessions: 7, maxHours: 14 },
      { week: '2026-11-23', sessions: 0, hours: 0, plannedSessions: 3, plannedHours: 4, maxSessions: 7, maxHours: 14 },
    ],
    paused: false,
    kept: 'disk',
    pc: {
      state: 'awake', linked: true, seenAt: at(`${TUE}T11:59:30Z`), line: 'Your PC is awake.',
      canWake: false, wakeWhy: 'Your PC is already awake.', canSleep: true, sleepWhy: null, sleepAsked: null, wokeAt: null, cardKey: null,
    },
    // Tuesdays are booked tonight at 22:00, a week ahead.
    release: { at: at(`${TUE}T22:00:00Z`), night: TUE, jobs: [{ id: '2026-11-24@16:00', date: '2026-11-24', start: 960, end: 1080, from: 'weekly' }] },
    later: [
      { at: at('2026-11-19T22:00:00Z'), night: '2026-11-19', jobs: [{ id: '2026-11-26@19:00', date: '2026-11-26', start: 1140, end: 1200, from: 'weekly' }] },
      { at: at('2026-11-20T22:00:00Z'), night: FRI, jobs: [{ id: '2026-11-27@10:00', date: '2026-11-27', start: 600, end: 660, from: 'once' }] },
      { at: at('2026-11-24T22:00:00Z'), night: '2026-11-24', jobs: [{ id: '2026-12-01@16:00', date: '2026-12-01', start: 960, end: 1080, from: 'weekly' }] },
    ],
    // Friday the 20th opened last Friday: the PC books it at its next run.
    open: [{ id: '2026-11-20@19:00', date: FRI, start: 1140, end: 1260 }],
    plan: [{ day: 'tue', start: 960, hours: 2 }, { day: 'thu', start: 1140, hours: 1 }],
    once: [
      { id: '2026-11-20@19:00', date: FRI, start: 1140, hours: 2, end: 1260, opensAt: at('2026-11-13T22:00:00Z'), open: true },
      { id: '2026-11-27@10:00', date: '2026-11-27', start: 600, hours: 1, end: 660, opensAt: at('2026-11-20T22:00:00Z'), open: false },
    ],
    order: [3, 4, 5, 2, 1, 6],
    // Today and later first, soonest first; then what is past, newest first.
    results: [
      { id: '2026-11-17@09:00', venue: 'kelvingrove', status: 'failed', date: TUE, start: 540, end: 600, court: null, gate: null, why: 'It did not work: the booking sheet did not load <twice>.', at: at('2026-11-10T22:01:00Z'), past: false },
      { id: '2026-11-18@18:00', venue: 'kelvingrove', status: 'none', date: '2026-11-18', start: 1080, end: 1200, court: null, gate: null, why: 'No court was free for the whole slot.', at: at('2026-11-11T22:05:00Z'), past: false },
      { id: '2026-11-19@19:00', venue: 'kelvingrove', status: 'booked', date: '2026-11-19', start: 1140, end: 1200, court: '3', gate: '2433', why: null, at: at('2026-11-12T22:00:10Z'), past: false },
      { id: '2026-11-12@19:00', venue: 'kelvingrove', status: 'failed', date: '2026-11-12', start: 1140, end: 1200, court: null, gate: null, why: 'It did not work: no reason given.', at: at('2026-11-05T22:03:00Z'), past: true },
      { id: '2026-11-10@16:00', venue: 'kelvingrove', status: 'booked', date: '2026-11-10', start: 960, end: 1080, court: '4', gate: null, why: null, at: at('2026-11-03T22:00:09Z'), past: true },
    ],
    run: null,
    indoor: {
      linked: true, days: 9, quietUntil: null, holdNo: null,
      centres: [
        { key: 'g', name: 'Gorbals', site: `https://glasgowclub.gladstonego.cloud/book/calendar/S0815?activityDate=${TUE}T00:00:00.000Z` },
        { key: 's', name: 'Scotstoun', site: `https://glasgowclub.gladstonego.cloud/book/calendar/SA011?activityDate=${TUE}T00:00:00.000Z` },
      ],
    },
    card: null,
    hold: null,
    notes: [{ id: 'aa11bb22cc', at: at('2026-11-12T22:00:10Z'), kind: 'booked', title: 'Court 3 booked', body: 'Thu 19 Nov · 19:00–20:00 · gate 2433' }],
    devices: [
      { id: phone.id, name: 'Francisco\'s iPhone', at: at(NOON), seenAt: at(NOON), me: true },
      { id: other.id, name: 'iPad', at: at(NOON), seenAt: at(NOON), me: false },
    ],
  });
  // The words are the menu's own, and the same booking is what Telegram's /plan lists.
  await t.app.handleUpdate(say(OWNER, '/menu'));
  assert.equal(t.tg.last().text.split('\n')[2], state.pc.line);
  assert.equal(etag, A.etagOf(state));
  // Each phone sees itself as "me", so each has its own etag; nothing of a token is in either.
  const seenByOther = t.app.appState(other.device);
  assert.deepEqual(seenByOther.state.devices.map(d => d.me), [false, true]);
  assert.notEqual(seenByOther.etag, etag);
  assert.ok(!/hash|token|push/i.test(JSON.stringify(state)));
  // Over HTTP it is the same thing, as JSON.
  await withServer(t, async ({ get }) => {
    assert.deepEqual(await get('/app/state', { token: phone.token }), { status: 200, json: { ok: true, etag, state } });
  });
  // A second later only the clock has moved: the same etag.
  t.clock.t += 1000;
  assert.equal(t.app.appState(phone.device).etag, etag);
  assert.equal(stateOf(t, phone).now, at(NOON) + 1000);
});

test('the state follows the clock: what has opened, what has started, what is past, and a paused bot books nothing', async () => {
  const t = makeBot(NOON, { state: SEEDED });
  const phone = await linkPhone(t);
  // Paused: nothing is coming, though the plan and the one-offs are still listed.
  await t.app.handleUpdate(say(OWNER, '/pause'));
  let s = stateOf(t, phone);
  assert.deepEqual([s.paused, s.release, s.later, s.open, s.plan.length, s.once.length], [true, null, [], [], 2, 2]);
  await t.app.handleUpdate(say(OWNER, '/resume'));
  // Tonight's release stays "the next" until ten minutes after it, like the bot's own "Next booking".
  t.clock.t = at(`${TUE}T22:09:59Z`);
  assert.equal(stateOf(t, phone).release.night, TUE);
  t.clock.t = at(`${TUE}T22:10:00Z`);
  s = stateOf(t, phone);
  assert.equal(s.release.night, '2026-11-19');
  assert.deepEqual(s.later.map(r => r.night), [FRI, '2026-11-24', '2026-11-26']);
  // Friday 22:00: the 27th opens. From then it is "open", and (ten minutes on) one of the open one-offs.
  t.clock.t = at(`${FRI}T21:59:59Z`);
  s = stateOf(t, phone);
  assert.deepEqual(s.once.map(o => [o.id, o.open]), [['2026-11-27@10:00', false]]);        // Friday's 19:00 has started: no longer ahead
  assert.deepEqual(s.open, []);
  t.clock.t = at(`${FRI}T22:00:00Z`);
  s = stateOf(t, phone);
  assert.deepEqual(s.once.map(o => [o.id, o.open]), [['2026-11-27@10:00', true]]);
  assert.deepEqual(s.open, [{ id: '2026-11-27@10:00', date: '2026-11-27', start: 600, end: 660 }]);
  assert.equal(s.release.jobs[0].id, '2026-11-27@10:00');                                 // and still tonight's release, for ten minutes
  // Once it is booked it is no longer waiting to be.
  await t.app.resultFromAgent({ id: '2026-11-27@10:00', status: 'booked', court: 5, gate: '9911', end: 660 });
  s = stateOf(t, phone);
  assert.deepEqual(s.open, []);
  assert.deepEqual(s.results.filter(r => !r.past).map(r => r.id), ['2026-11-27@10:00']);
  assert.deepEqual(s.results.filter(r => r.past).map(r => r.id), ['2026-11-19@19:00', '2026-11-18@18:00', '2026-11-17@09:00', '2026-11-12@19:00', '2026-11-10@16:00']);
  assert.deepEqual(s.results[0], { id: '2026-11-27@10:00', venue: 'kelvingrove', status: 'booked', date: '2026-11-27', start: 600, end: 660, court: '5', gate: '9911', why: null, at: t.clock.t, past: false });
});

test('a one-off that repeats a weekly day, added after its release was missed, is one of the open ones', async () => {
  // Thursdays at 19:00 every week; Thu 19 Nov opened on the 12th and was not booked.
  const t = makeBot(NOON, { state: { plan: { thu: { start: 1140, hours: 1 } } } });
  const phone = await linkPhone(t);
  assert.deepEqual(stateOf(t, phone).open, []);
  const r = await ask(t, phone, 'once', { date: '2026-11-19', start: 1140, hours: 1 });
  assert.deepEqual(r.body.state.open, [{ id: '2026-11-19@19:00', date: '2026-11-19', start: 1140, end: 1200 }]);
  assert.deepEqual(t.app.jobsForAgent({}, { run: false }).jobs.map(j => j.id), ['2026-11-19@19:00']);          // which is what the PC is told to book
});

test('the PC in the state: asleep, offline, not linked, and the same sentences Sleep and Wake give', async () => {
  // Asleep, with waking set up.
  const t = makeBot(NOON, { env: WAKE, state: { lastSeen: at(`${TUE}T11:50:00Z`), home: { ip: HOME.ip, at: 1 } } });
  const phone = await linkPhone(t);
  let pc = stateOf(t, phone).pc;
  assert.deepEqual(pc, { state: 'asleep', linked: true, seenAt: at(`${TUE}T11:50:00Z`), line: 'Your PC is asleep (last in touch today at 11:50). It wakes at 21:55 to book.',
    canWake: true, wakeWhy: null, canSleep: false, sleepWhy: 'Your PC is not awake.', sleepAsked: null, wokeAt: null, cardKey: null });
  assert.equal(stateOf(t, phone).indoor.holdNo, 'Your PC is not awake, and it is your PC that signs in to Glasgow Club and holds the court. Wake it and try again.');
  // Wake it from the app: the packet goes where /wake sends it, and for half a minute another is not sent.
  const woken = await ask(t, phone, 'pc/wake');
  assert.equal(woken.status, 200);
  assert.deepEqual(t.woke, [{ host: HOME.ip, port: 40009, mac: '44af287a1a5c' }]);
  pc = woken.body.state.pc;
  assert.deepEqual([pc.canWake, pc.wakeWhy, pc.wokeAt], [false, 'Sent a moment ago. Give it a minute.', at(NOON)]);
  assert.deepEqual(await ask(t, phone, 'pc/wake'), refused(409, 'Sent a moment ago. Give it a minute.'));
  await t.app.handleUpdate(say(OWNER, '/wake'));
  assert.equal(t.tg.last().text, 'Sent a moment ago. Give it a minute.');                 // Telegram says the same
  assert.equal(t.woke.length, 1);
  t.clock.t += 30000;
  assert.deepEqual([stateOf(t, phone).pc.canWake, stateOf(t, phone).pc.wakeWhy], [true, null]);
  // It answers: awake, and now it is sleep that can be asked for.
  await t.app.pingFromAgent(HOME);
  pc = stateOf(t, phone).pc;
  assert.deepEqual([pc.state, pc.line, pc.canWake, pc.wakeWhy, pc.canSleep, pc.sleepWhy], ['awake', 'Your PC is awake.', false, 'Your PC is already awake.', true, null]);
  assert.deepEqual(await ask(t, phone, 'pc/wake'), refused(409, 'Your PC is already awake.'));
  // Never in touch, and no way to wake it.
  const cold = makeBot(NOON);
  const coldPhone = await linkPhone(cold);
  pc = stateOf(cold, coldPhone).pc;
  assert.deepEqual(pc, { state: 'offline', linked: true, seenAt: null, line: 'Your PC has not been in touch yet.',
    canWake: false, wakeWhy: 'Waking is not set up: add WAKE_MAC on Railway.', canSleep: false, sleepWhy: 'Your PC is not awake.', sleepAsked: null, wokeAt: null, cardKey: null });
  assert.deepEqual(await ask(cold, coldPhone, 'pc/wake'), refused(409, 'Waking is not set up: add WAKE_MAC on Railway.'));
  // Waking set up, but the PC has never called: nowhere to send it.
  const homeless = makeBot(NOON, { env: WAKE });
  const homelessPhone = await linkPhone(homeless);
  assert.equal(stateOf(homeless, homelessPhone).pc.wakeWhy, 'I do not know your home address yet. Your PC must be in touch once first.');
  assert.deepEqual(await ask(homeless, homelessPhone, 'pc/wake'), refused(409, 'I do not know your home address yet. Your PC must be in touch once first.'));
  // A packet that would not go.
  const stuck = makeBot(NOON, { env: WAKE, state: { lastSeen: at(`${TUE}T11:50:00Z`), home: { ip: HOME.ip, at: 1 } }, wake: async () => { throw new Error('EHOSTUNREACH'); } });
  const stuckPhone = await linkPhone(stuck);
  assert.deepEqual(await ask(stuck, stuckPhone, 'pc/wake'), refused(409, 'The wake-up could not be sent. Try again.'));
  assert.equal(stateOf(stuck, stuckPhone).pc.canWake, true);
  // With no PC linked (the app cannot then reach the bot at all, but the functions still answer).
  const alone = makeBot(NOON, { linked: false, state: { apps: [{ id: 'a1b2c3d4', name: 'iPhone', hash: A.hashToken('x'), at: 1, seenAt: 1, push: null }] } });
  pc = alone.app.appState({ id: 'a1b2c3d4' }).state.pc;
  assert.deepEqual([pc.state, pc.linked, pc.line, pc.canWake, pc.canSleep, pc.sleepWhy], ['offline', false, null, false, false, 'Your PC is not linked to me.']);
  assert.equal(alone.app.appState({ id: 'a1b2c3d4' }).state.indoor.holdNo, 'Your PC is not linked to me, and it is your PC that signs in and holds the court.');
});

// ---------- GET /app/state: waiting for a change ----------

test('the state waits for a change when the phone has it already, and says "same" if there was none', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const token = phone.token;
  await withServer(t, async ({ get }) => {
    const first = await get('/app/state', { token });
    const etag = first.json.etag;
    assert.deepEqual(await get(`/app/state?have=${etag}`, { token }), { status: 200, json: { ok: true, etag, same: true } });          // no wait asked for
    assert.deepEqual((await get('/app/state?have=an-old-one&wait=20', { token })).json, first.json);                             // not what it has: at once
    assert.deepEqual((await get('/app/state?wait=20', { token })).json, first.json);
    // Nothing changes: the answer comes when the wait is over.
    let began = Date.now();
    assert.deepEqual(await get(`/app/state?have=${etag}&wait=0.25`, { token }), { status: 200, json: { ok: true, etag, same: true } });
    assert.ok(Date.now() - began >= 200, `waited ${Date.now() - began} ms`);
    // Something changes in Telegram: the answer comes at once, with the new state.
    began = Date.now();
    const waiting = get(`/app/state?have=${etag}&wait=20`, { token });
    setTimeout(() => t.app.handleUpdate(say(OWNER, '/set thu 19:00 2h')), 60);
    const changed = await waiting;
    assert.ok(Date.now() - began < 5000);
    assert.deepEqual(changed.json.state.plan, [{ day: 'thu', start: 1140, hours: 2 }]);
    assert.notEqual(changed.json.etag, etag);
    assert.deepEqual(Object.keys(changed.json), ['ok', 'etag', 'state']);
    // So does something that only the clock brings about: the PC falling silent.
    await t.app.pingFromAgent(HOME);
    const awake = await get('/app/state', { token });
    assert.equal(awake.json.state.pc.state, 'awake');
    const dozing = get(`/app/state?have=${awake.json.etag}&wait=20`, { token });
    setTimeout(() => { t.clock.t += 3 * 60000 + 1; }, 40);
    assert.equal((await dozing).json.state.pc.state, 'asleep');
    // And a phone that is unlinked while it waits is told so.
    const now = await get('/app/state', { token });
    const hanging = get(`/app/state?have=${now.json.etag}&wait=20`, { token });
    setTimeout(() => t.app.handleUpdate(say(OWNER, '/app forget')), 40);
    assert.deepEqual(await hanging, { status: 401, json: { ok: false, why: 'unpaired' } });
  });
});

test('a wait is 25 seconds at most, looks about once a second, and nothing is left running when the phone goes away', async () => {
  // How long a wait may be, whatever is asked for.
  assert.deepEqual(['25', '9999', '0.25', '1', '0', '-3', 'soon', '', null].map(A.waitMs), [25000, 25000, 250, 1000, 0, 0, 0, 0, 0]);
  const t = makeBot();
  const phone = await linkPhone(t);
  let looks = 0;
  const counted = api => ({ appPollMs: 10, appApi: { ...api, state: d => { looks++; return api.state(d); } } });
  await withServer(t, async ({ base, get }) => {
    const etag = (await get('/app/state', { token: phone.token })).json.etag;
    // A wait of 0.2 s with a look every 10 ms: about twenty looks, and then the answer.
    looks = 0;
    assert.deepEqual((await get(`/app/state?have=${etag}&wait=0.2`, { token: phone.token })).json, { ok: true, etag, same: true });
    assert.equal(looks, 21);                                         // once at the start, then once each 10 ms
    await sleep(60);
    assert.equal(looks, 21);                                         // and not once more after it has answered
    // The phone goes away in the middle of a long wait.
    looks = 0;
    const gone = new AbortController();
    const hung = fetch(`${base}/app/state?have=${etag}&wait=9999`, { headers: { authorization: `Bearer ${phone.token}` }, signal: gone.signal }).then(() => 'answered', e => e.name);
    await sleep(80);
    assert.ok(looks >= 3, `looked ${looks} times while it waited`);
    gone.abort();
    assert.equal(await hung, 'AbortError');
    await sleep(40);
    const after = looks;
    await sleep(120);
    assert.equal(looks, after);                                      // it stopped looking when the phone went
  }, counted);
});

// ---------- what the app asks for ----------

// The same thing asked in Telegram on a twin of the bot: what it answers, and how it leaves things.
async function inTelegram(t0, opts, text) {
  const twin = makeBot(t0, opts);
  await twin.app.handleUpdate(say(OWNER, text));
  return { reply: twin.tg.last().text, state: twin.app.state };
}

test('a one-off date from the app is the same as /book: added, already there, or refused in the same words', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  // Not open yet: booked when it opens.
  let r = await ask(t, phone, 'once', { date: '2026-11-25', start: 1140, hours: 2 });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['ok', 'etag', 'state']);
  assert.deepEqual(r.body.state.once, [{ id: '2026-11-25@19:00', date: '2026-11-25', start: 1140, hours: 2, end: 1260, opensAt: at('2026-11-18T22:00:00Z'), open: false }]);
  assert.equal(r.body.etag, t.app.appState(phone.device).etag);
  assert.deepEqual(t.store.load().once, [{ date: '2026-11-25', start: 1140, hours: 2 }]);
  assert.deepEqual(t.app.state.once, (await inTelegram(NOON, {}, '/book 25 nov 19:00 2h')).state.once);
  // Already open: the PC books it at its next run.
  r = await ask(t, phone, 'once', { date: FRI, start: 1140, hours: 1 });
  assert.deepEqual(r.body.state.open, [{ id: '2026-11-20@19:00', date: FRI, start: 1140, end: 1200 }]);
  assert.deepEqual(r.body.state.once.map(o => [o.id, o.open]), [['2026-11-20@19:00', true], ['2026-11-25@19:00', false]]);
  // There already: said, and left as it was (two hours, not one).
  r = await ask(t, phone, 'once', { date: '2026-11-25', start: 1140, hours: 1 });
  assert.deepEqual([r.status, r.body.ok, r.body.already, r.body.state.once.length, r.body.state.once[1].hours], [200, true, true, 2, 2]);
  assert.deepEqual(Object.keys(r.body), ['ok', 'already', 'etag', 'state']);
  // Refused, each in the words /book uses.
  for (const [body, typed] of [
    [{ date: '2026-11-10', start: 1140, hours: 1 }, '/book 2026-11-10 19:00'],
    [{ date: TUE, start: 600, hours: 1 }, '/book today 10:00'],
    [{ date: '2027-06-01', start: 1140, hours: 1 }, '/book 2027-06-01 19:00'],
    [{ date: '2026-11-25', start: 1155, hours: 1 }, '/book 25 nov 19:15'],
    [{ date: '2026-11-25', start: 1410, hours: 2 }, '/book 25 nov 23:30 2h'],
  ]) {
    r = await ask(t, phone, 'once', body);
    const told = (await inTelegram(NOON, {}, typed)).reply.split('\n')[0];
    assert.deepEqual(r, refused(400, told), typed);
  }
  assert.deepEqual((await ask(t, phone, 'once', { date: '2026-11-10', start: 1140, hours: 1 })).body.why, 'Tue 10 Nov at 19:00 has already passed.');
  assert.deepEqual((await ask(t, phone, 'once', { date: '2027-06-01', start: 1140, hours: 1 })).body.why, 'That is more than 90 days away. Try a nearer date.');
  assert.deepEqual(await ask(t, phone, 'once', { date: '25 nov', start: 1140, hours: 2 }), refused(400, A.WHY.once));
  assert.equal(t.app.state.once.length, 2);
  // /book takes any hour of the day, and so does this: the venue's hours are what the app should offer.
  assert.equal((await ask(t, phone, 'once', { date: '2026-11-26', start: 1320, hours: 1 })).status, 200);
  // The same over HTTP: the state after the change, or the sentence.
  await withServer(t, async ({ post }) => {
    const added = await post('/app/once', { date: '2026-11-28', start: 600, hours: 1 }, { token: phone.token });
    assert.deepEqual([added.status, Object.keys(added.json), added.json.state.once.map(o => o.id).includes('2026-11-28@10:00')], [200, ['ok', 'etag', 'state'], true]);
    assert.equal(added.json.etag, A.etagOf(added.json.state));
    const again = await post('/app/once', { date: '2026-11-28', start: 600, hours: 2 }, { token: phone.token });
    assert.deepEqual([again.status, again.json.already, again.json.etag], [200, true, added.json.etag]);
    assert.deepEqual(await post('/app/once', { date: '2026-11-10', start: 1140, hours: 1 }, { token: phone.token }), { status: 400, json: { ok: false, why: 'Tue 10 Nov at 19:00 has already passed.' } });
    assert.deepEqual(await post('/app/once/remove', { date: '2026-11-28', start: 600 }, { token: phone.token }).then(r => [r.status, r.json.state.once.length]), [200, 3]);
  });
});

test('removing a one-off, every week, court order and pause do what /cancel, /set, /off, /order, /pause and /resume do', async () => {
  const seed = { plan: { tue: { start: 960, hours: 2 } }, once: [{ date: '2026-11-25', start: 1140, hours: 2 }, { date: '2026-11-27', start: 600, hours: 1 }] };
  const t = makeBot(NOON, { state: seed });
  const phone = await linkPhone(t);
  // Remove a one-off (the Remove button; /cancel 1).
  let r = await ask(t, phone, 'once/remove', { date: '2026-11-25', start: 1140 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state.once.map(o => o.id), ['2026-11-27@10:00']);
  assert.deepEqual(t.app.state.once, (await inTelegram(NOON, { state: seed }, '/cancel 1')).state.once);
  r = await ask(t, phone, 'once/remove', { date: '2026-11-25', start: 1140 });             // already gone: nothing to refuse
  assert.deepEqual([r.status, r.body.state.once.length], [200, 1]);
  assert.deepEqual(await ask(t, phone, 'once/remove', { date: '2026-11-25' }), refused(400, A.WHY.onceRemove));
  // Every week (/set).
  r = await ask(t, phone, 'plan', { day: 'thu', start: 1140, hours: 2 });
  assert.deepEqual(r.body.state.plan, [{ day: 'tue', start: 960, hours: 2 }, { day: 'thu', start: 1140, hours: 2 }]);
  assert.deepEqual(t.app.state.plan, (await inTelegram(NOON, { state: seed }, '/set thu 19:00 2h')).state.plan);
  r = await ask(t, phone, 'plan', { day: 'tue', start: 1080, hours: 1 });                  // a day that is set is changed
  assert.deepEqual(r.body.state.plan[0], { day: 'tue', start: 1080, hours: 1 });
  assert.deepEqual(await ask(t, phone, 'plan', { day: 'thu', start: 1145, hours: 1 }), refused(400, (await inTelegram(NOON, {}, '/set thu 19:05')).reply.split('\n')[0]));
  assert.deepEqual(await ask(t, phone, 'plan', { day: 'thu', start: 1380, hours: 2 }), refused(400, (await inTelegram(NOON, {}, '/set thu 23:00 2h')).reply.split('\n')[0]));
  assert.deepEqual(await ask(t, phone, 'plan', { day: 'noday', start: 1140, hours: 1 }), refused(400, A.WHY.plan));
  // Stop a weekday (/off), or all of them (/off all).
  r = await ask(t, phone, 'plan/remove', { day: 'tue' });
  assert.deepEqual(r.body.state.plan, [{ day: 'thu', start: 1140, hours: 2 }]);
  assert.equal((await ask(t, phone, 'plan/remove', { day: 'sat' })).status, 200);          // there was none: nothing to refuse
  r = await ask(t, phone, 'plan/remove', { day: 'all' });
  assert.deepEqual([r.body.state.plan, t.app.state.plan], [[], {}]);
  assert.deepEqual(await ask(t, phone, 'plan/remove', {}), refused(400, A.WHY.planRemove));
  // Court order (/order).
  r = await ask(t, phone, 'order', { order: [6, 5, 4, 3, 2, 1] });
  assert.deepEqual([r.body.state.order, t.store.load().order], [[6, 5, 4, 3, 2, 1], [6, 5, 4, 3, 2, 1]]);
  r = await ask(t, phone, 'order', { order: [2, 4] });
  assert.deepEqual(r.body.state.order, (await inTelegram(NOON, {}, '/order 2 4')).state.order);
  assert.deepEqual(await ask(t, phone, 'order', { order: [2, 2, 4] }), refused(400, 'Courts 1 to 6, each once.'));
  assert.match((await inTelegram(NOON, {}, '/order 2 2 4')).reply, /\nCourts 1 to 6, each once\./);
  assert.deepEqual(t.app.state.order, [2, 4, 1, 3, 5, 6]);
  // Pause and resume.
  r = await ask(t, phone, 'pause', { paused: true });
  assert.deepEqual([r.body.state.paused, t.store.load().paused, t.app.jobsForAgent({}, { run: false }).jobs], [true, true, []]);
  r = await ask(t, phone, 'pause', { paused: false });
  assert.deepEqual([r.body.state.paused, t.store.load().paused], [false, false]);
  assert.deepEqual(await ask(t, phone, 'pause', {}), refused(400, A.WHY.pause));
  // Something the bot does not have is nothing, not an error.
  assert.equal(await ask(t, phone, 'reboot'), null);
  // And a phone that has been unlinked gets nowhere.
  await t.app.handleUpdate(say(OWNER, '/app forget'));
  assert.deepEqual(await ask(t, phone, 'pause', { paused: true }), refused(401, 'unpaired'));
  assert.equal(t.app.state.paused, false);
});

test('Sleep my PC from the app: handed to the PC\'s next ping, and refused when /sleep would refuse', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await t.app.pingFromAgent(HOME);
  const r = await ask(t, phone, 'pc/sleep');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.state.pc.sleepAsked, r.body.state.pc.state, r.body.state.pc.canSleep], [at(NOON), 'awake', true]);
  t.clock.t += 5000;
  assert.deepEqual(await t.app.pingFromAgent(HOME), { ok: true, sleep: true });
  let pc = stateOf(t, phone).pc;
  assert.deepEqual([pc.state, pc.sleepAsked, pc.canSleep, pc.sleepWhy], ['asleep', null, false, 'Your PC is not awake.']);
  assert.deepEqual(await ask(t, phone, 'pc/sleep'), refused(409, 'Your PC is not awake.'));
  assert.equal((await inTelegram(NOON, {}, '/sleep')).reply, 'Your PC is not awake.');
  // The PC would not: said in Telegram, and kept as a note for the app.
  await t.app.pingFromAgent(HOME, { refused: 'the nightly booking task is switched off, so nothing would wake it to book' });
  await settle();
  assert.deepEqual(stateOf(t, phone).notes.map(n => [n.kind, n.title, n.body]), [['info', 'Your PC stayed awake', 'It did not go to sleep: the nightly booking task is switched off, so nothing would wake it to book.']]);
  assert.equal(stateOf(t, phone).pc.state, 'awake');
  // A request nobody collects is forgotten after two minutes.
  await ask(t, phone, 'pc/sleep');
  t.clock.t += 2 * 60000;
  assert.equal(stateOf(t, phone).pc.sleepAsked, t.clock.t - 2 * 60000);
  t.clock.t += 1;
  assert.equal(stateOf(t, phone).pc.sleepAsked, null);
  // In the half hour before a booking the PC stays awake.
  const late = makeBot(`${TUE}T21:35:00Z`, { state: { plan: { tue: { start: 1140, hours: 1 } } } });
  const latePhone = await linkPhone(late);
  await late.app.pingFromAgent(HOME);
  pc = stateOf(late, latePhone).pc;
  assert.deepEqual([pc.canSleep, pc.sleepWhy], [false, 'Your PC books at 22:00, so it stays awake until then.']);
  assert.deepEqual(await ask(late, latePhone, 'pc/sleep'), refused(409, 'Your PC books at 22:00, so it stays awake until then.'));
  await late.app.handleUpdate(say(OWNER, '/sleep'));
  assert.equal(late.tg.last().text, 'Your PC books at 22:00, so it stays awake until then.');
  assert.deepEqual(await late.app.pingFromAgent(HOME), { ok: true });
});

test('a phone\'s push token: given, changed, taken back, and never two phones with the same one', async () => {
  const t = makeBot();
  const a = await linkPhone(t, 'A'), b = await linkPhone(t, 'B');
  let r = await ask(t, a, 'push', { token: PUSH_TOKEN });
  assert.deepEqual([r.status, Object.keys(r.body)], [200, ['ok', 'etag', 'state']]);
  assert.deepEqual(t.store.load().apps.map(d => d.push), [PUSH_TOKEN, null]);
  assert.ok(!JSON.stringify(r.body).includes(PUSH_TOKEN));                                 // it is kept, not shown
  await ask(t, b, 'push', { token: PUSH_TOKEN });                                         // the same phone, linked a second time
  assert.deepEqual(t.app.state.apps.map(d => d.push), [null, PUSH_TOKEN]);
  assert.deepEqual(await ask(t, b, 'push', { token: 'https://example.com/hook' }), refused(400, A.WHY.push));
  assert.deepEqual(await ask(t, b, 'push', {}), refused(400, A.WHY.push));
  await ask(t, b, 'push', { token: null });
  assert.deepEqual(t.store.load().apps.map(d => d.push), [null, null]);
});

// ---------- indoor courts: a look ----------

const pad = n => String(n).padStart(2, '0');
// One slot as Glasgow Club's site sends it (see test/indoor.test.js), and a day's sheet as the PC passes it on.
function slot(date, hh, { status = 'Available', before = false, from = '2026-11-10T00:00:00Z' } = {}) {
  const start = `${date}T${pad(hh)}:00:00Z`;
  return { startTime: start, endTime: `${date}T${pad(hh)}:59:59Z`, bookableFrom: from, bookableUntil: start, isBeforeTimetableSlotBookablePeriod: before, status };
}
const fromPc = courts => Object.entries(courts).map(([n, slots]) => ({ n, s: slots.map(s => [s.startTime, s.endTime, s.bookableFrom, s.bookableUntil, s.isBeforeTimetableSlotBookablePeriod ? 1 : 0, s.status]) }));
const asSite = courts => [{ locations: Object.entries(courts).map(([name, slots]) => ({ locationNameToDisplay: name, slots })) }];
const FRIDAY = { 'Tennis Hall Court 1': [slot(FRI, 18)], 'Tennis Hall Court 3': [slot(FRI, 18), slot(FRI, 19), slot(FRI, 20, { status: 'Unavailable' })] };
// The real reader, with this server turned away by the site (as on Railway), or let in.
const turnedAway = clock => G.createGlasgowClub({ now: () => clock.t, fetchImpl: async () => new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'content-type': 'text/html' } }) });
const letIn = courts => clock => G.createGlasgowClub({ now: () => clock.t, fetchImpl: async url => {
  if (String(url).endsWith('/api/samlauthentication/anonymous')) {
    const headers = new Headers();
    headers.append('set-cookie', 'Jwt=visitor; path=/; secure; httponly');
    return new Response('', { status: 200, headers });
  }
  return new Response(JSON.stringify(asSite(courts)), { status: 200, headers: { 'content-type': 'application/json' } });
} });

test('a look by the PC: asked on its ping like a tap in Telegram, and answered with the free courts by start time', async () => {
  const t = makeBot(NOON, { glasgow: turnedAway });
  const phone = await linkPhone(t);
  await t.app.pingFromAgent(HOME);
  const ping = t.app.pingFromAgent(HOME, { wait: 5 });
  const looking = ask(t, phone, 'indoor/look', { centre: 'g', date: FRI });
  const order = await ping;
  assert.deepEqual([order.look.key, order.look.date], ['g', FRI]);
  t.clock.t += 2000;
  assert.deepEqual(t.app.lookFromAgent({ id: order.look.id, ok: true, sheet: fromPc(FRIDAY) }), { ok: true });
  const r = await looking;
  assert.deepEqual(r, { status: 200, body: { ok: true, look: {
    centre: 'g', date: FRI, at: at(NOON) + 2000, by: 'pc',
    note: 'Free start times, as Glasgow Club showed it at 12:00. Each is one hour. Pick one.',
    slots: [
      { start: 1080, end: 1140, courts: [{ n: 1, name: 'Tennis Hall Court 1', price: null }, { n: 3, name: 'Tennis Hall Court 3', price: null }] },
      { start: 1140, end: 1200, courts: [{ n: 3, name: 'Tennis Hall Court 3', price: null }] },
    ],
    sheet: SHEET_G,
  } } });
  // The same day again within the minute is what is known already: the PC is not asked twice.
  const idle = t.app.pingFromAgent(HOME, { wait: 0.03 });
  assert.deepEqual((await ask(t, phone, 'indoor/look', { centre: 'g', date: FRI })).body.look, r.body.look);
  assert.deepEqual(await idle, { ok: true });
  // Telegram's card for that day says the same words, from the same read.
  await tap(t.app, 'gd:g:20261120', 7);
  assert.equal(t.tg.last().text.split('\n')[1], r.body.look.note);
  // Over HTTP the request simply waits for the PC.
  await withServer(t, async ({ post }) => {
    t.clock.t += 61000;
    await t.app.pingFromAgent(HOME);
    const next = t.app.pingFromAgent(HOME, { wait: 5 });
    const asked = post('/app/indoor/look', { centre: 's', date: FRI, fresh: true }, { token: phone.token });
    const o = await next;
    assert.deepEqual([o.look.key, o.look.date], ['s', FRI]);
    await sleep(40);
    t.app.lookFromAgent({ id: o.look.id, ok: true, sheet: fromPc({ 'Tennis Court 2': [slot(FRI, 9, { status: 'Unavailable' })] }) });
    const got = await asked;
    assert.equal(got.status, 200);
    assert.deepEqual(Object.keys(got.json), ['ok', 'look']);
    assert.deepEqual([got.json.look.by, got.json.look.slots, got.json.look.note], ['pc', [], 'No court is free that day, as Glasgow Club showed it at 12:01.']);
    assert.match(got.json.look.sheet, /\/SA011\?activityDate=2026-11-20T/);
  });
});

test('a look by the bot itself, where Glasgow Club lets this server in; and a day that has not opened yet', async () => {
  const opens = '2026-11-18T00:00:00Z';
  const t = makeBot(NOON, { glasgow: letIn({ 'Tennis Hall Court 2': [slot('2026-11-25', 18, { before: true, from: opens }), slot('2026-11-25', 19, { before: true, from: opens })] }) });
  const phone = await linkPhone(t);                                                       // the PC is not in touch: the bot reads
  const r = await ask(t, phone, 'indoor/look', { centre: 's', date: '2026-11-25' });
  assert.deepEqual(r.body.look, {
    centre: 's', date: '2026-11-25', at: at(NOON), by: 'bot',
    note: 'Not open for booking yet: Glasgow Club opens it at 00:00 on Wed 18 Nov (the midnight after Tue 17 Nov).\nFree as it stands: 18:00, 19:00.',
    slots: [],                                                                            // nothing can be booked, or held, until then
    sheet: 'https://glasgowclub.gladstonego.cloud/book/calendar/SA011?activityDate=2026-11-25T00:00:00.000Z',
  });
  const open = makeBot(NOON, { glasgow: letIn(FRIDAY) });
  const openPhone = await linkPhone(open);
  const got = (await ask(open, openPhone, 'indoor/look', { centre: 'g', date: FRI })).body.look;
  assert.deepEqual([got.by, got.slots.map(s => [s.start, s.courts.map(c => c.n)])], ['bot', [[1080, [1, 3]], [1140, [3]]]]);
});

test('a look that cannot be made is refused in the words Telegram\'s card would show', async () => {
  // What Telegram shows for the same day in the same circumstances: the line under the card's title.
  const cardSays = async (t0, opts, prepare) => {
    const twin = makeBot(t0, opts);
    if (prepare) await prepare(twin);
    await tap(twin.app, 'gd:g:20261120', 7);
    return twin.tg.last().text.split('\n')[1];
  };
  // The PC is awake but does not answer in time.
  const slowPc = { glasgow: turnedAway, pcLookMs: 30 };
  const a = makeBot(NOON, slowPc);
  const phoneA = await linkPhone(a);
  await a.app.pingFromAgent(HOME);
  const noAnswer = 'Your PC did not answer in time, so I could not read Glasgow Club\'s free courts.';
  assert.deepEqual(await ask(a, phoneA, 'indoor/look', { centre: 'g', date: FRI }), refused(409, noAnswer));
  assert.equal(await cardSays(NOON, slowPc, twin => twin.app.pingFromAgent(HOME)), noAnswer);
  // This server is turned away and the PC is not awake.
  const b = makeBot(NOON, { glasgow: turnedAway });
  const phoneB = await linkPhone(b);
  const asleep = 'Glasgow Club\'s site turns this server away, so your PC reads the free courts for me, and your PC is not awake. Wake it and try again, or open the sheet.';
  assert.deepEqual(await ask(b, phoneB, 'indoor/look', { centre: 'g', date: FRI }), refused(409, asleep));
  assert.equal(await cardSays(NOON, { glasgow: turnedAway }), asleep);
  // Around the PC's nightly booking run nothing is asked of it.
  const c = makeBot(`${TUE}T21:52:00Z`, { glasgow: turnedAway });
  const phoneC = await linkPhone(c);
  await c.app.pingFromAgent(HOME);
  const held = c.app.pingFromAgent(HOME, { wait: 0.03 });
  const busy = 'Your PC\'s nightly booking run is at 22:00, so I am asking nothing else of it until 22:10.';
  assert.deepEqual(await ask(c, phoneC, 'indoor/look', { centre: 'g', date: FRI }), refused(409, busy));
  assert.deepEqual(await held, { ok: true });
  assert.equal(await cardSays(`${TUE}T21:52:00Z`, { glasgow: turnedAway }, twin => twin.app.pingFromAgent(HOME)), busy);
  // The PC says the site turned it away: its words, and no more asking for an hour.
  const d = makeBot(NOON, { glasgow: turnedAway });
  const phoneD = await linkPhone(d);
  await d.app.pingFromAgent(HOME);
  const ping = d.app.pingFromAgent(HOME, { wait: 5 });
  const looking = ask(d, phoneD, 'indoor/look', { centre: 'g', date: FRI });
  d.app.lookFromAgent({ id: (await ping).look.id, ok: false, kind: 'challenge', why: 'the site is checking its visitors' });
  assert.deepEqual(await looking, refused(409, 'Glasgow Club\'s site is checking visitors from your home connection just now, so your PC cannot read the free courts. It will not be asked again for an hour.'));
  const quiet = stateOf(d, phoneD).indoor;
  assert.deepEqual([quiet.quietUntil, quiet.holdNo], [at(NOON) + 60 * 60000, 'Glasgow Club\'s site was checking visitors from your home connection, so your PC is leaving it alone until 13:00.']);
  d.clock.t += 60 * 60000;
  assert.deepEqual([stateOf(d, phoneD).indoor.quietUntil, stateOf(d, phoneD).pc.state], [null, 'asleep']);
  // A day that is not on offer, in the words of the button that is out of date.
  const e = makeBot();
  const phoneE = await linkPhone(e);
  for (const date of ['2026-11-16', '2026-11-26', '2026-11-31']) assert.deepEqual(await ask(e, phoneE, 'indoor/look', { centre: 'g', date }), refused(400, 'That day is no longer on offer. Pick again.'), date);
  await tap(e.app, 'gd:g:20261126', 7);
  assert.equal(lastAnswer(e), 'That day is no longer on offer. Pick again.');
  assert.deepEqual(await ask(e, phoneE, 'indoor/look', { centre: 'k', date: FRI }), refused(400, A.WHY.centre));
  assert.deepEqual(e.glasgow.asked, []);
  assert.equal((await ask(e, phoneE, 'indoor/look', { centre: 'g', date: '2026-11-25' })).status, 200);       // the ninth day is on offer
});

// ---------- indoor courts: a hold ----------

const HOLD = { centre: 'g', date: FRI, start: 1080, court: 3 };
// A phone linked, the PC in touch, a hold asked for from the app and collected by the PC's waiting ping.
async function heldFromApp(t0 = NOON, opts = {}) {
  const t = makeBot(t0, opts);
  const phone = await linkPhone(t);
  await ask(t, phone, 'push', { token: PUSH_TOKEN });
  await t.app.pingFromAgent(HOME);
  await seeFree(t, phone);                                      // the app has been shown court 3 free at 18:00
  t.tg.clear();
  const ping = t.app.pingFromAgent(HOME, { wait: 5 });
  const asked = await ask(t, phone, 'hold', HOLD);
  const order = await ping;
  return { ...t, phone, asked, order, id: order.hold && order.hold.id };
}
const pcSays = (t, stage, extra = {}) => t.app.holdFromAgent({ id: t.id, key: 'g', date: FRI, start: 1080, court: 3, stage, ...extra });

test('a hold from the app, end to end: asked, collected, signed in, in the basket, let go', async () => {
  const t = await heldFromApp();
  // Asked: the answer is the state, with the hold in the card's own words.
  assert.equal(t.asked.status, 200);
  assert.deepEqual(Object.keys(t.asked.body), ['ok', 'etag', 'state']);
  const first = t.asked.body.state.hold;
  assert.match(first.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(first, {
    id: first.id, startedBy: 'app', centre: 'g', centreName: 'Gorbals', date: FRI, start: 1080, end: 1140, court: 3, courtName: 'Court 3',
    stage: 'asked', live: true, ended: null, price: null, until: null, heardAt: at(NOON),
    title: TITLE,
    lines: ['Asking your PC to hold it. It signs in to Glasgow Club, puts the court in your basket and opens the payment page: under a minute.'],
    can: { release: true, done: false, pay: false },
    links: { basket: 'https://glasgowclub.gladstonego.cloud/book/basket', site: 'https://glasgowclub.gladstonego.cloud/', sheet: SHEET_G },
  });
  assert.equal(t.asked.body.state.indoor.holdNo, 'Your PC is already holding a court.');
  assert.deepEqual([t.asked.body.state.pc.canSleep, t.asked.body.state.pc.sleepWhy], [false, 'Your PC is holding a court for you. Let it go first.']);
  // The PC's ping collects exactly what a tap in Telegram hands it.
  assert.deepEqual(t.order, { ok: true, hold: { id: first.id, key: 'g', date: FRI, start: 1080, court: 3 } });
  const hold = () => stateOf(t, t.phone).hold;
  assert.deepEqual([hold().stage, hold().lines], ['asked', ['Your PC has it and is starting Chrome…']]);
  for (const [stage, words] of [['signing-in', 'Your PC is signing in to Glasgow Club…'], ['signed-in', 'Signed in. Finding the court on the sheet…'], ['adding', 'Putting court 3 in your basket…']]) {
    assert.deepEqual(pcSays(t, stage), { ok: true });
    assert.deepEqual([hold().stage, hold().lines, hold().can, hold().live], [stage, [words], { release: true, done: false, pay: false }, true]);
  }
  t.clock.t += 30000;
  assert.deepEqual(pcSays(t, 'held', { price: '£23.00', left: 12 * 60000 }), { ok: true });
  assert.deepEqual(hold(), {
    ...first, stage: 'held', price: '£23.00', until: at(NOON) + 30000 + 12 * 60000, heardAt: at(NOON) + 30000,
    lines: [
      'In your basket: £23.00 to pay. Your PC signed in as you and put it there at 12:00. The payment page is open in Chrome on your PC.',
      'Pay in the Chrome window on your PC, then tap I have paid.',
      'Unpaid, your PC lets it go at 12:12.',
    ],
    can: { release: true, done: true, pay: false },
  });
  // While it holds a court the PC is not put to sleep, from the app or from Telegram.
  assert.deepEqual(await ask(t, t.phone, 'pc/sleep'), refused(409, 'Your PC is holding a court for you. Let it go first.'));
  await t.app.handleUpdate(say(OWNER, '/sleep'));
  assert.equal(t.tg.last().text, 'Your PC is holding a court for you. Let it go first.');
  t.tg.clear();
  // Let it go: said in the state, and the PC hears it on its next note.
  const etag = t.app.appState(t.phone.device).etag;
  const let_go = await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' });
  assert.equal(let_go.status, 200);
  assert.notEqual(let_go.body.etag, etag);
  assert.deepEqual([let_go.body.state.hold.lines[1], let_go.body.state.hold.can, let_go.body.state.hold.lines.length], ['Letting it go…', { release: false, done: false, pay: false }, 2]);
  assert.deepEqual(pcSays(t, 'held', { beat: true }), { ok: true, order: 'release' });
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' }), refused(409, 'Already letting it go.'));
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'done' }), refused(409, 'Already letting it go.'));
  t.clock.t += 5000;
  assert.deepEqual(pcSays(t, 'released', { basket: 'empty', removed: 1, why: 'release', checked: true }), { ok: true });
  assert.deepEqual(hold(), {
    ...first, stage: 'held', live: false, ended: 'released', price: '£23.00', until: at(NOON) + 30000 + 12 * 60000, heardAt: at(NOON) + 35000,
    lines: ['Let go: your PC took the court out of your basket, so it was not paid for.'],
    can: { release: false, done: false, pay: false },
  });
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' }), refused(409, 'That hold is over.'));
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: 'ffffffffffff', what: 'release' }), refused(409, 'I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up.'));
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'pay' }), refused(400, A.WHY.pay));
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'pay!' }), refused(400, A.WHY.holdOrder));
  // How it ended is a note, and a notification to the phone.
  await settle();
  const note = stateOf(t, t.phone).notes[0];
  assert.deepEqual([note.kind, note.title, note.body, note.at], ['hold', 'Hold ended · Gorbals court 3', 'Fri 20 Nov · 18:00–19:00. Let go: your PC took the court out of your basket, so it was not paid for.', at(NOON) + 35000]);
  assert.deepEqual(t.pushes, [{ tokens: [PUSH_TOKEN], title: note.title, body: note.body }]);
  // Nothing of it went to Telegram: a hold started from the app has no card there.
  assert.equal(t.tg.calls.length, 0);
  assert.ok(t.logs.includes('Hold asked for: Gorbals 2026-11-20 18:00 court 3.'));
  assert.ok(t.logs.includes('Hold released: Gorbals 2026-11-20 18:00 court 3 (release).'));
  // It is over, so another can start, and the PC can sleep again.
  assert.deepEqual([stateOf(t, t.phone).indoor.holdNo, stateOf(t, t.phone).pc.canSleep], [null, true]);
});

test('I have paid from the app: the PC looks at the Bookings page, and "booked" is only ever its word', async () => {
  const t = await heldFromApp();
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'done' }), refused(409, 'It is not in your basket yet.'));
  pcSays(t, 'signing-in');
  pcSays(t, 'held', { price: 'free!', left: 12 * 60000 });
  assert.equal(stateOf(t, t.phone).hold.price, null);                                     // a price that does not read as one is left out
  const r = await ask(t, t.phone, 'hold/order', { id: t.id, what: 'done' });
  assert.deepEqual([r.status, r.body.state.hold.lines[1], r.body.state.hold.can], [200, 'Looking for it on your Bookings page…', { release: false, done: false, pay: false }]);
  assert.deepEqual(pcSays(t, 'held', { beat: true }), { ok: true, order: 'done' });
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' }), refused(409, 'Already checking.'));
  assert.deepEqual(pcSays(t, 'booked', { words: 'Thank you <Francisco>. Reference ########' }), { ok: true });
  const h = stateOf(t, t.phone).hold;
  assert.deepEqual([h.ended, h.live, h.lines], ['booked', false, ['Booked. It is on your Bookings page at Glasgow Club now, and was not before.', 'After the payment the page said: “Thank you <Francisco>. Reference ########”']]);
  await settle();
  assert.deepEqual(t.pushes.map(p => [p.title, p.body]), [['Booked · Gorbals court 3', 'Fri 20 Nov · 18:00–19:00. Booked. It is on your Bookings page at Glasgow Club now, and was not before. After the payment the page said: “Thank you <Francisco>. Reference ########”']]);
  assert.equal(stateOf(t, t.phone).notes[0].kind, 'hold');
});

test('a hold from the app is refused where the Hold button would refuse, in the card\'s words', async () => {
  // What the Hold button says in Telegram in the same circumstances: the toast, and the line on the card.
  const buttonSays = async (t0, opts, prepare) => {
    const twin = makeBot(t0, opts);
    if (prepare) await prepare(twin);
    await tap(twin.app, 'gh:g:20261120:1800:3', 7);
    return { toast: lastAnswer(twin), line: twin.tg.last() ? twin.tg.last().text.split('\n')[1] : null };
  };
  const awake = twin => twin.app.pingFromAgent(HOME);
  // The PC is not awake.
  const a = makeBot();
  const phoneA = await linkPhone(a);
  await seeFree(a, phoneA);
  const notAwake = 'Your PC is not awake, and it is your PC that signs in to Glasgow Club and holds the court. Wake it and try again.';
  assert.deepEqual(await ask(a, phoneA, 'hold', HOLD), refused(409, notAwake));
  assert.equal((await buttonSays(NOON, {})).line, notAwake);
  assert.equal(stateOf(a, phoneA).hold, null);
  // Around the nightly booking run: from 21:25 to 22:15, every night.
  const nearRun = 'Your PC\'s nightly booking run is at 22:00, so it holds nothing else from 21:25 to 22:15. The sheet below still opens.';
  for (const [time, goes] of [['21:24:59', true], ['21:25:00', false], ['22:15:00', false], ['22:15:01', true]]) {
    const b = makeBot(`${TUE}T${time}Z`);
    const phoneB = await linkPhone(b);
    await b.app.pingFromAgent(HOME);
    await seeFree(b, phoneB);
    assert.equal(stateOf(b, phoneB).indoor.holdNo, goes ? null : nearRun, time);
    const r = await ask(b, phoneB, 'hold', HOLD);
    if (goes) assert.equal(r.status, 200, time); else assert.deepEqual(r, refused(409, nearRun), time);
  }
  assert.equal((await buttonSays(`${TUE}T21:30:00Z`, {}, awake)).line, nearRun);
  // A time that is not on offer: passed, too far ahead, not a court, not a time.
  const c = makeBot();
  const phoneC = await linkPhone(c);
  await c.app.pingFromAgent(HOME);
  for (const body of [{ ...HOLD, date: TUE, start: 660 }, { ...HOLD, date: '2026-11-16' }, { ...HOLD, date: '2026-11-26' }, { ...HOLD, date: '2026-11-31' }, { ...HOLD, court: 0 }, { ...HOLD, court: 21 }, { ...HOLD, start: 1083 }, { ...HOLD, start: 1440 }, { ...HOLD, start: -60 }]) {
    assert.deepEqual(await ask(c, phoneC, 'hold', body), refused(400, 'That time is no longer on offer. Pick again.'), JSON.stringify(body));
  }
  await tap(c.app, 'gh:g:20261117:1100:3', 7);
  assert.equal(lastAnswer(c), 'That time is no longer on offer. Pick again.');
  assert.deepEqual(await ask(c, phoneC, 'hold', { ...HOLD, court: '3' }), refused(400, A.WHY.hold));
  assert.deepEqual(await ask(c, phoneC, 'hold', { ...HOLD, centre: 'x' }), refused(400, A.WHY.centre));
  assert.deepEqual(await c.app.pingFromAgent(HOME), { ok: true });                        // nothing was handed to the PC
  assert.equal(stateOf(c, phoneC).hold, null);
  // One hold at a time, whoever started it; and six in an hour at most, counted together.
  await seeFree(c, phoneC);
  assert.equal((await ask(c, phoneC, 'hold', HOLD)).status, 200);
  assert.deepEqual(await ask(c, phoneC, 'hold', { ...HOLD, start: 1140 }), refused(409, 'Your PC is already holding a court.'));
  const d = makeBot();
  const phoneD = await linkPhone(d);
  await seeFree(d, phoneD);
  for (let i = 0; i < 6; i++) {
    await d.app.pingFromAgent(HOME);
    const ping = d.app.pingFromAgent(HOME, { wait: 5 });
    if (i % 2) await tap(d.app, 'gh:g:20261120:1800:3', 7); else assert.equal((await ask(d, phoneD, 'hold', HOLD)).status, 200);
    d.app.holdFromAgent({ id: (await ping).hold.id, stage: 'failed', why: 'court 3 is not free at 18:00 any more' });
    d.clock.t += 60000;
  }
  await d.app.pingFromAgent(HOME);
  const tooMany = 'That is 6 holds within an hour, and each is a sign-in to Glasgow Club. The next can start at 13:00.';
  assert.deepEqual(await ask(d, phoneD, 'hold', HOLD), refused(409, tooMany));
  assert.equal(stateOf(d, phoneD).indoor.holdNo, tooMany);
  await tap(d.app, 'gh:g:20261120:1800:3', 7);
  await settle();
  assert.equal(d.tg.last().text.split('\n')[1], tooMany);
});

test('a hold from the app with nobody to carry it out ends as it does in Telegram: not collected, never started, or silent', async () => {
  // No ping collects it within 25 seconds.
  const a = makeBot();
  const phoneA = await linkPhone(a);
  await a.app.pingFromAgent(HOME);
  await seeFree(a, phoneA);
  a.tg.clear();
  const id = (await ask(a, phoneA, 'hold', HOLD)).body.state.hold.id;
  a.clock.t += 24999;
  await a.app.tick();
  assert.deepEqual([stateOf(a, phoneA).hold.ended, stateOf(a, phoneA).hold.live], [null, true]);
  a.clock.t += 1;
  await a.app.tick();
  let h = stateOf(a, phoneA).hold;
  assert.deepEqual([h.ended, h.live, h.lines, h.can], ['nopickup', false, ['Your PC did not pick it up in time, so nothing was done. It may have gone to sleep.'], { release: false, done: false, pay: false }]);
  assert.deepEqual(await a.app.pingFromAgent(HOME), { ok: true });                         // it is not handed over late
  assert.deepEqual(a.app.holdFromAgent({ id, stage: 'signing-in' }), { ok: true, order: 'release' });         // and a PC that has it after all is told to let go
  assert.equal(stateOf(a, phoneA).notes[0].body, 'Fri 20 Nov · 18:00–19:00. Your PC did not pick it up in time, so nothing was done. It may have gone to sleep.');
  assert.ok(a.logs.includes('Your PC did not collect the court to hold in time.'));
  // Collected, and then not a word: over after a minute and a half.
  const b = await heldFromApp();
  b.clock.t += 89999;
  await b.app.tick();
  assert.equal(stateOf(b, b.phone).hold.ended, null);
  b.clock.t += 1;
  await b.app.tick();
  assert.deepEqual([stateOf(b, b.phone).hold.ended, stateOf(b, b.phone).hold.lines], ['nostart', ['Your PC picked it up but never started on it, so nothing was done. Its PC link may need restarting.']]);
  // The PC's own word on how it ended then replaces what was assumed here, with a note of its own.
  assert.deepEqual(pcSays(b, 'released', { basket: 'untouched', why: 'release' }), { ok: true });
  assert.deepEqual([stateOf(b, b.phone).hold.ended, stateOf(b, b.phone).hold.lines], ['released', ['Stopped. Nothing had gone into your basket.']]);
  assert.deepEqual(stateOf(b, b.phone).notes.map(n => n.body.slice(26, 60)), ['Stopped. Nothing had gone into you', 'Your PC picked it up but never sta']);
  // It reaches the basket and the PC goes silent: said after 75 seconds, and over seven minutes after its time was up.
  const c = await heldFromApp();
  pcSays(c, 'signing-in');
  pcSays(c, 'held', { price: '£23.00', left: 12 * 60000 });
  c.clock.t += 75000;
  await c.app.tick();
  assert.equal(stateOf(c, c.phone).hold.lines.pop(), 'No word from your PC for over a minute. It may have lost its connection.');
  c.clock.t = at(NOON) + 19 * 60000 - 1;
  await c.app.tick();
  assert.equal(stateOf(c, c.phone).hold.ended, null);
  c.clock.t += 1;
  await c.app.tick();
  h = stateOf(c, c.phone).hold;
  assert.deepEqual([h.ended, h.lines], ['timeout', ['I have heard nothing more from your PC about this. If the court was in your basket and not paid for, the hold lapses by itself.']]);
  // Stopped from the app before the PC collected it.
  const d = makeBot();
  const phoneD = await linkPhone(d);
  await d.app.pingFromAgent(HOME);
  await seeFree(d, phoneD);
  const asked = (await ask(d, phoneD, 'hold', HOLD)).body.state.hold;
  const stopped = await ask(d, phoneD, 'hold/order', { id: asked.id, what: 'release' });
  assert.deepEqual([stopped.status, stopped.body.state.hold.ended, stopped.body.state.hold.lines], [200, 'stopped', ['Stopped before your PC had started. Nothing was done.']]);
  assert.deepEqual(await d.app.pingFromAgent(HOME, { wait: 0.02 }), { ok: true });
  // None of this drew anything in Telegram.
  for (const t of [a, b, c]) assert.equal(t.tg.calls.length, 0);
});

test('Telegram\'s buttons work on a hold started from the app: a Hold tap brings its card, and I have paid goes to the PC', async () => {
  const t = await heldFromApp();
  pcSays(t, 'signing-in');
  pcSays(t, 'held', { price: '£23.00', left: 12 * 60000 });
  await settle();
  assert.equal(t.tg.calls.length, 0);
  // A tap on Hold, on any card, while that court is held: the card becomes the hold's.
  await tap(t.app, 'gh:g:20261120:1900:3', 8);
  assert.equal(lastAnswer(t), 'Your PC is already holding a court.');
  await settle();
  assert.deepEqual(t.tg.calls.map(c => c.id), [8]);
  assert.equal(t.tg.last().text.split('\n')[0], `<b>${TITLE}</b>`);
  assert.deepEqual(buttons(t.tg.last()).map(b => [b.text, b.callback_data || b.url]), [['I have paid', `gp:${t.id}`], ['Let it go', `gx:${t.id}`]]);
  assert.deepEqual(await t.app.pingFromAgent(HOME), { ok: true });                         // no second hold was handed over
  // I have paid, tapped in Telegram: the app sees it, and the PC hears it.
  await tap(t.app, `gp:${t.id}`, 8);
  assert.equal(lastAnswer(t), 'Checking your Bookings page');
  let h = stateOf(t, t.phone).hold;
  assert.deepEqual([h.startedBy, h.lines[1], h.can], ['app', 'Looking for it on your Bookings page…', { release: false, done: false, pay: false }]);
  assert.deepEqual(pcSays(t, 'held', { beat: true }), { ok: true, order: 'done' });
  pcSays(t, 'unsure', { words: '', checked: true, basket: 'still' });
  await settle();
  // From now on the card in Telegram follows it too, to the end.
  assert.equal(t.tg.last().id, 8);
  assert.deepEqual(t.tg.last().text.split('\n').slice(1).map(A.plain), stateOf(t, t.phone).hold.lines);
  h = stateOf(t, t.phone).hold;
  assert.deepEqual([h.ended, h.lines[0]], ['unsure', 'You said you have paid, but I could not see the court as a new booking on your Bookings page.']);
  assert.deepEqual(texts(t.tg.last()), ['Open Glasgow Club', 'Other times', 'Menu']);
});

test('a hold started in Telegram shows in the app, which can let it go; its card says so', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await t.app.pingFromAgent(HOME);
  const ping = t.app.pingFromAgent(HOME, { wait: 5 });
  await tap(t.app, 'gh:g:20261120:1800:3', 7);
  const order = await ping;
  await settle();
  let h = stateOf(t, phone).hold;
  assert.deepEqual([h.id, h.startedBy, h.stage, h.title, h.lines, h.can], [order.hold.id, 'telegram', 'asked', TITLE, ['Your PC has it and is starting Chrome…'], { release: true, done: false, pay: false }]);
  assert.deepEqual(t.tg.last().text.split('\n').map(A.plain), [h.title, ...h.lines]);
  t.app.holdFromAgent({ id: h.id, stage: 'signing-in' });
  // Stop, from the app: the card in Telegram says "Stopping…", and the PC hears it on its next step.
  const r = await ask(t, phone, 'hold/order', { id: h.id, what: 'release' });
  assert.equal(r.status, 200);
  await settle();
  assert.deepEqual(t.tg.last().text.split('\n').slice(1), ['Your PC is signing in to Glasgow Club…', 'Stopping…']);
  assert.deepEqual(texts(t.tg.last()), []);
  assert.deepEqual(t.app.holdFromAgent({ id: h.id, stage: 'signed-in' }), { ok: true, order: 'release' });
  t.app.holdFromAgent({ id: h.id, stage: 'released', basket: 'untouched', why: 'release' });
  await settle();
  assert.deepEqual(t.tg.last().text.split('\n').slice(1), ['Stopped. Nothing had gone into your basket.']);
  h = stateOf(t, phone).hold;
  assert.deepEqual([h.ended, h.live, h.startedBy, h.lines], ['released', false, 'telegram', ['Stopped. Nothing had gone into your basket.']]);
  // Its ending is a note too, though it was started in Telegram.
  assert.deepEqual(stateOf(t, phone).notes.map(n => [n.kind, n.title]), [['hold', 'Hold ended · Gorbals court 3']]);
  // Over HTTP, the same request and the same refusal.
  await withServer(t, async ({ post }) => {
    assert.deepEqual(await post('/app/hold/order', { id: h.id, what: 'release' }, { token: phone.token }), { status: 409, json: { ok: false, why: 'That hold is over.' } });
    assert.deepEqual(await post('/app/hold', HOLD, { token: phone.token }), { status: 409, json: { ok: false, why: 'That list is old. Read the day again, then hold a court.' } });      // the app has not looked at that day yet
    assert.equal((await post('/app/indoor/look', { centre: 'g', date: FRI }, { token: phone.token })).status, 200);
    const started = await post('/app/hold', HOLD, { token: phone.token });
    assert.deepEqual([started.status, started.json.state.hold.startedBy, started.json.state.hold.stage], [200, 'app', 'asked']);
    assert.deepEqual(await post('/app/hold', { ...HOLD, court: 4 }, { token: phone.token }), { status: 409, json: { ok: false, why: 'Your PC is already holding a court.' } });
  });
});

// ---------- notes and notifications ----------

test('a court booked, or not, is a note and a notification, in the card\'s own facts', async () => {
  const t = makeBot(`${TUE}T22:00:10Z`);
  const a = await linkPhone(t, 'A'), b = await linkPhone(t, 'B'), c = await linkPhone(t, 'C');
  await ask(t, a, 'push', { token: PUSH_TOKEN });
  await ask(t, c, 'push', { token: 'ExpoPushToken[second-phone]' });
  t.tg.clear();
  assert.deepEqual(await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 }), { ok: true });
  assert.equal(t.tg.last().text, '<b>Booked · Court 3</b>\nTue 24 Nov · 16:00–18:00\nGate code: <code>2433</code>  (tap to copy)');
  await settle();
  let notes = stateOf(t, b).notes;
  assert.deepEqual(notes.map(n => [n.kind, n.title, n.body, n.at]), [['booked', 'Court 3 booked', 'Tue 24 Nov · 16:00–18:00 · gate 2433', at(`${TUE}T22:00:10Z`)]]);
  assert.match(notes[0].id, /^[0-9a-f]{10}$/);
  assert.deepEqual(Object.keys(notes[0]), ['id', 'at', 'kind', 'title', 'body']);
  // One notification, to every phone that gave a token (and not to the one that did not).
  assert.deepEqual(t.pushes, [{ tokens: [PUSH_TOKEN, 'ExpoPushToken[second-phone]'], title: 'Court 3 booked', body: 'Tue 24 Nov · 16:00–18:00 · gate 2433' }]);
  // The same result again (the PC retrying) is neither said nor noted twice.
  await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  await settle();
  assert.deepEqual([stateOf(t, b).notes.length, t.pushes.length, t.tg.calls.length], [1, 1, 1]);
  // Booked with no gate code shown; nothing free; and a failure, in the PC's own words.
  t.clock.t += 1000;
  await t.app.resultFromAgent({ id: '2026-11-25@19:00', status: 'booked', court: 4, end: 1260 });
  t.clock.t += 1000;
  await t.app.resultFromAgent({ id: '2026-11-24@19:00', status: 'none', end: 1260 });
  t.clock.t += 1000;
  await t.app.resultFromAgent({ id: '2026-11-24@20:00', status: 'failed', why: 'the sheet did not load <at all>', end: 1260 });
  await settle();
  notes = stateOf(t, b).notes;
  assert.deepEqual(notes.map(n => [n.kind, n.title, n.body]), [
    ['missed', 'Not booked', 'Tue 24 Nov · 20:00–21:00. It did not work: the sheet did not load <at all>.'],
    ['missed', 'Not booked', 'Tue 24 Nov · 19:00–21:00. No court was free for the whole slot.'],
    ['booked', 'Court 4 booked', 'Wed 25 Nov · 19:00–21:00 · gate code not shown'],
    ['booked', 'Court 3 booked', 'Tue 24 Nov · 16:00–18:00 · gate 2433'],
  ]);
  assert.deepEqual(t.pushes.map(p => p.title), ['Court 3 booked', 'Court 4 booked', 'Not booked', 'Not booked']);
  assert.deepEqual(t.store.load().notes, t.app.state.notes);
  // A result Telegram would not take is not recorded, and not noted: the PC sends it again.
  t.tg.failSend = 1;
  await assert.rejects(t.app.resultFromAgent({ id: '2026-11-26@19:00', status: 'booked', court: 2, end: 1200 }));
  await settle();
  assert.deepEqual([stateOf(t, b).notes.length, t.pushes.length], [4, 4]);
  // With no phone asking for notifications, the push service is not called at all.
  await ask(t, a, 'push', { token: null });
  await ask(t, c, 'push', { token: null });
  await t.app.resultFromAgent({ id: '2026-11-26@19:00', status: 'booked', court: 2, end: 1200 });
  await settle();
  assert.deepEqual([stateOf(t, b).notes.length, t.pushes.length], [5, 4]);
});

test('a push that fails, throws or never comes back does not hold up or break the Telegram message', async () => {
  for (const [name, push] of [
    ['throws', () => { throw new Error('boom'); }],
    ['rejects', async () => { throw new Error('boom'); }],
    ['hangs', () => new Promise(() => {})],
    ['is not a function', 'nonsense'],
  ]) {
    const t = makeBot(`${TUE}T22:00:10Z`, { push });
    const phone = await linkPhone(t);
    await ask(t, phone, 'push', { token: PUSH_TOKEN });
    t.tg.clear();
    assert.deepEqual(await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 }), { ok: true }, name);
    assert.equal(t.tg.last().text.split('\n')[0], '<b>Booked · Court 3</b>', name);
    assert.equal(t.app.state.results['2026-11-24@16:00'].court, '3', name);
    assert.equal(stateOf(t, phone).notes[0].title, 'Court 3 booked', name);
    await settle();
    if (name !== 'hangs') assert.ok(t.logs.some(l => /^A notification could not be sent: /.test(l)), name);
    // A hold's ending, the same.
    await t.app.pingFromAgent(HOME);
    t.clock.t = at(`${TUE}T22:20:00Z`);
    await t.app.pingFromAgent(HOME);
    const ping = t.app.pingFromAgent(HOME, { wait: 5 });
    await tap(t.app, 'gh:g:20261120:1800:3', 7);
    const id = (await ping).hold.id;
    assert.deepEqual(t.app.holdFromAgent({ id, stage: 'refused', why: 'the nightly booking is running' }), { ok: true }, name);
    await settle();
    assert.deepEqual(t.tg.last().text.split('\n').slice(1), ['Your PC did not start on it: the nightly booking is running.', 'Nothing was done.'], name);
    assert.equal(stateOf(t, phone).notes[0].body, 'Fri 20 Nov · 18:00–19:00. Your PC did not start on it: the nightly booking is running. Nothing was done.', name);
  }
});

test('the warnings around a booking night, trouble, and the heads-up are notes too, each once', async () => {
  const PLAN = { tue: { start: 960, hours: 2 } };
  // Twenty minutes before: the PC does not answer the wake-up.
  const a = makeBot(`${TUE}T21:40:00Z`, { env: WAKE, state: { plan: PLAN, lastSeen: at(`${TUE}T18:00:00Z`), home: { ip: HOME.ip, at: 1 } } });
  const phoneA = await linkPhone(a);
  await ask(a, phoneA, 'push', { token: PUSH_TOKEN });
  await a.app.tick();
  a.clock.t = at(`${TUE}T21:43:00Z`);
  await a.app.tick();
  await a.app.tick();
  assert.match(a.tg.last().text, /^<b>Your PC is not answering<\/b>/);
  assert.deepEqual(stateOf(a, phoneA).notes.map(n => [n.kind, n.title, n.body]), [['warn', 'Your PC is not answering', 'I sent it a wake-up at 21:40, ahead of tonight\'s booking, and it has not replied. Booking opens at 22:00 for Tue 24 Nov · 16:00–18:00.']]);
  // Two minutes before: the run has not started.
  a.clock.t = at(`${TUE}T21:58:00Z`);
  await a.app.tick();
  await a.app.tick();
  assert.deepEqual(stateOf(a, phoneA).notes.map(n => [n.kind, n.title]), [['warn', 'Your PC has not checked in'], ['warn', 'Your PC is not answering']]);
  assert.equal(stateOf(a, phoneA).notes[0].body, 'Booking opens at 22:00 for Tue 24 Nov · 16:00–18:00, but the booker on your PC has not been in touch. It may be off, or asleep without its wake timer. Book by hand on ClubSpark if you can.');
  await settle();
  assert.deepEqual(a.pushes.map(p => p.title), ['Your PC is not answering', 'Your PC has not checked in']);
  // A warning Telegram would not take is not noted until it has gone.
  const b = makeBot(`${TUE}T21:58:00Z`, { state: { plan: PLAN, lastSeen: at(`${TUE}T21:57:30Z`) } });
  const phoneB = await linkPhone(b);
  b.tg.failSend = 1;
  await b.app.tick();
  assert.deepEqual(stateOf(b, phoneB).notes, []);
  b.clock.t += 5000;
  await b.app.tick();
  assert.deepEqual(stateOf(b, phoneB).notes.map(n => [n.kind, n.title, n.body]), [['warn', 'The booking run has not started', 'Booking opens at 22:00 for Tue 24 Nov · 16:00–18:00. Your PC is awake, but it has not started tonight\'s run. Its "ClubSpark court booking" task may be switched off. Book by hand on ClubSpark if you can.']]);
  // The run starts: the heads-up. Then trouble. Then silence after the release.
  const c = makeBot(`${TUE}T21:55:05Z`, { state: { plan: PLAN } });
  const phoneC = await linkPhone(c);
  c.app.jobsForAgent(HOME, { run: true });
  await settle();
  assert.deepEqual(stateOf(c, phoneC).notes.map(n => [n.kind, n.title, n.body]), [['info', 'Booking at 22:00', 'Tue 24 Nov · 16:00–18:00. Your PC is awake and signing in.']]);
  c.app.jobsForAgent(HOME, { run: true });                                                 // asking again: no second heads-up, no second note
  await settle();
  assert.equal(stateOf(c, phoneC).notes.length, 1);
  c.clock.t = at(`${TUE}T21:56:00Z`);
  await c.app.progressFromAgent({ stage: 'trouble', why: 'Chrome did not start: <session not created>.', attempt: 2, of: 3 });
  assert.deepEqual(stateOf(c, phoneC).notes[0], { ...stateOf(c, phoneC).notes[0], kind: 'warn', title: 'Trouble before the booking', body: 'Chrome did not start: <session not created>. Your PC is trying again (attempt 2 of 3).' });
  c.clock.t += 5000;
  await c.app.progressFromAgent({ stage: 'trouble', why: 'again', attempt: 3, of: 3 });      // within 15 s: neither said nor noted
  assert.equal(stateOf(c, phoneC).notes.length, 2);
  c.clock.t = at(`${TUE}T22:08:05Z`);
  await c.app.tick();
  assert.deepEqual(stateOf(c, phoneC).notes.map(n => [n.kind, n.title]), [['warn', 'No word from your PC'], ['warn', 'Trouble before the booking'], ['info', 'Booking at 22:00']]);
  assert.equal(stateOf(c, phoneC).notes[0].body, 'It started on Tue 24 Nov · 16:00–18:00 but has not said how it went. Check ClubSpark, and book by hand if it is not there.');
});

test('the last thirty notes are kept, the newest first', async () => {
  const t = makeBot(`${TUE}T22:00:10Z`);
  const phone = await linkPhone(t);
  for (let i = 0; i < 33; i++) {
    t.clock.t += 1000;
    await t.app.resultFromAgent({ id: `2026-12-${pad(i % 28 + 1)}@${pad(9 + Math.floor(i / 28))}:00`, status: 'none' });
  }
  const notes = stateOf(t, phone).notes;
  assert.equal(notes.length, 30);
  assert.deepEqual([notes[0].at, notes[29].at], [at(`${TUE}T22:00:10Z`) + 33000, at(`${TUE}T22:00:10Z`) + 4000]);
  assert.equal(new Set(notes.map(n => n.id)).size, 30);
  assert.equal(t.store.load().notes.length, 30);
});

test('tonight\'s run in the state: started, signed in, trouble, and gone once it has reported', async () => {
  const t = makeBot(`${TUE}T21:29:59Z`, { state: { plan: { tue: { start: 960, hours: 2 } } } });
  const phone = await linkPhone(t);
  const run = () => stateOf(t, phone).run;
  assert.equal(run(), null);
  t.app.jobsForAgent(HOME, { run: true });                                                 // a run by hand, more than half an hour before: not tonight's
  assert.equal(run(), null);
  t.clock.t = at(`${TUE}T21:55:05Z`);
  t.app.jobsForAgent(HOME, { run: false });                                                // only looking (node book.js --jobs)
  assert.equal(run(), null);
  t.app.jobsForAgent(HOME, { run: true });
  assert.deepEqual(run(), { stage: 'started', at: at(`${TUE}T21:55:05Z`), why: null });
  t.clock.t = at(`${TUE}T21:56:00Z`);
  await t.app.progressFromAgent({ stage: 'trouble', why: 'ClubSpark did not load', attempt: 2, of: 3 });
  assert.deepEqual(run(), { stage: 'trouble', at: at(`${TUE}T21:56:00Z`), why: 'ClubSpark did not load. Your PC is trying again (attempt 2 of 3).' });
  t.clock.t = at(`${TUE}T21:57:00Z`);
  await t.app.progressFromAgent({ stage: 'ready' });
  assert.deepEqual(run(), { stage: 'ready', at: at(`${TUE}T21:57:00Z`), why: null });
  // The result comes in: the run has said what it had to say.
  t.clock.t = at(`${TUE}T22:00:11Z`);
  assert.deepEqual(run(), { stage: 'ready', at: at(`${TUE}T21:57:00Z`), why: null });
  await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  assert.equal(run(), null);
  // A run that never reports stays in view for an hour after the release, and no longer.
  const silent = makeBot(`${TUE}T21:55:05Z`, { state: { plan: { tue: { start: 960, hours: 2 } } } });
  const silentPhone = await linkPhone(silent);
  silent.app.jobsForAgent(HOME, { run: true });
  silent.clock.t = at(`${TUE}T22:59:59Z`);
  assert.equal(stateOf(silent, silentPhone).run.stage, 'started');
  silent.clock.t = at(`${TUE}T23:00:00Z`);
  assert.equal(stateOf(silent, silentPhone).run, null);
});

// ---------- the push service (lib/push.js) ----------

test('notifications go to Expo\'s push service as one request, and whatever goes wrong is only said in the log', async () => {
  const calls = [], logs = [];
  const answers = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); const next = answers.shift(); if (next instanceof Error) throw next; return next || new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }); };
  const push = createExpoPush({ fetchImpl, log: l => logs.push(l) });
  assert.equal(EXPO_URL, 'https://exp.host/--/api/v2/push/send');
  assert.equal(TIMEOUT_MS, 5000);
  assert.deepEqual(await push([PUSH_TOKEN, 'ExpoPushToken[b]'], { title: 'Court 3 booked', body: 'Thu 26 Nov · 19:00–21:00 · gate 2433' }), { unregistered: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, EXPO_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal);                                  // the five-second limit
  assert.deepEqual(JSON.parse(calls[0].init.body), [
    { to: PUSH_TOKEN, title: 'Court 3 booked', body: 'Thu 26 Nov · 19:00–21:00 · gate 2433', sound: 'default' },
    { to: 'ExpoPushToken[b]', title: 'Court 3 booked', body: 'Thu 26 Nov · 19:00–21:00 · gate 2433', sound: 'default' },
  ]);
  assert.deepEqual(logs, []);
  // Nobody to tell: nothing is sent.
  assert.deepEqual(await push([], { title: 'x', body: 'y' }), { unregistered: [] });
  assert.deepEqual(await push(null, { title: 'x', body: 'y' }), { unregistered: [] });
  assert.equal(calls.length, 1);
  // The service refuses, answers oddly, cannot be reached, or takes too long: never an error.
  answers.push(new Response('nope', { status: 500 }), new Response(JSON.stringify({ data: [{ status: 'error', message: '"x" is not a registered push notification recipient' }] }), { status: 200 }),
    new Response('not json', { status: 200 }), new Error('getaddrinfo ENOTFOUND exp.host'), Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  for (let i = 0; i < 5; i++) assert.deepEqual(await push([PUSH_TOKEN], { title: 't', body: 'b' }), { unregistered: [] });
  assert.deepEqual(logs, [
    'Expo\'s push service did not take a notification (HTTP 500).',
    'Expo\'s push service refused 1 of 1 notifications: "x" is not a registered push notification recipient',
    'A notification could not be sent: getaddrinfo ENOTFOUND exp.host',
    'A notification could not be sent: The operation was aborted due to timeout',
  ]);
});

test('a push token is never written in the log; a phone Expo no longer knows stays linked but gets no more notifications', async () => {
  const OTHER = 'ExpoPushToken[second-phone_123]';
  assert.equal(mask(`x ${PUSH_TOKEN} y ${OTHER} z ExponentPushToken[cut off`), 'x [a push token] y [a push token] z [a push token]');
  assert.equal(mask(null), '');
  // Expo, as it answers: one answer for each notification, in the order sent. It no longer knows the first phone.
  const sent = [], expoLogs = [];
  const expo = async (url, init) => {
    const to = JSON.parse(init.body).map(m => m.to);
    sent.push(to);
    return new Response(JSON.stringify({ data: to.map(token => (token === PUSH_TOKEN
      ? { status: 'error', message: `"${PUSH_TOKEN}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } }
      : token === 'ExpoPushToken[busy]' ? { status: 'error', message: `${token}: too many notifications`, details: { error: 'MessageRateExceeded' } } : { status: 'ok', id: 'x' })) }), { status: 200 });
  };
  const push = createExpoPush({ fetchImpl: expo, log: l => expoLogs.push(l) });
  assert.deepEqual(await push([OTHER, PUSH_TOKEN, 'ExpoPushToken[busy]'], { title: 't', body: 'b' }), { unregistered: [PUSH_TOKEN] });      // only "not registered" means the phone is gone
  assert.deepEqual(expoLogs, ['Expo\'s push service refused 2 of 3 notifications: "[a push token]" is not a registered push notification recipient']);
  const down = createExpoPush({ log: l => expoLogs.push(l), fetchImpl: async () => { throw new Error(`could not deliver to ${PUSH_TOKEN}`); } });
  assert.deepEqual(await down([PUSH_TOKEN], { title: 't', body: 'b' }), { unregistered: [] });
  assert.equal(expoLogs[1], 'A notification could not be sent: could not deliver to [a push token]');
  // In the bot: phone A's token is forgotten, phone B's is kept, and both phones stay linked.
  expoLogs.length = 0; sent.length = 0;
  const t = makeBot(`${TUE}T22:00:10Z`, { push });
  const a = await linkPhone(t, 'A'), b = await linkPhone(t, 'B');
  await ask(t, a, 'push', { token: PUSH_TOKEN });
  await ask(t, b, 'push', { token: OTHER });
  await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  await settle();
  assert.deepEqual(sent, [[PUSH_TOKEN, OTHER]]);
  assert.deepEqual(t.app.state.apps.map(d => [d.name, d.push]), [['A', null], ['B', OTHER]]);
  assert.deepEqual(t.store.load().apps.map(d => d.push), [null, OTHER]);
  assert.ok(t.app.appAuth(a.token) && t.app.appAuth(b.token));
  assert.ok(t.logs.includes('The push service no longer knows a linked phone, so no more notifications go there until the app asks for them again.'));
  await t.app.resultFromAgent({ id: '2026-11-24@19:00', status: 'none', end: 1260 });
  await settle();
  assert.deepEqual(sent[1], [OTHER]);                                                       // the next note goes to B alone
  // A phone that has been unlinked is sent nothing more, whatever token it once gave.
  await ask(t, b, 'unpair');
  await t.app.resultFromAgent({ id: '2026-11-25@19:00', status: 'none', end: 1260 });
  await settle();
  assert.equal(sent.length, 2);
  // And the app on A gives a token again: it is told again.
  await ask(t, a, 'push', { token: 'ExpoPushToken[a-new-one]' });
  await t.app.resultFromAgent({ id: '2026-11-26@19:00', status: 'none', end: 1260 });
  await settle();
  assert.deepEqual(sent[2], ['ExpoPushToken[a-new-one]']);
  // Through all of it, nothing shaped like a push token reached either log.
  const logged = [...t.logs, ...expoLogs].join('\n');
  assert.ok(!/PushToken\[/.test(logged), logged);
  assert.ok(logged.includes('From the app: push'));
  // A push that fails with the token in its words: masked in the bot's own log too.
  const u = makeBot(`${TUE}T22:00:10Z`, { push: async tokens => { throw new Error(`no route for ${tokens[0]}`); } });
  const phone = await linkPhone(u);
  await ask(u, phone, 'push', { token: PUSH_TOKEN });
  await u.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, end: 1080 });
  await settle();
  assert.ok(u.logs.includes('A notification could not be sent: no route for [a push token]'));
  assert.ok(!/PushToken\[/.test(u.logs.join('\n')));
});

// ---------- whose the phones are ----------

test('a phone linked while the bot answered to another chat does not outlive the owner taking the bot back', async () => {
  const STRANGER = 666;
  const gone = 'Unlinked a phone linked to the app while this bot answered to another chat.';
  // No TELEGRAM_CHAT_ID and no settings file: the first to send /start owns the bot (as before), and links a phone.
  const store = memStore(null);
  const first = makeBot(NOON, { store });
  await first.app.handleUpdate(say(STRANGER, '/start'));
  await first.app.handleUpdate(say(STRANGER, '/app'));
  const theirs = first.app.appPair({ code: /Code: <code>(\d{6})<\/code>/.exec(first.tg.last().text)[1], name: 'not yours' }).body.token;
  await settle();
  assert.ok(first.app.appAuth(theirs));
  assert.equal(store.load().apps[0].owner, STRANGER);                                      // each phone says whose it is
  // The real owner sets TELEGRAM_CHAT_ID, and the bot restarts on the same settings file.
  const back = makeBot(NOON, { store, env: { TELEGRAM_CHAT_ID: String(OWNER) } });
  assert.equal(back.app.appAuth(theirs), null);
  assert.deepEqual([back.app.state.apps, store.load().apps], [[], []]);
  assert.deepEqual(back.logs, [gone]);
  assert.equal(store.load().owner, STRANGER);                                              // the file's own owner is left as it was, as in 2.7
  await back.app.handleUpdate(say(OWNER, '/status'));
  assert.ok(!/Phones linked/.test(back.tg.last().text));                                   // nothing linked: /status reads as it always did
  // The owner links a phone of their own. /status says so, and it stays theirs over any number of
  // restarts, though the settings file still names the other chat as its owner.
  const mine = await linkPhone(back, 'Mine');
  await back.app.handleUpdate(say(OWNER, '/status'));
  assert.match(back.tg.last().text, /\nIndoor courts \(Glasgow Club\): [^\n]+\nPhones linked to the app: 1\nSettings kept across restarts: yes\n/);
  for (const restart of [1, 2]) {
    const again = makeBot(NOON, { store, env: { TELEGRAM_CHAT_ID: String(OWNER) } });
    assert.ok(again.app.appAuth(mine.token), `restart ${restart}`);
    assert.deepEqual(again.logs, []);
    assert.equal(stateOf(again, mine).devices.length, 1);
  }
  // TELEGRAM_CHAT_ID taken away again: the bot is the other chat's once more, and the owner's phone is not theirs.
  const theirsAgain = makeBot(NOON, { store });
  assert.equal(theirsAgain.app.appAuth(mine.token), null);
  assert.deepEqual([theirsAgain.app.state.apps, theirsAgain.logs], [[], [gone]]);
  assert.ok(![...first.logs, ...back.logs, ...theirsAgain.logs].join('\n').includes(theirs.slice(0, 12)));
});

test('phones in a settings file that do not say whose they are: kept for the file\'s own owner, dropped for any other', async () => {
  const gone = 'Unlinked a phone linked to the app while this bot answered to another chat.';
  const made = A.newToken();
  const phone = { id: 'a1b2c3d4', name: 'iPhone', hash: made.hash, at: 1, seenAt: 1, push: null };       // no owner on it
  // The file's owner and today's are the same chat: kept, and from now on it says whose it is.
  for (const env of [{}, { TELEGRAM_CHAT_ID: String(OWNER) }]) {
    const same = makeBot(NOON, { state: { apps: [phone] }, env });
    assert.ok(same.app.appAuth(made.token));
    assert.equal(same.store.load().apps[0].owner, OWNER);
    assert.deepEqual(same.logs, []);
  }
  // TELEGRAM_CHAT_ID names another chat than the settings file does: the phone goes.
  const other = makeBot(NOON, { state: { owner: 666, apps: [phone] }, env: { TELEGRAM_CHAT_ID: String(OWNER) } });
  assert.equal(other.app.appAuth(made.token), null);
  assert.deepEqual([other.store.load().apps, other.logs], [[], [gone]]);
  // TELEGRAM_CHAT_ID changed from one chat to another while the file happens to name the new one:
  // a phone linked for the old chat goes all the same, and the new owner's stays.
  const kept = A.newToken();
  const moved = makeBot(NOON, { state: { apps: [{ ...phone, owner: 666 }, { ...phone, id: 'b1b2c3d4', hash: kept.hash, owner: OWNER }] }, env: { TELEGRAM_CHAT_ID: String(OWNER) } });
  assert.deepEqual([moved.app.state.apps.map(d => d.id), moved.logs], [['b1b2c3d4'], [gone]]);
  assert.deepEqual([moved.app.appAuth(made.token), !!moved.app.appAuth(kept.token)], [null, true]);
  // Nobody owns the bot yet: nobody's phone is linked to it.
  const nobody = makeBot(NOON, { store: memStore({ v: 4, apps: [phone, { ...phone, id: 'c1b2c3d4', hash: kept.hash, owner: OWNER }] }) });
  assert.deepEqual([nobody.app.state.apps, nobody.app.appAuth(made.token), nobody.app.appAuth(kept.token)], [[], null, null]);
  assert.deepEqual(nobody.logs, ['Unlinked 2 phones linked to the app while this bot answered to another chat.']);
});

// ---------- what a phone cannot overdo ----------

test('the app may have the sheet read afresh twelve times in a minute; what is already known costs nothing', async () => {
  const t = makeBot(NOON, { glasgow: letIn(FRIDAY) });                                      // here the bot reads Glasgow Club itself, and keeps each day for a minute
  const phone = await linkPhone(t);
  const days = Array.from({ length: 9 }, (_, i) => `2026-11-${17 + i}`);
  const all = [...days.map(date => ({ centre: 'g', date })), ...days.map(date => ({ centre: 's', date }))];
  for (const look of all.slice(0, 12)) assert.equal((await ask(t, phone, 'indoor/look', look)).status, 200, JSON.stringify(look));
  const tooMany = refused(409, 'That is 12 looks at Glasgow Club\'s sheet within a minute, which is as many as I ask for. Wait a minute, then look again.');
  assert.deepEqual(await ask(t, phone, 'indoor/look', all[12]), tooMany);
  // A day read a moment ago is answered from what is known: as often as asked, and never counted.
  for (let i = 0; i < 20; i++) assert.equal((await ask(t, phone, 'indoor/look', all[0])).status, 200);
  // Refresh on it, ten seconds on, is a new read, and that is refused like any other.
  t.clock.t += 11000;
  assert.deepEqual(await ask(t, phone, 'indoor/look', { ...all[0], fresh: true }), tooMany);
  assert.equal((await ask(t, phone, 'indoor/look', all[0])).status, 200);
  // The twelve are the app's, not each phone's.
  const second = await linkPhone(t, 'iPad');
  assert.deepEqual(await ask(t, second, 'indoor/look', all[17]), tooMany);
  // Telegram's own looks are not counted, and not held back.
  await tap(t.app, 'gd:s:20261125', 7);
  assert.match(t.tg.last().text, /^<b>Scotstoun · Wed 25 Nov<\/b>\nNo court is free that day/);
  // A minute after the twelve there is room again.
  t.clock.t = at(NOON) + 59999;
  assert.deepEqual(await ask(t, phone, 'indoor/look', all[13]), tooMany);
  t.clock.t += 1;
  assert.equal((await ask(t, phone, 'indoor/look', all[13])).status, 200);
});

test('sixty one-off dates at most, for Telegram and the app alike', async () => {
  const day = n => new Date(Date.UTC(2026, 10, 18 + n)).toISOString().slice(0, 10);
  const sixty = [];
  for (let n = 0; n < 15; n++) for (const start of [540, 600, 660, 720]) sixty.push({ date: day(n), start, hours: 1 });
  const t = makeBot(NOON, { state: { once: sixty } });
  const phone = await linkPhone(t);
  assert.equal(stateOf(t, phone).once.length, 60);
  const full = 'Your list already has 60 one-off dates, which is as many as I keep. Remove one first.';
  assert.deepEqual(await ask(t, phone, 'once', { date: '2026-12-10', start: 1140, hours: 1 }), refused(409, full));
  await t.app.handleUpdate(say(OWNER, '/book 10 dec 19:00'));
  assert.equal(t.tg.last().text, full);
  await tap(t.app, 'ok:20261210:1900:1', 7);                                               // the Add button, on a card from before the list filled up
  assert.equal(lastAnswer(t), full);
  assert.match(t.tg.last().text, /<b>One-off dates<\/b>\n1\. Wed 18 Nov/);                 // the list itself, to remove one from
  assert.equal(t.app.state.once.length, 60);
  // One that is on the list is still "already there", and a date that has passed is still said as that.
  const there = await ask(t, phone, 'once', { date: sixty[0].date, start: sixty[0].start, hours: 2 });
  assert.deepEqual([there.status, there.body.already], [200, true]);
  assert.deepEqual(await ask(t, phone, 'once', { date: '2026-11-10', start: 1140, hours: 1 }), refused(400, 'Tue 10 Nov at 19:00 has already passed.'));
  // Remove one: room for one more, from either side, and then no more.
  assert.equal((await ask(t, phone, 'once/remove', { date: sixty[0].date, start: sixty[0].start })).status, 200);
  await t.app.handleUpdate(say(OWNER, '/book 10 dec 19:00'));
  assert.match(t.tg.last().text, /^<b>Thu 10 Dec · 19:00–20:00<\/b>/);
  assert.deepEqual(await ask(t, phone, 'once', { date: '2026-12-11', start: 1140, hours: 1 }), refused(409, full));
  assert.equal(t.store.load().once.length, 60);
});

test('one phone may have four waits open at once; a fifth is told how things stand at once', async () => {
  const t = makeBot();
  const phone = await linkPhone(t), other = await linkPhone(t, 'iPad');
  await withServer(t, async ({ base, get }) => {
    const etag = (await get('/app/state', { token: phone.token })).json.etag;
    const away = new AbortController();
    const hang = () => fetch(`${base}/app/state?have=${etag}&wait=25`, { headers: { authorization: `Bearer ${phone.token}` }, signal: away.signal }).then(r => r.json(), e => e.name);
    const four = [hang(), hang(), hang(), hang()];
    await sleep(80);
    // The fifth does not wait: it gets the state, the same as it has.
    const began = Date.now();
    const fifth = await get(`/app/state?have=${etag}&wait=25`, { token: phone.token });
    assert.ok(Date.now() - began < 1500, `the fifth took ${Date.now() - began} ms`);
    assert.deepEqual([fifth.status, Object.keys(fifth.json), fifth.json.etag], [200, ['ok', 'etag', 'state'], etag]);
    // Another phone has four of its own.
    const theirs = (await get('/app/state', { token: other.token })).json.etag;
    assert.deepEqual((await get(`/app/state?have=${theirs}&wait=0.1`, { token: other.token })).json, { ok: true, etag: theirs, same: true });
    // When the four are over (here the phone goes away), it may wait again.
    away.abort();
    assert.deepEqual(await Promise.all(four), ['AbortError', 'AbortError', 'AbortError', 'AbortError']);
    await sleep(80);
    for (let i = 0; i < 6; i++) assert.deepEqual((await get(`/app/state?have=${etag}&wait=0.05`, { token: phone.token })).json, { ok: true, etag, same: true });      // waits that end make room as well
  });
});

test('a hold from the app is only taken for a court that a look showed the app free in the last fifteen minutes', async () => {
  const old = refused(409, 'That list is old. Read the day again, then hold a court.');
  const t = makeBot();
  const phone = await linkPhone(t);
  await t.app.pingFromAgent(HOME);
  // The app has looked at nothing yet.
  assert.deepEqual(await ask(t, phone, 'hold', HOLD), old);
  assert.deepEqual(await ask(t, phone, 'hold', { centre: 's', date: '2026-11-25', start: 5, court: 20 }), old);
  // A day read in Telegram is not a day the app was shown.
  await tap(t.app, 'gd:g:20261120', 7);
  assert.deepEqual(await ask(t, phone, 'hold', HOLD), old);
  // The app reads Gorbals on Friday: courts 3 and 4 free at 18:00, court 3 at 19:00. Those and no others.
  const look = await seeFree(t, phone);
  assert.deepEqual(look.slots.map(s => [s.start, s.courts.map(c => c.n)]), [[1080, [3, 4]], [1140, [3]]]);
  for (const body of [{ ...HOLD, court: 5 }, { ...HOLD, start: 1140, court: 4 }, { ...HOLD, start: 1200 }, { ...HOLD, centre: 's' }, { ...HOLD, date: '2026-11-21' }]) assert.deepEqual(await ask(t, phone, 'hold', body), old, JSON.stringify(body));
  assert.equal(stateOf(t, phone).hold, null);
  assert.deepEqual(await t.app.pingFromAgent(HOME), { ok: true });                         // none of it reached the PC
  // A time that is not on offer at all is still said as that.
  assert.deepEqual(await ask(t, phone, 'hold', { ...HOLD, court: 21 }), refused(400, 'That time is no longer on offer. Pick again.'));
  // Fifteen minutes less a millisecond after the look, the list is still good...
  t.clock.t += 15 * 60000 - 1;
  await t.app.pingFromAgent(HOME);
  const started = await ask(t, phone, 'hold', HOLD);
  assert.equal(started.status, 200);
  assert.equal((await ask(t, phone, 'hold/order', { id: started.body.state.hold.id, what: 'release' })).status, 200);
  // ...and a millisecond later it is old.
  t.clock.t += 1;
  assert.deepEqual(await ask(t, phone, 'hold', { ...HOLD, court: 4 }), old);
  // Reading the day again makes it good again, whichever linked phone does the reading.
  const second = await linkPhone(t, 'iPad');
  await seeFree(t, second);
  assert.equal((await ask(t, phone, 'hold', { ...HOLD, court: 4 })).status, 200);
  // What was shown is kept in memory only: after a restart of the bot the app must look again.
  const again = makeBot(NOON, { store: t.store });
  const device = again.app.appAuth(phone.token);
  await again.app.pingFromAgent(HOME);
  assert.deepEqual(await again.app.appAsk(device, 'hold', HOLD), old);
  assert.ok(!JSON.stringify(t.store.load()).includes('1080:3'));
  // A court on a day that is not open for booking yet was shown, but not as one to book: not one to hold.
  const early = makeBot(NOON, { glasgow: letIn({ 'Tennis Hall Court 2': [slot('2026-11-25', 18, { before: true, from: '2026-11-18T00:00:00Z' })] }) });
  const earlyPhone = await linkPhone(early);
  assert.deepEqual((await seeFree(early, earlyPhone, 's', '2026-11-25')).slots, []);
  await early.app.pingFromAgent(HOME);
  assert.deepEqual(await ask(early, earlyPhone, 'hold', { centre: 's', date: '2026-11-25', start: 1080, court: 2 }), old);
  // Telegram's own Hold button is as it was: it asks for no look by the app.
  const u = makeBot();
  await u.app.pingFromAgent(HOME);
  await tap(u.app, 'gh:g:20261120:1800:3', 7);
  assert.equal(lastAnswer(u), 'Asking your PC');
});

test('before the PC has collected a hold, "I have paid" is refused and changes nothing, and Stop stops it', async () => {
  const early = refused(409, 'It is not in your basket yet.');
  // From the app.
  const t = makeBot();
  const phone = await linkPhone(t);
  await t.app.pingFromAgent(HOME);
  await seeFree(t, phone);
  const h = (await ask(t, phone, 'hold', HOLD)).body.state.hold;
  assert.deepEqual([h.stage, h.can], ['asked', { release: true, done: false, pay: false }]);
  assert.deepEqual(await ask(t, phone, 'hold/order', { id: h.id, what: 'done' }), early);
  let now = stateOf(t, phone);
  assert.deepEqual([now.hold.ended, now.hold.live, now.hold.can, now.notes], [null, true, { release: true, done: false, pay: false }, []]);
  assert.equal((await t.app.pingFromAgent(HOME)).hold.id, h.id);                           // the PC still collects it
  assert.deepEqual(await ask(t, phone, 'hold/order', { id: h.id, what: 'done' }), early);  // collected, not yet in the basket: the same
  assert.equal(stateOf(t, phone).hold.ended, null);
  // Stop, before the PC has it: over at once, and nothing is handed to the PC.
  const u = makeBot();
  const phoneU = await linkPhone(u);
  await u.app.pingFromAgent(HOME);
  await seeFree(u, phoneU);
  const hu = (await ask(u, phoneU, 'hold', HOLD)).body.state.hold;
  const stopped = await ask(u, phoneU, 'hold/order', { id: hu.id, what: 'release' });
  assert.deepEqual([stopped.status, stopped.body.state.hold.ended, stopped.body.state.hold.lines], [200, 'stopped', ['Stopped before your PC had started. Nothing was done.']]);
  assert.deepEqual(await u.app.pingFromAgent(HOME), { ok: true });
  // The same two in Telegram. Its card only shows Stop this early; an old or made-up "I have paid" button gets the same answer.
  for (const [button, toast, goesOn] of [['gp', 'It is not in your basket yet.', true], ['gx', 'Stopped', false]]) {
    const v = makeBot();
    await v.app.pingFromAgent(HOME);
    await tap(v.app, 'gh:g:20261120:1800:3', 7);
    await settle();
    const id = buttons(v.tg.last()).find(b => b.text === 'Stop').callback_data.slice(3);
    await tap(v.app, `${button}:${id}`, 7);
    await settle();
    assert.equal(lastAnswer(v), toast);
    const order = await v.app.pingFromAgent(HOME);
    await settle();
    if (goesOn) { assert.equal(order.hold.id, id); assert.equal(v.tg.last().text.split('\n')[1], 'Your PC has it and is starting Chrome…'); } else {
      assert.deepEqual(order, { ok: true });
      assert.equal(v.tg.last().text.split('\n')[1], 'Stopped before your PC had started. Nothing was done.');
    }
  }
});

// ---------- the server's own part ----------

test('the server itself turns away whatever has no linked phone\'s token, whatever stands behind the door', async () => {
  // A door with nothing behind it that would say no: only the server's own check is left to do so.
  const reached = [];
  const openDoor = {
    hello: () => ({ ok: true, bot: 'x', api: 1 }),
    pair: () => ({ status: 400, body: { ok: false, why: 'none', left: 0 } }),
    auth: token => (token === 'the-one-good-token' ? { id: 'aaaaaaaa' } : null),
    state: device => { reached.push(['state', device]); return { etag: 'e1', state: { gate: '2433' } }; },
    ask: async (device, name) => { reached.push(['ask', name]); return { status: 200, body: { ok: true, gate: '2433' } }; },
  };
  const server = createServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), token: AGENT, appApi: openDoor });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, headers = {}) => fetch(base + path, { method, headers, body: method === 'POST' || method === 'PUT' ? '{}' : undefined }).then(async r => [r.status, await r.text(), r.headers.get('cache-control')]);
  try {
    for (const [method, path, headers] of [
      ['GET', '/app/state', {}], ['GET', '/app/state?have=e1&wait=5', {}], ['GET', '/app/state', { authorization: 'Bearer nonsense' }],
      ['GET', '/app/state', { authorization: 'the-one-good-token' }], ['GET', '/app/state', { authorization: 'bearer the-one-good-token' }], ['GET', '/app/state', { authorization: 'Token the-one-good-token' }],
      ['GET', '/app/state?token=the-one-good-token', {}], ['GET', '/app/state', { authorization: `Bearer ${AGENT}` }], ['GET', '/app/state', { authorization: `Basic ${Buffer.from('x:the-one-good-token').toString('base64')}` }],
      ['POST', '/app/pause', {}], ['POST', '/app/pause?token=the-one-good-token', {}], ['POST', '/app/unpair', { authorization: 'Bearer the-one-good-tokenx' }], ['POST', '/app/hello', {}],
      ['HEAD', '/app/state', {}], ['HEAD', '/app/hello', {}], ['PUT', '/app/pause', {}], ['DELETE', '/app/state', {}], ['GET', '/app', {}], ['GET', '/app/', {}], ['GET', '/app/hello/', {}],
    ]) {
      const [status, text, cache] = await call(method, path, headers);
      assert.equal(status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
      if (method !== 'HEAD') assert.equal(text, '{"ok":false,"why":"unpaired"}');
      assert.equal(cache, 'no-store');
    }
    assert.deepEqual(reached, []);
    // Hello and pair are open; with the token, so is the rest. Every answer says it is not to be kept.
    assert.deepEqual(await call('GET', '/app/hello?x=1'), [200, '{"ok":true,"bot":"x","api":1}', 'no-store']);
    assert.deepEqual(await call('POST', '/app/pair'), [400, '{"ok":false,"why":"none","left":0}', 'no-store']);
    assert.deepEqual(await call('GET', '/app/state', { authorization: 'Bearer the-one-good-token' }), [200, '{"ok":true,"etag":"e1","state":{"gate":"2433"}}', 'no-store']);
    assert.deepEqual(await call('POST', '/app/anything', { authorization: 'Bearer the-one-good-token' }), [200, '{"ok":true,"gate":"2433"}', 'no-store']);
    assert.deepEqual(reached, [['state', { id: 'aaaaaaaa' }], ['ask', 'anything']]);
    // What only looks like the app's door is the PC's, and gets the PC's answer.
    for (const path of ['/APP/state', '/App/hello', '//app/state', '/apps/state', '/application']) {
      const [status, text] = await call('GET', path, { authorization: 'Bearer the-one-good-token' });
      assert.deepEqual([status, JSON.parse(text).why], [401, 'who are you? the PC must sign with its key (AGENT_PUBLIC_KEY) or send AGENT_TOKEN'], path);
    }
    assert.equal(reached.length, 2);
  } finally { await new Promise(r => server.close(r)); }
});

test('odd paths and methods under /app/ find nothing, and change nothing', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await withServer(t, async ({ call, port }) => {
    const nothing = { status: 404, json: { ok: false, why: 'no such thing here' } };
    for (const [method, path] of [['GET', '/app'], ['GET', '/app/'], ['GET', '/app/state/'], ['GET', '/app/STATE'], ['GET', '/app/%73tate'], ['POST', '/app/state'], ['GET', '/app/pause'], ['POST', '/app/pause/'], ['POST', '/app/Pause'],
      ['POST', '/app/once/remove/'], ['POST', '/app/__proto__'], ['POST', '/app/constructor'], ['POST', '/app/toString'], ['POST', '/app/hasOwnProperty'], ['PUT', '/app/pause'], ['DELETE', '/app/unpair'], ['POST', '/app/hello'], ['POST', '/app/pair/']]) {
      assert.deepEqual(await call(method, path, { token: phone.token, ...(method === 'GET' || method === 'DELETE' ? {} : { body: { paused: true, all: true } }) }), nothing, `${method} ${path}`);
    }
    assert.deepEqual(await call('HEAD', '/app/state', { token: phone.token }), { status: 404, json: null });
    assert.deepEqual(await call('HEAD', '/app/hello'), { status: 401, json: null });              // hello is open to GET, and to nothing else
    // A request for something that is not there, with a body that is not JSON, is told about the body first.
    assert.deepEqual(await call('POST', '/app/nothing', { token: phone.token, body: 'not json' }), { status: 400, json: { ok: false, why: 'The request body must be JSON.' } });
    // Targets that fetch would tidy up, written as they are.
    const first = out => out.split('\r\n')[0];
    for (const target of ['/app/../agent/ping', '/app/../health', '/app/./state', '/app/state#x', '/app/state%00']) {
      assert.equal(first((await raw(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).out), 'HTTP/1.1 401 Unauthorized', target);
      assert.equal(first((await raw(port, `POST ${target} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${phone.token}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)).out), 'HTTP/1.1 404 Not Found', target);
    }
    // After all of it: nothing paused, nobody unlinked, nothing asked of the PC.
    assert.deepEqual([t.app.state.paused, t.app.state.apps.length, ({}).paused], [false, 1, undefined]);
    assert.deepEqual(await t.app.pingFromAgent(HOME), { ok: true });
    // Unlinking is for the phone that asks, whatever else it sends.
    const other = await linkPhone(t, 'iPad');
    assert.deepEqual(await call('POST', '/app/unpair', { token: other.token, body: { all: true, id: phone.id } }), { status: 200, json: { ok: true } });
    assert.deepEqual(t.app.state.apps.map(d => d.id), [phone.id]);
  });
});

test('a waiting GET /app/state looks once a second and gives up after 25 seconds, whatever wait is asked for', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  // The server's own interval and limit (nothing is passed in), with a timer that notes how long it was asked to wait and then does not.
  const waits = [];
  const quick = { appPollMs: undefined, appTimers: { setTimeout: (fn, ms) => { waits.push(ms); return setTimeout(fn, 0); }, clearTimeout } };
  await withServer(t, async ({ get }) => {
    const etag = (await get('/app/state', { token: phone.token })).json.etag;
    assert.deepEqual((await get(`/app/state?have=${etag}&wait=9999`, { token: phone.token })).json, { ok: true, etag, same: true });
    assert.deepEqual(waits, Array(25).fill(1000));                   // 25 looks a second apart, and then the answer
    waits.length = 0;
    await get(`/app/state?have=${etag}&wait=2.5`, { token: phone.token });
    assert.deepEqual(waits, [1000, 1000, 500]);
    waits.length = 0;
    await get(`/app/state?have=${etag}`, { token: phone.token });
    await get(`/app/state?have=not-this&wait=25`, { token: phone.token });
    assert.deepEqual(waits, []);                                     // no wait asked for, or nothing to wait for: no timer at all
  }, quick);
});

test('the server cuts off a request that never finishes arriving, and leaves a slow answer alone', async () => {
  // Its own limits, as it runs on Railway.
  const usual = createServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), token: AGENT });
  assert.deepEqual([usual.requestTimeout, usual.headersTimeout], [30000, 15000]);
  // The same with the times made short, so the test need not wait half a minute.
  const t = makeBot();
  const short = { requestTimeoutMs: 400, headersTimeoutMs: 250, checkEveryMs: 50, onPing: async () => { await sleep(900); return { sleep: true }; } };
  await withServer(t, async ({ port, post, get }) => {
    // A body that never ends (8 bytes of the 100 promised): the connection is closed, and nothing was answered as if it had arrived.
    const half = await raw(port, 'POST /app/pair HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"code":', 5000);
    assert.equal(half.closed, true, 'the connection was left open');
    assert.ok(half.ms >= 300 && half.ms < 3000, `cut off after ${half.ms} ms`);
    assert.ok(half.out === '' || half.out.startsWith('HTTP/1.1 408 '), half.out);
    // Headers that never end: the same, sooner.
    const headless = await raw(port, 'GET /app/state HTTP/1.1\r\nHost: x\r\n', 5000);
    assert.equal(headless.closed, true);
    assert.ok(headless.ms < 3000 && (headless.out === '' || headless.out.startsWith('HTTP/1.1 408 ')), `${headless.ms} ms ${headless.out}`);
    // The same on the PC's door.
    assert.equal((await raw(port, `POST /agent/ping HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${AGENT}\r\nContent-Length: 50\r\n\r\n{"wait":`, 5000)).closed, true);
    // An ANSWER may take longer than that: the PC's waiting ping (here 0.9 s, on Railway up to 50 s) comes back whole.
    const began = Date.now();
    assert.deepEqual(await post('/agent/ping', { wait: 1 }, { token: AGENT }), { status: 200, json: { ok: true, sleep: true } });
    assert.ok(Date.now() - began >= 850);
    // And so may a phone's wait for a change.
    const phone = await linkPhone(t);
    const etag = (await get('/app/state', { token: phone.token })).json.etag;
    assert.deepEqual((await get(`/app/state?have=${etag}&wait=0.8`, { token: phone.token })).json, { ok: true, etag, same: true });
  }, short);
});

test('a body over 4 KB is refused, and one far over it is dropped without an answer', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await withServer(t, async ({ port, post }) => {
    const padded = bytes => JSON.stringify({ paused: false, p: 'x'.repeat(bytes - 23) });
    assert.equal(Buffer.byteLength(padded(4096)), 4096);
    assert.equal((await post('/app/pause', padded(4096), { token: phone.token })).status, 200);       // the limit itself is fine
    assert.deepEqual(await post('/app/pause', padded(4097), { token: phone.token }), { status: 413, json: { ok: false, why: 'That request is too large.' } });
    assert.deepEqual(await post('/app/pair', padded(5000)), { status: 413, json: { ok: false, why: 'That request is too large.' } });      // before anything is looked at, the code included
    // 300 KB: the server stops listening part of the way through and says nothing.
    const big = 'x'.repeat(300 * 1024);
    const dropped = await raw(port, `POST /app/pause HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${phone.token}\r\nContent-Length: ${big.length}\r\nConnection: close\r\n\r\n${big}`, 5000);
    assert.deepEqual([dropped.closed, dropped.out], [true, '']);
  });
});

// ---------- what is kept, again ----------

test('what 2.8 saves is what 2.7 saved, with the phones and the notes beside it: 2.7 would read its own part as before', async () => {
  const KNOWN_TO_27 = ['v', 'owner', 'plan', 'once', 'order', 'paused', 'results', 'sent', 'pics', 'lastSeen', 'lastRun', 'home'];
  // One evening, with the app used for all it can do.
  const t = makeBot(`${TUE}T21:50:00Z`, { env: WAKE, state: { plan: { tue: { start: 960, hours: 2 } } } });
  const phone = await linkPhone(t);
  await ask(t, phone, 'push', { token: PUSH_TOKEN });
  await ask(t, phone, 'once', { date: '2026-11-25', start: 1140, hours: 2 });
  await ask(t, phone, 'plan', { day: 'thu', start: 1140, hours: 1 });
  await ask(t, phone, 'order', { order: [6, 5] });
  await ask(t, phone, 'pause', { paused: true });
  await ask(t, phone, 'pause', { paused: false });
  await t.app.pingFromAgent(HOME);
  t.clock.t = at(`${TUE}T21:55:05Z`);
  t.app.jobsForAgent(HOME, { run: true });
  await settle();
  await t.app.progressFromAgent({ stage: 'ready' });
  t.clock.t = at(`${TUE}T22:00:09Z`);
  await t.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  await t.app.handleUpdate(say(OWNER, '/menu'));
  const saved = t.store.load();
  // The keys 2.7 knows, in its order, then the two it has never heard of. Still version 4.
  assert.deepEqual(Object.keys(saved), [...KNOWN_TO_27, 'apps', 'notes']);
  assert.equal(saved.v, 4);
  assert.ok(saved.apps.length === 1 && saved.notes.length === 2);
  // Each of 2.7's fields is in the shape 2.7 wrote and reads.
  assert.deepEqual(saved.plan, { tue: { start: 960, hours: 2 }, thu: { start: 1140, hours: 1 } });
  assert.deepEqual(saved.once, [{ date: '2026-11-25', start: 1140, hours: 2 }]);
  assert.deepEqual([saved.owner, saved.order, saved.paused], [OWNER, [6, 5, 1, 2, 3, 4], false]);
  assert.deepEqual(saved.results, { '2026-11-24@16:00': { id: '2026-11-24@16:00', status: 'booked', date: '2026-11-24', start: 960, end: 1080, court: '3', gate: '2433', at: at(`${TUE}T22:00:09Z`) } });
  assert.deepEqual(saved.sent, { [`ready:${at(`${TUE}T22:00:00Z`)}`]: at(`${TUE}T21:55:05Z`) });
  assert.deepEqual([saved.lastSeen, saved.lastRun, saved.home], [at(`${TUE}T21:55:05Z`), at(`${TUE}T21:55:05Z`), { ip: HOME.ip, at: at(`${TUE}T21:55:05Z`) }]);
  assert.deepEqual(Object.keys(saved.pics).sort(), ['booked', 'home-asleep', 'home-awake']);
  // Read with or without the two new keys, 2.7's own fields come out the same: nothing of theirs depends on the new ones.
  const whole = loadState(saved);
  const stripped = loadState(Object.fromEntries(KNOWN_TO_27.map(k => [k, saved[k]])));
  for (const k of KNOWN_TO_27) assert.deepEqual(whole[k], stripped[k], k);
  for (const k of KNOWN_TO_27) assert.deepEqual(whole[k], saved[k], k);                      // and cleaning them changes nothing
  assert.deepEqual([stripped.apps, stripped.notes], [[], []]);
  // The same evening without the app at all leaves the same in those fields.
  const u = makeBot(`${TUE}T21:50:00Z`, { env: WAKE, state: { plan: { tue: { start: 960, hours: 2 } } } });
  await u.app.handleUpdate(say(OWNER, '/book 25 nov 19:00 2h'));
  await u.app.handleUpdate(say(OWNER, '/set thu 19:00'));
  await u.app.handleUpdate(say(OWNER, '/order 6 5'));
  await u.app.handleUpdate(say(OWNER, '/pause'));
  await u.app.handleUpdate(say(OWNER, '/resume'));
  await u.app.pingFromAgent(HOME);
  u.clock.t = at(`${TUE}T21:55:05Z`);
  u.app.jobsForAgent(HOME, { run: true });
  await settle();
  await u.app.progressFromAgent({ stage: 'ready' });
  u.clock.t = at(`${TUE}T22:00:09Z`);
  await u.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  await u.app.handleUpdate(say(OWNER, '/menu'));
  const plain27 = u.store.load();
  for (const k of KNOWN_TO_27) assert.deepEqual(saved[k], plain27[k], k);
});

test('names, titles and bodies are cut by character, never through the middle of an emoji', async () => {
  const BALL = String.fromCodePoint(0x1F3BE);                                               // one character, two UTF-16 units
  const halved = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(A.cut(`ab${BALL}cd`, 3), `ab${BALL}`);
  assert.equal(A.cut(`ab${BALL}cd`, 2), 'ab');
  assert.equal(A.cut(`${BALL}${BALL}${BALL}`, 2), `${BALL}${BALL}`);
  assert.equal(A.cut(`a${BALL.slice(0, 1)}b${BALL.slice(1)}c`, 9), `a${String.fromCharCode(0xFFFD)}b${String.fromCharCode(0xFFFD)}c`);       // half an emoji that arrives on its own is made whole text
  // A phone's name with the emoji just where the cut falls: forty characters, the emoji whole.
  const t = makeBot();
  const r = t.app.appPair({ code: await codeFrom(t), name: `${'x'.repeat(39)}${BALL} phone` });
  await settle();
  const kept = t.app.state.apps[0].name;
  assert.equal(kept, `${'x'.repeat(39)}${BALL}`);
  assert.deepEqual([Array.from(kept).length, halved.test(kept), r.body.device.name], [40, false, kept]);
  assert.ok(!halved.test(t.tg.last().text));                                               // what Telegram is sent about it is whole too
  assert.equal(A.cleanName(`${BALL.repeat(60)}`), BALL.repeat(40));
  assert.equal(A.cleanName(`${'x'.repeat(39)} ${BALL}`), `${'x'.repeat(39)}`);              // and a cut never leaves a space on the end
  // Notes: a title of 120 characters and a body of 600, however many units those are.
  const n = A.makeNote('warn', `${'t'.repeat(119)}${BALL}${BALL}`, `${'b'.repeat(599)}${BALL}${BALL}`, 1);
  assert.deepEqual([n.title, n.body], [`${'t'.repeat(119)}${BALL}`, `${'b'.repeat(599)}${BALL}`]);
  // A reason from the PC that Telegram's own cut (300 units) leaves ending in half an emoji is whole in the note.
  const phone = { device: t.app.appAuth(r.body.token) };
  t.clock.t = at(`${TUE}T22:05:00Z`);
  await t.app.resultFromAgent({ id: '2026-11-24@19:00', status: 'failed', why: `${'y'.repeat(299)}${BALL}`, end: 1260 });
  const note = stateOf(t, phone).notes[0];
  assert.ok(!halved.test(note.body) && note.body.includes('y'.repeat(299)));
  const told = [];
  JSON.stringify(stateOf(t, phone), (key, value) => { if (typeof value === 'string') told.push(value); return value; });
  assert.ok(told.length > 20 && told.some(s => s.includes('y'.repeat(299))) && !told.some(s => halved.test(s)));      // nor is anything else the app is told
  // And whatever a settings file holds is made whole and cut the same way on loading.
  const loaded = loadState({ v: 4, apps: [{ id: 'a1b2c3d4', hash: 'a'.repeat(64), name: `${'x'.repeat(39)}${BALL}${BALL}` }, { id: 'b1b2c3d4', hash: 'b'.repeat(64), name: `half ${BALL.slice(0, 1)}` }],
    notes: [{ id: 'aa11bb22cc', at: 1, kind: 'info', title: `${'t'.repeat(119)}${BALL}${BALL}`, body: `${'b'.repeat(600)}${BALL}` }] });
  assert.deepEqual(loaded.apps.map(d => d.name), [`${'x'.repeat(39)}${BALL}`, `half ${String.fromCharCode(0xFFFD)}`]);
  assert.deepEqual([loaded.notes[0].title, loaded.notes[0].body], [`${'t'.repeat(119)}${BALL}`, 'b'.repeat(600)]);
});

test('the code and the tokens: made by the system\'s own random source, and compared in constant time', async () => {
  const realInt = crypto.randomInt, realEqual = crypto.timingSafeEqual;
  let compared = 0;
  try {
    crypto.randomInt = (lo, hi) => { assert.deepEqual([lo, hi], [0, 1000000]); return 482913; };
    assert.equal(A.createPairing().issue(0).code, '482913');                              // crypto.randomInt, and nothing weaker
    crypto.randomInt = realInt;
    crypto.timingSafeEqual = (a, b) => { compared++; return realEqual(a, b); };
    const p = A.createPairing({ random: () => 7 });
    p.issue(0);
    p.check('000008', 1); p.check('000007', 1);
    assert.equal(compared, 2);                                                            // each try at the code
    const a = A.newToken(), b = A.newToken();
    compared = 0;
    assert.equal(A.findDevice([{ id: 'a', hash: a.hash }, { id: 'b', hash: b.hash }], b.token).id, 'b');
    assert.equal(compared, 2);                                                            // every phone, not only up to the one that matches
    compared = 0;
    assert.equal(A.findDevice([{ id: 'a', hash: a.hash }, { id: 'b', hash: b.hash }], a.token).id, 'a');
    assert.equal(compared, 2);
  } finally { crypto.randomInt = realInt; crypto.timingSafeEqual = realEqual; }
});
