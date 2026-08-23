# kb-service

`kb-service` is the Dockerized MCP knowledge service used by Local-Rag-Wiki.

It indexes repository wiki notes and serves retrieval and safe write tools.

## Endpoints

- health: `GET /health`
- MCP: `POST /mcp/` (also available at `/mcp`)
- version metadata: `GET /version`

## MCP tools

- read/retrieval: `wiki_search`, `wiki_read`, `wiki_list`, `wiki_tree`, `wiki_schema_report`
- write/maintenance: `wiki_write`, `wiki_capture`, `wiki_delete`, `wiki_rename`

`wiki_search` supports tiered retrieval: `depth="abstract"` returns cheap L0 one-liners for scanning, `depth="packet"` (default) returns L1 context packets, and `wiki_read` returns the full L2 note. Pass `path_prefix` to scope retrieval to a directory subtree. `wiki_tree` browses the wiki as a navigable tree (ls/tree style) with per-note kind, status, and freshness.

Typed note kinds: `rule`, `decision`, `reference`, `runbook`, `glossary`, and `investigation` (durable debugging outcomes, confirmed negative results, and eliminated approaches). `wiki_capture` records a session finding as a pending, unverified `investigation` note that later maintenance verifies, promotes, or deletes.

## Data and write model

- Markdown notes are the source of truth.
- `wiki_read` returns a `content_hash`.
- Replacing/deleting/renaming existing notes requires the latest hash.
- Stale hashes return a conflict instead of overwriting newer content.

## Runtime defaults

- `KB_WIKI_ROOT=/workspace/wiki`
- `KB_REPOSITORY_ROOT=/repository` (read-only)
- `KB_ROOT=/workspace/.kb`
- `KB_PORT=1111`
- `KB_MCP_PATH=/mcp/`
- `KB_HEALTH_PATH=/health`
- `KB_EMBEDDING_MODEL=all-MiniLM-L6-v2`
- `KB_TOP_K=8`
- `KB_MAX_TOP_K=20`
- `KB_MIN_RELEVANCE=0.35`
- `KB_STALENESS_DAYS=90`

## Run directly (without wiki-kit)

```bash
docker run --rm \
  -p 1111:1111 \
  -e KB_REPOSITORY_ROOT=/repository \
  -v "$(pwd):/repository:ro" \
  -v "$(pwd)/wiki:/workspace/wiki" \
  -v "kb-data:/workspace/.kb" \
  -v "kb-models:/root/.cache/chroma" \
  <image>
```

## Related docs

- stack overview, install, and lifecycle: [../README.md](../README.md)

## License

MIT. See [LICENSE](./LICENSE).
