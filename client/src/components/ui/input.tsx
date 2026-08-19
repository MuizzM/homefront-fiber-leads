import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    // 44px on phones prevents mistaps and iOS focus zoom; desktop stays dense.
    return (
      <input
        type={type}
        className={cn(
          // NOTE: horizontal padding is intentionally NOT responsive. A
          // `md:px-3` here outranked any unprefixed consumer padding at
          // desktop widths (tailwind-merge cannot dedupe across breakpoints),
          // so every input with a leading icon collided with that icon on
          // desktop — visible in the Leads search. One padding value keeps
          // `pl-9`-style overrides working at every width.
          "flex h-11 w-full rounded-xl border border-input bg-background px-3.5 py-2 text-base ring-offset-background transition-[border-color,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50 md:h-9 md:rounded-lg md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
