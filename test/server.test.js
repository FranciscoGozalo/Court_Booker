'use strict';
// The endpoint your PC talks to.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../lib/server');

const TOKEN = 'a-long-random-line-for-testing-only';

async function withServer(handlers, fn) {
  const server = createServer({ token: TOKEN, ...handlers });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(r => server.close(r)); }
}
const auth = { authorization: `Bearer ${TOKEN}` };

test('health is open; everything else needs the token', async () => {
  await withServer({ getJobs: () => ({ jobs: [] }), onResult: async () => ({ ok: true }) }, async base => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/agent/jobs`)).status, 401);
    assert.equal((await fetch(`${base}/agent/jobs`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/nothing`, { headers: auth })).status, 404);
  });
});

test('the PC gets its jobs and can post a result', async () => {
  const got = [];
  const handlers = {
    getJobs: () => ({ jobs: [{ id: '2026-11-24@16:00' }], order: [3, 4] }),
    onResult: async r => { got.push(r); return r.id ? { ok: true } : { ok: false, why: 'no id' }; },
  };
  await withServer(handlers, async base => {
    const jobs = await (await fetch(`${base}/agent/jobs`, { headers: auth })).json();
    assert.deepEqual(jobs, { ok: true, jobs: [{ id: '2026-11-24@16:00' }], order: [3, 4] });
    const post = body => fetch(`${base}/agent/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ id: 'x', status: 'booked' }))).status, 200);
    assert.equal((await post(JSON.stringify({ status: 'booked' }))).status, 400);
    assert.equal((await post('not json')).status, 400);
    assert.deepEqual(got.map(r => r.id), ['x', undefined]);
  });
});

test('a result that cannot be passed on is a 500, so the PC tries again', async () => {
  await withServer({ getJobs: () => ({}), onResult: async () => { throw new Error('Telegram down'); } }, async base => {
    const res = await fetch(`${base}/agent/result`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'x' }) });
    assert.equal(res.status, 500);
  });
});
