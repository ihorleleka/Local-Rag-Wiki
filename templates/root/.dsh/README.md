# DeepSeek Harness integration

Local-Rag-Wiki installs its DSH workspace assets in this `.dsh/` directory:

- `mcp.servers.yml` declares the managed `wiki-manager` stdio server.
- `.dsh-mcp-client.js` is the agent-scoped MCP bridge used by the native profile
  bundle. It discovers server tools and registers stable
  `mcp__wiki-manager__*` tools on the active agent's DSH tool scope.
- `package.json` marks the local bridge as an ES module. The bridge must remain
  under `.dsh/`; no `.dsh-mcp-client.js` belongs at repository root.

Install the trusted DSH profile bundle once for the profile you use:

```bash
dsh plugin --profile web add github:ihorleleka/Local-Rag-Wiki
```

After restarting that profile, the bundle listens to DSH's native agent
lifecycle. For each active agent it reads that agent's workspace
`.dsh/mcp.servers.yml`, validates that `wiki-manager` points to the managed
runner beside a wiki-kit install marker, resolves the configured `node`
executable through DSH's subprocess service, and mounts the bridge through
`agent.ctx`. Initial discovery is awaited before the model request is assembled,
so the model receives the workspace MCP tool schemas on its first step.

The compatibility path `dsh/mcp.servers.yml` is also recognized when `.dsh/`
is absent; `.dsh/` always wins when both exist.

DSH core does not currently auto-load `mcp.servers.yml`. The profile bundle is
the trusted loader for these workspace assets. Do not add a second global
`@deepseek-ai/dsh-mcp-client` row for the same `wiki-manager` server; that would
start a duplicate connection.

Automatic L0/L1 recall calls the already-registered `wiki_search` tool through
DSH's tool registry; it never launches a second runner or captures local prompt
history. Recall runs at most once per turn and only from a direct user message;
tool outputs and later model steps cannot trigger it. The injected retrieval is
turn-scoped and replaced by an expiry marker when the turn stops, preventing
retrieved payloads from accumulating or applying to later turns. DSH lifecycle
and tool registration stay in Cordis plugins and the official DSH tool registry.
