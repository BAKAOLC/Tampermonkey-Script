// ==UserScript==
// @license     MIT
// @name        Bilibili 粉丝勋章自动保活
// @description 不限开播或点亮状态，成功发送满 24 小时后随机点赞；最先启动的 B 站标签页控制任务，失去响应后接管。
// @author      BAKAOLC
// @version     1.2.0
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
// @grant       GM_notification
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
  const API_BASE = 'https://api.live.bilibili.com'
  const CONFIG = Object.freeze({
    defaultClickTimes: 30,
    minClickTimes: 1,
    maxClickTimes: 3000,
    pageSize: 50,
    maxPages: 20,
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
    peer = { ...peer, ...patch, ownerId, startedAt, page: location.origin + location.pathname }
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
    await setValue(STORAGE.status, { ...previous, ...patch, ownerId, term: current.term,
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
      const data = await apiRequest(current, uid, `/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=${CONFIG.pageSize}`)
      await assertSession(current, uid)
      if (!Array.isArray(data.list)) throw new Error('勋章列表格式异常，本轮停止')
      const items = [...data.list, ...(Array.isArray(data.special_list) ? data.special_list : [])]
      const previousSize = medals.size
      for (const item of items) {
        const medal = item?.medal ?? {}
        const room = item?.room_info ?? {}
        const anchor = item?.anchor_info ?? {}
        const roomId = [room.room_id, room.roomid, anchor.room_id, medal.room_id].find(validId)
        if (!roomId) continue
        const targetId = [medal.target_id, anchor.uid, anchor.mid].find(validId)
        medals.set(String(roomId), {
          roomId: String(roomId), targetId: targetId ? String(targetId) : '',
          medalId: String(medal.medal_id ?? medal.id ?? ''),
          medalName: String(medal.medal_name ?? medal.name ?? ''),
          anchorName: String(anchor.nick_name ?? anchor.uname ?? ''),
        })
      }
      const total = Number(data.total_number ?? data.total ?? 0)
      if (data.list.length === 0 || (total > 0 && medals.size >= total) ||
        (total <= 0 && data.list.length < CONFIG.pageSize)) return [...medals.values()]
      if (medals.size === previousSize) throw new Error('勋章分页没有新增数据，本轮停止以免漏处理')
    }
    throw new Error('勋章列表超过分页上限，本轮停止')
  }
  const isDueForLike = (record, now = Date.now()) => {
    if (!record) return true
    if (Number(record.lastSuccessAt) > 0 && Number(record.lastSuccessAt) + CONFIG.resendIntervalMs > now) return false
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
    const anchorId = await resolveAnchorId(current, uid, medal)
    await assertSession(current, uid)
    const csrf = getCookie('bili_jct')
    if (!csrf) throw new Error('未检测到登录凭据，请先登录 Bilibili')
    const key = STORAGE.room(uid, medal.roomId)
    const previous = await getValue(key, null)
    if (!isDueForLike(previous)) return 'skipped'
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
  const runScan = async (current, uid) => {
    await assertSession(current, uid)
    const scanStartedAt = Date.now()
    await updateStatus(current, { uid, phase: 'scanning', current: '', nextScanAt: 0, lastError: '' })
    const medals = await getAllMedals(current, uid)
    const candidates = []
    for (const medal of medals) {
      if (isDueForLike(await getValue(STORAGE.room(uid, medal.roomId), null))) candidates.push(medal)
    }
    const summary = { totalMedals: medals.length, candidates: candidates.length, accepted: 0, rejected: 0, unknown: 0, failed: 0, skipped: 0 }
    const clickTimes = await getClickTimes()
    for (const [index, medal] of shuffle(candidates).entries()) {
      await sleep(randomInt(CONFIG.roomDelayMinMs, CONFIG.roomDelayMaxMs), current.controller.signal)
      await assertSession(current, uid)
      await updateStatus(current, { uid, phase: 'processing', current: `${index + 1}/${candidates.length} ${medal.medalName || medal.roomId}` })
      try {
        const outcome = await sendLike(current, uid, medal, clickTimes)
        summary[outcome] += 1
      } catch (error) {
        if (error instanceof LeadershipLostError || error instanceof AccountChangedError) throw error
        summary.failed += 1
        warn('处理直播间失败：', error)
      }
    }
    await updateStatus(current, { uid, phase: 'idle', current: '', lastScanAt: scanStartedAt, lastSummary: summary })
    if (summary.accepted > 0 && typeof GM_notification === 'function') {
      GM_notification({ title: SCRIPT_NAME, text: `本轮成功发送 ${summary.accepted} 个，拒绝 ${summary.rejected} 个，结果未知 ${summary.unknown} 个`, timeout: 6_000 })
    }
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
      // 只确认本轮开始时看到的请求；扫描期间的新请求留给下一轮。
      const acknowledgedRequest = request?.id ?? schedule.acknowledgedRequest
      await assertSession(current, uid)
      await setValue(key, { ...schedule, acknowledgedRequest })
      try { await runScan(current, uid) } catch (error) {
        if (error instanceof LeadershipLostError) throw error
        if (!(error instanceof AccountChangedError)) {
          await updateStatus(current, { uid, phase: 'error', current: '', lastError: error.message, lastScanAt: Date.now() })
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
    if (!validId(uid)) { alert('请先登录 Bilibili'); return }
    const request = { id: createId(), at: Date.now() }
    await setValue(STORAGE.request(uid), request)
    await setValue(STORAGE.signal, request)
    wakeWorker()
    log('已保存扫描请求；24 小时冷却和结果未知的保护记录仍然有效')
  }
  const showStatus = async () => {
    const status = await getValue(STORAGE.status, {})
    const uid = getUid()
    const sameAccount = uid && status.uid === uid
    const summary = sameAccount ? status.lastSummary ?? {} : {}
    const leader = selectLeader(await readPeers())
    const formatTime = value => value ? new Date(value).toLocaleString() : '无'
    alert([
      SCRIPT_NAME,
      `主控制者：${leader?.page ?? '等待选举'}`,
      `状态：${sameAccount ? status.phase : '等待当前账号的状态'}`,
      `下次扫描：${formatTime(sameAccount ? status.nextScanAt : 0)}`,
      `上次扫描：${formatTime(sameAccount ? status.lastScanAt : 0)}`,
      `上轮：成功发送 ${summary.accepted ?? 0} / 拒绝 ${summary.rejected ?? 0} / 结果未知 ${summary.unknown ?? 0} / 处理失败 ${summary.failed ?? 0}`,
      `点赞次数：${await getClickTimes()}`,
      '成功发送后满 24 小时才再次入选；结果未知时也暂缓 24 小时。',
      sameAccount && status.lastError ? `最近错误：${status.lastError}` : '',
    ].filter(Boolean).join('\n'))
  }
  const menu = (name, callback) => GM_registerMenuCommand(name, () => {
    Promise.resolve().then(callback).catch(error => { warn(error); alert(error.message) })
  })
  menu('查看运行状态', showStatus)
  menu('立即请求扫描', requestScan)
  menu('设置单次点赞数', async () => {
    const input = prompt(`请输入点赞次数（${CONFIG.minClickTimes}-${CONFIG.maxClickTimes}）：`, String(await getClickTimes()))
    if (input === null) return
    const value = Number(input)
    if (!Number.isInteger(value) || value < CONFIG.minClickTimes || value > CONFIG.maxClickTimes) {
      alert('输入无效，设置未更改。'); return
    }
    await setValue(STORAGE.clickTimes, value)
    alert(`已将单次点赞数设置为 ${value}。`)
  })
  GM_addValueChangeListener(STORAGE.signal, () => wakeWorker())
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
