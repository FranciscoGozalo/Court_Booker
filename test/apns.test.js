'use strict';
// Apple's push service (lib/apns.js, 2.14), against a stand-in for Node's http2: the token the bot signs
// for Apple, each push's request, one connection kept and made again, and nothing secret in the log.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createApns, fromEnv, readKey, mask, OFF, DEFAULT_TOPIC, DEFAULT_HOST } = require('../lib/apns');
require('./helpers');                            // holds the test file open while a push's own timer (unref'd) runs out

const KEY_ID = 'ABC123DEFG';
const TEAM_ID = 'TEAM456XYZ';
const DEVICE = 'a1'.repeat(40);                  // 80 hex characters, as iOS gives a token
const T0 = Date.parse('2026-11-17T12:00:00Z');
// A key such as Apple gives (P-256, its .p8 file being this PEM), made for these tests only.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

// A stand-in for http2.connect: each connection keeps the requests made on it, for the test to answer.
function fakeHttp2() {
  const sessions = [];
  const connect = authority => {
    const s = new EventEmitter();
    Object.assign(s, { authority, closed: false, destroyed: false, requests: [] });
    s.request = headers => {
      const req = new EventEmitter();
      Object.assign(req, { headers, body: null, cancelled: null });
      req.setEncoding = () => {};
      req.close = code => { req.cancelled = code; };
      req.end = body => { req.body = body; };
      s.requests.push(req);
      return req;
    };
    s.destroy = () => { s.destroyed = true; };
    s.close = () => { s.closed = true; };
    sessions.push(s);
    return s;
  };
  const answer = (req, status, body = '') => { req.emit('response', { ':status': status }); if (body) req.emit('data', body); req.emit('end'); req.emit('close'); };
  const last = () => { const s = sessions[sessions.length - 1]; return s.requests[s.requests.length - 1]; };
  return { connect, sessions, answer, last };
}
const parts = jwt => jwt.split('.');
const decode = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const verifies = jwt => {
  const [h, c, sig] = parts(jwt);
  return crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
};

test('a push to Apple: the request as Apple asks for it, and a token signed with the key (ES256), which Apple can check', async () => {
  const h = fakeHttp2(), clock = { t: T0 };
  const apns = createApns({ key: PEM, keyId: KEY_ID, teamId: TEAM_ID, connect: h.connect, now: () => clock.t });
  const payload = { aps: { timestamp: 1, event: 'start' } };
  const sent = apns.send(DEVICE, payload, { pushType: 'liveactivity', priority: 10 });
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].authority, `https://${DEFAULT_HOST}`);
  const req = h.last();
  const { authorization, ...rest } = req.headers;
  assert.deepEqual(rest, {
    ':method': 'POST', ':path': `/3/device/${DEVICE}`,
    'apns-push-type': 'liveactivity', 'apns-topic': `${DEFAULT_TOPIC}.push-type.liveactivity`,
    'apns-priority': '10', 'apns-expiration': '0', 'content-type': 'application/json',
  });
  assert.equal(DEFAULT_TOPIC, 'com.franciscogozalo.courtbooker');
  assert.deepEqual(JSON.parse(req.body), payload);
  // The token: { alg: ES256, kid } and { iss: team, iat: seconds }, signed with the key, the signature 64 bytes (r and s).
  const m = /^bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(authorization);
  assert.ok(m, authorization);
  const jwt = m[1];
  assert.deepEqual(decode(parts(jwt)[0]), { alg: 'ES256', kid: KEY_ID });
  assert.deepEqual(decode(parts(jwt)[1]), { iss: TEAM_ID, iat: T0 / 1000 });
  assert.equal(Buffer.from(parts(jwt)[2], 'base64url').length, 64);
  assert.ok(verifies(jwt), 'the signature checks out with the public key');
  h.answer(req, 200);
  assert.deepEqual(await sent, { status: 200, reason: null });
});

test('the signed token is used again for 50 minutes, then made afresh; one connection serves every push', async () => {
  const h = fakeHttp2(), clock = { t: T0 };
  const apns = createApns({ key: PEM, keyId: KEY_ID, teamId: TEAM_ID, connect: h.connect, now: () => clock.t });
  const push = async () => { const p = apns.send(DEVICE, {}); const req = h.last(); h.answer(req, 200); await p; return req.headers.authorization; };
  const first = await push();
  clock.t += 49 * 60000 + 59000;
  assert.equal(await push(), first);
  clock.t = T0 + 50 * 60000;
  const second = await push();
  assert.notEqual(second, first);
  assert.equal(decode(parts(second.slice(7))[1]).iat, (T0 + 50 * 60000) / 1000);
  assert.ok(verifies(second.slice(7)));
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].requests.length, 3);
});

test('Apple\'s refusals come back as its status and reason; the connection is made again after an error or a GOAWAY', async () => {
  const h = fakeHttp2(), logs = [];
  const apns = createApns({ key: PEM, keyId: KEY_ID, teamId: TEAM_ID, connect: h.connect, log: l => logs.push(l), host: 'api.sandbox.push.apple.com', topic: 'com.example.app' });
  let p = apns.send(DEVICE, {});
  assert.equal(h.sessions[0].authority, 'https://api.sandbox.push.apple.com');
  assert.equal(h.last().headers['apns-topic'], 'com.example.app.push-type.liveactivity');
  h.answer(h.last(), 400, '{"reason":"BadDeviceToken"}');
  assert.deepEqual(await p, { status: 400, reason: 'BadDeviceToken' });
  p = apns.send(DEVICE, {});
  h.answer(h.last(), 410, '{"reason":"Unregistered","timestamp":1}');
  assert.deepEqual(await p, { status: 410, reason: 'Unregistered' });
  assert.equal(h.sessions.length, 1);
  // The connection fails: whatever was waiting on it is answered, and the next push connects again.
  p = apns.send(DEVICE, {});
  const jwt = h.last().headers.authorization.slice(7);
  h.last().emit('error', new Error(`stream reset for ${DEVICE}`));
  h.sessions[0].emit('error', new Error(`socket hang up (${jwt}) ${PEM}`));
  assert.deepEqual(await p, { status: 0, reason: 'stream reset for [a device token]' });
  assert.equal(h.sessions[0].destroyed, true);
  p = apns.send(DEVICE, {});
  assert.equal(h.sessions.length, 2);
  h.answer(h.last(), 200);
  await p;
  // Apple says it is closing the connection (GOAWAY): the next push opens another.
  h.sessions[1].emit('goaway');
  p = apns.send(DEVICE, {});
  assert.equal(h.sessions.length, 3);
  h.answer(h.last(), 200);
  await p;
  // A connection closed by itself is not used again either.
  h.sessions[2].closed = true;
  p = apns.send(DEVICE, {});
  assert.equal(h.sessions.length, 4);
  h.answer(h.last(), 200);
  await p;
  // Nothing secret in the log: not the key, not the signed token, not the phone's token.
  const logged = logs.join('\n');
  assert.ok(logs.some(l => /^The connection to Apple's push service failed: socket hang up/.test(l)), logged);
  for (const secret of [DEVICE, jwt, jwt.split('.')[2], 'BEGIN PRIVATE KEY', PEM.split('\n')[1]]) assert.ok(!logged.includes(secret), secret.slice(0, 20));
});

test('a push never rejects: no answer in time, a connection that cannot be made, a body that is not JSON', async () => {
  const h = fakeHttp2();
  const slow = createApns({ key: PEM, keyId: KEY_ID, teamId: TEAM_ID, connect: h.connect, timeoutMs: 20 });
  const r = await slow.send(DEVICE, {});
  assert.deepEqual(r, { status: 0, reason: 'Apple did not answer in time' });
  assert.equal(h.last().cancelled, require('node:http2').constants.NGHTTP2_CANCEL);           // the request is given up
  const broken = createApns({ key: PEM, keyId: KEY_ID, teamId: TEAM_ID, connect: () => { throw new Error(`no route to ${DEVICE}`); } });
  assert.deepEqual(await broken.send(DEVICE, {}), { status: 0, reason: 'no route to [a device token]' });
  const odd = createApns({ key: PEM, keyId: KEY_ID, teamId: TEAM_ID, connect: h.connect });
  const p = odd.send(DEVICE, {});
  h.answer(h.last(), 500, 'not json');
  assert.deepEqual(await p, { status: 500, reason: null });
});

test('the key: its PEM text, with its line breaks written \\n, or the PEM base64-encoded; anything else is refused without a word of it', () => {
  for (const text of [PEM, PEM.replace(/\n/g, '\\n'), Buffer.from(PEM).toString('base64'), privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')]) {
    assert.equal(readKey(text).asymmetricKeyType, 'ec');
  }
  assert.throws(() => readKey(''), /empty/);
  assert.throws(() => readKey('not a key at all'), /^Error: it is not the \.p8 key from Apple/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => readKey(rsa), /not a P-256 key/);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => readKey(other), /not a P-256 key/);
  try { readKey(PEM.replace('BEGIN', 'BEGIN broken')); } catch (e) { assert.ok(!e.message.includes(PEM.split('\n')[1])); }
});

test('from Railway\'s variables: off, said once, without the key and its two ids; on with them; never a word of the key', () => {
  const said = env => { const logs = []; const apns = fromEnv(env, { log: l => logs.push(l), connect: fakeHttp2().connect }); return { apns, logs }; };
  assert.deepEqual(said({}), { apns: null, logs: [OFF] });
  assert.equal(OFF, 'Live Activities by push are off: add APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID on Railway.');
  assert.deepEqual(said({ APNS_KEY: PEM, APNS_KEY_ID: KEY_ID }).logs, [OFF]);
  assert.deepEqual(said({ APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID }).logs, [OFF]);
  const on = said({ APNS_KEY: Buffer.from(PEM).toString('base64'), APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });
  assert.ok(on.apns && typeof on.apns.send === 'function');
  assert.deepEqual([on.apns.host, on.apns.topic, on.logs], [DEFAULT_HOST, DEFAULT_TOPIC, ['Live Activities by push are on (api.push.apple.com).']]);
  const sandbox = said({ APNS_KEY: PEM, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_HOST: 'api.sandbox.push.apple.com', APNS_TOPIC: 'com.example.app' });
  assert.deepEqual([sandbox.apns.host, sandbox.apns.topic], ['api.sandbox.push.apple.com', 'com.example.app']);
  const bad = said({ APNS_KEY: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg-not-really', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });
  assert.deepEqual(bad, { apns: null, logs: ['Live Activities by push are off: APNS_KEY could not be read (it is not the .p8 key from Apple (its text, or that text base64-encoded)).'] });
  assert.equal(said({ APNS_KEY: PEM, APNS_KEY_ID: 'AB C', APNS_TEAM_ID: TEAM_ID }).apns, null);
  assert.equal(said({ APNS_KEY: PEM, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_HOST: 'https://evil/' }).apns, null);
});

test('what is masked before anything about a push is logged', () => {
  assert.equal(mask(`token ${DEVICE} refused`), 'token [a device token] refused');
  assert.equal(mask('eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln and more'), '[a signed token] and more');
  assert.equal(mask(`key ${PEM.trim()} here`), 'key [a key] here');
  assert.equal(mask(`cut short: ${PEM.slice(0, 60)}`), 'cut short: [a key]');
  assert.equal(mask('BadDeviceToken'), 'BadDeviceToken');
  assert.equal(mask(null), '');
});
