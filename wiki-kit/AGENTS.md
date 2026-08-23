# Wiki-Kit Repository Agent Guide

## Purpose

This repository packages the local agent wiki-kit for a Docker-backed `wiki-manager` MCP server. It does not own wiki content or the core indexing service. It owns the installer, generated repository assets, the managed `$wiki` skill, MCP/editor configuration templates, wrapper scripts, package documentation, and verification wiki-kit.

This `AGENTS.md` is for agents working on this wiki-kit repository only. It is not installed into consumer repositories. Consumer-facing agent policy lives at `templates/root/AGENTS.md`.

## Repository Map

- `bin/wiki-kit.js`: install/update/status/doctor CLI. It copies the managed payload, rewrites runner directory references, preserves user-added skills, removes legacy split skills, writes `.wiki-kit-install.json`, and reports local install health.
- `templates/root/`: source of files installed into consumer repositories.
- `templates/root/AGENTS.md`: generated consumer repository agent policy.
- `templates/root/.agents/skills/wiki/SKILL.md`: managed `$wiki` workflow delivered to consumers.
- `templates/root/.agents/run-wiki-manager.mcp.js`: Docker-backed MCP runner entrypoint delivered to consumers.
- `templates/root/.claude`, `templates/root/.codex`, `templates/root/.vscode`, `templates/root/opencode.jsonc`: editor and agent MCP configuration templates.
- `templates/root/wiki/.gitkeep`: creates the consumer-owned wiki directory; do not add template wiki content casually.
- `scripts/verify.js`: smoke verification for install/update/status behavior, custom `--agents-dir`, generated MCP references, install marker metadata, and `npm pack --dry-run`.
- `.artifacts/`: generated verification output. Treat as disposable and do not edit source behavior there.
- Root `.agents/`: local workspace directory only when present. It is not the canonical packaged payload.

## Change Boundaries

Keep root-local and consumer-delivered guidance separate:

- Edit this file for wiki-kit contributor/agent operating rules.
- Edit `templates/root/AGENTS.md` for policy that should be installed into consumer repositories.
- Edit `templates/root/.agents/skills/wiki/SKILL.md` for the consumer `$wiki` workflow mechanics.
- Edit `README.md` when package behavior, install/update semantics, delivered guidance, or verification expectations change.

Do not make behavior changes only in generated `.artifacts` output. Make changes in `templates/root`, `bin/`, or `scripts/`, then verify.

Do not add consumer wiki notes to this package unless the package intentionally starts shipping starter wiki content. The current contract is that wiki content is consumer-owned.

## Installer Rules

Preserve the installer contract:

- Install/update must preserve user-added skill directories under `<agentsDir>/skills`.
- The managed wiki skill is replaceable by the wiki-kit.
- Legacy split skills are intentionally removed: `retrieve-knowledge`, `initialize-wiki`, `migrate-wiki`, and `wiki-maintenance`.
- Root assets are overwritten only with `--force`.
- `--agents-dir` must remain a portable direct-child directory name that works on Windows, macOS, and Linux.
- MCP config references must be rewritten when `--agents-dir` is custom.
- The runner directory must remain a direct child of the consumer repository because the MCP runner resolves its parent as the project root.

When changing copy/rewrite logic, check both default `.agents` installs and custom `--agents-dir` installs.

## Template Rules

Treat `templates/root` as an installable product surface:

- Keep delivered instructions concise, professional, and implementation-neutral.
- Avoid repository-specific assumptions from this wiki-kit repo in consumer templates.
- Keep workflow mechanics in the `$wiki` skill and durable consumer policy in `templates/root/AGENTS.md`.
- Keep installed `.agents/README.md` short and consumer-facing.
- Keep path examples portable where practical; include Windows and POSIX command variants when users need both.
- Avoid absolute local paths in README examples, delivered templates, and wiki guidance. Consumer repositories may be cloned into different locations, so committed guidance should use repository-relative paths.
- Do not create placeholder notes, broad topic inventories, or unimplemented wiki workflows in templates.
- Abstract consumer-derived lessons before adding them to templates: state the repository-independent failure mode and invariant, then test the wording against a materially different scenario. Keep project-only findings in the consumer repository.
- Prefer placeholders such as `<capability>`, `<component>`, and `<generated-file>` in generic mechanics. Preserve exact names only for this wiki-kit's own interface, layout, commands, or verification fixtures.

When adding or renaming delivered files, update installer behavior, verification, README layout documentation, and package contents as needed.

## Documentation Standards

The README is package documentation. It should describe what the wiki-kit installs, how update behavior works, how verification works, and how consumers should refresh committed wiki-kit files.

Keep terminology consistent across:

- `README.md`
- `templates/root/AGENTS.md`
- `templates/root/.agents/skills/wiki/SKILL.md`

For wiki guidance, prefer professional architecture terms such as governed knowledge workflow, retrieval gate, typed notes, capability specifications, quality attributes, traceability, and reconstruction guidance. Avoid casual or session-specific phrasing.

## Verification

Run `npm run verify` before considering wiki-kit changes complete. It exercises the installer against scratch repositories and runs `npm pack --dry-run`.

Verification is especially required after changes to:

- `bin/wiki-kit.js`
- `scripts/verify.js`
- anything under `templates/root`
- `package.json`
- package README sections that describe install/update/packaged behavior

If verification fails, fix the source files rather than patching generated scratch output under `.artifacts`.

## Packaging

The npm package includes only paths declared in `package.json` `files`: `bin/`, `scripts/`, `templates/`, and `README.md`. Root `AGENTS.md` is intentionally not packaged or installed into consumer repositories.

Before publishing or asking users to install from GitHub, make sure the relevant changes are committed and pushed. Consumers installing with `npx github:ihorleleka/wiki-kit ...` get the GitHub ref, not uncommitted local files.

## Coding Standards

- Keep the Node CLI dependency-free unless there is a strong reason to add package dependencies.
- Prefer standard `fs`, `path`, and `child_process` APIs for installer behavior.
- Preserve cross-platform path handling. Test Windows path cases mentally even when editing on another platform.
- Avoid shell-specific assumptions in generated scripts and README commands.
- Keep destructive filesystem operations scoped to known target directories. Do not remove arbitrary consumer paths.
- Keep installer errors actionable and specific.
- Update verification when adding behavior that can regress.

## Git and Generated Output

The worktree may contain user changes. Do not revert changes you did not make.

Ignore `.artifacts/` unless inspecting verification output. It is generated by smoke tests and ignored by git.

When reviewing diffs, pay special attention to whether a change affects:

- consumer root assets;
- managed `.agents` payload;
- custom `--agents-dir` rewriting;
- root overwrite behavior with and without `--force`;
- package contents.

## Wiki Status For This Repo

This wiki-kit repository does not currently rely on its own `wiki/` content. For normal wiki-kit changes, report `Wiki: no update needed - wiki-kit guidance/package code changed` unless an actual repository wiki is introduced later.

