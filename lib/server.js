'use strict';
// The small HTTP endpoint Railway exposes so the home server can do the ClubSpark reading.
// Built on Node's own http, no packages. Everything but /health needs the shared token.
//
//   GET  /health        a plain ok, for Railway and for the home server to check it is reachable
//   GET  /agent/plan    the current plan, so the home server knows which slot to read
//   POST /agent/result  a reading from the home server: { date, start, end, ok, courts, ... }
//
// The token (AGENT_TOKEN) is the only thing standing between this and the open internet, so set
// a long random one. The only data here is your court plan and the readings; no Telegram token,
// nothing about the booking itself.

const http = require('http');

function createServer({ relay, getPlan, token, log = () => {}, maxBody = 64 * 1024 }) {
  const ok = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const fail = (res, code, why) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, why })); };
  const authed = req => {
    const h = String(req.headers.authorization || '');
    const given = h.startsWith('Bearer ') ? h.slice(7) : h;
    return !!token && given.length === token.length && timingEqual(given, token);
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/health') return ok(res, { ok: true });
    if (!authed(req)) return fail(res, 401, 'who are you? set the same AGENT_TOKEN on both ends');

    if (req.method === 'GET' && url === '/agent/plan') {
      try { return ok(res, { ok: true, plan: getPlan() }); }
      catch (e) { return fail(res, 500, (e && e.message) || 'could not read the plan'); }
    }
    if (req.method === 'POST' && url === '/agent/result') {
      let body = '', over = false;
      req.on('data', d => { body += d; if (body.length > maxBody) { over = true; req.destroy(); } });
      req.on('end', () => {
        if (over) return;
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        const r = relay.put(raw);
        if (!r.ok) return fail(res, 400, r.why);
        return ok(res, { ok: true });
      });
      req.on('error', () => {});
      return;
    }
    return fail(res, 404, 'no such thing here');
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
  return server;
}

// A constant-time compare, so the token cannot be guessed a character at a time by timing.
function timingEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

module.exports = { createServer, timingEqual };
