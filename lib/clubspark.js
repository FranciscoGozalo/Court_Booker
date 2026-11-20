'use strict';
// Glasgow Life's park tennis courts on ClubSpark (the seven in lib/venues.js): what is free on a
// day, and Book now. Your PC at home does both, because ClubSpark's Cloudflare turns this server
// away. Each request rides on the PC's ping, as a Glasgow Club look or hold does:
//
//   a look     your PC opens that park's booking sheet for the day in a Chrome window of its own,
//              kept off the screen, as any visitor would (no sign-in, nothing pressed), and sends
//              back what the sheet shows: each free interval's "Book" link (the very links its
//              nightly run books from), with the court names. POST /agent/clubspark/look.
//   Book now   your PC signs in to ClubSpark as its nightly run does and books exactly that court
//              for that time, or nothing: if the court has gone it says so and takes no other.
//              Only you pick. It tells this bot each step on POST /agent/clubspark/book, and it
//              presses "Continue booking" only once this bot has answered "go". The outcome is an
//              ordinary result (court and gate code, a card in Telegram, a note and a push).
//              Bookings are free with the owner's annual pass; your PC never pays, and stops at
//              any price or payment step.
//
// Your home connection is what the nightly booking depends on, and ClubSpark's Cloudflare once
// challenged it after many quick requests. So, for all the parks together:
//   - a day's look is kept 3 minutes, and reused for up to 10 when it is not asked to be fresh;
//   - at most 6 fresh reads in any 10 minutes, all phones together;
//   - no fresh read from an hour before the release time (21:00), no booking from 35 minutes
//     before it (21:25, as your PC), either until half an hour after (22:30), nor while the nightly
//     run is still going;
//   - one thing at a time: no look while a booking is under way, one booking at a time, none
//     beside a Glasgow Club hold, at most 4 bookings an hour (each is a sign-in);
//   - after ClubSpark turns your PC away (its "Just a moment" page; or, as your PC counts it, a
//     page or sheet that never shows, or a 403), met by a look or a booking: nothing at all for 2
//     hours, said in the look's note, in the app's state and in Telegram.
// Nothing here, or on the PC, ever tries to get round such a check. The PC keeps the same limits
// of its own (lib/clubspark.js in the booker).

const crypto = require('crypto');
const { iso, label, hhmm, todayCivil, addDays, londonInstant, londonWall } = require('./time');
const { civilOf, opensAt } = require('./schedule');
const V = require('./venues');
const W = require('./allowance');

const CACHE_MS = 3 * 60 * 1000;            // a day's look is not read again within this
const REUSE_MS = 10 * 60 * 1000;           // ...and is reused this long when the look is not asked to be fresh
const SHOWN_MS = 15 * 60 * 1000;           // Book now: only a court a look showed the app free, from a read this recent
const READS_MAX = 6;                       // fresh reads asked of your PC...
const READS_WINDOW_MS = 10 * 60 * 1000;    // ...in any ten minutes
const NIGHT_BOOK_MS = 35 * 60 * 1000;      // no booking from this long before the release time (21:25, as your PC)...
const NIGHT_LOOK_MS = 60 * 60 * 1000;      // ...and no fresh read from this long before it (21:00), for a quiet hour...
const NIGHT_AFTER_MS = 30 * 60 * 1000;     // ...to this long after it (22:30)
const QUIET_MS = 2 * 60 * 60 * 1000;       // after a "Just a moment" page: nothing at all
const LOOK_WAIT_MS = 45 * 1000;            // your PC's time to answer a look (Chrome starts, the page loads)
const COLLECT_MS = 25 * 1000;              // ...to collect a booking
const START_MS = 90 * 1000;                // collected, and no step heard for this long: it never started
const SILENT_MS = 75 * 1000;               // no word for this long: the state says so
const LOST_MS = 4 * 60 * 1000;             // ...and for this long: it is given up on
const MAX_RUN_MS = 12 * 60 * 1000;         // from collection, a booking is over by now, whatever was heard
const BOOKS_PER_HOUR = 4;
const STAGES = ['asked', 'starting', 'signing-in', 'signed-in', 'booking'];
const ENDS = ['booked', 'gone', 'failed', 'refused', 'quit'];   // the PC's word ('quit': its tool stopped, without a word of its own)
const OURS = ['notsent', 'nopickup', 'nostart', 'silent', 'timeout'];      // endings decided here: the PC's own word replaces them
const KINDS = ['challenge', 'quiet', 'timeout', 'network', 'odd', 'busy', 'pc'];

const DAY_GONE = 'That day is no longer on offer. Pick again.';
const TIME_GONE = 'That time is no longer on offer. Pick again.';
const LIST_OLD = 'That list is old. Read the day again, then book a court.';
const WHY = {
  body: 'The request body must be a JSON object.',
  venue: `There is no such park. Send one of: ${V.PARKS.map(p => p.key).join(', ')}.`,
  look: 'A look needs a park (venue) and a date (YYYY-MM-DD).',
  book: 'Book now needs a park (venue), a date (YYYY-MM-DD), a start in minutes after midnight, hours (1 or 2) and a court number.',
};

function problem(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}
const clock = ms => { const w = londonWall(ms); return hhmm(w.hh * 60 + w.mm); };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, max);
// A court's number, from its name as the sheet gives it: the number it ends with ("Court 3"),
// the same rule as the nightly run's. A court whose name ends in no number is not offered.
const courtNumber = name => { const m = /(\d+)\s*$/.exec(String(name || '')); return m ? Number(m[1]) : null; };

// What the PC's look sent, read: { slots, listed, free }. The PC sends the sheet as the page had it
// (tools/clubspark-now.js there):
//   courts     [[resource id, name], ...]   each court on the sheet
//   free       [[test id, end], ...]        each free interval's "Book" link: its data-test-id,
//                                           "booking-<court id>|<date>|<start>", and the end of its
//                                           interval in minutes (data-system-end-time)
//   intervals  how many intervals the sheet shows, free or not; sessions: how many sessions
// `slots` are the free ones, by start time: [{ start, end, courts: [{ n, name }] }], earliest
// first, leaving out times that have started. `free` maps "start:court" to the interval's end, for
// Book now. An answer that does not read as a sheet is a problem, so a change at ClubSpark is never
// passed off as "nothing is free".
function readSheet(sheet, dateIso, nowMs) {
  const bad = why => problem('odd', why);
  if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.courts) || !Array.isArray(sheet.free)) throw bad('an answer from your PC that was not a day\'s sheet');
  if (sheet.courts.length > 60 || sheet.free.length > 3000) throw bad('a sheet far larger than a park\'s');
  const names = new Map();
  for (const c of sheet.courts) {
    if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string') throw bad('an answer from your PC that was not a day\'s sheet');
    names.set(c[0], c[1].replace(/\s+/g, ' ').trim().slice(0, 60));
  }
  // Two courts ending in the same number could not be told apart: neither is offered.
  const count = new Map();
  for (const name of names.values()) { const n = courtNumber(name); if (n !== null) count.set(n, (count.get(n) || 0) + 1); }
  const listed = Number.isInteger(sheet.intervals) && sheet.intervals >= 0 ? sheet.intervals : 0;
  const sessions = Number.isInteger(sheet.sessions) && sheet.sessions >= 0 ? sheet.sessions : 0;
  if (sessions && !listed) throw bad('a sheet I can no longer read');
  const date = civilOf(dateIso);
  const byStart = new Map(), free = new Map();
  let understood = 0;
  for (const f of sheet.free) {
    if (!Array.isArray(f)) throw bad('an answer from your PC that was not a day\'s sheet');
    const m = /^booking-(.+)\|(\d{4}-\d{2}-\d{2})\|(\d{1,4})$/.exec(String(f[0]));
    if (!m) continue;
    understood++;
    const start = Number(m[3]), name = names.get(m[1]);
    if (m[2] !== dateIso || start >= 1440 || !name) continue;
    const n = courtNumber(name);
    if (n === null || n < 1 || n > 99 || count.get(n) > 1) continue;
    if (londonInstant(date, start) <= nowMs) continue;                   // started already
    const end = Number.isInteger(f[1]) && f[1] > start && f[1] <= 1440 ? f[1] : Math.min(start + 60, 1440);
    if (!byStart.has(start)) byStart.set(start, { start, end, courts: [] });
    const slot = byStart.get(start);
    if (!slot.courts.some(c => c.n === n)) slot.courts.push({ n, name });
    free.set(`${start}:${n}`, end);
  }
  if (sheet.free.length && !understood) throw bad('a sheet I can no longer read');
  const slots = [...byStart.values()].sort((a, b) => a.start - b.start);
  for (const s of slots) s.courts.sort((a, b) => a.n - b.n);
  return { slots, listed, free };
}

// What each request from the app must look like (POST /app/clubspark/look and /book). Whether it
// can be done now is for createClubSpark to say.
const isObj = b => !!b && typeof b === 'object' && !Array.isArray(b);
const dateShape = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
function readLook(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (!V.parkOf(b.venue)) return { why: typeof b.venue === 'string' ? WHY.venue : WHY.look };
  const date = dateShape(b.date);
  return date ? { venue: b.venue, date, fresh: b.fresh === true } : { why: WHY.look };
}
function readBook(b) {
  if (!isObj(b)) return { why: WHY.body };
  if (!V.parkOf(b.venue)) return { why: typeof b.venue === 'string' ? WHY.venue : WHY.book };
  const date = dateShape(b.date);
  const ok = date && Number.isInteger(b.start) && (b.hours === 1 || b.hours === 2) && Number.isInteger(b.court);
  return ok ? { venue: b.venue, date, start: b.start, hours: b.hours, court: b.court } : { why: WHY.book };
}

// The parks' looks and bookings, for app.js. What it needs from there:
//   linked       whether a PC can reach the bot at all
//   pcAwake(t)   whether your PC is awake          holdLive(t)  whether a Glasgow Club hold is under way
//   runGoing(t)  whether tonight's booking run is still going, as it reported
//   wakePings()  wake the PC's waiting ping, so it collects at once
//   heard(t)     a note from the PC shows it is awake
//   results()    the results, for the weekly allowance and "already booked"
//   record(raw)  keep an outcome as an ordinary result (the card, the note, the push)
//   tell(html)   a message to you in Telegram        note(kind, title, body)  a note for the app
function createClubSpark({ now = Date.now, log = () => {}, releaseMin = 22 * 60, daysAhead = 7, linked = true,
  pcAwake = () => false, holdLive = () => false, runGoing = () => false, wakePings = () => {}, heard = () => {},
  results = () => ({}), record = async () => {}, tell = async () => {}, note = () => {},
  lookWaitMs = LOOK_WAIT_MS, collectMs = COLLECT_MS } = {}) {
  const rules = { releaseMin, daysAhead };
  const cache = new Map();          // "venue:date" -> { at, slots, listed, free }: what a read showed
  const shown = new Map();          // "venue:date" -> { at (of the read), free }: what the app was shown
  let reads = [];                   // when fresh reads were asked of your PC
  let ask = null;                   // the look your PC is asked for: { id, key, venue, date, taken, done, promise }
  const late = new Map();           // looks given up on, by id: their answer may still come, and is still used
  let quietSince = 0, quietUntil = 0;
  let b = null;                     // the booking being followed, or the last one
  const recent = new Map();         // the last few bookings by id, so that your PC's late word about one still counts
  const gaveUp = new Set();         // bookings ended here: a PC that still has one is told to stop
  let starts = [];                  // when bookings were started
  const no = (status, why) => ({ status, body: { ok: false, why } });

  // ---------- days and guards ----------
  const isOpen = (date, t) => opensAt(date, rules) <= t;
  const lastOpen = t => { const far = addDays(todayCivil(t), daysAhead); return isOpen(far, t) ? far : addDays(far, -1); };
  // Why a day cannot be read or booked now, or null: from today to the last day open.
  function dayNo(venue, dateIso, t) {
    const date = civilOf(dateIso);
    if (iso(date) !== dateIso || date < todayCivil(t)) return DAY_GONE;
    if (isOpen(date, t)) return null;
    const opens = opensAt(date, rules);
    return `That day is not open for booking yet: it opens on ${label(todayCivil(opens))} at ${clock(opens)}.${venue === V.SCHEDULED ? ' Add it to your list and your PC books it then.' : ''}`;
  }
  // Around the nightly run: no booking from 35 minutes before the release (when your PC stops taking
  // them too), and no fresh read from an hour before, to give the connection a quiet hour; neither
  // until half an hour after. `what`: 'look' or 'book'.
  function nightBlock(t, what) {
    const before = what === 'look' ? NIGHT_LOOK_MS : NIGHT_BOOK_MS;
    for (const d of [-1, 0, 1]) {
      const rel = londonInstant(addDays(todayCivil(t), d), releaseMin);
      if (t >= rel - before && t < rel + NIGHT_AFTER_MS) return rel;
    }
    return null;
  }
  const minuteOf = ms => hhmm((((releaseMin + ms / 60000) % 1440) + 1440) % 1440);
  const nightText = what => (what === 'look'
    ? `Your PC's nightly booking run is at ${hhmm(releaseMin)}, so ClubSpark is not read from ${minuteOf(-NIGHT_LOOK_MS)} to ${minuteOf(NIGHT_AFTER_MS)}, to leave the connection quiet before it.`
    : `Your PC's nightly booking run is at ${hhmm(releaseMin)}, so nothing is booked at ClubSpark from ${minuteOf(-NIGHT_BOOK_MS)} to ${minuteOf(NIGHT_AFTER_MS)}.`);
  const quietText = () => `ClubSpark turned your PC away at ${clock(quietSince)}, as it does when it checks a connection, so it is left alone until ${clock(quietUntil)}: nothing is read or booked there from the app until then.`;
  const live = (t = now()) => !!b && !b.ended && t - b.heard < LOST_MS;
  // What stands in the way of a fresh read (`what` 'look') or a booking ('book') now, in words, or
  // null. Neither the day nor the court comes into it.
  function blocker(t, what) {
    if (!linked) return 'Your PC is not linked to me, and it is your PC that reads and books ClubSpark.';
    if (t < quietUntil) return quietText();
    if (nightBlock(t, what) !== null) return nightText(what);
    if (runGoing(t)) return 'Your PC\'s nightly booking run is still going, so nothing else is read or booked at ClubSpark until it has finished.';
    if (live(t)) return what === 'book' ? 'Your PC is already booking a court.' : 'Your PC is booking a court just now. Look again when it has finished.';
    if (what === 'book' && holdLive(t)) return 'Your PC is holding a court at Glasgow Club. Let it go first.';
    if (!pcAwake(t)) return `Your PC is not awake, and it is your PC that ${what === 'book' ? 'signs in to ClubSpark and books' : 'reads ClubSpark'}. Wake it and try again.`;
    if (what === 'look') {
      reads = reads.filter(at => t - at < READS_WINDOW_MS);
      if (reads.length >= READS_MAX) return `That is ${READS_MAX} reads of ClubSpark within ten minutes, which is as many as I ask your PC for, to keep your home connection in good standing with ClubSpark. The next can be at ${clock(reads[0] + READS_WINDOW_MS)}.`;
    } else {
      starts = starts.filter(at => t - at < 60 * 60 * 1000);
      if (starts.length >= BOOKS_PER_HOUR) return `That is ${BOOKS_PER_HOUR} bookings within an hour, and each is a sign-in to ClubSpark. The next can start at ${clock(starts[0] + 60 * 60 * 1000)}.`;
    }
    return null;
  }

  // ---------- turned away: two hours of nothing ----------
  // ClubSpark turned your PC away: its "Just a moment" check, or (as your PC counts it) a page or a
  // sheet that never showed, or a 403. `why` is your PC's word for which. Said in Telegram (and as a
  // note) once for each pause; being turned away again during one only moves its end.
  function turnAway(t, where, why) {
    const running = t < quietUntil;
    quietSince = t;
    quietUntil = t + QUIET_MS;
    const what = text(why) || 'ClubSpark showed a "Just a moment" page';
    log(`ClubSpark turned your PC away ${where} (${what}). Nothing more is read or booked there from the app until ${clock(quietUntil)}.`);
    if (running) return;
    const title = 'ClubSpark turned your PC away';
    const body = `ClubSpark turned your PC away at ${clock(t)}, ${where} (${what}), which is how it treats a connection it is checking. Nothing more is read or booked at ClubSpark from the app until ${clock(quietUntil)}. Your nightly booking run uses the same connection: if ClubSpark still turns it away at ${hhmm(releaseMin)}, that run may not get through.`;
    Promise.resolve().then(() => tell(`<b>${esc(title)}</b>\n${esc(body)}`)).catch(e => log(`Could not say so in Telegram: ${(e && e.message) || e}`));
    note('warn', title, body);
  }
  // Your PC says it is still leaving ClubSpark alone (it was turned away, and this bot has restarted since).
  function keepQuiet(until, t) {
    const u = Number(until);
    if (!Number.isFinite(u) || u <= t || u > t + QUIET_MS || u <= quietUntil) return;
    quietSince = quietSince && quietUntil > t ? quietSince : t;
    quietUntil = u;
    log(`Your PC is leaving ClubSpark alone until ${clock(u)}, after ClubSpark turned it away.`);
  }

  // ---------- a look ----------
  function whyOf(err) {
    switch (err.kind) {
      case 'challenge': return `ClubSpark turned your PC away just now (${err.message}), so it is left alone until ${clock(quietUntil)}: nothing is read or booked there from the app until then.`;
      case 'quiet': return now() < quietUntil ? quietText() : 'Your PC is leaving ClubSpark alone for a while, after ClubSpark turned it away.';
      case 'pc': return 'Your PC did not answer in time, so I could not read the free courts.';
      case 'timeout': return 'ClubSpark\'s page did not load on your PC in time.';
      case 'network': return 'Your PC could not reach ClubSpark.';
      case 'busy': return `Your PC did not read it: ${err.message}.`;
      default: return `ClubSpark's sheet could not be read (${err.message}).`;
    }
  }
  function readByPc(venue, date) {
    const a = { id: crypto.randomBytes(6).toString('hex'), key: `${venue}:${date}`, venue, date, taken: false };
    a.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => a.done(problem('pc', 'your PC did not answer in time')), lookWaitMs);
      if (timer.unref) timer.unref();
      a.done = (err, got) => {
        clearTimeout(timer);
        if (ask === a) ask = null;
        a.done = () => {};
        if (err && err.kind === 'pc') {               // its answer may still come, and is still worth having
          late.set(a.id, { venue, date });
          if (late.size > 10) late.delete(late.keys().next().value);
        }
        if (err) reject(err); else resolve(got);
      };
    });
    ask = a;
    wakePings();
    return a.promise;
  }
  // The note under a look: when ClubSpark showed it, and anything that holds the app back now.
  function noteOf(got, dateIso, t) {
    const at = clock(got.at), lines = [];
    if (got.slots.length) lines.push(`Free courts, as ClubSpark showed it at ${at}.`);
    else if (got.listed) lines.push(`No court is free that day, as ClubSpark showed it at ${at}.`);
    else lines.push(`ClubSpark's sheet shows no courts at all that day, as it showed it at ${at}.`);
    if (dateIso === iso(todayCivil(t))) lines.push('Times that have started are left out.');
    if (t < quietUntil) lines.push(quietText());
    return lines.join('\n');
  }
  function answer(v, got) {
    const t = now();
    // What the app has now been shown free: for 15 minutes from that read, Book now may be asked
    // for one of these courts, and for no other (kept in memory only, so not across a restart).
    for (const [key, s] of shown) if (t - s.at >= SHOWN_MS) shown.delete(key);
    shown.set(`${v.venue}:${v.date}`, { at: got.at, free: got.free });
    return { status: 200, body: { ok: true, look: {
      venue: v.venue, date: v.date, at: got.at, by: 'pc', note: noteOf(got, v.date, t),
      slots: got.slots.map(s => ({ start: s.start, end: s.end, courts: s.courts.map(c => ({ n: c.n, name: c.name })) })),
    } } };
  }
  async function look(v) {
    const t = now(), key = `${v.venue}:${v.date}`;
    const day = dayNo(v.venue, v.date, t);
    if (day) return no(400, day);
    const hit = cache.get(key);
    if (hit && t - hit.at < (v.fresh ? CACHE_MS : REUSE_MS)) return answer(v, hit);
    if (ask && ask.key === key) {                     // that very read is on its way: wait for it too
      try { return answer(v, await ask.promise); } catch (err) { return no(409, whyOf(err)); }
    }
    const stop = blocker(t, 'look');
    if (stop) return no(409, stop);
    if (ask) return no(409, 'Your PC is reading another day at ClubSpark just now. Try again in a moment.');
    reads.push(t);
    log(`ClubSpark: asking your PC for ${V.parkName(v.venue)} on ${v.date}.`);
    try { return answer(v, await readByPc(v.venue, v.date)); } catch (err) { return no(409, whyOf(err)); }
  }
  // Your PC's answer to a look: the sheet, or why not. One that comes after the wait has ended is
  // still kept (and a "Just a moment" in it still counts), but nobody is waiting for it.
  function lookFromPc(raw) {
    const t = now();
    const id = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : '';
    const a = ask && ask.id === id ? ask : null;
    const was = a || late.get(id);
    if (!was) return { ok: true, late: true };
    late.delete(id);
    heard(t);
    const reply = a ? { ok: true } : { ok: true, late: true };
    if (raw.ok === true) {
      let got;
      try {
        got = { at: t, ...readSheet(raw.sheet, was.date, t) };
      } catch (err) {
        log(`ClubSpark (${V.parkName(was.venue)}, ${was.date}): your PC's answer could not be read: ${err.message}`);
        if (a) a.done(err);
        return reply;
      }
      cache.set(`${was.venue}:${was.date}`, got);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      if (a) a.done(null, got);
      return reply;
    }
    const kind = KINDS.includes(raw.kind) && raw.kind !== 'pc' ? raw.kind : 'odd';
    if (kind === 'challenge') turnAway(t, `reading ${V.parkName(was.venue)}'s courts`, raw.why);
    if (kind === 'quiet') keepQuiet(raw.until, t);
    if (kind !== 'challenge') log(`ClubSpark (${V.parkName(was.venue)}, ${was.date}) could not be read by your PC: ${text(raw.why) || 'no reason given'}`);
    if (a) a.done(problem(kind, text(raw.why) || 'no reason given'));
    return reply;
  }

  // ---------- Book now ----------
  const parkOf = x => V.parkName(x.venue);
  // Once this bot has said go, anything but a booking or a court gone says to check ClubSpark (unless
  // the PC's words already do, or it stopped at a payment step, where it pressed nothing more).
  const afterGo = (x, why) => (x.committed && x.kind !== 'payment' && !/check ClubSpark/i.test(why) ? `${why}. It was booking when that happened: check ClubSpark for it` : why);
  // What a booking came to, as an ordinary result (lib/venues.js says how its id is made).
  function resultOf(x) {
    const base = { id: V.resultId(x.venue, x.date, x.start), end: x.end };
    const pcWhy = x.why ? ` (${x.why})` : '';
    switch (x.ended) {
      case 'booked': return { ...base, status: 'booked', court: String(x.court), ...(x.gate ? { gate: x.gate } : {}) };
      case 'gone': return { ...base, status: 'failed', why: `court ${x.court} was no longer free for that time${pcWhy}, and your PC takes no other court` };
      case 'refused': return { ...base, status: 'failed', why: `your PC did not start it: ${x.why || 'no reason given'}` };
      case 'failed': return { ...base, status: 'failed', why: afterGo(x, x.why || 'no reason given') };
      case 'quit': return { ...base, status: 'failed', why: x.committed ? `your PC's booking stopped while it was booking court ${x.court}${pcWhy}: check ClubSpark for it` : `your PC's booking stopped before it booked anything${pcWhy}` };
      case 'notsent': return { ...base, status: 'failed', why: `${x.why}, so it was not handed to your PC and nothing was booked` };
      case 'nopickup': return { ...base, status: 'failed', why: 'your PC did not collect it in time, so nothing was booked' };
      case 'nostart': return { ...base, status: 'failed', why: 'your PC collected it but did not start on it, so nothing was booked' };
      case 'timeout': return { ...base, status: 'failed', why: x.committed ? `your PC was still at it twelve minutes after it took the booking, so I stopped following it: check ClubSpark for court ${x.court}` : 'your PC was still at it twelve minutes after it took the booking, so I stopped following it. It books nothing without my go-ahead, so nothing was booked' };
      default: return { ...base, status: 'failed', why: x.committed ? `no word from your PC while it was booking court ${x.court}: check ClubSpark for it` : 'no word from your PC for four minutes, so I stopped following it. It books nothing without my go-ahead, so nothing was booked' };
    }
  }
  function end(x, how, raw = {}) {
    const t = now();
    x.ended = how;
    if (raw.why !== undefined) x.why = text(raw.why, 240);
    x.kind = typeof raw.kind === 'string' ? raw.kind.slice(0, 20) : '';
    if (how === 'booked') x.gate = String(raw.gate ?? '').replace(/[^\w#*-]/g, '').slice(0, 20) || null;
    if (OURS.includes(how) || how === 'quit') {
      gaveUp.add(x.id);
      if (gaveUp.size > 50) gaveUp.delete(gaveUp.values().next().value);
    }
    if (raw.kind === 'challenge') turnAway(t, `booking at ${parkOf(x)}`, raw.why);
    const r = resultOf(x);
    log(`Book now ${how}: ${parkOf(x)} ${x.date} ${hhmm(x.start)} court ${x.court}${r.why ? ` (${r.why})` : ''}.`);
    Promise.resolve().then(() => record(r)).catch(e => log(`Could not keep the result of Book now: ${(e && e.message) || e}`));
  }
  function book(v) {
    const t = now(), park = V.parkOf(v.venue);
    const day = dayNo(v.venue, v.date, t);
    if (day) return no(400, day);
    const date = civilOf(v.date), endMin = v.start + v.hours * 60;
    if (!(v.start >= 0 && v.start % 5 === 0 && endMin <= 1440) || !(v.court >= 1 && v.court <= 20) || londonInstant(date, v.start) <= t) return no(400, TIME_GONE);
    const had = results()[V.resultId(v.venue, v.date, v.start)];
    if (had && had.status === 'booked') return no(409, `Court ${had.court} is already booked for you at ${park.name} on ${label(date)} at ${hhmm(v.start)}.`);
    // Only a court a look showed the app free, from a read in the last 15 minutes, for the whole time.
    const seen = shown.get(`${v.venue}:${v.date}`);
    if (!seen || t - seen.at >= SHOWN_MS || !seen.free.has(`${v.start}:${v.court}`)) return no(409, LIST_OLD);
    for (let at = v.start; at < endMin;) {
      const next = seen.free.get(`${at}:${v.court}`);
      if (!next || next <= at) return no(409, `Court ${v.court} is not free for ${v.hours === 2 ? 'two hours' : 'an hour'} from ${hhmm(v.start)}. Pick another time or court.`);
      at = next;
    }
    const over = W.overIfBooked(results(), v.date, v.hours);
    if (over) return no(409, over);
    const stop = blocker(t, 'book');
    if (stop) return no(409, stop);
    if (b && !b.ended) end(b, b.taken ? 'silent' : 'nopickup');      // one long gone quiet: over, and a PC that still has it is told to stop
    b = { id: crypto.randomBytes(6).toString('hex'), venue: v.venue, date: v.date, start: v.start, hours: v.hours, end: endMin, court: v.court,
      at: t, taken: false, takenAt: null, heard: t, stage: 'asked', ended: null, why: '', gate: null, committed: false };
    recent.set(b.id, b);
    if (recent.size > 10) recent.delete(recent.keys().next().value);
    starts.push(t);
    log(`Book now asked for: ${park.name} ${v.date} ${hhmm(v.start)}-${hhmm(endMin)} court ${v.court}.`);
    wakePings();
    return { ok: true };
  }
  // A note from your PC about a booking: a step, or how it ended. The answer to the step "booking"
  // (it is about to press "Continue booking") is "go", or "stop" for one this bot no longer follows.
  function bookFromPc(raw) {
    const t = now();
    const id = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : null;
    const stage = raw && typeof raw.stage === 'string' ? raw.stage : '';
    // Any of the last few bookings, not only the one being followed: a newer one may have taken its
    // place while your PC was still at it.
    const x = id ? recent.get(id) : null;
    if (!x) return id && gaveUp.has(id) ? { ok: true, stop: true } : { ok: true, unknown: true };
    const ending = ENDS.includes(stage);
    // Over already. What the PC itself says of the ending replaces one only assumed here, and a
    // booking made replaces any ending but itself: a booking stands.
    const replaces = ending && stage !== 'quit' && (OURS.includes(x.ended) || (stage === 'booked' && x.ended !== 'booked'));
    if (x.ended && !replaces) return { ok: true, ...(stage === 'booking' && raw.beat !== true ? { stop: true } : {}) };
    heard(t);
    x.heard = t;
    if (raw.beat === true && !ending) return { ok: true };       // only that it is still at it
    if (ending) {
      end(x, stage, raw);
      return { ok: true };
    }
    if (STAGES.indexOf(stage) > STAGES.indexOf(x.stage)) x.stage = stage;
    if (stage === 'booking') {
      x.committed = true;
      log(`Book now: your PC is booking ${parkOf(x)} court ${x.court}.`);
      return { ok: true, go: true };
    }
    return { ok: true };
  }
  // What your PC should do now, collected by its ping: a look first (someone is waiting for it),
  // then a booking. Each is handed over once.
  function takeOrder(t) {
    if (ask && !ask.taken) {
      ask.taken = true;
      return { csLook: { id: ask.id, venue: ask.venue, date: ask.date } };
    }
    if (b && !b.ended && !b.taken) {
      // The night's quiet time, or a "Just a moment" check, came round while it waited.
      const stop = t < quietUntil ? 'ClubSpark had turned your PC away' : nightBlock(t, 'book') !== null ? 'your PC\'s nightly booking run was near' : null;
      if (stop) { end(b, 'notsent', { why: stop }); return null; }
      b.taken = true;
      b.takenAt = b.heard = t;
      log('Your PC collected the court to book.');
      return { csBook: { id: b.id, venue: b.venue, date: b.date, start: b.start, hours: b.hours, court: b.court } };
    }
    return null;
  }
  // The timer: a booking not collected, collected and never started, or gone silent.
  function tick(t) {
    const x = b;
    if (!x || x.ended) return;
    if (!x.taken) { if (t - x.at >= collectMs) end(x, 'nopickup'); return; }
    if (x.stage === 'asked' && t - x.takenAt >= START_MS) { end(x, 'nostart'); return; }
    if (t - x.heard >= LOST_MS) { end(x, 'silent'); return; }
    if (t - x.takenAt >= MAX_RUN_MS) end(x, 'timeout');
  }

  // ---------- for the app ----------
  function lineOf(x, t) {
    if (x.ended === 'booked') return `Booked: court ${x.court}. ${x.gate ? `Gate code ${x.gate}.` : 'The gate code was not shown.'}`;
    if (x.ended) return `Not booked: ${resultOf(x).why}.`;
    if (x.stage !== 'asked' && t - x.heard >= SILENT_MS) return 'No word from your PC for over a minute.';
    if (!x.taken) return 'Asking your PC to book it.';
    return {
      asked: 'Your PC has it and is starting Chrome…', starting: 'Your PC is opening ClubSpark…', 'signing-in': 'Your PC is signing in to ClubSpark…',
      'signed-in': `Signed in. Looking for court ${x.court} on the sheet…`, booking: `Booking court ${x.court}…`,
    }[x.stage];
  }
  function view(t) {
    reads = reads.filter(at => t - at < READS_WINDOW_MS);
    const x = b;
    return {
      linked,
      days: { first: iso(todayCivil(t)), last: iso(lastOpen(t)) },
      quietUntil: t < quietUntil ? quietUntil : null,
      lookNo: blocker(t, 'look'),
      bookNo: blocker(t, 'book'),
      reads: { used: reads.length, max: READS_MAX, nextAt: reads.length >= READS_MAX ? reads[0] + READS_WINDOW_MS : null },
      book: x ? {
        id: x.id, venue: x.venue, venueName: parkOf(x), date: x.date, start: x.start, end: x.end, hours: x.hours, court: x.court, courtName: `Court ${x.court}`,
        stage: x.stage, live: !x.ended, ended: x.ended, why: x.ended && x.ended !== 'booked' ? resultOf(x).why : null, gate: x.gate, at: x.at, heardAt: x.heard,
        line: lineOf(x, t),
      } : null,
    };
  }
  // POST /app/clubspark/<name>: 'look' answers { status, body } with the look; 'book' answers with
  // the state (`done`) once the booking is waiting for your PC, else { status, body } with why not.
  async function appAsk(name, body, done) {
    if (name === 'look') {
      const v = readLook(body);
      return v.why ? no(400, v.why) : look(v);
    }
    if (name === 'book') {
      const v = readBook(body);
      if (v.why) return no(400, v.why);
      const r = book(v);
      return r.ok ? done() : r;
    }
    return null;
  }
  // POST /agent/clubspark/look and /book, from your PC.
  function fromAgent(kind, raw) {
    if (kind === 'look') return lookFromPc(raw);
    if (kind === 'book') return bookFromPc(raw);
    return { ok: false, why: 'no such thing here' };
  }

  return { appAsk, fromAgent, takeOrder, tick, view, live };
}

module.exports = {
  createClubSpark, readSheet, readLook, readBook, courtNumber, WHY, DAY_GONE, TIME_GONE, LIST_OLD,
  CACHE_MS, REUSE_MS, SHOWN_MS, READS_MAX, READS_WINDOW_MS, NIGHT_BOOK_MS, NIGHT_LOOK_MS, NIGHT_AFTER_MS, QUIET_MS, LOOK_WAIT_MS, COLLECT_MS, START_MS, SILENT_MS, LOST_MS, MAX_RUN_MS, BOOKS_PER_HOUR,
};
