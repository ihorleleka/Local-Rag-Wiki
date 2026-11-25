# Wiki Kit

Managed files for this repository's project wiki. They are replaced on update;
don't edit them by hand. Your own skills under `skills/` are kept.

Update from the repository root:

```bash
.agents\update-wiki-kit.cmd --force      # Windows
sh .agents/update-wiki-kit.sh --force    # macOS / Linux
```

The update uses the same package source as the original install (recorded in
`.wiki-kit-install.json`); set `WIKI_KIT_PACKAGE` only to change it.

If the `wiki_*` tools are missing in an agent session, see
`skills/wiki/references/recovery.md`. Usage, troubleshooting, and configuration:
https://github.com/ihorleleka/Local-Rag-Wiki
