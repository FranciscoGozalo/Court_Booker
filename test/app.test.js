'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, loadState, backupLine, readBackup, intIn } = require('../app');
const L = require('../lib/links');
const M = require('../lib/messages');
const { at, fakeTelegram, memStore, say, run, runLikeIndex, clockOf } = require('./helpers');

const ME = 5550001, STRANGER = 5550002;
const GIVEN = 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/Book?Contacts%5B0%5D.IsPrimary=true&Contacts%5B0%5D.IsJunior=false&Contacts%5B0%5D.IsPlayer=true&ResourceID=41c43943-426c-422d-adf6-d84367f60067&Date=2026-11-17&SessionID=ff6ac50a-dbea-4388-90d7-dcc8332240fd&StartTime=900&EndTime=960&Category=0&SubCategory=0&VenueID=44c8485b-ba20-4617-b364-445810cb9212&ResourceGroupID=44c8485b-ba20-4617-b364-445810cb9212';

// A bot that has been claimed and given a plan: Thursdays 19:00 for two hours, courts 4 3 5 2 6 1.
function setup({ start = '2026-11-16T22:45:00Z', store = memStore(), env = {}, plan = true } = {}) {
  const clock = { t: at(start) };
  const tg = fakeTelegram(clock);
  const logs = [];
  const make = () => createApp({ now: () => clock.t, tg, store, env, log: m => logs.push(m), wait: async ms => { clock.t += ms; } });
  const app = make();
  return { clock, tg, store, logs, app, make, plan };
}
async function ready(opts) {
  const s = setup(opts);
  await s.app.handleUpdate(say(ME, '/start'));
  await s.app.handleUpdate(say(ME, '/set thu 19:00 2h'));
  await s.app.handleUpdate(say(ME, '/order 4 3 5 2 6 1'));
  s.tg.clear();
  return s;
}
const kinds = tg => tg.calls.map(c => `${c.method}@${clockOf(c.at).slice(11, 23)}`);

test('first /start claims the bot; nobody else gets in', async () => {
  const { app, tg, store } = setup();
  await app.handleUpdate(say(STRANGER, 'hello'));
  assert.equal(tg.last().text, 'Send /start to set this bot up.');
  assert.equal(app.owner(), null);
  await app.handleUpdate(say(ME, '/start'));
  assert.equal(app.owner(), ME);
  assert.match(tg.last().text, /This bot is now yours/);
  assert.match(tg.last().text, new RegExp(`TELEGRAM_CHAT_ID = <code>${ME}</code>`));
  assert.equal(store.load().owner, ME);

  tg.clear();
  await app.handleUpdate(say(STRANGER, '/start'));
  await app.handleUpdate(say(STRANGER, '/set mon 10:00'));
  await app.handleUpdate(say(STRANGER, '/plan'));
  assert.deepEqual(tg.calls.map(c => [c.chat, c.text]), [[STRANGER, 'This bot is private.']]);   // told once, then silence
  assert.equal(app.owner(), ME);
  assert.deepEqual(app.state.plan, {});
});

test('a chat ID in the variables is the owner from the start and cannot be claimed away', async () => {
  const { app, tg } = setup({ env: { TELEGRAM_CHAT_ID: String(ME) } });
  await app.handleUpdate(say(STRANGER, '/start'));
  assert.equal(tg.last().text, 'This bot is private.');
  assert.equal(app.owner(), ME);
  await app.handleUpdate(say(ME, '/plan'));
  assert.match(tg.last().text, /Your plan/);
});

test('an empty or junk chat ID variable is treated as not set', async () => {
  for (const v of ['', '  ', 'abc', '12.5']) {
    const { app } = setup({ env: { TELEGRAM_CHAT_ID: v } });
    assert.equal(app.owner(), null, JSON.stringify(v));
  }
  assert.equal(intIn('', 0, 9), null);
  assert.equal(intIn(null, 0, 9), null);
  assert.equal(intIn(true, 0, 9), null);
  assert.equal(intIn(' 7 ', 0, 9), 7);
  assert.equal(intIn(-3, -5, 5), -3);
});

test('/id answers anyone, so a locked-out owner can find their number', async () => {
  const { app, tg } = setup({ env: { TELEGRAM_CHAT_ID: String(ME) } });
  await app.handleUpdate(say(STRANGER, '/id'));
  assert.equal(tg.last().text, `Your chat ID is <code>${STRANGER}</code>`);
});

test('groups, channels and non-text messages are ignored', async () => {
  const { app, tg } = setup();
  await app.handleUpdate(say(ME, '/start', 'group'));
  await app.handleUpdate(say(ME, '/start', 'supergroup'));
  await app.handleUpdate({ update_id: 2, message: { chat: { id: ME, type: 'private' }, photo: [] } });
  await app.handleUpdate({ update_id: 3, edited_message: { chat: { id: ME, type: 'private' }, text: '/start' } });
  await app.handleUpdate({});
  await app.handleUpdate(null);
  assert.equal(tg.calls.length, 0);
  assert.equal(app.owner(), null);
});

test('/set understands the usual ways of writing a slot', async () => {
  const { app, tg } = await ready();
  const cases = [
    ['/set thu 19:00 2h', 'thu', { start: 1140, hours: 2 }],
    ['/set Thursday 7pm', 'thu', { start: 1140, hours: 1 }],
    ['/set fri 18 2', 'fri', { start: 1080, hours: 2 }],
    ['/set sat 10:00-12:00', 'sat', { start: 600, hours: 2 }],
    ['/set sun 10:00 to 11:00', 'sun', { start: 600, hours: 1 }],
    ['/set mon 9am 2 hours', 'mon', { start: 540, hours: 2 }],
    ['/set@KelvingroveBot tue 20:00 1h', 'tue', { start: 1200, hours: 1 }],
  ];
  for (const [text, day, want] of cases) {
    await app.handleUpdate(say(ME, text));
    assert.deepEqual(app.state.plan[day], want, text);
  }
  assert.match(tg.last().text, /^<b>Tuesdays · 20:00–21:00<\/b>\n/);
  for (const bad of ['/set', '/set thu', '/set thu 25:00', '/set xyz 19:00', '/set thu 19:00 3h', '/set thu 19:00-22:30', '/set thu 19:10', '/set thu 23:00 2h']) {
    const before = JSON.stringify(app.state.plan);
    await app.handleUpdate(say(ME, bad));
    assert.equal(JSON.stringify(app.state.plan), before, bad);
  }
});

test('/set replies with the slot and when the alert will come', async () => {
  const { app, tg } = setup({ start: '2026-11-16T22:45:00Z' });
  await app.handleUpdate(say(ME, '/start'));
  await app.handleUpdate(say(ME, '/set thu 19:00 2h'));
  assert.equal(tg.last().text, '<b>Thursdays · 19:00–21:00</b>\nThe alert comes 7 days before, 30 s ahead of the 22:00 release.\n\nNext alert: Thu 19 Nov at 21:59:30 (in 3 days), for Thu 26 Nov, 19:00–21:00.');
});

test('the release night, tick by tick: heads-up, links 30 s before, GO on the dot', async () => {
  const { app, tg, clock } = await ready();
  await run(app, clock, '2026-11-19T21:50:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(tg), ['send@21:55:00.000', 'send@21:59:30.000', 'edit@22:00:00.000']);
  const [warn, links, go] = tg.calls;
  assert.equal(warn.text, '<b>Thu 26 Nov · 19:00–21:00</b>\nBooking opens at 22:00. Your courts arrive at 21:59:30.\nCourt order: 4, 3, 5, 2, 6, 1. Check you are signed in now.');
  assert.equal(links.text, '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00, in 30 s. Wait for GO.');
  assert.equal(go.text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO.</b> Tap a court now.');
  assert.equal(go.id, links.id);                                       // the same message, edited
  assert.equal(go.chat, ME);
  assert.deepEqual(M.withoutColours(go).extra, links.extra);            // the same buttons in the same places
  assert.equal(M.hasColours(links), false);
  assert.deepEqual(go.extra.reply_markup.inline_keyboard.map(r => r.map(b => `${b.text}:${b.style || '-'}`)),
    [['Court 4:success', 'Court 3:primary', 'Court 5:primary'], ['Court 2:primary', 'Court 6:primary', 'Court 1:primary'], ['Whole sheet:-']]);
  const first = new URL(links.extra.reply_markup.inline_keyboard[0][0].url);
  assert.deepEqual([first.searchParams.get('ResourceID'), first.searchParams.get('Date'), first.searchParams.get('StartTime'), first.searchParams.get('EndTime')],
    [L.COURTS[4], '2026-11-26', '1140', '1260']);
  assert.ok(warn.extra.disable_notification !== true && links.extra.disable_notification !== true);   // these must buzz
});

test('woken exactly on time, the way the running bot does it', async () => {
  const { app, tg, clock } = await ready();
  await runLikeIndex(app, clock, '2026-11-19T21:54:59.937Z', '2026-11-19T22:00:05.000Z');   // start off the 100 ms grid
  assert.deepEqual(kinds(tg), ['send@21:55:00.000', 'send@21:59:30.000', 'edit@22:00:00.000']);
});

test('nothing is sent on nights that are not in the plan, and each night only once', async () => {
  const { app, tg, clock } = await ready();
  await app.handleUpdate(say(ME, '/set fri 19:00'));
  tg.clear();
  await run(app, clock, '2026-11-17T21:50:00Z', '2026-11-17T22:05:00Z', 1000);     // Tuesday
  await run(app, clock, '2026-11-18T21:50:00Z', '2026-11-18T22:05:00Z', 1000);     // Wednesday
  assert.equal(tg.calls.length, 0);
  await run(app, clock, '2026-11-19T21:50:00Z', '2026-11-19T22:05:00Z', 1000);     // Thursday
  await run(app, clock, '2026-11-20T21:50:00Z', '2026-11-20T22:05:00Z', 1000);     // Friday
  assert.deepEqual(tg.calls.map(c => `${c.method} ${clockOf(c.at).slice(0, 19)}`), [
    'send 2026-11-19T21:55:00', 'send 2026-11-19T21:59:30', 'edit 2026-11-19T22:00:00',
    'send 2026-11-20T21:55:00', 'send 2026-11-20T21:59:30', 'edit 2026-11-20T22:00:00',
  ]);
  assert.match(tg.calls[4].text, /Fri 27 Nov · 19:00–20:00/);
  await run(app, clock, '2026-11-26T21:50:00Z', '2026-11-26T22:05:00Z', 1000);     // the next Thursday
  assert.equal(tg.calls.length, 9);
  assert.match(tg.calls[7].text, /Thu 3 Dec · 19:00–21:00/);
  assert.deepEqual(Object.keys(app.state.sent).sort(), ['2026-11-26:go', '2026-11-26:links', '2026-11-26:warn']);   // old nights forgotten
});

test('a restart between the links and GO still edits the same message, with no repeats', async () => {
  const s = await ready();
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T21:59:44.900Z');
  assert.deepEqual(kinds(s.tg), ['send@21:55:00.000', 'send@21:59:30.000']);
  const linksId = s.tg.last().id;
  const app2 = s.make();                                               // a redeploy: new process, same stored settings
  await run(app2, s.clock, '2026-11-19T21:59:45Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:55:00.000', 'send@21:59:30.000', 'edit@22:00:00.000']);
  assert.equal(s.tg.last().id, linksId);
});

test('down across the release itself: the waiting message is still turned to GO when the bot comes back', async () => {
  const s = await ready();
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T21:59:50Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000']);
  const app2 = s.make();
  await run(app2, s.clock, '2026-11-19T22:00:25Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000', 'edit@22:00:25.000']);
  assert.equal(s.tg.calls[1].id, s.tg.calls[0].id);
});

test('an edit that had already gone through is not followed by a second GO message', async () => {
  const s = await ready();
  s.tg.failEdit = { code: 400, message: 'Bad Request: message is not modified', once: true };
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000']);                 // nothing more to send
  assert.equal(s.app.state.live.phase, 'go');
});

test('starting late: links at once, already saying GO if the release has passed', async () => {
  let s = await ready();
  await run(s.app, s.clock, '2026-11-19T21:59:41Z', '2026-11-19T22:10:00Z');        // 19 s before
  assert.deepEqual(kinds(s.tg), ['send@21:59:41.000', 'edit@22:00:00.000']);
  assert.match(s.tg.calls[0].text, /in 19 s\. Wait for GO\./);

  s = await ready();
  await run(s.app, s.clock, '2026-11-19T22:00:40Z', '2026-11-19T22:10:00Z');        // 40 s after
  assert.deepEqual(kinds(s.tg), ['send@22:00:40.000']);
  assert.match(s.tg.calls[0].text, /<b>GO\.<\/b>/);
  assert.equal(M.hasColours(s.tg.calls[0]), true);

  s = await ready();
  await run(s.app, s.clock, '2026-11-19T22:03:00Z', '2026-11-19T23:59:00Z', 1000);  // 3 min after: too late to matter
  assert.deepEqual(kinds(s.tg), []);
});

test('paused means silent; resuming in time still delivers', async () => {
  const s = await ready();
  await s.app.handleUpdate(say(ME, '/pause'));
  assert.equal(s.tg.last().text, 'Paused. No alerts until you send /resume.');
  assert.equal(s.app.msToNext(), null);
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T21:59:49.900Z');
  assert.equal(s.tg.calls.length, 0);
  s.clock.t = at('2026-11-19T21:59:50Z');
  await s.app.handleUpdate(say(ME, '/resume'));
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:59:50Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:50.000', 'edit@22:00:00.000']);
});

test('if the links message was deleted, GO arrives as a new message', async () => {
  const s = await ready();
  s.tg.failEdit = { code: 400, message: 'Bad Request: message to edit not found' };
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000', 'send@22:00:00.000']);
  assert.match(s.tg.last().text, /<b>GO\.<\/b>/);
});

test('a network blip is retried a second later, without duplicates', async () => {
  let s = await ready();
  await s.app.handleUpdate(say(ME, '/warn 0'));
  s.tg.clear();
  s.tg.failSend = 2;                                                   // the links fail twice, then get through
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:32.000', 'edit@22:00:00.000']);

  s = await ready();
  s.tg.failEdit = { code: 502, message: 'Bad Gateway', once: true };    // GO fails once, then works
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000', 'edit@22:00:01.000']);
  assert.ok(s.logs.some(l => /Could not send go: Bad Gateway/.test(l)));
});

test('Telegram asking us to slow down is respected', async () => {
  const s = await ready();
  const realSend = s.tg.send;
  let refused = false;
  s.tg.send = async (...a) => {
    if (!refused && s.clock.t >= at('2026-11-19T21:59:30Z')) { refused = true; const e = new Error('Too Many Requests'); e.code = 429; e.retryAfter = 4; throw e; }
    return realSend(...a);
  };
  await s.app.handleUpdate(say(ME, '/warn 0'));
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:34.000', 'edit@22:00:00.000']);
});

test('/go off leaves the links message alone; /warn 0 drops the heads-up; /lead moves the links', async () => {
  const s = await ready();
  await s.app.handleUpdate(say(ME, '/go off'));
  await s.app.handleUpdate(say(ME, '/warn 0'));
  await s.app.handleUpdate(say(ME, '/lead 45'));
  assert.equal(s.tg.last().text, 'The alert will arrive 45 s before the release.');
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:15.000']);
  assert.match(s.tg.calls[0].text, /in 45 s\./);
  for (const bad of ['/lead', '/lead 2', '/lead 301', '/lead abc', '/warn -1', '/warn 61', '/go', '/go maybe']) {
    await s.app.handleUpdate(say(ME, bad));
    assert.deepEqual([s.app.state.lead, s.app.state.warnMin, s.app.state.go], [45, 0, false], bad);
  }
  await s.app.handleUpdate(say(ME, '/warn 1'));
  assert.equal(s.tg.last().text, 'Heads-up 1 min before the release.');
  await s.app.handleUpdate(say(ME, '/lead 60'));
  await s.app.handleUpdate(say(ME, '/warn 1'));
  assert.match(s.tg.last().text, /no separate heads-up/);                // the links themselves arrive a minute before
  await s.app.handleUpdate(say(ME, '/lead 30'));
  await s.app.handleUpdate(say(ME, '/warn 2'));
  assert.equal(s.tg.last().text, 'Heads-up 2 min before the release.');
});

test('summer time: everything an hour earlier in UTC, the same on the UK clock', async () => {
  const s = await ready({ start: '2027-06-07T12:00:00Z' });
  await run(s.app, s.clock, '2027-06-10T20:50:00Z', '2027-06-10T21:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@20:55:00.000', 'send@20:59:30.000', 'edit@21:00:00.000']);
  assert.match(s.tg.calls[1].text, /Thu 17 Jun · 19:00–21:00<\/b>\nOpens at 22:00:00/);
});

test('the nights the clocks change', async () => {
  const s = await ready({ start: '2027-03-22T12:00:00Z' });
  await s.app.handleUpdate(say(ME, '/set sun 10:00'));
  s.tg.clear();
  await run(s.app, s.clock, '2027-03-28T20:50:00Z', '2027-03-28T22:10:00Z', 500);   // spring forward that morning
  assert.deepEqual(kinds(s.tg), ['send@20:55:00.000', 'send@20:59:30.000', 'edit@21:00:00.000']);
  assert.match(s.tg.calls[1].text, /Sun 4 Apr · 10:00–11:00/);
  s.tg.clear();
  await run(s.app, s.clock, '2027-10-31T20:50:00Z', '2027-10-31T22:10:00Z', 500);   // fall back that morning
  assert.deepEqual(kinds(s.tg), ['send@21:55:00.000', 'send@21:59:30.000', 'edit@22:00:00.000']);
  assert.match(s.tg.calls[1].text, /Sun 7 Nov · 10:00–11:00/);
});

test('release rules can be changed with variables', async () => {
  const s = await ready({ env: { RELEASE_TIME: '20:00', DAYS_AHEAD: '6' }, start: '2026-11-16T12:00:00Z' });
  await run(s.app, s.clock, '2026-11-20T19:50:00Z', '2026-11-20T20:10:00Z');        // Friday night -> Thursday
  assert.deepEqual(kinds(s.tg), ['send@19:55:00.000', 'send@19:59:30.000', 'edit@20:00:00.000']);
  assert.match(s.tg.calls[1].text, /Thu 26 Nov · 19:00–21:00<\/b>\nOpens at 20:00:00/);
  const junk = await ready({ env: { RELEASE_TIME: 'soon', DAYS_AHEAD: '0' } });
  assert.deepEqual([junk.app.cfg().releaseMin, junk.app.cfg().daysAhead], [1320, 7]);
});

test('/order, /off and /plan', async () => {
  const s = await ready();
  await s.app.handleUpdate(say(ME, '/order 1 2'));
  assert.deepEqual(s.app.state.order, [1, 2, 3, 4, 5, 6]);
  assert.equal(s.tg.last().text, 'Court order: 1, 2, 3, 4, 5, 6');
  await s.app.handleUpdate(say(ME, '/order 1 1 2'));
  assert.deepEqual(s.app.state.order, [1, 2, 3, 4, 5, 6]);
  assert.match(s.tg.last().text, /each once/);
  await s.app.handleUpdate(say(ME, '/order 654321'));
  assert.deepEqual(s.app.state.order, [6, 5, 4, 3, 2, 1]);
  await s.app.handleUpdate(say(ME, '/plan'));
  assert.match(s.tg.last().text, /Thursday · 19:00–21:00[\s\S]*Court order: 6, 5, 4, 3, 2, 1[\s\S]*Next alert: Thu 19 Nov at 21:59:30/);
  await s.app.handleUpdate(say(ME, '/off fri'));
  assert.match(s.tg.last().text, /^There was no alert for Friday\./);
  await s.app.handleUpdate(say(ME, '/off thursday'));
  assert.match(s.tg.last().text, /^Removed Thursday\.\n\nNo alert is scheduled\./);
  assert.deepEqual(s.app.state.plan, {});
  await s.app.handleUpdate(say(ME, '/set thu 19:00'));
  await s.app.handleUpdate(say(ME, '/off all'));
  assert.deepEqual(s.app.state.plan, {});
  await s.app.handleUpdate(say(ME, '/next'));
  assert.equal(s.tg.last().text, 'No alert is scheduled.');
});

test('/style changes how the courts are shown', async () => {
  const s = await ready();
  assert.equal(s.app.state.style, 'buttons');                            // the default: no address in the message
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T21:59:31Z');
  assert.equal(s.tg.last().text, '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00, in 30 s. Wait for GO.');
  await s.app.handleUpdate(say(ME, '/style both'));
  assert.match(s.tg.last().text, /^The buttons, plus your first-choice court written out/);
  await s.app.handleUpdate(say(ME, '/test'));
  assert.match(s.tg.last().text, /\n\nCourt 4, one tap:\nhttps:\/\/clubspark\.lta\.org\.uk\//);
  assert.ok(s.tg.last().extra.reply_markup);
  s.app.state.sent = {};
  await s.app.handleUpdate(say(ME, '/style links'));
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:05Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000', 'edit@22:00:00.000']);
  assert.equal(s.tg.calls[0].extra.reply_markup, undefined);
  assert.equal((s.tg.calls[0].text.match(/https:\/\/clubspark\.lta\.org\.uk\/KelvingroveParkTennisCourts\/Booking\/Book\?/g) || []).length, 6);
  await s.app.handleUpdate(say(ME, '/style buttons'));
  assert.equal(s.app.state.style, 'buttons');
  await s.app.handleUpdate(say(ME, '/style fancy'));
  assert.equal(s.app.state.style, 'buttons');
  assert.match(s.tg.last().text, /Now: buttons/);
});

test('/code and a pasted confirm-screen address both replace the booking code', async () => {
  const s = await ready();
  const other = GIVEN.replace('ff6ac50a-dbea-4388-90d7-dcc8332240fd', '11111111-2222-3333-4444-555555555555');
  await s.app.handleUpdate(say(ME, '/code ' + other));
  assert.equal(s.app.state.sid, '11111111-2222-3333-4444-555555555555');
  assert.match(s.tg.last().text, /code ending 555555, taken from a Court 4 address/);
  await s.app.handleUpdate(say(ME, GIVEN));                              // just pasted, no command
  assert.equal(s.app.state.sid, L.DEFAULT_SID);
  await s.app.handleUpdate(say(ME, 'https://example.com/Booking/Book?SessionID=11111111-2222-3333-4444-555555555555'));
  assert.equal(s.app.state.sid, L.DEFAULT_SID);
  assert.match(s.tg.last().text, /not the Kelvingrove confirm screen/);
  await s.app.handleUpdate(say(ME, '/code'));
  assert.match(s.tg.last().text, /Now: code ending 2240fd/);
  s.tg.clear();
  await s.app.handleUpdate(say(ME, '/code ' + other));
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T21:59:31Z');
  assert.match(s.tg.last().extra.reply_markup.inline_keyboard[1][2].url, /SessionID=11111111-2222-3333-4444-555555555555&/);
});

test('/test sends real links for a day that is already open, then shows GO', async () => {
  const s = await ready({ start: '2026-11-17T12:00:00Z' });              // Tuesday lunchtime
  await s.app.handleUpdate(say(ME, '/test'));
  assert.deepEqual(s.tg.calls.map(c => c.method), ['send', 'edit']);
  assert.equal(s.tg.calls[0].text, '<b>Test · Thu 19 Nov · 19:00–21:00</b>\nWaiting. On the night this line counts down to the release.\nThis day is already open, so a free court shows the confirm screen. Back out and nothing is booked.');
  assert.match(s.tg.calls[0].extra.reply_markup.inline_keyboard[0][0].url, /Date=2026-11-19&.*StartTime=1140&EndTime=1260/);
  assert.match(s.tg.calls[1].text, /\n<b>GO\.<\/b> This is how it turns at the release\.\n/);
  assert.equal(M.hasColours(s.tg.calls[0]), false);
  assert.equal(M.hasColours(s.tg.calls[1]), true);
  assert.deepEqual(M.withoutColours(s.tg.calls[1]).extra, s.tg.calls[0].extra);
  assert.equal(s.tg.calls[1].at - s.tg.calls[0].at, 5000);
  assert.equal(s.tg.calls[1].id, s.tg.calls[0].id);
  assert.deepEqual(s.app.state.sent, {});                                // a test never counts as the real thing

  const none = setup();
  await none.app.handleUpdate(say(ME, '/start'));
  await none.app.handleUpdate(say(ME, '/test'));
  assert.match(none.tg.last().text, /Set a day first/);
});

test('/signin, /status, /help and things it does not know', async () => {
  const s = await ready();
  await s.app.handleUpdate(say(ME, '/signin'));
  assert.deepEqual(s.tg.last().extra.reply_markup.inline_keyboard, [[{ text: 'Open the booking sheet', url: L.SHEET }]]);
  await s.app.handleUpdate(say(ME, '/status'));
  assert.match(s.tg.last().text, /Status<\/b>  \(version 1\.1\)[\s\S]*UK time now: 22:45:00[\s\S]*kept across restarts: yes[\s\S]*Style: buttons[\s\S]*Next alert/);
  await s.app.handleUpdate(say(ME, '/help'));
  assert.match(s.tg.last().text, /I never contact ClubSpark myself/);
  await s.app.handleUpdate(say(ME, '/dance'));
  assert.match(s.tg.last().text, /I do not know that one/);
  await s.app.handleUpdate(say(ME, 'what time is it'));
  assert.equal(s.tg.last().text, 'Send /help to see what I understand.');
});

test('every command in /help is one the bot handles', async () => {
  const s = await ready();
  await s.app.handleUpdate(say(ME, '/help'));
  const names = [...new Set((s.tg.last().text.replace(/<[^>]+>/g, '').match(/(?<![\w/])\/[a-z]+/g) || []))];
  assert.ok(names.length >= 14);
  for (const name of names) {
    await s.app.handleUpdate(say(ME, name));
    assert.doesNotMatch(s.tg.last().text, /I do not know that one/, name);
  }
});

test('settings survive a restart, and the plan in storage beats the variables', async () => {
  const store = memStore();
  const a = await ready({ store });
  await a.app.handleUpdate(say(ME, '/lead 20'));
  await a.app.handleUpdate(say(ME, '/style links'));
  const b = setup({ store, env: { COURT_PLAN: 'mon 09:00', COURT_ORDER: '1 2 3' } });
  assert.equal(b.app.owner(), ME);
  assert.deepEqual(b.app.state.plan, { thu: { start: 1140, hours: 2 } });
  assert.deepEqual([b.app.state.order, b.app.state.lead, b.app.state.style], [[4, 3, 5, 2, 6, 1], 20, 'links']);
});

test('with no storage yet, variables can seed the plan, the order and the owner', async () => {
  const s = setup({ env: { TELEGRAM_CHAT_ID: String(ME), COURT_PLAN: 'thu 19:00 2h, fri 19:00', COURT_ORDER: '4 3 5 2 6 1' } });
  assert.deepEqual(s.app.state.plan, { thu: { start: 1140, hours: 2 }, fri: { start: 1140, hours: 1 } });
  assert.deepEqual(s.app.state.order, [4, 3, 5, 2, 6, 1]);
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:05Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000', 'edit@22:00:00.000']);      // works with no /start at all
});

test('when settings are not being kept, it says so', async () => {
  const s = setup({ store: memStore(null, false) });
  await s.app.handleUpdate(say(ME, '/start'));
  assert.match(s.tg.last().text, /will be lost at the next restart/);
  await s.app.handleUpdate(say(ME, '/set thu 19:00'));
  assert.match(s.tg.last().text, /will be lost at the next restart/);
  await s.app.announce();
  assert.match(s.tg.last().text, /Court alert is running[\s\S]*will be lost at the next restart/);
  assert.equal(s.tg.last().extra.disable_notification, true);
  const kept = await ready();
  await kept.app.handleUpdate(say(ME, '/plan'));
  assert.doesNotMatch(kept.tg.last().text, /will be lost/);
});

test('/backup gives one line that brings everything back on a server with no storage', async () => {
  const a = await ready({ store: memStore(null, false) });               // Railway with no volume
  await a.app.handleUpdate(say(ME, '/set fri 18:00'));
  await a.app.handleUpdate(say(ME, '/lead 20'));
  await a.app.handleUpdate(say(ME, '/style links'));
  assert.equal(a.app.kept(), 'no');
  await a.app.handleUpdate(say(ME, '/backup'));
  const line = /<code>(.*)<\/code>/.exec(a.tg.last().text)[1].replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(line), { v: 2, owner: ME, plan: { thu: { start: 1140, hours: 2 }, fri: { start: 1080, hours: 1 } }, order: [4, 3, 5, 2, 6, 1], sid: L.DEFAULT_SID, lead: 20, warnMin: 5, go: true, style: 'links' });

  const b = setup({ store: memStore(null, false), env: { COURT_SETTINGS: line } });   // after a restart: nothing saved, only the variable
  assert.equal(b.app.owner(), ME);
  assert.deepEqual(b.app.state.plan, { thu: { start: 1140, hours: 2 }, fri: { start: 1080, hours: 1 } });
  assert.deepEqual([b.app.state.order, b.app.state.lead, b.app.state.style], [[4, 3, 5, 2, 6, 1], 20, 'links']);
  assert.equal(b.app.kept(), 'variable');
  await b.app.handleUpdate(say(ME, '/plan'));
  assert.doesNotMatch(b.tg.last().text, /will be lost/);                 // the variable already holds exactly this
  await b.app.handleUpdate(say(ME, '/status'));
  assert.match(b.tg.last().text, /kept across restarts: yes, from the COURT_SETTINGS variable/);
  b.tg.clear();
  await run(b.app, b.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:05Z');
  assert.deepEqual(kinds(b.tg), ['send@21:59:40.000', 'edit@22:00:00.000']);       // alerts run straight from the variable

  await b.app.handleUpdate(say(ME, '/off fri'));                          // a change the variable does not have yet
  assert.equal(b.app.kept(), 'no');
  assert.match(b.tg.last().text, /Removed Friday/);
  await b.app.handleUpdate(say(ME, '/plan'));
  assert.match(b.tg.last().text, /will be lost at the next restart[\s\S]*\/backup/);
  await b.app.handleUpdate(say(ME, '/set fri 18:00'));                    // put back, in a different order from before
  assert.equal(b.app.kept(), 'variable');
});

test('saved settings beat the COURT_SETTINGS variable, and a junk variable is ignored', async () => {
  const store = memStore();
  await ready({ store });
  const other = JSON.stringify({ owner: STRANGER, plan: { mon: { start: 540, hours: 1 } }, order: [6, 5, 4, 3, 2, 1] });
  const s = setup({ store, env: { COURT_SETTINGS: other } });
  assert.equal(s.app.owner(), ME);
  assert.deepEqual(s.app.state.plan, { thu: { start: 1140, hours: 2 } });
  assert.equal(s.app.kept(), 'disk');
  for (const junk of ['', 'not json', '[1,2]', '"text"', 'null', '{"plan":"x","owner":"me","order":[1]}']) {
    const j = setup({ env: { COURT_SETTINGS: junk, COURT_PLAN: 'sat 10:00' } });
    assert.equal(j.app.owner(), null, junk);
    assert.ok(Object.keys(j.app.state.plan).length <= 1, junk);
  }
  assert.equal(readBackup('{"a":1}').a, 1);
  assert.equal(readBackup(undefined), null);
  assert.equal(backupLine(loadState(null)), JSON.stringify({ v: 2, owner: null, plan: {}, order: [1, 2, 3, 4, 5, 6], sid: L.DEFAULT_SID, lead: 30, warnMin: 5, go: true, style: 'buttons' }));
});

test('settings saved by version 1.0 take the new buttons-only look; a later choice sticks', async () => {
  const asSavedBy10 = { owner: ME, plan: { thu: { start: 1140, hours: 2 } }, order: [4, 3, 5, 2, 6, 1], sid: L.DEFAULT_SID, lead: 30, warnMin: 5, go: true, style: 'both', paused: false, sent: {}, live: null };
  const store = memStore(asSavedBy10);
  const s = setup({ store });
  assert.equal(s.app.state.style, 'buttons');
  assert.deepEqual(s.app.state.plan, { thu: { start: 1140, hours: 2 } });   // nothing else changes
  assert.equal(s.app.owner(), ME);
  await s.app.handleUpdate(say(ME, '/style both'));                         // now chosen on purpose
  assert.equal(setup({ store }).app.state.style, 'both');
  assert.equal(loadState({ ...asSavedBy10, style: 'links' }).style, 'links');   // 1.0's other looks were always a choice
});

test('if Telegram refused button colours, every alert would still arrive, just without them', async () => {
  let s = await ready();
  s.tg.refuseColours = true;
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000', 'edit@22:00:00.000']);
  assert.equal(s.tg.calls[1].text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO.</b> Tap a court now.');
  assert.equal(s.tg.calls[1].id, s.tg.calls[0].id);
  assert.equal(M.hasColours(s.tg.calls[1]), false);
  assert.deepEqual(s.tg.calls[1].extra, s.tg.calls[0].extra);
  assert.ok(s.logs.some(l => /refused the button colours/.test(l)));

  s = await ready();                                                       // a late start sends GO as a new message
  s.tg.refuseColours = true;
  await run(s.app, s.clock, '2026-11-19T22:00:40Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@22:00:40.000']);
  assert.match(s.tg.calls[0].text, /<b>GO\.<\/b>/);
  assert.equal(M.hasColours(s.tg.calls[0]), false);

  s = await ready({ start: '2026-11-17T12:00:00Z' });                      // and so does /test
  s.tg.refuseColours = true;
  await s.app.handleUpdate(say(ME, '/test'));
  assert.deepEqual(s.tg.calls.map(c => c.method), ['send', 'edit']);
  assert.match(s.tg.calls[1].text, /<b>GO\.<\/b>/);
});

test('an edit that was already applied is not mistaken for a colour problem', async () => {
  const s = await ready();
  s.tg.failEdit = { code: 400, once: true, message: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' };
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:10:00Z');
  assert.deepEqual(kinds(s.tg), ['send@21:59:30.000']);                    // no second edit that would strip the colours
  assert.equal(s.app.state.live.phase, 'go');
  assert.ok(!s.logs.some(l => /refused the button colours/.test(l)));
});

test('damaged storage does not break the bot', () => {
  const st = loadState({ owner: 'me', plan: 'x', order: [9], sid: '<script>', lead: 9999, warnMin: null, go: 'no', style: 'x', paused: 'yes', sent: { a: 'b', '2026-11-19:links': 5 }, live: { night: 5 } });
  assert.deepEqual(st, { v: 2, owner: null, plan: {}, order: [1, 2, 3, 4, 5, 6], sid: L.DEFAULT_SID, lead: 30, warnMin: 5, go: true, style: 'buttons', paused: false, sent: { '2026-11-19:links': 5 }, live: null });
  assert.deepEqual(loadState(null).plan, {});
  assert.deepEqual(loadState('junk').order, [1, 2, 3, 4, 5, 6]);
});

test('before anyone has claimed it, nothing is sent', async () => {
  const s = setup({ env: { COURT_PLAN: 'thu 19:00' } });
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T22:05:00Z', 1000);
  assert.equal(s.tg.calls.length, 0);
  assert.equal(s.app.msToNext(), null);
  await s.app.announce();
  assert.equal(s.tg.calls.length, 0);
});

test('the bot only ever links to ClubSpark, and only talks to its owner', async () => {
  const s = await ready();
  await s.app.handleUpdate(say(ME, '/set fri 18:00 1h'));
  await s.app.handleUpdate(say(ME, '/test'));
  await s.app.handleUpdate(say(ME, '/signin'));
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-20T22:05:00Z', 1000);
  assert.ok(s.tg.calls.length >= 9);
  for (const c of s.tg.calls) {
    assert.equal(c.chat, ME);
    const urls = (c.text.replace(/&amp;/g, '&').match(/https?:\/\/[^\s<]+/g) || [])
      .concat(((c.extra.reply_markup || {}).inline_keyboard || []).flat().map(b => b.url));
    for (const u of urls) assert.equal(new URL(u).hostname, 'clubspark.lta.org.uk', u);
  }
});
