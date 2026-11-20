'use strict';
// The tap-through screens: each is a banner card's caption plus its buttons, so moving between
// screens just edits the same card. Pure functions: they build what to show and nothing else.
//
// Button data is kept short (Telegram allows 64 bytes):
//   h  home          b  book a court: where?
//   bk  Kelvingrove: book a date (this month)      cal:YYYYMM  that month
//   g:c  an indoor centre (c is g for Gorbals, s for Scotstoun): pick a day
//   gd:c:YYYYMMDD  its free start times that day   gr:c:YYYYMMDD  the same, read afresh
//   gt:c:YYYYMMDD:HHMM  one of them: the courts, and the page to book and pay on
//   gh:c:YYYYMMDD:HHMM:N  hold court N then: your PC puts it in your Glasgow Club basket
//   gx:<id>  let that hold go (or stop it)         gp:<id>  you have paid for it
//   gy:<id>  pay for it from your PC (asks first)   gb:<id>  back from that question
//   gz:<id>:<pence>  yes, pay that amount
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
const G = require('./glasgowclub');

const MAX_AHEAD_DAYS = 90;
const INDOOR_DAYS = 9;         // indoor: today and eight days on (a week ahead is open; the day after opens at midnight)
const FIRST_START = 9 * 60;    // Kelvingrove's sheet runs 09:00 to 21:00
const LAST_END = 21 * 60;
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_SHORT_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DOT = '·';

const btn = (text, data) => ({ text, callback_data: data });
const link = (text, url) => ({ text, url });      // opens a web page instead of another screen
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

// ---------- book a court: where? ----------
function venues() {
  return screen([
    '<b>Book a court</b>',
    'Where?',
    'Kelvingrove Park is outdoor: your PC books it when the day opens.',
    'Gorbals and Scotstoun are indoor (Glasgow Club): I find the free courts, your PC can put one in your basket, and you pay.',
  ].join('\n'), [
    [btn('Kelvingrove Park', 'bk')],
    [btn('Gorbals · indoor', 'g:g'), btn('Scotstoun · indoor', 'g:s')],
    HOME_ROW,
  ]);
}

// ---------- indoor courts (Glasgow Club) ----------
// The bot shows what is free and hands over the page to book on; see lib/glasgowclub.js for why
// it goes no further.
const courtsText = courts => `${courts.length === 1 ? 'court' : 'courts'} ${courts.length < 2 ? courts.join('') : `${courts.slice(0, -1).join(', ')} and ${courts[courts.length - 1]}`}`;
const readAt = got => `as Glasgow Club showed it at ${hhmm(londonMinutes(got.at))}`;
// "at 00:00 on Fri 20 Nov (the midnight after Thu 19 Nov)"
function opensText(ms) {
  const day = todayCivil(ms), mins = londonMinutes(ms);
  return `at ${hhmm(mins)} on ${label(day)}${mins === 0 ? ` (the midnight after ${label(addDays(day, -1))})` : ''}`;
}

function indoorDays(ctx, key) {
  const centre = G.CENTRES[key];
  const today = todayCivil(ctx.now);
  const days = [];
  for (let i = 0; i < INDOOR_DAYS; i++) {
    const day = addDays(today, i);
    days.push(btn(i === 0 ? 'Today' : label(day), `gd:${key}:${d8(iso(day))}`));
  }
  return screen([
    `<b>${centre.name} · indoor tennis</b>`,
    'Pick a day. Glasgow Club opens each day for booking a week ahead, at midnight.',
  ].join('\n'), [...rows(days, 3), [btn('Back', 'b'), ...HOME_ROW]]);
}

// While a day's sheet is being read.
function indoorWait(ctx, key, dateIso) {
  return screen(`<b>${G.CENTRES[key].name} · ${label(civilOf(dateIso))}</b>\nReading Glasgow Club's sheet…`, [[btn('Back', `g:${key}`), ...HOME_ROW]]);
}

// A day's free start times. `got` is { at, slots, listed } from the site, or null with `err`
// saying why not. A sheet with no courts on it at all is said as that, not as "none free".
function indoorDay(ctx, key, dateIso, got, err = null, note = '') {
  const centre = G.CENTRES[key];
  const url = G.sheetUrl(centre, dateIso);
  const lines = [`<b>${centre.name} · ${label(civilOf(dateIso))}</b>`];
  if (note) lines.push(note);
  let starts = [];
  if (!got) {
    lines.push(M.esc(G.whyText(err)), 'The sheet itself still opens from the button below.');
  } else {
    const open = got.slots.filter(s => s.opensAt === null);
    const later = got.slots.filter(s => s.opensAt !== null);
    starts = [...new Set(open.map(s => s.start))];
    if (starts.length) lines.push(`Free start times, ${readAt(got)}. Each is one hour. Pick one.`);
    else if (!later.length) lines.push(got.listed === 0 ? `Glasgow Club's sheet lists no courts at all that day, ${readAt(got)}. Open the sheet to see for yourself.` : `No court is free that day, ${readAt(got)}.`);
    if (later.length) {
      const times = [...new Set(later.map(s => s.start))].map(hhmm).join(', ');
      lines.push(`${starts.length ? 'Not open yet' : 'Not open for booking yet'}: Glasgow Club opens ${starts.length ? 'the rest' : 'it'} ${opensText(Math.min(...later.map(s => s.opensAt)))}.`,
        `Free ${starts.length ? 'then' : 'as it stands'}: ${times}.`);
    }
  }
  return screen(lines.join('\n'), [
    ...rows(starts.map(s => btn(hhmm(s), `gt:${key}:${d8(dateIso)}:${hm(s)}`)), 4),
    ...(!got && err && err.wake ? [[btn('Wake my PC', 'wk')]] : []),        // your PC reads the sheet, and it is not awake
    [btn(got ? 'Refresh' : 'Try again', `gr:${key}:${d8(dateIso)}`), link('Open the sheet', url)],
    [btn('Back', `g:${key}`), ...HOME_ROW],
  ]);
}

// One start time: which courts, and the page to book and pay on. Null when no court is free
// then any more.
function indoorSlot(ctx, key, dateIso, start, got) {
  const centre = G.CENTRES[key];
  const free = got.slots.filter(s => s.start === start && s.opensAt === null);
  if (!free.length) return null;
  const end = free[0].end;
  const courts = free.map(s => s.court);
  const longer = got.slots.filter(s => s.start === end && s.opensAt === null && courts.includes(s.court));
  const lines = [
    `<b>${centre.name} · ${label(civilOf(dateIso))} · ${hhmm(start)}–${hhmm(end)}</b>`,
    `Free: ${courtsText(courts)}, ${readAt(got)}.`,
  ];
  if (longer.length) lines.push(`Free for the hour after as well, to ${hhmm(longer[0].end)}: ${courtsText(longer.map(s => s.court))}.`);
  if (ctx.linked) lines.push('<b>Hold</b> one and your PC signs in to Glasgow Club, puts it in your basket and opens the payment page. Paying is yours: I never can.');
  lines.push(
    `${ctx.linked ? 'Or book it yourself' : 'To book it'}: open the sheet, press ${hhmm(start)} under a free court, then Book and Continue to payment, and pay by card there. It asks you to sign in.`,
    'The price shows before you pay. The court is yours once the payment has gone through.',
  );
  return screen(lines.join('\n'), [
    ...(ctx.linked ? rows(free.map(s => btn(`Hold court ${s.court}`, `gh:${key}:${d8(dateIso)}:${hm(start)}:${s.court}`)), 2) : []),
    [link(`Open the ${centre.name} sheet`, G.sheetUrl(centre, dateIso))],
    [btn('Other times', `gd:${key}:${d8(dateIso)}`), ...HOME_ROW],
  ]);
}

// A hold that could not be started, and why (`no.say`).
function indoorHoldNo(ctx, key, dateIso, start, court, no) {
  const centre = G.CENTRES[key];
  return screen([
    `<b>${centre.name} · ${label(civilOf(dateIso))} · ${hhmm(start)}–${hhmm(start + 60)} · Court ${court}</b>`,
    M.esc(no.say),
  ].join('\n'), [
    ...(no.wake ? [[btn('Wake my PC', 'wk')]] : []),
    [btn('Try again', `gt:${key}:${d8(dateIso)}:${hm(start)}`), link('Open the sheet', G.sheetUrl(centre, dateIso))],
    [btn('Other times', `gd:${key}:${d8(dateIso)}`), ...HOME_ROW],
  ]);
}

// A court your PC is holding for you, or was. `h` is the hold as app.js keeps it: where it
// has got to (`stage`), how it ended (`end`), and what you have asked of it (`order`).
// While it is going the card has no Menu button: it stays the hold's card, with its buttons.
const HOLD_DOING = {
  asked: 'Your PC has it and is starting Chrome…',
  'signing-in': 'Your PC is signing in to Glasgow Club…',
  'signed-in': 'Signed in. Finding the court on the sheet…',
};
const LAPSES = 'If the court was in your basket and not paid for, the hold lapses by itself.';
const LOOK_UNDER = 'Look under Bookings on Glasgow Club\'s site.';
// Once your PC pressed Pay for you (`h.pressed` true), or may have ('maybe': Chrome gave it no
// answer to the press, or it never said how the press went), an ending that cannot say how the
// payment went must not sound like "nothing happened": it says what is not known, where to
// look, and that nothing was undone.
const PAID_UNKNOWN = 'Whether the payment went through is not known here. Look under Bookings on Glasgow Club\'s site, and in your banking app. Nothing was taken out of your basket.';
const pressedLead = h => (h.pressed === 'maybe' ? 'Your PC may have pressed Pay (whether it did is not known)' : 'Your PC pressed Pay');
// How a hold ended, in words: what is known, and no more than that.
function holdEnding(h) {
  const quote = s => `“${M.esc(s)}”`;
  const why = M.esc(h.why || 'no reason was given');
  switch (h.end) {
    case 'booked':
      return [h.pressed === 'maybe' ? '<b>Booked.</b> It is on your Bookings page at Glasgow Club now, and was not before. Your PC could not tell whether its press of Pay had gone through; your banking app shows what was paid.'
        : h.pressed ? '<b>Booked and paid.</b> Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.'
          : '<b>Booked.</b> It is on your Bookings page at Glasgow Club now, and was not before.', ...(h.words ? [`After the payment the page said: ${quote(h.words)}`] : [])];
    case 'released': {
      const timeUp = h.why === 'time';
      if (h.basket === 'untouched') return ['Stopped. Nothing had gone into your basket.'];
      if (h.basket === 'gone') {
        return [`${timeUp ? 'Its time was up' : 'You asked me to let it go'}, but the court was no longer in the basket on your PC: it had been paid for, or the site had already let it go. Nothing was taken out.`, LOOK_UNDER];
      }
      if (h.basket === 'empty' && h.removed) return [timeUp ? 'Not paid in time, so your PC took the court out of your basket again.' : 'Let go: your PC took the court out of your basket, so it was not paid for.'];
      return [`${timeUp ? 'Not paid in time, so your PC went to take the court out of your basket' : 'Your PC went to take the court out of your basket'}, but I could not see that the basket is empty. An unpaid court lapses by itself.`];
    }
    case 'left':
    case 'unsure': {
      const first = h.pressed ? `${pressedLead(h)}${h.end === 'left' ? ' and the payment page moved on' : ', and the payment page never moved on'}`
        : h.end === 'left' ? 'The payment page on your PC moved on' : 'You said you have paid';
      const bank = h.pressed ? ' Look in your banking app too: if the money has gone and the court is not under Bookings, that is one for Glasgow Club.' : '';
      const seen = `I could not see the court as a new booking on your Bookings page${h.checked ? '' : ' (I could not read it)'}`;
      const basket = h.basket === 'still' ? 'It is still in the basket on your PC, so it does not look paid for. I left it there; unpaid, it lapses by itself.'
        : h.basket === 'gone' ? 'It is no longer in the basket, so the site either took the payment or let the court go.'
          : 'I could not read the basket either.';
      return [`${first}, but ${seen}.`, ...(h.words ? [`The page said: ${quote(h.words)}`] : []), `${basket} I have closed Chrome on your PC. ${LOOK_UNDER}${bank}`];
    }
    case 'failed':
      if (h.stage === 'held') return [`Something went wrong after ${h.pressed === 'maybe' ? 'your PC may have pressed Pay' : h.pressed ? 'your PC pressed Pay' : 'the court was in your basket'}: ${why}.`, `I cannot say how it ended. ${LOOK_UNDER}${h.pressed ? ' Look in your banking app too.' : ''}`];
      return [`It did not work: ${why}.`, `Nothing was booked or paid.${h.basket === 'empty' ? ' Your basket is empty.'
        : h.basket === 'items' ? ' Something is still in your basket; unpaid, it lapses by itself.'
          : h.basket === 'unclear' ? ' I could not see that your basket is empty; an unpaid court lapses by itself.' : ''}`];
    case 'refused': return [`Your PC did not start on it: ${why}.`, 'Nothing was done.'];
    // After a press, the four endings below know nothing of the payment, and say so, instead
    // of "an unpaid hold lapses by itself".
    case 'closed': return h.pressed ? [`${pressedLead(h)}, and then the Chrome window on your PC was closed, so I cannot see how it ended.`, PAID_UNKNOWN]
      : [`The Chrome window on your PC was closed, so I cannot see how it ended. ${LAPSES}`];
    case 'slept': return h.pressed ? [`${pressedLead(h)}, and then your PC went to sleep, so it stopped there.`, PAID_UNKNOWN]
      : [`Your PC went to sleep while it had the court, so it stopped there. ${LAPSES}`];
    case 'gone': return h.pressed ? [`${pressedLead(h)}, and then the tool on your PC stopped without saying how it ended${h.why ? ` (${why})` : ''}.`, PAID_UNKNOWN]
      : [`The tool on your PC stopped without saying how it ended${h.why ? ` (${why})` : ''}. ${LAPSES}`];
    case 'nopickup': return ['Your PC did not pick it up in time, so nothing was done. It may have gone to sleep.'];
    case 'nostart': return ['Your PC picked it up but never started on it, so nothing was done. Its PC link may need restarting.'];
    case 'stopped': return ['Stopped before your PC had started. Nothing was done.'];
    default: return h.pressed ? [`${pressedLead(h)}, and I have heard nothing more from your PC about this.`, PAID_UNKNOWN]
      : [`I have heard nothing more from your PC about this. ${LAPSES}`];
  }
}
// A message about a hold the bot is no longer following (it restarted while your PC held the
// court, or gave the hold up), sent only when your PC says Pay was pressed for it or may have
// been: while it is still going, and when it has ended, in the words its card would have had.
function indoorHoldStray(ctx, h) {
  const centre = Object.prototype.hasOwnProperty.call(G.CENTRES, h.key) ? G.CENTRES[h.key] : null;
  const lines = [
    centre ? `<b>${centre.name} · ${label(civilOf(h.date))} · ${hhmm(h.start)}–${hhmm(h.start + 60)} · Court ${h.court}</b>` : '<b>A court your PC was holding</b>',
    'I am no longer following this hold (I was restarted while your PC had it, or had given it up), so its card does not change any more. This is what your PC says:',
  ];
  if (h.end) lines.push(...holdEnding(h));
  else lines.push(`${pressedLead(h)}, and it is waiting for Glasgow Club's answer. If your bank asks you to approve the payment, that is yours to do in your banking app.`, `${PAID_UNKNOWN} I will say here how it ended, if your PC tells me.`);
  return screen(lines.join('\n'), [[link('Open Glasgow Club', G.siteUrl)], HOME_ROW]);
}
function indoorHold(ctx, h) {
  const centre = G.CENTRES[h.key];
  const lines = [`<b>${centre.name} · ${label(civilOf(h.date))} · ${hhmm(h.start)}–${hhmm(h.start + 60)} · Court ${h.court}</b>`];
  if (h.end) {
    lines.push(...holdEnding(h));
    const again = [btn('Other times', `gd:${h.key}:${d8(h.date)}`), ...HOME_ROW];
    const site = ['booked', 'left', 'unsure'].includes(h.end) || (h.end === 'released' && h.basket === 'gone') || (h.end === 'failed' && h.stage === 'held') || !!h.pressed;
    return screen(lines.join('\n'), [
      ...(h.end === 'nopickup' && ctx.wake === 'ready' && ctx.pc !== 'awake' ? [[btn('Wake my PC', 'wk')]] : []),
      ...(site ? [[link('Open Glasgow Club', G.siteUrl)]] : []),
      ...(!site && ['failed', 'refused', 'nopickup', 'nostart'].includes(h.end) ? [[link('Open the sheet', G.sheetUrl(centre, h.date))]] : []),
      h.end === 'booked' ? HOME_ROW : again,
    ]);
  }
  let keys;
  if (!h.taken) {
    lines.push('Asking your PC to hold it. It signs in to Glasgow Club, puts the court in your basket and opens the payment page: under a minute.');
    keys = [[btn('Stop', `gx:${h.id}`)]];
  } else if (h.stage !== 'held') {
    lines.push(HOLD_DOING[h.stage] || `Putting court ${h.court} in your basket…`);
    if (h.order) lines.push('Stopping…');
    keys = h.order ? [] : [[btn('Stop', `gx:${h.id}`)]];
  } else if (h.payState === 'confirm') {
    // You tapped Pay: the amount, said once more, before anything is typed anywhere.
    lines.push(
      `Pay <b>${M.esc(h.price)}</b> for this court with the card kept on your PC?`,
      'Your PC types the card into Glasgow Club\'s payment page and presses Pay. If your bank asks you to approve it, that is yours to do in your banking app.',
    );
    keys = [[btn(`Yes, pay ${h.price}`, `gz:${h.id}:${Math.round(Number(h.price.slice(1)) * 100)}`)], [btn('Back', `gb:${h.id}`)]];
  } else if (h.payState === 'asked') {
    lines.push(`<b>In your basket</b>: ${M.esc(h.price)} to pay.`, 'Paying: your PC is typing the card into the payment page and pressing Pay…');
    keys = [];
  } else if (h.payState === 'pressed') {
    // The time is when the PC's word reached here, a few seconds after the press itself.
    lines.push(
      `Your PC pressed <b>Pay ${M.esc(h.payAmount || h.price)}</b>; I heard so at ${hhmm(londonMinutes(h.pressedAt))}. If your bank asks you to approve it, do that now in your banking app.`,
      'Waiting for Glasgow Club\'s answer…',
    );
    if (h.payWords) lines.push(`The payment page says: “${M.esc(h.payWords)}”`);
    keys = [];
  } else if (h.payState === 'maybe') {
    // The press was sent and Chrome gave the PC no answer that says whether it landed.
    lines.push(
      `Your PC <b>may have pressed Pay ${M.esc(h.payAmount || h.price)}</b>: ${M.esc(h.payDoubt || 'it could not tell whether the press went through')}. I heard so at ${hhmm(londonMinutes(h.pressedAt))}.`,
      'Take it as pressed. Before you pay any other way, look under Bookings on Glasgow Club\'s site and in your banking app. If your bank asks you to approve this payment, that is yours to decide.',
      'Your PC takes nothing out of your basket, and is waiting for Glasgow Club\'s answer…',
    );
    if (h.payWords) lines.push(`The payment page says: “${M.esc(h.payWords)}”`);
    keys = [[link('Open Glasgow Club', G.siteUrl)]];
  } else {
    lines.push(`<b>In your basket</b>${h.price ? `: ${M.esc(h.price)} to pay` : ''}. Your PC signed in as you and put it there at ${hhmm(londonMinutes(h.heldAt))}. The payment page is open in Chrome on your PC.`);
    // Pay is offered only when the PC says it can, and this bot is locked to you (TELEGRAM_CHAT_ID).
    const canPay = ctx.pinned === true && h.pay === 'ready' && !!h.price && !h.payState && !h.order;
    if (h.payState === 'failed') lines.push(`Your PC could not pay: ${M.esc(h.payFailed)}. Pay was not pressed, so nothing was paid.`);
    if (h.order === 'release') lines.push('Letting it go…');
    else if (h.order === 'done') lines.push('Looking for it on your Bookings page…');
    else {
      if (canPay) lines.push('<b>Pay from my PC</b>: your PC pays with the card kept on it, once you have confirmed the amount.');
      else if (h.pay && h.pay !== 'ready' && h.payWhy) lines.push(`Paying from your PC is not on${h.pay === 'unpinned' ? '' : ' for this one'}: ${M.esc(h.payWhy)}.`);
      lines.push(
        `${canPay ? 'Or on' : 'To pay on'} this phone: open your basket below and sign in. If the court is there, pay there, then tap <b>I have paid</b>.`,
        'Nobody has tried that yet. If your basket comes up empty, the court is only in the browser on your PC: pay in the Chrome window there, or let it go.',
        `Unpaid, your PC lets it go at ${hhmm(londonMinutes(h.until))}.`,
      );
    }
    keys = h.order ? [] : [
      ...(canPay ? [[btn(`Pay ${h.price} from my PC`, `gy:${h.id}`)]] : []),
      [link('Open my basket', G.basketUrl)], [btn('I have paid', `gp:${h.id}`), btn('Let it go', `gx:${h.id}`)],
    ];
  }
  if (h.taken && h.silent) lines.push('No word from your PC for over a minute. It may have lost its connection.');
  return screen(lines.join('\n'), keys);
}

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
    [btn('Back', 'b'), ...HOME_ROW],
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
    [btn('Book another', 'bk'), btn('My bookings', 'm')],
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
  home, pcLine, venues, indoorDays, indoorWait, indoorDay, indoorSlot, indoorHold, indoorHoldNo, indoorHoldStray,
  calendar, times, lengths, confirmOnce, added, weekly, weeklyDay, weeklyTimes, weeklyLengths, weeklySaved,
  bookings, order, status, sleepConfirm, afterBooked, afterFailed, afterMissing, afterNotAnswering,
  d8, fromD8, hm, fromHm, monthOf, MAX_AHEAD_DAYS, INDOOR_DAYS, FIRST_START, LAST_END,
};
