'use strict';
// The split setup end to end on the Railway side: the bot reads free courts through the relay,
// which a home server fills by posting readings. Here the "home server" posts into the relay and
// the real app (createApp) builds the card from it, exactly as in index.js when AGENT_TOKEN is set.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createRelay } = require('../lib/relay');
const { at, fakeTelegram, memStore, say, clockOf, PICTURES } = require('./helpers');

const ME = 5550001;
const ALL_FREE = { 1: 'free', 2: 'free', 3: 'free', 4: 'free', 5: 'free', 6: 'free' };

async function ready({ card = false } = {}) {
  const clock = { t: at('2026-11-16T22:45:00Z') };
  const tg = fakeTelegram(clock);
  const relay = createRelay({ now: () => clock.t });
  const store = memStore();
  const make = () => createApp({ now: () => clock.t, tg, store, env: {}, pictures: PICTURES, wait: async ms => { clock.t += ms; }, checkCourts: relay.checkCourts, checkSource: 'home' });
  const app = make();
  await app.handleUpdate(say(ME, '/start'));
  await app.handleUpdate(say(ME, '/set thu 19:00 2h'));
  await app.handleUpdate(say(ME, '/order 4 3 5 2 6 1'));
  if (!card) await app.handleUpdate(say(ME, '/style buttons'));
  tg.clear();
  return { clock, tg, relay, app, make };
}
const kinds = tg => tg.calls.map(c => `${c.method}@${clockOf(c.at).slice(11, 23)}`);
const post = (relay, courts) => relay.put({ date: '2026-11-26', start: 1140, end: 1260, ok: true, courts, visible: true, ms: 1 });

// Step the clock, and on every step have the "home server" post a fresh reading (as the real one
// posts every ~2 s). `courtsAt(t)` says what the sheet shows then.
async function night(app, relay, clock, from, to, courtsAt, step = 100) {
  for (clock.t = at(from); clock.t <= at(to); clock.t += step) {
    if (courtsAt(clock.t)) post(relay, courtsAt(clock.t));
    await app.tick();
  }
}

test('a reading posted by the home server leads the card with the first free court', async () => {
  const s = await ready();
  const courtsAt = t => {
    const c = { ...ALL_FREE };
    if (t >= at('2026-11-19T22:00:02Z')) c[4] = 'booked';
    if (t >= at('2026-11-19T22:00:06Z')) c[3] = 'booked';
    return c;
  };
  await night(s.app, s.relay, s.clock, '2026-11-19T21:50:00Z', '2026-11-19T22:10:00Z', courtsAt);
  const texts = s.tg.calls.map(c => c.text);
  assert.match(texts[1], /Court 4 is free · then 3, 5, 2, 6, 1$/);              // the links, 30 s before
  assert.match(texts[2], /<b>GO<\/b> · tap Court 4 now\nAlso free: 3, 5, 2, 6, 1$/);
  assert.ok(texts.some(t => /tap Court 3 now\nAlso free: 5, 2, 6, 1$/.test(t)));  // court 4 taken
  assert.ok(texts.some(t => /tap Court 5 now\nAlso free: 2, 6, 1$/.test(t)));     // then court 3
  assert.deepEqual(kinds(s.tg).slice(0, 3), ['send@21:55:00.000', 'send@21:59:30.000', 'edit@22:00:00.000']);
  for (const c of s.tg.calls.slice(1)) assert.equal(c.id, s.tg.calls[1].id);      // one message, edited in place
});

test('if the home server goes quiet, the card falls back to all six and keeps the alert', async () => {
  const s = await ready();
  // Posts stop at 22:00:10; the relay treats readings older than 25 s as gone.
  const courtsAt = t => (t <= at('2026-11-19T22:00:10Z') ? { ...ALL_FREE } : null);
  await night(s.app, s.relay, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:01:00Z', courtsAt);
  const texts = s.tg.calls.map(c => c.text);
  assert.match(texts[0], /Court 4 is free/);                                     // while the home server was posting
  const fellBack = texts[texts.length - 1];
  assert.match(fellBack, /Could not check which courts are free · all six below$/);   // after it went quiet
  const kb = s.tg.calls[s.tg.calls.length - 1].extra.reply_markup.inline_keyboard;
  assert.deepEqual(kb.map(r => r.map(b => b.text)), [['Court 4', 'Court 3', 'Court 5'], ['Court 2', 'Court 6', 'Court 1'], ['Whole sheet']]);
});

test('before any reading arrives the bot is patient, then falls back honestly to all six', async () => {
  const s = await ready();
  await night(s.app, s.relay, s.clock, '2026-11-19T21:59:00Z', '2026-11-19T22:00:30Z', () => null);   // the home server never posts
  const texts = s.tg.calls.map(c => c.text);
  assert.equal(texts[0], '<b>Thu 26 Nov · 19:00–21:00</b>\nOpens at 22:00:00 · wait for GO');          // links at 21:59:30, only two misses: plain six
  assert.ok(!texts.some(t => /No court shows as free/.test(t)));                                       // never a false "nothing free"
  assert.match(texts[texts.length - 1], /Could not check which courts are free · all six below$/);     // once it is plainly not answering
});

test('in split mode the start-up note and /status name the home server, not a block', async () => {
  const s = await ready();
  await s.app.announce();
  assert.match(s.tg.last().text, /Free-court readings come from your home server\. It reads ClubSpark on booking nights\.$/);
  assert.doesNotMatch(s.tg.last().text, /not working|turned this server away/);
  await s.app.handleUpdate(say(ME, '/status'));
  assert.match(s.tg.last().text, /Free-court check: on, waiting for the first reading from your home server/);

  // Once readings arrive (during a window), /status says when the last one came.
  await night(s.app, s.relay, s.clock, '2026-11-19T21:59:16Z', '2026-11-19T21:59:26Z', () => ({ ...ALL_FREE }));
  await s.app.handleUpdate(say(ME, '/status'));
  assert.match(s.tg.last().text, /Free-court check: on, last reading from your home server at 21:59:\d\d/);
});
