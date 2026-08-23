---
id: evaluation-serialization
kind: reference
scope: test-fixture
last_verified: 2026-07-18
status: active
applies_to: [serialization, generated-models]
---
# Serialization and generation
## Use this when
Changing serialization roots, composition order, or generated models.
## Summary
Serialization roots compose in declared order. Regenerate models whenever serialized schemas or property aliases change, before compiling consumers.
## Key facts
- Root ordering is stable and significant.
- Generated output follows schema synchronization.
## Evidence
- generated: synthetic evaluation fixture
## Retrieval hints
serialization roots compose order, regenerate generated models
