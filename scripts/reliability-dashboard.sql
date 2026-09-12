-- Read-only dashboard queries; bind :tenantId to an authorized positive tenant.
-- Empty results when a feature has no samples mean unknown/disabled, not healthy.
SELECT p.run_id,p.phase,p.inflight,p.heartbeat_at,p.progress_at,
  MAX(0,CAST(unixepoch('now')*1000 AS INTEGER)-p.progress_at) AS progress_age_ms,
  p.deadline_at IS NOT NULL AND p.deadline_at<unixepoch('now')*1000 AS stalled
FROM scanner_run_progress p JOIN scan_runs r ON r.id=p.run_id AND r.tenant_id=p.tenant_id
WHERE :tenantId>0 AND p.tenant_id=:tenantId AND r.status='running'
ORDER BY p.heartbeat_at LIMIT 50;

SELECT run_id,checked_at,verified,actual_verified,failed,actual_failed,
  verified-actual_verified AS verified_drift,failed-actual_failed AS failed_drift
FROM scanner_count_checks WHERE :tenantId>0 AND tenant_id=:tenantId
ORDER BY checked_at DESC LIMIT 50;

SELECT status,COUNT(*) AS operations,MIN(created_at) AS oldest_created_at,
  SUM(attempts) AS attempts,SUM(CASE WHEN attempts>1 THEN attempts-1 ELSE 0 END) AS retry_attempts
FROM auth_delivery_outbox WHERE :tenantId>0 AND tenant_id=:tenantId GROUP BY status;
-- Retry attempts are observable; they do not independently prove external exactly-once delivery.

SELECT state,COUNT(*) AS operations,SUM(replays) AS replayed_requests,
  SUM(updated) AS committed_doors,SUM(restored) AS put_back_doors
FROM assignment_operations WHERE :tenantId>0 AND tenant_id=:tenantId GROUP BY state;

SELECT o.id,o.state,o.actor_user_id,o.created_at,o.updated_at,o.total,o.updated,o.restored
FROM assignment_operations o WHERE :tenantId>0 AND tenant_id=:tenantId
  AND state IN ('running','undoing') ORDER BY created_at LIMIT 8;

SELECT e.id,e.type,s.status,s.attempts,s.updated_at,
  e.id>COALESCE(c.last_event_id,0) AS replayable
FROM domain_events e JOIN event_processing_state s ON s.event_id=e.id AND s.subscriber='incentives'
LEFT JOIN event_subscriptions c ON c.name=s.subscriber
WHERE :tenantId>0 AND e.tenant_id=:tenantId AND s.status IN ('failed','blocked','dead_lettered')
ORDER BY (s.status='dead_lettered'),CASE WHEN s.status!='dead_lettered' THEN e.id END,e.id DESC LIMIT 50;
