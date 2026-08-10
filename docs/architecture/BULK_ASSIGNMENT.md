# Bulk assignment at scale, and the maintenance work that was breaking it

Status: design + implementation, 2026-08-10.
Owner: field-ops surface (Field Map lasso, territories) + the SQLite maintenance lane.

This document exists because "assign 1500 doors to a rep" failed in production with
`Load failed`, and the reason had nothing to do with assignment. Everything below is
written so the next person does not have to re-derive it.

## 1. What actually happened

A manager lassoed ~1500 doors on the Field Map, picked a rep, pressed Assign, and got a
toast reading `Load failed`. Repeatedly.

`Load failed` is not our string. It is Safari's `TypeError` message for a `fetch()` that
died at the network layer, and the lasso mutation surfaces it verbatim:

```ts
onError: (e: any) => toast({ title: e.message, variant: "destructive" })
```

So the browser never received a response. Not a 400, not a 500 - nothing.

### The endpoint was never the problem

Measured against a pristine local DB seeded with exactly 1500 doors:

| Path | Result |
| --- | --- |
| `POST /api/leads/bulk-assign`, 1500 ids | 200, `{updated:1500}`, **75 ms**, 7.9 KB body |
| `POST /api/territories/assign-area`, 1500 enclosed | 201, `{assigned:1500}`, **445 ms** |

Production was running the identical commit.

### The real cause: the HTTP event loop was being blocked

140 probes of `/api/health` - the cheapest route in the app - against production on a
near-idle box (`ratelimit-remaining` 1175/1200):

```
00:57:50  t= 1.27s      00:58:08  t= 2.97s
00:58:13  t=26.19s      00:59:08  t= 3.48s
01:00:06  t= 5.85s      01:00:09  t=17.87s
01:00:13  t=13.72s      01:01:06  t= 4.16s
9 of 140 probes over 1s; worst 26.19s
```

Process uptime stayed continuous across all of it, so the process **blocks, it does not
crash**, and no GitHub workflow was touching the box. The two worst stalls were exactly
**120 seconds apart**.

120 s is `WAL_CHECKPOINT_MS`. The chain:

1. `startWalGuard()` (`server/db.ts`) ticks every 120 s. Once the `-wal` file passes
   `WAL_TRUNCATE_MB` (default 512) it calls `forceWalTruncate()`.
2. `forceWalTruncate()` runs `PRAGMA wal_checkpoint(TRUNCATE)`. better-sqlite3 is
   **synchronous**, and the pragma waits up to `busy_timeout` (bounded to 30 s here) for
   readers to drain.
3. `server/index.ts` started that guard **in-process** when `SCAN_WORKERS === 0`.

`db.ts` even documents the safety rule, and gets the second half wrong:

> Run the guard in the CLUSTER PRIMARY (its event loop is a near-idle supervisor -
> blocking it stalls no HTTP or scan work) **or in the single process when
> SCAN_WORKERS=0**.

In cluster mode that is right: the primary serves no traffic. With `SCAN_WORKERS=0` there
is no primary, and that "single process" **is the web server**. Since the 2026-08-09
portal-first stop put production into single-process mode, the guard has been running a
synchronous, up-to-30-second checkpoint directly on the loop that answers every request.

Anything in flight during that window is dropped by Caddy (`health_timeout 3s`,
`max_fails 3`, `fail_duration 5s`), the browser's fetch rejects, and Safari calls it
`Load failed`.

### Why it tracked with door count

It does not cause the stall, but it multiplies exposure. `bulk-assign` chunks at 500, so a
1500-door lasso takes the SQLite write lock three times instead of once - three chances to
collide with a checkpoint holding it, against a production `busy_timeout` of 120 s. Small
lassos land in the gaps. Big ones do not.

### The second signal in that data

The guard only arms above 512 MB of WAL. Immediately after the portal-first stop the WAL
was 17 MB. A 120 s stall cadence therefore also proves **the WAL has grown back past
512 MB**, which means a heavy writer returned. Fixing the stall does not fix that; see
section 6.

## 2. The principle

> The event loop that serves HTTP does no unbounded synchronous work. Ever.

better-sqlite3 is synchronous by construction. That is a good trade for request-scoped
statements measured in microseconds and a fatal one for maintenance measured in seconds.
The rule is therefore not "be careful" but structural: **maintenance that can block for
longer than a request budget runs somewhere that serves no requests.**

Three corollaries drive the rest of this document:

1. Blocking DB maintenance runs off the request process. (Section 3.)
2. Request handlers never do work proportional to an unbounded set without yielding.
   (Section 4.)
3. A dropped connection is a distinct failure from a refused request, and the UI must say
   so. (Section 5.)

## 3. Maintenance moves off the request loop

`server/walMaintenance.ts` owns the decision of *where* the guard runs.

```
SCAN_WORKERS > 0   ->  cluster primary runs it in-process (unchanged, already correct)
SCAN_WORKERS === 0 ->  supervised child process runs it (new)
no child available ->  in-process, hard-bounded busy_timeout (dev fallback)
```

The child is a dedicated bundled entry point, `dist/wal-maintenance.cjs`, built by
`script/build.ts` exactly the way `reset-areas` and `import-fcc-pins` already are. It opens
its own better-sqlite3 connection and runs the same file-size-based guard loop. When it
blocks for 30 seconds it blocks nothing that anyone is waiting on.

Supervision is deliberately boring: respawn with exponential backoff on rapid exit, park
after repeated failures, forward `SIGTERM`, and never let a guard failure take the web
server with it. A parked guard is logged loudly - the WAL growing unattended is the
2026-07-23 disk-full incident, and silence is how that one hid.

`bootWalCheckpoint()` stays in-process. It runs before `listen()`, when nothing is served
and no other connection exists, so it both blocks for free and always wins the lock. It is
the cheapest reclaim we have.

Kill switch: `WAL_GUARD=off` still disables everything. It is not a fix - it re-opens the
disk-full spiral on a box already at 79 percent - but it stays because an operator at 2am
needs a lever.

## 4. Assignment stops shipping identifiers

### What was wrong beyond the stall

The old contract sends the door set from client to server as an array of ids. That has a
hard ceiling nobody had noticed:

- `MAX_BULK_ASSIGN_LEADS` is 25,000.
- The global API body limit is **64 KB** (`server/index.ts`).
- Production lead ids are 7 digits, so ~8 bytes per id on the wire.

64 KB / 8 bytes is about **8,000 ids**. Anything larger is rejected by the body parser
before the handler - and therefore before the friendly `BULK_TOO_LARGE` message - ever
runs. The advertised 25,000 limit was unreachable by roughly 3x.

There is a second, worse problem. Past the viewport threshold the map ships an even
*sample* of the window's pins (`truncated: true`). The lasso can only select pins the
client holds, so Assign silently skipped every unsampled door inside the loop. The UI
warns about this, which is honest, but the honest answer is to not have the limitation.

### The new contract

`POST /api/leads/assign-selection` describes the selection instead of enumerating it:

```jsonc
{
  "repId": 12,                       // or null to return doors to the pool
  "polygon": [[lng,lat], ...],       // the validated lasso ring
  "includeStates": ["unworked","not_home"],   // optional refinement, display states
  "excludeLeadIds": [8801, 8817]     // optional manual deselects, always small
}
```

Request size is O(ring points), not O(doors): **about 1-4 KB whether the ring holds 1,500
doors or 150,000.** The 64 KB ceiling stops being reachable, batching disappears from the
UI, and unsampled doors are included because the server evaluates the polygon itself.

### Resolution must agree with the map, by construction

The selection the server computes has to be the selection the manager saw. Rather than
reimplement the rule, the endpoint reuses the exact pipeline the map already uses:

```
storage.getLeadsForMap(tid, repScope, { bbox of ring, limit })   // same scoped SQL + knock join
  -> buildMapPins(rows)                                          // same projection
  -> polygonCovers(pin.lat, pin.lng, ring)                       // same enclosure test as assign-area
  -> pinDisplayState(pin) in includeStates                       // same shared/knock.ts function
  -> canReassignLead(user, pin)                                  // same authority rule
```

`pinDisplayState` is a pure function of columns the query already returns, and it is the
same module the client imports. Parity is structural, not maintained by hand.

The bbox pre-filter rides `idx_leads_lat_lng` / `idx_leads_map_window`, so candidate cost
is proportional to the ring's bounding box, not to the tenant.

### Writing without holding the loop or the lock

The write reuses the pattern `bulk-assign` already proved, with the chunk size raised now
that ids no longer ride the wire:

- **Set-based.** Two statements per chunk regardless of chunk size - one
  `INSERT INTO lead_events ... SELECT` and one `UPDATE ... RETURNING id`. Not three
  statements per door. 150,000 doors costs ~300 statements, not 450,000.
- **Chunked at 1,000**, each chunk its own `IMMEDIATE` transaction. A checkpoint collision
  can never stall more than one chunk, and the write lock is released between chunks
  instead of being held across the whole assignment.
- **Yielding.** `await setImmediate` between chunks, so `/api/health`, the Field Map and
  every other request keep flowing while a whole neighbourhood changes hands.
- **Scope predicates inlined into the SQL**, so tenant and visibility filtering is enforced
  by the statement itself and `RETURNING id` reports what actually moved rather than what
  was requested.
- **Events after commit.** SSE fan-out stays outside the transaction (a rollback has no
  retraction) and stays bounded at `LEAD_EVENT_BULK_MAX`.

### Limits, honestly stated

| Bound | Value | Why |
| --- | --- | --- |
| Ring points | 3 .. 10,000 | A freehand stroke is validated and simplified client-side already |
| Doors per selection | `MAX_ASSIGN_SELECTION`, default 250,000 | Runaway guard, checked before any write |
| Chunk size | 1,000 | Bounds both lock hold time and stall blast radius |
| `excludeLeadIds` | 5,000 | Manual deselects are small by nature; keeps the body bounded |
| Per-lead audit events | one per moved door | Audit integrity is the point; it is set-based, see section 6 |

`/api/leads/bulk-assign` stays, unchanged in contract, for callers that genuinely have an
exact id list. Its cap is corrected to an honest value derived from the body limit so it
fails with a readable message instead of a parser rejection.

## 5. A dead connection is not a server error

The manager's actual experience was a red toast reading `Load failed`, which is Safari
implementation detail leaking into a sales tool. Two changes:

- `apiRequest` distinguishes a rejected `fetch` (no response at all) from an HTTP error
  response, and raises a typed network error carrying a human sentence rather than the
  platform's string. Chrome says `Failed to fetch`, Safari says `Load failed`, Firefox says
  `NetworkError when attempting to fetch resource` - all three become one message.
- Assignment is idempotent - setting `assigned_rep_id` to the same rep twice is the same
  end state - so a mutation that dies at the network layer is retried once automatically
  before the user is told anything. A stall window is 5-30 s; the retry is what turns a
  visible failure into a slow success.

Retry is applied only to network-layer failures. An HTTP error response is a decision the
server made and is never retried.

## 6. What this does not fix

**The WAL is growing past 512 MB again.** The guard arming on a 120 s cadence proves it.
Moving the checkpoint off the request loop makes the symptom invisible, which is exactly
why this needs saying: the disk is at 79 percent on a 38 GB box holding an 18.8 GB
database, and the 2026-07-23 incident was a WAL that reached 12 GB and filled it.

Two candidate mechanisms, both already described in `db.ts`:

- A heavy writer returned after the portal-first stop turned all ten producers off.
- Checkpoint starvation - a long-lived read mark pinning the WAL tail so
  `wal_autocheckpoint` can never advance. `.iterate()` call sites hold a read transaction
  open for the life of the loop and are the usual suspects.

Both are diagnosable without SSH, read-only:

- `perf-report.yml` aggregates the `http.request` and `perf.leads_map` logs the app
  already emits.
- `host-disk.yml` with `action: report` prints live WAL and disk size.

The `db.wal_guard` structured log line (`beforeMb` / `afterMb` / `result` per tick) is the
fastest confirmation: a guard that runs every 120 s and never shrinks the file is starved,
not slow.

## 7. Rollout

1. WAL guard relocation ships first and alone. It is the outage fix, it is behind
   `WAL_GUARD`, and it changes no product behaviour.
2. `assign-selection` ships next, additive. `bulk-assign` keeps working, so the client can
   move over without a lockstep deploy.
3. The Field Map lasso switches to the polygon endpoint, which is also when the
   sampled-pins warning stops applying to Assign.

Deploys are a manual `deploy.yml` dispatch against a settled, CI-green SHA. See
`DEPLOY.md`.
