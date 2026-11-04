'use strict';
// Synthetic 5-minute-style workload: it measures cache/navigation bookkeeping,
// not real browser paint, IME or zoom latency.
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { StatusCache } = require('../lib/status-cache.cjs');

test('synthetic five-minute read stream keeps cache work bounded', async t => {
  let now = 0;
  const cache = new StatusCache({ ttl: 2500, now: () => now });
  const keys = ['inspect', 'workspace', 'settings', 'connections'];
  const payload = { marker: 'synthetic', rows: Array.from({ length: 500 }, (_, index) => ({ index, value: 'x'.repeat(80) })) };
  let loads = 0;
  const loader = async () => { loads += 1; return payload; };
  const started = performance.now();
  let reads = 0;
  for (let cycle = 0; cycle < 50; cycle += 1) {
    now += 6000; // 50 cycles * 6s = five synthetic minutes
    for (const key of keys) {
      for (let repeat = 0; repeat < 6; repeat += 1) {
        const result = await cache.request(key, loader);
        assert.equal(result.status, 'ok');
        assert.equal(result.value, payload);
        reads += 1;
      }
    }
  }
  const elapsedMs = performance.now() - started;
  assert.equal(reads, 1200);
  assert.equal(loads, 50 * keys.length); // one TTL reload per key per synthetic six-second cycle
  const metrics = cache.metrics();
  assert.ok(cache.entries.size <= keys.length);
  t.diagnostic(JSON.stringify({ reads, loads, elapsedMs: Math.round(elapsedMs * 100) / 100, metrics }));
});
