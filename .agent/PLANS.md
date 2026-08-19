# ExecPlans

An ExecPlan is a living, self-contained design and progress record for a substantial change. Store active plans under `.agent/plans/` with a short kebab-case filename. Do not commit throwaway notes.

Use an ExecPlan when work crosses client and server boundaries, changes authentication or tenant scope, modifies scanner/provider behavior, introduces a migration, affects commissions or sensitive onboarding data, changes deployment infrastructure, or is likely to take more than one focused session.

Every plan must let a developer unfamiliar with the task continue from the repository alone.

## Required sections

1. **Outcome** — observable user or operator behavior when complete.
2. **Context** — relevant files, current behavior, terminology, and constraints.
3. **Safety invariants** — tenant, privacy, spend, provider, data, and deployment boundaries that must remain true.
4. **Milestones** — ordered, independently verifiable slices with exact commands.
5. **Progress** — timestamped checklist updated whenever work stops or changes direction.
6. **Decisions** — choices made, alternatives rejected, and reasons.
7. **Discoveries** — unexpected behavior, evidence, and resulting plan changes.
8. **Validation** — tests, builds, manual checks, and expected results.
9. **Recovery** — how to retry safely and how to recover from partial completion.
10. **Result** — final behavior, remaining risks, and follow-up work.

Plans must describe concrete repository paths and commands. Keep them current while implementing; do not wait until the end to reconstruct history. Prefer reversible milestones and proof-of-concept checks before high-risk changes.
