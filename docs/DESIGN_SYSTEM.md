# Homefront design system

Light is the default appearance. Dark is a first-class setting, not an
afterthought, and a saved preference always wins over the default.

Every colour below is sampled from the logo (`client/public/hfs-logo.png`)
rather than invented:

| Sampled | Hex | HSL | Role in the product |
| --- | --- | --- | --- |
| Deep navy | `#0c243c` | `210 67% 14%` | structure, nav, links, selection, trust |
| Warm gold | `#e8a048` | `33 78% 60%` | emphasis, active state, premium detail |
| Muted teal | `#488484` | `180 29% 40%` | a supporting chart stop only |

The navy is lightened to `211 68% 26%` for interactive use so it holds white
text at 10.4:1; the gold is deepened to `33 78% 52%` so it holds dark ink.

## The split that keeps the product calm

**Blue carries structure. Gold carries emphasis.**

Gold is deliberately *not* a surface colour. It marks active state, premium
accents, money, and the one call to action that matters on a screen. Blue
carries everything structural: navigation, links, selected rows, the primary
button. If a screen has three gold things on it, two of them are wrong.

Gold has a hard constraint that is easy to violate by accident: the fill
(`33 78% 52%`) is **2.6:1 on white and must never carry text**. That is why
there are two gold tokens, not one.

| Class | Use |
| --- | --- |
| `bg-gold` + `text-gold-foreground` | a gold surface (6.6:1) |
| `text-gold-text` | gold **as text** (5.3:1 on white, 5.0:1 on `gold-soft`) |
| `bg-gold-soft` | the tint for chips and rails |

Money headline figures use `text-gold-text` (Incentives, Referrals, Mileage).
Counts that are not money stay navy — a door count is not a payout, and Areas
deliberately keeps its numbers structural.

## Semantic tokens

Defined in `client/src/index.css`, exposed through `tailwind.config.ts`. Reach
for the meaning, never the raw palette.

| Token | Light | Contrast on white | Meaning |
| --- | --- | --- | --- |
| `--primary` | `211 68% 26%` | 10.4:1 | structure, nav, in-play |
| `--success` | `161 94% 22%` | 6.1:1 | a win |
| `--warning` | `32 95% 30%` | 6.1:1 | work owed |
| `--destructive` | `0 72% 44%` | 6.0:1 | failure, loss |
| `--info` | `202 83% 32%` | 6.4:1 | progress, in flight |
| `--overlay` | `hsl(212 40% 12% / 0.45)` | n/a | the modal scrim |

`--info` is deliberately a brighter, more cyan blue than `--primary`: primary is
structure, info is a signal, and at a 3px rail the two must not read alike.

The contrast column is against white, but these are chip colours as often as
text: `bg-warning/10 text-warning` puts the token on a 10% wash of ITSELF.
Tuned to white alone they had no margin - warning was 4.51:1 on white and
3.97:1 on its own chip. Every value above now clears AA on white, on a /10
tint and on a /15 tint. Same trap, same fix, for `--accent-gold-text`.

`--overlay` carries **its own alpha**, so `bg-overlay` is the entire scrim and no
call site picks an opacity. That is not a style preference — the same modal
dimming had drifted into six spellings (`bg-black/40` through `/90`) across 17
files, so how dark the app went behind a dialog depended on which screen opened
it. The one exception is PropertyDetail's photo lightbox, which keeps a near
opaque black: that is a viewer backdrop, not a scrim.

### Rails carry meaning, not decoration

`KpiTile` takes a `tone` of `neutral | primary | info | success | warning`. It
does not take a colour. Callers say what the number *means* and the theme owns
how that looks, which is what keeps both themes correct at one edit.

Keep `warning` rare. On the Today glance row only "Follow-ups due" is amber,
because it is the one figure that is owed today and can be acted on. When
several tiles are amber, none of them mean anything.

## Two traps that have already shipped

**1. An undefined token does not error — it falls back to `currentColor`.**

`border-color: var(--card-border)` with `--card-border` undefined paints a 1px
border in the *text* colour: hard ink hairlines on every Card instead of a
hairline rule. This has happened twice. It happened the second time because the
stylesheet opened with a `:root` block holding both the dark palette *and* the
theme-agnostic foundations (component borders, chart ramp, radius, type scale);
scoping that block to `.dark` — correct for the palette — silently took the
foundations with it.

Foundations now live in a shared `:root` that both themes inherit.
`tests/unit/light-theme-token-coverage.test.ts` fails the build if a token is
defined only under `.dark`, or if the stylesheet or the Tailwind theme reads a
token no theme defines. It immediately found a second instance: a ten-token
`sidebar` palette from the shadcn scaffold, defined in neither theme, referenced
by zero call sites, waiting for the first `bg-sidebar`.

**2. The dark palette must outrank the light one by specificity, not by order.**

The dark block is written `:root.dark`, and the extra `:root` is load-bearing. A
bare `.dark` and the `:root` carrying the light palette have identical
specificity (0,1,0), so source order alone decides — and the light block sits
further down the file. Written as `.dark`, selecting the dark theme changed the
class on `<html>` and nothing else: with `.dark` applied, `--background` still
resolved to the light `40 24% 98%`. Qualifying with `:root` (0,2,0) makes dark
win wherever it sits, so re-ordering the stylesheet can never silently undo it.

## Raw palette steps on a light ground

`text-emerald-400` and friends were chosen against the old dark default. On
white they land near 1.9:1 and fail AA badly. Prefer the semantic token; it is
correct in both themes and needs no `dark:` twin.

An unpaired `-300`/`-400` step is the obvious case. Three less obvious ones:

- **A `-600 dark:-400` pair is not automatically safe.** `emerald-600` measures
  3.28:1 and `amber-700` 4.47:1. That rule was written to stop a bare `-400`
  washing out on light; it never checked that the light half cleared AA.
  Collapse the pair onto the token, which is correct on both grounds and needs
  no `dark:` twin.
- **A `[.light_&]:` override on a semantic base is dead weight.** The token
  already handles light, so the override only shadows it with the raw step it
  was meant to replace.
- **A chip's ink sits on a wash of ITSELF, not on the card.** This is the third
  variant of the same mistake and the one that survived the first two passes,
  because the arithmetic looks fine until you notice which background you
  measured against. `Leads.tsx` carried a comment stating that its `-600 on a
  /10 tint` chips "clear AA in BOTH themes". Measured on the running app, the
  Follow-up chip was **3.56:1** and Prospect **4.23:1** - both under AA, on the
  screen a manager spends the day in, repeated down 100 rows. The pair had been
  checked against white; the chip actually paints the ink on a 10% wash of its
  own hue, which is darker than white and eats the margin.

  Follow-up moved to `--warning` (5.27:1 on its own /10), because follow-up
  means work owed and that is what the token is for. Prospect kept its hue and
  darkened one step to `-700` (5.66:1): the lead-status ramp is **categorical**,
  not semantic, and collapsing Prospect onto `--destructive` would assert that a
  fresh lead is a failure.

  The general rule: when a colour is both the ink and the tint, compute the
  contrast against the composited tint. Every semantic token in the table above
  already clears AA on white, on /10 and on /15; a raw step almost never does.

This migration is **nearly finished on the light surfaces**. Outside the map
chrome, 20 unpaired call sites remain, and all but a handful of those sit on
panels that float over the dark map (`LeadsInViewPanel`, `lead-sheet/*`,
`FieldStatusBar`'s overlay branch) and belong with MapView rather than with the
light screens. The genuinely open ones are `ScanInspector`, `CallingLead`'s
INTERESTED chip, and the two `MyCommission` rank tints whose `[.light_&]:`
overrides currently carry them.

MapView and the two orphaned scanner tabs are excluded deliberately: they carry
their own dark chrome, and the semantic tokens are tuned for the light default,
so a chip on a dark panel needs hand review rather than a blanket replacement.
Check any file for `bg-slate-900`, `bg-black` or map chrome before converting it.

Also check `.ts` files, not just `.tsx`. Every grep in the first pass of this
migration used `--include='*.tsx'`, which hid `client/src/lib/areaProgress.ts`
and `shared/leadMark.ts` - and areaProgress is where the Areas status chips
actually live, so `Areas.tsx` kept coming back clean while the screen kept
measuring 3.28:1.

## Verifying, rather than assuming

Contrast is measured on the running app, not reasoned about from class names.
The check that matters walks the visible DOM, resolves each text node's real
composited background through its ancestors, and applies the WCAG threshold for
that font size and weight.

Four gotchas when measuring this app specifically:

- **Keep-alive stages.** Several route stages stay mounted at once, so
  `document.querySelector('h1')` can return a hidden screen's heading. Filter on
  `offsetParent` (plus a non-zero rect) to measure only what is on screen.
- **Screenshots after a viewport resize.** Resizing without reloading leaves a
  stale layout: the capture showed the canvas clipped to 330px inside a 375px
  viewport while every JS measurement correctly read 375. Reload after a resize,
  and trust measurement over the picture.
- **Gradients read as transparent.** An element with a `background-image`
  reports `backgroundColor: transparent`, so walking up for a background sails
  past it to the page white - which scored the white label on the navy-to-green
  Profile avatar as white-on-white, 1.0:1. Skip gradient-backed nodes rather
  than reporting them.
- **Empty screens hide their colours.** `/fiber` swept clean until it had data,
  then showed 53 failures at once. A route with no rows has proved nothing.

## Type and hit areas

| Token | Value | Tailwind |
| --- | --- | --- |
| `--text-2xs` | 11px | `text-2xs` |
| `--text-sm-minus` | 13px | `text-sm-minus` |
| `--tap-target-min` | 44px | `min-h-tap` |
| `--radius` | 12px | inherited by cards, buttons, inputs |

11px is the legibility floor — reps read this on phones in sunlight. 44px is the
one-handed hit-area floor (WCAG 2.5.5, iOS HIG).

Both floors are now **enforced** by `tests/unit/type-and-tap-floors.test.ts`
rather than asserted here. The 93 sub-11px call sites across 41 files that had
accumulated are gone; the token is size-only, so swapping `text-[10px]` for
`text-2xs` never reflows a line box. The test allows exactly one kind of
exception, marked inline with a `type-floor-exempt:` comment carrying its
reason: a **scale model of another interface**, like the miniature iOS share
sheet in `AddToHomeScreen` or the mock lock-screen notification in
`AnnouncementComposer`. That text is a picture of type; nobody reads it.

A comment could not fail a build, which is why both floors kept being breached
by people who agreed with them. The test found two `text-[7px]` sites and two
hover-only controls that a hand-written grep had missed.

### Touch reachability

Two utilities in `index.css`, because the alternatives keep getting reinvented
wrong:

- **`.reveal-on-hover`** replaces `opacity-0 group-hover:opacity-100`. Written
  the raw way, a secondary row control is not quiet on a touch screen, it is
  **absent** — and the desktop lead table starts at `lg`, which an iPad in
  landscape clears, so Edit and Delete did not exist on the device a manager
  qualifies pipeline on. The fade is scoped to `(hover: hover) and (pointer:
  fine)`; everywhere else the control is simply always visible. The floors test
  fails any new raw spelling on an interactive element.
- **`.tap-expand`** grows a control's hit area to the floor without changing its
  drawn size, for the cases where small is correct: a 36px header avatar reads
  as an avatar and a 44px one reads as a button. "Looks small" and "is hard to
  hit" are separable, and only the second matters between doors. Pair it with a
  real size increase, never as a substitute, when the control has visual mass to
  grow into.

## One page title, app-wide

A page-level `<h1>` is `text-xl font-bold`, whether it comes from `PageHeader`
or from a screen that keeps its own header markup for a custom action row.
`tests/unit/page-header-consistency.test.ts` enforces it, because title drift is
only visible by comparing screens — which a test can do and a reviewer cannot.

Nine of thirty-seven pages currently use the shared `PageHeader`; the rest
hand-roll the same markup. The title *treatment* is consistent and tested; the
duplication is not yet resolved.

## The layering scale (added 2026-08-31)

Stacking is named, never numbered. `tailwind.config.ts` defines the scale;
reach for the layer that says what the surface IS:

| Class | Value | Layer |
| --- | --- | --- |
| `z-nav` | 30 | persistent chrome: bottom tabs, map rail, in-page notices |
| `z-status` | 45 | the field status bar (and the assignment result bar) |
| `z-overlay` | 50 | every modal surface - Radix portals AND hand-rolled sheets |
| `z-raised` | 60 | transient bars above modals (pending bar, update prompt) |
| `z-toast` | 100 | feedback outranks everything it reports on |

The magic numbers this replaced had already inverted once: the statement
viewer sat at `z-[200]`, above the toasts confirming its own Download.
Hand-rolled overlays share `z-overlay` with the Radix portals on purpose - a
portal mounts later in the DOM, so a confirm opened from inside a hand-rolled
sheet wins by document order instead of losing by 20 z-index points.

## Modal behavior is a hook, not a per-file ritual

`useModalA11y(panelRef, { active, onClose })` in `hooks/use-modal-a11y.ts` is
the one modal contract for hand-rolled overlays: focus moved in, Tab
contained, Escape in the CAPTURE phase (so the map's tool-exit hatch never
sees the same keypress), body scroll lock, and focus restored to the opener.
Fourteen surfaces that declared `aria-modal="true"` without any of that now
use it. A NEW overlay should use the Radix Dialog/Sheet primitives first;
the hook exists for surfaces with a reason to stay hand-rolled.

Likewise `useRovingTabs(count, activeIndex, onSelect)` is the keyboard half
of the `role="tablist"` / `role="radiogroup"` contract (arrow keys, one tab
stop, Home/End). Declaring those roles without it promises AT users behavior
that does not exist.

## Small print added to the primitives

- `Button` has a `loading` prop: spinner + disabled + `aria-busy`, replacing
  the hand-rolled `{m.isPending ? <Loader2/> : null}` pattern.
- `Checkbox` carries `tap-expand` (16px drawn, 44px hit) and is pinned by the
  floors test alongside Switch. The floors test also fails any interactive
  element with an arbitrary `min-h-[N px]` under 44.
- `CardTitle` defaults to `text-base` - a card heading must never outrank the
  page `h1` (`text-xl`); the old `text-2xl` scaffold default was overridden
  at all 42 call sites.
- `shadow-card` is the one card shadow (was hand-typed identically in
  card.tsx and tooltip.tsx).
- `AlertDialogContent` renders as a bottom sheet on phones, exactly like
  `DialogContent`.
- `SheetContent` takes `hideClose` for sheets that render their own close
  control - only set it when a visible close exists inside.
- The toaster's severity accents ride the semantic tokens; `payment` keeps a
  violet pair because it is categorical, not a meaning.
