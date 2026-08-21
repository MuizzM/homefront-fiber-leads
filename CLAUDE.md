# Homefront Fiber Leads Claude Code guide

`AGENTS.md` is the canonical repository instruction file. Read it completely before doing any work and treat its mission, invariants, workflow, autonomy gates, skills, and review rules as binding.

## Claude Code compatibility

- Read the closest relevant documentation under `docs/` before changing a subsystem.
- Load the applicable repository skill from `.agents/skills/<skill-name>/SKILL.md` when `AGENTS.md` names or triggers it.
- For substantial work, create and maintain an ExecPlan under `.agent/plans/` using `.agent/PLANS.md`.
- Keep one implementation agent responsible for writes and integration. Use other agents for independent read-only mapping, security review, product-rule review, and test review.
- Work on a feature branch or isolated worktree. Do not merge, deploy, modify production, rotate secrets, run paid scans, or perform destructive data operations unless the user explicitly authorizes that exact action.
- Before finishing, run the relevant verification level from `$homefront-verify-change`, inspect the final diff, and report exact validation results and remaining risks.

When this file and `AGENTS.md` appear to disagree, follow the safer instruction and identify the conflict instead of guessing.
