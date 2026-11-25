# Wiki Service Recovery

Load this when `wiki-manager` is configured (`.mcp.json`, `.codex/config.toml`,
`opencode.jsonc`, `.vscode/mcp.json`, or `.dsh/mcp.servers.yml`) but the `wiki_*`
tools are missing or their calls fail.

Tell the user the wiki service is not connected and that your answer rests on
unindexed local files; do not switch to local files silently. A "warming up"
error means the container is still starting: retry shortly.

## Recover

- Start or check the service: `npx github:ihorleleka/Local-Rag-Wiki start .`
  (also `restart .`, `stop .`, `status .`, `doctor . --live`).
- Without npx, from the repository root (`.agents/` is the default install
  directory): `KB_LIFECYCLE_COMMAND=start node .agents/run-wiki-manager.mcp.js`
  (PowerShell: `$env:KB_LIFECYCLE_COMMAND='start'; node .agents/run-wiki-manager.mcp.js`).
  Use `restart` or `stop` the same way; `KB_ATTACH_ONLY=1` runs a health check
  that never starts or replaces the container.
- Tools missing at session start stay missing: after the service is up, the
  user must open a new session (or run `/mcp` and reconnect in Claude Code).
- Claude Code needs `MCP_TIMEOUT=150000` for a cold start; the installer sets it
  in `.claude/settings.json`.

## Meanwhile

Read `wiki/` files directly, validate notes with
`npx github:ihorleleka/Local-Rag-Wiki schema-report .`, and search with
`npx github:ihorleleka/Local-Rag-Wiki search . "<query>"` (`--json` for raw output).
