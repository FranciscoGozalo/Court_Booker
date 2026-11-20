'use strict';
// The words the bot sends. Telegram HTML formatting, plain text, no emoji.

const { label, hhmm, clockAt, inWords, addDays, DAY_KEYS, DAY_LONG } = require('./time');
const { slotText } = require('./plan');
const { upcoming, civilOf, opensAt, MISSING_MS } = require('./schedule');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (start, end) => `${hhmm(start)}–${hhmm(end)}`;
const dayOf = isoDate => label(civilOf(isoDate));
const slotOf = j => `${dayOf(j.date)} · ${span(j.start, j.end)}`;

// When the PC starts tonight's run: what it is about to book. It says "signing in" until the PC
// reports that it has signed in to ClubSpark (`ready`), so "ready" is never claimed too early.
function headsUp(cfg, jobs, ready = false) {
  const lines = jobs.map(j => `<b>${slotOf(j)}</b>`);
  const at = clockAt(jobs[0].releaseAt).slice(0, 5);
  return [
    `Booking at ${at}`,
    ...lines,
    `Courts in order: ${cfg.order.join(', ')}`,
    ready ? `Signed in. Waiting for ${at}.` : 'Your PC is awake and signing in.',
  ].join('\n');
}

// The PC hit a problem before a result and is trying again.
function troubleText(why, attempt, of) {
  return [
    '<b>Trouble before the booking</b>',
    `${esc(why)}.`,
    attempt && of ? `Your PC is trying again (attempt ${attempt} of ${of}).` : 'Your PC is trying again.',
  ].join('\n');
}

// A booking made. Goes on the "open" banner.
function bookedCaption(r) {
  const gate = r.gate ? `Gate code: <code>${esc(r.gate)}</code>  (tap to copy)`
    : 'Gate code: not shown. It is in your ClubSpark booking and the confirmation email.';
  return [`<b>Booked · Court ${esc(r.court)}</b>`, slotOf(r), gate].join('\n');
}

// A booking that did not happen, and why. (The why on its own is also what the app is told.)
const failedWhy = r => (r.status === 'none'
  ? 'No court was free for the whole slot.'
  : `It did not work: ${esc(r.why || 'no reason given')}.`);
function failedText(r) {
  return [`<b>Not booked · ${slotOf(r)}</b>`, failedWhy(r), 'Book by hand on ClubSpark if you still want it.'].join('\n');
}

const slotsOf = requests => requests.map(r => slotOf(r)).join(' and ');

// Two minutes before a release and the PC's booking run has not started. `awake` says whether
// the PC itself is in touch (then the run is the problem, not the PC).
function missingText(cfg, rel, awake = false) {
  if (awake) {
    return [
      '<b>The booking run has not started</b>',
      `Booking opens at ${hhmm(cfg.releaseMin)} for ${slotsOf(rel.requests)}. Your PC is awake, but it has not started tonight's run.`,
      'Its "ClubSpark court booking" task may be switched off. Book by hand on ClubSpark if you can.',
    ].join('\n');
  }
  return [
    '<b>Your PC has not checked in</b>',
    `Booking opens at ${hhmm(cfg.releaseMin)} for ${slotsOf(rel.requests)}, but the booker on your PC has not been in touch.`,
    'It may be off, or asleep without its wake timer. Book by hand on ClubSpark if you can.',
  ].join('\n');
}

// Twenty minutes before a release: the PC did not answer a wake-up sent at `triedAt`, or (with
// no way to wake it from here) has been silent for over a day, or for ever (`everSeen` false).
function notAnsweringText(cfg, rel, triedAt, everSeen = true) {
  return [
    '<b>Your PC is not answering</b>',
    triedAt ? `I sent it a wake-up at ${clockAt(triedAt).slice(0, 5)}, ahead of tonight's booking, and it has not replied.`
      : everSeen ? 'It has not been in touch for over a day.' : 'It has not been in touch yet.',
    `Booking opens at ${hhmm(cfg.releaseMin)} for ${slotsOf(rel.requests)}.`,
    'If it restarted, it is waiting for you to sign in to Windows. If it is off, switch it on.',
    `If it is only asleep, its own timer should still wake it for the run. I will tell you at ${clockAt(rel.releaseAt - MISSING_MS).slice(0, 5)} if the run has not started.`,
  ].join('\n');
}

// The run started, the release has passed, and nothing has come back.
function noWordText(requests) {
  return [
    '<b>No word from your PC</b>',
    `It started on ${slotsOf(requests)} but has not said how it went.`,
    'Check ClubSpark, and book by hand if it is not there.',
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
  '<b>Indoor courts (Glasgow Club)</b>',
  '/gorbals  and  /scotstoun  : the free indoor courts on a day. Under a free court, Hold has your PC sign in to Glasgow Club and put it in your basket, with the payment page open on the PC. Paying is yours: Glasgow Club takes a card payment with each booking, and I never make one.',
  '',
  '<b>Everything else</b>',
  '/plan  : what is booked when',
  '/order 3 4 5 2 1 6  : which courts to try first',
  '/pause  and  /resume',
  '/status  : clock, your PC and settings',
  '/wake  : wake your PC from sleep',
  '/sleep  : put your PC to sleep',
  '/app  : link the iPhone app  (/app forget unlinks every phone)',
  '/backup  : your settings as one line, to keep them without a volume',
  '/id  : your chat ID',
].join('\n');

function statusMessage(cfg, nowMs, info) {
  const skew = info.skewMs;
  const clockLine = skew === null ? 'Clock: not checked yet'
    : Math.abs(skew) <= 1500 ? "Clock: in step with Telegram's"
      : `Clock: ${Math.abs(Math.round(skew / 1000))} s ${skew > 0 ? 'ahead of' : 'behind'} Telegram's`;
  const state = { awake: 'awake', asleep: 'asleep', offline: 'not in touch' }[info.pc] || 'not in touch';
  const pc = !info.linked ? 'Your PC: not linked (AGENT_PUBLIC_KEY is not set on Railway)'
    : info.lastSeen ? `Your PC: ${state}, last in touch ${label(info.lastSeenDay)} at ${clockAt(info.lastSeen)}`
      : 'Your PC: not in touch yet (it checks in every minute while it is on, and at its booking run)';
  const wake = info.wake === 'ready' ? 'Wake from Telegram: ready (Wake my PC on the menu, or /wake)'
    : info.wake === 'no-home' ? 'Wake from Telegram: waiting for your PC to be in touch once, to learn your home address'
      : 'Wake from Telegram: not set up (WAKE_MAC and WAKE_PORT on Railway)';
  // The last time Glasgow Club's free indoor courts were read, and whether it worked.
  // Glasgow Club's site turns a cloud server away, so your PC does the reading while it is awake.
  const why = { challenge: 'its site was checking visitors', limit: 'its site said it was being asked too often', timeout: 'its site did not answer in time', network: 'its site could not be reached', pc: 'your PC did not answer in time' };
  const by = info.indoor && info.indoor.via === 'pc' ? 'by your PC' : 'from this server';
  const indoor = !info.indoor ? 'Indoor courts (Glasgow Club): not looked up since the last restart'
    : info.indoor.ok ? `Indoor courts (Glasgow Club): last read ${by} at ${clockAt(info.indoor.at)}`
      : `Indoor courts (Glasgow Club): could not be read ${by} at ${clockAt(info.indoor.at)} (${why[info.indoor.why] || 'its site gave an answer I could not use'})`;
  return [
    `<b>Status</b>  (version ${esc(info.version)})`,
    `UK time now: ${clockAt(nowMs)}`,
    clockLine,
    pc,
    ...(info.linked ? [wake] : []),
    indoor,
    `Settings kept across restarts: ${info.kept === 'disk' ? 'yes' : info.kept === 'variable' ? 'yes, from the COURT_SETTINGS variable' : 'NO. Add a Railway volume mounted at /data, or send /backup'}`,
    '',
    esc(nextLine(cfg, nowMs, info.paused)),
  ].join('\n');
}

module.exports = { esc, headsUp, troubleText, bookedCaption, failedText, failedWhy, missingText, notAnsweringText, noWordText, planMessage, nextLine, statusMessage, HELP, slotOf };
