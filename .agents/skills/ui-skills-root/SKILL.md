---
name: ui-skills-root
description: Use before UI-related work to select the smallest useful UI Skills context through the ui-skills CLI.
---

# UI Skills Root

This is the repository routing layer for the MIT-licensed [ibelick/ui-skills](https://github.com/ibelick/ui-skills) collection.

Use it when the task has a clear interface goal. If the goal is unclear, ask one short question. If the goal is clear, select the smallest useful skill context and then implement within Home Front's existing design system and repository rules.

## Protocol

1. Decide whether the task is UI-related.
2. Identify the likely category.
3. Inspect that category with the CLI.
4. Select the smallest useful skill set.
5. Load only the selected skill context.
6. Implement and verify with `$homefront-verify-change`.

## CLI

```bash
npx ui-skills start
npx ui-skills categories
npx ui-skills list --category <category>
npx ui-skills get <slug>
```

## Selection rules

- Prefer one skill.
- Use two only when the task needs two distinct angles.
- Use three only for a broad review, redesign, or multi-surface task.
- Never use more than three.
- Route by topic, then stack, then specificity.
- Prefer specific and framework-aware guidance over broad advice.
- Treat Home Front's design tokens, existing primitives, privacy rules, and safety invariants as the controlling authority.
