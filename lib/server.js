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
//                       it adds ?run=0 (only looking: node book.js --jobs). The signature covers
//                       the path without the query.
//   POST /agent/ping    the PC is awake (sent every minute while it is on); also where home is,
//                       for waking it (the address the request came from). With { wait: N } the
//                       answer waits up to N s for an instruction: { sleep: true } puts the PC to sleep;
//                       { look: { id, key, date } } has it read one day of Glasgow Club's indoor sheet
//   POST /agent/look    the PC's answer to a look: { id, ok: true, sheet } with the day's sheet as the
//                       site sent it, in short form, or { id, ok: false, kind, why }
//   POST /agent/progress  how the run is going, before a result: { stage: "ready" } once it has
//                       signed in to ClubSpark, or { stage: "trouble", why, attempt, of } when an
//                       attempt failed and it is trying again
//   POST /agent/result  what happened: { id, status: booked|none|failed, court, gate, why, date, start, end }
//
// Open to anyone, for Telegram's link previews (the wide banner trial): nothing but the pictures.
//   GET  /banner/<kind>.jpg   one of the banner pictures
//   GET  /card/<kind>         a bare page whose preview is that picture
//
// No ClubSpark password and no Telegram token ever pass through here.

const http = require('http');
const crypto = require('crypto');

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
function createServer({ getJobs, onResult, onPing = () => ({ ok: true }), onProgress = async () => ({ ok: true }), onLook = () => ({ ok: true }), picture = () => null, token = '', publicKey = null, log = () => {}, maxBody = 64 * 1024, now = Date.now }) {
  const ok = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const fail = (res, code, why) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, why })); };
  const used = new Map();   // signatures already accepted -> when to forget them

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

  const server = http.createServer((req, res) => {
    const [path, query = ''] = (req.url || '').split('?');
    if (req.method === 'GET' && path === '/health') return ok(res, { ok: true });
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
        try { return ok(res, { ok: true, ...getJobs(from, { run }) }); }
        catch (e) { return fail(res, 500, (e && e.message) || 'could not work out the jobs'); }
      }
      if (req.method === 'POST' && path === '/agent/ping') {
        // { wait: N } holds the answer up to N seconds (at most 50) until there is something for
        // the PC to do, such as going to sleep, so a tap in Telegram reaches it within seconds.
        // { refused: "why" } says the PC did not go to sleep when asked, and why.
        let wait = 0, refused = null;
        try {
          const b = JSON.parse(body || '{}');
          wait = Math.max(0, Math.min(MAX_WAIT_S, Number(b.wait) || 0));
          if (typeof b.refused === 'string' && b.refused.trim()) refused = b.refused.trim().slice(0, 200);
        } catch {}
        try { return ok(res, { ok: true, ...(await onPing(from, { wait, refused })) }); }
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
