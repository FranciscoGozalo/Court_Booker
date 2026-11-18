'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegram } = require('../lib/telegram');

// A stand-in for fetch that records what was asked and answers like Telegram.
function fakeFetch(reply, { date, takeMs = 0, clock } = {}) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, headers: init.headers, method: init.method });
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
  assert.deepEqual(f.seen[2].body, { offset: 5, timeout: 50, allowed_updates: ['message', 'callback_query'] });
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

test('a picture already known to Telegram is sent and swapped by name, as plain JSON', async () => {
  const f = fakeFetch({ body: { ok: true, result: { message_id: 9, photo: [{ file_id: 'small' }, { file_id: 'big' }] } } });
  const tg = createTelegram('T', { fetchImpl: f });
  const markup = { inline_keyboard: [[{ text: 'Court 1', url: 'https://clubspark.lta.org.uk/x' }]] };
  const sent = await tg.sendPhoto(42, 'FILE123', { caption: '<b>Hi</b>', parse_mode: 'HTML', reply_markup: markup });
  assert.equal(sent.photo[1].file_id, 'big');
  assert.equal(f.seen[0].url, 'https://api.telegram.org/botT/sendPhoto');
  assert.deepEqual(f.seen[0].body, { chat_id: 42, photo: 'FILE123', caption: '<b>Hi</b>', parse_mode: 'HTML', reply_markup: markup });
  await tg.editCaption(42, 9, 'GO', { parse_mode: 'HTML', reply_markup: markup });
  assert.equal(f.seen[1].url, 'https://api.telegram.org/botT/editMessageCaption');
  assert.deepEqual(f.seen[1].body, { chat_id: 42, message_id: 9, caption: 'GO', parse_mode: 'HTML', reply_markup: markup });
  await tg.editMedia(42, 9, 'FILE456', { caption: 'GO', parse_mode: 'HTML', reply_markup: markup });
  assert.equal(f.seen[2].url, 'https://api.telegram.org/botT/editMessageMedia');
  assert.deepEqual(f.seen[2].body, { chat_id: 42, message_id: 9, media: { type: 'photo', media: 'FILE456', caption: 'GO', parse_mode: 'HTML' }, reply_markup: markup });
});

test('a new picture is uploaded as a file alongside the same fields', async () => {
  const f = fakeFetch({ body: { ok: true, result: { message_id: 9, photo: [{ file_id: 'big' }] } } });
  const tg = createTelegram('T', { fetchImpl: f });
  const markup = { inline_keyboard: [[{ text: 'Court 1', url: 'https://clubspark.lta.org.uk/x' }]] };
  const file = { buf: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]), name: 'banner-wait.jpg' };

  await tg.sendPhoto(42, file, { caption: '<b>Hi</b>', parse_mode: 'HTML', reply_markup: markup });
  let form = f.seen[0].body;
  assert.ok(form instanceof FormData);
  assert.equal(f.seen[0].headers, undefined);                            // fetch writes the multipart header itself
  assert.deepEqual([...form.keys()].sort(), ['caption', 'chat_id', 'parse_mode', 'photo', 'reply_markup']);
  assert.deepEqual([form.get('chat_id'), form.get('caption'), form.get('parse_mode')], ['42', '<b>Hi</b>', 'HTML']);
  assert.deepEqual(JSON.parse(form.get('reply_markup')), markup);
  assert.equal(form.get('photo').name, 'banner-wait.jpg');
  assert.equal(form.get('photo').type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await form.get('photo').arrayBuffer())], [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);

  await tg.editMedia(42, 9, file, { caption: 'GO', parse_mode: 'HTML', reply_markup: markup });
  form = f.seen[1].body;
  assert.equal(f.seen[1].url, 'https://api.telegram.org/botT/editMessageMedia');
  assert.deepEqual([...form.keys()].sort(), ['chat_id', 'media', 'message_id', 'pic', 'reply_markup']);
  assert.deepEqual(JSON.parse(form.get('media')), { type: 'photo', media: 'attach://pic', caption: 'GO', parse_mode: 'HTML' });
  assert.equal(form.get('message_id'), '9');
  assert.equal(form.get('pic').name, 'banner-wait.jpg');
});

test('a refused picture comes back as an ordinary error with Telegram\'s code', async () => {
  const tg = createTelegram('T', { fetchImpl: fakeFetch({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' } }) });
  await assert.rejects(tg.sendPhoto(1, { buf: Buffer.from('x'), name: 'a.jpg' }, {}), e => e.code === 400 && /PHOTO_INVALID/.test(e.message));
  await assert.rejects(tg.editMedia(1, 2, 'ID', {}), e => e.code === 400);
});

