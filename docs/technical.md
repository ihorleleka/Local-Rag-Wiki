# Local-Rag-Wiki technical reference

Details for maintainers and for diagnosing unusual setups. Day-to-day use is
covered in the [README](../README.md).

## What the installer writes

- `.agents/`: the managed runner (`run-wiki-manager.mcp.js`), its static MCP
  manifest, the shared `wiki` skill, update wrappers, integration metadata
  (`integrations/`), and a plugin catalog (`plugins/`, not a Claude Code
  marketplace). User-added skill directories under `.agents/skills/` are kept;
  `skills/wiki` is replaced on every update.
- `AGENTS.md` and `CLAUDE.md`: one bounded managed section each, between
  `<!-- BEGIN/END WIKI-KIT MANAGED WIKI POLICY -->`. `CLAUDE.md` only imports
  `@AGENTS.md`. Text outside the markers is never touched.
- MCP entries named `wiki-manager` in `.mcp.json`, `.codex/config.toml`,
  `opencode.jsonc`, `.vscode/mcp.json`, and `.dsh/mcp.servers.yml`; unrelated
  servers and comments are preserved.
- `.claude/skills/wiki/` (generated from `.agents/skills/wiki`) and
  `env.MCP_TIMEOUT=150000` in `.claude/settings.json` (only when unset).
  `.claude/settings.local.json` stays user-owned; older installs may have an
  obsolete `mcpServers.wiki-manager` entry there that you can remove yourself.
  No MCP approvals or tool permissions are granted.
- `.gitattributes`: a managed block forcing LF for `wiki/**/*.md`, so edits and
  evidence identities match regardless of `core.autocrlf`.
- `wiki/`: created empty.

`--skip-root` skips everything outside `.agents/`. `--skip-docker` (or
`WIKI_KIT_SKIP_DOCKER=1`) skips image pull and container start.

During `install` and `update` the installer pulls the pinned image, replaces a
repository container running an older image, removes the superseded image tag
unless another repository still uses it, and starts the container so the
one-time embedding-model download (~80 MB) happens then.

## Runner and container

- One container per repository. Container and KB volume names include a hash of
  the canonical repository path, so equally named folders stay isolated; the
  `hf-cache` model volume is shared. `KB_CONTAINER_NAME`, `KB_VOLUME`, and
  `HF_CACHE_VOLUME` override the names (set `KB_VOLUME=<old-name>-kb-data` to
  reuse an index from an older basename-only install).
- Moving or re-cloning a repository changes the container name. The old
  container keeps running; remove it with `docker rm -f <name>` and its volume
  with `docker volume rm <name>-kb-data`.
- Git worktrees are separate checkouts and get their own container when a client
  session starts inside them. A session started in the main checkout indexes the
  main checkout only.
- The container outlives individual clients; concurrent clients attach to the
  same healthy container, and stale or stopped containers are recovered on the
  next start. It uses Docker's default restart policy unless `--keep-warm` or
  `KB_RESTART_POLICY` is set.
- The endpoint binds to `127.0.0.1` because it has no authentication and exposes
  write tools. Network exposure needs both `KB_BIND_ADDRESS` and
  `KB_ALLOW_NETWORK_EXPOSURE=1`, behind your own access control.
- The runner pins an image digest. `KB_IMAGE` overrides it and is reported as an
  override by `status`.

### Startup

Clients such as Claude Code give an MCP server 30 seconds to start by default.
The runner answers `initialize`, `ping`, and `tools/list` immediately from
`wiki-manager-manifest.js` and starts or attaches the container in the
background. Tool calls queue until the container is healthy; a call still
waiting after `KB_WARMUP_TIMEOUT_MS` (default 100 s) returns a "warming up" error
with the recovery command, and the next call retries a failed start. The
background start waits up to 120 s for a cold container. `KB_LAZY_INIT=0`
restores blocking startup. Lifecycle commands (`KB_LIFECYCLE_COMMAND`) and
`KB_ATTACH_ONLY=1` always block so their exit code reports the result.

Generated client timeouts: Codex gets 150 s startup and 120 s tool calls,
OpenCode a 150 s discovery timeout, Claude Code `MCP_TIMEOUT=150000`.

### Long-running sessions

The service may expire idle MCP sessions while staying healthy. The runner renews
a missing session on HTTP 404 and retries the rejected request once. Other HTTP
and transport failures return errors with the caller's request ID. A 30-second
HTTP deadline bounds stalled SSE responses. Network failures and timeouts are not
retried, because a write may already have executed.

### Crash-dump protection

Since 0.2.5 the Linux service disables core dumps before loading native
dependencies (including under WSL's piped crash collector) and refuses to start
if it cannot; containers also run with `--ulimit core=0:0`. Ptrace attachment to
the service process is disabled. This limits dump disk growth; it does not fix
native crashes or limit RAM. Custom image commands that bypass
`python -m kb_service` bypass this protection.

## Health signals

The schema report and search packets carry trust signals. They are designed to
be rare enough to mean something:

| Signal | Raised when |
|---|---|
| `packet_not_compiled` (error) | A note has no recognizable frontmatter or sections. |
| `missing_required_section`, `missing_last_verified` (error) | Shape is incomplete. Pending notes are exempt from `last_verified`. |
| `stale_verification` (warning) | A `rule` or `decision` note is older than `KB_STALENESS_DAYS` (90). Kinds come from `KB_STALENESS_KINDS` (`rule,decision`). |
| `pending_overdue` (warning) | A pending note's `captured` date is older than `KB_PENDING_MAX_DAYS` (7). |
| `changed_evidence_anchors` (info) | Anchored files changed since the last indexing. An audit hint; it does not set `verification_required`. |

Directory and glob evidence anchors change only when files appear or disappear,
not on content edits. File anchors compare Git blob identities with normalized
line endings, so staging, committing, or CRLF checkouts are not reported as
changes. `wiki-kit schema-report` exits non-zero only for errors.

## DeepSeek Harness bundle

Supported DSH range: `>=0.2.1-rc.5 <0.3.0-0`.

- On the first direct prompt of a session, the bundle compares the installed
  plugin's wiki-kit version with the workspace install marker and, when newer,
  runs `.agents/update-wiki-kit.cmd` or `.sh` once.
- It reads `.dsh/mcp.servers.yml` (or legacy `dsh/mcp.servers.yml` when `.dsh/`
  is absent), validates the `wiki-manager` entry against the install marker,
  resolves `node` through DSH's subprocess service (never `process.execPath`,
  which is Electron in DSH Desktop), and mounts `.dsh/.dsh-mcp-client.js`
  through `agent.ctx`. Tools register as `mcp__wiki-manager__*` on that agent's
  scope only. DSH core does not load this file itself; do not add a second
  global MCP client for the same server.
- While Docker is starting, the session stays usable and the bridge retries in
  the background.

Automatic recall runs once per turn, only for a direct user message. It does one
abstract search and injects up to three results (at most 900 characters) that
score at least 0.5, share terms or an identifier with the prompt, and are
active, complete, current, evidence-backed, and not marked for verification.
Pending, historical, and unknown-trust results are never injected. The injection
expires when the turn ends. Prefix a prompt with `$wiki ` to search
unconditionally. The bundle never captures prompt history.

When updating DSH-related libraries, follow the supported runtime's peer ranges
(DSH 0.2.1-rc.5 requires Cordis `~4.0.5` and Schemastery `~3.18.5`) rather than
npm `latest`, and verify the scoped bridge.

## Service

See [kb-service/README.md](../kb-service/README.md) for tools, the write model,
runtime settings, and the service test suites.

## Development

```bash
npm ci
npm test                      # installer, DSH bridge, HTTP bridge (no Docker)
python -m unittest discover -s kb-service/tests -p 'test_*.py'   # Python 3.11+, no Docker or models
npm run verify:runner         # needs Docker; exercises container lifecycle
```

CI runs the Python suite on 3.11 and 3.14. The installer and service share one
Git tag (`X.Y.Z` or `vX.Y.Z`); see
[tag-version-verify.yml](../.github/workflows/tag-version-verify.yml) and
[docker-release.yml](../.github/workflows/docker-release.yml).
