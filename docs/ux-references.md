# UX References — Mobbin Research

Research for the product-wide UX transformation. Twelve references, two per workflow.
Every URL below came from a Mobbin search result. Nothing here is a suggestion to copy
branding, colour, or literal layout — each entry isolates one **interaction principle**
and states how it lands on our product (reps knocking doors, managers assigning
territory, commission statements with holds and chargebacks).

**How to read an entry:** *What I see* is a description of the actual screenshot.
*Principle* is written so an engineer can implement it without looking at the image.
*For us* names the concrete screen in this repo it applies to.

**Honest caveat up front:** Mobbin has no door-to-door / field-sales CRM in its library
(no SalesRabbit, Spotio, Badger Maps equivalent surfaced across any query). All map
references are translated from logistics, rideshare, and GIS tooling. Similarly, no iOS
screen surfaced that combines a map sheet with a genuine per-record *visit history* list
— the closest were consumer place sheets. Where that gap matters it is called out.

---

## 1. Field map — map-first field work

The rep is walking, holding a phone in one hand, and needs to record an outcome in under
three seconds without losing their place on the map.

### 1.1 Grab Driver (iOS) — the thumb-zone commit bar
https://mobbin.com/screens/b215c37b-46a1-46bd-8b47-6ba2515bb842

**What I see.** Top ~40% is a live map with the driver's heading arrow and a numbered
destination pin. Below it a fixed card: a step header (`2 Stops` · **1. Pick up
passenger**) with a Navigate button, then the address, fare, and a payment badge. Then a
row of four small icon-and-label targets — Chat, Free Call, Help Centre, More. Then, at
the very bottom edge, a single full-width pill button, **Arrived**, with a separate round
power/status toggle beside it. Three distinct tiers of action, physically separated by
distance from the thumb.

**Principle.** Rank actions by *frequency × irreversibility* and assign each rank a fixed
screen region. The one action that advances the record's state gets a full-width button
pinned to the bottom safe area, always in the same place regardless of record type.
Communication/secondary actions get a compact icon row directly above it. Everything
informational sits above that and may scroll. The commit button never moves between
states — only its label changes.

**For us.** `client/src/components/OutcomeSheet.tsx` and `LeadKnockSheet.tsx`: the
outcome commit (Not Home / Callback / Sold / Not Interested) belongs in a bottom-pinned
bar whose position is identical on every property, so a rep builds muscle memory and can
log without looking. Call/text/notes become the icon row above it. Address, fiber
serviceability, and prior status scroll above that. The "on shift / off shift" toggle is
our analogue of Grab's power button — adjacent but visually separate from the commit
action so it is never hit by accident.

### 1.2 Turo (Web) — put the deciding value in the pin
https://mobbin.com/screens/16067ed9-b5f4-49ad-8097-9c1fb93c8997

**What I see.** Split view: scrollable result cards on the left, map on the right. The
map pins are not dots — they are labelled bubbles reading `$60`, `$66`, `$55`, `$59`,
`$95`. One bubble is filled dark to mark the currently-focused record. Above both panes
sits a single row of filter chips (Under $9x, Fuel efficiency, Fuel type, Deliver to me,
All filters) plus a Grid/Map toggle, and a location search with a grouped autocomplete
dropdown (History / Airports / Cities). The count "39 cars available" updates with the
filters.

**Principle.** A map pin should carry the single datum the user is deciding on, rendered
as text inside the marker, not as a colour the user has to decode against a legend.
Selection state is shown by inverting the focused marker while the list scrolls in sync.
Filters live in one horizontal row above *both* panes and mutate a visible result count,
so the user always knows the map is a filtered view rather than everything.

**For us.** `client/src/pages/LiveMap.tsx` and `MapView.tsx`: manager-side, a pin should
read `3d` (days since last knock) or the outcome code, not just a coloured dot — colour
alone stops working at ~6 statuses and is unusable in sunlight. Keep the visible
"N properties in view" count tied to the filter row so a manager assigning territory can
see they are looking at a subset. `LeadsInViewPanel.tsx` is already the list half of this
split; the missing half is sync — hovering a list row should invert its marker and
vice-versa.

---

## 2. Lead / property detail — a record over a map

The record has to open without destroying the spatial context the rep just built up.

### 2.1 Felt (Web) — the selected-feature card with a disambiguation pager
https://mobbin.com/screens/58a17ddb-ae85-48cf-96d8-aa8c632517d7

**What I see.** Full-bleed map dense with green and orange dots. A left rail holds
Legend/List tabs, tool entries (Measure, Spatial filter), a colour key (active /
inactive) and range legends. Floating over the map, anchored near the clicked point, is a
small card headed `Selected item` with edit / overflow / close icons. Inside: the record
name with an emoji marker, then a tight label-value list — ID `DRV098`, Zone `Chinatown`,
Street `3rd St`, Status `INACTIVE` (as a pill), and lat/long at the foot. At the bottom of
the card is a pager: `‹ 1 of 2 ›`.

**Principle.** When a click lands on overlapping features, do not guess and do not open a
disambiguation menu — open the first record immediately and give the card a `n of m`
pager to step through the others in place. The card is anchored to the geometry, small
enough that the surrounding map stays visible, and exposes edit / overflow / dismiss in a
fixed corner triad.

**For us.** `client/src/components/TerritoryDetailPanel.tsx` / `PropertyDetail.tsx`. This
solves multi-dwelling units directly: one street address, eight apartment leads stacked at
identical coordinates. Today that is ambiguous; a `1 of 8` pager over a compact card makes
the whole stack workable without zooming or opening a list. Keep the panel narrow enough
that the neighbouring properties stay on screen — the rep's next action is almost always
the house next door.

### 2.2 State Farm (iOS) — inferred fields are shown, labelled, and correctable
https://mobbin.com/screens/9d0a2e0b-70f0-43aa-986b-451c27d91f35

**What I see.** A `Trip details` screen: a map with the driven route and lettered
endpoints, overlaid at first by a dismissible explainer card titled **Phone distraction**
that spells out, in three bullets, the exact conditions under which the system flags a
trip. Below the map: the trip stamp (`Feb 28, 5:21 a.m. · 39 mins`), Chicago, 33.5 miles,
the vehicle. Then a labelled section `I was the…` with an ⓘ icon, containing a bordered
row reading **Driver (default)** with a red **Edit** on the right. Below that, `7 events`.

**Principle.** Any field the system inferred rather than observed must (a) render its
current value in plain language, (b) mark that the value is a system default, and (c)
carry a first-class Edit affordance in the same row. Pair it with an ⓘ that explains the
inference rule in concrete conditions, not marketing language. Correction is then a normal
act rather than an error report — which is what keeps the inferred data trustworthy,
because users actually fix it.

**For us.** We infer a lot: fiber serviceability from the scanners, unit counts,
occupancy, address normalisation. Every one of those on `PropertyDetail.tsx` should read
`Serviceable — from scan (default)` with an inline Edit and an ⓘ stating which scan and
when. Same pattern for auto-assigned territory owner. If a rep on the doorstep cannot
correct a wrong inference in one tap, they stop trusting the whole map.

---

## 3. Data-dense table — lead lists at scale

### 3.1 HubSpot (Web) — saved views as first-class tabs with an explicit budget
https://mobbin.com/screens/5179d751-e71a-4ebe-820e-a98ebc076e29

**What I see.** A `Contacts` table under a horizontal tab strip of saved views: *All
contacts* (with an × to close it), *Newsletter subscribers*, *Unsubscribed*, *All
customers*, *USA customers*, then **+ Add view (5/50)** and **All Views**. Below that a
second row of filter dropdowns (Contact owner, Create date, Last activity date, Lead
status, **+ More**, *Advanced filters* with a blue dot indicating active filters). Below
that, a search input, and right-aligned **Export** and **Edit columns**. Column headers
carry sort arrows and a per-column overflow icon. Footer: `Prev 1 Next` with `25 per
page`.

**Principle.** A saved view is a tab, not a dropdown item — it is opened, closed, and
reordered like a browser tab, and the "add" affordance states the quota inline
(`5/50`) so the limit is discovered before it is hit. Ad-hoc filters live in a *separate*
row from saved views, and any filter set beyond the visible chips is signalled by a dot on
the "Advanced filters" control so no filter is ever silently applied. Sorting and column
configuration are per-column controls, not a modal.

**For us.** `client/src/pages/Leads.tsx`. Reps and managers have durable, named questions
— "my callbacks this week", "unassigned in Zone 4", "sold, pending install", "chargeback
risk". Those should be closeable tabs owned per user, with a shared/team tier managers can
publish. Critical detail to copy: the active-filter dot. A manager who leaves a territory
filter on and then reports "we have no leads" is a support ticket we can design away.

### 3.2 Front (Web) — a persistent action bar that disables rather than hides
https://mobbin.com/screens/39bb7059-b5f2-437d-9022-8ffbac3753a0

**What I see.** A `Shared contacts` table. Directly above the header row sits a toolbar
that is present regardless of selection: **Message**, **Add to lists** (with a split
caret), **Merge**, **Delete** — and with exactly one row checked, *Merge* is rendered
greyed/inactive while the others stay live. Right side: Export, Create, Import, and the
live count "1 contact selected". The selected row is filled with a solid highlight across
its whole width. Columns run name / email / phone / segment.

**Principle.** Show the complete set of bulk actions at all times and disable the ones
that are invalid for the current selection, rather than revealing actions only after
selection. Users learn the system's full capability surface passively, and "why can't I do
X" becomes visible state instead of a missing button. Keep a live selection count adjacent
to the actions, and highlight selected rows edge-to-edge so selection survives horizontal
scrolling of a wide table.

**For us.** `Leads.tsx` bulk operations — assign to rep, change status, add to calling
queue, export, delete. *Reassign* should be visibly present but disabled with a tooltip
when the manager's selection spans territories they do not own, and *Merge duplicates*
disabled below two rows. Our tables scroll horizontally on tablet; full-width row
highlight is what keeps a 40-row selection legible after scrolling to the commission
columns.

---

## 4. Team & permissions admin

### 4.1 Lyssna (Web) — role options that describe capability, not job title
https://mobbin.com/screens/249efdbd-e4f4-4fc7-a442-97f80c2c9a68

**What I see.** A `Manage your team` settings pane. At the top an informational banner:
"You're on the Free plan, which includes 3 collaborators. To add more users you'll need to
upgrade to a paid plan," with the upgrade as an inline link. Then an invite row: email
field + a role select defaulting to *Admin* + an **Invite** button. Then two separately
headed groups — **Invited** (each row showing the pending email, a greyed "Invitation
resent" state or an active "Resend invitation" button, Edit, and a role dropdown) and
**Collaborators** (the owner, marked with an `Owner` pill). The open role dropdown shows
each option as a two-line block: **Admin** / "Full access including team and billing
management"; **Editor** / "Can create tests and spend account credits"; **Viewer
(unlimited)** / "Can view results, but can't create tests". At the bottom of that same
menu, in red: **Delete**.

**Principle.** Every role option renders a one-line description of what that role can
*do*, in the product's own vocabulary, inside the picker itself — never a bare label
requiring a docs trip. Name at least one financially consequential capability explicitly
("can spend account credits"). Separate pending invitations from active members into
distinct sections with different available actions. Surface the seat/plan limit at the
point of invitation, not at the moment of failure.

**For us.** `client/src/pages/Team.tsx`. Our roles carry real money: a manager can
approve commissions and reassign territory; a rep cannot. The picker must say
"Manager — assigns territory, approves commission and adjustments" and "Rep — logs
knocks and sees only their own commission". Pending vs active matters because a rep who
was invited but never logged in should not appear in leaderboards or territory
assignment. The seat-limit banner maps to our paywall (`PaywallBanner.tsx`) — show it in
the invite row, not after the invite fails.

### 4.2 Supabase (Web) — disable with a stated reason, never fail after the tap
https://mobbin.com/screens/f9290d9f-3a2d-40e9-975c-e898924870cb

**What I see.** An org settings `Team` tab listing three users. The first row shows an
`Invited` pill; its Role select is rendered inert/greyed, and a tooltip is open beside it
reading **"Role can only be changed after the user has accepted the invite."** The owner's
row likewise has an inert `Owner` select. Only the fully-joined member has a live
`Developer` select and an overflow `…` menu. The Role column header carries a ⓘ. A
`3 users` count sits at the foot; a member filter box and **Invite** / **Leave team**
buttons sit at the head.

**Principle.** When an action is blocked by the record's lifecycle state, render the
control in place, disabled, with the reason attached to it — do not hide the control and
do not allow the interaction and then fail. The reason string must name the state
transition that unblocks it ("after the user has accepted the invite"), so the admin knows
what to wait for. Rows whose state differs carry a status pill so the disabled control is
predictable rather than surprising.

**For us.** `Team.tsx` is full of lifecycle-gated actions: you cannot assign territory to
a rep who has not completed onboarding; you cannot change a rep's commission plan mid-pay
period; you cannot remove a rep who has unsettled held commission. Each of those should
be a visible, disabled control with the reason inline — "Commission plan locks until the
current pay period closes on 15 Aug" — rather than a hidden option or a red toast after
the click.

---

## 5. Financial statement — commissions, holds, chargebacks

### 5.1 Fiverr (Web) — partition money by claimability, and date every hold
https://mobbin.com/screens/460d8719-025d-4d7e-86bf-9dd45c17891a

**What I see.** An `Earnings` page with Overview / Financial documents tabs, then three
side-by-side bordered panels. **Available funds**: "Balance available for use $0.00" with
a **greyed-out, disabled** *Withdraw balance* button and a "Manage payout methods" link.
**Future payments**: "Payments being cleared $8.00 — 1 payment" and "Payments for active
orders $0.00". **Earnings & expenses**: earnings to date and expenses to date, with a
"Since joining" range selector. Each metric label carries a ⓘ. Below the panels: Date
range and Activity filter dropdowns, "Showing results 1-1 of 1", an "Email activity
report" action, and a ledger table — Date / Activity / Description / From / Order /
Amount — whose single row reads Activity `⏱ Clearing` with a small progress bar, and
Description **"Order will clear in 14 days"**.

**Principle.** Never present earnings as one number. Split the balance into panels by
*claimability* — what can be withdrawn now, what is held and will release, what is
lifetime context — and disable the withdraw control when the claimable panel is zero
rather than letting it fail. Then, in the ledger, each held row must carry its own status
plus a plain-language release statement ("will clear in 14 days"), so the user never has
to ask support why the two numbers differ. Every metric gets a ⓘ defining it precisely.

**For us.** `client/src/pages/MyCommission.tsx` and
`components/CommissionStatement.tsx`. This is our single biggest trust surface. A rep's
screen should read: **Payable now** (with Request payout disabled and explained when
zero), **Held — clears after the install/chargeback window** with the count of deals, and
**Chargebacks & adjustments** as its own negative bucket that is never silently netted
into the headline. Every held line must state the release condition in words — "clears 30
days after install, est. 12 Sep" — because "why is my number different from what I
expected" is the ticket we get most.

### 5.2 Airwallex (Web) — the money record's own status timeline, with the reason
https://mobbin.com/screens/0c92a739-c7cd-4449-ac2a-1bf158d6b1c8

**What I see.** A transfers list (filterable by creation date, with an Export control and
a Transfer date / Status / Recipient / Reference table showing a `Cancelled` pill). A
right-side drawer has opened over it, headed **Transfer** with the amount, a `Cancelled`
pill, the transfer ID `P251127-SLMYN11`, and three tabs — Overview / Transactions /
**Timeline**. Timeline is selected, showing three stacked events, each with its own icon,
a full timestamp with timezone (`27 Nov 2025 at 12:03 pm SGT`), the actor's name
(*Sam Lee*), the state reached (**Created**, **Scheduled**, **Cancelled**), and beneath
the last one: **"Reason: Cancelled by user"**.

**Principle.** Every money record carries an append-only timeline as a peer tab alongside
its summary, and each entry records four things: timestamp with timezone, actor, the state
entered, and — for any state that reduces or blocks value — a mandatory reason string. The
drawer opens over the list so the user keeps their place in the ledger, and the record's
current status pill is repeated in the drawer header so the summary and the timeline can
never disagree.

**For us.** `components/CommissionStatement.tsx` and `pages/CommissionConsole.tsx`. A
commission line's life is *earned → held → approved → paid*, with *clawed back* and
*adjusted* as branches. A rep disputing a chargeback needs to see exactly which manager
adjusted it, when, and the reason — and the reason field should be required at write time
in the console, not optional. Note that Airwallex separates *Transactions* (the money
movements) from *Timeline* (the state changes); we should do the same rather than
interleaving them into one confusing feed.

---

## 6. Destructive confirmation & undo

### 6.1 Notion (Web) — the confirm button states the counted scope
https://mobbin.com/screens/80904cb6-9a47-4bd2-ac41-1452de5fc687

**What I see.** A centred modal over the settings page, headed with a warning glyph:
**"Delete your entire account permanently?"** Body text states it cannot be undone,
that the account is removed from all shared workspaces, and *"Additionally, the following
workspace you own will be permanently deleted, removing any other members and their
access:"* — followed by an actual inventory card rendering the affected object:
`samlee's Space — Business Trial · 1 member`. Then "Please type your email to confirm"
with the email pre-visible in the field. The primary button is red, full-width, and reads
**"Permanently delete account and 1 workspace"**. A plain-text *Cancel* sits beneath it,
deliberately lower-contrast than the destructive button.

**Principle.** A destructive confirmation must query the system for the real blast radius
and render it as concrete objects with counts — not prose like "and associated data" —
and the confirm button's *label* must restate that counted scope ("delete account and 1
workspace"). Typed confirmation is the friction; the inventory is the information. Cancel
is text-weight and the destructive action is the visually heaviest element, so a mis-tap
is far more likely to hit the safe path than in a two-equal-buttons layout.

**For us.** Removing a rep from `Team.tsx` must first fetch and display: *"4 assigned
territories will be unassigned · 312 leads will move to unassigned · $1,840 in held
commission will remain payable"* — as an itemised card — and the button should read
"Remove Alex and unassign 312 leads". Same for deleting a territory or voiding a
commission batch. If we cannot compute the blast radius, we should not offer the action.

### 6.2 HubSpot (Web) — undo lives at the point of consequence, and is a real restore
https://mobbin.com/screens/bb7f0f5a-1de4-4773-b66a-f46e11c4ea24

**What I see.** The contacts table immediately after a bulk delete. The record count has
already dropped and the four surviving rows are rendered. Anchored at the top centre of
the viewport is a toast: **"2 Contacts were deleted. Restore Contacts. ↗"** with a
dismiss ×. The selection bar below still reads "2 contacts selected" with its full action
set (Enrich records, Assign, Edit, Delete, Create tasks, Enroll in sequence, More) and its
own × to clear.

**Principle.** After a destructive bulk action, the UI updates optimistically *and* offers
recovery in the same visual moment — an explicit "Restore" affordance in the toast, not a
generic "Undo" that vanishes in three seconds. The toast states the count so the user can
verify the scope actually matched their selection. Recovery is a real server-side restore
of the deleted records, which means the delete must be a soft-delete with a retention
window rather than a hard delete wrapped in a client-side timer.

**For us.** Every bulk mutation on `Leads.tsx` — bulk status change, bulk reassign, bulk
delete — should soft-delete/version and emit a counted restore toast: "312 leads
reassigned to Jordan. Undo." This pairs with 6.1: use the heavy typed-confirmation
inventory for the truly irreversible actions (removing a person, voiding money), and use
optimistic-plus-restore for the high-volume reversible ones. Applying the heavy pattern to
routine bulk edits just trains people to type through it without reading.

---

## Also seen, not selected

Kept short — these reinforce the principles above and are worth opening during design
review, but each duplicates a principle already covered.

- **Lovable** — https://mobbin.com/screens/bb0d45db-e185-4882-9463-4c511e00eca6 — delete
  dialog with a red-tinted bulleted list of exactly what dies, plus *"Deletion will be
  scheduled for Jan 2, 2026"*. Turning an irreversible action into a dated, cancellable
  one is a strong alternative to typed confirmation for rep offboarding.
- **Lindy** — https://mobbin.com/screens/5f09cbaa-949f-46b4-a85a-ee3614982344 — names the
  *successor* for orphaned resources ("transferred to the owner or an admin"), plus a
  required "Reason for deleting" select. We should name who inherits a removed rep's
  leads, in the dialog.
- **Dovetail** (flow) — https://mobbin.com/flows/f97b770d-63cb-4e5b-bfad-94ee19c262b8 —
  offers **"Downgrade to free instead"** as a sibling button to the destructive action.
  Offering the lesser action beside the destructive one is cheap and effective.
- **HubSpot** — https://mobbin.com/screens/fedf5525-727c-4f83-92d8-9ebc647363d4 — the
  selection bar *replaces* the filter row in place on selection, with rare bulk actions
  demoted into a *More* menu. An alternative to Front's always-present toolbar (3.2).
- **Felt** — https://mobbin.com/screens/c8b96c23-975f-472b-acca-279dede6555c — map legend
  doubles as the filter control (status checkboxes beside the colour key) with a
  "Zoom to all" and "Reset all filters". Relevant to `LiveMap.tsx` rep monitoring.
- **Pangea Charging** — https://mobbin.com/screens/b5f3ff80-dce6-427c-81e6-b4a4969ebc04 —
  detail sheet groups actions into cards by consequence tier (navigate / edit the record /
  report a problem / nearby), and ends with a *Nearby* list that keeps the user working
  the same area. The "next door" continuation is directly applicable to knocking.
- **Stripe** — https://mobbin.com/screens/96d9c8cb-24dd-451d-84ab-46eedb82f199 — every
  pending payout row carries an **Arrive by** date column. Cheap, and removes a whole
  class of "where is my money" questions.

## Gaps Mobbin could not fill

- **No field-sales / door-knocking CRM in the library.** Queries for territory canvassing
  and door-to-door outcome logging returned rideshare, delivery, and mapping products
  only. Everything in section 1 is a translation, not a same-domain reference.
- **No map sheet with a per-record visit history.** Searching iOS for a map half-sheet
  containing prior-visit entries returned consumer place sheets (saved places, top
  visitors) and trip logbooks. Section 2.2 supplies the *correctable inferred field*
  half and 5.2 supplies the *timeline* half; the combination is ours to design.
- **Only one true undo/restore pattern surfaced** (6.2). Destructive-confirmation
  material is abundant on Mobbin; genuine post-action recovery is rare, which is itself a
  signal that doing it well would differentiate us.
