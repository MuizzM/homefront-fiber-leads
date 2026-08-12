# Rep metrics and field performance

What the Metrics tab measures, how every number is calculated, who can see it,
and the rules that keep it a coaching tool rather than a surveillance one.

This document is written to be read by the people being measured, not only by
the people reading the dashboard.

**Related:** [Field location privacy](../FIELD_LOCATION_PRIVACY.md) covers the
location layer this feature sits on top of - what is collected, what is
deliberately not, retention, and the audit trail. Read that one first if your
question is about tracking rather than about metrics.

---

## The short version

- Metrics are computed from the **events the app already records** - knocks,
  shifts, location pings, leads, commissions. No parallel event log was created.
- A rate with **no denominator is blank, not zero**. A rep who knocked no doors
  has no contact rate, not a bad one.
- Rates are **never averaged across days**. A week's contact rate is the week's
  contacts over the week's attempts.
- **Breaks are excluded from pace.** A lunch hour is not a slow walk to the next
  door.
- Every coaching insight carries **the arithmetic that produced it**, and every
  one names an action.
- **Nothing here reclaims territory or affects pay.** Reclaim is a
  recommendation with a human decision recorded against it.

---

## Where the data comes from

The brief for this feature asked for three new tables: `field_shifts`,
`field_location_points`, and `door_visit_events`. All three already existed
under other names, holding live production data:

| Asked for | Already exists as | Written by |
| --- | --- | --- |
| `field_shifts` | `clock_sessions` | `/api/clock/in`, `/api/clock/out` |
| `field_location_points` | `location_pings` | the live-ops ingest route |
| `door_visit_events` | `knock_log` | `storage.createKnock` |

Building parallel tables would have meant double-writing every knock and every
fix, and the two copies **would** diverge - an offline queue flush that lands in
one and not the other is not hypothetical, it is the normal failure mode of the
sync path this feature depends on. Worse, metrics would then be computed from
the copy while pay, territory and compliance kept using the original, so a rep's
dashboard and their commission statement could disagree about whether a sale
happened.

So the existing tables **are** the event model. They were extended where they
were genuinely missing something:

| Column | Table | Why |
| --- | --- | --- |
| `clock_session_id` | `knock_log` | which shift a door belongs to. Previously inferred by comparing timestamps, which is wrong across a missed clock-out. |
| `dwell_seconds` | `knock_log` | time on the door, from the arrival event below. |

One table is genuinely new:

**`door_arrivals`** - "the rep walked up to this door" is the one event nothing
recorded, and dwell time cannot be computed without it. It is written when a rep
opens a door card in Field Mode and closed when they save a disposition. It
carries `retention_expires_at` and expires on the same schedule as
`location_pings`: an arrival is a position fix with a lead id attached, and it
must not outlive one because it happens to sit in a different table.

### Rollup tables

| Table | Grain | Contents |
| --- | --- | --- |
| `rep_daily_metrics` | one rep, one local day | counts and durations only |
| `territory_daily_metrics` | one area, one local day | counts, status, reclaim recommendation |
| `rep_coaching_insights` | one rep, one type, one period | the generated findings |
| `rep_coaching_notes` | free-form | supervisor notes and goals |
| `territory_reclaim_reviews` | one decision | the audit record of a human call |
| `rep_metrics_dirty_days` | the work queue | which rep-days need recomputing |

`rep_daily_metrics` holds **counts and durations only**. There is deliberately
no `contact_rate` column: storing one would invite a week's rate to be computed
as the mean of seven daily rates, and that number is wrong in a way nobody
notices. Every rate is derived at read time from summed numerators and
denominators.

---

## Metric definitions

Every formula below is also carried in code, in `shared/repMetrics.ts`
(`METRIC_DEFS`), and rendered as the tooltip behind the question mark on each
card. The number and its explanation ship from one module so they cannot drift.

### Activity

| Metric | Formula | Note |
| --- | --- | --- |
| Doors attempted | every knock logged | includes repeat visits |
| Doors visited | distinct doors with at least one knock | a door knocked three times is one visit |
| Verified doors | distinct doors where the fix placed the rep inside the grace radius | see *verification* below |
| Doors completed | distinct doors carrying a worked outcome | `not_home` and `prospect` do not complete a door |
| Untouched assigned doors | eligible assigned − ever worked | |
| Contacts | knocks where somebody answered | `was_home`, derived server-side from the outcome |
| Interested leads | knocks with the `interested` outcome | |
| Appointments | knocks that booked a **callback date** | see *appointments* below |
| Follow-ups created | knocks that set a callback date | |
| Follow-ups completed | later knocks on a door that already had one | |
| Revisits | knocks on a door this rep had already knocked | |
| Do-not-knock records | assigned doors nobody may knock | a property of the territory, not something a rep did |

### Conversion

| Metric | Formula |
| --- | --- |
| Contact rate | contacts ÷ doors attempted |
| Interest rate | interested ÷ contacts |
| Appointment rate | appointments ÷ contacts |
| Submission rate | submitted orders ÷ doors attempted |
| Close rate | submitted orders ÷ contacts |
| Install rate | installed ÷ submitted |
| Paid conversion | paid ÷ submitted |
| Cancellation rate | canceled ÷ submitted |
| Chargeback rate | chargebacks ÷ **paid** orders (org-configurable to submitted) |
| Follow-up conversion | orders from follow-up ÷ follow-ups completed |
| Callback completion | follow-ups completed ÷ follow-ups created |

Close rate is measured against people the rep actually spoke to, so a bad-luck
day of empty houses does not read as a closing problem.

The chargeback denominator is a named org setting because the choice changes the
number materially. It defaults to **paid**: a chargeback can only happen against
money that was actually paid, so dividing by submissions would understate the
rate for a rep whose orders mostly never installed - the opposite of informative.

### Territory utilization

| Metric | Formula |
| --- | --- |
| Territory utilization | doors **ever** worked ÷ eligible assigned doors |
| Coverage rate | doors visited in the period ÷ eligible assigned doors |
| Fresh-lead utilization | newly lit doors worked ÷ newly lit doors assigned |
| Time in assigned territory | seconds inside the polygon ÷ clocked-in seconds |
| Assignment aging | first meaningful activity − assignment time |

**Utilization is a stock, not a flow.** Using the day's attempts would report a
rep who finished their area yesterday as 0% utilized today, which is exactly the
reading that gets territory reclaimed from somebody who did the work.

Do-not-knock doors are removed from the denominator. A door nobody may knock is
not a door the rep failed to knock, and leaving it in makes a compliant rep look
under-utilized.

### Movement and time

| Metric | Formula | Note |
| --- | --- | --- |
| Active field time | clocked-in seconds, **overlapping shifts merged** | a missed clock-out cannot double the day |
| Doors per active hour | doors attempted ÷ clocked-in hours | |
| Time between doors (median) | median gap between consecutive knocks in one shift | **gaps over 45 minutes excluded** |
| Time between doors (average) | total counted gap ÷ number of gaps | the median is the honest figure |
| Longest inactive period | largest gap above 20 minutes inside one shift | |
| Time on door (dwell) | disposition time − arrival time | null where no arrival was recorded |
| Distance travelled | path length over accepted fixes | legs implying over 90 mph dropped |
| Distance per door | distance ÷ doors attempted | |
| Active work ratio | (clocked-in − inactive gaps) ÷ clocked-in | approximate; only the longest gap per day is stored |

**Why breaks are excluded from pace.** A rep who knocks at 9:00 and 9:05, takes
an hour for lunch, then knocks at 10:10 and 10:15 has a median gap of 5 minutes,
not 25. Including the break would make one lunch hour look like the slowest rep
on the team - the exact false accusation this feature must not manufacture. The
break is counted separately as an inactive period.

**Why median leads.** One 40-minute drive between neighbourhoods moves a mean far
more than it moves the rep's actual routine, and the mean is what a manager would
otherwise read as "slow".

**Route efficiency** is shown as a coaching observation only. It is never scored,
ranked, or used in any rule that produces an adverse insight.

### Two definitions worth stating plainly

**Verification.** A door is *verified* when the device fix placed the rep within
the org's grace radius. `unavailable` is **not** a failure state - a rep in a
basement, a dead phone, or an OS permission the org never asked for all land
there. Unverified doors are counted as attempts in full and never count against
the rep. See *GPS never blocks the work* below.

**Appointments.** This product has no `appointment` disposition, and
`shared/territoryMetrics.ts` already recorded the decision not to map
`interested` onto one - folding a soft "interested" into a booked appointment
would both overstate appointments and corrupt contact rate. That decision stands.
What this feature counts instead is a fact the schema genuinely persists: a knock
that set a **callback date**. The rep and the occupant agreed on a specific time
to come back. That is an appointment in every sense a manager cares about, and it
is what makes "appointment completion rate" mean anything.

---

## Field Mode

Field Mode is the **existing clock session plus a heads-up display**, not a
second shift concept. `/api/clock/in` and `/api/clock/out` remain the only things
that open and close a shift, so hourly pay, punch corrections and the Metrics
screen can never disagree about whether somebody was working.

### The flow

1. Rep taps **Start Field Mode**. This clocks them in.
2. If the org has location collection on and the rep has not yet acknowledged
   the current disclosure version, they are shown it. Tracking does not begin
   until they have.
3. The HUD shows doors today, doors remaining, contact rate, and the last
   disposition, refreshed once a minute.
4. While the shift is open **and** collection is active, a persistent
   "Location tracking active" indicator is rendered, naming the retention window
   and linking to the details. It is driven from the same server field the
   tracking gate uses, so the indicator cannot say off while collection is on.
5. Rep taps **End Field Mode**. This clocks them out and shows the shift
   summary: active time, doors visited, verified doors, contacts, appointments,
   submitted orders, distance, median time between doors, longest gap, and a
   comparison against their own 30-day average and personal best.

### GPS never blocks the work

This is a hard rule, enforced at three places:

- A disposition is **never** refused for a missing, weak, or denied fix. The
  record is marked `location not verified` and saved exactly like any other.
- The arrival endpoint returns `200 {recorded: false, reason}` rather than an
  error when it cannot write. A rep at a doorstep must never see a failure from
  a telemetry call.
- The `require_location_for_disposition` setting decides whether an unverified
  door is **flagged for review**. It can never decide whether the disposition is
  accepted.

### Offline behaviour

- Knocks queue offline and flush with a `client_id` idempotency key. A retried
  flush returns the existing row instead of double-logging.
- Arrivals take the same key, on a partial unique index over
  `(tenant_id, client_id)`.
- A knock that flushes hours later is attributed to the shift it was **taken**
  in, resolved by timestamp containment rather than "the newest open session".
- An offline knock whose outcome lost the compare-and-swap (a newer disposition
  already stood) is recorded as `superseded`. It counts as an **attempt** - the
  rep did walk up to that door - and contributes nothing to outcome counts.

---

## Privacy and location

The full policy is in [Field location privacy](../FIELD_LOCATION_PRIVACY.md).
What this feature adds:

### The metrics plane returns no coordinates

Metrics endpoints return **summaries** - seconds inside territory, metres
travelled, doors verified. Raw trails stay behind `field.location.export` in the
live-ops routes, which writes an append-only audit row on every pull.

A supervisor asking *"how is this rep doing"* gets numbers. A supervisor asking
*"where has this person been"* has to go through the door that writes an audit
record. Keeping those two questions on two different endpoints is the entire
point, and there is a test that fails if any metrics response contains a `lat`
or `lng` key.

### Admin → Settings → Field Activity & Privacy

| Setting | Default | Effect |
| --- | --- | --- |
| Enable field location tracking | off | the org-level switch (`mode`) |
| Require rep acknowledgment | on | no tracking before the disclosure is accepted |
| Capture interval | standard | battery saver / standard / high precision |
| Require active shift | on | no collection outside an open shift |
| Historical retention | 7 days | clamped 1-90; no setting can mean "keep forever" |
| Team leads may see live location | off | |
| Managers may see live location | on | |
| Require location for door dispositions | off | **flags** an unverified door; never blocks the save |
| Grace radius | 75 m | clamped 10-500 |
| Minimum dwell before verified | 0 s | clamped 0-600 |
| Raw location trails visible | **off** | off = summarized metrics only |
| Privacy notice text and version | - | changing the version re-prompts every rep |
| Require re-acknowledgment on change | on | |
| Chargeback basis | paid | paid or submitted orders |
| Leaderboards enabled | on | |
| Reps see team benchmarks | on | off = a rep sees only their own numbers |

Every change writes a **before and after** row to `admin_audit`, which is
protected by SQLite triggers against UPDATE and DELETE. "Who changed the location
policy and when" is the first question anyone will ask.

### Rules that are not settings

These are not configurable, by design:

- Location is never collected outside an open shift.
- Location data is never used for automatic discipline, pay deduction, or any
  adverse decision without human review.
- No coaching rule fires on location alone. Pace and territory-time rules require
  door activity to corroborate them, because an unverified fix means a weak
  signal far more often than it means a rep somewhere they should not be.
- A rep can always see their own collected activity.

---

## Permissions

| Capability | rep | team lead | manager | admin |
| --- | :-: | :-: | :-: | :-: |
| `dashboard.read.self` (My Metrics) | yes | yes | yes | yes |
| `coaching.read.self` (own insights) | yes | yes | yes | yes |
| `dashboard.read.team` (Team, Territory) | - | yes | yes | yes |
| `coaching.read.team` (Coaching board) | - | yes | yes | yes |
| `coaching.note.write` | - | yes | yes | yes |
| `field.location.read.team` (Live) | - | yes* | yes* | yes |
| `dashboard.read.org` (Reports) | - | - | yes | yes |
| `territory.reclaim.review` | - | - | yes | yes |
| `settings.manage.org` (privacy settings) | - | - | - | yes |

\* subject to the org's `allow_team_lead_live` / `allow_manager_live` settings.

**Scope is resolved server-side, always.** No endpoint accepts a rep id, team, or
territory and trusts it. The caller's scope comes from their own roster seat via
`liveOpsScope`:

- **Rep** - themselves only.
- **Team lead** - their full reports-to subtree.
- **Manager** - **their own branch**, not other managers' teams.
- **Admin** - the whole org.
- **Super admin** - only through an explicit organization context, always audited.

A client-supplied filter can only **narrow** that set. A request for somebody
outside scope returns **404, not 403**, because a 403 confirms the row exists,
which is itself a disclosure about a person the caller is not entitled to know
about.

Coaching notes are **private to supervisors unless explicitly shared**. Sharing is
a deliberate act at write time. Defaulting the other way would either stop
supervisors writing anything useful or blindside a rep with a file they never
knew existed.

---

## Territory utilization and reclaim

Each area is classified into one status:

| Status | Meaning |
| --- | --- |
| Fully worked | 90%+ of eligible doors worked |
| High conversion | 12%+ of attempts submitted, on a real sample |
| Healthy | working normally |
| High opportunity | a large unassigned pool worth deploying into |
| Needs attention | callbacks or recovery cases piling up |
| Underworked | under 25% utilization after a day assigned |
| Stale | no activity for 48 hours |
| Reclaim candidate | every reclaim condition below holds |

**The order these are tested in matters.** Best-case labels are checked first, so
an area that has been worked through is never tagged "underworked" merely because
there is nothing left in it to knock. That inversion is the easiest way for a
board like this to punish the people who finished.

An area below 20 eligible doors is never given a status beyond healthy: the rates
are too noisy to act on, and a 9-door area at 0% is not a finding.

### Reclaim requires every condition, not a score

A reclaim recommendation appears only when **all** of these hold:

- the area has been assigned for **4 or more days**, and
- utilization is **below 15%**, and
- there has been **no activity for 36 hours** (or none ever).

This is written as an explicit conjunction rather than a weighted score, so the
rationale a manager reads names the same facts the code checked. A score of 0.31
is not something you can put to a person; *"assigned 4 days, 8% of 300 doors
attempted, no activity in 36 hours, 47 newly lit doors untouched"* is.

### Nothing is reclaimed automatically

The Territory Metrics screen has **no endpoint that can take an area off a rep**.
The review control records a **decision** - kept, deferred, reassigned, or
reclaimed - to an audited row naming who decided and when. Actually moving doors
still happens on the Areas screen through the existing rank-gated routes, by
somebody who chose to do it.

There is a test that fails if the review endpoint changes any column on the
`territories` row.

---

## Coaching insights

Rule-based and explainable. There is no opaque score anywhere in this feature,
and no model output is treated as a source of truth.

Every insight carries: what happened, the supporting metrics, the comparison
baseline, a suggested action, the time period, and a link to the underlying data.

### The five rules the engine obeys

1. **No rule fires on a small sample.** Every rule declares a minimum
   denominator - 25 doors for contact-rate rules, 15 contacts for close-rate
   rules, 10 measured gaps for pace. A 0% close rate over four doors is a
   Tuesday, and a system that flags it teaches managers to ignore the system.
2. **No rule compares against a team of two.** Team baselines need at least
   **four** contributing members. Below that the "team median" is one
   identifiable colleague, and telling a rep they are below it is telling them
   about that person's numbers.
3. **An absent rate is not a bad rate.** A null rate is "no signal" and every
   rule declines to fire. A rep who was off sick never comes back to a coaching
   flag. Reps with no activity are also excluded from the team median rather than
   counted as zeros.
4. **The action is the point.** An insight with no suggested action is an
   accusation.
5. **Location never produces an adverse insight on its own.**

### The rules

| Insight | Fires when | Recommends |
| --- | --- | --- |
| High activity, low contact | volume fine, contact rate well below team | change **when** doors are knocked, work evening returns |
| Getting to the conversation, not through it | contact rate at or above team, close rate below | objection handling - explicitly **not** a territory change |
| Converting well, room for more doors | close rate above team, volume below | **more** territory |
| Verified activity, no sales | 40+ verified doors, 0 orders, healthy contact rate | pitch and closing coaching; says out loud not to cut territory |
| Time between doors running long | pace well above team **and** unworked doors nearby | route planning |
| Overdue callbacks | 3+ past their date (urgent at 10+) | clear callbacks before new territory |
| Booked returns not worked | callback completion under 50% | first hour on callbacks |
| Fresh doors untouched | fresh utilization under 30% on 25+ doors | prioritise newly lit |
| Orders cancelling | cancellation rate over 25% | confirm install window and first bill at the door |
| Assigned doors not started | 20+ untouched | start on the newly lit doors |
| Long gap in an active shift | 2+ hours between doors | *neutral* - a question, not a finding |
| Submission rate ahead of team | above team median | keep going |
| Orders are sticking | install rate above team | share how they qualify |

The slow-pace rule requires unworked doors nearby. "Slow" with nothing left to
knock is not slow - it is a rep who finished the area, and the gap is a routing
fact about the assignment rather than about the person.

The long-gap insight is deliberately `neutral` and worded as a question.
Appointments, drives, training and a dead phone all look identical in the data;
the system cannot tell them apart and says so.

### The list is capped, and always keeps a positive

Insights are capped at six, sorted most severe first. If the cap would drop every
positive insight, one is kept anyway. A board of pure red gets dismissed as noise,
and the real finding goes unread with the rest. The engine will not, however,
invent a strength it cannot support with a number - a rep with nothing above
threshold gets no positive insight rather than a hollow one.

### For managers

Insights are grouped **by severity, not by rep**. Grouping by rep produces a
ranked list of people, which is a league table however it is labelled. Grouping
by what needs doing produces a work queue.

The default sort on the team table is **doors attempted, not sales**. Opening a
coaching screen ranked by revenue frames every conversation as a sales league.

---

## Using this for coaching rather than punishment

The metrics exist to answer *"what should this person do differently tomorrow"*.
Some practical guidance:

- **Diagnose before acting.** High activity with low conversion and low activity
  with high conversion look similar on a leaderboard and need opposite
  responses. The insight engine names which one it is; the leaderboard cannot.
- **Do not reduce territory to fix a closing problem.** It removes the
  conversations the coaching needs. The engine says this explicitly in the
  `verified_activity_no_sales` insight because the reflex on seeing "55 doors, 0
  sales" is to take doors away.
- **A blank metric is not a zero.** Blanks mean there was nothing to measure.
- **Location gaps are not evidence.** Never open a conversation with "your GPS
  showed". Open it with the door activity, which is what the rules do.
- **Leaderboards are configurable and are not ranked on raw sales alone.**
  Supported boards include most improved conversion, best callback completion,
  best territory utilization, most recovered orders, and best verified activity.

The privacy policy prohibits using location data for automatic discipline, pay
deduction, or adverse decisions without human review. That is a policy commitment
and a legal exposure, not a preference.

---

## Performance and data processing

**Metric aggregation never runs inside an HTTP request.** better-sqlite3 is
synchronous, so a statement that scans `knock_log` for a whole org holds the only
thread this process has - and every other request, including a rep saving a
disposition on a doorstep, waits behind it. The yield engine already learned this
the expensive way (see `server/yieldRollups.ts` and the WAL-pinning incident it
documents), and this module copies its shape:

- Work is **chunked** - 40 rep-days per tick by default.
- Each slice **yields the event loop** with `setImmediate`, not a microtask.
- It runs on the cluster **primary only** - N workers draining one queue would
  each recompute the same rep-days.
- It **stands down** when the resource sentinel reports throttle-level pressure.
- It is **resumable** - the dirty-day queue is the cursor, and a crash costs one
  idempotent recomputation.
- The queue is drained **oldest first**, so a backlog is never starved behind a
  trickle of today's writes.

Recomputation is triggered two ways: the knock write path marks a rep-day dirty,
and a sweep marks every rep with an open shift or recent activity. The sweep
exists because some numbers change with no write at all - active seconds tick up
while a shift is open, and assignment counts change when somebody else's lasso
moves doors.

Dashboard reads only ever touch the rollup tables through bounded, indexed
selects. No HTTP handler aggregates `knock_log`.

**Tuning:**

| Variable | Default | Effect |
| --- | --- | --- |
| `REP_METRICS_ROLLUPS` | on | set to `off` to disable entirely |
| `REP_METRICS_CHUNK` | 40 | rep-days per tick |
| `REP_METRICS_TICK_MS` | 20000 | rollup cadence |
| `REP_METRICS_INSIGHT_TICK_MS` | 1800000 | insight and territory cadence |

### Time handling

All timestamps are stored in UTC. `metric_date` is a calendar date in the
**org's** timezone (`tenants.commission_timezone`) - the same one the commission
week uses, so a rep's "today" on this dashboard and on their pay statement are
the same day.

Day boundaries are computed through the calendar rather than by adding 86,400,000
ms, because a DST transition makes a local day 23 or 25 hours long and a fixed
offset would drop or double an hour of field work twice a year.

Timestamps are parsed defensively: this codebase writes both ISO strings and
SQLite's `datetime('now')` format, and the latter has no zone marker.
`Date.parse` would read it as local time, which on a US-East server shifts every
such timestamp by four or five hours. See `server/sqlTime.ts` for the full
history of this trap.

---

## Troubleshooting

### "My doors are not showing up"

1. **Check Field Mode is on.** Doors are recorded either way, but active time is
   not, so doors-per-hour and pace will be blank.
2. **Wait a minute.** Rollups run every 20 seconds and the dashboard reads the
   rollup, not the raw log.
3. **Check the date.** The day boundary is the *organization's* timezone. A knock
   at 11:50 PM local belongs to that day even if the server's UTC clock has
   rolled over.
4. **Check the rollup is running.** `rep_metrics.rollup` log lines report how
   many rep-days were written and how many are pending. If `pending` climbs
   without `written` moving, the job is standing down on resource pressure.

### "My doors are marked not verified"

That is a note about the **GPS fix**, not about the knock. Common causes: indoors
or in a basement, dense tree cover, location permission not granted, the device
returning a low-accuracy network fix, or the org's grace radius set tighter than
the address data supports.

None of it affects whether the disposition, note, follow-up, or sale was saved.
Unverified doors count in full toward doors attempted, contacts, and every
conversion rate. They are excluded only from the *verified doors* count.

If a whole team is suddenly unverified, check the grace radius setting and the
accuracy of the address points for that area before assuming anything about the
reps.

### "Dwell time is blank"

Dwell needs an **arrival** event, which is written when the rep opens the door
card in Field Mode. Doors dispositioned from a list, from the map without opening
the card, or through an offline flush that never recorded an arrival have no
dwell. This is expected, which is why every dwell metric carries its own sample
count rather than assuming the door count is the denominator.

An arrival older than 45 minutes is left open rather than producing an
implausible dwell - a rep who opened a card, walked away, and came back tomorrow
does not get a 19-hour time-on-door.

If dwell is blank *everywhere*, check the logs for
`rep_metrics.arrival_write_failed`.

### "Time between doors looks wrong"

Gaps over 45 minutes are excluded and counted as inactivity instead. If a rep's
median looks too low compared with their day length, that is why - and it is
correct. Compare *doors per active hour* for the whole-day picture.

Two doors either side of a clock-out are never compared. They are two different
days' work.

### "My team's median is not showing"

Team comparisons need at least four members with activity in the period. Below
that the median identifies an individual, and the comparison is withheld rather
than shown. The org can also switch off rep-facing benchmarks entirely
(`rep_sees_team_benchmarks`).

### "Offline knocks synced twice"

They should not - knocks carry a `client_id` idempotency key. If a door shows
duplicate attempts, check whether the second row is `superseded`, which means it
was recorded as field history but applied no status change and no money effect.
Superseded rows count as attempts, which is intentional.

### "The carrier and product reports are empty"

Those come from the provider order feed (`vendor_orders`). When that integration
is dark - as it is in this org today - the tables are legitimately empty and the
UI says so rather than rendering a convincing chart of zeros. Team yield on the
same screen comes from the metrics rollup and works regardless.

---

## Testing

| Suite | Covers |
| --- | --- |
| `tests/unit/rep-metrics.test.ts` | formulas, zero denominators, pace, shift merging, distance, aggregation |
| `tests/unit/coaching-insights.test.ts` | sample floors, baseline privacy floor, rule behaviour, language |
| `tests/unit/territory-health.test.ts` | status ordering, reclaim conjunction, risk score bounds |
| `tests/integration/rep-metrics-api.test.ts` | auth, scope, tenant isolation, no-raw-location, note privacy, review-only reclaim, offline idempotency |

Two of these caught real defects during development and are worth keeping
pointed at:

- `no raw location in the metrics plane` scans every metrics response for a
  `lat`/`lng` key. It is the mechanical guarantee behind the privacy claim above.
- `records a manager's decision without moving any doors` snapshots the
  `territories` row before and after a reclaim review and requires it unchanged.
