---
id: evaluation-editor-previews
kind: reference
scope: test-fixture
last_verified: 2026-07-18
status: active
applies_to: [saved-draft, editor-preview, hydration]
---
# Editor previews
## Use this when
Resolving a saved-draft editor preview or hydrating its component.
## Summary
The preview resolves the draft element alias, fetches draft values, maps them through the registered component resolver, and hydrates the matching frontend component.
## Key facts
- Preview data comes from the saved draft rather than published content.
- Unknown aliases return an explicit unsupported preview.
## Evidence
- generated: synthetic evaluation fixture
## Retrieval hints
saved draft editor preview resolve hydrate component
