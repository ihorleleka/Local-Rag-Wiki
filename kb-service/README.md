# Project RAG wiki

[![Docker Hub](https://img.shields.io/docker/v/ihorleleka/project-rag-wiki?sort=semver&label=docker%20hub)](https://hub.docker.com/repository/docker/ihorleleka/project-rag-wiki)

Repository-scoped MCP knowledge service for Markdown wiki content.

It indexes Markdown files from a mounted wiki folder, stores vectors in ChromaDB, and serves:
- MCP endpoint (streamable HTTP)
- health endpoint

The MCP surface is intentionally small:
- Active tools: `wiki_search`, `wiki_read`, `wiki_list`, `wiki_schema_report`,
  `wiki_write`, `wiki_delete`, `wiki_rename`
- Compatibility metadata: `GET /version` reports service, index schema, and MCP tool-contract versions

MCP initialization includes a compact instruction (under 512 characters) that
states the essential safe-use contract for clients without wiki-kit assets:
search is advisory, packets and stale claims require judgment, full detail comes
from `wiki_read`, an empty result is an honest gap, and whole-note replacement
uses the latest content hash.

All path-taking wiki tools accept only repository-relative `.md` paths under
the canonical wiki root. Absolute paths, traversal segments, hidden path
components (including `.obsidian`), non-Markdown extensions, and paths that
escape through symlinks are rejected. Backslashes are normalized for portable
relative-path input.

## Retrieval Model

Markdown files remain the saved and editable source of truth. During indexing,
the service derives additional context packet records from well-structured wiki
notes and stores those packet records alongside raw chunks in ChromaDB.

A note can compile into a decision-ready packet when it uses frontmatter such as:

```yaml
---
id: stable-note-id
kind: rule
scope: project-specific
last_verified: YYYY-MM-DD
status: active
applies_to:
  - domain-or-component
---
```

Supported `kind` values are:

- `rule` - mandatory behavior agents should follow.
- `decision` - architecture or product choices with rationale and consequences.
- `reference` - durable facts, concepts, API shapes, or domain context that are not rules.
- `runbook` - repeatable operational or maintenance procedures.
- `glossary` - names, terms, aliases, and vocabulary.

Each kind has a compact section shape:

| kind | required sections |
|---|---|
| `rule` | `Use this when`, `Rule`, `Do`, `Do not`, `Evidence`, `Retrieval hints` |
| `decision` | `Use this when`, `Decision`, `Rationale`, `Consequences`, `Evidence`, `Retrieval hints` |
| `reference` | `Use this when`, `Summary`, `Key facts`, `Evidence`, `Retrieval hints` |
| `runbook` | `Use this when`, `Steps`, `Do not`, `Evidence`, `Retrieval hints` |
| `glossary` | `Terms`, `Aliases`, `Retrieval hints` |

Capability specifications may additionally use `Capability contract`,
`Behavior model`, `Interaction model`, `Architecture boundaries`, `Data and
integration contracts`, `Quality attributes`, `Acceptance and verification`,
`Reconstruction guidance`, and `Open questions`. Packets normalize these to
`capability_contract`, `behavior_model`, `interaction_model`,
`architecture_boundaries`, `data_integration_contracts`, `quality_attributes`,
`acceptance_verification`, `reconstruction_guidance`, and
`has_open_questions`. Compact results prioritize the contract, boundaries,
verification entry points, and open-question indicator; full detail remains in
`wiki_read`.

When any extended capability section is present, schema reporting treats the
note as a capability specification and checks for the three core sections:
`Capability contract`, `Architecture boundaries`, and `Acceptance and
verification`. Ordinary typed notes that do not use the capability shape are
not subject to these additional warnings.

The indexer is backward compatible with older notes that omit `kind` or use the
old `Decision` / `Do` / `Do not` shape. Those notes still produce packets, but
their `gaps` field reports missing typed-note structure so agents can modernize
them during wiki maintenance.

`wiki_search` prefers matching packet records before raw chunks. Packet results
use one canonical shape: `record_type`, `relevance_score`, and one bounded
`packet` object. The packet contains normalized fields such as `rule`, `source`,
`schema_health`, `freshness_state`, `evidence_state`, `verification_required`,
`last_verified`, `applies_to`, `do`, `do_not`, `evidence`,
`kind`, `decision`, `rationale`, `consequences`, `summary`, `key_facts`,
`steps`, `terms`, `aliases`, and `gaps`. Empty and lower-priority oversized
values are omitted or truncated to keep one result below 4 KB. Full note prose
is available through `wiki_read`, not duplicated in search metadata.

Trust fields describe mechanics, not factual confidence:

- `schema_health` is `complete` only when local typed-note frontmatter and
  required sections are present and valid; otherwise it is `incomplete`.
- `freshness_state` is `current`, `stale`, or `unknown` from `last_verified`
  and the configured age threshold. It does not prove that claims are current.
- `evidence_state` is `present`, `missing`, or
  `changed_since_verification`. `present` means evidence was declared, not
  that the service executed or independently validated it.
- `verification_required` is true unless all three structural states are in
  their healthy/current/present state.

The serialized `needs_verification` field is a deprecated compatibility alias
for `verification_required`; it is scheduled for removal in a future MCP tool
contract. The misleading `confidence` field was removed in contract version 3.
Contract version 4 adds governed hash-protected delete and rename tools.

Evidence validation is repository-aware and runs during reindex/schema audit,
not during search. The service takes one batched Git snapshot, records tracked
blob identities plus working-tree state in the manifest, and reindexes a note
when a declared anchor changes. Checkout mtimes are not used. Missing files,
directories, symbols, and tests are reported explicitly; commands are recorded
but never executed by evidence inspection.
Warning-only Git stderr for line-ending normalization (LF/CRLF conversion
notices) is treated as non-fatal so consumer repositories with different local
Git/editor defaults do not break evidence snapshots.

Plain repository-relative paths remain compatible. Typed anchors may use
`path:`, `dir:`, `glob:`, `symbol: path#Name`, `test: path::TestName`, or
`generated:`. Prefer a small set of owner directories, public symbols, and
focused tests over exhaustive file inventories. More than
`KB_EVIDENCE_MAX_ANCHORS` verifiable anchors is a schema maintenance warning,
not a request for agents to open or manually verify every path.
The repository mount is read-only; `wiki_write` remains restricted to the
separate writable `KB_WIKI_ROOT` mount.

The typed `wiki_search` return enables MCP structured output in compatible
clients. FastMCP also supplies its serialized text fallback for older clients.
Raw chunk results retain `source_file`, `chunk_id`, and their bounded chunk
`context`; packet results do not repeat packet fields at the top level or in a
second semantic metadata object.

Search ranking keeps cosine similarity primary. Verified packets receive a
small `0.04` owner-context boost; packets needing verification lose `0.03`.
Results first select the strongest candidate from each source, then at most one
supporting result per source, so one long note cannot monopolize the response.
`deprecated` and `superseded` notes are excluded unless callers explicitly set
`include_inactive: true` for audit/history retrieval.

The default minimum adjusted relevance is `0.35`, configurable with
`KB_MIN_RELEVANCE` in the `0.0`-`1.0` range. When no candidate clears it,
`wiki_search` returns `{ "results": [] }` with compact diagnostics containing
`miss: true`, the threshold, and a knowledge-gap message. A miss is not an
error; inspect code or run one better-focused query rather than adopting weak,
unrelated context.

Packet embeddings use the configured model tokenizer and a 240-token ceiling
(or the model maximum when lower), so they are never silently truncated by the
default 256-token model window. Identity and routing fields come first: title,
source, note id, `Use this when`, retrieval hints, aliases, `applies_to`, and
the primary contract. Only constraints, anti-patterns, key facts, or steps that
fit the remaining budget are added. Evidence inventories and raw prose are not
embedded.
The full source prose remains in the Markdown document and is not stored as
packet metadata or used as the primary packet embedding text.

## Schema Report

`wiki_schema_report` audits Markdown notes without writing or reindexing. It
returns aggregate counts and per-note entries for:

- inferred and explicit `kind`
- packet compile status and packet `gaps`
- missing required sections by kind
- missing, invalid, or stale `last_verified`
- missing or duplicate `id`
- missing or invalid `status`
- oversized notes above `KB_NOTE_MAX_LINES` lines
- broken wiki links detected from `[[wikilinks]]`

Use it before broad wiki restructures or after schema changes to decide which
notes need typed-note cleanup.

## Write Model

`wiki_read` returns `path`, full `content`, and a SHA-256 `content_hash`. Use
`wiki_write` without `expected_hash` only to create a note that does not yet
exist. Replacing an existing note requires the hash returned by the read. A
stale or missing hash returns a structured conflict with `current_hash`; it
does not overwrite the newer note or trigger reindexing.

Successful note and manifest writes are staged beside their targets, flushed,
and atomically replaced. The service reindexes after each successful wiki
write and regenerates derived packet records automatically.

The repository enforces consistent line endings (`LF` for text) through
`.gitattributes` and `.editorconfig` to avoid warning-only Git output causing
downstream tooling instability around write/checkpoint flows.

Use `wiki_delete(path, expected_hash)` or
`wiki_rename(source_path, destination_path, expected_hash)` for structural wiki
maintenance. Both operations require the latest source hash, reject destination
collisions, and reindex before returning success, so removed source paths are
not left searchable until the watcher runs. They also reject notes with inbound
wikilinks. Update those referring notes first with hash-protected `wiki_write`
calls, then re-read the source and perform the delete or rename. This makes link
repair an explicit bounded conflict response, not a repository-wide manual path
verification ritual.

There is no append tool by design. Agents should read the current note, merge
changes locally, and write a complete coherent document so frontmatter,
semantic sections, links, and retrieval hints stay consistent.

## Agent Wiki-Kit

For an agent consumer of this service, see [@ihorleleka/wiki-kit](https://github.com/ihorleleka/wiki-kit).

## What This Image Expects

- A wiki folder mounted at `/workspace/wiki`
- The repository root mounted read-only at `/repository` for evidence identities
- A writable KB state folder mounted at `/workspace/.kb`
- A shared models cache KB state folder mounted at `/root/.cache/huggingface/hub`

Do not bake runtime `.kb` state into images.

## Runtime Defaults

- `KB_WIKI_ROOT=/workspace/wiki`
- `KB_REPOSITORY_ROOT=/repository` (read-only source/Git root for evidence inspection)
- `KB_ROOT=/workspace/.kb`
- `KB_PORT=1111`
- `KB_MCP_PATH=/mcp/`
- `KB_HEALTH_PATH=/health`
- `KB_EMBEDDING_MODEL=all-MiniLM-L6-v2`
- `KB_CHUNK_TOKENS=220` (token budget for heading-aware Markdown chunks)
- `KB_TOP_K=8`
- `KB_MAX_TOP_K=20` (hard ceiling for caller-supplied result counts)
- `KB_EMBEDDING_BATCH_SIZE=64`
- `KB_MIN_RELEVANCE=0.35`
- `KB_MERGE_ADJACENT_WINDOW=1`
- `KB_STALENESS_DAYS=90`
- `KB_NOTE_MAX_LINES=200`
- `KB_EVIDENCE_MAX_ANCHORS=12`
- `KB_WATCH_INTERVAL_SECONDS=15`

Indexing uses manifest hashes to skip parsing and embedding unchanged notes.
Successful single-note mutations request a targeted update; the service falls
back to a full pass when an evidence anchor depends on the changed note or an
older manifest lacks dependency metadata. Embeddings are written in bounded
batches, and caller-supplied result counts cannot exceed `KB_MAX_TOP_K`.

The health payload includes `progress_processed` and `progress_total` while
indexing. During the first long startup pass it returns HTTP `200` with
`"status": "starting"` once the MCP session manager is up, then transitions to
`"status": "ok"` after the first successful reindex. Index work runs outside
the async request loop and supports cooperative cancellation during shutdown, so
MCP requests remain responsive during a long pass.

The deterministic 20/100/500/1,000-note developer benchmark is deliberately
excluded from routine CI. Refresh its checked-in machine-specific baseline when
changing indexing behavior:

```bash
python tests/benchmark_indexing.py --output tests/indexing-performance-baseline.json
```

## Run

```bash
docker run --rm \
  -p 1111:1111 \
  -e KB_REPOSITORY_ROOT=/repository \
  -v "$(pwd):/repository:ro" \
  -v "$(pwd)/wiki:/workspace/wiki" \
  -v "$(reponame)-kb-data:/workspace/.kb" \
  -v "kb-models:/root/.cache/huggingface/hub" \
  ihorleleka/project-rag-wiki:latest
```

## Retrieval Quality Gate

The release workflow evaluates the current service against its own committed
synthetic wiki and machine-readable query corpus using the real embedding model
and a fresh Chroma index. It has no dependency on a consumer repository. Run
the same gate locally with a built image:

```bash
docker run --rm \
  -v "$(pwd)/tests:/evaluation:ro" \
  ihorleleka/project-rag-wiki:<tag> \
  python -m kb_service.evaluation \
    --wiki-root /evaluation/fixtures/retrieval-wiki \
    --dataset /evaluation/retrieval-evaluation.json \
    --top-k 3
```

The command exits non-zero when owner-note accuracy, top-k accuracy, mean
reciprocal rank, duplicate-source rate, expected misses, or payload limits
violate the dataset's committed thresholds.

The same already-built release-evaluation image runs
`tests/integration_real.py`, which uses real persistent Chroma with a
deterministic embedding provider to cover initial/change/removal indexing,
packet/chunk retrieval, inactive filtering, honest misses, hash conflicts, and
immediate record cleanup. This adds no second image build or routine CI job.

The original local consumer benchmark compared compact models. The default
remains `all-MiniLM-L6-v2`: both tested challengers failed its calibrated
undocumented-query miss, and `all-MiniLM-L12-v2` also reduced owner top-1
accuracy. Model changes must update and pass this repository-owned corpus rather
than relying only on a disposable sample project or generic benchmarks.

## Release Automation

Image versioning is driven from the Git tag.

- Tag releases as `X.Y.Z`.
- The GitHub Actions workflow at [`.github/workflows/docker-release.yml`] validates the tag, builds one native-amd64 candidate, runs every release gate against that exact image, then tags and pushes it without rebuilding.
- The workflow passes the tag name directly into the Docker build as `VERSION`.
- That same `VERSION` value is used for the OCI image label and the installed Python package version inside the image.

Set these repository settings before using the workflow:

- Secret `DOCKERHUB_USERNAME`
- Secret `DOCKERHUB_TOKEN`

## Endpoints

- Health: `GET /health`
- MCP: `POST /mcp/` (also mounted at `/mcp`)

The health response is `200` while startup indexing is still in progress and
the MCP session manager is running, with `"status": "starting"`. After the
first successful reindex it returns `"status": "ok"`. It exposes
`indexing_state`, `last_success_utc`, `last_failure_utc`, `last_error`,
`consecutive_failures`, and `indexed_revision`. Startup, watcher, and
write-triggered mutations share one coalescing worker; a startup failure, an
offline MCP session manager, or two consecutive post-startup failures return
HTTP `503`, and a later successful watcher pass restores health.

## License

MIT. See [LICENSE](LICENSE).
