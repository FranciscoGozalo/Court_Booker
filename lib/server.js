'use strict';
// The small HTTP endpoint your PC at home talks to. Built on Node's own http, no packages.
// Everything but /health must prove it comes from your PC, in one of two ways:
//
//   Signed   the PC signs each request with its own private key, and the bot checks it with
//            the public half, set here as AGENT_PUBLIC_KEY. Nothing secret is stored on Railway.
//            Header:  Authorization: Signed <ms since 1970>.<signature, base64url>
//            over the text  "<ms>\n<METHOD>\n<path>\n<sha256 of the body, hex>"  (see signedText).
//            Requests more than 5 minutes old are refused, and so is the same signature twice.
//   Bearer   a shared password, AGENT_TOKEN, set the same on both ends.
//
//   GET  /health        a plain ok, for Railway and for the PC to check it is reachable
//   GET  /agent/jobs    what the PC should book now. Asking is the PC's booking run starting, unless
//                       it adds ?run=0 (only looking: node book.js --jobs). ?venues=1 (2.10): its
//                       booker books every venue, so it is handed every venue's jobs, not only
//                       Kelvingrove's. The signature covers the path without the query.
//   POST /agent/ping    the PC is awake (sent every minute while it is on); also where home is,
//                       for waking it (the address the request came from). With { wait: N } the
//                       answer waits up to N s for an instruction: { sleep: true } puts the PC to sleep;
//                       { look: { id, key, date } } has it read one day of Glasgow Club's indoor sheet;
//                       { hold: { id, key, date, start, court, courts } } has it put that court in your
//                       basket, or (2.11) the two in `courts`, lowest first, whose first is `court`;
//                       { card: { id, sealed } } has it keep a card given in the app (sealed there for
//                       the PC's key: the bot cannot open it), { forgetCard: { id } } forget it.
//                       The ping also says { cardKey } (the PC's key for sealing a card), { card }
//                       (the card it keeps: brand, last four digits, expiry; or null) and, after a
//                       card or a forget, { cardDone: { id, ok, why } }. Automatic payments (2.10):
//                       { autoOn: { id, sealed } } has it keep the card's security code for them,
//                       { autoOff: { id } } delete it; the ping says { cardAuto } (whether it keeps
//                       one) and, after either, { autoDone: { id, ok, why } }. Book now at Glasgow Club
//                       (2.11.3): the ping says { glasgowBook: { max, why } } when its booker takes it (its
//                       price cap a court, and why it cannot pay just now), and the answer may be
//                       { glasgowBook: { id, key, date, start, courts, auth } }: book and pay for those courts
//   POST /agent/look    the PC's answer to a look: { id, ok: true, sheet } with the day's sheet as the
//                       site sent it, in short form, or { id, ok: false, kind, why }
//   POST /agent/hold    a step of a hold, or how it ended: { id, stage, key, date, start, court, courts,
//                       price, prices, ... } (2.11: `courts` all the courts, `price` the total,
//                       `prices` each court's). The answer may carry
//                       { order: "release" } (you tapped Let it go), { order: "done" } (I have paid) or
//                       { order: "pay", amount, sealed } (Pay in the app: the amount you confirmed
//                       there, and the card's security code sealed for the PC's key)
//   POST /agent/progress  how the run is going, before a result: { stage: "ready" } once it has
//                       signed in to ClubSpark, or { stage: "trouble", why, attempt, of } when an
//                       attempt failed and it is trying again
//   POST /agent/result  what happened: { id, status: booked|none|failed, court, gate, why, date, start, end }
//                       (Glasgow Club's also type, price, paid; two courts at once, 2.11: courts, and
//                       price the total)
//   POST /agent/clubspark/look   the PC's answer to a look at a park on ClubSpark: { id, ok: true, sheet }
//                       or { id, ok: false, kind, why } (lib/clubspark.js); the ping hands it { csLook }
//   POST /agent/clubspark/book   a step of Book now at a park, or how it ended: { id, stage, ... }; the
//                       answer to { stage: "booking" } is { go: true }, or { stop: true }; the ping hands it { csBook }
//   POST /agent/glasgow/book     a step of Book now at Glasgow Club (2.11.3, lib/glasgowbook.js), or how it
//                       ended without a result: { id, stage, ... }; the answer to { stage: "paying" } is
//                       { go: true } or { stop: true }. Without its handler (onGlasgowBook) this is a 404,
//                       never an answer that could read as a go
//
// Open to anyone, for Telegram's link previews (the wide banner trial): nothing but the pictures.
//   GET  /banner/<kind>.jpg   one of the banner pictures
//   GET  /card/<kind>         a bare page whose preview is that picture
//
// The iPhone app has its own door, /app/ (docs/app-api.md says what is behind it). A phone proves
// itself with the token it was given when it paired (Authorization: Bearer <token>), which the
// bot checks against the phones it has linked. That door and the PC's are kept apart: a phone's
// token opens nothing under /agent/, and the PC's key or AGENT_TOKEN opens nothing under /app/.
//   GET  /app/hello     open: the bot's version
//   POST /app/pair      open: a code from /app in Telegram, for a token (at most 10 tries in 10 minutes)
//   GET  /app/state     everything the app shows; with ?have=<etag>&wait=N it waits for a change
//   POST /app/...       what the app asks for: the same things as the Telegram commands, and the
//                       card for paying (POST /app/card, sealed in the app for the PC's key: passed
//                       on unopened, never written down)
//
// Whoever is asking, a request that does not finish arriving is cut off: 15 seconds for its
// headers, 30 for the whole of it. An answer may take longer (the PC's waiting ping, 50 seconds).
//
// No ClubSpark password and no Telegram token ever pass through here.

const http = require('http');
const crypto = require('crypto');
const { MAX_BODY: APP_MAX_BODY, MAX_WAITS: APP_MAX_WAITS, waitMs } = require('./appapi');

const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_WAIT_S = 50;

const signedText = (ms, method, path, body) =>
  `${ms}\n${method}\n${path}\n${crypto.createHash('sha256').update(body || '').digest('hex')}`;

// The PC's public key, from AGENT_PUBLIC_KEY: one line of base64 (as the PC prints it) or a PEM block.
function readPublicKey(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const key = t.includes('BEGIN')
    ? crypto.createPublicKey(t)
    : crypto.createPublicKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`AGENT_PUBLIC_KEY is a ${key.asymmetricKeyType} key; it should be ed25519`);
  return key;
}

// The page Telegram reads to make the preview: the picture, and the venue as its only words.
const cardPage = (host, kind, hash) => `<!doctype html><html><head><meta charset="utf-8">
<meta property="og:site_name" content="Court Booker">
<meta property="og:title" content="Kelvingrove Park">
<meta property="og:image" content="https://${host}/banner/${kind}.jpg?v=${hash}">
<meta property="og:image:width" content="1280"><meta property="og:image:height" content="480">
<meta name="twitter:card" content="summary_large_image">
<title>Court Booker</title></head><body></body></html>`;

// `maxBody`: a day's sheet from the PC (POST /agent/look) is the largest thing sent here, about 13 KB.
// `appApi`: what the iPhone app's requests are answered with, { hello, pair, auth, state, ask }
// from app.js. Without it there is nothing under /app/. `appPollMs`: how often a waiting
// GET /app/state looks whether the state has changed; `appTimers`: the timer it waits with
// (tests put their own in its place).
// `requestTimeoutMs`, `headersTimeoutMs`: how long a request may take to ARRIVE (its headers, and
// the whole of it) before the connection is cut. They say nothing of how long an answer may
// take, so the PC's ping, which waits up to 50 seconds for its answer, is not touched by them.
// `checkEveryMs`: how often Node looks for requests that have run out of time.
function createServer({ getJobs, onResult, onPing = () => ({ ok: true }), onProgress = async () => ({ ok: true }), onLook = () => ({ ok: true }), onHold = () => ({ ok: true }), picture = () => null, token = '', publicKey = null, log = () => {}, maxBody = 64 * 1024, now = Date.now,
  appApi = null, appPollMs = 1000, appTimers = { setTimeout, clearTimeout }, requestTimeoutMs = 30 * 1000, headersTimeoutMs = 15 * 1000, checkEveryMs = 5000,
  onClubSpark = () => ({ ok: true }), onGlasgowBook = null }) {
  const ok = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const fail = (res, code, why) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, why })); };
  const used = new Map();   // signatures already accepted -> when to forget them

  // ---------- the iPhone app ----------
  // Its requests are answered here and go no further: the PC's check (`authed`, below) never
  // sees them. Bodies are JSON, at most 4 KB.
  const UNPAIRED = { ok: false, why: 'unpaired' };
  const NOTHING = { ok: false, why: 'no such thing here' };
  function forApp(req, res, path, query) {
    const send = (code, body) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size <= APP_MAX_BODY) chunks.push(d);
      else { chunks.length = 0; if (size > 64 * APP_MAX_BODY) req.destroy(); }      // far too much: stop listening
    });
    req.on('error', () => {});
    req.on('end', () => {
      const text = size > APP_MAX_BODY ? null : Buffer.concat(chunks).toString('utf8');
      answerApp(req, res, path, query, text, send).catch(e => {
        log(`A request from the app failed: ${(e && e.message) || e}`);
        send(500, { ok: false, why: 'Something went wrong on my side. Try again.' });
      });
    });
  }
  async function answerApp(req, res, path, query, text, send) {
    if (!appApi) return send(404, NOTHING);
    if (text === null) return send(413, { ok: false, why: 'That request is too large.' });
    const get = req.method === 'GET', post = req.method === 'POST';
    if (get && path === '/app/hello') return send(200, appApi.hello());
    let body = null, json = true;
    if (post) { try { body = text.trim() ? JSON.parse(text) : {}; } catch { json = false; } }
    if (post && path === '/app/pair') {                 // anything that is not the code is a wrong try, unreadable bodies too
      const r = appApi.pair(json ? body : null);
      return send(r.status, r.body);
    }
    const h = String(req.headers.authorization || '');
    const device = h.startsWith('Bearer ') ? appApi.auth(h.slice(7).trim()) : null;
    if (!device) return send(401, UNPAIRED);
    if (get && path === '/app/state') return pollState(res, device, query, send);
    if (post) {
      if (!json) return send(400, { ok: false, why: 'The request body must be JSON.' });
      const r = await appApi.ask(device, path.slice('/app/'.length), body);
      if (r) return send(r.status, r.body);
    }
    return send(404, NOTHING);
  }
  // GET /app/state: the state at once, unless the phone says it has it already (?have=<etag>).
  // Then the answer waits up to ?wait seconds (25 at most) for a change, looking about once a
  // second, and says `same` if there was none. Nothing is left running once it has answered,
  // or once the phone has gone away. One phone may have four waits open; a fifth is not kept
  // waiting, and is told how things stand at once.
  const waits = new Map();                            // phone id -> waits open now
  function pollState(res, device, query, send) {
    const q = new URLSearchParams(query);
    const have = q.get('have') || '';
    let left = waitMs(q.get('wait'));
    let timer = null, over = false, counted = false;
    const stop = () => {
      if (over) return;
      over = true;
      appTimers.clearTimeout(timer);
      res.off('close', stop);
      if (!counted) return;
      const open = (waits.get(device.id) || 1) - 1;
      if (open > 0) waits.set(device.id, open); else waits.delete(device.id);
    };
    const look = () => {
      if (over) return;
      let cur;
      try { cur = appApi.state(device); } catch (e) {
        stop();
        log(`Could not work out the state for the app: ${(e && e.message) || e}`);
        return send(500, { ok: false, why: 'Something went wrong on my side. Try again.' });
      }
      if (!cur) { stop(); return send(401, UNPAIRED); }                  // unlinked while it waited
      if (!have || cur.etag !== have) { stop(); return send(200, { ok: true, etag: cur.etag, state: cur.state }); }
      if (left <= 0) { stop(); return send(200, { ok: true, etag: cur.etag, same: true }); }
      if (!counted) {                                                    // about to wait: is there room for one more?
        const open = waits.get(device.id) || 0;
        if (open >= APP_MAX_WAITS) { stop(); return send(200, { ok: true, etag: cur.etag, state: cur.state }); }
        counted = true;
        waits.set(device.id, open + 1);
      }
      const step = Math.min(appPollMs, left);
      left -= step;
      timer = appTimers.setTimeout(look, step);
    };
    res.on('close', stop);
    look();
  }

  function authed(req, path, body) {
    const h = String(req.headers.authorization || '');
    if (h.startsWith('Signed ')) {
      if (!publicKey) return false;
      const m = /^Signed (\d{10,16})\.([A-Za-z0-9_-]{40,200})$/.exec(h);
      if (!m) return false;
      const ms = Number(m[1]), t = now();
      if (Math.abs(t - ms) > MAX_AGE_MS || used.has(m[2])) return false;
      let good = false;
      try { good = crypto.verify(null, Buffer.from(signedText(ms, req.method, path, body)), publicKey, Buffer.from(m[2], 'base64url')); } catch {}
      if (!good) return false;
      for (const [sig, until] of used) if (until < t) used.delete(sig);
      used.set(m[2], t + 2 * MAX_AGE_MS);
      return true;
    }
    const given = h.startsWith('Bearer ') ? h.slice(7) : h;
    return !!token && given.length === token.length && timingEqual(given, token);
  }

  // A request that does not finish arriving is cut off: 15 seconds for its headers, 30 for the
  // whole of it. (Node's own limits are 60 and 300 seconds, and it looks every 30.)
  const server = http.createServer({ requestTimeout: requestTimeoutMs, headersTimeout: headersTimeoutMs, connectionsCheckingInterval: checkEveryMs }, (req, res) => {
    const [path, query = ''] = (req.url || '').split('?');
    if (req.method === 'GET' && path === '/health') return ok(res, { ok: true });
    if (path === '/app' || path.startsWith('/app/')) return forApp(req, res, path, query);     // the iPhone app's own door
    let m;
    if (req.method === 'GET' && (m = /^\/(banner|card)\/([a-z-]{1,20})(\.jpg)?$/.exec(path)) && (m[1] === 'banner') === !!m[3]) {
      const p = picture(m[2]);
      if (!p) return fail(res, 404, 'no such picture');
      if (m[1] === 'banner') {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': p.buf.length, 'cache-control': 'public, max-age=86400' });
        return res.end(p.buf);
      }
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').replace(/[^\w.:-]/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(cardPage(host, m[2], p.hash));
    }
    // The body is read first, because a signature covers it. Read as text, so a character that
    // arrives split across two pieces is put back together before anything is checked.
    let body = '', over = false;
    req.setEncoding('utf8');
    req.on('data', d => { body += d; if (body.length > maxBody) { over = true; req.destroy(); } });
    req.on('error', () => {});
    req.on('end', async () => {
      if (over) return;
      if (!authed(req, path, body)) return fail(res, 401, 'who are you? the PC must sign with its key (AGENT_PUBLIC_KEY) or send AGENT_TOKEN');

      // Where the PC is calling from: your home's public address, for waking it (see lib/wake.js).
      const from = { ip: clientIp(req) };
      if (req.method === 'GET' && path === '/agent/jobs') {
        // ?run=0: only looking. ?run=1, or nothing (a PC with older code): a booking run starting.
        const flag = new URLSearchParams(query).get('run');
        const run = flag === '0' ? false : flag === '1' ? true : undefined;
        const venues = new URLSearchParams(query).get('venues') === '1';
        // ?clubRun=1430 (booker 2.12): Glasgow Club's own run starts at that minute on the PC (23:50).
        // A booker that says nothing (older) books Glasgow Club from its 21:55 run, as before.
        const club = Number(new URLSearchParams(query).get('clubRun'));
        const clubRun = Number.isInteger(club) && club >= 22 * 60 && club < 24 * 60 ? club : null;
        try { return ok(res, { ok: true, ...getJobs(from, { run, venues, clubRun }) }); }
        catch (e) { return fail(res, 500, (e && e.message) || 'could not work out the jobs'); }
      }
      if (req.method === 'POST' && path === '/agent/ping') {
        // { wait: N } holds the answer up to N seconds (at most 50) until there is something for
        // the PC to do, such as going to sleep, so a tap in Telegram reaches it within seconds.
        // { refused: "why" } says the PC did not go to sleep when asked, and why.
        // { cardKey, card, cardDone } are about the card for paying from the app; app.js checks them.
        // { glasgowBook } (2.11.3, an object): its booker takes Book now at Glasgow Club; passed on as `book`.
        let wait = 0, refused = null, card = null, book = null;
        try {
          const b = JSON.parse(body || '{}');
          wait = Math.max(0, Math.min(MAX_WAIT_S, Number(b.wait) || 0));
          if (typeof b.refused === 'string' && b.refused.trim()) refused = b.refused.trim().slice(0, 200);
          if (b && typeof b === 'object') card = { key: b.cardKey, has: Object.prototype.hasOwnProperty.call(b, 'card'), kept: b.card, done: b.cardDone, auto: b.cardAuto, autoDone: b.autoDone };
          const gb = b && typeof b === 'object' ? b.glasgowBook : null;
          if (gb && typeof gb === 'object' && !Array.isArray(gb)) book = gb;
        } catch {}
        try { return ok(res, { ok: true, ...(await onPing(from, { wait, refused, card, book })) }); }
        catch (e) { return fail(res, 500, (e && e.message) || 'could not take the ping'); }
      }
      if (req.method === 'POST' && path === '/agent/look') {
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        try { return ok(res, { ok: true, ...(await onLook(raw)) }); }
        catch (e) {
          log(`Could not take a look from the PC: ${e.message}`);
          return fail(res, 500, 'could not take that');
        }
      }
      if (req.method === 'POST' && path === '/agent/hold') {
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        try { return ok(res, { ok: true, ...(await onHold(raw)) }); }
        catch (e) {
          log(`Could not take a note about a hold from the PC: ${e.message}`);
          return fail(res, 500, 'could not take that');
        }
      }
      if (req.method === 'POST' && (path === '/agent/clubspark/look' || path === '/agent/clubspark/book')) {
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        try { return ok(res, { ok: true, ...(await onClubSpark(path.slice('/agent/clubspark/'.length), raw)) }); }
        catch (e) {
          log(`Could not take a note about ClubSpark from the PC: ${e.message}`);
          return fail(res, 500, 'could not take that');
        }
      }
      if (req.method === 'POST' && path === '/agent/glasgow/book') {
        // A bot built without the handler says there is no such thing: never { ok: true }, which a
        // PC might read as more than it is. (index.js always gives it: serverFor.)
        if (typeof onGlasgowBook !== 'function') return fail(res, 404, 'no such thing here');
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        try { return ok(res, { ok: true, ...(await onGlasgowBook(raw)) }); }
        catch (e) {
          log(`Could not take a note about Book now at Glasgow Club from the PC: ${e.message}`);
          return fail(res, 500, 'could not take that');
        }
      }
      if (req.method === 'POST' && path === '/agent/progress') {
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        try {
          const r = await onProgress(raw);
          return r && r.ok ? ok(res, { ok: true }) : fail(res, 400, (r && r.why) || 'that did not make sense');
        } catch (e) {
          log(`Could not take a progress note: ${e.message}`);
          return fail(res, 500, 'could not take that');
        }
      }
      if (req.method === 'POST' && path === '/agent/result') {
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        try {
          const r = await onResult(raw);
          return r.ok ? ok(res, { ok: true }) : fail(res, 400, r.why);
        } catch (e) {
          log(`Could not take a result: ${e.message}`);
          return fail(res, 500, 'could not take that result');
        }
      }
      return fail(res, 404, 'no such thing here');
    });
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
  return server;
}

// The caller's address: Railway's edge puts it in X-Real-IP. Only ever read for requests the PC
// has signed, so nobody else can set where the wake-up goes.
function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (fwd) return fwd;
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

// A constant-time compare, so the token cannot be guessed a character at a time by timing.
function timingEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

module.exports = { createServer, timingEqual, signedText, readPublicKey, clientIp, MAX_AGE_MS };
