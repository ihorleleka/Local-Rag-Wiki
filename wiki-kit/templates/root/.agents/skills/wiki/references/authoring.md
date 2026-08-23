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
`decision` only when they generalize.

Do not flatten mandatory rules into references or mix several kinds to avoid
choosing ownership. Use repository-relative files/directories, public symbols,
focused tests, refactors, tickets, or user confirmations as bounded evidence.

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

## Write-Back Planning

1. Apply repository write-back criteria; stop when nothing durable and verified changed.
2. List distinct durable topics and map each to its smallest authoritative owner.
3. Update existing owners when scope remains cohesive; create a focused owner
   only when useful verified knowledge lacks one.
4. Update every owner whose reusable contract changed. Do not collapse separable
   frontend, backend, API, data, operations, and quality concerns into a broad note.
5. Put useful but unverified behavior in `Open questions` or report it as follow-up.
6. Keep workflow conventions that govern a class of changes in their own owner,
   not hidden only inside one feature incident.

## Change Artifacts And Durable Ownership

Treat proposals, task plans, design drafts, and completed-change archives as
change-oriented artifacts, regardless of which tool or directory owns them.
They explain intent and history but are not automatically authoritative for
current behavior after implementation and verification.

When a change completes or its artifacts are archived, make one explicit
durable-knowledge decision: update the canonical wiki owner, confirm that it
already remains correct, or record that no durable write-back is warranted.
Link to an active artifact only when it remains authoritative; do not duplicate
whole contracts across systems. Reconcile conflicting active claims instead of
requiring future agents to compare both histories manually.
