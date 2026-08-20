# Home Front Portal — UI system

**Product:** multi-tenant field-sales operations SaaS

**Primary users:** mobile field representatives; desktop/tablet managers and administrators

**Design dials:** variance 5/10 · motion 3/10 · density 7/10
**Updated:** 2026-08-19

This file records the design decisions for future portal work. The implemented
tokens in `client/src/index.css` and the shared primitives in
`client/src/components/ui/` are the source of truth. Page-specific files under
`design-system/home-front-portal/pages/` may narrow these rules but must not
replace the Home Front brand or accessibility floors.

## Product character

Calm, trustworthy, operational, and fast. The interface should feel like a
serious field tool: clear data, obvious next actions, minimal decoration, and
enough warmth to make onboarding approachable. Avoid a generic marketing-site
look inside the authenticated app.

## Brand and color

Use semantic HSL tokens only; do not hardcode colors in page components.

| Role | Light | Dark | Usage |
|---|---:|---:|---|
| Primary | `211 68% 26%` | `209 78% 62%` | Navigation, links, primary action |
| Background | `40 24% 98%` | `216 22% 6%` | App canvas |
| Foreground | `212 40% 12%` | `210 16% 96%` | Primary text |
| Card | `0 0% 100%` | `216 20% 9%` | Content surfaces |
| Secondary | `214 22% 95%` | `216 15% 14%` | Subtle groups and hover surfaces |
| Muted text | `213 14% 42%` | `214 10% 62%` | Secondary copy; maintain AA |
| Success | `161 94% 22%` | `160 84% 42%` | Confirmed success only |
| Warning | `32 95% 30%` | `38 92% 55%` | Attention state with text/icon |
| Destructive | `0 72% 44%` | `0 80% 68%` | Destructive actions and errors |

- Light mode remains the default; dark mode is an explicit user preference.
- Warm gold is an accent for premium/reward detail, never a general surface.
- Never communicate status by color alone. Pair it with a label or icon.
- Normal text must reach 4.5:1 contrast; focus and control boundaries 3:1.

## Typography

- Use the self-hosted variable **Geist** family already bundled by Vite.
- Page title: `text-xl font-bold tracking-tight` and exactly one `h1`.
- Body: 14–16px with 1.5 line-height; mobile inputs stay 16px to avoid zoom.
- Dense supporting text may use 13px. The absolute legibility floor is 11px and
  is reserved for non-essential metadata.
- Use tabular figures for money, progress, durations, and comparable metrics.
- Use sentence case for section labels. Reserve uppercase tracking for the
  official wordmark and compact status codes, not routine page structure.
- Prefer wrapping to truncation. If truncation is unavoidable, preserve a way
  for pointer and keyboard users to reach the full value.

## Layout and spacing

- Use a 4/8px rhythm. Standard component/section spacing: 8, 16, 24, 32, 48.
- Desktop sidebar: 264px. Mobile navigation: drawer plus no more than five
  labeled bottom destinations.
- Standard content widths: `max-w-5xl` for focused workflows, `max-w-7xl` for
  data workspaces. Long prose should stay below roughly 75 characters per line.
- Mobile-first checkpoints: 375, 768, 1024, and 1440px. Also verify landscape.
- Reserve safe-area and bottom-tab space. Never hide focused content behind
  fixed chrome and never introduce horizontal page scrolling.
- Cards use 12–16px radii, a visible semantic border, and subtle elevation.
  Avoid stacks of nested floating cards where grouped rows are clearer.

## Components

### Buttons

- One primary action per screen. Secondary and destructive actions are visually
  subordinate and separated where mistakes are costly.
- 44px minimum touch target; 8px between adjacent touch controls.
- Use Lucide icons, with text labels unless the icon control has an accessible
  name. Decorative icons are `aria-hidden`.
- Pointer, hover, active, disabled, loading, and visible keyboard-focus states
  are required. Feedback must not shift surrounding layout.

### Forms

- Every field has a visible label and semantic input type/autocomplete where
  applicable. Place specific errors beside the field and wire them with
  `aria-describedby`/`aria-invalid`.
- Failed multi-field forms focus a summary or the first invalid field. Keep user
  input intact and explain the recovery action.
- Disable async submit controls while pending and announce success/errors in an
  appropriate live region without stealing focus.

### Data and lists

- Stat tiles read label first, number second; use tabular figures and text/icon
  status, not decorative color alone.
- Clickable list rows are real buttons or links with visible focus. Descriptions
  may wrap to two lines; do not hide decision-making context.
- Virtualize lists above roughly 50 visible records and debounce high-frequency
  search/filter requests.
- Charts require a text summary or table alternative, labeled units, keyboard-
  reachable details, and a meaningful loading/empty/error state.

### Navigation and overlays

- Active navigation uses background, weight, and a rail—not color alone.
- Keep the skip-to-content path working without changing the hash-router route.
- Drawers and sheets trap focus, close with Escape, expose expanded/modal state,
  restore trigger focus, and use blur only to indicate background dismissal.

## Motion and performance

- Motion explains state changes; it is not decoration. Favor opacity/transform
  and 150–300ms feedback. Avoid layout-changing hover transforms.
- Respect `prefers-reduced-motion` and render the final usable state immediately.
- Reserve async space with skeletons to prevent layout shift. Split heavy
  routes, lazy-load below-the-fold media, and keep tap feedback under 100ms.

## Pre-delivery gates

- Keyboard: logical tab order, visible focus, skip link, Escape routes.
- Screen reader: one page `h1`, named icon controls, semantic progress/status,
  decorative icons hidden.
- Responsive: 375/768/1024/1440px plus landscape; no clipped content or
  horizontal scroll.
- Themes: independently inspect light and dark contrast and interaction states.
- Touch: targets at least 44px, safe-area clearance, no gesture-only action.
- Truth: UI copy must match the real product state and authorization; never use
  a polished empty/loading state to imply data or access that does not exist.
