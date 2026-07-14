# Address-level Kinetic city sweeps

The Fresh Fiber Sweep screen at `/sweeps` implements the complete operator flow: locate and check an address area, harvest and check a city from OpenStreetMap, run a persistent budgeted availability sweep, inspect address-level results, and export the first-mover knock list.

## Truth model

Infrastructure and customer status are independent facts:

- `freshly_available` requires a prior conclusive unavailable observation followed by a conclusive fiber-available observation. A first scan that is already available is `baseline_available`, not fresh.
- `new_opportunity` means Kinetic indicated serviceable fiber and `billingStatus=N`.
- `existing_customer` means Kinetic indicated `billingStatus=Y`.
- `unknown` is used whenever those signals are missing or fiber is not serviceable.
- Customer labels are always `confirmed=false` and provider-indicated unless a separate, lawful customer source is integrated. They are never presented as independently verified facts.
- A failed request records an append-only failed snapshot but never overwrites availability truth.

Each check writes `availability_snapshots` with the target, run, timestamp, normalized result, customer signals, transition, API source, SHA-256 evidence hash, and a reference to the legacy raw `fiber_checks` evidence row.

## Sweep lifecycle

`POST /api/sweeps/city` creates a persistent `sweep_jobs` record and returns immediately. The worker then:

1. resolves the city and tiled boundary;
2. harvests OSM address nodes/buildings through the existing bounded Overpass client;
3. normalizes and upserts the address pool;
4. queues at most the operator-approved `maxChecks`;
5. checks sequential 5,000-address batches through the resumable scan engine;
6. stores every result and continuously updates progress;
7. resumes unfinished jobs after a restart.

The default hard ceiling is 50,000 checks per sweep and can be reduced with `MAX_CITY_SWEEP_CHECKS`. Existing billing gates, run budgets, rate control, proxy-byte accounting, pause/cancel controls, and authorization remain authoritative.

## APIs

- `GET /api/sweeps/address-search?query=...&radiusMeters=500`
- `POST /api/sweeps/address` with `{ "query":"123 Main St, Lexington, NC", "radiusMeters":500, "maxChecks":5000 }`
- `POST /api/sweeps/city` with `{ "city":"Lexington", "state":"NC", "maxChecks":5000 }`
- `GET /api/sweeps`
- `GET /api/sweeps/:id`
- `GET /api/sweeps/:id/results?stage=fresh&customer=new_opportunity`
- `GET /api/sweeps/:id/fresh`
- `GET /api/sweeps/:id/knock-list`
- `GET /api/sweeps/:id/knock-list.csv`
- `POST /api/sweeps/:id/cancel`

Only admins can initiate or cancel provider-spending sweeps. Managers and team leads can inspect results and export deployment lists.

## Source and automation boundaries

OSM/Nominatim/Overpass calls use stable descriptive identification, bounded tiling, caching through the persistent pool, retry/backoff, and source timeouts. OSM completeness varies; a licensed county parcel/address feed should supplement sparse markets.

Kinetic checks use the existing explicitly configured integration. The application does not rotate identities, spoof users, bypass CAPTCHAs, or defeat access controls. A challenge, authentication failure, throttle, unknown schema, or malformed response is recorded as a non-answer and surfaced. For reliable production volume, use an authorized carrier/partner availability API or licensed feed and written permission for the intended query rate.

Independent availability confirmation must be imported through the existing corroboration API using licensed FCC BDC/fabric data, an authorized partner feed, a licensed third-party source, or field verification. FCC fabric/address data is subject to its applicable license.
