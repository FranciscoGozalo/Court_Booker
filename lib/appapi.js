'use strict';
// The pure parts of the iPhone app's API (docs/app-api.md): pairing codes, the tokens a phone
// proves itself with, the list of linked phones, the notes, the fingerprint (etag) of the state,
// and what each request must look like. Nothing here talks to Telegram or to the network, and
// nothing here keeps a token: only its SHA-256.

const crypto = require('crypto');
const { hhmm, iso } = require('./time');
const { parseDay, parseOrder, parseSlot } = require('./plan');
const { civilOf } = require('./schedule');

const API = 1;
const MAX_DEVICES = 5;                      // phones linked at once
const PAIR_TTL_MS = 10 * 60 * 1000;         // a pairing code is good for this long...
const PAIR_TRIES = 5;                       // ...and for this many wrong tries
const PAIR_LIMIT = 10;                      // tries at pairing, whoever makes them...
const PAIR_WINDOW_MS = 10 * 60 * 1000;      // ...in any stretch this long
const SEEN_EVERY_MS = 60 * 1000;            // "last heard from" is noted at most this often
const MAX_BODY = 4 * 1024;                  // the largest request body, in bytes
const MAX_WAIT_S = 25;                      // the longest GET /app/state waits for a change
const MAX_WAITS = 4;                        // waits one phone may have open at once
const LOOKS_PER_MIN = 12;                   // looks the app may have read afresh, by the PC or the site...
const LOOKS_WINDOW_MS = 60 * 1000;          // ...in any stretch this long
const SHOWN_MS = 15 * 60 * 1000;            // how long a court the app was shown free may be held from the app
const NAME_MAX = 40;
const NOTES_KEEP = 30;
const NOTE_KINDS = ['booked', 'missed', 'warn', 'hold', 'info'];
const NOTE_TITLE_MAX = 120;
const NOTE_BODY_MAX = 600;

// ---------- words ----------
// A Telegram caption as plain text: the tags go, and &lt; &gt; &amp; are the characters again.
// What comes out is whole text (see `whole`), like everything else the app is told.
const plain = html => whole(String(html ?? '').replace(/<\/?[a-zA-Z][^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
// Text made whole: half an emoji left by a cut made elsewhere (a reason from the PC, cut to fit
// a Telegram message) becomes U+FFFD, so nothing the app is sent ends in half a character.
// And text cut to `max` characters, counted as code points and not as UTF-16 units, so that
// the cut never lands inside an emoji.
const REPLACEMENT = String.fromCharCode(0xFFFD);
const whole = s => String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT);
const cut = (s, max) => Array.from(whole(s)).slice(0, max).join('');

// ---------- tokens ----------
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
// What a phone is given once, when it pairs: 32 random bytes. Only the hash is kept.
function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
// Two short texts compared without giving away, by how long it takes, where they differ.
function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
// The linked phone a token belongs to, or null. Every phone is compared, in constant time.
function findDevice(devices, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const given = Buffer.from(hashToken(token), 'hex');
  let found = null;
  for (const d of devices || []) {
    const kept = Buffer.from(String((d && d.hash) || ''), 'hex');
    if (kept.length === given.length && crypto.timingSafeEqual(kept, given) && !found) found = d;
  }
  return found;
}

// ---------- the linked phones ----------
const cleanName = v => (typeof v === 'string' ? cut(v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), NAME_MAX).trim() : '') || 'iPhone';
// An Expo push token ("ExponentPushToken[...]"), or null.
const cleanPush = v => (typeof v === 'string' && /^Expo(nent)?PushToken\[[^[\]\s]{1,200}\]$/.test(v) ? v : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A phone that has just paired: what to keep of it, and the token to hand over once. `owner` is
// the Telegram chat it was linked for: a phone is only ever good for that chat's bot.
function newDevice(name, t, owner = null) {
  const { token, hash } = newToken();
  return { token, device: { id: crypto.randomBytes(4).toString('hex'), name: cleanName(name), hash, at: t, seenAt: t, push: null, owner } };
}
// The linked phones from storage, made safe to use: [{ id, name, hash, at, seenAt, push, owner }].
function cleanApps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw) {
    if (out.length >= MAX_DEVICES) break;
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !/^[0-9a-f]{8}$/.test(d.id)) continue;
    if (typeof d.hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hash)) continue;
    if (out.some(o => o.id === d.id || o.hash === d.hash)) continue;
    const at = num(d.at) ?? 0;
    out.push({ id: d.id, name: cleanName(d.name), hash: d.hash, at, seenAt: num(d.seenAt) ?? at, push: cleanPush(d.push), owner: Number.isSafeInteger(d.owner) ? d.owner : null });
  }
  return out;
}

// ---------- pairing ----------
// One code at a time: six digits, good for ten minutes and for one use. Five wrong tries cancel it.
function createPairing({ ttlMs = PAIR_TTL_MS, tries = PAIR_TRIES, random = () => crypto.randomInt(0, 1000000) } = {}) {
  let cur = null;                              // { code, until, left }
  return {
    issue(t) {
      cur = { code: String(random()).padStart(6, '0'), until: t + ttlMs, left: tries };
      return { code: cur.code, until: cur.until };
    },
    // How a try stands: { why: null, left } when the code is right (it is then still waiting:
    // `use` spends it), or { why: 'none' | 'expired' | 'wrong', left } with the tries left on it.
    check(given, t) {
      if (!cur) return { why: 'none', left: 0 };
      if (t >= cur.until) return { why: 'expired', left: 0 };
      const text = typeof given === 'number' && Number.isInteger(given) && given >= 0 ? String(given).padStart(6, '0')
        : typeof given === 'string' ? given.replace(/\s+/g, '') : '';
      if (sameText(text, cur.code)) return { why: null, left: cur.left };
      const left = --cur.left;
      if (left <= 0) cur = null;
      return { why: 'wrong', left: Math.max(0, left) };
    },
    use() { cur = null; },
    cancel() { cur = null; },
    waiting: t => !!cur && t < cur.until,
  };
}
// At most `max` tries in any `windowMs`, whoever they come from. A try that is turned away is
// not counted, so the way back in opens ten minutes after the first of the ten.
function createLimiter(max = PAIR_LIMIT, windowMs = PAIR_WINDOW_MS) {
  let tries = [];
  return {
    allow(t) {
      tries = tries.filter(at => t - at < windowMs);
      if (tries.length >= max) return false;
      tries.push(t);
      return true;
    },
  };
}

// ---------- notes ----------
// What the bot told you unprompted, kept for the app: { id, at, kind, title, body }.
function makeNote(kind, title, body, t) {
  return {
    id: crypto.randomBytes(5).toString('hex'), at: t, kind: NOTE_KINDS.includes(kind) ? kind : 'info',
    title: cut(String(title ?? '').replace(/\s+/g, ' ').trim(), NOTE_TITLE_MAX),
    body: cut(String(body ?? '').replace(/\s+/g, ' ').trim(), NOTE_BODY_MAX),
  };
}
// The notes from storage, made safe to use: the newest first, the last 30.
function cleanNotes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const n of raw) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !/^[0-9a-f]{6,20}$/.test(n.id)) continue;
    if (num(n.at) === null || !NOTE_KINDS.includes(n.kind) || typeof n.title !== 'string' || typeof n.body !== 'string') continue;
    if (out.some(o => o.id === n.id)) continue;
    out.push({ id: n.id, at: n.at, kind: n.kind, title: cut(n.title, NOTE_TITLE_MAX), body: cut(n.body, NOTE_BODY_MAX) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, NOTES_KEEP);
}

// ---------- the state's fingerprint ----------
// A hash of the state without `now`, so it changes only when something the app shows does.
function etagOf(state) {
  const rest = { ...state };
  delete rest.now;
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

// How long GET /app/state may wait for a change, from its ?wait= (seconds): at most 25, in ms.
const waitMs = v => Math.max(0, Math.min(MAX_WAIT_S, Number(v) || 0)) * 1000;

// ---------- what each request must look like ----------
// Each takes the request's body and returns what it asks for, or { why } with a plain sentence.
// Whether the thing can be done now is not decided here: app.js does that, with the same checks
// the Telegram commands make.
const isObj = b => !!b && typeof b === 'object' && !Array.isArray(b);
const int = (v, lo, hi) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const dateShape = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
// A date that is on the calendar ("2026-11-31" is not).
const realDate = v => (dateShape(v) && iso(civilOf(v)) === v ? v : null);
const WHY = {
  body: 'The request body must be a JSON object.',
  once: 'A one-off booking needs a date (YYYY-MM-DD), a start in minutes after midnight, and hours (1 or 2).',
  onceRemove: 'To remove a one-off booking, send its date (YYYY-MM-DD) and its start in minutes after midnight.',
  plan: 'A weekly booking needs a day (mon to sun), a start in minutes after midnight, and hours (1 or 2).',
  planRemove: 'To stop a weekly booking, send its day (mon to sun, or all).',
  order: 'Courts 1 to 6, each once.',
  pause: 'Send paused as true or false.',
  centre: 'There is no such centre: send g for Gorbals or s for Scotstoun.',
  look: 'A look needs a centre (g or s) and a date (YYYY-MM-DD).',
  hold: 'A hold needs a centre (g or s), a date (YYYY-MM-DD), a start in minutes after midnight, and a court number.',
  holdOrder: 'To act on a hold, send its id and what to do: release or done.',
  push: 'That is not an Expo push token. Send one, or null to stop notifications.',
};
// The slot rules /set and /book apply, with their sentences (lib/plan.js).
function slotOf(start, hours, fallback) {
  const slot = parseSlot([hhmm(start), `${hours}h`]);
  return 'start' in slot ? { start: slot.start, hours: slot.hours } : { why: slot.why || fallback };
}
function readOnce(b) {
  if (!isObj(b)) return { why: WHY.body };
  const date = realDate(b.date), start = int(b.start, 0, 1439);
  if (!date || start === null || (b.hours !== 1 && b.hours !== 2)) return { why: WHY.once };
  const slot = slotOf(start, b.hours, WHY.once);
  return slot.why ? slot : { date, ...slot };
}
function readOnceRemove(b) {
  if (!isObj(b)) return { why: WHY.body };
  const date = dateShape(b.date), start = int(b.start, 0, 1439);
  return !date || start === null ? { why: WHY.onceRemove } : { date, start };
}
function readPlan(b) {
  if (!isObj(b)) return { why: WHY.body };
  const day = typeof b.day === 'string' ? parseDay(b.day) : null, start = int(b.start, 0, 1439);
  if (!day || start === null || (b.hours !== 1 && b.hours !== 2)) return { why: WHY.plan };
  const slot = slotOf(start, b.hours, WHY.plan);
  return slot.why ? slot : { day, ...slot };
}
function readPlanRemove(b) {
  if (!isObj(b)) return { why: WHY.body };
  const text = typeof b.day === 'string' ? b.day.trim().toLowerCase() : '';
  const day = text === 'all' ? 'all' : parseDay(text);
  return day ? { day } : { why: WHY.planRemove };
}
function readOrder(b) {
  if (!isObj(b)) return { why: WHY.body };
  const o = b.order;
  if (!Array.isArray(o) || o.length < 1 || o.length > 6 || !o.every(n => int(n, 1, 6) !== null)) return { why: WHY.order };
  const order = parseOrder(o.join(' '));              // as /order reads it: each once; any left out go last
  return order ? { order } : { why: WHY.order };
}
function readPause(b) {
  if (!isObj(b)) return { why: WHY.body };
  return typeof b.paused === 'boolean' ? { paused: b.paused } : { why: WHY.pause };
}
function readLook(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (b.centre !== 'g' && b.centre !== 's') return { why: typeof b.centre === 'string' ? WHY.centre : WHY.look };
  const date = dateShape(b.date);
  return date ? { centre: b.centre, date, fresh: b.fresh === true } : { why: WHY.look };
}
function readHold(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (b.centre !== 'g' && b.centre !== 's') return { why: typeof b.centre === 'string' ? WHY.centre : WHY.hold };
  // Only the shapes are checked here; which times and courts are on offer is the bot's to say.
  const date = dateShape(b.date);
  return !date || !Number.isInteger(b.start) || !Number.isInteger(b.court) ? { why: WHY.hold } : { centre: b.centre, date, start: b.start, court: b.court };
}
function readHoldOrder(b) {
  if (!isObj(b)) return { why: WHY.body };
  const ok = typeof b.id === 'string' && /^[0-9a-f]{12}$/.test(b.id) && (b.what === 'release' || b.what === 'done');
  return ok ? { id: b.id, what: b.what } : { why: WHY.holdOrder };
}
function readPush(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (b.token === null) return { token: null };
  const token = cleanPush(b.token);
  return token ? { token } : { why: WHY.push };
}

module.exports = {
  API, MAX_DEVICES, PAIR_TTL_MS, PAIR_TRIES, PAIR_LIMIT, PAIR_WINDOW_MS, SEEN_EVERY_MS, MAX_BODY, MAX_WAIT_S, MAX_WAITS,
  LOOKS_PER_MIN, LOOKS_WINDOW_MS, SHOWN_MS, NAME_MAX, NOTES_KEEP, NOTE_KINDS, NOTE_TITLE_MAX, NOTE_BODY_MAX, WHY,
  plain, whole, cut, hashToken, newToken, sameText, findDevice, cleanName, cleanPush, newDevice, cleanApps,
  createPairing, createLimiter, makeNote, cleanNotes, etagOf, waitMs,
  readOnce, readOnceRemove, readPlan, readPlanRemove, readOrder, readPause, readLook, readHold, readHoldOrder, readPush,
};
