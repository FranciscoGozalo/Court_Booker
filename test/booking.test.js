'use strict';
// Version 2: booking requests, what the PC is told to book, and the messages about it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, loadState, backupLine } = require('../app');
const { parseDate, parseBooking, parseSlot } = require('../lib/plan');
const { jobsFor, missingFor, upcoming } = require('../lib/schedule');
const { civil, iso } = require('../lib/time');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
// Tuesday 17 Nov 2026, UK on GMT. Kelvingrove opens a day 7 days ahead at 22:00.
const TUE = '2026-11-17';
const cfgWith = (plan = {}, once = []) => ({ plan, once, order: [3, 4, 5, 2, 1, 6], releaseMin: 22 * 60, daysAhead: 7 });

function makeApp(t0, { state = { owner: OWNER }, linked = true } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const app = createApp({ now: () => clock.t, tg, store: memStore(state), pictures: PICTURES, linked });
  return { app, tg, clock };
}
const send = (app, text) => app.handleUpdate(say(OWNER, text));

// ---------- reading dates and slots ----------

test('one-off dates in the ways people write them', () => {
  const today = civil(2026, 11, 17);   // a Tuesday
  const d = s => { const c = parseDate(s.split(' '), today); return c === null ? null : iso(c); };
  assert.equal(d('2026-11-25'), '2026-11-25');
  assert.equal(d('25/11'), '2026-11-25');
  assert.equal(d('25 nov'), '2026-11-25');
  assert.equal(d('nov 25'), '2026-11-25');
  assert.equal(d('25th november'), '2026-11-25');
  assert.equal(d('wed 25 nov'), '2026-11-25');
  assert.equal(d('wed'), '2026-11-18');
  assert.equal(d('tue'), '2026-11-17');            // today counts
  assert.equal(d('tomorrow'), '2026-11-18');
  assert.equal(d('3 jan'), '2027-01-03');          // no year: the next one
  assert.equal(d('31 nov'), null);
  assert.equal(d('someday'), null);
});

test('a /book line splits into date and slot, even when the date ends in a number', () => {
  const today = civil(2026, 11, 17);
  const b = s => { const r = parseBooking(s.split(' '), today); return 'date' in r ? `${iso(r.date)} ${r.start} ${r.hours}` : `why:${r.why}`; };
  assert.equal(b('25 nov 19:00 2h'), '2026-11-25 1140 2');
  assert.equal(b('nov 5 19:00'), '2026-11-05 1140 1'.replace('2026-11-05', '2027-11-05'));   // 5 Nov has passed this year
  assert.equal(b('wed 7pm 2h'), '2026-11-18 1140 2');
  assert.equal(b('wed 19:00-21:00'), '2026-11-18 1140 2');
  assert.equal(b('wed 19:30'), '2026-11-18 1170 1');
  assert.equal(b('wed 19:15'), 'why:Slots start on the hour. Try a time like 19:00.');
  assert.equal(b('wed'), 'why:null');
  assert.deepEqual(parseSlot(['19:00-22:00']), { why: 'A booking can be one hour or two.' });
});

// ---------- what the PC is told to book ----------

test('a weekly day is booked at the release 7 days before; a one-off too', () => {
  const c = cfgWith({ tue: { start: 960, hours: 2 } }, [{ date: '2026-11-24', start: 1200, hours: 1 }]);
  const jobs = jobsFor(at(`${TUE}T21:55:00Z`), c, {});
  assert.deepEqual(jobs.map(j => j.id), ['2026-11-24@16:00', '2026-11-24@20:00']);
  assert.equal(jobs[0].releaseAt, at(`${TUE}T22:00:00Z`));
  assert.equal(jobs[0].end, 18 * 60);
  // The next night the weekly Tuesday is not chased, but the one-off on the now-open 24th is.
  assert.deepEqual(jobsFor(at('2026-11-18T21:55:00Z'), c, {}).map(j => j.id), ['2026-11-24@20:00']);
  // Nothing once it is booked.
  assert.deepEqual(jobsFor(at(`${TUE}T21:55:00Z`), c, { '2026-11-24@16:00': { status: 'booked' } }).map(j => j.id), ['2026-11-24@20:00']);
});

test('a one-off date that is already open is booked straight away; a weekly day is not', () => {
  const c = cfgWith({ fri: { start: 960, hours: 2 } }, [{ date: '2026-11-20', start: 1140, hours: 2 }]);
  const jobs = jobsFor(at(`${TUE}T12:00:00Z`), c, {});
  assert.deepEqual(jobs.map(j => j.id), ['2026-11-20@19:00']);           // Fri 20 opened on Fri 13; the weekly Friday is not chased
  assert.ok(jobs[0].releaseAt < at(`${TUE}T12:00:00Z`));
  // Once the slot has started it is too late; only that night's weekly release is left.
  assert.deepEqual(jobsFor(at('2026-11-20T19:00:00Z'), c, {}).map(j => j.id), ['2026-11-27@16:00']);
});

test('summer time: the release is 22:00 UK, 21:00 UTC', () => {
  const c = cfgWith({ fri: { start: 960, hours: 2 } });
  const [job] = jobsFor(at('2026-07-10T20:55:00Z'), c, {});
  assert.equal(job.date, '2026-07-17');
  assert.equal(job.releaseAt, at('2026-07-10T21:00:00Z'));
});

test('the PC is missed only if it has not been in touch shortly before the release', () => {
  const c = cfgWith({ tue: { start: 960, hours: 2 } });
  assert.equal(missingFor(at(`${TUE}T21:57:00Z`), c, null), null);                        // too early to worry
  assert.ok(missingFor(at(`${TUE}T21:58:30Z`), c, null));                                   // 90 s to go, nothing heard
  assert.equal(missingFor(at(`${TUE}T21:58:30Z`), c, at(`${TUE}T21:55:10Z`)), null);        // it checked in
  assert.ok(missingFor(at(`${TUE}T21:58:30Z`), c, at(`${TUE}T20:00:00Z`)));                 // only hours ago: missing
  assert.equal(upcoming(at(`${TUE}T23:00:00Z`), c, 1)[0].night, civil(2026, 11, 24));
});

// ---------- the bot ----------

test('/set, /book, /plan and /cancel', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await send(app, '/set tue 16:00 2h');
  assert.match(tg.last().text, /Tuesdays · 16:00–18:00/);
  await send(app, '/book 25 nov 19:00 2h');
  assert.match(tg.last().text, /Wed 25 Nov · 19:00–21:00/);
  assert.match(tg.last().text, /Booked when it opens: Wed 18 Nov at 22:00/);
  await send(app, '/book fri 19:00');                                         // Fri 20 Nov: already open
  assert.match(tg.last().text, /already open/);
  await send(app, '/book 25 nov 19:00');
  assert.match(tg.last().text, /already on your list/);
  await send(app, '/plan');
  const plan = tg.last().text;
  assert.match(plan, /Tuesdays · 16:00–18:00/);
  assert.match(plan, /1\. Fri 20 Nov · 19:00–20:00 \(open now/);
  assert.match(plan, /2\. Wed 25 Nov · 19:00–21:00 \(opens Wed 18 Nov 22:00\)/);
  assert.match(plan, /Next booking: Tue 17 Nov at 22:00/);
  await send(app, '/cancel 1');
  assert.match(tg.last().text, /Removed Fri 20 Nov · 19:00–20:00/);
  assert.equal(app.state.once.length, 1);
  await send(app, '/book today 10:00');
  assert.match(tg.last().text, /already passed/);
  await send(app, '/book 2026-11-10 19:00');
  assert.match(tg.last().text, /already passed/);
  await send(app, '/free');
  assert.match(tg.last().text, /old link alerts/);
});

test('the PC checking in gets its jobs and a heads-up card on the awake banner, once', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:55:00Z`, { state: { owner: OWNER, plan: { tue: { start: 960, hours: 2 } }, order: [3, 4, 5, 2, 1, 6] } });
  const got = app.jobsForAgent();
  assert.deepEqual(got.jobs.map(j => j.id), ['2026-11-24@16:00']);
  assert.deepEqual(got.order, [3, 4, 5, 2, 1, 6]);
  await new Promise(r => setImmediate(r));
  const card = tg.last();
  assert.equal(card.method, 'photo');
  assert.equal(card.photo, 'upload:banner-home-awake.jpg');
  assert.match(card.text, /Booking at 22:00\n<b>Tue 24 Nov · 16:00–18:00<\/b>/);
  clock.t += 30000;
  app.jobsForAgent();                                                             // asking again: no second card
  await new Promise(r => setImmediate(r));
  assert.equal(tg.calls.filter(c => c.method === 'photo').length, 1);
  // No warning, because the PC has been in touch.
  clock.t = at(`${TUE}T21:58:30Z`);
  await app.tick();
  assert.equal(tg.calls.length, 1);
});

test('a booking result arrives as a card on the booked banner with the gate code', async () => {
  const { app, tg } = makeApp(`${TUE}T22:00:10Z`);
  const r = await app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  assert.deepEqual(r, { ok: true });
  const card = tg.last();
  assert.equal(card.method, 'photo');
  assert.equal(card.photo, 'upload:banner-booked.jpg');
  assert.equal(card.text, '<b>Booked · Court 3</b>\nTue 24 Nov · 16:00–18:00\nGate code: <code>2433</code>  (tap to copy)');
  // The same result again (the PC retrying) is not sent twice; a later failure does not undo it.
  await app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  await app.resultFromAgent({ id: '2026-11-24@16:00', status: 'failed', why: 'x', end: 1080 });
  assert.equal(tg.calls.length, 1);
  assert.equal(app.state.results['2026-11-24@16:00'].court, '3');
  // The second time Telegram is given the picture's id, not the file.
  await app.resultFromAgent({ id: '2026-11-25@19:00', status: 'booked', court: 4, end: 1260 });
  assert.equal(tg.last().photo, 'id:banner-booked.jpg');
  assert.match(tg.last().text, /Gate code: not shown/);
});

test('a failed booking is a card on the not-booked banner saying why; nonsense is refused', async () => {
  const { app, tg } = makeApp(`${TUE}T22:05:00Z`);
  await app.resultFromAgent({ id: '2026-11-24@19:00', status: 'none', end: 1260 });
  assert.equal(tg.last().method, 'photo');
  assert.equal(tg.last().photo, 'upload:banner-missed.jpg');
  assert.deepEqual(tg.last().extra.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['n:b', 'n:h']);
  assert.match(tg.last().text, /Not booked · Tue 24 Nov · 19:00–21:00<\/b>\nNo court free for the whole time/);
  assert.equal((await app.resultFromAgent({ id: 'nope', status: 'booked', court: 3 })).ok, false);
  assert.equal((await app.resultFromAgent({ id: '2026-11-24@19:00', status: 'booked' })).ok, false);   // no court
});

test('if Telegram fails, the result is not recorded, so the PC can send it again', async () => {
  const { app, tg } = makeApp(`${TUE}T22:00:10Z`);
  tg.failSend = 1;
  await assert.rejects(app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 }));
  assert.equal(app.state.results['2026-11-24@16:00'], undefined);
  await app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, gate: '2433', end: 1080 });
  assert.equal(tg.calls.length, 1);
});

test('a PC that has not checked in is warned about once, two minutes before', async () => {
  // Last heard from at tea time: asleep or off. (The check 20 minutes before is in safety.test.js.)
  const { app, tg, clock } = makeApp(`${TUE}T21:57:00Z`, { state: { v: 4, owner: OWNER, plan: { tue: { start: 960, hours: 2 } }, lastSeen: at(`${TUE}T18:00:00Z`) } });
  await app.tick();
  assert.equal(tg.calls.length, 0);
  clock.t = at(`${TUE}T21:58:00Z`);
  await app.tick();
  assert.match(tg.last().text, /Your PC has not checked in/);
  clock.t += 1000;
  await app.tick();
  assert.equal(tg.calls.length, 1);
  // Without a PC link (no AGENT_TOKEN) there is nothing to warn about.
  const b = makeApp(`${TUE}T21:58:00Z`, { state: { owner: OWNER, plan: { tue: { start: 960, hours: 2 } } }, linked: false });
  await b.app.tick();
  assert.equal(b.tg.calls.length, 0);
});

test('a PC asking hours before the release gets its jobs but no heads-up yet', async () => {
  const { app, tg } = makeApp(`${TUE}T15:00:00Z`, { state: { owner: OWNER, plan: { tue: { start: 960, hours: 2 } } } });
  assert.equal(app.jobsForAgent().jobs.length, 1);
  await new Promise(r => setImmediate(r));
  assert.equal(tg.calls.length, 0);
});

test('paused: the PC is told there is nothing to book', () => {
  const { app } = makeApp(`${TUE}T21:55:00Z`, { state: { owner: OWNER, plan: { tue: { start: 960, hours: 2 } }, paused: true } });
  assert.deepEqual(app.jobsForAgent().jobs, []);
});

test('settings saved by version 1 keep the owner, weekly plan and order; old banners are dropped', () => {
  const old = { v: 3, owner: OWNER, plan: { thu: { start: 1140, hours: 2 } }, order: [4, 3, 5, 2, 6, 1], sid: 'x', style: 'card', live: { night: 'x' }, pics: { open: { hash: 'h', id: 'i' }, booked: { hash: 'h2', id: 'i2' } } };
  const s = loadState(old);
  assert.equal(s.owner, OWNER);
  assert.deepEqual(s.plan, { thu: { start: 1140, hours: 2 } });
  assert.deepEqual(s.order, [4, 3, 5, 2, 6, 1]);
  assert.deepEqual(s.once, []);
  assert.deepEqual(s.pics, { booked: { hash: 'h2', id: 'i2' } });     // "open" was a banner of version 2.0
  assert.equal(s.style, undefined);
  assert.match(backupLine(s), /"once":\[\]/);
});

test('past one-off dates drop off the list', async () => {
  const { app, clock } = makeApp(`${TUE}T12:00:00Z`, { state: { owner: OWNER, once: [{ date: '2026-11-17', start: 600, hours: 1 }, { date: '2026-11-25', start: 1140, hours: 2 }] } });
  clock.t = at('2026-11-18T00:00:05Z');
  await app.tick();
  assert.deepEqual(app.state.once.map(o => o.date), ['2026-11-25']);
});
