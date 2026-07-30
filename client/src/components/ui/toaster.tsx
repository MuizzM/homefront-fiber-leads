import { useToast } from "@/hooks/use-toast"
import type { NotificationSeverity } from "@/hooks/use-toast"
import {
  Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport,
} from "@/components/ui/toast"
import { CheckCircle2, Info, AlertTriangle, XCircle, WifiOff, CreditCard, Loader2 } from "lucide-react"

// Severity → politeness + accent + icon. Routine messages are announced
// POLITELY (Radix type="background" → aria-live polite) and auto-dismiss;
// important ones are ASSERTIVE (type="foreground") and persist. Reduced-motion
// is honored by the animation classes; the viewport is safe-area padded.
const META: Record<NotificationSeverity, { politeness: "foreground" | "background"; accent: string; Icon: any; iconClass: string }> = {
  success: { politeness: "background", accent: "border-emerald-500/40", Icon: CheckCircle2, iconClass: "text-emerald-500" },
  info:    { politeness: "background", accent: "border-border",         Icon: Info,        iconClass: "text-sky-500" },
  warning: { politeness: "foreground", accent: "border-amber-500/50",   Icon: AlertTriangle, iconClass: "text-amber-500" },
  error:   { politeness: "foreground", accent: "border-rose-500/50",    Icon: XCircle,     iconClass: "text-rose-500" },
  offline: { politeness: "foreground", accent: "border-amber-500/50",   Icon: WifiOff,     iconClass: "text-amber-500" },
  payment: { politeness: "foreground", accent: "border-violet-500/50",  Icon: CreditCard,  iconClass: "text-violet-500" },
  loading: { politeness: "foreground", accent: "border-border",         Icon: Loader2,     iconClass: "text-muted-foreground animate-spin motion-reduce:animate-none" },
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, severity, variant, ...props }) {
        const sev: NotificationSeverity = severity ?? (variant === "destructive" ? "error" : "info")
        const m = META[sev]
        const Icon = m.Icon
        return (
          <Toast
            key={id}
            {...props}
            type={m.politeness}
            data-severity={sev}
            className={`items-start gap-3 p-4 pr-9 ${m.accent}`}
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${m.iconClass}`} aria-hidden="true" />
            <div className="grid gap-0.5 min-w-0 flex-1">
              {title && <ToastTitle className="text-[13px] leading-snug">{title}</ToastTitle>}
              {description && <ToastDescription className="text-[12px] leading-snug">{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
