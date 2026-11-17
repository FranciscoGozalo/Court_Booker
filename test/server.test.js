'use strict';
// The HTTP endpoint Railway exposes to the home server. A real listener on an ephemeral port.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, timingEqual } = require('../lib/server');
const { createRelay } = require('../lib/relay');

const TOKEN = 'a-long-secret-token-000000000000';
const PLAN = { plan: { thu: { start: 1140, hours: 2 } }, order: [4, 3, 5, 2, 6, 1], releaseMin: 1320, daysAhead: 7, lead: 30, free: true };
const reading = { date: '2026-11-26', start: 1140, end: 1260, ok: true, courts: { 1: 'free', 2: 'booked', 3: 'free', 4: 'free', 5: 'free', 6: 'free' }, visible: true, ms: 170 };

// Starts the server, runs `body(base, relay)`, and always closes it.
async function withServer(body, { getPlan = () => PLAN } = {}) {
  const relay = createRelay();
  const server = createServer({ relay, getPlan, token: TOKEN });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await body(base, relay); } finally { await new Promise(r => server.close(r)); }
}
const auth = { authorization: `Bearer ${TOKEN}` };

test('health needs no token, so Railway and the home server can check the bot is up', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
});

test('everything else needs the token', async () => {
  await withServer(async base => {
    for (const path of ['/agent/plan', '/agent/result']) {
      assert.equal((await fetch(`${base}${path}`)).status, 401);
      assert.equal((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    }
    assert.equal((await fetch(`${base}/agent/plan`, { headers: { authorization: TOKEN } })).status, 200);   // bare token, no "Bearer", also fine
  });
});

test('the plan is served so the home server knows what to read', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/agent/plan`, { headers: auth });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, plan: PLAN });
  });
});

test('a reading is accepted and then handed to the bot as its court check', async () => {
  await withServer(async (base, relay) => {
    const r = await fetch(`${base}/agent/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(reading) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    const got = relay.checkCourts('2026-11-26', 1140, 1260);                         // exactly what the bot would get
    assert.equal(got.ok, true);
    assert.equal(got.courts[2], 'booked');
    assert.equal(relay.status().posts, 1);
  });
});

test('junk, bad JSON and an oversized body are refused without storing anything', async () => {
  await withServer(async (base, relay) => {
    assert.equal((await fetch(`${base}/agent/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: 'not json' })).status, 400);
    assert.equal((await fetch(`${base}/agent/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ nope: 1 }) })).status, 400);
    const big = await fetch(`${base}/agent/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: 'x'.repeat(100000) }).catch(e => ({ status: 'reset: ' + e.message }));
    assert.ok(big.status === 400 || String(big.status).startsWith('reset'), String(big.status));
    assert.equal(relay.status().posts, 0);
    assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/agent/result`, { headers: auth })).status, 404);   // GET on the post route
  });
});

test('the plan failing does not take the server down', async () => {
  await withServer(async base => {
    assert.equal((await fetch(`${base}/agent/plan`, { headers: auth })).status, 500);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  }, { getPlan: () => { throw new Error('no plan'); } });
});

test('the token compare does not leak its length or content by timing', () => {
  assert.equal(timingEqual('abc', 'abc'), true);
  assert.equal(timingEqual('abc', 'abd'), false);
  assert.equal(timingEqual('abc', 'abcd'), false);
  assert.equal(timingEqual('', ''), true);
});
