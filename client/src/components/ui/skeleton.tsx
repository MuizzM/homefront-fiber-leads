import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("app-skeleton rounded-xl bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
