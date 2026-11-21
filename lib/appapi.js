'use strict';
// The pure parts of the iPhone app's API (docs/app-api.md): pairing codes, the tokens a phone
// proves itself with, the list of linked phones, the notes, the fingerprint (etag) of the state,
// and what each request must look like. Nothing here talks to Telegram or to the network, and
// nothing here keeps a token: only its SHA-256. A sealed box (a card, or a card's security code,
// sealed by the app for your PC's key) is only ever looked at for its size and shape here: the
// bot has no key to open it with.

const crypto = require('crypto');
const { hhmm, iso } = require('./time');
const { parseDay, parseOrder, parseSlot } = require('./plan');
const P = require('./plan');
const { civilOf } = require('./schedule');
const { CENTRES } = require('./glasgowclub');
const V = require('./venues');

const API = 3;                              // 3 (version 2.10): weekly bookings and one-offs at any venue, and automatic payments; 2 (2.9): the card and Pay, and the parks on ClubSpark (docs/app-api.md says what else changed)
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
// A sealed box from the app: standard base64 of the sender's one-off public key (32 bytes), a
// nonce (24) and nacl.box's ciphertext (what was sealed, plus 16 bytes of its own).
const SEALED_MAX = 1024;                    // at most this many base64 characters
const SEALED_MIN = 32 + 24 + 16 + 2;        // and at least a key, a nonce, the box's 16 bytes and "{}"
// What the PC may call the card it keeps.
const CARD_BRANDS = ['Visa', 'Mastercard', 'American Express', 'Maestro', 'Discover', 'Diners Club', 'JCB', 'Card'];

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
// What a note is about (2.10.4): a result's id ("2026-11-24@16:00", "scotstoun/2026-11-25@18:00"), so the app can open
// that court (or that date) when the note, or its notification, is tapped. Null for anything else.
const NOTE_REF = /^(?:[a-z]{3,20}\/)?\d{4}-\d{2}-\d{2}@\d{2}:\d{2}$/;
const refOf = ref => (typeof ref === 'string' && NOTE_REF.test(ref) ? ref : null);
function makeNote(kind, title, body, t, ref = null) {
  return {
    id: crypto.randomBytes(5).toString('hex'), at: t, kind: NOTE_KINDS.includes(kind) ? kind : 'info',
    title: cut(String(title ?? '').replace(/\s+/g, ' ').trim(), NOTE_TITLE_MAX),
    body: cut(String(body ?? '').replace(/\s+/g, ' ').trim(), NOTE_BODY_MAX),
    ref: refOf(ref),
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
    out.push({ id: n.id, at: n.at, kind: n.kind, title: cut(n.title, NOTE_TITLE_MAX), body: cut(n.body, NOTE_BODY_MAX), ref: refOf(n.ref) });
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
  centre: 'There is no such centre: send g for Gorbals, s for Scotstoun (indoor) or o for Scotstoun outdoor.',
  look: 'A look needs a centre (g, s or o) and a date (YYYY-MM-DD).',
  hold: 'A hold needs a centre (g, s or o), a date (YYYY-MM-DD), a start in minutes after midnight, and a court number.',
  holdOrder: 'To act on a hold, send its id and what to do: release, done or pay.',
  pay: 'To pay, send the hold\'s id, what: "pay", the amount you confirmed (such as "£23.00") and the sealed security code.',
  card: 'To keep a card on your PC, send it sealed for your PC\'s card key: { sealed }.',
  sealed: 'That is not a sealed box I can pass on: it must be standard base64, at most 1024 characters, of a key, a nonce and the box.',
  push: 'That is not an Expo push token. Send one, or null to stop notifications.',
  scheduled: 'This sets Kelvingrove\'s weekly time, as /set does. Add a weekly booking at another venue to the weekly list.',
  weekly: 'A weekly booking needs a venue, a day (mon to sun), a start in minutes after midnight, and hours (1 or 2).',
  weeklyId: 'To change or remove a weekly booking, send its id.',
  weeklyOn: 'To switch a weekly booking on or off, send its id and on (true or false).',
  venue: 'There is no such venue: send one of the keys in state.venues.',
  types: 'Scotstoun has indoor and outdoor courts: send type, indoor or outdoor.',
  clubHours: 'Glasgow Club courts are booked an hour at a time.',
  outdoorHours: 'Scotstoun\'s outdoor courts are open from 08:00 to 18:00.',
  onHour: 'Slots start on the hour. Try a time like 19:00.',
  auto: 'To turn automatic payments on, send the card\'s security code sealed for your PC\'s card key: { sealed }.',
  auth: 'auth, when sent, must be the 32 lowercase hex characters the app makes with the card\'s pay key.',
  authItems: 'To sign bookings, send items: [{ id, auth }], one to 30 of them, each a weekly booking\'s or a one-off date\'s id and its 32 hex characters.',
};
// A request's `auth` (2.10.1), when it has one: { auth } (null when it sends none) or { why }.
// It is kept with the entry and handed to your PC, never shown or written to the log.
function readAuth(b) {
  if (b.auth === undefined || b.auth === null) return { auth: null };
  return P.authOf(b.auth) ? { auth: b.auth } : { why: WHY.auth };
}
// /app/plan is Kelvingrove's alone, as /set is (lib/venues.js): a `venue` other than that is
// refused, never ignored. Every other request names its venue (2.10).
const otherPark = b => b.venue !== undefined && b.venue !== 'kelvingrove';
// The venue and court type a request names: { venue, type } or { why }. No venue: Kelvingrove (as
// before 2.10). No type: the venue's only one; Scotstoun, which has two, must say which.
function placeOf(b, { venueNeeded = false } = {}) {
  if (b.venue === undefined && !venueNeeded) return { venue: V.SCHEDULED, type: 'outdoor' };
  const venue = typeof b.venue === 'string' ? b.venue : null;
  if (!venue || !V.isVenue(venue)) return { why: venue === null && venueNeeded ? WHY.weekly : WHY.venue };
  const types = V.typesOf(venue);
  if (b.type === undefined) return types.length === 1 ? { venue, type: types[0] } : { why: WHY.types };
  if (!types.includes(b.type)) return { why: `${V.venueName(venue)} has ${types.join(' and ')} courts only.` };
  return { venue, type: b.type };
}
// What a venue and type allow of a slot: Glasgow Club's an hour on the hour, Scotstoun's outdoor
// courts 08:00 to 18:00. The sentence, or null.
function slotAt(place, start, hours) {
  if (!V.clubOf(place.venue)) return null;
  if (hours !== 1) return WHY.clubHours;
  if (start % 60 !== 0) return WHY.onHour;
  if (place.venue === 'scotstoun' && place.type === 'outdoor' && (start < 8 * 60 || start > 17 * 60)) return WHY.outdoorHours;
  return null;
}
// The slot rules /set and /book apply, with their sentences (lib/plan.js).
function slotOf(start, hours, fallback) {
  const slot = parseSlot([hhmm(start), `${hours}h`]);
  return 'start' in slot ? { start: slot.start, hours: slot.hours } : { why: slot.why || fallback };
}
// A one-off at any venue (2.10): Kelvingrove when no venue is named, as before.
function readOnce(b) {
  if (!isObj(b)) return { why: WHY.body };
  const date = realDate(b.date), start = int(b.start, 0, 1439);
  if (!date || start === null || (b.hours !== 1 && b.hours !== 2)) return { why: WHY.once };
  const place = placeOf(b);
  if (place.why) return place;
  const slot = slotOf(start, b.hours, WHY.once);
  if (slot.why) return slot;
  const why = slotAt(place, slot.start, slot.hours);
  if (why) return { why };
  const a = readAuth(b);
  if (a.why) return a;
  return { date, ...slot, ...(place.venue === V.SCHEDULED ? {} : place), ...(a.auth ? { auth: a.auth } : {}) };       // Kelvingrove's as before 2.10
}
function readOnceRemove(b) {
  if (!isObj(b)) return { why: WHY.body };
  const date = dateShape(b.date), start = int(b.start, 0, 1439);
  if (!date || start === null) return { why: WHY.onceRemove };
  if (b.venue !== undefined && !V.isVenue(b.venue)) return { why: WHY.venue };
  return b.venue === undefined || b.venue === V.SCHEDULED ? { date, start } : { date, start, venue: b.venue };
}
// POST /app/weekly { venue, type, day, start, hours, on }: a weekly booking at any venue.
function readWeekly(b) {
  if (!isObj(b)) return { why: WHY.body };
  const day = typeof b.day === 'string' ? parseDay(b.day) : null, start = int(b.start, 0, 1439);
  if (b.venue === undefined || !day || start === null || (b.hours !== 1 && b.hours !== 2)) return { why: WHY.weekly };
  if (b.on !== undefined && typeof b.on !== 'boolean') return { why: WHY.weekly };
  const place = placeOf(b, { venueNeeded: true });
  if (place.why) return place;
  const slot = slotOf(start, b.hours, WHY.weekly);
  if (slot.why) return slot;
  const why = slotAt(place, slot.start, slot.hours);
  if (why) return { why };
  const a = readAuth(b);
  if (a.why) return a;
  return { ...place, day, ...slot, on: b.on !== false, ...(a.auth ? { auth: a.auth } : {}) };
}
const weeklyId = v => (typeof v === 'string' && /^[0-9a-f]{8}$/.test(v) ? v : null);
// POST /app/weekly/change { id, venue?, type?, day?, start?, hours? }: what is to change; the
// entry as it will be is checked whole (readWeekly) by the caller, with the entry it changes.
function readWeeklyChange(b) {
  if (!isObj(b)) return { why: WHY.body };
  const id = weeklyId(b.id);
  if (!id) return { why: WHY.weeklyId };
  const fields = {};
  for (const k of ['venue', 'type', 'day', 'start', 'hours']) if (b[k] !== undefined) fields[k] = b[k];
  const a = readAuth(b);
  if (a.why) return a;
  return { id, fields, ...(a.auth ? { auth: a.auth } : {}) };
}
// POST /app/weekly/auth { items: [{ id, auth }] } (2.10.1): signatures made afresh (a new card, or
// automatic payments switched on), for weekly bookings (their 8-hex ids) or one-off dates (their
// ids as state.once gives them, "gorbals/2026-11-25@18:00").
const MAX_AUTH_ITEMS = 30;
const onceIdShape = v => typeof v === 'string' && v.length <= 60 && /^([a-z]+\/)?\d{4}-\d{2}-\d{2}@\d{2}:\d{2}$/.test(v);
function readWeeklyAuth(b) {
  if (!isObj(b)) return { why: WHY.body };
  const items = b.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_AUTH_ITEMS) return { why: WHY.authItems };
  const out = [];
  for (const it of items) {
    if (!isObj(it) || !(weeklyId(it.id) || onceIdShape(it.id)) || !P.authOf(it.auth)) return { why: WHY.authItems };
    if (out.some(o => o.id === it.id)) return { why: WHY.authItems };
    out.push({ id: it.id, auth: it.auth });
  }
  return { items: out };
}
function readWeeklyOn(b) {
  if (!isObj(b)) return { why: WHY.body };
  const id = weeklyId(b.id);
  return id && typeof b.on === 'boolean' ? { id, on: b.on } : { why: WHY.weeklyOn };
}
function readWeeklyRemove(b) {
  if (!isObj(b)) return { why: WHY.body };
  const id = weeklyId(b.id);
  return id ? { id } : { why: WHY.weeklyId };
}
function readPlan(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (otherPark(b)) return { why: WHY.scheduled };
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
// A centre is any sheet the bot reads and holds from (lib/glasgowclub.js CENTRES: g, s and o).
const isCentre = c => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CENTRES, c);
function readLook(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (!isCentre(b.centre)) return { why: typeof b.centre === 'string' ? WHY.centre : WHY.look };
  const date = dateShape(b.date);
  return date ? { centre: b.centre, date, fresh: b.fresh === true } : { why: WHY.look };
}
function readHold(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (!isCentre(b.centre)) return { why: typeof b.centre === 'string' ? WHY.centre : WHY.hold };
  // Only the shapes are checked here; which times and courts are on offer is the bot's to say.
  const date = dateShape(b.date);
  return !date || !Number.isInteger(b.start) || !Number.isInteger(b.court) ? { why: WHY.hold } : { centre: b.centre, date, start: b.start, court: b.court };
}
// A sealed box, by its size and shape only: canonical standard base64 (so what is passed on is
// exactly what came), at most SEALED_MAX characters, at least SEALED_MIN bytes. Null otherwise.
function readSealed(v) {
  if (typeof v !== 'string' || v.length > SEALED_MAX || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const bytes = Buffer.from(v, 'base64');
  return bytes.length >= SEALED_MIN && bytes.toString('base64') === v ? v : null;
}
// The amount the app confirmed, written as the PC reads a price: "£23.00" (or "£23").
const readAmount = v => (typeof v === 'string' && /^£\d{1,4}(\.\d\d)?$/.test(v) ? v : null);
function readHoldOrder(b) {
  if (!isObj(b)) return { why: WHY.body };
  const ok = typeof b.id === 'string' && /^[0-9a-f]{12}$/.test(b.id) && (b.what === 'release' || b.what === 'done' || b.what === 'pay');
  if (!ok) return { why: WHY.holdOrder };
  if (b.what !== 'pay') return { id: b.id, what: b.what };
  const amount = readAmount(b.amount);
  if (!amount || typeof b.sealed !== 'string') return { why: WHY.pay };
  const sealed = readSealed(b.sealed);
  return sealed ? { id: b.id, what: 'pay', amount, sealed } : { why: WHY.sealed };
}
// POST /app/card { sealed }: the card, sealed by the app for the PC's card key.
function readCard(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (typeof b.sealed !== 'string') return { why: WHY.card };
  const sealed = readSealed(b.sealed);
  return sealed ? { sealed } : { why: WHY.sealed };
}
const readForget = b => (isObj(b) ? {} : { why: WHY.body });
// POST /app/card/auto { sealed }: the card's security code, sealed by the app for the PC's card key
// to be kept there for automatic payments (docs/app-api.md says what is in the box).
function readAuto(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (typeof b.sealed !== 'string') return { why: WHY.auto };
  const sealed = readSealed(b.sealed);
  return sealed ? { sealed } : { why: WHY.sealed };
}
const readAutoOff = b => (isObj(b) ? {} : { why: WHY.body });

// ---------- what the PC says of its card ----------
// Its card key: standard base64 of 32 bytes (an X25519 public key). Null if it is not one.
function cleanKey(v) {
  if (typeof v !== 'string' || v.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(v)) return null;
  const bytes = Buffer.from(v, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === v ? v : null;
}
// The card it keeps: { brand, last4, expMonth, expYear }, or null when it keeps none.
// Undefined when what it said does not read as either (what was known before then stands).
function cleanCard(v) {
  if (v === null) return null;
  if (!isObj(v) || !CARD_BRANDS.includes(v.brand) || typeof v.last4 !== 'string' || !/^\d{4}$/.test(v.last4)) return undefined;
  if (int(v.expMonth, 1, 12) === null || int(v.expYear, 2000, 2099) === null) return undefined;
  // `tag` (2.9.1): the first 8 hex characters of the SHA-256 of the card's pay key (its 32 raw
  // bytes), as the PC gives it, so that the app knows its own card by its own key. Anything else
  // is not passed on: null.
  const tag = typeof v.tag === 'string' && /^[0-9a-f]{8}$/.test(v.tag) ? v.tag : null;
  return { brand: v.brand, last4: v.last4, expMonth: v.expMonth, expYear: v.expYear, tag };
}
function readPush(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (b.token === null) return { token: null };
  const token = cleanPush(b.token);
  return token ? { token } : { why: WHY.push };
}

module.exports = {
  API, MAX_DEVICES, PAIR_TTL_MS, PAIR_TRIES, PAIR_LIMIT, PAIR_WINDOW_MS, SEEN_EVERY_MS, MAX_BODY, MAX_WAIT_S, MAX_WAITS,
  LOOKS_PER_MIN, LOOKS_WINDOW_MS, SHOWN_MS, NAME_MAX, NOTES_KEEP, NOTE_KINDS, NOTE_TITLE_MAX, NOTE_BODY_MAX, SEALED_MAX, SEALED_MIN, CARD_BRANDS, WHY,
  plain, whole, cut, hashToken, newToken, sameText, findDevice, cleanName, cleanPush, newDevice, cleanApps,
  createPairing, createLimiter, makeNote, cleanNotes, etagOf, waitMs,
  readOnce, readOnceRemove, readPlan, readPlanRemove, readOrder, readPause, readLook, readHold, readHoldOrder, readPush,
  readSealed, readAmount, readCard, readForget, readAuto, readAutoOff, readWeekly, readWeeklyChange, readWeeklyOn, readWeeklyRemove, readWeeklyAuth, readAuth, MAX_AUTH_ITEMS, placeOf, slotAt,
  cleanKey, cleanCard,
};
