// ── Centralized notification service ─────────────────────────────────────────
// One hub for every toast in the app. Backward-compatible with the existing
// `toast({ title, description, variant, action })` calls, but now with:
//   • SEVERITY-driven timing — routine messages (success/info) auto-dismiss in
//     ~2.5s; important ones (warning/error/offline/payment/loading) PERSIST
//     until resolved or dismissed. `duration` overrides; `null` = never auto.
//   • DEDUPE — an identical message that's already showing/queued is dropped
//     (its timer is refreshed) instead of stacking.
//   • QUEUE — only ONE toast is visible at a time; rapid actions queue and show
//     in turn so nothing is silently lost.
//   • ERROR CENTER — error/warning notifications are also appended to a durable
//     log so an auto-dismissed or missed failure is never gone for good.
// Placement, aria-live, and reduced-motion live in the Toaster component.
import * as React from "react"

import type { ToastActionElement, ToastProps } from "@/components/ui/toast"

export type NotificationSeverity =
  | "success" | "info" | "warning" | "error" | "offline" | "payment" | "loading"

// Routine severities auto-dismiss; everything else persists until resolved.
const AUTO_DISMISS_MS = 2600
const DURATION_BY_SEVERITY: Record<NotificationSeverity, number | null> = {
  success: AUTO_DISMISS_MS,
  info: AUTO_DISMISS_MS,
  warning: null,
  error: null,
  offline: null,
  payment: null,
  loading: null,
}

const REMOVE_ANIMATION_MS = 220

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
  toasts: ToasterToast[]      // visible — at most one
  queue: ToasterToast[]       // pending, shown in turn
}

// ── timing helpers ───────────────────────────────────────────────────────────
export function resolveDuration(t: Pick<ToasterToast, "severity" | "duration">): number | null {
  if (t.duration !== undefined) return t.duration
  if (t.severity) return DURATION_BY_SEVERITY[t.severity]
  return AUTO_DISMISS_MS
}
export function dedupeSignature(t: ToasterToast): string {
  return t.dedupeKey ?? `${t.severity ?? "info"}|${String(t.title ?? "")}|${String(t.description ?? "")}`
}
function isDuplicate(state: State, t: ToasterToast): boolean {
  const sig = dedupeSignature(t)
  return [...state.toasts, ...state.queue].some(x => dedupeSignature(x) === sig)
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
  if (ms == null) return // persistent — never auto-dismiss
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
      // Only one visible at a time — extras queue.
      if (state.toasts.length >= 1) return { ...state, queue: [...state.queue, action.toast] }
      return { ...state, toasts: [action.toast] }
    }
    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map(t => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
        queue: state.queue.map(t => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
      }
    case "DISMISS_TOAST": {
      const { toastId } = action
      const ids = toastId ? [toastId] : state.toasts.map(t => t.id)
      ids.forEach(id => { clearTimers(id); scheduleRemoval(id) })
      return {
        ...state,
        toasts: state.toasts.map(t => (toastId === undefined || t.id === toastId ? { ...t, open: false } : t)),
        // A queued toast dismissed before it ever showed is simply dropped.
        queue: toastId ? state.queue.filter(t => t.id !== toastId) : state.queue,
      }
    }
    case "REMOVE_TOAST": {
      const remaining = action.toastId === undefined ? [] : state.toasts.filter(t => t.id !== action.toastId)
      // Promote the next queued toast into the now-free visible slot.
      if (remaining.length === 0 && state.queue.length > 0) {
        const [next, ...rest] = state.queue
        queueMicrotask(() => scheduleAutoDismiss(next))
        return { toasts: [next], queue: rest }
      }
      return { ...state, toasts: remaining }
    }
  }
}

const listeners: Array<(state: State) => void> = []
let memoryState: State = { toasts: [], queue: [] }
function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach(l => l(memoryState))
}

type Toast = Omit<ToasterToast, "id" | "createdAt">

function toast(props: Toast) {
  const id = genId()
  const createdAt = Date.now()
  // variant → severity bridge so legacy `variant: "destructive"` persists.
  const severity: NotificationSeverity | undefined = props.severity ?? (props.variant === "destructive" ? "error" : undefined)
  const full: ToasterToast = { ...props, severity, id, createdAt, open: true }

  // Dedupe: an identical live/queued message refreshes rather than stacks.
  if (isDuplicate(memoryState, full)) {
    const sig = dedupeSignature(full)
    const existing = [...memoryState.toasts, ...memoryState.queue].find(x => dedupeSignature(x) === sig)
    if (existing && memoryState.toasts.some(t => t.id === existing.id)) scheduleAutoDismiss(existing)
    return { id: existing?.id ?? id, dismiss: () => dispatch({ type: "DISMISS_TOAST", toastId: existing?.id }), update: () => {} }
  }

  full.onOpenChange = (open) => { if (!open) dispatch({ type: "DISMISS_TOAST", toastId: id }) }
  recordToErrorCenter(full)
  dispatch({ type: "ADD_TOAST", toast: full })
  // Timer only starts once VISIBLE (queued toasts start when promoted).
  if (memoryState.toasts.some(t => t.id === id)) scheduleAutoDismiss(full)

  return {
    id,
    dismiss: () => dispatch({ type: "DISMISS_TOAST", toastId: id }),
    update: (p: Partial<ToasterToast>) => dispatch({ type: "UPDATE_TOAST", toast: { ...p, id } }),
  }
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState)
  React.useEffect(() => {
    listeners.push(setState)
    return () => { const i = listeners.indexOf(setState); if (i > -1) listeners.splice(i, 1) }
  }, [])
  return {
    toasts: state.toasts,
    queue: state.queue,
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
  memoryState = { toasts: [], queue: [] }
  errorLog = []
  dismissTimers.forEach(clearTimeout); dismissTimers.clear()
  removeTimers.forEach(clearTimeout); removeTimers.clear()
  listeners.forEach(l => l(memoryState))
}

export { useToast, useErrorCenter, toast }
