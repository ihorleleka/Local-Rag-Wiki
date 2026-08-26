# local-rag-wiki

A repo-local RAG wiki for AI agents: a per-repository MCP knowledge service
(governed search / read / write of Markdown wiki notes) plus an installer that
wires it into your agent tooling. Docker is required to run the service.

## Quick start (recommended)

Pre-pull the service image before your first agent session to avoid cold-start
delays:

```bash
docker pull ihorleleka/project-rag-wiki:latest
```

## Install

Run in your repository root:

```bash
npx github:ihorleleka/Local-Rag-Wiki install .
```

This scaffolds the managed `.agents/` runner, the `AGENTS.md` policy section,
MCP config for DeepSeek Harness (`.dsh/mcp.servers.yml`), Claude Code, Codex,
VS Code, and OpenCode, plus a `wiki/` folder. These integrations are additive:
installing DSH support does not remove or replace the other harness configs.
The MCP service then starts automatically per repository when your agent client
connects. Pre-pulling the image (above) is recommended before running the agent
in a fresh environment.

## DeepSeek Harness

Install the native DSH bundle once into the profile you use (usually `web`):

```bash
dsh plugin --profile web add github:ihorleleka/Local-Rag-Wiki
```

Restart that DSH profile, open an installed repository as its workspace, and
start a session. The bundle uses DSH's official `@deepseek-ai/dsh-mcp-client`
to find the wiki-kit installation marker (including a custom `--agents-dir`),
launch the managed MCP runner, reconnect it, discover its tools, and register
them as native `mcp__wiki-manager__*` tools. The runner starts or attaches to
the repository's Docker service exactly as it does for the other harnesses.

It also mounts a marker-gated Cordis recall coordinator for that workspace:
`agent/session-start` seeds recurring-topic hints; `agent/pre-step` uses local
state, then performs bounded wiki retrieval only for a material prompt—first
`wiki_search depth="abstract"` (L0), then matching `depth="packet"` context
(L1). It labels the evidence and leaves full L2 `wiki_read` decisions to the
model. `session/event` records an assistant summary, while `agent/turn-stopping`
and `session/flush` trim and persist state. Recall is per-workspace cached and
in-flight deduplicated; L1 packets are rate-limited, cold starts have a bounded
90-second allowance, and state updates are queued with atomic replacement. No
state or wiki process is used outside a repository with a wiki-kit install marker.

The generated `.dsh/mcp.servers.yml` remains a workspace-config alternative;
do not activate both bridges with the same `wiki-manager` namespace or DSH will
rightly reject the duplicate tool registration. `AGENTS.md` remains the
portable policy layer.

The `.agents/hooks/` and `.claude/settings.local.json` hooks are Claude
Code-specific. DSH lifecycle interception belongs in trusted Host/Profile
Cordis plugins, not a project-local hook manifest. See
[`.dsh/README.md`](./templates/root/.dsh/README.md) for the workspace-config
boundary.

## Update

After install, refresh the managed files from inside the repo — no npx needed:

```bash
.agents\update-wiki-kit.cmd --force
```

```bash
sh .agents/update-wiki-kit.sh --force
```

## Lifecycle

```bash
npx github:ihorleleka/Local-Rag-Wiki status .
npx github:ihorleleka/Local-Rag-Wiki restart .
npx github:ihorleleka/Local-Rag-Wiki doctor . --live
```

`start .`, `stop .`, and `pull .` are available the same way. The repository
container persists independently of individual agent clients.

## How it works

- This package is the installer: it scaffolds and maintains the `.agents/`
  runner and MCP configuration in a consumer repository.
- [kb-service/](./kb-service) is the Dockerized MCP knowledge service the runner
  launches per repository. It serves `wiki_search`, `wiki_read`, `wiki_list`,
  `wiki_tree`, `wiki_schema_report`, `wiki_write`, `wiki_capture`, `wiki_delete`,
  and `wiki_rename` over `POST /mcp/` (loopback by default), with hash-protected
  writes. `wiki_search` supports tiered retrieval (`depth=abstract|packet`) plus
  `path_prefix` directory scoping.

## Versioning

The installer and kb-service ride the same Git tag (`X.Y.Z` or `vX.Y.Z`).
Release automation:

- [tag-version-verify.yml](./.github/workflows/tag-version-verify.yml)
- [docker-release.yml](./.github/workflows/docker-release.yml)

## License

MIT (see [kb-service/LICENSE](./kb-service/LICENSE)).
