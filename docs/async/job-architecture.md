# Background work architecture

See [ADR 0003](../adr/0003-durable-work-contract.md). There is no new universal
queue in this phase. These existing systems have different ordering and side
effect requirements:

| Work | Existing owners | Durable state and limits |
| --- | --- | --- |
| Incentive events | `domainEventStore`, `incentiveSubscriber`, `eventQueueOps`, `globalMaintenance` | Append-only events, tenant dedupe, global cursor; one event's effects/state/cursor commit together. Five automatic failed attempts, backoff, leased processing and audited human recovery. |
| Fresh notifications | `notification_outbox`, `stateMonitorScheduler` | Enqueue dedupe; two-minute claims; bounded attempts/backoff, shared send breaker, at-least-once external delivery. |
| Scan work | `scanIntelStore`, `scanEngine`, `providerRequestQueue`, `distributedProviderCoordinator` | Persistent runs/targets and admission, role ownership, bounded provider work. Provider authorization and spend policy remain separate gates. |
| Address discovery | `addressDiscovery/store.ts`, `engine.ts` | Tenant request/idempotency keys, durable tile state/checkpoints, retries and leases. |
| Uploaded order/commission imports | `vendorOrderImportWorker`, `commissionFileImportWorker` and stores | One import per pass, chunked work, three attempts; encrypted file persistence when configured. Unencrypted in-memory staging cannot survive restart. |
| Browser field saves | `client/src/lib/knockQueue.ts`, training review queue | Scoped durable staging, idempotent replay, pending/dead-lane recovery. Offline caches are not a complete downloaded territory. |

## Foundation behavior

Organization queue recovery validates immutable event ownership before taking a
writer and again inside the transaction. The state change and tenant audit commit
together. Contention retries asynchronously for the existing one-second
interactive budget; exhaustion returns retryable 503 without changing state.
Diagnostics are read-only, scoped, and disclose 200-row array truncation.
Global financial event ordering is unchanged; a tenant can remain delayed by an
unresolved earlier event from another tenant. Per-tenant financial ordering is a
separate design and migration problem.

Startup alert retention applies the existing cap independently to each tenant,
uses a fixed ID/time watermark, skips live leases and yields every 500 updates.
A chunk retries contention asynchronously for up to 15 seconds. A terminal
failure leaves earlier chunks intact and logs failure; current boot wiring does
not schedule a later retry. Running cleanup again resumes from durable state.
Retention does not send messages or resurrect old superseded alerts.

## Next foundation work

- Non-default tenants need explicit recipient routing and a bounded periodic
  retry dispatcher; the current monitor tick drains the default tenant only.
  Do not route another tenant's alert to a global inbox as a shortcut.
- Import retries need per-attempt fencing/receipts and partial-progress proofs.
- Assignment replay/undo receipts are currently process-local. Reuse existing
  preview/apply/CAS-undo policy when adding durable progress and cross-worker replay.
- Inventory ownership, idempotency, attempts, timeout, lease, redacted observation
  and recovery for each handler before consolidation. Financial order and paid
  provider limits must survive any common abstraction.
