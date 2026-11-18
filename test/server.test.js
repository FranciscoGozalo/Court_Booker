'use strict';
// The endpoint your PC talks to.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../lib/server');

const TOKEN = 'a-long-random-line-for-testing-only';

async function withServer(handlers, fn) {
  const server = createServer({ token: TOKEN, ...handlers });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(r => server.close(r)); }
}
const auth = { authorization: `Bearer ${TOKEN}` };

test('health is open; everything else needs the token', async () => {
  await withServer({ getJobs: () => ({ jobs: [] }), onResult: async () => ({ ok: true }) }, async base => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/agent/jobs`)).status, 401);
    assert.equal((await fetch(`${base}/agent/jobs`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/nothing`, { headers: auth })).status, 404);
  });
});

test('the PC gets its jobs and can post a result', async () => {
  const got = [];
  const handlers = {
    getJobs: () => ({ jobs: [{ id: '2026-11-24@16:00' }], order: [3, 4] }),
    onResult: async r => { got.push(r); return r.id ? { ok: true } : { ok: false, why: 'no id' }; },
  };
  await withServer(handlers, async base => {
    const jobs = await (await fetch(`${base}/agent/jobs`, { headers: auth })).json();
    assert.deepEqual(jobs, { ok: true, jobs: [{ id: '2026-11-24@16:00' }], order: [3, 4] });
    const post = body => fetch(`${base}/agent/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ id: 'x', status: 'booked' }))).status, 200);
    assert.equal((await post(JSON.stringify({ status: 'booked' }))).status, 400);
    assert.equal((await post('not json')).status, 400);
    assert.deepEqual(got.map(r => r.id), ['x', undefined]);
  });
});

test('a result that cannot be passed on is a 500, so the PC tries again', async () => {
  await withServer({ getJobs: () => ({}), onResult: async () => { throw new Error('Telegram down'); } }, async base => {
    const res = await fetch(`${base}/agent/result`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'x' }) });
    assert.equal(res.status, 500);
  });
});

const crypto = require('node:crypto');
const { signedText, readPublicKey } = require('../lib/server');

// The PC's side of a signed request, as kelvingrove-court-booker does it.
function signedHeader(privateKey, method, path, body, ms = Date.now()) {
  const sig = crypto.sign(null, Buffer.from(signedText(ms, method, path, body)), privateKey).toString('base64url');
  return `Signed ${ms}.${sig}`;
}

test('requests signed with the PC key are let in; anything else is not', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const pub = readPublicKey(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  const got = [];
  const handlers = { getJobs: () => ({ jobs: [] }), onResult: async r => { got.push(r); return { ok: true }; }, publicKey: pub, token: '' };
  await withServer(handlers, async base => {
    const get = h => fetch(`${base}/agent/jobs`, { headers: { authorization: h } }).then(r => r.status);
    assert.equal(await get(signedHeader(privateKey, 'GET', '/agent/jobs', '')), 200);
    assert.equal(await get(signedHeader(other.privateKey, 'GET', '/agent/jobs', '')), 401);                       // someone else's key
    assert.equal(await get(signedHeader(privateKey, 'GET', '/agent/jobs', '', Date.now() - 6 * 60000)), 401);    // too old
    assert.equal(await get(signedHeader(privateKey, 'POST', '/agent/jobs', '')), 401);                          // signed for something else
    const replay = signedHeader(privateKey, 'GET', '/agent/jobs', '');
    assert.equal(await get(replay), 200);
    assert.equal(await get(replay), 401);                                                                         // the same signature twice
    assert.equal(await get('Bearer '), 401);                                                                      // no token set: no way in
    // A result: the signature covers the body, so a changed body is refused.
    const body = JSON.stringify({ id: '2026-11-24@16:00', status: 'booked', court: '3' });
    const post = (h, b) => fetch(`${base}/agent/result`, { method: 'POST', headers: { authorization: h }, body: b }).then(r => r.status);
    assert.equal(await post(signedHeader(privateKey, 'POST', '/agent/result', body), body.replace('3', '4')), 401);
    assert.equal(await post(signedHeader(privateKey, 'POST', '/agent/result', body), body), 200);
    assert.deepEqual(got.map(r => r.court), ['3']);
  });
});

test('the PC pings to say it is awake; only it may', async () => {
  let pings = 0;
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onPing: () => { pings++; return {}; } }, async base => {
    assert.equal((await fetch(`${base}/agent/ping`, { method: 'POST', body: '{}' })).status, 401);
    const res = await fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: '{}' });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(pings, 1);
  });
});

test('the banner pictures and their preview pages are open to all, and nothing else is', async () => {
  const pics = { 'home-awake': { buf: Buffer.from('jpeg bytes'), hash: 'abc' } };
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), picture: k => pics[k] || null }, async base => {
    const img = await fetch(`${base}/banner/home-awake.jpg`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await img.arrayBuffer()).toString(), 'jpeg bytes');
    const page = await fetch(`${base}/card/home-awake`, { headers: { 'x-forwarded-host': 'bot.example.app' } });
    assert.match(await page.text(), /<meta property="og:image" content="https:\/\/bot\.example\.app\/banner\/home-awake\.jpg\?v=abc">/);
    assert.equal((await fetch(`${base}/banner/nothing.jpg`)).status, 404);
    assert.equal((await fetch(`${base}/card/home-awake.jpg`)).status, 401);          // not a page: falls through to the locked part
    assert.equal((await fetch(`${base}/banner/../agent/jobs`)).status, 401);
  });
});

test('the public key can be given as one line of base64 or as PEM, and must be ed25519', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  assert.equal(readPublicKey(publicKey.export({ type: 'spki', format: 'pem' })).asymmetricKeyType, 'ed25519');
  assert.equal(readPublicKey(''), null);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => readPublicKey(rsa), /should be ed25519/);
});
