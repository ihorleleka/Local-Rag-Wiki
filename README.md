# local-rag-wiki

`local-rag-wiki` merges the former `wiki-kit` and `Project-Rag-Wiki` repositories into one monorepo:

- [`wiki-kit/`](./wiki-kit) - Node-based installer/runner assets for repo-local wiki workflows.
- [`kb-service/`](./kb-service) - Python MCP knowledge service that indexes wiki content and serves retrieval tools.

## Is this actually RAG?

Yes. The service indexes repository wiki notes into vector storage and retrieves relevant context for downstream agent/tool use, which is Retrieval-Augmented Generation behavior.

## Versioning policy

This repo uses one shared Git tag for both components.

- Tag format: `X.Y.Z` or `vX.Y.Z`
- Effective release version: `X.Y.Z`
- `kb-service` resolves package version from Git tags (`setuptools-scm`)
- `wiki-kit` version is set from the same tag during tag workflows

See [`/.github/workflows/tag-version-verify.yml`](./.github/workflows/tag-version-verify.yml) and [`/.github/workflows/docker-release.yml`](./.github/workflows/docker-release.yml).

