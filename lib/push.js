'use strict';
// Notifications to the iPhone app, by Expo's push service. Best effort: whatever goes wrong is
// said in the log and goes no further, so a notification can never hold up or break a message.
// What is sent is each note's title and body, to the push tokens the linked phones gave, and the
// odd quiet one that only wakes the app for its widgets (see messageFor).
// A push token is never written in the log: Expo's own words about one are masked first.

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const TIMEOUT_MS = 5000;

// Anything shaped like a push token, taken out of words that are about to be logged.
const mask = text => String(text ?? '').replace(/Expo(?:nent)?PushToken\[[^\]]*\]?/g, '[a push token]');

// One notification for one token, as Expo's push service takes it. `wake`: the notification also
// wakes the app on the iPhone in the background for a moment, so its Home Screen widgets catch up
// with the app closed: `_contentAvailable: true`, which Expo passes on to Apple as content-available.
// With a title and a body it is shown as ever, with its sound, and wakes the app besides. With
// neither it is a wake alone (a quiet one): shown nowhere, no sound, only `data`, and at normal
// priority, as Apple asks of a notification that only wakes an app (it may then hold it back while
// the phone saves power). One with no words that does not wake either is nothing: push sends none.
function messageFor(to, { title, body, data, wake }) {
  if (title || body) return { to, title, body, sound: 'default', ...(data ? { data } : {}), ...(wake ? { _contentAvailable: true } : {}) };
  return { to, ...(data ? { data } : {}), _contentAvailable: true, priority: 'normal' };
}

// Sends one notification to each token. Resolves to { unregistered: [tokens Expo says it no
// longer knows] }, so the caller can stop sending to them. It never rejects.
function createExpoPush({ fetchImpl = fetch, log = () => {}, url = EXPO_URL } = {}) {
  // `data` (2.10.4): what the app gets when the notification is tapped ({ ref }: the court it is about), or nothing.
  // `wake`: see messageFor.
  return async function push(tokens, { title, body, data = null, wake = false } = {}) {
    const unregistered = [];
    if (!Array.isArray(tokens) || !tokens.length || !(title || body || wake)) return { unregistered };
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(tokens.map(to => messageFor(to, { title, body, data, wake }))),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) { log(`Expo's push service did not take a notification (HTTP ${res.status}).`); return { unregistered }; }
      const answer = await res.json().catch(() => null);
      // One answer for each notification, in the order they were sent.
      const each = answer && Array.isArray(answer.data) ? answer.data : [];
      const refused = each.filter(d => d && d.status === 'error');
      each.forEach((d, i) => { if (d && d.status === 'error' && d.details && d.details.error === 'DeviceNotRegistered' && typeof tokens[i] === 'string') unregistered.push(tokens[i]); });
      if (refused.length) log(`Expo's push service refused ${refused.length} of ${tokens.length} notifications: ${mask(String(refused[0].message || 'no reason given')).slice(0, 200)}`);
    } catch (e) {
      log(`A notification could not be sent: ${mask((e && e.message) || e)}`);
    }
    return { unregistered };
  };
}

module.exports = { createExpoPush, mask, EXPO_URL, TIMEOUT_MS };
