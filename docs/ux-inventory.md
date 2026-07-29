# UX Inventory — Routes, Workflows, and Design-System Consolidation

Ground truth for the product-wide UX transformation. Every claim below is
verified by reading the code; anything not directly verifiable is marked
`INFERRED` or omitted.

- **Router:** `client/src/App.tsx` (wouter + `useHashLocation` — the app routes on
  the URL **hash**, e.g. `#/lead/7`).
- **Shell / nav:** `client/src/pages/Layout.tsx` (sidebar + mobile header + More
  sheet), `client/src/components/BottomTabs.tsx` (mobile tab bar).
- **Authorization:** `shared/capabilities.ts` (dotted capability strings — the
  modern layer) and `shared/permissions.ts` (legacy territory rank model).
- **Tokens:** `client/src/index.css`, `tailwind.config.ts`.

---

## 1. Route Inventory

35 explicit `<Route path>` entries + 1 catch-all = **36 route declarations**.
Of those, **9 are pure redirects** (legacy bookmarks) and **27 render a page
component**.

Two gate mechanisms exist side by side in `App.tsx`:

- `CapabilityGuard` (`App.tsx:109`) → checks `can(role, capability)` from
  `shared/capabilities.ts`. **11 routes.**
- `Guard` (`App.tsx:100`) → checks a hardcoded **role array**, no capability
  string. **12 routes.** This is the main authorization inconsistency in the app.

Both render `AccessDenied` (`App.tsx:89`) on failure.

| Route | Component file | Primary user | Goal | Permission gate (actual string) | Mobile-critical? |
|---|---|---|---|---|---|
| `/` | `pages/Dashboard.tsx` | manager / admin | Team + org overview; reps are redirected away | none on the route itself; role redirects at `App.tsx:200-203` | No (desktop-primary) |
| `/today` | `pages/Today.tsx` | **rep** | Next door + why, log outcome in ≤2 taps | cap `field.app.use` | **Yes** — BottomTabs "Today" |
| `/map` | `pages/MapView.tsx` | **rep**, team lead, manager | Knock the territory on a live map | cap `field.app.use` | **Yes** — BottomTabs primary FAB; full-bleed (Layout suppresses header + tabs, `Layout.tsx:163`) |
| `/leads` | `pages/Leads.tsx` | rep / manager (dual UI) | Rep: work assigned doors. Manager: qualify + assign pipeline | cap `field.app.use` | **Yes** — BottomTabs "Leads" |
| `/lead/:id` | `pages/PropertyDetail.tsx` | **rep** | Deep view of one door + knock timeline + log | cap `field.app.use` | **Yes** |
| `/followups` | `pages/FollowUps.tsx` | **rep** | Callbacks owed, grouped Overdue/Today/Upcoming | cap `field.app.use` | **Yes** |
| `/leaderboard` | `pages/Leaderboard.tsx` | rep, manager | Ranked sales board, self-row pinned | cap `field.app.use` | **Yes** — sidebar "Field" group |
| `/clock` | `pages/ClockIn.tsx` | **rep**, manager | Clock in/out, hours history | cap `field.app.use` | **Yes** |
| `/my-commission` | `pages/MyCommission.tsx` | **rep** | This week's pay, tier progress, statement, payout setup | cap `commission.read.self` | **Yes** — BottomTabs "Pay" |
| `/my-documents` | `pages/MyDocuments.tsx` | rep | Onboarding agreements to sign | cap `onboarding.documents.read.self` | Yes |
| `/calling` | `pages/CallingQueue.tsx` | **calling rep**, calling manager | Compliance-gated call queue | cap `calling.queue.read` | **Yes** — full-bleed (`Layout.tsx:164`) |
| `/calling/lead/:id` | `pages/CallingLead.tsx` | **calling rep** | One lead's call workspace + disposition | cap `calling.lead.read` | **Yes** |
| `/calling/compliance` | `pages/CallingCompliance.tsx` | compliance admin, auditor | DNC, consent, policy oversight | cap `calling.compliance.read` | No |
| `/profile` | `pages/Profile.tsx` | all roles | Account details | **NONE** — `component={Profile}`, no guard (`App.tsx:236`) | Yes |
| `/team` | `pages/Team.tsx` | team lead, manager, admin | Manage people, roles, territories | **role array** `["admin","manager","team_lead"]` | No |
| `/commission-console` | `pages/CommissionConsole.tsx` | manager, admin | Book sales, adjustments, approve + pay | **role array** `["admin","manager","team_lead"]` | No |
| `/applications` | `pages/Applications.tsx` | manager, admin | Rep onboarding pipeline | **role array** `["admin","manager"]` | No |
| `/fiber` | `pages/FiberIntelligence.tsx` | manager, admin | Consolidated fiber market workspace | **role array** `["admin","manager"]` (mirrors server `requireManager`) | No |
| `/live-map` | `pages/LiveMap.tsx` | manager, admin | Real-time rep positions | **role array** `["admin","manager"]` | No |
| `/diagnostics` | `pages/Diagnostics.tsx` | manager, admin | System health | **role array** `["admin","manager"]` | No |
| `/login-activity` | `pages/LoginActivity.tsx` | team lead, manager, admin | Auth trail | **role array** `["admin","manager","team_lead"]` | No |
| `/governance` | `pages/Governance.tsx` | admin | Capability matrix / permissions admin | **role array** `["admin"]` | No |
| `/billing` | `pages/Billing.tsx` | admin | Tenant subscription + credits | **role array** `["admin"]` | No |
| `/token` | `pages/TokenSetup.tsx` | admin | Mapbox token setup | **role array** `["admin"]` | No |
| `/scanner-tools` | `pages/Scanners.tsx` | admin | Deep scan tools (tabbed) | **role array** `["admin"]` | No |
| `/super-admin` | `pages/SuperAdmin.tsx` | **super admin** | SaaS tenant management | identity gate `isSuperAdmin(user, superAdminEmails)` (`App.tsx:318-322`); server enforces `requireSuperAdmin` | No |
| `*` (catch-all) | `pages/not-found.tsx` | all | 404 | none | Yes |

### Redirect-only routes (legacy bookmark preservation)

| Route | Redirects to | Declared at |
|---|---|---|
| `/my-territory` | `/map` | `App.tsx:220` |
| `/commissions` | `/my-commission` (rep) else `/commission-console` | `App.tsx:226` |
| `/users` | `/team` | `App.tsx:300` |
| `/markets` | `/fiber` | `App.tsx:274` |
| `/sweeps` | `/fiber` | `App.tsx:275` |
| `/scanner` | `/fiber` | `App.tsx:276` |
| `/city-scan` | `/fiber` | `App.tsx:277` |
| `/usa-scan` | `/fiber` | `App.tsx:278` |
| `/kinetic-scanner` | `/fiber` | `App.tsx:279` |

### Non-route page components

| File | How it renders | Notes |
|---|---|---|
| `pages/Login.tsx` | `App.tsx:186` — returned when `!user \|\| isFirstRun`, outside the `<Router>` | Not a route |
| `pages/Layout.tsx` | Shell wrapping every route | Not a route |
| `pages/CityScanner.tsx` (669 lines) | Tab inside `Scanners.tsx:108` | Reachable only via `/scanner-tools` |
| `pages/USAScanner.tsx` (550 lines) | Tab inside `Scanners.tsx:109` | Reachable only via `/scanner-tools` |
| `pages/KineticScanner.tsx` (1,164 lines) | Tab inside `Scanners.tsx:110` | Reachable only via `/scanner-tools` |

> `/scanner-tools` mounts 2,383 lines of scanner UI behind three tabs. Their
> routes (`/city-scan`, `/usa-scan`, `/kinetic-scanner`) now redirect to
> `/fiber`, so the pages are reachable **only** through the admin tab strip.

### Gate inconsistencies worth fixing

1. **`/profile` has no guard at all** (`App.tsx:236` uses the bare
   `component={Profile}` form). Every other in-app route is guarded.
2. **`/commission-console` grants `team_lead`** via role array (`App.tsx:232`),
   but the capabilities that page's actions need — `commission.sales.write`,
   `commission.adjustments.write`, `commission.statements.write`,
   `payouts.pay` — are **manager+/admin only** (`capabilities.ts:97,103`). A team
   lead reaches the console and finds its write surface rejected by the server.
3. **12 routes gate on role arrays, not capabilities**, so the capability model
   in `shared/capabilities.ts` is bypassed for every management surface. The
   `scan.submit` / `scan.manage` split is defined but **no route consumes it**.

---

## 2. Top Ten Routes — Detail

Selected by: presence in a rep's daily loop, and presence in the main nav /
bottom tab bar.

### 1. `/map` — `pages/MapView.tsx` (7,498 lines)

- **Data:** `GET /api/leads/map?format=packed` (`:1605`), `/api/territories`,
  `GET /api/territories/progress` (`:1765`), `/api/team` (`:1729`),
  `/api/territory-requests` (`:1249`), `GET /api/config/map` (`:1833`).
  Mutations: `POST /api/leads` (`:1157`), `POST /api/leads/bulk-assign`
  (`:1328`), `/bulk-status` (`:1358`), `/bulk-mark` (`:1384`),
  `POST /api/territories/assign-area` (`:1292`), `PATCH/DELETE /api/territories/:id`
  (`:1418`, `:1430`), `POST /api/scan/live-test` (`:856`).
- **Loading / empty / error:** **NONE.** Grep across all 7,498 lines returns
  **zero** occurrences of `isLoading`, `isError`, or `Skeleton`. The primary
  query at `:1605` destructures `{ data: mapPinData }` only. If `/api/leads/map`
  fails or is slow, the rep sees an **empty map with no pins and no indication
  anything is wrong** — indistinguishable from "you have no doors."
  **This is the single highest-severity defect in the product.**
- **Accessibility:** 34 `aria-label` uses — comparatively good. One `role="status"`.
- **Performance:** The historically bad patterns are already fixed and
  documented in-file (`:2580`, `:2768`, `:3037` describe removing
  `O(leads × areas)` JSON.parse loops). Remaining `JSON.parse` calls at `:2999`
  (inside `useMemo`) and `:6135` (single selected territory) are **not** smells.
  No verified perf defect remains.

### 2. `/today` — `pages/Today.tsx` (398 lines)

- **Data:** `GET /api/leads/map` (`:74`), `GET /api/leaderboard` (`:77`),
  `GET /api/clock/status` (`:80`), `GET /api/followups` (`:84`).
  Mutations: `POST /api/clock/in` (`:87`), `POST /api/clock/out` (`:95`).
- **States:** All three present and good — skeleton (`:230`), `ErrorCard`
  (`:367`), `EmptyCard` (`:378`), plus an `AllDoneCard` (`:389`) success state
  and per-stat error em-dash (`:296`).
- **Accessibility:** Strong. Shared `FOCUS` ring constant (`:26`), `aria-hidden`
  on decorative icons, real `role="progressbar"` with `aria-valuenow` (`:205`),
  all touch targets ≥44px (`h-11`/`h-12`).
- **Worst defect (design, not correctness):** it hand-rolls **three**
  state components — `ErrorCard`, `EmptyCard`, `AllDoneCard` — plus a local
  `Stat` (`:289`), duplicating `components/EmptyState.tsx` and
  `components/KpiTile.tsx`.
- Minor: two independent loading gates (`loading` at `:125` excludes `clockQ`,
  which has its own skeleton at `:183`), so the clock card pops in separately.

### 3. `/leads` — `pages/Leads.tsx` (1,113 lines)

- **Data:** `GET /api/leads?search&status&city&state&assignedRepId&fiberStatus&limit&offset`
  (`:766`, page size 100), `GET /api/leads/facets` (`:791`), `GET /api/stats`
  (`:799`), `GET /api/team` (`:822`), `GET /api/onboarding/pipeline` (`:823`).
  Panel: `GET /api/leads/:id` (`:428`), `/history` (`:435`), `/enrichment`
  (`:447`), `GET /api/leads/:id/knocks` (`:183`). Mutations: `POST /api/leads`,
  `PATCH /api/leads/:id`, `DELETE /api/leads/:id`, `POST /api/leads/:id/assign`,
  `POST /api/leads/:id/knock`, `PATCH /api/leads/:id/enrichment`.
- **States:** All present — dual skeletons for desktop table and mobile cards
  (`:962-976`), error with retry (`:978`), empty with filter-aware copy (`:980`).
- **Worst defect (performance):** the desktop table (`:983`, `hidden lg:block`)
  and the mobile card list (`:1015`, `lg:hidden`) are **both always mounted** —
  visibility is CSS-only. At `PAGE_SIZE = 100` that is **200 fully-rendered row
  subtrees** in the DOM at every viewport, with all their event handlers.
- **Performance (also verified):** `.find()` inside `.map()` twice —
  `team.find(m => m.id === k.repId)` at `:289` inside the knock-history map, and
  `assignmentName()` (`:895`, a `team.find`) called inside the table row map at
  `:995`. Neither `team` nor a lookup map is memoized.
- **Accessibility:** Four icon-only row buttons carry only `title=` and **no
  `aria-label`** — Assign (`:1002`), Open details (`:1003`), Edit (`:1004`),
  Delete (`:1005`); contrast with the Calling link at `:1001` which has both.
  All four are `w-8 h-8` (32px). Two of them (`:1004`, `:1005`) are
  `opacity-0 group-hover:opacity-100` — **hover-only affordances**, unreachable
  on touch. Mobile status-filter chips are `h-9` (36px, `:956`), and the
  pagination Prev/Next are `h-9` (`:1049`) — both under the 44px target.
- **Dead deep link:** `Dashboard.tsx:390` links `#/leads?id={leadId}`, but
  `Leads.tsx` never reads a search/query param. The link lands on an unfiltered
  list.

### 4. `/lead/:id` — `pages/PropertyDetail.tsx` (528 lines)

- **Data:** `GET /api/leads/:id` (`:115`), `GET /api/leads/:id/history` (`:119`),
  `GET /api/leads/:id/photos` (`:401`), `GET /api/photos/:id/file` (`:383`, blob
  fetch because auth is header-based). Upload: `POST /api/leads/:id/photos`
  (`:414`).
- **States:** Skeletons (`:145`), error + retry (`:151`), history empty (`:192`),
  photos empty (`:449`), plus a per-lead offline `SaveState` (`:474`).
- **Worst defect (design system):** **three competing summary-card variants ship
  in production** — `SummaryLedger` (`:272`), `SummarySplit` (`:296`),
  `SummaryBanded` (`:341`) — selected by a `cardVariant` URL param read at
  `:87-94`, defaulting to variant 2. This is an unfinished A/B test left in the
  bundle. Each variant has its own action-row styling (`cell` at `:273`, `btn` at
  `:304`, a third `btn` at `:343`), so the same three buttons are styled three
  ways.
- **Accessibility:** Good — `aria-hidden` on decorative icons, `aria-label` on
  the back button (`:136`) and photo buttons (`:443`, `:461`), 44px targets.
  `VerifyBadge` (`:96`) correctly pairs colour with a text label and icon.

### 5. `/my-commission` — `pages/MyCommission.tsx` (725 lines)

- **Data:** `GET /api/commission/statements/me/current` (`:121`), plus payout
  endpoints inside `GetPaidSection` (`:565`).
- **States:** Loading `animate-pulse` blocks (`:160`), error + retry (`:167`),
  two distinct empty states — no rep profile (`:178`), no plan (`:186`).
- **Worst defect (design system):** the file declares its **own local
  `function EmptyState`** at `:548` with a different API (`icon: ReactNode`,
  `body` instead of `description`) that **shadows the shared
  `components/EmptyState.tsx`**. Two components, same name, different look.
- Also: the loading state uses raw `animate-pulse` (`:161-162`) instead of the
  app's `.app-skeleton` shimmer utility (`index.css:212`), so this page's
  skeleton animates differently from every other page's.
- 13 hand-rolled `rounded-xl bg-card border border-border` blocks — the most of
  any page — none using `components/ui/card`.

### 6. `/` — `pages/Dashboard.tsx` (609 lines)

- **Data:** `GET /api/stats/saas` (`:196`, 30s poll), `GET /api/activity-log?limit=20`
  (`:202`, 15s poll, manager-only), `GET /api/clock/sessions` (`:209`),
  `GET /api/stats` (`:220`), `GET /api/scan/first-seen-live?hours=24` (`:225`),
  `GET /api/leaderboard` (`:231`), `GET /api/team/:id/activity` (`:139`, on tap).
- **States:** Well covered — skeletons at `:306`, `:369`, `:513`, `:559`; error +
  retry at `:361` and `:419`; four separate empty states at `:319`, `:382`,
  `:517`, `:570`.
- **Worst defect (design system):** **three different stat presentations on one
  page** — `KpiTile` via `FieldTile` (`:132`, used `:288-292`), a bespoke
  `MetricStrip` hairline grid (`:53`, used `:427`), and `Badge` counters
  (`:263-276`). Plus four inline empty-state variants that share no primitive.
- **Performance (verified):** `clockSessions.filter(s => s.date === today)` is
  recomputed **four times per render** — `:243`, `:247`, `:570`, `:577` — with no
  `useMemo`, on a component polling every 15–30 s.
- Navigation inconsistency: quick actions use raw `<a href="#/…">` (`:452`,
  `:462`, `:472`, `:482`, `:388`) instead of wouter `<Link>` used everywhere
  else. The "City Scan" action (`:452`) points at `#/city-scan`, which
  `App.tsx:277` redirects to `/fiber` — the label no longer matches the
  destination.

### 7. `/leaderboard` — `pages/Leaderboard.tsx` (299 lines)

- **Data:** `GET /api/leaderboard[?range=|?since=&until=]` (`:50`, `:61`), 30 s poll.
- **Worst defect:** the loading state is **bare centred text**,
  `"Loading leaderboard..."` (`:190`) — no skeleton, while every sibling page
  uses skeletons. It also causes a full layout jump when the board arrives.
- **States otherwise:** error card + retry (`:191`), and it correctly uses the
  **shared `EmptyState`** (`:205`) — one of only four files that do.
- **Performance:** `board.findIndex` (`:68`) and `board.reduce` (`:71`) run
  unmemoized on every 30 s poll render. Rows are unvirtualized but carry
  `render-lazy` (`:224` → `content-visibility: auto`, `index.css:225`), which
  mitigates below ~200 rows.
- **Yet another stat strip:** `:152-169` is a fourth hairline metric grid,
  visually near-identical to Dashboard's `MetricStrip` but separately written.

### 8. `/clock` — `pages/ClockIn.tsx` (258 lines)

- **Data:** `GET /api/clock/status` (`:48`, 10 s poll), `GET /api/clock/sessions`
  (`:54`, 30 s poll). Mutations: `POST /api/clock/in` (`:60`), `/out` (`:70`).
- **Worst defect (correctness):** the session-history empty state is gated on
  `sessions.length === 0` (`:231`) but the list renders
  `sessions.filter(s => s.clockedOut)` (`:235`). A rep whose only sessions are
  **currently active** gets an **empty box with no message at all** — neither
  rows nor the "No sessions yet" copy.
- Good: the clock-status error state explicitly refuses to render "Off Duty" on
  a failed fetch (`:103-113`) — the right instinct, and a pattern worth
  generalising.
- **States:** the empty state is a bare `<p className="text-sm …">No sessions yet</p>`
  (`:232`) — a sixth distinct empty-state treatment.
- **Performance:** four unmemoized array passes per render — `:80`, `:82`, `:86`,
  plus `:235` — on a component that re-renders every 10 s.
- **Fifth stat strip:** `:169-188`.

### 9. `/followups` — `pages/FollowUps.tsx` (200 lines)

- **Data:** `GET /api/followups` (`:54`).
- **States:** The cleanest field page. Row skeletons (`:90`), error + retry
  (`:99`), and the **shared `EmptyState`** with `tone="positive"` (`:109`).
  Grouping is memoized (`:61`).
- **Worst defect:** its error block (`:100-106`) is hand-rolled, because **no
  shared `ErrorState` primitive exists** — every page invents one. Verified
  variants: `Today.tsx:367`, `FollowUps.tsx:100`, `PropertyDetail.tsx:152`,
  `MyCommission.tsx:167`, `Leads.tsx:978`, `Leaderboard.tsx:192`,
  `ClockIn.tsx:106`, `Dashboard.tsx:361` + `:419`.
- **Accessibility:** the per-row "Log" button (`:193`) has an `aria-label`, and
  the row is `items-stretch` so its height matches the row — acceptable.
  Status is conveyed by a colour dot (`:176`) **plus** the date/time text, so it
  is not colour-only.

### 10. `/calling` — `pages/CallingQueue.tsx` (321 lines)

- **Data:** `getCallingStatus`, `getCallingQueue`, `getCallingCallbacks` from
  `lib/callingApi.ts` (`:6`).
- **States:** The **best-built page in the app**. Dedicated
  `CallingPageSkeleton` and `CallingUnknownState` primitives from
  `components/calling/CallingChrome.tsx`, per-section skeletons
  (`QueueRowsSkeleton`, `:104`, with `role="status" aria-busy`), independent
  error branches for status (`:213`) and queue (`:287`), and a real empty state
  (`:309`).
- **Accessibility:** Best in the app — `aria-label` on every landmark section
  (`:219`, `:226`, `:264`, `:298`), on the search input (`:261`), and a
  `role="group"` filter bar (`:264`).
- **Worst defect:** its design system is **calling-only**. `CallingChrome.tsx`
  exports exactly the four primitives the field pages most need
  (`CallingChrome`, `CallingAvailability`, `CallingUnknownState`,
  `CallingPageSkeleton`) and **nothing outside `components/calling/` and
  `pages/Calling*.tsx` can use them.** Meanwhile `stageTone` (`:16`) is a
  seventh independent status-colour map.

---

## 3. Components That Should Be Shared

### 3a. Primitives that exist but are barely adopted

| Primitive | File | Adoption | Should be |
|---|---|---|---|
| `EmptyState` | `components/EmptyState.tsx` | **4 files**: `AdminHistory.tsx`, `scan/LiveScanFeed.tsx`, `Leaderboard.tsx`, `FollowUps.tsx` | Every page |
| `KpiTile` | `components/KpiTile.tsx` | **1 file**: `Dashboard.tsx` | Every stat surface |
| `ui/card` | `components/ui/card.tsx` | **8 files** | vs. **~30 files** hand-rolling `rounded-*  border border-border bg-card` |
| `ui/badge` | `components/ui/badge.tsx` | Has `success`/`warning` semantic variants (`badge.tsx:21-22`) | Almost never used for status — pages pass raw colour classes via `className` |

### 3b. Duplicated components — build once, share

1. **Empty state — 8 implementations.**
   `components/EmptyState.tsx` (canonical) · `MyCommission.tsx:548` (a *second
   component literally named `EmptyState`*) · `Today.tsx:378` `EmptyCard` +
   `:389` `AllDoneCard` · `Leads.tsx:980` (inline) · `Dashboard.tsx:319,382,517,570`
   (four inline italic divs) · `ClockIn.tsx:232` (bare `<p>`) ·
   `PropertyDetail.tsx:192,450` (inline text) · `CallingQueue.tsx:309`.

2. **Error state — 9 implementations, no primitive exists.**
   `Today.tsx:367` · `FollowUps.tsx:100` · `PropertyDetail.tsx:152` ·
   `MyCommission.tsx:167` · `Leads.tsx:978` · `Leaderboard.tsx:192` ·
   `ClockIn.tsx:106` · `Dashboard.tsx:361` and `:419` ·
   `components/calling/CallingChrome.tsx:131` (`CallingUnknownState`, the only
   named one). All render icon + title + body + a Retry button, with different
   heights, radii, and button styles.

3. **Stat / KPI tile — 5 implementations.**
   `components/KpiTile.tsx` (canonical) · `Dashboard.tsx:53` `MetricStrip` ·
   `Today.tsx:289` `Stat` · `Leads.tsx:712` `EnterpriseKpi` ·
   `Leaderboard.tsx:152` totals grid · `ClockIn.tsx:169` metric strip.
   Dashboard alone uses two of these on one screen.

4. **Loading skeleton — 3 mechanisms.**
   `components/ui/skeleton.tsx` + the `.app-skeleton` shimmer (`index.css:212`)
   is canonical. But `MyCommission.tsx:160` uses raw `animate-pulse`, and
   `Leaderboard.tsx:190` uses **plain text**. `components/calling/CallingChrome.tsx:144`
   defines a page-level skeleton the field pages cannot import.

5. **Lead summary / property card — 4+ implementations.**
   `PropertyDetail.tsx:272/296/341` (three variants of the same card) ·
   `Leads.tsx:1022` (mobile article card) · `components/LeadCard.tsx` ·
   `Today.tsx:316` `HeroCard`. All show address + city + status + actions.

6. **Lead row / list item — 5 implementations.**
   `Today.tsx:347` `DoorRow` · `FollowUps.tsx:168` `Row` · `Leads.tsx:987`
   (table row) and `:1016` (mobile card) · `CallingQueue.tsx:298` queue row ·
   `components/LeadsInViewPanel.tsx`.

7. **Timeline / activity feed — 4 implementations.**
   `PropertyDetail.tsx:504` `TimelineRow` · `Leads.tsx:663` (the
   `before:absolute` rail inside `IntelligencePanel`) · `Dashboard.tsx:524`
   (activity feed) · `Dashboard.tsx:167` (rep activity list) ·
   `components/AdminHistory.tsx`.

8. **Modal / bottom sheet — 3 mechanisms.**
   `components/ui/dialog.tsx` + `ui/sheet.tsx` + `ui/drawer.tsx` (canonical, all
   Radix) · `Dashboard.tsx:145` `RepActivityCard` (hand-rolled `fixed inset-0`
   with `role="dialog"` but **no focus trap and no Escape handler**) ·
   `PropertyDetail.tsx:456` photo viewer (hand-rolled, has `autoFocus` + a local
   Escape handler but no trap) · `Layout.tsx:412` More sheet (hand-rolled with a
   **correct** focus trap at `:178-199` — the pattern the other two should adopt).

9. **Focus-ring convention — 3 mechanisms.**
   Global `:focus-visible` (`index.css:294`) · the `FOCUS` constant duplicated in
   `Today.tsx:26`, `Diagnostics.tsx`, `components/ErrorBoundary.tsx` ·
   ad-hoc `focus-visible:ring-*` strings elsewhere.

### 3c. Where the SAME concept is styled differently — the consolidation list

**Lead status.** One concept, **seven** independent colour systems:

| # | Source | Form | Notes |
|---|---|---|---|
| 1 | `shared/statusConfig.ts:34` `STATUS_CONFIG` | Hex + pin shape + glyph + `onDark` | The documented canonical contract. Used by `LeadMap.tsx`, `LeadKnockSheet.tsx`, `lib/leadGeoJson.ts`, `lib/statusIcons.ts`, `MapView.tsx` |
| 2 | `shared/knock.ts:95` `STATE_COLORS` / `:108` `STATE_LABELS` | Hex, keyed by *display state* not lead status | Used by `Today.tsx`, `FollowUps.tsx`, `PropertyDetail.tsx`, `OutcomeSheet.tsx`, `LeadsInViewPanel.tsx`, `lib/mapPins.ts` |
| 3 | `shared/knock.ts:58` `OUTCOME_META` | Hex, keyed by *outcome* | Used by `PropertyDetail.tsx:505`, `Dashboard.tsx:168` |
| 4 | `Leads.tsx:54` `STATUS_COLOR` | **Tailwind class strings** | Comment at `:48` claims it is "matched to the map's `STATE_COLORS`" — it is a hand-maintained copy that can silently drift |
| 5 | `Leads.tsx:71` `OUTCOME_COLORS` | Tailwind class strings | A second local map in the same file |
| 6 | `CallingQueue.tsx:16` `stageTone` | Tailwind class strings, calling stages | |
| 7 | `components/LeadCard.tsx:87` `TONE` | Tailwind `-600/dark:-400` pairs | |

Three status **label** maps also diverge: `statusConfig.ts:34` (`"Follow-up"`),
`knock.ts:108`, and `Leads.tsx:39` (`"Follow Up"`).

**Status badge shape.** Four different chip geometries for the same pill:
`ui/badge.tsx:10` (`rounded-md px-2.5 py-0.5 text-xs`) ·
`PropertyDetail.tsx:240` (`h-6 rounded-full px-2.5 text-[10.5px] uppercase`) ·
`Dashboard.tsx:401` (`h-[20px] rounded-full px-2 text-2xs uppercase`) ·
`FollowUps.tsx:180` (`rounded-full px-1.5 py-0.5 text-2xs uppercase`).

**Card radius.** Across `pages/`: `rounded-xl` ×265, `rounded-lg` ×150,
`rounded-2xl` ×111, `rounded-md` ×19 — for the same "card" concept. Compounded by
the token gap in §4.

**Role colour.** `Layout.tsx:104` `RoleBadge` and `Layout.tsx:125` `avatarBg`
maintain two parallel role→colour maps (text vs. background) in the same file,
neither tokenized.

**Navigation.** wouter `<Link>` (`Layout.tsx`, `Today.tsx`, `Leads.tsx`) vs raw
`<a href="#/…">` (`Dashboard.tsx:388,452,462,472,482`).

---

## 4. Existing Design Tokens

A consolidation must build on these.

### Colour — `client/src/index.css:26-96` (dark, default) and `:100-125` (`.light`)

All HSL triplets, consumed through `hsl(var(--x) / <alpha-value>)` in
`tailwind.config.ts:13-88`.

**Surfaces:** `--background`, `--foreground`, `--card`, `--card-foreground`,
`--popover`, `--popover-foreground`, `--secondary`, `--secondary-foreground`,
`--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`.

**Brand + intent:** `--primary` (HomeFront teal, `172 44% 46%` dark /
`172 62% 32%` light for AA on white), `--primary-foreground`, `--destructive`,
`--destructive-foreground`, `--ring`.

**Semantic status:** `--success` (`160 84% 42%` / `161 94% 26%`), `--warning`
(`38 92% 55%` / `32 95% 38%`). Exposed as `bg-success` / `text-warning` etc.
**These exist and are correct — pages should be migrated onto them from raw
`emerald-*` / `amber-*`.**

**Lines:** `--border`, `--input`, plus the surface-border set `--card-border`,
`--popover-border`, `--primary-border`, `--secondary-border`, `--muted-border`,
`--accent-border`, `--destructive-border`, `--button-outline`, `--badge-outline`.

**Charts:** `--chart-1` … `--chart-5` (teal-anchored, colourblind-spaced).

**Sidebar:** `tailwind.config.ts:66-81` maps `--sidebar`, `--sidebar-foreground`,
`--sidebar-border`, `--sidebar-ring`, `--sidebar-primary(-foreground/-border)`,
`--sidebar-accent(-foreground/-border)`. **These CSS variables are never defined
in `index.css`** — the mappings are dead.

**Raw (non-token) colours in the config:** `tailwind.config.ts:82-87`
`status.online/away/busy/offline` are hardcoded `rgb()` values that do not
theme-switch.

**Glass (map chrome) — `index.css:344-357`:** `--glass-ink`, `--glass-fill`,
`--glass-fill-strong`, `--glass-fill-sheet`, `--glass-fill-opaque`,
`--glass-stroke`, `--glass-specular`, `--glass-shadow-1`, `--glass-shadow-2`,
`--glass-shadow-sheet`. Consumed by the `.glass-surface` / `.glass-capsule` /
`.glass-sheet` / `.glass-opaque` / `.glass-hairline` / `.glass-ink-scope`
component classes (`:360-426`), with correct `@supports not (backdrop-filter)`
and `prefers-reduced-transparency` fallbacks.

### Radius — **the biggest token gap**

- `index.css:95` defines `--radius: 0.75rem` (12px), documented as the
  "design-system standard".
- **`var(--radius)` is referenced nowhere in the codebase.** Verified by grep
  across `client/` and `tailwind.config.ts`: zero hits.
- `tailwind.config.ts:8-12` instead **hardcodes** `lg: .5625rem` (9px),
  `md: .375rem` (6px), `sm: .1875rem` (3px) — none derived from `--radius`.
- Consequence: `rounded-lg` = 9px, while `rounded-xl` (12px) and `rounded-2xl`
  (16px) come from Tailwind's untouched defaults. There is no radius scale, and
  the intended 12px standard is only reachable by accident via `rounded-xl`.

**Fix direction:** define the scale from `--radius` and collapse the four card
radii onto two (surface / control).

### Typography — `tailwind.config.ts:93-101`, `index.css:131-145`

- **Families:** `sans` = Geist Variable → Inter Variable → system-ui (both
  self-hosted via `@fontsource-variable`, `index.css:2-3`); `serif` = Georgia;
  `mono` = ui-monospace stack.
- **One custom size:** `2xs` = `0.6875rem` (11px), documented as the legibility
  floor for sunlight reading. Size-only, no line-height override.
- **Heading scale (`index.css:135-137`):** `h1` = `text-xl font-bold tracking-tight`,
  `h2` = `text-lg font-semibold tracking-tight`, `h3` = `text-base font-semibold`.
  **Widely overridden in practice** — `Today.tsx:150` uses `text-[27px]`,
  `FollowUps.tsx:81` `text-[26px]`, `Dashboard.tsx:254` `text-[22px]`,
  `Leads.tsx:903` `text-2xl`, `PropertyDetail.tsx:277` `text-[17px]`. Arbitrary
  bracket sizes are pervasive: `text-[13px]`, `text-[14px]`, `text-[15px]`,
  `text-[11px]`, `text-[10.5px]`, `text-[12px]` appear across every page.
  **There is no shared body/label type scale** — only the three heading rules and
  `2xs`.

### Spacing

**No custom spacing scale.** `tailwind.config.ts` extends `borderRadius`,
`colors`, `fontSize`, `fontFamily`, `keyframes`, `animation` — spacing is stock
Tailwind. Safe-area insets are applied ad hoc via
`env(safe-area-inset-*)` in `Layout.tsx` (`:242`, `:323`, `:375`, `:422`),
`BottomTabs.tsx:33`, `Today.tsx`, and `PropertyDetail.tsx:462`.

### Motion — `index.css`

`app-route-enter` (`:193`, 180ms mobile / 140ms desktop),
`app-skeleton-shimmer` (`:208`, 1.25s), `card-swap-in` (`:433`, 120ms),
`scan-line` (`:280`), `hf-puck-pulse` (`:488`), Radix accordion keyframes
(`tailwind.config.ts:102-115`). A global `prefers-reduced-motion` collapse
(`:327-333`) and a shared interaction transition on
`button, a, [role="button"], [role="tab"], [role="option"]` (`:320-323`).

### Interaction utilities

`.hover-elevate` / `.active-elevate-2` (`index.css:14-23`) — the single
foreground-tinted overlay mechanism for Button/Badge, hover gated behind
`@media (hover: hover)`.
`.touch-target` (`:237`, mobile-only `min-width/height: 44px`) — **defined but
adopted almost nowhere**; pages hand-write `h-11`/`h-12` instead.
`.render-lazy` (`:225`, `content-visibility: auto`) — used by `Leaderboard.tsx:224`
and `Leads.tsx:1022`.
`.no-scrollbar` (`:316`), `.pill-row-fade` (`:453`), `.stmt-paper` / `.stmt-overlay`
/ `.no-print` print isolation (`:501-516`).

---

## 5. Highest-Value Consolidation Targets, Ranked

1. **Give `/map` loading and error states.** `MapView.tsx:1605` — a silent
   failure on the rep's primary screen.
2. **One status-colour source.** Collapse the seven maps in §3c onto
   `shared/statusConfig.ts`, exposing both hex (map/canvas) and token-backed
   Tailwind classes (DOM).
3. **Ship `ErrorState`, adopt `EmptyState` and `KpiTile` everywhere.** That
   removes 8 empty-state, 9 error-state, and 5 stat-tile implementations, and
   deletes the shadowing `MyCommission.tsx:548`.
4. **Pick one `PropertyDetail` summary card**, delete the other two variants and
   the `cardVariant` param (`PropertyDetail.tsx:87-94, 272, 296, 341`).
5. **Wire `--radius` into `tailwind.config.ts`** and collapse the four card radii.
6. **Stop double-rendering the leads list** (`Leads.tsx:983` + `:1015`).
7. **Promote `components/calling/CallingChrome.tsx` primitives** out of
   `components/calling/` — it is already the app's best page chrome.
8. **A11y sweep:** `aria-label` on the four icon-only buttons at
   `Leads.tsx:1002-1005`, replace the hover-only Edit/Delete affordances, raise
   `h-9`/`h-8` mobile controls to the existing `.touch-target` 44px, and add
   focus traps to the two hand-rolled modals (`Dashboard.tsx:145`,
   `PropertyDetail.tsx:456`) using the correct pattern already in
   `Layout.tsx:178-199`.
9. **Close the gate gaps:** guard `/profile`, and move the 12 role-array routes
   onto capability strings so `shared/capabilities.ts` is the single
   authorization source.
