import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./client/index.html", "./client/src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        lg: ".5625rem", /* 9px */
        md: ".375rem", /* 6px */
        sm: ".1875rem", /* 3px */
      },
      colors: {
        // Flat / base colors (regular buttons)
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
          border: "hsl(var(--card-border) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
          border: "hsl(var(--popover-border) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
          border: "var(--primary-border)",
        },
        /* The Homefront gold, from the logo. Emphasis, active state and the one
           call to action that matters - never a large background.
             bg-gold + text-gold-foreground   a gold surface (6.6:1)
             text-gold-text                   gold AS text on white (4.6:1, AA)
             bg-gold-soft                     the tint for chips and rails
           `gold` itself is 2.6:1 on white and must not carry text. */
        gold: {
          DEFAULT: "hsl(var(--accent-gold) / <alpha-value>)",
          hover: "hsl(var(--accent-gold-hover) / <alpha-value>)",
          foreground: "hsl(var(--accent-gold-fg) / <alpha-value>)",
          text: "hsl(var(--accent-gold-text) / <alpha-value>)",
          soft: "hsl(var(--accent-gold-soft) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
          border: "var(--secondary-border)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
          border: "var(--muted-border)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
          border: "var(--accent-border)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
          border: "var(--destructive-border)",
        },
        ring: "hsl(var(--ring) / <alpha-value>)",
        // Semantic status colors — replaces ad-hoc raw emerald/amber usage so
        // both themes stay AA (tokens defined in index.css :root/.light).
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        info: "hsl(var(--info) / <alpha-value>)",
        // No <alpha-value>: --overlay already carries its own alpha, so `bg-overlay`
        // is the whole scrim and no call site needs to pick an opacity.
        overlay: "var(--overlay)",
        chart: {
          "1": "hsl(var(--chart-1) / <alpha-value>)",
          "2": "hsl(var(--chart-2) / <alpha-value>)",
          "3": "hsl(var(--chart-3) / <alpha-value>)",
          "4": "hsl(var(--chart-4) / <alpha-value>)",
          "5": "hsl(var(--chart-5) / <alpha-value>)",
        },
        // NOTE: a `sidebar` palette used to live here (sidebar, -primary and
        // -accent, 10 tokens). It came from the shadcn scaffold, none of its
        // tokens were ever defined in index.css, and it had ZERO call sites -
        // this is a bottom-tab mobile app with no sidebar to style. Left in
        // place it was a trap: the first `bg-sidebar` would have resolved to
        // `hsl( / 1)` and the first `border-sidebar-primary` to `currentColor`,
        // which is the same undefined-token bug that once put ink hairlines on
        // every Card. tests/unit/light-theme-token-coverage.test.ts now fails
        // the build if a Tailwind colour maps to a token no theme defines.
        // NOTE: a second, conflicting `status` palette used to live here
        // (online/away/busy/offline as raw rgb()). It had ZERO call sites and
        // its greens/ambers/reds did not match the canonical field-status
        // palette in shared/statusConfig.ts — e.g. rgb(34 197 94) vs the real
        // prospect #16A34A. Two status vocabularies with different values is
        // precisely the drift designTokens.ts exists to prevent, so the dead
        // one is gone. STATUS_CONFIG / STATE_COLORS are the single source.
      },
      // Sub-`text-sm` steps. ALL size-only (no line-height tuple) so swapping an
      // arbitrary `text-[Npx]` for the named token never reflows a line box.
      // Values are mirrored by --text-* in client/src/index.css and by
      // designTokens.ts; tests/unit/design-tokens.test.ts fails on any drift.
      //
      // Legibility floor: 11px is the smallest sanctioned text size (reps read
      // this on phones in sunlight). Do NOT add a token below it — the 16
      // `text-[10px]`, 11 `text-[10.5px]` and 3 sub-10px call sites in the app
      // are floor violations to be raised, not sizes to be blessed.
      fontSize: {
        "2xs": "0.6875rem",     // 11px — meta, captions, pill text
        // 13px sits between Tailwind's text-xs (12px) and text-sm (14px), a real
        // gap in the default scale; 146 call sites reach past it for
        // `text-[13px]`. Named relative to the existing scale rather than
        // starting a parallel one.
        "sm-minus": "0.8125rem", // 13px — dense secondary body text
      },
      // One-handed hit-area floor (WCAG 2.5.5 / iOS HIG), so intent is legible
      // at the call site: `min-h-tap` says what `min-h-[44px]` only implies.
      // Identical metrics to the h-11 the app already uses.
      spacing: {
        tap: "2.75rem", // 44px — matches --tap-target-min
      },
      fontFamily: {
        /* Real stacks — the old var(--font-*) custom properties were never defined */
        sans: ["Geist Variable", "system-ui", "-apple-system", "sans-serif"],
        serif: ["Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
} satisfies Config;
