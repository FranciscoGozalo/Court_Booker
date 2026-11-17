'use strict';
// The bot's behaviour: your booking requests, what your PC at home should book, and the
// messages about it. The bot itself never touches ClubSpark: your PC signs in and books
// (Cloudflare turns Railway away), then reports back here, and the bot tells you the court,
// the time and the gate code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { iso, label, hhmm, todayCivil, addDays, londonInstant, DAY_KEYS, DAY_LONG } = require('./lib/time');
const { parseDay, parseTime, parseOrder, parsePlan, parseSlot, parseBooking, cleanPlan, cleanOrder, cleanOnce, slotText, slotEnd } = require('./lib/plan');
const { jobsFor, missingFor, msToNextCheck, opensAt, civilOf } = require('./lib/schedule');
const M = require('./lib/messages');

const VERSION = '2.0';
const STATE_VERSION = 4;
const SENT_KEEP_MS = 3 * 86400000;
const RESULTS_KEEP_MS = 60 * 86400000;
const MAX_AHEAD_DAYS = 90;
const GONE = ['test', 'free', 'signin', 'style', 'lead', 'warn', 'go', 'code'];   // link-alert commands from version 1

// The two banner pictures: the court before booking opens (heads-up), and with the
// floodlights on (booked). Each carries a fingerprint, so a changed file is uploaded afresh.
function loadPictures(dir = path.join(__dirname, 'assets')) {
  const out = {};
  for (const kind of ['wait', 'open']) {
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
    results: {}, sent: {}, pics: {}, lastSeen: null,
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
    }
    for (const kind of ['wait', 'open']) {                       // what Telegram calls each picture, once it has it
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

// `linked` says whether a PC can reach the bot (AGENT_TOKEN is set).
function createApp({ now = Date.now, tg, store, log = () => {}, env = {}, pictures = loadPictures(), linked = true }) {
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
  async function sendCard(chat, kind, caption) {
    const p = pictures && pictures[kind];
    if (!p) return say(chat, caption);
    const known = state.pics[kind];
    const extra = { caption, parse_mode: 'HTML' };
    try {
      let sent;
      const useId = known && known.hash === p.hash ? known.id : null;
      try { sent = await tg.sendPhoto(chat, useId || { buf: p.buf, name: p.name }, extra); } catch (err) {
        if (!useId || transient(err)) throw err;
        delete state.pics[kind];                                   // the saved name for the picture no longer works: upload it again
        sent = await tg.sendPhoto(chat, { buf: p.buf, name: p.name }, extra);
      }
      const sizes = sent && sent.photo;
      const id = Array.isArray(sizes) && sizes.length ? sizes[sizes.length - 1].file_id : null;
      if (id) { state.pics[kind] = { hash: p.hash, id }; save(); }
      return sent;
    } catch (err) {
      if (transient(err)) throw err;
      log(`Telegram would not take the picture (${err.message}). Sending plain text.`);
      return say(chat, caption);
    }
  }

  // ---------- your PC ----------
  // The PC asks what to book. Asking counts as checking in; before a release it also brings a
  // heads-up card, once per release.
  function jobsForAgent() {
    const t = now();
    state.lastSeen = t;
    const c = cfg();
    const jobs = state.paused || owner() === null ? [] : jobsFor(t, c, state.results);
    const coming = jobs.filter(j => j.releaseAt > t);
    if (coming.length) {
      const key = `ready:${coming[0].releaseAt}`;
      if (!state.sent[key]) {
        state.sent[key] = t;
        sendCard(owner(), 'wait', M.headsUp(c, coming)).catch(e => { delete state.sent[key]; log(`Heads-up not sent: ${e.message}`); });
      }
    }
    save();
    return {
      jobs: jobs.map(j => ({ id: j.id, date: j.date, start: j.start, end: j.end, hours: j.hours, releaseAt: j.releaseAt })),
      order: c.order, releaseMin, daysAhead,
    };
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
      if (r.status === 'booked') await sendCard(chat, 'open', M.bookedCaption(r));
      else await say(chat, M.failedText(r));
    }
    state.results[r.id] = { ...r, at: now() };
    for (const k of Object.keys(state.results)) if (now() - state.results[k].at > RESULTS_KEEP_MS) delete state.results[k];
    save();
    log(`Result from the PC: ${r.id} ${r.status}${r.court ? ` (Court ${r.court})` : ''}`);
    return { ok: true };
  }

  // ---------- messages from the owner ----------
  async function handleUpdate(update) {
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
      await say(chat, `This bot is now yours, and it answers only you.\nTo lock that in for good, add the variable TELEGRAM_CHAT_ID = <code>${chat}</code> in Railway.${keepNote()}\n\n${M.HELP}`);
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
      case 'help':
        await say(chat, M.HELP); break;

      case 'plan':
      case 'list':
        await say(chat, M.planMessage(c, t, state.paused, state.results) + keepNote()); break;

      case 'next':
        await say(chat, next()); break;

      case 'status':
        await say(chat, M.statusMessage(c, t, {
          version: VERSION, skewMs: tg.skewMs ? tg.skewMs() : null, kept: kept(), paused: state.paused,
          linked, lastSeen: state.lastSeen, lastSeenDay: state.lastSeen ? todayCivil(state.lastSeen) : null,
        }));
        break;

      case 'set': {
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
  // Warns you if your PC has not checked in shortly before a release, and tidies up.
  let ticking = false;
  const retryAt = {};
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const t = now(), today = todayCivil(t);
      const pastOnce = state.once.filter(o => civilOf(o.date) < today);
      if (pastOnce.length) { state.once = state.once.filter(o => civilOf(o.date) >= today); save(); }
      const chat = owner();
      if (chat === null || state.paused || !linked) return;
      const rel = missingFor(t, cfg(), state.lastSeen);
      if (!rel) return;
      const key = `missing:${rel.releaseAt}`;
      if (state.sent[key] || (retryAt[key] && t < retryAt[key])) return;
      try {
        await say(chat, M.missingText(cfg(), rel));
        state.sent[key] = t;
        for (const k of Object.keys(state.sent)) if (t - state.sent[k] > SENT_KEEP_MS) delete state.sent[k];
        save();
        log(`Warned that the PC has not checked in for ${label(rel.playDate)}`);
      } catch (err) {
        retryAt[key] = t + (err.retryAfter ? err.retryAfter * 1000 : 5000);
        log(`Could not send the warning: ${err.message}`);
      }
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

  return { handleUpdate, tick, msToNext, announce, jobsForAgent, resultFromAgent, kept, state, cfg, owner, VERSION, hasPictures: !!pictures };
}

module.exports = { createApp, loadState, loadPictures, backupLine, readBackup, cleanResult, intIn, VERSION };
