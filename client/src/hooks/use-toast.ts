// ── Centralized notification service ─────────────────────────────────────────
// One hub for every toast in the app. Backward-compatible with the existing
// `toast({ title, description, variant, action })` calls, but now with:
//   • EVERYTHING AUTO-DISMISSES — routine messages (success/info) leave in
//     ~2.5s; important ones (warning/error/offline/payment) stay a longer beat
//     (~6s) so they can be read, then leave too. Nothing lingers. `duration`
//     overrides per-call; `null` is the explicit opt-out for the rare toast
//     that must persist (loading defaults to null — its lifetime is bound to
//     the operation, the caller updates/dismisses it).
//   • DEDUPE — an identical message that's already showing is dropped (its
//     timer is refreshed) instead of stacking.
//   • CAP — at most TWO toasts are visible; a new one appears INSTANTLY (no
//     waiting for the old one's exit) and the oldest is pushed out.
//   • ERROR CENTER — error/warning notifications are also appended to a durable
//     log so an auto-dismissed or missed failure is never gone for good.
// Placement, aria-live, and reduced-motion live in the Toaster component.
import * as React from "react"

import type { ToastActionElement, ToastProps } from "@/components/ui/toast"

export type NotificationSeverity =
  | "success" | "info" | "warning" | "error" | "offline" | "payment" | "loading"

// Routine severities leave quickly; important ones get a longer read window —
// but every user-facing severity auto-dismisses. Only `loading` defaults to
// persistent because its lifetime is the operation's, not a timer's.
export const SUCCESS_DISMISS_MS = 2500
export const ERROR_DISMISS_MS = 6000
const DURATION_BY_SEVERITY: Record<NotificationSeverity, number | null> = {
  success: SUCCESS_DISMISS_MS,
  info: SUCCESS_DISMISS_MS,
  warning: ERROR_DISMISS_MS,
  error: ERROR_DISMISS_MS,
  offline: ERROR_DISMISS_MS,
  payment: ERROR_DISMISS_MS,
  loading: null,
}

// How long an exiting toast stays mounted so its exit animation (~150ms of
// GPU-composited transform/fade in toast.tsx) can finish before unmount.
const REMOVE_ANIMATION_MS = 160

// The interface stays clean: at most two toasts on screen at once.
const MAX_VISIBLE_TOASTS = 2

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
  severity?: NotificationSeverity
  /** ms until auto-dismiss; null persists. Defaults from severity. */
  duration?: number | null
  /** Explicit dedupe signature; defaults to severity+title+description. */
  dedupeKey?: string
  createdAt?: number
}

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const

let count = 0
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

type ActionType = typeof actionTypes
type Action =
  | { type: ActionType["ADD_TOAST"]; toast: ToasterToast }
  | { type: ActionType["UPDATE_TOAST"]; toast: Partial<ToasterToast> }
  | { type: ActionType["DISMISS_TOAST"]; toastId?: ToasterToast["id"] }
  | { type: ActionType["REMOVE_TOAST"]; toastId?: ToasterToast["id"] }

interface State {
  toasts: ToasterToast[]      // visible, newest first — at most MAX_VISIBLE_TOASTS open
}

// ── timing helpers ───────────────────────────────────────────────────────────
export function resolveDuration(t: Pick<ToasterToast, "severity" | "duration">): number | null {
  if (t.duration !== undefined) return t.duration
  if (t.severity) return DURATION_BY_SEVERITY[t.severity]
  return SUCCESS_DISMISS_MS
}
export function dedupeSignature(t: ToasterToast): string {
  return t.dedupeKey ?? `${t.severity ?? "info"}|${String(t.title ?? "")}|${String(t.description ?? "")}`
}
function findLiveDuplicate(state: State, t: ToasterToast): ToasterToast | undefined {
  const sig = dedupeSignature(t)
  // A toast mid-exit (open:false) is not a dup candidate — the message should
  // be allowed to reappear.
  return state.toasts.find(x => x.open !== false && dedupeSignature(x) === sig)
}

const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
const removeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimers(id: string) {
  const d = dismissTimers.get(id); if (d) { clearTimeout(d); dismissTimers.delete(id) }
  const r = removeTimers.get(id); if (r) { clearTimeout(r); removeTimers.delete(id) }
}
function scheduleAutoDismiss(t: ToasterToast) {
  clearTimers(t.id)
  const ms = resolveDuration(t)
  if (ms == null) return // explicit opt-out — caller owns this toast's lifetime
  dismissTimers.set(t.id, setTimeout(() => dispatch({ type: "DISMISS_TOAST", toastId: t.id }), ms))
}
function scheduleRemoval(id: string) {
  if (removeTimers.has(id)) return
  removeTimers.set(id, setTimeout(() => {
    removeTimers.delete(id)
    dispatch({ type: "REMOVE_TOAST", toastId: id })
  }, REMOVE_ANIMATION_MS))
}

// ── error center ─────────────────────────────────────────────────────────────
export interface StoredNotification { id: string; title: string; description?: string; severity: NotificationSeverity; at: number }
const MAX_ERROR_LOG = 50
let errorLog: StoredNotification[] = []
const errorListeners: Array<(log: StoredNotification[]) => void> = []
function recordToErrorCenter(t: ToasterToast) {
  const sev = t.severity ?? (t.variant === "destructive" ? "error" : "info")
  if (sev !== "error" && sev !== "warning" && sev !== "offline" && sev !== "payment") return
  errorLog = [{ id: t.id, title: String(t.title ?? ""), description: t.description ? String(t.description) : undefined, severity: sev, at: t.createdAt ?? Date.now() }, ...errorLog].slice(0, MAX_ERROR_LOG)
  errorListeners.forEach(l => l(errorLog))
}
export function getErrorNotifications(): StoredNotification[] { return errorLog }
export function clearErrorNotifications() { errorLog = []; errorListeners.forEach(l => l(errorLog)) }

// ── reducer ──────────────────────────────────────────────────────────────────
export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST": {
      // The new toast shows INSTANTLY (newest first). Anything past the cap is
      // pushed into its exit animation — no waiting for the old one to leave.
      const toasts = [action.toast, ...state.toasts]
      const evicted = toasts.slice(MAX_VISIBLE_TOASTS).filter(t => t.open !== false)
      evicted.forEach(t => { clearTimers(t.id); scheduleRemoval(t.id) })
      return {
        toasts: toasts.map((t, i) =>
          i >= MAX_VISIBLE_TOASTS && t.open !== false ? { ...t, open: false } : t
        ),
      }
    }
    case "UPDATE_TOAST":
      return {
        toasts: state.toasts.map(t => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
      }
    case "DISMISS_TOAST": {
      const { toastId } = action
      const ids = toastId ? [toastId] : state.toasts.map(t => t.id)
      ids.forEach(id => { clearTimers(id); scheduleRemoval(id) })
      return {
        toasts: state.toasts.map(t => (toastId === undefined || t.id === toastId ? { ...t, open: false } : t)),
      }
    }
    case "REMOVE_TOAST": {
      if (action.toastId === undefined) return { toasts: [] }
      return { toasts: state.toasts.filter(t => t.id !== action.toastId) }
    }
  }
}

const listeners: Array<(state: State) => void> = []
let memoryState: State = { toasts: [] }
function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach(l => l(memoryState))
}

type Toast = Omit<ToasterToast, "id" | "createdAt">

// Shared by both handles toast() can return (fresh id and dedupe-refreshed).
// An update that changes TIMING — the loading→success/error pattern, or an
// explicit duration — must re-arm auto-dismiss: the schedule ran at creation
// against the OLD severity/duration (loading = persist), so without this a
// toast updated from loading to "Done" would linger forever.
function updateToast(id: string, p: Partial<ToasterToast>) {
  dispatch({ type: "UPDATE_TOAST", toast: { ...p, id } })
  if (p.severity !== undefined || p.duration !== undefined) {
    const merged = memoryState.toasts.find(t => t.id === id)
    if (merged && merged.open !== false) scheduleAutoDismiss(merged)
  }
}

function toast(props: Toast) {
  const id = genId()
  const createdAt = Date.now()
  // variant → severity bridge so legacy `variant: "destructive"` maps to error.
  const severity: NotificationSeverity | undefined = props.severity ?? (props.variant === "destructive" ? "error" : undefined)
  const full: ToasterToast = { ...props, severity, id, createdAt, open: true }

  // Dedupe: an identical live message refreshes its timer rather than stacks.
  const existing = findLiveDuplicate(memoryState, full)
  if (existing) {
    scheduleAutoDismiss(existing)
    return {
      id: existing.id,
      dismiss: () => dispatch({ type: "DISMISS_TOAST", toastId: existing.id }),
      update: (p: Partial<ToasterToast>) => updateToast(existing.id, p),
    }
  }

  full.onOpenChange = (open) => { if (!open) dispatch({ type: "DISMISS_TOAST", toastId: id }) }
  recordToErrorCenter(full)
  dispatch({ type: "ADD_TOAST", toast: full })
  scheduleAutoDismiss(full)

  return {
    id,
    dismiss: () => dispatch({ type: "DISMISS_TOAST", toastId: id }),
    update: (p: Partial<ToasterToast>) => updateToast(id, p),
  }
}

// Subscribes LAZILY: a component that only calls `toast()`/`dismiss()` (most
// pages) never re-renders on toast traffic — only components that actually
// read `.toasts` (the Toaster) subscribe to state changes. This keeps a toast
// dispatch from re-rendering every page that grabbed `toast` via the hook.
function useToast() {
  const [state, setState] = React.useState<State>(memoryState)
  const readsState = React.useRef(false)
  React.useEffect(() => {
    const listener = (s: State) => { if (readsState.current) setState(s) }
    listeners.push(listener)
    // Catch up on anything dispatched between render and subscription.
    if (readsState.current && memoryState !== state) setState(memoryState)
    return () => { const i = listeners.indexOf(listener); if (i > -1) listeners.splice(i, 1) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return {
    get toasts() { readsState.current = true; return state.toasts },
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  }
}

// Error-center hook — a durable list of failures the user can revisit.
function useErrorCenter() {
  const [log, setLog] = React.useState<StoredNotification[]>(errorLog)
  React.useEffect(() => {
    errorListeners.push(setLog)
    return () => { const i = errorListeners.indexOf(setLog); if (i > -1) errorListeners.splice(i, 1) }
  }, [])
  return { notifications: log, clear: clearErrorNotifications }
}

// Test-only reset so the module-level singleton doesn't leak across cases.
export function __resetToastsForTest() {
  memoryState = { toasts: [] }
  errorLog = []
  dismissTimers.forEach(clearTimeout); dismissTimers.clear()
  removeTimers.forEach(clearTimeout); removeTimers.clear()
  listeners.forEach(l => l(memoryState))
}

export { useToast, useErrorCenter, toast }
