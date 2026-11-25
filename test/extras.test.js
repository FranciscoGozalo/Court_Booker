'use strict';
// The extras: the reminder on the day, the calendar feed, Book now, and what to book when the
// slot asked for is taken.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, loadState, backupLine, cleanResult } = require('../app');
const { createServer } = require('../lib/server');
const { feed, fold } = require('../lib/calendar');
const { parseRemind } = require('../lib/plan');
const { alternativesFor } = require('../lib/schedule');
const M = require('../lib/messages');
const UI = require('../lib/ui');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const HOME = { ip: '2.96.64.17' };
const WAKE = { WAKE_MAC: '44:AF:28:7A:1A:5C', WAKE_PORT: '40009' };
const BOOKED = { id: '2026-11-17@18:00', status: 'booked', date: TUE, start: 1080, end: 1140, court: '3', gate: '2433', at: at('2026-11-10T22:00:11Z') };
const OPEN = { date: '2026-11-20', start: 1140, hours: 2 };      // Friday 19:00, open for booking since last Friday

function makeApp(t0, { state = {}, env = {}, linked = true, wake } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const woke = [];
  const logs = [];
  const app = createApp({
    now: () => clock.t, tg, pictures: PICTURES, linked, env, log: l => logs.push(l),
    store: memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], ...state }),
    wake: wake || (async to => { woke.push({ ...to, at: clock.t }); return 3; }),
  });
  return { app, tg, clock, woke, logs };
}
const go = async (app, clock, when) => { clock.t = at(when); await app.tick(); };
const send = (app, text) => app.handleUpdate(say(OWNER, text));
let tapId = 1;
const tap = (app, data, messageId) => app.handleUpdate({
  update_id: 1, callback_query: { id: `x${tapId++}`, data, from: { id: OWNER }, message: { message_id: messageId, chat: { id: OWNER, type: 'private' } } },
});
const buttons = call => call.extra.reply_markup.inline_keyboard.flat();
const labels = call => buttons(call).map(b => b.text);
// New messages only: a menu card being redrawn (its dot changing as the PC goes quiet) does not count.
const sent = tg => tg.calls.filter(c => c.method === 'send' || c.method === 'photo');

// ---------- the reminder ----------

test('on the day, the court and gate code come again two hours before, once', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T15:59:59Z`, { state: { results: { [BOOKED.id]: BOOKED } } });
  await app.tick();
  assert.equal(tg.calls.length, 0);
  await go(app, clock, `${TUE}T16:00:00Z`);
  const card = tg.last();
  assert.equal(card.photo, 'upload:banner-booked.jpg');
  assert.equal(card.text, '<b>Tennis today · Court 3</b>\nTue 17 Nov · 18:00–19:00 (in 2 h)\nGate code: <code>2433</code>  (tap to copy)');
  assert.deepEqual(buttons(card).map(b => b.callback_data), ['n:m', 'n:h']);
  await go(app, clock, `${TUE}T16:30:00Z`);
  await go(app, clock, `${TUE}T18:30:00Z`);
  assert.equal(tg.calls.length, 1);
});

test('the reminder still comes when booking is paused or no PC is linked, and late if the bot was away', async () => {
  for (const how of [{ state: { paused: true } }, { linked: false }]) {
    const { app, tg } = makeApp(`${TUE}T17:20:00Z`, { ...how, state: { ...how.state, results: { [BOOKED.id]: BOOKED } } });
    await app.tick();
    assert.match(tg.last().text, /^<b>Tennis today · Court 3<\/b>\nTue 17 Nov · 18:00–19:00 \(in 40 min\)/);
  }
  const after = makeApp(`${TUE}T18:00:00Z`, { state: { results: { [BOOKED.id]: BOOKED } } });
  await after.app.tick();
  assert.equal(after.tg.calls.length, 0);                              // it has started: too late to remind
});

test('/remind sets how long before, or switches it off', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T12:00:00Z`, { state: { results: { [BOOKED.id]: BOOKED } } });
  await send(app, '/remind 90');
  assert.match(tg.last().text, /1 hour 30 minutes before you play/);
  assert.equal(app.state.remind, 90);
  tg.clear();
  await go(app, clock, `${TUE}T16:29:59Z`);
  assert.equal(tg.calls.length, 0);
  await go(app, clock, `${TUE}T16:30:00Z`);
  assert.match(tg.last().text, /\(in 1 h 30 min\)/);

  const off = makeApp(`${TUE}T12:00:00Z`, { state: { results: { [BOOKED.id]: BOOKED } } });
  await send(off.app, '/remind off');
  assert.equal(off.tg.last().text, 'No reminders.');
  off.tg.clear();
  await go(off.app, off.clock, `${TUE}T17:00:00Z`);
  assert.equal(off.tg.calls.length, 0);
  await send(off.app, '/remind soon');
  assert.match(off.tg.last().text, /Use it like this/);
});

test('how the reminder time is read', () => {
  const cases = { '2h': 120, '2': 120, '1.5h': 90, '90': 90, '90 min': 90, '45m': 45, '12': 720, '24h': 1440, off: 0, '0': 0, none: 0 };
  for (const [typed, minutes] of Object.entries(cases)) assert.equal(parseRemind(typed), minutes, typed);
  for (const bad of ['', '10m', '25h', 'soon', '-2h', '2 days']) assert.equal(parseRemind(bad), null, bad);
});

test('a court booked inside the reminder time gets no second message', async () => {
  const late = { ...BOOKED, at: at(`${TUE}T16:40:00Z`) };              // booked with Book now, 80 minutes before
  const { app, tg, clock } = makeApp(`${TUE}T16:41:00Z`, { state: { results: { [late.id]: late } } });
  await app.tick();
  await go(app, clock, `${TUE}T17:30:00Z`);
  assert.equal(tg.calls.length, 0);
});

test('a day-ahead reminder says tomorrow', async () => {
  const { app, tg } = makeApp('2026-11-16T18:00:00Z', { state: { remind: 1440, results: { [BOOKED.id]: BOOKED } } });
  await app.tick();
  assert.match(tg.last().text, /^<b>Tennis tomorrow · Court 3<\/b>\nTue 17 Nov · 18:00–19:00 \(in 24 h\)/);
});

// ---------- the calendar feed ----------

test('the feed: one event for each booked court, in UTC, with the gate code', () => {
  const results = {
    a: BOOKED,
    b: { id: '2026-07-07@18:00', status: 'booked', date: '2026-07-07', start: 1080, end: 1200, court: '5', at: at('2026-06-30T21:00:09Z') },   // summer time
    c: { id: '2026-11-18@19:00', status: 'none', date: '2026-11-18', start: 1140, end: 1200, at: 1 },
  };
  const ics = feed(results, { now: at(`${TUE}T12:00:00Z`) });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 2);                  // the one that was not booked is not there
  assert.match(ics, /UID:2026-11-17-18-00@court-booker\r\nDTSTAMP:20261110T220011Z\r\nDTSTART:20261117T180000Z\r\nDTEND:20261117T190000Z\r\nSUMMARY:Tennis · Court 3\r\nLOCATION:Kelvingrove Park Tennis Courts\\, Glasgow\r\nDESCRIPTION:Gate code: 2433\r\n/);
  assert.match(ics, /DTSTART:20260707T170000Z\r\nDTEND:20260707T190000Z/);    // 18:00 in a Glasgow summer is 17:00 UTC
  assert.match(ics, /DESCRIPTION:Gate code: see your ClubSpark booking\./);
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, l);
  assert.equal(feed({}).match(/BEGIN:VEVENT/g), null);
});

test('long lines in the feed are folded at 75 bytes, never through the middle of a letter', () => {
  const folded = fold(`DESCRIPTION:${'é'.repeat(80)}`);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 2);
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 75);
  assert.ok(parts.slice(1).every(p => p.startsWith(' ')));
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), `DESCRIPTION:${'é'.repeat(80)}`);
});

test('/calendar gives a link only its holder can use, and a new link switches the old one off', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`, { env: { RAILWAY_PUBLIC_DOMAIN: 'bot.example.app' }, state: { results: { [BOOKED.id]: BOOKED } } });
  assert.equal(app.calendarFeed('0'.repeat(32)), null);                // no link made yet: nothing to guess
  await send(app, '/calendar');
  const card = tg.last();
  const first = app.state.cal;
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.deepEqual(buttons(card)[0], { text: 'Add to my calendar', url: `https://bot.example.app/cal/${first}` });
  assert.match(card.text, /^<b>Calendar<\/b>/);
  assert.match(app.calendarFeed(first), /SUMMARY:Tennis · Court 3/);
  assert.equal(app.calendarFeed('0'.repeat(32)), null);
  assert.equal(app.calendarFeed(''), null);
  assert.equal(app.calendarFeed(first.slice(0, 31)), null);
  await send(app, '/calendar');
  assert.equal(app.state.cal, first);                                  // asking again keeps the link
  // New link: asked first, then done.
  await tap(app, 'c:new', card.id);
  assert.match(tg.last().text, /Make a new calendar link\?/);
  assert.equal(app.state.cal, first);
  await tap(app, 'c:new:ok', card.id);
  assert.notEqual(app.state.cal, first);
  assert.equal(app.calendarFeed(first), null);
  assert.ok(app.calendarFeed(app.state.cal));
  assert.equal(tg.answers.at(-1), 'New link made. The old one no longer works.');
});

test('without a public address the calendar screen says so, and offers no link', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await send(app, '/calendar');
  assert.match(tg.last().text, /needs the bot's public address/);
  assert.ok(buttons(tg.last()).every(b => !b.url));
});

test('the server hands out the feed and its page by secret alone, and nothing without it', async () => {
  const secret = 'ab'.repeat(16);
  const asked = [];
  const server = createServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), token: 'x'.repeat(30),
    calendar: s => { asked.push(s); return s === secret ? 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' : null; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ics = await fetch(`${base}/cal/${secret}.ics`);
    assert.equal(ics.status, 200);
    assert.equal(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
    assert.equal(ics.headers.get('cache-control'), 'no-store');
    assert.equal(await ics.text(), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    const page = await fetch(`${base}/cal/${secret}`, { headers: { 'x-forwarded-host': 'bot.example.app' } });
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await page.text(), new RegExp(`href="webcal://bot\\.example\\.app/cal/${secret}\\.ics"`));
    const head = await fetch(`${base}/cal/${secret}.ics`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(`${base}/cal/${'cd'.repeat(16)}.ics`)).status, 404);
    assert.equal((await fetch(`${base}/cal/not-a-secret.ics`)).status, 401);     // not even the right shape: the locked part
    assert.equal((await fetch(`${base}/cal/${secret}.ics`, { method: 'POST' })).status, 401);
    assert.deepEqual(asked, [secret, secret, secret, 'cd'.repeat(16)]);
  } finally { await new Promise(r => server.close(r)); }
});

// ---------- options ----------

test('Options: the reminder and the fallbacks are set by tapping, and the menu leads there', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await send(app, '/menu');
  const card = tg.last();
  assert.equal(labels(card).at(-1), 'Options');
  await tap(app, 'opt', card.id);
  assert.equal(tg.last().text, '<b>Options</b>\nReminder: 2 hours before you play\nIf your slot is taken: book nothing else\nCalendar: your bookings in your phone\'s calendar');
  await tap(app, 'rm', card.id);
  assert.deepEqual(labels(tg.last()).slice(0, 4), ['Off', '1 hour before', '• 2 hours before', '3 hours before']);
  await tap(app, 'rm:60', card.id);
  assert.equal(app.state.remind, 60);
  assert.equal(tg.answers.at(-1), 'Reminder: 1 hour before you play');
  assert.deepEqual(labels(tg.last()).slice(0, 2), ['Off', '• 1 hour before']);
  await tap(app, 'rm:45', card.id);                                    // not one of the choices
  assert.equal(app.state.remind, 60);
  await tap(app, 'fb', card.id);
  assert.match(tg.last().text, /1\. The same start, one hour instead of two: off\n2\. An hour later, the same length: off/);
  await tap(app, 'fb:s', card.id);
  assert.deepEqual(app.state.fallback, { shorter: true, later: false });
  assert.equal(tg.answers.at(-1), 'If your slot is taken: take one hour instead of two');
  await tap(app, 'fb:l', card.id);
  assert.deepEqual(app.state.fallback, { shorter: true, later: true });
  assert.match(tg.last().text, /3\. An hour later, one hour\./);
  await tap(app, 'fb:s', card.id);
  assert.deepEqual(app.state.fallback, { shorter: false, later: true });
  await send(app, '/status');
  assert.match(tg.last().text, /Reminder: 1 hour before you play\nIf your slot is taken: take the same length an hour later/);
});

test('the new screens fit Telegram: 64 bytes a button, 1024 characters a caption', () => {
  const cfg = { plan: {}, once: [OPEN], order: [3, 4, 5, 2, 1, 6], releaseMin: 1320, daysAhead: 7 };
  const open = [{ id: '2026-11-20@19:00', date: '2026-11-20', start: 1140, end: 1260 }, { id: 'b', date: '2026-11-21', start: 600, end: 660 }, { id: 'c', date: '2026-11-22', start: 600, end: 660 }];
  const ctx = { cfg, now: at(`${TUE}T12:00:00Z`), paused: false, results: {}, lastSeen: at(`${TUE}T11:59:00Z`), linked: true, pc: 'awake', wake: 'ready',
    openNow: open, bookAsk: null, remind: 120, fallback: { shorter: true, later: true }, calUrl: `https://bot.example.app/cal/${'ab'.repeat(16)}` };
  for (const s of [UI.home(ctx), UI.home({ ...ctx, bookAsk: ctx.now }), UI.options(ctx), UI.reminder(ctx), UI.fallback(ctx), UI.calendarLink(ctx), UI.calendarLink({ ...ctx, calUrl: null }), UI.calendarNew(), UI.added(ctx, '2026-11-20', 1140, 2), UI.bookings(ctx)]) {
    assert.ok(s.caption.length <= 1024, s.caption);
    for (const b of s.keyboard.inline_keyboard.flat()) {
      assert.ok(b.text.length > 0);
      if (b.url) assert.match(b.url, /^https:\/\//); else assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    }
  }
});

// ---------- Book now ----------

test('Book now is offered while something is open, and the PC collects it on its next ping', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T12:00:00Z`, { state: { once: [OPEN] } });
  await app.pingFromAgent(HOME); await app.tick();
  await send(app, '/menu');
  const card = tg.last();
  assert.match(card.text, /Open now: Fri 20 Nov · 19:00–21:00\. Your PC books it at 21:55, or tap Book now\./);
  assert.deepEqual(labels(card).slice(0, 2), ['Sleep my PC', 'Book now']);
  // The PC's ping is waiting for something to do: the tap reaches it at once.
  const waiting = app.pingFromAgent(HOME, { wait: 50 });
  await tap(app, 'bn', card.id);
  assert.equal(tg.answers.at(-1), 'Book now sent');
  assert.match(tg.last().text, /Book now sent at 12:00\. Your PC starts within a few seconds; the result follows here\./);
  assert.deepEqual(await waiting, { ok: true, book: true });
  clock.t += 1000;
  assert.deepEqual(await app.pingFromAgent(HOME), { ok: true });        // once only
  // The run starts, books, and the result comes as usual. Nothing else is said.
  app.jobsForAgent(HOME, { run: true });
  clock.t += 40000;
  await app.resultFromAgent({ id: '2026-11-20@19:00', status: 'booked', court: 4, gate: '1111', end: 1260 });
  assert.match(tg.last().text, /^<b>Booked · Court 4<\/b>\nFri 20 Nov · 19:00–21:00/);
  const n = sent(tg).length;
  await go(app, clock, `${TUE}T12:30:00Z`);
  assert.equal(sent(tg).length, n);
  await send(app, '/menu');
  assert.ok(!labels(tg.last()).includes('Book now'));                  // nothing left to book
});

test('no Book now when nothing is open, when paused, or close to tonight\'s run', async () => {
  const none = makeApp(`${TUE}T12:00:00Z`, { state: { once: [{ date: '2026-11-30', start: 1140, hours: 1 }] } });   // opens next week
  await none.app.pingFromAgent(HOME); await none.app.tick();
  await send(none.app, '/menu');
  assert.ok(!labels(none.tg.last()).includes('Book now'));
  await send(none.app, '/booknow');
  assert.equal(none.tg.last().text, 'Nothing is open to book right now.');

  const paused = makeApp(`${TUE}T12:00:00Z`, { state: { once: [OPEN], paused: true } });
  await paused.app.pingFromAgent(HOME); await paused.app.tick();
  await send(paused.app, '/booknow');
  assert.equal(paused.tg.last().text, 'Booking is paused. Resume it first.');

  // Tuesdays are booked at 22:00 tonight: from 21:30 the nightly run has it in hand.
  const near = makeApp(`${TUE}T21:45:00Z`, { state: { once: [OPEN], plan: { tue: { start: 960, hours: 2 } } } });
  await near.app.pingFromAgent(HOME); await near.app.tick();
  await send(near.app, '/booknow');
  assert.equal(near.tg.last().text, 'Your PC\'s 22:00 run books this too. No need.');
  assert.deepEqual(await near.app.pingFromAgent(HOME), { ok: true });
});

test('a sleeping PC is woken for Book now, and collects it when it is up', async () => {
  const { app, tg, clock, woke } = makeApp(`${TUE}T12:00:00Z`, { env: WAKE, state: { once: [OPEN], lastSeen: at(`${TUE}T09:00:00Z`), home: { ip: HOME.ip, at: 1 } } });
  await app.tick();
  await send(app, '/booknow');
  assert.equal(woke.length, 1);
  assert.match(tg.last().text, /Book now sent at 12:00\. Your PC is waking up first; the result follows here\./);
  clock.t += 40000;
  assert.deepEqual(await app.pingFromAgent(HOME), { ok: true, book: true });

  // With no way to wake it, it is left for the nightly run.
  const stuck = makeApp(`${TUE}T12:00:00Z`, { state: { once: [OPEN], lastSeen: at(`${TUE}T09:00:00Z`) } });
  await stuck.app.tick();
  await send(stuck.app, '/booknow');
  assert.equal(stuck.tg.last().text, 'Your PC is not awake. It books this at its next run.');
  stuck.clock.t += 40000;
  assert.deepEqual(await stuck.app.pingFromAgent(HOME), { ok: true });
});

test('a Book now nobody collects within five minutes is dropped', async () => {
  const { app, clock } = makeApp(`${TUE}T12:00:00Z`, { env: WAKE, state: { once: [OPEN], lastSeen: at(`${TUE}T09:00:00Z`), home: { ip: HOME.ip, at: 1 } } });
  await app.tick();
  await send(app, '/booknow');
  clock.t += 5 * 60000 + 1;
  assert.deepEqual(await app.pingFromAgent(HOME), { ok: true });        // the PC woke too late: not a surprise booking
});

test('asked to sleep and to book: it books', async () => {
  const { app } = makeApp(`${TUE}T12:00:00Z`, { state: { once: [OPEN] } });
  await app.pingFromAgent(HOME); await app.tick();
  await send(app, '/sleep');
  await send(app, '/booknow');
  assert.deepEqual(await app.pingFromAgent(HOME), { ok: true, book: true });
  assert.deepEqual(await app.pingFromAgent(HOME), { ok: true });        // and the sleep is forgotten
  assert.equal(app.pcState(), 'awake');
});

test('if the PC cannot start the booking it says why, and you are told', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T12:00:00Z`, { state: { once: [OPEN] } });
  await app.pingFromAgent(HOME); await app.tick();
  await send(app, '/booknow');
  await app.pingFromAgent(HOME);                                        // collected
  tg.clear();
  await app.pingFromAgent(HOME, { refused: 'the nightly booking task is switched off', about: 'book' });
  assert.equal(tg.last().text, '<b>The booking did not start</b>\nYour PC could not start it: the nightly booking task is switched off.');
  await go(app, clock, `${TUE}T12:30:00Z`);
  assert.equal(sent(tg).length, 1);                                    // and no second message about it later
});

test('Book now that comes to nothing is followed up: the run never started, or said nothing', async () => {
  // Collected, but the PC's run never asked what to book.
  const a = makeApp(`${TUE}T12:00:00Z`, { state: { once: [OPEN] } });
  await a.app.pingFromAgent(HOME); await a.app.tick();
  await send(a.app, '/booknow');
  await a.app.pingFromAgent(HOME);
  a.tg.clear();
  for (const m of ['12:01', '12:02', '12:03', '12:04', '12:05', '12:06', '12:07']) { a.clock.t = at(`${TUE}T${m}:00Z`); await a.app.pingFromAgent(HOME); await a.app.tick(); }
  assert.equal(a.tg.calls.length, 0);
  await go(a.app, a.clock, `${TUE}T12:08:00Z`);
  assert.equal(a.tg.last().text, '<b>The booking did not start</b>\nYour PC took Book now for Fri 20 Nov · 19:00–21:00, but its booking run has not started.\nIts "ClubSpark court booking" task may be missing or switched off. Book by hand on ClubSpark if you can.');
  await go(a.app, a.clock, `${TUE}T12:20:00Z`);
  assert.equal(sent(a.tg).length, 1);

  // The run started (it asked for its jobs) and then went quiet.
  const b = makeApp(`${TUE}T12:00:00Z`, { state: { once: [OPEN] } });
  await b.app.pingFromAgent(HOME); await b.app.tick();
  await send(b.app, '/booknow');
  await b.app.pingFromAgent(HOME);
  b.clock.t = at(`${TUE}T12:00:20Z`);
  b.app.jobsForAgent(HOME, { run: true });
  b.tg.clear();
  await go(b.app, b.clock, `${TUE}T12:08:19Z`);
  assert.equal(sent(b.tg).length, 0);
  await go(b.app, b.clock, `${TUE}T12:08:20Z`);
  assert.match(b.tg.last().text, /^<b>No word from your PC<\/b>\nIt started on Fri 20 Nov · 19:00–21:00/);
});

test('the server passes on what a refusal was about', async () => {
  const got = [];
  const server = createServer({ getJobs: () => ({}), onResult: async () => ({ ok: true }), token: 'x'.repeat(30), onPing: (from, how) => { got.push(how); return { book: true }; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/agent/ping`, { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(30)}` }, body: JSON.stringify(body) }).then(r => r.json());
    assert.deepEqual(await post({ awake: true }), { ok: true, book: true });
    await post({ refused: 'the booking task is missing', about: 'book' });
    await post({ refused: 'wake timers are off', about: 'something else' });
    assert.deepEqual(got, [{ wait: 0, refused: null, about: null }, { wait: 0, refused: 'the booking task is missing', about: 'book' }, { wait: 0, refused: 'wake timers are off', about: null }]);
  } finally { await new Promise(r => server.close(r)); }
});

// ---------- when the slot is taken ----------

test('what may be booked instead: shorter first, then later, never past closing', () => {
  const alt = (start, end, fb) => alternativesFor({ start, end }, fb, 21 * 60).map(a => `${a.start / 60}-${a.end / 60}`);
  assert.deepEqual(alt(1080, 1200, { shorter: false, later: false }), []);
  assert.deepEqual(alt(1080, 1200, { shorter: true, later: false }), ['18-19']);
  assert.deepEqual(alt(1080, 1200, { shorter: false, later: true }), ['19-21']);
  assert.deepEqual(alt(1080, 1200, { shorter: true, later: true }), ['18-19', '19-21', '19-20']);
  assert.deepEqual(alt(1080, 1140, { shorter: true, later: true }), ['19-20']);                 // one hour asked: only later
  assert.deepEqual(alt(1140, 1260, { shorter: true, later: true }), ['19-20', '20-21']);        // 20:00-22:00 would run past closing
  assert.deepEqual(alt(1200, 1260, { shorter: true, later: true }), []);                        // the last slot of the day
});

test('the PC is told the fallbacks with each job, but never a time you asked for separately', () => {
  const state = { once: [{ date: '2026-11-20', start: 1080, hours: 2 }, { date: '2026-11-20', start: 1140, hours: 1 }], fallback: { shorter: true, later: true } };
  const { app } = makeApp(`${TUE}T12:00:00Z`, { state });
  const jobs = app.jobsForAgent(HOME, { run: false }).jobs;
  assert.deepEqual(jobs.map(j => j.id), ['2026-11-20@18:00', '2026-11-20@19:00']);
  assert.deepEqual(jobs[0].alternatives, [{ start: 1080, end: 1140 }]);                         // 19:00 is your other booking: not taken as a fallback
  assert.deepEqual(jobs[1].alternatives, [{ start: 1200, end: 1260 }]);
  const off = makeApp(`${TUE}T12:00:00Z`, { state: { once: state.once } });
  assert.deepEqual(off.app.jobsForAgent(HOME, { run: false }).jobs.map(j => j.alternatives), [[], []]);
});

test('a fallback booking says what was booked and what was asked, everywhere it shows', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T12:00:40Z`, { state: { once: [{ date: '2026-11-20', start: 1080, hours: 2 }] } });
  await app.resultFromAgent({ id: '2026-11-20@18:00', status: 'booked', court: 5, gate: '7777', start: 1140, end: 1200, askedEnd: 1200 });
  assert.equal(tg.last().text, '<b>Booked · Court 5</b>\nFri 20 Nov · 19:00–20:00\nYour slot (18:00–20:00) was taken, so this is the nearest free one.\nGate code: <code>7777</code>  (tap to copy)');
  const kept = app.state.results['2026-11-20@18:00'];
  assert.deepEqual([kept.start, kept.end, kept.askedStart, kept.askedEnd], [1140, 1200, 1080, 1200]);
  assert.deepEqual(app.jobsForAgent(HOME, { run: false }).jobs, []);    // the request is settled: not booked again tonight
  await send(app, '/plan');
  assert.match(tg.last().text, /1\. Fri 20 Nov · 18:00–20:00 \(booked 19:00–20:00 instead, Court 5, gate 7777\)/);
  assert.match(app.calendarFeed(app.state.cal) || feed(app.state.results), /DTSTART:20261120T190000Z\r\nDTEND:20261120T200000Z/);
  tg.clear();
  await go(app, clock, '2026-11-20T17:00:00Z');                         // two hours before the real start, not the asked one
  assert.match(tg.last().text, /Fri 20 Nov · 19:00–20:00 \(in 2 h\)/);
});

test('results are read safely: a fallback keeps what was asked, a plain booking does not', () => {
  const plain = cleanResult({ id: '2026-11-20@18:00', status: 'booked', court: 3, start: 1080, end: 1200, askedEnd: 1200 });
  assert.equal(plain.askedEnd, undefined);
  assert.deepEqual([plain.start, plain.end], [1080, 1200]);
  const shorter = cleanResult({ id: '2026-11-20@18:00', status: 'booked', court: 3, start: 1080, end: 1140, askedEnd: 1200 });
  assert.deepEqual([shorter.start, shorter.end, shorter.askedStart, shorter.askedEnd], [1080, 1140, 1080, 1200]);
  assert.deepEqual(cleanResult(shorter), shorter);                                              // and reads back the same from storage
  const old = cleanResult({ id: '2026-11-20@18:00', status: 'booked', court: 3, end: 1200 });   // a PC with older code: no start sent
  assert.deepEqual([old.start, old.end, old.askedEnd], [1080, 1200, undefined]);
  const none = cleanResult({ id: '2026-11-20@18:00', status: 'none', start: 1140, end: 1200, tried: 3 });
  assert.deepEqual([none.start, none.tried], [1080, 3]);                                        // not booked: always the time asked
  assert.equal(cleanResult({ id: '2026-11-20@18:00', status: 'none', tried: 1 }).tried, undefined);
  assert.match(M.failedText(none), /No court was free for the whole slot, nor for the fallback times\./);
  assert.match(M.failedText({ ...none, tried: undefined }), /No court was free for the whole slot\.\n/);
});

test('the new settings are kept, and travel in the backup line', () => {
  const s = loadState({ v: 4, owner: OWNER, remind: 90, fallback: { shorter: true }, cal: 'ab'.repeat(16) });
  assert.deepEqual([s.remind, s.fallback, s.cal], [90, { shorter: true, later: false }, 'ab'.repeat(16)]);
  const back = loadState(JSON.parse(backupLine(s)));
  assert.deepEqual([back.remind, back.fallback, back.cal], [90, { shorter: true, later: false }, 'ab'.repeat(16)]);
  const fresh = loadState({ v: 4, owner: OWNER, remind: 99999, fallback: 'yes', cal: 'not a secret' });
  assert.deepEqual([fresh.remind, fresh.fallback, fresh.cal], [120, { shorter: false, later: false }, null]);
  assert.equal(loadState({ v: 4, owner: OWNER, remind: 0 }).remind, 0);                          // off stays off
});
