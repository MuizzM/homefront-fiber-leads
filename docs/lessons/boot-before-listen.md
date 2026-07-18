# httpServer.listen() must come before heavy startup work — or every deploy is an outage.
Boot ran migrations + resumed hundreds of runs + statewide sweep + monitor tick BEFORE
listen(), so /api/health never answered inside the deploy health window; the deploy
rolled back and the rollback ground through the same boot: ~10-minute outage per
deploy, observed twice. Fix: listen() right after migrations/routes; everything heavy
runs in startBackgroundServices() from the listen callback, and slow periodic work
(state-monitor startup tick) is setTimeout-delayed (STATE_MONITOR_STARTUP_DELAY_MS).
Compose healthcheck start_period widened as a margin, not as the fix.
