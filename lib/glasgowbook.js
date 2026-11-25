'use strict';
// Book now at Glasgow Club (2.11.3): a court on a day open now, booked the way the parks' Book now
// books one (lib/clubspark.js), and paid by your PC with the card and code it keeps. The screens and
// the flow are the parks'; paying is the one difference. Each request rides on the PC's ping, as a
// park's does:
//
//   the ask     the app sends the slot, the courts, the minute it signed (`stamp`, 2.12) and its
//               Face ID signature over all three, in words of Book now's own (court-broker/now/v1,
//               docs/app-api.md), so that no other signature will do for it. This bot cannot check
//               the signature (it has no pay key); it refuses a stamp more than five minutes old or
//               two ahead of its clock, checks it can be done now and keeps one follower, in memory
//               only (POST /app/glasgow/book). The signature and the stamp are handed to your PC
//               once, with the order, and not kept here a moment longer; neither is logged.
//   the steps   your PC signs in, takes exactly the courts named (or none), and says each step on
//               POST /agent/glasgow/book. Just before it presses Pay it asks for the go-ahead, and
//               this bot gives it only to the follower it still has, for exactly the courts asked
//               for, at no more than your PC's own price cap a court, while Pay Automatically is on
//               and nothing is on its way to turn it off. Anything else is "stop", and nothing is paid.
//   the end     an ordinary result on POST /agent/result (the card, the note, the push, Courts),
//               which the follower hears first (app.js, resultFromAgent). An ending decided here is
//               kept as a failed result: before the go-ahead it is truthfully "nothing was paid";
//               after it, "look under Bookings and in your banking app".
//
// Never beside a hold, a park's Book now or the nightly runs; at most 6 sign-ins to Glasgow Club an
// hour, holds and Book now together; never while Glasgow Club is checking visitors from home. Your PC
// keeps limits of its own besides, and checks the signature, the cap, its daily limit and that each
// slot is paid once at most (lib/hold.js and tools/glasgow-club-book.js in the booker).

const crypto = require('crypto');
const { iso, label, hhmm, todayCivil, addDays, londonInstant, londonWall } = require('./time');
const { civilOf, opensAtFor } = require('./schedule');
const V = require('./venues');
const A = require('./appapi');
const M = require('./messages');
const { DAY_GONE, TIME_GONE, LIST_OLD } = require('./clubspark');
const { INDOOR_DAYS } = require('./ui');

const COLLECT_MS = 25 * 1000;              // your PC's ping collects it within this, or nothing was handed over
const START_MS = 90 * 1000;                // collected, and no word from its tool for this long: it never started
const SILENT_MS = 75 * 1000;               // no word for this long: the state says so
const LOST_MS = 4 * 60 * 1000;             // ...and for this long: it is given up on
const MAX_RUN_MS = 30 * 60 * 1000;         // from collection, it is over by now, whatever was heard (your PC stops its own at 28 minutes)
const RESULT_MS = 35 * 60 * 1000;          // ...and its tool's result, sent again for up to a minute, has come by now
const STARTS_PER_HOUR = 6;                 // sign-ins to Glasgow Club an hour, holds and Book now together
const HOUR_MS = 60 * 60 * 1000;
const STAMP_MS = 60 * 1000;                // `stamp` counts whole minutes
const STAMP_OLD_MS = 5 * 60 * 1000;        // signed longer ago than this, by this bot's clock: refused
const STAMP_AHEAD_MS = 2 * 60 * 1000;      // signed further ahead of this bot's clock than this: refused
const APPROVE_MS = 5 * 60 * 1000;          // your PC waits this long for your bank's approval (its tool's APPROVE_WAIT_MS), then goes on without it
const STAGES = ['asked', 'starting', 'signed-in', 'paying', 'approve'];
const ENDS = ['refused', 'gone', 'quit'];  // the PC's word: its link would not start it, its tool has gone, or its tool stopped
const OURS = ['notsent', 'nopickup', 'nostart', 'silent', 'timeout'];   // endings decided here: the PC's own word replaces them
const RESULTS = ['booked', 'failed', 'none'];

// What stands in the way, in the order it is checked (docs/app-api.md, "Book now at Glasgow Club").
const NOT_LINKED = 'Your PC isn’t linked, and it’s your PC that books Glasgow Club.';
const BUSY = 'Your PC is already booking a court.';
const HOLDING = 'Your PC is holding a court at Glasgow Club. Let it go first.';
const ASLEEP = 'Your PC isn’t awake. Wake it and try again.';
const RUN_GOING = 'Not available until the nightly booking has finished.';
const UPDATE_PC = 'Update the booker on your PC.';
const NOT_SAID = 'Your PC hasn’t said yet whether it can pay. Try again in a minute.';
const NO_CARD = 'There is no card on your PC. Add one in the app first.';
const AUTO_OFF = 'Turn on Pay Automatically first.';
const CARD_COMING = 'Your new card has not reached your PC yet. Try again in a moment.';
const AUTO_COMING = 'Pay Automatically has not reached your PC yet. Try again in a moment.';
// The stamp the app signed with (2.12), by this bot's clock.
const STAMP_OLD = 'That took too long. Try again.';
const STAMP_AHEAD = 'Your phone’s clock is ahead. Set it to the right time, then try again.';

const clock = ms => { const w = londonWall(ms); return hhmm(w.hh * 60 + w.mm); };
const text = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, max);
// Your PC's reason, as you are told it (2.12, lib/messages.js pcWords: never its .env, a setting's
// name or a file); this bot's log keeps its exact words. After "Your PC can’t pay just now:" it
// starts "it" ("it is set to try without booking (dry run)"), and goes in brackets only if it has none.
const said = (v, max = 200) => text(M.pcWords(text(v, 1000)), max);
const its = w => w.replace(/^your PC's\b/, 'its').replace(/^your PC\b/, 'it');
const aside = w => (/[()]/.test(w) ? `: ${w}` : ` (${w})`);
const pence = p => Math.round(Number(String(p).slice(1)) * 100);
// What a result's reason says of your basket, after its first sentence (your PC's reason itself):
// "The court was taken out of your basket again", "A court may still be in your basket, unpaid: …".
// "It"/"They" at the start, which were the courts, say so ("The court may still be …").
const basketOf = (why, n = 1) => String(why || '').split(/(?<=\.)\s+/).slice(1).map(s => s.replace(/[.\s]+$/, ''))
  .filter(s => /\bbasket\b/i.test(s)).map(s => s.replace(/^(?:It|They) may\b/, `${n > 1 ? 'The courts' : 'The court'} may`));
const sameCourts = (a, b) => !!a && !!b && a.length === b.length && a.every((n, i) => n === b[i]);
// The courts a follower is for: "Court 2", "Courts 2 & 3"; and in the middle of a sentence.
const courtsOf = x => M.courtWords({ court: x.courts[0], courts: x.courts });
const courtsIn = x => M.courtWordsIn({ court: x.courts[0], courts: x.courts });

// Book now at Glasgow Club, for app.js. What it needs from there:
//   linked         whether a PC can reach the bot at all
//   pcAwake(t)     whether your PC is awake            holdLive(t)  whether a hold is under way
//   csLive(t)      whether a park's Book now is        runGoing(t)  whether tonight's run is still going
//   nightNo(t)     the sentence for the nightly runs, or null
//   quietUntil(t)  until when Glasgow Club is left alone (it checked visitors from home), or 0
//   starts()       when sign-ins to Glasgow Club were started (shared with holds); addStart(t) one more
//   pc()           { books, max, why }: what your PC's last ping said (books: it takes Book now here;
//                  max: its price cap a court, "£30.00"; why: why it cannot pay just now)
//   card()         { said, kept, auto, asking }: the card your PC keeps, Pay Automatically, and
//                  what is on its way to it ('card' a new card, 'auto' Pay Automatically on)
//   shownFree(centre, date, start, courts)  whether a look showed the app those courts free lately
//   results()      the results                       record(raw)  keep an ending decided here as a result
//   bankSay(slot)  say once that your bank wants the payment approved (Telegram, a note, a push)
//   wakePings()    wake the PC's waiting ping         heard(t)     a note from the PC shows it is awake
//   setQuiet(t)    Glasgow Club checked visitors: an hour of quiet, as for a hold
function createGlasgowBook({ now = Date.now, log = () => {}, linked = true,
  pcAwake = () => false, holdLive = () => false, csLive = () => false, runGoing = () => false, nightNo = () => null,
  quietUntil = () => 0, starts = () => [], addStart = () => {}, pc = () => ({ books: false, max: null, why: null }),
  card = () => ({ said: false, kept: false, auto: false, asking: null }), shownFree = () => false,
  results = () => ({}), record = async () => {}, bankSay = async () => {}, wakePings = () => {}, heard = () => {}, setQuiet = () => {},
  collectMs = COLLECT_MS } = {}) {
  let g = null;                     // the booking being followed, or the last one
  const recent = new Map();         // the last few by id, so that your PC's late word about one still counts
  const gaveUp = new Set();         // ended: a PC that still has one is told to stop
  const no = (status, why) => ({ status, body: { ok: false, why } });
  const live = (t = now()) => !!g && !g.ended && t - g.heard < LOST_MS;
  const nameOf = x => `${V.placeName(x.venue, x.type)} ${x.date} ${hhmm(x.start)} ${courtsIn(x)}`;

  // ---------- what stands in the way ----------
  // Why no Book now can start now, in words, or null. Neither the day nor the courts come into it.
  function blocker(t) {
    if (!linked) return NOT_LINKED;
    if (live(t)) return BUSY;
    if (holdLive(t)) return HOLDING;
    if (csLive(t)) return BUSY;
    if (!pcAwake(t)) return ASLEEP;
    const night = nightNo(t);
    if (night) return night;
    if (runGoing(t)) return RUN_GOING;
    const quiet = quietUntil(t);
    if (quiet) return `Glasgow Club was checking visitors from your home connection. Not available until ${clock(quiet)}.`;
    const hour = starts().filter(at => t - at < HOUR_MS);
    if (hour.length >= STARTS_PER_HOUR) return `That’s ${STARTS_PER_HOUR} sign-ins to Glasgow Club in an hour. Next at ${clock(Math.min(...hour) + HOUR_MS)}.`;
    const p = pc();
    if (!p.books) return UPDATE_PC;
    if (p.why) return `Your PC can’t pay just now: ${its(said(p.why))}.`;
    if (!p.max) return NOT_SAID;                    // a ping since this bot started has not said its cap
    const c = card();
    if (!c.kept) return c.asking === 'card' ? CARD_COMING : NO_CARD;
    if (!c.auto) return c.asking === 'auto' ? AUTO_COMING : AUTO_OFF;
    if (c.asking === 'card') return CARD_COMING;
    if (c.asking === 'auto') return AUTO_COMING;
    return null;
  }

  // ---------- how it ends ----------
  // An ending decided here (or by your PC's link, or its tool without a result), as a failed result.
  // `paid`: false, or 'maybe' once the go-ahead was given and a press is not ruled out. What was paid
  // is not in `why`: the card, the note and the app's results add it, as for every Glasgow Club result
  // ("Nothing was paid.", or to look in your banking app and under Bookings on Glasgow Club's site).
  // `bookId`: which Book now it is, so that each is told of on its own (app.js, takeResult).
  function resultOf(x) {
    const failed = (why, paid = false) => ({ id: x.rid, venue: x.venue, status: 'failed', type: x.type, end: x.end, ...(x.price ? { price: x.price } : {}), paid, why, bookId: x.id });
    const pcWhy = x.why ? ` (${x.why})` : '';
    const paying = `while it was paying for ${courtsOf(x)}`;
    const stopped = x.stopWhy ? `${x.stopWhy}, so I told your PC not to pay` : null;
    switch (x.ended) {
      case 'notsent': return failed(`${x.why}, so it was not handed to your PC`);
      case 'nopickup': return failed('your PC did not collect it in time');
      case 'nostart': return failed('your PC collected it but did not start on it');
      case 'refused': return failed(`your PC did not start it: ${x.why || 'no reason given'}`);
      case 'timeout': return x.committed ? failed(`I stopped following it half an hour after your PC took it, ${paying}`, 'maybe')
        : failed(stopped || 'your PC was still at it half an hour after it took the booking, so I stopped following it. It pays nothing without my go-ahead');
      case 'gone':
      case 'quit':
        if (!x.committed) return failed(stopped || `your PC's booking stopped before paying${pcWhy}`);
        return x.pressed ? failed(`your PC's booking stopped${pcWhy} ${paying}`, 'maybe')
          : failed(`your PC stopped before Pay was pressed${pcWhy}. An unpaid court lapses by itself`);
      default: return x.committed ? failed(`no word from your PC ${paying}`, 'maybe')
        : failed(stopped || 'no word from your PC for four minutes, so I stopped following it. It pays nothing without my go-ahead');
    }
  }
  function forget(x) {
    x.auth = null;
    x.stamp = null;
    gaveUp.add(x.id);
    if (gaveUp.size > 50) gaveUp.delete(gaveUp.values().next().value);
  }
  // `raw.why`: your PC's own words with its endings (refused, gone, quit), said in plain words (said)
  // and kept as they came in the log; this bot's own with the endings it decides.
  function end(x, how, raw = {}) {
    x.ended = how;
    forget(x);
    const pcs = ENDS.includes(how) && raw.why !== undefined ? text(raw.why, 240) : '';
    if (raw.why !== undefined) x.why = ENDS.includes(how) ? said(raw.why, 240) : text(raw.why, 240);
    if (how === 'gone' || how === 'quit') x.pressed = raw.pressed === true || raw.pressed === 'maybe';
    const r = resultOf(x);
    x.paid = r.paid;
    log(`Book now at Glasgow Club ${how}: ${nameOf(x)} (${r.why}).${pcs && pcs !== x.why ? ` Your PC's words: ${pcs}.` : ''}`);
    Promise.resolve().then(() => record(r)).catch(e => log(`Could not keep the result of Book now at Glasgow Club: ${(e && e.message) || e}`));
  }

  // ---------- a slot your PC may already have paid for ----------
  // Pay pressed for that slot, or perhaps pressed (the midnight run, or a Book now), whichever court
  // type: your PC pays for each slot once at most, and what happened is looked at first. A Book now
  // that has just ended so counts at once, before its result is kept. A booking kept for it is not
  // this (it is refused as booked). `rid`: the slot's result id; the result, or the follower, or null.
  const paidFor = y => !!y && (y.paid === 'maybe' || y.paid === true);
  function triedFor(rid) {
    const had = results()[rid];
    if (had && had.status === 'booked') return null;
    return paidFor(had) ? had : [...recent.values()].reverse().find(y => y.rid === rid && paidFor(y)) || null;
  }
  const mayHavePaid = (venue, type, date, start) =>
    `Your PC may already have paid for ${V.placeName(venue, type)} on ${label(civilOf(date))} at ${hhmm(start)}. Check Bookings on Glasgow Club’s site and your banking app.`;
  // For the app (2.12, `glasgow.tried`): every Glasgow Club slot still to come that Book now refuses
  // so, with the very sentence it is refused with, so that the app can say it before Face ID is asked
  // for (as it does `bookNo`). Soonest first.
  function tried(t) {
    const rids = new Set([...Object.values(results()).filter(r => r && V.clubOf(r.venue)).map(r => r.id), ...[...recent.values()].map(y => y.rid)]);
    const out = [];
    for (const rid of rids) {
      const y = triedFor(rid);
      if (!y || londonInstant(civilOf(y.date), y.start) <= t) continue;
      out.push({ id: rid, venue: y.venue, type: y.type, date: y.date, start: y.start, why: mayHavePaid(y.venue, y.type, y.date, y.start) });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start));
  }

  // ---------- the ask ----------
  // `v`: as lib/appapi.js read it, { venue, type, centre, date, start, courts, auth, stamp }.
  function book(v) {
    const t = now(), date = civilOf(v.date), today = todayCivil(t);
    tick(t);                                    // one overdue ends first, as its timer would end it (so a Pay perhaps pressed is known)
    // Signed just now (2.12), by this bot's clock: at most five minutes ago, or two ahead (a phone's
    // clock a little fast). A Book now's signature is good for that ask, not for one made later.
    const signedAt = v.stamp * STAMP_MS;
    if (t - signedAt > STAMP_OLD_MS) return no(400, STAMP_OLD);
    if (signedAt - t > STAMP_AHEAD_MS) return no(400, STAMP_AHEAD);
    if (iso(date) !== v.date || date < today) return no(400, DAY_GONE);
    const opens = opensAtFor(v.venue, date, {});
    if (opens > t || date > addDays(today, INDOOR_DAYS - 1)) return no(400, `Not open yet: opens ${label(todayCivil(opens))} at ${clock(opens)}.`);
    if (londonInstant(date, v.start) <= t) return no(400, TIME_GONE);
    // Booked already, whichever court type (Scotstoun's indoor and outdoor share a result's id).
    const rid = V.resultId(v.venue, v.date, v.start);
    const had = results()[rid];
    if (had && had.status === 'booked') {
      const two = Array.isArray(had.courts) && had.courts.length > 1;
      return no(409, `${M.courtWords(had)} ${two ? 'are' : 'is'} already booked for you at ${V.placeName(v.venue, had.type)} on ${label(date)} at ${hhmm(v.start)}.`);
    }
    // Pay pressed for that slot, or perhaps pressed (triedFor): said in the app's state as well (tried).
    const paid = triedFor(rid);
    if (paid) return no(409, mayHavePaid(v.venue, paid.type, v.date, v.start));
    if (!shownFree(v.centre, v.date, v.start, v.courts)) return no(409, LIST_OLD);
    const stop = blocker(t);
    if (stop) return no(409, stop);
    if (g && !g.ended) end(g, g.taken ? 'silent' : 'nopickup');        // one long gone quiet: over, and a PC that still has it is told to stop
    g = { id: crypto.randomBytes(6).toString('hex'), rid, venue: v.venue, type: v.type, centre: v.centre, date: v.date, start: v.start, end: v.start + 60,
      courts: v.courts.slice(), auth: v.auth, stamp: v.stamp, at: t, taken: false, takenAt: null, heard: t, steps: 0, stage: 'asked', committed: false,
      ended: null, why: '', stopWhy: '', price: null, paid: null, pressed: false, got: null, bankSaid: false, approveAt: null, payWord: '' };
    recent.set(g.id, g);
    if (recent.size > 10) recent.delete(recent.keys().next().value);
    addStart(t);
    log(`Book now at Glasgow Club asked for: ${nameOf(g)}.`);
    wakePings();
    return { ok: true };
  }

  // What your PC should do now, collected by its ping: the booking, once. What stands in the way of
  // it is looked at again first: if anything came round while it waited, it is not handed over.
  function takeOrder(t) {
    const x = g;
    if (!x || x.ended || x.taken) return null;
    const p = pc();
    const stop = quietUntil(t) ? 'Glasgow Club was checking visitors from your home connection'
      : nightNo(t) ? 'your PC\'s nightly booking run was near'
        : holdLive(t) ? 'your PC was holding a court at Glasgow Club'
          : csLive(t) ? 'your PC was booking a park court'
            : !p.books ? 'your PC no longer said it books Glasgow Club'
              : p.why ? `your PC could not pay just then${aside(its(said(p.why)))}` : null;
    if (stop) { end(x, 'notsent', { why: stop }); return null; }
    x.taken = true;
    x.takenAt = x.heard = t;
    // `stamp` (2.12): the minute the app signed, which your PC needs to rebuild the words it signed.
    const order = { glasgowBook: { id: x.id, key: x.centre, date: x.date, start: x.start, courts: x.courts.slice(), auth: x.auth, stamp: x.stamp } };
    x.auth = null;                                                     // handed over: not kept here a moment longer
    x.stamp = null;
    log('Your PC collected the court to book at Glasgow Club.');
    return order;
  }

  // ---------- your PC's steps ----------
  // The go-ahead to press Pay: for the follower this bot still has, exactly its courts, at no more
  // than your PC's cap a court (the price is the total), with Pay Automatically on and no off on its way.
  function goFor(x, raw) {
    const courts = A.courtList(raw.courts), price = A.readAmount(raw.price);
    const p = pc(), c = card();
    const cap = p.max ? pence(p.max) * x.courts.length : null;
    const why = !sameCourts(courts, x.courts) ? `your PC was about to pay for ${courts ? M.courtWordsIn({ court: courts[0], courts }) : 'courts it did not name'}, not the ${courtsIn(x)} you asked for`
      : !price ? 'your PC did not say what it was about to pay'
        : cap === null ? 'your PC had not said its price cap'
          : pence(price) > cap ? `${price} is over your PC's cap of ${p.max}${x.courts.length > 1 ? ' a court' : ''}`
            : p.why ? `your PC said it could not pay just then${aside(its(said(p.why)))}`
              : !c.kept ? 'there was no card on your PC'
                : !c.auto ? 'Pay Automatically was turned off' : null;
    if (why) {
      x.stopWhy = why;
      log(`Book now at Glasgow Club: no go-ahead to pay for ${nameOf(x)}: ${why}.`);
      return { ok: true, stop: true };
    }
    x.stopWhy = '';
    x.committed = true;
    x.price = price;
    if (STAGES.indexOf('paying') > STAGES.indexOf(x.stage)) x.stage = 'paying';
    log(`Book now at Glasgow Club: your PC may pay ${price} for ${nameOf(x)}.`);
    return { ok: true, go: true };
  }
  // Your bank wants the payment approved: said once (Telegram, a note, a push), with no change to
  // anything about the night's run.
  function sayBank(x, raw) {
    const price = A.readAmount(raw.price);
    if (price) x.price = price;
    if (x.bankSaid) return;
    x.bankSaid = true;
    log(`Book now at Glasgow Club: your bank wants the payment for ${nameOf(x)} approved.`);
    Promise.resolve().then(() => bankSay({ venue: x.venue, type: x.type, date: x.date, start: x.start, price: x.price, court: x.courts[0], courts: x.courts }))
      .catch(e => log(`Could not say so: ${(e && e.message) || e}`));
  }
  // A note from your PC about a booking (POST /agent/glasgow/book): a step, a beat, or how it ended
  // without a result. The answer to "paying" (it is about to press Pay) is "go", or "stop".
  function fromPc(raw) {
    const t = now();
    const obj = !!raw && typeof raw === 'object' && !Array.isArray(raw);
    const id = obj && typeof raw.id === 'string' ? raw.id : null;
    const stage = obj && typeof raw.stage === 'string' ? raw.stage : '';
    const beat = obj && raw.beat === true;
    const ending = ENDS.includes(stage);
    // Glasgow Club was checking visitors (its tool's exit 9): an hour of quiet, whatever else is known.
    if (ending && raw.kind === 'challenge') setQuiet(t);
    // Any of the last few bookings, not only the one being followed. One this bot is not following
    // (any more: ended, given up on, or not known here at all, since it restarted) is told to stop at
    // every step but an ending, so that your PC goes no further: a late "starting" (collected, then
    // slow to start, and ended here meanwhile) signs in to nothing and takes no court, and a "paying"
    // presses nothing. An ending needs no answer (and still replaces one only assumed here, below).
    const stop = ending ? {} : { stop: true };
    const x = id ? recent.get(id) : null;
    if (!x) {
      if (id && gaveUp.has(id)) return { ok: true, stop: true };
      return { ok: true, ...stop, unknown: true };
    }
    // Over already. The PC's own word replaces an ending only assumed here; nothing else changes it.
    // But your bank wanting the payment approved is said all the same: it will not wait.
    if (x.ended && !(ending && OURS.includes(x.ended))) {
      if (stage === 'approve' && !beat && x.ended !== 'booked') sayBank(x, raw);
      return { ok: true, ...stop };
    }
    heard(t);
    x.heard = t;
    x.steps++;
    if (ending) { end(x, stage, raw); return { ok: true }; }
    // While it pays, each word (a beat too) says whether it is waiting for your bank's approval:
    // "approve", or "paying" again once the approval has come (or the check has gone) and it waits
    // for Glasgow Club's answer (awaitingBank).
    if (stage === 'paying' || stage === 'approve') x.payWord = stage;
    if (beat) return { ok: true };                                    // only that it is still at it
    if (stage === 'paying') return goFor(x, raw);
    if (stage === 'approve') {
      if (STAGES.indexOf('approve') > STAGES.indexOf(x.stage)) x.stage = 'approve';
      if (x.approveAt === null) x.approveAt = t;
      sayBank(x, raw);
      return { ok: true };
    }
    if (STAGES.indexOf(stage) > STAGES.indexOf(x.stage)) x.stage = stage;      // forwards only; a stage not known here moves nothing
    return { ok: true };
  }

  // Your PC's result for a slot (app.js, resultFromAgent, before anything else is done with it). The
  // follower it is for (the slot and its court type, collected by your PC within the time its tool
  // can still be running; one its tool has spoken for first) ends with it: a booking replaces any
  // ending, anything else any ending but a booking. A result later than that (a 21:55 run's, for a
  // one-off on the list for the same slot) is no follower's. Returns the result to keep (with the
  // reason it was not paid, when this bot said stop, and the follower's id as `bookId`), or null when
  // it is no follower's.
  function onResult(r) {
    if (!r || !RESULTS.includes(r.status)) return null;
    const t = now();
    let x = null;
    for (const y of [...recent.values()].reverse()) {
      if (y.rid !== r.id || y.type !== r.type || !y.taken || t - y.takenAt >= RESULT_MS) continue;
      if (!x) x = y;
      if (y.steps > 0) { x = y; break; }
    }
    if (!x) return null;
    if (x.ended === 'booked') return { ...r, bookId: x.id };            // a booking stands (app.js keeps it so too)
    // Told to stop, and nothing paid: why, in this bot's words, in place of your PC's reason ("the bot
    // did not give the go-ahead …"); but what your PC said besides of the basket stands with them (the
    // courts taken out again, or that one may still be there), and so do `paid` and `price`.
    const stopped = x.stopWhy && r.status !== 'booked' && r.paid === false;
    const kept = { ...r, ...(stopped ? { why: [`${x.stopWhy}, so I told your PC not to pay`, ...basketOf(r.why, x.courts.length)].join('. ') } : {}), bookId: x.id };
    x.ended = kept.status;
    forget(x);
    x.why = text(kept.why, 300);
    if (kept.price) x.price = kept.price;
    x.paid = kept.paid;
    x.got = kept;
    log(`Book now at Glasgow Club ${kept.status}, as your PC says: ${nameOf(x)}.`);
    return kept;
  }

  // The timer: a booking not collected, collected and never started, gone silent, or still going long after.
  function tick(t) {
    const x = g;
    if (!x || x.ended) return;
    if (!x.taken) { if (t - x.at >= collectMs) end(x, 'nopickup'); return; }
    if (!x.steps && t - x.takenAt >= START_MS) { end(x, 'nostart'); return; }
    if (t - x.heard >= LOST_MS) { end(x, 'silent'); return; }
    if (t - x.takenAt >= MAX_RUN_MS) end(x, 'timeout');
  }

  // ---------- for the app ----------
  // Whether your bank's approval is still waited for (2.12): your PC said "approve", its latest word
  // since says so too, and its five minutes for it have not run out. Once it is not, the app is shown
  // "paying" again, so that "Approve … in your bank’s app." goes once you have approved, not only with
  // the result.
  const awaitingBank = (x, t) => x.stage === 'approve' && x.payWord === 'approve' && x.approveAt !== null && t - x.approveAt < APPROVE_MS;
  const stageOf = (x, t) => (x.stage === 'approve' && !awaitingBank(x, t) ? 'paying' : x.stage);
  // Why it was not booked, as the app's results say it (with what was paid), without "It didn’t work: ".
  const whyOf = x => A.plain(M.failedWhy({ ...(RESULTS.includes(x.ended) ? x.got : resultOf(x)), venue: x.venue }))
    .replace(/^It didn’t work: /, '').replace(/^No court free/, 'no court free').replace(/\.$/, '');
  function lineOf(x, t) {
    if (x.ended === 'booked') return `Booked: ${x.got ? M.courtWords(x.got) : courtsOf(x)}.${x.paid === true && x.price ? ` Paid ${x.price}.` : ''}`;
    if (x.ended) return `Not booked: ${whyOf(x)}.`;
    if (x.stage !== 'asked' && t - x.heard >= SILENT_MS) return 'No word from your PC for over a minute.';
    if (!x.taken) return 'Asking your PC to book it.';
    return {
      asked: 'Starting Chrome on your PC…', starting: 'Signing in to Glasgow Club…', 'signed-in': `Signed in. Booking ${courtsOf(x)}…`,
      paying: x.price ? `Paying ${x.price}…` : 'Paying…', approve: `Approve ${x.price || 'the payment'} in your bank’s app.`,
    }[stageOf(x, t)];
  }
  function view(t) {
    const x = g;
    if (!x) return null;
    return {
      id: x.id, venue: x.venue, venueName: V.placeName(x.venue, x.type), type: x.type, centre: x.centre, date: x.date, start: x.start, end: x.end, hours: 1,
      court: x.courts[0], courts: x.courts.slice(), courtName: courtsOf(x),
      stage: stageOf(x, t), live: !x.ended, ended: x.ended, why: x.ended && x.ended !== 'booked' ? whyOf(x) : null,
      price: x.price, paid: x.ended ? x.paid : null, at: x.at, heardAt: x.heard, line: lineOf(x, t),
    };
  }
  // POST /app/glasgow/book: the state (`done`) once the booking is waiting for your PC, else
  // { status, body } with why not.
  async function appAsk(body, done) {
    const v = A.readGlasgowBook(body);
    if (v.why) return no(400, v.why);
    const r = book(v);
    return r.ok ? done() : r;
  }

  return { appAsk, fromPc, takeOrder, onResult, tick, view, live, blocker, tried };
}

module.exports = {
  createGlasgowBook, COLLECT_MS, START_MS, SILENT_MS, LOST_MS, MAX_RUN_MS, RESULT_MS, STARTS_PER_HOUR, STAMP_OLD_MS, STAMP_AHEAD_MS, APPROVE_MS,
  NOT_LINKED, BUSY, HOLDING, ASLEEP, RUN_GOING, UPDATE_PC, NOT_SAID, NO_CARD, AUTO_OFF, CARD_COMING, AUTO_COMING, STAMP_OLD, STAMP_AHEAD,
};
