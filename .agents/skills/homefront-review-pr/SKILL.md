---
name: homefront-review-pr
description: Review a Homefront Fiber Leads branch or pull request for correctness, security, tenant isolation, business-rule regressions, and missing tests. Use for PR review, branch review, pre-merge assessment, or requests to inspect changes in parallel.
---

# Review a Homefront change

1. Resolve the base and head refs and inspect the complete diff.
2. For cross-cutting changes, run independent read-only reviews in parallel:
   - `code_mapper`: execution path and affected contracts.
   - `security_reviewer`: tenant, authorization, privacy, provider, and abuse boundaries.
   - `test_reviewer`: coverage and failure-path gaps.
   - `product_guard`: field-sales behavior and operator impact.
3. Wait for every delegated review and verify each finding against the current code.
4. Deduplicate findings and rank them by user impact: critical, high, medium, or low.
5. Lead with actionable findings including file, symbol or line, failure scenario, and safe direction. Do not pad the review with style preferences.
6. If there are no material findings, state that clearly and list remaining validation or uncertainty.
