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
DSH workspace assets (`.dsh/mcp.servers.yml` and its scoped MCP bridge), Claude
Code, Codex, VS Code, and OpenCode, plus a `wiki/` folder. The DSH bridge stays
under `.dsh/`; it is never installed as a repository-root
`.dsh-mcp-client.js`. These integrations are additive. The MCP service starts
per repository when a configured agent client connects. Pre-pulling the image
(above) is recommended before running the agent in a fresh environment.

## DeepSeek Harness

Install the native DSH bundle once into the profile you use (usually `web`):

```bash
dsh plugin --profile web add github:ihorleleka/Local-Rag-Wiki
```

Restart that DSH profile, open an installed repository as its workspace, and
start a session. On DSH's native `agent/created` / `agent/session-start`
lifecycle, the bundle reads the active workspace's `.dsh/mcp.servers.yml`,
validates its `wiki-manager` entry against the managed install marker, resolves
the configured `node` executable through DSH's subprocess service, and mounts
the bridge through `agent.ctx`. It never uses `process.execPath`, because that
is the Electron executable in DSH Desktop. Initial discovery finishes before
the model request is assembled, exposing stable native
`mcp__wiki-manager__*` tools on that agent's tool scope. Identical namespaces
can coexist in different agent scopes without leaking tools between sessions.

The scoped bridge source is delivered as `.dsh/.dsh-mcp-client.js` (never at
repository root) and follows DSH's MCP transport, reconnect, tool-schema, and
execution pipeline. The canonical config path is `.dsh/mcp.servers.yml`; a
legacy `dsh/mcp.servers.yml` is accepted only when the canonical file is absent.
DSH core does not auto-load this file—the trusted profile bundle is its loader.
Do not add a second global MCP client for the same server.

The bundle also performs bounded wiki recall for material prompts. After the
scoped bridge is ready, `agent/pre-step` dispatches `wiki_search` through DSH's
existing tool registry—first `depth="abstract"` (L0), then matching
`depth="packet"` context (L1). It does not spawn a second runner. Recall is
per-workspace cached and in-flight deduplicated, L1 packets are rate-limited,
and full L2 `wiki_read` remains model-directed.

The governed wiki and its MCP search are the only DSH memory path; the bundle
does not capture local prompt history. Claude Code connects to the same runner
through its MCP configuration without repository prompt-history hooks. See
[`.dsh/README.md`](./templates/root/.dsh/README.md) for the workspace boundary.

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
