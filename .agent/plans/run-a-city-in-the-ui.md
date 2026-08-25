# Run a city from the UI, and stop on streets with no fiber

## Outcome

An admin types a city into Fiber Intelligence, presses Run, and the system
harvests every address in it from OpenStreetMap, checks them, and stops checking
any street whose probes come back with no fiber. Progress, what the prune saved,
and what the run found are visible while it runs.

## Context

Owner directive 2026-08-24: "build this system in prod with ui I can run the
city its openmap and list out all and system skips streets with no fiber and its
built in ui what we have now enhanced 20 on ip and tokn then switch it".

Most of it already existed and did not need building:

| asked for | already there |
| --- | --- |
| run a city, from OpenStreetMap | `POST /api/sweeps/city` -> `startCitySweep` -> Overpass harvest -> upsert -> resumable batched checks |
| list out all | `GET /api/sweeps/:id/results`, `/knock-list`, `/fresh`, CSV export |
| 20 per IP and token, then switch | shipped earlier today - see [[one-ip-one-token]] |
| everything through Decodo | shipped earlier today - see [[carrier-egress-decodo-only]] |

Two things were genuinely missing: the sweep never stopped on a dead street, and
`/sweeps` redirects to `/fiber`, where no control starts a city.

The evidence for the prune was measured in this session. A blind statewide run
checked 250 Charlotte doors and got 250 UNMATCHED - Kinetic does not know those
addresses, because that inventory is an OSM address grid over a city it barely
serves. Statesville is the same waste in the other shape: every door recognised,
1,000 checked, zero sellable. Both are visible after one or two answers on a
street, and streets are lit together - the neighbourhood sweep measured 22.5%
yield next to known-good doors against 0.9% blind.

## Safety invariants

- A street is only judged after it has actually been asked. No probe, no park.
- Parked doors are marked `skipped`, never `done`: they carry no verdict, are
  not evidence, and a later sweep can pick them up when the street lights.
- The existing admission gates stay: `requireAdmin`, `requireScanningAllowed`,
  `authorizedScanAdmission`, `MAX_CITY_SWEEP_CHECKS`.
- The prune must be reversible without a deploy: `SWEEP_PARK_DEAD_STREETS=off`.

## Milestones

1. `server/storage.ts`: `streets_parked` and `doors_skipped` on `sweep_jobs`.
   Placed AFTER the CREATE TABLE - the first attempt sat above it and every
   migration run logged "no such table: sweep_jobs".
2. `server/sweepService.ts`: probe-first ordering at queue time via the
   neighbourhood sweep's own `selectProbe`/`orderFlood`/`houseNumberOf`, and
   `parkDeadStreets()` between batches.
3. `POST /api/sweeps/:id/cancel` - `cancelSweep()` existed with no route.
4. `client/src/components/fiber/CitySweepRunner.tsx`, mounted admin-only in the
   Coverage tab of Fiber Intelligence.
5. `tests/integration/sweep-parks-dead-streets.test.ts`.

## Progress

- 2026-08-24: milestones 1-5 implemented; full verification run.

## Decisions

- REUSE the neighbourhood sweep's pure probe functions rather than writing a
  second ordering. They are deterministic and already carry their own tests.
- A street is dead when it has `SWEEP_PROBES_PER_STREET` (default 2) answered
  doors and not one is serviceable, tenured fiber, or coming soon. Two, not one,
  because a single bad OSM record should not park a real street.
- Coming soon counts as ALIVE. A dated build is worth knowing about, and the
  coming ledger wants it.
- Park at `state='skipped'`, a state the batch query already ignores, so the run
  loop terminates without any change to its exit condition.
- The panel lives in the Coverage tab rather than a new screen: the ask was
  "built in ui what we have now enhanced", and Coverage is already the
  operations surface.

## Discoveries

- `/sweeps` has redirected to `/fiber` for some time, so the operator flow the
  city-sweep documentation describes had no way in. The APIs never stopped
  working.
- `cancelSweep()` was implemented and unreachable - no route ever called it.

## Validation

- `tests/integration/sweep-parks-dead-streets.test.ts`: 3 passed - dead street
  parked, unmatched street parked, answered street kept, coming-soon kept,
  unprobed street untouched, idempotent on a second pass, and the off-switch.
- `bash scripts/agent-verify.sh full`: recorded in Result.

## Recovery

`SWEEP_PARK_DEAD_STREETS=off` restores whole-city checking without a deploy.
The two columns are additive; no data is rewritten. Parked doors keep
`last_scanned_at IS NULL`, so nothing is lost - a later sweep re-queues them.

## Result

Works, proven by running Broadway, NC from the UI three times against the real
inventory and the real Decodo egress. The first two runs FAILED to prune and
that is the value of having run it:

| run | queued | probes | checked | streets parked | doors skipped |
| --- | --- | --- | --- | --- | --- |
| 1 | 300 | - | 300 | 0 | 0 |
| 2 | 300 | 0 | 300 | 0 | 0 |
| 3 | 300 | 106 | **106** | **31** | **194 (65%)** |

All 300 doors came back UNMATCHED across 53 streets, so the correct answer was
always "probe 106 and stop". Two defects stood between the design and that:

1. THE PROBE BATCH DID NOT EXIST. Probes were ordered first in the queue, but
   the batch takes 5,000 rows at a time, so probes and flood went to the
   provider in the same run and parkDeadStreets had nothing answered to judge.
   Probes now form their own batch and the flood waits for the prune.
2. updateJob DROPPED probe_count IN SILENCE. It filters writes against a column
   whitelist and probe_count was not on it, so the gate read back 0 and run 2
   floods exactly like run 1 - no error, no log, 300 more provider calls. The
   whitelist now throws on an unknown column.

`agent-verify full` green: 582 files, 7367 tests, build included.

NOT DEPLOYED. Building it in the repository is not shipping it to production:
that needs an explicit deploy on a settled green SHA, and it is the owner's
call.

Broadway itself is a dead market for this inventory: 4,102 doors on file, 690
never scanned, and every one of the 300 checked came back unmatched. The city
has 2,493 doors that DID match in the past, so the streets Kinetic knows are
already scanned and what is left is OSM filler. That is the prune working as
intended, not a scanning failure.
