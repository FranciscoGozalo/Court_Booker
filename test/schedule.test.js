'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/schedule');
const { civil, iso } = require('../lib/time');
const { at } = require('./helpers');
const z = ms => new Date(ms).toISOString();

// Thursdays 19:00 for two hours, Fridays 19:00 for one. Kelvingrove's rule: 7 days ahead at 22:00.
const cfg = (over = {}) => ({
  plan: { thu: { start: 1140, hours: 2 }, fri: { start: 1140, hours: 1 } },
  daysAhead: 7, releaseMin: 1320, lead: 30, warnMin: 5, go: true, ...over,
});

test('a Thursday night releases the Thursday a week on', () => {
  const rel = S.releaseFor(civil(2026, 11, 19), cfg());
  assert.deepEqual([iso(rel.night), iso(rel.playDate), z(rel.releaseAt), rel.start, rel.end, rel.hours],
    ['2026-11-19', '2026-11-26', '2026-11-19T22:00:00.000Z', 1140, 1260, 2]);
  assert.equal(S.releaseFor(civil(2026, 11, 16), cfg()), null);             // Monday is not in the plan
  assert.equal(S.releaseFor(civil(2026, 11, 20), cfg()).end, 1200);         // Friday is one hour
});

test('the three timed messages for one release', () => {
  const ev = S.eventsFor(S.releaseFor(civil(2026, 11, 19), cfg()), cfg());
  assert.deepEqual(ev.map(e => [e.type, z(e.at), e.key]), [
    ['warn', '2026-11-19T21:55:00.000Z', '2026-11-19:warn'],
    ['links', '2026-11-19T21:59:30.000Z', '2026-11-19:links'],
    ['go', '2026-11-19T22:00:00.000Z', '2026-11-19:go'],
  ]);
});

test('settings change which messages there are', () => {
  const types = c => S.eventsFor(S.releaseFor(civil(2026, 11, 19), c), c).map(e => e.type);
  assert.deepEqual(types(cfg({ warnMin: 0 })), ['links', 'go']);
  assert.deepEqual(types(cfg({ go: false })), ['warn', 'links']);
  assert.deepEqual(types(cfg({ warnMin: 1 })), ['warn', 'links', 'go']);              // a minute before still fits ahead of the links
  assert.deepEqual(types(cfg({ warnMin: 1, lead: 60 })), ['links', 'go']);            // no point warning as the links arrive
  const one = S.eventsFor(S.releaseFor(civil(2026, 11, 19), cfg({ warnMin: 1 })), cfg({ warnMin: 1 }))[0];
  assert.deepEqual([z(one.at), z(one.until)], ['2026-11-19T21:59:00.000Z', '2026-11-19T21:59:25.000Z']);   // never on top of the links
  const ev = S.eventsFor(S.releaseFor(civil(2026, 11, 19), cfg({ lead: 45 })), cfg({ lead: 45 }));
  assert.equal(z(ev.find(e => e.type === 'links').at), '2026-11-19T21:59:15.000Z');
});

test('what is due at each moment of the night', () => {
  const due = (t, sent = {}) => S.dueEvents(at(t), cfg(), sent).map(e => e.type);
  assert.deepEqual(due('2026-11-19T21:54:59.999Z'), []);
  assert.deepEqual(due('2026-11-19T21:55:00.000Z'), ['warn']);
  assert.deepEqual(due('2026-11-19T21:55:00.000Z', { '2026-11-19:warn': 1 }), []);
  assert.deepEqual(due('2026-11-19T21:59:29.999Z', { '2026-11-19:warn': 1 }), []);
  assert.deepEqual(due('2026-11-19T21:59:30.000Z', { '2026-11-19:warn': 1 }), ['links']);
  assert.deepEqual(due('2026-11-19T21:59:59.999Z', { '2026-11-19:warn': 1, '2026-11-19:links': 1 }), []);
  assert.deepEqual(due('2026-11-19T22:00:00.000Z', { '2026-11-19:warn': 1, '2026-11-19:links': 1 }), ['go']);
  assert.deepEqual(due('2026-11-19T22:00:00.000Z', { '2026-11-19:warn': 1, '2026-11-19:links': 1, '2026-11-19:go': 1 }), []);
});

test('late starts: only messages that are still useful', () => {
  const due = t => S.dueEvents(at(t), cfg(), {}).map(e => e.type);
  assert.deepEqual(due('2026-11-19T21:56:59Z'), ['warn']);            // heads-up still worth it
  assert.deepEqual(due('2026-11-19T21:57:00Z'), []);                  // two minutes late: skip it
  assert.deepEqual(due('2026-11-19T21:59:26Z'), []);
  assert.deepEqual(due('2026-11-19T21:59:45Z'), ['links']);
  assert.deepEqual(due('2026-11-19T22:00:10Z'), ['links', 'go']);
  assert.deepEqual(due('2026-11-19T22:02:59Z'), ['links', 'go']);
  assert.deepEqual(due('2026-11-19T22:03:00Z'), []);                  // three minutes on, the moment has passed
  assert.deepEqual(due('2026-11-18T22:00:00Z'), []);                  // Wednesday: nothing in the plan a week on
});

test('the next release still to come', () => {
  const next = t => { const r = S.nextRelease(at(t), cfg()); return r && [iso(r.night), iso(r.playDate)]; };
  assert.deepEqual(next('2026-11-16T21:40:00Z'), ['2026-11-19', '2026-11-26']);
  assert.deepEqual(next('2026-11-19T21:59:59Z'), ['2026-11-19', '2026-11-26']);
  assert.deepEqual(next('2026-11-19T22:00:00Z'), ['2026-11-20', '2026-11-27']);
  assert.deepEqual(next('2026-11-20T22:00:00Z'), ['2026-11-26', '2026-12-03']);
  assert.equal(S.nextRelease(at('2026-11-16T21:40:00Z'), cfg({ plan: {} })), null);
});

test('how long until the next message', () => {
  assert.equal(S.msToNextEvent(at('2026-11-19T21:54:59.900Z'), cfg()), 100);
  assert.equal(S.msToNextEvent(at('2026-11-19T21:55:00.000Z'), cfg()), 270000);    // warn is now; links are next
  assert.equal(S.msToNextEvent(at('2026-11-19T21:59:59.990Z'), cfg()), 10);
  assert.equal(S.msToNextEvent(at('2026-11-19T22:00:00.000Z'), cfg()), null);
  assert.equal(S.msToNextEvent(at('2026-11-19T12:00:00.000Z'), cfg()), 9 * 3600000 + 55 * 60000);
  assert.equal(S.msToNextEvent(at('2026-11-16T12:00:00.000Z'), cfg()), null);      // nothing on a Monday
});

test('summer time and the weeks the clocks change', () => {
  const rel = (y, m, d, c = cfg({ plan: { thu: { start: 1140, hours: 1 }, sun: { start: 600, hours: 1 } } })) => {
    const r = S.releaseFor(civil(y, m, d), c); return [iso(r.playDate), z(r.releaseAt)];
  };
  assert.deepEqual(rel(2027, 6, 10), ['2027-06-17', '2027-06-10T21:00:00.000Z']);    // BST: 22:00 is 21:00 UTC
  assert.deepEqual(rel(2027, 3, 25), ['2027-04-01', '2027-03-25T22:00:00.000Z']);    // GMT night, BST play day
  assert.deepEqual(rel(2027, 3, 28), ['2027-04-04', '2027-03-28T21:00:00.000Z']);    // the night of the spring change
  assert.deepEqual(rel(2027, 10, 31), ['2027-11-07', '2027-10-31T22:00:00.000Z']);   // the night of the autumn change
  assert.deepEqual(rel(2027, 10, 28), ['2027-11-04', '2027-10-28T21:00:00.000Z']);   // BST night, GMT play day
  assert.deepEqual(rel(2026, 12, 31), ['2027-01-07', '2026-12-31T22:00:00.000Z']);   // year end
  assert.deepEqual(S.dueEvents(at('2027-06-10T20:59:30Z'), cfg(), {}).map(e => e.type), ['links']);              // 21:59:30 BST
});

test('other release rules', () => {
  const c = cfg({ daysAhead: 6, releaseMin: 20 * 60, plan: { sun: { start: 600, hours: 1 } } });
  const r = S.releaseFor(civil(2026, 11, 16), c);                                   // Monday night -> Sunday
  assert.deepEqual([iso(r.playDate), z(r.releaseAt)], ['2026-11-22', '2026-11-16T20:00:00.000Z']);
});

test('a release just before midnight still gets its links after midnight', () => {
  const c = cfg({ releaseMin: 23 * 60 + 59, plan: { thu: { start: 1140, hours: 1 } } });
  assert.deepEqual(S.dueEvents(at('2026-11-20T00:01:00Z'), c, {}).map(e => e.key), ['2026-11-19:links', '2026-11-19:go']);
  assert.deepEqual(S.dueEvents(at('2026-11-20T00:01:00Z'), c, { '2026-11-19:links': 1, '2026-11-19:go': 1 }).map(e => e.key), []);
  assert.deepEqual(S.dueEvents(at('2026-11-20T00:02:00Z'), c, {}).map(e => e.key), []);                 // three minutes on
});

test('a day that is already open, for trying the links', () => {
  const rel = S.releaseFor(civil(2026, 11, 19), cfg());                             // for Thu 26 Nov 19:00
  assert.equal(iso(S.checkDate(at('2026-11-17T12:00:00Z'), cfg(), rel)), '2026-11-19');   // same weekday this week
  assert.equal(iso(S.checkDate(at('2026-11-19T18:54:00Z'), cfg(), rel)), '2026-11-19');   // still more than 5 min before 19:00
  assert.equal(iso(S.checkDate(at('2026-11-19T18:56:00Z'), cfg(), rel)), '2026-11-20');   // too close: tomorrow
  assert.equal(iso(S.checkDate(at('2026-11-19T21:58:00Z'), cfg(), rel)), '2026-11-20');   // on the night itself
  const next = S.nextRelease(at('2026-11-19T22:30:00Z'), cfg());                    // now pointing at Fri 27
  assert.equal(iso(S.checkDate(at('2026-11-19T22:30:00Z'), cfg(), next)), '2026-11-20');
});
