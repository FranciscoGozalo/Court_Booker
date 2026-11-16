'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegram } = require('../lib/telegram');

// A stand-in for fetch that records what was asked and answers like Telegram.
function fakeFetch(reply, { date, takeMs = 0, clock } = {}) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers, method: init.method });
    if (clock) clock.t += takeMs;
    const r = typeof reply === 'function' ? reply(seen.length) : reply;
    return { status: r.status || 200, headers: { get: h => (h.toLowerCase() === 'date' ? (date ? date() : null) : null) }, json: async () => { if (r.raw) throw new Error('not json'); return r.body; } };
  };
  f.seen = seen;
  return f;
}

test('sends the right request and returns the result', async () => {
  const f = fakeFetch({ body: { ok: true, result: { message_id: 7 } } });
  const tg = createTelegram('123:ABC', { fetchImpl: f });
  const got = await tg.send(42, 'hello', { parse_mode: 'HTML' });
  assert.deepEqual(got, { message_id: 7 });
  assert.equal(f.seen[0].url, 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.equal(f.seen[0].method, 'POST');
  assert.deepEqual(f.seen[0].body, { chat_id: 42, text: 'hello', parse_mode: 'HTML' });
  await tg.edit(42, 7, 'changed');
  assert.equal(f.seen[1].url, 'https://api.telegram.org/bot123:ABC/editMessageText');
  assert.deepEqual(f.seen[1].body, { chat_id: 42, message_id: 7, text: 'changed' });
  await tg.getUpdates(5, 50);
  assert.deepEqual(f.seen[2].body, { offset: 5, timeout: 50, allowed_updates: ['message'] });
});

test('only ever talks to the Telegram address it was given', async () => {
  const f = fakeFetch({ body: { ok: true, result: true } });
  const tg = createTelegram('T', { fetchImpl: f, apiUrl: 'http://127.0.0.1:9999/' });
  await tg.call('getMe');
  assert.equal(f.seen[0].url, 'http://127.0.0.1:9999/botT/getMe');
});

test('errors carry Telegram\'s code, words and any wait it asks for', async () => {
  let tg = createTelegram('T', { fetchImpl: fakeFetch({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } } }) });
  await assert.rejects(tg.send(1, 'x'), e => e.code === 429 && e.retryAfter === 3 && /Too Many/.test(e.message));
  tg = createTelegram('T', { fetchImpl: fakeFetch({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' } }) });
  await assert.rejects(tg.edit(1, 2, 'x'), e => e.code === 400);
  tg = createTelegram('T', { fetchImpl: fakeFetch({ status: 502, raw: true }) });
  await assert.rejects(tg.send(1, 'x'), e => e.code === 502 && e.message === 'HTTP 502');
  tg = createTelegram('T', { fetchImpl: async () => { throw new Error('socket hang up'); } });
  await assert.rejects(tg.send(1, 'x'), /socket hang up/);
});

test('measures this server\'s clock against Telegram\'s', async () => {
  const clock = { t: Date.parse('2026-11-19T21:00:00.400Z') };
  // Telegram's clock reads exactly 3 s behind ours; its Date header is cut to whole seconds.
  const date = () => new Date(Math.floor((clock.t - 3000) / 1000) * 1000).toUTCString();
  const tg = createTelegram('T', { fetchImpl: fakeFetch({ body: { ok: true, result: true } }, { date, takeMs: 80, clock }), clock: () => clock.t });
  assert.equal(tg.skewMs(), null);
  for (let i = 0; i < 9; i++) { await tg.call('getMe'); clock.t += 137; }
  assert.ok(Math.abs(tg.skewMs() - 3000) <= 600, `measured ${tg.skewMs()}`);
});

test('slow replies (long polls) are left out of the clock check', async () => {
  const clock = { t: Date.parse('2026-11-19T21:00:00Z') };
  const tg = createTelegram('T', { fetchImpl: fakeFetch({ body: { ok: true, result: [] } }, { date: () => new Date(clock.t).toUTCString(), takeMs: 50000, clock }), clock: () => clock.t });
  await tg.getUpdates(0, 50);
  assert.equal(tg.skewMs(), null);
});
