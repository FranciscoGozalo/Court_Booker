'use strict';
// The words and buttons the bot sends. Telegram HTML formatting, plain text, no emoji.

const { label, hhmm, clockAt, inWords, DAY_KEYS, DAY_LONG } = require('./time');
const { SHEET, sheetUrl, directUrl } = require('./links');
const { slotText } = require('./plan');
const { nextRelease } = require('./schedule');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NO_PREVIEW = { is_disabled: true };   // so nothing fetches the links on your behalf
const span = (start, end) => `${hhmm(start)}–${hhmm(end)}`;

// The courts to offer, best first: the free ones once the sheet has been read, otherwise all six in the owner's order.
const offered = (cfg, view) => (view && view.mode === 'pick' ? [view.best, ...view.others] : cfg.order);

// Six court buttons in the owner's order, then the whole sheet. They are the same before
// and after the release, so nothing under the owner's thumb changes at the moment that matters.
// Once the sheet shows which courts are free: one wide button for the first free court in the
// owner's order, the other free courts under it, then the whole sheet.
function courtKeyboard(cfg, date, start, end, view = null) {
  const sheetRow = [{ text: 'Whole sheet', url: sheetUrl(date) }];
  if (view && view.mode === 'pick') {
    const others = view.others.map(n => ({ text: `Court ${n}`, url: directUrl(n, date, start, end, cfg.sid) }));
    const rows = [[{ text: `Book Court ${view.best}`, url: directUrl(view.best, date, start, end, cfg.sid) }]];
    for (let i = 0; i < others.length; i += 3) rows.push(others.slice(i, i + 3));
    return { inline_keyboard: [...rows, sheetRow] };
  }
  const courts = cfg.order.map(n => ({ text: `Court ${n}`, url: directUrl(n, date, start, end, cfg.sid) }));
  return { inline_keyboard: [courts.slice(0, 3), courts.slice(3), sheetRow] };
}
// The same links written out, for people who prefer tapping an address to tapping a button.
function courtLinks(cfg, date, start, end, view = null) {
  return offered(cfg, view).map(n => `Court ${n}\n${esc(directUrl(n, date, start, end, cfg.sid))}`).join('\n\n')
    + `\n\nWhole sheet\n${esc(sheetUrl(date))}`;
}
// How the courts are shown:
//   card     a picture on top, the words as its caption, the court buttons under it (the default)
//   buttons  plain text with the court buttons (Telegram asks "Open this link?" before each one)
//   both     the buttons, plus the first-choice court written out, which opens in one tap
//   links    the same courts written out
// A card comes back marked `card: true`; whoever sends it adds the picture.
function withCourts(cfg, head, date, start, end, view = null) {
  const extra = { parse_mode: 'HTML', link_preview_options: NO_PREVIEW };
  if (cfg.style === 'links') return { text: `${head}\n\n${courtLinks(cfg, date, start, end, view)}`, extra };
  const reply_markup = courtKeyboard(cfg, date, start, end, view);
  if (cfg.style === 'card') return { text: head, extra: { parse_mode: 'HTML', reply_markup }, card: true };
  extra.reply_markup = reply_markup;
  if (cfg.style !== 'both') return { text: head, extra };
  const first = offered(cfg, view)[0];
  return { text: `${head}\n\nCourt ${first}, one tap:\n${esc(directUrl(first, date, start, end, cfg.sid))}`, extra };
}

// Five minutes before: say what is coming and let them check they are signed in.
function warnMessage(cfg, rel, nowMs) {
  const text = `<b>${label(rel.playDate)} · ${span(rel.start, rel.end)}</b>\n`
    + `Booking opens at ${hhmm(cfg.releaseMin)}. Your courts arrive at ${clockAt(rel.releaseAt - cfg.lead * 1000)}.\n`
    + `Court order: ${cfg.order.join(', ')}. Check you are signed in now.`;
  return { text, extra: { parse_mode: 'HTML', link_preview_options: NO_PREVIEW, reply_markup: { inline_keyboard: [[{ text: 'Check I am signed in', url: SHEET }]] } } };
}

// The courts. `phase` is 'wait' before the release and 'go' from the release on. Both have
// the same number of lines, so swapping one for the other does not move the buttons.
// `view` is what the booking sheet showed (see courtView in availability.js); null if it was not read.
const GO_LINE = '<b>GO</b> · tap a court now';
const asView = v => (v && typeof v === 'object' && typeof v.mode === 'string' ? v : null);
const goLine = view => (view && view.mode === 'pick' ? `<b>GO</b> · tap Court ${view.best} now` : GO_LINE);
// One more line once the sheet has been read, saying what it showed.
function freeLine(view, phase) {
  if (!view) return '';
  if (view.mode === 'pick') {
    if (phase === 'go') return view.others.length ? `\nAlso free: ${view.others.join(', ')}` : '\nNo other court is free';
    return `\nCourt ${view.best} is free${view.others.length ? ` · then ${view.others.join(', ')}` : ''}`;
  }
  if (view.mode === 'none') return '\nNo court shows as free · all six below';
  return '\nCould not check which courts are free · all six below';
}
function linksMessage(cfg, rel, phase, view = null) {
  view = asView(view);
  const line1 = `<b>${label(rel.playDate)} · ${span(rel.start, rel.end)}</b>`;
  const line2 = phase === 'go' ? goLine(view) : `Opens at ${clockAt(rel.releaseAt)}${cfg.go ? ' · wait for GO' : ''}`;
  return withCourts(cfg, `${line1}\n${line2}${freeLine(view, phase)}`, rel.playDate, rel.start, rel.end, view);
}

// A try-out with links for a day that is already open.
function testMessage(cfg, rel, date, phase, view = null) {
  view = asView(view);
  const line1 = `<b>Test · ${label(date)} · ${span(rel.start, rel.end)}</b>`;
  const line2 = phase === 'go' ? goLine(view) : `Opens at the release${cfg.go ? ' · wait for GO' : ''}`;
  const line3 = 'Test only. This day is already open, so a free court shows the confirm screen. Back out and nothing is booked.';
  return withCourts(cfg, `${line1}\n${line2}${freeLine(view, phase)}\n${line3}`, date, rel.start, rel.end, view);
}

// The answer to /free: what the sheet shows for each court, in the owner's order.
function freeMessage(cfg, date, rel, answer, checking) {
  const head = `<b>Free courts · ${label(date)} · ${span(rel.start, rel.end)}</b>`;
  const off = checking ? '' : '\n\nChecking is off for the alerts, so they show all six courts. Send /free on to switch it on.';
  if (!answer.ok) {
    return `${head}\nCould not read the booking sheet: ${esc(answer.why)}.\nThe alerts will show all six courts, as before.${off}`;
  }
  if (!answer.visible) return `${head}\nClubSpark answered, but the sheet shows nothing for that day.${off}`;
  const lines = cfg.order.map(n => `Court ${n}: ${answer.courts[n]}`);
  const free = cfg.order.filter(n => answer.courts[n] === 'free');
  const lead = !checking ? off
    : free.length ? `\n\nOn booking nights the alert leads with the first free court in your order, and moves on as courts are taken.`
      : '\n\nNo court is free for that slot. On booking nights, if none shows as free, the alert offers all six.';
  return `${head}\n${lines.join('\n')}\n\nRead from ClubSpark in ${(answer.ms / 1000).toFixed(1)} s.${lead}`;
}

function planLines(cfg) {
  const days = [1, 2, 3, 4, 5, 6, 0].map(i => DAY_KEYS[i]).filter(k => cfg.plan[k]);
  if (!days.length) return ['No days set yet. Add one with, for example:  /set thu 19:00 2h'];
  return days.map(k => `${DAY_LONG[DAY_KEYS.indexOf(k)]} · ${slotText(cfg.plan[k])}`);
}

function nextLine(cfg, nowMs, paused) {
  if (paused) return 'Alerts are paused. Send /resume to switch them back on.';
  const rel = nextRelease(nowMs, cfg);
  if (!rel) return 'No alert is scheduled.';
  const sendAt = rel.releaseAt - cfg.lead * 1000;
  return `Next alert: ${label(rel.night)} at ${clockAt(sendAt)} (${inWords(sendAt - nowMs)}), for ${label(rel.playDate)}, ${span(rel.start, rel.end)}.`;
}

function planMessage(cfg, nowMs, paused) {
  return [
    '<b>Your plan</b>',
    ...planLines(cfg).map(esc),
    '',
    `Court order: ${cfg.order.join(', ')}`,
    `Alert ${cfg.lead} s before the ${hhmm(cfg.releaseMin)} release${cfg.go ? ', then GO' : ''}.`,
    cfg.warnMin > 0 ? `Heads-up ${cfg.warnMin} min before.` : 'No heads-up message.',
    '',
    esc(nextLine(cfg, nowMs, paused)),
  ].join('\n');
}

const HELP = [
  '<b>Court alert</b>',
  'I message you the courts just before Kelvingrove releases a new day. I read the public booking sheet to see which courts are free and lead with the first free one in your order. You tap, ClubSpark shows the confirm screen, you confirm and pay. I never sign in or book anything myself.',
  '',
  '<b>Set it up</b>',
  '/set thu 19:00 2h  : alert for Thursdays, 19:00, two hours',
  '/off thu  : stop Thursdays  (/off all for everything)',
  '/order 4 3 5 2 6 1  : which courts to offer first',
  '/plan  : show the plan and the next alert',
  '/test  : send the courts now for a day that is already open',
  '/free  : which courts are free now  (/free off to always show all six)',
  '/signin  : open the booking sheet to sign in',
  '',
  '<b>Fine tuning</b>',
  '/style card  : a picture card that changes when booking opens',
  '/style buttons  : plain text with the court buttons',
  '/style both  : plain text, plus your first-choice court written out as a link that opens in one tap',
  '/style links  : the courts written out as one-tap links',
  '/lead 30  : seconds before the release that the alert arrives',
  '/warn 5  : minutes before for the heads-up (0 for none)',
  '/go off  : do not turn the message to GO at the release',
  '/code  : new booking code (or just paste a confirm-screen address)',
  '/pause  and  /resume',
  '/backup  : your settings as one line, to keep them without a volume',
  '/status  and  /id',
].join('\n');

// How the free-court check is doing, for /status.
function checkLine(check) {
  if (!check) return 'Free-court check: unavailable in this build';
  if (!check.on) return 'Free-court check: off (send /free on)';
  if (!check.last) return 'Free-court check: on, not run yet (send /free to try it)';
  const when = clockAt(check.last.at);
  return check.last.ok ? `Free-court check: on, last read the sheet at ${when}`
    : `Free-court check: on, but at ${when} it failed: ${esc(check.last.why)}`;
}

function statusMessage(cfg, nowMs, info) {
  const skew = info.skewMs;
  const clockLine = skew === null ? 'Clock: not checked yet'
    : Math.abs(skew) <= 1500 ? "Clock: in step with Telegram's"
      : `Clock: ${Math.abs(Math.round(skew / 1000))} s ${skew > 0 ? 'ahead of' : 'behind'} Telegram's, so alerts will be ${skew > 0 ? 'early' : 'late'} by that much`;
  return [
    `<b>Status</b>  (version ${esc(info.version)})`,
    `UK time now: ${clockAt(nowMs)}`,
    clockLine,
    `Settings kept across restarts: ${info.kept === 'disk' ? 'yes' : info.kept === 'variable' ? 'yes, from the COURT_SETTINGS variable' : 'NO. Add a Railway volume mounted at /data, or send /backup'}`,
    `Booking code ends ${cfg.sid.slice(-6)}`,
    `Style: ${cfg.style}`,
    checkLine(info.check),
    '',
    esc(nextLine(cfg, nowMs, info.paused)),
  ].join('\n');
}

module.exports = {
  esc, courtKeyboard, courtLinks,
  warnMessage, linksMessage, testMessage, freeMessage, planMessage, nextLine, statusMessage, HELP, NO_PREVIEW,
};
