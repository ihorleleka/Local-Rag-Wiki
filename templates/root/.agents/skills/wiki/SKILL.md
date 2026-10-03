---
name: wiki
description: Decision-sensitive repository knowledge retrieval, authoring, maintenance, and trust audits using wiki-manager when available or an explicit local-file fallback. Use when repository knowledge could change a non-trivial decision or when the user mentions wiki, knowledge base, packets, schema reports, or wiki_* tools.
---

# Wiki

`wiki/` notes are authored sources; packets are generated retrieval artifacts.
Never edit generated packets. This skill owns knowledge workflow guidance;
[authoring guidance](references/authoring.md) owns write-back eligibility, note
structure, and safe writes. Load that reference only when considering write-back,
initializing, capturing, or changing notes, or auditing their authoring quality.

## Establish Available Capabilities

At first relevant use in each agent, inspect the tools actually exposed. If tool
discovery exists, make one focused discovery attempt for missing wiki tools.
A server configuration or a parent's access does not prove this agent has access.
Do not repeatedly probe an unchanged environment or start/install/reconfigure a
service merely to satisfy a retrieval step.

Choose the mode for the operation:

| Mode | When | Available guarantees |
|---|---|---|
| Managed | The needed native wiki tools are exposed and callable | Only the read, search, schema, or guarded-write capabilities actually exercised |
| Local-file | Required tools are absent or the service is unavailable | Direct source inspection and local checks; no managed indexing or atomic write guarantee |

The managed tools are `wiki_search`, `wiki_read`, `wiki_list`, `wiki_tree`,
`wiki_schema_report`, `wiki_write`, `wiki_capture`, `wiki_delete`, and `wiki_rename`.
Use available native operations; a missing write tool need not prevent native
reads. In local-file mode, use scoped file search/read and normal repository
tools. Before any write, follow the authoring reference's mode-specific safeguards.

If managed tools become available later, validate affected notes and confirm a
read/search reflects the latest content before trusting indexed results. Do not
wait for an unobservable watcher or claim freshness from elapsed time alone.

## Choose the Operation

- **Retrieve:** answer an uncovered decision-relevant question using the route below.
- **Initialize, maintain, or capture:** load the authoring reference and apply its
  eligibility checks before planning a write.
- **Audit:** use the audit route below; load authoring guidance when assessing
  note structure or evidence quality.

Retrieval and audits are read-only unless fixes are requested or meet authoring
eligibility. A search miss alone is not evidence that a new note is warranted.
Do not load authoring guidance for routine retrieval.

## Retrieve and Prepare a Decision Brief

1. Name the unanswered decision and the information needed to settle it.
2. In managed mode, shape `wiki_search` around each information need using the
   matrix below; scope by `path_prefix` only when the owner subtree is known.
   For unfamiliar scope, use `wiki_tree` and abstract search to select owners,
   then packets. Read full notes for insufficient packets, conflicting claims,
   or critical security/operational decisions.
3. In local-file mode, locate the likely owner with a bounded path/content
   search, then read relevant sections. Do not replace packet retrieval with
   a full wiki dump.
4. Stop when sufficient relevant owners settle each decision (usually 1-3 per
   decision, not a cap for the whole task). After an honest miss for an information
   need, try at most one better focused query, then inspect code instead of search
   looping.
5. Corroborate decision-critical, stale, incomplete, or contradictory claims
   against source or scoped execution evidence. When present, inspect
   `schema_health`, `freshness_state`, `evidence_state`, `verification_required`,
   `last_verified`, and `gaps`; these signals are not proof of behavior.

### Query Shape and Starting Budget

Split by information need, not word count. A mixed query makes unrelated topics
compete in one ranking; increasing `top_k` does not ensure coverage of each topic.
Conversely, splitting a coherent relationship can lose the context needed to
retrieve its contract. These are starting heuristics, not measured guarantees
that three searches outperform one.

| Information need | Starting search shape | Why |
|---|---|---|
| One known fact or canonical owner | One focused query, `top_k: 1-2`, packet depth | Avoid unrelated context; read the known note directly when its path is available. |
| A few distinct decisions, such as ownership, expected behavior, and verification requirements | One focused query per uncovered need; usually 2-3 queries, `top_k: 2-3` each, packet depth | Give each need its own retrieval budget rather than one keyword pile with `top_k: 8-10`. |
| One cross-boundary relationship, such as a producer/consumer contract | One query naming both sides and the relationship, `top_k: 3` | Preserve the shared contract; split only if a specific side remains uncovered. |
| Unfamiliar repository or unclear ownership | `wiki_tree` plus one coherent orientation query, `depth: "abstract"`, `top_k: 3`; widen to `6-8` if several owners must be mapped | Scan cheaply before loading selected packets; a larger single search is for coverage of one map, not unrelated questions. |
| One coherent review needing several related owners, such as constraints on changing a shared interface | One focused query, `depth: "abstract"`, `top_k: 6-8`, then selected packets/full notes | A wider candidate set can help when all owners inform the same decision; target uncovered subquestions afterward. |

Phrase each query as a clear information need using the project's terminology:
`<component> ownership and dependency constraints`, `<operation> expected failure behavior`,
or `<change> verification requirements`. Search these separately only when they
are distinct unanswered questions. Keep `<producer> <consumer> shared contract`
together when the relationship itself is the question.

Run independent searches concurrently only when supported; sequence searches
that depend on discovered terminology or owners. Deduplicate by canonical
source/path, retain which need each source supports, and check coverage per need
rather than counting hits or comparing relevance scores across queries. Three
searches with `top_k: 3` return up to nine candidates, not necessarily nine unique
owners or the same cost as one search with `top_k: 8`. Use abstracts for wide scans
and load only decision-relevant packets/full notes. Do not fan out into every
possible topic or widen results to hide a poor query. Apply the same
information-need split to bounded local-file search/read; native ranking and
depth controls are unavailable there.

### Handoff Format and Evidence Records

Pass sufficient context to delegated workers instead of requiring duplicate
retrieval. The lead consolidates findings; workers return evidence and candidate
knowledge unless explicitly assigned a distinct wiki owner.
Structure the decision brief with:

- **Decision and constraints:** what must be decided/preserved, with canonical note IDs or paths.
- **Evidence:** relevant code anchors, approved decisions, and verification scope.
- **Open questions:** what remains unverified and who can resolve it.
- **Invalidation:** changes to contracts, source, configuration, or evidence that require refresh.

Keep it to relevant facts, not another copy of all policies. Store the brief in
working context or task records, not a new wiki note by default.

Distinguish approved decisions, code observations, scoped execution results,
and unverified reports. Approval is not implementation or runtime acceptance;
a delegated summary needs accessible supporting evidence before it is verified.

For execution claims, retain the command, relevant version/configuration/feature
scope, source snapshot or run identity, result, and a retrievable diagnostic
record in the execution workspace. Recover missing evidence or reproduce the
check when the next decision requires it. Readiness gates belong to the owning
implementation workflow; the wiki does not replace them.

## Audit

State the audit question and evidence scope. In managed mode, sample real
queries for owner relevance, honest misses, freshness, and response size. In
local-file mode, audit note content and navigation; do not assess an unexercised
search engine's ranking quality.

Judge usefulness by decisions improved, repeated mistakes avoided, unnecessary
inspection reduced, and claims reproducible across sessions, not note/search
counts. Separate documentation problems from tool delivery, execution quality,
and task acceptance problems. Report proposed fixes separately from applied ones.

## Completion

At completion of substantive work where repository knowledge was relevant,
consider whether durable findings need write-back; load authoring guidance if
needed to decide or act. Report once: `wiki updated: <notes>` or
`no wiki write-back warranted: <reason>`. Do not impose this report on unrelated
or trivial work. Mention retrieval only when it changed the outcome, constrained
work, or exposed a durable gap; do not repeat status after routine worker updates.
Disclose relevant capability and verification limits, including checks not run.
Never claim indexing, schema validation, or concurrency guarantees not exercised.
Workers return these details to their lead for consolidated reporting.
