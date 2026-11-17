'use strict';
// The words and buttons the bot sends. Telegram HTML formatting, plain text, no emoji.

const { label, hhmm, clockAt, inWords, DAY_KEYS, DAY_LONG } = require('./time');
const { SHEET, sheetUrl, directUrl } = require('./links');
const { slotText } = require('./plan');
const { nextRelease } = require('./schedule');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NO_PREVIEW = { is_disabled: true };   // so nothing fetches the links on your behalf
const span = (start, end) => `${hhmm(start)}–${hhmm(end)}`;

// Six court buttons in the owner's order, then the whole sheet. From the release on the
// courts take colour: green for the first choice, blue for the rest. The buttons themselves,
// and where they sit, are the same before and after.
function courtKeyboard(cfg, date, start, end, phase) {
  const courts = cfg.order.map((n, i) => {
    const b = { text: `Court ${n}`, url: directUrl(n, date, start, end, cfg.sid) };
    if (phase === 'go') b.style = i === 0 ? 'success' : 'primary';
    return b;
  });
  return { inline_keyboard: [courts.slice(0, 3), courts.slice(3), [{ text: 'Whole sheet', url: sheetUrl(date) }]] };
}
// The same links written out, for people who prefer tapping an address to tapping a button.
function courtLinks(cfg, date, start, end) {
  return cfg.order.map(n => `Court ${n}\n${esc(directUrl(n, date, start, end, cfg.sid))}`).join('\n\n')
    + `\n\nWhole sheet\n${esc(sheetUrl(date))}`;
}
// How the courts are shown:
//   buttons  buttons only: the tidy default (Telegram asks "Open this link?" before each one)
//   both     the buttons, plus the first-choice court written out, which opens in one tap
//   links    all six written out
function withCourts(cfg, head, date, start, end, phase) {
  const extra = { parse_mode: 'HTML', link_preview_options: NO_PREVIEW };
  if (cfg.style === 'links') return { text: `${head}\n\n${courtLinks(cfg, date, start, end)}`, extra };
  extra.reply_markup = courtKeyboard(cfg, date, start, end, phase);
  if (cfg.style !== 'both') return { text: head, extra };
  const first = cfg.order[0];
  return { text: `${head}\n\nCourt ${first}, one tap:\n${esc(directUrl(first, date, start, end, cfg.sid))}`, extra };
}

// The same message with the button colours taken off, in case Telegram ever refuses them.
function hasColours(m) {
  const kb = m.extra && m.extra.reply_markup && m.extra.reply_markup.inline_keyboard;
  return !!kb && kb.some(row => row.some(b => b.style));
}
function withoutColours(m) {
  if (!hasColours(m)) return m;
  const rows = m.extra.reply_markup.inline_keyboard.map(row => row.map(({ style, ...b }) => b));
  return { text: m.text, extra: { ...m.extra, reply_markup: { inline_keyboard: rows } } };
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
function linksMessage(cfg, rel, phase, nowMs) {
  const line1 = `<b>${label(rel.playDate)} · ${span(rel.start, rel.end)}</b>`;
  const line2 = phase === 'go'
    ? '<b>GO.</b> Tap a court now.'
    : `Opens at ${clockAt(rel.releaseAt)}, ${inWords(rel.releaseAt - nowMs)}. Wait for GO.`;
  return withCourts(cfg, `${line1}\n${line2}`, rel.playDate, rel.start, rel.end, phase);
}

// A try-out with links for a day that is already open.
function testMessage(cfg, rel, date, phase) {
  const line1 = `<b>Test · ${label(date)} · ${span(rel.start, rel.end)}</b>`;
  const line2 = phase === 'go'
    ? '<b>GO.</b> This is how it turns at the release.'
    : 'Waiting. On the night this line counts down to the release.';
  const line3 = 'This day is already open, so a free court shows the confirm screen. Back out and nothing is booked.';
  return withCourts(cfg, `${line1}\n${line2}\n${line3}`, date, rel.start, rel.end, phase);
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
  'I message you the court buttons just before Kelvingrove releases a new day. You tap, ClubSpark shows the confirm screen, you confirm and pay. I never contact ClubSpark myself.',
  '',
  '<b>Set it up</b>',
  '/set thu 19:00 2h  : alert for Thursdays, 19:00, two hours',
  '/off thu  : stop Thursdays  (/off all for everything)',
  '/order 4 3 5 2 6 1  : which courts to offer first',
  '/plan  : show the plan and the next alert',
  '/test  : send the courts now for a day that is already open',
  '/signin  : open the booking sheet to sign in',
  '',
  '<b>Fine tuning</b>',
  '/style buttons  : court buttons only (Telegram asks "Open this link?" on each)',
  '/style both  : also writes out your first-choice court as a link that opens in one tap',
  '/style links  : all six courts written out as one-tap links',
  '/lead 30  : seconds before the release that the alert arrives',
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

module.exports = {
  esc, courtKeyboard, courtLinks, hasColours, withoutColours,
  warnMessage, linksMessage, testMessage, planMessage, nextLine, statusMessage, HELP, NO_PREVIEW,
};
