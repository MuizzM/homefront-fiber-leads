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

An unpaired `-300`/`-400` step is the obvious case. Two less obvious ones:

- **A `-600 dark:-400` pair is not automatically safe.** `emerald-600` measures
  3.28:1 and `amber-700` 4.47:1. That rule was written to stop a bare `-400`
  washing out on light; it never checked that the light half cleared AA.
  Collapse the pair onto the token, which is correct on both grounds and needs
  no `dark:` twin.
- **A `[.light_&]:` override on a semantic base is dead weight.** The token
  already handles light, so the override only shadows it with the raw step it
  was meant to replace.

This migration is **not finished**. 83 unpaired call sites remain, more than
half of them in `MapView` (27) and the two orphaned scanner tabs (`USAScanner`
15, `CityScanner` 12); the rest is a long tail of one or two per file. MapView
is excluded deliberately: it carries its own dark map chrome, and the semantic
tokens are tuned for the light default, so a chip on a dark panel needs hand
review rather than a blanket replacement. Check any file for `bg-slate-900`,
`bg-black` or map chrome before converting it.

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

11px is the legibility floor — reps read this on phones in sunlight. The
`text-[10px]` call sites that remain are violations to be raised, not sizes to
be blessed. 44px is the one-handed hit-area floor (WCAG 2.5.5, iOS HIG).

## One page title, app-wide

A page-level `<h1>` is `text-xl font-bold`, whether it comes from `PageHeader`
or from a screen that keeps its own header markup for a custom action row.
`tests/unit/page-header-consistency.test.ts` enforces it, because title drift is
only visible by comparing screens — which a test can do and a reviewer cannot.

Nine of thirty-seven pages currently use the shared `PageHeader`; the rest
hand-roll the same markup. The title *treatment* is consistent and tested; the
duplication is not yet resolved.
