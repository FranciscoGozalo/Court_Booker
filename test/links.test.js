'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/links');
const { civil } = require('../lib/time');

// The confirm-screen address copied from ClubSpark on 16 Nov 2026: Court 4, Tue 17 Nov, 15:00 to 16:00.
const GIVEN = 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/Book?Contacts%5B0%5D.IsPrimary=true&Contacts%5B0%5D.IsJunior=false&Contacts%5B0%5D.IsPlayer=true&ResourceID=41c43943-426c-422d-adf6-d84367f60067&Date=2026-11-17&SessionID=ff6ac50a-dbea-4388-90d7-dcc8332240fd&StartTime=900&EndTime=960&Category=0&SubCategory=0&VenueID=44c8485b-ba20-4617-b364-445810cb9212&ResourceGroupID=44c8485b-ba20-4617-b364-445810cb9212';

test('rebuilds the real confirm-screen address exactly', () => {
  assert.equal(L.directUrl(4, civil(2026, 11, 17), 900, 960, L.DEFAULT_SID), GIVEN);
});

test('another court, day and a two-hour slot', () => {
  const u = new URL(L.directUrl(2, civil(2026, 11, 26), 1140, 1260, L.DEFAULT_SID));
  assert.equal(u.origin + u.pathname, 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/Book');
  assert.equal(u.searchParams.get('ResourceID'), '83d4fedf-f1e1-4ace-a34b-6000d23db0b2');
  assert.equal(u.searchParams.get('Date'), '2026-11-26');
  assert.equal(u.searchParams.get('StartTime'), '1140');
  assert.equal(u.searchParams.get('EndTime'), '1260');
  assert.equal(u.searchParams.get('Contacts[0].IsPrimary'), 'true');
  assert.equal(u.searchParams.get('VenueID'), L.VENUE);
});

test('six different courts', () => {
  assert.deepEqual(Object.keys(L.COURTS), ['1', '2', '3', '4', '5', '6']);
  assert.equal(new Set(Object.values(L.COURTS)).size, 6);
  for (const id of Object.values(L.COURTS)) assert.match(id, L.GUID);
});

test('every link points at ClubSpark and nowhere else', () => {
  for (let n = 1; n <= 6; n++) assert.equal(new URL(L.directUrl(n, civil(2027, 1, 7), 600, 660, L.DEFAULT_SID)).hostname, 'clubspark.lta.org.uk');
  assert.equal(L.sheetUrl(civil(2026, 11, 26)), 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/BookByDate#?date=2026-11-26&role=guest');
});

test('reading a booking code out of a pasted address', () => {
  assert.deepEqual(L.parseBookAddress('  ' + GIVEN + '\n'), { ok: true, sid: 'ff6ac50a-dbea-4388-90d7-dcc8332240fd', court: 4 });
  assert.deepEqual(L.parseBookAddress(GIVEN.replace('ff6ac50a', 'FF6AC50A')).sid, 'ff6ac50a-dbea-4388-90d7-dcc8332240fd');
  assert.equal(L.parseBookAddress(GIVEN.replace(/ResourceID=[^&]+/, 'ResourceID=00000000-0000-0000-0000-000000000000')).court, 0);
});

test('refuses addresses that are not the Kelvingrove confirm screen', () => {
  const bad = [
    GIVEN.replace('clubspark.lta.org.uk', 'evil.example'),
    GIVEN.replace('clubspark.lta.org.uk', 'clubspark.lta.org.uk.evil.example'),
    GIVEN.replace('KelvingroveParkTennisCourts', 'SomeOtherVenue'),
    'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/BookByDate#?date=2026-11-17&role=guest',
    'https://checkout.stripe.com/g/pay/cs_live_x#abc',
    GIVEN.replace('ff6ac50a-dbea-4388-90d7-dcc8332240fd', '"><script>'),
    GIVEN.replace(/&SessionID=[^&]+/, ''),
    'hello', '', null, undefined,
  ];
  for (const b of bad) {
    const got = L.parseBookAddress(b);
    assert.equal(got.ok, false, String(b));
    assert.ok(got.why.length > 10);
  }
});
