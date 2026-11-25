'use strict';
// The words the bot sends. Telegram HTML formatting, plain text, no emoji.

const { label, hhmm, clockAt, inWords, addDays, todayCivil, DAY_KEYS, DAY_LONG } = require('./time');
const { slotText } = require('./plan');
const { upcoming, civilOf, opensAt, opensAtFor, MISSING_MS } = require('./schedule');
const { parkName, placeName, clubOf, SCHEDULED } = require('./venues');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (start, end) => `${hhmm(start)}–${hhmm(end)}`;
const dayOf = isoDate => label(civilOf(isoDate));
// A booking's day and time; any venue but Kelvingrove is named first ("Gorbals · Wed 25 Nov · 18:00–19:00").
const slotOf = j => `${j.venue && j.venue !== SCHEDULED ? `${placeName(j.venue, j.type)} · ` : ''}${dayOf(j.date)} · ${span(j.start, j.end)}`;
const isClubR = r => !!(r && clubOf(r.venue));
// A court, or two at once at Glasgow Club (2.11), as they are named: "Court 3", "Courts 3 & 4".
// `x`: a result, a hold or a note about one ({ court, courts }). Plain text: escape it for HTML.
const courtWords = x => (Array.isArray(x.courts) && x.courts.length > 1 ? `Courts ${x.courts.join(' & ')}` : `Court ${x.court}`);
// The same in the middle of a sentence: "court 3", "courts 3 & 4".
const courtWordsIn = x => `c${courtWords(x).slice(1)}`;
// " · 2 courts" after a weekly booking or a one-off date for two courts at once (2.11); else nothing.
const courtsNote = e => (e.courts > 1 ? ` · ${e.courts} courts` : '');
// What a Glasgow Club result says of the payment.
function paidLine(r) {
  if (r.paid === true) return `Paid ${r.price ? `${esc(r.price)} ` : ''}with the card your PC keeps.`;
  if (r.paid === 'maybe') return 'Pay was pressed, and whether the payment went through is not known: look in your banking app and under Bookings on Glasgow Club\'s site.';
  return 'Nothing was paid.';
}

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
    attempt && of ? `Trying again (${attempt} of ${of}).` : 'Trying again.',
  ].join('\n');
}

// A booking made. Goes on the "open" banner. Two courts at once (2.11): "Booked · Courts 3 & 4".
function bookedCaption(r) {
  if (isClubR(r)) return [`<b>Booked · ${esc(courtWords(r))}</b>`, slotOf(r), paidLine(r)].join('\n');
  const gate = r.gate ? `Gate code: <code>${esc(r.gate)}</code>  (tap to copy)`
    : 'Gate code: not shown. It is in your ClubSpark booking and the confirmation email.';
  return [`<b>Booked · ${esc(courtWords(r))}</b>`, slotOf(r), gate].join('\n');
}

// ---------- your PC's reasons, in words for you ----------
// Your PC's booker gives its reasons as they read on the PC: a line of its .env, a setting's name, a
// file under logs\ or vault\, an option of one of its tools. Where one reaches you (Telegram, and
// the app's toasts, results and notes) it is said in plain words instead (pcWords); this bot's own
// log keeps your PC's exact words. The reasons booker 2.12 gives are put in words of their own
// first; then anything else of that kind is left out: a part in brackets that names it, or a
// sentence from the part (after a colon) where it begins; if nothing is left, PC_UNSAID.
const PC_WORDS = [
  [/\bDRY_RUN is on in (?:the )?\.env(?: file)? on your PC\b/g, 'your PC is set to try without booking (dry run)'],
  [/\bGLASGOW_PAY_PER_DAY in \.env is 0(?:, so no payment is made from this PC)?/g, 'your PC is set to make no payments'],
  [/\bGLASGOW_PAY_PER_DAY in \.env should be a whole number of payments a day \(2 if left empty\)/g, 'the number of payments a day your PC is set to make is not a whole number'],
  [/\bGLASGOW_AUTO_PAY_MAX in \.env should be an amount in pounds, like 30\b/g, 'the most your PC is set to pay for a court is not an amount in pounds'],
  [/ \((?:GLASGOW_PAY_PER_DAY|GLASGOW_AUTO_PAY_MAX)\)/g, ''],
  // Today's payments, noted on your PC (its "Put the file right, or delete it" is advice for the PC only).
  [/\bthe note of payments made from this PC \(logs[\\/]glasgow-pay\.json\) (?:could not be read \([^)]*\)|does not read as I wrote it), so today's limit cannot be checked(?:\. Put the file right, or delete it if you know what was paid today)?/g,
    'your PC could not check how many payments it has made today'],
  [/\bthe note of payments made from this PC \(logs[\\/]glasgow-pay\.json\) (?:(?:cannot|could not) be written \([^)]*\)|did not keep what was written to it), and without it the daily limit cannot be kept/g,
    'your PC could not keep count of its payments today'],
  [/\bthe \.env file on your PC could not be read\b/g, 'your PC could not read its own settings'],
  [/\bGLASGOW_CLUB_USERNAME and GLASGOW_CLUB_PASSWORD are not both set in (?:the )?\.env(?: file)?(?: on your PC)?(?:, so there is nothing to sign in with)?/g, 'your PC has no Glasgow Club login to sign in with'],
  [/\(the login in the \.env file on your PC may be out of date\)/g, '(the Glasgow Club login on your PC may be out of date)'],
  [/\bBOT_URL in (?:the )?\.env(?: file)?(?: on your PC)? is not an https address\b/g, 'your PC does not reach me at a secure (https) address'],
  [/\bthe note of holds already paid for on this PC \(vault[\\/]+used\.json\) (?:could not be read|does not read as it should)/g, 'your PC could not check which slots it has paid for already'],
  [/\bthe note of holds already paid for on this PC \(vault[\\/]+used\.json\) could not be written/g, 'your PC could not note the slot as paid for'],
];
// What gives a reason away as the PC's own: .env, a setting's name (DRY_RUN), an option (--book-now),
// a path (C:\…, logs\…, vault\…) or a file's name (used.json).
const PC_INSIDE = /\.env\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b|(?:^|[\s("'])--[a-z]|\b[A-Za-z]:[\\/]|\b(?:logs|vault|tools|lib|node_modules)[\\/]|\b[\w-]+\.(?:json|js|cjs|mjs|log|ps1|bat|cmd|txt|exe|env|key|pem)\b/;
const PC_UNSAID = 'something on your PC needs looking at there';
function pcWords(raw) {
  let s = String(raw ?? '');
  for (const [from, to] of PC_WORDS) s = s.replace(from, to);
  if (!PC_INSIDE.test(s)) return s;
  s = s.replace(/\s*\([^()]*\)/g, part => (PC_INSIDE.test(part) ? '' : part));
  const kept = s.split(/(?<=\.)\s+/).map(sentence => {
    const parts = sentence.split(/:\s+/);
    const at = parts.findIndex(p => PC_INSIDE.test(p));
    return (at < 0 ? parts : parts.slice(0, at)).join(': ').replace(/[\s.,:;]+$/, '');
  }).filter(Boolean);
  return kept.length ? kept.join('. ') : PC_UNSAID;
}

// A booking that did not happen, and why. (The why on its own is also what the app is told.) Your
// PC's words are taken in plain already (app.js, cleanResult); pcWords again here only for a result
// kept by a bot older than that.
const failedWhy = r => (r.status === 'none'
  ? `No court free for the whole time.${isClubR(r) ? ' Nothing was paid.' : ''}`
  : `It didn’t work: ${esc(pcWords(r.why || 'no reason given'))}.${isClubR(r) ? ` ${paidLine(r)}` : ''}`);
function failedText(r) {
  return [`<b>Not booked · ${slotOf(r)}</b>`, failedWhy(r), `Book by hand on ${isClubR(r) ? 'Glasgow Club\'s site' : 'ClubSpark'} if you still want it.`].join('\n');
}

const slotsOf = requests => requests.map(r => slotOf(r)).join(' and ');

// Two minutes before a release and the PC's booking run has not started. `awake` says whether
// the PC itself is in touch (then the run is the problem, not the PC).
function missingText(cfg, rel, awake = false) {
  if (rel.club) {
    return [
      awake ? '<b>The midnight booking is not under way</b>' : '<b>Your PC has not checked in</b>',
      `Glasgow Club opens at 00:00 for ${slotsOf(rel.requests)}, but ${awake ? 'the booking run on your PC has not said it is ready for it' : 'the booker on your PC has not been in touch'}.`,
      `Its "${rel.clubRun ? 'Glasgow Club court booking' : 'ClubSpark court booking'}" task may not have ${rel.clubRun ? 'started at 23:50' : 'stayed awake to midnight'} (re-run schedule.ps1 on your PC), or the PC may be off. Book by hand on Glasgow Club's site if you can.`,
    ].join('\n');
  }
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
// `untold` (2.15): the minute of the PC's run, when the PC has not heard of tonight's booking yet, so
// its own timer is not set to wake it for it.
function notAnsweringText(cfg, rel, triedAt, everSeen = true, untold = null) {
  return [
    '<b>Your PC is not answering</b>',
    triedAt ? `I sent it a wake-up at ${clockAt(triedAt).slice(0, 5)}, ahead of tonight's booking, and it has not replied.`
      : everSeen ? 'It has not been in touch for over a day.' : 'It has not been in touch yet.',
    `Booking opens at ${rel.club ? '00:00' : hhmm(cfg.releaseMin)} for ${slotsOf(rel.requests)}.`,
    'If it restarted, it is waiting for you to sign in to Windows. If it is off, switch it on.',
    untold ? `It has not heard of this booking, so its own timer will not wake it: wake it before ${clockAt(untold).slice(0, 5)}. I will tell you at ${clockAt(rel.releaseAt - MISSING_MS).slice(0, 5)} if the run has not started.`
      : `If it is only asleep, its own timer should still wake it for the run. I will tell you at ${clockAt(rel.releaseAt - MISSING_MS).slice(0, 5)} if the run has not started.`,
  ].join('\n');
}

// The run started, the release has passed, and nothing has come back.
function noWordText(requests, club = false) {
  return [
    '<b>No word from your PC</b>',
    `It started on ${slotsOf(requests)} but has not said how it went.`,
    club ? 'Check under Bookings on Glasgow Club\'s site and in your banking app, and book by hand if it is not there.' : 'Check ClubSpark, and book by hand if it is not there.',
  ].join('\n');
}

// Every weekly booking, Monday first: Kelvingrove's as they always read ("Thursdays · 19:00–21:00"),
// any other venue's with its name, and one switched off said so.
function weeklyLines(cfg) {
  if (!Array.isArray(cfg.weekly)) {
    const days = [1, 2, 3, 4, 5, 6, 0].map(i => DAY_KEYS[i]).filter(k => cfg.plan[k]);
    return days.map(k => `${DAY_LONG[DAY_KEYS.indexOf(k)]}s · ${slotText(cfg.plan[k])}`);
  }
  return cfg.weekly.map(w => `${DAY_LONG[DAY_KEYS.indexOf(w.day)]}s · ${slotText(w)}${w.venue !== SCHEDULED ? ` · ${placeName(w.venue, w.type)}` : ''}${courtsNote(w)}${w.on === false ? ' (off)' : ''}`);
}

// One-offs, numbered for /cancel, with how each stands.
function onceLines(cfg, nowMs, results) {
  const lines = (cfg.once || []).map((o, i) => {
    const r = results[`${o.date}@${hhmm(o.start)}`];
    const opens = opensAt(civilOf(o.date), cfg);
    const state = r && r.status === 'booked' ? `booked, Court ${r.court}${r.gate ? `, gate ${r.gate}` : ''}`
      : opens > nowMs ? `opens ${label(addDays(civilOf(o.date), -cfg.daysAhead))} ${hhmm(cfg.releaseMin)}`
        : 'open now, your PC books it on its next run';
    return `${i + 1}. ${dayOf(o.date)} · ${slotText(o)} (${state})`;
  });
  // The other venues' (the app's), after Kelvingrove's numbered ones, which /cancel takes.
  for (const o of cfg.away || []) {
    const r = results[`${o.venue}/${o.date}@${hhmm(o.start)}`];
    const opens = opensAtFor(o.venue, civilOf(o.date), cfg);
    const state = r && r.status === 'booked' ? `booked, ${esc(courtWords(r))}`
      : opens > nowMs ? `opens ${label(todayCivil(opens))} ${clockAt(opens).slice(0, 5)}` : 'open now, your PC books it on its next run';
    lines.push(`· ${placeName(o.venue, o.type)} · ${dayOf(o.date)} · ${slotText(o)}${courtsNote(o)} (${state})`);
  }
  return lines;
}

function nextLine(cfg, nowMs, paused) {
  if (paused) return 'Booking is paused. Send /resume to switch it back on.';
  const [rel] = upcoming(nowMs, cfg, 1);
  if (!rel) return 'Nothing to book yet.';
  if (rel.club) return `Next booking: ${label(addDays(rel.night, 1))} at 00:00 (${inWords(rel.releaseAt - nowMs)}), for ${rel.requests.map(r => slotOf(r)).join(' and ')}.`;
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
  '/gorbals  and  /scotstoun  : the free indoor courts on a day (Scotstoun\'s outdoor courts: Book a date in /menu). Under a free court, Hold has your PC sign in to Glasgow Club and put it in your basket, with the payment page open on the PC. Then pay from the iPhone app, which has your PC pay with the card it keeps (you give the card in the app, and I never see it), or pay in the Chrome window on your PC.',
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
    ...(info.phones > 0 ? [`Phones linked to the app: ${info.phones}`] : []),      // only said when there is one: see /app
    `Settings kept across restarts: ${info.kept === 'disk' ? 'yes' : info.kept === 'variable' ? 'yes, from the COURT_SETTINGS variable' : 'NO. Add a Railway volume mounted at /data, or send /backup'}`,
    '',
    esc(nextLine(cfg, nowMs, info.paused)),
  ].join('\n');
}

module.exports = { esc, headsUp, troubleText, bookedCaption, failedText, failedWhy, missingText, notAnsweringText, noWordText, planMessage, nextLine, statusMessage, HELP, slotOf, courtWords, courtWordsIn,
  pcWords, PC_UNSAID };
