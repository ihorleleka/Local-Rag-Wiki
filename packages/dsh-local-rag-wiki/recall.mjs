import path from 'node:path'

const CACHE_TTL_MS = 60000
const MAX_CACHE_ENTRIES = 32
// Automatic recall is deliberately smaller than a typical tool result. At the
// conservative four-characters-per-token estimate this is a 225-token ceiling.
const ABSTRACT_LIMIT = 900
// Search rank selects candidates; it is not a calibrated probability of topical
// relevance. Automatic injection also requires direct lexical grounding below.
export const AUTO_RECALL_MINIMUM_SCORE = 0.5
// Retained for callers compiled against the prior export.
export const AUTO_RECALL_CONFIDENCE_THRESHOLD = AUTO_RECALL_MINIMUM_SCORE

const cache = new Map()
const inFlight = new Map()
const metrics = new Map()

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'check', 'do', 'does',
  'for', 'from', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on',
  'or', 'our', 'please', 'should', 'so', 'that', 'the', 'their', 'then', 'there', 'these',
  'this', 'to', 'use', 'used', 'using', 'was', 'we', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'you', 'your', 'any', 'have', 'has', 'had', 'been', 'sent', 'files',
  'file', 'message', 'messages', 'returned', 'return', 'score', 'scores', 'entry', 'entries',
])

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
      groundingSkipped: 0,
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

function parseSearchResponse(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function meaningfulTerms(text) {
  return new Set(
    (String(text || '').toLowerCase().match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) || [])
      .filter(term => term.length > 2 && !STOPWORDS.has(term)),
  )
}

function candidateText(result) {
  return [result?.source, result?.source_file, result?.abstract, result?.context]
    .filter(value => typeof value === 'string')
    .join(' ')
}

function isIdentifierLike(term) {
  return /[._-]|\d/.test(term)
}

// A single generic word is insufficient evidence that the returned repository
// note is about the submitted task. Requiring two independently shared terms
// (or a shared identifier) deliberately biases automatic recall towards abstention.
export function hasLexicalGrounding(query, result) {
  const queryTerms = meaningfulTerms(query)
  const resultTerms = meaningfulTerms(candidateText(result))
  const shared = [...queryTerms].filter(term => resultTerms.has(term))
  return shared.some(isIdentifierLike) || shared.length >= 2
}

function compactSearchResponse(response, limit) {
  const results = Array.isArray(response?.results) ? response.results : []
  const diagnostics = response?.diagnostics && typeof response.diagnostics === 'object'
    ? { ...response.diagnostics }
    : {}
  const selected = []
  for (const result of results) {
    const candidate = { results: [...selected, result], diagnostics: { ...diagnostics, result_count: selected.length + 1 } }
    if (JSON.stringify(candidate).length > limit) break
    selected.push(result)
  }
  if (selected.length !== results.length) diagnostics.budget_truncated = true
  const compact = { results: selected, diagnostics: { ...diagnostics, result_count: selected.length } }
  return JSON.stringify(compact)
}

function automaticCandidates(query, response) {
  const results = Array.isArray(response?.results) ? response.results : []
  return results.filter(result => (
    Number(result?.relevance_score) >= AUTO_RECALL_MINIMUM_SCORE
    && hasLexicalGrounding(query, result)
  ))
}

function cacheKey(workspace, query, explicit) {
  // Explicit `$wiki` is allowed to retrieve weak/synonym matches. It must never
  // populate an automatic caller's confidence-gated cache (or vice versa).
  return `${workspace}\u0000${explicit ? 'explicit' : 'automatic'}\u0000${query.trim().toLowerCase()}`
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

async function runNativeRecall(workspace, query, search, { explicit = false } = {}) {
  try {
    workspaceMetrics(workspace).abstractQueries += 1
    // Automatic recall is L0-only. Additional detail remains an explicit model
    // tool decision, rather than being preloaded into every opted-in turn.
    const raw = await search({ query, depth: 'abstract', top_k: 3 })
    if (isMiss(raw)) return undefined
    const response = parseSearchResponse(raw)
    if (!response) {
      // MCP returns JSON today. Do not inject an opaque response automatically.
      if (!explicit) {
        workspaceMetrics(workspace).confidenceSkipped += 1
        return undefined
      }
      const abstract = truncate(raw, ABSTRACT_LIMIT)
      return { abstract }
    }
    if (explicit && !Array.isArray(response.results)) {
      const abstract = truncate(raw, ABSTRACT_LIMIT)
      if (abstract.length < String(raw).trim().length) workspaceMetrics(workspace).budgetTruncations += 1
      return { abstract }
    }
    if (!explicit) {
      const scoreCandidates = (response.results || []).filter(result => Number(result?.relevance_score) >= AUTO_RECALL_MINIMUM_SCORE)
      if (scoreCandidates.length === 0) {
        workspaceMetrics(workspace).confidenceSkipped += 1
        return undefined
      }
      const grounded = automaticCandidates(query, response)
      if (grounded.length === 0) {
        workspaceMetrics(workspace).groundingSkipped += 1
        return undefined
      }
      response.results = grounded
    }
    const abstract = compactSearchResponse(response, ABSTRACT_LIMIT)
    if (abstract.length > ABSTRACT_LIMIT || !Array.isArray(response.results) || response.results.length === 0) {
      workspaceMetrics(workspace).budgetTruncations += 1
      return undefined
    }
    if (abstract.length < String(raw).trim().length) workspaceMetrics(workspace).budgetTruncations += 1
    return { abstract }
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
  const key = cacheKey(workspaceRoot, query, explicit)
  const cached = readCache(key)
  if (cached) {
    metric.cacheHits += 1
    return awaitWithSignal(Promise.resolve(cached), signal, workspaceRoot)
  }
  let task = inFlight.get(key)
  if (task) metric.inFlightHits += 1
  if (!task) {
    task = runNativeRecall(workspaceRoot, query, search, { explicit })
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
