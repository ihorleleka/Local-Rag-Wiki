# Wiki Authoring Reference

Load this reference only for Initialize, Migrate, or non-trivial Maintain work.

## Specificity And Generalization

Choose the target before drafting:

- **Wiki-Kit-generic:** reusable across unrelated repositories; exclude consumer
  names, domain wording, frameworks, and incidental paths.
- **Project-wide:** a repository invariant independent of the task that exposed it.
- **Capability-specific:** exact behavior owned by one feature, component,
  integration, API, or workflow; preserve public labels and contract terms.
- **Instance evidence:** a bug, task, file, or example supporting a claim, not a rule by itself.

Extract the invariant, name its scope/non-goals, and test it against a materially
different scenario. Narrow it or keep it as evidence when it does not generalize.

## Note Scope And Size

One note should own one retrievable capability, component, contract,
integration, decision, rule, runbook, glossary area, or cross-cutting concern.

- Target under 150 lines/1,500 words for focused notes.
- Split before `KB_NOTE_MAX_LINES` (default 200), more than eight top-level
  sections, or `KB_EVIDENCE_MAX_ANCHORS` (default 12) when cohesion is weakening.
- Split when different searches need unrelated sections, evidence dominates,
  kinds are mixed, or one packet cannot answer a routine owner query coherently.
- Keep a short parent map responsible for summary, boundaries, links, and hints.

## Typed Notes

Frontmatter:

```yaml
---
id: stable-note-id
kind: reference
scope: project-specific
last_verified: YYYY-MM-DD
status: active
applies_to:
  - domain-or-component
---
```

Canonical shapes:

- `rule`: `Use this when`, `Rule`, `Do`, `Do not`, `Evidence`, `Retrieval hints`.
- `decision`: `Use this when`, `Decision`, `Rationale`, `Consequences`, `Evidence`, `Retrieval hints`.
- `reference`: `Use this when`, `Summary`, `Key facts`, `Evidence`, `Retrieval hints`.
- `runbook`: `Use this when`, `Steps`, `Do not`, `Evidence`, `Retrieval hints`.
- `glossary`: `Terms`, `Aliases`, `Retrieval hints`.
- `investigation`: `Use this when`, `Context`, `Findings`, `Eliminated approaches`,
  `Scope and completeness`, `Evidence`, `Retrieval hints`.

Use `investigation` for outcomes that are non-obvious and expensive to recover: debugging
root causes, confirmed negative results (audits with a clear scope that found nothing),
eliminated approaches with reasoning, library or environment quirks, and bounded compatibility
findings. State scope and completeness explicitly so future agents know what the investigation
covered and what it did not. Keep findings as observed facts; promote them to `rule` or
`decision` only when they generalize. `wiki_capture` emits a pending `investigation` note as a
mid-task stash; treat those as unverified candidates and, on a later Maintain/Audit pass, verify
their evidence and either activate/promote them or delete them.

Do not flatten mandatory rules into references or mix several kinds to avoid
choosing ownership. Use repository-relative files/directories, public symbols,
focused tests, refactors, tickets, or user confirmations as bounded evidence.

## Evidence Levels

Keep the basis and certainty of a claim explicit in the note's prose; no new
frontmatter fields are required:

- **Approved decision:** authorized contract or policy, with its source and scope;
  not proof that implementation or acceptance exists.
- **Code observation:** supported by named source anchors and applicable versions;
  not proof that an execution path succeeded.
- **Executed verification:** exact check, relevant configuration/feature scope,
  and reproducible evidence; not a timeless statement about the current branch.
- **Reported finding:** a delegated/external assertion whose supporting evidence
  is missing or not yet established. Do not silently promote it to verified.
- **Synthesis:** cross-source pattern derived from multiple compatible observations.
- **Inference:** reasoned conclusion not directly stated; explain why it follows.
- **Hypothesis:** plausible but unverified explanation; keep it as open follow-up.

Do not present inference as direct fact, correlation as causation, or repeated
claims as independent corroboration. A worker's report can support a claim when
its evidence is accessible and its scope is clear; a status label alone cannot.
Set `last_verified` only for an actual verification of the stated scope, not
because wording or formatting changed.

## Durable Knowledge vs Execution State

| Content | Home |
|---|---|
| Stable contract, ownership boundary, approved decision | Canonical wiki owner |
| Reproducible command, prerequisites, version constraint, failure diagnosis | Runbook or focused investigation |
| Current task queue, patch readiness, pass/fail counts, active blocker | Execution plan or session records |
| Raw logs, run IDs, temporary diagnostics, working decision briefs | Execution workspace |
| Costly unresolved finding with evidence and a verification path | Pending investigation |

Retain execution evidence until the owning acceptance decision is resolved.
Wiki notes retain the reusable conclusion and reproducible verification path,
not machine-local log paths. A durable historical test claim needs a bounded
source/version and check scope; if that cannot be stated, keep the outcome in
execution records instead.

Good: "For version X, the editor stores a JSON array even when it publishes one
string; the converter and named regression test establish the contract."
Avoid: "The build currently passes; component Y is awaiting another run."

## Capability Specifications

Use an extended `reference` when future agents need to understand or reconstruct
a delivery unit without repeating discovery. Include concrete retrieval
triggers, verified behavior/contracts, boundaries, evidence, verification, and
explicit open questions for partial coverage.

Supported sections include `Capability contract`, `Behavior model`,
`Interaction model`, `Architecture boundaries`, `Data and integration
contracts`, `Quality attributes`, `Acceptance and verification`,
`Reconstruction guidance`, `Evidence`, `Open questions`, and `Retrieval hints`.
Once using the extended shape, include at least `Capability contract`,
`Architecture boundaries`, and `Acceptance and verification`.

Prefer stable owner directories, public symbols, and focused tests over
file-by-file inventories. Repository inspection validates declared anchors;
routine retrieval does not require reopening them all.

## Canonical Homes

Use this as a menu, not a checklist:

- `index.md`: active-note map and routing.
- `overview.md`: repository purpose, runtime, entrypoints, dependencies.
- `architecture.md`: major decisions and consequences.
- `coding-standards.md` or `rules/<topic>.md`: mandatory behavior.
- `development-runbook.md` or `operations/<topic>.md`: repeatable procedures.
- `features/<name>.md`: business/user-facing capabilities.
- `components/<name>.md`: modules, domains, services, reusable components.
- `integrations/<name>.md`: external systems/protocols/adapters.
- `investigations/<topic>.md`: debugging outcomes, confirmed negative findings, eliminated
  approaches, compatibility findings, and scoped audit results.
- `api/<area>.md`, `data/<area>.md`, `ui-patterns.md`, and `glossary.md` for their focused concerns.

An initial index is navigational, not evidence of coverage: link only active
verified owners and identify material gaps or open questions.

## Write-Back Planning

1. Separate durable findings from execution state and map each retained topic to
   its smallest authoritative owner. Correct decision-changing errors promptly;
   batch other changes at coherent milestones.
2. Update existing owners first. Split genuinely distinct contracts, rather than
   accumulating all discoveries in a runbook or incident note.
3. Reconcile delegated evidence through the lead. Unresolved claims belong in
   `Open questions` or a pending investigation, not accepted capability summaries.
4. Follow the skill's initialization timing and mode-specific validation. A
   baseline needs verified orientation and coverage limits, not a file inventory.
5. A no-write decision needs a reason in the delivery summary, not a new note.

## Change Artifacts And Durable Ownership

Treat proposals, task plans, design drafts, and completed-change archives as
change-oriented artifacts, regardless of which tool or directory owns them.
They explain intent and history but are not automatically authoritative for
current behavior after implementation and verification.

At completion, update the canonical owner, confirm it is already accurate, or
explain why no write-back is warranted. Link to an active artifact only while it
remains authoritative; do not copy its current status into the wiki. Reconcile
conflicting contracts instead of requiring readers to compare histories.

## Distillation And Graph Quality Gates

When a maintain/audit update synthesizes multiple notes, ensure the result is
durable knowledge rather than source-by-source narration:

- state the analytical question or retrieval objective up front;
- preserve evidence levels, uncertainty, contradictions, and coverage limits;
- keep identities and aliases consistent across owners;
- make relationship claims directional and evidence-backed (who depends on what,
  what governs what, what changed and why);
- give material claims bounded evidence rather than a source-by-source dump;
- keep maps navigational and contracts in one authoritative owner.

## Final Quality Gate

Before completing non-trivial authoring or maintenance, verify that:

- each changed note has valid frontmatter and a canonical shape for its kind;
- each major claim links to exact evidence at the right granularity;
- contradictions, scope limits, and stale sections are made explicit;
- terminology, aliases, and public names are consistent across linked owners;
- each changed note remains concise and retrieval-friendly (no source dump);
- managed mode: schema validation and focused retrieval confirm the intended behavior;
- local-file mode: frontmatter/shape, links, evidence, and diffs are checked;
  server schema/index verification is explicitly unperformed.
