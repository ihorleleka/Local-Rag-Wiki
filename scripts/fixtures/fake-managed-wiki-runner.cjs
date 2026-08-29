#!/usr/bin/env node

;(async () => {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')

  const server = new Server(
    { name: 'wiki-kit-lifecycle-verification', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'wiki_search',
      description: 'Return deterministic wiki retrieval data.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          depth: { type: 'string', enum: ['abstract', 'packet'] },
          top_k: { type: 'integer' },
        },
        required: ['query', 'depth'],
        additionalProperties: false,
      },
    }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        result_count: 1,
        depth: request.params.arguments?.depth,
        query: request.params.arguments?.query,
        source: 'architecture.md',
        abstract: 'Lifecycle MCP verification result.',
      }),
    }],
  }))
  await server.connect(new StdioServerTransport())
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
