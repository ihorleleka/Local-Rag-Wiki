# Wiki Authoring Reference

Load this before creating, restructuring, or auditing notes. Small updates to an
existing note only need the rules in the skill.

## What Belongs in the Wiki

Keep knowledge that is expensive to rediscover from code: contracts between
components, approved decisions and their reasons, mandatory rules, operating
procedures, and confirmed findings from costly investigations. Leave out
implementation detail that code and tests already state, file inventories, task
status, and anything that changes on most commits.

One topic has one owning note. Update the owner instead of adding a second note,
and do not redefine policy, ownership, or product behavior without authority.

## Note Shape

Frontmatter (all fields required except `applies_to`):

```yaml
---
id: stable-note-id
kind: reference
scope: project-specific
status: active
last_verified: YYYY-MM-DD
applies_to:
  - component-or-domain
---
```

Required `##` sections by `kind`; a note missing them still indexes but is
reported as incomplete:

- `rule`: Use this when, Rule, Do, Do not, Evidence, Retrieval hints.
- `decision`: Use this when, Decision, Rationale, Consequences, Evidence, Retrieval hints.
- `reference`: Use this when, Summary, Key facts, Evidence, Retrieval hints.
- `runbook`: Use this when, Steps, Do not, Evidence, Retrieval hints.
- `glossary`: Terms, Aliases, Retrieval hints.
- `investigation`: Use this when, Context, Findings, Eliminated approaches,
  Scope and completeness, Evidence, Retrieval hints.

A note without frontmatter or recognizable sections does not compile into a
search packet; `wiki_schema_report` lists it as `packet_not_compiled`.

Size: aim for 60-100 lines; split before 200 lines (`KB_NOTE_MAX_LINES`) or when
different questions need unrelated sections. A note that grows into a list of
every class or endpoint is an inventory: keep the contract and point at code.

## Evidence Anchors

Evidence lists the few repository locations that back the note's claims. The
service checks that they exist and reports when they change.

- Prefer specific files, public symbols (`path/to/File.cs#TypeName`), and
  focused tests. Up to about five anchors is typical; more than 12 is flagged.
- Avoid anchoring to whole directories, globs, and high-churn files such as
  composition roots or shared configuration. Directory and glob anchors are
  tracked only for files being added or removed, not content edits.
- A changed anchor is a hint to re-check the claim during an audit, not a
  failure. When you re-check and the note still holds, bump `last_verified`.

## Status and Freshness

- `pending`: unverified candidate, usually from `wiki_capture`. Resolve within
  about a week (`KB_PENDING_MAX_DAYS`, default 7): verify and promote the
  conclusion into its owner, or delete it. Overdue pending notes are reported.
- `active`: current, verified owner.
- `superseded`: kept as history; link the replacement and say what changed.
- `deprecated`: no longer applies; say why.

Age warnings (`KB_STALENESS_DAYS`, default 90) apply only to `rule` and
`decision` notes (`KB_STALENESS_KINDS`), because those are the notes whose
silent aging misleads. Set `last_verified` only after checking the claim.

## Writing Safely

- Managed mode: `wiki_read` the note, then `wiki_edit` with a unique fragment
  copied from it. Line-ending differences (CRLF vs LF) are tolerated; other
  whitespace must match. On `text_not_found` or `ambiguous_match` nothing was
  written: re-read and retry with more context instead of rewriting the note.
- Use `wiki_write` for new notes or deliberate rewrites, and `wiki_delete` or
  `wiki_rename` for path changes; both refuse while other notes link to the path.
- Search results reindex in the background after a write; `wiki_read` always
  returns the file on disk.
- One writer per note. Delegated agents return findings to the lead, which
  writes them.
- Local-file mode (or another worktree): edit files directly, keep the shape
  above, and validate with `npx github:ihorleleka/Local-Rag-Wiki schema-report <path>`.

## Audits

When asked to audit, sample real questions and check that the right owner comes
first, that pending notes are resolved, and that error-level schema findings are
fixed. Warnings and info findings are prompts for judgment, not a cleanup quota.
Report proposed fixes separately from applied ones.
