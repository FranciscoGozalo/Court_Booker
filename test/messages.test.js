'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/messages');
const S = require('../lib/schedule');
const L = require('../lib/links');
const { civil } = require('../lib/time');
const { at } = require('./helpers');

const cfg = (over = {}) => ({
  plan: { thu: { start: 1140, hours: 2 } }, order: [4, 3, 5, 2, 6, 1], sid: L.DEFAULT_SID,
  daysAhead: 7, releaseMin: 1320, lead: 30, warnMin: 5, go: true, style: 'both', ...over,
});
const rel = c => S.releaseFor(civil(2026, 11, 19), c);
const plain = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const linksAt = at('2026-11-19T21:59:30Z');

test('the links message before the release', () => {
  const c = cfg(), m = M.linksMessage(c, rel(c), 'wait', linksAt);
  const lines = plain(m.text).split('\n');
  assert.equal(lines[0], 'Thu 26 Nov · 19:00 to 21:00');
  assert.equal(lines[1], '⏳ Opens at 22:00:00, in 30 s. Wait for GO.');
  assert.equal(lines[3], 'Court 4, one tap:');
  assert.equal(lines[4], L.directUrl(4, civil(2026, 11, 26), 1140, 1260, L.DEFAULT_SID));
  assert.equal(lines.length, 5);
  assert.equal(m.extra.parse_mode, 'HTML');
});

test('the court buttons follow the chosen order and carry the right slot', () => {
  const c = cfg(), kb = M.linksMessage(c, rel(c), 'wait', linksAt).extra.reply_markup.inline_keyboard;
  assert.deepEqual(kb.map(r => r.map(b => b.text)), [['Court 4', 'Court 3', 'Court 5'], ['Court 2', 'Court 6', 'Court 1'], ['Whole sheet']]);
  for (const [i, n] of [4, 3, 5, 2, 6, 1].entries()) {
    const u = new URL(kb[Math.floor(i / 3)][i % 3].url);
    assert.equal(u.hostname, 'clubspark.lta.org.uk');
    assert.deepEqual([u.searchParams.get('ResourceID'), u.searchParams.get('Date'), u.searchParams.get('StartTime'), u.searchParams.get('EndTime')],
      [L.COURTS[n], '2026-11-26', '1140', '1260']);
  }
  assert.equal(kb[2][0].url, 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/BookByDate#?date=2026-11-26&role=guest');
});

test('turning to GO changes one line and moves nothing', () => {
  for (const style of ['both', 'links', 'buttons']) {
    const c = cfg({ style });
    const w = M.linksMessage(c, rel(c), 'wait', linksAt), g = M.linksMessage(c, rel(c), 'go', at('2026-11-19T22:00:00Z'));
    const wl = w.text.split('\n'), gl = g.text.split('\n');
    assert.equal(wl.length, gl.length, style);
    assert.deepEqual(wl.filter((l, i) => l !== gl[i]).length, 1, style);
    assert.equal(plain(gl[1]), '🟢 GO. Open now. Tap a court.');
    assert.notEqual(w.text, g.text);
    assert.deepEqual(w.extra, g.extra, style);                         // same buttons in the same places
  }
});

test('the three styles', () => {
  const both = M.linksMessage(cfg(), rel(cfg()), 'wait', linksAt);
  const links = M.linksMessage(cfg({ style: 'links' }), rel(cfg()), 'wait', linksAt);
  const buttons = M.linksMessage(cfg({ style: 'buttons' }), rel(cfg()), 'wait', linksAt);
  assert.equal(buttons.text.split('\n').length, 2);
  assert.ok(buttons.extra.reply_markup && both.extra.reply_markup);
  assert.equal(links.extra.reply_markup, undefined);
  const written = plain(links.text).split('\n').filter(l => l.startsWith('https://'));
  assert.deepEqual(written, [4, 3, 5, 2, 6, 1].map(n => L.directUrl(n, civil(2026, 11, 26), 1140, 1260, L.DEFAULT_SID)).concat(L.sheetUrl(civil(2026, 11, 26))));
  assert.ok(plain(links.text).length < 4096, 'fits in one Telegram message');
  assert.ok(Buffer.byteLength(JSON.stringify(both.extra.reply_markup)) < 10000);
});

test('written-out links are never wrapped in hidden-link markup, and nothing is fetched for a preview', () => {
  for (const style of ['both', 'links', 'buttons']) {
    const c = cfg({ style });
    for (const m of [M.linksMessage(c, rel(c), 'wait', linksAt), M.linksMessage(c, rel(c), 'go', linksAt), M.warnMessage(c, rel(c), linksAt), M.testMessage(c, rel(c), civil(2026, 11, 20), 'wait')]) {
      assert.ok(!/<a\s/i.test(m.text));
      assert.deepEqual(m.extra.link_preview_options, { is_disabled: true });
      assert.ok(!/&(?!amp;|lt;|gt;)/.test(m.text), 'every & is escaped');
    }
  }
});

test('a late links message counts down from where it is', () => {
  const c = cfg();
  assert.match(M.linksMessage(c, rel(c), 'wait', at('2026-11-19T21:59:45Z')).text, /in 15 s\. Wait for GO\./);
});

test('the heads-up', () => {
  const c = cfg(), m = M.warnMessage(c, rel(c), at('2026-11-19T21:55:00Z'));
  assert.equal(plain(m.text), 'Kelvingrove · Thu 26 Nov opens at 22:00\nYour slot: 19:00 to 21:00. Courts in order: 4, 3, 5, 2, 6, 1.\nThe court links arrive at 21:59:30. Check you are signed in now.');
  assert.deepEqual(m.extra.reply_markup.inline_keyboard, [[{ text: 'Check I am signed in', url: 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/BookByDate' }]]);
});

test('the try-out message', () => {
  const c = cfg(), m = M.testMessage(c, rel(c), civil(2026, 11, 20), 'wait'), g = M.testMessage(c, rel(c), civil(2026, 11, 20), 'go');
  assert.equal(plain(m.text).split('\n')[0], 'TEST · Fri 20 Nov · 19:00 to 21:00');
  assert.match(m.extra.reply_markup.inline_keyboard[0][0].url, /Date=2026-11-20&/);
  assert.equal(m.text.split('\n').length, g.text.split('\n').length);
  assert.match(g.text, /GO/);
});

test('plan, next alert and status', () => {
  const c = cfg({ plan: { thu: { start: 1140, hours: 2 }, fri: { start: 1080, hours: 1 }, sun: { start: 600, hours: 1 } } });
  const now = at('2026-11-16T21:40:00Z');
  const p = plain(M.planMessage(c, now, false));
  assert.match(p, /Thursday: 19:00 to 21:00\nFriday: 18:00 to 19:00\nSunday: 10:00 to 11:00/);   // Monday first, Sunday last
  assert.match(p, /Court order: 4, 3, 5, 2, 6, 1/);
  assert.match(p, /Links arrive 30 s before the 22:00 release, then turn to GO\./);
  assert.match(p, /Heads-up 5 min before\./);
  assert.equal(M.nextLine(c, now, false), 'Next alert: Thu 19 Nov at 21:59:30 (in 3 days), for Thu 26 Nov 19:00 to 21:00.');
  assert.equal(M.nextLine(c, at('2026-11-19T21:58:00Z'), false), 'Next alert: Thu 19 Nov at 21:59:30 (in 2 min), for Thu 26 Nov 19:00 to 21:00.');
  assert.equal(M.nextLine(c, now, true), 'Alerts are paused. Send /resume to switch them back on.');
  assert.equal(M.nextLine(cfg({ plan: {} }), now, false), 'No alert is scheduled.');
  assert.match(plain(M.planMessage(cfg({ plan: {} }), now, false)), /No days set yet/);
  const st = plain(M.statusMessage(c, now, { version: '1.0', skewMs: 120, kept: 'disk', paused: false }));
  assert.match(st, /UK time now: 21:40:00/);
  assert.match(st, /Clock: in step with Telegram's/);
  assert.match(st, /Settings kept across restarts: yes/);
  assert.match(st, /Booking code ends 2240fd/);
  assert.match(plain(M.statusMessage(c, now, { version: '1.0', skewMs: -4200, kept: 'no', paused: false })), /Clock: 4 s behind Telegram's, so alerts will be late by that much[\s\S]*restarts: NO/);
  assert.match(plain(M.statusMessage(c, now, { version: '1.0', skewMs: null, kept: 'variable', paused: false })), /Clock: not checked yet[\s\S]*restarts: yes, from the COURT_SETTINGS variable/);
});

test('escaping', () => {
  assert.equal(M.esc('a<b>&"c'), 'a&lt;b&gt;&amp;"c');
});
