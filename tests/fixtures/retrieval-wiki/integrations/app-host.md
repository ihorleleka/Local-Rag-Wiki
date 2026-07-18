---
id: evaluation-app-host
kind: reference
scope: test-fixture
last_verified: 2026-07-18
status: active
applies_to: [application-host, SQL, object-storage, init-containers]
---
# Application host orchestration
## Use this when
Changing application-host provisioning, SQL, object storage, startup bundles, or init-container dependencies.
## Summary
The application host provisions SQL and object storage, wires their references into the web service, generates startup bundles, and makes the web service wait for required init containers.
## Key facts
- Readiness dependencies are explicit.
- Startup bundles are generated before the dependent service begins.
## Evidence
- generated: synthetic evaluation fixture
## Retrieval hints
application host provision SQL object storage startup bundle init-container dependency
