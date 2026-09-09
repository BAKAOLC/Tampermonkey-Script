'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '..', 'Bilibili Medal Keepalive.user.js'), 'utf8')
const startup = source.lastIndexOf('  startCoordinator()')
assert(startup > 0)
const instrumented = source.slice(0, startup) + `
  globalThis.testApi = {
    CONFIG, STORAGE, ownerId, isDueForLike, selectLeader, selectCandidate,
    sendLike, apiRequest, runScan, workerLoop, coordinatorTick, assertSession,
    requestScan, updateStatus, startCoordinator,
    get session() { return session },
    get peer() { return peer },
    setSession(value) { session = value },
    async init() {
      tabInfo = await GM.getTab()
      await publishPeer({ state: 'follower', term: '', expiresAt: 0, seenAt: Date.now() })
    },
    async lead(term = ownerId + '-term') {
      const expiresAt = Date.now() + CONFIG.leaseDurationMs
      await publishPeer({ state: 'active', term, activatedAt: Date.now(), seenAt: Date.now(), expiresAt })
      const current = { term, expiresAt, controller: new AbortController() }
      session = current
      return current
    },
  }
})()
`
const clone = value => value === undefined ? undefined : structuredClone(value)
const medal = { roomId: '123', targetId: '456', medalId: '8', medalName: '测试', anchorName: '测试主播' }
const apiMedal = { medal: { medal_id: 8, target_id: 456, is_lighted: 1 }, room_info: { room_id: 123, living_status: 0 } }
const flush = async () => { for (let i = 0; i < 100; i += 1) await Promise.resolve() }
function world() {
  const data = new Map(), tabs = new Map(), timers = new Map(), requests = [], listeners = []
  let now = 1_800_000_000_000, nextTimer = 0, nextId = 0
  const w = {
    data, tabs, timers, requests,
    get now() { return now },
    set now(value) { now = value },
    respond(options, body = { code: 0, data: {} }, status = 200) {
      queueMicrotask(() => options.onload({ status, responseText: JSON.stringify(body) }))
    },
    handler(options) {
      w.respond(options, { code: 0, data: options.method === 'POST' ? {} : { list: [apiMedal] } })
    },
    async advance(ms) {
      const end = now + ms
      await flush()
      while (true) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
        await flush()
      }
      now = end
      await flush()
    },
    tab(tabId, uid = '100') {
      const events = new Map(), menus = new Map()
      let account = uid
      const context = {
        Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } },
        crypto: { randomUUID: () => `${tabId}-${++nextId}` },
        AbortController, URLSearchParams,
        location: { origin: `https://${tabId === 'A' ? 'www' : 'live'}.bilibili.com`, pathname: '/' },
        document: { get cookie() { return account ? `DedeUserID=${account}; bili_jct=test` : '' } },
        console: { log() {}, warn() {} }, alert() {}, prompt: () => null,
        addEventListener: (name, fn) => events.set(name, fn),
        setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id },
        clearTimeout: id => timers.delete(id),
        GM: {
          getValue: async (key, fallback) => data.has(key) ? clone(data.get(key)) : fallback,
          setValue: async (key, value) => {
            const before = data.get(key); data.set(key, clone(value))
            for (const listener of listeners) if (listener.key === key) queueMicrotask(() => listener.fn(key, before, clone(value), true))
          },
          getTab: async () => clone(tabs.get(tabId) ?? {}),
          saveTab: async value => { tabs.set(tabId, clone(value)) },
          getTabs: async () => Object.fromEntries([...tabs].map(([key, value]) => [key, clone(value)])),
        },
        GM_registerMenuCommand: (name, fn) => menus.set(name, fn),
        GM_addValueChangeListener: (key, fn) => listeners.push({ key, fn }),
        GM_notification() {},
        GM_xmlhttpRequest(options) {
          requests.push({ tabId, method: options.method, options })
          w.handler(options)
          return { abort() { options.onabort() } }
        },
      }
      vm.runInNewContext(instrumented, context)
      return { api: context.testApi, events, menus, context, account(value) { account = value } }
    },
  }
  return w
}

test('24-hour eligibility ignores light/live state and protects pending or unknown sends', () => {
  const w = world(), a = w.tab('A').api, day = a.CONFIG.resendIntervalMs
  assert.equal(a.isDueForLike(null), true)
  assert.equal(a.isDueForLike({ lastSuccessAt: w.now - day + 1 }), false)
  assert.equal(a.isDueForLike({ lastSuccessAt: w.now - day }), true)
  for (const outcome of ['pending', 'unknown']) {
    assert.equal(a.isDueForLike({ outcome, attemptedAt: w.now - day + 1 }), false)
    assert.equal(a.isDueForLike({ outcome, attemptedAt: w.now - day }), true)
  }
  assert.equal(a.isDueForLike({ outcome: 'rejected', attemptedAt: w.now }), true)
})

test('earliest responsive tab wins, keeps control, and expired terms cannot revive', async () => {
  const w = world(), a = w.tab('A'), b = w.tab('B')
  await a.api.init(); w.now += 1; await b.api.init()
  assert.equal(a.api.selectCandidate(Object.values(Object.fromEntries(w.tabs)).map(t => t.bmkCoordinatorV2)).ownerId, a.api.ownerId)
  const first = a.api.coordinatorTick(); await flush(); await w.advance(1500); await first
  assert(a.api.session)
  await b.api.coordinatorTick(); assert.equal(b.api.session, null)
  const old = a.api.session
  w.now = old.expiresAt + 1
  const takeover = b.api.coordinatorTick(); await flush(); await w.advance(1500); await takeover
  assert(b.api.session)
  await assert.rejects(a.api.assertSession(old), { name: 'LeadershipLostError' })
  await a.api.coordinatorTick()
  assert.equal(a.api.session, null)
  assert.equal(b.api.selectLeader([...w.tabs.values()].map(t => t.bmkCoordinatorV2)).ownerId, b.api.ownerId)
  b.api.session.controller.abort(); await flush()
})

test('closed controlling tab permits takeover without waiting for lease expiry', async () => {
  const w = world(), a = w.tab('A'), b = w.tab('B')
  await a.api.init(); const current = await a.api.lead(); w.now += 1; await b.api.init()
  current.controller.abort(); w.tabs.delete('A')
  const takeover = b.api.coordinatorTick(); await flush(); await w.advance(1500); await takeover
  assert(b.api.session)
  b.api.session.controller.abort(); await flush()
})

test('successful sends persist per account, are deduplicated, and count acceptance', async () => {
  const w = world(), tab = w.tab('A'), a = tab.api
  await a.init(); const current = await a.lead()
  assert.equal(await a.sendLike(current, '100', medal, 30), 'accepted')
  assert.equal(await a.sendLike(current, '100', medal, 30), 'skipped')
  assert.equal(w.data.get(a.STORAGE.room('100', '123')).lastSuccessAt, w.now)
  tab.account('200')
  assert.equal(await a.sendLike(current, '200', medal, 30), 'accepted')
  assert.equal(w.requests.filter(r => r.method === 'POST').length, 2)
})

test('POST network errors are never retried and protect takeover with unknown outcome', async () => {
  const w = world(), a = w.tab('A').api
  await a.init(); const current = await a.lead()
  w.handler = options => queueMicrotask(() => options.onerror())
  assert.equal(await a.sendLike(current, '100', medal, 30), 'unknown')
  assert.equal(await a.sendLike(current, '100', medal, 30), 'skipped')
  assert.equal(w.requests.length, 1)
  assert.equal(w.data.get(a.STORAGE.room('100', '123')).outcome, 'unknown')
})

test('explicit API rejection does not set a successful-send timestamp', async () => {
  const w = world(), a = w.tab('A').api
  await a.init(); const current = await a.lead()
  w.handler = options => w.respond(options, { code: -1, message: 'rejected' })
  assert.equal(await a.sendLike(current, '100', medal, 30), 'rejected')
  const saved = w.data.get(a.STORAGE.room('100', '123'))
  assert.equal(saved.lastSuccessAt, 0)
  assert.equal(a.isDueForLike(saved), true)
  assert.equal(w.requests.length, 1)
})

test('hanging request times out once and leaves a conservative record', async () => {
  const w = world(), a = w.tab('A').api
  await a.init(); const current = await a.lead()
  w.handler = () => {}
  const send = a.sendLike(current, '100', medal, 30)
  await flush(); await w.advance(a.CONFIG.requestTimeoutMs)
  assert.equal(await send, 'unknown')
  assert.equal(w.requests.length, 1)
})

test('lease loss before a GET retry cancels the retry', async () => {
  const w = world(), a = w.tab('A').api
  await a.init(); const current = await a.lead()
  w.handler = options => { queueMicrotask(() => options.onerror()); w.tabs.delete('A') }
  const request = a.apiRequest(current, '100', '/test')
  const result = assert.rejects(request, { name: 'LeadershipLostError' })
  await flush(); await w.advance(6500); await result
  assert.equal(w.requests.length, 1)
})

test('leadership loss during POST keeps pending record and never writes stale success', async () => {
  const w = world(), a = w.tab('A').api
  await a.init(); const current = await a.lead()
  w.handler = options => { w.tabs.delete('A'); w.respond(options) }
  await assert.rejects(a.sendLike(current, '100', medal, 30), { name: 'LeadershipLostError' })
  assert.equal(w.requests.length, 1)
  assert.equal(w.data.get(a.STORAGE.room('100', '123')).outcome, 'pending')
})

test('account switch prevents dispatch and clears previous account status', async () => {
  const w = world(), tab = w.tab('A'), a = tab.api
  await a.init(); const current = await a.lead()
  tab.account('200')
  await assert.rejects(a.sendLike(current, '100', medal, 30), { name: 'AccountChangedError' })
  assert.equal(w.requests.length, 0)
  w.data.set(a.STORAGE.status, { uid: '100', lastSummary: { accepted: 8 } })
  await a.updateStatus(current, { uid: '200', phase: 'waiting' })
  assert.equal(w.data.get(a.STORAGE.status).lastSummary, undefined)
})

test('offline and already-lighted medals are sent once and no lighting verification request is made', async () => {
  const w = world(), a = w.tab('A').api
  await a.init(); const current = await a.lead()
  w.handler = options => w.respond(options, { code: 0, data: options.method === 'POST' ? {} : { list: [apiMedal, apiMedal] } })
  const scan = a.runScan(current, '100')
  await flush(); await w.advance(a.CONFIG.roomDelayMaxMs)
  const summary = await scan
  assert.equal(summary.accepted, 1); assert.equal(summary.candidates, 1)
  assert.equal(w.requests.filter(r => r.method === 'POST').length, 1)
  assert.equal(w.requests.filter(r => r.method === 'GET').length, 1)
})

test('manual request arriving during a scan survives and triggers the next scan', async () => {
  const w = world(), tab = w.tab('A'), a = tab.api
  await a.init(); const current = await a.lead()
  const key = a.STORAGE.schedule('100'), requestKey = a.STORAGE.request('100')
  w.data.set(key, { nextScanAt: w.now, acknowledgedRequest: '' })
  let gets = 0
  w.handler = options => {
    if (options.method === 'GET') gets += 1
    if (options.method === 'POST') void a.requestScan()
    w.respond(options, { code: 0, data: options.method === 'POST' ? {} : { list: [apiMedal] } })
  }
  const worker = a.workerLoop(current)
  const done = worker.catch(error => { assert.equal(error.name, 'LeadershipLostError') })
  await flush(); await w.advance(a.CONFIG.roomDelayMaxMs)
  assert.equal(gets, 2)
  assert.equal(w.data.get(key).acknowledgedRequest, w.data.get(requestKey).id)
  assert.equal(w.requests.filter(r => r.method === 'POST').length, 1)
  current.controller.abort(); await done
})

test('failed persistence prevents any POST from being dispatched', async () => {
  const w = world(), tab = w.tab('A'), a = tab.api
  await a.init(); const current = await a.lead()
  tab.context.GM.setValue = async () => { throw new Error('storage unavailable') }
  await assert.rejects(a.sendLike(current, '100', medal, 30), /storage unavailable/)
  assert.equal(w.requests.length, 0)
})

test('a reservation changed by another term prevents dispatch', async () => {
  const w = world(), tab = w.tab('A'), a = tab.api
  await a.init(); const current = await a.lead()
  tab.context.GM.setValue = async (key, value) => {
    w.data.set(key, { ...clone(value), attemptId: 'another-term' })
  }
  await assert.rejects(a.sendLike(current, '100', medal, 30), { name: 'LeadershipLostError' })
  assert.equal(w.requests.length, 0)
})
