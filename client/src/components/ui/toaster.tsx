import { useToast } from "@/hooks/use-toast"
import type { NotificationSeverity } from "@/hooks/use-toast"
import {
  Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport,
} from "@/components/ui/toast"
import { CheckCircle2, Info, AlertTriangle, XCircle, WifiOff, CreditCard, Loader2 } from "lucide-react"

// Severity → politeness + accent + icon. Routine messages are announced
// POLITELY (Radix type="background" → aria-live polite); important ones are
// ASSERTIVE (type="foreground"). Every severity auto-dismisses (errors on a
// longer beat) — timing lives in use-toast. Severity is conveyed by a SLIM
// left accent on the card, never a loud fill. Reduced-motion is honored by
// the animation classes; the viewport is safe-area padded.
const META: Record<NotificationSeverity, { politeness: "foreground" | "background"; accent: string; Icon: any; iconClass: string }> = {
  success: { politeness: "background", accent: "border-l-emerald-500", Icon: CheckCircle2, iconClass: "text-emerald-500" },
  info:    { politeness: "background", accent: "border-l-sky-500",     Icon: Info,        iconClass: "text-sky-500" },
  warning: { politeness: "foreground", accent: "border-l-amber-500",   Icon: AlertTriangle, iconClass: "text-amber-500" },
  error:   { politeness: "foreground", accent: "border-l-rose-500",    Icon: XCircle,     iconClass: "text-rose-500" },
  offline: { politeness: "foreground", accent: "border-l-amber-500",   Icon: WifiOff,     iconClass: "text-amber-500" },
  payment: { politeness: "foreground", accent: "border-l-violet-500",  Icon: CreditCard,  iconClass: "text-violet-500" },
  loading: { politeness: "foreground", accent: "border-l-transparent", Icon: Loader2,     iconClass: "text-muted-foreground animate-spin motion-reduce:animate-none" },
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, severity, variant, duration: _duration, dedupeKey: _dedupeKey, createdAt: _createdAt, ...props }) {
        const sev: NotificationSeverity = severity ?? (variant === "destructive" ? "error" : "info")
        const m = META[sev]
        const Icon = m.Icon
        return (
          <Toast
            key={id}
            {...props}
            // The notification service owns ALL timing (severity windows,
            // duration:null persistence, dedupe timer refresh). Radix runs its
            // OWN close timer — `durationProp || provider default (5s)`, and a
            // null/undefined duration falls through to the 5s default — which
            // would force-close a persistent (duration:null) or loading toast
            // at 5s and cut the 6s error window short. Infinity is Radix's
            // documented opt-out, so its timer never fires; the service's
            // DISMISS_TOAST drives open=false instead. duration/dedupeKey/
            // createdAt are service-level fields, destructured out above so
            // they never reach the DOM element.
            duration={Infinity}
            type={m.politeness}
            data-severity={sev}
            className={`items-start ${m.accent}`}
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${m.iconClass}`} aria-hidden="true" />
            <div className="grid gap-0.5 min-w-0 flex-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
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
