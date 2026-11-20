'use strict';
// The bot's behaviour: your booking requests, what your PC at home should book, and the
// messages about it. The bot itself never touches ClubSpark: your PC signs in and books
// (Cloudflare turns Railway away), then reports back here, and the bot tells you the court,
// the time and the gate code.
// For the indoor courts at Gorbals and Scotstoun (Glasgow Club) it looks up what is free, and
// "Hold" has your PC sign in there and put a court in your basket. Paying is yours: at your PC,
// or from the iPhone app, which has your PC pay with the card it keeps (the bot passes on the
// card and its security code sealed for your PC's key, and can open neither). Glasgow Club's
// site turns Railway away too, so while your PC is awake it does the reading as well.
// The iPhone app (docs/app-api.md) is another way in to the same things: what it asks is done by
// the functions the Telegram commands and buttons use, with the same checks.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { iso, label, hhmm, todayCivil, addDays, londonInstant, londonWall, civil, DAY_KEYS, DAY_LONG } = require('./lib/time');
const { parseDay, parseTime, parseOrder, parsePlan, parseSlot, parseBooking, cleanPlan, cleanOrder, cleanOnce, slotText, slotEnd } = require('./lib/plan');
const { jobsFor, jobId, missingFor, msToNextCheck, opensAt, civilOf, upcoming, releaseAround, MISSING_MS, SEEN_FRESH_MS } = require('./lib/schedule');
const M = require('./lib/messages');
const UI = require('./lib/ui');
const { readMac, publicIPv4, sendWake } = require('./lib/wake');
const G = require('./lib/glasgowclub');
const A = require('./lib/appapi');
const { createExpoPush, mask: maskPush } = require('./lib/push');

const VERSION = '2.9';
const STATE_VERSION = 4;
// Your PC checks in every minute while it is awake (node book.js --link), and at its nightly run.
const AWAKE_MS = 3 * 60 * 1000;            // heard from this recently: awake
const OFFLINE_MS = 24.5 * 3600 * 1000;     // not heard from since before last night's run: off, or not waking
const SENT_KEEP_MS = 3 * 86400000;
const RESULTS_KEEP_MS = 60 * 86400000;
const MAX_AHEAD_DAYS = 90;
const MAX_ONCE = 60;                       // one-off dates on the list at once, however they are asked for
const HEADS_UP_MS = 30 * 60 * 1000;   // the heads-up card only goes out when the PC checks in this close to a release
const PREFLIGHT_MS = 20 * 60 * 1000;       // this long before a release, make sure the PC answers (waking it if asleep)
const PREFLIGHT_WAIT_MS = 3 * 60 * 1000;   // how long the PC gets to answer that wake-up before you are told
const NO_WORD_MS = 8 * 60 * 1000;          // a run that started should have reported by this long after the release
const NO_WORD_FOR_MS = 60 * 60 * 1000;     // ...and after this the bot stops watching for it
const GONE = ['test', 'free', 'signin', 'style', 'lead', 'warn', 'go', 'code'];   // link-alert commands from version 1
// Said to a button, and to the app, that asks for an indoor day or time which is not on offer.
const DAY_GONE = 'That day is no longer on offer. Pick again.';
const TIME_GONE = 'That time is no longer on offer. Pick again.';
// Said to the app when it asks to hold a court that no look showed it free in the last 15 minutes.
const LIST_OLD = 'That list is old. Read the day again, then hold a court.';
// What the iPhone app can ask for (POST /app/<name>, docs/app-api.md).
const APP_ASKS = ['unpair', 'once', 'once/remove', 'plan', 'plan/remove', 'order', 'pause', 'pc/sleep', 'pc/wake', 'indoor/look', 'hold', 'hold/order', 'card', 'card/forget', 'push'];

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
    apps: [], notes: [],
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
      state.notes = A.cleanNotes(raw.notes);                      // what the bot told you unprompted, kept for the app
    }
    for (const kind of KINDS) {                                   // what Telegram calls each picture, once it has it
      const p = raw.pics && raw.pics[kind];
      if (p && typeof p.hash === 'string' && typeof p.id === 'string') state.pics[kind] = { hash: p.hash, id: p.id };
    }
    state.apps = A.cleanApps(raw.apps);                           // the phones linked to the app: a hash of each one's token, never the token
  } else {
    state.plan = parsePlan(env.COURT_PLAN);
    state.order = parseOrder(env.COURT_ORDER) || state.order;
  }
  return state;
}

// The settings as one line, for the COURT_SETTINGS variable, and back again. The phones linked
// to the app are left out on purpose: a line that is copied about should open no door.
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
// magic packet (lib/wake.js), and `glasgow` reads Glasgow Club's free indoor courts
// (lib/glasgowclub.js); both are swapped out in tests. `pcLookMs` is how long your PC gets to
// answer when it is asked to read Glasgow Club's sheet, and `pcHoldMs` how long it gets to
// collect a court to hold. `push` sends a notification to the phones linked to the app
// (lib/push.js: Expo's push service); tests swap it out too. `retryMs`: how long before a message
// that must not be lost (see strangerNote) is tried again when Telegram will not take it.
function createApp({ now = Date.now, tg, store, log = () => {}, env = {}, pictures = loadPictures(), linked = true, wake = sendWake, glasgow = null, pcLookMs = 20000, pcHoldMs = 25000, push = null, retryMs = 3000 }) {
  const indoor = glasgow || G.createGlasgowClub({ now, log });
  const pushOut = push || createExpoPush({ log });
  const fromVariable = readBackup(env.COURT_SETTINGS);
  const state = loadState(store.load() ?? fromVariable, env);
  const variableLine = fromVariable ? backupLine(loadState(fromVariable, env)) : null;
  const save = () => store.save(state);
  const envOwner = intIn(env.TELEGRAM_CHAT_ID, -1e15, 1e15);
  const owner = () => envOwner ?? state.owner;
  // A phone is linked to the app for one Telegram chat: the bot's owner at the time. One that
  // was linked while the bot answered to another chat (the settings file was someone else's, or
  // TELEGRAM_CHAT_ID was) does not outlive the owner taking the bot back: it is dropped here.
  {
    const mine = owner();
    const fileWasAnothers = envOwner !== null && state.owner !== null && state.owner !== envOwner;
    const before = state.apps.length;
    let stamped = 0;
    state.apps = state.apps.filter(d => {
      if (d.owner !== null) return d.owner === mine;
      if (mine === null || fileWasAnothers) return false;       // it does not say whose it is, and the file was not this owner's
      d.owner = mine;
      stamped++;
      return true;
    });
    const dropped = before - state.apps.length;
    if (dropped) log(`Unlinked ${dropped === 1 ? 'a phone' : `${dropped} phones`} linked to the app while this bot answered to another chat.`);
    if (dropped || stamped) save();
  }
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

  // ---------- notes: what the bot tells you unprompted, kept for the iPhone app ----------
  // The last 30 are kept, and each also goes as a notification to every linked phone that gave
  // a push token. Best effort, and never in the way: the notification is not waited for, and
  // nothing here can throw. A push token is never written in the log. A phone whose token the
  // push service no longer knows stays linked, but gets no more notifications until the app
  // gives a token again.
  function note(kind, title, body) {
    try {
      const n = A.makeNote(kind, title, body, now());
      state.notes = [n, ...state.notes].slice(0, A.NOTES_KEEP);
      save();
      const tokens = [...new Set(state.apps.map(d => d.push).filter(Boolean))];
      if (tokens.length) {
        Promise.resolve().then(() => pushOut(tokens, { title: n.title, body: n.body }))
          .then(told => {
            const gone = told && Array.isArray(told.unregistered) ? told.unregistered : [];
            const phones = state.apps.filter(d => d.push && gone.includes(d.push));
            if (!phones.length) return;
            for (const d of phones) d.push = null;
            save();
            log(`The push service no longer knows ${phones.length === 1 ? 'a linked phone' : `${phones.length} linked phones`}, so no more notifications go there until the app asks for them again.`);
          })
          .catch(e => log(`A notification could not be sent: ${maskPush((e && e.message) || e)}`));
      }
    } catch (e) {
      log(`Could not keep a note for the app: ${(e && e.message) || e}`);
    }
  }
  // A message's own words as a note: its first line is the title, the `lines` after it the body.
  const noteOf = (text, lines) => {
    const [title, ...rest] = String(text).split('\n').map(A.plain);
    return { title, body: rest.slice(0, lines).join(' ') };
  };

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
  // What stands in the way of a wake-up now: { toast, menu } (`menu`: the menu is still worth
  // showing), or null. The Wake button, /wake and the app all go by it.
  function wakeBlocker(t) {
    if (wakeState() === 'off') return { toast: 'Waking is not set up: add WAKE_MAC on Railway.' };
    if (!state.home) return { toast: 'I do not know your home address yet. Your PC must be in touch once first.' };
    if (pcState(t) === 'awake') return { toast: 'Your PC is already awake.', menu: true };
    if (wokeAt && t - wokeAt < 30000) return { toast: 'Sent a moment ago. Give it a minute.' };
    return null;
  }
  // The Wake button and /wake. Returns a note for the tap and, when it makes sense, the menu;
  // `sent` says the wake-up went.
  async function wakePc() {
    const t = now();
    const no = wakeBlocker(t);
    if (no) return no.menu ? { toast: no.toast, screen: UI.home(ctx()), view: 'h' } : { toast: no.toast };
    try {
      await wake({ host: state.home.ip, port: wakePort, mac: wakeMac });
    } catch (err) {
      log(`Wake-up not sent: ${err.message}`);
      return { toast: 'The wake-up could not be sent. Try again.' };
    }
    wokeAt = t;
    log('Wake-up sent to your PC.');
    return { toast: 'Wake-up sent', screen: UI.home(ctx()), view: 'h', sent: true };
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
  // What stands in the way of putting your PC to sleep now, in words, or null. Sleep my PC,
  // /sleep and the app all go by it.
  function sleepNo(t) {
    if (!linked) return 'Your PC is not linked to me.';
    if (pcState(t) !== 'awake') return 'Your PC is not awake.';
    if (sleepBlocker(t)) return `Your PC books at ${hhmm(releaseMin)}, so it stays awake until then.`;
    if (holdLive(t)) return 'Your PC is holding a court for you. Let it go first.';
    return null;
  }
  // `sent` says the request is waiting for the PC.
  function requestSleep() {
    const t = now();
    const no = sleepNo(t);
    if (no) return linked ? { toast: no, screen: UI.home(ctx()), view: 'h' } : { toast: no };
    sleepAsk = t;
    for (const w of waiters) w.wake();
    log('Asked your PC to sleep.');
    return { toast: 'Sleep sent', screen: UI.home(ctx()), view: 'h', sent: true };
  }
  // What the PC should do now, collected by its ping: { look } (read a day of Glasgow Club's
  // sheet: someone is waiting for it, so it goes first), { hold } (put a court in your basket),
  // { card } or { forgetCard } (keep a card from the app, or forget the one kept: see "your
  // card") or { sleep: true }, each once, or nothing.
  function takeOrder(t) {
    if (lookAsk && !lookAsk.taken) {
      lookAsk.taken = true;
      return { look: { id: lookAsk.id, key: lookAsk.key, date: lookAsk.date } };
    }
    if (hold && !hold.end && !hold.taken) {
      hold.taken = true;
      hold.heard = hold.takenAt = t;
      log('Your PC collected the court to hold.');
      drawHold(hold);
      return { hold: { id: hold.id, key: hold.key, date: hold.date, start: hold.start, court: hold.court } };
    }
    const card = takeCard(t);
    if (card) return card;
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

  // ---------- your PC reads Glasgow Club ----------
  // Glasgow Club's site turns this server away (as ClubSpark does), so while your PC is awake
  // it does the reading, from your own connection: the request rides on its ping, like Sleep,
  // and the day's sheet comes back on POST /agent/look. One look at a time; the PC gets
  // `pcLookMs` to answer (its pings leave a gap of up to ten seconds, and the read takes a few).
  let lookAsk = null;                                 // the look being waited for: { id, key, date, taken, done }
  function askPc(centre, dateIso) {
    return new Promise((resolve, reject) => {
      if (lookAsk) lookAsk.done(G.problem('odd', 'another look took its place'));
      const ask = { id: crypto.randomBytes(6).toString('hex'), key: centre.key, date: dateIso, taken: false };
      const timer = setTimeout(() => ask.done(G.problem('pc', 'your PC did not answer in time')), pcLookMs);
      if (timer.unref) timer.unref();
      ask.done = (err, json) => {
        clearTimeout(timer);
        if (lookAsk === ask) lookAsk = null;
        ask.done = () => {};
        if (err) reject(err); else resolve(json);
      };
      lookAsk = ask;
      // The newest ping first: an older one may be left over from a connection that has gone
      // (Wi-Fi dropping, the link restarting), and would take the look to nowhere.
      for (const w of [...waiters].reverse()) w.wake();
    });
  }
  // The PC's answer to a look: the day's sheet as the site sent it (in short form), or why not.
  // An answer nobody is waiting for any more (it came too late) is dropped.
  function lookFromAgent(raw) {
    const ask = lookAsk;
    if (!raw || typeof raw !== 'object' || !ask || raw.id !== ask.id) return { ok: true, late: true };
    if (raw.ok === true) {
      try { ask.done(null, G.sheetFromPc(raw.sheet)); } catch (err) { ask.done(err); }
    } else {
      const kind = G.KINDS.includes(raw.kind) && raw.kind !== 'pc' ? raw.kind : 'odd';
      ask.done(G.problem(kind, String(raw.why || 'no reason given').replace(/\s+/g, ' ').slice(0, 200)));
    }
    return { ok: true };
  }
  // A day's sheet, by the way that can work: your PC while it is awake, otherwise from here
  // (which Glasgow Club lets through only if this server is not in a cloud). Around the PC's
  // nightly booking run nothing is asked of it: ten minutes either side of the release time,
  // every night, whether or not a day opens then (the run starts five minutes before).
  const LOOK_GUARD_MS = 10 * 60 * 1000;
  const nearRun = t => [-1, 0, 1].some(d => Math.abs(t - londonInstant(addDays(todayCivil(t), d), releaseMin)) <= LOOK_GUARD_MS);
  async function readIndoor(key, dateIso, fresh) {
    const t = now();
    if (linked && pcState(t) === 'awake') {
      if (!indoor.peek(key, dateIso, { fresh }) && nearRun(t)) {
        const busy = G.problem('odd', 'the PC is at its booking run');
        busy.say = `Your PC's nightly booking run is at ${hhmm(releaseMin)}, so I am asking nothing else of it until ${hhmm((releaseMin + LOOK_GUARD_MS / 60000) % 1440)}.`;
        throw busy;
      }
      try { return await indoor.day(key, dateIso, { fresh, via: askPc }); } catch (err) {
        if (err.kind === 'pc') err.wake = wakeState() === 'ready';      // it may have gone to sleep: offer to wake it
        throw err;
      }
    }
    try { return await indoor.day(key, dateIso, { fresh }); } catch (err) {
      if (!linked || err.kind !== 'challenge') throw err;
      const asleep = G.problem('challenge', err.message);
      asleep.say = 'Glasgow Club\'s site turns this server away, so your PC reads the free courts for me, and your PC is not awake. Wake it and try again, or open the sheet.';
      asleep.wake = wakeState() === 'ready';
      throw asleep;
    }
  }

  // ---------- your PC holds a court at Glasgow Club ----------
  // "Hold" under a free court: your PC signs in to Glasgow Club, puts that court in your basket
  // and stops at the payment page, in a Chrome window on the PC (tools/glasgow-club-book.js
  // there). The request rides on the PC's ping, like a look. The tool then says each step on
  // POST /agent/hold, and every note of its is answered with what you have asked for since:
  // "Let it go", "I have paid", or, from the iPhone app only, "Pay".
  // Paying: the bot never can, and never sees a card. The card is typed into the app, sealed
  // there for your PC's own key, and kept on your PC (see "your card", below). Pay in the app
  // sends the price you confirmed there and the card's security code, sealed the same way. The
  // bot checks that the court is in the basket, that your PC keeps a card and says it can pay
  // for this court, and that the price is the one your PC read; then it hands the order to the
  // PC with the PC's next note, once, and keeps nothing of the sealed code. The PC types the card
  // in, presses Pay once, and says how it goes: "paying", "approve" (your bank wants you to
  // approve it in your banking app) and how it ended. Telegram has no Pay button: the security
  // code only ever comes from the app.
  // Once the PC says Pay was pressed (`pressed`), or may have been ('maybe': Chrome gave it no
  // answer to the press), that is said with however the hold ends, whoever ends it, and such a
  // hold is never told to let go.
  // One court at a time, never around the PC's nightly booking run, at most HOLD_PER_HOUR an hour.
  const HOLD_STAGES = ['signing-in', 'signed-in', 'adding', 'held', 'paying', 'approve'];
  const HOLD_ENDS = ['failed', 'refused', 'released', 'booked', 'left', 'unsure', 'closed', 'slept', 'gone'];
  const HOLD_OURS = ['timeout', 'nostart'];           // endings this bot decided on itself: the PC's own word replaces them
  const HOLD_BEFORE_MS = 35 * 60 * 1000;              // none is started this long before the release time...
  const HOLD_AFTER_MS = 15 * 60 * 1000;               // ...or this long after it (the run starts five minutes before)
  const HOLD_START_MS = 90 * 1000;                    // collected by the PC, yet no step heard for this long: it never started
  const HOLD_SETUP_MS = 8 * 60 * 1000;                // from the tap to the basket takes under a minute; by now it is not coming
  const HOLD_AFTER_END_MS = 7 * 60 * 1000;            // ...and this long after its time was up a hold is over, whatever was heard
  const HOLD_SILENT_MS = 75 * 1000;                   // no word from the PC for this long: the card says so
  const HOLD_LOST_MS = 4 * 60 * 1000;                 // ...and for this long: another hold may be started
  const HOLD_PER_HOUR = 6;                            // each is a sign-in to Glasgow Club
  const HOLD_QUIET_MS = 60 * 60 * 1000;               // after Glasgow Club's site checked visitors from home
  const HOLD_REDRAW_MS = 5000;                        // a card Telegram would not redraw is tried again after this
  const PAY_ORDER_MS = 30 * 1000;                     // an order to pay goes to the PC within this long, or is dropped unsent
  const PAY_TOLD_MS = 30 * 1000;                      // ...and once it has gone, the PC says it is paying within this long, or the card says so
  const PAY_ROOM_MS = 30 * 1000;                      // no order to pay is taken with less of the hold's time left than this
  const PAYING = ['paying', 'approve'];
  let hold = null;                                    // the hold being followed, or the last one
  const gaveUp = new Set();                           // holds given up on here: a PC that still has one is told to let it go
  // Holds given up on here for a newer one although Pay was pressed, may have been, or was
  // ordered and never answered: still followed to their end, on their own cards.
  const former = new Map();
  let holdStarts = [];
  let holdQuiet = 0;
  const clock = ms => { const w = londonWall(ms); return hhmm(w.hh * 60 + w.mm); };
  const holdLive = (t = now()) => !!hold && !hold.end && t - hold.heard < HOLD_LOST_MS;
  const holdName = h => `${G.CENTRES[h.key].name} ${h.date} ${hhmm(h.start)} court ${h.court}`;
  const nearHoldGuard = t => [-1, 0, 1].some(d => {
    const rel = londonInstant(addDays(todayCivil(t), d), releaseMin);
    return t >= rel - HOLD_BEFORE_MS && t <= rel + HOLD_AFTER_MS;
  });
  // What is known here of a press of Pay for a hold, strongest first: true (the PC said it
  // pressed), 'maybe' (the PC said it may have: it got no answer to the press; or its link
  // says a press was noted before the tool went), 'unheard' (an order to pay went out to the PC,
  // and the PC never said how that went), false.
  const PRESS_RANK = [false, 'unheard', 'maybe', true];
  const stronger = (a, b) => (PRESS_RANK.indexOf(a) >= PRESS_RANK.indexOf(b) ? a : b);
  const pressedSaid = v => (v === true ? true : v === 'maybe' ? 'maybe' : null);
  const pressedNow = h => h.pressed === true || h.pressed === 'maybe';
  // `silent`: the ending is not the tool's own word (the bot's own "nothing more was heard",
  // or the PC link's "the tool has gone"). Only then does an order to pay that went out and was
  // never answered count for anything: the tool's own endings say for themselves whether it pressed.
  const pressedSoFar = (h, silent) => (pressedNow(h) ? h.pressed : silent && (h.payState === 'told' || h.payState === 'paying') ? 'unheard' : false);
  // An order to pay that has not gone out to the PC (any more): the sealed code goes, and with it
  // the order. Nothing was sent, so nothing was pressed, and Pay may be asked for again.
  function withdrawPay(h, why) {
    h.paySealed = null;
    h.payState = 'lost';
    h.payFailed = why;
    log(`Hold: the order to pay for ${holdName(h)} was dropped (${why}).`);
  }
  function giveUpOn(h, end) {
    h.end = end;
    if (end === 'timeout') h.pressed = pressedSoFar(h, true);
    if (h.payState === 'asked') withdrawPay(h, 'the hold ended before your PC could be told');
    // A PC that still has a hold given up on here is told to let it go: never one for which
    // Pay was pressed, may have been, or was ordered and not answered.
    if (!h.pressed) {
      gaveUp.add(h.id);
      if (gaveUp.size > 50) gaveUp.delete(gaveUp.values().next().value);
    }
    holdEnded(h);
  }
  // How a hold ended, as a note for the app: the card's own words about the ending, whoever
  // started the hold. (Said again if the PC's own word later replaces an ending assumed here.)
  function holdEnded(h) {
    try {
      const [, ...lines] = UI.indoorHold(ctx(), h).caption.split('\n').map(A.plain);
      note('hold', `${h.end === 'booked' ? 'Booked' : 'Hold ended'} · ${G.CENTRES[h.key].name} court ${h.court}`,
        `${label(civilOf(h.date))} · ${hhmm(h.start)}–${hhmm(h.start + 60)}. ${lines.join(' ')}`);
    } catch (e) {
      log(`Could not keep a note about the hold: ${e.message}`);
    }
  }
  // Until when Glasgow Club's site is to be left alone by your PC: it met a "checking your
  // browser" page there, holding a court or reading the sheet. 0 when it is not.
  function siteQuietUntil(t) {
    const seen = indoor.health();
    const look = seen && !seen.ok && seen.via === 'pc' && (seen.why === 'challenge' || seen.why === 'limit') ? seen.at + HOLD_QUIET_MS : 0;
    const until = Math.max(holdQuiet, look);
    return t < until ? until : 0;
  }
  // What stands in the way of a new hold: { toast, say, wake, busy }, or null.
  function holdBlocker(t) {
    if (!linked) return { toast: 'Your PC is not linked to me.', say: 'Your PC is not linked to me, and it is your PC that signs in and holds the court.' };
    if (holdLive(t)) return { toast: 'Your PC is already holding a court.', busy: true };
    if (pcState(t) !== 'awake') {
      return { toast: 'Your PC is not awake.', say: 'Your PC is not awake, and it is your PC that signs in to Glasgow Club and holds the court. Wake it and try again.', wake: wakeState() === 'ready' };
    }
    if (nearHoldGuard(t)) {
      const from = (releaseMin - HOLD_BEFORE_MS / 60000 + 1440) % 1440, to = (releaseMin + HOLD_AFTER_MS / 60000) % 1440;
      return { toast: 'Not around the nightly booking run.', say: `Your PC's nightly booking run is at ${hhmm(releaseMin)}, so it holds nothing else from ${hhmm(from)} to ${hhmm(to)}. The sheet below still opens.` };
    }
    const quietUntil = siteQuietUntil(t);
    if (quietUntil) return { toast: 'Glasgow Club is checking visitors.', say: `Glasgow Club's site was checking visitors from your home connection, so your PC is leaving it alone until ${clock(quietUntil)}.` };
    holdStarts = holdStarts.filter(at => t - at < 60 * 60 * 1000);
    if (holdStarts.length >= HOLD_PER_HOUR) {
      return { toast: 'Too many holds this hour.', say: `That is ${HOLD_PER_HOUR} holds within an hour, and each is a sign-in to Glasgow Club. The next can start at ${clock(holdStarts[0] + 60 * 60 * 1000)}.` };
    }
    return null;
  }
  // Redraws a hold's card as the hold stands now. One at a time, in order; never throws.
  // A hold started from the app has no card (`cardless`) unless a Hold tap in Telegram brings
  // it one: until then there is nothing to redraw, and the app reads the hold from its state.
  function drawHold(h) {
    if (h.cardless) return Promise.resolve();
    h.draws = (h.draws || Promise.resolve()).then(async () => {
      h.redrawAt = null;
      h.card = await show(h.chat, UI.indoorHold(ctx(), h), h.card, { wide: h.wide });
    }).catch(err => {
      h.redrawAt = now() + (err && err.retryAfter ? err.retryAfter * 1000 : HOLD_REDRAW_MS);     // checkHold tries again then
      log(`Could not update the hold's card: ${err.message}`);
    });
    return h.draws;
  }
  // The checks behind the Hold button, and the start of a hold when nothing stands in the way.
  // The app goes through here as well. `where` says who asked and where the hold's card is:
  // { by: 'telegram' | 'app', chat, card, wide, cardless, stale }. Returns { bad: true } (not a
  // time on offer), { old: true } (`stale`: asked by the app for a court no recent look showed it
  // free), { no } (what holdBlocker said) or { h } (the hold, now waiting for the PC's ping).
  function holdStart(key, dateIso, start, court, where) {
    const t = now(), date = civilOf(dateIso), today = todayCivil(t);
    if (iso(date) !== dateIso || date < today || date > addDays(today, UI.INDOOR_DAYS - 1) || !(court >= 1 && court <= 20)
      || !(start >= 0 && start <= 23 * 60 && start % 5 === 0) || londonInstant(date, start) <= t) return { bad: true };
    if (where.stale) return { old: true };                               // from the app, for a court no recent look showed it free
    const no = holdBlocker(t);
    if (no) return { no };
    if (hold && !hold.end) {                                             // one that went silent long ago: it is over, and a PC that still has it lets go
      giveUpOn(hold, 'timeout');
      drawHold(hold);
    }
    // ...unless Pay was pressed for it, may have been, or was ordered and never answered: that
    // one is followed to its end on its own card, whatever is held next.
    if (hold && hold.pressed) {
      former.set(hold.id, hold);
      if (former.size > 3) former.delete(former.keys().next().value);
    }
    const h = { id: crypto.randomBytes(6).toString('hex'), by: where.by, chat: where.chat, card: where.card, wide: where.wide, cardless: !!where.cardless,
      key, date: dateIso, start, court, at: t, heard: t,
      taken: false, takenAt: null, stage: 'asked', end: null, order: null, price: '', heldAt: null, until: null, why: '', basket: '', removed: null, words: '', checked: false, silent: false, draws: null, redrawAt: null,
      // Paying from the app. `pay`: what the PC says with each of its notes in the basket:
      // 'ready' (it can pay for this one), 'off' or 'failed' (it cannot, or it tried and could
      // not: `payWhy`), or '' (it said nothing: an older PC). `payState`: null; 'asked' (the app
      // asked at `payAskedAt`, and the order waits for the PC's next note, with its sealed code in
      // `paySealed`); 'told' (it went to the PC at `payToldAt`, and the sealed code is no longer
      // kept here); 'paying' (the PC said it is paying); 'failed' (the PC said it could not, and
      // did not press Pay: `payFailed`); 'lost' (it never reached the PC, or the PC did not take
      // it up: `payFailed`. Nothing was pressed, and Pay may be asked for again). `payAmount`: the
      // amount confirmed in the app. `pressedAt`: when a press was heard of here. `payDoubt`: why
      // a press is only "maybe". `payWords`: what the payment page said after the press.
      // `pressed`: what is known of a press (PRESS_RANK). `bank`: with an ending, 'approve' (your
      // bank's approval had not come) or 'code' (it asked for a code, which the PC never types).
      // `payAfter`: notes from the basket heard since the order went to the PC, saying nothing of it.
      pay: '', payWhy: '', payState: null, payAmount: '', paySealed: null, payAskedAt: null, payToldAt: null, payQuiet: false, payAfter: 0, payFailed: '',
      payDoubt: '', payWords: '', pressedAt: null, pressed: false, bank: '' };
    hold = h;
    holdStarts.push(t);
    log(`Hold asked for: ${holdName(h)}.`);
    for (const w of [...waiters].reverse()) w.wake();                    // the newest ping first, as for a look
    return { h };
  }
  // "Hold court N" was tapped (gh). The tap is answered, the PC's waiting ping is woken, and
  // the card says what is going on; everything after that comes from the PC.
  async function holdTap(q, chat, m, answer, newCard) {
    const [, key, d, hmText, courtText] = m;
    const dateIso = UI.fromD8(d), start = UI.fromHm(hmText), court = Number(courtText);
    const wide = typeof q.message.text === 'string' && !newCard;
    const card = newCard ? null : q.message.message_id;
    const r = holdStart(key, dateIso, start, court, { by: 'telegram', chat, card, wide });
    if (r.bad) {
      await answer(TIME_GONE);
      await show(chat, UI.indoorDays(ctx(), key), card, { wide });
      return;
    }
    if (r.no) {
      const no = r.no;
      await answer(no.toast);
      if (!no.busy) await show(chat, UI.indoorHoldNo(ctx(), key, dateIso, start, court, no), card, { wide });
      else if (hold.cardless || hold.card !== card) {                    // the hold's own card may be far up the chat by now, or it was started from the app and has none: it moves here
        hold.cardless = false;
        hold.chat = chat;
        hold.card = card;
        hold.wide = wide;
        await drawHold(hold);
      }
      return;
    }
    await answer('Asking your PC');
    await drawHold(r.h);
  }
  // "Let it go" or "Stop" (gx: release) and "I have paid" (gp: done) on a hold's card, or the
  // same asked by the app. The PC hears of it on its next note, a few seconds on. `ok` says
  // the order was taken; without it the toast says why not. While your PC pays, neither is
  // taken: it is at the payment page, and only it can say how that ends.
  function holdOrder(id, what) {
    const h = hold;
    if (!h || h.id !== id) return { toast: 'I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up.' };
    if (h.end) return { toast: 'That hold is over.' };
    if (pressedNow(h)) return { toast: h.pressed === true ? 'Your PC has pressed Pay. Wait for the answer.' : 'Your PC may have pressed Pay. Wait for the answer.' };
    if (PAYING.includes(h.stage) || h.payState === 'paying') return { toast: 'Your PC is paying for it. Wait for its answer.' };
    if (h.payState === 'told') return { toast: 'Your PC has been told to pay. Wait for its answer.' };
    if (what === 'done' && h.stage !== 'held') return { toast: 'It is not in your basket yet.' };      // "I have paid" says nothing until there is something to pay for, and never stops a hold
    if (!h.taken) {                                                      // the PC has not collected it: nothing to undo
      giveUpOn(h, 'stopped');
      log('Hold stopped before the PC collected it.');
      drawHold(h);
      return { toast: 'Stopped', ok: true };
    }
    if (h.order) return { toast: h.order === 'release' ? 'Already letting it go.' : 'Already checking.' };
    // An order to pay that has not gone out to the PC yet is dropped by this tap: the PC is
    // never asked for both.
    if (h.payState === 'asked') withdrawPay(h, `you asked to ${what === 'done' ? 'check your Bookings page' : 'let it go'} before your PC had been told`);
    h.order = what;
    log(`Hold: you tapped ${what === 'done' ? 'I have paid' : 'Let it go'}.`);
    drawHold(h);
    return { toast: what === 'done' ? 'Checking your Bookings page' : 'Letting it go', ok: true };
  }
  // What stands in the way of an order to pay for the hold `h` now, from the app, in words, or
  // null. `can.pay` in the app's state is the same check. (The amount is checked on its own.)
  function payNo(h, t) {
    if (h.end) return 'That hold is over.';
    if (PAYING.includes(h.stage) || h.payState === 'paying' || pressedNow(h)) return 'Your PC is paying for it already.';
    if (h.payState === 'asked' || h.payState === 'told') return 'Your PC has been told to pay for it already.';
    if (h.payState === 'failed') return 'Your PC tried to pay for it once and could not, so it will not try again. Pay at your PC, or let it go.';
    if (h.stage !== 'held') return 'It is not in your basket yet.';
    if (h.order) return h.order === 'release' ? 'Already letting it go.' : 'Already checking.';
    if (cardAsk && cardAsk.kind === 'forget') return 'Your PC is forgetting its card.';
    if (cardAsk) return 'Your new card has not reached your PC yet. Try again in a moment.';
    if (!pcCard) return 'There is no card on your PC. Add one in the app first.';
    if (h.pay !== 'ready') return h.pay && h.payWhy ? `Your PC cannot pay for this court: ${h.payWhy}.` : 'Your PC has not said that it can pay for this court.';
    if (!h.price) return 'Your PC could not read the price, so it cannot pay for this court.';
    if (h.silent || t - h.heard >= HOLD_SILENT_MS) return 'I have not heard from your PC for over a minute, so I am not asking it to pay.';
    if (h.until && h.until - t < PAY_ROOM_MS) return 'Too little of the hold\'s time is left to pay for it from here. Pay at your PC, or let it go.';
    return null;
  }
  // Pay, from the app: the hold's id, the amount you confirmed there, and the card's security
  // code sealed for your PC. Taken only as payNo allows, and only for the price your PC read.
  // The order then waits for the PC's next note (a few seconds), PAY_ORDER_MS at most.
  function holdPay(id, amount, sealed) {
    const t = now(), h = hold;
    if (!h || h.id !== id) return { toast: 'I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up.' };
    const no = payNo(h, t);
    if (no) return { toast: no };
    if (amount !== h.price) return { toast: `The price is ${h.price}, not ${amount}. Look at it again before you pay.` };
    h.payState = 'asked';
    h.payAmount = amount;
    h.paySealed = sealed;
    h.payAskedAt = t;
    h.payToldAt = null;
    h.payQuiet = false;
    h.payAfter = 0;
    h.payFailed = '';
    log(`Hold: you asked in the app to pay ${amount} for ${holdName(h)} with the card your PC keeps.`);
    drawHold(h);
    return { ok: true };
  }

  // ---------- messages about holds that have no card to say it on ----------
  // Sent at once; if Telegram will not take one, the timer tries again, less and less often,
  // for about half an hour. A newer word about the same hold takes the place of an older one
  // that has not got through.
  const NOTE_TRIES = 40;
  const outbox = [];                    // { id, chat, scr, tries, nextAt, sending }
  function postNote(id, chat, scr, t) {
    for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].id === id && !outbox[i].sending) outbox.splice(i, 1);
    outbox.push({ id, chat, scr, tries: 0, nextAt: t, sending: false });
    return flushNotes(t);
  }
  async function flushNotes(t) {
    for (const item of [...outbox]) {
      if (item.sending || t < item.nextAt) continue;
      item.sending = true;
      try {
        await say(item.chat, item.scr.caption, { reply_markup: item.scr.keyboard });
        if (outbox.includes(item)) outbox.splice(outbox.indexOf(item), 1);
      } catch (err) {
        item.sending = false;
        item.tries++;
        log(`Could not tell you about a hold I am not following: ${err.message}`);
        if (item.tries >= NOTE_TRIES) {
          if (outbox.includes(item)) outbox.splice(outbox.indexOf(item), 1);
          log('Gave up on that message.');
        } else item.nextAt = now() + (err.retryAfter ? err.retryAfter * 1000 : Math.min(60000, retryMs * 2 ** Math.min(10, item.tries - 1)));
      }
    }
  }

  // A note about a hold this bot is not following: it restarted while the PC held the court
  // (holds are kept in memory only). Nothing can be done about such a hold from here, and its
  // card no longer changes. But if the PC says Pay was pressed for it, or may have been, that
  // is not to be lost: you are told so, in a message and as a note for the app, once while it
  // is still going and once when it has ended, in the words its card would have had. (A beat
  // comes every few seconds; neither is ever said twice.) The same once if the PC says it could
  // not pay: the old card may be standing at "Paying…".
  const noteText = v => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, 300);
  const BASKETS = ['empty', 'items', 'unclear', 'untouched', 'gone', 'still'];
  // What a note says of a press: on its way to paying ('paying', 'approve') and with an ending, in its `pressed`.
  const pressOf = (raw, stage) => (PAYING.includes(stage) || HOLD_ENDS.includes(stage) ? pressedSaid(raw.pressed) : null);
  const strangers = new Map();          // id -> { going, ended, failed: what has been said; pressed; court: which court, once a note has said }
  function strangerNote(raw, id, stage) {
    const t = now();
    const ending = HOLD_ENDS.includes(stage);
    const s = strangers.get(id) || { going: false, ended: false, failed: false, pressed: null, court: null };
    const said = pressOf(raw, stage);
    s.pressed = said ? stronger(s.pressed || false, said) : s.pressed;   // the PC link's "gone" may say nothing of a press: what an earlier note said stands
    const couldNot = !ending && stage === 'held' && raw.pay === 'failed' && !s.pressed;
    if (!s.pressed && !couldNot) return;
    if (!s.court && Object.prototype.hasOwnProperty.call(G.CENTRES, raw.key) && typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
      && !Number.isNaN(Date.parse(`${raw.date}T12:00:00Z`)) && Number.isInteger(raw.start) && raw.start >= 0 && raw.start <= 23 * 60 && Number.isInteger(raw.court) && raw.court >= 1 && raw.court <= 20) {
      s.court = { key: raw.key, date: raw.date, start: raw.start, court: raw.court };
    }
    strangers.set(id, s);
    if (strangers.size > 20) strangers.delete(strangers.keys().next().value);
    if (couldNot ? s.failed || s.ended : ending ? s.ended : s.going || s.ended) return;
    if (couldNot) s.failed = true; else if (ending) s.ended = true; else s.going = true;
    const scr = UI.indoorHoldStray(ctx(), { ...(s.court || {}), stage: 'held', pressed: s.pressed || false, end: ending ? stage : null, why: noteText(raw.why), words: noteText(raw.words),
      basket: BASKETS.includes(raw.basket) ? raw.basket : '', removed: null, checked: raw.checked === true, bank: ['approve', 'code'].includes(raw.bank) ? raw.bank : '',
      payFailed: couldNot ? noteText(raw.payWhy) || 'no reason was given' : '' });
    log(couldNot ? 'A hold I am not following: your PC says it could not pay for it. Told you so.'
      : `A hold I am not following ${ending ? `ended (${stage})` : 'is going on'}, and your PC says Pay ${s.pressed === 'maybe' ? 'may have been' : 'was'} pressed for it: told you so.`);
    // The same words as a note for the app, which has no hold to show them on either.
    const [, ...lines] = scr.caption.split('\n').map(A.plain);
    const where = s.court ? `${G.CENTRES[s.court.key].name} court ${s.court.court}` : 'a court your PC was holding';
    note('hold', `${ending ? (stage === 'booked' ? 'Booked' : 'Hold ended') : couldNot ? 'Not paid' : 'Paying'} · ${where}`,
      `${s.court ? `${label(civilOf(s.court.date))} · ${hhmm(s.court.start)}–${hhmm(s.court.start + 60)}. ` : ''}${lines.join(' ')}`);
    const chat = owner();
    if (chat !== null) postNote(id, chat, scr, t);
  }

  // A note from the PC's tool about a hold: a step, or how it ended. The answer carries what
  // you have asked for since. A hold given up on here is told to let go; one this bot does not
  // know (it restarted meanwhile) is left to run out by itself on the PC (see strangerNote).
  function holdFromAgent(raw) {
    const t = now();
    const id = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : null;
    const stage = raw && typeof raw === 'object' && typeof raw.stage === 'string' ? raw.stage : '';
    // What this very note says of a press. Whatever was decided here before, a hold whose PC
    // says Pay was pressed, or may have been, is never told to let go.
    const says = id ? pressOf(raw, stage) : null;
    if (says) gaveUp.delete(id);
    const h = hold && id === hold.id ? hold : (id && former.get(id)) || null;
    if (!h) {
      if (id && gaveUp.has(id)) return { ok: true, order: 'release' };
      if (id && /^[0-9a-f]{6,40}$/.test(id)) strangerNote(raw, id, stage);
      return { ok: true, unknown: true };
    }
    const ending = HOLD_ENDS.includes(stage);
    const text = noteText;
    // Over already. What the PC itself says of the ending replaces one this bot only assumed.
    if (h.end && !(ending && stage !== 'gone' && HOLD_OURS.includes(h.end))) {
      // ...and a press that is heard of only now (in a late note, or in the PC link's "gone",
      // which knows of the tool's note of a press) still goes on a card that was ended on a guess.
      if (says && HOLD_OURS.includes(h.end) && stronger(h.pressed, says) !== h.pressed) {
        h.pressed = says;
        h.pressedAt = h.pressedAt ?? t;
        log(`Hold: ${holdName(h)} was over here, and your PC now says Pay ${says === true ? 'was' : 'may have been'} pressed.`);
        drawHold(h);
      }
      return gaveUp.has(id) && !ending ? { ok: true, order: 'release' } : { ok: true };
    }
    state.lastSeen = t;                                                  // a note from the PC shows it is awake, as a ping does
    h.heard = t;
    let redraw = h.silent;
    h.silent = false;
    if (ending) {
      // Whether Pay was pressed. The tool's own word with its ending counts first; failing
      // that, what it said while the hold was going. "gone" is the PC link's word: the link
      // knows only whether the tool noted a press, so there the stronger of the two counts.
      const own = pressedSoFar(h, stage === 'gone');
      h.pressed = stage === 'gone' ? stronger(own, says || false) : says ?? own;
      h.end = stage;
      h.why = text(raw.why);
      h.words = text(raw.words);
      h.basket = BASKETS.includes(raw.basket) ? raw.basket : '';
      h.removed = Number.isInteger(raw.removed) && raw.removed >= 0 ? raw.removed : null;
      h.checked = raw.checked === true;
      h.bank = raw.bank === 'approve' || raw.bank === 'code' ? raw.bank : '';
      h.order = null;
      if (h.payState === 'asked') withdrawPay(h, 'the hold ended before your PC could be told');
      if (raw.kind === 'challenge') {                                    // the site was checking visitors: no holds, and no looks by the PC, for an hour
        holdQuiet = t + HOLD_QUIET_MS;
        if (indoor.turnedAway) indoor.turnedAway('pc', 'the site was checking its visitors when your PC went to hold a court');
      }
      log(`Hold ${stage}: ${holdName(h)}${h.why ? ` (${h.why})` : ''}${h.pressed ? `; Pay ${h.pressed === true ? 'was' : h.pressed === 'maybe' ? 'may have been' : 'was ordered and may have been'} pressed` : ''}.`);
      drawHold(h);
      holdEnded(h);
      return { ok: true };
    }
    const left = Number(raw.left);
    const newUntil = left > 0 && left <= 30 * 60 * 1000 ? t + left : null;
    if (PAYING.includes(stage)) {
      if (HOLD_STAGES.indexOf(h.stage) < HOLD_STAGES.indexOf('held')) return { ok: true };       // paying for a court that never reached the basket: not a note that makes sense
      // Paying: the PC took up the order (it says so before it types a key), pressed Pay (or
      // may have), or your bank wants you to approve the payment. A press, as first heard,
      // stands: a "may have" does not turn into a "pressed" on a later note, nor the other way.
      if (h.payState !== 'paying') {
        h.payState = 'paying';
        h.paySealed = null;
        h.payFailed = '';
        log(`Hold: your PC is paying${h.payAmount ? ` ${h.payAmount}` : ''} for ${holdName(h)}.`);
        redraw = true;
      }
      if (says && !pressedNow(h)) {
        h.pressed = says;
        h.pressedAt = t;
        h.payDoubt = says === 'maybe' ? text(raw.payWhy).slice(0, 160) : '';
        log(`Hold: your PC ${says === 'maybe' ? 'may have pressed' : 'pressed'} Pay for ${holdName(h)}${h.payAmount ? ` (${h.payAmount})` : ''}${h.payDoubt ? `: ${h.payDoubt}` : ''}.`);
        redraw = true;
      }
      if (HOLD_STAGES.indexOf(stage) > HOLD_STAGES.indexOf(h.stage)) {    // forwards only: paying, then approve
        h.stage = stage;
        if (stage === 'approve') log(`Hold: your bank wants you to approve the payment for ${holdName(h)}.`);
        redraw = true;
      }
      // The hold runs on the PC's clock while it pays: until when it waits for the answer.
      if (newUntil && (!h.until || Math.abs(newUntil - h.until) > 5000)) {
        if (!h.until || clock(newUntil) !== clock(h.until)) redraw = true;
        h.until = newUntil;
      }
      const words = text(raw.words);
      if (words && words !== h.payWords) { h.payWords = words; redraw = true; }
      if (redraw) drawHold(h);
      return { ok: true };
    }
    if (HOLD_STAGES.indexOf(stage) > HOLD_STAGES.indexOf(h.stage)) {      // forwards only ("asked" comes before them all)
      h.stage = stage;
      redraw = true;
      if (stage === 'held') {
        h.price = typeof raw.price === 'string' && /^£\d{1,4}(\.\d\d)?$/.test(raw.price) ? raw.price : '';
        h.heldAt = t;
        h.until = newUntil || t + 12 * 60 * 1000;
        log(`Hold: ${holdName(h)} is in the basket${h.price ? ` (${h.price})` : ''}.`);
      }
    } else if (stage === 'held' && PAYING.includes(h.stage) && !pressedNow(h) && raw.pay === 'failed') {
      // The PC stopped before it pressed Pay: back in the basket, unpaid, as it was.
      h.stage = 'held';
      redraw = true;
    }
    if (stage === 'held' && h.stage === 'held') {
      // What the PC says, with each of its notes in the basket, about paying for this court
      // from the app: it can ('ready'), it cannot ('off', and why), or it tried and could not.
      const pay = ['ready', 'off', 'failed'].includes(raw.pay) ? raw.pay : '';
      const payWhy = pay && pay !== 'ready' ? text(raw.payWhy).slice(0, 200) : '';
      if (pay !== h.pay || payWhy !== h.payWhy) {
        if (pay !== h.pay) log(`Hold: your PC ${pay === 'ready' ? 'can pay for' : pay ? `cannot pay for` : 'says nothing about paying for'} ${holdName(h)}${payWhy ? ` (${payWhy})` : ''}.`);
        h.pay = pay;
        h.payWhy = payWhy;
        redraw = true;
      }
      if (h.payState === 'told' || h.payState === 'paying') {
        // Told to pay, the PC is back with a note from the basket: it could not (and says why),
        // or the order never reached it. Either way it did not press Pay. A PC that took the
        // order up says so before anything else, so two notes from the basket that say nothing
        // of it mean it never got there. (One alone may be an older note that was slow on the
        // way, overtaken by the one that took the order.)
        if (pay === 'failed') {
          h.payState = 'failed';
          h.payFailed = payWhy || 'no reason was given';
          log(`Hold: your PC could not pay for ${holdName(h)} (${h.payFailed}).`);
          redraw = true;
        } else if (h.payState === 'told' && ++h.payAfter >= 2) {
          withdrawPay(h, 'your PC did not get the order to pay');
          redraw = true;
        }
      }
      if (h.payState === 'asked' && pay !== 'ready') {
        // Asked for while the PC could pay, and now it says it cannot: the order is not sent.
        withdrawPay(h, payWhy ? `your PC cannot pay for this court just now: ${payWhy}` : 'your PC cannot pay for this court just now');
        redraw = true;
      }
      if (h.payState === 'asked' && h.paySealed) {
        // The order goes with this answer, once, and its sealed code is not kept here a moment longer.
        const out = { ok: true, order: 'pay', amount: h.payAmount, sealed: h.paySealed };
        h.paySealed = null;
        h.payState = 'told';
        h.payToldAt = t;
        log(`Hold: the order to pay ${h.payAmount} for ${holdName(h)} went to your PC.`);
        drawHold(h);
        return out;
      }
    }
    if (redraw) drawHold(h);
    return h.order ? { ok: true, order: h.order } : { ok: true };
  }
  // Looked at by the timer: a hold the PC never collected, one it has gone silent on, one that
  // has run past any time it could still be going, and an order to pay that has not gone out.
  async function checkHold(t) {
    // The last word on the card of a hold that has made way for another, if it did not get there.
    for (const f of former.values()) if (f !== hold && f.redrawAt && t >= f.redrawAt) await drawHold(f);
    const h = hold;
    if (!h) return;
    if (h.redrawAt && t >= h.redrawAt) await drawHold(h);                // the last redraw did not get through
    if (h.end) return;
    if (!h.taken) {
      if (t - h.at < pcHoldMs) return;
      giveUpOn(h, 'nopickup');
      log('Your PC did not collect the court to hold in time.');
      await drawHold(h);
      return;
    }
    if (h.stage === 'asked' && t - h.takenAt >= HOLD_START_MS) {         // collected, and then nothing: the tool never started
      giveUpOn(h, 'nostart');
      log(`Hold: your PC collected ${holdName(h)} but never started on it.`);
      await drawHold(h);
      return;
    }
    if (t >= (h.until ? h.until + HOLD_AFTER_END_MS : h.at + HOLD_SETUP_MS)) {
      giveUpOn(h, 'timeout');
      log(`Hold: nothing more was heard about ${holdName(h)}.`);
      await drawHold(h);
      return;
    }
    // An order to pay that the PC has not come for within half a minute is dropped unsent:
    // nothing was pressed, and it may be asked for again. One that went out and has not been
    // answered within half a minute: the card says so.
    if (h.payState === 'asked' && t - h.payAskedAt > PAY_ORDER_MS) {
      withdrawPay(h, 'your PC did not come for it within half a minute');
      await drawHold(h);
    }
    if (h.payState === 'told' && !h.payQuiet && t - h.payToldAt > PAY_TOLD_MS) {
      h.payQuiet = true;
      log(`Hold: your PC was told to pay for ${holdName(h)} and has not said how it went.`);
      await drawHold(h);
    }
    const silent = h.stage !== 'asked' && t - h.heard >= HOLD_SILENT_MS;        // before its first step, "never started" covers it
    if (silent !== h.silent) {
      h.silent = silent;
      if (silent) log('Hold: no word from your PC for over a minute.');
      await drawHold(h);
    }
  }

  // ---------- your card, for paying from the app ----------
  // The card is typed into the iPhone app and sealed there for your PC's card key: an X25519
  // key the PC makes once and keeps to itself, protected by Windows. The public half comes with
  // every ping (`cardKey`), and the app is shown it as pc.cardKey. The bot cannot open what is
  // sealed: it looks at the size and the shape, hands it to the PC with the PC's next ping, and
  // drops it. It is never written to the log or to disk, and is kept in memory only until then:
  // one at a time, a newer one in its place, CARD_ASK_MS at most. The PC opens it, checks it and
  // keeps it, protected by Windows; its pings say which card it keeps (brand, last four digits,
  // expiry: `pcCard`), and the one after the card says how it went. Forgetting the card goes the
  // same way, without a box. None of this is kept across a restart: the PC's next ping says it all again.
  const CARD_ASK_MS = 2 * 60 * 1000;                  // a card waits this long for the PC to collect it...
  const CARD_ANSWER_MS = 2 * 60 * 1000;               // ...and a card or a forget, once collected, this long for the PC's answer
  let cardKey = null;                                 // the PC's card key, as its last ping gave it (base64), or null
  let pcCard = null;                                  // the card the PC keeps, as its last ping said: { brand, last4, expMonth, expYear }, or null
  let pcCardSaid = false;                             // whether a ping has said which card it keeps (since this start)
  let cardAsk = null;                                 // waiting for the PC: { id, kind: 'card' | 'forget', sealed, at, takenAt }
  let cardWhy = null;                                 // why the last card (or forget) did not go through, in words, for the app
  const payingNow = () => !!hold && !hold.end && (PAYING.includes(hold.stage) || ['asked', 'told', 'paying'].includes(hold.payState));
  // What stands in the way of a card (`kind` 'card') or a forget now, in words, or null.
  function cardNo(kind, t) {
    if (!linked) return 'Your PC is not linked to me, and it is your PC that keeps the card.';
    if (payingNow()) return 'Your PC is paying for a court just now. Try again once that is over.';
    if (kind === 'forget') return null;
    if (!cardKey) return 'Your PC has not given me its card key yet. It does with every ping while it is awake: wake it, or wait a minute, then try again.';
    if (pcState(t) !== 'awake') return 'Your PC is not awake, and it is your PC that keeps the card. Wake it and try again.';
    return null;
  }
  // POST /app/card: a card, sealed by the app for your PC's card key, passed on as it came.
  function cardFromApp(sealed) {
    const t = now();
    const no = cardNo('card', t);
    if (no) return { no };
    if (cardAsk) log(cardAsk.kind === 'card' ? 'A newer card from the app takes the place of one still waiting for your PC.' : 'A card from the app takes the place of an order to forget the card.');
    cardAsk = { id: crypto.randomBytes(6).toString('hex'), kind: 'card', sealed, at: t, takenAt: null };
    cardWhy = null;
    log('A card from the app, sealed for your PC, is waiting for it.');
    for (const w of [...waiters].reverse()) w.wake();                    // the newest ping first, as for a look
    return { ok: true };
  }
  // POST /app/card/forget: your PC is to delete the card it keeps. A card that has not reached
  // the PC yet goes at once, unseen by it.
  function forgetFromApp() {
    const t = now();
    const no = cardNo('forget', t);
    if (no) return { no };
    if (cardAsk && cardAsk.kind === 'card' && !cardAsk.takenAt) {
      cardAsk = null;
      cardWhy = null;
      log('A card from the app that had not reached your PC was dropped: forgetting it was asked for.');
      if (pcCardSaid && !pcCard) return { ok: true };                    // and the PC keeps none: nothing more to do
    } else if (!cardAsk && pcCardSaid && !pcCard) return { no: 'Your PC keeps no card.' };
    cardAsk = { id: crypto.randomBytes(6).toString('hex'), kind: 'forget', sealed: null, at: t, takenAt: null };
    cardWhy = null;
    log('Asked your PC to forget the card it keeps.');
    for (const w of [...waiters].reverse()) w.wake();
    return { ok: true };
  }
  // A card or a forget for the PC's ping to collect: { card: { id, sealed } } or
  // { forgetCard: { id } }, once; or null.
  function takeCard(t) {
    if (!cardAsk || cardAsk.takenAt) return null;
    if (cardAsk.kind === 'card' && t - cardAsk.at > CARD_ASK_MS) { checkCard(t); return null; }          // too old to hand over: dropped
    cardAsk.takenAt = t;
    if (cardAsk.kind === 'forget') {
      log('Your PC collected the order to forget its card.');
      return { forgetCard: { id: cardAsk.id } };
    }
    const sealed = cardAsk.sealed;
    cardAsk.sealed = null;                                               // handed over: not kept here a moment longer
    log('Your PC collected the card from the app.');
    return { card: { id: cardAsk.id, sealed } };
  }
  // What a ping says about the card: the PC's key, the card it keeps, and how the last card or
  // forget went (`done`, for the id it was handed). Each is checked; what does not read is left
  // as it was. `has` says whether the ping said which card it keeps at all (an older PC does not).
  function cardFromPc(c) {
    if (!c || typeof c !== 'object') return;
    const key = A.cleanKey(c.key);
    if (key && key !== cardKey) {
      log(cardKey ? 'Your PC has a new card key.' : 'Your PC gave me its card key.');
      cardKey = key;
    }
    if (c.has) {
      const kept = A.cleanCard(c.kept);
      if (kept !== undefined) { pcCard = kept; pcCardSaid = true; }
    }
    const done = c.done;
    if (!done || typeof done !== 'object' || typeof done.ok !== 'boolean' || !cardAsk || !cardAsk.takenAt || done.id !== cardAsk.id) return;      // one this bot is not waiting for (a repeat, or from before a restart)
    const card = cardAsk.kind === 'card';
    if (done.ok === true) {
      log(card ? `Your PC kept the card from the app${pcCard ? ` (${pcCard.brand} ending ${pcCard.last4})` : ''}.` : 'Your PC forgot its card.');
      cardWhy = null;
    } else {
      const why = noteText(A.plain(done.why)).slice(0, 200) || 'no reason was given';
      cardWhy = card ? `Your PC did not keep that card: ${why}.` : `Your PC could not forget its card: ${why}.`;
      log(cardWhy);
    }
    cardAsk = null;
  }
  // Looked at by the timer: a card the PC has not collected, or has not answered for, in time.
  function checkCard(t) {
    if (!cardAsk) return;
    if (!cardAsk.takenAt && cardAsk.kind === 'card' && t - cardAsk.at > CARD_ASK_MS) {
      cardAsk = null;
      cardWhy = 'Your PC did not collect the card within two minutes, so I dropped it. Send it again while your PC is awake.';
      log('A card from the app was not collected by your PC within two minutes, and was dropped.');
    } else if (cardAsk.takenAt && t - cardAsk.takenAt > CARD_ANSWER_MS) {
      cardWhy = cardAsk.kind === 'card' ? 'Your PC took the card but did not say whether it kept it. The card shown here is the one your PC says it keeps.'
        : 'Your PC took the order to forget its card but did not say how that went. The card shown here is the one your PC says it keeps.';
      log('Your PC did not say how the card from the app went.');
      cardAsk = null;
    }
  }
  // The card for the app's state: null when your PC keeps none (as far as I know), nothing is
  // on its way, and there is nothing to say.
  function cardView() {
    if (!pcCard && !cardAsk && !cardWhy) return null;
    return {
      brand: pcCard ? pcCard.brand : null, last4: pcCard ? pcCard.last4 : null, expMonth: pcCard ? pcCard.expMonth : null, expYear: pcCard ? pcCard.expYear : null,
      pending: !!cardAsk && cardAsk.kind === 'card', forgetting: !!cardAsk && cardAsk.kind === 'forget', why: cardWhy,
    };
  }
  // How many sealed boxes this bot holds in memory just now (0, 1 or 2): for the tests, which
  // check that each is dropped once handed over, replaced, or given up on.
  const sealedHeld = () => (cardAsk && cardAsk.sealed ? 1 : 0) + [hold, ...former.values()].filter(h => h && h.paySealed).length;

  // A trial of a wider banner: a text message with the banner as a large link preview (the page
  // at /card/<kind> on this server names the picture). Telegram fetches it from RAILWAY_PUBLIC_DOMAIN.
  const publicHost = String(env.PUBLIC_HOST || env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const previewOf = kind => (publicHost && pictures && pictures[kind]
    ? { url: `https://${publicHost}/card/${kind}?v=${pictures[kind].hash}`, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true });

  // ---------- the tap-through screens ----------
  const ctx = () => ({ cfg: cfg(), now: now(), paused: state.paused, results: state.results, lastSeen: state.lastSeen, linked, pc: pcState(), wake: wakeState(), wokeAt, sleepAsk, card: pcCard });
  const statusInfo = () => ({
    version: VERSION, skewMs: tg.skewMs ? tg.skewMs() : null, kept: kept(), paused: state.paused,
    linked, lastSeen: state.lastSeen, lastSeenDay: state.lastSeen ? todayCivil(state.lastSeen) : null, pc: pcState(),
    wake: wakeState(), wokeAt, indoor: indoor.health(), phones: state.apps.length,
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
  // Shows a screen: on the card the button was on, or as a new card. Returns the id of the card
  // it is on now, so a second screen can follow on the same one.
  async function show(chat, scr, messageId = null, { view = null, wide = false } = {}) {
    const card = { kind: homeKind(), wide, caption: scr.caption, keyboard: scr.keyboard, view };
    if (messageId) {
      try { await drawOn(chat, messageId, card); return messageId; } catch (err) {
        if (err.code !== 400) throw err;       // e.g. a message Telegram will not change: a new card instead
      }
    }
    const sent = wide
      ? await say(chat, scr.caption, { link_preview_options: previewOf(card.kind), reply_markup: scr.keyboard })
      : await sendCard(chat, card.kind, scr.caption, scr.keyboard);
    const id = (sent && sent.message_id) || null;
    track(chat, id, card, true);
    return id;
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

  // ---------- what you ask for ----------
  // The changes behind the commands, the buttons and the app, so that all three do the same
  // thing with the same checks. What is said about each is the caller's business.
  // A one-off Kelvingrove date: { no } with the sentence that refuses it (`full`: because the
  // list holds as many as it may), { already: true } when that date and time are on the list,
  // or { added: true }.
  function addOnce(dateIso, start, hours, t) {
    const date = civilOf(dateIso), today = todayCivil(t);
    if (date < today || londonInstant(date, start) <= t) return { no: `${label(date)} at ${hhmm(start)} has already passed.` };
    if (date > addDays(today, MAX_AHEAD_DAYS)) return { no: `That is more than ${MAX_AHEAD_DAYS} days away. Try a nearer date.` };
    if (state.once.some(o => o.date === dateIso && o.start === start)) return { already: true };
    if (state.once.length >= MAX_ONCE) return { no: `Your list already has ${MAX_ONCE} one-off dates, which is as many as I keep. Remove one first.`, full: true };
    state.once = cleanOnce([...state.once, { date: dateIso, start, hours }]); save();
    return { added: true };
  }
  // Takes a one-off off the list. Returns it, or null if it was not there.
  function removeOnce(dateIso, start) {
    const gone = state.once.find(o => o.date === dateIso && o.start === start);
    state.once = state.once.filter(o => o !== gone); save();
    return gone || null;
  }
  function setWeekly(day, start, hours) { state.plan[day] = { start, hours }; save(); }
  // Stops a weekday ('all': every one). Says whether there was anything to stop.
  function stopWeekly(day) {
    const had = day === 'all' ? Object.keys(state.plan).length > 0 : !!state.plan[day];
    if (day === 'all') state.plan = {}; else delete state.plan[day];
    save();
    return had;
  }
  function setOrder(order) { state.order = order; save(); }
  function setPaused(paused) { state.paused = paused; save(); }

  const DAY_RE = '(sun|mon|tue|wed|thu|fri|sat)';
  // What a button does. Returns the screen to show next and a short note for the tap.
  function route(data) {
    let m;
    const c = ctx();
    if (data === 'noop') return {};
    if (data === 'h') return { screen: UI.home(c), view: 'h' };
    if (data === 'b') return { screen: UI.venues() };
    if (data === 'bk') return { screen: UI.calendar(c) };
    if ((m = /^g:([gs])$/.exec(data))) return { screen: UI.indoorDays(c, m[1]) };
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
      const r = addOnce(dateIso, start, hours, c.now);
      if (r.full) return { screen: UI.bookings(c), toast: r.no };          // the list is full: here it is, to remove one from
      if (r.no) return { screen: UI.calendar(c), toast: 'That time is no longer available. Pick again.' };
      if (r.already) return { screen: UI.added(c, dateIso, start, hours, true), toast: 'Already on your list' };
      log(`Added ${dateIso} ${hhmm(start)} by button`);
      return { screen: UI.added(ctx(), dateIso, start, hours), toast: 'Added' };
    }
    if ((m = /^x:(\d{8}):(\d{4})$/.exec(data))) {
      const dateIso = UI.fromD8(m[1]), start = UI.fromHm(m[2]);
      const gone = removeOnce(dateIso, start);
      return { screen: UI.bookings(ctx(), gone ? `Removed ${label(civilOf(dateIso))} · ${slotText(gone)}` : ''), toast: gone ? 'Removed' : 'Already gone' };
    }
    if (data === 'w') return { screen: UI.weekly(c) };
    if ((m = new RegExp(`^wd:${DAY_RE}$`).exec(data))) return { screen: UI.weeklyDay(c, m[1]) };
    if ((m = new RegExp(`^wt:${DAY_RE}$`).exec(data))) return { screen: UI.weeklyTimes(c, m[1]) };
    if ((m = new RegExp(`^wt:${DAY_RE}:(\\d{4})$`).exec(data))) return { screen: UI.weeklyLengths(c, m[1], UI.fromHm(m[2])) };
    if ((m = new RegExp(`^wl:${DAY_RE}:(\\d{4}):([12])$`).exec(data))) {
      const start = UI.fromHm(m[2]), hours = +m[3];
      if (start < UI.FIRST_START || start + hours * 60 > UI.LAST_END) return { screen: UI.weekly(c), toast: 'Pick a time between 09:00 and 21:00.' };
      setWeekly(m[1], start, hours);
      log(`Weekly ${m[1]} set by button`);
      return { screen: UI.weeklySaved(ctx(), m[1]), toast: 'Saved' };
    }
    if ((m = new RegExp(`^woff:${DAY_RE}$`).exec(data))) {
      stopWeekly(m[1]);
      return { screen: UI.weekly(ctx()), toast: `Stopped ${DAY_LONG[DAY_KEYS.indexOf(m[1])]}s` };
    }
    if (data === 'm') return { screen: UI.bookings(c) };
    if (data === 'o') return { screen: UI.order(c) };
    if ((m = /^o:([1-6]{1,6})$/.exec(data)) && new Set(m[1]).size === m[1].length) return { screen: UI.order(c, m[1]) };
    if ((m = /^os:([1-6]{1,6})$/.exec(data)) && new Set(m[1]).size === m[1].length) {
      setOrder(parseOrder(m[1].split('').join(' ')));
      return { screen: UI.home(ctx()), view: 'h', toast: `Court order: ${state.order.join(', ')}` };
    }
    if (data === 'p') {
      setPaused(!state.paused);
      return { screen: UI.home(ctx()), view: 'h', toast: state.paused ? 'Paused: nothing will be booked' : 'Booking is on' };
    }
    if (data === 's') return { screen: UI.status(c, statusInfo()), view: 's' };
    if (data === 'sl') return { screen: UI.sleepConfirm(c) };
    if (data === 'sl:ok') return requestSleep();
    if ((m = /^g([xp]):([0-9a-f]{12})$/.exec(data))) return holdOrder(m[2], m[1] === 'x' ? 'release' : 'done');
    return { toast: 'That button is out of date. Send /menu.' };
  }

  // ---------- indoor courts (Glasgow Club) ----------
  // A day at a centre (gd, or gr to read it afresh) or one start time on it (gt). These wait
  // for Glasgow Club's site (twelve seconds at the very most), so the tap is answered first and
  // the card says it is reading. `newCard`: leave the tapped message as it is and open a card.
  async function indoorTap(q, chat, m, answer, newCard) {
    const [, kind, key, d, hmText] = m;
    const dateIso = UI.fromD8(d), date = civilOf(dateIso), today = todayCivil(now());
    const wide = typeof q.message.text === 'string' && !newCard;
    // The card being drawn on. If Telegram will not change it, a new card takes over, and what
    // follows goes on that one.
    let id = newCard ? null : q.message.message_id;
    const draw = async scr => { id = await show(chat, scr, id, { wide }); };
    if (iso(date) !== dateIso || date < today || date > addDays(today, UI.INDOOR_DAYS - 1) || (kind === 't') !== !!hmText) {
      await answer(DAY_GONE);
      await draw(UI.indoorDays(ctx(), key));
      return;
    }
    await answer();
    const again = kind === 'r';
    if (!indoor.peek(key, dateIso, { fresh: again })) await draw(UI.indoorWait(ctx(), key, dateIso));
    let got = null, err = null;
    try { got = await readIndoor(key, dateIso, again); } catch (e) { err = e; }
    if (kind === 't' && got) {
      const start = UI.fromHm(hmText);
      const scr = UI.indoorSlot(ctx(), key, dateIso, start, got);
      await draw(scr || UI.indoorDay(ctx(), key, dateIso, got, null, `No court is free at ${hhmm(start)} any more.`));
      return;
    }
    await draw(UI.indoorDay(ctx(), key, dateIso, got, err));
  }
  // On start-up: can this server itself read Glasgow Club? One read, said in the log.
  async function checkIndoor() {
    const dateIso = iso(addDays(todayCivil(now()), 1));
    try {
      const got = await indoor.day('g', dateIso);
      log(`Glasgow Club answers from here: Gorbals on ${label(civilOf(dateIso))} has ${new Set(got.slots.map(s => s.start)).size} start times with a free court.`);
      return true;
    } catch (err) {
      log(`Glasgow Club does not answer from here (${err.kind || 'odd'}). ${linked ? 'Your PC reads its free courts instead, while it is awake' : 'The indoor screens still hand over the link to its sheet, without the free courts'}.`);
      return false;
    }
  }
  // Once after each start: when this server cannot read Glasgow Club itself, try the way by
  // your PC, on the first of its pings that can carry the question, and say in the log how it
  // went. Nothing is asked while you are waiting on a look of your own, while a request to
  // sleep is waiting for the PC, or around its nightly booking run.
  let pcTried = false;
  function tryPcOnce(t) {
    if (pcTried || lookAsk || sleepAsk !== null || !linked || pcState(t) !== 'awake') return;
    const direct = indoor.health();
    if (!direct || direct.ok || direct.via === 'pc') return;                 // not looked from here yet, or no need
    if (nearRun(t)) return;
    pcTried = true;
    const dateIso = iso(addDays(todayCivil(t), 1));
    indoor.day('g', dateIso, { via: askPc }).then(
      got => log(`Your PC read Glasgow Club for me: Gorbals on ${label(civilOf(dateIso))} has ${new Set(got.slots.map(s => s.start)).size} start times with a free court.`),
      err => log(`Your PC could not read Glasgow Club for me (${err.kind || 'odd'}): ${err.message}.`));
  }

  // A button was tapped. Only the owner's taps count.
  async function handleTap(q) {
    const chat = q.message && q.message.chat ? q.message.chat.id : null;
    const answer = text => Promise.resolve().then(() => tg.answer(q.id, text)).catch(() => {});
    if (chat === null || owner() === null || chat !== owner()) { await answer('This bot is private.'); return; }
    let data = String(q.data || '');
    const fresh = data.startsWith('n:');                                   // on a booking message: keep it, open a new card
    if (fresh) data = data.slice(2);
    const indoorMatch = /^g([drt]):([gs]):(\d{8})(?::(\d{4}))?$/.exec(data);
    const holdMatch = /^gh:([gs]):(\d{8}):(\d{4}):(\d{1,2})$/.exec(data);
    if (indoorMatch || holdMatch) {
      // A tap can be answered once. If something fails after that, the word goes as a message.
      let answered = false;
      const once = text => { if (answered) return Promise.resolve(); answered = true; return answer(text); };
      try { await (holdMatch ? holdTap(q, chat, holdMatch, once, fresh) : indoorTap(q, chat, indoorMatch, once, fresh)); } catch (e) {
        log(`Indoor button failed: ${e.message}`);
        if (!answered) await once('That did not work. Send /menu to start again.');
        else await say(chat, 'That did not work: I could not update the card. Send /menu to start again.').catch(() => {});
      }
      return;
    }
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
  // How the PC's booking run stands, as it last said, for the app: { stage, at, why }. "started"
  // when it asked what to book, "ready" once it has signed in, "trouble" while it tries again.
  let runNote = null;
  // What has been said is remembered for a few days, so nothing is said twice; then forgotten.
  const forgetOld = t => { for (const k of Object.keys(state.sent)) if (t - state.sent[k] > SENT_KEEP_MS) delete state.sent[k]; };
  function jobsForAgent(from = {}, { run } = {}) {
    const t = now();
    const starting = run !== false;
    state.lastSeen = t;
    if (starting) state.lastRun = t;
    if (starting) runNote = { stage: 'started', at: t, why: null };
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
        const text = M.headsUp(c, coming);
        card.sent = sendCard(card.chat, 'home-awake', text)
          .then(sent => {
            card.id = (sent && sent.message_id) || null; card.photo = !!(sent && sent.photo);
            const lines = text.split('\n').map(A.plain);         // the same card, as a note for the app
            note('info', lines[0], `${coming.map(j => M.slotOf(j)).join(' and ')}. ${lines[lines.length - 1]}`);
          })
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
  // `card` is what the ping says about the card for paying from the app: { key, has, kept, done }
  // (see cardFromPc), as lib/server.js reads it from the ping.
  async function pingFromAgent(from = {}, { wait = 0, refused = null, card = null } = {}) {
    state.lastSeen = now();
    noteHome(from);
    save();
    cardFromPc(card);
    if (refused) {                                    // asked to sleep, it would not: say why
      sleptAt = null;
      log(`Your PC stayed awake: ${refused}`);
      const chat = owner();
      if (chat !== null) {
        say(chat, `<b>Your PC stayed awake</b>\nIt did not go to sleep: ${M.esc(refused)}.`).catch(e => log(`Could not say so: ${e.message}`));
        note('info', 'Your PC stayed awake', `It did not go to sleep: ${refused}.`);
      }
    }
    if (wait > 0) tryPcOnce(now());
    let order = takeOrder(now());
    if (!order.sleep && !order.look && !order.hold && !order.card && !order.forgetCard && wait > 0) {
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
    let trouble = null;
    if (stage === 'trouble') {
      const why = String(raw.why || 'no reason given').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, 300);
      const text = M.troubleText(why, intIn(raw.attempt, 2, 9), intIn(raw.of, 2, 9));
      trouble = { why, text, about: noteOf(text, 2) };
    }
    runNote = { stage, at: now(), why: trouble ? trouble.about.body : null };
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
    await say(chat, trouble.text);
    note('warn', trouble.about.title, trouble.about.body);
    log(`Your PC reported trouble before the booking: ${trouble.why}`);
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
    if (!same && chat !== null) {                     // what the card said, as a note for the app
      if (r.status === 'booked') note('booked', `Court ${r.court} booked`, `${M.slotOf(r)} · ${r.gate ? `gate ${r.gate}` : 'gate code not shown'}`);
      else note('missed', 'Not booked', `${M.slotOf(r)}. ${A.plain(M.failedWhy(r))}`);
    }
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
        setWeekly(day, slot.start, slot.hours);
        const name = DAY_LONG[DAY_KEYS.indexOf(day)];
        await say(chat, `<b>${name}s · ${slotText(state.plan[day])}</b>\nBooked every week, ${daysAhead} days before at ${hhmm(releaseMin)}, when the day opens.\n\n${next()}${keepNote()}`);
        break;
      }

      case 'off': {
        if ((args[0] || '').toLowerCase() === 'all') { stopWeekly('all'); await say(chat, `Every weekly booking removed. One-off dates stay; see /plan.\n\n${next()}`); break; }
        const day = parseDay(args[0]);
        if (!day) { await say(chat, 'Use it like this:  /off thu   (or /off all)'); break; }
        const had = stopWeekly(day);
        await say(chat, `${had ? 'Removed' : 'There was no weekly booking for'} ${DAY_LONG[DAY_KEYS.indexOf(day)]}s.\n\n${next()}${keepNote()}`);
        break;
      }

      case 'gorbals':                                // the indoor courts (Glasgow Club): pick a day
      case 'scotstoun':
        await show(chat, UI.indoorDays(ctx(), cmd[0])); break;

      case 'book': {
        if (!args.length) { await show(chat, UI.venues()); break; }
        const usage = 'Use it like this:  /book 25 nov 19:00 2h\nA date (25 nov, 25/11, wed, tomorrow), a start time, then 1h or 2h.';
        const today = todayCivil(t);
        const got = parseBooking(args, today);
        if (!('date' in got)) { await say(chat, (got.why ? `${got.why}\n` : '') + usage); break; }
        const date = got.date;
        const added = addOnce(iso(date), got.start, got.hours, t);
        if (added.no) { await say(chat, added.no); break; }
        if (added.already) { await say(chat, `${label(date)} at ${hhmm(got.start)} is already on your list. See /plan.`); break; }
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
        setOrder(order);
        await say(chat, `Court order: ${order.join(', ')}`);
        break;
      }

      case 'backup':
        await say(chat, `Tap the line below to copy it, then save it in Railway as the variable COURT_SETTINGS. The bot starts from it whenever it has no saved settings, so update it after you change your plan.\n\n<code>${M.esc(backupLine(state))}</code>`); break;

      case 'pause':
        setPaused(true);
        await say(chat, 'Paused. Your PC will not book anything until you send /resume.'); break;

      case 'resume':
        setPaused(false);
        await say(chat, `Booking is on.\n\n${next()}`); break;

      case 'app': {                                  // link the iPhone app, or unlink every phone
        const word = (args[0] || '').toLowerCase();
        if (word === 'forget') {
          const n = state.apps.length;
          state.apps = [];
          pairing.cancel();
          save();
          if (n) log(`Unlinked ${n === 1 ? 'the phone' : `all ${n} phones`} linked to the app (/app forget).`);
          await say(chat, n ? `Unlinked ${n === 1 ? 'your phone' : `all ${n} phones`}: the app on ${n === 1 ? 'it' : 'them'} can no longer reach me. Send /app to link a phone again.` : 'No phone was linked. Send /app to link one.');
          break;
        }
        if (word) { await say(chat, 'Use it like this:  /app   (a code to link a phone)   or   /app forget   (unlink every phone)'); break; }
        if (!linked) { await say(chat, 'The app reaches me at the same address as your PC, and that only opens once your PC is linked. Add AGENT_PUBLIC_KEY in Railway first (see the README), then send /app again.'); break; }
        const { code } = pairing.issue(t);
        const names = state.apps.map(d => M.esc(d.name)).join(', ');
        await say(chat, [
          '<b>Link the iPhone app</b>',
          `Code: <code>${code}</code>  (tap to copy)`,
          'Type it into the app within 10 minutes. It works once, and five wrong tries cancel it. A new /app replaces it.',
          ...(publicHost ? [`If the app asks where I am: <code>https://${M.esc(publicHost)}</code>`] : []),
          'The app can do what you do here, and one thing more: pay for a court your PC holds, with the card your PC keeps.',
          state.apps.length >= A.MAX_DEVICES ? `${A.MAX_DEVICES} phones are linked already (${names}), and that is as many as I keep, so the app will be turned away. Unlink one in the app on that phone, or send /app forget to unlink them all.`
            : state.apps.length ? `Linked now: ${names}. /app forget unlinks every phone.` : 'No phone is linked yet.',
          ...(kept() === 'disk' ? [] : ['Note: without a Railway volume mounted at /data, the link to a phone is lost each time I restart.']),
        ].join('\n'));
        break;
      }

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
  // Sends a warning once (trying again after a failed send), and notes that it went. `make`
  // gives the warning's words: once sent, its first line and the two after it are kept as a
  // note for the app.
  async function warnOnce(key, t, make, send, noted) {
    if (state.sent[key] || (retryAt[key] && t < retryAt[key])) return;
    try {
      const text = make();
      await send(text);
      forgetOld(t);
      state.sent[key] = t;
      save();
      log(noted);
      const about = noteOf(text, 2);
      note('warn', about.title, about.body);
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
          await warnOnce(warned, t, () => M.notAnsweringText(cfg(), rel, null, !!state.lastSeen), text => sendCard(chat, 'home-offline', text, UI.afterNotAnswering(false)),
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
    await warnOnce(warned, t, () => M.notAnsweringText(cfg(), rel, tried), text => sendCard(chat, 'home-offline', text, UI.afterNotAnswering(true)),
      `Warned that the PC did not answer a wake-up ahead of ${label(rel.playDate)}'s booking`);
  }

  async function checkStarted(t, chat) {
    const rel = missingFor(t, cfg(), state.lastRun);
    if (!rel) return;
    const awake = pcState(t) === 'awake';
    await warnOnce(`missing:${rel.releaseAt}`, t, () => M.missingText(cfg(), rel, awake), text => sendCard(chat, 'home-offline', text, UI.afterMissing()),
      `Warned that the booking run has not started for ${label(rel.playDate)}${awake ? ' (the PC is awake)' : ''}`);
  }

  // Whether the PC has said how one of a release's bookings went: booked at any time, or any
  // result since about the time of the run.
  const reported = (rel, r) => { const got = state.results[r.id]; return !!got && (got.status === 'booked' || got.at >= rel.releaseAt - SEEN_FRESH_MS); };
  async function checkReported(t, chat) {
    const rel = releaseAround(t, cfg(), 0, NO_WORD_FOR_MS);
    // No run for this release at all: the "has not started" warning has already said so.
    if (!rel || !state.lastRun || state.lastRun < rel.releaseAt - SEEN_FRESH_MS) return;
    // The eight minutes run from the release, or from the last sign of life after it: the run
    // starting (or starting over), or the result for another of tonight's bookings.
    const results = rel.requests.map(r => (state.results[r.id] && state.results[r.id].at) || 0);
    if (t < Math.max(rel.releaseAt, state.lastRun, ...results) + NO_WORD_MS) return;
    const silent = rel.requests.filter(r => !reported(rel, r));
    if (!silent.length) return;
    await warnOnce(`noword:${rel.releaseAt}`, t, () => M.noWordText(silent), text => sendCard(chat, 'missed', text, UI.afterFailed()),
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
      await checkHold(t);
      checkCard(t);
      await flushNotes(t);
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

  // ---------- the iPhone app (docs/app-api.md) ----------
  // Another way in to what you already do in Telegram, over the HTTP server your PC talks to
  // (lib/server.js, under /app/). A phone is linked with a code from /app. After that it proves
  // itself with a token, of which only the SHA-256 is kept here (state.apps). Whatever it asks
  // is done by the function behind the Telegram command or button of the same name, so the
  // checks and the words are the same, and the app can do nothing you cannot do here but one
  // thing: Pay, with the card your PC keeps (the app alone has the card's security code).
  const pairing = A.createPairing();
  const pairLimiter = A.createLimiter();
  const lookLimiter = A.createLimiter(A.LOOKS_PER_MIN, A.LOOKS_WINDOW_MS);      // fresh reads asked for through the app, all phones together
  const appShown = new Map();                         // what a look last showed the app free: "g:2026-11-20" -> { at, free: Set("1080:3") }
  const appHello = () => ({ ok: true, bot: VERSION, api: A.API });

  // A phone gives the code from /app and is handed its token, once. Returns { status, body }.
  // Only a try against a code that is waiting counts towards the ten in ten minutes: with no
  // code to guess at there is nothing to protect, and a stranger's tries must not keep you out.
  function appPair(body) {
    const t = now();
    const b = body && typeof body === 'object' ? body : {};
    if (!pairing.waiting(t)) return { status: 400, body: { ok: false, why: pairing.check(b.code, t).why, left: 0 } };       // none, or expired
    if (!pairLimiter.allow(t)) return { status: 429, body: { ok: false, why: 'slow' } };
    const tried = pairing.check(b.code, t);
    if (tried.why) {
      if (tried.why === 'wrong') log(`A wrong code was tried for linking a phone (${tried.left} ${tried.left === 1 ? 'try' : 'tries'} left on it).`);
      return { status: 400, body: { ok: false, why: tried.why, left: tried.left } };
    }
    if (state.apps.length >= A.MAX_DEVICES) return { status: 400, body: { ok: false, why: 'full', left: tried.left } };
    let made;
    do { made = A.newDevice(b.name, t, owner()); } while (state.apps.some(d => d.id === made.device.id));      // an id of its own
    const { token, device } = made;
    state.apps.push(device);
    pairing.use();
    save();
    log(`A phone was linked to the app: ${device.name}.`);
    const chat = owner();
    if (chat !== null) {
      say(chat, `<b>Phone linked</b>\n${M.esc(device.name)} can now do what you do here, and pay for a court your PC holds with the card your PC keeps. /app forget unlinks every phone.`)
        .catch(e => log(`Could not say that a phone was linked: ${e.message}`));
    }
    return { status: 200, body: { ok: true, token, device: { id: device.id, name: device.name } } };
  }

  // The phone a token belongs to, as { id, name }, or null. When it was last heard from is
  // noted at most once a minute: that is part of the state, and so of its etag.
  function appAuth(token) {
    const d = A.findDevice(state.apps, token);
    if (!d || d.owner !== owner()) return null;
    const t = now();
    if (t - d.seenAt >= A.SEEN_EVERY_MS) { d.seenAt = t; save(); }
    return { id: d.id, name: d.name };
  }

  // How the PC's booking run stands, around a release: from half an hour before it to an hour
  // after, or until every booking of that release has been reported on. Otherwise null.
  function runNow(t) {
    if (!runNote || state.paused) return null;
    const rel = releaseAround(t, cfg(), HEADS_UP_MS, NO_WORD_FOR_MS);
    if (!rel || runNote.at < rel.releaseAt - HEADS_UP_MS || rel.requests.every(r => reported(rel, r))) return null;
    return { stage: runNote.stage, at: runNote.at, why: runNote.why };
  }

  // The hold being followed, or the last one, as the app sees it: the card's own words, and
  // which of its buttons Telegram would show now; and whether Pay from the app would be taken
  // now (payNo, the very check an order to pay goes through). Null if there has been none since the start.
  function holdView(x) {
    const h = hold;
    if (!h) return null;
    const centre = G.CENTRES[h.key];
    const scr = UI.indoorHold(x, h);
    const [title, ...lines] = scr.caption.split('\n').map(A.plain);
    const keys = scr.keyboard.inline_keyboard.flat().map(b => b.callback_data);
    return {
      id: h.id, startedBy: h.by, centre: h.key, centreName: centre.name, date: h.date, start: h.start, end: h.start + 60,
      court: h.court, courtName: `Court ${h.court}`, stage: h.stage, live: !h.end, ended: h.end,
      price: h.price || null, until: h.until, heardAt: h.heard, title, lines,
      can: { release: keys.includes(`gx:${h.id}`), done: keys.includes(`gp:${h.id}`), pay: payNo(h, x.now) === null },
      links: { basket: G.basketUrl, site: G.siteUrl, sheet: G.sheetUrl(centre, h.date) },
    };
  }

  // Everything the app shows, as it stands now. `meId` is the phone that asks.
  function buildState(meId) {
    const t = now(), c = cfg(), x = ctx(), today = todayCivil(t);
    const booking = !state.paused && owner() !== null;                   // while paused nothing is booked, so nothing is coming
    const releases = booking ? upcoming(t, c, 4) : [];
    const releaseOf = r => ({ at: r.releaseAt, night: iso(r.night), jobs: r.requests.map(j => ({ id: j.id, date: j.date, start: j.start, end: j.end, from: j.kind })) });
    const onceIds = new Set(state.once.map(o => jobId(o.date, o.start)));
    const open = booking ? jobsFor(t, c, state.results).filter(j => j.releaseAt <= t && onceIds.has(j.id)) : [];
    const byDay = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start);
    const results = Object.values(state.results).map(r => ({
      id: r.id, status: r.status, date: r.date, start: r.start, end: r.end, court: r.court ?? null, gate: r.gate ?? null,
      why: r.status === 'booked' ? null : A.plain(M.failedWhy(r)), at: r.at, past: civilOf(r.date) < today,
    })).sort((a, b) => (a.past !== b.past ? (a.past ? 1 : -1) : a.past ? byDay(b, a) : byDay(a, b)));
    const noWake = wakeBlocker(t), noSleep = sleepNo(t), noHold = holdBlocker(t), line = UI.pcLine(x);
    return {
      now: t, bot: VERSION,
      venue: { name: 'Kelvingrove Park', short: 'KP', first: UI.FIRST_START, last: UI.LAST_END, lengths: [1, 2], courts: [1, 2, 3, 4, 5, 6], releaseMin, daysAhead, maxAheadDays: MAX_AHEAD_DAYS },
      paused: state.paused,
      kept: kept(),
      pc: {
        state: x.pc, linked, seenAt: state.lastSeen, line: line ? A.plain(line) : null,
        canWake: !noWake, wakeWhy: noWake ? noWake.toast : null, canSleep: !noSleep, sleepWhy: noSleep,
        sleepAsked: sleepAsk !== null && t - sleepAsk <= SLEEP_ASK_MS ? sleepAsk : null, wokeAt, cardKey,
      },
      release: releases.length ? releaseOf(releases[0]) : null,
      later: releases.slice(1).map(releaseOf),
      open: open.map(j => ({ id: j.id, date: j.date, start: j.start, end: j.end })),
      plan: [1, 2, 3, 4, 5, 6, 0].map(i => DAY_KEYS[i]).filter(k => state.plan[k]).map(k => ({ day: k, start: state.plan[k].start, hours: state.plan[k].hours })),
      once: state.once.filter(o => londonInstant(civilOf(o.date), o.start) > t).map(o => {
        const opens = opensAt(civilOf(o.date), c);
        return { id: jobId(o.date, o.start), date: o.date, start: o.start, hours: o.hours, end: slotEnd(o.start, o.hours), opensAt: opens, open: opens <= t };
      }),
      order: state.order.slice(),
      results,
      run: runNow(t),
      indoor: {
        linked, days: UI.INDOOR_DAYS, quietUntil: siteQuietUntil(t) || null, holdNo: noHold ? (noHold.say || noHold.toast) : null,
        centres: Object.values(G.CENTRES).map(ce => ({ key: ce.key, name: ce.name, site: G.sheetUrl(ce, iso(today)) })),
      },
      card: cardView(),
      hold: holdView(x),
      notes: state.notes.map(n => ({ id: n.id, at: n.at, kind: n.kind, title: n.title, body: n.body })),
      devices: state.apps.map(d => ({ id: d.id, name: d.name, at: d.at, seenAt: d.seenAt, me: d.id === meId })),
    };
  }
  // The state for one phone with its fingerprint, { etag, state }, or null if that phone is no
  // longer linked.
  function appState(device) {
    if (!device || !state.apps.some(d => d.id === device.id)) return null;
    const s = buildState(device.id);
    return { etag: A.etagOf(s), state: s };
  }

  // A day's free indoor courts, for the app: what the day's card shows in Telegram, read the
  // same way (readIndoor) and refused in the same words.
  async function appLook(v) {
    const no = why => ({ status: 409, body: { ok: false, why } });
    const t = now(), date = civilOf(v.date), today = todayCivil(t);
    if (iso(date) !== v.date || date < today || date > addDays(today, UI.INDOOR_DAYS - 1)) return { status: 400, body: { ok: false, why: DAY_GONE } };
    // A look that needs the sheet read afresh (by your PC, or from here) is one of the twelve
    // a minute the app may ask for, whether or not the read then works. One answered from
    // what is already known asks nothing of anyone, and is not counted.
    if (!indoor.peek(v.centre, v.date, { fresh: v.fresh }) && !lookLimiter.allow(t)) {
      return no(`That is ${A.LOOKS_PER_MIN} looks at Glasgow Club's sheet within a minute, which is as many as I ask for. Wait a minute, then look again.`);
    }
    let got;
    try { got = await readIndoor(v.centre, v.date, v.fresh); } catch (err) { return no(A.whole(G.whyText(err))); }
    const slots = [];
    for (const s of got.slots) {
      if (s.opensAt !== null) continue;                                  // not open for booking yet: the note says when
      let at = slots.find(o => o.start === s.start);
      if (!at) slots.push(at = { start: s.start, end: s.end, courts: [] });
      at.courts.push({ n: s.court, name: A.whole(s.name || `Court ${s.court}`), price: null });      // the sheet carries no price: that shows once a court is held
    }
    const [, ...words] = UI.indoorDay(ctx(), v.centre, v.date, got).caption.split('\n').map(A.plain);
    // What the app has now been shown free: for the next 15 minutes a hold may be asked for one
    // of these courts, and for no other (kept in memory only, so not across a restart).
    const shownAt = now();
    for (const [key, shown] of appShown) if (shownAt - shown.at >= A.SHOWN_MS) appShown.delete(key);
    appShown.set(`${v.centre}:${v.date}`, { at: shownAt, free: new Set(slots.flatMap(s => s.courts.map(c => `${s.start}:${c.n}`))) });
    return { status: 200, body: { ok: true, look: {
      centre: v.centre, date: v.date, at: got.at, by: got.via === 'pc' ? 'pc' : 'bot', note: words.join('\n'), slots,
      sheet: G.sheetUrl(G.CENTRES[v.centre], v.date),
    } } };
  }

  // Something the app asks for, by its name in the address ("once", "pc/sleep", …). Returns
  // { status, body } for the server, or null when there is no such request.
  async function appAsk(device, name, body) {
    const me = state.apps.find(d => d.id === (device && device.id));
    const no = (status, why) => ({ status, body: { ok: false, why } });
    if (!me) return no(401, 'unpaired');
    const t = now();
    // The answer to a request that was carried out: the state as it now stands.
    const done = (extra = {}) => { const s = appState(me); return s ? { status: 200, body: { ok: true, ...extra, ...s } } : no(401, 'unpaired'); };
    if (!APP_ASKS.includes(name)) return null;
    const read = { once: A.readOnce, 'once/remove': A.readOnceRemove, plan: A.readPlan, 'plan/remove': A.readPlanRemove, order: A.readOrder, pause: A.readPause,
      'indoor/look': A.readLook, hold: A.readHold, 'hold/order': A.readHoldOrder, card: A.readCard, 'card/forget': A.readForget, push: A.readPush }[name];
    const v = read ? read(body) : {};
    if (v.why) return no(400, v.why);
    log(`From the app: ${name}`);
    switch (name) {
      case 'unpair':
        state.apps = state.apps.filter(d => d !== me); save();
        log(`A phone unlinked itself from the app: ${me.name}.`);
        return { status: 200, body: { ok: true } };
      case 'once': {
        const r = addOnce(v.date, v.start, v.hours, t);
        if (r.no) return no(r.full ? 409 : 400, r.no);
        if (r.added) log(`Added ${v.date} ${hhmm(v.start)} from the app`);
        return done(r.already ? { already: true } : {});
      }
      case 'once/remove':
        removeOnce(v.date, v.start);
        return done();
      case 'plan':
        setWeekly(v.day, v.start, v.hours);
        return done();
      case 'plan/remove':
        stopWeekly(v.day);
        return done();
      case 'order':
        setOrder(v.order);
        return done();
      case 'pause':
        setPaused(v.paused);
        return done();
      case 'pc/sleep': {
        const r = requestSleep();
        return r.sent ? done() : no(409, r.toast);
      }
      case 'pc/wake': {
        const r = await wakePc();
        return r.sent ? done() : no(409, r.toast);
      }
      case 'indoor/look':
        return appLook(v);
      case 'hold': {
        // Telegram only offers Hold under a court that a sheet showed free. The app's equal: the
        // court must be one that a look showed the app free in the last 15 minutes.
        const shown = appShown.get(`${v.centre}:${v.date}`);
        const stale = !(shown && t - shown.at < A.SHOWN_MS && shown.free.has(`${v.start}:${v.court}`));
        const r = holdStart(v.centre, v.date, v.start, v.court, { by: 'app', chat: owner(), card: null, wide: false, cardless: true, stale });
        if (r.bad) return no(400, TIME_GONE);
        if (r.old) return no(409, LIST_OLD);
        return r.no ? no(409, r.no.say || r.no.toast) : done();
      }
      case 'hold/order': {
        const r = v.what === 'pay' ? holdPay(v.id, v.amount, v.sealed) : holdOrder(v.id, v.what);
        return r.ok ? done() : no(409, r.toast);
      }
      case 'card': {
        const r = cardFromApp(v.sealed);
        return r.ok ? done() : no(409, r.no);
      }
      case 'card/forget': {
        const r = forgetFromApp();
        return r.ok ? done() : no(409, r.no);
      }
      case 'push':
        if (v.token) for (const d of state.apps) if (d !== me && d.push === v.token) d.push = null;      // one phone, one entry: no notification twice
        me.push = v.token; save();
        return done();
      default:
        return null;
    }
  }

  return {
    handleUpdate, tick, msToNext, announce, checkIndoor, lookFromAgent, holdFromAgent, jobsForAgent, pingFromAgent, progressFromAgent, resultFromAgent, picture, pcState, wakeState, kept, state, cfg, owner, VERSION, hasPictures: !!pictures,
    appHello, appPair, appAuth, appState, appAsk, sealedHeld,
  };
}

module.exports = { createApp, loadState, loadPictures, backupLine, readBackup, cleanResult, intIn, VERSION, KINDS };
