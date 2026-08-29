#!/usr/bin/env node

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const SCRATCH = path.join(ROOT, '.artifacts', 'verify-dsh-mcp')
const LOADER = path.join(ROOT, 'packages', 'dsh-local-rag-wiki', 'workspace-mcp.mjs')
const CLIENT = path.join(ROOT, 'templates', 'root', '.dsh', '.dsh-mcp-client.js')

function reset() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH, { recursive: true })
}

function installRunner(workspace, agentsDir = '.agents') {
  const root = path.join(workspace, agentsDir)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, '.wiki-kit-install.json'), '{}\n')
  fs.writeFileSync(path.join(root, 'run-wiki-manager.mcp.js'), '// test runner\n')
  return `${agentsDir}/run-wiki-manager.mcp.js`
}

function writeConfig(workspace, relative, content) {
  const file = path.join(workspace, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}

function yaml(runner, additions = '') {
  return `servers:\n  wiki-manager:\n    transport: stdio\n    command: node\n    args: ["${runner}"]\n${additions}`
}

function expectError(operation, pattern) {
  assert.throws(operation, pattern)
}

async function assertScopedBridge() {
  const [{ Context }, { default: toolsPlugin }, { default: systemPromptPlugin }, { createScope }, mcpClient] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-scope'),
    import(pathToFileURL(CLIENT).href),
  ])
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin).await()
  await ctx.plugin(toolsPlugin, { mode: 'native' }).await()
  const tools = ctx.get('tools')
  assert(tools, 'DSH tools service did not activate')

  const agentA = { id: 'agent-a' }
  const agentB = { id: 'agent-b' }
  const scopeA = createScope(ctx, agentA)
  const scopeB = createScope(ctx, agentB)
  const config = {
    serverName: 'wiki-manager',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(ROOT, 'scripts', 'fixtures', 'fake-mcp-server.mjs')],
    cwd: ROOT,
    failOnStartupError: true,
  }

  try {
    const handleA = scopeA.ctx.plugin(mcpClient, config)
    const handleB = scopeB.ctx.plugin(mcpClient, config)
    await Promise.all([handleA.await(), handleB.await()])
    const publicName = 'mcp__wiki-manager__wiki_ping'
    assert.deepEqual(tools.schemas(agentA).map(tool => tool.name), [publicName])
    assert.deepEqual(tools.schemas(agentB).map(tool => tool.name), [publicName])
    const result = await tools.execute({
      callId: 'verify-dsh-mcp-1',
      name: publicName,
      arguments: { message: 'ok' },
      signal: new AbortController().signal,
      agent: agentA,
    })
    assert.equal(result.isError, false)
    assert.deepEqual(result.content, [{ type: 'text', text: 'pong:ok' }])

    await scopeA.dispose()
    assert.deepEqual(tools.schemas(agentA).map(tool => tool.name), [])
    assert.deepEqual(tools.schemas(agentB).map(tool => tool.name), [publicName])
  } finally {
    await scopeA.dispose()
    await scopeB.dispose()
  }
  assert.deepEqual(tools.schemas(agentB).map(tool => tool.name), [])
}

async function assertLifecycleIntegration() {
  const [{ Context }, { default: toolsPlugin }, { default: systemPromptPlugin }, { createScope }, { Session }, { createUserMessage }, lifecycle] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-session'),
    import('@deepseek-ai/dsh-llm'),
    import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-local-rag-wiki', 'index.mjs')).href),
  ])
  const workspace = path.join(SCRATCH, 'lifecycle-integration')
  const agentsRoot = path.join(workspace, '.agents')
  fs.mkdirSync(agentsRoot, { recursive: true })
  fs.mkdirSync(path.join(workspace, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(agentsRoot, '.wiki-kit-install.json'), '{}\n')
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'fixtures', 'fake-managed-wiki-runner.cjs'),
    path.join(agentsRoot, 'run-wiki-manager.mcp.js'),
  )
  writeConfig(workspace, '.dsh/mcp.servers.yml', yaml('.agents/run-wiki-manager.mcp.js'))

  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin).await()
  await ctx.plugin(toolsPlugin, { mode: 'native' }).await()
  await ctx.plugin(lifecycle).await()
  const tools = ctx.get('tools')
  const session = Session.create('lifecycle-agent', undefined, {
    version: 0,
    id: 'lifecycle-agent',
    createdAt: Date.now(),
    cwd: workspace,
  })
  const agent = { id: 'lifecycle-agent', session }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx

  try {
    await ctx.parallel('agent/created', { agent })
    assert.deepEqual(tools.schemas(agent).map(tool => tool.name), ['mcp__wiki-manager__wiki_search'])
    const prompt = 'Explain the project architecture and component rendering behavior in detail'
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'tool output must not become the recall query' }], source: { kind: 'tool', callId: 'prior-tool' } }),
    ]
    const decision = await ctx.waterfall(
      'agent/pre-step',
      { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages }),
    )
    assert.equal(decision.messages.length, 3)
    assert.match(decision.messages[2].content[0].text, /Lifecycle MCP verification result/)
    assert.match(decision.messages[2].content[0].text, new RegExp(prompt))
    assert.doesNotMatch(decision.messages[2].content[0].text, /tool output must not become the recall query/)

    const repeated = await ctx.waterfall(
      'agent/pre-step',
      { agent, messages: [messages[0]], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [messages[0]] }),
    )
    assert.equal(repeated.messages.length, 1, 'one turn must not run or inject recall twice')

    const toolStep = [createUserMessage({
      content: [{ type: 'text', text: 'A long compiler or file-read tool result with many searchable keywords' }],
      source: { kind: 'tool', callId: 'tool-step' },
    })]
    const continuation = await ctx.waterfall(
      'agent/pre-step',
      { agent, messages: toolStep, turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: toolStep }),
    )
    assert.equal(continuation.messages.length, 1, 'tool-loop steps must not trigger recall')

    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    assert.match(session.deriveMessages().at(-1).content[0].text, /Lifecycle MCP verification result/)
    await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    const visibleRecall = session.deriveMessages().filter(message => message.source?.plugin === 'local-rag-wiki-lifecycle')
    assert.equal(visibleRecall.length, 1, 'recall projection must occupy one visible surface slot')
    assert.match(visibleRecall[0].content[0].text, /state="expired"/)
    assert.doesNotMatch(visibleRecall[0].content[0].text, /Lifecycle MCP verification result/)

    const nextPrompt = createUserMessage({
      content: [{ type: 'text', text: 'Review the deployment architecture and service boundaries' }],
      source: { kind: 'user' },
    })
    const nextTurn = await ctx.waterfall(
      'agent/pre-step',
      { agent, messages: [nextPrompt], turn: 2, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [nextPrompt] }),
    )
    assert.equal(nextTurn.messages.length, 2, 'a new direct-user turn may retrieve once')
    assert.match(nextTurn.messages[1].content[0].text, /Lifecycle MCP verification result/)
  } finally {
    await scope.dispose()
  }
  assert.deepEqual(tools.schemas(agent).map(tool => tool.name), [])
}

async function main() {
  reset()
  const { loadWorkspaceWikiMcp } = await import(pathToFileURL(LOADER).href)

  const missing = path.join(SCRATCH, 'missing')
  fs.mkdirSync(missing)
  assert.equal(loadWorkspaceWikiMcp(missing), undefined)

  const canonical = path.join(SCRATCH, 'canonical')
  fs.mkdirSync(canonical)
  const canonicalRunner = installRunner(canonical)
  const canonicalFile = writeConfig(canonical, '.dsh/mcp.servers.yml', yaml(canonicalRunner, '    toolCallTimeoutMs: 90000\n'))
  const canonicalResult = loadWorkspaceWikiMcp(canonical)
  assert.equal(canonicalResult.configPath, canonicalFile)
  assert.equal(canonicalResult.server.serverName, 'wiki-manager')
  assert.equal(canonicalResult.server.command, 'node')
  assert.equal(canonicalResult.server.toolCallTimeoutMs, 90000)
  assert.equal(canonicalResult.server.failOnStartupError, true)
  assert.equal(canonicalResult.server.reconnect.initialDelayMs, 5000)
  assert.equal(path.basename(canonicalResult.server.args[0]), 'run-wiki-manager.mcp.js')

  const custom = path.join(SCRATCH, 'custom')
  fs.mkdirSync(custom)
  const customRunner = installRunner(custom, 'wiki-kit-agent')
  writeConfig(custom, '.dsh/mcp.servers.yml', yaml(customRunner, '    env:\n      KB_IMAGE: test-image\n'))
  assert.equal(loadWorkspaceWikiMcp(custom).server.env.KB_IMAGE, 'test-image')

  const legacy = path.join(SCRATCH, 'legacy')
  fs.mkdirSync(legacy)
  const legacyRunner = installRunner(legacy)
  const legacyFile = writeConfig(legacy, 'dsh/mcp.servers.yml', yaml(legacyRunner))
  assert.equal(loadWorkspaceWikiMcp(legacy).configPath, legacyFile)

  const precedence = path.join(SCRATCH, 'precedence')
  fs.mkdirSync(precedence)
  const precedenceRunner = installRunner(precedence)
  const preferredFile = writeConfig(precedence, '.dsh/mcp.servers.yml', yaml(precedenceRunner))
  const ignoredFile = writeConfig(precedence, 'dsh/mcp.servers.yml', yaml(precedenceRunner))
  const precedenceResult = loadWorkspaceWikiMcp(precedence)
  assert.equal(precedenceResult.configPath, preferredFile)
  assert.deepEqual(precedenceResult.ignoredLegacy, [ignoredFile])

  const unrelated = path.join(SCRATCH, 'unrelated')
  fs.mkdirSync(unrelated)
  writeConfig(unrelated, '.dsh/mcp.servers.yml', 'servers:\n  other:\n    transport: stdio\n    command: other\n')
  assert.equal(loadWorkspaceWikiMcp(unrelated).server, undefined)

  const duplicate = path.join(SCRATCH, 'duplicate')
  fs.mkdirSync(duplicate)
  const duplicateRunner = installRunner(duplicate)
  writeConfig(duplicate, '.dsh/mcp.servers.yml', `${yaml(duplicateRunner)}  wiki-manager:\n    transport: stdio\n    command: node\n    args: ["${duplicateRunner}"]\n`)
  expectError(() => loadWorkspaceWikiMcp(duplicate), /Map keys must be unique|unique/i)

  const electron = path.join(SCRATCH, 'electron')
  fs.mkdirSync(electron)
  const electronRunner = installRunner(electron)
  writeConfig(electron, '.dsh/mcp.servers.yml', yaml(electronRunner).replace('command: node', 'command: DSH Desktop.exe'))
  expectError(() => loadWorkspaceWikiMcp(electron), /must be node/)

  const traversal = path.join(SCRATCH, 'traversal')
  fs.mkdirSync(traversal)
  installRunner(traversal)
  writeConfig(traversal, '.dsh/mcp.servers.yml', yaml('../run-wiki-manager.mcp.js'))
  expectError(() => loadWorkspaceWikiMcp(traversal), /inside the workspace/)

  const clientSource = fs.readFileSync(CLIENT, 'utf8')
  assert.match(clientSource, /Workspace-delivered fork of @deepseek-ai\/dsh-mcp-client/)
  assert.doesNotMatch(clientSource, /activeServerNames|serverName namespace reservation/)
  assert.doesNotMatch(clientSource, /Promise\.withResolvers/)
  assert.match(clientSource, /ctx\.tools\.register\(definition\)/)
  assert.match(clientSource, /return \(\) => connection\.dispose\(\)/)

  await assertScopedBridge()
  await assertLifecycleIntegration()
  console.log('verify-dsh-mcp: ok')
}

main().catch(error => {
  console.error(`verify-dsh-mcp: ${error.stack || error.message}`)
  process.exit(1)
})
