'use strict';
// The words and buttons the bot sends. Telegram HTML formatting.

const { label, hhmm, clockAt, inWords, DAY_KEYS, DAY_LONG } = require('./time');
const { SHEET, sheetUrl, directUrl } = require('./links');
const { slotText } = require('./plan');
const { nextRelease } = require('./schedule');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NO_PREVIEW = { is_disabled: true };   // so nothing fetches the links on your behalf

// Six court buttons in the owner's order, then the whole sheet.
function courtKeyboard(cfg, date, start, end) {
  const btn = n => ({ text: `Court ${n}`, url: directUrl(n, date, start, end, cfg.sid) });
  return { inline_keyboard: [cfg.order.slice(0, 3).map(btn), cfg.order.slice(3).map(btn), [{ text: 'Whole sheet', url: sheetUrl(date) }]] };
}
// The same links written out, for people who prefer tapping an address to tapping a button.
function courtLinks(cfg, date, start, end) {
  return cfg.order.map(n => `Court ${n}\n${esc(directUrl(n, date, start, end, cfg.sid))}`).join('\n\n')
    + `\n\nWhole sheet\n${esc(sheetUrl(date))}`;
}
// How the courts are shown:
//   both     the first-choice court written out (one tap), then buttons for all six
//   links    all six written out
//   buttons  buttons only (tidy, but Telegram asks "Open this link?" before each one)
function withCourts(cfg, head, date, start, end) {
  const extra = { parse_mode: 'HTML', link_preview_options: NO_PREVIEW };
  if (cfg.style === 'links') return { text: `${head}\n\n${courtLinks(cfg, date, start, end)}`, extra };
  extra.reply_markup = courtKeyboard(cfg, date, start, end);
  if (cfg.style === 'buttons') return { text: head, extra };
  const first = cfg.order[0];
  return { text: `${head}\n\nCourt ${first}, one tap:\n${esc(directUrl(first, date, start, end, cfg.sid))}`, extra };
}

// Five minutes before: say what is coming and let them check they are signed in.
function warnMessage(cfg, rel, nowMs) {
  const text = `<b>Kelvingrove · ${label(rel.playDate)} opens at ${hhmm(cfg.releaseMin)}</b>\n`
    + `Your slot: ${hhmm(rel.start)} to ${hhmm(rel.end)}. Courts in order: ${cfg.order.join(', ')}.\n`
    + `The court links arrive at ${clockAt(rel.releaseAt - cfg.lead * 1000)}. Check you are signed in now.`;
  return { text, extra: { parse_mode: 'HTML', link_preview_options: NO_PREVIEW, reply_markup: { inline_keyboard: [[{ text: 'Check I am signed in', url: SHEET }]] } } };
}

// The links. `phase` is 'wait' before the release and 'go' from the release on. Both have
// the same number of lines, so swapping one for the other does not move the buttons.
function linksMessage(cfg, rel, phase, nowMs) {
  const line1 = `<b>${label(rel.playDate)} · ${hhmm(rel.start)} to ${hhmm(rel.end)}</b>`;
  const line2 = phase === 'go'
    ? '🟢 GO. Open now. Tap a court.'
    : `⏳ Opens at ${clockAt(rel.releaseAt)}, ${inWords(rel.releaseAt - nowMs)}. Wait for GO.`;
  return withCourts(cfg, `${line1}\n${line2}`, rel.playDate, rel.start, rel.end);
}

// A try-out with links for a day that is already open.
function testMessage(cfg, rel, date, phase) {
  const line1 = `<b>TEST · ${label(date)} · ${hhmm(rel.start)} to ${hhmm(rel.end)}</b>`;
  const line2 = phase === 'go'
    ? '🟢 This is what GO looks like on the night.'
    : 'This day is already open, so each court should show the confirm screen.';
  return withCourts(cfg, `${line1}\n${line2}\nBack out without confirming and nothing is booked.`, date, rel.start, rel.end);
}

function planLines(cfg) {
  const days = [1, 2, 3, 4, 5, 6, 0].map(i => DAY_KEYS[i]).filter(k => cfg.plan[k]);
  if (!days.length) return ['No days set yet. Add one with, for example:  /set thu 19:00 2h'];
  return days.map(k => `${DAY_LONG[DAY_KEYS.indexOf(k)]}: ${slotText(cfg.plan[k])}`);
}

function nextLine(cfg, nowMs, paused) {
  if (paused) return 'Alerts are paused. Send /resume to switch them back on.';
  const rel = nextRelease(nowMs, cfg);
  if (!rel) return 'No alert is scheduled.';
  const sendAt = rel.releaseAt - cfg.lead * 1000;
  return `Next alert: ${label(rel.night)} at ${clockAt(sendAt)} (${inWords(sendAt - nowMs)}), for ${label(rel.playDate)} ${hhmm(rel.start)} to ${hhmm(rel.end)}.`;
}

function planMessage(cfg, nowMs, paused) {
  return [
    '<b>Your plan</b>',
    ...planLines(cfg).map(esc),
    '',
    `Court order: ${cfg.order.join(', ')}`,
    `Links arrive ${cfg.lead} s before the ${hhmm(cfg.releaseMin)} release${cfg.go ? ', then turn to GO' : ''}.`,
    cfg.warnMin > 0 ? `Heads-up ${cfg.warnMin} min before.` : 'No heads-up message.',
    '',
    esc(nextLine(cfg, nowMs, paused)),
  ].join('\n');
}

const HELP = [
  '<b>Court alert</b>',
  'I message you the court links just before Kelvingrove releases a new day. You tap, ClubSpark shows the confirm screen, you confirm and pay. I never contact ClubSpark myself.',
  '',
  '<b>Set it up</b>',
  '/set thu 19:00 2h  : alert for Thursdays, 19:00, two hours',
  '/off thu  : stop Thursdays  (/off all for everything)',
  '/order 4 3 5 2 6 1  : which courts to offer first',
  '/plan  : show the plan and the next alert',
  '/test  : send the links now for a day that is already open',
  '/signin  : open the booking sheet to sign in',
  '',
  '<b>Fine tuning</b>',
  '/style both  : first-choice court as a one-tap link, buttons for the rest',
  '/style links  : all six courts as one-tap links',
  '/style buttons  : buttons only (Telegram asks "Open this link?" on each)',
  '/lead 30  : seconds before the release that the links arrive',
  '/warn 5  : minutes before for the heads-up (0 for none)',
  '/go off  : do not turn the message to GO at the release',
  '/code  : new booking code (or just paste a confirm-screen address)',
  '/pause  and  /resume',
  '/backup  : your settings as one line, to keep them without a volume',
  '/status  and  /id',
].join('\n');

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
    '',
    esc(nextLine(cfg, nowMs, info.paused)),
  ].join('\n');
}

module.exports = { esc, courtKeyboard, courtLinks, warnMessage, linksMessage, testMessage, planMessage, nextLine, statusMessage, HELP, NO_PREVIEW };
