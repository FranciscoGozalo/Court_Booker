'use strict';
// The safety nets around a booking night: the PC checked 20 minutes before, a run that never
// starts, a run that starts but never reports, and what the heads-up card says while it waits.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../app');
const { createServer, signedText, readPublicKey } = require('../lib/server');
const { releaseAround } = require('../lib/schedule');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT. Tuesdays open for booking at 22:00 the Tuesday before.
const HOME = { ip: '2.96.64.17' };
const WAKE = { WAKE_MAC: '44:AF:28:7A:1A:5C', WAKE_PORT: '40009' };
const PLAN = { tue: { start: 960, hours: 2 } };

function makeApp(t0, { state = {}, env = {}, wake } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const woke = [];
  const logs = [];
  const app = createApp({
    now: () => clock.t, tg, pictures: PICTURES, linked: true, env, log: l => logs.push(l),
    store: memStore({ v: 4, owner: OWNER, plan: PLAN, order: [3, 4, 5, 2, 1, 6], ...state }),
    wake: wake || (async to => { woke.push({ ...to, at: clock.t }); return 3; }),
  });
  return { app, tg, clock, woke, logs };
}
const go = async (app, clock, when) => { clock.t = at(when); await app.tick(); };
const settle = () => new Promise(r => setImmediate(r));
const texts = tg => tg.calls.map(c => c.text);
const datas = call => call.extra.reply_markup.inline_keyboard.flat().map(b => b.callback_data);

// ---------- a run that never starts ----------

test('an awake PC whose booking run never starts is warned about, two minutes before', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:50:00Z`);
  for (const m of ['21:50', '21:51', '21:52', '21:53', '21:54', '21:55', '21:56', '21:57']) {     // the link, pinging away
    clock.t = at(`${TUE}T${m}:10Z`);
    await app.pingFromAgent(HOME);
    await app.tick();
  }
  assert.equal(tg.calls.length, 0);
  await go(app, clock, `${TUE}T21:58:00Z`);
  const card = tg.last();
  assert.equal(card.photo, 'upload:banner-home-offline.jpg');
  assert.match(card.text, /^<b>The booking run has not started<\/b>\nBooking opens at 22:00 for Tue 24 Nov · 16:00–18:00\. Your PC is awake, but it has not started tonight's run\./);
  assert.match(card.text, /"ClubSpark court booking" task may be switched off/);
  await go(app, clock, `${TUE}T21:58:30Z`);
  assert.equal(tg.calls.length, 1);                                    // said once
});

test('looking at the jobs (node book.js --jobs) is not a run, and brings no heads-up', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:56:00Z`);
  assert.equal(app.jobsForAgent(HOME, { run: false }).jobs.length, 1);
  await settle();
  assert.equal(tg.calls.length, 0);
  assert.equal(app.state.lastRun, null);
  assert.equal(app.pcState(), 'awake');                                // it does show the PC is on
  await go(app, clock, `${TUE}T21:58:00Z`);
  assert.match(tg.last().text, /The booking run has not started/);
});

test('a run that started, flagged or from a PC with older code, is not warned about', async () => {
  for (const how of [{ run: true }, {}, undefined]) {
    const { app, tg, clock } = makeApp(`${TUE}T21:55:05Z`);
    app.jobsForAgent(HOME, how);
    await settle();
    assert.equal(app.state.lastRun, at(`${TUE}T21:55:05Z`));
    assert.match(tg.last().text, /^Booking at 22:00\n/);                // the heads-up
    await go(app, clock, `${TUE}T21:58:00Z`);
    await go(app, clock, `${TUE}T21:59:59Z`);
    assert.equal(tg.calls.length, 1);
  }
});

test('a PC that is off is still told about in the old words', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:57:00Z`, { state: { lastSeen: at(`${TUE}T18:00:00Z`) } });
  await app.tick();
  assert.equal(tg.calls.length, 0);
  await go(app, clock, `${TUE}T21:58:00Z`);
  assert.match(tg.last().text, /^<b>Your PC has not checked in<\/b>/);
});

// ---------- a run that starts but never reports ----------

test('a run that started but sent no result is followed up eight minutes after the release', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:55:05Z`);
  app.jobsForAgent(HOME, { run: true });
  await settle();
  tg.clear();
  await go(app, clock, `${TUE}T22:07:59Z`);
  assert.equal(tg.calls.length, 0);
  await go(app, clock, `${TUE}T22:08:00Z`);
  const card = tg.last();
  assert.equal(card.photo, 'upload:banner-missed.jpg');
  assert.equal(card.text, '<b>No word from your PC</b>\nIt started on Tue 24 Nov · 16:00–18:00 but has not said how it went.\nCheck ClubSpark, and book by hand if it is not there.');
  assert.deepEqual(datas(card), ['n:b', 'n:h']);
  await go(app, clock, `${TUE}T22:20:00Z`);
  assert.equal(tg.calls.length, 1);                                    // said once
});

test('no follow-up when the result came, whatever it was', async () => {
  for (const result of [{ status: 'booked', court: 3, gate: '2433' }, { status: 'none' }, { status: 'failed', why: 'x' }]) {
    const { app, tg, clock } = makeApp(`${TUE}T21:55:05Z`);
    app.jobsForAgent(HOME, { run: true });
    clock.t = at(`${TUE}T22:00:11Z`);
    await app.resultFromAgent({ id: '2026-11-24@16:00', end: 1080, ...result });
    tg.clear();
    await go(app, clock, `${TUE}T22:08:00Z`);
    await go(app, clock, `${TUE}T22:30:00Z`);
    assert.equal(tg.calls.length, 0, result.status);
  }
});

test('with two bookings and one result, the follow-up names only the silent one', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:55:05Z`, { state: { once: [{ date: '2026-11-24', start: 1200, hours: 1 }] } });
  assert.equal(app.jobsForAgent(HOME, { run: true }).jobs.length, 2);
  clock.t = at(`${TUE}T22:00:11Z`);
  await app.resultFromAgent({ id: '2026-11-24@16:00', status: 'booked', court: 3, end: 1080 });
  tg.clear();
  await go(app, clock, `${TUE}T22:08:11Z`);                            // eight minutes after the first result
  assert.match(tg.last().text, /It started on Tue 24 Nov · 20:00–21:00 but has not said/);
});

test('each sign of life restarts the eight minutes: another booking\'s result, or the run starting over', async () => {
  // Two bookings: the first finds nothing for five minutes, so the second starts late.
  const two = makeApp(`${TUE}T21:55:05Z`, { state: { once: [{ date: '2026-11-24', start: 1200, hours: 1 }] } });
  two.app.jobsForAgent(HOME, { run: true });
  two.clock.t = at(`${TUE}T22:05:05Z`);
  await two.app.resultFromAgent({ id: '2026-11-24@16:00', status: 'none', end: 1080 });
  two.tg.clear();
  await go(two.app, two.clock, `${TUE}T22:13:04Z`);
  assert.equal(two.tg.calls.length, 0);
  await go(two.app, two.clock, `${TUE}T22:13:05Z`);
  assert.match(two.tg.last().text, /It started on Tue 24 Nov · 20:00–21:00 but has not said/);

  // The run hit trouble at 22:04 and started over: it has until 22:12.
  const again = makeApp(`${TUE}T21:55:05Z`);
  again.app.jobsForAgent(HOME, { run: true });
  again.clock.t = at(`${TUE}T22:04:00Z`);
  await again.app.progressFromAgent({ stage: 'trouble', why: 'the booking sheet did not load', attempt: 2, of: 3 });
  again.tg.clear();
  await go(again.app, again.clock, `${TUE}T22:11:59Z`);
  assert.equal(again.tg.calls.length, 0);
  await go(again.app, again.clock, `${TUE}T22:12:00Z`);
  assert.match(again.tg.last().text, /No word from your PC/);
});

test('a run that started late gets its eight minutes from when it started', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:58:00Z`, { state: { lastSeen: at(`${TUE}T21:57:30Z`) } });
  await app.tick();                                                    // "has not started", as it has not
  assert.match(tg.last().text, /The booking run has not started/);
  clock.t = at(`${TUE}T22:03:00Z`);
  app.jobsForAgent(HOME, { run: true });
  tg.clear();
  await go(app, clock, `${TUE}T22:10:59Z`);
  assert.equal(tg.calls.length, 0);
  await go(app, clock, `${TUE}T22:11:00Z`);
  assert.match(tg.last().text, /No word from your PC/);
});

test('no run at all: the warning before the release is the only one', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:58:00Z`, { state: { lastSeen: at(`${TUE}T18:00:00Z`) } });
  await app.tick();
  assert.equal(tg.calls.length, 1);
  await go(app, clock, `${TUE}T22:08:00Z`);
  await go(app, clock, `${TUE}T22:40:00Z`);
  assert.equal(tg.calls.length, 1);
});

// ---------- twenty minutes before ----------

test('twenty minutes before, a sleeping PC is sent a wake-up, once, and nothing is said if it answers', async () => {
  const { app, tg, clock, woke, logs } = makeApp(`${TUE}T21:39:59Z`, { env: WAKE, state: { lastSeen: at(`${TUE}T18:00:00Z`), home: { ip: HOME.ip, at: at(`${TUE}T18:00:00Z`) } } });
  await app.tick();
  assert.equal(woke.length, 0);                                        // not yet
  await go(app, clock, `${TUE}T21:40:00Z`);
  assert.deepEqual(woke, [{ host: '2.96.64.17', port: 40009, mac: '44af287a1a5c', at: at(`${TUE}T21:40:00Z`) }]);
  assert.ok(logs.some(l => /your PC was not awake, so I sent it a wake-up/.test(l)));
  await go(app, clock, `${TUE}T21:40:30Z`);
  assert.equal(woke.length, 1);
  clock.t = at(`${TUE}T21:40:45Z`);
  await app.pingFromAgent(HOME);                                       // it woke
  await go(app, clock, `${TUE}T21:43:00Z`);
  await go(app, clock, `${TUE}T21:50:00Z`);
  assert.equal(tg.calls.length, 0);
});

test('if it does not answer within three minutes you are told, with a Wake button, once', async () => {
  const { app, tg, clock, woke } = makeApp(`${TUE}T21:40:00Z`, { env: WAKE, state: { lastSeen: at(`${TUE}T18:00:00Z`), home: { ip: HOME.ip, at: at(`${TUE}T18:00:00Z`) } } });
  await app.tick();
  assert.equal(woke.length, 1);
  await go(app, clock, `${TUE}T21:42:59Z`);
  assert.equal(tg.calls.length, 0);
  await go(app, clock, `${TUE}T21:43:00Z`);
  const card = tg.last();
  assert.equal(card.photo, 'upload:banner-home-offline.jpg');
  assert.equal(card.text, [
    '<b>Your PC is not answering</b>',
    'I sent it a wake-up at 21:40, ahead of tonight\'s booking, and it has not replied.',
    'Booking opens at 22:00 for Tue 24 Nov · 16:00–18:00.',
    'If it restarted, it is waiting for you to sign in to Windows. If it is off, switch it on.',
    'If it is only asleep, its own timer should still wake it for the run. I will tell you at 21:58 if the run has not started.',
  ].join('\n'));
  assert.deepEqual(datas(card), ['n:wk', 'n:s', 'n:h']);
  await go(app, clock, `${TUE}T21:45:00Z`);
  assert.equal(tg.calls.length, 1);
  assert.equal(woke.length, 1);
  // And at 21:58 the second warning does come, as promised.
  await go(app, clock, `${TUE}T21:58:00Z`);
  assert.match(tg.last().text, /^<b>Your PC has not checked in<\/b>/);
  assert.equal(tg.calls.length, 2);
});

test('a PC that is awake twenty minutes before is left alone', async () => {
  const { app, tg, clock, woke } = makeApp(`${TUE}T21:39:30Z`, { env: WAKE });
  await app.pingFromAgent(HOME);
  await go(app, clock, `${TUE}T21:40:00Z`);
  clock.t = at(`${TUE}T21:41:00Z`);
  await app.pingFromAgent(HOME);
  await go(app, clock, `${TUE}T21:43:30Z`);
  assert.equal(woke.length, 0);
  assert.equal(tg.calls.length, 0);
});

test('a PC put to sleep from Telegram earlier is woken twenty minutes before too', async () => {
  const { app, clock, woke } = makeApp(`${TUE}T21:00:00Z`, { env: WAKE });
  await app.pingFromAgent(HOME); await app.tick();
  await app.handleUpdate(say(OWNER, '/sleep'));
  clock.t += 2000;
  assert.deepEqual(await app.pingFromAgent(HOME), { ok: true, sleep: true });
  await go(app, clock, `${TUE}T21:39:00Z`);
  assert.equal(woke.length, 0);
  await go(app, clock, `${TUE}T21:40:00Z`);
  assert.equal(woke.length, 1);
});

test('a wake-up that could not be sent is tried again half a minute later', async () => {
  let fails = 1;
  const sent = [];
  const wake = async to => { if (fails-- > 0) throw new Error('no route'); sent.push(to); return 3; };
  const { app, tg, clock } = makeApp(`${TUE}T21:40:00Z`, { env: WAKE, wake, state: { lastSeen: at(`${TUE}T18:00:00Z`), home: { ip: HOME.ip, at: at(`${TUE}T18:00:00Z`) } } });
  await app.tick();
  await go(app, clock, `${TUE}T21:40:10Z`);
  assert.equal(sent.length, 0);
  await go(app, clock, `${TUE}T21:40:30Z`);
  assert.equal(sent.length, 1);
  await go(app, clock, `${TUE}T21:43:29Z`);
  assert.equal(tg.calls.length, 0);                                    // three minutes from the one that went
  await go(app, clock, `${TUE}T21:43:30Z`);
  assert.match(tg.last().text, /I sent it a wake-up at 21:40/);
});

test('with no way to wake it, only a PC silent for over a day is told about early', async () => {
  const asleep = makeApp(`${TUE}T21:40:00Z`, { state: { lastSeen: at(`${TUE}T18:00:00Z`) } });
  await asleep.app.tick();
  await go(asleep.app, asleep.clock, `${TUE}T21:45:00Z`);
  assert.equal(asleep.tg.calls.length, 0);

  const gone = makeApp(`${TUE}T21:40:00Z`, { state: { lastSeen: at('2026-11-15T22:01:00Z') } });
  await gone.app.tick();
  const card = gone.tg.last();
  assert.match(card.text, /^<b>Your PC is not answering<\/b>\nIt has not been in touch for over a day\.\nBooking opens at 22:00/);
  assert.deepEqual(datas(card), ['n:s', 'n:h']);                       // no Wake button: there is nothing to wake it with
  await go(gone.app, gone.clock, `${TUE}T21:41:00Z`);
  assert.equal(gone.tg.calls.length, 1);

  const never = makeApp(`${TUE}T21:40:00Z`);
  await never.app.tick();
  assert.match(never.tg.last().text, /It has not been in touch yet\./);
});

test('nothing is checked on a night with nothing to book, or while paused', async () => {
  const quiet = makeApp('2026-11-18T21:40:00Z', { env: WAKE, state: { lastSeen: at(`${TUE}T18:00:00Z`), home: { ip: HOME.ip, at: 1 } } });
  await quiet.app.tick();
  await go(quiet.app, quiet.clock, '2026-11-18T22:10:00Z');
  assert.equal(quiet.woke.length, 0);
  assert.equal(quiet.tg.calls.length, 0);

  const paused = makeApp(`${TUE}T21:40:00Z`, { env: WAKE, state: { paused: true, lastSeen: at(`${TUE}T18:00:00Z`), home: { ip: HOME.ip, at: 1 } } });
  await paused.app.tick();
  await go(paused.app, paused.clock, `${TUE}T21:58:00Z`);
  assert.equal(paused.woke.length, 0);
  assert.equal(paused.tg.calls.length, 0);
});

test('the window around a release: from so long before, to so long after', () => {
  const c = { plan: PLAN, once: [], order: [3], releaseMin: 22 * 60, daysAhead: 7 };
  const around = (when, before, after) => !!releaseAround(at(when), c, before * 60000, after * 60000);
  assert.equal(around(`${TUE}T21:39:59Z`, 20, -2), false);
  assert.equal(around(`${TUE}T21:40:00Z`, 20, -2), true);
  assert.equal(around(`${TUE}T21:57:59Z`, 20, -2), true);
  assert.equal(around(`${TUE}T21:58:00Z`, 20, -2), false);              // from here the other warning takes over
  assert.equal(around(`${TUE}T21:59:59Z`, 0, 60), false);
  assert.equal(around(`${TUE}T22:00:00Z`, 0, 60), true);
  assert.equal(around(`${TUE}T22:59:59Z`, 0, 60), true);
  assert.equal(around(`${TUE}T23:00:00Z`, 0, 60), false);
  assert.equal(around('2026-11-18T22:00:00Z', 0, 60), false);           // a Wednesday: nothing to book
});

// ---------- the heads-up card ----------

test('the heads-up says "signing in" until the PC reports it has signed in', async () => {
  const { app, tg } = makeApp(`${TUE}T21:55:05Z`);
  app.jobsForAgent(HOME, { run: true });
  await settle();
  const card = tg.last();
  assert.equal(card.text, 'Booking at 22:00\n<b>Tue 24 Nov · 16:00–18:00</b>\nCourts in order: 3, 4, 5, 2, 1, 6\nYour PC is awake and signing in.');
  assert.deepEqual(await app.progressFromAgent({ stage: 'ready' }), { ok: true });
  const edit = tg.last();
  assert.equal(edit.method, 'caption');
  assert.equal(edit.id, card.id);
  assert.equal(edit.text, 'Booking at 22:00\n<b>Tue 24 Nov · 16:00–18:00</b>\nCourts in order: 3, 4, 5, 2, 1, 6\nSigned in. Waiting for 22:00.');
  await app.progressFromAgent({ stage: 'ready' });                     // a second attempt signing in: nothing more
  assert.equal(tg.calls.length, 2);
});

test('"signed in" arriving before the card has finished sending still lands on it', async () => {
  const { app, tg } = makeApp(`${TUE}T21:55:05Z`);
  app.jobsForAgent(HOME, { run: true });
  await app.progressFromAgent({ stage: 'ready' });                     // no pause in between
  assert.deepEqual(tg.calls.map(c => c.method), ['photo', 'caption']);
  assert.match(tg.last().text, /Signed in\. Waiting for 22:00\.$/);
});

test('"signed in" with no heads-up card (a late run, or after a restart of the bot) is taken quietly', async () => {
  const { app, tg } = makeApp(`${TUE}T22:03:00Z`);
  app.jobsForAgent(HOME, { run: true });
  assert.deepEqual(await app.progressFromAgent({ stage: 'ready' }), { ok: true });
  assert.equal(tg.calls.length, 0);
});

test('trouble before the booking is passed on at once, but never as a flood', async () => {
  const { app, tg, clock } = makeApp(`${TUE}T21:56:00Z`);
  assert.deepEqual(await app.progressFromAgent({ stage: 'trouble', why: 'Chrome did not start: <session not created>.', attempt: 2, of: 3 }), { ok: true });
  assert.equal(tg.last().text, '<b>Trouble before the booking</b>\nChrome did not start: &lt;session not created&gt;.\nYour PC is trying again (attempt 2 of 3).');
  clock.t += 5000;
  await app.progressFromAgent({ stage: 'trouble', why: 'again', attempt: 3, of: 3 });
  assert.equal(tg.calls.length, 1);                                    // within 15 s: not twice
  clock.t += 20000;
  await app.progressFromAgent({ stage: 'trouble', why: 'ClubSpark did not load' });
  assert.equal(tg.last().text, '<b>Trouble before the booking</b>\nClubSpark did not load.\nYour PC is trying again.');
  assert.deepEqual(await app.progressFromAgent({ stage: 'dancing' }), { ok: false, why: 'that is not a stage I know (ready, trouble or bank)' });
  assert.equal((await app.progressFromAgent(null)).ok, false);
});

// ---------- two changes to one card at the same moment ----------

test('two redraws of the same card go to Telegram one after the other, never together', async () => {
  const { app, tg } = makeApp(`${TUE}T12:00:00Z`);
  await app.handleUpdate(say(OWNER, '/menu'));
  const id = tg.last().id;
  let open = 0, most = 0;
  const real = tg.editCaption;
  tg.editCaption = async (...a) => {
    open++; most = Math.max(most, open);
    await new Promise(r => setTimeout(r, 5));
    open--;
    return real(...a);
  };
  const tap = (data, n) => app.handleUpdate({ update_id: 1, callback_query: { id: `q${n}`, data, from: { id: OWNER }, message: { message_id: id, chat: { id: OWNER, type: 'private' } } } });
  await Promise.all([tap('b', 1), tap('w', 2), tap('h', 3)]);
  assert.equal(most, 1);
  assert.equal(tg.calls.filter(c => c.method === 'caption').length, 3);
});

// ---------- the endpoint ----------

test('the server tells a run from a look, and takes progress notes only from the PC', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = readPublicKey(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  const sign = (method, path, body) => {
    const ms = Date.now();
    return `Signed ${ms}.${crypto.sign(null, Buffer.from(signedText(ms, method, path, body)), privateKey).toString('base64url')}`;
  };
  const runs = [], notes = [];
  const server = createServer({
    getJobs: (from, how) => { runs.push(how.run); return { jobs: [] }; },
    onResult: async () => ({ ok: true }),
    onProgress: async raw => { notes.push(raw); return raw.stage === 'ready' ? { ok: true } : { ok: false, why: 'no' }; },
    publicKey: pub,
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // The signature covers the path without the query, so one way of signing does for all three.
    for (const q of ['', '?run=1', '?run=0']) {
      const res = await fetch(`${base}/agent/jobs${q}`, { headers: { authorization: sign('GET', '/agent/jobs', '') } });
      assert.equal(res.status, 200, q);
    }
    assert.deepEqual(runs, [undefined, true, false]);

    const post = (body, signed = true) => fetch(`${base}/agent/progress`, { method: 'POST', headers: signed ? { authorization: sign('POST', '/agent/progress', body) } : {}, body }).then(r => r.status);
    assert.equal(await post('{"stage":"ready"}', false), 401);
    assert.equal(await post('{"stage":"ready"}'), 200);
    assert.equal(await post('{"stage":"dancing"}'), 400);
    assert.equal(await post('not json'), 400);
    assert.deepEqual(notes, [{ stage: 'ready' }, { stage: 'dancing' }]);
  } finally { await new Promise(r => server.close(r)); }
});
