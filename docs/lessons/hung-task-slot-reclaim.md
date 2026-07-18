# If a heartbeat keeps leases fresh for the whole task lifetime, hung tasks hold slots forever — add a hard task deadline.
Moving the lease heartbeat to cover the admission wait (correct, prevents duplicate
checks) also meant a HUNG task's lease never expired, so its concurrency slot was
never reclaimed. Fix: coordinator cleanup() force-expires any ACTIVE admission older
than PROVIDER_TASK_MAX_MS (180s) regardless of lease freshness — no legitimate check
runs that long (5s search cap), and the late completion is a harmless no-op UPDATE.
