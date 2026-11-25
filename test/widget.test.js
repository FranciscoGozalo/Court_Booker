'use strict';
// The iPhone's widgets reading the state with the app closed (2.14): a widget token of their own, which
// opens GET /app/widget/state and nothing else; and the Live Activity tokens the app gives the bot
// (POST /app/activity/token), checked and kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp, loadState } = require('../app');
const { createQuietTelegram } = require('../lib/telegram');
const { serverFor } = require('../index');
const A = require('../lib/appapi');
const { at, memStore, PICTURES } = require('./helpers');

const OWNER = 42;
const NOON = '2026-11-17T12:00:00Z';         // a Tuesday; UK on GMT
const AGENT = 'a-long-random-line-for-testing-only';
const START = 'AB'.repeat(40);               // a push-to-start token, as iOS gives it (hex)
const UPDATE = 'ef'.repeat(40);
const ACTIVITY_ID = 'F3A1C2D4-1111-2222-3333-444455556666';
const COURT = '2026-11-24@16:00';
const UNPAIRED = { status: 401, json: { ok: false, why: 'unpaired' } };

function makeBot({ store = memStore({ v: 4, owner: OWNER }), apns = null } = {}) {
  const clock = { t: at(NOON) };
  const logs = [];
  const glasgow = { asked: [], day: async () => ({ at: clock.t, slots: [], listed: 0 }), peek: () => null, health: () => null };
  const app = createApp({ now: () => clock.t, tg: createQuietTelegram(), store, pictures: PICTURES, linked: true, glasgow, log: l => logs.push(l),
    push: async () => {}, wake: async () => 3, apns });
  return { app, clock, store, logs };
}
function link(t, name = 'iPhone') {
  const r = t.app.appPair({ code: t.app.pairFromAgent({}).code, name });
  assert.equal(r.status, 200);
  return { token: r.body.token, id: r.body.device.id, device: t.app.appAuth(r.body.token) };
}
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);
// The bot's server as index.js builds it, and a way to call it.
async function withServer(t, fn) {
  const server = serverFor(t.app, { token: AGENT, log: l => t.logs.push(l) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
  };
  try {
    await fn({ get: (path, token) => call('GET', path, { token }), post: (path, body, token) => call('POST', path, { token, body }) });
  } finally { await new Promise(r => { server.closeAllConnections(); server.close(r); }); }
}
const strip = r => ({ status: r.status, json: r.json });

test('a widget token reads the state as GET /app/state gives it, at once; it opens nothing else, and a phone\'s own token does not open its read', async () => {
  const t = makeBot();
  const phone = link(t);
  await withServer(t, async ({ get, post }) => {
    const made = await post('/app/widget/token', {}, phone.token);
    assert.equal(made.status, 200);
    assert.deepEqual(Object.keys(made.json), ['ok', 'token']);
    const widget = made.json.token;
    assert.match(widget, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(widget, 'base64url').length, 32);
    // Only its SHA-256 is kept, on the phone it was made for.
    const saved = t.store.load();
    assert.equal(saved.apps[0].widget, crypto.createHash('sha256').update(widget).digest('hex'));
    assert.ok(!JSON.stringify(saved).includes(widget));
    // The read: exactly what the phone itself is shown.
    const read = await get('/app/widget/state', widget);
    assert.equal(read.status, 200);
    assert.equal(read.cache, 'no-store');
    assert.deepEqual(Object.keys(read.json), ['ok', 'etag', 'state']);
    assert.deepEqual(strip(await get('/app/state', phone.token)), strip(read));
    assert.deepEqual(read.json.state.devices.map(d => d.me), [true]);
    // Never a wait: what a phone would wait on comes at once.
    const asked = Date.now();
    assert.deepEqual(strip(await get(`/app/widget/state?have=${read.json.etag}&wait=25`, widget)), strip(read));
    assert.ok(Date.now() - asked < 2000);
    // The widget token opens nothing else: not the state the app waits on, not one request, not another widget token.
    assert.deepEqual(strip(await get('/app/state', widget)), UNPAIRED);
    assert.deepEqual(strip(await post('/app/pause', { paused: true }, widget)), UNPAIRED);
    assert.deepEqual(strip(await post('/app/widget/token', {}, widget)), UNPAIRED);
    assert.deepEqual(strip(await post('/app/unpair', {}, widget)), UNPAIRED);
    assert.deepEqual(strip(await post('/app/widget/state', {}, widget)), UNPAIRED);
    assert.equal(t.app.state.paused, false);
    assert.equal(t.app.state.apps.length, 1);
    // ...nor anything of the PC's.
    assert.equal((await post('/agent/ping', {}, widget)).status, 401);
    // The phone's own token, no token and a token nobody was given do not open the widget's read.
    assert.deepEqual(strip(await get('/app/widget/state', phone.token)), UNPAIRED);
    assert.deepEqual(strip(await get('/app/widget/state')), UNPAIRED);
    assert.deepEqual(strip(await get('/app/widget/state', A.newToken().token)), UNPAIRED);
    assert.deepEqual(strip(await get('/app/widget/state', AGENT)), UNPAIRED);
    // A POST there from the phone is no such thing.
    assert.deepEqual(strip(await post('/app/widget/state', {}, phone.token)), { status: 404, json: { ok: false, why: 'no such thing here' } });
    // Neither the widget token nor any length of it worth having is in the log; asking for it is.
    const logged = t.logs.join('\n');
    for (let i = 0; i + 12 <= widget.length; i++) assert.ok(!logged.includes(widget.slice(i, i + 12)), 'a piece of the widget token is in the log');
    assert.ok(logged.includes('From the app: widget/token'));
  });
});

test('a widget\'s read is not the phone being heard from', async () => {
  const t = makeBot();
  const phone = link(t);
  const linkedAt = t.clock.t;
  const widget = (await ask(t, phone, 'widget/token')).body.token;
  t.clock.t += 5 * 60000;
  const read = t.app.appWidget(widget);
  assert.equal(read.status, 200);
  assert.equal(read.body.state.devices[0].seenAt, linkedAt);
  assert.equal(t.store.load().apps[0].seenAt, linkedAt);
  // The phone itself asking is.
  t.app.appAuth(phone.token);
  assert.equal(t.store.load().apps[0].seenAt, linkedAt + 5 * 60000);
});

test('a new widget token replaces the old; unlinking the phone, or every phone, ends it; a restart keeps it', async () => {
  const t = makeBot();
  const phone = link(t), other = link(t, 'iPad');
  const first = (await ask(t, phone, 'widget/token')).body.token;
  const second = (await ask(t, phone, 'widget/token')).body.token;
  assert.notEqual(first, second);
  assert.equal(t.app.appWidget(first).status, 401);
  assert.equal(t.app.appWidget(second).status, 200);
  // Each phone's widget reads that phone's state.
  const ipad = (await ask(t, other, 'widget/token')).body.token;
  assert.deepEqual(t.app.appWidget(ipad).body.state.devices.map(d => [d.name, d.me]), [['iPhone', false], ['iPad', true]]);
  // A body that is not an object is refused, as everywhere.
  assert.deepEqual((await ask(t, phone, 'widget/token', [1])).body, { ok: false, why: 'The request body must be a JSON object.' });
  // Started again on the same settings: the widget still reads.
  const again = makeBot({ store: t.store });
  assert.equal(again.app.appWidget(second).status, 200);
  assert.equal(loadState(t.store.load()).apps[0].widget, A.hashToken(second));
  // The phone unlinks itself: its widget's token opens nothing any more; the other phone's still does.
  await ask(t, phone, 'unpair');
  assert.deepEqual(t.app.appWidget(second), { status: 401, body: { ok: false, why: 'unpaired' } });
  assert.equal(t.app.appWidget(ipad).status, 200);
  // Every phone unlinked from the PC: none.
  t.app.pairFromAgent({ forget: true });
  assert.equal(t.app.appWidget(ipad).status, 401);
  // A phone linked for another chat (the bot taken over) is dropped at the start, its widget with it.
  const mine = makeBot({ store: memStore({ v: 4, owner: OWNER }) });
  const p = link(mine);
  const w = (await ask(mine, p, 'widget/token')).body.token;
  const taken = makeBot({ store: memStore({ ...mine.store.load(), owner: 777 }) });
  assert.equal(taken.app.appWidget(w).status, 401);
});

test('a widget may read 120 times an hour; the 121st is told slow; each phone\'s widget is counted apart, and a new token is no new count', async () => {
  const t = makeBot();
  const phone = link(t), other = link(t, 'iPad');
  let widget = (await ask(t, phone, 'widget/token')).body.token;
  const first = t.clock.t;
  for (let i = 0; i < 120; i++) {
    if (i === 60) widget = (await ask(t, phone, 'widget/token')).body.token;
    t.clock.t = first + i * 1000;
    assert.equal(t.app.appWidget(widget).status, 200, `read ${i + 1}`);
  }
  assert.deepEqual(t.app.appWidget(widget), { status: 429, body: { ok: false, why: 'slow' } });
  await withServer(t, async ({ get }) => {
    assert.deepEqual(strip(await get('/app/widget/state', widget)), { status: 429, json: { ok: false, why: 'slow' } });
  });
  // An unknown token is told unpaired, not slow.
  assert.equal(t.app.appWidget(A.newToken().token).status, 401);
  // The other phone's widget has its own 120.
  const ipad = (await ask(t, other, 'widget/token')).body.token;
  assert.equal(t.app.appWidget(ipad).status, 200);
  // The phone's own reads are not counted: GET /app/state goes on.
  assert.ok(t.app.appState(phone.device));
  // An hour after the first read, the widget may read again.
  t.clock.t = first + 60 * 60000;
  assert.equal(t.app.appWidget(widget).status, 200);
});

test('POST /app/activity/token: the push-to-start token and an activity\'s own, checked, kept, and given back as nothing but `activity.start`', async () => {
  const t = makeBot({ apns: { send: async () => ({ status: 200, reason: null }) } });
  const phone = link(t), other = link(t, 'iPad');
  const why = async body => { const r = await ask(t, phone, 'activity/token', body); return [r.status, r.body.why]; };
  assert.deepEqual(t.app.appState(phone.device).state.activity, { push: true, start: false });
  // What is refused, and in which words.
  assert.deepEqual(await why([1]), [400, 'The request body must be a JSON object.']);
  for (const body of [{}, { token: START }, { kind: 'stop', token: START }, { kind: 'START', token: START }]) {
    assert.deepEqual(await why(body), [400, 'To give a Live Activity token, send kind: "start" (the push-to-start token) or "update" (an activity\'s own token).'], JSON.stringify(body));
  }
  for (const token of [undefined, '', 'ab'.repeat(31) + 'a', 'zz'.repeat(40), 'a'.repeat(401), 7, ['ab'.repeat(40)], `${START} `]) {
    assert.deepEqual(await why({ kind: 'start', token }), [400, 'A push-to-start token is hex, 64 to 400 characters. Send one, or null to stop.'], String(token).slice(0, 20));
  }
  const updateWhy = 'An activity\'s token needs its activity id (up to 80 letters, digits and dashes), its court (a result\'s id, as state.results gives it) and the token (hex, 64 to 400 characters). Or send token: null to forget it.';
  const good = { kind: 'update', activity: ACTIVITY_ID, court: COURT, token: UPDATE };
  for (const bad of [{ activity: undefined }, { activity: '' }, { activity: 'x'.repeat(81) }, { activity: 'a b' }, { activity: 'a/b' }, { court: undefined }, { court: '2026-11-24' }, { court: '../x' }, { court: 'Gorbals/2026-11-24@19:00' }, { token: undefined }, { token: 'ab' }, { token: 'zz'.repeat(40) }]) {
    assert.deepEqual(await why({ ...good, ...bad }), [400, updateWhy], JSON.stringify(bad));
  }
  assert.equal(t.store.load().apps[0].activityStart, null, 'nothing kept from what was refused');
  // The push-to-start token: kept (in lower case), and said as `activity.start`; null forgets it.
  const r = await ask(t, phone, 'activity/token', { kind: 'start', token: START });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['ok', 'etag', 'state']);
  assert.deepEqual(r.body.state.activity, { push: true, start: true });
  assert.equal(t.store.load().apps[0].activityStart, START.toLowerCase());
  assert.deepEqual(t.app.appState(other.device).state.activity, { push: true, start: false }, 'each phone says its own');
  // One phone, one token: the same token from another phone moves to it.
  await ask(t, other, 'activity/token', { kind: 'start', token: START.toLowerCase() });
  assert.deepEqual(t.store.load().apps.map(d => d.activityStart), [null, START.toLowerCase()]);
  await ask(t, other, 'activity/token', { kind: 'start', token: null });
  assert.deepEqual(t.store.load().apps.map(d => d.activityStart), [null, null]);
  // An activity the app runs: kept, and its court counted as started on that phone.
  assert.equal((await ask(t, phone, 'activity/token', good)).status, 200);
  assert.deepEqual(t.store.load().apps[0].activityUpdate, { activity: ACTIVITY_ID, court: COURT, token: UPDATE });
  assert.deepEqual(t.store.load().activitySent, { [phone.id]: COURT });
  const club = { kind: 'update', activity: 'abc-123', court: 'scotstoun/2026-11-25@18:00', token: 'ab'.repeat(200) };
  assert.equal((await ask(t, phone, 'activity/token', club)).status, 200);
  assert.deepEqual(t.store.load().apps[0].activityUpdate, { activity: 'abc-123', court: 'scotstoun/2026-11-25@18:00', token: 'ab'.repeat(200) });
  assert.equal((await ask(t, phone, 'activity/token', { kind: 'update', token: null })).status, 200);
  assert.equal(t.store.load().apps[0].activityUpdate, null);
  // No token is in the state, nor in the log.
  await ask(t, phone, 'activity/token', { kind: 'start', token: START });
  await ask(t, phone, 'activity/token', good);
  const s = JSON.stringify(t.app.appState(phone.device).state).toLowerCase();
  const logged = t.logs.join('\n').toLowerCase();
  for (const token of [START.toLowerCase(), UPDATE]) { assert.ok(!s.includes(token.slice(0, 16))); assert.ok(!logged.includes(token.slice(0, 16))); }
  assert.ok(!s.includes(ACTIVITY_ID.toLowerCase()));
  // Over HTTP, the same.
  await withServer(t, async ({ post }) => {
    assert.deepEqual(strip(await post('/app/activity/token', { kind: 'start' }, phone.token)), { status: 400, json: { ok: false, why: 'A push-to-start token is hex, 64 to 400 characters. Send one, or null to stop.' } });
    assert.equal((await post('/app/activity/token', { kind: 'start', token: null }, phone.token)).json.state.activity.start, false);
  });
});

test('what is kept of a widget token and of the Live Activity tokens is made safe to use', () => {
  const base = { id: 'a1b2c3d4', name: 'iPhone', hash: 'a'.repeat(64), at: 1, seenAt: 2, push: null, owner: OWNER };
  const kept = over => loadState({ v: 4, apps: [{ ...base, ...over }] }).apps[0];
  assert.deepEqual(kept({}), { ...base, widget: null, activityStart: null, activityUpdate: null });
  const update = { activity: ACTIVITY_ID, court: COURT, token: UPDATE };
  assert.deepEqual(kept({ widget: 'b'.repeat(64), activityStart: START, activityUpdate: { ...update, extra: true } }),
    { ...base, widget: 'b'.repeat(64), activityStart: START.toLowerCase(), activityUpdate: update });
  for (const widget of ['B'.repeat(64), 'b'.repeat(63), 7, {}, 'a token itself']) assert.equal(kept({ widget }).widget, null);
  for (const activityStart of ['ab'.repeat(20), 'xy'.repeat(40), 7, null]) assert.equal(kept({ activityStart }).activityStart, null);
  for (const bad of [null, 'x', [], { ...update, court: 'nowhere' }, { ...update, activity: '' }, { ...update, token: 'zz' }]) assert.equal(kept({ activityUpdate: bad }).activityUpdate, null);
  // Which court was sent to which phone: only for phones linked, and only a result's id.
  const sent = loadState({ v: 4, apps: [base], activitySent: { a1b2c3d4: COURT, ffffffff: COURT } }).activitySent;
  assert.deepEqual(sent, { a1b2c3d4: COURT });
  assert.deepEqual(loadState({ v: 4, apps: [base], activitySent: { a1b2c3d4: '../x' } }).activitySent, {});
  assert.deepEqual(loadState({ v: 4, apps: [base], activitySent: 'x' }).activitySent, {});
  assert.deepEqual(loadState({ v: 3, apps: [base], activitySent: { a1b2c3d4: COURT } }).activitySent, {}, 'not from another version of the file');
  // A token found by its own kind only.
  const phone = A.newToken(), widget = A.newToken();
  const devices = [{ id: 'a1b2c3d4', hash: phone.hash, widget: widget.hash }];
  assert.equal(A.findDevice(devices, phone.token).id, 'a1b2c3d4');
  assert.equal(A.findDevice(devices, widget.token), null);
  assert.equal(A.findWidget(devices, widget.token).id, 'a1b2c3d4');
  assert.equal(A.findWidget(devices, phone.token), null);
  assert.equal(A.findWidget([{ id: 'a1b2c3d4', hash: phone.hash, widget: null }], widget.token), null);
});
