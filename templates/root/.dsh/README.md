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

   The bundle mounts DSH's official `@deepseek-ai/dsh-mcp-client`. It starts
   the repository runner through a marker-aware launcher, supports custom
   `--agents-dir` names, reconnects after transport loss, discovers MCP tools,
   and exposes them as native `mcp__wiki-manager__*` tools. Its native Cordis
   coordinator applies repository-local recall: local state first, then a
   bounded `wiki_search` L0 abstract scan and L1 packet retrieval for material
   prompts. It labels retrieved evidence and leaves full L2 `wiki_read` choices
   to the model. Per-workspace caching and in-flight deduplication avoid repeated
   searches; L1 packets are rate-limited and state writes are queued atomically.

The profile bundle is global to its DSH profile but activates the runner using
DSH's current workspace. It invokes this repository's
`.dsh/run-wiki-manager.cjs` launcher, so run the wiki-kit update command after
upgrading to ensure that file is present. It only works in repositories that
have first received the Local-Rag-Wiki repository install. Restart the selected
profile after adding or removing the bundle.

Do not activate both the workspace config and the profile bundle with the same
`wiki-manager` namespace: both bridge the same server and DSH will reject the
duplicate tool registrations. Prefer the profile bundle for managed lifecycle;
keep the workspace config as the no-profile-install alternative.

The Claude Code hook files under `.agents/hooks/` and
`.claude/settings.local.json` are intentionally retained for Claude Code. DSH
uses its native MCP bridge here; no Claude hook is copied or executed by DSH.
