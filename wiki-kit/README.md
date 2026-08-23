# wiki-kit

`wiki-kit` installs the local agent configuration needed to use a Docker-backed
`wiki-manager` MCP server from an existing repository.

It gives coding agents a governed, repo-local wiki workflow: retrieve relevant
decisions, contracts, placement rules, runbooks, and capability notes before
decisions where that context can change the approach; then write back verified,
durable knowledge when the work reveals something future sessions should not
rediscover.

## What You Get

- Docker-backed `wiki-manager` MCP runner
- repository `AGENTS.md` policy for wiki-backed agent work
- editor MCP configuration for Codex, Claude, OpenCode, and VS Code
- a routed `$wiki` skill for retrieval, initialization, maintenance,
  and audit
- decision-sensitive retrieval, explicit instruction/trust boundaries, and a valid no-write outcome when no reusable knowledge changed
- scope-aware authoring that separates generic wiki-kit rules, project-wide guidance, capability contracts, and task evidence
- write-back guidance for focused notes, multi-note updates, and schema-report-backed note splitting
- capability-spec parsing aligned across the managed skill and MCP packet contract, including contract, boundaries, verification, and open-question indicators
- a committed `wiki/` folder owned by the consumer repository
- update wrappers so committed wiki-kit files can be refreshed consistently

The package does not ship project knowledge. Your repository owns the wiki
content.

Wiki notes are meant to be committed and shared. Keep examples and evidence
portable: use repository-relative paths such as `src/app.ts`, not local absolute
paths from one developer's machine.

## Install

Run from the consumer repository root:

```bash
npx github:ihorleleka/wiki-kit install . --force
npx github:ihorleleka/wiki-kit pull .
```

This writes:

```text
<repo>/
  .agents/      managed wiki-kit runner and $wiki skill
  AGENTS.md     repository agent policy
  .claude/      Claude MCP configuration
  .codex/       Codex MCP configuration
  .vscode/      VS Code MCP configuration
  opencode.jsonc OpenCode MCP configuration
  wiki/         consumer-owned knowledge base
```

Prerequisites:

- Docker available on `PATH`
- Node.js 18 or newer
- a repository where the wiki-kit runner directory can live as a direct child

## MCP Network Security

The runner publishes the unauthenticated MCP endpoint on `127.0.0.1` only. This
keeps read and write tools unavailable to other machines on the network.

Specialized environments that intentionally require network exposure can set
both `KB_BIND_ADDRESS` and `KB_ALLOW_NETWORK_EXPOSURE=1`. For example,
`KB_BIND_ADDRESS=0.0.0.0` exposes the endpoint on every IPv4 interface. Do not
enable this without an external access-control boundary. A non-loopback bind is
rejected unless the explicit opt-in is present.

## Docker Resource Identity

Default container and knowledge-index volume names combine the repository
basename with a short hash of its canonical absolute root. Two repositories
with the same folder name therefore use different containers and KB volumes,
while reopening the same repository reuses its existing index. The Hugging Face
model cache remains the intentionally shared `hf-cache` volume.

This naming replaces the earlier basename-only defaults. After updating, the
first run creates a new per-repository KB volume. To reuse an older index during
changeover, set `KB_VOLUME=<old-repository-name>-kb-data`; remove that override
after rebuilding the new default index. Existing `KB_CONTAINER_NAME`,
`KB_VOLUME`, and `HF_CACHE_VOLUME` overrides remain supported.

## Compatibility Contract

Version/schema/tool-contract combinations are validated as a matrix. `wiki-kit status .`
reports the configured image, running image ID and registry digest,
service/schema/tool-contract versions, and one of `current`, `outdated`, or
`incompatible`, with compatibility guidance. `KB_IMAGE` is an explicit override;
status reports it as such while still evaluating the running image metadata.

Image pulls are deliberate rather than an implicit side effect of install or
update. Run `wiki-kit pull .`, followed by `wiki-kit restart .`, to adopt the
pinned image. To roll back temporarily, set `KB_IMAGE` to a known compatible
digest and restart; status will identify the override.

## MCP Timeouts

The generated Codex configuration allows 75 seconds for MCP startup and 120
seconds per tool call. OpenCode's supported MCP discovery timeout is set to
75,000 milliseconds. The current VS Code and Claude configuration formats do
not receive undocumented timeout properties.

On Windows 10.0.26200, the live verifier completed its full fresh-KB and
fresh-model-cache scenario in 38.97 seconds; the verifier also records the MCP
initialization interval directly and fails if it reaches the generated 75-second
limit. Linux and macOS measurements remain to be collected on those platforms.

The runner passes `KB_MIN_RELEVANCE` to the service, defaulting to `0.35`.
It also mounts the repository root read-only at `/repository` for batched Git
evidence inspection. Wiki writes continue through the separate writable
`wiki/` mount; evidence inspection never executes declared commands.
Override it only when a project-owned evaluation set justifies a different
threshold.

## Update

Refresh an existing committed install:

```bash
npx github:ihorleleka/wiki-kit update . --force
```

or use the installed wrapper:

```bash
.agents\update-wiki-kit.cmd --force
```

On macOS or Linux:

```bash
sh ./.agents/update-wiki-kit.sh --force
```

Install and update preserve user-added skill directories under
`.agents/skills`, replace only the managed `$wiki` skill, and remove older split
wiki-kit skills from previous versions. Existing `AGENTS.md` instructions and
editor MCP configuration are merged by default: the installer updates only the
managed wiki policy section and the `wiki-manager` MCP server entries while
leaving other wiki-kites, instructions, and MCP servers in place. Non-mergeable
root assets are overwritten only when `--force` is used.

The managed `AGENTS.md` policy is enclosed by explicit begin/end comments; one
legacy unmarked policy is migrated without matching or deleting local headings.
JSON/JSONC configuration edits replace only wiki-kit-owned values and preserve
comments, trailing-comma style, unrelated servers, and unrelated VS Code
settings. `--force` refreshes managed assets but does not authorize replacing
user-owned configuration. Repeated updates are idempotent.

## Check Setup

Inspect the local install without changing files:

```bash
npx github:ihorleleka/wiki-kit status .
```

Run local health checks for the wiki-kit, Node.js, and Docker CLI:

```bash
npx github:ihorleleka/wiki-kit doctor .
```

`doctor` does not pull images, start containers, or contact the network.

To inspect an already-running installation end to end, use:

```bash
npx github:ihorleleka/wiki-kit doctor . --live
```

Live doctor still never starts, replaces, or writes through the service. It
checks Docker daemon access, local image availability, running container state,
loopback binding, health and compatibility metadata, then performs MCP
initialize, `tools/list`, and a read-only `wiki_list`. Every failure includes a
specific recovery command.

Status and doctor validate the named `wiki-manager` entry in each supported
configuration schema, including its Node command, sole runner argument, and
resolved file. They normalize Windows and POSIX separators and report unrelated
user MCP servers separately; an unrelated JavaScript runner cannot satisfy the
managed-entry check.

Maintainers can exercise the live runner, including Docker port binding, MCP
initialization, and tool discovery, with `npm run verify:runner`. This starts a
temporary container and requires the configured `KB_IMAGE` to be available.
The seconds-long `npm run verify` suite runs on ordinary pushes and pull
requests. The image-heavy Docker integration suite runs in CI only for release
tags or an explicit manual dispatch, keeping routine open-source CI usage small.

## Container Lifecycle

The repository's wiki container is a persistent local daemon shared by MCP
clients. Closing an editor or agent client does not remove it, so other clients
continue to work. Manage it explicitly from the consumer repository root:

```bash
npx github:ihorleleka/wiki-kit start .
npx github:ihorleleka/wiki-kit stop .
npx github:ihorleleka/wiki-kit restart .
```

Startup uses Docker's atomic container-name claim: concurrent clients attach to
the winner instead of deleting and recreating its healthy container. A stopped
or non-responsive namesake is treated as stale and replaced deterministically.

## Custom Runner Directory

The default runner directory is `.agents`. You can choose another portable
direct-child directory name:

```bash
npx github:ihorleleka/wiki-kit install . --agents-dir wiki-kit-agent --force
```

Do not use slashes, drive prefixes, shell metacharacters, Windows-reserved
names, or trailing dots/spaces. The runner must remain a direct child of the
consumer repository because the MCP runner resolves its parent as the project
root.

Later `install` and `update` commands discover a single existing install marker,
so a custom installation can be refreshed without repeating `--agents-dir`.
The installed update wrappers also pass their own directory explicitly. If a
repository contains more than one marker, automatic discovery stops and asks
you to select one with `--agents-dir`; it never modifies an arbitrary install
or creates a second default `.agents` directory.

## Where Behavior Lives

This README is only the package overview. Installed behavior is documented in
the files delivered to each consumer repository:

- `AGENTS.md` for durable repository policy
- `.agents/skills/wiki/SKILL.md` for `$wiki` workflow mechanics
- `wiki/` for project-specific knowledge
