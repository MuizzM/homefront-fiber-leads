# Service boundaries and extraction criteria

See [ADR 0002](../adr/0002-domain-boundaries.md) and [domain map](domain-map.md).

The deployable remains an Express application with explicit primary/control/HTTP
worker roles and a shared SQLite file. Moving HTTP to multiple hosts requires
more than starting containers: assignment receipts, sessions/files, job claims,
provider coordination and database ownership must work across hosts first.

Extract a domain only when all of these are concrete:

1. A measured workload cannot meet its agreed budget within the current process
   allocation, or independent release/availability needs justify the cost.
2. One domain owns writes and exposes versioned commands/events with actor,
   tenant, idempotency, timeout and failure contracts.
3. Cross-domain consistency and replay behavior are explicit; no hidden shared
   transaction or raw table write is left behind.
4. The owner can operate auth, metrics, retries, secrets, deployment, recovery
   and cost controls independently.
5. A reversible rollout and realistic load/recovery test exist.

Prefer moving an existing bounded worker off an HTTP loop before adding a
network service. Do not duplicate provider clients or move policy into transport.
The next extraction should target a characterized operation (for example an
assignment receipt), preserving existing preview/visibility/business rules.
