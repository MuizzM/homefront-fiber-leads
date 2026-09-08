# Outbox and effect consistency

Use the existing `domain_events` or `notification_outbox` when their semantics
match the domain. Do not create another outbox solely to follow a template.

1. Validate actor, tenant, business identity and revision.
2. In one short local transaction, persist the business fact and the required
   event/outbox entry using a stable tenant-aware dedupe key.
3. Claim bounded work with a lease. Commit the claim before network activity.
4. Send through the authorized adapter, with provider idempotency if available.
5. Persist success only for the current claim. Retry a known retryable outcome
   with finite backoff; surface exhausted/ambiguous work for reviewed recovery.

A crash between steps 4 and 5 can repeat a remote effect. Enqueue dedupe and a
`processed_jobs` lookup do not close that window. The existing fresh webhook
passes an idempotency key; email delivery remains at-least-once. Multiple
channels sharing one row can also repeat an earlier successful channel when a
later channel fails. Separate channel receipts are a future change, not a claim
made by this foundation.

For local financial effects, the existing maintenance path commits each event's
writes, queue state and cursor together, with unique reward keys guarding replay.
Do not advance a cursor before durable effects or skip a poison event to improve
throughput. Operator recovery requires a reason, tenant ownership and atomic
audit. Tests simulate audit failure and contention without sending anything.

Inspection/replay UX should build on existing financial queue and fiber failure
surfaces. An API's existence is not proof of a complete dead-letter review UI;
permission, pagination, expiry and retry policy need acceptance tests per domain.
