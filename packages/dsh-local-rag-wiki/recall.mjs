import path from 'node:path'

const CACHE_TTL_MS = 60000
const MAX_CACHE_ENTRIES = 32
// Automatic recall is deliberately smaller than a typical tool result. At the
// conservative four-characters-per-token estimate this is a 225-token ceiling.
const ABSTRACT_LIMIT = 900
export const AUTO_RECALL_CONFIDENCE_THRESHOLD = 0.5

const cache = new Map()
const inFlight = new Map()
const metrics = new Map()

function workspaceMetrics(workspace) {
  if (!metrics.has(workspace)) {
    metrics.set(workspace, {
      requests: 0,
      cacheHits: 0,
      inFlightHits: 0,
      abstractQueries: 0,
      explicitRequests: 0,
      automaticRequests: 0,
      automaticSkipped: 0,
      confidenceSkipped: 0,
      injectedChars: 0,
      estimatedInjectedTokens: 0,
      budgetTruncations: 0,
      aborts: 0,
      failures: 0,
    })
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

function highestRelevanceScore(value) {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    return value.reduce((highest, item) => Math.max(highest, highestRelevanceScore(item) ?? -Infinity), -Infinity)
  }
  const ownScore = Number(value.relevance_score)
  const childScores = Object.values(value).map(highestRelevanceScore).filter(Number.isFinite)
  const highest = Math.max(Number.isFinite(ownScore) ? ownScore : -Infinity, ...childScores)
  return Number.isFinite(highest) ? highest : undefined
}

export function retrievalConfidence(text) {
  try {
    return highestRelevanceScore(JSON.parse(text))
  } catch {
    return undefined
  }
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

// A user can bypass automatic confidence gating with this leading directive.
export function explicitWikiQuery(prompt) {
  const match = String(prompt || '').match(/^\s*\$wiki(?:\s+|\s*$)([\s\S]*)$/i)
  if (!match) return undefined
  const query = match[1].trim()
  return query || undefined
}

export function noteAutomaticSkip(workspace) {
  workspaceMetrics(path.resolve(workspace)).automaticSkipped += 1
}

export function recordInjectedContext(workspace, text) {
  const metric = workspaceMetrics(path.resolve(workspace))
  metric.injectedChars += text.length
  metric.estimatedInjectedTokens += Math.ceil(text.length / 4)
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

async function runNativeRecall(workspace, query, search, { requireConfidence = false } = {}) {
  try {
    workspaceMetrics(workspace).abstractQueries += 1
    // Automatic recall is L0-only. Additional detail remains an explicit model
    // tool decision, rather than being preloaded into every opted-in turn.
    const abstract = await search({ query, depth: 'abstract', top_k: 3 })
    if (isMiss(abstract)) return undefined
    if (requireConfidence && (retrievalConfidence(abstract) ?? 0) < AUTO_RECALL_CONFIDENCE_THRESHOLD) {
      workspaceMetrics(workspace).confidenceSkipped += 1
      return undefined
    }
    const abstractResult = truncate(abstract, ABSTRACT_LIMIT)
    if (abstractResult.length < String(abstract).trim().length) {
      workspaceMetrics(workspace).budgetTruncations += 1
    }
    return { abstract: abstractResult }
  } catch (error) {
    warn(workspace, error?.message || String(error))
    return undefined
  }
}

/**
 * Per-workspace deduplicated, bounded L0 retrieval through the already mounted
 * DSH MCP tool. A cancelling caller stops waiting without killing a
 * shared in-flight query owned by another active agent step.
 */
export function retrieveWikiTiers(workspace, query, signal, search, { explicit = true } = {}) {
  const workspaceRoot = path.resolve(workspace)
  if (typeof search !== 'function') return Promise.resolve(undefined)
  const metric = workspaceMetrics(workspaceRoot)
  metric.requests += 1
  if (explicit) metric.explicitRequests += 1
  else metric.automaticRequests += 1
  const key = cacheKey(workspaceRoot, query)
  const cached = readCache(key)
  if (cached) {
    metric.cacheHits += 1
    return awaitWithSignal(Promise.resolve(cached), signal, workspaceRoot)
  }
  let task = inFlight.get(key)
  if (task) metric.inFlightHits += 1
  if (!task) {
    task = runNativeRecall(workspaceRoot, query, search, { requireConfidence: !explicit })
      .then(value => {
        if (value?.abstract) writeCache(key, value)
        return value
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, task)
  }
  return awaitWithSignal(task, signal, workspaceRoot)
}

export function shouldRetrieve(prompt) {
  return Boolean(explicitWikiQuery(prompt))
}
