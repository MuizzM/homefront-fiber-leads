# PerfectVision submitted orders and order recovery

Status: manual import is complete and usable. Automated retrieval and automated
messaging are both dark and stay dark until specific authorizations exist. Last
reviewed 2026-08-11.

This document describes engineering controls, not legal advice. Messaging law is
fact- and jurisdiction-specific. The same posture `docs/CALLING_COMPLIANCE.md`
records applies here: an organization needs written approval from qualified
counsel for its sender identities, consent language, templates, states and
message purposes before the messaging flag is turned on for it.

## What this integration is for

Every submitted order is a commission that has not happened yet. Between
submission and install an order can stall in a dozen ways, most of them
silently: a document never arrived, a technician knocked and nobody was home,
the provider put it on hold pending construction. This plane imports the
provider's own view of those orders, matches each one to the sale it came from,
and puts the ones that stalled in front of the rep who sold them while a phone
call still changes the outcome.

Source report: **Total Submitted Orders by Program**, in the PerfectVision POE
portal (report id `00O5f000008aWTiEAM`).

## What it deliberately does not do

- **It never writes to PerfectVision.** There is no create, submit, modify,
  cancel, approve or delete path. The integration is read-only by construction,
  not by convention.
- **It never logs into the portal for you.** See "Automated retrieval" below.
- **It never decides what a rep is paid.** `installed` here means a technician
  finished. Paid comes from the Commission File plane and nowhere else.
- **It never sends a message on its own.** Opening a recovery case is a work
  item on a screen. Sending is a separate, consent-gated act.

## Architecture

```
POE report export (CSV/XLSX, uploaded by an admin)
  -> parse            server/providers/perfectVisionSubmittedOrders.ts
  -> normalize        shared/orderColumnMapping.ts, shared/orderStatusSource.ts
  -> match            server/orderMatching.ts        -> commission_sales
  -> record           server/vendorOrderStore.ts     -> vendor_orders + events
  -> evaluate         server/orderRecoveryEngine.ts  -> order_recovery_cases
  -> (optional) send  server/orderRecoveryMessaging.ts, gated by
                      shared/contactConsent.ts
```

Everything above the `match` line is provider-specific and lives behind the
`OrderStatusSourceProvider` interface (`shared/orderStatusSource.ts`). A second
carrier order feed is a sibling file in `server/providers/` and changes nothing
downstream.

The work runs in a background worker (`server/vendorOrderImportWorker.ts`),
never in the upload request: parsing and matching a 40,000-row export is minutes
of synchronous SQLite work, and this app runs on one thread.

## Exporting the report

1. Sign in to the PerfectVision POE portal with your own dealer account.
2. Open **Total Submitted Orders by Program**.
3. Set the date range you want. A rolling 60 to 90 days is the usual choice:
   long enough to catch an order that stalled in June, short enough to keep the
   file small.
4. Export as **CSV** or **XLSX** (both are supported; the format is detected
   from the file's bytes, not its extension).
5. Upload it at **Governance -> Order Imports**.

Files above 25 MB or 100,000 rows are refused rather than truncated. Split the
report by date range and import each part; a silently truncated import looks
like a complete one, and the orders it dropped are exactly the ones nobody
chases.

### Required source fields

The report's column NAMES are never assumed - you bind them yourself. What the
pipeline needs is:

| Purpose | Requirement |
| --- | --- |
| Identity | At least one of order ID, transaction ID, or customer account number. **Required.** |
| Status | The order status column. **Required.** |
| Address | Service address. Strongly recommended: without it, matching is ID-only and the queue cannot show a location. |
| Dates | Submitted or sale date, scheduled install date, install date. Without a submitted date, stale-order detection cannot run. |
| Rep | Rep name and, if the carrier issues one, rep ID. Without a rep column, cases cannot be routed back to the person who sold the order. |
| Contact | Customer name, phone, email. Only needed if you intend to message. |
| Reasons | Failure or cancellation reason, required customer action. These drive priority. |

## How mapping works

A Salesforce report export is not an API. Its headers depend on who built the
report, which columns they left in, whether they renamed any, and which version
they ran. So the mapping is **data**: stored per organization, edited by an
admin looking at their own export.

The screen does three things and refuses to do a fourth:

1. **Suggest.** Given the real headers, it proposes a mapping. A suggestion is a
   convenience for your first visit and never becomes the live mapping on its
   own.
2. **Validate.** It says precisely why a mapping cannot be used yet, with every
   problem at once. Errors block saving; warnings do not, but you see them.
3. **Preview.** It shows what the first rows would become, including a table of
   every distinct status in the file and what each one was read as.

It will not auto-detect its way into production. Auto-detection that silently
becomes the live mapping is the failure this design exists to prevent: it works
on the sample, then quietly binds "Install Date" to the SCHEDULED date on a
later export and every order in the org looks installed.

The preview never shows a customer phone number or email address. It reports
whether the column HAS them and at what rate they parse, which is all a mapping
check needs.

### Status mapping

Provider status text is normalized into a fixed vocabulary
(`shared/orderStatusSource.ts`): `submitted`, `accepted`,
`pending_customer_action`, `pending_documents`, `install_scheduled`,
`installed`, `failed_install`, `missed_appointment`, `canceled`, `rejected`,
`on_hold`, `unknown`.

The rules are conservative and ordered most-specific-first. Failure phrases are
matched before success phrases, because provider text routinely contains both
words: "install failed" must never read as installed, and "canceled after
install scheduled" must never read as scheduled.

Anything unrecognised becomes `unknown` - never a guess. Unknown rows import,
are counted, and are visible, and they drive no automatic action until somebody
maps them. Use the **status overrides** box on the mapping screen to teach the
system what a phrase like "PROJECT HOLD ZZ" means for your organization.

### Timezones

A report exported from a browser carries local dates with no offset. Set the
report timezone on the mapping screen. Date-only values become UTC midnight of
that calendar day; date-and-time values are read in the report's timezone. This
is not cosmetic: read as UTC on a server, a 7pm install appointment lands on the
previous day, and "install today" is then wrong for exactly the evening
appointments that matter most.

## Matching

Imported rows are matched to `commission_sales` by a ladder, and the confidence
decides the consequences:

| Confidence | Rule | Result |
| --- | --- | --- |
| 1.00 | External order ID equals `commission_sales.external_order_id` | Matched. Attributes the order. |
| 1.00 | External transaction ID | Matched. |
| 0.95 | Customer account number | Matched. |
| 0.90 | Rep's carrier-issued ID + address + carrier | Matched. |
| 0.80 | Rep NAME + address + carrier | Review. |
| 0.75 | Address + carrier + sale date in window | Review. |
| 0.50 | Customer name + address | Suggestion only. |

At or above **0.90** the order is linked, the rep is attributed, the recovery
engine may open a case, and (subject to every consent rule) a message may
eventually be sent. Below that, the row lands in the review queue with its
candidates attached and does nothing on its own.

Ambiguity is a refusal, not a tie-break. When a rule produces more than one
candidate the rule fails rather than picking the first row: two sales at one
address on one day is a real situation (a duplex, a resubmission), and guessing
attributes a commission to the wrong rep and texts the wrong customer.

### Resolving a match exception

**Governance -> Order Imports -> Orders that need a decision.**

Each row shows the provider's order identity, the address, the product, the rep
name on the report, and why it could not be matched. You can:

- **Link to this sale.** Enter the internal sale ID. A human confirmation is a
  full-confidence match, and it also stamps the carrier's IDs onto that sale so
  the NEXT import matches at tier one without anybody. Resolving an exception
  should make the next one less likely, not just clear this one.
- **Re-check.** Re-runs the matcher, for after somebody has added the carrier's
  order ID to the sale by another route.
- **Not ours.** Marks the row ignored, with a note.

All three are recorded in the admin audit trail with the actor, the decision and
the note.

## How recovery works

After every import (and on demand from the policy screen), each touched order is
evaluated. The decision is pure and lives in `shared/orderRecovery.ts`.

### What never opens a case

Checked first, and in this order:

1. The order is installed.
2. Commission truth says it was paid.
3. It is flagged fraudulent.
4. The household is marked do-not-contact.
5. The customer has opted out of every channel we hold.
6. The order is not matched to a sale at high confidence.
7. The failure reason matches the organization's non-recoverable list.
8. An active case already exists.

### Triggers and priority

| Trigger | Default priority |
| --- | --- |
| Failed install, within the urgent window | Urgent |
| Missed appointment, within the urgent window | Urgent |
| Install date passed with no install, recent | Urgent |
| Failed install or missed appointment, older | High |
| Customer action needed | High |
| Missing documents | High |
| On hold | Medium |
| Accepted with no install date after N days | Medium |
| Submitted with no progress after N days | Medium |
| Provider reason flagged as fixable | Medium |
| Canceled and on the recoverable list | Low |

A stall is measured from the last time the PROVIDER touched the order, not from
submission. An order submitted six weeks ago that the provider updated yesterday
is not stalled; somebody is working it.

Priority only ever goes up on re-evaluation. An admin who deliberately dropped a
case to low does not get it handed back on the next run.

Cancellations never auto-open by default. The recoverable-reasons list starts
empty, and a phrase has to be added to it deliberately.

### Configuring it

**Governance -> Recovery Messaging -> Policy.** Everything is per organization:
stall windows, the install grace period, the cancellation window, the urgent
window, both reason lists, and an estimated per-order value that turns case
counts into a commission-at-risk figure. That figure is labelled an estimate
everywhere it appears, because it is one. Real commission comes from the
commission file.

## Working the queue

- **Rep -> My recoveries** shows only cases assigned to that rep. The server
  scopes it from their roster seat; there is no filter that could widen it.
- **Manage -> Order Recovery** shows the supervisory queue, scoped to the
  caller's own branch (the same resolver the live map uses), plus the funnel and
  the recovery metrics.

A case shows the customer and address, carrier, product, program, original rep,
current owner, order status, failure or hold reason, install dates, days
stalled, last contact, next action, consent status, and the full timeline of
both the case and the provider's own status changes.

Actions: assign or reassign (supervisory), add a note, schedule a callback, mark
resolved with an outcome, mark not recoverable, draft a message, send an
approved message.

## Consent and suppression

Messaging is fail-closed and has no override. `shared/contactConsent.ts` is the
one decision point, and there is no argument to it that lets a suppression, an
opt-out, or a missing consent record be bypassed. A rep cannot override an
opt-out because the code has nowhere to put the override.

A send requires **all** of:

1. `PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED=true` on the server.
2. The organization has approved messaging, and confirmed a consent policy.
3. The order is matched to a sale at high confidence.
4. A valid destination on file.
5. Not suppressed, and not do-not-contact.
6. A consent record whose basis covers this channel and this message purpose.
   A service update about an order the customer placed accepts an existing
   business relationship; marketing by text requires express written consent.
7. An approved template, and a configured sender.
8. Opt-out wording in a text; an unsubscribe link and the company's postal
   address in an email. Checked against the RENDERED body, not the template.
9. Inside the recipient's local contact hours. An unresolvable timezone blocks -
   a state that spans two zones cannot place a customer's evening.
10. Inside the frequency caps: per contact per day, per case in total, and a
    minimum gap between messages.

A blocked send is still recorded, with its reason codes, so a compliance review
can prove the wall held rather than infer it from an absence.

### Opt-outs

- **STOP by text.** The inbound webhook (`POST /api/order-recovery/sms/inbound`,
  shared-secret gated) suppresses the number in every organization that has
  messaged it, immediately. Matched as a whole message: a customer writing
  "please stop by on Thursday" is not silently suppressed, because losing a
  recoverable order and reading as ignored is its own failure.
- **Email unsubscribe.** Every recovery email carries a signed unsubscribe link
  and RFC 8058 one-click headers. The link is public by design: a mechanism that
  needs a login is not a functional unsubscribe.
- **Lifting a block** is an administrator action, requires a written reason, and
  is audited. There is no delete path. A customer who opts out again after a lift
  is re-blocked.

### The consent ledger

`customer_contact_consents` records the channel, a keyed hash of the
destination, the status, the basis, the source, the language shown, when it was
captured, and a proof reference pointing at wherever the artifact actually lives.
Newest record wins, so a customer who revoked in June and re-subscribed in
August is subscribed.

Destinations are stored as keyed hashes plus a masked display form, never in
plain text. A suppression list is the one table an attacker most wants: it is a
list of people who are definitely reachable.

## Templates

**Governance -> Recovery Messaging -> Templates.** Seeded on first visit as
DRAFTS. Shipping a template is not approving it: an admin reads each one, edits
it into their own voice, and approves it. Editing an approved template publishes
a NEW draft version rather than changing words an approval was granted for.

Variables: `{{customer_first_name}}`, `{{carrier}}`, `{{product_sold}}`,
`{{program}}`, `{{service_address}}`, `{{install_date}}`, `{{support_phone}}`,
`{{rep_name}}`, `{{company_name}}`, `{{company_address}}`, `{{callback_link}}`,
`{{unsubscribe_link}}`.

Rendering refuses on an unknown variable and on an empty value. "Hi , this is
about your order" is worse than no message at all. Values substituted into an
HTML email are escaped: a customer name is whatever a rep typed at a door and
then travelled through a provider's report, and it is not trusted markup.

Kinds: install reminder, missed installation, customer action needed, missing
documents, failed installation, canceled-order recovery, final follow-up.

## Commission integration

An order and a commission are linked by external order or transaction ID.

- `installed` from this plane advances the CRM funnel and closes a recovery
  case. It never means a commission was earned or paid.
- Paid, chargeback and reversal come from the Commission File plane, which
  writes into `vendor_order_commission_links`. Until it does, an order's
  commission panel says "no commission record yet" rather than implying one.
- A chargeback that arrives months later lands on the same order's timeline.

The sequence a report can show end to end: order source -> submitted ->
installed -> paid, and separately for recovered orders: case created -> outreach
-> recovered -> installed -> paid.

## Automated retrieval

`PERFECTVISION_ORDER_SYNC_ENABLED=false`, and it should stay that way until
PerfectVision has authorized automated delivery for this dealer in writing.

The provider has **no scraping path**. The POE report is an authenticated
Salesforce Experience Cloud page, and driving it server-side would mean storing a
dealer's portal password, replaying their session cookie and CSRF token, and
parsing HTML the vendor may restructure without notice. That is
credential-sharing against a vendor system, it is the kind of automated access a
portal's terms typically prohibit, and it produces an integration that breaks
silently and looks like a compromised account while it does.

So `fetchOrderReport` refuses in three places: the flag, the connection mode,
and the absence of an authorized delivery. Turning the flag on without
configuring an approved export endpoint, SFTP drop, or scheduled report delivery
changes nothing except the error message.

**To enable it later:** obtain written authorization, configure the delivery,
implement it in the marked branch of
`server/providers/perfectVisionSubmittedOrders.ts`, set the connection mode, and
only then set the flag. Record the authorization reference on the connection.

## Operations

### Environment

```bash
openssl rand -hex 32   # VENDOR_ORDER_ENCRYPTION_KEY
openssl rand -hex 32   # VENDOR_CONTACT_HASH_KEY
```

```dotenv
PERFECTVISION_ORDER_SYNC_ENABLED=false
PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED=false
VENDOR_ORDER_ENCRYPTION_KEY=
VENDOR_CONTACT_HASH_KEY=
PUBLIC_BASE_URL=
RECOVERY_SMS_WEBHOOK_SECRET=
```

Without `VENDOR_ORDER_ENCRYPTION_KEY` the pipeline still runs, but the uploaded
file is not stored and the original row data is not retained. The import record
says so, and the admin screen shows a banner. That is deliberate: writing a
provider report's customer data to disk in the clear because an env var was
missing is not a degraded mode.

### Permissions

| Capability | Held by | Opens |
| --- | --- | --- |
| `order.read.self` / `.team` / `.org` | rep / team lead / manager | Order lists |
| `order.import.manage` | admin | Upload, mapping, connection, raw file download |
| `order.match.resolve` | manager | The exception queue |
| `recovery.read.self` / `.team` / `.org` | rep / team lead / manager | The queue |
| `recovery.work` | rep | Notes, callbacks, resolution |
| `recovery.manage` | manager | Assignment |
| `recovery.message.draft` / `.send` | rep | Drafting and sending |
| `recovery.policy.manage` | admin | Stall windows, caps, approval |
| `messaging.templates.manage` | admin | Authoring and approving templates |
| `contact.consent.manage`, `contact.suppression.manage` | admin, compliance admin | The ledgers |

### Runbook

**An import is stuck in "Importing".** The worker reclaims anything stuck past
15 minutes and requeues it, up to three attempts, then fails it with a message.
Check that the control process is running and that `VENDOR_ORDER_WORKER` is not
`off`. `SELECT id, status, attempts, safe_error_summary FROM vendor_order_imports
ORDER BY id DESC LIMIT 10;`

**An import failed with "the uploaded file is no longer available".** No
encryption key was configured, so the bytes were held in memory only and a
restart lost them. Set `VENDOR_ORDER_ENCRYPTION_KEY` and upload again.

**Everything landed in the exception queue.** Almost always the mapping. Check
that the identity column is bound to the column that actually carries the
carrier's order ID, and that internal sales carry those IDs. The fastest fix is
to resolve a handful by hand: each resolution stamps the ID onto the sale, so
the next import matches them automatically.

**Orders imported but no cases opened.** Either the orders are healthy, or they
are unmatched (an unmatched order never opens a case), or the stall windows are
longer than the file's age. Check `match_status` on `vendor_orders` and the
policy screen.

**Nothing is sending.** The Recovery Messaging screen lists every blocker in
plain words at the top. In order of likelihood: the server flag, no approved
template, no sender identity, no postal address, no consent record.

**A customer says they still get messages after opting out.** They should not:
suppression is checked at send time from the database, on both hash schemes.
Check `customer_contact_suppressions` for their normalized destination and look
for a `lifted_at` - a lift is audited with the actor and the reason in
`admin_audit`.

**Re-importing the same file.** Refused with a 409 naming the earlier import.
Confirm to override. An unchanged row is recognised by its content hash and
writes no event, so a deliberate re-import is free.

### What is auditable

- `vendor_order_events` - every provider status transition, append-only,
  enforced by database triggers.
- `order_recovery_case_events` - every assignment, note, callback, message and
  resolution, append-only.
- `order_recovery_outreach` - every message drafted, sent or blocked, with the
  rendered body and the consent basis frozen onto it.
- `admin_audit` - mapping saves, exception resolutions, policy changes, template
  approvals, suppression additions and lifts, raw file downloads, and every
  blocked send.

## Tests

```bash
DATA_DIR=$(mktemp -d) npm test -- tests/unit/order-status-source.test.ts tests/unit/order-column-mapping.test.ts tests/unit/order-recovery-policy.test.ts tests/unit/contact-consent-gate.test.ts tests/unit/order-recovery-templates.test.ts tests/unit/xlsx-reader.test.ts tests/integration/vendor-order-import.test.ts tests/integration/order-recovery-messaging.test.ts
```

A pristine `DATA_DIR` matters: the development `data.db` is large enough to make
timing-sensitive tests fail.
