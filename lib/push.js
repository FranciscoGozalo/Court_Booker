'use strict';
// Notifications to the iPhone app, by Expo's push service. Best effort: whatever goes wrong is
// said in the log and goes no further, so a notification can never hold up or break a message.
// What is sent is each note's title and body, to the push tokens the linked phones gave.

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const TIMEOUT_MS = 5000;

function createExpoPush({ fetchImpl = fetch, log = () => {}, url = EXPO_URL } = {}) {
  return async function push(tokens, { title, body } = {}) {
    if (!Array.isArray(tokens) || !tokens.length) return;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(tokens.map(to => ({ to, title, body, sound: 'default' }))),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) { log(`Expo's push service did not take a notification (HTTP ${res.status}).`); return; }
      const answer = await res.json().catch(() => null);
      const refused = answer && Array.isArray(answer.data) ? answer.data.filter(d => d && d.status === 'error') : [];
      if (refused.length) log(`Expo's push service refused ${refused.length} of ${tokens.length} notifications: ${String(refused[0].message || 'no reason given').slice(0, 200)}`);
    } catch (e) {
      log(`A notification could not be sent: ${(e && e.message) || e}`);
    }
  };
}

module.exports = { createExpoPush, EXPO_URL, TIMEOUT_MS };
