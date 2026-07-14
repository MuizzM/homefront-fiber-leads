# NC/SC Kinetic fresh-fiber monitoring

This subsystem continuously monitors Kinetic/Windstream/Uniti fiber at the address level across North Carolina and South Carolina. City metadata controls inventory and cadence; it is never treated as proof that an address is serviceable.

## What is implemented

- A reproducible target inventory of all 820 incorporated places in the two states: 549 NC and 271 SC.
- Population, primary county, every county part, representative coordinates, priority, scan cadence, and source vintage.
- A slowly expanding OSM address inventory, harvested one market at a time when enabled, using the existing tiled/retrying Overpass client.
- Budgeted, resumable Kinetic checks through the existing authorized provider integration.
- Persistent unavailable-to-available transition timestamps (`scan_targets.first_seen_live_at`). Baseline-available addresses are not falsely called fresh.
- Independent address-level corroboration, explicit provisional/cross-verified confidence, density/recency ranking, CSV knock lists, map links, and dashboard summaries.
- Durable email/webhook alert outbox and a weekly, conditional-request official announcement watcher.
- Fail-loud source poll state and scan status APIs.

## Data sources and evidence rules

The target CSV is generated from the US Census Bureau's 2025 Subcounty Population Estimates and 2025 Gazetteer place files. Run `npm run markets:refresh` to rebuild it. The generated file is `data/nc_sc_kinetic_markets.csv`.

Kinetic availability comes only from the repository's existing authorized address lookup. It is address-specific. Heuristics, city coverage pages, ZIP claims, announcements, CAPTCHA pages, malformed responses, and network failures never become availability truth.

Independent corroboration is accepted only through the authenticated `POST /api/monitor/corroboration` import using one of:

- `fcc_bdc_licensed`
- `carrier_partner_feed`
- `third_party_licensed`
- `field_verification`

An independent `available` observation must be for the same `scan_target_id` and fall from seven days before through 31 days after the Kinetic flip. Otherwise the hit remains `single_source_provisional`. FCC Broadband Data Collection address/fabric data must be acquired and used under the applicable FCC/CostQuest license; the app does not scrape it.

Official Kinetic/Uniti announcements only change market priority and cadence. They never confirm a door. The initial critical NC markets come from official May 2026 releases. The watcher uses a stable descriptive User-Agent, ETag/Last-Modified, a seven-day interval, bounded requests, and fails visibly on blocks or layout/source failures.

## Scheduler and budgets

The monitor initializes its free market inventory on every boot. Paid provider scanning is off unless both live gates are set.

```env
ENABLE_STATE_MONITORING=true
STATE_MONITOR_LIVE=true
STATE_MONITOR_TICK_MINUTES=60
STATE_MONITOR_DAILY_CHECK_BUDGET=2000
STATE_MONITOR_MARKET_BUDGET=250

# Free/public inventory expansion. Requires MAPBOX_TOKEN for one city bbox lookup;
# address enumeration uses Overpass. One market is attempted every six ticks.
ENABLE_STATE_ADDRESS_HARVEST=true
STATE_MONITOR_INVENTORY_EVERY_TICKS=6
MAPBOX_TOKEN=pk...

# Weekly official announcement watch (optional and fail-loud)
ENABLE_ANNOUNCEMENT_WATCH=true
KINETIC_ANNOUNCEMENT_FEED_URL=https://investor.uniti.com/press-releases

# At least one alert channel
FRESH_FIBER_WEBHOOK_URL=https://example.com/hooks/fresh-fiber
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
ADMIN_EMAIL=
```

Cadence is 24 hours for announcement-critical places, 48 hours for population-high places, seven days for medium places, and 14 days for low/rural places. Each tick starts at most one address-inventory job or one provider scan. A global daily check cap and a per-market cap prevent unbounded proxy spend. Existing active jobs are allowed to finish before another starts. Scan jobs retain their queue and resume after crashes.

The system does not rotate identities, bypass challenges, solve CAPTCHAs, or disguise automation. It uses stable identification, bounded concurrency, rate control, retry/backoff, conditional requests, explicit authorization gates, and provider/source terms. If Kinetic changes schema or returns a challenge, the check is inconclusive and the failure is surfaced.

## Run end to end

```bash
npm install
npm run markets:refresh
npm run check
npm run test:unit
npm run dev
```

Log in as a manager/admin, then inspect:

- `GET /api/monitor/summary?days=7`
- `GET /api/monitor/markets?state=NC&due=true`
- `GET /api/monitor/schedule`
- `GET /api/monitor/sources`
- `GET /api/monitor/fresh?days=30`
- `GET /api/monitor/clusters?days=30&radiusMeters=250`
- `GET /api/monitor/knock-list.csv?days=30`
- `GET /api/monitor/markets.csv`

Admin operations:

- `POST /api/monitor/seed` refreshes the DB from the generated Census dataset.
- `POST /api/monitor/tick` runs one scheduler tick. It can spend only when both live gates and the existing billing/scan gate allow it.
- `POST /api/monitor/announcements/poll` forces the official source check.
- `POST /api/monitor/corroboration` imports licensed/field verification evidence.

Example corroboration payload:

```json
{
  "rows": [{
    "scanTargetId": 123,
    "source": "fcc_bdc_licensed",
    "sourceRecordId": "licensed-record-456",
    "observedAt": "2026-07-13T16:00:00.000Z",
    "availability": "available",
    "technology": "fiber",
    "maxDownMbps": 1000,
    "importBatchId": "fcc-2026-06"
  }]
}
```

## Operational truth and limitations

- The complete place target inventory is real and source-vintaged. Address coverage depends on OSM completeness; sparse markets should be augmented with a licensed parcel/address feed.
- A market with `inventory_pending` is scheduled but cannot be checked until it has address records.
- `single_source_provisional` means Kinetic showed a real change, but an independent address-level source has not yet verified it.
- Alerts without configured email/webhook delivery remain pending in the outbox instead of being silently discarded.
- The current app uses SQLite because that is the repository's production persistence layer. The monitor uses indexed, additive tables and prepared statements; a PostgreSQL/PostGIS migration can preserve the same schema and evidence model when the application moves databases.
