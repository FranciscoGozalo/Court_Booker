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

test('a look from the PC needs the token, and a whole day\'s sheet fits', async () => {
  const got = [];
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onLook: raw => { got.push(raw); return raw.id === 'late' ? { late: true } : {}; } }, async base => {
    const post = (body, headers = auth) => fetch(`${base}/agent/look`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ id: 'x' }), {})).status, 401);
    assert.equal((await post('not json')).status, 400);
    // A real day (six courts, sixteen hours) is about 10 KB. This one is larger than any, and past the old 16 KB limit.
    const slot = h => [`2026-11-25T${h}:00:00Z`, `2026-11-25T${h}:59:59Z`, '2026-11-18T00:00:00Z', `2026-11-25T${h}:00:00Z`, 0, 'Unavailable'];
    const sheet = Array.from({ length: 10 }, (_, c) => ({ n: `Tennis Hall Court ${c + 1}`, s: Array.from({ length: 20 }, (_, h) => slot(String(4 + h).padStart(2, '0'))) }));
    const body = JSON.stringify({ id: 'abc123def456', ok: true, sheet });
    assert.ok(body.length > 16 * 1024 && body.length < 64 * 1024);
    const res = await post(body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(await (await post(JSON.stringify({ id: 'late', ok: false, kind: 'timeout', why: 'x' }))).json(), { ok: true, late: true });
    assert.deepEqual(got.map(r => [r.id, r.ok]), [['abc123def456', true], ['late', false]]);
  });
  // A handler that fails is a 500, as for a result.
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onLook: () => { throw new Error('boom'); } }, async base => {
    assert.equal((await fetch(`${base}/agent/look`, { method: 'POST', headers: auth, body: '{}' })).status, 500);
  });
});

test('a signed body that arrives in pieces, cut inside a letter, is still the PC\'s', async () => {
  const http = require('node:http');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = readPublicKey(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  const got = [];
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onLook: raw => { got.push(raw); return {}; }, publicKey: pub, token: '' }, async base => {
    const body = JSON.stringify({ id: 'abc', ok: false, kind: 'odd', why: 'café fermé – naïve' });
    const bytes = Buffer.from(body);
    const cut = bytes.indexOf(Buffer.from('é')) + 1;                 // between the two bytes of the first é
    assert.equal(bytes[cut - 1], 0xc3);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/agent/look`, { method: 'POST', headers: { authorization: signedHeader(privateKey, 'POST', '/agent/look', body), 'content-type': 'application/json', 'content-length': bytes.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write(bytes.subarray(0, cut));
      setTimeout(() => req.end(bytes.subarray(cut)), 30);
    });
    assert.equal(status, 200);
    assert.deepEqual(got.map(r => r.why), ['café fermé – naïve']);
  });
});

test('a note about a hold needs the token, and its answer carries your order back to the PC', async () => {
  const got = [];
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onHold: raw => { got.push(raw); return raw.stage === 'held' ? { order: 'release' } : {}; } }, async base => {
    const post = (body, headers = auth) => fetch(`${base}/agent/hold`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'held' }), {})).status, 401);
    assert.equal((await post('not json')).status, 400);
    assert.deepEqual(await (await post(JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'signing-in' }))).json(), { ok: true });
    assert.deepEqual(await (await post(JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'held', price: '£23.00' }))).json(), { ok: true, order: 'release' });
    assert.deepEqual(got.map(r => [r.id, r.stage, r.price]), [['a1b2c3d4e5f6', 'signing-in', undefined], ['a1b2c3d4e5f6', 'held', '£23.00']]);
  });
  // A handler that fails is a 500; one that is not there at all (an older bot) answers ok and no more.
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onHold: () => { throw new Error('boom'); } }, async base => {
    assert.equal((await fetch(`${base}/agent/hold`, { method: 'POST', headers: auth, body: '{}' })).status, 500);
  });
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }) }, async base => {
    assert.deepEqual(await (await fetch(`${base}/agent/hold`, { method: 'POST', headers: auth, body: '{}' })).json(), { ok: true });
  });
});

test('the jobs ask passes on when Glasgow Club\'s own run starts on the PC (booker 2.12): 22:00 to 23:59 only', async () => {
  const seen = [];
  const handlers = { getJobs: (from, o) => { seen.push(o.clubRun); return { jobs: [] }; }, onResult: async () => ({ ok: true }) };
  await withServer(handlers, async base => {
    for (const q of ['', '?run=1&venues=1&clubRun=1430', '?clubRun=99', '?clubRun=1440', '?clubRun=23:50', '?clubRun=1320']) {
      assert.equal((await fetch(`${base}/agent/jobs${q}`, { headers: auth })).status, 200);
    }
  });
  assert.deepEqual(seen, [null, 1430, null, null, null, 1320]);
});

test('the ping says whether its booker takes Book now at Glasgow Club (2.11.3): an object is passed on as `book`, anything else is nothing', async () => {
  const got = [];
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onPing: (from, said) => { got.push(said); return {}; } }, async base => {
    const ping = body => fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then(r => r.json());
    assert.deepEqual(await ping({ glasgowBook: { max: '£30.00' } }), { ok: true });
    await ping({ glasgowBook: { max: '£30.00', why: 'GLASGOW_PAY_PER_DAY in .env is 0' }, wait: 1 });
    for (const glasgowBook of [null, 'yes', true, ['£30.00'], 30]) await ping({ glasgowBook });
    await ping({});                                                                              // an older PC
    assert.deepEqual(got.map(s => s.book), [{ max: '£30.00' }, { max: '£30.00', why: 'GLASGOW_PAY_PER_DAY in .env is 0' }, null, null, null, null, null, null]);
    assert.equal(got[1].wait, 1);
  });
});

test('a note about Book now at Glasgow Club needs the PC\'s token; the go-ahead comes back as the handler gave it; and a bot without the handler says there is no such thing, never ok', async () => {
  const got = [];
  const onGlasgowBook = raw => { got.push(raw); return raw.stage === 'paying' ? { go: true } : {}; };
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onGlasgowBook }, async base => {
    const post = (body, headers = auth) => fetch(`${base}/agent/glasgow/book`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'paying' }), {})).status, 401);
    assert.equal((await post(JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'paying' }), { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post('not json')).status, 400);
    assert.deepEqual(await (await post(JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'starting' }))).json(), { ok: true });
    assert.deepEqual(await (await post(JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'paying', price: '£23.00', courts: [3] }))).json(), { ok: true, go: true });
    assert.deepEqual(got.map(r => r.stage), ['starting', 'paying']);
  });
  // Signed with the PC's key, as the booker sends it.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = readPublicKey(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onGlasgowBook, publicKey: pub, token: '' }, async base => {
    const body = JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'paying', price: '£23.00', courts: [3] });
    const send = h => fetch(`${base}/agent/glasgow/book`, { method: 'POST', headers: { authorization: h }, body });
    const res = await send(signedHeader(privateKey, 'POST', '/agent/glasgow/book', body));
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, go: true }]);
    assert.equal((await send(signedHeader(privateKey, 'POST', '/agent/clubspark/book', body))).status, 401);      // signed for another route
  });
  // A handler that fails is a 500. None at all (a server built without it): 404, as an older bot answers.
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onGlasgowBook: () => { throw new Error('boom'); } }, async base => {
    assert.equal((await fetch(`${base}/agent/glasgow/book`, { method: 'POST', headers: auth, body: '{}' })).status, 500);
  });
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }) }, async base => {
    const res = await fetch(`${base}/agent/glasgow/book`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'a1b2c3d4e5f6', stage: 'paying' }) });
    assert.deepEqual([res.status, await res.json()], [404, { ok: false, why: 'no such thing here' }]);
  });
});

test('a request that never finishes arriving is cut off, while an answer may take its time', async () => {
  const net = require('node:net');
  // As it runs: 15 seconds for a request's headers, 30 for the whole of it.
  const usual = createServer({ token: TOKEN, getJobs: () => ({}), onResult: async () => ({ ok: true }) });
  assert.deepEqual([usual.headersTimeout, usual.requestTimeout], [15000, 30000]);
  // The same with the times made short, and a ping whose answer takes longer than either.
  const slowPing = async () => { await new Promise(r => setTimeout(r, 700)); return { sleep: true }; };
  await withServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), onPing: slowPing, requestTimeoutMs: 300, headersTimeoutMs: 200, checkEveryMs: 50 }, async base => {
    const port = Number(new URL(base).port);
    // The PC's ping with the start of its body and never the rest: the connection is closed on it.
    const closedAfter = await new Promise(resolve => {
      const began = Date.now(), s = net.connect(port, '127.0.0.1');
      s.on('error', () => {});
      s.on('close', () => resolve(Date.now() - began));
      s.on('connect', () => s.write(`POST /agent/ping HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 50\r\n\r\n{"wait":`));
      setTimeout(() => { resolve(null); s.destroy(); }, 4000).unref();
    });
    assert.ok(closedAfter !== null && closedAfter >= 250 && closedAfter < 3000, `closed after ${closedAfter} ms`);
    // The same ping sent whole: its answer, 0.7 s in the making (up to 50 s on the PC's waiting ping), comes back.
    const res = await fetch(`${base}/agent/ping`, { method: 'POST', headers: auth, body: JSON.stringify({ wait: 1 }) });
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, sleep: true }]);
  });
});
