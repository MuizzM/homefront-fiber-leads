# Field location: what is collected, and what is not

This documents the location tracking behind the Live Operations dashboard. It is
written to be read by the people being tracked, not only by the people who
switched it on.

**This is not legal advice.** The last section lists the statutory duties that
apply to employee location tracking in the states Homefront operates in, and
they need review by counsel before this is enabled in production. I am not
qualified to sign that off, and nothing here should be treated as having done so.

## The short version

- Location is recorded **only while a rep is clocked in.** Off-shift movement is
  never collected - not filtered out on read, never written in the first place.
- Tracking is **on by default** once an org enables it. A rep does not have to
  opt in, but is always **told**, always **shown** that it is running, and can
  **pause** it where org policy permits.
- Precise points are **deleted after 7 days** by default.
- A supervisor sees **their own branch**, never the whole org.
- **Exporting** a rep's location history writes a permanent audit record.

## What is collected

While clocked in, and only then:

| Field | Why |
| --- | --- |
| latitude, longitude | the position itself |
| accuracy (metres) | so the map can show uncertainty instead of a false pinpoint |
| speed, heading | to distinguish travelling from working a block |
| device timestamp | the honest age of the fix |
| server timestamp | when it was received, kept separate from the above |
| shift id | so a point can be tied to the shift that authorised it |

Sampling is **event-based, not a fixed tick**: roughly every 60 seconds while
moving, 3 minutes while stationary, 5 minutes in a backgrounded tab. A fix
within 25 metres of the previous one is discarded unless 5 minutes have passed,
so a parked car does not generate a trail. A fix vaguer than 100 metres is
rejected outright unless nothing better has arrived for 10 minutes, and is then
flagged as low-confidence rather than drawn as though it were precise.

## What is deliberately NOT collected

- Any location while **off shift**, on a break, or after clock-out.
- **Session tokens, passwords, or credentials** of any kind.
- **Private messages** or message content.
- **IP addresses** and **user-agent strings**.
- **Device identifiers.** The presence table stores a coarse
  `phone | tablet | desktop` bucket - enough to tell a supervisor someone is on
  the road, and not a fingerprint that outlives its purpose.
- **Battery level**, app inventory, or anything else about the handset.

## Consent, and what "default on" means

Two separate records, deliberately not merged:

- **Policy** (`field_location_policy`) is what the **org** decided:
  `off` (the shipped default), `default_on`, or `locked_on`, plus the retention
  window and whether reps may pause.
- **Consent** (`field_location_consent`) is what the **rep** was told and
  acknowledged, stamped with the disclosure version.

Keeping them apart is what lets "default on" and "never secret" both be true.
The org may switch collection on without asking each rep; the rep still cannot
be tracked until they have been shown the disclosure and acknowledged it. If the
disclosure text changes materially, the version changes and every rep is asked
again rather than inheriting agreement to different words.

`locked_on` prevents a rep **disabling** tracking for a shift. It does not
prevent a documented pause, and it never bypasses the disclosure.

This is an **opt-out** model, not opt-in. That was an explicit product decision.
It is defensible for employer-provided tools during paid working hours in most
US jurisdictions, and it is exactly the point the state-law section below says
must be reviewed.

## Retention

Precise points are hard-deleted after the org's retention window - **7 days by
default**, configurable per org between 1 and 90 days, and capped by
`LOCATION_PINGS_KEEP_DAYS` so no org setting can mean "keep forever". The
nightly job (`server/dbPrune.ts`) does the deleting and records what it removed.

Deletion is a **hard delete, not anonymisation**. A movement trail with the name
stripped off is still a movement trail: the route identifies whoever walked it.

Aggregate daily counts (doors knocked, sales) are not location data and are kept
on the ordinary business schedule.

## Who can see what

| Role | Sees |
| --- | --- |
| Rep | themselves, and their own tracking state |
| Team lead | their full reporting subtree |
| Manager | **their own branch** - not other managers' teams |
| Admin | everyone in their org |
| Any other org | nothing, ever |

Scope is resolved **server-side** from the viewer's own roster seat
(`server/liveOpsScope.ts`). A client cannot widen it by passing a rep id, a team
or a territory; those can only narrow what the server already allows. A request
for someone outside scope returns **404, not 403**, because a 403 would confirm
that the person exists.

## Audit

| Event | Where it goes |
| --- | --- |
| Viewing the dashboard | `activity_log`, once per viewer per 15 minutes |
| Opening a rep's panel | `activity_log` |
| **Exporting location history** | `admin_audit` - append-only, with the range and row count |
| Changing the org policy | `admin_audit`, with before and after |

`admin_audit` is protected by SQLite triggers that reject UPDATE and DELETE, so
the record of who pulled a person's movement history cannot be quietly removed.

View logging is coalesced deliberately: a dashboard polling every ten seconds
would otherwise file 360 rows an hour per viewer, and an audit trail nobody can
read is the same as no audit trail.

## Legal considerations requiring review

Employee location tracking is regulated unevenly across US states, and the rules
turn on employer-owned vs personal devices, on-duty vs off-duty hours, and
whether notice or affirmative consent is required.

- **California** - Penal Code §637.7 restricts electronic tracking of a person's
  location; the employer-owned-vehicle/device carve-outs are narrow. CCPA/CPRA
  additionally treats precise geolocation as **sensitive personal information**,
  triggering notice-at-collection and limits on secondary use.
- **Illinois** - one of the strictest notice regimes; BIPA is not directly
  implicated by GPS but the state's general posture on employee monitoring is
  demanding.
- **New York** - Civil Rights Law §52-c requires **written notice** to employees
  subject to electronic monitoring, acknowledged at hire.
- **Connecticut** - Gen. Stat. §31-48d requires **prior written notice** of
  electronic monitoring, posted conspicuously.
- **Delaware** - Code tit. 19 §705 requires daily notice or one-time written
  acknowledgement before monitoring.
- **Texas / North Carolina** (Homefront's current footprint) have no
  location-specific statute, so the general rules - consent, purpose limitation,
  and off-duty boundaries - govern.
- **EU / UK**, if ever applicable: continuous location tracking of workers needs
  a lawful basis, a DPIA, and a proportionality assessment. "Because we can" is
  not one.

Common threads the implementation already reflects: **notice before collection**,
**purpose limitation** (operations, not surveillance), **no off-duty tracking**,
**data minimisation**, and **bounded retention**.

What still needs a decision from counsel and ownership:

1. Whether the **opt-out** posture is acceptable in every state Homefront
   operates in, or whether some require affirmative written consent.
2. Whether the disclosure text meets each state's **written notice** wording.
3. Whether reps must be able to pause in all jurisdictions, i.e. whether
   `locked_on` is lawful everywhere it might be used.
4. Whether 7 days is the right default given any retention duties that cut the
   other way (wage-and-hour disputes, vehicle claims).

## Turning it on

Collection ships **off**. Enabling it is a deliberate admin action
(`PATCH /api/live-ops/policy`) that writes an append-only audit row naming who
changed it and what it was before - because "who switched on employee tracking,
and when" is the first question anyone will ask.
