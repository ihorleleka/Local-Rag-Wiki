import { spawn } from 'node:child_process'
import path from 'node:path'
import { findAgentsRoot } from './state.mjs'

const RUNNER_FILE = 'run-wiki-manager.mcp.js'
const COLD_START_TIMEOUT_MS = 90000
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
    metrics.set(workspace, { requests: 0, cacheHits: 0, inFlightHits: 0, abstractQueries: 0, packetQueries: 0, packetRateLimited: 0, timeouts: 0, aborts: 0, failures: 0 })
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

function textResult(response) {
  return (response?.result?.content || []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
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

function runMcpRecall(workspace, runner, query) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [runner], { cwd: workspace, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buffer = ''
    let stage = 'initialize'
    let abstractResult = ''
    let settled = false
    const finish = (value, reason) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (reason === 'timeout') workspaceMetrics(workspace).timeouts += 1
      if (reason) warn(workspace, reason)
      try { child.stdin.end() } catch {}
      try { child.kill() } catch {}
      resolve(value)
    }
    const timeout = setTimeout(() => finish(undefined, 'timeout waiting for the repository MCP runner'), COLD_START_TIMEOUT_MS)
    const send = message => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch { finish(undefined, 'MCP stdin closed unexpectedly') }
    }

    child.on('error', error => finish(undefined, `runner process error: ${error.message}`))
    child.on('exit', code => { if (!settled) finish(undefined, `runner exited before recall completed (${code ?? 'unknown'})`) })
    child.stderr.on('data', () => {})
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n')
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let response
        try { response = JSON.parse(line) } catch { continue }
        if (response.id === 1) {
          if (!response.result?.serverInfo) return finish(undefined, 'invalid initialize response')
          stage = 'abstract'
          workspaceMetrics(workspace).abstractQueries += 1
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wiki_search', arguments: { query, depth: 'abstract', top_k: 5 } } })
        } else if (response.id === 2 && stage === 'abstract') {
          const abstract = textResult(response)
          if (response.error || isMiss(abstract)) return finish(undefined)
          abstractResult = truncate(abstract, ABSTRACT_LIMIT)
          if (!canRetrievePacket(workspace)) return finish({ abstract: abstractResult, packetRateLimited: true })
          stage = 'packet'
          workspaceMetrics(workspace).packetQueries += 1
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wiki_search', arguments: { query, depth: 'packet', top_k: 3 } } })
        } else if (response.id === 3 && stage === 'packet') {
          const packet = textResult(response)
          if (response.error || isMiss(packet)) return finish({ abstract: abstractResult })
          finish({ abstract: abstractResult, packet: truncate(packet, PACKET_LIMIT) })
        }
      }
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'local-rag-wiki-dsh-recall', version: '1.0.0' } } })
  })
}

/**
 * Per-workspace deduplicated, bounded L0/L1 retrieval. A cancelling caller
 * stops waiting but does not tear down a shared in-flight repository query.
 */
export function retrieveWikiTiers(workspace, query, signal) {
  const workspaceRoot = path.resolve(workspace)
  const agentsRoot = findAgentsRoot(workspaceRoot)
  if (!agentsRoot) return Promise.resolve(undefined)
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
    task = runMcpRecall(workspaceRoot, path.join(agentsRoot, RUNNER_FILE), query)
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
