import path from 'node:path'

const CACHE_TTL_MS = 60000
const MAX_CACHE_ENTRIES = 32
const PACKET_WINDOW_MS = 60000
const MAX_PACKET_RETRIEVALS_PER_WINDOW = 2
const ABSTRACT_LIMIT = 1800
const PACKET_LIMIT = 3600

const cache = new Map()
const inFlight = new Map()
const packetWindows = new Map()
const metrics = new Map()

function workspaceMetrics(workspace) {
  if (!metrics.has(workspace)) {
    metrics.set(workspace, { requests: 0, cacheHits: 0, inFlightHits: 0, abstractQueries: 0, packetQueries: 0, packetRateLimited: 0, aborts: 0, failures: 0 })
  }
  return metrics.get(workspace)
}

/** Read-only operational diagnostics for host logs and future profile UI. */
export function recallMetrics(workspace) {
  return { ...(metrics.get(path.resolve(workspace)) || {}) }
}

function warn(workspace, reason) {
  workspaceMetrics(workspace).failures += 1
  console.warn(`[local-rag-wiki] bounded wiki recall skipped for ${path.basename(workspace)}: ${reason}`)
}

function truncate(text, limit) {
  const normalized = String(text || '').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n[truncated]` : normalized
}

function isMiss(text) {
  return !text || /"miss"\s*:\s*true/.test(text) || /"result_count"\s*:\s*0/.test(text)
}

function cacheKey(workspace, query) {
  return `${workspace}\u0000${query.trim().toLowerCase()}`
}

function readCache(key) {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

function writeCache(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

function canRetrievePacket(workspace) {
  const now = Date.now()
  const active = (packetWindows.get(workspace) || []).filter(timestamp => timestamp > now - PACKET_WINDOW_MS)
  if (active.length >= MAX_PACKET_RETRIEVALS_PER_WINDOW) {
    packetWindows.set(workspace, active)
    workspaceMetrics(workspace).packetRateLimited += 1
    return false
  }
  active.push(now)
  packetWindows.set(workspace, active)
  return true
}

function awaitWithSignal(promise, signal, workspace) {
  if (!signal) return promise
  if (signal.aborted) {
    workspaceMetrics(workspace).aborts += 1
    return Promise.resolve(undefined)
  }
  return new Promise(resolve => {
    const abort = () => {
      workspaceMetrics(workspace).aborts += 1
      resolve(undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => resolve(value)).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function runNativeRecall(workspace, query, search) {
  try {
    workspaceMetrics(workspace).abstractQueries += 1
    const abstract = await search({ query, depth: 'abstract', top_k: 5 })
    if (isMiss(abstract)) return undefined
    const abstractResult = truncate(abstract, ABSTRACT_LIMIT)
    if (!canRetrievePacket(workspace)) return { abstract: abstractResult, packetRateLimited: true }

    workspaceMetrics(workspace).packetQueries += 1
    const packet = await search({ query, depth: 'packet', top_k: 3 })
    if (isMiss(packet)) return { abstract: abstractResult }
    return { abstract: abstractResult, packet: truncate(packet, PACKET_LIMIT) }
  } catch (error) {
    warn(workspace, error?.message || String(error))
    return undefined
  }
}

/**
 * Per-workspace deduplicated, bounded L0/L1 retrieval through the already
 * mounted DSH MCP tool. A cancelling caller stops waiting without killing a
 * shared in-flight query owned by another active agent step.
 */
export function retrieveWikiTiers(workspace, query, signal, search) {
  const workspaceRoot = path.resolve(workspace)
  if (typeof search !== 'function') return Promise.resolve(undefined)
  const metric = workspaceMetrics(workspaceRoot)
  metric.requests += 1
  const key = cacheKey(workspaceRoot, query)
  const cached = readCache(key)
  if (cached) {
    metric.cacheHits += 1
    return awaitWithSignal(Promise.resolve(cached), signal, workspaceRoot)
  }
  let task = inFlight.get(key)
  if (task) metric.inFlightHits += 1
  if (!task) {
    task = runNativeRecall(workspaceRoot, query, search)
      .then(value => {
        if (value?.abstract) writeCache(key, value)
        return value
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, task)
  }
  return awaitWithSignal(task, signal, workspaceRoot)
}

export function shouldRetrieve(prompt, keywordCount) {
  const text = String(prompt || '').trim()
  if (text.length < 24 || keywordCount < 2) return false
  return !/^(ok|okay|thanks|thank you|continue|yes|no|sure)[!. ]*$/i.test(text)
}
