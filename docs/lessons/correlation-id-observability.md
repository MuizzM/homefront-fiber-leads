# One stable correlation id per work item, end to end — and keep per-item logs OUT of stdout.
Every address carries addressKey (sha256 of the normalized address, 16 hex) through
queued→minting→token_ready→searching→parsing→saving→classified in the durable
scan_events table; the inspector API exposes it as correlationId + ISO ts, and the
admin Scan Inspector filters by correlation id / stage / outcome with a copyable id
per timeline. Meanwhile per-check started/completed logs were ~50% of container
stdout and rotated real diagnostics away in minutes — they're gated behind
SCAN_VERBOSE_LOGS; the event table IS the per-item observability path. Secrets never
appear: masked decodo-sN + token last-4 only.
