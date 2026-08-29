# Wiki Kit

This directory is the managed local runner payload for the repository wiki.

Use the wrapper here to refresh the committed wiki-kit files:

```bash
.\update-wiki-kit.cmd --force
```

On macOS or Linux:

```bash
sh ./update-wiki-kit.sh --force
```

The wrappers resolve the package source from `.wiki-kit-install.json` so updates
keep using the source that performed the install. Set `WIKI_KIT_PACKAGE` only to
override that source intentionally.

The update preserves user-added skill directories under `skills/`, replaces the
managed `skills/wiki` skill, and removes old split wiki-kit skills from earlier
versions.

The install includes integration metadata in `integrations/` and plugin catalog
metadata in `plugins/`. Project recall is provided by the governed wiki MCP
service rather than local prompt-history hooks.

Repository `AGENTS.md` instructions and editor MCP configuration are merged by
default. The update owns only the managed wiki policy section and the
`wiki-manager` MCP server entries.

The MCP entrypoint is `run-wiki-manager.mcp.js`. Repository-level agent policy
and editor MCP configuration live in the repository root.

The MCP endpoint binds to `127.0.0.1` by default because it has no built-in
authentication and includes write tools. Intentional network exposure requires
both `KB_BIND_ADDRESS` and `KB_ALLOW_NETWORK_EXPOSURE=1`; protect such exposure
with an external access-control boundary.

Default container and KB volume names include a stable hash of the canonical
repository root, so repositories with identical folder names remain isolated.
The `hf-cache` model volume stays shared. To migrate an older basename-only
index, temporarily set `KB_VOLUME=<old-repository-name>-kb-data`; explicit
`KB_CONTAINER_NAME`, `KB_VOLUME`, and `HF_CACHE_VOLUME` values take precedence.

The repository container persists independently of individual MCP clients.
Closing one client does not stop service for another. Use `wiki-kit start .`,
`wiki-kit stop .`, or `wiki-kit restart .` for explicit lifecycle control.
Concurrent clients attach to the same healthy repository container; stale or
stopped containers are recovered on the next start.

The managed runner pins a deterministic Project-Rag-Wiki image digest. Use
`wiki-kit pull .` to fetch it deliberately, then `wiki-kit restart .`. The
`wiki-kit status .` command reports the configured and running image plus its
compatibility state. `KB_IMAGE` is an explicit override and is reported as one.

Generated Codex configuration allows 75 seconds for cold MCP startup and 120
seconds for tool calls. OpenCode receives its supported 75-second MCP discovery
timeout. The live maintainer verifier uses empty KB and model-cache volumes to
exercise cold initialization.
