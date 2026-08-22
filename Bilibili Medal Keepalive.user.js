// ==UserScript==
// @license MIT
// @name        Bilibili 粉丝勋章自动保活
// @description 在任意 Bilibili 页面随机扫描已拥有的粉丝勋章，仅对开播且尚未点亮的直播间发送批量点赞，并保证跨子域、跨标签页只有一个工作实例
// @author      BAKAOLC
// @version     1.1.5
// @match       https://*.bilibili.com/*
// @match       https://bilibili.com/*
// @namespace   none
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @grant       GM_addValueChangeListener
// @grant       GM_notification
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
    maxAttemptsPerRoomPerDay: 3,
    requestRetries: 1,
    leaseDurationMs: 180_000,
    heartbeatIntervalMs: 20_000,
    claimSettleMinMs: 800,
    claimSettleMaxMs: 1_800,
    lockRetryMinMs: 4_000,
    lockRetryMaxMs: 9_000,
  })

  const STORAGE = Object.freeze({
    daily: 'bmk:daily:v1',
    status: 'bmk:status:v1',
    runNow: 'bmk:run-now:v1',
    clickTimes: 'bmk:click-times:v1',
    lock: 'bmk:global-lock:v1',
  })

  const log = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args)
  const warn = (...args) => console.warn(`[${SCRIPT_NAME}]`, ...args)
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const createId = () =>
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

  class LeadershipLostError extends Error {
    constructor() {
      super('当前标签页已失去全局任务锁')
      this.name = 'LeadershipLostError'
    }
  }

  const getGlobalLock = () => GM_getValue(STORAGE.lock, null)
  const isGlobalLockValid = lock =>
    Boolean(lock?.ownerId) && Number(lock.expiresAt ?? 0) > Date.now()
  const ownsGlobalLock = ownerId => {
    const lock = getGlobalLock()
    return lock?.ownerId === ownerId && isGlobalLockValid(lock)
  }
  const assertGlobalLeadership = ownerId => {
    if (!ownsGlobalLock(ownerId)) {
      throw new LeadershipLostError()
    }
  }

  const tryAcquireGlobalLock = async ownerId => {
    const current = getGlobalLock()
    if (isGlobalLockValid(current)) {
      return current.ownerId === ownerId
    }

    const claimedAt = Date.now()
    GM_setValue(STORAGE.lock, {
      ownerId,
      state: 'claiming',
      claimedAt,
      expiresAt: claimedAt + CONFIG.leaseDurationMs,
      page: location.href,
    })

    await sleep(randomInt(CONFIG.claimSettleMinMs, CONFIG.claimSettleMaxMs))
    const observed = getGlobalLock()
    if (observed?.ownerId !== ownerId) {
      return false
    }

    const activatedAt = Date.now()
    GM_setValue(STORAGE.lock, {
      ownerId,
      state: 'active',
      claimedAt,
      activatedAt,
      expiresAt: activatedAt + CONFIG.leaseDurationMs,
      page: location.href,
    })
    return ownsGlobalLock(ownerId)
  }

  const renewGlobalLock = ownerId => {
    const current = getGlobalLock()
    if (current?.ownerId !== ownerId || !isGlobalLockValid(current)) {
      return false
    }
    GM_setValue(STORAGE.lock, {
      ...current,
      state: 'active',
      heartbeatAt: Date.now(),
      expiresAt: Date.now() + CONFIG.leaseDurationMs,
      page: location.href,
    })
    return true
  }

  const releaseGlobalLock = ownerId => {
    const current = getGlobalLock()
    if (current?.ownerId === ownerId) {
      GM_setValue(STORAGE.lock, {
        ownerId: '',
        state: 'released',
        releasedAt: Date.now(),
        expiresAt: 0,
      })
    }
  }

  const shuffle = source => {
    const result = [...source]
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i)
      ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
  }

  const getCookie = name => {
    const prefix = `${name}=`
    const item = document.cookie.split('; ').find(cookie => cookie.startsWith(prefix))
    return item ? decodeURIComponent(item.slice(prefix.length)) : ''
  }

  const getLocalDay = (date = new Date()) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const getClickTimes = () => {
    const value = Number(GM_getValue(STORAGE.clickTimes, CONFIG.defaultClickTimes))
    if (!Number.isInteger(value)) {
      return CONFIG.defaultClickTimes
    }
    return Math.min(CONFIG.maxClickTimes, Math.max(CONFIG.minClickTimes, value))
  }

  const getDailyState = () => {
    const today = getLocalDay()
    const saved = GM_getValue(STORAGE.daily, null)
    if (!saved || saved.day !== today) {
      return { day: today, rooms: {}, attempts: {} }
    }
    return {
      day: today,
      rooms: saved.rooms && typeof saved.rooms === 'object' ? saved.rooms : {},
      attempts: saved.attempts && typeof saved.attempts === 'object' ? saved.attempts : {},
    }
  }

  const saveDailyState = state => GM_setValue(STORAGE.daily, state)

  const updateStatus = patch => {
    const previous = GM_getValue(STORAGE.status, {})
    GM_setValue(STORAGE.status, {
      ...previous,
      ...patch,
      updatedAt: Date.now(),
      page: location.href,
    })
  }

  const toError = (message, code) => {
    const error = new Error(code === undefined ? message : `${message} (code: ${code})`)
    error.code = code
    return error
  }

  const apiRequest = async (path, init = {}) => {
    let lastError
    for (let attempt = 0; attempt <= CONFIG.requestRetries; attempt += 1) {
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          credentials: 'include',
          cache: 'no-store',
          ...init,
        })
        const text = await response.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error(`API 返回了非 JSON 内容（HTTP ${response.status}）`)
        }
        if (!response.ok) {
          throw toError(`HTTP ${response.status}: ${json.message || json.msg || '请求失败'}`)
        }
        if (json.code !== 0) {
          throw toError(json.message || json.msg || 'Bilibili API 请求失败', json.code)
        }
        return json.data ?? json.result ?? {}
      } catch (error) {
        lastError = error
        if (attempt < CONFIG.requestRetries) {
          await sleep(randomInt(2_500, 6_500))
        }
      }
    }
    throw lastError
  }

  const getAllMedals = async () => {
    const medals = new Map()
    let reportedTotal = 0

    for (let page = 1; page <= CONFIG.maxPages; page += 1) {
      const data = await apiRequest(
        `/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=${CONFIG.pageSize}`,
      )
      const normalList = Array.isArray(data.list) ? data.list : []
      const specialList = Array.isArray(data.special_list) ? data.special_list : []
      const items = [...normalList, ...specialList]
      reportedTotal = Math.max(reportedTotal, Number(data.total_number ?? data.total ?? 0))

      for (const item of items) {
        const medal = item?.medal ?? {}
        const room = item?.room_info ?? {}
        const anchor = item?.anchor_info ?? {}
        const roomId = String(
          room.room_id ?? room.roomid ?? anchor.room_id ?? medal.room_id ?? '',
        ).trim()
        const medalId = String(medal.medal_id ?? medal.id ?? '').trim()
        if (!roomId || roomId === '0') {
          warn('跳过无法识别直播间的勋章', item)
          continue
        }
        const key = medalId || roomId
        medals.set(key, {
          roomId,
          medalId,
          targetId: String(medal.target_id ?? anchor.uid ?? anchor.mid ?? '').trim(),
          medalName: String(medal.medal_name ?? medal.name ?? ''),
          anchorName: String(anchor.nick_name ?? anchor.uname ?? ''),
          isLighted: Number(medal.is_lighted ?? medal.is_light ?? 0) === 1,
          liveStatus: Number(room.living_status ?? room.live_status ?? room.liveStatus ?? 0),
        })
      }

      if (
        normalList.length === 0 ||
        normalList.length < CONFIG.pageSize ||
        (reportedTotal > 0 && medals.size >= reportedTotal)
      ) {
        break
      }
    }

    return [...medals.values()]
  }

  const getRoomUserInfo = roomId =>
    apiRequest(`/xlive/web-room/v1/index/getInfoByUser?room_id=${encodeURIComponent(roomId)}`)

  const getCurrentMedal = info => info?.medal?.curr_weared ?? null

  const sendBatchLike = async (roomId, anchorId, clickTimes) => {
    const uid = getCookie('DedeUserID')
    const csrf = getCookie('bili_jct')
    if (!uid || !csrf) {
      throw new Error('未检测到登录 Cookie（DedeUserID / bili_jct），请先登录 Bilibili')
    }

    const body = new URLSearchParams({
      click_time: String(clickTimes),
      room_id: String(roomId),
      anchor_id: String(anchorId),
      uid,
      csrf_token: csrf,
      csrf,
      visit_id: '',
    })

    return apiRequest('/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body,
    })
  }


  const markAttempt = (state, roomId) => {
    state.attempts[roomId] = Number(state.attempts[roomId] ?? 0) + 1
    saveDailyState(state)
  }

  const markDone = (state, medal, status) => {
    state.rooms[medal.roomId] = {
      at: Date.now(),
      status,
      medalName: medal.medalName,
      anchorName: medal.anchorName,
    }
    saveDailyState(state)
  }

  const runScan = async ownerId => {
    assertGlobalLeadership(ownerId)
    const state = getDailyState()
    const clickTimes = getClickTimes()
    const startedAt = Date.now()
    updateStatus({ ownerId, phase: 'scanning', startedAt, lastError: '' })

    const medals = await getAllMedals()
    for (const medal of medals) {
      if (medal.isLighted && !state.rooms[medal.roomId]) {
        markDone(state, medal, 'already-lighted')
      }
    }

    const candidates = shuffle(
      medals.filter(medal => {
        if (medal.liveStatus !== 1 || medal.isLighted || state.rooms[medal.roomId]) {
          return false
        }
        return Number(state.attempts[medal.roomId] ?? 0) < CONFIG.maxAttemptsPerRoomPerDay
      }),
    )

    updateStatus({
      ownerId,
      phase: 'processing',
      totalMedals: medals.length,
      liveCandidates: candidates.length,
      clickTimes,
    })

    let succeeded = 0
    let failed = 0
    const accepted = []

    for (const [index, medal] of candidates.entries()) {
      await sleep(randomInt(CONFIG.roomDelayMinMs, CONFIG.roomDelayMaxMs))
      assertGlobalLeadership(ownerId)
      updateStatus({
        ownerId,
        phase: 'processing',
        current: `${index + 1}/${candidates.length} ${medal.medalName || medal.roomId}`,
      })

      try {
        markAttempt(state, medal.roomId)
        let anchorId = medal.targetId
        if (!anchorId) {
          const info = await getRoomUserInfo(medal.roomId)
          anchorId = getCurrentMedal(info)?.target_id
        }
        if (!anchorId) {
          throw new Error(`直播间 ${medal.roomId} 未返回可用的主播 UID`)
        }

        assertGlobalLeadership(ownerId)
        await sendBatchLike(medal.roomId, anchorId, clickTimes)
        accepted.push(medal)
        log(`点赞 API 已接受 ${medal.medalName || medal.roomId}`, {
          roomId: medal.roomId,
          clickTimes,
        })
      } catch (error) {
        if (error instanceof LeadershipLostError) {
          throw error
        }
        failed += 1
        warn(`处理 ${medal.medalName || medal.roomId} 失败:`, error)
      }
    }

    if (accepted.length > 0) {
      await sleep(randomInt(3_000, 6_000))
      assertGlobalLeadership(ownerId)
      try {
        const refreshed = await getAllMedals()
        const refreshedByMedalId = new Map(refreshed.map(medal => [medal.medalId, medal]))
        const refreshedByRoomId = new Map(refreshed.map(medal => [medal.roomId, medal]))
        for (const medal of accepted) {
          const latest =
            (medal.medalId && refreshedByMedalId.get(medal.medalId)) ||
            refreshedByRoomId.get(medal.roomId)
          if (latest?.isLighted) {
            markDone(state, medal, 'verified')
            succeeded += 1
            log(`已回读确认点亮 ${medal.medalName || medal.roomId}`)
          } else {
            failed += 1
            warn(`点赞 API 已接受，但牌子仍未点亮，将在后续扫描中重试`, medal)
          }
        }
      } catch (error) {
        warn('点赞成功，但刷新勋章列表进行回读验证失败:', error)
        for (const medal of accepted) {
          markDone(state, medal, 'api-accepted')
          succeeded += 1
        }
      }
    }

    updateStatus({
      ownerId,
      phase: 'idle',
      current: '',
      lastScanAt: startedAt,
      lastSummary: {
        totalMedals: medals.length,
        candidates: candidates.length,
        succeeded,
        failed,
      },
    })

    if (succeeded > 0 && typeof GM_notification === 'function') {
      GM_notification({
        title: SCRIPT_NAME,
        text: `本轮已处理 ${succeeded} 个勋章${failed ? `，失败 ${failed} 个` : ''}`,
        timeout: 6_000,
      })
    }
  }

  let wakeResolver = null
  const wake = () => {
    wakeResolver?.()
    wakeResolver = null
  }
  const waitOrWake = ms =>
    new Promise(resolve => {
      let finished = false
      const finish = () => {
        if (finished) {
          return
        }
        finished = true
        wakeResolver = null
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      wakeResolver = finish
    })

  const workerLoop = async ownerId => {
    let delay = randomInt(CONFIG.initialDelayMinMs, CONFIG.initialDelayMaxMs)
    while (true) {
      const nextScanAt = Date.now() + delay
      updateStatus({ ownerId, phase: 'waiting', nextScanAt })
      await waitOrWake(delay)

      try {
        await runScan(ownerId)
      } catch (error) {
        if (error instanceof LeadershipLostError) {
          throw error
        }
        warn('扫描失败:', error)
        updateStatus({
          ownerId,
          phase: 'error',
          lastError: error instanceof Error ? error.message : String(error),
          lastScanAt: Date.now(),
        })
      }

      delay = randomInt(CONFIG.scanIntervalMinMs, CONFIG.scanIntervalMaxMs)
    }
  }

  const coordinatorLoop = async ownerId => {
    while (true) {
      const acquired = await tryAcquireGlobalLock(ownerId)
      if (!acquired) {
        await waitOrWake(randomInt(CONFIG.lockRetryMinMs, CONFIG.lockRetryMaxMs))
        continue
      }

      log('已取得跨子域全局任务锁，当前标签页成为唯一工作实例。')
      updateStatus({ ownerId, phase: 'leader', acquiredAt: Date.now(), lastError: '' })
      const heartbeatTimer = setInterval(() => {
        if (!renewGlobalLock(ownerId)) {
          wake()
        }
      }, CONFIG.heartbeatIntervalMs)

      try {
        await workerLoop(ownerId)
      } catch (error) {
        if (error instanceof LeadershipLostError) {
          warn('当前标签页已失去全局任务锁，停止工作并重新参与竞选。')
        } else {
          warn('全局工作实例异常退出:', error)
          updateStatus({
            ownerId,
            phase: 'error',
            lastError: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        clearInterval(heartbeatTimer)
        releaseGlobalLock(ownerId)
      }

      await waitOrWake(randomInt(CONFIG.lockRetryMinMs, CONFIG.lockRetryMaxMs))
    }
  }

  const showStatus = () => {
    const status = GM_getValue(STORAGE.status, {})
    const daily = getDailyState()
    const formatTime = value => (value ? new Date(value).toLocaleString() : '无')
    const summary = status.lastSummary ?? {}
    alert(
      [
        SCRIPT_NAME,
        `状态：${status.phase ?? '尚未启动'}`,
        `工作页面：${status.page ?? '无'}`,
        `下次扫描：${formatTime(status.nextScanAt)}`,
        `上次扫描：${formatTime(status.lastScanAt)}`,
        `今日已完成：${Object.keys(daily.rooms).length}`,
        `上轮：候选 ${summary.candidates ?? 0} / 成功 ${summary.succeeded ?? 0} / 失败 ${summary.failed ?? 0}`,
        `点赞次数：${getClickTimes()}`,
        status.lastError ? `最近错误：${status.lastError}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  GM_registerMenuCommand('查看运行状态', showStatus)
  GM_registerMenuCommand('立即请求扫描', () => {
    GM_setValue(STORAGE.runNow, { id: createId(), at: Date.now() })
    wake()
    log('已请求当前主实例立即扫描')
  })
  GM_registerMenuCommand('设置单次点赞数', () => {
    const input = prompt(
      `请输入每个直播间的点赞次数（${CONFIG.minClickTimes}-${CONFIG.maxClickTimes}）：`,
      String(getClickTimes()),
    )
    if (input === null) {
      return
    }
    const value = Number(input)
    if (!Number.isInteger(value) || value < CONFIG.minClickTimes || value > CONFIG.maxClickTimes) {
      alert('输入无效，设置未更改。')
      return
    }
    GM_setValue(STORAGE.clickTimes, value)
    alert(`已将单次点赞数设置为 ${value}。`)
  })
  GM_registerMenuCommand('清除今日记录并重新扫描', () => {
    saveDailyState({ day: getLocalDay(), rooms: {}, attempts: {} })
    GM_setValue(STORAGE.runNow, { id: createId(), at: Date.now() })
    wake()
    log('已清除今日记录并请求重新扫描')
  })

  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(STORAGE.runNow, wake)
  }

  const ownerId = createId()
  coordinatorLoop(ownerId).catch(error => {
    warn('全局任务协调器异常退出:', error)
    updateStatus({
      ownerId,
      phase: 'error',
      lastError: error instanceof Error ? error.message : String(error),
    })
  })
})()
