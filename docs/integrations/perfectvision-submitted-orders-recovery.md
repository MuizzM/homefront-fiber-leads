# PerfectVision submitted orders and order recovery

Status: manual import is complete and usable. Scheduled delivery (the automated
path, as a push) is built and ships dark: it needs the delivery secret, the
sync flag, and an enabled scheduled_export connection, and the flag stays off
until PerfectVision authorizes automated delivery in writing. Automated
messaging is dark under its own flag. The Commission File plane (provider-paid
truth, the writer of `vendor_order_commission_links`) is built - see
"Commission integration" below. Last reviewed 2026-08-16.

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
POE report export (CSV/XLSX, uploaded by an admin,
                   or POSTed by a scheduled delivery)
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

An order and a commission are linked by external order or transaction ID, and
by the Windstream account number once a human has confirmed it (below).

- `installed` from this plane advances the CRM funnel and closes a recovery
  case. It never means a commission was earned or paid.
- Paid, chargeback and reversal come from the Commission File plane, which
  writes into `vendor_order_commission_links`. Until it does, an order's
  commission panel says "no commission record yet" rather than implying one.
- A chargeback that arrives months later lands on the same order's timeline.

The sequence a report can show end to end: order source -> submitted ->
installed -> paid, and separately for recovered orders: case created -> outreach
-> recovered -> installed -> paid.

### The Commission File plane

Built and live in code (2026-08-16). Source: the **Commission File** page under
My Account on the PerfectVision dealer site (https://www.perfect-vision.com,
dealer HF336) - an HTML table with a date-range filter, exported or captured as
CSV. Like the orders report there is no fetch path and never will be; an
operator exports the page and uploads it. Unlike the orders report the columns
are FIXED (the vendor renders the page, nobody composes it), so there is no
per-organization mapping screen: headers bind by name, tolerant of case and
spacing only, and a file whose headers changed is refused with the missing
names spelled out.

```
Commission File export (CSV/XLSX, uploaded by an admin)
  -> parse + normalize  server/providers/perfectVisionCommissionFile.ts,
                        shared/commissionSource.ts
  -> line state         server/commissionFileStore.ts  -> commission_file_lines
                        (identity: account + document + product + category,
                         NEWEST upload date wins; older restatements are
                         evidence in commission_file_rows, never a regression)
  -> match              server/commissionMatching.ts
  -> money              vendor_order_commission_links (this plane is that
                        table's one writer; one link per line, upserted, so a
                        line restated Open -> Closed updates its link rather
                        than stacking amounts; chargebacks land negative on
                        the SAME order)
```

Upload at `POST /api/commission-imports` (multer in-memory, checksum dedupe
with an explicit override, encrypted at rest under the same
`VENDOR_ORDER_ENCRYPTION_KEY`, processed by `commissionFileImportWorker` -
kill-switch `COMMISSION_FILE_WORKER=off`). Preview without importing at
`POST /api/commission-imports/preview`. The review queue lives at
`GET /api/commission-imports/exceptions/list` with resolve and rematch beside
it. Capabilities are borrowed from the order screens - `order.import.manage`
uploads, `order.match.resolve` works the queue - because it is the same class
of provider evidence handled by the same people.

**The join, and why it goes through people.** The commission file carries NO
Chuzo order number, and the orders report carries no account number, so on
first contact the two planes share no machine identity. The ladder is:

| Confidence | Rule | Result |
| --- | --- | --- |
| 1.00 | Account number equals `vendor_orders.account_key` | Matched. Money attaches. |
| 0.95 | Account number equals `commission_sales.customer_account_number` | Matched. Money attaches. |
| 0.75 | Customer name + act/deact date near the sale's own dates | Review. NO money. |

Money never attaches below matched-at-full-confidence. A name-and-dates fit
waits in the review queue; two candidates is a refusal. Confirming a line
stamps the Windstream account number onto the sale AND the vendor order and
then sweeps the account's other lines (the fiber plan, the security add-on,
tech support all share one account and document), so one human decision
settles the account and every later file matches it at the top rung by
itself. The intended shape is exactly that: the FIRST file lands almost
entirely with a human, and the second file almost entirely without one.

**Row shapes worth knowing** (all present in the captured fixture
`tests/fixtures/perfectvision/commission-file-2026-07-17_2026-08-16.csv`):
negative amounts render as `($45.00)` and thousands as `"$2,405.00"`; a batch
`Payment` row with empty account, document and agent is the weekly payout
total (recorded, category `payment_batch`, never an exception); an all-caps
`PAYMENT` row with an account is a manual spiff whose customer name exists
only inside the Comments string (`WI: NAME - PRODUCT/ACTV`); a `/FCHB` comment
suffix marks a first chargeback.

**What it deliberately does not do.** It never books a sale, prices a
statement, or moves a payout - `server/commissionService.ts` owns what a rep
is paid, and this plane records what the provider paid the dealership beside
it (see docs/COMMISSIONS.md, "Provider-paid truth"). Its only write into the
internal ledger is stamping `customer_account_number` onto a sale a human
confirmed.

## Automated retrieval

`PERFECTVISION_ORDER_SYNC_ENABLED=false`, and it should stay that way until
PerfectVision has authorized automated delivery for this dealer in writing.

The provider has **no scraping path**, and never will. The POE report is an
authenticated Salesforce Experience Cloud page, and driving it server-side
would mean storing a dealer's portal password, replaying their session cookie
and CSRF token, and parsing HTML the vendor may restructure without notice.
That is credential-sharing against a vendor system, it is the kind of automated
access a portal's terms typically prohibit, and it produces an integration that
breaks silently and looks like a compromised account while it does.
`fetchOrderReport` - the pull path - still refuses unconditionally.

What exists instead is a **push**: scheduled delivery. The report leaves the
portal by a mechanism the vendor itself provides (a Salesforce report
subscription that emails the export on a schedule, or a delivery PerfectVision
sets up), a bridge extracts the file, and posts the bytes to this server. No
process of ours ever holds a portal credential or opens a connection to
PerfectVision.

### The delivery endpoint

```
POST /api/order-imports/scheduled-delivery
x-webhook-secret:    ORDER_REPORT_DELIVERY_SECRET   (required; without it the route answers 404)
x-report-filename:   optional file name for the import history
x-organization-id:   required only when MORE THAN ONE org has an enabled scheduled delivery
content-type:        text/csv or application/octet-stream
body:                the report file itself, raw bytes (CSV or XLSX; sniffed)
```

Three server-side switches all have to agree before a byte is accepted, and
each is independently a kill switch:

1. `ORDER_REPORT_DELIVERY_SECRET` (16+ characters) - authenticates the
   deliverer. Unset or short, the endpoint does not exist (404).
2. `PERFECTVISION_ORDER_SYNC_ENABLED=true` - the operator's record that
   PerfectVision authorized automated delivery. Keep the authorization
   reference with the connection.
3. An **enabled** connection in **scheduled_export** mode - the per-org opt-in,
   set from Governance -> Order Imports ("Turn on scheduled delivery"). The org
   a delivery lands in is resolved from this state, never from the request.

A delivery then follows exactly the manual-upload pipeline: the org's saved
mapping (409 if none exists yet - run one import by hand first), the same size
and row caps, the same worker, the same matching and recovery evaluation, the
same import history and audit trail (`order_import.scheduled_delivery.received`).
Responses: 202 accepted with the import id; 200 with `duplicate: true` when the
identical file was already imported (a subscription re-sending an unchanged
report is a normal day, so this is success, not an error); 400 malformed body;
413 too large.

The "Check readiness" button on Governance -> Order Imports runs the connection
test and states, in order, which of the three switches is not satisfied.

### Getting the report to the endpoint

**Preferred: the portal's own report subscription.** Signed in to the POE
portal, open Total Submitted Orders by Program and look for Subscribe (on
Lightning reports it lives on the report actions menu). Schedule it daily,
attach the results as a .csv file, and address it to the delivery mailbox. Two
cautions: Salesforce caps attached report files at roughly 15,000 rows, so keep
the report's date filter to a rolling window (30 to 60 days) rather than
all-time - a rolling window re-delivered daily is the intended shape, since
unchanged rows are free and changed rows update in place. And if the Subscribe
action is not exposed to a partner login, ask the PerfectVision account rep to
schedule the delivery from their side - that conversation is also the natural
place to obtain the written authorization the flag requires.

**The bridge: mailbox to endpoint.** Any email pipe works; the contract is only
"extract the attachment, POST the bytes". With Cloudflare Email Routing (this
org already runs its marketing DNS on Cloudflare) the whole bridge is one Email
Worker on a routed address such as `poe-reports@homefrontsolutionsllc.com`:

```js
// Cloudflare Email Worker. Route: poe-reports@<domain> -> this worker.
// Vars: CRM_DELIVERY_URL, ORDER_REPORT_DELIVERY_SECRET (secret), ALLOWED_SENDERS.
import PostalMime from "postal-mime";

export default {
  async email(message, env) {
    const allowed = (env.ALLOWED_SENDERS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const from = String(message.from ?? "").toLowerCase();
    if (allowed.length && !allowed.some((a) => from.endsWith(a))) {
      message.setReject("Sender not allowed");
      return;
    }
    const email = await PostalMime.parse(message.raw);
    const report = (email.attachments ?? []).find((a) =>
      /\.(csv|xlsx)$/i.test(a.filename ?? "") || /text\/csv|spreadsheetml/.test(a.mimeType ?? ""));
    if (!report) return; // a subscription email with no attachment is ignored
    const res = await fetch(env.CRM_DELIVERY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webhook-secret": env.ORDER_REPORT_DELIVERY_SECRET,
        "x-report-filename": report.filename ?? "report.csv",
      },
      body: report.content,
    });
    if (res.status !== 202 && res.status !== 200) {
      console.log("poe delivery failed", res.status, await res.text());
    }
  },
};
```

Restrict `ALLOWED_SENDERS` to the sending domain of the subscription mail (for
a Salesforce subscription that is typically the org's Salesforce sender or
PerfectVision's own domain - read one real message before pinning it).

**Fallback: any scheduler that can run curl.** Wherever the export file already
lands (an SFTP drop, a synced folder), this is the entire integration:

```bash
curl -sS -X POST "https://portal.homefrontsolutionsllc.com/api/order-imports/scheduled-delivery" \
  -H "x-webhook-secret: $ORDER_REPORT_DELIVERY_SECRET" \
  -H "x-report-filename: total-submitted-orders.csv" \
  -H "content-type: text/csv" \
  --data-binary @report.csv
```

**To enable end to end:** obtain the written authorization, set
`ORDER_REPORT_DELIVERY_SECRET` and `PERFECTVISION_ORDER_SYNC_ENABLED=true` on
the server, turn on scheduled delivery for the org on Governance -> Order
Imports, configure the subscription and the bridge, then watch the first
delivery land in the import history. The first import must still be done by
hand - deliveries refuse until a saved mapping exists, because the mapping
screen is where a human confirms what each column means.

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
ORDER_REPORT_DELIVERY_SECRET=   # 16+ chars; unset, the delivery endpoint answers 404
```

Without `VENDOR_ORDER_ENCRYPTION_KEY` the uploaded file is not stored and the
original row data is not retained. The import record says so, and the admin
screen shows a banner. That is deliberate: writing a provider report's customer
data to disk in the clear because an env var was missing is not a degraded
mode. In a SINGLE-process deployment the import still runs from memory; in
production the upload's in-memory buffer and the worker that claims the job are
not guaranteed to share a process, and every import fails with "the uploaded
file is no longer available" (observed 2026-08-16). Treat the key as REQUIRED
in production - the `Host env keys (production)` workflow generates it on the
box and restarts the app.

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
DATA_DIR=$(mktemp -d) npm test -- tests/unit/order-status-source.test.ts tests/unit/order-column-mapping.test.ts tests/unit/order-recovery-policy.test.ts tests/unit/contact-consent-gate.test.ts tests/unit/order-recovery-templates.test.ts tests/unit/xlsx-reader.test.ts tests/integration/vendor-order-import.test.ts tests/integration/vendor-order-scheduled-delivery.test.ts tests/integration/order-recovery-messaging.test.ts tests/integration/commission-file-import.test.ts
```

The commission suite runs against the real captured Commission File export in
`tests/fixtures/perfectvision/`, so the parser's claims about parenthesized
negatives, batch totals and manual spiffs are pinned to actual vendor output.

A pristine `DATA_DIR` matters: the development `data.db` is large enough to make
timing-sensitive tests fail.
