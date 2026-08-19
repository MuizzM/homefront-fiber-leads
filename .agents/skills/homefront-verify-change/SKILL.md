---
name: homefront-verify-change
description: Validate Homefront Fiber Leads code, tests, builds, deployment guards, and agent-harness files after implementation or before a pull request. Use for requests to test, verify, finish, validate, prepare, or check a Homefront change.
---

# Verify a Homefront change

1. Inspect `git status --short` and the final diff. Separate unrelated user changes from the task.
2. Choose the smallest credible level:
   - `harness`: instruction, skill, custom-agent, or harness-validator changes only.
   - `focused`: normal code changes with named relevant test paths.
   - `full`: cross-cutting, scanner, auth, tenant, migration, commission, onboarding, dependency, CI, or deployment changes.
3. Run `bash scripts/agent-verify.sh <level> [test paths...]`.
4. If a check fails, diagnose the real cause. Do not weaken a gate or rewrite a test merely to obtain green output.
5. Report each command, result, skipped check, and environment limitation.

For `focused`, pass every relevant Vitest path. If the affected behavior cannot be isolated confidently, use `full`.
