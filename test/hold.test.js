'use strict';
// "Hold" under a free indoor court: your PC signs in to Glasgow Club and puts the court in your
// basket. The bot's side of it: the request on the PC's ping, the card as the PC's tool reports
// each step, and your taps (Let it go, I have paid) on their way back to the PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const UI = require('../lib/ui');
const G = require('../lib/glasgowclub');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const FRI = '2026-11-20';
const HOLD = 'gh:g:20261120:1800:3';
const TITLE = '<b>Gorbals · Fri 20 Nov · 18:00–19:00 · Court 3</b>';
const LAPSES = 'An unpaid court lapses by itself.';
const LOOK_UNDER = 'Look under Bookings on Glasgow Club\'s site.';

function makeApp(t0, { pcHoldMs = 60, env = {}, glasgow = null, store = memStore({ owner: OWNER, order: [3, 4, 5, 2, 1, 6] }) } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const logs = [], pushes = [];
  const reader = glasgow || { asked: 0, day: async () => { reader.asked++; return { at: clock.t, slots: [], listed: 1 }; }, peek: () => null, health: () => null };
  const app = createApp({ now: () => clock.t, tg, store, pictures: PICTURES, linked: true, glasgow: typeof reader === 'function' ? reader(clock) : reader, log: l => logs.push(l), env, pcHoldMs, retryMs: 30,
    push: async (tokens, message) => { pushes.push(message); } });
  return { app, tg, clock, logs, pushes, glasgow: reader };
}
// A phone linked to the app, which gave a push token: what the app sees, and what is pushed to it.
async function linkPhone(t) {
  await t.app.handleUpdate(say(OWNER, '/app'));
  const code = /Code: <code>(\d{6})<\/code>/.exec(t.tg.last().text)[1];
  const r = t.app.appPair({ code, name: 'iPhone' });
  assert.equal(r.status, 200);
  const device = t.app.appAuth(r.body.token);
  assert.equal((await t.app.appAsk(device, 'push', { token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })).status, 200);
  return device;
}
let tapId = 1;
const tap = (app, data, messageId, { chat = OWNER } = {}) => app.handleUpdate({
  update_id: 1, callback_query: { id: String(tapId++), data, from: { id: chat }, message: { message_id: messageId, chat: { id: chat, type: 'private' } } },
});
const buttons = call => call.extra.reply_markup.inline_keyboard.flat();
const texts = call => buttons(call).map(b => b.text);
const rest = call => call.text.split('\n').slice(1);
const lastAnswer = t => t.tg.answers[t.tg.answers.length - 1];
// The card is redrawn without the PC's note waiting for Telegram: let that happen.
const settle = () => new Promise(r => setTimeout(r, 5));
// The PC in touch, a hold tapped on card 7, and the PC's waiting ping collecting it.
async function started(t0 = `${TUE}T12:00:00Z`, opts = {}) {
  const t = makeApp(t0, opts);
  await t.app.pingFromAgent({ ip: '81.2.69.142' });
  const ping = t.app.pingFromAgent({ ip: '81.2.69.142' }, { wait: 5 });
  await tap(t.app, HOLD, 7);
  const order = await ping;
  await settle();
  return { ...t, order, id: order.hold && order.hold.id };
}
const note = (t, stage, extra = {}) => t.app.holdFromAgent({ id: t.id, key: 'g', date: FRI, start: 1080, court: 3, stage, ...extra });
const held = t => note(t, 'held', { price: '£23.00', left: 12 * 60000 });

// ---------- the screens ----------

const ctxAt = time => ({ cfg: { plan: {}, once: [], order: [3, 4, 5, 2, 1, 6], releaseMin: 1320, daysAhead: 7 }, now: at(time), paused: false, results: {}, lastSeen: null, linked: true, pc: 'awake', wake: 'ready' });
const holdAt = (over = {}) => ({ id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, taken: true, stage: 'held', end: null, order: null, price: '£23.00',
  heldAt: at(`${TUE}T12:01:00Z`), until: at(`${TUE}T12:13:00Z`), why: '', basket: '', removed: null, words: '', checked: false, silent: false, ...over });
// Telegram counts a caption's 1024 characters after it has read the tags and entities.
const seen = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const fits = scr => {
  assert.ok(seen(scr.caption).length <= 1024, `caption is ${seen(scr.caption).length} long`);
  for (const b of scr.keyboard.inline_keyboard.flat()) if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
};
const keysOf = scr => scr.keyboard.inline_keyboard.flat().map(b => b.text);
const wordsOf = scr => scr.caption.split('\n').slice(1).join('\n');

test('the card of a court in your basket: what to pay, where the payment page is, and the two buttons', () => {
  const s = UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt());
  // Signing in to Glasgow Club on a phone does not show the basket your PC filled (tried by
  // the owner): nothing says to pay on the phone, and there is no "Open my basket" any more.
  assert.equal(s.caption, [
    TITLE,
    '<b>£23.00 to pay.</b> In your basket since 12:01.',
    'Pay in Chrome on your PC and tap <b>I have paid</b>.',
    'Let go at 12:13 if unpaid.',
  ].join('\n'));
  // No Menu while it is going: the card stays the hold's card, with the buttons that matter.
  assert.deepEqual(s.keyboard.inline_keyboard.flat().map(b => [b.text, b.callback_data || b.url]), [
    ['I have paid', 'gp:a1b2c3d4e5f6'], ['Let it go', 'gx:a1b2c3d4e5f6'],
  ]);
  fits(s);
  // Once you have tapped one, the buttons go and the card says what is happening.
  const going = UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt({ order: 'release' }));
  assert.deepEqual([going.caption.split('\n')[2], keysOf(going)], ['Letting it go…', []]);
  assert.equal(UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt({ order: 'done' })).caption.split('\n')[2], 'Looking for it on your Bookings page…');
  // A price that did not come through is simply left out.
  assert.match(UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt({ price: '' })).caption, /\nIn your basket since \d\d:\d\d\./);
  // Before the basket: one button, Stop.
  for (const over of [{ taken: false, stage: 'asked' }, { stage: 'asked' }, { stage: 'signing-in' }, { stage: 'adding' }]) assert.deepEqual(keysOf(UI.indoorHold(ctxAt(`${TUE}T12:00:10Z`), holdAt(over))), ['Stop']);
});

test('every way a hold can end says what is known and no more, and none is too long for a card', () => {
  const ctx = ctxAt(`${TUE}T12:20:00Z`);
  const end = over => { const s = UI.indoorHold(ctx, holdAt(over)); fits(s); return s; };
  // Let go, or out of time.
  assert.equal(wordsOf(end({ end: 'released', why: 'release', basket: 'empty', removed: 1 })), 'Let go. Not paid.');
  assert.equal(wordsOf(end({ end: 'released', why: 'time', basket: 'empty', removed: 1 })), 'Not paid in time. Let go.');
  assert.deepEqual(keysOf(end({ end: 'released', why: 'time', basket: 'empty', removed: 1 })), ['Other times', 'Menu']);
  assert.equal(wordsOf(end({ end: 'released', why: 'release', basket: 'untouched' })), 'Stopped. Nothing was in your basket.');
  // The court had left the basket by itself: "nothing was paid" is not claimed.
  assert.equal(wordsOf(end({ end: 'released', why: 'time', basket: 'gone', removed: 0 })),
    `Time was up, but the court had already left your basket: paid for, or let go by the site. Nothing was taken out.\n${LOOK_UNDER}`);
  assert.match(wordsOf(end({ end: 'released', why: 'release', basket: 'gone', removed: 0 })), /^You asked to let it go, but the court had already left your basket/);
  assert.deepEqual(keysOf(end({ end: 'released', why: 'release', basket: 'gone', removed: 0 })), ['Open Glasgow Club', 'Other times', 'Menu']);
  // It could not be seen to have come out: an empty basket is not claimed either.
  for (const over of [{ basket: 'unclear', removed: 1 }, { basket: 'items', removed: 1 }, { basket: 'empty', removed: 0 }, { basket: '', removed: null }]) {
    assert.match(wordsOf(end({ end: 'released', why: 'release', ...over })), /^Your PC went to take it out of your basket, but couldn’t see the basket empty\. An unpaid court lapses by itself\.$/);
  }
  // Booked: only ever said on the PC's word that it is on the Bookings page now and was not before.
  assert.equal(wordsOf(end({ end: 'booked', words: 'Thank you. Reference ########' })), '<b>Booked.</b> Now on your Glasgow Club Bookings page.\nThe page said: “Thank you. Reference ########”');
  assert.deepEqual(keysOf(end({ end: 'booked' })), ['Open Glasgow Club', 'Menu']);
  // The page moved on, or you said you paid, and it is not seen as booked.
  assert.equal(wordsOf(end({ end: 'left', words: 'Payment declined', checked: true, basket: 'still' })), [
    'The payment page on your PC moved on, but I could not see the court as a new booking on your Bookings page.',
    'The page said: “Payment declined”',
    `It is still in the basket on your PC, so it does not look paid for. I left it there; unpaid, it lapses by itself. I have closed Chrome on your PC. ${LOOK_UNDER}`,
  ].join('\n'));
  assert.equal(wordsOf(end({ end: 'unsure', checked: false, basket: 'gone' })), [
    'You said you have paid, but I could not see the court as a new booking on your Bookings page (I could not read it).',
    `It is no longer in the basket, so the site either took the payment or let the court go. I have closed Chrome on your PC. ${LOOK_UNDER}`,
  ].join('\n'));
  assert.match(wordsOf(end({ end: 'unsure', checked: true, basket: 'unclear' })), /\nI could not read the basket either\. I have closed Chrome on your PC\./);
  assert.deepEqual(keysOf(end({ end: 'unsure', checked: true, basket: 'still' })), ['Open Glasgow Club', 'Other times', 'Menu']);
  // It failed before the basket, or with something left in it.
  assert.equal(wordsOf(end({ end: 'failed', stage: 'adding', why: 'court 3 is not free at 18:00 any more' })), 'It didn’t work: court 3 is not free at 18:00 any more.\nNothing was booked or paid.');
  assert.equal(wordsOf(end({ end: 'failed', stage: 'adding', why: 'the site could not price your basket', basket: 'empty' })), 'It didn’t work: the site could not price your basket.\nNothing was booked or paid. Your basket is empty.');
  assert.equal(wordsOf(end({ end: 'failed', stage: 'adding', why: 'x', basket: 'items' })), 'It didn’t work: x.\nNothing was booked or paid. Something is still in your basket; unpaid, it lapses by itself.');
  assert.deepEqual(keysOf(end({ end: 'failed', stage: 'adding', why: 'x' })), ['Open the sheet', 'Other times', 'Menu']);
  // It failed once the payment page was yours: "nothing was paid" is not claimed.
  assert.equal(wordsOf(end({ end: 'failed', stage: 'held', why: 'a question was open on the page in Chrome, so I left it as it was' })),
    `Something went wrong after the court was in your basket: a question was open on the page in Chrome, so I left it as it was.\nI cannot say how it ended. ${LOOK_UNDER}`);
  assert.deepEqual(keysOf(end({ end: 'failed', stage: 'held', why: 'x' })), ['Open Glasgow Club', 'Other times', 'Menu']);
  // The rest.
  assert.equal(wordsOf(end({ end: 'refused', stage: 'asked', why: 'the nightly booking is running' })), 'Your PC didn’t start on it: the nightly booking is running.\nNothing was done.');
  assert.equal(wordsOf(end({ end: 'closed' })), `Chrome was closed on your PC, so how it ended isn’t known. ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'slept' })), `Your PC went to sleep while it had the court. ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'gone' })), `The tool on your PC stopped without saying how it ended. ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'gone', why: 'the booking tool was still running after twenty minutes, so it was stopped' })), `The tool on your PC stopped without saying how it ended (the booking tool was still running after twenty minutes, so it was stopped). ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'nopickup', taken: false, stage: 'asked' })), 'Your PC didn’t pick it up in time. Nothing was done.');
  assert.deepEqual(keysOf(UI.indoorHold({ ...ctx, pc: 'asleep' }, holdAt({ end: 'nopickup', taken: false, stage: 'asked' }))), ['Wake my PC', 'Open the sheet', 'Other times', 'Menu']);
  assert.equal(wordsOf(end({ end: 'nostart', stage: 'asked' })), 'Your PC never started on it. Nothing was done. Its PC link may need restarting.');
  assert.equal(wordsOf(end({ end: 'stopped', taken: false, stage: 'asked' })), 'Stopped before your PC started. Nothing was done.');
  assert.equal(wordsOf(end({ end: 'timeout' })), `No more word from your PC. ${LAPSES}`);
  // The longest it can get: a failure with 300 characters of why, all of them needing escaping.
  const long = end({ end: 'failed', stage: 'adding', why: '<'.repeat(300), basket: 'unclear' });
  assert.ok(long.caption.includes('&lt;&lt;') && !long.caption.includes('<<'));
});

// ---------- from the tap to the basket ----------

test('Hold: the PC collects it on its ping, the card follows each step, and Let it go reaches the PC', async () => {
  const t = await started();
  // The tap was answered at once, and the PC's ping came back with the one court.
  assert.deepEqual(t.tg.answers, ['Asking your PC']);
  assert.deepEqual(Object.keys(t.order).sort(), ['hold', 'ok']);
  assert.deepEqual({ ...t.order.hold, id: 'x' }, { id: 'x', key: 'g', date: FRI, start: 1080, court: 3 });
  assert.match(t.id, /^[0-9a-f]{12}$/);
  assert.equal(t.glasgow.asked, 0);                                          // a hold reads nothing itself
  // The card it was tapped on carries it from here; it is never a second card.
  assert.deepEqual(rest(t.tg.last()), ['Starting Chrome on your PC…']);
  assert.deepEqual(texts(t.tg.last()), ['Stop']);
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });               // handed over once
  for (const [stage, words] of [['signing-in', 'Signing in to Glasgow Club…'], ['signed-in', 'Signed in. Finding the court on the sheet…'], ['adding', 'Putting court 3 in your basket…']]) {
    assert.deepEqual(note(t, stage), { ok: true });
    await settle();
    assert.deepEqual(rest(t.tg.last()), [words]);
  }
  t.clock.t += 30000;
  assert.deepEqual(held(t), { ok: true });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[1], '<b>£23.00 to pay.</b> In your basket since 12:00.');
  assert.match(t.tg.last().text, /\nLet go at 12:12 if unpaid\.$/);
  assert.deepEqual(texts(t.tg.last()), ['I have paid', 'Let it go']);
  assert.ok(t.tg.calls.every(c => c.id === 7 && (c.method === 'media' || c.method === 'caption')));
  // The PC asks every few seconds whether you tapped anything: no, and the card is left alone.
  const drawn = t.tg.calls.length;
  assert.deepEqual(note(t, 'held', { beat: true, price: '£23.00', left: 700000 }), { ok: true });
  await settle();
  assert.equal(t.tg.calls.length, drawn);
  // Let it go: said on the card, and the PC hears it on its next note (and again, until it has acted).
  await tap(t.app, `gx:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'Letting it go');
  await settle();
  assert.equal(t.tg.last().text.split('\n')[2], 'Letting it go…');
  assert.deepEqual(texts(t.tg.last()), []);
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'release' });
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'release' });
  await tap(t.app, `gx:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'Already letting it go.');
  assert.deepEqual(note(t, 'released', { basket: 'empty', removed: 1, why: 'release', checked: true }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Let go. Not paid.']);
  assert.deepEqual(buttons(t.tg.last()).map(b => [b.text, b.callback_data]), [['Other times', 'gd:g:20261120'], ['Menu', 'h']]);
  // It is over: later notes change nothing (the PC link's "the tool has gone" among them), and its buttons say so.
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true });
  assert.deepEqual(note(t, 'gone'), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Let go. Not paid.']);
  await tap(t.app, `gx:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'That hold is over.');
  assert.ok(t.logs.includes('Hold asked for: Gorbals 2026-11-20 18:00 court 3.'));
  assert.ok(t.logs.includes('Hold released: Gorbals 2026-11-20 18:00 court 3 (release).'));
});

test('I have paid: the PC is told to look at your Bookings page, and the card says what it found', async () => {
  const t = await started();
  await tap(t.app, `gp:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'It is not in your basket yet.');                                  // too early
  assert.deepEqual(note(t, 'signing-in'), { ok: true });
  held(t);
  await tap(t.app, `gp:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'Checking your Bookings page');
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'done' });
  await tap(t.app, `gx:${t.id}`, 7);                                                             // one order at a time
  assert.equal(lastAnswer(t), 'Already checking.');
  assert.deepEqual(note(t, 'booked', { words: 'Thank you <Francisco>. Reference ########' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['<b>Booked.</b> Now on your Glasgow Club Bookings page.', 'The page said: “Thank you &lt;Francisco&gt;. Reference ########”']);
  assert.deepEqual(texts(t.tg.last()), ['Open Glasgow Club', 'Menu']);
});

test('you said you paid, but it is still in the basket: said as that, and what the PC reports is kept as it came', async () => {
  const t = await started();
  held(t);
  await tap(t.app, `gp:${t.id}`, 7);
  note(t, 'unsure', { words: '', checked: true, basket: 'still' });
  await settle();
  assert.deepEqual(rest(t.tg.last()), [
    'You said you have paid, but I could not see the court as a new booking on your Bookings page.',
    `It is still in the basket on your PC, so it does not look paid for. I left it there; unpaid, it lapses by itself. I have closed Chrome on your PC. ${LOOK_UNDER}`,
  ]);
});

// ---------- a hold that ends booked is a booking (2.10.3) ----------

const GORBALS_FRI = 'gorbals/2026-11-20@18:00';     // the id the midnight run gives Gorbals, Fri 20 Nov, 18:00
const keptAs = (t, id) => { const r = t.app.state.results[id]; if (!r) return r; const { at: _, ...rest } = r; return rest; };

test('a hold paid for and booked is kept as a booking, under the midnight run\'s id, with no second card, note or push', async () => {
  const t = await started();
  const phone = await linkPhone(t);
  held(t);
  note(t, 'paying', { price: '£23.00', pressed: true, left: 6 * 60000 });
  await settle();
  t.tg.clear();
  const notes = t.app.state.notes.length, pushes = t.pushes.length;
  assert.deepEqual(note(t, 'booked', { words: 'Thank you', pressed: true }), { ok: true });
  await settle();
  assert.deepEqual(keptAs(t, GORBALS_FRI), {
    id: GORBALS_FRI, status: 'booked', date: FRI, start: 1080, end: 1140, venue: 'gorbals', type: 'indoor', price: '£23.00', paid: true, court: '3',
  });
  // Said once, as before: the hold's own card, its note and that note's push. No "booked" card, no second note.
  assert.deepEqual(t.tg.calls.map(c => [c.method, c.id]), [['caption', 7]]);
  assert.equal(t.app.state.notes.length, notes + 1);
  assert.equal(t.app.state.notes[0].title, 'Booked · Gorbals court 3');
  assert.equal(t.pushes.length, pushes + 1);
  // The app's results show it as any other booking at Glasgow Club.
  const shown = t.app.appState(phone).state.results.find(r => r.id === GORBALS_FRI);
  assert.deepEqual({ ...shown, at: 0 }, {
    id: GORBALS_FRI, venue: 'gorbals', status: 'booked', date: FRI, start: 1080, end: 1140, court: '3', gate: null, why: null, at: 0, past: false,
    type: 'indoor', price: '£23.00', paid: true,
  });
  // Glasgow Club's courts are not part of the parks' weekly allowance.
  assert.deepEqual(t.app.appState(phone).state.allowance.map(w => w.sessions), [0, 0]);
  assert.ok(t.logs.includes(`Kept as a booking: ${GORBALS_FRI} booked (Court 3)`));
});

test('a court paid for at the PC (I have paid) and found booked is kept as a booking too: Scotstoun outdoor, Wed 25 Nov, 18:00, court 1, £6.00', async () => {
  const t = makeApp('2026-11-20T12:00:00Z');
  await t.app.pingFromAgent({ ip: '81.2.69.142' });
  const ping = t.app.pingFromAgent({ ip: '81.2.69.142' }, { wait: 5 });
  await tap(t.app, 'gh:o:20261125:1800:1', 7);
  const id = (await ping).hold.id;
  const pc = (stage, extra = {}) => t.app.holdFromAgent({ id, key: 'o', date: '2026-11-25', start: 1080, court: 1, stage, ...extra });
  pc('held', { price: '£6.00', left: 12 * 60000 });
  await tap(t.app, `gp:${id}`, 7);
  assert.deepEqual(pc('held', { beat: true }), { ok: true, order: 'done' });
  pc('booked', { words: '' });
  await settle();
  assert.deepEqual(keptAs(t, 'scotstoun/2026-11-25@18:00'), {
    id: 'scotstoun/2026-11-25@18:00', status: 'booked', date: '2026-11-25', start: 1080, end: 1140, venue: 'scotstoun', type: 'outdoor', price: '£6.00', paid: true, court: '1',
  });
});

test('a booked hold stops the same slot being booked again, and a later result for its id does not count it twice', async () => {
  // A one-off for Gorbals, Fri 20 Nov, 18:00, added after that day opened: the next run would book it.
  const store = memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], onceAway: [{ date: FRI, start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', at: at(`${TUE}T09:00:00Z`) }] });
  const t = await started(`${TUE}T12:00:00Z`, { store });
  assert.deepEqual(t.app.jobsForAgent({}, { run: false, venues: true }).jobs.map(j => j.id), [GORBALS_FRI]);
  held(t);
  note(t, 'booked', { words: '', pressed: true });
  await settle();
  assert.deepEqual(t.app.jobsForAgent({}, { run: false, venues: true }).jobs, []);
  // The PC's run says the same booking again: no card, and one booking. Its "nothing free" leaves the booking standing.
  t.tg.clear();
  const notes = t.app.state.notes.length;
  await t.app.resultFromAgent({ id: GORBALS_FRI, status: 'booked', court: '3', type: 'indoor', price: '£23.00', paid: true });
  await t.app.resultFromAgent({ id: GORBALS_FRI, status: 'none', type: 'indoor', why: 'No court free for the whole time.' });
  assert.deepEqual([t.tg.calls.length, t.app.state.notes.length], [0, notes]);
  assert.equal(Object.keys(t.app.state.results).filter(k => k === GORBALS_FRI).length, 1);
  assert.deepEqual([keptAs(t, GORBALS_FRI).status, keptAs(t, GORBALS_FRI).court], ['booked', '3']);
});

test('a booked hold takes the place of the run\'s "not booked" for that slot, and never of a booking kept there already', async () => {
  const t = await started(`${TUE}T12:00:00Z`, { store: memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], results: {
    [GORBALS_FRI]: { id: GORBALS_FRI, status: 'none', type: 'indoor', why: 'No court free for the whole time.', at: at(`${TUE}T00:05:00Z`) } } }) });
  held(t);
  note(t, 'booked', { words: '', pressed: true });
  await settle();
  assert.deepEqual([keptAs(t, GORBALS_FRI).status, keptAs(t, GORBALS_FRI).court, keptAs(t, GORBALS_FRI).paid], ['booked', '3', true]);
  const u = await started(`${TUE}T12:00:00Z`, { store: memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], results: {
    [GORBALS_FRI]: { id: GORBALS_FRI, status: 'booked', type: 'indoor', court: '5', price: '£23.00', paid: true, at: at(`${TUE}T00:05:00Z`) } } }) });
  held(u);
  note(u, 'booked', { words: '', pressed: true });
  await settle();
  assert.equal(keptAs(u, GORBALS_FRI).court, '5');
});

test('a hold that ends any other way keeps no result', async () => {
  for (const [stage, extra] of [['released', { why: 'release', basket: 'empty', removed: 1 }], ['released', { why: 'time', basket: 'gone', removed: 0 }], ['left', { words: 'Payment declined', checked: true, basket: 'still' }],
    ['unsure', { checked: false, basket: 'gone' }], ['failed', { why: 'x' }], ['refused', { why: 'busy' }], ['closed', {}], ['slept', {}], ['gone', { pressed: 'maybe' }]]) {
    const t = await started();
    held(t);
    note(t, stage, extra);
    await settle();
    assert.deepEqual(t.app.state.results, {}, stage);
  }
  // Nor one that was never heard of again.
  const t = await started();
  held(t);
  t.clock.t = at(`${TUE}T12:19:00Z`);
  await t.app.tick();
  assert.deepEqual(t.app.state.results, {});
});

test('a hold this bot is not following (it restarted) that ends booked is kept as a booking, whether or not Pay was pressed', async () => {
  const fresh = makeApp(`${TUE}T12:05:00Z`);
  assert.deepEqual(fresh.app.holdFromAgent({ id: 'a1b2c3d4e5f6', key: 's', date: FRI, start: 1140, court: 2, stage: 'booked', words: '', price: '£23.00', pressed: true }), { ok: true, unknown: true });
  // Paid for at the PC: nothing is said of it, but the booking is kept (its price, if the note does not carry one, is not known).
  fresh.app.holdFromAgent({ id: 'b1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'booked', words: '' });
  await settle();
  assert.deepEqual(keptAs(fresh, 'scotstoun/2026-11-20@19:00'), {
    id: 'scotstoun/2026-11-20@19:00', status: 'booked', date: FRI, start: 1140, end: 1200, venue: 'scotstoun', type: 'indoor', price: '£23.00', paid: true, court: '2',
  });
  assert.deepEqual([keptAs(fresh, GORBALS_FRI).price, keptAs(fresh, GORBALS_FRI).paid, keptAs(fresh, GORBALS_FRI).court], [null, true, '3']);
  assert.equal(fresh.app.state.notes.filter(n => /^Booked/.test(n.title)).length, 1);           // the pressed one, as before
  // A note that does not say which court it was keeps nothing.
  fresh.app.holdFromAgent({ id: 'c1b2c3d4e5f6', stage: 'booked', words: '' });
  assert.equal(Object.keys(fresh.app.state.results).length, 2);
});

test('the steps only go forwards, and a price that does not read as one is left out', async () => {
  const t = await started();
  note(t, 'held', { price: '<b>free</b>', left: -5 });
  await settle();
  assert.match(t.tg.last().text, /\nIn your basket since \d\d:\d\d\./);
  assert.match(t.tg.last().text, /\nLet go at 12:12 if unpaid\.$/);                    // twelve minutes when it does not say
  const drawn = t.tg.calls.length;
  assert.deepEqual(note(t, 'signing-in'), { ok: true });                                        // a note that arrives late
  assert.deepEqual(note(t, 'dancing'), { ok: true });                                           // a step it does not know
  await settle();
  assert.equal(t.tg.calls.length, drawn);
});

test('a hold that fails says why, with the PC\'s own words made safe for the card', async () => {
  const t = await started();
  note(t, 'signing-in');
  assert.deepEqual(note(t, 'failed', { why: 'the sign-in to Glasgow Club did not go through <b>x</b>.  ', basket: 'nonsense' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['It didn’t work: the sign-in to Glasgow Club did not go through &lt;b&gt;x&lt;/b&gt;.', 'Nothing was booked or paid.']);
  assert.deepEqual(texts(t.tg.last()), ['Open the sheet', 'Other times', 'Menu']);
  // Another can be started straight away.
  const ping = t.app.pingFromAgent({}, { wait: 5 });
  await tap(t.app, 'gh:s:20261121:0900:1', 7);
  assert.deepEqual({ ...(await ping).hold, id: 'x' }, { id: 'x', key: 's', date: '2026-11-21', start: 540, court: 1 });
});

test('a failure after the payment page was yours never says "nothing was paid"', async () => {
  const t = await started();
  held(t);
  note(t, 'failed', { why: 'it stopped: a question was open on the page in Chrome, so I left it as it was' });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Something went wrong after the court was in your basket: it stopped: a question was open on the page in Chrome, so I left it as it was.', `I cannot say how it ended. ${LOOK_UNDER}`]);
});

test('the PC would not start on it: said with its reason', async () => {
  const t = await started();
  assert.deepEqual(note(t, 'refused', { why: 'the nightly booking is running' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Your PC didn’t start on it: the nightly booking is running.', 'Nothing was done.']);
});

// ---------- when it does not go to plan ----------

test('no ping collects it in time: the card says so, nothing is handed over later, and a PC that has it after all is told to let go', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { pcHoldMs: 25000, env: { WAKE_MAC: 'AA:BB:CC:DD:EE:FF' } });
  await t.app.pingFromAgent({ ip: '81.2.69.142' });
  await tap(t.app, HOLD, 7);
  assert.deepEqual(rest(t.tg.last()), ['Asking your PC to hold it. Under a minute.']);
  assert.deepEqual(texts(t.tg.last()), ['Stop']);
  t.clock.t += 24000;
  await t.app.tick();
  assert.equal(rest(t.tg.last())[0].slice(0, 15), 'Asking your PC ');
  t.clock.t += 1000;
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Your PC didn’t pick it up in time. Nothing was done.']);
  assert.deepEqual(texts(t.tg.last()), ['Open the sheet', 'Other times', 'Menu']);                // it is still "awake" by its last ping
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });
  const id = buttons(t.tg.calls[0]).find(b => b.text === 'Stop').callback_data.slice(3);
  assert.deepEqual(t.app.holdFromAgent({ id, stage: 'signing-in' }), { ok: true, order: 'release' });
  assert.deepEqual(t.app.holdFromAgent({ id, stage: 'held', beat: true }), { ok: true, order: 'release' });
  assert.deepEqual(t.app.holdFromAgent({ id, stage: 'released', basket: 'untouched' }), { ok: true });   // it has let go: nothing more to ask of it
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Your PC didn’t pick it up in time. Nothing was done.']);
  assert.ok(t.logs.includes('Your PC did not collect the court to hold in time.'));
});

test('the PC collects it and then says nothing at all (an older PC link, or a tool that would not start): over after a minute and a half', async () => {
  const t = await started();
  t.clock.t += 89000;
  await t.app.pingFromAgent();                                                                   // its pings go on; the hold is another matter
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Starting Chrome on your PC…']);
  t.clock.t += 1000;
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Your PC never started on it. Nothing was done. Its PC link may need restarting.']);
  assert.deepEqual(texts(t.tg.last()), ['Open the sheet', 'Other times', 'Menu']);
  // If the tool does start after that, it is told to stop; and its own word on how it ended is taken.
  assert.deepEqual(note(t, 'signing-in'), { ok: true, order: 'release' });
  assert.deepEqual(note(t, 'released', { basket: 'untouched', why: 'release' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Stopped. Nothing was in your basket.']);
});

test('the tool on the PC dies without a word: the PC link says it has gone, and the card says that', async () => {
  const t = await started();
  note(t, 'signing-in');
  assert.deepEqual(note(t, 'gone'), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), [`The tool on your PC stopped without saying how it ended. ${LAPSES}`]);
  assert.deepEqual(texts(t.tg.last()), ['Other times', 'Menu']);
  // And another hold can start.
  const ping = t.app.pingFromAgent({}, { wait: 5 });
  await tap(t.app, HOLD, 7);
  assert.equal((await ping).hold.court, 3);
});

test('Stop before the PC has collected it: nothing is handed over at all', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { pcHoldMs: 25000 });
  await t.app.pingFromAgent();
  await tap(t.app, HOLD, 7);
  const id = buttons(t.tg.last()).find(b => b.text === 'Stop').callback_data.slice(3);
  await tap(t.app, `gx:${id}`, 7);
  assert.equal(lastAnswer(t), 'Stopped');
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Stopped before your PC started. Nothing was done.']);
  assert.deepEqual(await t.app.pingFromAgent({}, { wait: 0.02 }), { ok: true });
});

test('Stop while the PC is signing in: it hears it on its next step', async () => {
  const t = await started();
  note(t, 'signing-in');
  await tap(t.app, `gx:${t.id}`, 7);
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Signing in to Glasgow Club…', 'Stopping…']);
  assert.deepEqual(texts(t.tg.last()), []);
  assert.deepEqual(note(t, 'signed-in'), { ok: true, order: 'release' });
  note(t, 'released', { basket: 'untouched', why: 'release' });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Stopped. Nothing was in your basket.']);
});

test('the PC goes silent: the card says so after a minute or so, and takes it back when it is heard again', async () => {
  const t = await started();
  held(t);
  await settle();
  t.clock.t += 74000;
  await t.app.tick();
  assert.ok(!t.tg.last().text.includes('No word from your PC'));
  t.clock.t += 1000;
  await t.app.tick();
  assert.match(t.tg.last().text, /\nNo word from your PC for over a minute\.$/);
  assert.deepEqual(texts(t.tg.last()), ['I have paid', 'Let it go']);
  const drawn = t.tg.calls.length;
  await t.app.tick();
  assert.equal(t.tg.calls.length, drawn);                                                      // said once
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true });
  await settle();
  assert.ok(!t.tg.last().text.includes('No word from your PC'));
});

test('a hold is over seven minutes after its time was up, heard from or not; then the PC\'s own word on how it ended is still taken', async () => {
  const t = await started();
  held(t);                                                                                       // until 12:12
  for (let i = 0; i < 18 * 60 / 4; i++) { t.clock.t += 4000; note(t, 'held', { beat: true }); }  // beats every four seconds until 12:18
  await t.app.tick();
  assert.equal(t.tg.last().text.split('\n')[1].slice(0, 22), '<b>£23.00 to pay.</b> ');
  t.clock.t = at(`${TUE}T12:19:00Z`);
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), [`No more word from your PC. ${LAPSES}`]);
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'release' });             // a PC that still has it is told to let go
  assert.deepEqual(note(t, 'booked', { words: '' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['<b>Booked.</b> Now on your Glasgow Club Bookings page.']);
  // A hold that never reaches the basket is over eight minutes after the tap.
  const s = await started();
  note(s, 'signing-in');
  for (let i = 0; i < 7; i++) { s.clock.t += 60000; note(s, 'signing-in'); await s.app.tick(); }
  assert.deepEqual(rest(s.tg.last()), ['Signing in to Glasgow Club…']);
  s.clock.t += 60000;
  await s.app.tick();
  assert.match(rest(s.tg.last())[0], /^No more word from your PC\./);
});

test('a card Telegram would not redraw is tried again by the timer, so the last word always gets there', async () => {
  const t = await started();
  held(t);
  await settle();
  t.tg.failEdit = { code: 429, message: 'Too Many Requests', once: true };
  note(t, 'released', { basket: 'empty', removed: 1, why: 'time', checked: true });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[1].slice(0, 22), '<b>£23.00 to pay.</b> ');         // the ending did not get on to the card
  assert.ok(t.logs.some(l => /Could not update the hold's card: Too Many Requests/.test(l)));
  t.clock.t += 4000;
  await t.app.tick();
  assert.equal(t.tg.last().text.split('\n')[1].slice(0, 22), '<b>£23.00 to pay.</b> ');         // not yet: five seconds
  t.clock.t += 1000;
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Not paid in time. Let go.']);
  const drawn = t.tg.calls.length;
  t.clock.t += 10000;
  await t.app.tick();
  assert.equal(t.tg.calls.length, drawn);                                                      // and then left alone
});

test('notes about a hold this bot does not know are left alone: no order goes back', async () => {
  const t = await started();
  assert.deepEqual(t.app.holdFromAgent({ id: 'ffffffffffff', stage: 'held', beat: true }), { ok: true, unknown: true });
  for (const junk of [null, 'held', 7, {}, { id: 12, stage: 'held' }, { stage: 'released' }]) assert.deepEqual(t.app.holdFromAgent(junk), { ok: true, unknown: true });
  const fresh = makeApp(`${TUE}T12:00:00Z`);                                                     // a bot that has just restarted
  assert.deepEqual(fresh.app.holdFromAgent({ id: 'a1b2c3d4e5f6', stage: 'held', beat: true }), { ok: true, unknown: true });
  // Its buttons, on a card from before the restart, say what is so.
  await tap(fresh.app, 'gx:a1b2c3d4e5f6', 7);
  assert.equal(lastAnswer(fresh), 'No longer following that hold. Your PC lets it go when its time is up.');
});

// ---------- what stands in the way of a hold ----------

test('one court at a time: a tap while one is held brings its card to where you are', async () => {
  const t = await started();
  held(t);
  await settle();
  t.tg.clear();
  await tap(t.app, 'gh:g:20261120:1900:3', 8);
  assert.equal(lastAnswer(t), 'Your PC is already holding a court.');
  await settle();
  // Card 8 is now the hold's card, with its buttons; later news goes there.
  assert.deepEqual(t.tg.calls.map(c => c.id), [8]);
  assert.deepEqual(texts(t.tg.last()), ['I have paid', 'Let it go']);
  note(t, 'released', { basket: 'empty', removed: 1, why: 'time', checked: true });
  await settle();
  assert.equal(t.tg.last().id, 8);
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });                                   // no second hold was handed over
});

test('after four silent minutes another may start; the first is then over, and a PC that still has it is told to let go', async () => {
  const t = await started();
  note(t, 'signing-in');
  await settle();
  t.clock.t += 4 * 60000;
  await t.app.pingFromAgent();
  const ping = t.app.pingFromAgent({}, { wait: 5 });
  await tap(t.app, 'gh:g:20261120:1900:3', 8);
  const second = (await ping).hold;
  assert.equal(second.start, 1140);
  await settle();
  const first = t.tg.calls.filter(c => c.id === 7).pop();
  assert.match(first.text.split('\n')[1], /^No more word from your PC\./);  // its card says it is over
  assert.deepEqual(texts(first), ['Other times', 'Menu']);
  assert.deepEqual(note(t, 'signed-in'), { ok: true, order: 'release' });                        // the old tool, if it is still there
  assert.deepEqual(t.app.holdFromAgent({ id: second.id, stage: 'signing-in' }), { ok: true });
  // Paid for at the PC all the same: kept as a booking.
  note(t, 'booked', { words: '', price: '£23.00' });
  await settle();
  assert.deepEqual([keptAs(t, GORBALS_FRI).status, keptAs(t, GORBALS_FRI).court, keptAs(t, GORBALS_FRI).price], ['booked', '3', '£23.00']);
});

test('with the PC asleep there is nobody to hold it: the card says so and offers to wake it', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { env: { WAKE_MAC: 'AA:BB:CC:DD:EE:FF' } });
  await t.app.pingFromAgent({ ip: '81.2.69.142' });
  t.clock.t += 10 * 60000;                                                                      // no ping for ten minutes
  await tap(t.app, HOLD, 7);
  assert.deepEqual(t.tg.answers, ['Your PC isn’t awake.']);
  assert.deepEqual(t.tg.last().text.split('\n'), [TITLE, 'Your PC isn’t awake. Wake it and try again.']);
  assert.deepEqual(buttons(t.tg.last()).map(b => [b.text, b.callback_data || b.url]), [
    ['Wake my PC', 'wk'], ['Try again', 'gt:g:20261120:1800'], ['Open the sheet', 'https://glasgowclub.gladstonego.cloud/book/calendar/S0815?activityDate=2026-11-20T00:00:00.000Z'],
    ['Other times', 'gd:g:20261120'], ['Menu', 'h'],
  ]);
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });                                  // and nothing waits for the PC
});

test('around the nightly booking run no hold is started: from 21:25 to 22:15, every night', async () => {
  for (const [time, goes] of [['21:24:59', true], ['21:25:00', false], ['21:58:00', false], ['22:15:00', false], ['22:15:01', true]]) {
    const t = makeApp(`${TUE}T${time}Z`);
    await t.app.pingFromAgent();
    await tap(t.app, HOLD, 7);
    assert.equal(t.tg.answers[0], goes ? 'Asking your PC' : 'Not around the nightly booking.', time);
    if (!goes) assert.equal(t.tg.last().text.split('\n')[1], 'Not available 21:25–22:15, around the nightly booking. The sheet still opens.');
  }
});

test('at most six holds are started in an hour', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`);
  for (let i = 0; i < 6; i++) {
    await t.app.pingFromAgent();
    const ping = t.app.pingFromAgent({}, { wait: 5 });
    await tap(t.app, HOLD, 7);
    const order = await ping;
    t.app.holdFromAgent({ id: order.hold.id, stage: 'failed', why: 'court 3 is not free at 18:00 any more' });
    t.clock.t += 60000;
  }
  await t.app.pingFromAgent();
  await tap(t.app, HOLD, 7);
  assert.equal(lastAnswer(t), 'Too many holds this hour.');
  assert.equal(t.tg.last().text.split('\n')[1], 'That’s 6 holds in an hour. Next at 13:00.');
  t.clock.t = at(`${TUE}T13:00:00Z`);
  await t.app.pingFromAgent();
  await tap(t.app, HOLD, 7);
  assert.equal(lastAnswer(t), 'Asking your PC');
});

test('Glasgow Club checking visitors from home stops holds for an hour, and nothing tries to get round it', async () => {
  const t = await started();
  note(t, 'failed', { why: 'it stopped: Glasgow Club\'s site is checking its visitors (a "checking your browser" page), so I went no further', kind: 'challenge' });
  await settle();
  assert.match(rest(t.tg.last())[0], /^It didn’t work: it stopped: Glasgow Club's site is checking its visitors/);
  t.clock.t += 59 * 60000;
  await t.app.pingFromAgent();
  await tap(t.app, HOLD, 7);
  assert.equal(lastAnswer(t), 'Glasgow Club is checking visitors.');
  assert.equal(t.tg.last().text.split('\n')[1], 'Glasgow Club was checking visitors from your home connection. Not available until 13:00.');
  t.clock.t += 60001;
  await t.app.pingFromAgent();
  await tap(t.app, HOLD, 7);
  assert.equal(lastAnswer(t), 'Asking your PC');
});

test('that hour is one and the same for holding a court and for reading the sheet, whichever met the page', async () => {
  // The real reader, with this server turned away (as on Railway), so the PC is the only way.
  const realReader = clock => G.createGlasgowClub({ fetchImpl: async () => new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'content-type': 'text/html' } }), now: () => clock.t });
  // A hold meets the page: the PC is not asked to read the sheet either.
  const a = await started(`${TUE}T12:00:00Z`, { glasgow: realReader });
  note(a, 'failed', { why: 'it stopped: the site is checking its visitors', kind: 'challenge' });
  a.clock.t += 60000;
  await a.app.pingFromAgent();
  await tap(a.app, 'gd:g:20261120', 9);
  assert.match(a.tg.last().text, /Glasgow Club's site is checking visitors from your home connection just now, so your PC cannot read the free courts\. It will not be asked again for an hour\./);
  assert.deepEqual(await a.app.pingFromAgent(), { ok: true });                                   // no look was handed to the PC
  // A look meets the page: no hold is started, even from a card that is still on screen.
  const b = makeApp(`${TUE}T12:00:00Z`, { glasgow: realReader });
  await b.app.pingFromAgent();
  const ping = b.app.pingFromAgent({}, { wait: 5 });
  const looking = tap(b.app, 'gd:g:20261120', 9);
  const order = await ping;
  b.app.lookFromAgent({ id: order.look.id, ok: false, kind: 'challenge', why: 'the site is checking its visitors' });
  await looking;
  b.clock.t += 60000;
  await b.app.pingFromAgent();
  await tap(b.app, HOLD, 7);
  assert.equal(lastAnswer(b), 'Glasgow Club is checking visitors.');
  assert.equal(b.tg.last().text.split('\n')[1], 'Glasgow Club was checking visitors from your home connection. Not available until 13:00.');
  assert.deepEqual(await b.app.pingFromAgent(), { ok: true });
});

test('a time that has passed, a day no longer on offer or a court that is not one lead back to the days', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`);
  await t.app.pingFromAgent();
  for (const data of ['gh:g:20261117:1100:3', 'gh:g:20261116:1800:3', 'gh:g:20261230:1800:3', 'gh:g:20261120:1800:0', 'gh:g:20261120:1800:21', 'gh:g:20261120:1803:3', 'gh:g:20261131:1800:3']) {
    t.tg.clear();
    await tap(t.app, data, 7);
    assert.equal(lastAnswer(t), 'That time is no longer on offer. Pick again.', data);
    assert.match(t.tg.last().text, /^<b>Gorbals · indoor tennis<\/b>/, data);
  }
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });
  // And only the owner's taps count at all.
  await tap(t.app, HOLD, 7, { chat: 99 });
  assert.equal(lastAnswer(t), 'This bot is private.');
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });
});

// ---------- with the PC's other jobs ----------

test('the PC is not put to sleep while it holds a court', async () => {
  const t = await started();
  held(t);
  await t.app.handleUpdate(say(OWNER, '/sleep'));
  assert.equal(t.tg.last().text, 'Your PC is holding a court. Let it go first.');
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });
  note(t, 'released', { basket: 'empty', removed: 1, why: 'time', checked: true });
  await t.app.handleUpdate(say(OWNER, '/sleep'));
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true, sleep: true });
});

test('a note from the PC about a hold counts as the PC being in touch', async () => {
  const t = await started();
  t.clock.t += 2.5 * 60000;
  held(t);
  t.clock.t += 2.5 * 60000;                                                                    // five minutes since its last ping
  assert.equal(t.app.pcState(), 'awake');
});
