# Architecture decision records

Current program: [SaaS upgrade roadmap](roadmap.md). ADRs describe accepted
implementation choices; a proposed platform purchase or migration is not an
implicit approval to change production.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](adr/0001-tenant-and-data-foundation.md) | Accepted for foundation phase | Shared tenant tables in current SQLite; explicit application ownership, additive changes, measured migration gate. |
| [0002](adr/0002-domain-boundaries.md) | Accepted | Incremental modular monolith; public domain commands and evidence-based extraction. |
| [0003](adr/0003-durable-work-contract.md) | Accepted | Strengthen existing durable events/jobs; atomic local effects, at-least-once remote delivery, tenant-owned recovery. |

A new ADR records context, decision, alternatives, consequences, validation and
recovery. Supersede an ADR explicitly rather than rewriting a historical decision
as though the earlier state never existed.
