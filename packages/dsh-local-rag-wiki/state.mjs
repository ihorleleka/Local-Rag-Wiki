import fs from 'node:fs'
import path from 'node:path'

const MARKER_FILE = '.wiki-kit-install.json'
const STATE_FILE = 'self-evolving.json'
const STATE_DIR = '.wiki-kit-state'
const MAX_RECENT = 200
const writeQueues = new Map()
const STOPWORDS = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'between', 'could', 'doing', 'from', 'have', 'into', 'just', 'like', 'make', 'more', 'need', 'should', 'than', 'that', 'then', 'there', 'these', 'this', 'those', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your'])

function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim() }

export function findAgentsRoot(workspace) {
  if (!workspace || typeof workspace !== 'string') return undefined
  try {
    for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(workspace, entry.name)
      if (fs.existsSync(path.join(candidate, MARKER_FILE))) return candidate
    }
  } catch {}
  return undefined
}

function statePath(workspace) {
  const agentsRoot = findAgentsRoot(workspace)
  return agentsRoot && path.join(agentsRoot, STATE_DIR, STATE_FILE)
}

function readStateFile(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { recent: Array.isArray(state.recent) ? state.recent : [], keywordTotals: state.keywordTotals && typeof state.keywordTotals === 'object' ? state.keywordTotals : {} }
  } catch { return { recent: [], keywordTotals: {} } }
}

function writeStateFile(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(trimState(state), null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

export function readState(workspace) {
  const file = statePath(workspace)
  return file ? readStateFile(file) : { recent: [], keywordTotals: {} }
}

export function trimState(state) {
  return { recent: (Array.isArray(state?.recent) ? state.recent : []).slice(0, MAX_RECENT), keywordTotals: state?.keywordTotals && typeof state.keywordTotals === 'object' ? state.keywordTotals : {} }
}

export function writeState(workspace, state) {
  const file = statePath(workspace)
  if (!file) return false
  writeStateFile(file, state)
  return true
}

/** Serialize read-modify-write updates per installed repository and atomically replace the state file. */
export function updateState(workspace, mutate) {
  const file = statePath(workspace)
  if (!file) return Promise.resolve(undefined)
  const previous = writeQueues.get(file) || Promise.resolve()
  const task = previous.catch(() => {}).then(() => {
    const next = mutate(readStateFile(file))
    writeStateFile(file, next)
    return next
  })
  writeQueues.set(file, task)
  return task.finally(() => {
    if (writeQueues.get(file) === task) writeQueues.delete(file)
  })
}

export function keywords(value) {
  const seen = new Set()
  return (normalize(value).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || []).filter(word => !STOPWORDS.has(word) && !seen.has(word) && seen.add(word)).slice(0, 12)
}

export function capturePrompt(state, prompt, captureId) {
  const text = normalize(prompt)
  const next = trimState(state)
  if (!text) return next
  const extracted = keywords(text)
  for (const word of extracted) next.keywordTotals[word] = Number(next.keywordTotals[word] || 0) + 1
  next.recent.unshift({ captureId, capturedAt: new Date().toISOString(), prompt: text.slice(0, 260), summary: '', keywords: extracted })
  next.recent = next.recent.slice(0, MAX_RECENT)
  return next
}

export function captureAssistantSummary(state, captureId, summary) {
  const text = normalize(summary)
  const next = trimState(state)
  const target = next.recent.find(item => item.captureId === captureId)
  if (text && target && !target.summary) target.summary = text.slice(0, 260)
  return next
}

export function relevantRecent(state, prompt, limit = 3) {
  const query = new Set(keywords(prompt))
  if (query.size === 0) return []
  return (Array.isArray(state.recent) ? state.recent : []).map(item => ({ item, score: (item.keywords || []).filter(word => query.has(word)).length })).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score).slice(0, limit).map(({ item }) => item)
}

export function topHints(state, limit = 6) {
  return Object.entries(state.keywordTotals || {}).sort((left, right) => Number(right[1]) - Number(left[1])).slice(0, limit).map(([word]) => word)
}

export function textFrom(message) {
  return (Array.isArray(message?.content) ? message.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}
