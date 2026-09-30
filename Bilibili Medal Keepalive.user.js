// ==UserScript==
// @license     MIT
// @name        Bilibili 粉丝勋章自动保活
// @description 每隔 20–45 分钟按洗牌队列选择一个 24 小时内未点赞的勋章，未点赞过的优先，未激活的临时优先；页面内管理和控制。
// @author      BAKAOLC
// @version     1.3.5
// @match       https://*.bilibili.com/*
// @match       https://bilibili.com/*
// @namespace   none
// @grant       GM.getValue
// @grant       GM.setValue
// @grant       GM.getTab
// @grant       GM.saveTab
// @grant       GM.getTabs
// @grant       GM_registerMenuCommand
// @grant       GM_addValueChangeListener
// @grant       GM_xmlhttpRequest
// @connect     api.live.bilibili.com
// @run-at      document-start
// @supportURL  https://github.com/BAKAOLC/Tampermonkey-Script
// @homepageURL https://github.com/BAKAOLC/Tampermonkey-Script
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const SCRIPT_NAME = '粉丝勋章自动保活'
  const SCRIPT_VERSION = '1.3.5'
  const API_BASE = 'https://api.live.bilibili.com'
  const CONFIG = Object.freeze({
    defaultClickTimes: 30,
    minClickTimes: 1,
    maxClickTimes: 3000,
    pageSize: 10,
    maxPages: 100,
    initialDelayMinMs: 15_000,
    initialDelayMaxMs: 180_000,
    scanIntervalMinMs: 20 * 60_000,
    scanIntervalMaxMs: 45 * 60_000,
    roomDelayMinMs: 12_000,
    roomDelayMaxMs: 35_000,
    resendIntervalMs: 24 * 60 * 60_000,
    leaseDurationMs: 180_000,
    heartbeatIntervalMs: 20_000,
    claimSettleMs: 1_500,
    pollIntervalMs: 5_000,
    requestTimeoutMs: 20_000,
    storageTimeoutMs: 10_000,
    getRetries: 1,
  })
  const STORAGE = Object.freeze({
    peer: 'bmkCoordinatorV2',
    status: 'bmk:status:v2',
    signal: 'bmk:signal:v2',
    clickTimes: 'bmk:click-times:v1',
    room: (uid, roomId) => `bmk:room:v2:${uid}:${roomId}`,
    schedule: uid => `bmk:schedule:v2:${uid}`,
    request: uid => `bmk:request:v2:${uid}`,
    queue: uid => `bmk:queue:v1:${uid}`,
    medals: uid => `bmk:medals:v1:${uid}`,
    paused: uid => `bmk:paused:v1:${uid}`,
  })
  const log = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args)
  const warn = (...args) => console.warn(`[${SCRIPT_NAME}]`, ...args)
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
  const createId = () => crypto.randomUUID()
  const ownerId = createId()
  const startedAt = Date.now()
  let tabInfo
  let peer
  let session = null
  let coordinatorTask = null
  let stopped = false
  let wakeWorker = () => {}

  class LeadershipLostError extends Error {
    constructor() { super('主控制者任期已失效'); this.name = 'LeadershipLostError' }
  }
  class AccountChangedError extends Error {
    constructor() { super('登录账号已改变，停止本轮扫描'); this.name = 'AccountChangedError' }
  }
  class ApiError extends Error {
    constructor(message, { rejected = false, retryable = false } = {}) {
      super(message)
      this.name = 'ApiError'
      this.rejected = rejected
      this.retryable = retryable
    }
  }

  const bounded = (promise, ms = CONFIG.storageTimeoutMs) => {
    let timer
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('脚本管理器响应超时')), ms) }),
    ]).finally(() => clearTimeout(timer))
  }
  const getValue = (key, fallback) => bounded(GM.getValue(key, fallback))
  const setValue = (key, value) => bounded(GM.setValue(key, value))
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new LeadershipLostError()); return }
    const finish = error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(new LeadershipLostError())
    const timer = setTimeout(() => finish(), ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
  const getCookie = name => {
    const item = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))
    if (!item) return ''
    try { return decodeURIComponent(item.slice(name.length + 1)) } catch { return '' }
  }
  const getUid = () => getCookie('DedeUserID')
  const validId = value => /^[1-9]\d*$/.test(String(value ?? ''))
  const shuffle = source => {
    const result = [...source]
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i)
      ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
  }
  const getClickTimes = async () => {
    const n = Number(await getValue(STORAGE.clickTimes, CONFIG.defaultClickTimes))
    return Number.isInteger(n) ? Math.min(CONFIG.maxClickTimes, Math.max(CONFIG.minClickTimes, n)) : CONFIG.defaultClickTimes
  }

  // 每个标签页只写自己的登记信息，避免旧控制者续租/释放时覆盖新控制者。
  // 跨子域租约仍是协作式协调，不能替代服务端幂等或原子锁。
  const readPeers = async () => Object.values(await bounded(GM.getTabs()))
    .map(tab => tab?.[STORAGE.peer])
    .filter(value => value?.ownerId && Number.isFinite(value.startedAt))
  const comparePeers = (a, b) => a.startedAt - b.startedAt || a.ownerId.localeCompare(b.ownerId)
  const selectLeader = (peers, now = Date.now()) => peers
    .filter(value => value.state === 'active' && value.expiresAt > now)
    .sort((a, b) => a.activatedAt - b.activatedAt || comparePeers(a, b))[0]
  const selectCandidate = (peers, now = Date.now()) => peers
    .filter(value => value.seenAt + CONFIG.leaseDurationMs > now && value.state !== 'closed')
    .sort(comparePeers)[0]
  const publishPeer = async patch => {
    peer = { ...peer, ...patch, ownerId, startedAt, version: SCRIPT_VERSION, page: location.origin + location.pathname }
    await bounded(GM.saveTab({ ...tabInfo, [STORAGE.peer]: peer }))
  }
  const loseSession = () => {
    session?.controller.abort()
    wakeWorker()
  }
  const assertSession = async (current, uid) => {
    if (stopped || current.controller.signal.aborted || current.expiresAt <= Date.now()) {
      current.controller.abort()
      throw new LeadershipLostError()
    }
    const leader = selectLeader(await readPeers())
    if (leader?.ownerId !== ownerId || leader.term !== current.term || current.expiresAt <= Date.now()) {
      current.controller.abort()
      throw new LeadershipLostError()
    }
    if (uid !== undefined && getUid() !== uid) throw new AccountChangedError()
  }
  const updateStatus = async (current, patch) => {
    await assertSession(current)
    const stored = await getValue(STORAGE.status, {})
    const previous = patch.uid !== undefined && stored.uid !== patch.uid ? {} : stored
    await setValue(STORAGE.status, { ...previous, ...patch, ownerId, term: current.term, version: SCRIPT_VERSION,
      updatedAt: Date.now(), page: location.origin + location.pathname })
  }

  const requestOnce = (path, init, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new LeadershipLostError()); return }
    let handle
    let timer
    let finished = false
    const finish = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      finish(new LeadershipLostError())
      handle?.abort()
    }
    const timeout = () => {
      finish(new ApiError('请求超时，结果未知', { retryable: true }))
      handle?.abort()
    }
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(timeout, CONFIG.requestTimeoutMs)
    try {
      handle = GM_xmlhttpRequest({
        method: init.method ?? 'GET', url: `${API_BASE}${path}`, data: init.body,
        headers: init.headers, timeout: CONFIG.requestTimeoutMs, nocache: true,
        anonymous: false,
        onload: response => {
          let json
          try { json = JSON.parse(response.responseText) } catch {
            finish(new ApiError(`API 返回非 JSON 内容（HTTP ${response.status}）`, { retryable: response.status >= 500 }))
            return
          }
          if (response.status < 200 || response.status >= 300) {
            finish(new ApiError(`HTTP ${response.status}`, { retryable: response.status >= 500 }))
          } else if (typeof json?.code !== 'number') {
            finish(new ApiError('API 响应缺少有效的 code'))
          } else if (json.code !== 0) {
            finish(new ApiError(`${json.message || json.msg || '请求被拒绝'} (code: ${json.code})`, { rejected: true }))
          } else finish(null, json.data ?? json.result ?? {})
        },
        onerror: () => finish(new ApiError('网络请求失败，结果未知', { retryable: true })),
        ontimeout: timeout,
        onabort: () => finish(new ApiError('请求被中止，结果未知')),
      })
    } catch (error) { finish(error) }
  })
  const apiRequest = async (current, uid, path, init = {}) => {
    const retries = (init.method ?? 'GET') === 'GET' ? CONFIG.getRetries : 0
    for (let attempt = 0; ; attempt += 1) {
      await assertSession(current, uid)
      try { return await requestOnce(path, init, current.controller.signal) } catch (error) {
        if (!error.retryable || attempt >= retries) throw error
        await sleep(randomInt(2_500, 6_500), current.controller.signal)
      }
    }
  }

  const getAllMedals = async (current, uid) => {
    const medals = new Map()
    for (let page = 1; page <= CONFIG.maxPages; page += 1) {
      const path = `/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=${CONFIG.pageSize}`
      if (getUid() !== uid) throw new AccountChangedError()
      const data = current ? await apiRequest(current, uid, path) : await requestOnce(path, {}, new AbortController().signal)
      if (current) await assertSession(current, uid)
      else if (getUid() !== uid) throw new AccountChangedError()
      if (!Array.isArray(data.list)) throw new Error('勋章列表格式异常，本轮停止')
      const items = [...data.list, ...(Array.isArray(data.special_list) ? data.special_list : [])]
      const previousSize = medals.size
      for (const item of items) {
        const medal = item?.medal ?? item?.medal_info ?? {}
        const room = item?.room_info ?? {}
        const anchor = item?.anchor_info ?? {}
        const roomId = [room.room_id, room.roomid, anchor.room_id, medal.room_id, medal.roomid, item?.room_id, item?.roomid].find(validId)
        if (!roomId) continue
        const targetId = [medal.target_id, anchor.uid, anchor.mid].find(validId)
        medals.set(String(roomId), {
          roomId: String(roomId), targetId: targetId ? String(targetId) : '',
          medalId: String(medal.medal_id ?? medal.id ?? ''),
          medalName: String(medal.medal_name ?? medal.name ?? ''),
          anchorName: String(anchor.nick_name ?? anchor.uname ?? ''),
          isLighted: medal.is_lighted == null ? null : Number(medal.is_lighted) === 1,
        })
      }
      const totalPages = Number(data.page_info?.total_page ?? 0)
      if (items.length > 0 && medals.size === 0) throw new Error('勋章列表有数据，但未找到有效的直播间 ID')
      if (totalPages > 0) {
        if (page >= totalPages) return [...medals.values()]
        continue
      }
      const total = Number(data.total_number ?? data.total ?? 0)
      if (data.list.length === 0 || (total > 0 && medals.size >= total) ||
        (total <= 0 && data.list.length < CONFIG.pageSize)) return [...medals.values()]
      if (medals.size === previousSize) throw new Error('勋章分页没有新增数据，本轮停止以免漏处理')
    }
    throw new Error('勋章列表超过分页上限，本轮停止')
  }
  const isDueForLike = (record, now = Date.now(), inactive = false) => {
    if (!record) return true
    if (!inactive && Number(record.lastSuccessAt) > 0 && Number(record.lastSuccessAt) + CONFIG.resendIntervalMs > now) return false
    return !['pending', 'unknown'].includes(record.outcome) ||
      Number(record.attemptedAt || 0) + CONFIG.resendIntervalMs <= now
  }
  const resolveAnchorId = async (current, uid, medal) => {
    if (validId(medal.targetId)) return medal.targetId
    const info = await apiRequest(current, uid,
      `/xlive/web-room/v1/index/getInfoByUser?room_id=${encodeURIComponent(medal.roomId)}`)
    const worn = info?.medal?.curr_weared
    // 佩戴勋章未必属于当前直播间，只有勋章 ID 匹配时才采用其主播 UID。
    if (medal.medalId && String(worn?.medal_id ?? worn?.id ?? '') === medal.medalId && validId(worn?.target_id)) {
      return String(worn.target_id)
    }
    throw new Error(`直播间 ${medal.roomId} 缺少可确认的主播 UID`)
  }
  const sendLike = async (current, uid, medal, clickTimes) => {
    if (await getValue(STORAGE.paused(uid), false)) return 'skipped'
    const anchorId = await resolveAnchorId(current, uid, medal)
    await assertSession(current, uid)
    const csrf = getCookie('bili_jct')
    if (!csrf) throw new Error('未检测到登录凭据，请先登录 Bilibili')
    const key = STORAGE.room(uid, medal.roomId)
    const previous = await getValue(key, null)
    if (!isDueForLike(previous, Date.now(), medal.isLighted === false)) return 'skipped'
    const record = {
      lastSuccessAt: previous?.lastSuccessAt ?? 0,
      attemptedAt: Date.now(), attemptId: createId(), term: current.term,
      outcome: 'pending', medalName: medal.medalName, anchorName: medal.anchorName,
    }
    // 先持久化，再发送。页面关闭或响应丢失时，下一个任期仍能看到这次尝试。
    await assertSession(current, uid)
    await setValue(key, record)
    const saved = await getValue(key, null)
    if (saved?.attemptId !== record.attemptId) throw new LeadershipLostError()
    await assertSession(current, uid)
    if (await getValue(STORAGE.paused(uid), false)) {
      await setValue(key, { ...record, outcome: 'cancelled' })
      return 'skipped'
    }
    const body = new URLSearchParams({ click_time: String(clickTimes), room_id: medal.roomId,
      anchor_id: anchorId, uid, csrf_token: csrf, csrf, visit_id: '' }).toString()
    try {
      await apiRequest(current, uid, '/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      })
    } catch (error) {
      if (error instanceof LeadershipLostError || error instanceof AccountChangedError) throw error
      await assertSession(current, uid)
      const latest = await getValue(key, null)
      if (latest?.attemptId !== record.attemptId) throw new LeadershipLostError()
      await setValue(key, { ...record, outcome: error.rejected ? 'rejected' : 'unknown', lastError: error.message })
      warn(`${medal.medalName || medal.roomId}：${error.message}`)
      return error.rejected ? 'rejected' : 'unknown'
    }
    // 失去任期后不回写旧结果；发送前的 pending 记录会继续阻止立即补发。
    await assertSession(current, uid)
    if ((await getValue(key, null))?.attemptId !== record.attemptId) throw new LeadershipLostError()
    await setValue(key, { ...record, outcome: 'accepted', lastSuccessAt: Date.now(), lastError: '' })
    log(`点赞 API 已接受 ${medal.medalName || medal.roomId}`)
    return 'accepted'
  }
  const runScan = async (current, uid, { immediate = false } = {}) => {
    await assertSession(current, uid)
    const scanStartedAt = Date.now()
    await updateStatus(current, { uid, phase: 'scanning', current: '', nextScanAt: 0, lastError: '', lastResult: '' })
    const medals = await getAllMedals(current, uid)
    await setValue(STORAGE.medals(uid), { at: Date.now(), medals })
    const candidates = []
    const neverLiked = new Set()
    let cooling = 0
    let uncertain = 0
    let earliestEligibleAt = Infinity
    for (const medal of medals) {
      const record = await getValue(STORAGE.room(uid, medal.roomId), null)
      if (!isDueForLike(record, Date.now(), medal.isLighted === false)) {
        const successDueAt = Number(record?.lastSuccessAt || 0) + CONFIG.resendIntervalMs
        const uncertainDueAt = ['pending', 'unknown'].includes(record?.outcome) ? Number(record.attemptedAt || 0) + CONFIG.resendIntervalMs : 0
        earliestEligibleAt = Math.min(earliestEligibleAt, Math.max(successDueAt, uncertainDueAt))
        if (uncertainDueAt > Date.now()) uncertain += 1
        else cooling += 1
        continue
      }
      candidates.push(medal)
      if (!(Number(record?.lastSuccessAt) > 0)) neverLiked.add(medal.roomId)
    }
    const summary = { totalMedals: medals.length, candidates: candidates.length, cooling, uncertain, accepted: 0, rejected: 0, unknown: 0, failed: 0, skipped: 0 }
    let lastResult = candidates.length ? '' : medals.length
      ? `暂无候选：${cooling} 个近期已点赞，${uncertain} 个发送结果待确认；最早可处理时间：${new Date(earliestEligibleAt).toLocaleString()}`
      : '账号没有可处理的勋章'
    let lastError = ''
    await updateStatus(current, { uid, lastSummary: summary, lastResult })
    const clickTimes = await getClickTimes()
    // 保留洗牌队列的顺序，新候选也先洗牌；未成功点赞过的排在已点过的前面。
    const eligibleIds = new Set(candidates.map(medal => medal.roomId))
    const storedQueue = await getValue(STORAGE.queue(uid), [])
    const queue = [...new Set(Array.isArray(storedQueue) ? storedQueue : [])].filter(id => eligibleIds.has(id))
    const queuedIds = new Set(queue)
    queue.push(...shuffle(candidates.filter(medal => !queuedIds.has(medal.roomId))).map(medal => medal.roomId))
    const ordered = [...queue.filter(id => neverLiked.has(id)), ...queue.filter(id => !neverLiked.has(id))]
    // 每轮重新读取激活状态；未激活的越过成功点赞冷却和随机队列，临时优先。
    const unlighted = candidates.filter(medal => medal.isLighted === false)
    const selectedMedal = unlighted.length ? shuffle(unlighted)[0] : candidates.find(medal => medal.roomId === ordered[0])
    await assertSession(current, uid)
    await setValue(STORAGE.queue(uid), ordered.filter(id => id !== selectedMedal?.roomId))
    const selected = selectedMedal ? [selectedMedal] : []
    for (const medal of selected) {
      const sendAt = Date.now() + (immediate ? 0 : randomInt(CONFIG.roomDelayMinMs, CONFIG.roomDelayMaxMs))
      await updateStatus(current, { uid, phase: 'delaying', current: medal.medalName || medal.roomId, sendAt })
      await sleep(Math.max(0, sendAt - Date.now()), current.controller.signal)
      await assertSession(current, uid)
      await updateStatus(current, { uid, phase: 'processing', current: medal.medalName || medal.roomId })
      try {
        const outcome = await sendLike(current, uid, medal, clickTimes)
        summary[outcome] += 1
        const name = medal.medalName || medal.roomId
        if (outcome === 'accepted') lastResult = `已点赞：${name}`
        else if (outcome === 'skipped') lastResult = `未发送：${name}，任务暂停或候选已被处理`
        else {
          const record = await getValue(STORAGE.room(uid, medal.roomId), null)
          lastError = record?.lastError || '未返回详细原因'
          lastResult = `${outcome === 'rejected' ? '点赞被拒绝' : '发送结果未知'}：${name}，${lastError}`
        }
      } catch (error) {
        if (error instanceof LeadershipLostError || error instanceof AccountChangedError) throw error
        summary.failed += 1
        lastError = error.message
        lastResult = `处理失败：${medal.medalName || medal.roomId}，${error.message}`
        warn('处理直播间失败：', error)
      }
    }
    await updateStatus(current, { uid, phase: 'idle', current: '', sendAt: 0, lastScanAt: scanStartedAt, lastSummary: summary, lastResult, lastError })
    return summary
  }

  const waitForWork = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new LeadershipLostError()); return }
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      if (wakeWorker === finish) wakeWorker = () => {}
      if (signal.aborted) reject(new LeadershipLostError())
      else resolve()
    }
    const timer = setTimeout(finish, ms)
    wakeWorker = finish
    signal.addEventListener('abort', finish, { once: true })
  })
  const workerLoop = async current => {
    while (!current.controller.signal.aborted) {
      await assertSession(current)
      const uid = getUid()
      if (!validId(uid) || !getCookie('bili_jct')) {
        await updateStatus(current, { uid: '', phase: 'login-required', current: '', nextScanAt: 0 })
        await waitForWork(CONFIG.pollIntervalMs, current.controller.signal)
        continue
      }
      if (await getValue(STORAGE.paused(uid), false)) {
        await updateStatus(current, { uid, phase: 'paused', current: '', nextScanAt: 0 })
        await waitForWork(CONFIG.pollIntervalMs, current.controller.signal)
        continue
      }
      const key = STORAGE.schedule(uid)
      let schedule = await getValue(key, null)
      if (!schedule) {
        schedule = { nextScanAt: Date.now() + randomInt(CONFIG.initialDelayMinMs, CONFIG.initialDelayMaxMs), acknowledgedRequest: '' }
        await setValue(key, schedule)
      }
      const request = await getValue(STORAGE.request(uid), null)
      const requested = request?.id && request.id !== schedule.acknowledgedRequest
      if (!requested && schedule.nextScanAt > Date.now()) {
        await updateStatus(current, { uid, phase: 'waiting', nextScanAt: schedule.nextScanAt, current: '' })
        await waitForWork(Math.min(CONFIG.pollIntervalMs, schedule.nextScanAt - Date.now()), current.controller.signal)
        continue
      }
      // 完成本轮后才确认请求；失去控制权时，接管者仍能继续处理未完成的请求。
      const acknowledgedRequest = request?.id ?? schedule.acknowledgedRequest
      await assertSession(current, uid)
      await setValue(key, { ...schedule, runningRequest: requested ? request.id : '' })
      try { await runScan(current, uid, { immediate: Boolean(requested) }) } catch (error) {
        if (error instanceof LeadershipLostError) throw error
        if (!(error instanceof AccountChangedError)) {
          await updateStatus(current, { uid, phase: 'error', current: '', sendAt: 0, lastError: error.message, lastResult: '未执行：' + error.message, lastScanAt: Date.now() })
          warn('扫描失败：', error)
        }
      }
      await assertSession(current)
      await setValue(key, { acknowledgedRequest, nextScanAt: Date.now() + randomInt(CONFIG.scanIntervalMinMs, CONFIG.scanIntervalMaxMs) })
    }
  }

  const coordinatorTick = async () => {
    const now = Date.now()
    const peers = await readPeers()
    const leader = selectLeader(peers)
    if (session) {
      if (session.controller.signal.aborted || session.expiresAt <= now ||
        leader?.ownerId !== ownerId || leader.term !== session.term) {
        loseSession()
        await session.task
        session = null
        await publishPeer({ state: 'follower', term: '', expiresAt: 0, seenAt: Date.now() })
      } else {
        // 不允许超时后恢复的旧任期自行续命。
        if (session.expiresAt <= Date.now()) { loseSession(); return }
        const expiresAt = Date.now() + CONFIG.leaseDurationMs
        await publishPeer({ seenAt: Date.now(), expiresAt })
        session.expiresAt = expiresAt
      }
      return
    }
    await publishPeer({ state: 'follower', term: '', expiresAt: 0, seenAt: Date.now() })
    if (leader) return
    if (selectCandidate(await readPeers())?.ownerId !== ownerId) return
    const term = createId()
    await publishPeer({ state: 'claiming', term, seenAt: Date.now(), expiresAt: 0 })
    await sleep(CONFIG.claimSettleMs)
    if (stopped) return
    const settled = await readPeers()
    if (selectLeader(settled) || selectCandidate(settled)?.ownerId !== ownerId) return
    const expiresAt = Date.now() + CONFIG.leaseDurationMs
    await publishPeer({ state: 'active', term, activatedAt: Date.now(), seenAt: Date.now(), expiresAt })
    const observed = selectLeader(await readPeers())
    if (observed?.ownerId !== ownerId || observed.term !== term) return
    const current = { term, expiresAt, controller: new AbortController() }
    session = current
    current.task = workerLoop(current).catch(error => {
      if (!(error instanceof LeadershipLostError)) warn('主控制者停止：', error)
    }).finally(() => current.controller.abort())
    log('当前标签页成为主控制者')
  }
  const coordinatorLoop = async () => {
    tabInfo = await bounded(GM.getTab())
    await publishPeer({ state: 'follower', term: '', expiresAt: 0, seenAt: Date.now() })
    while (!stopped) {
      try { await coordinatorTick() } catch (error) {
        loseSession()
        warn('任务协调失败，暂停当前任期：', error)
      }
      await sleep(CONFIG.heartbeatIntervalMs)
    }
  }

  const requestScan = async () => {
    const uid = getUid()
    if (!validId(uid)) throw new Error('请先登录 Bilibili')
    if (!getCookie('bili_jct')) throw new Error('登录凭据缺失，请重新登录 Bilibili')
    if (await getValue(STORAGE.paused(uid), false)) throw new Error('任务已暂停，请先恢复')
    const leader = selectLeader(await readPeers())
    if (leader && leader.version !== SCRIPT_VERSION) {
      throw new Error(`主控制标签页仍运行旧版，请刷新所有已打开的 B 站标签页：${leader.page}`)
    }
    const request = { id: createId(), at: Date.now() }
    await setValue(STORAGE.request(uid), request)
    await setValue(STORAGE.signal, request)
    wakeWorker()
    log('已提交立即执行请求')
  }
  let controls = null
  let panelTimer = null
  let panelSnapshot = null
  let panelRefreshTask = null
  let panelRefreshAgain = false
  const watchedAccounts = new Set()
  const watchedRooms = new Set()
  let listFingerprint = ''
  const panelIsOpen = () => controls && !controls.find('backdrop').hidden
  const refreshOpenPanel = () => {
    if (!panelIsOpen()) return
    void refreshStatus().catch(error => {
      if (panelIsOpen()) controls.find('message').textContent = error.message
    })
  }
  const watchPanelAccount = uid => {
    if (!validId(uid) || watchedAccounts.has(uid)) return
    watchedAccounts.add(uid)
    for (const key of [STORAGE.schedule(uid), STORAGE.request(uid), STORAGE.paused(uid), STORAGE.queue(uid), STORAGE.medals(uid)]) {
      GM_addValueChangeListener(key, refreshOpenPanel)
    }
  }
  const resolvePanelTheme = () => {
    const surfaces = [document.body, document.documentElement].filter(Boolean)
    for (const surface of surfaces) {
      const marker = ['data-theme', 'data-color-mode', 'theme'].map(name => surface.getAttribute(name) ?? '').join(' ') + ` ${surface.className}`
      if (/(?:^|[\s_-])(dark|night)(?:$|[\s_-])/i.test(marker)) return 'dark'
      if (/(?:^|[\s_-])(light|day)(?:$|[\s_-])/i.test(marker)) return 'light'
    }
    // 页面实际背景优先于系统偏好，避免系统为深色但 B 站仍为浅色时配色不一致。
    for (const surface of surfaces) {
      const style = getComputedStyle(surface)
      const rgb = style.backgroundColor.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/)
      if (rgb && (rgb[4] === undefined || Number(rgb[4]) >= 0.5)) {
        const brightness = (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255
        return brightness < 0.5 ? 'dark' : 'light'
      }
      if (style.colorScheme === 'dark' || style.colorScheme === 'light') return style.colorScheme
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  const mountControls = async () => {
    if (controls) return controls
    if (!document.documentElement) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    if (controls) return controls
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;z-index:2147483647'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = `
      <style>
        :host{all:initial;font:14px/1.6 system-ui,sans-serif;--text:#202938;--surface:#fff;--border:#c5ceda;--button:#f0f3f7;--hover:#e2e9f1;--input:#fff;--muted:#526174;--accent:#006b9c;--focus:#008ac0;--overlay:#17253d55;color:var(--text);color-scheme:light}
        :host([data-theme="dark"]){--text:#e8edf4;--surface:#182231;--border:#536075;--button:#263346;--hover:#35465e;--input:#101925;--muted:#bac6d5;--accent:#8fd9ff;--focus:#71cfff;--overlay:#0008;color-scheme:dark}
        *{box-sizing:border-box} button,input{font:inherit} button{cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:7px 12px;background:var(--button);color:var(--text)}
        button:hover{background:var(--hover)} button:disabled{opacity:.5;cursor:default} button:focus-visible,input:focus-visible{outline:2px solid var(--focus)}
        #backdrop{position:fixed;inset:0;background:var(--overlay);display:grid;place-items:center}
        [hidden]{display:none!important} #panel{width:min(460px,calc(100vw - 32px));max-height:85vh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;box-shadow:0 12px 48px #0004}
        header{display:flex;align-items:center;justify-content:space-between;gap:12px} h2{font-size:18px;margin:0} #status{white-space:pre-wrap;overflow-wrap:anywhere;margin:16px 0;font:inherit}
        .actions,form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0} input{width:90px;padding:7px;border:1px solid var(--border);border-radius:6px;background:var(--input);color:var(--text)}
        #panel:has(#medal-list:not([hidden])){width:min(1050px,calc(100vw - 32px))} #table-scroll{overflow:auto;max-height:45vh} table{width:100%;border-collapse:collapse;font-size:13px} th,td{padding:9px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top;min-width:110px;overflow-wrap:anywhere} th{position:sticky;top:0;background:var(--surface)} td small{display:block;color:var(--muted)} #list-time{font-size:12px;color:var(--muted)} #message{min-height:24px;color:var(--accent)} #close{padding:4px 10px}
      </style>
      <div id="backdrop" hidden>
        <section id="panel" role="dialog" aria-modal="true" aria-labelledby="title" tabindex="-1">
          <header><h2 id="title">粉丝勋章保活</h2><button id="close" aria-label="关闭">×</button></header>
          <pre id="status">正在读取状态…</pre>
          <div class="actions"><button id="pause">暂停任务</button><button id="scan">立即执行一次</button><button id="list-toggle" aria-expanded="false">查看勋章列表</button></div>
          <form id="settings"><label for="clicks">单次点赞数</label><input id="clicks" type="number" min="1" max="3000" step="1" required><button type="submit">保存</button></form>
          <section id="medal-list" hidden>
            <div class="actions"><button id="list-refresh">刷新激活状态</button><span id="list-time"></span></div>
            <div id="table-scroll"><table><thead><tr><th>勋章 / 主播</th><th>激活状态</th><th>处理状态</th><th>上次点赞</th><th>最近结果</th></tr></thead><tbody id="medal-rows"></tbody></table></div>
            <p id="list-empty"></p>
          </section>
          <div id="message" role="status" aria-live="polite"></div>
        </section>
      </div>`
    document.documentElement.append(host)
    const find = id => root.getElementById(id)
    const syncTheme = () => host.setAttribute('data-theme', resolvePanelTheme())
    const themeObserver = new MutationObserver(syncTheme)
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!find('backdrop').hidden) syncTheme()
    })
    controls = { find, previousFocus: null, syncTheme, themeObserver }
    const action = async callback => {
      try { await callback() } catch (error) { warn(error); find('message').textContent = error.message }
    }
    const close = () => {
      find('backdrop').hidden = true
      clearInterval(panelTimer)
      panelTimer = null
      themeObserver.disconnect()
      controls.previousFocus?.focus()
    }
    find('close').addEventListener('click', close)
    find('backdrop').addEventListener('click', event => { if (event.target === find('backdrop')) close() })
    root.addEventListener('keydown', event => {
      if (find('backdrop').hidden) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const elements = [...find('panel').querySelectorAll('button,input')].filter(element => !element.disabled && element.getClientRects().length > 0)
        const first = elements[0], last = elements.at(-1)
        if (event.shiftKey && (root.activeElement === first || root.activeElement === find('panel'))) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus() }
      }
    })
    find('pause').addEventListener('click', () => void action(async () => {
      const uid = getUid()
      if (!validId(uid)) throw new Error('请先登录 Bilibili')
      const paused = !await getValue(STORAGE.paused(uid), false)
      await setValue(STORAGE.paused(uid), paused)
      await setValue(STORAGE.signal, { id: createId(), at: Date.now() })
      wakeWorker()
      find('message').textContent = paused ? '已暂停任务' : '已恢复任务'
      await refreshStatus()
    }))
    find('scan').addEventListener('click', () => void action(async () => {
      await requestScan()
      find('message').textContent = '请求已提交'
      await refreshStatus()
    }))
    find('list-toggle').addEventListener('click', () => void action(async () => {
      const open = find('medal-list').hidden
      find('medal-list').hidden = !open
      find('list-toggle').textContent = open ? '收起勋章列表' : '查看勋章列表'
      find('list-toggle').setAttribute('aria-expanded', String(open))
      if (open) {
        await refreshStatus()
        await refreshMedalList()
      }
    }))
    find('list-refresh').addEventListener('click', () => void action(refreshMedalList))
    find('settings').addEventListener('submit', event => {
      event.preventDefault()
      void action(async () => {
        const value = Number(find('clicks').value)
        if (!Number.isInteger(value) || value < CONFIG.minClickTimes || value > CONFIG.maxClickTimes) throw new Error('请输入 1–3000 的整数')
        await setValue(STORAGE.clickTimes, value)
        find('message').textContent = `已保存单次点赞数：${value}`
        await refreshStatus()
      })
    })
    return controls
  }
  const refreshMedalList = async () => {
    const { find } = controls
    const uid = getUid()
    if (!validId(uid)) throw new Error('请先登录 Bilibili')
    find('list-refresh').disabled = true
    find('list-time').textContent = '正在读取激活状态…'
    try {
      const medals = await getAllMedals(null, uid)
      if (getUid() !== uid) throw new AccountChangedError()
      await setValue(STORAGE.medals(uid), { at: Date.now(), medals })
      await refreshStatus()
    } catch (error) {
      find('list-time').textContent = '读取失败'
      throw error
    } finally { find('list-refresh').disabled = false }
  }
  const renderMedalList = () => {
    if (!panelSnapshot || controls.find('medal-list').hidden) return
    const { find } = controls
    const { uid, roster, records, queue, paused } = panelSnapshot
    const medals = roster?.medals ?? []
    const queuePositions = new Map((Array.isArray(queue) ? queue : []).map((id, index) => [id, index + 1]))
    const outcomeNames = { accepted: '已发送', rejected: '被拒绝', unknown: '结果未知', pending: '发送中 / 未确认', cancelled: '已取消', failed: '处理失败' }
    const formatTime = value => value ? new Date(value).toLocaleString() : '未点赞过'
    const rows = medals.map(medal => {
      const record = records[medal.roomId]
      const inactive = medal.isLighted === false
      const due = isDueForLike(record, Date.now(), inactive)
      const uncertain = ['pending', 'unknown'].includes(record?.outcome)
      const eligibleAt = Math.max(!inactive ? Number(record?.lastSuccessAt || 0) + CONFIG.resendIntervalMs : 0,
        uncertain ? Number(record.attemptedAt || 0) + CONFIG.resendIntervalMs : 0)
      const position = queuePositions.get(medal.roomId)
      const state = !due ? uncertain ? '发送结果待确认' : '冷却中'
        : inactive ? '优先处理' : position ? `队列第 ${position} 位` : '可进入随机队列'
      return { medal, record, state: paused ? `已暂停 · ${state}` : state, eligibleAt: due ? 0 : eligibleAt }
    })
    const fingerprint = JSON.stringify([uid, roster?.at, rows])
    if (fingerprint === listFingerprint) return
    listFingerprint = fingerprint
    find('list-time').textContent = roster?.at ? `激活状态读取于 ${new Date(roster.at).toLocaleString()}` : '尚未读取激活状态'
    find('list-empty').textContent = medals.length ? '' : roster?.at ? '没有勋章' : '点击“刷新激活状态”读取列表'
    const fragment = document.createDocumentFragment()
    for (const { medal, record, state, eligibleAt } of rows) {
      const row = document.createElement('tr')
      const values = [
        [medal.medalName || '未命名勋章', `${medal.anchorName || '主播'} · 房间 ${medal.roomId}`],
        [medal.isLighted === false ? '未激活' : medal.isLighted === true ? '已激活' : '未知'],
        [state, eligibleAt ? `可处理时间：${new Date(eligibleAt).toLocaleString()}` : ''],
        [formatTime(record?.lastSuccessAt)],
        [outcomeNames[record?.outcome] ?? '尚未处理', record?.lastError || ''],
      ]
      for (const [text, detail] of values) {
        const cell = document.createElement('td')
        cell.textContent = text
        if (detail) { const small = document.createElement('small'); small.textContent = detail; cell.append(small) }
        row.append(cell)
      }
      fragment.append(row)
    }
    find('medal-rows').replaceChildren(fragment)
  }
  const renderStatus = () => {
    if (!panelIsOpen() || !panelSnapshot) return
    const { find } = controls
    controls.syncTheme()
    const { uid, status, leader, paused, schedule, request, queue, clickTimes } = panelSnapshot
    if (uid !== getUid()) { refreshOpenPanel(); return }
    const sameAccount = uid && status.uid === uid
    const summary = sameAccount ? status.lastSummary ?? {} : {}
    const busy = sameAccount && ['scanning', 'delaying', 'processing'].includes(status.phase)
    const pendingRequest = request?.id && request.id !== schedule?.acknowledgedRequest
    const phases = { scanning: '正在读取勋章并选择候选', delaying: '已选中勋章，等待发送', processing: '正在发送点赞', idle: '本轮完成', waiting: '等待下一轮', paused: '已暂停', 'login-required': '等待登录', error: '运行出错' }
    const formatTime = value => value ? new Date(value).toLocaleString() : '无'
    const countdown = value => {
      const seconds = Math.max(0, Math.ceil((value - Date.now()) / 1000))
      return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`
    }
    const nextAt = !paused && !busy ? schedule?.nextScanAt ?? 0 : 0
    const leaderAlive = leader && leader.expiresAt > Date.now()
    const outdatedLeader = leaderAlive && leader.version !== SCRIPT_VERSION
    find('status').textContent = [
      `主控制者：${leaderAlive ? leader.page : '等待选举或接管'}`,
      `版本：界面 ${SCRIPT_VERSION} / 控制者 ${leaderAlive ? leader.version ?? '旧版（无版本登记）' : '等待选举'}`,
      outdatedLeader ? '旧版控制者仍在运行，请刷新所有已打开的 B 站标签页。' : '',
      `状态：${!validId(uid) ? '等待登录' : paused ? '已暂停' : !busy && pendingRequest ? '立即执行请求已排队' : sameAccount ? phases[status.phase] ?? status.phase : '等待当前账号的状态'}`,
      `正在处理：${sameAccount && status.current ? status.current : '无'}`,
      sameAccount && !paused && status.phase === 'delaying' ? `发送倒计时：${countdown(status.sendAt)}` : '',
      `下次执行：${paused ? '已暂停' : busy ? '本轮结束后安排' : pendingRequest ? '尽快执行' : nextAt ? `${formatTime(nextAt)}（${nextAt > Date.now() ? `剩余 ${countdown(nextAt)}` : '等待控制者开始'}）` : '等待安排'}`,
      `上次扫描：${formatTime(sameAccount ? status.lastScanAt : 0)}`,
      `上轮：成功发送 ${summary.accepted ?? 0} / 拒绝 ${summary.rejected ?? 0} / 结果未知 ${summary.unknown ?? 0} / 处理失败 ${summary.failed ?? 0}`,
      `上轮候选：${summary.candidates ?? 0}，勋章总数：${summary.totalMedals ?? 0}`,
      `随机队列剩余：${Array.isArray(queue) ? queue.length : 0}`,
      `点赞次数：${clickTimes}`,
      sameAccount && status.lastResult ? `执行结果：${status.lastResult}` : '',
      sameAccount && status.lastError ? `最近错误：${status.lastError}` : '',
    ].filter(Boolean).join('\n')
    find('pause').textContent = paused ? '恢复任务' : '暂停任务'
    find('pause').disabled = !validId(uid)
    find('scan').disabled = !validId(uid) || paused || busy || Boolean(pendingRequest)
    find('scan').textContent = busy ? '正在执行' : pendingRequest ? '请求已排队' : '立即执行一次'
    renderMedalList()
  }
  const refreshStatus = () => {
    if (panelRefreshTask) { panelRefreshAgain = true; return panelRefreshTask }
    panelRefreshTask = (async () => {
      do {
        panelRefreshAgain = false
        const uid = getUid()
        watchPanelAccount(uid)
        const [status, peers, paused, schedule, request, queue, clickTimes, roster] = await Promise.all([
          getValue(STORAGE.status, {}), readPeers(),
          validId(uid) ? getValue(STORAGE.paused(uid), false) : false,
          validId(uid) ? getValue(STORAGE.schedule(uid), null) : null,
          validId(uid) ? getValue(STORAGE.request(uid), null) : null,
          validId(uid) ? getValue(STORAGE.queue(uid), []) : [], getClickTimes(),
          validId(uid) ? getValue(STORAGE.medals(uid), null) : null,
        ])
        if (uid !== getUid()) { panelRefreshAgain = true; continue }
        const records = {}
        if (!controls.find('medal-list').hidden) {
          await Promise.all((roster?.medals ?? []).map(async medal => {
            const key = STORAGE.room(uid, medal.roomId)
            if (!watchedRooms.has(key)) { watchedRooms.add(key); GM_addValueChangeListener(key, refreshOpenPanel) }
            records[medal.roomId] = await getValue(key, null)
          }))
        }
        if (uid !== getUid()) { panelRefreshAgain = true; continue }
        panelSnapshot = { uid, status, leader: selectLeader(peers), paused, schedule, request, queue, clickTimes, roster, records }
        renderStatus()
      } while (panelRefreshAgain && panelIsOpen())
    })().finally(() => { panelRefreshTask = null })
    return panelRefreshTask
  }
  const showStatus = async () => {
    const { find } = await mountControls()
    if (find('backdrop').hidden) {
      controls.previousFocus = document.activeElement
      find('backdrop').hidden = false
      const options = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'theme'] }
      controls.themeObserver.observe(document.documentElement, options)
      if (document.body) controls.themeObserver.observe(document.body, options)
      find('clicks').value = String(await getClickTimes())
      find('message').textContent = ''
      find('panel').focus()
    }
    await refreshStatus()
    let lastReadAt = Date.now()
    if (panelIsOpen() && !panelTimer) panelTimer = setInterval(() => {
      renderStatus()
      // 存储变化即时刷新；定时读取仅用于发现账号、标签页和控制者的变化。
      if (Date.now() - lastReadAt >= 5_000) { lastReadAt = Date.now(); refreshOpenPanel() }
    }, 1_000)
  }
  GM_registerMenuCommand('打开勋章保活控制面板', () => {
    void showStatus().catch(error => { warn(error); if (controls) controls.find('message').textContent = error.message })
  })
  GM_addValueChangeListener(STORAGE.signal, () => wakeWorker())
  for (const key of [STORAGE.status, STORAGE.clickTimes, STORAGE.signal]) {
    GM_addValueChangeListener(key, refreshOpenPanel)
  }
  addEventListener('pagehide', () => {
    stopped = true
    loseSession()
    if (peer) void publishPeer({ state: 'closed', term: '', expiresAt: 0, seenAt: 0 }).catch(() => {})
  })
  addEventListener('pageshow', event => {
    if (event.persisted && stopped) {
      stopped = false
      startCoordinator()
    }
  })
  const startCoordinator = () => {
    if (coordinatorTask) return
    coordinatorTask = coordinatorLoop().catch(error => {
      loseSession()
      warn('协调器无法启动：', error)
    }).finally(() => { coordinatorTask = null })
  }
  startCoordinator()
})()
