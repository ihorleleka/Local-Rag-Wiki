import fs from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'

export const MCP_CONFIG_CANDIDATES = Object.freeze([
  path.join('.dsh', 'mcp.servers.yml'),
  path.join('dsh', 'mcp.servers.yml'),
])

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const SERVER_FIELDS = new Set([
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'reconnect',
])
const RECONNECT_FIELDS = new Set(['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a mapping`)
  return value
}

function assertKnownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${label}.${field} is not supported`)
  }
}

function assertPositiveNumber(value, label, integer = false) {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a positive ${integer ? 'integer' : 'number'}`)
  }
  return value
}

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function parseYaml(file) {
  const document = parseDocument(fs.readFileSync(file, 'utf8'), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new Error(document.errors.map(error => error.message).join('; '))
  }
  return document.toJS({ maxAliasCount: 0 })
}

function findConfig(workspace) {
  const matches = MCP_CONFIG_CANDIDATES
    .map(relative => ({ relative, file: path.join(workspace, relative) }))
    .filter(candidate => fs.existsSync(candidate.file))
  if (matches.length === 0) return undefined
  return {
    ...matches[0],
    ignoredLegacy: matches.length > 1 ? matches.slice(1).map(match => match.file) : [],
  }
}

function normalizeReconnect(value, label) {
  if (value === undefined) return { enabled: true, initialDelayMs: 5000, maxAttempts: 5 }
  const reconnect = assertRecord(value, label)
  assertKnownFields(reconnect, RECONNECT_FIELDS, label)
  const normalized = {}
  if (reconnect.enabled !== undefined) {
    if (typeof reconnect.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`)
    normalized.enabled = reconnect.enabled
  }
  if (reconnect.initialDelayMs !== undefined) normalized.initialDelayMs = assertPositiveNumber(reconnect.initialDelayMs, `${label}.initialDelayMs`)
  if (reconnect.maxDelayMs !== undefined) normalized.maxDelayMs = assertPositiveNumber(reconnect.maxDelayMs, `${label}.maxDelayMs`)
  if (reconnect.maxAttempts !== undefined) normalized.maxAttempts = assertPositiveNumber(reconnect.maxAttempts, `${label}.maxAttempts`, true)
  return normalized
}

function normalizeEnv(value, label) {
  if (value === undefined) return {}
  const env = assertRecord(value, label)
  const normalized = {}
  for (const [key, entry] of Object.entries(env)) {
    if (!key || typeof entry !== 'string') throw new Error(`${label}.${key || '<empty>'} must be a string`)
    normalized[key] = entry
  }
  return normalized
}

function normalizeWikiServer(workspace, serverName, value) {
  if (!SERVER_NAME_PATTERN.test(serverName)) throw new Error(`servers.${serverName} is not a valid MCP server name`)
  const label = `servers.${serverName}`
  const server = assertRecord(value, label)
  assertKnownFields(server, SERVER_FIELDS, label)
  if (server.transport !== 'stdio') throw new Error(`${label}.transport must be stdio for the managed wiki server`)
  if (server.command !== 'node' && server.command !== 'node.exe') {
    throw new Error(`${label}.command must be node (DSH Desktop process.execPath is Electron, not Node)`)
  }
  if (!Array.isArray(server.args) || server.args.length !== 1 || typeof server.args[0] !== 'string' || !server.args[0]) {
    throw new Error(`${label}.args must contain exactly one managed runner path`)
  }

  const workspaceReal = fs.realpathSync(workspace)
  const runner = path.resolve(workspace, server.args[0])
  if (!inside(workspace, runner) || !fs.existsSync(runner)) {
    throw new Error(`${label}.args[0] must resolve to an existing runner inside the workspace`)
  }
  const runnerReal = fs.realpathSync(runner)
  if (!inside(workspaceReal, runnerReal) || path.basename(runnerReal) !== 'run-wiki-manager.mcp.js') {
    throw new Error(`${label}.args[0] must reference the managed run-wiki-manager.mcp.js`)
  }
  const marker = path.join(path.dirname(runnerReal), '.wiki-kit-install.json')
  if (!fs.existsSync(marker)) throw new Error(`${label}.args[0] is not beside a wiki-kit install marker`)

  if (server.cwd !== undefined && path.resolve(workspace, server.cwd) !== workspace) {
    throw new Error(`${label}.cwd must resolve to the workspace root`)
  }
  if (server.failOnStartupError !== undefined && typeof server.failOnStartupError !== 'boolean') {
    throw new Error(`${label}.failOnStartupError must be a boolean`)
  }

  return {
    serverName,
    transport: 'stdio',
    command: server.command,
    args: [runnerReal],
    env: normalizeEnv(server.env, `${label}.env`),
    cwd: workspaceReal,
    toolCallTimeoutMs: server.toolCallTimeoutMs === undefined
      ? 120000
      : assertPositiveNumber(server.toolCallTimeoutMs, `${label}.toolCallTimeoutMs`),
    failOnStartupError: server.failOnStartupError ?? true,
    reconnect: normalizeReconnect(server.reconnect, `${label}.reconnect`),
  }
}

/** Read and validate the managed wiki MCP entry for one active DSH workspace. */
export function loadWorkspaceWikiMcp(workspaceInput) {
  if (typeof workspaceInput !== 'string' || workspaceInput.trim() === '') return undefined
  const workspace = path.resolve(workspaceInput)
  let stat
  try { stat = fs.statSync(workspace) } catch { return undefined }
  if (!stat.isDirectory()) return undefined
  const found = findConfig(workspace)
  if (!found) return undefined
  const root = assertRecord(parseYaml(found.file), found.relative)
  const servers = assertRecord(root.servers, `${found.relative}.servers`)
  if (!Object.hasOwn(servers, 'wiki-manager')) return {
    configPath: found.file,
    ignoredLegacy: found.ignoredLegacy,
    server: undefined,
  }
  return {
    configPath: found.file,
    ignoredLegacy: found.ignoredLegacy,
    server: normalizeWikiServer(workspace, 'wiki-manager', servers['wiki-manager']),
  }
}
