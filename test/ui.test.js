'use strict';
// The tap-through screens and what each button does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const UI = require('../lib/ui');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT

function makeApp(t0, state = { owner: OWNER, order: [3, 4, 5, 2, 1, 6] }) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const app = createApp({ now: () => clock.t, tg, store: memStore(state), pictures: PICTURES, linked: true });
  return { app, tg, clock };
}
// A tap on a button of the card with this id.
let tapId = 1;
const tap = (app, data, messageId, chat = OWNER) => app.handleUpdate({
  update_id: 1, callback_query: { id: String(tapId++), data, from: { id: chat }, message: { message_id: messageId, chat: { id: chat, type: 'private' } } },
});
const buttons = call => call.extra.reply_markup.inline_keyboard.flat();
const find = (call, text) => buttons(call).find(b => b.text === text);
const allData = call => buttons(call).map(b => b.callback_data);

test('every button fits in Telegram\'s 64 bytes and every screen caption in 1024 characters', () => {
  const ctx = { cfg: { plan: { tue: { start: 960, hours: 2 } }, once: [{ date: '2026-11-25', start: 1140, hours: 2 }], order: [3, 4, 5, 2, 1, 6], releaseMin: 1320, daysAhead: 7 }, now: at(`${TUE}T12:00:00Z`), paused: false, results: {}, lastSeen: null, linked: true };
  const screens = [UI.home(ctx), UI.calendar(ctx), UI.times(ctx, '2026-11-25'), UI.lengths(ctx, '2026-11-25', 1140), UI.confirmOnce(ctx, '2026-11-25', 1140, 2),
    UI.added(ctx, '2026-11-25', 1140, 2), UI.weekly(ctx), UI.weeklyDay(ctx, 'tue'), UI.weeklyTimes(ctx, 'wed'), UI.weeklyLengths(ctx, 'wed', 1140), UI.bookings(ctx), UI.order(ctx, '34')];
  for (const s of screens) {
    assert.ok(s.caption.length <= 1024, s.caption);
    for (const b of s.keyboard.inline_keyboard.flat()) {
      assert.ok(b.text.length > 0);
      assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    }
  }
});

test('the calendar: past days are blanked, booked days marked, months limited to 90 days ahead', () => {
  const ctx = { cfg: { plan: {}, once: [{ date: '2026-11-25', start: 1140, hours: 2 }], order: [1, 2, 3, 4, 5, 6], releaseMin: 1320, daysAhead: 7 }, now: at(`${TUE}T12:00:00Z`), paused: false, results: {} };
  const s = UI.calendar(ctx);
  const rows = s.keyboard.inline_keyboard;
  assert.deepEqual(rows[0].map(b => b.text), ['·', 'November 2026', '›']);        // cannot go back before this month
  const days = rows.slice(2, -1).flat();
  assert.equal(days.length % 7, 0);
  assert.equal(days.find(b => b.callback_data === 'd:20261117').text, '17');          // today can be picked
  assert.ok(!days.some(b => b.callback_data === 'd:20261116'));                      // yesterday cannot
  assert.equal(days.find(b => b.callback_data === 'd:20261125').text, '25•');         // already booked
  assert.equal(days.indexOf(days.find(b => b.callback_data === 'd:20261117')), 22);    // 1 Nov is a Sunday: six blanks, then 1 to 16 greyed out
  assert.match(s.caption, /Days up to Mon 23 Nov are open now/);
  // February 2027 is more than 90 days away: no way forward from January.
  assert.equal(UI.calendar(ctx, Date.UTC(2027, 1, 1, 12)).keyboard.inline_keyboard[0][2].text, '·');
});

test('booking a date by tapping: menu, calendar, day, time, length, add', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await app.handleUpdate(say(OWNER, '/menu'));
  const menu = tg.last();
  assert.equal(menu.method, 'photo');
  assert.equal(menu.photo, 'upload:banner-wait.jpg');
  assert.match(menu.text, /Court booker/);
  const card = menu.id;
  await tap(app, find(menu, 'Book a date').callback_data, card);
  assert.equal(tg.last().method, 'caption');                                          // the same card changes
  assert.equal(tg.last().id, card);
  await tap(app, 'd:20261125', card);
  assert.match(tg.last().text, /^<b>Wed 25 Nov<\/b>\nOpens Wed 18 Nov at 22:00; your PC books it then/);
  await tap(app, find(tg.last(), '19:00').callback_data, card);
  assert.deepEqual(buttons(tg.last()).map(b => b.text).slice(0, 2), ['1 hour · 19:00–20:00', '2 hours · 19:00–21:00']);
  await tap(app, 'l:20261125:1900:2', card);
  assert.match(tg.last().text, /Book Wed 25 Nov · 19:00–21:00\?/);
  await tap(app, 'ok:20261125:1900:2', card);
  assert.match(tg.last().text, /Added · Wed 25 Nov · 19:00–21:00/);
  assert.deepEqual(app.state.once, [{ date: '2026-11-25', start: 1140, hours: 2 }]);
  assert.equal(tg.answers.at(-1), 'Added');
  // Tapping Add again (an old card) does not add it twice.
  await tap(app, 'ok:20261125:1900:2', card);
  assert.equal(tg.answers.at(-1), 'Already on your list');
  assert.equal(app.state.once.length, 1);
  // Only one card was ever sent; everything else edited it.
  assert.equal(tg.calls.filter(c => c.method === 'photo').length, 1);
});

test('today only offers times still ahead, and a time that has passed cannot be added', async () => {
  const { app, tg } = makeApp(`${TUE}T17:30:00Z`);
  await app.handleUpdate(say(OWNER, '/book'));
  await tap(app, 'd:20261117', tg.last().id);
  assert.deepEqual(allData(tg.last()).filter(d => d.startsWith('t:')), ['t:20261117:1800', 't:20261117:1900', 't:20261117:2000']);
  await tap(app, 'ok:20261117:1000:1', tg.last().id);
  assert.match(tg.answers.at(-1), /no longer available/);
  assert.equal(app.state.once.length, 0);
});

test('weekly days by tapping: set, change, stop', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await app.handleUpdate(say(OWNER, '/set'));
  const card = tg.last().id;
  assert.match(tg.last().text, /Every week/);
  await tap(app, 'wd:fri', card);                                                     // not set yet: straight to times
  await tap(app, 'wt:fri:1600', card);
  await tap(app, 'wl:fri:1600:2', card);
  assert.deepEqual(app.state.plan, { fri: { start: 960, hours: 2 } });
  assert.match(tg.last().text, /Fridays · 16:00–18:00 saved/);
  await tap(app, 'w', card);
  assert.equal(find(tg.last(), 'Fri · 16:00–18:00').callback_data, 'wd:fri');
  await tap(app, 'wd:fri', card);
  assert.deepEqual(buttons(tg.last()).map(b => b.text), ['Change the time', 'Stop Fridays', 'Back', 'Menu']);
  await tap(app, 'woff:fri', card);
  assert.deepEqual(app.state.plan, {});
  assert.equal(tg.answers.at(-1), 'Stopped Fridays');
});

test('my bookings has a Remove button for each one-off', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`, { owner: OWNER, plan: { tue: { start: 960, hours: 2 } }, once: [{ date: '2026-11-25', start: 1140, hours: 2 }, { date: '2026-11-27', start: 600, hours: 1 }] });
  await app.handleUpdate(say(OWNER, '/plan'));
  const card = tg.last().id;
  assert.deepEqual(buttons(tg.last()).map(b => b.text).slice(0, 3), ['Remove Wed 25 Nov 19:00', 'Remove Fri 27 Nov 10:00', 'Stop Tuesdays']);
  await tap(app, 'x:20261125:1900', card);
  assert.deepEqual(app.state.once.map(o => o.date), ['2026-11-27']);
  assert.match(tg.last().text, /^<b>Removed Wed 25 Nov · 19:00–21:00<\/b>/);
});

test('court order by tapping courts in turn', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await app.handleUpdate(say(OWNER, '/order'));
  const card = tg.last().id;
  await tap(app, 'o:4', card);
  await tap(app, 'o:45', card);
  assert.match(tg.last().text, /New: 4, 5, then the rest/);
  assert.equal(find(tg.last(), 'Court 4 · 1st').callback_data, 'noop');
  await tap(app, 'os:45', card);
  assert.deepEqual(app.state.order, [4, 5, 1, 2, 3, 6]);
  await tap(app, 'os:455', card);                                                    // a court twice: ignored
  assert.deepEqual(app.state.order, [4, 5, 1, 2, 3, 6]);
});

test('pause from the menu, and booking messages open a new card so they stay', async () => {
  const { app, tg } = makeApp(`${TUE}T22:00:10Z`);
  await app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  const booked = tg.last();
  assert.deepEqual(allData(booked), ['n:m', 'n:h']);
  await tap(app, 'n:h', booked.id);
  assert.equal(tg.last().method, 'photo');                                           // a new card, not an edit
  assert.notEqual(tg.last().id, booked.id);
  await tap(app, 'p', tg.last().id);
  assert.equal(app.state.paused, true);
  assert.match(tg.last().text, /Booking is paused/);
  assert.equal(find(tg.last(), 'Resume booking').callback_data, 'p');
});

test('taps from anyone else are refused, and an old text message gets a new card', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await tap(app, 'p', 5, 999);
  assert.equal(app.state.paused, false);
  assert.equal(tg.answers.at(-1), 'This bot is private.');
  tg.failEdit = { code: 400, message: 'Bad Request: there is no caption in the message to edit', once: true };
  await tap(app, 'h', 7);
  assert.equal(tg.last().method, 'photo');
});
