# How we ensure we don't miss fresh new-fiber leads

**The problem.** Our best leads are brand-new construction the moment Kinetic lights fiber to it — the resident doesn't know it's available yet. But *no single address source knows about new construction on time*:

- **OpenStreetMap (Overpass)** — free, but community-mapped. New subdivisions show up months late, if ever. A live Inman, SC scan found a **~24% new-fiber lead rate on new-build addresses OSM had never heard of**, vs ~7% on the existing streets it did have.
- **County parcels** — authoritative, but the county's GIS lags subdivisions still in plat review.
- **Geocoders (Mapbox)** — good and current, but a street too new can fuzzy-match to the wrong place (our first "Nard Ln" lookup resolved to *Ward Lane, WV*).

Relying on any one of them silently drops leads. So we **enumerate several sources, merge them, and measure the coverage** — and when a source disagrees, that disagreement is the signal.

## The four providers (`server/providers/`)

| Provider | Class | Role |
|---|---|---|
| **Mapbox** | `primary` | The main working enumerator — a dense reverse-geocode grid that finds real houses *including* new builds. Paid, so it's capped + explicit. |
| **Parcel** | `authoritative` | County GIS records — the closest thing to "every address that officially exists." The **denominator** for coverage. |
| **Rooftop** | `authoritative` | Rooftop-accurate points (pluggable dataset). Highest coordinate precision — wins the pin on any duplicate. |
| **Overpass** | `fill` | Free OSM — fills gaps where it's mapped; never defines coverage (it's the one that skips new builds). |

Every provider implements one interface (`AddressProvider.enumerate(bbox)`), returns the same `RawAddress` shape, and reports `partial: true` when it *cannot guarantee completeness* (rate-limited, capped, or outside its data footprint). A partial authoritative source is **never** trusted as the denominator — we'd rather say "estimated" than ship a confident wrong number.

## Merge (`mergeAddresses`)

Union every provider, deduped by a normalized address key that folds street-type + direction synonyms (`Bell Ridge Court` == `Bell Ridge Ct`). Precedence (best coordinate wins): **rooftop → parcel → mapbox → overpass**. Each surviving address records every source that had it, and whether the **Mapbox primary missed it** — the new-build signal.

## Coverage report (`buildCoverageReport`)

- **`coverageRatio`** = of the addresses the authoritative sources say exist, how many did the primary enumerator actually capture. `full ≥ 0.95 · good ≥ 0.8 · partial ≥ 0.5 · sparse > 0 · none = 0`.
- **`newBuildCandidates`** = addresses present in parcel/rooftop/overpass but **missing from the primary** — the fresh leads a primary-only scan would skip, newest first.
- **`estimated` / `unknown`** — if no authoritative source is usable, or the primary didn't run (e.g. a free preview with Mapbox excluded, or a Mapbox throttle), we report `classification: "unknown"` and `coverageRatio: null` **instead of a fake 0% / "all new builds."** Honest uncertainty beats a confident lie.

`GET /api/coverage/preview` runs this for a bbox **for free** (parcel/rooftop/overpass, no paid Mapbox unless `includeMapbox`) so an operator sees a gap *before* spending on a scan.

## Tiled scan worker (`server/tileScan.ts`)

To sweep a whole town without missing anything, split the region into tiles and run each through a state machine: `pending → enumerating → qualifying → done`, with bounded retry (`failed → retry`). Per tile: gather all providers → merge → qualify the merged set through Kinetic. A small tile means a throttle only costs *that* tile's work, and it just retries — the region always finishes.

## Cost discipline (the guardrails)

Two prior Mapbox billing incidents (123K and 1.16M requests) taught us: **never a silent paid harvest.**

- Tiled scan is **free by default** (parcel/overpass). The paid Mapbox grid runs only with explicit `deep: true`, and its **total call count is estimated and capped up front** (`MAX_TILE_MAPBOX_CALLS`) — rejected before running if over budget.
- Kinetic spend is bounded by a per-scan `budget` (max addresses qualified) **and** a job-level dedupe set — each address is scanned once, never re-scanned across overlapping tile edges or against existing leads.
- **Cancel stops qualification immediately** — no more proxy probes after the operator hits stop.
- Outbound Kinetic runs at capped concurrency with backoff (avoids 429). Tap-a-house reverse-geocoding is gated to team_lead+ and rate-limited.

## In the field (frontend)

- **Tap-a-house** — a tap on the map reverse-geocodes the rooftop to an address (no typing).
- **Persistently tappable scanned dots** — every scan hit is a real target; tap it for the property card.
- **Lead card** — address, fiber status, speed, competitor, with **Add as lead** + **Copy address**.
- **Manual add-lead** — prefilled from a tap/dot or typed from scratch.

## The one-line version

We treat "which addresses exist here?" as a measured quantity with a known error bar, not an assumption — so a subdivision the map hasn't caught up to shows up as a **visible coverage gap with a list of the exact addresses to go check**, instead of silently never appearing.
