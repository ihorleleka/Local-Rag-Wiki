#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import * as mcpClient from '../templates/root/.dsh/.dsh-mcp-client.js'
import { loadWorkspaceWikiMcp } from '../packages/dsh-local-rag-wiki/workspace-mcp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(process.argv[2] || path.join(here, '..'))
const discovered = loadWorkspaceWikiMcp(workspace)
if (!discovered?.server) throw new Error(`No managed wiki-manager entry found for ${workspace}`)

const ctx = new Context()
await ctx.plugin(systemPromptPlugin).await()
await ctx.plugin(toolsPlugin, { mode: 'native' }).await()
const tools = ctx.get('tools')
const agent = { id: `workspace-mcp-verification:${workspace}`, session: { id: 'workspace-mcp-verification' } }
const scope = createScope(ctx, agent)
const startedAt = Date.now()

function summary(result) {
  return {
    isError: result.isError,
    content: result.content.map(block => block.type === 'text'
      ? { type: 'text', text: block.text.slice(0, 3000) }
      : block),
  }
}

try {
  const handle = scope.ctx.plugin(mcpClient, discovered.server)
  await handle.await()
  const schemas = tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__wiki-manager__'))
  const names = schemas.map(tool => tool.name)
  if (names.length === 0) throw new Error('MCP connected but registered no wiki-manager tools')

  const treeName = 'mcp__wiki-manager__wiki_tree'
  const searchName = 'mcp__wiki-manager__wiki_search'
  for (const required of [treeName, searchName]) {
    if (!names.includes(required)) throw new Error(`required workspace MCP tool is missing: ${required}`)
  }

  const tree = await tools.execute({
    callId: 'workspace-mcp-tree',
    name: treeName,
    arguments: {},
    signal: new AbortController().signal,
    agent,
  })
  const search = await tools.execute({
    callId: 'workspace-mcp-search',
    name: searchName,
    arguments: {
      query: 'Elizabeth project architecture components and purpose',
      depth: 'abstract',
    },
    signal: new AbortController().signal,
    agent,
  })
  for (const [label, result] of [['wiki_tree', tree], ['wiki_search', search]]) {
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (result.isError || !text.trim()) throw new Error(`${label} did not return successful text content`)
  }
  const calls = [
    { name: treeName, result: summary(tree) },
    { name: searchName, result: summary(search) },
  ]

  console.log(JSON.stringify({
    workspace,
    configPath: discovered.configPath,
    startupMs: Date.now() - startedAt,
    tools: names,
    calls,
  }, null, 2))
} finally {
  await scope.dispose()
}
