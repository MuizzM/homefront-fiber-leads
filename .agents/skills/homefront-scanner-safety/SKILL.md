---
name: homefront-scanner-safety
description: Design, change, debug, or review Homefront Kinetic/Decodo scanning, fresh-fiber discovery, market monitoring, new-build radar, provider transport, retries, queues, budgets, or geographic scope. Use whenever scanner behavior, provider calls, bot-wall responses, concurrency, scan spend, or discovered leads are involved.
---

# Change scanner behavior safely

1. Read the relevant scanner and operations documentation under `docs/`, then trace the real path from admission through provider transport, projection, persistence, and lead visibility.
2. Record the authorization source, tenant boundary, geographic scope, queue owner, retry bound, concurrency bound, spend bound, and stop condition.
3. Treat CAPTCHA, non-JSON challenges, ambiguous authorization, and provider-policy responses as stop conditions. Never add challenge evasion or an unbounded identity-rotation loop.
4. Keep paid or external work behind server-side authorization and operational feature gates. UI controls are not sufficient.
5. Preserve immutable super-admin semantics and ordinary-user tenant isolation for state, progress, results, and streams.
6. Add focused tests for success, denial, retry exhaustion, tenant separation, duplicate prevention, and accounting accuracy.
7. Use an ExecPlan for cross-cutting scanner work and finish with `$homefront-verify-change` at `full` level.
