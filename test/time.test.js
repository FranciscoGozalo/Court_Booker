'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/time');
const { at } = require('./helpers');
const z = ms => new Date(ms).toISOString();

test('22:00 UK as an instant, winter and summer', () => {
  assert.equal(z(T.londonInstant(T.civil(2026, 11, 16), 1320)), '2026-11-16T22:00:00.000Z');   // GMT
  assert.equal(z(T.londonInstant(T.civil(2027, 6, 10), 1320)), '2027-06-10T21:00:00.000Z');    // BST
});

test('22:00 UK on the days the clocks change', () => {
  assert.equal(z(T.londonInstant(T.civil(2027, 3, 28), 1320)), '2027-03-28T21:00:00.000Z');    // spring forward
  assert.equal(z(T.londonInstant(T.civil(2027, 10, 31), 1320)), '2027-10-31T22:00:00.000Z');   // fall back
  assert.equal(z(T.londonInstant(T.civil(2027, 10, 31), 30)), '2027-10-30T23:30:00.000Z');     // 00:30, still BST
  assert.equal(z(T.londonInstant(T.civil(2027, 3, 27), 1439)), '2027-03-27T23:59:00.000Z');    // last minute of GMT
});

test('today in the UK, whatever the server clock says', () => {
  assert.equal(T.iso(T.todayCivil(at('2026-11-16T21:40:00Z'))), '2026-11-16');
  assert.equal(T.iso(T.todayCivil(at('2027-06-10T22:59:59Z'))), '2027-06-10');   // 23:59:59 BST
  assert.equal(T.iso(T.todayCivil(at('2027-06-10T23:30:00Z'))), '2027-06-11');   // 00:30 BST next day
  assert.equal(T.iso(T.todayCivil(at('2026-12-31T23:59:59Z'))), '2026-12-31');
  assert.equal(T.iso(T.todayCivil(at('2027-01-01T00:00:00Z'))), '2027-01-01');
});

test('dates: adding days, names and labels', () => {
  const thu = T.civil(2026, 11, 26);
  assert.deepEqual([T.iso(thu), T.label(thu), T.dayKey(thu), T.dayLong(thu)], ['2026-11-26', 'Thu 26 Nov', 'thu', 'Thursday']);
  assert.equal(T.iso(T.addDays(T.civil(2027, 3, 25), 7)), '2027-04-01');          // across the spring change
  assert.equal(T.iso(T.addDays(T.civil(2027, 10, 28), 7)), '2027-11-04');         // across the autumn change
  assert.equal(T.label(T.addDays(T.civil(2026, 12, 31), 7)), 'Thu 7 Jan');        // across the year end
  assert.equal(T.iso(T.addDays(T.civil(2028, 2, 28), 1)), '2028-02-29');          // leap day
  assert.equal(T.iso(T.addDays(T.civil(2026, 11, 16), -1)), '2026-11-15');
});

test('clock text', () => {
  assert.equal(T.hhmm(1320), '22:00');
  assert.equal(T.hhmm(545), '09:05');
  assert.equal(T.clockAt(at('2026-11-19T21:59:30Z')), '21:59:30');
  assert.equal(T.clockAt(at('2027-06-10T20:59:30Z')), '21:59:30');   // BST
  assert.equal(T.clockAt(at('2027-06-10T23:00:00Z')), '00:00:00');   // midnight shows as 00, never 24
});

test('how long from now, in words', () => {
  assert.equal(T.inWords(30000), 'in 30 s');
  assert.equal(T.inWords(29600), 'in 30 s');
  assert.equal(T.inWords(89000), 'in 89 s');
  assert.equal(T.inWords(5 * 60000), 'in 5 min');
  assert.equal(T.inWords(125 * 60000), 'in 2 h 5 min');
  assert.equal(T.inWords(3 * 3600000), 'in 3 h');
  assert.equal(T.inWords(3 * 86400000 + 20 * 60000), 'in 3 days');
  assert.equal(T.inWords(-500), 'in 0 s');
});
