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
const LAPSES = 'If the court was in your basket and not paid for, the hold lapses by itself.';
const LOOK_UNDER = 'Look under Bookings on Glasgow Club\'s site.';

function makeApp(t0, { pcHoldMs = 60, env = {}, glasgow = null, store = memStore({ owner: OWNER, order: [3, 4, 5, 2, 1, 6] }) } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const logs = [];
  const reader = glasgow || { asked: 0, day: async () => { reader.asked++; return { at: clock.t, slots: [], listed: 1 }; }, peek: () => null, health: () => null };
  const app = createApp({ now: () => clock.t, tg, store, pictures: PICTURES, linked: true, glasgow: typeof reader === 'function' ? reader(clock) : reader, log: l => logs.push(l), env, pcHoldMs });
  return { app, tg, clock, logs, glasgow: reader };
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

const ctxAt = time => ({ cfg: { plan: {}, once: [], order: [3, 4, 5, 2, 1, 6], releaseMin: 1320, daysAhead: 7 }, now: at(time), paused: false, results: {}, lastSeen: null, linked: true, pc: 'awake', wake: 'ready', pinned: true });
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

test('the card of a court in your basket: what to pay, where the payment page is, and the three buttons', () => {
  const s = UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt());
  assert.equal(s.caption, [
    TITLE,
    '<b>In your basket</b>: £23.00 to pay. Your PC signed in as you and put it there at 12:01. The payment page is open in Chrome on your PC.',
    'To pay on this phone: open your basket below and sign in. If the court is there, pay there, then tap <b>I have paid</b>.',
    'Nobody has tried that yet. If your basket comes up empty, the court is only in the browser on your PC: pay in the Chrome window there, or let it go.',
    'Unpaid, your PC lets it go at 12:13.',
  ].join('\n'));
  // No Menu while it is going: the card stays the hold's card, with the buttons that matter.
  assert.deepEqual(s.keyboard.inline_keyboard.flat().map(b => [b.text, b.callback_data || b.url]), [
    ['Open my basket', 'https://glasgowclub.gladstonego.cloud/book/basket'],
    ['I have paid', 'gp:a1b2c3d4e5f6'], ['Let it go', 'gx:a1b2c3d4e5f6'],
  ]);
  fits(s);
  // Once you have tapped one, the buttons go and the card says what is happening.
  const going = UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt({ order: 'release' }));
  assert.deepEqual([going.caption.split('\n')[2], keysOf(going)], ['Letting it go…', []]);
  assert.equal(UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt({ order: 'done' })).caption.split('\n')[2], 'Looking for it on your Bookings page…');
  // A price that did not come through is simply left out.
  assert.match(UI.indoorHold(ctxAt(`${TUE}T12:02:00Z`), holdAt({ price: '' })).caption, /\n<b>In your basket<\/b>\. Your PC signed in as you/);
  // Before the basket: one button, Stop.
  for (const over of [{ taken: false, stage: 'asked' }, { stage: 'asked' }, { stage: 'signing-in' }, { stage: 'adding' }]) assert.deepEqual(keysOf(UI.indoorHold(ctxAt(`${TUE}T12:00:10Z`), holdAt(over))), ['Stop']);
});

test('every way a hold can end says what is known and no more, and none is too long for a card', () => {
  const ctx = ctxAt(`${TUE}T12:20:00Z`);
  const end = over => { const s = UI.indoorHold(ctx, holdAt(over)); fits(s); return s; };
  // Let go, or out of time.
  assert.equal(wordsOf(end({ end: 'released', why: 'release', basket: 'empty', removed: 1 })), 'Let go: your PC took the court out of your basket, so it was not paid for.');
  assert.equal(wordsOf(end({ end: 'released', why: 'time', basket: 'empty', removed: 1 })), 'Not paid in time, so your PC took the court out of your basket again.');
  assert.deepEqual(keysOf(end({ end: 'released', why: 'time', basket: 'empty', removed: 1 })), ['Other times', 'Menu']);
  assert.equal(wordsOf(end({ end: 'released', why: 'release', basket: 'untouched' })), 'Stopped. Nothing had gone into your basket.');
  // The court had left the basket by itself: "nothing was paid" is not claimed.
  assert.equal(wordsOf(end({ end: 'released', why: 'time', basket: 'gone', removed: 0 })),
    `Its time was up, but the court was no longer in the basket on your PC: it had been paid for, or the site had already let it go. Nothing was taken out.\n${LOOK_UNDER}`);
  assert.match(wordsOf(end({ end: 'released', why: 'release', basket: 'gone', removed: 0 })), /^You asked me to let it go, but the court was no longer in the basket on your PC/);
  assert.deepEqual(keysOf(end({ end: 'released', why: 'release', basket: 'gone', removed: 0 })), ['Open Glasgow Club', 'Other times', 'Menu']);
  // It could not be seen to have come out: an empty basket is not claimed either.
  for (const over of [{ basket: 'unclear', removed: 1 }, { basket: 'items', removed: 1 }, { basket: 'empty', removed: 0 }, { basket: '', removed: null }]) {
    assert.match(wordsOf(end({ end: 'released', why: 'release', ...over })), /^Your PC went to take the court out of your basket, but I could not see that the basket is empty\. An unpaid court lapses by itself\.$/);
  }
  // Booked: only ever said on the PC's word that it is on the Bookings page now and was not before.
  assert.equal(wordsOf(end({ end: 'booked', words: 'Thank you. Reference ########' })), '<b>Booked.</b> It is on your Bookings page at Glasgow Club now, and was not before.\nAfter the payment the page said: “Thank you. Reference ########”');
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
  assert.equal(wordsOf(end({ end: 'failed', stage: 'adding', why: 'court 3 is not free at 18:00 any more' })), 'It did not work: court 3 is not free at 18:00 any more.\nNothing was booked or paid.');
  assert.equal(wordsOf(end({ end: 'failed', stage: 'adding', why: 'the site could not price your basket', basket: 'empty' })), 'It did not work: the site could not price your basket.\nNothing was booked or paid. Your basket is empty.');
  assert.equal(wordsOf(end({ end: 'failed', stage: 'adding', why: 'x', basket: 'items' })), 'It did not work: x.\nNothing was booked or paid. Something is still in your basket; unpaid, it lapses by itself.');
  assert.deepEqual(keysOf(end({ end: 'failed', stage: 'adding', why: 'x' })), ['Open the sheet', 'Other times', 'Menu']);
  // It failed once the payment page was yours: "nothing was paid" is not claimed.
  assert.equal(wordsOf(end({ end: 'failed', stage: 'held', why: 'a question was open on the page in Chrome, so I left it as it was' })),
    `Something went wrong after the court was in your basket: a question was open on the page in Chrome, so I left it as it was.\nI cannot say how it ended. ${LOOK_UNDER}`);
  assert.deepEqual(keysOf(end({ end: 'failed', stage: 'held', why: 'x' })), ['Open Glasgow Club', 'Other times', 'Menu']);
  // The rest.
  assert.equal(wordsOf(end({ end: 'refused', stage: 'asked', why: 'the nightly booking is running' })), 'Your PC did not start on it: the nightly booking is running.\nNothing was done.');
  assert.equal(wordsOf(end({ end: 'closed' })), `The Chrome window on your PC was closed, so I cannot see how it ended. ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'slept' })), `Your PC went to sleep while it had the court, so it stopped there. ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'gone' })), `The tool on your PC stopped without saying how it ended. ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'gone', why: 'the booking tool was still running after twenty minutes, so it was stopped' })), `The tool on your PC stopped without saying how it ended (the booking tool was still running after twenty minutes, so it was stopped). ${LAPSES}`);
  assert.equal(wordsOf(end({ end: 'nopickup', taken: false, stage: 'asked' })), 'Your PC did not pick it up in time, so nothing was done. It may have gone to sleep.');
  assert.deepEqual(keysOf(UI.indoorHold({ ...ctx, pc: 'asleep' }, holdAt({ end: 'nopickup', taken: false, stage: 'asked' }))), ['Wake my PC', 'Open the sheet', 'Other times', 'Menu']);
  assert.equal(wordsOf(end({ end: 'nostart', stage: 'asked' })), 'Your PC picked it up but never started on it, so nothing was done. Its PC link may need restarting.');
  assert.equal(wordsOf(end({ end: 'stopped', taken: false, stage: 'asked' })), 'Stopped before your PC had started. Nothing was done.');
  assert.equal(wordsOf(end({ end: 'timeout' })), `I have heard nothing more from your PC about this. ${LAPSES}`);
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
  assert.deepEqual(rest(t.tg.last()), ['Your PC has it and is starting Chrome…']);
  assert.deepEqual(texts(t.tg.last()), ['Stop']);
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });               // handed over once
  for (const [stage, words] of [['signing-in', 'Your PC is signing in to Glasgow Club…'], ['signed-in', 'Signed in. Finding the court on the sheet…'], ['adding', 'Putting court 3 in your basket…']]) {
    assert.deepEqual(note(t, stage), { ok: true });
    await settle();
    assert.deepEqual(rest(t.tg.last()), [words]);
  }
  t.clock.t += 30000;
  assert.deepEqual(held(t), { ok: true });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[1], '<b>In your basket</b>: £23.00 to pay. Your PC signed in as you and put it there at 12:00. The payment page is open in Chrome on your PC.');
  assert.match(t.tg.last().text, /\nUnpaid, your PC lets it go at 12:12\.$/);
  assert.deepEqual(texts(t.tg.last()), ['Open my basket', 'I have paid', 'Let it go']);
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
  assert.deepEqual(rest(t.tg.last()), ['Let go: your PC took the court out of your basket, so it was not paid for.']);
  assert.deepEqual(buttons(t.tg.last()).map(b => [b.text, b.callback_data]), [['Other times', 'gd:g:20261120'], ['Menu', 'h']]);
  // It is over: later notes change nothing (the PC link's "the tool has gone" among them), and its buttons say so.
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true });
  assert.deepEqual(note(t, 'gone'), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Let go: your PC took the court out of your basket, so it was not paid for.']);
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
  assert.deepEqual(rest(t.tg.last()), ['<b>Booked.</b> It is on your Bookings page at Glasgow Club now, and was not before.', 'After the payment the page said: “Thank you &lt;Francisco&gt;. Reference ########”']);
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

test('the steps only go forwards, and a price that does not read as one is left out', async () => {
  const t = await started();
  note(t, 'held', { price: '<b>free</b>', left: -5 });
  await settle();
  assert.match(t.tg.last().text, /\n<b>In your basket<\/b>\. Your PC signed in as you/);
  assert.match(t.tg.last().text, /\nUnpaid, your PC lets it go at 12:12\.$/);                    // twelve minutes when it does not say
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
  assert.deepEqual(rest(t.tg.last()), ['It did not work: the sign-in to Glasgow Club did not go through &lt;b&gt;x&lt;/b&gt;.', 'Nothing was booked or paid.']);
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
  assert.deepEqual(rest(t.tg.last()), ['Your PC did not start on it: the nightly booking is running.', 'Nothing was done.']);
});

// ---------- when it does not go to plan ----------

test('no ping collects it in time: the card says so, nothing is handed over later, and a PC that has it after all is told to let go', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { pcHoldMs: 25000, env: { WAKE_MAC: 'AA:BB:CC:DD:EE:FF' } });
  await t.app.pingFromAgent({ ip: '81.2.69.142' });
  await tap(t.app, HOLD, 7);
  assert.deepEqual(rest(t.tg.last()), ['Asking your PC to hold it. It signs in to Glasgow Club, puts the court in your basket and opens the payment page: under a minute.']);
  assert.deepEqual(texts(t.tg.last()), ['Stop']);
  t.clock.t += 24000;
  await t.app.tick();
  assert.equal(rest(t.tg.last())[0].slice(0, 15), 'Asking your PC ');
  t.clock.t += 1000;
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Your PC did not pick it up in time, so nothing was done. It may have gone to sleep.']);
  assert.deepEqual(texts(t.tg.last()), ['Open the sheet', 'Other times', 'Menu']);                // it is still "awake" by its last ping
  assert.deepEqual(await t.app.pingFromAgent(), { ok: true });
  const id = buttons(t.tg.calls[0]).find(b => b.text === 'Stop').callback_data.slice(3);
  assert.deepEqual(t.app.holdFromAgent({ id, stage: 'signing-in' }), { ok: true, order: 'release' });
  assert.deepEqual(t.app.holdFromAgent({ id, stage: 'held', beat: true }), { ok: true, order: 'release' });
  assert.deepEqual(t.app.holdFromAgent({ id, stage: 'released', basket: 'untouched' }), { ok: true });   // it has let go: nothing more to ask of it
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Your PC did not pick it up in time, so nothing was done. It may have gone to sleep.']);
  assert.ok(t.logs.includes('Your PC did not collect the court to hold in time.'));
});

test('the PC collects it and then says nothing at all (an older PC link, or a tool that would not start): over after a minute and a half', async () => {
  const t = await started();
  t.clock.t += 89000;
  await t.app.pingFromAgent();                                                                   // its pings go on; the hold is another matter
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Your PC has it and is starting Chrome…']);
  t.clock.t += 1000;
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Your PC picked it up but never started on it, so nothing was done. Its PC link may need restarting.']);
  assert.deepEqual(texts(t.tg.last()), ['Open the sheet', 'Other times', 'Menu']);
  // If the tool does start after that, it is told to stop; and its own word on how it ended is taken.
  assert.deepEqual(note(t, 'signing-in'), { ok: true, order: 'release' });
  assert.deepEqual(note(t, 'released', { basket: 'untouched', why: 'release' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Stopped. Nothing had gone into your basket.']);
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
  assert.deepEqual(rest(t.tg.last()), ['Stopped before your PC had started. Nothing was done.']);
  assert.deepEqual(await t.app.pingFromAgent({}, { wait: 0.02 }), { ok: true });
});

test('Stop while the PC is signing in: it hears it on its next step', async () => {
  const t = await started();
  note(t, 'signing-in');
  await tap(t.app, `gx:${t.id}`, 7);
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Your PC is signing in to Glasgow Club…', 'Stopping…']);
  assert.deepEqual(texts(t.tg.last()), []);
  assert.deepEqual(note(t, 'signed-in'), { ok: true, order: 'release' });
  note(t, 'released', { basket: 'untouched', why: 'release' });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Stopped. Nothing had gone into your basket.']);
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
  assert.match(t.tg.last().text, /\nNo word from your PC for over a minute\. It may have lost its connection\.$/);
  assert.deepEqual(texts(t.tg.last()), ['Open my basket', 'I have paid', 'Let it go']);
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
  assert.equal(t.tg.last().text.split('\n')[1].slice(0, 22), '<b>In your basket</b>:');
  t.clock.t = at(`${TUE}T12:19:00Z`);
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), [`I have heard nothing more from your PC about this. ${LAPSES}`]);
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'release' });             // a PC that still has it is told to let go
  assert.deepEqual(note(t, 'booked', { words: '' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['<b>Booked.</b> It is on your Bookings page at Glasgow Club now, and was not before.']);
  // A hold that never reaches the basket is over eight minutes after the tap.
  const s = await started();
  note(s, 'signing-in');
  for (let i = 0; i < 7; i++) { s.clock.t += 60000; note(s, 'signing-in'); await s.app.tick(); }
  assert.deepEqual(rest(s.tg.last()), ['Your PC is signing in to Glasgow Club…']);
  s.clock.t += 60000;
  await s.app.tick();
  assert.match(rest(s.tg.last())[0], /^I have heard nothing more from your PC about this\./);
});

test('a card Telegram would not redraw is tried again by the timer, so the last word always gets there', async () => {
  const t = await started();
  held(t);
  await settle();
  t.tg.failEdit = { code: 429, message: 'Too Many Requests', once: true };
  note(t, 'released', { basket: 'empty', removed: 1, why: 'time', checked: true });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[1].slice(0, 22), '<b>In your basket</b>:');         // the ending did not get on to the card
  assert.ok(t.logs.some(l => /Could not update the hold's card: Too Many Requests/.test(l)));
  t.clock.t += 4000;
  await t.app.tick();
  assert.equal(t.tg.last().text.split('\n')[1].slice(0, 22), '<b>In your basket</b>:');         // not yet: five seconds
  t.clock.t += 1000;
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Not paid in time, so your PC took the court out of your basket again.']);
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
  assert.equal(lastAnswer(fresh), 'I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up.');
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
  assert.deepEqual(texts(t.tg.last()), ['Open my basket', 'I have paid', 'Let it go']);
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
  assert.match(first.text.split('\n')[1], /^I have heard nothing more from your PC about this\./);  // its card says it is over
  assert.deepEqual(texts(first), ['Other times', 'Menu']);
  assert.deepEqual(note(t, 'signed-in'), { ok: true, order: 'release' });                        // the old tool, if it is still there
  assert.deepEqual(t.app.holdFromAgent({ id: second.id, stage: 'signing-in' }), { ok: true });
});

test('with the PC asleep there is nobody to hold it: the card says so and offers to wake it', async () => {
  const t = makeApp(`${TUE}T12:00:00Z`, { env: { WAKE_MAC: 'AA:BB:CC:DD:EE:FF' } });
  await t.app.pingFromAgent({ ip: '81.2.69.142' });
  t.clock.t += 10 * 60000;                                                                      // no ping for ten minutes
  await tap(t.app, HOLD, 7);
  assert.deepEqual(t.tg.answers, ['Your PC is not awake.']);
  assert.deepEqual(t.tg.last().text.split('\n'), [TITLE, 'Your PC is not awake, and it is your PC that signs in to Glasgow Club and holds the court. Wake it and try again.']);
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
    assert.equal(t.tg.answers[0], goes ? 'Asking your PC' : 'Not around the nightly booking run.', time);
    if (!goes) assert.equal(t.tg.last().text.split('\n')[1], 'Your PC\'s nightly booking run is at 22:00, so it holds nothing else from 21:25 to 22:15. The sheet below still opens.');
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
  assert.equal(t.tg.last().text.split('\n')[1], 'That is 6 holds within an hour, and each is a sign-in to Glasgow Club. The next can start at 13:00.');
  t.clock.t = at(`${TUE}T13:00:00Z`);
  await t.app.pingFromAgent();
  await tap(t.app, HOLD, 7);
  assert.equal(lastAnswer(t), 'Asking your PC');
});

test('Glasgow Club checking visitors from home stops holds for an hour, and nothing tries to get round it', async () => {
  const t = await started();
  note(t, 'failed', { why: 'it stopped: Glasgow Club\'s site is checking its visitors (a "checking your browser" page), so I went no further', kind: 'challenge' });
  await settle();
  assert.match(rest(t.tg.last())[0], /^It did not work: it stopped: Glasgow Club's site is checking its visitors/);
  t.clock.t += 59 * 60000;
  await t.app.pingFromAgent();
  await tap(t.app, HOLD, 7);
  assert.equal(lastAnswer(t), 'Glasgow Club is checking visitors.');
  assert.equal(t.tg.last().text.split('\n')[1], 'Glasgow Club\'s site was checking visitors from your home connection, so your PC is leaving it alone until 13:00.');
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
  assert.equal(b.tg.last().text.split('\n')[1], 'Glasgow Club\'s site was checking visitors from your home connection, so your PC is leaving it alone until 13:00.');
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
  assert.equal(t.tg.last().text, 'Your PC is holding a court for you. Let it go first.');
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

// ---------- paying from your PC ----------
// Only when the PC says with the court that paying is set up there (a card and a limit in its
// .env), and only when this bot is locked to you by TELEGRAM_CHAT_ID. The card never comes to
// the bot: all it handles is the amount and your two taps.

const PINNED = { env: { TELEGRAM_CHAT_ID: String(OWNER) } };
const startedPinned = (opts = {}) => started(undefined, { ...PINNED, ...opts });
const heldReady = t => note(t, 'held', { price: '£23.00', left: 12 * 60000, pay: 'ready' });
// A hold in the basket on a pinned bot, Pay tapped and confirmed, and the PC told so.
async function payAsked() {
  const t = await startedPinned();
  heldReady(t);
  await tap(t.app, `gy:${t.id}`, 7);
  await tap(t.app, `gz:${t.id}:2300`, 7);
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'pay', amount: '£23.00' });
  return t;
}
// ...and the PC's word that Pay was pressed (`how`: 'pressed'), or may have been ('maybe').
async function payPressed(how = 'pressed') {
  const t = await payAsked();
  t.clock.t += 9000;
  assert.deepEqual(note(t, 'held', { beat: true, pay: how, left: 6 * 60000, ...(how === 'maybe' ? { payWhy: 'Chrome gave no answer when Pay was pressed' } : {}) }), { ok: true });
  await settle();
  return t;
}
const PAID_UNKNOWN = 'Whether the payment went through is not known here. Look under Bookings on Glasgow Club\'s site, and in your banking app. Nothing was taken out of your basket.';

test('the card of a court your PC can pay for: Pay comes first, and it asks before it does anything', () => {
  const ctx = ctxAt(`${TUE}T12:02:00Z`);
  const s = UI.indoorHold(ctx, holdAt({ pay: 'ready' }));
  assert.deepEqual(keysOf(s), ['Pay £23.00 from my PC', 'Open my basket', 'I have paid', 'Let it go']);
  assert.equal(s.keyboard.inline_keyboard[0][0].callback_data, 'gy:a1b2c3d4e5f6');
  assert.equal(s.caption.split('\n')[2], '<b>Pay from my PC</b>: your PC pays with the card kept on it, once you have confirmed the amount.');
  assert.match(s.caption.split('\n')[3], /^Or on this phone: open your basket below and sign in\./);
  fits(s);
  // The question: the amount once more, and what will happen.
  const q = UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'confirm' }));
  assert.deepEqual(q.caption.split('\n').slice(1), [
    'Pay <b>£23.00</b> for this court with the card kept on your PC?',
    'Your PC types the card into Glasgow Club\'s payment page and presses Pay. If your bank asks you to approve it, that is yours to do in your banking app.',
  ]);
  assert.deepEqual(q.keyboard.inline_keyboard.flat().map(b => [b.text, b.callback_data]), [['Yes, pay £23.00', 'gz:a1b2c3d4e5f6:2300'], ['Back', 'gb:a1b2c3d4e5f6']]);
  fits(q);
  // While it pays, and once Pay is pressed, there is nothing to tap.
  const paying = UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'asked', order: 'pay' }));
  assert.deepEqual([paying.caption.split('\n')[2], keysOf(paying)], ['Paying: your PC is typing the card into the payment page and pressing Pay…', []]);
  const pressed = UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'pressed', payAmount: '£23.00', pressedAt: at(`${TUE}T12:03:00Z`), payWords: 'Processing <payment>' }));
  assert.deepEqual(pressed.caption.split('\n').slice(1), [
    'Your PC pressed <b>Pay £23.00</b>; I heard so at 12:03. If your bank asks you to approve it, do that now in your banking app.',   // the time is when the bot heard, and says so
    'Waiting for Glasgow Club\'s answer…',
    'The payment page says: “Processing &lt;payment&gt;”',
  ]);
  assert.deepEqual(keysOf(pressed), []);
  // Chrome gave the PC no answer to the press: "may have pressed", what to do about it, and where to look.
  const maybe = UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'maybe', payAmount: '£23.00', pressedAt: at(`${TUE}T12:03:00Z`), payDoubt: 'Chrome did not answer in time when Pay was pressed <45 s>' }));
  assert.deepEqual(maybe.caption.split('\n').slice(1), [
    'Your PC <b>may have pressed Pay £23.00</b>: Chrome did not answer in time when Pay was pressed &lt;45 s&gt;. I heard so at 12:03.',
    'Take it as pressed. Before you pay any other way, look under Bookings on Glasgow Club\'s site and in your banking app. If your bank asks you to approve this payment, that is yours to decide.',
    'Your PC takes nothing out of your basket, and is waiting for Glasgow Club\'s answer…',
  ]);
  assert.deepEqual(maybe.keyboard.inline_keyboard.flat().map(b => [b.text, b.url]), [['Open Glasgow Club', 'https://glasgowclub.gladstonego.cloud/']]);   // no "Let it go", no "I have paid", no second Pay
  fits(maybe);
  assert.match(UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'maybe', pressedAt: at(`${TUE}T12:03:00Z`) })).caption, /may have pressed Pay £23\.00<\/b>: it could not tell whether the press went through\. I heard so at 12:03\./);
  // The longest these two cards can get (the PC's reason is cut at 160 characters, the page's words at 300) still fits a card.
  fits(UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'maybe', payAmount: '£1234.00', pressedAt: at(`${TUE}T12:03:00Z`), payDoubt: '<'.repeat(160), payWords: '<'.repeat(300) })));
  fits(UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'pressed', payAmount: '£1234.00', pressedAt: at(`${TUE}T12:03:00Z`), payWords: '<'.repeat(300) })));
  // It could not pay: said, with the other ways still there, and Pay not offered again.
  const failed = UI.indoorHold(ctx, holdAt({ pay: 'ready', payState: 'failed', payFailed: 'the expiry box: it did not hold what was typed' }));
  assert.equal(failed.caption.split('\n')[2], 'Your PC could not pay: the expiry box: it did not hold what was typed. Pay was not pressed, so nothing was paid.');
  assert.deepEqual(keysOf(failed), ['Open my basket', 'I have paid', 'Let it go']);
  // Set up, but not for this one: why, and no Pay button. Not set up at all: not a word.
  const over = UI.indoorHold(ctx, holdAt({ pay: 'over', payWhy: '£30.00 is more than your limit for one payment (GLASGOW_PAY_MAX, £25)' }));
  assert.equal(over.caption.split('\n')[2], 'Paying from your PC is not on for this one: £30.00 is more than your limit for one payment (GLASGOW_PAY_MAX, £25).');
  assert.deepEqual(keysOf(over), ['Open my basket', 'I have paid', 'Let it go']);
  assert.ok(!UI.indoorHold(ctx, holdAt()).caption.includes('Paying from your PC'));
  // A bot that is not locked to you never shows Pay, whatever the hold says of itself.
  for (const loose of [{ ...ctx, pinned: false }, { ...ctx, pinned: undefined }]) {
    const none = UI.indoorHold(loose, holdAt({ pay: 'ready' }));
    assert.deepEqual(keysOf(none), ['Open my basket', 'I have paid', 'Let it go']);
    assert.ok(!none.caption.includes('Pay from my PC'));
  }
});

test('how it ended after your PC pressed Pay: booked and paid, or what is known and where to look', () => {
  const ctx = ctxAt(`${TUE}T12:20:00Z`);
  const end = over => { const s = UI.indoorHold(ctx, holdAt({ pressed: true, ...over })); fits(s); return wordsOf(s); };
  assert.equal(end({ end: 'booked', words: 'Thank you' }), '<b>Booked and paid.</b> Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.\nAfter the payment the page said: “Thank you”');
  assert.equal(end({ end: 'unsure', checked: true, basket: 'still' }), [
    'Your PC pressed Pay, and the payment page never moved on, but I could not see the court as a new booking on your Bookings page.',
    `It is still in the basket on your PC, so it does not look paid for. I left it there; unpaid, it lapses by itself. I have closed Chrome on your PC. ${LOOK_UNDER} Look in your banking app too: if the money has gone and the court is not under Bookings, that is one for Glasgow Club.`,
  ].join('\n'));
  assert.match(end({ end: 'left', checked: true, basket: 'gone', words: 'Payment failed' }), /^Your PC pressed Pay and the payment page moved on, but I could not see the court as a new booking on your Bookings page\.\nThe page said: “Payment failed”\n/);
  assert.equal(end({ end: 'failed', stage: 'held', why: 'it stopped: Chrome went away' }), `Something went wrong after your PC pressed Pay: it stopped: Chrome went away.\nI cannot say how it ended. ${LOOK_UNDER} Look in your banking app too.`);
});

test('after a press, the endings that know nothing of the payment say so: the window closed, the PC asleep, the tool gone, nothing more heard', () => {
  const ctx = ctxAt(`${TUE}T12:20:00Z`);
  const card = over => { const s = UI.indoorHold(ctx, holdAt({ pressed: true, ...over })); fits(s); return s; };
  const end = over => wordsOf(card(over));
  assert.equal(end({ end: 'closed' }), `Your PC pressed Pay, and then the Chrome window on your PC was closed, so I cannot see how it ended.\n${PAID_UNKNOWN}`);
  assert.equal(end({ end: 'slept' }), `Your PC pressed Pay, and then your PC went to sleep, so it stopped there.\n${PAID_UNKNOWN}`);
  assert.equal(end({ end: 'gone' }), `Your PC pressed Pay, and then the tool on your PC stopped without saying how it ended.\n${PAID_UNKNOWN}`);
  assert.equal(end({ end: 'gone', why: 'the booking tool was still running after twenty-eight minutes, so it was stopped' }),
    `Your PC pressed Pay, and then the tool on your PC stopped without saying how it ended (the booking tool was still running after twenty-eight minutes, so it was stopped).\n${PAID_UNKNOWN}`);
  assert.equal(end({ end: 'timeout' }), `Your PC pressed Pay, and I have heard nothing more from your PC about this.\n${PAID_UNKNOWN}`);
  for (const how of ['closed', 'slept', 'gone', 'timeout']) {
    // None of them says an unpaid hold "lapses by itself", and each points at where the answer is.
    assert.ok(!end({ end: how }).includes('lapses'), how);
    assert.deepEqual(keysOf(card({ end: how })), ['Open Glasgow Club', 'Other times', 'Menu'], how);
    // "May have pressed" (Chrome gave the PC no answer to the press) is said as that, with the same care.
    assert.equal(end({ end: how, pressed: 'maybe' }).split('\n')[1], PAID_UNKNOWN, how);
    assert.match(end({ end: how, pressed: 'maybe' }), /^Your PC may have pressed Pay \(whether it did is not known\), and /, how);
    // Without a press they read as they always did.
    assert.match(wordsOf(UI.indoorHold(ctx, holdAt({ end: how }))), /If the court was in your basket and not paid for, the hold lapses by itself\.$/, how);
  }
  // The other endings after a press that may or may not have landed.
  assert.equal(end({ end: 'booked', pressed: 'maybe', words: 'Thank you' }),
    '<b>Booked.</b> It is on your Bookings page at Glasgow Club now, and was not before. Your PC could not tell whether its press of Pay had gone through; your banking app shows what was paid.\nAfter the payment the page said: “Thank you”');
  assert.match(end({ end: 'unsure', pressed: 'maybe', checked: true, basket: 'still' }), /^Your PC may have pressed Pay \(whether it did is not known\), and the payment page never moved on, but I could not see the court as a new booking on your Bookings page\.\n.*Look in your banking app too/);
  assert.match(end({ end: 'left', pressed: 'maybe', checked: true, basket: 'gone' }), /^Your PC may have pressed Pay \(whether it did is not known\) and the payment page moved on, but /);
  assert.equal(end({ end: 'failed', pressed: 'maybe', stage: 'held', why: 'it stopped: Chrome went away' }), `Something went wrong after your PC may have pressed Pay: it stopped: Chrome went away.\nI cannot say how it ended. ${LOOK_UNDER} Look in your banking app too.`);
  // The longest of them, with everything the PC can send at its longest, still fits a card (`end` checks each).
  for (const pressed of [true, 'maybe']) {
    end({ end: 'left', pressed, checked: false, basket: 'still', words: '<'.repeat(300) });
    end({ end: 'unsure', pressed, checked: false, basket: 'still', words: '<'.repeat(300) });
    end({ end: 'gone', pressed, why: '<'.repeat(300) });
    end({ end: 'failed', pressed, stage: 'held', why: '<'.repeat(300) });
    end({ end: 'booked', pressed, words: '<'.repeat(300) });
  }
});

test('Pay from my PC: asked for, confirmed with the amount, sent to the PC until it answers, and never twice', async () => {
  const t = await startedPinned();
  assert.deepEqual(heldReady(t), { ok: true });
  await settle();
  assert.deepEqual(texts(t.tg.last()), ['Pay £23.00 from my PC', 'Open my basket', 'I have paid', 'Let it go']);
  assert.ok(t.logs.some(l => /is in the basket \(£23\.00\); your PC can pay for it if you say so\.$/.test(l)));
  // Tap Pay: the question. Nothing is sent to the PC for that.
  await tap(t.app, `gy:${t.id}`, 7);
  await settle();
  assert.deepEqual(texts(t.tg.last()), ['Yes, pay £23.00', 'Back']);
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true });
  // Back, and Pay again.
  await tap(t.app, `gb:${t.id}`, 7);
  await settle();
  assert.deepEqual(texts(t.tg.last()), ['Pay £23.00 from my PC', 'Open my basket', 'I have paid', 'Let it go']);
  await tap(t.app, `gy:${t.id}`, 7);
  // Yes: the PC is told the amount with its next note, and again until it has said how it went.
  await tap(t.app, `gz:${t.id}:2300`, 7);
  assert.equal(lastAnswer(t), 'Paying £23.00');
  await settle();
  assert.equal(t.tg.last().text.split('\n')[2], 'Paying: your PC is typing the card into the payment page and pressing Pay…');
  assert.deepEqual(texts(t.tg.last()), []);
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'pay', amount: '£23.00' });
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'pay', amount: '£23.00' });
  await tap(t.app, `gz:${t.id}:2300`, 7);                                                        // a second tap on Yes
  assert.equal(lastAnswer(t), 'Your PC is paying.');
  await tap(t.app, `gx:${t.id}`, 7);                                                             // and nothing else is taken meanwhile
  assert.equal(lastAnswer(t), 'Your PC is paying. Wait for its answer.');
  // The PC pressed Pay: no more orders go out, and the card waits for the answer.
  t.clock.t += 8000;
  assert.deepEqual(note(t, 'held', { beat: true, pay: 'pressed', left: 6 * 60000 }), { ok: true });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[1], 'Your PC pressed <b>Pay £23.00</b>; I heard so at 12:00. If your bank asks you to approve it, do that now in your banking app.');
  assert.deepEqual(texts(t.tg.last()), []);
  await tap(t.app, `gx:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'Your PC has pressed Pay. Wait for the answer.');
  await tap(t.app, `gz:${t.id}:2300`, 7);
  assert.equal(lastAnswer(t), 'Pay has been pressed already.');
  assert.deepEqual(note(t, 'held', { beat: true, pay: 'pressed', left: 5 * 60000 }), { ok: true });
  // What the payment page says meanwhile is shown; then the ending.
  note(t, 'held', { beat: true, pay: 'pressed', left: 5 * 60000, words: 'Approve this payment in your banking app' });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[3], 'The payment page says: “Approve this payment in your banking app”');
  note(t, 'booked', { words: 'Thank you. Your booking is confirmed', pressed: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['<b>Booked and paid.</b> Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.', 'After the payment the page said: “Thank you. Your booking is confirmed”']);
  assert.ok(t.logs.includes('Hold: you confirmed paying £23.00 for Gorbals 2026-11-20 18:00 court 3 from your PC.'));
  assert.ok(t.logs.includes('Hold: your PC pressed Pay for Gorbals 2026-11-20 18:00 court 3 (£23.00).'));
});

test('"Yes, pay" only counts for the amount that was shown, after the question, on a court the PC can pay for', async () => {
  const t = await startedPinned();
  heldReady(t);
  await tap(t.app, `gz:${t.id}:2300`, 7);                                                        // Yes without the question (an old button)
  assert.equal(lastAnswer(t), 'The amount has changed. Look again.');
  await tap(t.app, `gy:${t.id}`, 7);
  await tap(t.app, `gz:${t.id}:4600`, 7);                                                        // another amount
  assert.equal(lastAnswer(t), 'The amount has changed. Look again.');
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true });                               // nothing was sent to the PC
  // A court the PC did not say it can pay for: no Pay, whatever is tapped.
  const plain = await startedPinned();
  held(plain);
  for (const data of [`gy:${plain.id}`, `gz:${plain.id}:2300`]) {
    await tap(plain.app, data, 7);
    assert.equal(lastAnswer(plain), 'Paying from your PC is not on for this court.');
  }
  assert.deepEqual(note(plain, 'held', { beat: true }), { ok: true });
  // Before the court is in the basket, and once the hold is over: no.
  const early = await startedPinned();
  note(early, 'signing-in');
  await tap(early.app, `gy:${early.id}`, 7);
  assert.equal(lastAnswer(early), 'Paying from your PC is not on for this court.');
  note(early, 'failed', { why: 'x' });
  await tap(early.app, `gy:${early.id}`, 7);
  assert.equal(lastAnswer(early), 'That hold is over.');
  await tap(early.app, 'gy:ffffffffffff', 7);
  assert.equal(lastAnswer(early), 'I am no longer following that hold.');
});

test('the PC could not pay: the card says why, Pay is not offered again, and the court can still be let go', async () => {
  const t = await startedPinned();
  heldReady(t);
  await tap(t.app, `gy:${t.id}`, 7);
  await tap(t.app, `gz:${t.id}:2300`, 7);
  assert.deepEqual(note(t, 'held', { beat: true, pay: 'failed', payWhy: 'the payment page says "Pay £46.00", not the £23.00 you confirmed' }), { ok: true });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[2], 'Your PC could not pay: the payment page says "Pay £46.00", not the £23.00 you confirmed. Pay was not pressed, so nothing was paid.');
  assert.deepEqual(texts(t.tg.last()), ['Open my basket', 'I have paid', 'Let it go']);
  await tap(t.app, `gy:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'That did not work; the card says why.');
  await tap(t.app, `gx:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'Letting it go');
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'release' });
});

test('told to pay twice over, a PC that comes back with neither a press nor a reason is not acting on it: said, and the order withdrawn', async () => {
  const t = await startedPinned();
  heldReady(t);
  await tap(t.app, `gy:${t.id}`, 7);
  await tap(t.app, `gz:${t.id}:2300`, 7);
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'pay', amount: '£23.00' });
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'pay', amount: '£23.00' });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[2], 'Paying: your PC is typing the card into the payment page and pressing Pay…');
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true });                               // the third note: it is not acting on it
  await settle();
  assert.equal(t.tg.last().text.split('\n')[2], 'Your PC could not pay: your PC did not act on it. Pay was not pressed, so nothing was paid.');
  // While the PC is at it (it sends nothing while it types), however long that takes, nothing is concluded.
  const slow = await startedPinned();
  heldReady(slow);
  await tap(slow.app, `gy:${slow.id}`, 7);
  await tap(slow.app, `gz:${slow.id}:2300`, 7);
  note(slow, 'held', { beat: true });
  slow.clock.t += 60000;
  await slow.app.tick();
  assert.equal(slow.tg.last().text.split('\n')[2], 'Paying: your PC is typing the card into the payment page and pressing Pay…');
  assert.deepEqual(note(slow, 'held', { beat: true, pay: 'pressed', left: 6 * 60000 }), { ok: true });
});

test('after Pay is pressed the hold runs on the PC\'s clock for the answer, and an ending that could not see the booking says where to look', async () => {
  const t = await startedPinned();
  heldReady(t);                                                                                  // until 12:12
  await tap(t.app, `gy:${t.id}`, 7);
  await tap(t.app, `gz:${t.id}:2300`, 7);
  t.clock.t = at(`${TUE}T12:11:00Z`);
  note(t, 'held', { beat: true, pay: 'pressed', left: 6 * 60000 });                              // pressed a minute before the hold's own end
  for (t.clock.t = at(`${TUE}T12:11:04Z`); t.clock.t < at(`${TUE}T12:23:00Z`); t.clock.t += 4000) { note(t, 'held', { beat: true, pay: 'pressed', left: Math.max(0, at(`${TUE}T12:17:00Z`) - t.clock.t) }); await t.app.tick(); }
  assert.match(t.tg.last().text.split('\n')[1], /^Your PC pressed <b>Pay £23\.00<\/b>; I heard so at 12:11\./);   // still waiting at 12:23, eleven minutes after 12:12
  note(t, 'unsure', { words: '', checked: true, basket: 'still', pressed: true });
  await settle();
  assert.match(rest(t.tg.last())[0], /^Your PC pressed Pay, and the payment page never moved on, but I could not see the court as a new booking/);
  assert.match(rest(t.tg.last())[1], /Look in your banking app too/);
});

// ---------- after a press, no ending forgets it ----------

test('the PC link says the tool has gone after Pay was pressed: the card says Pay was pressed and that how it went is not known', async () => {
  const t = await payPressed();
  // The link does not know what its tool did: its note says nothing of a press. The bot does.
  assert.deepEqual(note(t, 'gone', { why: 'the booking tool was still running after twenty-eight minutes, so it was stopped' }), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Your PC pressed Pay, and then the tool on your PC stopped without saying how it ended (the booking tool was still running after twenty-eight minutes, so it was stopped).', PAID_UNKNOWN]);
  assert.deepEqual(texts(t.tg.last()), ['Open Glasgow Club', 'Other times', 'Menu']);
});

test('the Chrome window closed, or the PC asleep, after Pay was pressed: said with the press, whether or not the tool\'s note says so again', async () => {
  for (const [how, first] of [['closed', 'Your PC pressed Pay, and then the Chrome window on your PC was closed, so I cannot see how it ended.'], ['slept', 'Your PC pressed Pay, and then your PC went to sleep, so it stopped there.']]) {
    for (const extra of [{ pressed: true }, {}]) {
      const t = await payPressed();
      assert.deepEqual(note(t, how, extra), { ok: true });
      await settle();
      assert.deepEqual(rest(t.tg.last()), [first, PAID_UNKNOWN], how);
      assert.deepEqual(texts(t.tg.last()), ['Open Glasgow Club', 'Other times', 'Menu'], how);
    }
  }
  // A hold nobody paid for from the PC ends in the old words.
  const plain = await started();
  held(plain);
  note(plain, 'closed');
  await settle();
  assert.deepEqual(rest(plain.tg.last()), [`The Chrome window on your PC was closed, so I cannot see how it ended. ${LAPSES}`]);
});

test('nothing more is heard after Pay was pressed: the card says so with the press, and the PC is never told to let go', async () => {
  const t = await payPressed();                                                                  // the PC gave the page six more minutes
  t.clock.t += 12 * 60000;
  await t.app.tick();
  assert.match(t.tg.last().text.split('\n')[1], /^Your PC pressed <b>Pay £23\.00<\/b>; I heard so at /);   // not yet: seven minutes after its time
  t.clock.t += 2 * 60000;
  await t.app.tick();
  assert.deepEqual(rest(t.tg.last()), ['Your PC pressed Pay, and I have heard nothing more from your PC about this.', PAID_UNKNOWN]);
  assert.deepEqual(texts(t.tg.last()), ['Open Glasgow Club', 'Other times', 'Menu']);
  // A PC that still has it is not told to let go (as it is for a hold nobody paid for): a payment may be going through.
  assert.deepEqual(note(t, 'held', { beat: true, pay: 'pressed', left: 0 }), { ok: true });
  // And when the PC does say how it ended, its word replaces the bot's guess.
  assert.deepEqual(note(t, 'booked', { words: 'Thank you', pressed: true }), { ok: true });
  await settle();
  assert.equal(rest(t.tg.last())[0], '<b>Booked and paid.</b> Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.');
  // Given up for another hold after four silent minutes: the same words, and the old tool is not told to let go either.
  const old = await payPressed();
  old.clock.t += 4 * 60000;
  await old.app.pingFromAgent();
  const ping = old.app.pingFromAgent({}, { wait: 5 });
  await tap(old.app, 'gh:g:20261120:1900:3', 8);
  await ping;
  await settle();
  const first = old.tg.calls.filter(c => c.id === 7).pop();
  assert.deepEqual(rest(first), ['Your PC pressed Pay, and I have heard nothing more from your PC about this.', PAID_UNKNOWN]);
  assert.deepEqual(note(old, 'held', { beat: true, pay: 'pressed', left: 60000 }), { ok: true, unknown: true });
});

test('you confirmed Pay and the PC never said how it went: an ending that is not the tool\'s own word says Pay may have been pressed', async () => {
  // The tool is stopped, or dies, in the middle of paying: the link's "gone" is all that comes.
  const t = await payAsked();
  assert.deepEqual(note(t, 'gone'), { ok: true });
  await settle();
  assert.deepEqual(rest(t.tg.last()), ['Your PC may have pressed Pay (whether it did is not known), and then the tool on your PC stopped without saying how it ended.', PAID_UNKNOWN]);
  // Nothing at all comes: the bot's own ending says the same, and does not tell the PC to let go.
  const silent = await payAsked();
  silent.clock.t += 20 * 60000;
  await silent.app.tick();
  assert.deepEqual(rest(silent.tg.last()), ['Your PC may have pressed Pay (whether it did is not known), and I have heard nothing more from your PC about this.', PAID_UNKNOWN]);
  assert.deepEqual(note(silent, 'held', { beat: true }), { ok: true });
  // The tool's own word, when it does come, is what counts: it had not pressed, and let the court go.
  assert.deepEqual(note(silent, 'released', { basket: 'empty', removed: 1, why: 'time', checked: true }), { ok: true });
  await settle();
  assert.deepEqual(rest(silent.tg.last()), ['Not paid in time, so your PC took the court out of your basket again.']);
  // The tool's own "closed" while it had only been asked: it would have said so had it pressed.
  const closed = await payAsked();
  note(closed, 'closed');
  await settle();
  assert.deepEqual(rest(closed.tg.last()), [`The Chrome window on your PC was closed, so I cannot see how it ended. ${LAPSES}`]);
});

test('"may have pressed": the PC could not tell whether its press of Pay landed, and from then on it is treated as pressed here too', async () => {
  const t = await payPressed('maybe');
  assert.deepEqual(rest(t.tg.last()), [
    'Your PC <b>may have pressed Pay £23.00</b>: Chrome gave no answer when Pay was pressed. I heard so at 12:00.',
    'Take it as pressed. Before you pay any other way, look under Bookings on Glasgow Club\'s site and in your banking app. If your bank asks you to approve this payment, that is yours to decide.',
    'Your PC takes nothing out of your basket, and is waiting for Glasgow Club\'s answer…',
  ]);
  assert.deepEqual(texts(t.tg.last()), ['Open Glasgow Club']);
  assert.ok(t.logs.includes('Hold: your PC may have pressed Pay for Gorbals 2026-11-20 18:00 court 3 (£23.00): Chrome gave no answer when Pay was pressed.'));
  // No order goes to the PC any more, and neither Let it go, I have paid nor a second Pay is taken.
  assert.deepEqual(note(t, 'held', { beat: true, pay: 'maybe', left: 5 * 60000 }), { ok: true });
  for (const [data, toast] of [[`gx:${t.id}`, 'Your PC may have pressed Pay. Wait for the answer.'], [`gp:${t.id}`, 'Your PC may have pressed Pay. Wait for the answer.'], [`gy:${t.id}`, 'Pay may have been pressed already.'], [`gz:${t.id}:2300`, 'Pay may have been pressed already.']]) {
    await tap(t.app, data, 7);
    assert.equal(lastAnswer(t), toast, data);
  }
  assert.deepEqual(note(t, 'held', { beat: true, pay: 'maybe', left: 5 * 60000, words: 'Processing' }), { ok: true });
  await settle();
  assert.equal(t.tg.last().text.split('\n')[4], 'The payment page says: “Processing”');
  // The ending carries it: not seen as booked.
  assert.deepEqual(note(t, 'unsure', { words: '', checked: true, basket: 'still', pressed: 'maybe' }), { ok: true });
  await settle();
  assert.match(rest(t.tg.last())[0], /^Your PC may have pressed Pay \(whether it did is not known\), and the payment page never moved on, but I could not see the court as a new booking/);
  assert.match(rest(t.tg.last())[1], /Look in your banking app too/);
  // Every other ending after a "maybe", whether the note says so again or not.
  for (const [how, extra, first] of [
    ['closed', { pressed: 'maybe' }, 'Your PC may have pressed Pay (whether it did is not known), and then the Chrome window on your PC was closed, so I cannot see how it ended.'],
    ['slept', {}, 'Your PC may have pressed Pay (whether it did is not known), and then your PC went to sleep, so it stopped there.'],
    ['gone', {}, 'Your PC may have pressed Pay (whether it did is not known), and then the tool on your PC stopped without saying how it ended.'],
  ]) {
    const m = await payPressed('maybe');
    note(m, how, extra);
    await settle();
    assert.deepEqual(rest(m.tg.last()), [first, PAID_UNKNOWN], how);
  }
  const quiet = await payPressed('maybe');
  quiet.clock.t += 14 * 60000;
  await quiet.app.tick();
  assert.deepEqual(rest(quiet.tg.last()), ['Your PC may have pressed Pay (whether it did is not known), and I have heard nothing more from your PC about this.', PAID_UNKNOWN]);
  assert.deepEqual(note(quiet, 'held', { beat: true, pay: 'maybe', left: 0 }), { ok: true });         // never "let it go"
  // Booked after all: said as booked, with what is not known left as that.
  const b = await payPressed('maybe');
  note(b, 'booked', { words: '', pressed: 'maybe' });
  await settle();
  assert.deepEqual(rest(b.tg.last()), ['<b>Booked.</b> It is on your Bookings page at Glasgow Club now, and was not before. Your PC could not tell whether its press of Pay had gone through; your banking app shows what was paid.']);
});

test('the bot restarted between the press and the ending: a note that says Pay was pressed is passed on to you in a message, not dropped', async () => {
  const t = await payPressed();
  const fresh = makeApp(`${TUE}T12:05:00Z`, PINNED);                                             // the same bot after a redeploy: it knows no hold
  const beat = { id: t.id, key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', beat: true, price: '£23.00', pay: 'pressed', left: 4 * 60000 };
  // The PC's next beat: nothing can be ordered, but you hear of it, once.
  assert.deepEqual(fresh.app.holdFromAgent(beat), { ok: true, unknown: true });
  await settle();
  assert.equal(fresh.tg.calls.length, 1);
  assert.deepEqual([fresh.tg.last().method, fresh.tg.last().chat], ['send', OWNER]);
  assert.deepEqual(fresh.tg.last().text.split('\n'), [
    TITLE,
    'I am no longer following this hold (I was restarted while your PC had it, or had given it up), so its card does not change any more. This is what your PC says:',
    'Your PC pressed Pay, and it is waiting for Glasgow Club\'s answer. If your bank asks you to approve the payment, that is yours to do in your banking app.',
    `${PAID_UNKNOWN} I will say here how it ended, if your PC tells me.`,
  ]);
  assert.deepEqual(texts(fresh.tg.last()), ['Open Glasgow Club', 'Menu']);
  for (let i = 0; i < 5; i++) assert.deepEqual(fresh.app.holdFromAgent(beat), { ok: true, unknown: true });   // a beat every four seconds
  await settle();
  assert.equal(fresh.tg.calls.length, 1);
  // The ending: said once more, in the words the card would have had.
  const ending = { id: t.id, key: 'g', date: FRI, start: 1080, court: 3, stage: 'unsure', words: '', checked: true, basket: 'still', pressed: true };
  assert.deepEqual(fresh.app.holdFromAgent(ending), { ok: true, unknown: true });
  assert.deepEqual(fresh.app.holdFromAgent(ending), { ok: true, unknown: true });                 // the PC tries an ending up to four times
  assert.deepEqual(fresh.app.holdFromAgent({ id: t.id, stage: 'gone' }), { ok: true, unknown: true });   // and its link's "the tool has gone" follows
  await settle();
  assert.equal(fresh.tg.calls.length, 2);
  assert.deepEqual(fresh.tg.last().text.split('\n').slice(0, 3), [
    TITLE,
    'I am no longer following this hold (I was restarted while your PC had it, or had given it up), so its card does not change any more. This is what your PC says:',
    'Your PC pressed Pay, and the payment page never moved on, but I could not see the court as a new booking on your Bookings page.',
  ]);
  assert.match(fresh.tg.last().text, /Look in your banking app too/);
  assert.ok(fresh.logs.some(l => /A hold I am not following ended \(unsure\), and your PC says Pay was pressed for it: told you so\./.test(l)));
  // The ending is the first thing heard after the restart: booked and paid, said once.
  const later = makeApp(`${TUE}T12:05:00Z`, PINNED);
  later.app.holdFromAgent({ id: t.id, key: 'g', date: FRI, start: 1080, court: 3, stage: 'booked', words: 'Thank you', pressed: true });
  await settle();
  assert.deepEqual(later.tg.last().text.split('\n').slice(2), ['<b>Booked and paid.</b> Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.', 'After the payment the page said: “Thank you”']);
  // The tool was stopped after the restart: the link's "gone" says nothing of a press, but an earlier beat did.
  const stopped = makeApp(`${TUE}T12:05:00Z`, PINNED);
  stopped.app.holdFromAgent({ ...beat, pay: 'maybe' });
  stopped.app.holdFromAgent({ id: t.id, stage: 'gone', why: 'the booking tool was still running after twenty-eight minutes, so it was stopped' });
  await settle();
  assert.equal(stopped.tg.calls.length, 2);
  assert.deepEqual(stopped.tg.last().text.split('\n').slice(0, 1).concat(stopped.tg.last().text.split('\n').slice(2)), [
    TITLE,
    'Your PC may have pressed Pay (whether it did is not known), and then the tool on your PC stopped without saying how it ended (the booking tool was still running after twenty-eight minutes, so it was stopped).',
    PAID_UNKNOWN,
  ]);
  // Telegram will not take the message: it is tried again.
  const flaky = makeApp(`${TUE}T12:05:00Z`, PINNED);
  flaky.tg.failSend = 1;
  flaky.app.holdFromAgent(ending);
  await new Promise(r => setTimeout(r, 3100));
  assert.equal(flaky.tg.calls.length, 1);
  assert.ok(flaky.logs.some(l => /Could not tell you about that hold: network down/.test(l)));
});

test('a note about a hold this bot does not know that says nothing of a press is still left alone, and so is one that does not read as a hold', async () => {
  const fresh = makeApp(`${TUE}T12:05:00Z`, PINNED);
  for (const raw of [
    { id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', beat: true, price: '£23.00' },
    { id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', beat: true, pay: 'ready' },
    { id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', beat: true, pay: 'failed', payWhy: 'x' },
    { id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'released', basket: 'empty', removed: 1, why: 'time' },
    { id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'closed' },
    { id: 'a1b2c3d4e5f6', stage: 'gone' },
    { id: 'a1b2c3d4e5f6', stage: 'signing-in', pay: 'pressed', pressed: 'yes' },                   // not a step at which Pay can have been pressed, and not a word for it
    { id: '<b>not an id</b>', stage: 'booked', pressed: true },
    null, 7, {},
  ]) assert.deepEqual(fresh.app.holdFromAgent(raw), { ok: true, unknown: true });
  await settle();
  assert.equal(fresh.tg.calls.length, 0);
  // A note with a press but without a court that reads as one: you are still told, without a made-up court.
  fresh.app.holdFromAgent({ id: 'a1b2c3d4e5f6', key: 'toString', date: 'soon', start: -1, court: 99, stage: 'closed', pressed: true });
  await settle();
  assert.equal(fresh.tg.calls.length, 1);
  assert.equal(fresh.tg.last().text.split('\n')[0], '<b>A court your PC was holding</b>');
  assert.match(fresh.tg.last().text, /Your PC pressed Pay, and then the Chrome window on your PC was closed/);
  // A bot with no owner at all has nobody to tell.
  const ownerless = makeApp(`${TUE}T12:05:00Z`, { store: memStore(null) });
  ownerless.app.holdFromAgent({ id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'booked', pressed: true });
  await settle();
  assert.equal(ownerless.tg.calls.length, 0);
});

// ---------- who may spend ----------

test('Pay is offered, and taken, only when the bot is locked to you by TELEGRAM_CHAT_ID: an owner from the saved settings alone cannot spend', async () => {
  const t = await started();                                                                     // the owner comes from the saved settings; no TELEGRAM_CHAT_ID
  assert.deepEqual(heldReady(t), { ok: true });
  await settle();
  assert.deepEqual(texts(t.tg.last()), ['Open my basket', 'I have paid', 'Let it go']);          // no Pay button
  assert.equal(t.tg.last().text.split('\n')[2], 'Paying from your PC is not on: this bot is not locked to you, so whoever came to own it could spend from your card. Add the variable TELEGRAM_CHAT_ID = 42 in Railway.');
  assert.ok(t.logs.some(l => /is in the basket \(£23\.00\); your PC could pay for it, but Pay is not offered without TELEGRAM_CHAT_ID\.$/.test(l)));
  // The taps themselves (from an old card, or made up) are refused, and no order to pay ever goes to the PC.
  for (const data of [`gy:${t.id}`, `gz:${t.id}:2300`, `gy:${t.id}`, `gz:${t.id}:2300`]) {
    await tap(t.app, data, 7);
    assert.equal(lastAnswer(t), 'Paying needs this bot locked to you: set TELEGRAM_CHAT_ID in Railway.', data);
    assert.deepEqual(note(t, 'held', { beat: true }), { ok: true });
  }
  // Everything else about the hold works as ever.
  await tap(t.app, `gx:${t.id}`, 7);
  assert.equal(lastAnswer(t), 'Letting it go');
  assert.deepEqual(note(t, 'held', { beat: true }), { ok: true, order: 'release' });
});

test('the saved settings lost and no TELEGRAM_CHAT_ID: whoever sends /start first owns the bot, and still cannot spend from your card', async () => {
  const STRANGER = 666;
  const t = makeApp(`${TUE}T12:00:00Z`, { store: memStore(null) });
  await t.app.handleUpdate(say(STRANGER, '/start'));
  assert.equal(t.app.owner(), STRANGER);                                                         // as it has always been, for a bot that is not locked
  await t.app.pingFromAgent({ ip: '81.2.69.142' });
  const ping = t.app.pingFromAgent({ ip: '81.2.69.142' }, { wait: 5 });
  await tap(t.app, HOLD, 7, { chat: STRANGER });
  const id = (await ping).hold.id;
  await settle();
  t.app.holdFromAgent({ id, key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', price: '£23.00', left: 12 * 60000, pay: 'ready' });
  await settle();
  assert.deepEqual(texts(t.tg.last()), ['Open my basket', 'I have paid', 'Let it go']);
  for (const data of [`gy:${id}`, `gz:${id}:2300`]) {
    await tap(t.app, data, 7, { chat: STRANGER });
    assert.equal(lastAnswer(t), 'Paying needs this bot locked to you: set TELEGRAM_CHAT_ID in Railway.');
  }
  assert.deepEqual(t.app.holdFromAgent({ id, key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', beat: true }), { ok: true });
  // With TELEGRAM_CHAT_ID set, a stranger is not the owner at all, and the owner's Pay works.
  const locked = makeApp(`${TUE}T12:00:00Z`, { ...PINNED, store: memStore(null) });
  await locked.app.handleUpdate(say(STRANGER, '/start'));
  assert.equal(locked.app.owner(), OWNER);
});
