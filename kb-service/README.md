# kb-service

`kb-service` is the Dockerized MCP knowledge service used by Local-Rag-Wiki.

It indexes repository wiki notes and serves retrieval and safe write tools.

## Endpoints

- health: `GET /health`
- MCP: `POST /mcp/` (also available at `/mcp`)
- version metadata: `GET /version`

## MCP tools

- read/retrieval: `wiki_search`, `wiki_read`, `wiki_list`, `wiki_tree`, `wiki_schema_report`
- write/maintenance: `wiki_edit`, `wiki_write`, `wiki_capture`, `wiki_delete`, `wiki_rename`

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
- Prefer `wiki_edit(path: str, old_text: str, new_text: str)` for small updates to
  existing notes. It replaces exactly one literal occurrence of `old_text`, with
  no regex, fuzzy matching, or replace-all behavior. `old_text` must be nonempty;
  empty `new_text` deletes the matched text. CRLF/LF differences between the
  fragment and the note are tolerated; the note keeps its own line endings.
- Edit conflicts are `not_found` (note does not exist), `text_not_found` (no exact
  match), and `ambiguous_match` (more than one exact match). Conflicts make no
  writes and schedule no reindex. Re-read the note and choose a unique literal
  context before retrying; do not fall back to a full replacement to bypass a
  conflict.
- Use `wiki_write` for note creation or intentional full replacements; delete
  and rename operate by path.
- Successful edits use the same atomic whole-note persistence as writes.
  If UTF-8 encoding or staging I/O fails, the previous note/manifest is retained
  and the temporary staging file is removed.
- Concurrent updates are eventually consistent, with the last completed replacement winning;
  exact matching is not a whole-note optimistic concurrency guarantee.
- Successful edit, write, delete, rename, and capture calls schedule a targeted
  reindex and return immediately with `index_status: "scheduled"`; use a later
  read/search after indexing completes.

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
- `KB_STALENESS_DAYS=90` (age warnings apply only to `KB_STALENESS_KINDS=rule,decision`)
- `KB_PENDING_MAX_DAYS=7` (pending notes older than this are reported as overdue)

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

- install and day-to-day use: [../README.md](../README.md)
- health signals and runner internals: [../docs/technical.md](../docs/technical.md)

## License

MIT. See [LICENSE](./LICENSE).
