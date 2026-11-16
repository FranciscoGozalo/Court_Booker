'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'court-alert-'));

test('saves and loads, creating the folder if needed', () => {
  const dir = path.join(tmp(), 'nested', 'data');
  const store = createStore(dir, { env: {} });
  assert.equal(store.load(), null);
  assert.equal(store.save({ owner: 1, plan: { thu: { start: 1140, hours: 2 } } }), true);
  assert.deepEqual(createStore(dir, { env: {} }).load(), { owner: 1, plan: { thu: { start: 1140, hours: 2 } } });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);                  // no half-written leftovers
});

test('a damaged file reads as nothing rather than crashing', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{"owner": 1, "pla');
  assert.equal(createStore(dir, { env: {} }).load(), null);
});

test('carries on in memory when the folder cannot be written', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const logs = [];
  const store = createStore(path.join(blocker, 'data'), { log: m => logs.push(m), env: {} });
  assert.equal(store.save({ a: 1 }), false);
  assert.equal(store.save({ a: 2 }), false);
  assert.equal(logs.length, 1);                                           // says so once, not on every save
  assert.equal(store.isPersistent(), false);
});

test('on Railway, settings only last if a volume is mounted where they are kept', () => {
  const dir = tmp();
  const railway = { RAILWAY_ENVIRONMENT: 'production' };
  assert.equal(createStore(dir, { env: {} }).isPersistent(), true);                                         // not Railway: an ordinary disk
  assert.equal(createStore(dir, { env: railway }).isPersistent(), false);                                   // Railway, no volume
  assert.equal(createStore(dir, { env: { ...railway, RAILWAY_VOLUME_MOUNT_PATH: dir } }).isPersistent(), true);
  assert.equal(createStore(path.join(dir, 'sub'), { env: { ...railway, RAILWAY_VOLUME_MOUNT_PATH: dir } }).isPersistent(), true);
  assert.equal(createStore(dir, { env: { ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/somewhere/else' } }).isPersistent(), false);
  assert.equal(createStore(dir + '-other', { env: { ...railway, RAILWAY_VOLUME_MOUNT_PATH: dir } }).isPersistent(), false);   // a sibling, not inside
});
