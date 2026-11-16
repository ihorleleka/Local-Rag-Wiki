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

The native bundle supports DSH `>=0.2.1-rc.5 <0.3.0-0`. A DSH `0.3.0`
prerelease or later requires a compatible wiki-kit release.

Install the native DSH bundle once into the profile you use (usually `web`):

```bash
dsh plugin --profile web add github:ihorleleka/Local-Rag-Wiki
```

Restart that DSH profile, open an installed repository as its workspace, and
start a session. Opening the session alone does not start the wiki bridge. When
the first direct user prompt is submitted, the bundle compares the wiki-kit
package version of the installed profile plugin—not the DSH runtime version—with
the workspace install marker. When the plugin version is newer, it runs the
workspace's `.agents/update-wiki-kit.cmd` on Windows or
`.agents/update-wiki-kit.sh` on macOS/Linux once; the updated marker prevents
another run for that plugin version. It then reads the active workspace's
`.dsh/mcp.servers.yml`, validates its `wiki-manager` entry against the managed
install marker, resolves the configured `node` executable through DSH's
subprocess service, and mounts the bridge through `agent.ctx`. It never uses
`process.execPath`, because that is the Electron executable in DSH Desktop.
When Docker is reachable, initial discovery finishes before the model request is
assembled, exposing stable native `mcp__wiki-manager__*` tools on that agent's
tool scope. If Docker Desktop is still starting, the session remains usable and
the bridge retries in the background until it can register those tools.
Identical namespaces can coexist in different agent scopes without leaking tools
between sessions.

The scoped bridge source is delivered as `.dsh/.dsh-mcp-client.js` (never at
repository root) and follows DSH's MCP transport, reconnect, tool-schema, and
execution pipeline. The canonical config path is `.dsh/mcp.servers.yml`; a
legacy `dsh/mcp.servers.yml` is accepted only when the canonical file is absent.
DSH core does not auto-load this file—the trusted profile bundle is its loader.
Do not add a second global MCP client for the same server.

Wiki recall is context-bounded. Prefix a prompt with `$wiki ` to opt in
unconditionally, for example `$wiki explain the deployment architecture`.
Otherwise, the first direct prompt performs one L0 candidate search and injects
only individually qualifying results: `relevance_score >= 0.5`, direct lexical
grounding to the prompt (two shared meaningful terms or one shared identifier),
and explicit trust signals: active status, complete schema, current freshness,
present evidence, and no required verification. Pending, historical, and unknown-
trust results are excluded from automatic injection. Older service images without
these trust fields also cause automatic recall to abstain; explicit retrieval
remains available. These signals describe the indexed snapshot, not proof of live
behavior. The score is a ranking signal, not a calibrated probability; `$wiki`
bypasses this automatic-abstention policy for deliberate inspection. Candidate and injected L0 results use
three matches and are capped at 900
characters—about 225 tokens by the recorded estimate. It never automatically
preloads L1 packets; additional detail is a
model-directed `wiki_search` or `wiki_read` decision. Recall is cached and
in-flight deduplicated per workspace. It is turn-scoped: when the turn stops,
the evidence is replaced by an empty, non-model-visible surface event, so it
cannot accumulate in later model requests. Recall diagnostics track skipped
ordinary prompts, explicit requests, cache hits, context characters, estimated
injected tokens, and budget truncations.

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

### Long-running MCP sessions

The HTTP backend can expire idle MCP sessions while remaining healthy. The
managed stdio runner renews a missing session on HTTP 404, then retries the
rejected request once without restarting MCP or the container. Other HTTP and
transport failures return errors with the caller's request ID instead of leaving
calls pending. A 30-second wall-clock HTTP deadline also bounds stalled SSE
responses, even when keepalive traffic continues. Network failures and timeouts
are not automatically retried: a write may already have executed.

For an older installed runner, update the managed workspace files and reconnect
its MCP client once to load the fix. A container/image replacement is not required
for this runner-only fix.

## Crash-dump protection

Starting with 0.2.5, the Linux backend disables process core dumps before loading native dependencies,
including when WSL uses a piped crash collector (where `ulimit core=0` alone is
not sufficient). Managed containers additionally use `--ulimit core=0:0`.
The backend refuses to start on Linux if process-level protection cannot be
established. Ordinary debugger/ptrace attachment to that process is also disabled.
This contains crash-dump disk growth; it does not fix native crashes or limit RAM.

To apply this protection to an existing installation, update the managed files,
then run `pull .` and `restart .` using the lifecycle commands above. Updating
files alone does not replace a running container. Restart briefly interrupts all
clients sharing that repository's container, but retains wiki/index/model volumes.
If `KB_IMAGE` is overridden, use an image containing this fix; the default image
is pinned to the shared release version. Existing Windows dump files are not
removed, and no host-wide WSL settings are modified. Custom image commands that
bypass `python -m kb_service` also bypass its process-level protection.

## How it works

- This package is the installer: it scaffolds and maintains the `.agents/`
  runner and MCP configuration in a consumer repository.
- [kb-service/](./kb-service) is the Dockerized MCP knowledge service the runner
  launches per repository. It serves `wiki_search`, `wiki_read`, `wiki_list`,
  `wiki_tree`, `wiki_schema_report`, `wiki_edit`, `wiki_write`, `wiki_capture`,
  `wiki_delete`, and `wiki_rename` over `POST /mcp/` (loopback by default), with
  atomic note persistence and targeted reindexing. Prefer `wiki_edit` for small
  updates; use `wiki_write` for creation or full replacements. `wiki_search`
  supports tiered retrieval (`depth=abstract|packet`) plus `path_prefix` directory
  scoping.

`wiki_edit(path: str, old_text: str, new_text: str)` replaces exactly one literal
match in an existing note. `old_text` must be nonempty; empty `new_text` deletes
that match. It performs no write on conflicts: `not_found` (missing note),
`text_not_found` (no match), or `ambiguous_match` (multiple matches). See the
[service write contract](./kb-service/README.md#data-and-write-model) for details.

## Agentic memory design review

See the [dated comparison and delivery audit](./docs/agentic-memory-review.md)
against Mem0, Letta, Graphiti, Cognee, and OpenViking, including adopted patterns,
licensing caveats, and prioritized remaining work. The design keeps governed
Markdown and bounded retrieval rather than adding a conversation archive or graph
service. MCP availability and native skill discovery are separate capabilities;
the delivered policy names the skill file for clients without `$wiki` discovery.

## Versioning

The installer and kb-service ride the same Git tag (`X.Y.Z` or `vX.Y.Z`).
Release automation:

- [tag-version-verify.yml](./.github/workflows/tag-version-verify.yml)
- [docker-release.yml](./.github/workflows/docker-release.yml)

## Development and verification

From a clean checkout, install the locked JavaScript dependencies before running
installer and scoped DSH bridge regressions:

```bash
npm ci
npm test
```

The dependency-free Python suite fakes native libraries and model providers; it
requires Python 3.11+ and does not start Docker or download models:

```bash
python -m unittest discover -s kb-service/tests -p 'test_*.py'
```

CI runs this suite on Python 3.11 and 3.14. See the
[service verification notes](./kb-service/README.md#verification) for the separate
real-dependency integration suite. `npm run verify:runner` requires Docker and
exercises container lifecycle operations; it is not part of the offline suite.

When updating DSH-related libraries, check the supported runtime's peer ranges,
not only npm's `latest` tag. DSH 0.2.1-rc.5 requires Cordis `~4.0.5` and uses
Schemastery `~3.18.5`; upgrading the top-level copies independently can split the
plugin dependency graph. Preserve the supported runtime baseline and verify the
scoped bridge before accepting such updates.

## License

MIT (see [kb-service/LICENSE](./kb-service/LICENSE)).
