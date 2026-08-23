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
editor MCP config (`.claude/`, `.codex/`, `.vscode/`, `opencode.jsonc`), and a
`wiki/` folder. The MCP service then starts automatically per repository when
your agent client connects. Pre-pulling the image (above) is recommended before
running the agent in a fresh environment.

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
