'use strict';
// The bot's behaviour: what it does with each message from its owner, and what it sends when.
// It talks to Telegram only. It never contacts ClubSpark: it sends links for a person to tap.

const { iso, label, hhmm, clockAt, DAY_KEYS, DAY_LONG } = require('./lib/time');
const { DEFAULT_SID, GUID, SHEET, parseBookAddress } = require('./lib/links');
const { parseDay, parseTime, parseHours, parseOrder, parsePlan, cleanPlan, cleanOrder, slotText } = require('./lib/plan');
const { dueEvents, msToNextEvent, nextRelease, checkDate } = require('./lib/schedule');
const M = require('./lib/messages');

const VERSION = '1.2';
const STYLES = ['buttons', 'both', 'links'];
const STATE_VERSION = 2;
const SENT_KEEP_MS = 3 * 86400000;

// A whole number in a range, from a number or a string of digits. Anything else is null.
function intIn(v, lo, hi) {
  if (typeof v === 'string') {
    if (!/^-?\d+$/.test(v.trim())) return null;
    v = Number(v.trim());
  }
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

// Settings from storage, or from the environment on a first start, made safe to use.
function loadState(raw, env = {}) {
  const state = {
    v: STATE_VERSION, owner: null, plan: {}, order: [1, 2, 3, 4, 5, 6], sid: DEFAULT_SID,
    lead: 30, warnMin: 5, go: true, style: 'buttons', paused: false, sent: {}, live: null,
  };
  if (raw && typeof raw === 'object') {
    state.owner = intIn(raw.owner, -1e15, 1e15);
    state.plan = cleanPlan(raw.plan);
    state.order = cleanOrder(raw.order);
    if (GUID.test(String(raw.sid || ''))) state.sid = String(raw.sid).toLowerCase();
    state.lead = intIn(raw.lead, 5, 300) ?? 30;
    state.warnMin = intIn(raw.warnMin, 0, 60) ?? 5;
    state.go = raw.go !== false;
    state.style = STYLES.includes(raw.style) ? raw.style : 'buttons';
    // Version 1.0 saved its own default look, "both". The default is now buttons only, so
    // settings written by 1.0 follow it. A later /style both is saved with the new version and sticks.
    if (raw.v !== STATE_VERSION && raw.style === 'both') state.style = 'buttons';
    state.paused = raw.paused === true;
    if (raw.sent && typeof raw.sent === 'object') {
      for (const k of Object.keys(raw.sent)) if (typeof raw.sent[k] === 'number') state.sent[k] = raw.sent[k];
    }
    const l = raw.live;
    if (l && typeof l === 'object' && typeof l.night === 'string' && Number.isInteger(l.id) && Number.isInteger(l.chat)) {
      state.live = { night: l.night, chat: l.chat, id: l.id, phase: l.phase === 'go' ? 'go' : 'wait' };
    }
  } else {
    state.plan = parsePlan(env.COURT_PLAN);
    state.order = parseOrder(env.COURT_ORDER) || state.order;
  }
  return state;
}

// The settings as one line, for the COURT_SETTINGS variable, and back again.
function backupLine(state) {
  return JSON.stringify({
    v: STATE_VERSION, owner: state.owner, plan: cleanPlan(state.plan), order: state.order, sid: state.sid,
    lead: state.lead, warnMin: state.warnMin, go: state.go, style: state.style,
  });
}
function readBackup(text) {
  try {
    const o = JSON.parse(String(text || ''));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

function createApp({ now = Date.now, tg, store, log = () => {}, env = {}, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const fromVariable = readBackup(env.COURT_SETTINGS);
  const state = loadState(store.load() ?? fromVariable, env);
  const variableLine = fromVariable ? backupLine(loadState(fromVariable, env)) : null;
  const save = () => store.save(state);
  const envOwner = intIn(env.TELEGRAM_CHAT_ID, -1e15, 1e15);
  const owner = () => envOwner ?? state.owner;
  const releaseMin = parseTime(env.RELEASE_TIME) ?? 22 * 60;
  const daysAhead = intIn(env.DAYS_AHEAD, 1, 30) ?? 7;
  const cfg = () => ({
    plan: state.plan, order: state.order, sid: state.sid, lead: state.lead,
    warnMin: state.warnMin, go: state.go, style: state.style, releaseMin, daysAhead,
  });
  // Will the settings outlive a restart? On disk, or matching the COURT_SETTINGS variable, or not at all.
  function kept() {
    if (store.isPersistent ? store.isPersistent() : true) return 'disk';
    return variableLine !== null && variableLine === backupLine(state) ? 'variable' : 'no';
  }
  const keepNote = () => (kept() !== 'no' ? '' : '\n\nNote: these settings will be lost at the next restart. To keep them, add a Railway volume mounted at /data, or send /backup.');
  const html = { parse_mode: 'HTML', link_preview_options: M.NO_PREVIEW };
  const say = (chat, text, extra = {}) => tg.send(chat, text, { ...html, ...extra });
  const sendMsg = (chat, m) => tg.send(chat, m.text, m.extra);
  const editMsg = (chat, id, m) => tg.edit(chat, id, m.text, m.extra);
  const next = () => M.esc(M.nextLine(cfg(), now(), state.paused));
  const toldPrivate = new Set();

  async function setCode(chat, text) {
    const got = parseBookAddress(text);
    if (!got.ok) { await say(chat, M.esc(got.why)); return; }
    state.sid = got.sid; save();
    await say(chat, `Saved. The court links now use the booking code ending ${got.sid.slice(-6)}${got.court ? `, taken from a Court ${got.court} address` : ''}. Send /test to check it.`);
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
    if (!cmd) {
      if (/^https?:\/\//i.test(text)) await setCode(chat, text);
      else await say(chat, 'Send /help to see what I understand.');
      return;
    }
    log(`Command: /${cmd}`);
    const c = cfg(), t = now();

    switch (cmd) {
      case 'start':
      case 'help':
        await say(chat, M.HELP); break;

      case 'plan':
        await say(chat, M.planMessage(c, t, state.paused) + keepNote()); break;

      case 'next':
        await say(chat, next()); break;

      case 'status':
        await say(chat, M.statusMessage(c, t, { version: VERSION, skewMs: tg.skewMs ? tg.skewMs() : null, kept: kept(), paused: state.paused })); break;

      case 'set': {
        const usage = 'Use it like this:  /set thu 19:00 2h\nDay, start time, then 1h or 2h (1h if you leave it out).';
        const day = parseDay(args[0]);
        let start = null, hours = null;
        const range = /^(.+?)(?:-|–|to)(.+)$/i.exec(args.slice(1).join(''));
        if (range && parseTime(range[1]) !== null && parseTime(range[2]) !== null) {   // "19:00-21:00"
          start = parseTime(range[1]);
          const len = parseTime(range[2]) - start;
          hours = len === 60 ? 1 : len === 120 ? 2 : null;
          if (!hours) { await say(chat, 'A booking can be one hour or two.\n' + usage); break; }
        } else {
          start = parseTime(args[1]);
          hours = args.length > 2 ? parseHours(args.slice(2).join(' ')) : 1;
        }
        if (!day || start === null || !hours) { await say(chat, usage); break; }
        if (start % 30 !== 0) { await say(chat, 'Slots start on the hour. Try a time like 19:00.'); break; }
        if (start + hours * 60 > 1440) { await say(chat, 'That slot runs past midnight. Try an earlier time.'); break; }
        state.plan[day] = { start, hours }; save();
        const name = DAY_LONG[DAY_KEYS.indexOf(day)];
        const odd = start % 60 !== 0 ? '\nNote: I have only seen Kelvingrove slots start on the hour. Send /test to check this one opens.' : '';
        await say(chat, `<b>${name}s · ${slotText(state.plan[day])}</b>${odd}\nThe alert comes ${daysAhead} days before, ${state.lead} s ahead of the ${hhmm(releaseMin)} release.\n\n${next()}${keepNote()}`);
        break;
      }

      case 'off': {
        if ((args[0] || '').toLowerCase() === 'all') { state.plan = {}; save(); await say(chat, 'All days removed. No alerts will be sent.'); break; }
        const day = parseDay(args[0]);
        if (!day) { await say(chat, 'Use it like this:  /off thu   (or /off all)'); break; }
        const had = !!state.plan[day];
        delete state.plan[day]; save();
        await say(chat, `${had ? 'Removed' : 'There was no alert for'} ${DAY_LONG[DAY_KEYS.indexOf(day)]}.\n\n${next()}${keepNote()}`);
        break;
      }

      case 'order': {
        const order = parseOrder(rest);
        if (!order) { await say(chat, `Use it like this:  /order 4 3 5 2 6 1\nCourts 1 to 6, each once. Any you leave out go last.\nNow: ${state.order.join(', ')}`); break; }
        state.order = order; save();
        await say(chat, `Court order: ${order.join(', ')}`);
        break;
      }

      case 'lead': {
        const n = intIn(args[0] ?? null, 5, 300);
        if (n === null) { await say(chat, `Use a number of seconds from 5 to 300, for example  /lead 30\nNow: ${state.lead} s`); break; }
        state.lead = n; save();
        await say(chat, `The alert will arrive ${n} s before the release.`);
        break;
      }

      case 'warn': {
        const n = intIn(args[0] ?? null, 0, 60);
        if (n === null) { await say(chat, `Use a number of minutes from 0 to 60, for example  /warn 5  (0 for no heads-up)\nNow: ${state.warnMin} min`); break; }
        state.warnMin = n; save();
        const tooClose = n > 0 && n * 60 <= state.lead + 5;
        await say(chat, n === 0 ? 'No heads-up message.'
          : tooClose ? `That is no earlier than the links themselves (${state.lead} s before), so there will be no separate heads-up.`
            : `Heads-up ${n} min before the release.`);
        break;
      }

      case 'go': {
        const a = (args[0] || '').toLowerCase();
        if (a !== 'on' && a !== 'off') { await say(chat, `Send  /go on  or  /go off\nNow: ${state.go ? 'on' : 'off'}`); break; }
        state.go = a === 'on'; save();
        await say(chat, state.go ? 'At the release the alert will turn to GO.' : 'The alert will stay as it is at the release.');
        break;
      }

      case 'style': {
        const a = (args[0] || '').toLowerCase();
        if (!STYLES.includes(a)) { await say(chat, `Send  /style buttons,  /style both  or  /style links\nNow: ${state.style}`); break; }
        state.style = a; save();
        await say(chat, {
          buttons: 'Court buttons only. Telegram asks "Open this link?" when you tap one.',
          both: 'The buttons, plus your first-choice court written out as a link that opens in one tap.',
          links: 'All six courts written out as links that open in one tap. No buttons.',
        }[a] + ' Send /test to see it.');
        break;
      }

      case 'code': {
        if (!rest) { await say(chat, `Paste a confirm-screen address here to replace the booking code.\nTo get one: tap a free slot on the sheet, then Continue booking, and copy the address of the screen that follows.\nNow: code ending ${state.sid.slice(-6)}`); break; }
        await setCode(chat, rest);
        break;
      }

      case 'backup':
        await say(chat, `Tap the line below to copy it, then save it in Railway as the variable COURT_SETTINGS. The bot starts from it whenever it has no saved settings, so update it after you change your plan.\n\n<code>${M.esc(backupLine(state))}</code>`); break;

      case 'pause':
        state.paused = true; save();
        await say(chat, 'Paused. No alerts until you send /resume.'); break;

      case 'resume':
        state.paused = false; save();
        await say(chat, `Alerts are on.\n\n${next()}`); break;

      case 'signin':
        await say(chat, 'Open the booking sheet and sign in to ClubSpark there. The court links open in the same place, so you will still be signed in when they arrive.', { reply_markup: { inline_keyboard: [[{ text: 'Open the booking sheet', url: SHEET }]] } }); break;

      case 'test': {
        const rel = nextRelease(t, c);
        if (!rel) { await say(chat, 'Set a day first, for example  /set thu 19:00 2h'); break; }
        const date = checkDate(t, c, rel);
        const first = M.testMessage(c, rel, date, 'wait');
        const sent = await sendMsg(chat, first);
        if (c.go) {
          await wait(5000);
          await editMsg(chat, sent.message_id, M.testMessage(c, rel, date, 'go')).catch(e => log(`Test GO edit failed: ${e.message}`));
        }
        break;
      }

      default:
        await say(chat, 'I do not know that one. Send /help to see what I understand.');
    }
  }

  // ---------- the timed messages ----------
  let ticking = false;
  const retryAt = {};   // after a failed send, when to try that message again
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const chat = owner();
      if (chat === null || state.paused) return;
      const c = cfg();
      for (const e of dueEvents(now(), c, state.sent)) {
        if (state.sent[e.key] || (retryAt[e.key] && now() < retryAt[e.key])) continue;
        const night = iso(e.rel.night);
        try {
          if (e.type === 'warn') {
            const m = M.warnMessage(c, e.rel, now());
            await tg.send(chat, m.text, m.extra);
          } else if (e.type === 'links') {
            const phase = now() >= e.rel.releaseAt ? 'go' : 'wait';
            const sent = await sendMsg(chat, M.linksMessage(c, e.rel, phase, now()));
            state.live = { night, chat, id: sent.message_id, phase };
            if (phase === 'go') state.sent[`${night}:go`] = now();   // it already says GO
          } else if (e.type === 'go') {
            if (!state.sent[`${night}:links`]) continue;             // the links are still to come and will say GO themselves
            const live = state.live && state.live.night === night ? state.live : null;
            if (!live || live.phase !== 'go') {
              const m = M.linksMessage(c, e.rel, 'go', now());
              let edited = false;
              if (live) {
                try { await editMsg(live.chat, live.id, m); edited = true; }
                catch (err) {
                  if (err.code !== 400) throw err;
                  if (/not modified/i.test(err.message)) edited = true;   // an earlier try got through after all
                }                                                         // any other 400: the message has gone, so send GO afresh
              }
              if (!edited) {
                const sent = await sendMsg(chat, m);
                state.live = { night, chat, id: sent.message_id, phase: 'go' };
              } else {
                live.phase = 'go';
              }
            }
          }
          state.sent[e.key] = now();
          for (const k of Object.keys(state.sent)) if (now() - state.sent[k] > SENT_KEEP_MS) delete state.sent[k];
          save();
          log(`Sent ${e.type} for ${label(e.rel.playDate)} at ${clockAt(now())} UK`);
        } catch (err) {
          retryAt[e.key] = now() + (err.retryAfter ? err.retryAfter * 1000 : 1000);
          log(`Could not send ${e.type}: ${err.message}. Trying again shortly.`);
        }
      }
    } finally {
      ticking = false;
    }
  }

  // How long until the next timed message, so the caller can wake up exactly then.
  function msToNext() {
    if (owner() === null || state.paused) return null;
    return msToNextEvent(now(), cfg());
  }

  // A quiet note on start-up, so a deploy can be seen to have worked.
  async function announce() {
    const chat = owner();
    if (chat === null) { log('No owner yet. Open the bot in Telegram and send /start.'); return; }
    await tg.send(chat, `Court alert is running (version ${VERSION}).\n${next()}${keepNote()}`, { ...html, disable_notification: true })
      .catch(e => log(`Start-up note not sent: ${e.message}`));
  }

  return { handleUpdate, tick, msToNext, announce, kept, state, cfg, owner, VERSION };
}

module.exports = { createApp, loadState, backupLine, readBackup, intIn, VERSION, STYLES };
