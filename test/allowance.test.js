'use strict';
// Glasgow Life Tennis's weekly allowance (lib/allowance.js): at most 7 sessions and 14 hours in a
// week (Monday to Sunday, by the day played), across the seven parks; a booked session always
// counts, cancelled or not. Book now, the schedule (Telegram and the app alike) and the nightly run
// each keep to it; the app is shown this week and next.

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../lib/allowance');
const { createApp } = require('../app');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; the week of Mon 16 Nov runs to Sun 22 Nov
const NOON = `${TUE}T12:00:00Z`;
const RULES = { releaseMin: 1320, daysAhead: 7 };
const settle = () => new Promise(r => setTimeout(r, 5));

// Booked results: `list` is [venue, date, start, hours].
function booked(list) {
  const out = {};
  for (const [venue, date, start, hours] of list) {
    const hm = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    const id = `${venue === 'kelvingrove' ? '' : `${venue}/`}${date}@${hm}`;
    out[id] = { id, status: 'booked', date, start, end: start + hours * 60, court: '1', at: at('2026-11-10T22:00:00Z'), ...(venue === 'kelvingrove' ? {} : { venue }) };
  }
  return out;
}
// Six one-hour sessions already booked in the week of Mon 16 Nov, at four parks.
const SIX = booked([['maryhill', '2026-11-16', 600, 1], ['queenspark', '2026-11-16', 1080, 1], ['kelvingrove', TUE, 540, 1],
  ['kelvingrove', '2026-11-18', 1080, 1], ['victoriapark', '2026-11-19', 600, 1], ['garrowhill', '2026-11-22', 600, 1]]);

function makeBot(t0 = NOON, state = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const pushes = [];
  const glasgow = { day: async () => { throw new Error('not here'); }, peek: () => null, health: () => null };
  const app = createApp({ now: () => clock.t, tg, store: memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6], ...state }), pictures: PICTURES, glasgow,
    push: async (tokens, m) => { pushes.push(m); }, wake: async () => 3 });
  return { app, tg, clock, pushes };
}
async function linkPhone(t) {
  await t.app.handleUpdate(say(OWNER, '/app'));
  const code = /Code: <code>(\d{6})<\/code>/.exec(t.tg.last().text)[1];
  const r = t.app.appPair({ code, name: 'iPhone' });
  await settle();
  const device = t.app.appAuth(r.body.token);
  await t.app.appAsk(device, 'push', { token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' });
  return { device };
}
const ask = (t, phone, name, body) => t.app.appAsk(phone.device, name, body);
const tap = (t, data) => t.app.handleUpdate({ update_id: 1, callback_query: { id: `q${Math.random()}`, data, from: { id: OWNER }, message: { message_id: 7, chat: { id: OWNER, type: 'private' } } } });

// ---------- the counting ----------

test('a week runs Monday to Sunday, by the day played', () => {
  assert.deepEqual(['2026-11-16', TUE, '2026-11-22', '2026-11-23', '2027-01-03', '2027-01-04'].map(W.weekOf),
    ['2026-11-16', '2026-11-16', '2026-11-16', '2026-11-23', '2026-12-28', '2027-01-04']);
});

test('booked: every booked result in the week, at any park; planned: what the schedule will still try', () => {
  const results = { ...SIX, ...booked([['kelvingrove', '2026-11-23', 960, 2]]),
    'x': { id: '2026-11-20@09:00', status: 'none', date: '2026-11-20', start: 540, end: 600 }, 'y': { id: '2026-11-21@09:00', status: 'failed', date: '2026-11-21', start: 540, end: 600 } };
  assert.deepEqual(W.bookedIn(results, '2026-11-16'), { sessions: 6, hours: 6 });
  assert.deepEqual(W.bookedIn(results, '2026-11-23'), { sessions: 1, hours: 2 });
  assert.deepEqual(W.bookedIn({}, '2026-11-16'), { sessions: 0, hours: 0 });
  // Tuesdays 16:00 for two hours and Thursdays 19:00 every week; Fri 20 Nov 19:00 for two, and Fri 27 Nov 10:00.
  const cfg = { ...RULES, plan: { tue: { start: 960, hours: 2 }, thu: { start: 1140, hours: 1 } }, once: [{ date: '2026-11-20', start: 1140, hours: 2 }, { date: '2026-11-27', start: 600, hours: 1 }] };
  // This week: today's and Thursday's releases have gone by (each a week ago), so only Friday's one-off is still to try.
  assert.deepEqual(W.plannedIn(cfg, {}, '2026-11-16', at(NOON)), { sessions: 1, hours: 2 });
  // Next week: Tuesday (its release is tonight), Thursday, and the 27th.
  assert.deepEqual(W.plannedIn(cfg, {}, '2026-11-23', at(NOON)), { sessions: 3, hours: 4 });
  // Booked, it counts as booked and not as planned; begun, it is no longer tried.
  assert.deepEqual(W.plannedIn(cfg, booked([['kelvingrove', '2026-11-20', 1140, 2]]), '2026-11-16', at(NOON)), { sessions: 0, hours: 0 });
  assert.deepEqual(W.plannedIn(cfg, {}, '2026-11-16', at('2026-11-20T19:00:00Z')), { sessions: 0, hours: 0 });
  // Ten minutes after tonight's release Tuesday the 24th is no longer the schedule's to try.
  assert.deepEqual(W.plannedIn(cfg, {}, '2026-11-23', at(`${TUE}T22:10:00Z`)), { sessions: 2, hours: 2 });
  // This week and next, as the app is shown them.
  assert.deepEqual(W.weeks(cfg, results, at(NOON)), [
    { week: '2026-11-16', sessions: 6, hours: 6, plannedSessions: 1, plannedHours: 2, maxSessions: 7, maxHours: 14 },
    { week: '2026-11-23', sessions: 1, hours: 2, plannedSessions: 3, plannedHours: 4, maxSessions: 7, maxHours: 14 },
  ]);
});

test('the sentences, sessions first, then hours', () => {
  assert.equal(W.overText('2026-11-23', 8, 9), 'That would be 8 sessions in the week of Mon 23 Nov; the limit is 7.');
  assert.equal(W.overText('2026-11-23', 7, 15), 'That would be 15 hours in the week of Mon 23 Nov; the limit is 14.');
  assert.equal(W.overText('2026-11-23', 7, 14.5), 'That would be 14.5 hours in the week of Mon 23 Nov; the limit is 14.');
  assert.equal(W.overText('2026-11-23', 7, 14), null);
  // Book now: what is booked, and this one.
  const seven = { ...SIX, ...booked([['drumchapel', '2026-11-21', 600, 1]]) };
  assert.equal(W.overIfBooked(seven, '2026-11-20', 1), 'That would be 8 sessions in the week of Mon 16 Nov; the limit is 7.');
  assert.equal(W.overIfBooked(seven, '2026-11-23', 2), null);                                   // another week
  const long = booked([['maryhill', '2026-11-16', 600, 2], ['maryhill', TUE, 600, 2], ['maryhill', '2026-11-18', 600, 2], ['maryhill', '2026-11-19', 600, 2], ['maryhill', '2026-11-20', 600, 2], ['maryhill', '2026-11-21', 600, 2]]);
  assert.equal(W.overIfBooked(long, '2026-11-22', 2), null);                                    // seven sessions, fourteen hours: just within
  const thirteen = booked([['maryhill', '2026-11-16', 600, 2], ['maryhill', TUE, 600, 2], ['maryhill', '2026-11-18', 600, 2], ['maryhill', '2026-11-19', 600, 2], ['maryhill', '2026-11-20', 600, 2], ['knightswood', '2026-11-21', 600, 3]]);
  assert.equal(W.overIfBooked(thirteen, '2026-11-22', 2), 'That would be 15 hours in the week of Mon 16 Nov; the limit is 14.');
});

test('a change to the schedule is refused only for a week it adds to that would go over', () => {
  const cfg = { ...RULES, plan: {}, once: [] };
  const withOnce = (date, start, hours) => ({ ...cfg, once: [...cfg.once, { date, start, hours }] });
  // Six booked and one planned this week: an eighth is refused, whether a one-off or a weekly time.
  const before = withOnce('2026-11-21', 1080, 1);
  assert.equal(W.overIfPlanned(before, { ...before, once: [...before.once, { date: '2026-11-22', start: 1080, hours: 1 }] }, SIX, at(NOON)), 'That would be 8 sessions in the week of Mon 16 Nov; the limit is 7.');
  // A weekly Sunday adds nothing this week: Sunday the 22nd's release went by on the 15th.
  assert.equal(W.overIfPlanned(before, { ...before, plan: { sun: { start: 1080, hours: 1 } } }, SIX, at(NOON)), null);
  // Next week is free: fine. A change that adds nothing to a week over the limit: fine too.
  assert.equal(W.overIfPlanned(before, { ...before, once: [...before.once, { date: '2026-11-25', start: 1080, hours: 1 }] }, SIX, at(NOON)), null);
  const over = { ...SIX, ...booked([['drumchapel', '2026-11-20', 600, 1], ['drumchapel', '2026-11-21', 600, 1]]) };     // eight booked: over already
  assert.equal(W.overIfPlanned(cfg, { ...cfg, plan: { mon: { start: 1080, hours: 2 } } }, over, at(NOON)), null);      // Mondays begin next week
  assert.equal(W.overIfPlanned(cfg, withOnce('2026-11-22', 1080, 1), over, at(NOON)), 'That would be 9 sessions in the week of Mon 16 Nov; the limit is 7.');
  // Hours: twelve planned in a far week, and three more is too many; fewer hours is never refused.
  const far = { ...cfg, once: ['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08', '2027-01-09'].map(date => ({ date, start: 600, hours: 2 })) };
  assert.equal(W.overIfPlanned(far, { ...far, once: [...far.once, { date: '2027-01-10', start: 600, hours: 2 }] }, {}, at(NOON)), null);
  const full = { ...far, once: [...far.once, { date: '2027-01-10', start: 600, hours: 2 }] };
  assert.equal(W.overIfPlanned(full, { ...full, once: [...full.once, { date: '2027-01-10', start: 900, hours: 1 }] }, {}, at(NOON)), 'That would be 8 sessions in the week of Mon 4 Jan; the limit is 7.');
  const fewer = { ...cfg, once: far.once.slice(1), plan: { mon: { start: 600, hours: 2 } } };
  assert.equal(W.overIfPlanned(fewer, { ...fewer, plan: { mon: { start: 600, hours: 1 } } }, {}, at(NOON)), null);
});

test('the nightly run is handed what fits, in order; the rest is not handed over, each with its sentence', () => {
  const jobs = [{ id: '2026-11-20@18:00', date: '2026-11-20', start: 1080, end: 1140 }, { id: '2026-11-21@18:00', date: '2026-11-21', start: 1080, end: 1200 }, { id: '2026-11-24@16:00', date: '2026-11-24', start: 960, end: 1080 }];
  const { keep, skip } = W.fitJobs(jobs, SIX);
  assert.deepEqual(keep.map(j => j.id), ['2026-11-20@18:00', '2026-11-24@16:00']);
  assert.deepEqual(skip.map(s => [s.job.id, s.why]), [['2026-11-21@18:00', 'That would be 8 sessions in the week of Mon 16 Nov; the limit is 7.']]);
  assert.deepEqual(W.fitJobs(jobs, {}).skip, []);
});

// ---------- in Telegram, the app and the nightly run ----------

test("a one-off that would pass the week's limit is refused, in Telegram and the app alike, in the same words", async () => {
  const t = makeBot(NOON, { results: SIX, once: [{ date: '2026-11-21', start: 1080, hours: 1 }] });
  const phone = await linkPhone(t);
  const why = 'That would be 8 sessions in the week of Mon 16 Nov; the limit is 7.';
  await t.app.handleUpdate(say(OWNER, '/book 22 nov 19:00'));
  assert.equal(t.tg.last().text, why);
  assert.deepEqual(await ask(t, phone, 'once', { date: '2026-11-22', start: 1140, hours: 1 }), { status: 409, body: { ok: false, why } });
  await tap(t, 'ok:20261122:1900:1');
  assert.equal(t.tg.answers[t.tg.answers.length - 1], why);
  assert.equal(t.app.state.once.length, 1);
  // The same, a week on, is fine; and the app is shown both weeks.
  assert.equal((await ask(t, phone, 'once', { date: '2026-11-29', start: 1140, hours: 2 })).status, 200);
  assert.deepEqual(t.app.appState(phone.device).state.allowance, [
    { week: '2026-11-16', sessions: 6, hours: 6, plannedSessions: 1, plannedHours: 1, maxSessions: 7, maxHours: 14 },
    { week: '2026-11-23', sessions: 0, hours: 0, plannedSessions: 1, plannedHours: 2, maxSessions: 7, maxHours: 14 },
  ]);
});

test("a weekly time that would pass a week's limit is refused the same way; one that adds no session is not", async () => {
  // Seven one-offs next week, 10:00 each day: the week of Mon 23 Nov is full.
  const once = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'].map(date => ({ date, start: 600, hours: 1 }));
  const t = makeBot(NOON, { once });
  const phone = await linkPhone(t);
  const why = 'That would be 8 sessions in the week of Mon 23 Nov; the limit is 7.';
  await t.app.handleUpdate(say(OWNER, '/set wed 19:00'));
  assert.equal(t.tg.last().text, why);
  assert.deepEqual(await ask(t, phone, 'plan', { day: 'wed', start: 1140, hours: 1 }), { status: 409, body: { ok: false, why } });
  await tap(t, 'wl:wed:1900:1');
  assert.equal(t.tg.answers[t.tg.answers.length - 1], why);
  assert.deepEqual(t.app.state.plan, {});
  // Wednesdays at 10:00 are already asked for on the 25th: no more sessions, so it is taken.
  assert.equal((await ask(t, phone, 'plan', { day: 'wed', start: 600, hours: 1 })).status, 200);
  // A Monday every week adds nothing this week or next (their releases have gone by): taken too.
  await t.app.handleUpdate(say(OWNER, '/set mon 19:00'));
  assert.match(t.tg.last().text, /^<b>Mondays · 19:00–20:00<\/b>/);
  assert.deepEqual(t.app.appState(phone.device).state.allowance[1], { week: '2026-11-23', sessions: 0, hours: 0, plannedSessions: 7, plannedHours: 7, maxSessions: 7, maxHours: 14 });
});

test('the nightly run is not handed a job that would pass the limit: its result says why, once, and a look changes nothing', async () => {
  // Seven sessions booked in the week of Mon 23 Nov already (Book now at the parks), and Tuesdays every week.
  const results = booked([['maryhill', '2026-11-23', 600, 1], ['maryhill', '2026-11-24', 600, 1], ['maryhill', '2026-11-25', 600, 1], ['maryhill', '2026-11-26', 600, 1],
    ['maryhill', '2026-11-27', 600, 1], ['maryhill', '2026-11-28', 600, 1], ['maryhill', '2026-11-29', 600, 1]]);
  const t = makeBot(`${TUE}T21:55:00Z`, { results, plan: { tue: { start: 960, hours: 2 } }, lastSeen: at(`${TUE}T21:54:00Z`) });
  const phone = await linkPhone(t);
  // A look (node book.js --jobs): nothing for the PC, and nothing recorded.
  assert.deepEqual(t.app.jobsForAgent({}, { run: false }).jobs, []);
  assert.equal(t.app.state.results['2026-11-24@16:00'], undefined);
  t.tg.clear();
  // The run itself: nothing handed over, and the job has a result that says why.
  assert.deepEqual(t.app.jobsForAgent({}, { run: true }).jobs, []);
  await settle();
  const r = t.app.state.results['2026-11-24@16:00'];
  assert.deepEqual([r.status, r.why], ['failed', 'that would be 8 sessions in the week of Mon 23 Nov; the limit is 7. Your PC did not try it']);
  const card = t.tg.calls.find(c => c.method === 'photo');
  assert.equal(card.text, '<b>Not booked · Tue 24 Nov · 16:00–18:00</b>\nIt did not work: that would be 8 sessions in the week of Mon 23 Nov; the limit is 7. Your PC did not try it.\nBook by hand on ClubSpark if you still want it.');
  assert.deepEqual(t.pushes.map(p => p.title), ['Not booked']);
  // Asked again (a second attempt of the run): not said twice.
  t.app.jobsForAgent({}, { run: true });
  await settle();
  assert.equal(t.tg.calls.filter(c => c.method === 'photo').length, 1);
  // It counts as reported, so "No word from your PC" does not follow.
  t.clock.t = at(`${TUE}T22:09:00Z`);
  await t.app.tick();
  assert.equal(t.tg.calls.filter(c => /No word from your PC/.test(c.text || '')).length, 0);
  assert.equal(t.app.appState(phone.device).state.run, null);
});

test('one session short of the limit: the first job of the night is handed over, the second is not', async () => {
  const results = booked([['maryhill', '2026-11-23', 600, 1], ['maryhill', '2026-11-25', 600, 1], ['maryhill', '2026-11-26', 600, 1], ['maryhill', '2026-11-27', 600, 1],
    ['maryhill', '2026-11-28', 600, 1], ['maryhill', '2026-11-29', 600, 1]]);
  const t = makeBot(`${TUE}T21:55:00Z`, { results, plan: { tue: { start: 960, hours: 1 } }, once: [{ date: '2026-11-24', start: 1140, hours: 1 }] });
  const got = t.app.jobsForAgent({}, { run: true });
  assert.deepEqual(got.jobs.map(j => j.id), ['2026-11-24@16:00']);
  await settle();
  assert.match(t.app.state.results['2026-11-24@19:00'].why, /^that would be 8 sessions in the week of Mon 23 Nov/);
});
