# DeepSeek Harness integration

Local-Rag-Wiki supports two complementary DSH installation modes:

1. **Repository install** — run `npx github:ihorleleka/Local-Rag-Wiki install .`
   in a repository. It creates this workspace-local `mcp.servers.yml`, which
   points DSH at the managed `wiki-manager` MCP runner.
2. **Profile bundle (recommended)** — install the native bundle once for the
   DSH profile you use:

   ```bash
   dsh plugin --profile web add github:ihorleleka/Local-Rag-Wiki
   ```

   The profile bundle listens for `agent/created`. For each agent whose actual
   workspace contains a Local-Rag-Wiki install marker, it mounts DSH's official
   `@deepseek-ai/dsh-mcp-client` in that agent scope, using the workspace's
   managed runner. This supports custom `--agents-dir` names, reconnects after
   transport loss, discovers MCP tools, and exposes predictable
   `mcp__wiki-manager__*` tools. The client remains agent-scoped even though
   its namespace is stable. It also applies repository-local recall: local
   state first, then bounded `wiki_search` L0 abstract scans and L1 packet
   retrieval for material prompts. Full L2 `wiki_read` remains model-directed.

The profile bundle is global to its DSH profile, but it does not start a wiki
container or register wiki tools until an agent opens an installed repository.
Restart the selected profile after adding or removing the bundle.

The workspace config remains a no-profile-install alternative. Prefer the
profile bundle rather than enabling both bridges, which would create duplicate
MCP connections to the same repository service.

The Claude Code hook files under `.agents/hooks/` and
`.claude/settings.local.json` are intentionally retained for Claude Code. DSH
uses its native MCP bridge here; no Claude hook is copied or executed by DSH.
