# Homefront agentic harness

This repository now teaches Codex how to work here. The pieces have different jobs:

| Piece | Purpose | How it activates |
| --- | --- | --- |
| `AGENTS.md` | Always-on project rules and safety boundaries | Loaded when Codex starts in this repository |
| `.agent/PLANS.md` | Format for long-running, restartable work | Used when `AGENTS.md` requires an ExecPlan |
| `.agents/skills/*/SKILL.md` | Repeatable Homefront workflows | Selected automatically from the description or explicitly with `$skill-name` |
| `.codex/agents/*.toml` | Focused subagent roles | Spawned when requested or when an applicable workflow delegates work |
| `.codex/config.toml` | Project-level agent settings | Loaded only after the repository is trusted |
| `scripts/agent-verify.sh` | Deterministic quality gates | Called by the verification skill or directly |

## What happens when you ask for work

1. Codex reads `AGENTS.md` and any more specific instructions near the files involved.
2. It matches your request to a skill description. You can force one by naming it with `$`.
3. For a large change, it writes an ExecPlan and keeps the progress and decisions current.
4. For independent investigation, it may delegate read-only work to the custom agents. One primary writer integrates the result.
5. It implements the change and runs the verification skill.
6. You review the diff and CI before merge or deployment.

GitHub access alone does not start work. A task starts from your prompt, an explicit GitHub `@codex` request, enabled automatic review, or a configured workflow.

## Prompts to use in the Mac app

Small fix:

> Trace this bug, make the smallest fix, add a regression test, and use `$homefront-verify-change` before you finish.

Large feature:

> Create an ExecPlan for this feature. Use `code_mapper` and `product_guard` in parallel for research, keep one writer for implementation, and validate the completed milestones.

Scanner work:

> Use `$homefront-scanner-safety` to review this scanner change. Confirm tenant scope, retry bounds, concurrency, spend, provider stop conditions, and tests before editing.

Pull-request review:

> Use `$homefront-review-pr` to review this branch against `rep-knocking-workflow`. Wait for all reviewer agents and show only verified material findings.

Database work:

> Use `$homefront-database-change` to plan this migration, including restart safety, tenant separation, backup recovery, and upgrade tests.

## Learning rule

Memory is helpful context, not policy. When Codex makes the same wrong assumption twice, correct the nearest durable source:

- Always-on repository rule: update `AGENTS.md`.
- Repeated workflow: update or add a skill.
- Long task knowledge: update its ExecPlan.
- System architecture or operations fact: update the relevant file in `docs/`.

Keep these files short and evidence-based. More instructions are not automatically better.
