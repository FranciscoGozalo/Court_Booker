'use strict';
// The small HTTP endpoint your PC at home talks to. Built on Node's own http, no packages.
// Everything but /health needs the shared token.
//
//   GET  /health        a plain ok, for Railway and for the PC to check it is reachable
//   GET  /agent/jobs    what the PC should book now (also counts as the PC checking in)
//   POST /agent/result  what happened: { id, status: booked|none|failed, court, gate, why, date, start, end }
//
// The token (AGENT_TOKEN) is the only thing standing between this and the open internet, so set
// a long random one. No ClubSpark password and no Telegram token ever pass through here.

const http = require('http');

function createServer({ getJobs, onResult, token, log = () => {}, maxBody = 16 * 1024 }) {
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

    if (req.method === 'GET' && url === '/agent/jobs') {
      try { return ok(res, { ok: true, ...getJobs() }); }
      catch (e) { return fail(res, 500, (e && e.message) || 'could not work out the jobs'); }
    }
    if (req.method === 'POST' && url === '/agent/result') {
      let body = '', over = false;
      req.on('data', d => { body += d; if (body.length > maxBody) { over = true; req.destroy(); } });
      req.on('end', async () => {
        if (over) return;
        let raw; try { raw = JSON.parse(body); } catch { return fail(res, 400, 'that was not JSON'); }
        try {
          const r = await onResult(raw);
          return r.ok ? ok(res, { ok: true }) : fail(res, 400, r.why);
        } catch (e) {
          log(`Could not take a result: ${e.message}`);
          return fail(res, 500, 'could not take that result');
        }
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
