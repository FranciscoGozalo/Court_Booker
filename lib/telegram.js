'use strict';
// A small Telegram Bot API client on Node's built-in fetch. No packages.

function createTelegram(token, { fetchImpl = fetch, clock = Date.now, apiUrl = 'https://api.telegram.org' } = {}) {
  const base = `${String(apiUrl).replace(/\/+$/, '')}/bot${token}/`;
  const skews = [];   // our clock minus Telegram's, from the Date header on each reply

  async function request(method, init, timeoutMs) {
    const started = clock();
    const res = await fetchImpl(base + method, { method: 'POST', ...init, signal: AbortSignal.timeout(timeoutMs) });
    const server = Date.parse(res.headers.get('date') || '');
    // The header is cut to whole seconds, so the true server time is about half a second later.
    // Long polls sit open for up to a minute, so only quick replies are used for this.
    if (!Number.isNaN(server) && clock() - started < 2000) {
      skews.push((started + clock()) / 2 - (server + 500));
      if (skews.length > 15) skews.shift();
    }
    const body = await res.json().catch(() => null);
    if (!body || !body.ok) {
      const err = new Error((body && body.description) || `HTTP ${res.status}`);
      err.code = (body && body.error_code) || res.status;
      err.retryAfter = body && body.parameters && body.parameters.retry_after;
      throw err;
    }
    return body.result;
  }

  const call = (method, params = {}, timeoutMs = 15000) =>
    request(method, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }, timeoutMs);

  // The same call with a file attached. `files` maps a field name to { buf, name }.
  function callWithFiles(method, params, files, timeoutMs = 20000) {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const [key, file] of Object.entries(files)) form.append(key, new Blob([file.buf], { type: 'image/jpeg' }), file.name);
    return request(method, { body: form }, timeoutMs);
  }

  // A picture is either the id Telegram gave it when it was first sent (a string), or the file itself.
  const isId = photo => typeof photo === 'string';

  return {
    call,
    // Short time limits here: on the night it is better to give up and try again than to hang.
    send: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, ...extra }, 7000),
    edit: (chatId, messageId, text, extra = {}) => call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }, 7000),
    // extra: { caption, parse_mode, reply_markup }
    sendPhoto: (chatId, photo, extra = {}) => (isId(photo)
      ? call('sendPhoto', { chat_id: chatId, photo, ...extra }, 7000)
      : callWithFiles('sendPhoto', { chat_id: chatId, ...extra }, { photo })),
    editCaption: (chatId, messageId, caption, extra = {}) => call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, ...extra }, 7000),
    // Swaps a message's picture, keeping (or changing) its caption and buttons in the same step.
    editMedia(chatId, messageId, photo, extra = {}) {
      const { caption, parse_mode, reply_markup } = extra;
      const media = { type: 'photo', media: isId(photo) ? photo : 'attach://pic', caption, parse_mode };
      const params = { chat_id: chatId, message_id: messageId, media, reply_markup };
      return isId(photo) ? call('editMessageMedia', params, 7000) : callWithFiles('editMessageMedia', params, { pic: photo });
    },
    getUpdates: (offset, timeoutSec) => call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 15) * 1000),
    // Every button tap must be answered, or the button keeps spinning. `text` shows briefly.
    answer: (callbackId, text) => call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }, 7000),
    // Middle value of the recent measurements, or null before the first one.
    skewMs() {
      if (!skews.length) return null;
      const sorted = [...skews].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },
  };
}

module.exports = { createTelegram };
