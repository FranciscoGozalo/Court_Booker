'use strict';
// The relay: Railway holds the latest reading the home server posted, and hands it to the bot
// in place of reading ClubSpark. The home agent reads ClubSpark; see agent.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelay, cleanReading } = require('../lib/relay');

const ALL_FREE = { 1: 'free', 2: 'free', 3: 'free', 4: 'free', 5: 'free', 6: 'free' };
const reading = (over = {}) => ({ date: '2026-11-26', start: 1140, end: 1260, ok: true, courts: { ...ALL_FREE }, visible: true, ms: 180, ...over });

test('a posted reading is cleaned to a known date, slot and courts', () => {
  assert.deepEqual(cleanReading(reading()), { date: '2026-11-26', start: 1140, end: 1260, ok: true, courts: ALL_FREE, visible: true, ms: 180 });
  // numbers as strings, odd states and missing courts are made safe
  const c = cleanReading({ date: '2026-11-26', start: '1140', end: '1260', ok: true, courts: { 1: 'free', 2: 'nonsense', 4: 'booked' } });
  assert.deepEqual(c.courts, { 1: 'free', 2: 'unknown', 3: 'unknown', 4: 'booked', 5: 'unknown', 6: 'unknown' });
  assert.equal(c.visible, true);
  assert.equal(cleanReading({ date: '2026-11-26', start: 1140, end: 1260, ok: true, courts: {} }).visible, false);
  const f = cleanReading({ date: '2026-11-26', start: 1140, end: 1260, ok: false, stop: true, why: 'blocked' });
  assert.deepEqual(f, { date: '2026-11-26', start: 1140, end: 1260, ok: false, stop: true, why: 'blocked' });
  for (const bad of [null, {}, { date: 'nope', start: 1, end: 2 }, { date: '2026-11-26', start: 1260, end: 1140 }, { date: '2026-11-26', start: 'x', end: 2 }]) {
    assert.equal(cleanReading(bad), null, JSON.stringify(bad));
  }
  assert.match(cleanReading({ date: '2026-11-26', start: 1140, end: 1260, ok: false }).why, /could not read/);
  assert.equal(cleanReading({ date: '2026-11-26', start: 1140, end: 1260, ok: false, why: 'x'.repeat(500) }).why.length, 200);
});

test('the bot gets the latest reading, but only while it is fresh and for the slot it asks about', () => {
  let t = 1_000_000;
  const relay = createRelay({ now: () => t, freshMs: 25000 });
  assert.deepEqual(relay.checkCourts('2026-11-26', 1140, 1260), { ok: false, stop: false, why: 'no reading from the home server yet' });

  assert.deepEqual(relay.put(reading()), { ok: true });
  assert.deepEqual(relay.checkCourts('2026-11-26', 1140, 1260), { ok: true, courts: ALL_FREE, visible: true, ms: 180 });
  assert.deepEqual(relay.checkCourts('2026-11-26', 600, 720), { ok: false, stop: false, why: 'no reading from the home server yet' });   // a different slot
  assert.deepEqual(relay.checkCourts('2026-11-27', 1140, 1260).ok, false);                                                             // a different day

  t += 20000;
  assert.equal(relay.checkCourts('2026-11-26', 1140, 1260).ok, true);                                                                  // still fresh
  t += 10000;                                                                                                                          // 30 s old now
  const stale = relay.checkCourts('2026-11-26', 1140, 1260);
  assert.deepEqual(stale, { ok: false, stop: false, why: 'the home server last answered 30 s ago' });                                  // falls back, but keeps trying

  relay.put(reading({ courts: { ...ALL_FREE, 4: 'booked' } }));                                                                        // a newer reading replaces it
  assert.equal(relay.checkCourts('2026-11-26', 1140, 1260).courts[4], 'booked');
});

test('a posted failure is passed on, carrying whether to stop for the night', () => {
  let t = 5_000_000;
  const relay = createRelay({ now: () => t });
  relay.put(reading({ ok: false, stop: true, why: 'ClubSpark turned the home server away', courts: undefined }));
  assert.deepEqual(relay.checkCourts('2026-11-26', 1140, 1260), { ok: false, stop: true, why: 'ClubSpark turned the home server away' });
  relay.put(reading({ ok: false, stop: false, why: 'home internet is down', courts: undefined }));
  assert.deepEqual(relay.checkCourts('2026-11-26', 1140, 1260), { ok: false, stop: false, why: 'home internet is down' });
});

test('junk is refused and never stored', () => {
  const relay = createRelay();
  assert.deepEqual(relay.put({ nonsense: true }), { ok: false, why: 'that reading made no sense' });
  assert.equal(relay.status().posts, 0);
});

test('status says whether a fresh reading has arrived', () => {
  let t = 2_000_000;
  const relay = createRelay({ now: () => t, freshMs: 25000 });
  assert.deepEqual(relay.status(), { posts: 0, lastPostAt: null, fresh: false });
  relay.put(reading());
  assert.deepEqual(relay.status(), { posts: 1, lastPostAt: 2_000_000, fresh: true });
  t += 30000;
  assert.equal(relay.status().fresh, false);
});
