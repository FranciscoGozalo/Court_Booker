'use strict';
// The words the bot sends. Telegram HTML formatting, plain text, no emoji.

const { label, hhmm, clockAt, inWords, addDays, DAY_KEYS, DAY_LONG } = require('./time');
const { slotText } = require('./plan');
const { upcoming, civilOf, opensAt } = require('./schedule');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (start, end) => `${hhmm(start)}–${hhmm(end)}`;
const dayOf = isoDate => label(civilOf(isoDate));
const slotOf = j => `${dayOf(j.date)} · ${span(j.start, j.end)}`;

// When the PC checks in before a release: what it is about to book. Goes on the "wait" banner.
function headsUp(cfg, jobs) {
  const lines = jobs.map(j => `<b>${slotOf(j)}</b>`);
  return [
    `Booking at ${clockAt(jobs[0].releaseAt).slice(0, 5)}`,
    ...lines,
    `Courts in order: ${cfg.order.join(', ')}`,
    'Your PC is ready.',
  ].join('\n');
}

// A booking made. Goes on the "open" banner.
function bookedCaption(r) {
  const gate = r.gate ? `Gate code: <code>${esc(r.gate)}</code>  (tap to copy)`
    : 'Gate code: not shown. It is in your ClubSpark booking and the confirmation email.';
  return [`<b>Booked · Court ${esc(r.court)}</b>`, slotOf(r), gate].join('\n');
}

// A booking that did not happen, and why.
function failedText(r) {
  const why = r.status === 'none'
    ? 'No court was free for the whole slot.'
    : `It did not work: ${esc(r.why || 'no reason given')}.`;
  return [`<b>Not booked · ${slotOf(r)}</b>`, why, 'Book by hand on ClubSpark if you still want it.'].join('\n');
}

// The PC has not been in touch shortly before a release.
function missingText(cfg, rel) {
  return [
    '<b>Your PC has not checked in</b>',
    `Booking opens at ${hhmm(cfg.releaseMin)} for ${rel.requests.map(r => slotOf(r)).join(' and ')}, but the booker on your PC has not been in touch.`,
    'It may be off, or asleep without its wake timer. Book by hand on ClubSpark if you can.',
  ].join('\n');
}

function weeklyLines(cfg) {
  const days = [1, 2, 3, 4, 5, 6, 0].map(i => DAY_KEYS[i]).filter(k => cfg.plan[k]);
  return days.map(k => `${DAY_LONG[DAY_KEYS.indexOf(k)]}s · ${slotText(cfg.plan[k])}`);
}

// One-offs, numbered for /cancel, with how each stands.
function onceLines(cfg, nowMs, results) {
  return (cfg.once || []).map((o, i) => {
    const r = results[`${o.date}@${hhmm(o.start)}`];
    const opens = opensAt(civilOf(o.date), cfg);
    const state = r && r.status === 'booked' ? `booked, Court ${r.court}${r.gate ? `, gate ${r.gate}` : ''}`
      : opens > nowMs ? `opens ${label(addDays(civilOf(o.date), -cfg.daysAhead))} ${hhmm(cfg.releaseMin)}`
        : 'open now, your PC books it on its next run';
    return `${i + 1}. ${dayOf(o.date)} · ${slotText(o)} (${state})`;
  });
}

function nextLine(cfg, nowMs, paused) {
  if (paused) return 'Booking is paused. Send /resume to switch it back on.';
  const [rel] = upcoming(nowMs, cfg, 1);
  if (!rel) return 'Nothing to book yet.';
  return `Next booking: ${label(rel.night)} at ${hhmm(cfg.releaseMin)} (${inWords(rel.releaseAt - nowMs)}), for ${rel.requests.map(r => slotOf(r)).join(' and ')}.`;
}

function planMessage(cfg, nowMs, paused, results) {
  const weekly = weeklyLines(cfg);
  const once = onceLines(cfg, nowMs, results);
  return [
    '<b>Every week</b>',
    ...(weekly.length ? weekly : ['Nothing yet. Add one with  /set thu 19:00 2h']),
    '',
    '<b>One-off dates</b>',
    ...(once.length ? once : ['None. Add one with  /book 25 nov 19:00 2h']),
    '',
    `Court order: ${cfg.order.join(', ')}`,
    `Days open ${cfg.daysAhead} days ahead at ${hhmm(cfg.releaseMin)}. Your PC books them then.`,
    '',
    esc(nextLine(cfg, nowMs, paused)),
  ].join('\n');
}

const HELP = [
  '<b>Court booker</b>',
  'I keep your booking requests. At each release your PC at home signs in to ClubSpark and books the first free court in your order, and I send you the court, the time and the gate code.',
  '',
  'Send /menu for buttons that do all of this. Or type:',
  '',
  '<b>Every week</b>',
  '/set thu 19:00 2h  : book Thursdays, 19:00, two hours',
  '/off thu  : stop Thursdays  (/off all for every week)',
  '',
  '<b>One-off dates</b>',
  '/book 25 nov 19:00 2h  : book that date once',
  '/book wed 7pm  : the coming Wednesday, one hour',
  '/cancel 2  : remove one-off number 2 from /plan',
  '',
  '<b>Everything else</b>',
  '/plan  : what is booked when',
  '/order 3 4 5 2 1 6  : which courts to try first',
  '/pause  and  /resume',
  '/status  : clock, your PC and settings',
  '/backup  : your settings as one line, to keep them without a volume',
  '/id  : your chat ID',
].join('\n');

function statusMessage(cfg, nowMs, info) {
  const skew = info.skewMs;
  const clockLine = skew === null ? 'Clock: not checked yet'
    : Math.abs(skew) <= 1500 ? "Clock: in step with Telegram's"
      : `Clock: ${Math.abs(Math.round(skew / 1000))} s ${skew > 0 ? 'ahead of' : 'behind'} Telegram's`;
  const pc = !info.linked ? 'Your PC: not linked (AGENT_TOKEN is not set on Railway)'
    : info.lastSeen ? `Your PC: last in touch ${label(info.lastSeenDay)} at ${clockAt(info.lastSeen)}`
      : 'Your PC: not in touch yet (it checks in when its booking run starts)';
  return [
    `<b>Status</b>  (version ${esc(info.version)})`,
    `UK time now: ${clockAt(nowMs)}`,
    clockLine,
    pc,
    `Settings kept across restarts: ${info.kept === 'disk' ? 'yes' : info.kept === 'variable' ? 'yes, from the COURT_SETTINGS variable' : 'NO. Add a Railway volume mounted at /data, or send /backup'}`,
    '',
    esc(nextLine(cfg, nowMs, info.paused)),
  ].join('\n');
}

module.exports = { esc, headsUp, bookedCaption, failedText, missingText, planMessage, nextLine, statusMessage, HELP, slotOf };
