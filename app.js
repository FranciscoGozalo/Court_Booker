'use strict';
// The bot's behaviour: your booking requests, what your PC at home should book, and the
// messages about it. The bot itself never touches ClubSpark: your PC signs in and books
// (Cloudflare turns Railway away), then reports back here, and the bot tells you the court,
// the time and the gate code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { iso, label, hhmm, todayCivil, addDays, londonInstant, civil, DAY_KEYS, DAY_LONG } = require('./lib/time');
const { parseDay, parseTime, parseOrder, parsePlan, parseSlot, parseBooking, cleanPlan, cleanOrder, cleanOnce, slotText, slotEnd } = require('./lib/plan');
const { jobsFor, missingFor, msToNextCheck, opensAt, civilOf, upcoming, releaseAround, MISSING_MS, SEEN_FRESH_MS } = require('./lib/schedule');
const M = require('./lib/messages');
const UI = require('./lib/ui');
const { readMac, publicIPv4, sendWake } = require('./lib/wake');

const VERSION = '2.4';
const STATE_VERSION = 4;
// Your PC checks in every minute while it is awake (node book.js --link), and at its nightly run.
const AWAKE_MS = 3 * 60 * 1000;            // heard from this recently: awake
const OFFLINE_MS = 24.5 * 3600 * 1000;     // not heard from since before last night's run: off, or not waking
const SENT_KEEP_MS = 3 * 86400000;
const RESULTS_KEEP_MS = 60 * 86400000;
const MAX_AHEAD_DAYS = 90;
const HEADS_UP_MS = 30 * 60 * 1000;   // the heads-up card only goes out when the PC checks in this close to a release
const PREFLIGHT_MS = 20 * 60 * 1000;       // this long before a release, make sure the PC answers (waking it if asleep)
const PREFLIGHT_WAIT_MS = 3 * 60 * 1000;   // how long the PC gets to answer that wake-up before you are told
const NO_WORD_MS = 8 * 60 * 1000;          // a run that started should have reported by this long after the release
const NO_WORD_FOR_MS = 60 * 60 * 1000;     // ...and after this the bot stops watching for it
const GONE = ['test', 'free', 'signin', 'style', 'lead', 'warn', 'go', 'code'];   // link-alert commands from version 1

// The banner pictures (made by art/make-banners.cjs): the menu card in three versions, one for
// each state of your PC (the coloured dot), and one each for a court booked and not booked.
// Each carries a fingerprint, so a changed file is uploaded afresh.
const KINDS = ['home-awake', 'home-asleep', 'home-offline', 'booked', 'missed'];
function loadPictures(dir = path.join(__dirname, 'assets')) {
  const out = {};
  for (const kind of KINDS) {
    const name = `banner-${kind}.jpg`;
    let buf;
    try { buf = fs.readFileSync(path.join(dir, name)); } catch { return null; }
    out[kind] = { buf, name, hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) };
  }
  return out;
}

// A whole number in a range, from a number or a string of digits. Anything else is null.
function intIn(v, lo, hi) {
  if (typeof v === 'string') {
    if (!/^-?\d+$/.test(v.trim())) return null;
    v = Number(v.trim());
  }
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

// A result from the PC, made safe to keep and show. Null if it does not make sense.
function cleanResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const m = /^(\d{4}-\d{2}-\d{2})@(\d{2}):(\d{2})$/.exec(id);
  if (!m || !['booked', 'none', 'failed'].includes(raw.status)) return null;
  const start = Number(m[2]) * 60 + Number(m[3]);
  const end = intIn(raw.end, start + 30, 1440) ?? slotEnd(start, 1);
  const r = { id, status: raw.status, date: m[1], start, end };
  if (raw.status === 'booked') {
    r.court = String(raw.court ?? '').replace(/[^\w ]/g, '').slice(0, 20);
    if (!r.court) return null;
    if (raw.gate) r.gate = String(raw.gate).replace(/[^\w#*-]/g, '').slice(0, 20) || undefined;
  } else if (raw.why) {
    r.why = String(raw.why).slice(0, 300);
  }
  return r;
}

// Settings from storage, or from the environment on a first start, made safe to use.
// Settings saved by version 1 (the link alerts) keep the owner, weekly plan, court order and pictures.
function loadState(raw, env = {}) {
  const state = {
    v: STATE_VERSION, owner: null, plan: {}, once: [], order: [1, 2, 3, 4, 5, 6], paused: false,
    results: {}, sent: {}, pics: {}, lastSeen: null, lastRun: null, home: null,
  };
  if (raw && typeof raw === 'object') {
    state.owner = intIn(raw.owner, -1e15, 1e15);
    state.plan = cleanPlan(raw.plan);
    state.once = cleanOnce(raw.once);
    state.order = cleanOrder(raw.order);
    state.paused = raw.paused === true;
    if (raw.v === STATE_VERSION) {
      if (raw.sent && typeof raw.sent === 'object') {
        for (const k of Object.keys(raw.sent)) if (typeof raw.sent[k] === 'number') state.sent[k] = raw.sent[k];
      }
      if (raw.results && typeof raw.results === 'object') {
        for (const k of Object.keys(raw.results)) {
          const r = cleanResult(raw.results[k]);
          if (r && typeof raw.results[k].at === 'number') state.results[r.id] = { ...r, at: raw.results[k].at };
        }
      }
      if (typeof raw.lastSeen === 'number') state.lastSeen = raw.lastSeen;
      if (typeof raw.lastRun === 'number') state.lastRun = raw.lastRun;     // when the PC's booking run last started, or said how it is going
      const h = raw.home;                                         // where your PC last called from, for waking it
      if (h && publicIPv4(h.ip) && typeof h.at === 'number') state.home = { ip: h.ip, at: h.at };
    }
    for (const kind of KINDS) {                                   // what Telegram calls each picture, once it has it
      const p = raw.pics && raw.pics[kind];
      if (p && typeof p.hash === 'string' && typeof p.id === 'string') state.pics[kind] = { hash: p.hash, id: p.id };
    }
  } else {
    state.plan = parsePlan(env.COURT_PLAN);
    state.order = parseOrder(env.COURT_ORDER) || state.order;
  }
  return state;
}

// The settings as one line, for the COURT_SETTINGS variable, and back again.
function backupLine(state) {
  return JSON.stringify({ v: STATE_VERSION, owner: state.owner, plan: cleanPlan(state.plan), once: cleanOnce(state.once), order: state.order });
}
function readBackup(text) {
  try {
    const o = JSON.parse(String(text || ''));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// `linked` says whether a PC can reach the bot (AGENT_TOKEN is set). `wake` sends the
// magic packet (lib/wake.js), and is swapped out in tests.
function createApp({ now = Date.now, tg, store, log = () => {}, env = {}, pictures = loadPictures(), linked = true, wake = sendWake }) {
  const fromVariable = readBackup(env.COURT_SETTINGS);
  const state = loadState(store.load() ?? fromVariable, env);
  const variableLine = fromVariable ? backupLine(loadState(fromVariable, env)) : null;
  const save = () => store.save(state);
  const envOwner = intIn(env.TELEGRAM_CHAT_ID, -1e15, 1e15);
  const owner = () => envOwner ?? state.owner;
  const releaseMin = parseTime(env.RELEASE_TIME) ?? 22 * 60;
  const daysAhead = intIn(env.DAYS_AHEAD, 1, 30) ?? 7;
  const cfg = () => ({ plan: state.plan, once: state.once, order: state.order, releaseMin, daysAhead });
  function kept() {
    if (store.isPersistent ? store.isPersistent() : true) return 'disk';
    return variableLine !== null && variableLine === backupLine(state) ? 'variable' : 'no';
  }
  const keepNote = () => (kept() !== 'no' ? '' : '\n\nNote: these settings will be lost at the next restart. To keep them, add a Railway volume mounted at /data, or send /backup.');
  const html = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  const say = (chat, text, extra = {}) => tg.send(chat, text, { ...html, ...extra });
  const next = () => M.esc(M.nextLine(cfg(), now(), state.paused));
  const toldPrivate = new Set();

  // ---------- banner cards ----------
  // A card is a banner picture with the words as its caption. A picture must never cost a
  // message, so whatever Telegram refuses about one falls back to plain text.
  const transient = err => !err.code || err.code === 429 || err.code >= 500;
  const notModified = err => /not modified/i.test((err && err.message) || '');
  // A picture goes to Telegram as the id it gave last time, or as the file the first time (or
  // when Telegram no longer knows the id).
  async function withPicture(kind, fn) {
    const p = pictures[kind], saved = state.pics[kind];
    const id = saved && saved.hash === p.hash ? saved.id : null;
    const file = { buf: p.buf, name: p.name };
    let sent;
    try { sent = await fn(id || file); } catch (err) {
      if (!id || transient(err) || notModified(err)) throw err;
      delete state.pics[kind];
      sent = await fn(file);
    }
    const sizes = sent && sent.photo;
    const got = Array.isArray(sizes) && sizes.length ? sizes[sizes.length - 1].file_id : null;
    if (got && got !== id) { state.pics[kind] = { hash: p.hash, id: got }; save(); }
    return sent;
  }
  async function sendCard(chat, kind, caption, keyboard = null) {
    const markup = keyboard ? { reply_markup: keyboard } : {};
    if (!pictures || !pictures[kind]) return say(chat, caption, markup);
    try {
      return await withPicture(kind, photo => tg.sendPhoto(chat, photo, { caption, parse_mode: 'HTML', ...markup }));
    } catch (err) {
      if (transient(err)) throw err;
      log(`Telegram would not take the picture (${err.message}). Sending plain text.`);
      return say(chat, caption, markup);
    }
  }

  // ---------- your PC's state: the dot on the menu banner ----------
  // Sleeping it from Telegram (Sleep my PC, /sleep): the request waits here until the PC's next
  // ping collects it, and after that the PC counts as asleep until it pings again.
  let sleepAsk = null;                                // when you asked (not yet collected)
  let sleptAt = null;                                 // when the PC collected it
  function pcState(t = now()) {
    if (!linked || !state.lastSeen) return 'offline';
    const age = t - state.lastSeen;
    if (age > OFFLINE_MS) return 'offline';
    if (sleptAt && state.lastSeen <= sleptAt) return 'asleep';
    return age <= AWAKE_MS ? 'awake' : 'asleep';
  }
  const homeKind = () => `home-${pcState()}`;

  // ---------- waking your PC (lib/wake.js) ----------
  // Needs WAKE_MAC (the PC's network card) and a port forward on your router from WAKE_PORT to
  // the PC. The address comes from your PC's own signed requests, so it follows your home's
  // address when your internet provider changes it.
  const wakeMac = readMac(env.WAKE_MAC);
  const wakePort = intIn(env.WAKE_PORT, 1, 65535) ?? 9;
  let wokeAt = null;                                  // when the last wake-up went (this run only)
  const wakeState = () => (!wakeMac || !linked ? 'off' : state.home ? 'ready' : 'no-home');
  function noteHome(from) {
    const ip = publicIPv4(from && from.ip);
    if (!ip) return;
    if (!state.home || state.home.ip !== ip) log(state.home ? 'Your home\'s public address changed.' : 'Learned your home\'s public address, for waking your PC.');
    state.home = { ip, at: now() };
  }
  // The Wake button and /wake. Returns a note for the tap and, when it makes sense, the menu.
  async function wakePc() {
    const t = now();
    if (wakeState() === 'off') return { toast: 'Waking is not set up: add WAKE_MAC on Railway.' };
    if (!state.home) return { toast: 'I do not know your home address yet. Your PC must be in touch once first.' };
    if (pcState(t) === 'awake') return { toast: 'Your PC is already awake.', screen: UI.home(ctx()), view: 'h' };
    if (wokeAt && t - wokeAt < 30000) return { toast: 'Sent a moment ago. Give it a minute.' };
    try {
      await wake({ host: state.home.ip, port: wakePort, mac: wakeMac });
    } catch (err) {
      log(`Wake-up not sent: ${err.message}`);
      return { toast: 'The wake-up could not be sent. Try again.' };
    }
    wokeAt = t;
    log('Wake-up sent to your PC.');
    return { toast: 'Wake-up sent', screen: UI.home(ctx()), view: 'h' };
  }

  // ---------- sleeping your PC ----------
  // A request no ping has collected within this long is dropped, so the PC never falls asleep
  // the next time it wakes because of an old tap.
  const SLEEP_ASK_MS = 2 * 60 * 1000;
  const SLEEP_GUARD_MS = 30 * 60 * 1000;              // no sleeping in the half hour before a booking
  const waiters = new Set();                          // pings waiting for something to do
  function sleepBlocker(t) {
    if (state.paused || owner() === null) return null;
    const [rel] = upcoming(t, cfg(), 1);
    return rel && t >= rel.releaseAt - SLEEP_GUARD_MS ? rel : null;
  }
  function requestSleep() {
    const t = now();
    if (!linked) return { toast: 'Your PC is not linked to me.' };
    if (pcState(t) !== 'awake') return { toast: 'Your PC is not awake.', screen: UI.home(ctx()), view: 'h' };
    const rel = sleepBlocker(t);
    if (rel) return { toast: `Your PC books at ${hhmm(releaseMin)}, so it stays awake until then.`, screen: UI.home(ctx()), view: 'h' };
    sleepAsk = t;
    for (const w of waiters) w.wake();
    log('Asked your PC to sleep.');
    return { toast: 'Sleep sent', screen: UI.home(ctx()), view: 'h' };
  }
  // What the PC should do now, collected by its ping: { sleep: true } once, or nothing.
  function takeOrder(t) {
    if (sleepAsk === null) return {};
    const fresh = t - sleepAsk <= SLEEP_ASK_MS && !sleepBlocker(t);
    sleepAsk = null;
    if (!fresh) return {};
    sleptAt = t;
    log('Your PC collected the request to sleep.');
    return { sleep: true };
  }
  function waitForOrder(ms) {
    return new Promise(resolve => {
      const w = { wake: () => { clearTimeout(w.timer); waiters.delete(w); resolve(); } };
      w.timer = setTimeout(w.wake, ms);
      waiters.add(w);
    });
  }

  // A trial of a wider banner: a text message with the banner as a large link preview (the page
  // at /card/<kind> on this server names the picture). Telegram fetches it from RAILWAY_PUBLIC_DOMAIN.
  const publicHost = String(env.PUBLIC_HOST || env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const previewOf = kind => (publicHost && pictures && pictures[kind]
    ? { url: `https://${publicHost}/card/${kind}?v=${pictures[kind].hash}`, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true });

  // ---------- the tap-through screens ----------
  const ctx = () => ({ cfg: cfg(), now: now(), paused: state.paused, results: state.results, lastSeen: state.lastSeen, linked, pc: pcState(), wake: wakeState(), wokeAt, sleepAsk });
  const statusInfo = () => ({
    version: VERSION, skewMs: tg.skewMs ? tg.skewMs() : null, kept: kept(), paused: state.paused,
    linked, lastSeen: state.lastSeen, lastSeenDay: state.lastSeen ? todayCivil(state.lastSeen) : null, pc: pcState(),
    wake: wakeState(), wokeAt,
  });
  // The menu cards sent since this start, so a tap, or a change in your PC's state, can redraw
  // them: { kind (banner), wide, caption, keyboard, view ('h' home, 's' status, or null) }.
  const cards = new Map();
  const newest = new Map();                 // chat -> id of the newest menu card
  function track(chat, id, card, isNew) {
    if (!id) return;
    cards.set(`${chat}:${id}`, card);
    if (cards.size > 100) cards.delete(cards.keys().next().value);
    if (isNew) newest.set(chat, id);
  }
  // Redraws a card where it is: just the words when its banner is still right, otherwise both.
  // One edit at a time per card: a tap and the PC's dot changing can both redraw the same card
  // in the same moment, and Telegram cancels one of two edits that overlap.
  const editing = new Map();
  async function drawOn(chat, id, card) {
    const key = `${chat}:${id}`;
    const mine = (editing.get(key) || Promise.resolve()).catch(() => {}).then(() => drawNow(chat, id, card));
    editing.set(key, mine);
    try { await mine; } finally { if (editing.get(key) === mine) editing.delete(key); }
  }
  async function drawNow(chat, id, card) {
    const was = cards.get(`${chat}:${id}`);
    const extra = { parse_mode: 'HTML', reply_markup: card.keyboard };
    try {
      if (card.wide) await tg.edit(chat, id, card.caption, { ...extra, link_preview_options: previewOf(card.kind) });
      else if ((!was || was.kind !== card.kind) && pictures && pictures[card.kind]) {
        await withPicture(card.kind, photo => tg.editMedia(chat, id, photo, { caption: card.caption, ...extra }));
      } else await tg.editCaption(chat, id, card.caption, extra);
    } catch (err) {
      if (!notModified(err)) throw err;
    }
    track(chat, id, card, false);
  }
  // Shows a screen: on the card the button was on, or as a new card.
  async function show(chat, scr, messageId = null, { view = null, wide = false } = {}) {
    const card = { kind: homeKind(), wide, caption: scr.caption, keyboard: scr.keyboard, view };
    if (messageId) {
      try { await drawOn(chat, messageId, card); return; } catch (err) {
        if (err.code !== 400) throw err;       // e.g. a message Telegram will not change: a new card instead
      }
    }
    const sent = wide
      ? await say(chat, scr.caption, { link_preview_options: previewOf(card.kind), reply_markup: scr.keyboard })
      : await sendCard(chat, card.kind, scr.caption, scr.keyboard);
    track(chat, sent && sent.message_id, card, true);
  }
  // When your PC wakes or sleeps, the newest menu card gets the new dot (and, on the home and
  // status screens, the new words).
  let shownPc = null;
  async function refreshNewest(t) {
    const pc = pcState(t);
    if (pc === shownPc) return;
    const first = shownPc === null;
    shownPc = pc;
    const chat = owner();
    const id = chat === null ? null : newest.get(chat);
    const card = id && cards.get(`${chat}:${id}`);
    if (first || !card || card.kind === `home-${pc}`) return;
    const scr = card.view === 'h' ? UI.home(ctx()) : card.view === 's' ? UI.status(ctx(), statusInfo()) : card;
    try { await drawOn(chat, id, { ...card, kind: `home-${pc}`, caption: scr.caption, keyboard: scr.keyboard }); } catch (err) {
      log(`Could not update the menu card: ${err.message}`);
    }
  }

  const DAY_RE = '(sun|mon|tue|wed|thu|fri|sat)';
  // What a button does. Returns the screen to show next and a short note for the tap.
  function route(data) {
    let m;
    const c = ctx();
    if (data === 'noop') return {};
    if (data === 'h') return { screen: UI.home(c), view: 'h' };
    if (data === 'b') return { screen: UI.calendar(c) };
    if ((m = /^cal:(\d{4})(\d{2})$/.exec(data))) return { screen: UI.calendar(c, civil(+m[1], +m[2], 1)) };
    if ((m = /^d:(\d{8})$/.exec(data))) return { screen: UI.times(c, UI.fromD8(m[1])) };
    if ((m = /^t:(\d{8}):(\d{4})$/.exec(data))) return { screen: UI.lengths(c, UI.fromD8(m[1]), UI.fromHm(m[2])) };
    if ((m = /^l:(\d{8}):(\d{4}):([12])$/.exec(data))) return { screen: UI.confirmOnce(c, UI.fromD8(m[1]), UI.fromHm(m[2]), +m[3]) };
    if ((m = /^ok:(\d{8}):(\d{4}):([12])$/.exec(data))) {
      const dateIso = UI.fromD8(m[1]), start = UI.fromHm(m[2]), hours = +m[3];
      const date = civilOf(dateIso), today = todayCivil(c.now);
      if (date > addDays(today, UI.MAX_AHEAD_DAYS) || londonInstant(date, start) <= c.now || start + hours * 60 > UI.LAST_END) {
        return { screen: UI.calendar(c), toast: 'That time is no longer available. Pick again.' };
      }
      if (state.once.some(o => o.date === dateIso && o.start === start)) return { screen: UI.added(c, dateIso, start, hours, true), toast: 'Already on your list' };
      state.once = cleanOnce([...state.once, { date: dateIso, start, hours }]); save();
      log(`Added ${dateIso} ${hhmm(start)} by button`);
      return { screen: UI.added(ctx(), dateIso, start, hours), toast: 'Added' };
    }
    if ((m = /^x:(\d{8}):(\d{4})$/.exec(data))) {
      const dateIso = UI.fromD8(m[1]), start = UI.fromHm(m[2]);
      const gone = state.once.find(o => o.date === dateIso && o.start === start);
      state.once = state.once.filter(o => o !== gone); save();
      return { screen: UI.bookings(ctx(), gone ? `Removed ${label(civilOf(dateIso))} · ${slotText(gone)}` : ''), toast: gone ? 'Removed' : 'Already gone' };
    }
    if (data === 'w') return { screen: UI.weekly(c) };
    if ((m = new RegExp(`^wd:${DAY_RE}$`).exec(data))) return { screen: UI.weeklyDay(c, m[1]) };
    if ((m = new RegExp(`^wt:${DAY_RE}$`).exec(data))) return { screen: UI.weeklyTimes(c, m[1]) };
    if ((m = new RegExp(`^wt:${DAY_RE}:(\\d{4})$`).exec(data))) return { screen: UI.weeklyLengths(c, m[1], UI.fromHm(m[2])) };
    if ((m = new RegExp(`^wl:${DAY_RE}:(\\d{4}):([12])$`).exec(data))) {
      const start = UI.fromHm(m[2]), hours = +m[3];
      if (start < UI.FIRST_START || start + hours * 60 > UI.LAST_END) return { screen: UI.weekly(c), toast: 'Pick a time between 09:00 and 21:00.' };
      state.plan[m[1]] = { start, hours }; save();
      log(`Weekly ${m[1]} set by button`);
      return { screen: UI.weeklySaved(ctx(), m[1]), toast: 'Saved' };
    }
    if ((m = new RegExp(`^woff:${DAY_RE}$`).exec(data))) {
      delete state.plan[m[1]]; save();
      return { screen: UI.weekly(ctx()), toast: `Stopped ${DAY_LONG[DAY_KEYS.indexOf(m[1])]}s` };
    }
    if (data === 'm') return { screen: UI.bookings(c) };
    if (data === 'o') return { screen: UI.order(c) };
    if ((m = /^o:([1-6]{1,6})$/.exec(data)) && new Set(m[1]).size === m[1].length) return { screen: UI.order(c, m[1]) };
    if ((m = /^os:([1-6]{1,6})$/.exec(data)) && new Set(m[1]).size === m[1].length) {
      state.order = parseOrder(m[1].split('').join(' ')); save();
      return { screen: UI.home(ctx()), view: 'h', toast: `Court order: ${state.order.join(', ')}` };
    }
    if (data === 'p') {
      state.paused = !state.paused; save();
      return { screen: UI.home(ctx()), view: 'h', toast: state.paused ? 'Paused: nothing will be booked' : 'Booking is on' };
    }
    if (data === 's') return { screen: UI.status(c, statusInfo()), view: 's' };
    if (data === 'sl') return { screen: UI.sleepConfirm(c) };
    if (data === 'sl:ok') return requestSleep();
    return { toast: 'That button is out of date. Send /menu.' };
  }

  // A button was tapped. Only the owner's taps count.
  async function handleTap(q) {
    const chat = q.message && q.message.chat ? q.message.chat.id : null;
    const answer = text => Promise.resolve().then(() => tg.answer(q.id, text)).catch(() => {});
    if (chat === null || owner() === null || chat !== owner()) { await answer('This bot is private.'); return; }
    let data = String(q.data || '');
    const fresh = data.startsWith('n:');                                   // on a booking message: keep it, open a new card
    if (fresh) data = data.slice(2);
    let result;
    try { result = data === 'wk' ? await wakePc() : route(data); } catch (e) { log(`Button failed: ${e.message}`); result = { toast: 'That did not work. Send /menu to start again.' }; }
    await answer(result.toast);
    const wide = typeof q.message.text === 'string';                      // the wide trial card is a text message
    if (result.screen) await show(chat, result.screen, fresh ? null : q.message.message_id, { view: result.view || null, wide: wide && !fresh });
  }

  // ---------- your PC ----------
  // The PC asks what to book. `run` says whether this is a booking run starting (the nightly
  // task) or only a look (`node book.js --jobs`); an older PC says neither, and counts as a run.
  // A run starting is what the "has not started" warning watches for, and before a release it
  // brings the heads-up card, once per release.
  let headsUp = null;                       // tonight's heads-up card, so "signed in" can be written on it
  // What has been said is remembered for a few days, so nothing is said twice; then forgotten.
  const forgetOld = t => { for (const k of Object.keys(state.sent)) if (t - state.sent[k] > SENT_KEEP_MS) delete state.sent[k]; };
  function jobsForAgent(from = {}, { run } = {}) {
    const t = now();
    const starting = run !== false;
    state.lastSeen = t;
    if (starting) state.lastRun = t;
    noteHome(from);
    const c = cfg();
    const jobs = state.paused || owner() === null ? [] : jobsFor(t, c, state.results);
    const coming = jobs.filter(j => j.releaseAt > t && j.releaseAt - t <= HEADS_UP_MS);
    if (starting && coming.length) {
      const key = `ready:${coming[0].releaseAt}`;
      if (!state.sent[key]) {
        forgetOld(t);
        state.sent[key] = t;
        const card = { chat: owner(), coming, id: null, photo: false, ready: false };
        card.sent = sendCard(card.chat, 'home-awake', M.headsUp(c, coming))
          .then(sent => { card.id = (sent && sent.message_id) || null; card.photo = !!(sent && sent.photo); })
          .catch(e => { delete state.sent[key]; log(`Heads-up not sent: ${e.message}`); });
        headsUp = card;
      }
    }
    save();
    return {
      jobs: jobs.map(j => ({ id: j.id, date: j.date, start: j.start, end: j.end, hours: j.hours, releaseAt: j.releaseAt })),
      order: c.order, releaseMin, daysAhead,
    };
  }

  // The PC says it is awake: every minute from `node book.js --link`, which runs while you are
  // signed in to Windows. That is all the dot on the menu banner goes on.
  // With `wait` (seconds) the answer waits until there is something for the PC to do, so a
  // Sleep tap reaches it within seconds instead of at its next ping.
  async function pingFromAgent(from = {}, { wait = 0, refused = null } = {}) {
    state.lastSeen = now();
    noteHome(from);
    save();
    if (refused) {                                    // asked to sleep, it would not: say why
      sleptAt = null;
      log(`Your PC stayed awake: ${refused}`);
      const chat = owner();
      if (chat !== null) say(chat, `<b>Your PC stayed awake</b>\nIt did not go to sleep: ${M.esc(refused)}.`).catch(e => log(`Could not say so: ${e.message}`));
    }
    let order = takeOrder(now());
    if (!order.sleep && wait > 0) {
      await waitForOrder(wait * 1000);
      order = takeOrder(now());
    }
    return { ok: true, ...order };
  }

  // The PC says how tonight's run is going, before there is a result: "ready" once it has signed
  // in to ClubSpark (written on the heads-up card), or "trouble" when an attempt failed and it is
  // about to try again (a message, so you know with minutes to spare).
  let lastTrouble = 0;
  async function progressFromAgent(raw) {
    const stage = raw && raw.stage;
    const chat = owner();
    if (stage !== 'ready' && stage !== 'trouble') return { ok: false, why: 'that is not a stage I know (ready or trouble)' };
    state.lastSeen = state.lastRun = now();           // the run is going: the wait for its result starts again
    save();
    if (chat === null) return { ok: true };
    if (stage === 'ready') {
      const card = headsUp;
      if (!card || card.ready) return { ok: true };
      card.ready = true;
      await card.sent;                                  // the card itself may still be on its way
      if (!card.id) return { ok: true };
      const caption = M.headsUp(cfg(), card.coming, true);
      try {
        if (card.photo) await tg.editCaption(card.chat, card.id, caption, { parse_mode: 'HTML' });
        else await tg.edit(card.chat, card.id, caption, html);
      } catch (err) {
        if (!notModified(err)) log(`Could not write "signed in" on the heads-up: ${err.message}`);
      }
      log('Your PC has signed in and is waiting for the release.');
      return { ok: true };
    }
    const t = now();
    if (t - lastTrouble < 15000) return { ok: true };            // never a flood of these
    lastTrouble = t;
    const why = String(raw.why || 'no reason given').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, 300);
    await say(chat, M.troubleText(why, intIn(raw.attempt, 2, 9), intIn(raw.of, 2, 9)));
    log(`Your PC reported trouble before the booking: ${why}`);
    return { ok: true };
  }

  // The PC says what happened. The message goes out first: if Telegram fails, the PC is told
  // so and tries again, and nothing is recorded twice.
  async function resultFromAgent(raw) {
    const r = cleanResult(raw);
    if (!r) return { ok: false, why: 'that result is missing something or does not make sense' };
    const prev = state.results[r.id];
    if (prev && prev.status === 'booked' && r.status !== 'booked') return { ok: true };       // a booking stands
    const same = prev && prev.status === r.status && prev.court === r.court;
    const chat = owner();
    if (!same && chat !== null) {
      if (r.status === 'booked') await sendCard(chat, 'booked', M.bookedCaption(r), UI.afterBooked());
      else await sendCard(chat, 'missed', M.failedText(r), UI.afterFailed());
    }
    state.results[r.id] = { ...r, at: now() };
    for (const k of Object.keys(state.results)) if (now() - state.results[k].at > RESULTS_KEEP_MS) delete state.results[k];
    save();
    log(`Result from the PC: ${r.id} ${r.status}${r.court ? ` (Court ${r.court})` : ''}`);
    return { ok: true };
  }

  // ---------- messages from the owner ----------
  async function handleUpdate(update) {
    if (update && update.callback_query) return handleTap(update.callback_query);
    const msg = update && update.message;
    if (!msg || typeof msg.text !== 'string' || !msg.chat || msg.chat.type !== 'private') return;
    const chat = msg.chat.id;
    const text = msg.text.trim();
    const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const cmd = m ? m[1].toLowerCase() : null;
    const rest = m && m[2] ? m[2].trim() : '';
    const args = rest ? rest.split(/\s+/) : [];

    if (cmd === 'id') { await say(chat, `Your chat ID is <code>${chat}</code>`); return; }

    if (owner() === null) {
      if (cmd !== 'start') { await say(chat, 'Send /start to set this bot up.'); return; }
      state.owner = chat; save();
      log('Owner set by /start');
      await say(chat, `This bot is now yours, and it answers only you.\nTo lock that in for good, add the variable TELEGRAM_CHAT_ID = <code>${chat}</code> in Railway.${keepNote()}`);
      await show(chat, UI.home(ctx()), null, { view: 'h' });
      return;
    }
    if (chat !== owner()) {
      if (!toldPrivate.has(chat) && toldPrivate.size < 1000) { toldPrivate.add(chat); await say(chat, 'This bot is private.').catch(() => {}); }
      return;
    }
    if (!cmd) { await say(chat, 'Send /help to see what I understand.'); return; }
    log(`Command: /${cmd}`);
    const c = cfg(), t = now();

    switch (cmd) {
      case 'start':
      case 'menu':
        await show(chat, UI.home(ctx()), null, { view: 'h' }); break;

      case 'wide':                                   // the menu with a wider banner, as a trial
        if (!publicHost) { await say(chat, 'The wide card needs this server\'s public address (RAILWAY_PUBLIC_DOMAIN).'); break; }
        await show(chat, UI.home(ctx()), null, { view: 'h', wide: true }); break;

      case 'sleep': {                                // Sleep my PC, typed (no "are you sure?")
        const r = requestSleep();
        if (r.toast === 'Sleep sent') await show(chat, r.screen, null, { view: 'h' });
        else await say(chat, M.esc(r.toast));
        break;
      }

      case 'wake': {                                 // the Wake button, typed
        const r = await wakePc();
        if (r.screen) await show(chat, r.screen, null, { view: 'h' });
        else await say(chat, M.esc(r.toast));
        break;
      }

      case 'help':
        await say(chat, M.HELP); break;

      case 'plan':
      case 'list': {
        const scr = UI.bookings(ctx());
        await show(chat, { ...scr, caption: scr.caption + keepNote() }); break;
      }

      case 'next':
        await say(chat, next()); break;

      case 'status':
        await show(chat, UI.status(ctx(), statusInfo()), null, { view: 's' }); break;

      case 'set': {
        if (!args.length) { await show(chat, UI.weekly(ctx())); break; }
        const usage = 'Use it like this:  /set thu 19:00 2h\nDay, start time, then 1h or 2h (1h if you leave it out).';
        const day = parseDay(args[0]);
        const slot = parseSlot(args.slice(1));
        if (!day || !('start' in slot)) { await say(chat, (slot.why ? `${slot.why}\n` : '') + usage); break; }
        state.plan[day] = { start: slot.start, hours: slot.hours }; save();
        const name = DAY_LONG[DAY_KEYS.indexOf(day)];
        await say(chat, `<b>${name}s · ${slotText(state.plan[day])}</b>\nBooked every week, ${daysAhead} days before at ${hhmm(releaseMin)}, when the day opens.\n\n${next()}${keepNote()}`);
        break;
      }

      case 'off': {
        if ((args[0] || '').toLowerCase() === 'all') { state.plan = {}; save(); await say(chat, `Every weekly booking removed. One-off dates stay; see /plan.\n\n${next()}`); break; }
        const day = parseDay(args[0]);
        if (!day) { await say(chat, 'Use it like this:  /off thu   (or /off all)'); break; }
        const had = !!state.plan[day];
        delete state.plan[day]; save();
        await say(chat, `${had ? 'Removed' : 'There was no weekly booking for'} ${DAY_LONG[DAY_KEYS.indexOf(day)]}s.\n\n${next()}${keepNote()}`);
        break;
      }

      case 'book': {
        if (!args.length) { await show(chat, UI.calendar(ctx())); break; }
        const usage = 'Use it like this:  /book 25 nov 19:00 2h\nA date (25 nov, 25/11, wed, tomorrow), a start time, then 1h or 2h.';
        const today = todayCivil(t);
        const got = parseBooking(args, today);
        if (!('date' in got)) { await say(chat, (got.why ? `${got.why}\n` : '') + usage); break; }
        const date = got.date, dateIso = iso(date);
        if (date < today || londonInstant(date, got.start) <= t) {
          await say(chat, `${label(date)} at ${hhmm(got.start)} has already passed.`); break;
        }
        if (date > addDays(today, MAX_AHEAD_DAYS)) { await say(chat, `That is more than ${MAX_AHEAD_DAYS} days away. Try a nearer date.`); break; }
        if (state.once.some(o => o.date === dateIso && o.start === got.start)) { await say(chat, `${label(date)} at ${hhmm(got.start)} is already on your list. See /plan.`); break; }
        state.once = cleanOnce([...state.once, { date: dateIso, start: got.start, hours: got.hours }]); save();
        const opens = opensAt(date, c);
        const when = opens > t
          ? `Booked when it opens: ${label(addDays(date, -daysAhead))} at ${hhmm(releaseMin)}.`
          : 'That day is already open, so your PC books it on its next run (21:55 each night), or straight away if you run the booker on the PC now.';
        await say(chat, `<b>${label(date)} · ${slotText({ start: got.start, hours: got.hours })}</b>\n${when}${keepNote()}`);
        break;
      }

      case 'cancel': {
        if (!args.length) { await show(chat, UI.bookings(ctx())); break; }
        const n = intIn(args[0] ?? null, 1, state.once.length || 1);
        let gone = null;
        if (n !== null && state.once[n - 1]) gone = state.once.splice(n - 1, 1)[0];
        else if (args.length) {
          const date = parseBooking([...args, '00:00'], todayCivil(t)).date ?? null;   // "/cancel 25 nov": that date's one-offs
          if (date !== null) {
            const before = state.once.length;
            state.once = state.once.filter(o => o.date !== iso(date));
            if (state.once.length < before) gone = { date: iso(date), all: true };
          }
        }
        if (!gone) { await say(chat, 'Use the number from /plan, like  /cancel 2  (or a date, like  /cancel 25 nov)'); break; }
        save();
        await say(chat, `Removed ${gone.all ? `every one-off on ${label(civilOf(gone.date))}` : `${label(civilOf(gone.date))} · ${slotText(gone)}`}.\n\n${next()}`);
        break;
      }

      case 'order': {
        if (!rest) { await show(chat, UI.order(ctx())); break; }
        const order = parseOrder(rest);
        if (!order) { await say(chat, `Use it like this:  /order 3 4 5 2 1 6\nCourts 1 to 6, each once. Any you leave out go last.\nNow: ${state.order.join(', ')}`); break; }
        state.order = order; save();
        await say(chat, `Court order: ${order.join(', ')}`);
        break;
      }

      case 'backup':
        await say(chat, `Tap the line below to copy it, then save it in Railway as the variable COURT_SETTINGS. The bot starts from it whenever it has no saved settings, so update it after you change your plan.\n\n<code>${M.esc(backupLine(state))}</code>`); break;

      case 'pause':
        state.paused = true; save();
        await say(chat, 'Paused. Your PC will not book anything until you send /resume.'); break;

      case 'resume':
        state.paused = false; save();
        await say(chat, `Booking is on.\n\n${next()}`); break;

      default:
        await say(chat, GONE.includes(cmd)
          ? 'That was for the old link alerts. The bot now books for you: see /help.'
          : 'I do not know that one. Send /help to see what I understand.');
    }
  }

  // ---------- the timer ----------
  // Watches each booking night from 20 minutes before the release to an hour after, and speaks
  // up when something is not as it should be. Three checks, each said once:
  //   20 minutes before   the PC is not awake: wake it; three minutes on, still silent: say so
  //    2 minutes before   the PC's booking run has not started
  //    8 minutes after    the run started, but no result has come back
  let ticking = false;
  const retryAt = {};
  // Sends a warning once (trying again after a failed send), and notes that it went.
  async function warnOnce(key, t, send, noted) {
    if (state.sent[key] || (retryAt[key] && t < retryAt[key])) return;
    try {
      await send();
      forgetOld(t);
      state.sent[key] = t;
      save();
      log(noted);
    } catch (err) {
      retryAt[key] = t + (err.retryAfter ? err.retryAfter * 1000 : 5000);
      log(`Could not send the warning: ${err.message}`);
    }
  }

  async function checkAhead(t, chat) {
    const rel = releaseAround(t, cfg(), PREFLIGHT_MS, -MISSING_MS);
    if (!rel) return;
    const key = `pre:${rel.releaseAt}`, warned = `prewarn:${rel.releaseAt}`;
    const tried = state.sent[key];
    if (!tried) {
      const pc = pcState(t);
      if (pc === 'awake' || (retryAt[key] && t < retryAt[key])) return;
      if (wakeState() !== 'ready') {
        // Nothing to wake it with from here: speak up only if it has been silent for over a day.
        if (pc === 'offline') {
          await warnOnce(warned, t, () => sendCard(chat, 'home-offline', M.notAnsweringText(cfg(), rel, null, !!state.lastSeen), UI.afterNotAnswering(false)),
            `Warned ahead of ${label(rel.playDate)}'s booking that the PC has been out of touch for over a day`);
        }
        return;
      }
      try {
        await wake({ host: state.home.ip, port: wakePort, mac: wakeMac });
      } catch (err) {
        retryAt[key] = t + 30000;
        log(`Wake-up ahead of the booking not sent: ${err.message}`);
        return;
      }
      state.sent[key] = wokeAt = t;
      save();
      log(`Ahead of ${label(rel.playDate)}'s booking your PC was not awake, so I sent it a wake-up.`);
      return;
    }
    if (t - tried < PREFLIGHT_WAIT_MS || (state.lastSeen && state.lastSeen > tried)) return;     // still waiting, or it answered
    await warnOnce(warned, t, () => sendCard(chat, 'home-offline', M.notAnsweringText(cfg(), rel, tried), UI.afterNotAnswering(true)),
      `Warned that the PC did not answer a wake-up ahead of ${label(rel.playDate)}'s booking`);
  }

  async function checkStarted(t, chat) {
    const rel = missingFor(t, cfg(), state.lastRun);
    if (!rel) return;
    const awake = pcState(t) === 'awake';
    await warnOnce(`missing:${rel.releaseAt}`, t, () => sendCard(chat, 'home-offline', M.missingText(cfg(), rel, awake), UI.afterMissing()),
      `Warned that the booking run has not started for ${label(rel.playDate)}${awake ? ' (the PC is awake)' : ''}`);
  }

  async function checkReported(t, chat) {
    const rel = releaseAround(t, cfg(), 0, NO_WORD_FOR_MS);
    // No run for this release at all: the "has not started" warning has already said so.
    if (!rel || !state.lastRun || state.lastRun < rel.releaseAt - SEEN_FRESH_MS) return;
    // The eight minutes run from the release, or from the last sign of life after it: the run
    // starting (or starting over), or the result for another of tonight's bookings.
    const results = rel.requests.map(r => (state.results[r.id] && state.results[r.id].at) || 0);
    if (t < Math.max(rel.releaseAt, state.lastRun, ...results) + NO_WORD_MS) return;
    const heard = r => { const got = state.results[r.id]; return !!got && (got.status === 'booked' || got.at >= rel.releaseAt - SEEN_FRESH_MS); };
    const silent = rel.requests.filter(r => !heard(r));
    if (!silent.length) return;
    await warnOnce(`noword:${rel.releaseAt}`, t, () => sendCard(chat, 'missed', M.noWordText(silent), UI.afterFailed()),
      `Said there is no word from the PC about ${silent.map(r => r.id).join(', ')}`);
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const t = now(), today = todayCivil(t);
      const pastOnce = state.once.filter(o => civilOf(o.date) < today);
      if (pastOnce.length) { state.once = state.once.filter(o => civilOf(o.date) >= today); save(); }
      await refreshNewest(t);
      const chat = owner();
      if (chat === null || state.paused || !linked) return;
      await checkAhead(t, chat);
      await checkStarted(t, chat);
      await checkReported(t, chat);
    } finally {
      ticking = false;
    }
  }

  // How long until the timer next matters, so the caller can wake up then.
  function msToNext() {
    if (owner() === null || state.paused || !linked) return null;
    return msToNextCheck(now(), cfg());
  }

  // A quiet note on start-up, so a deploy can be seen to have worked.
  async function announce() {
    const chat = owner();
    if (chat === null) { log('No owner yet. Open the bot in Telegram and send /start.'); return; }
    const pc = linked ? '' : '\nYour PC cannot reach me yet: set AGENT_TOKEN in Railway (see the README).';
    await tg.send(chat, `Court booker is running (version ${VERSION}).\n${next()}${pc}${keepNote()}`, { ...html, disable_notification: true })
      .catch(e => log(`Start-up note not sent: ${e.message}`));
  }

  // A banner by name, for the public /banner and /card pages (the wide trial).
  const picture = kind => (pictures && KINDS.includes(kind) ? pictures[kind] : null);

  return { handleUpdate, tick, msToNext, announce, jobsForAgent, pingFromAgent, progressFromAgent, resultFromAgent, picture, pcState, wakeState, kept, state, cfg, owner, VERSION, hasPictures: !!pictures };
}

module.exports = { createApp, loadState, loadPictures, backupLine, readBackup, cleanResult, intIn, VERSION, KINDS };
