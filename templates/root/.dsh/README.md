# DeepSeek Harness integration

These files connect DeepSeek Harness to this repository's wiki service. They are
managed by wiki-kit and replaced on update; keep them in `.dsh/`.

They are loaded by the Local-Rag-Wiki DSH bundle, installed once per profile:

```bash
dsh plugin --profile web add github:ihorleleka/Local-Rag-Wiki
```

Don't add a separate global MCP client for `wiki-manager`; the bundle already
connects it. Details: https://github.com/ihorleleka/Local-Rag-Wiki/blob/main/docs/technical.md
