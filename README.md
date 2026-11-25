# local-rag-wiki

A small, searchable project wiki for AI coding agents. Your repository keeps
short Markdown notes about contracts, decisions, rules, and runbooks in `wiki/`;
agents search them before making decisions and update them when those things
change. Search runs in a local Docker container, one per repository.

Works with Claude Code, Codex, OpenCode, VS Code, and DeepSeek Harness.

## Requirements

- Node.js 18 or newer (for `npx`)
- Docker Desktop or another Docker engine

## Install

From your repository root, with Docker running:

```bash
npx github:ihorleleka/Local-Rag-Wiki install .
```

This adds a `wiki/` folder, a short section in `AGENTS.md` (imported by
`CLAUDE.md`), the `wiki` skill, and `wiki-manager` MCP entries for each supported
client. Your existing instructions and MCP servers are kept. Commit the result.

Then open a new agent session in the repository root and check that the
`wiki_*` tools are listed (`/mcp` in Claude Code). Accept the project MCP trust
prompt if your client shows one.

## Day-to-day use

You mostly don't need to do anything: agents load the `wiki` skill when a
decision depends on project knowledge. In Claude Code you can also type `/wiki`;
other clients use `$wiki`.

Good notes are short (about 60-100 lines) and record what is expensive to
rediscover from code:

- contracts between components and why they exist
- architectural decisions and their consequences
- rules every change must follow
- operating procedures and costly debugging findings

Most commits need no wiki change. Ask your agent to update the wiki when a
contract, decision, or rule changes, and to check note health with:

```bash
npx github:ihorleleka/Local-Rag-Wiki schema-report .
```

## Update

From inside the repository (no `npx` needed):

```bash
.agents\update-wiki-kit.cmd --force      # Windows
sh .agents/update-wiki-kit.sh --force    # macOS / Linux
```

## Troubleshooting

```bash
npx github:ihorleleka/Local-Rag-Wiki status .
npx github:ihorleleka/Local-Rag-Wiki doctor . --live
npx github:ihorleleka/Local-Rag-Wiki restart .
```

- **`wiki_*` tools missing:** start the service with `start .`, then open a new
  session (or reconnect with `/mcp`). Clients read MCP config from the folder
  they start in, so open the repository root, not a parent folder.
- **"Warming up" errors:** the container is still starting (the first start
  downloads an ~80 MB model). Retry in a minute.
- **Slow first call after a reboot:** use `start . --keep-warm` to keep the
  container running across restarts.
- **Search without MCP:** `npx github:ihorleleka/Local-Rag-Wiki search . "<query>"`.

`start .`, `stop .`, and `pull .` work the same way.

## DeepSeek Harness

Install the bundle once into the DSH profile you use, then restart it:

```bash
dsh plugin --profile web add github:ihorleleka/Local-Rag-Wiki
```

Open an installed repository as the workspace. The wiki tools appear on the first
prompt, and relevant notes are suggested automatically; prefix a prompt with
`$wiki ` to always search.

## More

- [Technical reference](./docs/technical.md): what each installed file does,
  container behavior, health signals, configuration, DSH internals, development.
- [kb-service](./kb-service/README.md): the search service and its tools.

## License

MIT (see [kb-service/LICENSE](./kb-service/LICENSE)).
