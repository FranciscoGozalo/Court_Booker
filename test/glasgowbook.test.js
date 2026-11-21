'use strict';
// Book now at Glasgow Club (2.11.3, lib/glasgowbook.js): the parks' Book now, at Glasgow Club, with
// the payment as the one difference. What stands in the way, in order; the one hand-over of the
// order and its signature; each step from your PC; the go-ahead before Pay and every check behind
// it; your bank's approval; how it ends, said truthfully about what was paid; your PC's own result
// heard first; the timers; and everything else that waits while it runs. Your PC, Glasgow Club,
// Telegram, the push service and the clock are stand-ins. Nothing here signs in anywhere or pays.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../app');
const { serverFor } = require('../index');
const GB = require('../lib/glasgowbook');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const FRI = '2026-11-20';
const NOON = `${TUE}T12:00:00Z`;
const HOME = { ip: '81.2.69.142' };
const AGENT = 'a-long-random-line-for-testing-only';
const KEY = crypto.randomBytes(32).toString('base64');
const VISA = { brand: 'Visa', last4: '4242', expMonth: 12, expYear: 2028 };
const AUTH = crypto.randomBytes(16).toString('hex');          // the app's Face ID signature over the slot, as it sends it
const PUSH_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const MIN = 60 * 1000;
const RID = 'gorbals/2026-11-20@18:00';
const BODY = { venue: 'gorbals', type: 'indoor', date: FRI, start: 1080, hours: 1, court: 3, auth: AUTH };
const TWO = { ...BODY, courts: [3, 4] };
const settle = () => new Promise(r => setTimeout(r, 5));
const sealedOf = (n = 60) => crypto.randomBytes(32 + 24 + 16 + n).toString('base64');

// What the stand-in for Glasgow Club shows free on any day, at any centre: court 1 at 17:00, courts 3
// and 4 at 18:00, court 3 at 19:00.
const FREE = [
  { start: 1020, end: 1080, court: 1, name: 'Court 1', opensAt: null },
  { start: 1080, end: 1140, court: 3, name: 'Tennis Hall Court 3', opensAt: null },
  { start: 1080, end: 1140, court: 4, name: 'Tennis Hall Court 4', opensAt: null },
  { start: 1140, end: 1200, court: 3, name: 'Tennis Hall Court 3', opensAt: null },
];
// The bot with stand-ins. `reader.seen`: what Glasgow Club's site last did to your PC (a check, for the hour of quiet).
function makeBot(t0 = NOON, { state = {}, store = null, glasgowbook = {} } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const logs = [], pushes = [];
  store = store || memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], ...state });
  const reader = { seen: null, day: async () => ({ at: clock.t, slots: FREE.map(s => ({ ...s })), listed: 12 }), peek: () => null, health: () => reader.seen };
  const app = createApp({ now: () => clock.t, tg, store, pictures: PICTURES, linked: true, glasgow: reader, log: l => logs.push(l), glasgowbook,
    push: async (tokens, message) => { pushes.push({ tokens, ...message }); }, wake: async () => 3 });
  return { app, tg, clock, store, logs, pushes, reader };
}
async function linkPhone(t) {
  await t.app.handleUpdate(say(OWNER, '/app'));
  const code = /Code: <code>(\d{6})<\/code>/.exec(t.tg.last().text)[1];
  const r = t.app.appPair({ code, name: 'iPhone' });
  assert.equal(r.status, 200);
  await settle();
  const phone = { token: r.body.token, device: t.app.appAuth(r.body.token) };
  await t.app.appAsk(phone.device, 'push', { token: PUSH_TOKEN });
  return phone;
}
// Your PC's ping as a booker from 2.11.3 sends it: its card (Visa, Pay Automatically on) and Book now
// here at a cap of £30.00 a court. `book: null` is a booker older than 2.11.3.
const pcPing = (t, { wait = 0, card = {}, book = { max: '£30.00' } } = {}) =>
  t.app.pingFromAgent(HOME, { wait, card: { key: KEY, has: true, kept: VISA, auto: true, ...card }, book });
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);
const refused = (status, why) => ({ status, body: { ok: false, why } });
const stateOf = (t, phone) => t.app.appState(phone.device).state;
const pcSays = (t, raw) => t.app.glasgowBookFromAgent(raw);
const centreOf = b => (b.venue === 'scotstoun' ? (b.type === 'outdoor' ? 'o' : 's') : 'g');
async function seeFree(t, phone, centre = 'g', date = FRI) {
  assert.equal((await ask(t, phone, 'indoor/look', { centre, date })).status, 200);
}
// A court the app was shown free, booked now: the look, the request, and your PC's waiting ping collecting it.
async function collected(t, phone, body = BODY) {
  await pcPing(t);
  await seeFree(t, phone, centreOf(body), body.date);
  const ping = pcPing(t, { wait: 5 });
  const asked = await ask(t, phone, 'glasgow/book', body);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const order = await ping;
  return { asked, order, id: order.glasgowBook && order.glasgowBook.id };
}
// ...and its tool started on it.
async function started(t, phone, body = BODY) {
  const c = await collected(t, phone, body);
  pcSays(t, { id: c.id, stage: 'starting' });
  pcSays(t, { id: c.id, stage: 'signed-in' });
  return c;
}
// Your PC's result, as its tool posts it on /agent/result (booked and paid, unless said otherwise).
const resultOf = (extra = {}) => ({ id: RID, date: FRI, start: 1080, end: 1140, type: 'indoor', status: 'booked', court: 3, courts: [3], price: '£23.00', paid: true, ...extra });
const notPaidOf = why => resultOf({ status: 'failed', court: undefined, courts: undefined, paid: false, why });
let tapId = 1;
const tap = (app, data, messageId) => app.handleUpdate({
  update_id: 1, callback_query: { id: `gb${tapId++}`, data, from: { id: OWNER }, message: { message_id: messageId, chat: { id: OWNER, type: 'private' } } },
});
const lastAnswer = t => t.tg.answers[t.tg.answers.length - 1];

// Stand-ins for everything lib/glasgowbook.js asks app.js, each one switch: nothing in the way.
const clearEnv = () => ({ t: at(NOON), holdLive: false, csLive: false, awake: true, night: null, run: false, quiet: 0, starts: [],
  books: true, why: null, max: '£30.00', kept: true, auto: true, asking: null });
const depsOf = (env, extra = {}) => ({ now: () => env.t, linked: true,
  holdLive: () => env.holdLive, csLive: () => env.csLive, pcAwake: () => env.awake, nightNo: () => env.night, runGoing: () => env.run,
  quietUntil: () => env.quiet, starts: () => env.starts, addStart: t => env.starts.push(t), pc: () => ({ books: env.books, max: env.max, why: env.why }),
  card: () => ({ said: true, kept: env.kept, auto: env.auto, asking: env.asking }), shownFree: () => true, ...extra });

// ---------- end to end ----------

test('Book now at Glasgow Club, end to end: asked, collected once with its signature, each step, the go-ahead, your bank, booked and paid; an ordinary result with a card, a note and a push', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await pcPing(t);
  assert.deepEqual(stateOf(t, phone).glasgow, { linked: true, pcBooks: true, bookNo: null, payMax: '£30.00', book: null });
  const { asked, order, id } = await collected(t, phone);
  // Asked: the answer is the state, with the booking in it.
  assert.deepEqual(Object.keys(asked.body), ['ok', 'etag', 'state']);
  assert.deepEqual(asked.body.state.glasgow.book, {
    id, venue: 'gorbals', venueName: 'Gorbals', type: 'indoor', centre: 'g', date: FRI, start: 1080, end: 1140, hours: 1, court: 3, courts: [3], courtName: 'Court 3',
    stage: 'asked', live: true, ended: null, why: null, price: null, paid: null, at: t.clock.t, heardAt: t.clock.t, line: 'Asking your PC to book it.',
  });
  assert.equal(asked.body.state.glasgow.bookNo, 'Your PC is already booking a court.');
  // Handed over once, in the order's shape, with the signature; never again, and not kept here.
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.deepEqual(order, { ok: true, glasgowBook: { id, key: 'g', date: FRI, start: 1080, courts: [3], auth: AUTH } });
  assert.deepEqual(await pcPing(t), { ok: true });
  const book = () => stateOf(t, phone).glasgow.book;
  assert.equal(book().line, 'Starting Chrome on your PC…');
  for (const [stage, line] of [['starting', 'Signing in to Glasgow Club…'], ['signed-in', 'Signed in. Booking Court 3…']]) {
    assert.deepEqual(pcSays(t, { id, stage }), { ok: true });
    assert.deepEqual([book().stage, book().line], [stage, line]);
  }
  // A beat says only that it is still at it; it moves nothing.
  t.clock.t += 30000;
  assert.deepEqual(pcSays(t, { id, stage: 'signed-in', beat: true }), { ok: true });
  assert.deepEqual([book().stage, book().heardAt], ['signed-in', t.clock.t]);
  // About to press Pay: the go-ahead, for exactly that court at no more than the cap.
  assert.deepEqual(pcSays(t, { id, stage: 'paying', price: '£23.00', courts: [3] }), { ok: true, go: true });
  assert.deepEqual([book().stage, book().price, book().line], ['paying', '£23.00', 'Paying £23.00…']);
  // Your bank wants it approved: said once, in Telegram, as a note and a push. The night's run is not touched.
  const lastRun = t.app.state.lastRun, pushed = t.pushes.length;
  t.tg.clear();
  assert.deepEqual(pcSays(t, { id, stage: 'approve', price: '£23.00', court: 3, courts: [3] }), { ok: true });
  await settle();
  const words = 'Your PC is paying £23.00 for Gorbals · Fri 20 Nov · 18:00–19:00, court 3. Approve it in your bank’s app within five minutes.';
  assert.deepEqual(t.tg.calls.map(c => c.text), [`<b>Approve the payment in your bank's app</b>\n${words}`]);
  let s = stateOf(t, phone);
  assert.deepEqual([s.notes[0].kind, s.notes[0].title, s.notes[0].body], ['warn', 'Approve the payment in your bank\'s app', words]);
  assert.equal(t.pushes.length, pushed + 1);
  assert.deepEqual([s.glasgow.book.stage, s.glasgow.book.line], ['approve', 'Approve £23.00 in your bank’s app.']);
  assert.equal(t.app.state.lastRun, lastRun);
  pcSays(t, { id, stage: 'approve', price: '£23.00', court: 3, courts: [3] });
  pcSays(t, { id, stage: 'approve', beat: true });
  await settle();
  assert.equal(t.tg.calls.length, 1);
  // The result, as at midnight: the follower hears it first; then the card, the note, the push and Courts.
  t.tg.clear();
  assert.deepEqual(await t.app.resultFromAgent(resultOf()), { ok: true });
  await settle();
  assert.deepEqual(t.tg.calls.map(c => [c.method, c.text]), [['photo', '<b>Booked · Court 3</b>\nGorbals · Fri 20 Nov · 18:00–19:00\nPaid £23.00 with the card your PC keeps.']]);
  s = stateOf(t, phone);
  assert.deepEqual(s.results, [{ id: RID, venue: 'gorbals', status: 'booked', date: FRI, start: 1080, end: 1140, court: '3', gate: null, why: null, at: t.clock.t, past: false, type: 'indoor', price: '£23.00', paid: true, courts: [3] }]);
  assert.deepEqual([s.notes[0].kind, s.notes[0].title, s.notes[0].body, s.notes[0].ref], ['booked', 'Court 3 booked', 'Gorbals · Fri 20 Nov · 18:00–19:00 · paid £23.00', RID]);
  assert.equal(t.pushes.length, pushed + 2);
  assert.deepEqual([s.glasgow.book.live, s.glasgow.book.ended, s.glasgow.book.paid, s.glasgow.book.why, s.glasgow.book.line], [false, 'booked', true, null, 'Booked: Court 3. Paid £23.00.']);
  assert.equal(s.glasgow.bookNo, null);
  // The same slot is not booked again; your PC's later words change nothing, and a late "paying" is told to stop.
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, court: 4 }), refused(409, 'Court 3 is already booked for you at Gorbals on Fri 20 Nov at 18:00.'));
  assert.deepEqual(pcSays(t, { id, stage: 'gone', why: 'the booking tool has gone' }), { ok: true });
  assert.deepEqual(pcSays(t, { id, stage: 'paying', price: '£23.00', courts: [3] }), { ok: true, stop: true });
  assert.equal(book().ended, 'booked');
  // Its signature is nowhere: not in the state, the log, the settings or Telegram.
  assert.ok(![JSON.stringify(stateOf(t, phone)), t.logs.join('\n'), JSON.stringify(t.store.load()), JSON.stringify(t.tg.calls)].some(x => x.includes(AUTH)));
  // Telegram has no Book button: it cannot sign. Hold and I have paid stay as they were.
  assert.ok(!t.tg.calls.some(c => JSON.stringify(c.extra || {}).includes('glasgow')));
});

test('two courts: both named, handed over together, the go-ahead only for both at no more than twice the cap; booked as one result for the slot', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const { asked, order, id } = await started(t, phone, TWO);
  assert.deepEqual([asked.body.state.glasgow.book.courts, asked.body.state.glasgow.book.courtName], [[3, 4], 'Courts 3 & 4']);
  assert.deepEqual(order.glasgowBook.courts, [3, 4]);
  assert.equal(stateOf(t, phone).glasgow.book.line, 'Signed in. Booking Courts 3 & 4…');
  assert.deepEqual(pcSays(t, { id, stage: 'paying', price: '£46.00', courts: [3, 4] }), { ok: true, go: true });
  await t.app.resultFromAgent(resultOf({ court: '3 & 4', courts: [3, 4], price: '£46.00' }));
  await settle();
  const s = stateOf(t, phone);
  assert.deepEqual([s.results[0].court, s.results[0].courts, s.results[0].price], ['3 & 4', [3, 4], '£46.00']);
  assert.equal(s.glasgow.book.line, 'Booked: Courts 3 & 4. Paid £46.00.');
  assert.deepEqual(await ask(t, phone, 'glasgow/book', TWO), refused(409, 'Courts 3 & 4 are already booked for you at Gorbals on Fri 20 Nov at 18:00.'));
});

// ---------- what stands in the way ----------

test('what stands in the way, in order: each sentence as the one before it is cleared', async () => {
  assert.equal(GB.createGlasgowBook(depsOf(clearEnv(), { linked: false })).blocker(at(NOON)), 'Your PC isn’t linked, and it’s your PC that books Glasgow Club.');
  const env = clearEnv();
  const gb = GB.createGlasgowBook(depsOf(env));
  assert.equal(gb.blocker(env.t), null);
  assert.equal(await gb.appAsk(BODY, () => 'asked'), 'asked');
  // Everything at once in the way, then cleared one at a time.
  Object.assign(env, { holdLive: true, csLive: true, awake: false, night: 'Not available 21:25–22:15, around the nightly booking.', run: true, quiet: at(NOON) + 30 * MIN,
    starts: Array.from({ length: 6 }, (_, i) => at(NOON) - 50 * MIN + i * MIN), books: false, why: 'GLASGOW_PAY_PER_DAY in .env is 0.', max: null, kept: false, auto: false, asking: null });
  const steps = [
    ['Your PC is already booking a court.', () => { env.t += 25000; gb.tick(env.t); }],              // this booking, until it is over
    ['Your PC is holding a court at Glasgow Club. Let it go first.', () => { env.holdLive = false; }],
    ['Your PC is already booking a court.', () => { env.csLive = false; }],                       // a park's Book now
    ['Your PC isn’t awake. Wake it and try again.', () => { env.awake = true; }],
    ['Not available 21:25–22:15, around the nightly booking.', () => { env.night = null; }],
    ['Not available until the nightly booking has finished.', () => { env.run = false; }],
    ['Glasgow Club was checking visitors from your home connection. Not available until 12:30.', () => { env.quiet = 0; }],
    ['That’s 6 sign-ins to Glasgow Club in an hour. Next at 12:10.', () => { env.starts = []; }],
    ['Update the booker on your PC.', () => { env.books = true; }],
    ['Your PC can’t pay just now: GLASGOW_PAY_PER_DAY in .env is 0.', () => { env.why = null; }],
    ['Your PC hasn’t said yet whether it can pay. Try again in a minute.', () => { env.max = '£30.00'; }],
    ['There is no card on your PC. Add one in the app first.', () => { env.asking = 'card'; }],
    ['Your new card has not reached your PC yet. Try again in a moment.', () => { env.kept = true; env.asking = null; }],
    ['Turn on Pay Automatically first.', () => { env.asking = 'auto'; }],
    ['Pay Automatically has not reached your PC yet. Try again in a moment.', () => { env.auto = true; env.asking = 'card'; }],
    ['Your new card has not reached your PC yet. Try again in a moment.', () => { env.asking = 'auto'; }],
    ['Pay Automatically has not reached your PC yet. Try again in a moment.', () => { env.asking = null; }],
  ];
  for (const [sentence, clear] of steps) {
    assert.equal(gb.blocker(env.t), sentence);
    clear();
  }
  assert.equal(gb.blocker(env.t), null);
  assert.equal(gb.view(env.t).ended, 'nopickup');
});

test('what stands in the way, from the bot as it runs: the PC asleep, a hold, a park\'s Book now, the nightly runs, the site\'s check, an older booker, its reason, the card and Pay Automatically', async () => {
  const bookNo = (t, phone) => stateOf(t, phone).glasgow.bookNo;
  // Asleep: refused, and said so before anything is signed.
  const a = makeBot();
  const phoneA = await linkPhone(a);
  await pcPing(a);
  await seeFree(a, phoneA);
  a.clock.t += 4 * MIN;
  assert.equal(bookNo(a, phoneA), 'Your PC isn’t awake. Wake it and try again.');
  assert.deepEqual(await ask(a, phoneA, 'glasgow/book', BODY), refused(409, 'Your PC isn’t awake. Wake it and try again.'));
  assert.equal(stateOf(a, phoneA).glasgow.book, null);
  // A hold under way (Telegram's Hold button).
  const h = makeBot();
  const phoneH = await linkPhone(h);
  await pcPing(h);
  await seeFree(h, phoneH);
  await tap(h.app, 'gh:g:20261120:1800:3', 7);
  assert.equal(stateOf(h, phoneH).hold.live, true);
  assert.deepEqual(await ask(h, phoneH, 'glasgow/book', BODY), refused(409, 'Your PC is holding a court at Glasgow Club. Let it go first.'));
  // A park's Book now under way; and the other way round, the park's waits for this one (below).
  const p = makeBot();
  const phoneP = await linkPhone(p);
  await pcPing(p);
  const ping = pcPing(p, { wait: 5 });
  const looking = ask(p, phoneP, 'clubspark/look', { venue: 'queenspark', date: FRI });
  const o = await ping;
  p.app.clubSparkFromAgent('look', { id: o.csLook.id, ok: true, sheet: { courts: [['id-1', 'Court 1']], free: [[`booking-id-1|${FRI}|1080`, 1140]], intervals: 12, sessions: 4 } });
  assert.equal((await looking).status, 200);
  assert.equal((await ask(p, phoneP, 'clubspark/book', { venue: 'queenspark', date: FRI, start: 1080, hours: 1, court: 1 })).status, 200);
  assert.equal(bookNo(p, phoneP), 'Your PC is already booking a court.');
  // Around the nightly booking, every night: 21:25 to 22:15.
  const n = makeBot(`${TUE}T21:24:59Z`);
  const phoneN = await linkPhone(n);
  const nightAt = async time => { n.clock.t = at(time); await pcPing(n); return bookNo(n, phoneN); };
  assert.equal(await nightAt(`${TUE}T21:24:59Z`), null);
  for (const time of ['21:25:00', '21:55:00', '22:15:00']) assert.equal(await nightAt(`${TUE}T${time}Z`), 'Not available 21:25–22:15, around the nightly booking.', time);
  assert.equal(await nightAt(`${TUE}T22:15:01Z`), null);
  // On a night your PC books Glasgow Club at midnight: 21:25 until half past midnight.
  const c = makeBot(`${TUE}T21:00:00Z`, { state: { weekly: [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1 }] } });
  const phoneC = await linkPhone(c);
  const clubAt = async time => { c.clock.t = at(time); await pcPing(c); return bookNo(c, phoneC); };
  assert.equal(await clubAt(`${TUE}T21:24:59Z`), null);
  for (const time of [`${TUE}T21:25:00Z`, `${TUE}T22:30:00Z`, `${TUE}T23:59:00Z`, '2026-11-18T00:30:00Z']) assert.equal(await clubAt(time), 'Not available 21:25–00:30 tonight, around the midnight booking.', time);
  assert.equal(await clubAt('2026-11-18T00:30:01Z'), null);
  // Tonight's run still going after 22:15 (it has not said how every booking went).
  const r = makeBot(`${TUE}T21:55:00Z`, { state: { plan: { tue: { start: 960, hours: 2 } } } });
  const phoneR = await linkPhone(r);
  r.app.jobsForAgent(HOME, { run: true });
  r.clock.t = at(`${TUE}T22:31:00Z`);
  await pcPing(r);
  assert.equal(bookNo(r, phoneR), 'Not available until the nightly booking has finished.');
  // Glasgow Club checking visitors from home: an hour of quiet, holds and Book now alike.
  const q = makeBot();
  const phoneQ = await linkPhone(q);
  await pcPing(q);
  q.reader.seen = { ok: false, via: 'pc', why: 'challenge', at: q.clock.t };
  assert.equal(bookNo(q, phoneQ), 'Glasgow Club was checking visitors from your home connection. Not available until 13:00.');
  // A booker older than 2.11.3: the app holds there instead; and the PC's own reason it cannot pay now.
  const v = makeBot();
  const phoneV = await linkPhone(v);
  await pcPing(v, { book: null });
  assert.deepEqual([stateOf(v, phoneV).glasgow.pcBooks, bookNo(v, phoneV)], [false, 'Update the booker on your PC.']);
  await pcPing(v, { book: { max: '£30.00', why: 'GLASGOW_PAY_PER_DAY in .env is 0.' } });
  assert.deepEqual([stateOf(v, phoneV).glasgow.pcBooks, stateOf(v, phoneV).glasgow.payMax, bookNo(v, phoneV)], [true, '£30.00', 'Your PC can’t pay just now: GLASGOW_PAY_PER_DAY in .env is 0.']);
  await pcPing(v, { book: { max: '30 pounds' } });
  assert.deepEqual([stateOf(v, phoneV).glasgow.payMax, bookNo(v, phoneV)], [null, 'Your PC hasn’t said yet whether it can pay. Try again in a minute.']);
  // The card, and Pay Automatically, as your PC says it keeps them, and what is on its way to it.
  await pcPing(v, { card: { kept: null, auto: false } });
  assert.equal(bookNo(v, phoneV), 'There is no card on your PC. Add one in the app first.');
  await pcPing(v, { card: { auto: false } });
  assert.equal(bookNo(v, phoneV), 'Turn on Pay Automatically first.');
  assert.equal((await ask(v, phoneV, 'card/auto', { sealed: sealedOf() })).status, 200);
  assert.equal(bookNo(v, phoneV), 'Pay Automatically has not reached your PC yet. Try again in a moment.');
  const on = await pcPing(v, { card: { auto: false } });
  await pcPing(v, { card: { auto: true, autoDone: { id: on.autoOn.id, ok: true } } });
  assert.equal(bookNo(v, phoneV), null);
  assert.equal((await ask(v, phoneV, 'card', { sealed: sealedOf() })).status, 200);
  assert.equal(bookNo(v, phoneV), 'Your new card has not reached your PC yet. Try again in a moment.');
  const card = await pcPing(v);
  await pcPing(v, { card: { auto: false, done: { id: card.card.id, ok: true } } });        // a new card: its code goes with the old one
  assert.equal(bookNo(v, phoneV), 'Turn on Pay Automatically first.');
  await pcPing(v);
  assert.equal((await ask(v, phoneV, 'card/auto/off')).status, 200);                         // off on its way counts at once
  assert.equal(bookNo(v, phoneV), 'Turn on Pay Automatically first.');
});

test('the day, the time, a booking kept already (either court type at Scotstoun), and a court a look showed free lately: each refused in its own words, and nothing is started', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await pcPing(t);
  await seeFree(t, phone);
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, date: '2026-11-16' }), refused(400, 'That day is no longer on offer. Pick again.'));
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, date: '2026-11-25' }), refused(400, 'Not open yet: opens Wed 18 Nov at 00:00.'));       // the app schedules those
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, date: '2026-12-20' }), refused(400, 'Not open yet: opens Sun 13 Dec at 00:00.'));
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, date: TUE, start: 660 }), refused(400, 'That time is no longer on offer. Pick again.'));
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, auth: undefined }), refused(400, 'Book now at Glasgow Club is paid: it must be signed in the app.'));
  // Only courts a look showed the app free, at that start, in the last 15 minutes: every court asked for.
  const old = 'That list is old. Read the day again, then book a court.';
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, court: 5 }), refused(409, old));
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, court: 3, courts: [3, 5] }), refused(409, old));
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, start: 1140, court: 4 }), refused(409, old));
  assert.deepEqual(await ask(t, phone, 'glasgow/book', { ...BODY, venue: 'scotstoun', type: 'indoor' }), refused(409, old));     // a look at Gorbals is not one at Scotstoun
  t.clock.t += 15 * MIN;
  await pcPing(t);
  assert.deepEqual(await ask(t, phone, 'glasgow/book', BODY), refused(409, old));
  assert.deepEqual([stateOf(t, phone).glasgow.book, t.app.state.onceAway], [null, []]);
  // Booked already: whichever court type, since Scotstoun's indoor and outdoor share a result's id.
  const booked = (id, type, court) => ({ [id]: { id, status: 'booked', date: FRI, start: 1020, end: 1080, court, type, price: '£23.00', paid: true, at: at('2026-11-13T00:02:00Z') } });
  const u = makeBot(NOON, { state: { results: booked('scotstoun/2026-11-20@17:00', 'indoor', '2') } });
  const phoneU = await linkPhone(u);
  await pcPing(u);
  const out = { venue: 'scotstoun', type: 'outdoor', date: FRI, start: 1020, court: 1, auth: AUTH };
  assert.deepEqual(await ask(u, phoneU, 'glasgow/book', out), refused(409, 'Court 2 is already booked for you at Scotstoun on Fri 20 Nov at 17:00.'));
  const w = makeBot(NOON, { state: { results: booked('scotstoun/2026-11-20@17:00', 'outdoor', '1') } });
  const phoneW = await linkPhone(w);
  await pcPing(w);
  assert.deepEqual(await ask(w, phoneW, 'glasgow/book', { ...out, type: 'indoor', court: 2 }), refused(409, 'Court 1 is already booked for you at Scotstoun outdoor on Fri 20 Nov at 17:00.'));
  // A slot that was not booked is no hindrance.
  const f = makeBot(NOON, { state: { results: { [RID]: { id: RID, status: 'failed', date: FRI, start: 1080, end: 1140, type: 'indoor', paid: false, why: 'x', at: at(NOON) - MIN } } } });
  const phoneF = await linkPhone(f);
  assert.equal((await collected(f, phoneF)).asked.status, 200);
});

// ---------- the hand-over ----------

test('a booking waiting for your PC\'s ping is looked at again before it is handed over; if anything came round meanwhile it is not, and nothing was paid', async () => {
  const cases = [
    ['quiet', env => { env.quiet = env.t + MIN; }, 'Glasgow Club was checking visitors from your home connection'],
    ['night', env => { env.night = 'Not available 21:25–22:15, around the nightly booking.'; }, 'your PC\'s nightly booking run was near'],
    ['hold', env => { env.holdLive = true; }, 'your PC was holding a court at Glasgow Club'],
    ['park', env => { env.csLive = true; }, 'your PC was booking a park court'],
    ['older booker', env => { env.books = false; }, 'your PC no longer said it books Glasgow Club'],
    ['cannot pay', env => { env.why = 'its daily limit of 2 is used up.'; }, 'your PC could not pay just then (its daily limit of 2 is used up)'],
  ];
  for (const [name, change, why] of cases) {
    const env = clearEnv(), kept = [];
    const gb = GB.createGlasgowBook(depsOf(env, { record: async r => { kept.push(r); } }));
    assert.equal(await gb.appAsk(BODY, () => 'asked'), 'asked', name);
    change(env);
    assert.equal(gb.takeOrder(env.t), null, name);
    assert.equal(gb.takeOrder(env.t), null, name);
    await settle();
    assert.deepEqual(kept, [{ id: RID, venue: 'gorbals', status: 'failed', type: 'indoor', end: 1140, paid: false, why: `${why}, so it was not handed to your PC` }], name);
    assert.deepEqual([gb.view(env.t).ended, gb.view(env.t).line], ['notsent', `Not booked: ${why}, so it was not handed to your PC. Nothing was paid.`], name);
  }
  // In the bot: a PC rolled back to an older booker says nothing of Book now on the very ping that
  // would collect it, so it is not handed over; the app goes back to Hold at once.
  const t = makeBot();
  const phone = await linkPhone(t);
  await pcPing(t);
  await seeFree(t, phone);
  assert.equal((await ask(t, phone, 'glasgow/book', BODY)).status, 200);
  assert.deepEqual(await pcPing(t, { book: null }), { ok: true });
  await settle();
  const s = stateOf(t, phone);
  assert.deepEqual([s.glasgow.pcBooks, s.glasgow.book.ended, s.results[0].why, s.results[0].paid],
    [false, 'notsent', 'It didn’t work: your PC no longer said it books Glasgow Club, so it was not handed to your PC. Nothing was paid.', false]);
  assert.equal(t.tg.last().text, '<b>Not booked · Gorbals · Fri 20 Nov · 18:00–19:00</b>\nIt didn’t work: your PC no longer said it books Glasgow Club, so it was not handed to your PC. Nothing was paid.\nBook by hand on Glasgow Club\'s site if you still want it.');
  // ...or one whose ping says it cannot pay just now; or the nightly booking's time came while it waited.
  const u = makeBot();
  const phoneU = await linkPhone(u);
  await pcPing(u);
  await seeFree(u, phoneU);
  await ask(u, phoneU, 'glasgow/book', BODY);
  assert.deepEqual(await pcPing(u, { book: { max: '£30.00', why: 'GLASGOW_PAY_PER_DAY in .env is 0.' } }), { ok: true });
  assert.equal(stateOf(u, phoneU).glasgow.book.why, 'your PC could not pay just then (GLASGOW_PAY_PER_DAY in .env is 0), so it was not handed to your PC. Nothing was paid');
  const n = makeBot(`${TUE}T21:24:50Z`);
  const phoneN = await linkPhone(n);
  await pcPing(n);
  await seeFree(n, phoneN);
  assert.equal((await ask(n, phoneN, 'glasgow/book', BODY)).status, 200);
  n.clock.t = at(`${TUE}T21:25:00Z`);
  assert.deepEqual(await pcPing(n), { ok: true });
  assert.equal(stateOf(n, phoneN).glasgow.book.ended, 'notsent');
});

// ---------- the go-ahead ----------

test('the go-ahead only for the booking still followed: exactly its courts, at no more than your PC\'s cap a court, Pay Automatically on and no off on its way; anything else is stop', async () => {
  const goWith = async (paying, { body = BODY, before = async () => {} } = {}) => {
    const t = makeBot();
    const phone = await linkPhone(t);
    const { id } = await started(t, phone, body);
    await before(t, phone);
    return { t, phone, id, answer: pcSays(t, { id, stage: 'paying', ...paying }) };
  };
  const GO = { ok: true, go: true }, STOP = { ok: true, stop: true };
  assert.deepEqual((await goWith({ price: '£23.00', courts: [3] })).answer, GO);
  assert.deepEqual((await goWith({ price: '£30.00', courts: [3] })).answer, GO);                    // the cap itself
  assert.deepEqual((await goWith({ price: '£30.01', courts: [3] })).answer, STOP);
  assert.deepEqual((await goWith({ price: '£23.00', courts: [4] })).answer, STOP);                  // not the court asked for
  assert.deepEqual((await goWith({ price: '£23.00' })).answer, STOP);                               // courts not said
  assert.deepEqual((await goWith({ courts: [3] })).answer, STOP);                                   // price not said
  assert.deepEqual((await goWith({ price: '23', courts: [3] })).answer, STOP);
  assert.deepEqual((await goWith({ price: '£60.00', courts: [3, 4] }, { body: TWO })).answer, GO);   // two courts: twice the cap
  assert.deepEqual((await goWith({ price: '£60.01', courts: [3, 4] }, { body: TWO })).answer, STOP);
  assert.deepEqual((await goWith({ price: '£23.00', courts: [3] }, { body: TWO })).answer, STOP);    // all or nothing
  // What your PC's pings have said since: a lower cap, a reason it cannot pay, Pay Automatically off.
  assert.deepEqual((await goWith({ price: '£23.00', courts: [3] }, { before: t => pcPing(t, { book: { max: '£20.00' } }) })).answer, STOP);
  assert.deepEqual((await goWith({ price: '£23.00', courts: [3] }, { before: t => pcPing(t, { book: { max: '£30.00', why: 'its daily limit of 2 is used up' } }) })).answer, STOP);
  assert.deepEqual((await goWith({ price: '£23.00', courts: [3] }, { before: t => pcPing(t, { card: { auto: false } }) })).answer, STOP);
  // Off asked for in the app: never refused while it books, and it stops this one at once.
  const off = await goWith({ price: '£23.00', courts: [3] }, { before: async (t, phone) => { assert.equal((await ask(t, phone, 'card/auto/off')).status, 200); } });
  assert.deepEqual(off.answer, STOP);
  // Its result then says why your PC did not pay, in this bot's words: nothing was paid.
  await off.t.app.resultFromAgent(notPaidOf('your PC did not pay: the bot did not give the go-ahead to pay (it had stopped following this booking). The court was taken out of your basket again'));
  await settle();
  const s = stateOf(off.t, off.phone);
  assert.deepEqual([s.results[0].why, s.results[0].paid], ['It didn’t work: Pay Automatically was turned off, so I told your PC not to pay. Nothing was paid.', false]);
  assert.deepEqual([s.glasgow.book.ended, s.glasgow.book.line], ['failed', 'Not booked: Pay Automatically was turned off, so I told your PC not to pay. Nothing was paid.']);
  assert.match(off.t.logs.join('\n'), /no go-ahead to pay for Gorbals 2026-11-20 18:00 court 3: Pay Automatically was turned off/);
  // The same result sent again (its answer was lost on the way) is kept in the same words, once.
  const cards = off.t.tg.calls.length;
  await off.t.app.resultFromAgent(notPaidOf('your PC did not pay: the bot did not give the go-ahead to pay (it had stopped following this booking). The court was taken out of your basket again'));
  await settle();
  assert.deepEqual([off.t.app.state.results[RID].why, off.t.tg.calls.length], ['Pay Automatically was turned off, so I told your PC not to pay', cards]);
  // A stop for the price says the price and the cap; and the PC's own word "gone" after a stop says the same.
  const over = await goWith({ price: '£31.00', courts: [3] });
  pcSays(over.t, { id: over.id, stage: 'gone', why: 'the booking tool stopped with code 7' });
  await settle();
  assert.equal(stateOf(over.t, over.phone).results[0].why, 'It didn’t work: £31.00 is over your PC\'s cap of £30.00, so I told your PC not to pay. Nothing was paid.');
  // The same "paying" again (its answer was lost on the way): the same go-ahead.
  const again = await goWith({ price: '£23.00', courts: [3] });
  assert.deepEqual(pcSays(again.t, { id: again.id, stage: 'paying', price: '£23.00', courts: [3] }), GO);
  // A booking this bot does not know (it restarted since), or one that has ended: stop.
  assert.deepEqual(pcSays(again.t, { id: 'ffffffffffff', stage: 'paying', price: '£23.00', courts: [3] }), { ok: true, stop: true, unknown: true });
  assert.deepEqual(pcSays(again.t, { id: 'ffffffffffff', stage: 'starting' }), { ok: true, unknown: true });
  assert.deepEqual(again.t.app.glasgowBookFromAgent(null), { ok: true, unknown: true });
  const ended = await goWith({ price: '£23.00', courts: [3] }, { before: t => { t.clock.t += 4 * MIN; return t.app.tick(); } });
  assert.deepEqual(ended.answer, STOP);
});

test('over HTTP, with the server built as index.js builds it: the ping carries Book now and hands the order over, the steps reach the follower, "paying" gets the go-ahead, and the result is the follower\'s', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const server = serverFor(t.app, { token: AGENT, appPollMs: 15 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, token) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async res => ({ status: res.status, json: await res.json() }));
  const post = (path, body, token = AGENT) => call('POST', path, body, token);
  try {
    // Your PC's ping as its booker sends it: the card, Pay Automatically, and Book now here.
    const pingBody = { cardKey: KEY, card: VISA, cardAuto: true, glasgowBook: { max: '£30.00' } };
    assert.deepEqual(await post('/agent/ping', pingBody), { status: 200, json: { ok: true } });
    assert.equal((await post('/app/indoor/look', { centre: 'g', date: FRI }, phone.token)).status, 200);
    const ping = post('/agent/ping', { ...pingBody, wait: 5 });
    const asked = await post('/app/glasgow/book', BODY, phone.token);
    assert.equal(asked.status, 200);
    assert.equal(asked.json.state.glasgow.book.stage, 'asked');
    const order = (await ping).json;
    const id = order.glasgowBook.id;
    assert.deepEqual(order, { ok: true, glasgowBook: { id, key: 'g', date: FRI, start: 1080, courts: [3], auth: AUTH } });
    assert.deepEqual(await post('/agent/glasgow/book', { id, stage: 'starting' }), { status: 200, json: { ok: true } });
    assert.deepEqual(await post('/agent/glasgow/book', { id, stage: 'signed-in', beat: true }), { status: 200, json: { ok: true } });
    assert.deepEqual(await post('/agent/glasgow/book', { id, stage: 'paying', price: '£23.00', courts: [3] }), { status: 200, json: { ok: true, go: true } });
    assert.deepEqual(await post('/agent/glasgow/book', { id: 'ffffffffffff', stage: 'paying', price: '£23.00', courts: [3] }), { status: 200, json: { ok: true, stop: true, unknown: true } });
    // The phone's token opens nothing under /agent/.
    assert.equal((await post('/agent/glasgow/book', { id, stage: 'paying', price: '£23.00', courts: [3] }, phone.token)).status, 401);
    assert.deepEqual(await post('/agent/result', resultOf()), { status: 200, json: { ok: true } });
    const s = (await call('GET', '/app/state', undefined, phone.token)).json.state;
    assert.deepEqual([s.glasgow.book.ended, s.glasgow.book.line, s.results[0].status], ['booked', 'Booked: Court 3. Paid £23.00.', 'booked']);
  } finally { await new Promise(r => { server.closeAllConnections(); server.close(r); }); }
});

// ---------- liveness, and your bank ----------

test('beats keep it alive through a slow sign-in and basket (three minutes before "paying"); a beat of any stage is only heard; with no word at all it is over at four minutes, and nothing was paid', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const { id } = await collected(t, phone);
  pcSays(t, { id, stage: 'starting' });
  for (let i = 0; i < 7; i++) {
    t.clock.t += 30000;
    assert.deepEqual(pcSays(t, { id, stage: i < 3 ? 'starting' : 'signed-in', beat: true }), { ok: true });
    await t.app.tick();
  }
  pcSays(t, { id, stage: 'signed-in' });
  t.clock.t += 30000;
  assert.deepEqual(pcSays(t, { id, stage: 'held', beat: true }), { ok: true });                     // not a stage of Book now: heard, and nothing more
  t.clock.t += 30000;
  await t.app.tick();
  let b = stateOf(t, phone).glasgow.book;
  assert.deepEqual([b.live, b.stage, b.line], [true, 'signed-in', 'Signed in. Booking Court 3…']);
  assert.deepEqual(pcSays(t, { id, stage: 'paying', price: '£23.00', courts: [3] }), { ok: true, go: true });
  // Silent before the go-ahead: over a minute, the state says so; four minutes, it is over.
  const u = makeBot();
  const phoneU = await linkPhone(u);
  const c = await collected(u, phoneU);
  pcSays(u, { id: c.id, stage: 'starting' });
  u.clock.t += 75 * 1000;
  await u.app.tick();
  b = stateOf(u, phoneU).glasgow.book;
  assert.deepEqual([b.live, b.line], [true, 'No word from your PC for over a minute.']);
  u.clock.t += 165 * 1000;
  await u.app.tick();
  await settle();
  const s = stateOf(u, phoneU);
  assert.deepEqual([s.glasgow.book.ended, s.results[0].paid, s.results[0].why], ['silent', false,
    'It didn’t work: no word from your PC for four minutes, so I stopped following it. It pays nothing without my go-ahead. Nothing was paid.']);
  assert.deepEqual(pcSays(u, { id: c.id, stage: 'paying', price: '£23.00', courts: [3] }), { ok: true, stop: true });
});

// ---------- how it ends ----------

test('each ending decided without a result from your PC is a failed result: "nothing was paid" before the go-ahead, and after it whatever is known of a press', async () => {
  const endedWith = async (go, raw, extraSteps = async () => {}) => {
    const t = makeBot();
    const phone = await linkPhone(t);
    const { id } = await started(t, phone);
    if (go) assert.deepEqual(pcSays(t, { id, stage: 'paying', price: '£23.00', courts: [3] }), { ok: true, go: true });
    if (raw) pcSays(t, { id, ...raw });
    await extraSteps(t, id);
    await settle();
    const s = stateOf(t, phone);
    return { ended: s.glasgow.book.ended, paid: s.results[0].paid, why: s.results[0].why, line: s.glasgow.book.line, t, phone };
  };
  const NOTHING = 'Nothing was paid.';
  const MAYBE = 'Pay was pressed, and whether the payment went through is not known: look in your banking app and under Bookings on Glasgow Club\'s site.';
  // The link would not start it.
  let e = await endedWith(false, { stage: 'refused', why: 'it is holding or booking a court at Glasgow Club for you already' });
  assert.deepEqual([e.ended, e.paid, e.why], ['refused', false, `It didn’t work: your PC did not start it: it is holding or booking a court at Glasgow Club for you already. ${NOTHING}`]);
  // Its tool gone, or stopped, before the go-ahead.
  e = await endedWith(false, { stage: 'gone', why: 'the booking tool stopped with code 2' });
  assert.deepEqual([e.ended, e.paid, e.why], ['gone', false, `It didn’t work: your PC's booking stopped before paying (the booking tool stopped with code 2). ${NOTHING}`]);
  e = await endedWith(false, { stage: 'quit', why: 'your PC went to sleep', pressed: false });
  assert.deepEqual([e.ended, e.paid, e.why], ['quit', false, `It didn’t work: your PC's booking stopped before paying (your PC went to sleep). ${NOTHING}`]);
  // After the go-ahead: no press noted, or one noted (or may have been).
  e = await endedWith(true, { stage: 'gone', why: 'the booking tool stopped with code 7' });
  assert.deepEqual([e.ended, e.paid, e.why], ['gone', false, `It didn’t work: your PC stopped before Pay was pressed (the booking tool stopped with code 7). An unpaid court lapses by itself. ${NOTHING}`]);
  e = await endedWith(true, { stage: 'gone', why: 'the booking tool stopped with code 1', pressed: 'maybe' });
  assert.deepEqual([e.ended, e.paid, e.why], ['gone', 'maybe', `It didn’t work: your PC's booking stopped (the booking tool stopped with code 1) while it was paying for Court 3. ${MAYBE}`]);
  assert.equal(e.line, `Not booked: your PC's booking stopped (the booking tool stopped with code 1) while it was paying for Court 3. ${MAYBE.slice(0, -1)}.`);
  e = await endedWith(true, { stage: 'quit', why: 'your PC went to sleep', pressed: true });
  assert.deepEqual([e.ended, e.paid], ['quit', 'maybe']);
  // Silent after the go-ahead: a press is not ruled out.
  e = await endedWith(true, null, async t => { t.clock.t += 4 * MIN; await t.app.tick(); });
  assert.deepEqual([e.ended, e.paid, e.why], ['silent', 'maybe', `It didn’t work: no word from your PC while it was paying for Court 3. ${MAYBE}`]);
  // Still at it half an hour after it was collected, beats and all.
  const beating = async (t, id) => { for (let m = 1; m <= 30; m++) { t.clock.t += MIN; pcSays(t, { id, stage: 'signed-in', beat: true }); await t.app.tick(); } };
  e = await endedWith(false, null, beating);
  assert.deepEqual([e.ended, e.paid, e.why], ['timeout', false, `It didn’t work: your PC was still at it half an hour after it took the booking, so I stopped following it. It pays nothing without my go-ahead. ${NOTHING}`]);
  e = await endedWith(true, null, beating);
  assert.deepEqual([e.ended, e.paid, e.why], ['timeout', 'maybe', `It didn’t work: I stopped following it half an hour after your PC took it, while it was paying for Court 3. ${MAYBE}`]);
  // Glasgow Club was checking visitors (its tool's exit 9): an hour of quiet for holds and Book now alike, even after a result.
  e = await endedWith(false, { stage: 'gone', why: 'Glasgow Club showed a check page', kind: 'challenge' });
  const s = stateOf(e.t, e.phone);
  assert.deepEqual([s.glasgow.bookNo, s.indoor.holdNo], ['Glasgow Club was checking visitors from your home connection. Not available until 13:00.',
    'Glasgow Club was checking visitors from your home connection. Not available until 13:00.']);
  // Each ending decided here is said in Telegram once, as a card, and as a note.
  assert.equal(e.t.tg.calls.filter(c => /^<b>Not booked · Gorbals · Fri 20 Nov · 18:00–19:00<\/b>/.test(c.text || '')).length, 1);
  assert.deepEqual([s.notes[0].kind, s.notes[0].title, s.notes[0].ref], ['missed', 'Not booked', RID]);
});

test('your PC\'s result is the follower\'s first: it replaces an ending decided here, a booking replaces any, and it is kept even when Telegram will not take its card', async () => {
  // Silent before the go-ahead, then your PC's own failure: its words stand.
  const a = makeBot();
  const phoneA = await linkPhone(a);
  const ca = await started(a, phoneA);
  a.clock.t += 4 * MIN;
  await a.app.tick();
  await settle();
  assert.equal(stateOf(a, phoneA).glasgow.book.ended, 'silent');
  await a.app.resultFromAgent(notPaidOf('Court 3 was no longer free at 18:00, and your PC takes no other court'));
  await settle();
  let s = stateOf(a, phoneA);
  assert.deepEqual([s.glasgow.book.ended, s.results[0].why], ['failed', 'It didn’t work: Court 3 was no longer free at 18:00, and your PC takes no other court. Nothing was paid.']);
  assert.equal(s.glasgow.book.line, 'Not booked: Court 3 was no longer free at 18:00, and your PC takes no other court. Nothing was paid.');
  assert.deepEqual(pcSays(a, { id: ca.id, stage: 'gone', why: 'the booking tool stopped with code 7' }), { ok: true });      // the link's word after it changes nothing
  assert.equal(stateOf(a, phoneA).glasgow.book.ended, 'failed');
  // Gone after the go-ahead with a press noted, then booked after all: a booking replaces any ending.
  const b = makeBot();
  const phoneB = await linkPhone(b);
  const cb = await started(b, phoneB);
  pcSays(b, { id: cb.id, stage: 'paying', price: '£23.00', courts: [3] });
  pcSays(b, { id: cb.id, stage: 'gone', pressed: 'maybe' });
  await settle();
  assert.equal(b.app.state.results[RID].paid, 'maybe');
  await b.app.resultFromAgent(resultOf());
  await settle();
  s = stateOf(b, phoneB);
  assert.deepEqual([s.glasgow.book.ended, s.results[0].status, s.results[0].paid], ['booked', 'booked', true]);
  // ...and nothing replaces a booking.
  await b.app.resultFromAgent(notPaidOf('a late word'));
  await settle();
  assert.deepEqual([stateOf(b, phoneB).glasgow.book.ended, b.app.state.results[RID].status], ['booked', 'booked']);
  // Telegram down when the result comes: it is kept all the same, and the follower has it, so the
  // link's "gone" afterwards changes nothing and no "look under Bookings" is kept over a paid court.
  const c = makeBot();
  const phoneC = await linkPhone(c);
  const cc = await started(c, phoneC);
  pcSays(c, { id: cc.id, stage: 'paying', price: '£23.00', courts: [3] });
  c.tg.failSend = 5;
  assert.deepEqual(await c.app.resultFromAgent(resultOf()), { ok: true });
  c.tg.failSend = 0;
  pcSays(c, { id: cc.id, stage: 'gone', pressed: 'maybe' });
  await settle();
  s = stateOf(c, phoneC);
  assert.deepEqual([s.glasgow.book.ended, s.results[0].status, s.results[0].paid], ['booked', 'booked', true]);
  assert.match(c.logs.join('\n'), /Could not send the card for gorbals\/2026-11-20@18:00: network down/);
  // A result for the other court type at the same hour (Scotstoun) is not this booking's.
  const d = makeBot();
  const phoneD = await linkPhone(d);
  const out = { venue: 'scotstoun', type: 'outdoor', date: FRI, start: 1020, court: 1, auth: AUTH };
  await started(d, phoneD, out);
  await d.app.resultFromAgent({ id: 'scotstoun/2026-11-20@17:00', type: 'indoor', status: 'failed', paid: false, why: 'the midnight run\'s' });
  assert.equal(stateOf(d, phoneD).glasgow.book.live, true);
  await d.app.resultFromAgent({ id: 'scotstoun/2026-11-20@17:00', type: 'outdoor', status: 'booked', court: 1, price: '£6.00', paid: true });
  assert.deepEqual([stateOf(d, phoneD).glasgow.book.ended, stateOf(d, phoneD).glasgow.book.line], ['booked', 'Booked: Court 1. Paid £6.00.']);
  // A result whose tool's first step never arrived is still the booking's (it was collected).
  const f = makeBot();
  const phoneF = await linkPhone(f);
  await collected(f, phoneF);
  await f.app.resultFromAgent(resultOf());
  assert.equal(stateOf(f, phoneF).glasgow.book.ended, 'booked');
  // An ending decided here whose card is slow on its way, and your PC's result kept meanwhile: your PC's word stands.
  for (const pc of [resultOf(), notPaidOf('Court 3 was no longer free at 18:00, and your PC takes no other court')]) {
    const k = makeBot();
    const phoneK = await linkPhone(k);
    const ck = await started(k, phoneK);
    pcSays(k, { id: ck.id, stage: 'paying', price: '£23.00', courts: [3] });
    const fast = k.tg.sendPhoto;
    let slowOnce = true;
    k.tg.sendPhoto = async (...a) => { if (slowOnce) { slowOnce = false; await new Promise(r => setTimeout(r, 30)); } return fast(...a); };
    k.clock.t += 4 * MIN;
    await k.app.tick();                                                                          // silent: its card on its way, slowly
    await k.app.resultFromAgent(pc);
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual([k.app.state.results[RID].status, k.app.state.results[RID].paid, stateOf(k, phoneK).glasgow.book.ended], [pc.status, pc.paid, pc.status]);
    assert.match(k.logs.join('\n'), /Result for gorbals\/2026-11-20@18:00 not kept over the one kept meanwhile/);
  }
  // Silent after the go-ahead, then your PC is heard again: your bank wants it approved. Said all the same.
  const g = makeBot();
  const phoneG = await linkPhone(g);
  const cg = await started(g, phoneG);
  pcSays(g, { id: cg.id, stage: 'paying', price: '£23.00', courts: [3] });
  g.clock.t += 4 * MIN;
  await g.app.tick();
  g.tg.clear();
  assert.deepEqual(pcSays(g, { id: cg.id, stage: 'approve', price: '£23.00', court: 3 }), { ok: true });
  await settle();
  assert.deepEqual(g.tg.calls.map(c => c.text.split('\n')[0]), ['<b>Approve the payment in your bank\'s app</b>']);
  // Half an hour and more after it was collected, a result for that slot is no longer this booking's
  // (a 21:55 run's, for a one-off on the list for it): the booking keeps its own ending.
  const h = makeBot();
  const phoneH = await linkPhone(h);
  const ch = await started(h, phoneH);
  pcSays(h, { id: ch.id, stage: 'refused', why: 'it is booking a court at Glasgow Club for you already' });
  await settle();
  h.clock.t += GB.RESULT_MS;
  await h.app.resultFromAgent(notPaidOf('No court free for the whole time'));
  await settle();
  assert.deepEqual([stateOf(h, phoneH).glasgow.book.ended, h.app.state.results[RID].why], ['refused', 'No court free for the whole time']);
});

test('the timers: not collected in 25 seconds, collected and never started in 90, silent for four minutes, still going after half an hour', async () => {
  // Not collected: nothing was handed over, and nothing is handed over late.
  const a = makeBot();
  const phoneA = await linkPhone(a);
  await pcPing(a);
  await seeFree(a, phoneA);
  assert.equal((await ask(a, phoneA, 'glasgow/book', BODY)).status, 200);
  a.clock.t += 24999;
  await a.app.tick();
  assert.equal(stateOf(a, phoneA).glasgow.book.live, true);
  a.clock.t += 1;
  await a.app.tick();
  await settle();
  assert.deepEqual([stateOf(a, phoneA).glasgow.book.ended, stateOf(a, phoneA).results[0].why], ['nopickup', 'It didn’t work: your PC did not collect it in time. Nothing was paid.']);
  assert.deepEqual(await pcPing(a), { ok: true });
  // Collected, then no word at all for a minute and a half: it never started (an older link, or a tool that would not start).
  const b = makeBot();
  const phoneB = await linkPhone(b);
  const cb = await collected(b, phoneB);
  b.clock.t += 89999;
  await b.app.tick();
  assert.equal(stateOf(b, phoneB).glasgow.book.live, true);
  b.clock.t += 1;
  await b.app.tick();
  await settle();
  assert.deepEqual([stateOf(b, phoneB).glasgow.book.ended, stateOf(b, phoneB).results[0].why], ['nostart', 'It didn’t work: your PC collected it but did not start on it. Nothing was paid.']);
  assert.deepEqual(pcSays(b, { id: cb.id, stage: 'paying', price: '£23.00', courts: [3] }), { ok: true, stop: true });
  // A beat counts as a start, as any word from its tool does.
  const c = makeBot();
  const phoneC = await linkPhone(c);
  const cc = await collected(c, phoneC);
  c.clock.t += 60000;
  pcSays(c, { id: cc.id, stage: 'starting', beat: true });
  c.clock.t += 60000;
  await c.app.tick();
  assert.equal(stateOf(c, phoneC).glasgow.book.live, true);
  assert.deepEqual([GB.COLLECT_MS, GB.START_MS, GB.SILENT_MS, GB.LOST_MS, GB.MAX_RUN_MS].map(ms => ms / 1000), [25, 90, 75, 240, 1800]);
});

// ---------- kept across a restart of the bot ----------

test('whether your PC\'s booker takes Book now is kept on disk: a restarted bot shows Book at once, takes none until the PC has said its cap again, and an older booker\'s ping clears it', async () => {
  const store = memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6] });
  const t = makeBot(NOON, { store });
  await pcPing(t);
  assert.equal(store.load().pcBooks, true);
  assert.match(t.logs.join('\n'), /Your PC says its booker books and pays at Glasgow Club now \(Book now\)\./);
  // The bot restarts. The PC was heard 30 seconds ago, and its card is known from before.
  const u = makeBot(`${TUE}T12:00:30Z`, { store });
  const phone = await linkPhone(u);
  assert.deepEqual(stateOf(u, phone).glasgow, { linked: true, pcBooks: true, bookNo: 'Your PC hasn’t said yet whether it can pay. Try again in a minute.', payMax: null, book: null });
  await seeFree(u, phone);
  assert.deepEqual(await ask(u, phone, 'glasgow/book', BODY), refused(409, 'Your PC hasn’t said yet whether it can pay. Try again in a minute.'));
  await pcPing(u);
  assert.deepEqual([stateOf(u, phone).glasgow.bookNo, stateOf(u, phone).glasgow.payMax], [null, '£30.00']);
  // A PC rolled back to an older booker: its next ping says nothing of Book now. Hold again, and saved so.
  await pcPing(u, { book: null });
  assert.deepEqual([stateOf(u, phone).glasgow.pcBooks, stateOf(u, phone).glasgow.bookNo, store.load().pcBooks], [false, 'Update the booker on your PC.', false]);
  assert.match(u.logs.join('\n'), /Your PC no longer says its booker books at Glasgow Club now: the app holds there instead\./);
  // A follower is in memory only: after a restart, your PC's steps for it are told to stop (above: unknown).
});

// ---------- while it runs ----------

test('while it runs: no card, forget or Pay Automatically on (off is always taken), no sleep, no hold (Telegram\'s Hold tap says why, with no hold to show), no park\'s Book now; all back once it is over', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const { id } = await started(t, phone);
  const paying = 'Your PC is paying for a court just now. Try again once that is over.';
  assert.deepEqual(await ask(t, phone, 'card', { sealed: sealedOf() }), refused(409, paying));
  assert.deepEqual(await ask(t, phone, 'card/forget'), refused(409, paying));
  assert.deepEqual(await ask(t, phone, 'card/auto', { sealed: sealedOf() }), refused(409, paying));
  assert.deepEqual(await ask(t, phone, 'pc/sleep'), refused(409, 'Your PC is booking a court. Wait for it to finish.'));
  await t.app.handleUpdate(say(OWNER, '/sleep'));
  assert.equal(t.tg.last().text, 'Your PC is booking a court. Wait for it to finish.');
  let s = stateOf(t, phone);
  assert.deepEqual([s.indoor.holdNo, s.clubspark.bookNo, s.clubspark.lookNo, s.glasgow.bookNo, s.pc.canSleep],
    ['Your PC is booking a court at Glasgow Club. Hold one when it’s done.', 'Your PC is already booking a court.', null, 'Your PC is already booking a court.', false]);
  assert.deepEqual(await ask(t, phone, 'glasgow/book', BODY), refused(409, 'Your PC is already booking a court.'));
  assert.deepEqual(await ask(t, phone, 'hold', { centre: 'g', date: FRI, start: 1080, court: 4 }), refused(409, 'Your PC is booking a court at Glasgow Club. Hold one when it’s done.'));
  // Telegram's Hold button, with no hold ever started on this bot: said, and nothing breaks.
  await tap(t.app, 'gh:g:20261120:1800:4', 7);
  assert.equal(lastAnswer(t), 'Your PC is booking a court.');
  assert.equal(t.tg.last().text.split('\n')[1], 'Your PC is booking a court at Glasgow Club. Hold one when it’s done.');
  assert.equal(stateOf(t, phone).hold, null);
  assert.ok(!t.logs.some(l => /button failed/i.test(l)));
  // Pay Automatically off: never refused.
  assert.equal((await ask(t, phone, 'card/auto/off')).status, 200);
  // Over: everything is back.
  await t.app.resultFromAgent(notPaidOf('Court 3 was no longer free at 18:00, and your PC takes no other court'));
  await settle();
  const ping = await pcPing(t);
  assert.deepEqual(Object.keys(ping), ['ok', 'autoOff']);
  await pcPing(t, { card: { auto: false, autoDone: { id: ping.autoOff.id, ok: true } } });
  s = stateOf(t, phone);
  assert.deepEqual([s.indoor.holdNo, s.clubspark.bookNo, s.pc.canSleep, s.glasgow.book.live], [null, null, true, false]);
  assert.equal((await ask(t, phone, 'card', { sealed: sealedOf() })).status, 200);
  assert.ok(id);
});

test('six sign-ins to Glasgow Club an hour, holds and Book now together: three holds and three bookings, and the seventh of either is refused until the first leaves the hour', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  for (let i = 0; i < 3; i++) {
    await pcPing(t);
    const ping = pcPing(t, { wait: 5 });
    await tap(t.app, 'gh:g:20261120:1800:3', 7);
    const order = await ping;
    t.app.holdFromAgent({ id: order.hold.id, stage: 'failed', why: 'court 3 is not free at 18:00 any more' });
    t.clock.t += MIN;
  }
  for (let i = 0; i < 3; i++) {
    const { id } = await collected(t, phone);
    pcSays(t, { id, stage: 'refused', why: 'the nightly booking starts soon' });
    t.clock.t += MIN;
  }
  await pcPing(t);
  await seeFree(t, phone);
  const full = 'That’s 6 sign-ins to Glasgow Club in an hour. Next at 13:00.';
  assert.equal(stateOf(t, phone).glasgow.bookNo, full);
  assert.deepEqual(await ask(t, phone, 'glasgow/book', BODY), refused(409, full));
  await tap(t.app, 'gh:g:20261120:1800:3', 7);
  assert.equal(lastAnswer(t), 'Too many holds this hour.');
  // From 13:00 the first has left the hour: one more.
  t.clock.t = at(`${TUE}T13:00:00Z`);
  assert.equal((await collected(t, phone)).asked.status, 200);
});
