'use strict';
// The home agent's read-scheduling: on a booking night it reads the planned slot on the bot's
// own cadence and hands each reading back. It reuses lib/schedule, so the window matches the bot.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentLoop } = require('../lib/agent');
const { at } = require('./helpers');

const CFG = { plan: { thu: { start: 1140, hours: 2 } }, order: [4, 3, 5, 2, 6, 1], releaseMin: 1320, daysAhead: 7, lead: 30, free: true };
const ALL_FREE = { 1: 'free', 2: 'free', 3: 'free', 4: 'free', 5: 'free', 6: 'free' };

// Runs the agent loop over a stretch of a night, stepping the clock, collecting what it posts.
async function replay(cfg, from, to, { checker, step = 1000 } = {}) {
  let t = at(from);
  const reads = [], posts = [];
  const read = checker || (async (date, start, end) => { reads.push({ at: t, date, start, end }); return { ok: true, visible: true, courts: { ...ALL_FREE }, ms: 150 }; });
  const loop = createAgentLoop({ checkCourts: read, now: () => t });
  for (; t <= at(to); t += step) await loop(cfg, { onResult: r => posts.push({ at: t, ...r }) });
  return { reads, posts };
}
const hhmmss = ms => new Date(ms).toISOString().slice(11, 19);

test('reads only around the release, for the planned slot, on the bot\'s cadence', async () => {
  const { reads, posts } = await replay(CFG, '2026-11-19T21:00:00Z', '2026-11-19T23:00:00Z');
  assert.equal(reads.length, posts.length);
  assert.equal(hhmmss(reads[0].at), '21:59:15');                                   // 15 s before the courts go out
  assert.ok(reads.every(r => r.at < at('2026-11-19T22:05:00Z')));                  // stops five minutes after
  for (const r of reads) assert.deepEqual([r.date, r.start, r.end], ['2026-11-26', 1140, 1260]);
  const afterRelease = reads.filter(r => r.at >= at('2026-11-19T22:00:00Z') && r.at < at('2026-11-19T22:00:30Z'));
  assert.ok(afterRelease.length >= 10 && afterRelease.length <= 16, `about every 2 s: ${afterRelease.length}`);
  assert.ok(reads.length >= 30 && reads.length <= 60, String(reads.length));
  for (const p of posts) { assert.equal(p.ok, true); assert.equal(p.date, '2026-11-26'); assert.deepEqual(p.courts, ALL_FREE); }
});

test('nothing is read on a night that is not in the plan', async () => {
  const { reads } = await replay(CFG, '2026-11-20T21:00:00Z', '2026-11-20T23:00:00Z', { step: 2000 });   // Friday, not planned
  assert.equal(reads.length, 0);
});

test('with the check switched off, or no plan, the agent reads nothing', async () => {
  assert.equal((await replay({ ...CFG, free: false }, '2026-11-19T21:58:00Z', '2026-11-19T22:02:00Z')).reads.length, 0);
  assert.equal((await replay(null, '2026-11-19T21:58:00Z', '2026-11-19T22:02:00Z')).reads.length, 0);
  assert.equal((await replay({ plan: {}, order: [1, 2, 3, 4, 5, 6], releaseMin: 1320, daysAhead: 7, lead: 30 }, '2026-11-19T21:58:00Z', '2026-11-19T22:02:00Z')).reads.length, 0);
});

test('a reading that throws is posted as a failure, not swallowed', async () => {
  const checker = async () => { throw new Error('home internet down'); };
  const { posts } = await replay(CFG, '2026-11-19T21:59:00Z', '2026-11-19T21:59:40Z', { checker });
  assert.ok(posts.length >= 1);
  assert.deepEqual([posts[0].ok, posts[0].stop, posts[0].why, posts[0].date], [false, false, 'home internet down', '2026-11-26']);
});

test('a posted failure carries its reason and slot through', async () => {
  const checker = async () => ({ ok: false, stop: true, why: 'ClubSpark turned the home server away (HTTP 403, Cloudflare)' });
  const { posts } = await replay(CFG, '2026-11-19T21:59:00Z', '2026-11-19T21:59:20Z', { checker });
  assert.equal(posts[0].ok, false);
  assert.equal(posts[0].stop, true);
  assert.match(posts[0].why, /403/);
  assert.deepEqual([posts[0].date, posts[0].start, posts[0].end], ['2026-11-26', 1140, 1260]);
});
