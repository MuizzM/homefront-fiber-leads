# ADR 0002: incremental domain boundaries

Status: accepted, 2026-09-08.

## Context and decision

The app already has shared contracts, domain stores/services and specialized
routes, alongside large `server/routes.ts`, `server/storage.ts` and `MapView.tsx`.
Retain the current repository layout. Extract one characterized workflow into
an existing domain before inventing a new package, service or framework.

The [domain map](../architecture/domain-map.md) names current authority. A public
command validates actor/tenant, input and expected revision; its store owns
persistent changes. Pure rules live in `shared/` when both server and browser
need them. A consumer cannot strengthen eligibility or determine money by
reinterpreting raw provider/UI data. Cross-domain effects use an existing public
service or a durable event when delayed processing is acceptable. Atomic local
business invariants stay in a short database transaction.

## Alternatives and consequences

A wholesale monorepo move or microservice split would increase review and
operational cost without fixing SQLite contention or missing idempotency.
Package boundaries alone do not enforce tenant access. Extract a deployable
only after a domain has independent scaling/release needs, stable contracts,
authentication and tenant propagation, ownership, observability and a recovery
plan. See [service criteria](../architecture/service-boundaries.md).

## Validation and recovery

Characterize the chosen slice's permissions, outputs, errors, idempotency and
side effects before moving it. Keep equivalent results and measure resource
changes. A refactor must be independently revertible; do not bundle business
rule changes with directory moves. No directory-wide move is part of 1A.
