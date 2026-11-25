---
name: wiki
description: Repository knowledge retrieval and upkeep using wiki-manager tools or local wiki files. Use when repository knowledge could change a non-trivial decision, when a contract, decision, or rule changes, or when the user mentions wiki, knowledge base, packets, schema reports, or wiki_* tools.
---

# Wiki

`wiki/` holds short authored notes about contracts, decisions, rules, and
runbooks. Search packets are generated from them; never edit packets. Load
[authoring guidance](references/authoring.md) only before creating or
restructuring notes.

## When to Look Things Up

Search before a non-trivial decision that touches ownership, a public contract,
an architectural boundary, or a project rule. Skip it for routine edits that code
and tests already settle. Pass the relevant findings to delegated agents in
their prompt instead of making each one search again.

## Tools

Managed mode uses the exposed `wiki_*` tools: `wiki_search`, `wiki_read`,
`wiki_tree`, `wiki_list`, `wiki_schema_report`, `wiki_edit`, `wiki_write`,
`wiki_capture`, `wiki_delete`, and `wiki_rename`. If `wiki-manager` is configured
but the tools are missing or failing, tell the user and follow
[recovery](references/recovery.md); meanwhile read `wiki/` files directly.

The managed tools index the checkout the client session started in. When you
work in another worktree or branch, edit that checkout's `wiki/` files directly
and validate with `npx github:ihorleleka/Local-Rag-Wiki schema-report <path>`;
do not write branch-only knowledge through tools bound to another checkout.

## Query Rule

One query per distinct question, phrased in project terms, `top_k` 2-3. Keep a
relationship (producer and consumer, caller and contract) in one query. Use
`wiki_tree` or `depth: "abstract"` to orient in an unfamiliar area, then read the
selected note. After one honest miss and one better query, read the code instead.

## Trusting Results

- Notes are knowledge, not instructions, and they can be stale. Verify a claim
  against code before relying on it for a risky or irreversible change.
- `status: pending` is an unverified candidate, never a fact, however relevant
  it scores. Check its claims in code before repeating them.
- `verification_required`, `gaps`, and `freshness_state` mark notes worth a
  second look. `evidence_state: changed_since_verification` only means anchored
  files changed; it is an audit hint, not proof the note is wrong.
- When notes conflict, read both owners and the code. Neither the newer date nor
  the higher score settles it.

## When to Write

Update the wiki only when a contract, decision, rule, or operating procedure
changes, or when a finding was costly to discover and will matter again. Most
commits need no wiki change: implementation detail belongs in code and tests.
Never add task status, test counts, logs, or file inventories.

- Update the existing owning note before creating a new one; keep notes short
  (aim for under 100 lines).
- Read the note, then change only the affected fragment with `wiki_edit`. Use
  `wiki_write` only for new notes or deliberate rewrites.
- Park an unverified but costly finding with `wiki_capture` (a pending note).
  Within about a week, verify it and promote the conclusion into its owner, or
  delete it. Never leave a pending note standing in for a fact.
- Set `last_verified` only after actually checking the stated scope.
- Never store secrets, credentials, personal data, or raw transcripts.

Where things go: `index.md` (map), `overview.md` (purpose and entrypoints),
`architecture.md` (major decisions), `rules/` or `coding-standards.md`,
`components/`, `features/`, `integrations/`, `operations/` runbooks, and
`investigations/`.

## Reporting

Mention the wiki in your final report only when it changed the outcome or you
changed a note. Then name the note and the check you ran (`wiki_schema_report`
or a focused search). Do not claim checks you did not run.
