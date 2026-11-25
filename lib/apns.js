'use strict';
// Pushes to the iPhone by Apple's own push service (APNs), for today's court on the Lock Screen (a
// Live Activity, 2.14: lib/activity.js): started, and ended, with the app closed. Expo's service
// (lib/push.js) cannot do that. Best effort: whatever goes wrong is said in what `send` resolves to,
// and never thrown.
//
// It needs the key Apple gives for its push service (a .p8 file), its key id and the team id, set on
// Railway as APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID (fromEnv, below). The bot proves itself to Apple
// with a short token it signs with that key (ES256), made afresh every 50 minutes (Apple takes one for
// an hour). The key and the tokens are never written in the log, nor any phone's token: anything
// shaped like one is masked first.

const http2 = require('http2');
const crypto = require('crypto');

const DEFAULT_TOPIC = 'com.franciscogozalo.courtbooker';    // the app's bundle id
const DEFAULT_HOST = 'api.push.apple.com';                 // TestFlight and App Store builds; a build from Xcode uses api.sandbox.push.apple.com
const JWT_MS = 50 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const OFF = 'Live Activities by push are off: add APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID on Railway.';

// Anything shaped like a phone's token, a signed token or a key, taken out of words that are about to be logged.
const mask = text => String(text ?? '')
  .replace(/-----BEGIN[\s\S]*?(-----END[^-]*-----|$)/g, '[a key]')
  .replace(/\b[0-9a-fA-F]{32,}\b/g, '[a device token]')
  .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*/g, '[a signed token]');

// The key from APNS_KEY: the .p8 file's text (its line breaks may be written \n), or that text base64-encoded.
// Throws, in words that say nothing of the key, when it is not a P-256 private key.
function readKey(text) {
  let t = String(text ?? '').trim();
  if (!t) throw new Error('it is empty');
  let key;
  try {
    if (!t.includes('BEGIN')) {
      const raw = Buffer.from(t, 'base64');
      const pem = raw.toString('utf8');
      key = pem.includes('BEGIN') ? crypto.createPrivateKey(pem.replace(/\\n/g, '\n')) : crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
    } else {
      t = t.replace(/\\n/g, '\n');
      key = crypto.createPrivateKey(t);
    }
  } catch { throw new Error('it is not the .p8 key from Apple (its text, or that text base64-encoded)'); }
  if (key.asymmetricKeyType !== 'ec' || (key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve !== 'prime256v1')) {
    throw new Error('it is not a P-256 key, as Apple\'s .p8 keys are');
  }
  return key;
}

const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
// The token Apple is shown: { alg: ES256, kid } and { iss: team, iat: seconds }, signed with the key.
function makeJwt(key, keyId, teamId, ms) {
  const head = `${b64url({ alg: 'ES256', kid: keyId })}.${b64url({ iss: teamId, iat: Math.floor(ms / 1000) })}`;
  const sig = crypto.sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${sig.toString('base64url')}`;
}

// `key`: the key's text (as APNS_KEY) or a key object. `connect`: http2.connect, or a stand-in in tests.
// One connection to Apple is kept and used for every push; it is made again after an error, or once
// Apple says it is closing it (a GOAWAY). Each push gets 10 seconds.
function createApns({ key, keyId, teamId, topic = DEFAULT_TOPIC, host = DEFAULT_HOST, log = () => {}, connect = http2.connect, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  const privateKey = key && typeof key === 'object' && key.asymmetricKeyType ? key : readKey(key);
  let jwt = null, jwtAt = 0;
  const bearer = () => {
    const t = now();
    if (!jwt || t - jwtAt >= JWT_MS || t < jwtAt) { jwt = makeJwt(privateKey, keyId, teamId, t); jwtAt = t; }
    return jwt;
  };
  let session = null;
  const drop = s => { if (session === s) session = null; };
  function open() {
    if (session && !session.closed && !session.destroyed) return session;
    const s = connect(`https://${host}`);
    session = s;
    s.on('error', e => { drop(s); log(`The connection to Apple's push service failed: ${mask((e && e.message) || e).slice(0, 200)}`); try { s.destroy(); } catch {} });
    s.on('goaway', () => drop(s));
    s.on('close', () => drop(s));
    return s;
  }

  // One push. Resolves to { status, reason }: Apple's HTTP status (200 when it took it) and its reason
  // when it did not ("BadDeviceToken", "Unregistered", "InvalidProviderToken", …); status 0, with a
  // reason, when Apple could not be reached or did not answer within 10 seconds. It never rejects.
  function send(deviceToken, payload, { pushType = 'liveactivity', priority = 10 } = {}) {
    return new Promise(resolve => {
      let over = false, timer = null, req = null;
      const finish = r => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        resolve(r);
      };
      try {
        const s = open();
        req = s.request({
          ':method': 'POST', ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${bearer()}`,
          'apns-push-type': pushType,
          'apns-topic': pushType === 'liveactivity' ? `${topic}.push-type.liveactivity` : topic,
          'apns-priority': String(priority),
          'apns-expiration': '0',
          'content-type': 'application/json',
        });
      } catch (e) {
        return finish({ status: 0, reason: mask((e && e.message) || e).slice(0, 200) });
      }
      timer = setTimeout(() => {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        finish({ status: 0, reason: 'Apple did not answer in time' });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      let status = 0, body = '';
      req.on('response', h => { status = Number(h[':status']) || 0; });
      if (req.setEncoding) req.setEncoding('utf8');
      req.on('data', d => { if (body.length < 4096) body += d; });
      req.on('end', () => {
        let reason = null;
        try { const j = JSON.parse(body); if (j && typeof j.reason === 'string') reason = j.reason.slice(0, 80); } catch {}
        finish({ status, reason });
      });
      req.on('error', e => finish({ status: 0, reason: mask((e && e.message) || e).slice(0, 200) }));
      req.on('close', () => finish({ status, reason: status ? null : 'the connection closed' }));
      try { req.end(JSON.stringify(payload)); } catch (e) { finish({ status: 0, reason: mask((e && e.message) || e).slice(0, 200) }); }
    });
  }
  const close = () => { if (session) { try { session.close(); } catch {} session = null; } };
  return { send, close, host, topic };
}

// The pushes from Railway's variables, or null (switched off) without the key and its two ids: one
// line in the log says which. `log` and `connect` are passed on.
function fromEnv(env = {}, { log = () => {}, connect } = {}) {
  const text = String(env.APNS_KEY || '').trim(), keyId = String(env.APNS_KEY_ID || '').trim(), teamId = String(env.APNS_TEAM_ID || '').trim();
  if (!text || !keyId || !teamId) { log(OFF); return null; }
  if (!/^[A-Za-z0-9]{4,32}$/.test(keyId) || !/^[A-Za-z0-9]{4,32}$/.test(teamId)) {
    log('Live Activities by push are off: APNS_KEY_ID and APNS_TEAM_ID are the ten letters and digits Apple shows for each.');
    return null;
  }
  const topic = String(env.APNS_TOPIC || '').trim() || DEFAULT_TOPIC;
  const host = String(env.APNS_HOST || '').trim() || DEFAULT_HOST;
  if (!/^[A-Za-z0-9.-]+$/.test(topic) || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) {
    log('Live Activities by push are off: APNS_TOPIC is the app\'s bundle id, and APNS_HOST a host name such as api.push.apple.com.');
    return null;
  }
  try {
    const apns = createApns({ key: text, keyId, teamId, topic, host, log, ...(connect ? { connect } : {}) });
    log(`Live Activities by push are on (${host}).`);
    return apns;
  } catch (e) {
    log(`Live Activities by push are off: APNS_KEY could not be read (${e.message}).`);
    return null;
  }
}

module.exports = { createApns, fromEnv, readKey, makeJwt, mask, DEFAULT_TOPIC, DEFAULT_HOST, JWT_MS, TIMEOUT_MS, OFF };
