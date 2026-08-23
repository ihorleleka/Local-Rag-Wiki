---
id: evaluation-coding-standards
kind: rule
scope: test-fixture
last_verified: 2026-07-18
status: active
applies_to: [Hero, converters, dependency-injection, generated-models]
---
# Coding standards
## Use this when
Adding a Hero element converter, dependency-injection key, or generated model mapping.
## Rule
Hero converters live in the feature conversion layer, use the content alias as their keyed DI identity, and map only declared generated model properties.
## Do
- Regenerate models before compiling converter changes.
## Do not
- Do not hand-edit generated model classes.
## Evidence
- generated: synthetic evaluation fixture
## Retrieval hints
Hero converter ownership, keyed dependency injection, generated model properties
