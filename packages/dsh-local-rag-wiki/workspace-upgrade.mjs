import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
// This is the wiki-kit package containing the DSH profile plugin. It is
// deliberately unrelated to the installed DSH runtime version.
const { version: pluginVersion } = require('../../package.json')
const MARKER_FILE = '.wiki-kit-install.json'
const WINDOWS_UPGRADE = 'update-wiki-kit.cmd'
const POSIX_UPGRADE = 'update-wiki-kit.sh'

function parseVersion(input) {
  const match = typeof input === 'string'
    && input.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return undefined
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** Returns positive when left is a newer valid semantic version than right. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return undefined
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1
    if (aPart === bPart) continue
    const aNumeric = /^\d+$/.test(aPart)
    const bNumeric = /^\d+$/.test(bPart)
    if (aNumeric && bNumeric) return Number(aPart) > Number(bPart) ? 1 : -1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return aPart > bPart ? 1 : -1
  }
  return 0
}

export function readWorkspaceVersion(agentsRoot) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(agentsRoot, MARKER_FILE), 'utf8'))
    return typeof marker.version === 'string' ? marker.version.trim() : undefined
  } catch {
    return undefined
  }
}

export function upgradeCommand(agentsRoot, platform = process.platform) {
  if (platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', path.join(agentsRoot, WINDOWS_UPGRADE)] }
  }
  return { command: 'sh', args: [path.join(agentsRoot, POSIX_UPGRADE)] }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`wiki-kit upgrade exited with ${code ?? 'an unknown'} status`)))
  })
}

/**
 * Upgrade a workspace only when this profile plugin's wiki-kit package is newer
 * than its managed wiki-kit marker. The marker is rewritten by the wrapper, making the
 * operation naturally one-time for a given installed package version.
 */
export async function upgradeWorkspaceIfNeeded(agentsRoot, options = {}) {
  const plugin = options.pluginVersion || pluginVersion
  const workspace = readWorkspaceVersion(agentsRoot)
  if (compareVersions(plugin, workspace) !== 1) return { upgraded: false, plugin, workspace }

  const script = upgradeCommand(agentsRoot, options.platform)
  const execute = options.execute || run
  await execute(script.command, script.args, path.dirname(agentsRoot))
  return { upgraded: true, plugin, workspace }
}
