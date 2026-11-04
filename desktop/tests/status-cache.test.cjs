'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StatusCache } = require('../lib/status-cache.cjs');

test('concurrent identical reads coalesce into one loader and cache the result', async () => {
  let calls = 0;
  let release;
  const cache = new StatusCache({ ttl: 10000, now: () => 1000 });
  const loader = () => { calls += 1; return new Promise(resolve => { release = () => resolve({ value: calls }); }); };
  const pending = Array.from({ length: 20 }, () => cache.get('status', loader));
  await new Promise(resolve => setImmediate(resolve));
  release();
  const values = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.equal(values.every(value => value.value === 1), true);
  assert.deepEqual(await cache.get('status', loader), { value: 1 });
  assert.equal(calls, 1);
  const metrics = cache.metrics();
  assert.equal(metrics.loads, 1);
  assert.equal(metrics.coalesced, 19);
  assert.equal(metrics.hits, 1);
});

test('failed loads are not cached and a retry can succeed', async () => {
  let calls = 0;
  const cache = new StatusCache({ ttl: 10000, now: () => 0 });
  const loader = async () => { calls += 1; if (calls === 1) throw new Error('synthetic read failure'); return 'ok'; };
  await assert.rejects(cache.get('status', loader), /synthetic/);
  assert.equal(await cache.get('status', loader), 'ok');
  assert.equal(calls, 2);
});

test('invalidated generations cannot overwrite a newer snapshot', async () => {
  let sequence = 0;
  const cache = new StatusCache({ ttl: 10000, now: () => 0 });
  const pending = cache.request('slow', () => new Promise(resolve => setTimeout(() => resolve(`old-${++sequence}`), 10)));
  cache.invalidate();
  const result = await pending;
  assert.equal(result.status, 'stale');
  assert.equal(cache.peek('slow'), undefined);
  assert.equal(await cache.get('slow', async () => 'new'), 'new');
  assert.equal(cache.peek('slow'), 'new');
});

test('two fresh requests may resolve out of order but only the later-started one wins', async () => {
  let releaseFirst, releaseSecond;
  const cache = new StatusCache({ ttl: 10000, now: () => 0 });
  const first = cache.request('key', () => new Promise(resolve => { releaseFirst = resolve; }), { fresh: true });
  const second = cache.request('key', () => new Promise(resolve => { releaseSecond = resolve; }), { fresh: true });
  releaseSecond('new');
  const secondResult = await second;
  assert.equal(secondResult.status, 'ok');
  assert.equal(secondResult.value, 'new');
  releaseFirst('old');
  const firstResult = await first;
  assert.equal(firstResult.status, 'stale');
  assert.equal(cache.peek('key'), 'new');
});

test('closing cancels an in-flight request and refuses new ones', async () => {
  let release;
  const cache = new StatusCache({ ttl: 10000, now: () => 0 });
  const pending = cache.request('key', () => new Promise(resolve => { release = resolve; }));
  cache.close();
  release('late');
  assert.deepEqual(await pending, { status: 'closed' });
  assert.deepEqual(await cache.request('key', async () => 'new'), { status: 'closed' });
  await assert.rejects(cache.get('key', async () => 'new'), /关闭/);
});

test('expired entries reload and a closed cache refuses new reads', async () => {
  let now = 0, calls = 0;
  const cache = new StatusCache({ ttl: 100, now: () => now });
  const loader = async () => { calls += 1; return calls; };
  assert.equal(await cache.get('status', loader), 1);
  now = 99;
  assert.equal(await cache.get('status', loader), 1);
  now = 101;
  assert.equal(await cache.get('status', loader), 2);
  assert.equal(await cache.get('status', loader, { fresh: true }), 3);
  cache.close();
  await assert.rejects(cache.get('status', loader), /关闭/);
});
