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
const M = require('../lib/messages');
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
  assert.deepEqual(g, { id: g.id, venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, end: 1140, on: true, next: { date: '2026-11-25', opensAt: at('2026-11-18T00:00:00Z') }, signed: false, courts: 1, auth: null });
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
  assert.deepEqual(r.body.state.weekly.find(w => w.id === g.id), { id: g.id, venue: 'scotstoun', type: 'outdoor', day: 'thu', start: 600, hours: 1, end: 660, on: true, next: { date: '2026-11-26', opensAt: at('2026-11-19T00:00:00Z') }, signed: false, courts: 1, auth: null });
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
  assert.deepEqual(r.body.state.once, [{ id: 'gorbals/2026-11-25@18:00', venue: 'gorbals', type: 'indoor', date: '2026-11-25', start: 1080, hours: 1, end: 1140, opensAt: at('2026-11-18T00:00:00Z'), open: false, signed: false, courts: 1, auth: null }]);
  assert.deepEqual(await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-25', start: 1080, hours: 2 }), refused(400, 'Glasgow Club courts are booked an hour at a time.'));
  assert.deepEqual(t.store.load().once, []);                                 // Kelvingrove's list, as an older bot reads it, has none of it
  assert.deepEqual(t.store.load().onceAway, [{ date: '2026-11-25', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', at: t.clock.t }]);
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
    { id: 'scotstoun/2026-11-26@10:00', date: '2026-11-26', start: 600, end: 660, hours: 1, releaseAt: at('2026-11-19T00:00:00Z'), venue: 'scotstoun', type: 'outdoor', centre: 'o', from: 'weekly', courts: 1 },     // unsigned: no auth
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
  assert.match(t.tg.last().text, /^<b>Not booked · Scotstoun outdoor · Thu 26 Nov · 10:00–11:00<\/b>\nIt didn’t work: your bank did not approve the payment in time\. Pay was pressed, and whether the payment went through is not known/);
  assert.match(t.tg.last().text, /Book by hand on Glasgow Club's site if you still want it\.$/);
  await t.app.resultFromAgent({ id: 'gorbals/2026-11-27@18:00', status: 'none', paid: false, end: 1140 });
  await settle();
  assert.equal(state(t, phone).results.find(x => x.id === 'gorbals/2026-11-27@18:00').why, 'No court free for the whole time. Nothing was paid.');
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
  const words = 'Your PC is paying £23.00 for Gorbals · Wed 25 Nov · 18:00–19:00, court 2. Approve it in your bank’s app within five minutes.';
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
  assert.equal(state(t, phone).pc.sleepWhy, 'Staying awake for the 00:00 booking.');
  t.clock.t = at('2026-11-17T23:25:00Z');
  await t.app.pingFromAgent(HOME);
  assert.equal(state(t, phone).indoor.holdNo, 'Not available 23:25–00:30, around the midnight booking. The sheet still opens.');
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
  // Off again, while the PC says it keeps no code: still sent (2.10.1), since what the PC last
  // said may be out of date, and off twice is off.
  assert.equal((await ask(t, phone, 'card/auto/off')).status, 200);
  const again = await ping({ auto: false });
  assert.deepEqual(Object.keys(again), ['ok', 'autoOff']);
  await ping({ auto: false, autoDone: { id: again.autoOff.id, ok: true } });
  assert.deepEqual([state(t, phone).card.auto, state(t, phone).card.autoAsked], [false, null]);
  // An "on" not collected yet, then off: the on is dropped unseen, and off still goes.
  await ask(t, phone, 'card/auto', { sealed: sealedOf() });
  await ask(t, phone, 'card/auto/off');
  assert.equal(t.app.sealedHeld(), 0);
  const only = await ping({ auto: false });
  assert.deepEqual(Object.keys(only), ['ok', 'autoOff']);
  await ping({ auto: false, autoDone: { id: only.autoOff.id, ok: true } });
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

// ---------- signed bookings (2.10.1) ----------

// The app's signature for a booking, as docs/app-api.md gives it: the first 16 bytes of an
// HMAC-SHA-512 made with the card's pay key, in lowercase hex.
const PAY = Buffer.alloc(32, 0x5a);
const sign = msg => crypto.createHmac('sha512', PAY).update(msg, 'utf8').digest().subarray(0, 16).toString('hex');

test('signatures: the worked example of docs/app-api.md', () => {
  assert.equal(PAY.toString('base64'), 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=');
  assert.equal(sign('court-broker/weekly/v1|gorbals|indoor|wed|1080|1'), 'c019d5fd3bab087b5a29d9b76c6c69a7');
  assert.equal(sign('court-broker/once/v1|gorbals|indoor|2026-11-25|1080|1'), '7e8fea3af1d796d60bf594483ef7a054');
});

test('signed bookings: kept with the entry and handed to the PC with Glasgow Club\'s jobs; never logged; a change that alters what was signed drops it', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const tag = sign('court-broker/weekly/v1|gorbals|indoor|wed|1080|1');
  let r = await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'wed', start: 1080, hours: 1, auth: tag });
  assert.equal(r.status, 200);
  const g = r.body.state.weekly[0];
  assert.equal(g.signed, true);
  assert.equal(g.auth, tag);                                                     // shown to the app since 2.11, which checks it itself
  assert.equal(t.app.state.weekly[0].auth, tag);
  assert.equal(t.store.load().weekly[0].auth, tag);                              // kept, to hand to the PC
  // Only 32 lowercase hex characters will do.
  for (const auth of ['C019D5FD3BAB087B5A29D9B76C6C69A7', tag.slice(0, 31), `${tag}0`, 12, {}]) {
    assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'thu', start: 1080, hours: 1, auth }), refused(400, A.WHY.auth));
  }
  // Switched off and on, or changed with nothing it signs changed: still signed.
  await ask(t, phone, 'weekly/on', { id: g.id, on: false });
  r = await ask(t, phone, 'weekly/on', { id: g.id, on: true });
  assert.equal(r.body.state.weekly[0].signed, true);
  r = await ask(t, phone, 'weekly/change', { id: g.id, day: 'wed' });
  assert.equal(r.body.state.weekly[0].signed, true);
  // Changed in what it signs, with no signature: no longer signed. With one: signed again.
  r = await ask(t, phone, 'weekly/change', { id: g.id, start: 1140 });
  assert.equal(r.body.state.weekly[0].signed, false);
  assert.equal(t.app.state.weekly[0].auth, undefined);
  const tag2 = sign('court-broker/weekly/v1|gorbals|indoor|wed|1140|1');
  r = await ask(t, phone, 'weekly/change', { id: g.id, start: 1080, auth: tag });
  assert.equal(r.body.state.weekly[0].signed, true);
  // A one-off, signed.
  const onceTag = sign('court-broker/once/v1|gorbals|indoor|2026-11-26|1080|1');
  r = await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-26', start: 1080, hours: 1, auth: onceTag });
  assert.equal(r.body.state.once.find(o => o.id === 'gorbals/2026-11-26@18:00').signed, true);
  // Signed afresh, all at once (a new card): weekly bookings by their id, one-offs by theirs.
  r = await ask(t, phone, 'weekly/auth', { items: [{ id: g.id, auth: tag2 }, { id: 'gorbals/2026-11-26@18:00', auth: tag }] });
  assert.equal(r.status, 200);
  assert.deepEqual([t.app.state.weekly[0].auth, t.app.state.onceAway[0].auth], [tag2, tag]);
  // All or nothing: one that is gone refuses the lot, and nothing changes.
  assert.deepEqual(await ask(t, phone, 'weekly/auth', { items: [{ id: g.id, auth: tag }, { id: 'ffffffff', auth: tag }] }),
    refused(409, 'That weekly booking is no longer on your list (ffffffff). Nothing was changed.'));
  assert.equal(t.app.state.weekly[0].auth, tag2);
  for (const body of [{}, { items: [] }, { items: [{ id: g.id }] }, { items: [{ id: 'not an id', auth: tag }] }, { items: [{ id: g.id, auth: tag }, { id: g.id, auth: tag }] },
    { items: Array.from({ length: 31 }, (_, i) => ({ id: `0000000${(i % 10)}`, auth: tag })) }]) {
    assert.deepEqual(await ask(t, phone, 'weekly/auth', body), refused(400, A.WHY.authItems), JSON.stringify(body).slice(0, 80));
  }
  // Never in the log, or in Telegram.
  for (const s of [tag, tag2, onceTag]) {
    assert.ok(!t.logs.join('\n').includes(s));
    assert.ok(!JSON.stringify(t.tg.calls).includes(s));
  }
});

test('the app is shown each weekly booking\'s and one-off date\'s signature as it was sent (2.11), or null, to check it against the card\'s pay key itself; `signed` stays for older apps', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const wTag = sign('court-broker/weekly/v2|gorbals|indoor|wed|1080|1|2');
  const oTag = sign('court-broker/once/v1|scotstoun|outdoor|2026-11-26|600|1');
  await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'wed', start: 1080, hours: 1, courts: 2, auth: wTag });
  await ask(t, phone, 'weekly', { venue: 'queenspark', day: 'thu', start: 1080, hours: 1 });
  await ask(t, phone, 'once', { venue: 'scotstoun', type: 'outdoor', date: '2026-11-26', start: 600, hours: 1, auth: oTag });
  let r = await ask(t, phone, 'once', { date: '2026-11-27', start: 600, hours: 1 });
  const s = r.body.state;
  assert.deepEqual(s.weekly.map(w => [w.venue, w.signed, w.auth]), [['gorbals', true, wTag], ['queenspark', false, null]]);
  assert.deepEqual(s.once.map(o => [o.id, o.signed, o.auth]), [['scotstoun/2026-11-26@10:00', true, oTag], ['2026-11-27@10:00', false, null]]);
  // As JSON too: null, never left out.
  assert.deepEqual(JSON.parse(JSON.stringify(t.app.appState(phone.device).state)).weekly.map(w => w.auth), [wTag, null]);
  // It follows the entry: dropped when what it signs changes, the new one when the app signs afresh.
  const id = s.weekly[0].id;
  r = await ask(t, phone, 'weekly/change', { id, courts: 1 });
  assert.deepEqual([r.body.state.weekly[0].signed, r.body.state.weekly[0].auth], [false, null]);
  const again = sign('court-broker/weekly/v1|gorbals|indoor|wed|1080|1');
  r = await ask(t, phone, 'weekly/auth', { items: [{ id, auth: again }] });                       // kept for older apps
  assert.deepEqual([r.body.state.weekly[0].signed, r.body.state.weekly[0].auth], [true, again]);
  // Still never in the log, in Telegram, or in the one-line backup.
  await t.app.handleUpdate(say(OWNER, '/plan'));
  await t.app.handleUpdate(say(OWNER, '/backup'));
  for (const tag of [wTag, oTag, again]) {
    assert.ok(!t.logs.join('\n').includes(tag));
    assert.ok(!JSON.stringify(t.tg.calls).includes(tag));
  }
  assert.ok(!require('../app').backupLine(t.app.state).includes(again));
});

test('the PC is handed each Glasgow Club job\'s signature and where it comes from; a one-off added after its day opened is open, one that waited for its midnight is not tried after it', async () => {
  const wTag = sign('court-broker/weekly/v1|gorbals|indoor|wed|1080|1');
  const oTag = sign('court-broker/once/v1|scotstoun|outdoor|2026-11-26|600|1');
  const weekly = [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1, auth: wTag }, { id: 'aaaaaaa1', venue: 'kelvingrove', day: 'wed', start: 1080, hours: 1, auth: wTag }];
  const onceAway = [{ date: '2026-11-26', start: 600, hours: 1, venue: 'scotstoun', type: 'outdoor', auth: oTag, at: at('2026-11-15T09:00:00Z') }];
  // Tuesday 21:55: Gorbals's Wednesday 25 Nov at the coming midnight, signed as a weekly booking.
  const t = makeBot(`${TUE}T21:55:00Z`, { state: { weekly, onceAway } });
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: true, venues: true }).jobs, [
    { id: 'gorbals/2026-11-25@18:00', date: '2026-11-25', start: 1080, end: 1140, hours: 1, releaseAt: at('2026-11-18T00:00:00Z'), venue: 'gorbals', type: 'indoor', centre: 'g', from: 'weekly', auth: wTag, courts: 1 },
  ]);
  // Wednesday 21:55: Kelvingrove's job as always (no signature handed for a park); Scotstoun's one-off at the coming midnight, signed as a one-off.
  t.clock.t = at('2026-11-18T21:55:00Z');
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: true, venues: true }).jobs, [
    { id: '2026-11-25@18:00', date: '2026-11-25', start: 1080, end: 1140, hours: 1, releaseAt: at('2026-11-18T22:00:00Z') },
    { id: 'scotstoun/2026-11-26@10:00', date: '2026-11-26', start: 600, end: 660, hours: 1, releaseAt: at('2026-11-19T00:00:00Z'), venue: 'scotstoun', type: 'outdoor', centre: 'o', from: 'once', auth: oTag, courts: 1 },
  ]);
  // Its midnight gone by (and its half hour): it was that release's to book, so it is not tried again later.
  t.clock.t = at('2026-11-19T21:55:00Z');
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: true, venues: true }).jobs, []);
  assert.equal(t.app.appState((await linkPhone(t)).device).state.open.length, 0);
  // Added after its day opened: open, booked at the next run.
  const late = makeBot('2026-11-19T12:00:00Z', { state: { onceAway: [{ ...onceAway[0], at: at('2026-11-19T11:00:00Z') }] } });
  late.clock.t = at('2026-11-19T21:55:00Z');
  assert.deepEqual(late.app.jobsForAgent(HOME, { run: true, venues: true }).jobs, [
    { id: 'scotstoun/2026-11-26@10:00', date: '2026-11-26', start: 600, end: 660, hours: 1, releaseAt: at('2026-11-19T00:00:00Z'), venue: 'scotstoun', type: 'outdoor', centre: 'o', from: 'once', auth: oTag, courts: 1, open: true },
  ]);
  // Unsigned: handed without a signature (your PC then takes no court for it).
  const bare = makeBot(`${TUE}T21:55:00Z`, { state: { weekly: [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1 }] } });
  assert.deepEqual(bare.app.jobsForAgent(HOME, { run: true, venues: true }).jobs.map(j => [j.id, j.from, j.auth]), [['gorbals/2026-11-25@18:00', 'weekly', undefined]]);
});

test('settings kept before 2.10 are copied once, as they were, before 2.10 first saves them; settings kept by 2.10 are not', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { createStore } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-pre210-'));
  const old = { v: 4, owner: OWNER, plan: { thu: { start: 1140, hours: 2 } }, once: [{ date: '2026-11-27', start: 600, hours: 1 }], order: [3, 4, 5, 2, 1, 6] };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(old));
  const start = () => {
    const logs = [];
    const clock = { t: at(NOON) };
    const app = createApp({ now: () => clock.t, tg: fakeTelegram(clock), store: createStore(dir, { env: {} }), pictures: PICTURES, linked: true, log: l => logs.push(l),
      glasgow: { day: async () => ({ at: clock.t, slots: [], listed: 0 }), peek: () => null, health: () => null }, push: async () => {}, wake: async () => 3 });
    return { app, logs };
  };
  const first = start();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.pre-2.10.json'), 'utf8')), old);
  assert.ok(first.logs.some(l => l === 'The settings as they were before 2.10 are kept beside them, in state.pre-2.10.json.'));
  // Saved in 2.10's shape, then started again: the copy stays as it was, and is not made again.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...old, weekly: [] }));
  const second = start();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.pre-2.10.json'), 'utf8')), old);
  assert.ok(!second.logs.some(l => /before 2\.10/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an open one-off goes to the PC with its own signature alone, even when a signed weekly booking is for the same slot', () => {
  const wTag = sign('court-broker/weekly/v1|gorbals|indoor|fri|1080|1');
  const oTag = sign('court-broker/once/v1|gorbals|indoor|2026-11-20|1080|1');
  const weekly = [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'fri', start: 1080, hours: 1, auth: wTag }];
  const added = at('2026-11-17T09:00:00Z');                                       // after Friday 20 Nov opened (Fri 13 Nov 00:00)
  const t = makeBot(`${TUE}T21:55:00Z`, { state: { weekly, onceAway: [{ date: '2026-11-20', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', at: added, auth: oTag }] } });
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: true, venues: true }).jobs.map(j => [j.id, j.from, j.auth, j.open]), [['gorbals/2026-11-20@18:00', 'once', oTag, true]]);
  // The one-off unsigned: handed unsigned (your PC takes no court for it), never with the weekly booking's.
  const u = makeBot(`${TUE}T21:55:00Z`, { state: { weekly, onceAway: [{ date: '2026-11-20', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', at: added }] } });
  assert.deepEqual(u.app.jobsForAgent(HOME, { run: true, venues: true }).jobs.map(j => [j.id, j.from, j.auth, j.open]), [['gorbals/2026-11-20@18:00', 'once', undefined, true]]);
});

test('the one-line backup leaves the signatures out, as it does the phones', async () => {
  const { backupLine } = require('../app');
  const tag = sign('court-broker/weekly/v1|gorbals|indoor|wed|1080|1');
  const t = makeBot(NOON, { state: { weekly: [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1, auth: tag }],
    onceAway: [{ date: '2026-11-26', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', auth: tag, at: at(NOON) }], once: [{ date: '2026-11-27', start: 600, hours: 1, auth: tag }] } });
  const line = backupLine(t.app.state);
  assert.ok(!line.includes(tag));
  assert.deepEqual(JSON.parse(line).weekly, [{ id: 'aaaaaaa3', venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, on: true }]);
  await t.app.handleUpdate(say(OWNER, '/backup'));
  assert.ok(!JSON.stringify(t.tg.calls).includes(tag));
});

// ---------- two courts at once (2.11) ----------

test('signatures for two courts: the v2 words of docs/app-api.md; one court\'s are the v1 words, as they were', () => {
  assert.equal(sign('court-broker/weekly/v2|gorbals|indoor|wed|1080|1|2'), '775461b248015a591db102a1d095807d');
  assert.equal(sign('court-broker/once/v2|gorbals|indoor|2026-11-25|1080|1|2'), 'f12b7ca19d33d2b217aa219c5be3fa95');
  assert.equal(sign('court-broker/weekly/v1|gorbals|indoor|wed|1080|1'), 'c019d5fd3bab087b5a29d9b76c6c69a7');
});

test('a weekly booking of two courts at Glasgow Club: kept, shown, and handed to the PC with its courts and its signature; two at a park refused; a change of courts needs a new signature', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  const v2 = sign('court-broker/weekly/v2|gorbals|indoor|wed|1080|1|2');
  let r = await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'wed', start: 1080, hours: 1, courts: 2, auth: v2 });
  assert.equal(r.status, 200);
  const g = r.body.state.weekly[0];
  assert.deepEqual(g, { id: g.id, venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, end: 1140, on: true, next: { date: '2026-11-25', opensAt: at('2026-11-18T00:00:00Z') }, signed: true, courts: 2, auth: v2 });
  assert.deepEqual(t.app.state.weekly, [{ id: g.id, venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, on: true, courts: 2, auth: v2 }]);
  assert.deepEqual(t.store.load().weekly, t.app.state.weekly);                                        // kept as it is
  // Two at a park (Kelvingrove too), and anything but 1 or 2, refused in plain words. One court, said or not: as before.
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'queenspark', day: 'wed', start: 1080, hours: 1, courts: 2 }), refused(400, 'Two courts at once are for Glasgow Club only.'));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'kelvingrove', day: 'thu', start: 1080, hours: 1, courts: 2 }), refused(400, A.WHY.clubCourts));
  assert.deepEqual(await ask(t, phone, 'weekly', { venue: 'gorbals', day: 'thu', start: 1080, hours: 1, courts: 3 }), refused(400, 'courts, when sent, must be 1 or 2.'));
  r = await ask(t, phone, 'weekly', { venue: 'queenspark', day: 'thu', start: 1080, hours: 1, courts: 1 });
  assert.deepEqual(r.body.state.weekly.map(w => [w.venue, w.courts]), [['gorbals', 2], ['queenspark', 1]]);
  assert.deepEqual(t.app.state.weekly[1], { id: t.app.state.weekly[1].id, venue: 'queenspark', type: 'outdoor', day: 'thu', start: 1080, hours: 1, on: true });
  // Tuesday 21:55: handed to the PC for its midnight with both courts and the v2 signature.
  t.clock.t = at(`${TUE}T21:55:00Z`);
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: true, venues: true }).jobs, [
    { id: 'gorbals/2026-11-25@18:00', date: '2026-11-25', start: 1080, end: 1140, hours: 1, releaseAt: at('2026-11-18T00:00:00Z'), venue: 'gorbals', type: 'indoor', centre: 'g', from: 'weekly', auth: v2, courts: 2 },
  ]);
  // Telegram's /plan says so.
  await t.app.handleUpdate(say(OWNER, '/plan'));
  assert.match(t.tg.last().text, /\nWednesdays · 18:00–19:00 · Gorbals · 2 courts\nThursdays · 18:00–19:00 · Queens Park\n/);
  // Switched off and on: still two courts, still signed.
  await ask(t, phone, 'weekly/on', { id: g.id, on: false });
  r = await ask(t, phone, 'weekly/on', { id: g.id, on: true });
  assert.deepEqual([r.body.state.weekly[0].courts, r.body.state.weekly[0].signed], [2, true]);
  // Changed to one court without a new signature: unsigned (the app signs again, with Face ID). With one: signed.
  r = await ask(t, phone, 'weekly/change', { id: g.id, courts: 1 });
  assert.deepEqual([r.body.state.weekly[0].courts, r.body.state.weekly[0].signed], [1, false]);
  assert.deepEqual(t.app.state.weekly[0], { id: g.id, venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, on: true });
  r = await ask(t, phone, 'weekly/change', { id: g.id, courts: 2, auth: v2 });
  assert.deepEqual([r.body.state.weekly[0].courts, r.body.state.weekly[0].signed], [2, true]);
  r = await ask(t, phone, 'weekly/change', { id: g.id, day: 'wed' });                                // nothing it signs is changed
  assert.deepEqual([r.body.state.weekly[0].courts, r.body.state.weekly[0].signed], [2, true]);
  // The one-line backup keeps the courts, never the signature.
  assert.deepEqual(JSON.parse(require('../app').backupLine(t.app.state)).weekly[0], { id: g.id, venue: 'gorbals', type: 'indoor', day: 'wed', start: 1080, hours: 1, on: true, courts: 2 });
  // Moved to a park, it must say one court; then it is one court there, unsigned.
  assert.deepEqual(await ask(t, phone, 'weekly/change', { id: g.id, venue: 'maryhill' }), refused(400, A.WHY.clubCourts));
  r = await ask(t, phone, 'weekly/change', { id: g.id, venue: 'maryhill', courts: 1 });
  assert.deepEqual(r.body.state.weekly.find(w => w.id === g.id), { id: g.id, venue: 'maryhill', type: 'outdoor', day: 'wed', start: 1080, hours: 1, end: 1140, on: true, next: { date: '2026-11-25', opensAt: at('2026-11-18T22:00:00Z') }, signed: false, courts: 1, auth: null });
  // Kept with a park's entry by mistake (a file edited by hand): read as one court.
  assert.deepEqual(P.cleanWeekly([{ id: 'aaaaaaa1', venue: 'queenspark', day: 'wed', start: 1080, hours: 1, courts: 2 }, { id: 'aaaaaaa2', venue: 'gorbals', day: 'thu', start: 1080, hours: 1, courts: 7 }])
    .map(w => [w.venue, P.courtsOf(w), 'courts' in w]), [['queenspark', 1, false], ['gorbals', 1, false]]);
});

test('a one-off date for two courts at Glasgow Club: kept, shown and handed to the PC with its courts; sent again for another number of courts, it takes that, with the signature sent along or none', async () => {
  const t = makeBot('2026-11-19T12:00:00Z');                                                        // Thu 26 Nov opened at 00:00 today
  const phone = await linkPhone(t);
  const v2 = sign('court-broker/once/v2|gorbals|indoor|2026-11-26|1080|1|2'), v1 = sign('court-broker/once/v1|gorbals|indoor|2026-11-26|1080|1');
  const added = t.clock.t;
  let r = await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-26', start: 1080, hours: 1, courts: 2, auth: v2 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state.once, [{ id: 'gorbals/2026-11-26@18:00', venue: 'gorbals', type: 'indoor', date: '2026-11-26', start: 1080, hours: 1, end: 1140, opensAt: at('2026-11-19T00:00:00Z'), open: true, signed: true, courts: 2, auth: v2 }]);
  assert.deepEqual(t.store.load().onceAway, [{ date: '2026-11-26', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', at: added, courts: 2, auth: v2 }]);
  // Added after its day opened: booked at the next run, with both courts and its own signature.
  t.clock.t = at('2026-11-19T21:55:00Z');
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: true, venues: true }).jobs.map(j => [j.id, j.from, j.auth, j.courts, j.open]), [['gorbals/2026-11-26@18:00', 'once', v2, 2, true]]);
  await t.app.handleUpdate(say(OWNER, '/plan'));
  assert.match(t.tg.last().text, /\n· Gorbals · Thu 26 Nov · 18:00–19:00 · 2 courts \(open now, your PC books it on its next run\)\n/);
  // Two at a park, or at Kelvingrove: refused.
  assert.deepEqual(await ask(t, phone, 'once', { venue: 'maryhill', date: '2026-11-27', start: 600, hours: 1, courts: 2 }), refused(400, A.WHY.clubCourts));
  assert.deepEqual(await ask(t, phone, 'once', { date: '2026-11-27', start: 600, hours: 1, courts: 2 }), refused(400, A.WHY.clubCourts));
  // Sent again for one court with no signature: one court, unsigned (the signature it had was for two).
  r = await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-26', start: 1080, hours: 1 });
  assert.deepEqual([r.status, r.body.already, r.body.state.once[0].courts, r.body.state.once[0].signed], [200, true, 1, false]);
  assert.deepEqual(t.app.state.onceAway, [{ date: '2026-11-26', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', at: added }]);
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: false, venues: true }).jobs.map(j => [j.from, j.auth, j.courts]), [['once', undefined, 1]]);
  // For two again, with the signature for two: as it was. The same courts again: only a new signature is taken.
  r = await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-26', start: 1080, hours: 1, courts: 2, auth: v2 });
  assert.deepEqual([r.body.already, r.body.state.once[0].courts, r.body.state.once[0].signed], [true, 2, true]);
  r = await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-26', start: 1080, hours: 1, courts: 2 });
  assert.deepEqual([r.body.already, r.body.state.once[0].courts, r.body.state.once[0].signed], [true, 2, true]);
  r = await ask(t, phone, 'once', { venue: 'gorbals', date: '2026-11-26', start: 1080, hours: 1, courts: 1, auth: v1 });
  assert.deepEqual(t.app.state.onceAway, [{ date: '2026-11-26', start: 1080, hours: 1, venue: 'gorbals', type: 'indoor', at: added, auth: v1 }]);
  assert.ok(!t.logs.join('\n').includes(v2) && !t.logs.join('\n').includes(v1));
});

test('a result of two courts from the PC (its midnight run): one result for the slot, kept and shown with both courts and the total, said in one card and one note; your bank\'s approval names both', async () => {
  const t = makeBot('2026-11-18T00:03:00Z', { state: { weekly: [{ id: 'aaaaaaa3', venue: 'gorbals', day: 'wed', start: 1080, hours: 1, courts: 2 }] } });
  const phone = await linkPhone(t);
  assert.deepEqual(await t.app.progressFromAgent({ stage: 'bank', id: 'gorbals/2026-11-25@18:00', type: 'indoor', price: '£46.00', court: 3, courts: [3, 4] }), { ok: true });
  await settle();
  assert.equal(state(t, phone).notes[0].body, 'Your PC is paying £46.00 for Gorbals · Wed 25 Nov · 18:00–19:00, courts 3 & 4. Approve it in your bank’s app within five minutes.');
  assert.equal(t.tg.last().text.split('\n')[1], 'Your PC is paying £46.00 for Gorbals · Wed 25 Nov · 18:00–19:00, courts 3 &amp; 4. Approve it in your bank’s app within five minutes.');
  t.tg.clear();
  const result = { id: 'gorbals/2026-11-25@18:00', status: 'booked', court: 3, courts: [3, 4], type: 'indoor', price: '£46.00', paid: true, end: 1140 };
  assert.deepEqual(await t.app.resultFromAgent(result), { ok: true });
  await settle();
  assert.deepEqual(t.tg.calls.map(c => c.text), ['<b>Booked · Courts 3 &amp; 4</b>\nGorbals · Wed 25 Nov · 18:00–19:00\nPaid £46.00 with the card your PC keeps.']);
  const r = state(t, phone).results.find(x => x.id === 'gorbals/2026-11-25@18:00');
  assert.deepEqual([r.status, r.court, r.courts, r.price, r.paid], ['booked', '3 & 4', [3, 4], '£46.00', true]);
  assert.deepEqual([state(t, phone).notes[0].title, state(t, phone).notes[0].body], ['Courts 3 & 4 booked', 'Gorbals · Wed 25 Nov · 18:00–19:00 · paid £46.00']);
  assert.equal(Object.keys(t.app.state.results).length, 1);
  // Said again (the PC does, until it hears back): no second card, and one booking.
  await t.app.resultFromAgent(result);
  await settle();
  assert.equal(t.tg.calls.length, 1);
  assert.deepEqual(t.app.jobsForAgent(HOME, { run: false, venues: true }).jobs, []);               // that slot is booked
  // What a result may say of its courts, as the bot reads it.
  const { cleanResult } = require('../app');
  const base = { id: 'gorbals/2026-11-25@18:00', status: 'booked', type: 'indoor', price: '£46.00', paid: true };
  const read = raw => { const x = cleanResult(raw); return [x.court, x.courts]; };
  assert.deepEqual(read({ ...base, court: '3 & 4', courts: [3, 4] }), ['3 & 4', [3, 4]]);
  assert.deepEqual(read({ ...base, courts: [3, 4] }), ['3 & 4', [3, 4]]);
  assert.deepEqual(read({ ...base, court: 3, courts: [3] }), ['3', [3]]);
  assert.deepEqual(read({ ...base, court: 3 }), ['3', undefined]);                                // as before 2.11
  for (const courts of [[4, 3], [3, 3], [3, 4, 5], [0, 1], '3,4', [5]]) assert.deepEqual(read({ ...base, court: 3, courts }), ['3', undefined], JSON.stringify(courts));
  assert.deepEqual(read({ id: 'queenspark/2026-11-25@18:00', status: 'booked', court: 1, courts: [1, 2] }), ['1', undefined]);       // a park: one court
  assert.deepEqual(read({ ...base, status: 'failed', paid: false, why: 'Only 1 of 2 courts was free, so none was taken', courts: [3, 4] }), [undefined, undefined]);
  assert.equal(M.failedText(cleanResult({ ...base, status: 'failed', paid: false, why: 'Only 1 of 2 courts was free, so none was taken' })),
    '<b>Not booked · Gorbals · Wed 25 Nov · 18:00–19:00</b>\nIt didn’t work: Only 1 of 2 courts was free, so none was taken. Nothing was paid.\nBook by hand on Glasgow Club\'s site if you still want it.');
});
