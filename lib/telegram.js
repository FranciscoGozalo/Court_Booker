'use strict';
// A small Telegram Bot API client on Node's built-in fetch. No packages.

function createTelegram(token, { fetchImpl = fetch, clock = Date.now, apiUrl = 'https://api.telegram.org' } = {}) {
  const base = `${String(apiUrl).replace(/\/+$/, '')}/bot${token}/`;
  const skews = [];   // our clock minus Telegram's, from the Date header on each reply

  async function call(method, params = {}, timeoutMs = 15000) {
    const started = clock();
    const res = await fetchImpl(base + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
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

  return {
    call,
    // Short time limits here: on the night it is better to give up and try again than to hang.
    send: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, ...extra }, 7000),
    edit: (chatId, messageId, text, extra = {}) => call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }, 7000),
    getUpdates: (offset, timeoutSec) => call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 15) * 1000),
    // Middle value of the recent measurements, or null before the first one.
    skewMs() {
      if (!skews.length) return null;
      const sorted = [...skews].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },
  };
}

module.exports = { createTelegram };
