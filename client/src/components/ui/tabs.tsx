"use client"

// ── Tabs ──────────────────────────────────────────────────────────────────────
// The tablist primitive a run of screens hand-rolled as `role="tablist"` with
// no tabpanel, no aria-controls and no arrow keys (docs/ui-audit-2026-08.md §5:
// "an unimplemented keyboard contract should be dropped or implemented, per
// widget" — this implements it). Radix supplies the real contract: roving
// tabindex, Home/End, arrow keys, automatic aria wiring between trigger and
// panel. The skin follows the design system: active carries background +
// weight (never color alone), triggers meet the 44px floor, tokens throughout.

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // A quiet rail of pills; horizontal scroll instead of wrap so a long tab
      // set stays one row on phones (the peeking pill advertises the scroll).
      "inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-secondary p-1 text-muted-foreground scrollbar-none",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // 44px one-handed floor; active = raised card + full-weight ink, so the
      // state survives color-vision differences and both themes.
      "inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-3.5 text-[13px] font-semibold transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:pointer-events-none disabled:opacity-50",
      "data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      "data-[state=inactive]:hover:text-foreground",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
