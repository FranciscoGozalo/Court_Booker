'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/plan');

test('days', () => {
  for (const [text, want] of [['thu', 'thu'], ['Thu', 'thu'], ['THURSDAY', 'thu'], ['thurs', 'thu'], ['fri.', 'fri'], ['Saturday', 'sat'], ['sun', 'sun'], ['tues', 'tue'], ['wednes', 'wed']]) {
    assert.equal(P.parseDay(text), want, text);
  }
  for (const text of ['', 'th', 'thx', 'thursdayy', 'today', '19:00', null, undefined]) assert.equal(P.parseDay(text), null, String(text));
});

test('times', () => {
  for (const [text, want] of [['19:00', 1140], ['19.00', 1140], ['1900', 1140], ['19', 1140], ['7pm', 1140], ['7:30pm', 1170], ['7 PM', 1140], ['09:00', 540], ['9', 540], ['12am', 0], ['12pm', 720], ['00:00', 0], ['23:59', 1439]]) {
    assert.equal(P.parseTime(text), want, text);
  }
  for (const text of ['', '24:00', '19:60', '13pm', '0pm', 'seven', '7 o clock', '-1', '19:0', null, undefined]) assert.equal(P.parseTime(text), null, String(text));
});

test('lengths', () => {
  for (const [text, want] of [['1', 1], ['2', 2], ['1h', 1], ['2h', 2], ['2 h', 2], ['2hrs', 2], ['2 hours', 2], ['1 hour', 1], ['2H', 2]]) assert.equal(P.parseHours(text), want, text);
  for (const text of ['', '3', '0', '2.5', 'two', '90m', null, undefined]) assert.equal(P.parseHours(text), null, String(text));
});

test('court order', () => {
  assert.deepEqual(P.parseOrder('4 3 5 2 6 1'), [4, 3, 5, 2, 6, 1]);
  assert.deepEqual(P.parseOrder('4,3,5,2,6,1'), [4, 3, 5, 2, 6, 1]);
  assert.deepEqual(P.parseOrder('435261'), [4, 3, 5, 2, 6, 1]);
  assert.deepEqual(P.parseOrder('4 > 3 > 5'), [4, 3, 5, 1, 2, 6]);      // the rest follow in number order
  assert.deepEqual(P.parseOrder('6'), [6, 1, 2, 3, 4, 5]);
  for (const text of ['', '4 4 5', '7', '0 1 2', '4 x', '1234567', null, undefined]) assert.equal(P.parseOrder(text), null, String(text));
});

test('slot ends', () => {
  assert.deepEqual([P.slotEnd(1140, 1), P.slotEnd(1140, 2), P.slotEnd(1380, 2)], [1200, 1260, 1440]);
  assert.equal(P.slotText({ start: 1140, hours: 2 }), '19:00 to 21:00');
  assert.equal(P.slotText({ start: 540, hours: 1 }), '09:00 to 10:00');
});

test('a plan written as one line (the COURT_PLAN variable)', () => {
  assert.deepEqual(P.parsePlan('thu 19:00 2h, fri 18:00'), { thu: { start: 1140, hours: 2 }, fri: { start: 1080, hours: 1 } });
  assert.deepEqual(P.parsePlan('Thursday 7pm 2; sat 10'), { thu: { start: 1140, hours: 2 }, sat: { start: 600, hours: 1 } });
  assert.deepEqual(P.parsePlan('nonsense, thu, fri 25:00, mon 09:00'), { mon: { start: 540, hours: 1 } });
  assert.deepEqual(P.parsePlan(undefined), {});
  assert.deepEqual(P.parsePlan(''), {});
});

test('junk from storage comes out safe', () => {
  assert.deepEqual(P.cleanPlan({ thu: { start: 1140, hours: 2 }, fri: { start: -5 }, sat: 'x', zzz: { start: 600 }, sun: { start: 600.5 }, mon: { start: 600, hours: 9 } }),
    { mon: { start: 600, hours: 1 }, thu: { start: 1140, hours: 2 } });
  assert.deepEqual(P.cleanPlan(null), {});
  assert.deepEqual(P.cleanPlan('x'), {});
  assert.deepEqual(P.cleanOrder([4, 3, 5, 2, 6, 1]), [4, 3, 5, 2, 6, 1]);
  for (const bad of [[4, 4, 5, 2, 6, 1], [1, 2], 'x', null, [1, 2, 3, 4, 5, 7], [1, 2, 3, 4, 5, 6, 1]]) assert.deepEqual(P.cleanOrder(bad), [1, 2, 3, 4, 5, 6]);
});
