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

L0 packet results include `trust.status`, `trust.last_verified`, schema, freshness,
evidence, and verification signals. Pending investigations are searchable candidates,
not accepted facts; non-active or unknown-status L0 packets require verification.
Deprecated/superseded notes require `include_inactive: true`. The DSH bundle's
automatic recall admits only explicitly trusted active results; explicit `$wiki`
and model-directed tools remain available for deliberate inspection. Trust signals
reflect the indexed snapshot, not a guarantee of live behavior or source authority.

Typed note kinds: `rule`, `decision`, `reference`, `runbook`, `glossary`, and `investigation` (durable debugging outcomes, confirmed negative results, and eliminated approaches). `wiki_capture` records a session finding as a pending, unverified `investigation` note that later maintenance verifies, promotes, or deletes.

## Data and write model

- Markdown notes are the source of truth.
- `wiki_read` returns the current complete Markdown content.
- Writes replace whole notes atomically; delete and rename operate by path.
  If UTF-8 encoding or staging I/O fails, the previous note/manifest is retained
  and the temporary staging file is removed.
- Concurrent updates are eventually consistent, with the last completed replacement winning.
- Write, delete, rename, and capture calls schedule a targeted reindex and return immediately with `index_status: "scheduled"`; use a later read/search after indexing completes.

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

## Verification

From the repository root, run the fast fake-backed unit suite without installing
service dependencies:

```bash
python -m unittest discover -s kb-service/tests -p 'test_*.py'
```

For real FastAPI/FastMCP and Chroma coverage, use an activated repository-local
virtual environment with the service installed (or the project image):

```bash
python -m pip install ./kb-service
python -m unittest discover -s kb-service/tests -p integration_real.py -v
```

Run the real suite separately: the fast suite replaces dependency modules in
process. Integration tests use temporary local storage and deterministic
embeddings; no model downloads or live MCP service are needed. Linux-only
runtime-safety tests are skipped on other operating systems.

Dependency pins are intentional. Take compatible patch updates after both
suites pass; evaluate major upgrades (including FastMCP 4) separately rather than
silently expanding the Python/runtime API contract.

## Related docs

- stack overview, install, and lifecycle: [../README.md](../README.md)

## License

MIT. See [LICENSE](./LICENSE).
