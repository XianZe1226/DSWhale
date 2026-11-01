process.env.BILI_TRAFFIC_TEST = '1'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ok = () => new Response(JSON.stringify({ code: 0, data: {} }))
let instance = 0
async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-legacy-throttle-'))
  const previousHome = process.env.DSWHALE_DATA_HOME
  process.env.DSWHALE_DATA_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSWHALE_DATA_HOME
    else process.env.DSWHALE_DATA_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  const directory = path.join(home, '.bili-ai')
  fs.mkdirSync(directory)
  const { apiGet } = await import('../tools/lib/bili-api.mjs?legacy-throttle=' + ++instance)
  const epoch = Date.now()
  let elapsed = 1000
  t.mock.method(Date, 'now', () => epoch + elapsed)
  t.mock.method(performance, 'now', () => elapsed)
  // Advance a controlled clock at the timer boundary, without real-time races.
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    elapsed += ms
    queueMicrotask(callback)
  })
  return {
    directory,
    now: () => elapsed,
    advance: ms => { elapsed += ms },
    get: i => apiGet('https://api.bilibili.com/x/v2/reply?oid=' + i),
    apiGet,
  }
}

for (const outcome of ['success', 'error']) {
  test(`slow predispatch log preserves actual spacing after transport ${outcome}`, async t => {
    const s = await setup(t)
    const append = fs.appendFileSync
    let delayed = false
    t.mock.method(fs, 'appendFileSync', function (file, ...args) {
      if (!delayed && file === path.join(s.directory, 'api-requests.log')) {
        delayed = true
        s.advance(225)
      }
      return append.call(this, file, ...args)
    })
    const starts = []
    t.mock.method(globalThis, 'fetch', async () => {
      starts.push(s.now())
      if (starts.length === 1 && outcome === 'error') throw new Error('synthetic transport failure')
      return ok()
    })
    const results = await Promise.all([1, 2, 3].map(s.get))
    assert.deepEqual(results.map(r => r.code), outcome === 'error' ? [-1, 0, 0] : [0, 0, 0])
    assert.equal(starts.length, 3)
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] - starts[i - 1] >= 300, JSON.stringify(starts))
    }
  })
}

for (const risk of ['http', 'payload']) {
  test(`queued requests observe a ${risk} ban before dispatch and the queue recovers`, async t => {
    const s = await setup(t)
    const starts = []
    t.mock.method(globalThis, 'fetch', async () => {
      starts.push(s.now())
      return risk === 'http' ? new Response('', { status: 412 })
        : new Response(JSON.stringify({ code: -412, message: 'risk' }))
    })
    const results = await Promise.all([1, 2, 3].map(s.get))
    assert.deepEqual(results.map(r => r.code), [-412, -412, -412])
    assert.equal(starts.length, 1, 'queued calls must not reach the network after the first risk response')
    fs.unlinkSync(path.join(s.directory, 'api-ban.json'))
    t.mock.method(globalThis, 'fetch', async () => { starts.push(s.now()); return ok() })
    assert.equal((await s.get(4)).code, 0)
    assert.equal(starts.length, 2)
  })
}

test('a failure before transport does not poison the queue', async t => {
  const s = await setup(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return ok() })
  const timeout = AbortSignal.timeout
  let first = true
  t.mock.method(AbortSignal, 'timeout', function (...args) {
    if (first) { first = false; throw new Error('synthetic signal failure') }
    return timeout.apply(this, args)
  })
  const results = await Promise.all([1, 2].map(s.get))
  assert.deepEqual(results.map(r => r.code), [-1, 0])
  assert.equal(calls, 1)
})

test('recursive WBI nav completes before entering the dispatch queue', async t => {
  const s = await setup(t)
  const paths = []
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input)
    paths.push(url.pathname)
    if (url.pathname.endsWith('/nav')) return new Response(JSON.stringify({ code: 0, data: {
      wbi_img: { img_url: 'https://i.test/' + 'a'.repeat(32) + '.png', sub_url: 'https://i.test/' + 'b'.repeat(32) + '.png' },
    } }))
    assert.match(url.searchParams.get('w_rid'), /^[a-f0-9]{32}$/)
    return ok()
  })
  assert.equal((await s.apiGet('https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890')).code, 0)
  assert.deepEqual(paths, ['/x/web-interface/nav', '/x/web-interface/wbi/view'])
})
