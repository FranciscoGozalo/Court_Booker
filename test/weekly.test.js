'use strict';
// Weekly bookings at any venue, Glasgow Club's midnight bookings paid by your PC, and the switch
// for automatic payments (version 2.10, docs/app-api.md). A night with only Kelvingrove in it is
// as it always was: its jobs, its words and its release are the ones 2.9 had.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp, loadState } = require('../app');
const S = require('../lib/schedule');
const P = require('../lib/plan');
const W = require('../lib/allowance');
const V = require('../lib/venues');
const A = require('../lib/appapi');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const NOON = `${TUE}T12:00:00Z`;
const HOME = { ip: '81.2.69.142' };
const KEY = crypto.randomBytes(32).toString('base64');
const VISA = { brand: 'Visa', last4: '4242', expMonth: 12, expYear: 2028 };
const sealedOf = (n = 60) => crypto.randomBytes(32 + 24 + 16 + n).toString('base64');
const settle = () => new Promise(r => setTimeout(r, 5));
const CFG = { releaseMin: 22 * 60, daysAhead: 7 };

function makeBot(t0 = NOON, { state = {}, env = {} } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const logs = [], pushes = [];
  const store = memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], ...state });
  const glasgow = { asked: [], day: async () => ({ at: clock.t, slots: [], listed: 0 }), peek: () => null, health: () => null };
  const app = createApp({ now: () => clock.t, tg, store, pictures: PICTURES, linked: true, env, glasgow, log: l => logs.push(l),
    push: async (tokens, message) => { pushes.push({ tokens, ...message }); }, wake: async () => 3 });
  return { app, tg, clock, store, logs, pushes };
}
async function linkPhone(t) {
  await t.app.handleUpdate(say(OWNER, '/app'));
  const code = /Code: <code>(\d{6})<\/code>/.exec(t.tg.last().text)[1];
  const r = t.app.appPair({ code, name: 'Test phone' });
  await settle();
  return { device: t.app.appAuth(r.body.token) };
}
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);
const refused = (status, why) => ({ status, body: { ok: false, why } });
const state = (t, phone) => t.app.appState(phone.device).state;

// ---------- the schedule ----------

test('a schedule with only Kelvingrove in it gives the very jobs, releases and ids 2.9 gave', () => {
  const plan = { thu: { start: 1140, hours: 2 } };
  const once = [{ date: '2026-11-27', start: 600, hours: 1 }];
  const old = { ...CFG, plan, once };                                         // as 2.9 read it
  const now = { ...CFG, plan: P.planOf(P.weeklyFromPlan(plan)), weekly: P.weeklyFromPlan(plan), once, away: [] };     // as 2.10 does
  for (const t of [`${TUE}T21:55:00Z`, '2026-11-19T21:58:00Z', '2026-11-20T21:59:00Z', '2026-11-21T09:00:00Z']) {
    assert.deepEqual(S.jobsFor(at(t), now), S.jobsFor(at(t), old), t);
    assert.deepEqual(S.upcoming(at(t), now, 4), S.upcoming(at(t), old, 4), t);
    assert.deepEqual(S.missingFor(at(t), now, null), S.missingFor(at(t), old, null), t);
    assert.deepEqual(S.msToNextCheck(at(t), now), S.msToNextCheck(at(t), old), t);
  }
  const [job] = S.jobsFor(at('2026-11-19T21:55:00Z'), now);
  assert.deepEqual(job, { id: '2026-11-26@19:00', date: '2026-11-26', start: 1140, end: 1260, hours: 2, kind: 'weekly', releaseAt: at('2026-11-19T22:00:00Z') });
});

test('every venue: the parks at 22:00 a week ahead (each with its id), Glasgow Club at the midnight after, 7 days ahead of that', () => {
  const weekly = P.cleanWeekly([
    { id: 'aaaaaaa1', venue: 'kelvingrove', day: 'wed', start: 1080, hours: 1 },
    { id: 'aaaaaaa2', venue: 'queenspark', day: 'wed', start: 1080, hours: 2 },
    { id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1 },
    { id: 'aaaaaaa4', venue: 'scotstoun', type: 'outdoor', day: 'thu', start: 600, hours: 1 },
    { id: 'aaaaaaa5', venue: 'maryhill', day: 'wed', start: 1200, hours: 1, on: false },
  ]);
  const cfg = { ...CFG, plan: P.planOf(weekly), weekly, once: [], away: [] };
  // Tuesday 17 Nov, 21:55: tonight the parks open Tue 24 Nov... nothing on Tuesdays; Wednesday's open tomorrow night.
  // Wednesday 18 Nov, 21:55: the parks' 22:00 release opens Wed 25 Nov; the midnight after opens Glasgow Club's Thu 26 Nov.
  const jobs = S.jobsFor(at('2026-11-18T21:55:00Z'), cfg);
  assert.deepEqual(jobs.map(j => [j.id, j.venue || 'kelvingrove', j.releaseAt]), [
    ['2026-11-25@18:00', 'kelvingrove', at('2026-11-18T22:00:00Z')],
    ['queenspark/2026-11-25@18:00', 'queenspark', at('2026-11-18T22:00:00Z')],
    ['scotstoun/2026-11-26@10:00', 'scotstoun', at('2026-11-19T00:00:00Z')],
  ]);
  assert.equal(jobs[2].type, 'outdoor');
  // Tuesday night: Gorbals's Wednesday 18:00, a week on Wednesday, at the midnight into Wednesday 18 Nov.
  const tue = S.jobsFor(at(`${TUE}T21:55:00Z`), cfg);
  assert.deepEqual(tue.map(j => [j.id, j.releaseAt]), [['gorbals/2026-11-25@18:00', at('2026-11-18T00:00:00Z')]]);
  // The releases, the soonest first, Glasgow Club's among them.
  assert.deepEqual(S.upcoming(at(`${TUE}T12:00:00Z`), cfg, 3).map(r => [r.releaseAt, !!r.club, r.requests.map(q => q.id).join()]), [
    [at('2026-11-18T00:00:00Z'), true, 'gorbals/2026-11-25@18:00'],
    [at('2026-11-18T22:00:00Z'), false, '2026-11-25@18:00,queenspark/2026-11-25@18:00'],
    [at('2026-11-19T00:00:00Z'), true, 'scotstoun/2026-11-26@10:00'],
  ]);
  // When a venue's day opens.
  assert.equal(S.opensAtFor('gorbals', P.cleanWeekly && require('../lib/time').civil(2026, 11, 25), cfg), at('2026-11-18T00:00:00Z'));
  assert.equal(S.opensAtFor('queenspark', require('../lib/time').civil(2026, 11, 25), cfg), at('2026-11-18T22:00:00Z'));
});

test('the allowance counts the parks only: Glasgow Club\'s courts never use it up, and the run is handed theirs whatever the week holds', () => {
  const results = {};
  for (let d = 0; d < 7; d++) results[`2026-11-${23 + d}@09:00`] = { id: `2026-11-${23 + d}@09:00`, status: 'booked', date: `2026-11-${23 + d}`, start: 540, end: 600 };
  results['gorbals/2026-11-24@10:00'] = { id: 'gorbals/2026-11-24@10:00', status: 'booked', date: '2026-11-24', start: 600, end: 660, venue: 'gorbals' };
  assert.deepEqual(W.bookedIn(results, '2026-11-23'), { sessions: 7, hours: 7 });
  const jobs = [
    { id: 'gorbals/2026-11-25@18:00', venue: 'gorbals', type: 'indoor', date: '2026-11-25', start: 1080, end: 1140, releaseAt: 1 },
    { id: 'queenspark/2026-11-25@18:00', venue: 'queenspark', type: 'outdoor', date: '2026-11-25', start: 1080, end: 1140, releaseAt: 1 },
  ];
  const fit = W.fitJobs(jobs, results);
  assert.deepEqual(fit.keep.map(j => j.id), ['gorbals/2026-11-25@18:00']);
  assert.deepEqual(fit.skip.map(s => [s.job.id, s.why]), [['queenspark/2026-11-25@18:00', 'That would be 8 sessions in the week of Mon 23 Nov; the limit is 7.']]);
});

// ---------- the kept state ----------

test('Kelvingrove\'s plan of old becomes weekly entries, the same each time it is read, with the plan kept beside them', () => {
  const s = loadState({ v: 4, owner: OWNER, plan: { tue: { start: 960, hours: 2 }, thu: { start: 1140, hours: 1 } } });
  assert.deepEqual(s.weekly, [
    { id: 'f7de6e62', venue: 'kelvingrove', type: 'outdoor', day: 'tue', start: 960, hours: 2, on: true },
    { id: 'a8d74aef', venue: 'kelvingrove', type: 'outdoor', day: 'thu', start: 1140, hours: 1, on: true },
  ]);
  assert.deepEqual(s.plan, { tue: { start: 960, hours: 2 }, thu: { start: 1140, hours: 1 } });
  assert.deepEqual(loadState({ v: 4, plan: { tue: { start: 960, hours: 2 } } }).weekly[0].id, 'f7de6e62');
  // Once kept, the entries are what is read; the plan follows them.
  const kept = loadState({ v: 4, plan: { mon: { start: 600, hours: 1 } }, weekly: [{ id: '0123abcd', venue: 'gorbals', day: 'wed', start: 1080, hours: 2 }, { id: '0123abce', venue: 'kelvingrove', day: 'fri', start: 1140, hours: 1, on: false }] });
  assert.deepEqual(kept.weekly, [
    { id: '0123abcd', venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, on: true },
    { id: '0123abce', venue: 'kelvingrove', type: 'outdoor', day: 'fri', start: 1140, hours: 1, on: false },
  ]);
  assert.deepEqual(kept.plan, {});                                               // Kelvingrove's one entry is off
  // Whatever does not read as an entry is dropped; one venue, day and start once.
  assert.deepEqual(P.cleanWeekly([{ id: 'zz', venue: 'gorbals', day: 'wed', start: 1080 }, { id: '0000000a', venue: 'hampden', day: 'wed', start: 1080 },
    { id: '0000000b', venue: 'gorbals', day: 'xyz', start: 1080 }, { id: '0000000c', venue: 'gorbals', day: 'wed', start: 1080 }, { id: '0000000d', venue: 'gorbals', day: 'wed', start: 1080 }]).map(w => w.id), ['0000000c']);
});

// ---------- the app ----------

test('weekly bookings from the app: added at any venue, changed, switched off and on, removed; refused in plain words', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  let r = await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'wed', start: 1080, hours: 1 });
  assert.equal(r.status, 200);
  const [g] = r.body.state.weekly;
  assert.match(g.id, /^[0-9a-f]{8}$/);
  assert.deepEqual(g, { id: g.id, venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, end: 1140, on: true, next: { date: '2026-11-25', opensAt: at('2026-11-18T00:00:00Z') } });
  r = await ask(t, phone, 'weekly', { venue: 'queenspark', day: 'wed', start: 1080, hours: 2 });
  r = await ask(t, phone, 'weekly', { venue: 'kelvingrove', day: 'wed', start: 1080, hours: 1 });
  r = await ask(t, phone, 'weekly', { venue: 'kelvingrove', day: 'wed', start: 1200, hours: 1 });            // several a day
  assert.deepEqual(r.body.state.weekly.map(w => [w.venue, w.day, w.start]), [['kelvingrove', 'wed', 1080], ['queenspark', 'wed', 1080], ['gorbals', 'wed', 1080], ['kelvingrove', 'wed', 1200]]);
  assert.deepEqual(r.body.state.plan, [{ day: 'wed', start: 1080, hours: 1 }]);                               // the plan of old: Kelvingrove's first, one a day
  // Refused.
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'wed', start: 1080, hours: 1 }), refused(409, 'There is already a weekly booking at Gorbals on Wednesdays at 18:00.'));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'scotstoun', day: 'wed', start: 1080, hours: 1 }), refused(400, 'Scotstoun has indoor and outdoor courts: send type, indoor or outdoor.'));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'scotstoun', type: 'outdoor', day: 'wed', start: 1080, hours: 1 }), refused(400, 'Scotstoun\'s outdoor courts are open from 08:00 to 18:00.'));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'wed', start: 1080, hours: 2 }), refused(400, 'Glasgow Club courts are booked an hour at a time.'));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'maryhill', type: 'indoor', day: 'wed', start: 1080, hours: 1 }), refused(400, 'Maryhill Park has outdoor courts only.'));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'hampden', day: 'wed', start: 1080, hours: 1 }), refused(400, A.WHY.venue));
  assert.deepEqual(await ask(t, phone, 'weekly', { day: 'wed', start: 1080, hours: 1 }), refused(400, A.WHY.weekly));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'wed', start: 1110, hours: 1 }), refused(400, 'Slots start on the hour. Try a time like 19:00.'));
  // Changed: the whole entry is read again (a venue changed without a type takes the venue's own).
  r = await ask(t, phone, 'weekly/change', { id: g.id, venue: 'scotstoun', type: 'outdoor', day: 'thu', start: 600 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state.weekly.find(w => w.id === g.id), { id: g.id, venue: 'scotstoun', type: 'outdoor', day: 'thu', start: 600, hours: 1, end: 660, on: true, next: { date: '2026-11-26', opensAt: at('2026-11-19T00:00:00Z') } });
  assert.deepEqual(await ask(t, phone, 'weekly/change', { id: g.id, venue: 'gorbals', type: 'outdoor' }), refused(400, 'Gorbals has indoor courts only.'));
  assert.deepEqual(await ask(t, phone, 'weekly/change', { id: 'ffffffff', start: 600 }), refused(409, 'That weekly booking is no longer on your list.'));
  // Off and on.
  r = await ask(t, phone, 'weekly/on', { id: g.id, on: false });
  assert.deepEqual([r.body.state.weekly.find(w => w.id === g.id).on, r.body.state.weekly.find(w => w.id === g.id).next], [false, null]);
  assert.deepEqual(await ask(t, phone, 'weekly/on', { id: g.id }), refused(400, A.WHY.weeklyOn));
  r = await ask(t, phone, 'weekly/on', { id: g.id, on: true });
  assert.equal(r.body.state.weekly.find(w => w.id === g.id).on, true);
  // Removed.
  r = await ask(t, phone, 'weekly/remove', { id: g.id });
  assert.equal(r.body.state.weekly.some(w => w.id === g.id), false);
  assert.deepEqual(await ask(t, phone, 'weekly/remove', { id: g.id }), refused(409, 'That weekly booking is no longer on your list.'));
  assert.deepEqual(await ask(t, phone, 'weekly/remove', {}), refused(400, A.WHY.weeklyId));
  // Kept, and the plan of old beside the entries.
  const saved = t.store.load();
  assert.deepEqual(saved.weekly.map(w => [w.venue, w.day, w.start]), [['kelvingrove', 'wed', 1080], ['queenspark', 'wed', 1080], ['kelvingrove', 'wed', 1200]]);
  assert.deepEqual(saved.plan, { wed: { start: 1080, hours: 1 } });
  // The weekly allowance at the parks: an eighth session in a week is refused, Glasgow Club's are not counted.
  const full = makeBot();
  const fp = await linkPhone(full);
  // The week of Mon 23 Nov: six at Maryhill and one at Garrowhill (Monday's release has gone by at noon on the 17th).
  for (const day of ['tue', 'wed', 'thu', 'fri', 'sat', 'sun']) assert.equal((await ask(full, fp, 'weekly', { venue: 'maryhill', day, start: 600, hours: 1 })).status, 200, day);
  assert.equal((await ask(full, fp, 'weekly', { venue: 'garrowhill', day: 'thu', start: 720, hours: 1 })).status, 200);
  assert.equal((await ask(full, fp, 'weekly', { venue: 'gorbals', day: 'wed', start: 1080, hours: 1 })).status, 200);
  assert.deepEqual(await ask(full, fp, 'weekly', { venue: 'queenspark', day: 'wed', start: 1080, hours: 1 }), refused(409, 'That would be 8 sessions in the week of Mon 23 Nov; the limit is 7.'));
});

test('one-offs at any venue, from the app; Telegram\'s /set and /off stay Kelvingrove\'s', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  let r = await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-25', start: 1080, hours: 1 });
  assert.deepEqual(r.body.state.once, [{ id: 'gorbals/2026-11-25@18:00', venue: 'gorbals', type: 'indoor', date: '2026-11-25', start: 1080, hours: 1, end: 1140, opensAt: at('2026-11-18T00:00:00Z'), open: false }]);
  assert.deepEqual(await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-25', start: 1080, hours: 2 }), refused(400, 'Glasgow Club courts are booked an hour at a time.'));
  assert.deepEqual(t.store.load().once, []);                                 // Kelvingrove's list, as an older bot reads it, has none of it
  assert.deepEqual(t.store.load().onceAway, [{ date: '2026-11-25', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor' }]);
  r = await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'thu', start: 1080, hours: 1 });
  await t.app.handleUpdate(say(OWNER, '/set thu 19:00 2h'));
  await t.app.handleUpdate(say(OWNER, '/plan'));
  const plan = t.tg.last().text;
  assert.match(plan, /Thursdays · 18:00–19:00 · Gorbals/);
  assert.match(plan, /Thursdays · 19:00–21:00\n/);
  assert.match(plan, /· Gorbals · Wed 25 Nov · 18:00–19:00 \(opens Wed 18 Nov 00:00\)/);
  await t.app.handleUpdate(say(OWNER, '/off all'));
  assert.match(t.tg.last().text, /^Every weekly booking at Kelvingrove removed\. Those at other venues stay, and so do one-off dates; see \/plan\./);
  assert.deepEqual(t.app.state.weekly.map(w => w.venue), ['gorbals']);
});

// ---------- the nightly run ----------

test('the jobs handed to the PC: Kelvingrove\'s as always; another park with its ClubSpark address; Glasgow Club\'s with its sheet; a PC older than 2.10 gets Kelvingrove\'s alone', async () => {
  const weekly = [
    { id: 'aaaaaaa1', venue: 'kelvingrove', day: 'wed', start: 1080, hours: 1 },
    { id: 'aaaaaaa2', venue: 'queenspark', day: 'wed', start: 1080, hours: 2 },
    { id: 'aaaaaaa3', venue: 'scotstoun', type: 'outdoor', day: 'thu', start: 600, hours: 1 },
  ];
  const t = makeBot('2026-11-18T21:55:00Z', { state: { weekly } });
  const got = t.app.jobsForAgent(HOME, { run: true, venues: true });
  assert.deepEqual(got.jobs, [
    { id: '2026-11-25@18:00', date: '2026-11-25', start: 1080, end: 1140, hours: 1, releaseAt: at('2026-11-18T22:00:00Z') },
    { id: 'queenspark/2026-11-25@18:00', date: '2026-11-25', start: 1080, end: 1200, hours: 2, releaseAt: at('2026-11-18T22:00:00Z'), venue: 'queenspark', type: 'outdoor', address: 'QueensParkTennisCourtsGlasgow' },
    { id: 'scotstoun/2026-11-26@10:00', date: '2026-11-26', start: 600, end: 660, hours: 1, releaseAt: at('2026-11-19T00:00:00Z'), venue: 'scotstoun', type: 'outdoor', centre: 'o' },
  ]);
  // An older PC's booker would book any of them at Kelvingrove: it is handed Kelvingrove's alone, and the others have a result saying why.
  const old = makeBot('2026-11-18T21:55:00Z', { state: { weekly } });
  assert.deepEqual(old.app.jobsForAgent(HOME, { run: true }).jobs.map(j => j.id), ['2026-11-25@18:00']);
  await settle();
  assert.deepEqual(Object.values(old.app.state.results).map(r => [r.id, r.status, r.why]), [
    ['queenspark/2026-11-25@18:00', 'failed', 'your PC\'s booker does not book Queens Park yet: update it on your PC. Your PC did not try it'],
    ['scotstoun/2026-11-26@10:00', 'failed', 'your PC\'s booker does not book Scotstoun outdoor yet: update it on your PC. Your PC did not try it'],
  ]);
});

test('a Glasgow Club result: booked with its court and price, or not, with whether anything was paid; said in Telegram and as a note', async () => {
  const t = makeBot('2026-11-18T00:03:00Z', { state: { weekly: [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1 }] } });
  const phone = await linkPhone(t);
  await t.app.resultFromAgent({ id: 'gorbals/2026-11-25@18:00', status: 'booked', court: 2, type: 'indoor', price: '£23.00', paid: true, end: 1140 });
  await settle();
  assert.match(t.tg.last().text, /^<b>Booked · Court 2<\/b>\nGorbals · Wed 25 Nov · 18:00–19:00\nPaid £23\.00 with the card your PC keeps\.$/);
  const r = state(t, phone).results.find(x => x.id === 'gorbals/2026-11-25@18:00');
  assert.deepEqual([r.venue, r.type, r.status, r.court, r.price, r.paid, r.gate], ['gorbals', 'indoor', 'booked', '2', '£23.00', true, null]);
  assert.deepEqual([state(t, phone).notes[0].title, state(t, phone).notes[0].body], ['Court 2 booked', 'Gorbals · Wed 25 Nov · 18:00–19:00 · paid £23.00']);
  // Not booked: why, and whether Pay was pressed.
  await t.app.resultFromAgent({ id: 'scotstoun/2026-11-26@10:00', status: 'failed', type: 'outdoor', price: '£12.00', paid: 'maybe', why: 'your bank did not approve the payment in time', end: 660 });
  await settle();
  assert.match(t.tg.last().text, /^<b>Not booked · Scotstoun outdoor · Thu 26 Nov · 10:00–11:00<\/b>\nIt did not work: your bank did not approve the payment in time\. Pay was pressed, and whether the payment went through is not known/);
  assert.match(t.tg.last().text, /Book by hand on Glasgow Club's site if you still want it\.$/);
  await t.app.resultFromAgent({ id: 'gorbals/2026-11-27@18:00', status: 'none', paid: false, end: 1140 });
  await settle();
  assert.equal(state(t, phone).results.find(x => x.id === 'gorbals/2026-11-27@18:00').why, 'No court was free for the whole slot. Nothing was paid.');
  // A park's result has neither price nor paid.
  await t.app.resultFromAgent({ id: 'queenspark/2026-11-25@18:00', status: 'booked', court: 1, end: 1140 });
  const q = state(t, phone).results.find(x => x.id === 'queenspark/2026-11-25@18:00');
  assert.deepEqual([q.price, q.paid, q.type], [null, null, 'outdoor']);
});

test('your bank wants the payment approved: said at once, in Telegram and as a note, once for each booking', async () => {
  const t = makeBot('2026-11-18T00:01:30Z');
  const phone = await linkPhone(t);
  await ask(t, phone, 'push', { token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' });
  const before = t.pushes.length;
  assert.deepEqual(await t.app.progressFromAgent({ stage: 'bank', id: 'gorbals/2026-11-25@18:00', type: 'indoor', price: '£23.00', court: 2 }), { ok: true });
  await settle();
  const words = 'Your PC is paying £23.00 for Gorbals · Wed 25 Nov · 18:00–19:00, court 2. Your bank wants you to approve it in its app; your PC waits five minutes for that.';
  assert.equal(t.tg.last().text, `<b>Approve the payment in your bank's app</b>\n${words}`);
  assert.deepEqual([state(t, phone).notes[0].kind, state(t, phone).notes[0].title, state(t, phone).notes[0].body], ['warn', 'Approve the payment in your bank\'s app', words]);
  assert.equal(t.pushes.length, before + 1);
  assert.deepEqual(await t.app.progressFromAgent({ stage: 'bank', id: 'gorbals/2026-11-25@18:00', price: '£23.00' }), { ok: true });       // once
  await settle();
  assert.equal(t.pushes.length, before + 1);
  assert.deepEqual(await t.app.progressFromAgent({ stage: 'bank', id: '2026-11-25@18:00' }), { ok: false, why: 'that is not one of the run\'s Glasgow Club bookings' });
});

test('around a night\'s Glasgow Club booking: no Sleep from 23:00, no hold from 23:25 to 00:30, no look from 23:50 to 00:10; other nights as before', async () => {
  const t = makeBot('2026-11-17T22:59:00Z', { state: { weekly: [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1 }] } });
  const phone = await linkPhone(t);
  await t.app.pingFromAgent(HOME);
  assert.equal(state(t, phone).pc.sleepWhy, null);
  t.clock.t = at('2026-11-17T23:00:00Z');
  await t.app.pingFromAgent(HOME);
  assert.equal(state(t, phone).pc.sleepWhy, 'Your PC books Glasgow Club at 00:00, so it stays awake until then.');
  t.clock.t = at('2026-11-17T23:25:00Z');
  await t.app.pingFromAgent(HOME);
  assert.equal(state(t, phone).indoor.holdNo, 'Your PC books Glasgow Club at 00:00, so it holds nothing else from 23:25 to 00:30. The sheet below still opens.');
  t.clock.t = at('2026-11-18T00:31:00Z');
  await t.app.pingFromAgent(HOME);
  assert.deepEqual([state(t, phone).indoor.holdNo, state(t, phone).pc.sleepWhy], [null, null]);
  // A night without one: nothing in the way at 23:30.
  const q = makeBot('2026-11-18T23:30:00Z', { state: { weekly: [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1 }] } });
  const qp = await linkPhone(q);
  await q.app.pingFromAgent(HOME);
  assert.deepEqual([state(q, qp).indoor.holdNo, state(q, qp).pc.sleepWhy], [null, null]);
});

// ---------- automatic payments ----------

test('automatic payments: the sealed code goes to the PC once and is not kept here; on, off, and the PC\'s word on each', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const ping = (extra = {}) => t.app.pingFromAgent(HOME, { card: { key: KEY, has: true, kept: VISA, ...extra } });
  await ping({ auto: false });
  const sealed = sealedOf();
  let r = await ask(t, phone, 'card/auto', { sealed });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.state.card.auto, r.body.state.card.autoAsked, r.body.state.card.autoWhy], [false, 'on', null]);
  assert.equal(t.app.sealedHeld(), 1);
  const order = await ping({ auto: false });
  assert.deepEqual(Object.keys(order.autoOn), ['id', 'sealed']);
  assert.equal(order.autoOn.sealed, sealed);
  assert.equal(t.app.sealedHeld(), 0);                                         // handed over: not kept a moment longer
  await ping({ auto: true, autoDone: { id: order.autoOn.id, ok: true } });
  assert.deepEqual([state(t, phone).card.auto, state(t, phone).card.autoAsked], [true, null]);
  assert.ok(!t.logs.join('\n').includes(sealed));
  assert.ok(!JSON.stringify(t.store.load()).includes(sealed));
  // Off: the PC deletes it.
  r = await ask(t, phone, 'card/auto/off');
  assert.equal(r.body.state.card.autoAsked, 'off');
  const off = await ping({ auto: true });
  assert.deepEqual(Object.keys(off), ['ok', 'autoOff']);
  await ping({ auto: false, autoDone: { id: off.autoOff.id, ok: true } });
  assert.deepEqual([state(t, phone).card.auto, state(t, phone).card.autoAsked], [false, null]);
  assert.equal((await ask(t, phone, 'card/auto/off')).status, 200);             // off already: nothing to do
  assert.deepEqual(await ping({ auto: false }), { ok: true });
  // The PC's no, in its words.
  r = await ask(t, phone, 'card/auto', { sealed: sealedOf() });
  const on2 = await ping({ auto: false });
  await ping({ auto: false, autoDone: { id: on2.autoOn.id, ok: false, why: 'the security code was sealed for another card' } });
  assert.equal(state(t, phone).card.autoWhy, 'Your PC did not turn automatic payments on: the security code was sealed for another card.');
  // Refused here.
  assert.deepEqual(await ask(t, phone, 'card/auto', {}), refused(400, A.WHY.auto));
  assert.deepEqual(await ask(t, phone, 'card/auto', { sealed: 'not base64!' }), refused(400, A.WHY.sealed));
  await t.app.pingFromAgent(HOME, { card: { key: KEY, has: true, kept: null } });
  assert.deepEqual(await ask(t, phone, 'card/auto', { sealed: sealedOf() }), refused(409, 'There is no card on your PC. Add one in the app first.'));
  const asleep = makeBot();
  const ap = await linkPhone(asleep);
  await asleep.app.pingFromAgent(HOME, { card: { key: KEY, has: true, kept: VISA } });
  asleep.clock.t += 10 * 60000;
  assert.deepEqual(await ask(asleep, ap, 'card/auto', { sealed: sealedOf() }), refused(409, 'Your PC is not awake, and it is your PC that keeps the code. Wake it and try again.'));
  const keyless = makeBot();
  const kp = await linkPhone(keyless);
  assert.deepEqual(await ask(keyless, kp, 'card/auto', { sealed: sealedOf() }), refused(409, 'Your PC has not given me its card key yet. It does with every ping while it is awake: wake it, or wait a minute, then try again.'));
});
