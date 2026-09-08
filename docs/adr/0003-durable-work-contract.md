# ADR 0003: durable work and recovery

Status: accepted, 2026-09-08.

## Context and decision

`domainEventStore`, `eventQueueOps`, `scanIntelStore`, address discovery,
notification outbox and import stores already persist different kinds of work.
Preserve those systems and standardize guarantees before consolidation.

A database event and required local effects commit together. Event consumers
use stable business keys and at-least-once delivery. A `processed_jobs` pre-check
alone cannot guarantee exactly-once remote effects across a crash. Remote
adapters need provider idempotency where available, explicit retry limits and
reconciliation of ambiguous outcomes. Do not promise exactly-once email.

Keep the incentive subscriber's global ordered cursor: a later financial event
must not bypass an unresolved predecessor. Organization operators see and act
only on their immutable event ownership. Retention budgets apply per tenant;
maintenance preserves live leases, limits each write batch and yields between
batches. Fixed watermarks keep passes finite. Preserve the existing shared
provider breaker and authorization/spend gates.

## Alternatives and consequences

A new universal queue/outbox would duplicate existing persistent state and
could break financial order. A per-tenant financial cursor may improve fairness
but needs a distinct proof of event ordering and migration strategy. It is not
introduced here. Current non-default alert retry dispatch, remote recipient
routing, import fencing and assignment receipt durability remain backlog items.

## Validation and recovery

Test duplicates, foreign access, rollback, writer contention, partial completion,
restart, retry exhaustion and live leases using synthetic data. Retention does
not resurrect previously superseded rows. A failed chunk leaves completed chunks
intact; retry resumes from durable state. A failure after the bounded background
lock budget is logged; current startup cleanup has no later scheduled retry.
