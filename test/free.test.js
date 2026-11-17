'use strict';
// The free-court check on a release night: the bot reads the public booking sheet and leads
// with the first free court in the owner's order. A stand-in sheet answers by the clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, backupLine, loadState } = require('../app');
const L = require('../lib/links');
const { at, fakeTelegram, memStore, say, run, clockOf, PICTURES } = require('./helpers');

const ME = 5550001;
const ALL_FREE = { 1: 'free', 2: 'free', 3: 'free', 4: 'free', 5: 'free', 6: 'free' };

// A stand-in for reading the sheet. `answer(t)` says what it shows at time t.
function fakeSheet(clock, answer = () => ({ ok: true, visible: true, courts: { ...ALL_FREE }, ms: 200 })) {
  const sheet = async (date, start, end) => { sheet.calls.push({ at: clock.t, date, start, end }); return sheet.answer(clock.t); };
  sheet.calls = [];
  sheet.answer = answer;
  return sheet;
}
// Courts taken one by one: `gone` is a list of [time, court].
const takenAt = (gone, base = ALL_FREE) => t => {
  const courts = { ...base };
  for (const [when, n] of gone) if (t >= at(when)) courts[n] = 'booked';
  return { ok: true, visible: true, courts, ms: 200 };
};

async function ready({ start = '2026-11-16T22:45:00Z', card = false, store = memStore(), answer } = {}) {
  const clock = { t: at(start) };
  const tg = fakeTelegram(clock);
  const sheet = fakeSheet(clock, answer);
  const logs = [];
  const make = () => createApp({ now: () => clock.t, tg, store, env: {}, pictures: PICTURES, log: m => logs.push(m), wait: async ms => { clock.t += ms; }, checkCourts: sheet });
  const app = make();
  await app.handleUpdate(say(ME, '/start'));
  await app.handleUpdate(say(ME, '/set thu 19:00 2h'));
  await app.handleUpdate(say(ME, '/order 4 3 5 2 6 1'));
  if (!card) await app.handleUpdate(say(ME, '/style buttons'));
  tg.clear();
  return { clock, tg, sheet, logs, app, make, store };
}
const kinds = tg => tg.calls.map(c => `${c.method}@${clockOf(c.at).slice(11, 23)}`);
const buttons = c => c.extra.reply_markup.inline_keyboard.map(r => r.map(b => b.text));
const courtIn = b => Object.keys(L.COURTS).find(n => L.COURTS[n] === new URL(b.url).searchParams.get('ResourceID'));

test('on a release night the courts lead with the first free one, and move on as courts are taken', async () => {
  const s = await ready({ answer: takenAt([['2026-11-19T22:00:02Z', 4], ['2026-11-19T22:00:06Z', 3]]) });
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T22:10:00Z');
  const [warn, links, go, third, fifth, ...more] = s.tg.calls;
  assert.equal(more.length, 0);
  assert.deepEqual(kinds(s.tg).slice(0, 3), ['send@21:55:00.000', 'send@21:59:30.000', 'edit@22:00:00.000']);
  assert.match(warn.text, /Check you are signed in now/);

  assert.equal(links.text, '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00 · wait for GO\nCourt 4 is free · then 3, 5, 2, 6, 1');
  assert.deepEqual(buttons(links), [['Book Court 4'], ['Court 3', 'Court 5', 'Court 2'], ['Court 6', 'Court 1'], ['Whole sheet']]);
  const kb = links.extra.reply_markup.inline_keyboard;
  assert.deepEqual(kb.slice(0, 3).flat().map(courtIn), ['4', '3', '5', '2', '6', '1']);   // each button opens its own court
  const first = new URL(kb[0][0].url);
  assert.deepEqual([first.searchParams.get('Date'), first.searchParams.get('StartTime'), first.searchParams.get('EndTime')], ['2026-11-26', '1140', '1260']);

  assert.equal(go.text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO</b> · tap Court 4 now\nAlso free: 3, 5, 2, 6, 1');
  assert.deepEqual(go.extra, links.extra);                                // GO itself moves nothing
  assert.equal(third.text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO</b> · tap Court 3 now\nAlso free: 5, 2, 6, 1');
  assert.deepEqual(buttons(third), [['Book Court 3'], ['Court 5', 'Court 2', 'Court 6'], ['Court 1'], ['Whole sheet']]);
  assert.equal(courtIn(third.extra.reply_markup.inline_keyboard[0][0]), '3');
  assert.match(fifth.text, /tap Court 5 now\nAlso free: 2, 6, 1$/);
  for (const c of [go, third, fifth]) { assert.equal(c.method, 'edit'); assert.equal(c.id, links.id); }   // one message throughout
  assert.ok(third.at > at('2026-11-19T22:00:02Z') && third.at < at('2026-11-19T22:00:05Z'), clockOf(third.at));   // noticed within a few seconds
  assert.ok(fifth.at > at('2026-11-19T22:00:06Z') && fifth.at < at('2026-11-19T22:00:09Z'), clockOf(fifth.at));
});

test('the sheet is read only around the release, gently, and only for the planned slot', async () => {
  const s = await ready();
  await run(s.app, s.clock, '2026-11-19T21:00:00Z', '2026-11-19T23:00:00Z');
  const times = s.sheet.calls.map(c => c.at);
  assert.equal(clockOf(times[0]).slice(11, 23), '21:59:15.000');          // 15 s before the courts go out
  assert.ok(times.every(t => t < at('2026-11-19T22:05:00Z')));              // and for five minutes after the release
  assert.ok(times.some(t => t >= at('2026-11-19T22:00:00Z') && t <= at('2026-11-19T22:00:01Z')));   // once just after it
  assert.ok(times.length >= 30 && times.length <= 60, String(times.length));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 500);
  const busy = times.filter(t => t >= at('2026-11-19T22:00:00Z') && t < at('2026-11-19T22:00:30Z')).length;
  assert.ok(busy >= 10 && busy <= 16, String(busy));                       // about every 2 s while courts are going
  for (const c of s.sheet.calls) assert.deepEqual([c.date, c.start, c.end], ['2026-11-26', 1140, 1260]);
  s.sheet.calls.length = 0;
  await run(s.app, s.clock, '2026-11-20T21:00:00Z', '2026-11-20T23:00:00Z', 1000);   // a night not in the plan
  assert.equal(s.sheet.calls.length, 0);
});

test('nothing changes under the thumb in the last seconds before GO', async () => {
  const s = await ready({ answer: takenAt([['2026-11-19T21:59:56Z', 4]]) });
  await s.app.handleUpdate(say(ME, '/lead 28'));                           // so that a read lands 3 s before the release
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:10Z');
  assert.ok(s.sheet.calls.some(c => c.at >= at('2026-11-19T21:59:57Z') && c.at < at('2026-11-19T22:00:00Z')));
  assert.deepEqual(kinds(s.tg), ['send@21:59:32.000', 'edit@22:00:00.000']);   // no edit in between: GO brings the change
  assert.match(s.tg.calls[0].text, /Court 4 is free/);
  assert.match(s.tg.calls[1].text, /<b>GO<\/b> · tap Court 3 now\nAlso free: 5, 2, 6, 1/);
});

test('if ClubSpark turns the server away, the courts come as always, with a note, and it is not asked again', async () => {
  const s = await ready({ answer: () => ({ ok: false, stop: true, why: 'ClubSpark turned this server away (HTTP 403, Cloudflare)' }) });
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T22:10:00Z');
  assert.equal(s.sheet.calls.length, 1);
  assert.deepEqual(kinds(s.tg), ['send@21:55:00.000', 'send@21:59:30.000', 'edit@22:00:00.000']);
  assert.equal(s.tg.calls[1].text, '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00 · wait for GO\nCould not check which courts are free · all six below');
  assert.equal(s.tg.calls[2].text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO</b> · tap a court now\nCould not check which courts are free · all six below');
  for (const c of s.tg.calls.slice(1)) assert.deepEqual(buttons(c), [['Court 4', 'Court 3', 'Court 5'], ['Court 2', 'Court 6', 'Court 1'], ['Whole sheet']]);
  assert.ok(s.logs.some(l => /Could not read the booking sheet: .*403.*Not trying again tonight/.test(l)));
  await s.app.handleUpdate(say(ME, '/status'));
  assert.match(s.tg.last().text, /Free-court check: on, but at 21:59:15 it failed: ClubSpark turned this server away \(HTTP 403, Cloudflare\)/);
});

test('a flaky sheet: one failed read says nothing, three do, and a good read brings the pick back', async () => {
  const s = await ready({ answer: t => (t < at('2026-11-19T22:00:03Z') ? { ok: false, stop: false, why: 'ClubSpark did not answer within 4 s' } : takenAt([])(t)) });
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:10Z');
  const [links, note, go, back] = s.tg.calls;
  assert.equal(s.tg.calls.length, 4);
  assert.equal(links.text, '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00 · wait for GO');      // two misses by then: nothing said
  assert.match(note.text, /wait for GO\nCould not check which courts are free · all six below$/);   // the third, at 21:59:35
  assert.equal(clockOf(note.at).slice(11, 19), '21:59:35');
  assert.match(go.text, /tap a court now\nCould not check/);
  assert.match(back.text, /<b>GO<\/b> · tap Court 4 now\nAlso free: 3, 5, 2, 6, 1$/);
  assert.deepEqual(buttons(back)[0], ['Book Court 4']);

  const once = await ready({ answer: t => (t < at('2026-11-19T21:59:20Z') ? { ok: false, stop: false, why: 'x' } : takenAt([])(t)) });
  await run(once.app, once.clock, '2026-11-19T21:59:00Z', '2026-11-19T21:59:31Z');
  assert.equal(once.tg.calls.length, 1);
  assert.match(once.tg.calls[0].text, /Court 4 is free/);                   // one miss and then a good read: never mentioned
});

test('"nothing free" is not believed before the release; after it, all six are still offered', async () => {
  const none = { 1: 'booked', 2: 'booked', 3: 'booked', 4: 'booked', 5: 'booked', 6: 'booked' };
  const s = await ready({ answer: () => ({ ok: true, visible: true, courts: { ...none }, ms: 200 }) });
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:10Z');
  const [links, go, said] = s.tg.calls;
  assert.equal(links.text, '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00 · wait for GO');   // as always
  assert.equal(go.text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO</b> · tap a court now');           // the last read was before the release
  assert.equal(said.text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO</b> · tap a court now\nNo court shows as free · all six below');
  assert.ok(said.at <= at('2026-11-19T22:00:01.500Z'), clockOf(said.at));
  for (const c of [links, go, said]) assert.deepEqual(buttons(c), [['Court 4', 'Court 3', 'Court 5'], ['Court 2', 'Court 6', 'Court 1'], ['Whole sheet']]);
  assert.equal(s.tg.calls.length, 3);

  const blank = await ready({ answer: () => ({ ok: true, visible: false, courts: {}, ms: 200 }) });   // the day not on the sheet yet
  await run(blank.app, blank.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:10Z');
  assert.deepEqual(blank.tg.calls.map(c => c.text.split('\n').length), [2, 2]);   // as always, nothing added
});

test('a court that comes back (say, a payment not finished) is offered again', async () => {
  const s = await ready({ answer: t => {
    const courts = { 1: 'booked', 2: 'booked', 3: 'booked', 4: 'booked', 5: 'booked', 6: 'booked' };
    if (t < at('2026-11-19T22:00:01Z') || t >= at('2026-11-19T22:01:00Z')) courts[2] = 'free';
    return { ok: true, visible: true, courts, ms: 200 };
  } });
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:02:00Z');
  const texts = s.tg.calls.map(c => c.text.split('\n').slice(1).join(' | '));
  assert.deepEqual(texts, [
    'Opens at 22:00:00 · wait for GO | Court 2 is free',
    '<b>GO</b> · tap Court 2 now | No other court is free',
    '<b>GO</b> · tap a court now | No court shows as free · all six below',
    '<b>GO</b> · tap Court 2 now | No other court is free',
  ]);
  assert.deepEqual(buttons(s.tg.last()), [['Book Court 2'], ['Whole sheet']]);
});

test('the card look: picture first, words to GO, then the picture; later changes edit only the words', async () => {
  const s = await ready({ card: true, answer: takenAt([['2026-11-19T22:00:02Z', 4]]) });
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:10Z');
  assert.deepEqual(s.tg.calls.map(c => c.method), ['photo', 'caption', 'media', 'caption']);
  const [card, words, pic, later] = s.tg.calls;
  assert.equal(card.photo, 'upload:banner-wait.jpg');
  assert.match(card.text, /Court 4 is free · then 3, 5, 2, 6, 1$/);
  assert.match(words.text, /tap Court 4 now/);
  assert.equal(pic.photo, 'upload:banner-open.jpg');
  assert.match(later.text, /tap Court 3 now\nAlso free: 5, 2, 6, 1$/);
  assert.deepEqual(buttons(later)[0], ['Book Court 3']);
  assert.deepEqual(Object.keys(later.extra).sort(), ['parse_mode', 'reply_markup']);
  assert.ok(s.tg.calls.every(c => c.id === card.id));
});

test('a restart in the middle picks up reading the sheet and brings the message up to date', async () => {
  const s = await ready({ answer: takenAt([['2026-11-19T22:00:20Z', 4]]) });
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:10Z');
  const id = s.tg.calls[0].id;
  const app2 = s.make();
  await run(app2, s.clock, '2026-11-19T22:00:30Z', '2026-11-19T22:00:40Z');
  assert.match(s.tg.last().text, /tap Court 3 now/);
  assert.equal(s.tg.last().id, id);
  assert.deepEqual(s.tg.calls.map(c => c.method), ['send', 'edit', 'edit']);
});

test('the other looks lead with the free court too', async () => {
  const s = await ready({ answer: takenAt([], { ...ALL_FREE, 4: 'coaching', 5: 'booked' }) });
  await s.app.handleUpdate(say(ME, '/style both'));
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T21:59:31Z');
  assert.match(s.tg.last().text, /Court 3 is free · then 2, 6, 1\n\nCourt 3, one tap:\nhttps:\/\/clubspark/);
  assert.ok(s.tg.last().text.includes(`ResourceID=${L.COURTS[3]}`));
  await s.app.handleUpdate(say(ME, '/style links'));
  const l = await ready({ answer: takenAt([], { ...ALL_FREE, 4: 'coaching', 5: 'booked' }) });
  await l.app.handleUpdate(say(ME, '/style links'));
  l.tg.clear();
  await run(l.app, l.clock, '2026-11-19T21:59:00Z', '2026-11-19T21:59:31Z');
  const written = l.tg.last().text.match(/^Court \d$/gm);
  assert.deepEqual(written, ['Court 3', 'Court 2', 'Court 6', 'Court 1']);  // only the free ones, best first
});

test('/free shows what the sheet says for the next planned slot, on a day that is open', async () => {
  const s = await ready({ start: '2026-11-17T12:00:00Z', answer: takenAt([], { ...ALL_FREE, 4: 'booked', 5: 'coaching', 2: 'not bookable' }) });
  await s.app.handleUpdate(say(ME, '/free'));
  assert.deepEqual(s.sheet.calls.map(c => [c.date, c.start, c.end]), [['2026-11-19', 1140, 1260]]);
  assert.equal(s.tg.last().text, '<b>Free courts · Thu 19 Nov · 19:00–21:00</b>\nCourt 4: booked\nCourt 3: free\nCourt 5: coaching\nCourt 2: not bookable\nCourt 6: free\nCourt 1: free\n\nRead from ClubSpark in 0.2 s.\n\nOn booking nights the alert leads with the first free court in your order, and moves on as courts are taken.');
  await s.app.handleUpdate(say(ME, '/status'));
  assert.match(s.tg.last().text, /Free-court check: on, last read the sheet at 12:00:00/);

  s.sheet.answer = () => ({ ok: false, stop: true, why: 'ClubSpark turned this server away (HTTP 403, Cloudflare)' });
  await s.app.handleUpdate(say(ME, '/free'));
  assert.equal(s.tg.last().text, '<b>Free courts · Thu 19 Nov · 19:00–21:00</b>\nCould not read the booking sheet: ClubSpark turned this server away (HTTP 403, Cloudflare).\nThe alerts will show all six courts, as before.');
  s.sheet.answer = () => ({ ok: true, visible: false, courts: {}, ms: 100 });
  await s.app.handleUpdate(say(ME, '/free'));
  assert.match(s.tg.last().text, /ClubSpark answered, but the sheet shows nothing for that day\.$/);
  s.sheet.answer = () => { throw new Error('surprise'); };
  await s.app.handleUpdate(say(ME, '/free'));
  assert.match(s.tg.last().text, /Could not read the booking sheet: surprise\./);

  const empty = await ready();
  await empty.app.handleUpdate(say(ME, '/off all'));
  await empty.app.handleUpdate(say(ME, '/free'));
  assert.match(empty.tg.last().text, /Set a day first/);
  assert.equal(empty.sheet.calls.length, 0);
});

test('/free off: the night runs exactly as before and the sheet is never read; /free on brings it back', async () => {
  const s = await ready();
  await s.app.handleUpdate(say(ME, '/free off'));
  assert.equal(s.tg.last().text, 'The alerts will show all six courts, without reading the booking sheet.');
  assert.equal(s.store.load().free, false);
  assert.equal(JSON.parse(backupLine(s.app.state)).free, false);
  assert.equal(loadState(JSON.parse(backupLine(s.app.state))).free, false);
  await s.app.handleUpdate(say(ME, '/status'));
  assert.match(s.tg.last().text, /Free-court check: off \(send \/free on\)/);
  s.tg.clear();
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T22:10:00Z');
  assert.equal(s.sheet.calls.length, 0);
  assert.equal(s.tg.calls[1].text, '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00 · wait for GO');
  assert.equal(s.tg.calls[2].text, '<b>Thu 26 Nov · 19:00–21:00</b>\n<b>GO</b> · tap a court now');
  assert.equal(s.tg.calls.length, 3);

  await s.app.handleUpdate(say(ME, '/free'));                              // checking now still works when asked
  assert.match(s.tg.last().text, /Checking is off for the alerts, so they show all six courts\. Send \/free on to switch it on\.$/);
  await s.app.handleUpdate(say(ME, '/free on'));
  assert.match(s.tg.last().text, /lead with the first free court/);
  assert.equal(s.app.state.free, true);
  await s.app.handleUpdate(say(ME, '/free maybe'));
  assert.match(s.tg.last().text, /Now: on/);
  assert.equal(loadState({ owner: ME }).free, true);                       // settings from before 1.4: on
});

test('/test reads the sheet for the open day and leads with the free court', async () => {
  const s = await ready({ start: '2026-11-17T12:00:00Z', answer: takenAt([], { ...ALL_FREE, 4: 'booked' }) });
  await s.app.handleUpdate(say(ME, '/test'));
  assert.deepEqual(s.sheet.calls.map(c => c.date), ['2026-11-19']);
  const [w, g] = s.tg.calls;
  assert.equal(w.text, '<b>Test · Thu 19 Nov · 19:00–21:00</b>\nOpens at the release · wait for GO\nCourt 3 is free · then 5, 2, 6, 1\nTest only. This day is already open, so a free court shows the confirm screen. Back out and nothing is booked.');
  assert.equal(g.text, '<b>Test · Thu 19 Nov · 19:00–21:00</b>\n<b>GO</b> · tap Court 3 now\nAlso free: 5, 2, 6, 1\nTest only. This day is already open, so a free court shows the confirm screen. Back out and nothing is booked.');
  assert.deepEqual(buttons(g)[0], ['Book Court 3']);
  assert.match(g.extra.reply_markup.inline_keyboard[0][0].url, /Date=2026-11-19&/);
  assert.deepEqual(s.app.state.sent, {});

  s.sheet.answer = () => ({ ok: false, stop: true, why: 'blocked' });
  s.tg.clear();
  await s.app.handleUpdate(say(ME, '/test'));
  assert.match(s.tg.calls[0].text, /\nCould not check which courts are free · all six below\n/);
});

test('with the check on, the bot still only links to ClubSpark and only talks to its owner', async () => {
  const s = await ready({ card: true, answer: takenAt([['2026-11-19T22:00:02Z', 4], ['2026-11-19T22:00:04Z', 3]]) });
  await s.app.handleUpdate(say(ME, '/test'));
  await s.app.handleUpdate(say(ME, '/free'));
  await run(s.app, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T22:06:00Z');
  assert.ok(s.tg.calls.length >= 8);
  for (const c of s.tg.calls) {
    assert.equal(c.chat, ME);
    const urls = (String(c.text).replace(/&amp;/g, '&').match(/https?:\/\/[^\s<]+/g) || [])
      .concat(((c.extra.reply_markup || {}).inline_keyboard || []).flat().map(b => b.url));
    for (const u of urls) assert.equal(new URL(u).hostname, 'clubspark.lta.org.uk', u);
  }
});

test('the start-up note says whether the booking sheet can be read from this server', async () => {
  const s = await ready({ start: '2026-11-17T12:00:00Z' });
  await s.app.announce();
  assert.match(s.tg.last().text, /^Court alert is running \(version 1\.4\)\.\nNext alert: [^\n]+\nFree-court check: working\.$/);
  assert.equal(s.tg.last().extra.disable_notification, true);
  assert.deepEqual(s.sheet.calls.map(c => c.date), ['2026-11-19']);
  s.sheet.answer = () => ({ ok: false, stop: true, why: 'ClubSpark turned this server away (HTTP 403, Cloudflare)' });
  await s.app.announce();
  assert.match(s.tg.last().text, /\nFree-court check: not working \(ClubSpark turned this server away \(HTTP 403, Cloudflare\)\)\. The alerts will show all six courts\.$/);
  assert.ok(s.logs.some(l => /cannot be read from here: .*403/.test(l)));
  await s.app.handleUpdate(say(ME, '/free off'));
  s.sheet.calls.length = 0;
  await s.app.announce();
  assert.equal(s.sheet.calls.length, 0);                                   // switched off: not read at all
  assert.doesNotMatch(s.tg.last().text, /Free-court check/);
});
