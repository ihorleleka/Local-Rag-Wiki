---
id: evaluation-development-runbook
kind: runbook
scope: test-fixture
last_verified: 2026-07-18
status: active
applies_to: [build, test, run, troubleshooting]
---
# Development runbook
## Use this when
Installing, building, testing, running, or troubleshooting the solution locally.
## Steps
1. Restore dependencies.
2. Run the production build.
3. Run focused tests, then the complete verification suite.
4. Start the local runtime and inspect health before debugging failures.
## Do not
- Do not report success when a required verification command failed.
## Evidence
- generated: synthetic evaluation fixture
## Retrieval hints
verified local workflow, build, test, run, troubleshoot
