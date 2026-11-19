'use strict';
// The tap-through screens: each is a banner card's caption plus its buttons, so moving between
// screens just edits the same card. Pure functions: they build what to show and nothing else.
//
// Button data is kept short (Telegram allows 64 bytes):
//   h  home          b  book a date (this month)   cal:YYYYMM  that month
//   d:YYYYMMDD       pick a start time on that day
//   t:YYYYMMDD:HHMM  pick a length                 l:YYYYMMDD:HHMM:H  check before adding
//   ok:YYYYMMDD:HHMM:H  add it                     x:YYYYMMDD:HHMM    remove a one-off
//   w  every week    wd:day  one weekday           wt:day  its start times
//   wt:day:HHMM  its length                        wl:day:HHMM:H  save it    woff:day  stop it
//   m  my bookings   o / o:345  court order, picked so far   os:345  save it
//   p  pause or resume    s  status    wk  wake your PC    sl / sl:ok  sleep it (ask, then do)
//   noop  does nothing
//   n:<any of these>  the same screen, but on a new card (used on booking messages, so they stay)

const { iso, label, hhmm, civil, civilParts, addDays, todayCivil, londonInstant, londonWall, DAY_KEYS, DAY_LONG } = require('./time');
const { slotEnd, slotText } = require('./plan');
const { opensAt, civilOf } = require('./schedule');
const M = require('./messages');

const MAX_AHEAD_DAYS = 90;
const FIRST_START = 9 * 60;    // Kelvingrove's sheet runs 09:00 to 21:00
const LAST_END = 21 * 60;
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_SHORT_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DOT = '·';

const btn = (text, data) => ({ text, callback_data: data });
const noop = text => btn(text, 'noop');
const rows = (buttons, per) => { const out = []; for (let i = 0; i < buttons.length; i += per) out.push(buttons.slice(i, i + per)); return out; };
const d8 = isoDate => isoDate.replace(/-/g, '');
const fromD8 = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const hm = minutes => hhmm(minutes).replace(':', '');
const fromHm = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
const ym = c => { const p = civilParts(c); return `${p.y}${String(p.m).padStart(2, '0')}`; };
const monthOf = c => { const p = civilParts(c); return civil(p.y, p.m, 1); };
const dayName = k => DAY_LONG[DAY_KEYS.indexOf(k)];
const span = (start, hours) => `${hhmm(start)}–${hhmm(slotEnd(start, hours))}`;
const screen = (caption, keyboard) => ({ caption, keyboard: { inline_keyboard: keyboard } });
const HOME_ROW = [btn('Menu', 'h')];

// The last date that is already open for booking now.
function openUntil(ctx) {
  const today = todayCivil(ctx.now);
  return addDays(today, ctx.cfg.daysAhead - (ctx.now < londonInstant(today, ctx.cfg.releaseMin) ? 1 : 0));
}
// When a date gets booked, in words.
function whenText(ctx, date) {
  const opens = opensAt(date, ctx.cfg);
  return opens <= ctx.now
    ? 'Open now: your PC books it on its next run (21:55 each night).'
    : `Opens ${label(addDays(date, -ctx.cfg.daysAhead))} at ${hhmm(ctx.cfg.releaseMin)}; your PC books it then.`;
}

// ---------- home ----------
// When something happened, in words: "today at 13:01", "yesterday at 21:55" or "Mon 16 Nov at 21:55".
function whenSeen(ctx, ms) {
  const day = todayCivil(ms), today = todayCivil(ctx.now);
  const d = day === today ? 'today' : day === addDays(today, -1) ? 'yesterday' : label(day);
  return `${d} at ${hhmm(londonMinutes(ms))}`;
}
// Your PC's state in words, to go with the dot on the banner.
function pcLine(ctx) {
  if (!ctx.linked) return null;
  if (ctx.pc === 'awake') return 'Your PC is awake.';
  if (ctx.pc === 'asleep') return `Your PC is asleep (last in touch ${whenSeen(ctx, ctx.lastSeen)}). It wakes at ${hhmm(ctx.cfg.releaseMin - 5)} to book.`;
  return ctx.lastSeen ? `Your PC has not been in touch since ${whenSeen(ctx, ctx.lastSeen)}. It may be off.` : 'Your PC has not been in touch yet.';
}

// Waking is offered while the PC is not awake and the bot knows where home is; sleeping while
// it is awake. They share the top row of the menu.
const canWake = ctx => ctx.wake === 'ready' && ctx.pc !== 'awake';
const canSleep = ctx => ctx.linked && ctx.pc === 'awake';
const WAKE_NOTE_MS = 5 * 60 * 1000;
const SLEEP_NOTE_MS = 2 * 60 * 1000;
const powerRow = ctx => (canWake(ctx) ? [[btn('Wake my PC', 'wk')]] : canSleep(ctx) ? [[btn('Sleep my PC', 'sl')]] : []);

function home(ctx) {
  const lines = ['<b>Court Booker</b>', M.esc(M.nextLine(ctx.cfg, ctx.now, ctx.paused))];
  const pc = pcLine(ctx);
  if (pc) lines.push(pc);
  if (canWake(ctx) && ctx.wokeAt && ctx.now - ctx.wokeAt < WAKE_NOTE_MS) {
    lines.push(`Wake-up sent at ${hhmm(londonMinutes(ctx.wokeAt))}. The dot turns green when your PC answers, usually within a minute.`);
  }
  if (canSleep(ctx) && ctx.sleepAsk && ctx.now - ctx.sleepAsk < SLEEP_NOTE_MS) {
    lines.push(`Sleep sent at ${hhmm(londonMinutes(ctx.sleepAsk))}. Your PC goes to sleep within a few seconds, and the dot turns amber.`);
  }
  return screen(lines.join('\n'), [
    ...powerRow(ctx),
    [btn('Book a date', 'b'), btn('Every week', 'w')],
    [btn('My bookings', 'm'), btn('Court order', 'o')],
    [btn(ctx.paused ? 'Resume booking' : 'Pause booking', 'p'), btn('Status', 's')],
  ]);
}
function londonMinutes(ms) { const w = londonWall(ms); return w.hh * 60 + w.mm; }

// ---------- book a date ----------
function calendar(ctx, month = null) {
  const today = todayCivil(ctx.now);
  const last = addDays(today, MAX_AHEAD_DAYS);
  const first = month ?? monthOf(today);
  const p = civilParts(first);
  const prev = p.m === 1 ? civil(p.y - 1, 12, 1) : civil(p.y, p.m - 1, 1);
  const next = p.m === 12 ? civil(p.y + 1, 1, 1) : civil(p.y, p.m + 1, 1);
  const canPrev = prev >= monthOf(today);
  const canNext = next <= last;
  const marked = new Set((ctx.cfg.once || []).map(o => o.date));
  const cells = [];
  for (let i = 0; i < (civilParts(first).dow + 6) % 7; i++) cells.push(noop(DOT));        // Monday first
  for (let day = first; civilParts(day).m === p.m; day = addDays(day, 1)) {
    const n = civilParts(day).d;
    if (day < today || day > last) cells.push(noop(DOT));
    else cells.push(btn(marked.has(iso(day)) ? `${n}•` : String(n), `d:${d8(iso(day))}`));
  }
  while (cells.length % 7) cells.push(noop(DOT));
  const caption = [
    '<b>Book a date</b>',
    `Days up to ${label(openUntil(ctx))} are open now; your PC books them at its next run.`,
    `Later days are booked at ${hhmm(ctx.cfg.releaseMin)} the night they open, ${ctx.cfg.daysAhead} days before.`,
    '• means that day already has a booking.',
  ].join('\n');
  return screen(caption, [
    [canPrev ? btn('‹', `cal:${ym(prev)}`) : noop(DOT), noop(`${MONTH_LONG[p.m - 1]} ${p.y}`), canNext ? btn('›', `cal:${ym(next)}`) : noop(DOT)],
    ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(noop),
    ...rows(cells, 7),
    HOME_ROW,
  ]);
}

// Start times for a date; today only those still ahead.
function startTimes(ctx, date) {
  const out = [];
  const today = todayCivil(ctx.now);
  for (let s = FIRST_START; s + 60 <= LAST_END; s += 60) {
    if (date === today && londonInstant(date, s) <= ctx.now) continue;
    out.push(s);
  }
  return out;
}

function times(ctx, dateIso) {
  const date = civilOf(dateIso);
  const starts = startTimes(ctx, date);
  const caption = [`<b>${label(date)}</b>`, whenText(ctx, date), starts.length ? 'Pick a start time.' : 'No start times are left that day.'].join('\n');
  return screen(caption, [
    ...rows(starts.map(s => btn(hhmm(s), `t:${d8(dateIso)}:${hm(s)}`)), 4),
    [btn('Back', `cal:${ym(date)}`), ...HOME_ROW],
  ]);
}

function lengths(ctx, dateIso, start) {
  const date = civilOf(dateIso);
  const options = [1, 2].filter(h => start + h * 60 <= LAST_END)
    .map(h => btn(`${h === 1 ? '1 hour' : '2 hours'} · ${span(start, h)}`, `l:${d8(dateIso)}:${hm(start)}:${h}`));
  return screen(`<b>${label(date)} · from ${hhmm(start)}</b>\nHow long?`, [
    ...options.map(b => [b]),
    [btn('Back', `d:${d8(dateIso)}`), ...HOME_ROW],
  ]);
}

function confirmOnce(ctx, dateIso, start, hours) {
  const date = civilOf(dateIso);
  const caption = [`<b>Book ${label(date)} · ${span(start, hours)}?</b>`, whenText(ctx, date), `Courts in order: ${ctx.cfg.order.join(', ')}`].join('\n');
  return screen(caption, [
    [btn('Add it', `ok:${d8(dateIso)}:${hm(start)}:${hours}`)],
    [btn('Back', `t:${d8(dateIso)}:${hm(start)}`), ...HOME_ROW],
  ]);
}

function added(ctx, dateIso, start, hours, already = false) {
  const date = civilOf(dateIso);
  const head = already ? `<b>Already on your list · ${label(date)} · ${span(start, hours)}</b>` : `<b>Added · ${label(date)} · ${span(start, hours)}</b>`;
  return screen([head, whenText(ctx, date)].join('\n'), [
    [btn('Book another', 'b'), btn('My bookings', 'm')],
    HOME_ROW,
  ]);
}

// ---------- every week ----------
function weekly(ctx) {
  const plan = ctx.cfg.plan;
  const caption = [
    '<b>Every week</b>',
    `Tap a day to set or change it. Each is booked at ${hhmm(ctx.cfg.releaseMin)} on the same weekday the week before.`,
  ].join('\n');
  const days = DAY_SHORT_MON_FIRST.map(k => btn(plan[k] ? `${dayName(k).slice(0, 3)} · ${slotText(plan[k])}` : dayName(k).slice(0, 3), `wd:${k}`));
  return screen(caption, [...rows(days, 2), HOME_ROW]);
}

function weeklyDay(ctx, k) {
  const e = ctx.cfg.plan[k];
  if (!e) return weeklyTimes(ctx, k);
  return screen(`<b>${dayName(k)}s · ${slotText(e)}</b>\nBooked every week.`, [
    [btn('Change the time', `wt:${k}`)],
    [btn(`Stop ${dayName(k)}s`, `woff:${k}`)],
    [btn('Back', 'w'), ...HOME_ROW],
  ]);
}

function weeklyTimes(ctx, k) {
  const starts = [];
  for (let s = FIRST_START; s + 60 <= LAST_END; s += 60) starts.push(s);
  return screen(`<b>${dayName(k)}s</b>\nPick a start time.`, [
    ...rows(starts.map(s => btn(hhmm(s), `wt:${k}:${hm(s)}`)), 4),
    [btn('Back', 'w'), ...HOME_ROW],
  ]);
}

function weeklyLengths(ctx, k, start) {
  const options = [1, 2].filter(h => start + h * 60 <= LAST_END)
    .map(h => [btn(`${h === 1 ? '1 hour' : '2 hours'} · ${span(start, h)}`, `wl:${k}:${hm(start)}:${h}`)]);
  return screen(`<b>${dayName(k)}s · from ${hhmm(start)}</b>\nHow long?`, [...options, [btn('Back', `wt:${k}`), ...HOME_ROW]]);
}

function weeklySaved(ctx, k) {
  const e = ctx.cfg.plan[k];
  return screen([`<b>${dayName(k)}s · ${slotText(e)} saved</b>`, `Booked every week, the ${dayName(k)} before at ${hhmm(ctx.cfg.releaseMin)}.`, M.esc(M.nextLine(ctx.cfg, ctx.now, ctx.paused))].join('\n'), [
    [btn('Every week', 'w'), ...HOME_ROW],
  ]);
}

// ---------- my bookings ----------
function bookings(ctx, note = '') {
  const caption = (note ? `<b>${note}</b>\n\n` : '') + M.planMessage(ctx.cfg, ctx.now, ctx.paused, ctx.results);
  const buttons = [];
  for (const o of (ctx.cfg.once || []).slice(0, 8)) {
    buttons.push([btn(`Remove ${label(civilOf(o.date))} ${hhmm(o.start)}`, `x:${d8(o.date)}:${hm(o.start)}`)]);
  }
  for (const k of DAY_SHORT_MON_FIRST) if (ctx.cfg.plan[k]) buttons.push([btn(`Stop ${dayName(k)}s`, `woff:${k}`)]);
  buttons.push([btn('Book a date', 'b'), btn('Every week', 'w')], HOME_ROW);
  return screen(caption.length > 1000 ? `${caption.slice(0, 990)}…` : caption, buttons);
}

// ---------- court order ----------
function order(ctx, draft = '') {
  const picked = draft.split('').map(Number);
  const ord = n => ['1st', '2nd', '3rd', '4th', '5th', '6th'][n];
  const caption = [
    '<b>Court order</b>',
    `Now: ${ctx.cfg.order.join(', ')}`,
    picked.length ? `New: ${picked.join(', ')}${picked.length < 6 ? ', then the rest' : ''}` : 'Tap the courts in the order to try them, then Save.',
  ].join('\n');
  const courts = [1, 2, 3, 4, 5, 6].map(n => (picked.includes(n) ? noop(`Court ${n} · ${ord(picked.indexOf(n))}`) : btn(`Court ${n}`, `o:${draft}${n}`)));
  return screen(caption, [
    ...rows(courts, 3),
    ...(picked.length ? [[btn('Save', `os:${draft}`), btn('Start again', 'o')]] : []),
    HOME_ROW,
  ]);
}

// ---------- sleep your PC ----------
function sleepConfirm(ctx) {
  const wake = ctx.wake === 'ready' ? 'Wake it again any time with Wake my PC.' : 'To wake it from here, set up waking (see /status).';
  return screen([
    '<b>Put your PC to sleep?</b>',
    'It goes to sleep within a few seconds. Anything open on it stays as it is.',
    `It still wakes itself at ${hhmm(ctx.cfg.releaseMin - 5)} each night for the booking; if its booking task could not wake it, it stays awake and I tell you why.`,
    wake,
  ].join('\n'), [
    [btn('Yes, sleep', 'sl:ok')],
    HOME_ROW,
  ]);
}

// ---------- status ----------
function status(ctx, info) {
  return screen(M.statusMessage(ctx.cfg, ctx.now, info), [HOME_ROW]);
}

// Buttons for the booking messages. They open a new card, so the message itself stays.
const afterBooked = () => ({ inline_keyboard: [[btn('My bookings', 'n:m'), btn('Menu', 'n:h')]] });
const afterFailed = () => ({ inline_keyboard: [[btn('Book a date', 'n:b'), btn('Menu', 'n:h')]] });
const afterMissing = () => ({ inline_keyboard: [[btn('Status', 'n:s'), btn('Menu', 'n:h')]] });
// Under "Your PC is not answering": another try at waking it, when the bot can.
const afterNotAnswering = canWake => ({ inline_keyboard: [...(canWake ? [[btn('Wake my PC', 'n:wk')]] : []), [btn('Status', 'n:s'), btn('Menu', 'n:h')]] });

module.exports = {
  home, calendar, times, lengths, confirmOnce, added, weekly, weeklyDay, weeklyTimes, weeklyLengths, weeklySaved,
  bookings, order, status, sleepConfirm, afterBooked, afterFailed, afterMissing, afterNotAnswering,
  d8, fromD8, hm, fromHm, monthOf, MAX_AHEAD_DAYS, FIRST_START, LAST_END,
};
