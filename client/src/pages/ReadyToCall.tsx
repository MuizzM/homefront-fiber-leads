// ── Ready-to-Call workspace ──────────────────────────────────────────────────
// One phone-bearing lead at a time. Design grammar from shipped contact cards
// (Mobbin — Telegram / TextNow / WhatsApp): a centered identity, the phone
// number as the hero, a big one-tap Call action, then a compact disposition
// step. Numbers dial the device dialer via tel:; nothing here gates the call —
// the rep verifies each number when they press Call (their stated workflow).
//
// Concurrency: on landing a card the rep CLAIMS an advisory soft-lock and
// heartbeats it; a card already claimed by someone else shows "… is calling
// this now" so two reps don't unknowingly dial the same record. The lock frees
// on save, on moving off the card, and on an unmount/TTL.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CALL_OUTCOMES, callOutcomeMeta, displayName, isResident, dialPhone, formatDialDisplay,
  type CallableLeadFields,
} from "@shared/readyToCall";
import {
  Phone, Copy, Check, ChevronLeft, ChevronRight, MapPin, User, Loader2, WifiOff,
  PhoneCall, MessageSquare, PhoneOff,
} from "lucide-react";

interface QueueLead extends CallableLeadFields {
  id: number; address: string; city: string; state: string; zip: string;
  leadStatus: string; lastCallOutcome: string | null;
  lockedByUserId: number | null; lockedByName: string | null; lockedUntil: string | null;
}
interface QueueResponse { queue: QueueLead[]; meId: number | null; noTenant?: boolean; }

const TONE: Record<string, string> = {
  neutral:  "border-border bg-secondary text-foreground",
  info:     "border-sky-500/30 bg-sky-500/10 text-sky-300 [.light_&]:text-sky-700",
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 [.light_&]:text-emerald-700",
  warn:     "border-amber-500/30 bg-amber-500/10 text-amber-300 [.light_&]:text-amber-700",
  danger:   "border-rose-500/30 bg-rose-500/10 text-rose-300 [.light_&]:text-rose-700",
};
const TONE_ACTIVE: Record<string, string> = {
  neutral:  "border-primary bg-primary/15 text-foreground ring-1 ring-primary",
  info:     "border-sky-500 bg-sky-500/20 text-sky-200 ring-1 ring-sky-500 [.light_&]:text-sky-800",
  positive: "border-emerald-500 bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500 [.light_&]:text-emerald-800",
  warn:     "border-amber-500 bg-amber-500/20 text-amber-100 ring-1 ring-amber-500 [.light_&]:text-amber-800",
  danger:   "border-rose-500 bg-rose-500/20 text-rose-100 ring-1 ring-rose-500 [.light_&]:text-rose-800",
};

// A concise, personalized opener built ONLY from data we actually have — never
// a fabricated claim. Falls back gracefully when a field is missing.
function buildScript(lead: QueueLead): string {
  const who = isResident(lead) ? "there" : displayName(lead).split(" ")[0];
  const where = lead.city ? ` here in ${lead.city}` : "";
  return `Hi ${who}, this is [your name] with Home Front Solutions — we're bringing Kinetic Fiber internet to your neighborhood${where}. I wanted to see if you'd want faster, more reliable service at your address. Do you have a quick minute?`;
}

import { FOCUS } from "@/lib/a11y";

export default function ReadyToCall() {
  const { toast } = useToast();
  const [idx, setIdx] = useState(0);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [cbDate, setCbDate] = useState("");
  const [cbTime, setCbTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<"phone" | "address" | null>(null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const clientIdRef = useRef<string>("");

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const query = useQuery<QueueResponse>({
    queryKey: ["/api/ready-to-call/queue"],
    queryFn: () => apiRequest("GET", "/api/ready-to-call/queue").then(r => r.json()),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const queue = query.data?.queue ?? [];
  const meId = query.data?.meId ?? null;
  const current: QueueLead | undefined = queue[idx];
  const lockedByOther = !!current?.lockedByUserId && current.lockedByUserId !== meId;

  // Fresh idempotency key per lead we land on (survives retries of THIS save).
  useEffect(() => {
    if (current) clientIdRef.current = `rtc-${current.id}-${Math.random().toString(36).slice(2)}-${performance.now().toFixed(0)}`;
    setOutcome(null); setNotes(""); setCbDate(""); setCbTime("");
  }, [current?.id]);

  // Claim the current card + heartbeat; release on change/unmount.
  useEffect(() => {
    if (!current || lockedByOther) return;
    let alive = true;
    const leadId = current.id;
    apiRequest("POST", `/api/ready-to-call/${leadId}/claim`, {}).catch(() => {});
    const hb = setInterval(() => { if (alive) apiRequest("POST", `/api/ready-to-call/${leadId}/heartbeat`, {}).catch(() => {}); }, 60_000);
    return () => {
      alive = false; clearInterval(hb);
      apiRequest("POST", `/api/ready-to-call/${leadId}/release`, {}).catch(() => {});
    };
  }, [current?.id, lockedByOther]);

  const go = useCallback((delta: number) => setIdx(i => Math.max(0, Math.min(queue.length - 1, i + delta))), [queue.length]);

  const copy = useCallback(async (kind: "phone" | "address", text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(kind); setTimeout(() => setCopied(null), 1400); }
    catch { toast({ title: "Couldn't copy", variant: "destructive" }); }
  }, [toast]);

  const meta = outcome ? callOutcomeMeta(outcome) : null;
  const needsCallback = !!meta?.requiresCallback;
  const canSave = !!outcome && !saving && (!needsCallback || (cbDate && cbTime));

  const save = useCallback(async () => {
    if (!current || !outcome || saving) return;
    if (needsCallback && !(cbDate && cbTime)) { toast({ title: "Pick a callback date and time.", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const res = await apiRequest("POST", `/api/ready-to-call/${current.id}/outcome`, {
        outcome, notes: notes.trim() || null,
        callbackDate: needsCallback ? cbDate : null, callbackTime: needsCallback ? cbTime : null,
        dialedE164: dialPhone(current), clientId: clientIdRef.current,
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Could not save"); }
      toast({ title: `Saved: ${callOutcomeMeta(outcome)?.label}` });
      // Advance: drop the dispositioned lead and keep the same index (next lead
      // slides in). A terminal outcome removes it from the server queue on refetch.
      await query.refetch();
      setIdx(i => Math.min(i, Math.max(0, (query.data?.queue.length ?? 1) - 2)));
    } catch (e: any) {
      // Preserve the rep's entered notes/outcome — nothing is discarded on failure.
      toast({ title: e?.message || "Couldn't save — your notes are kept. Try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }, [current, outcome, notes, cbDate, cbTime, needsCallback, saving, query, toast]);

  // ── States ────────────────────────────────────────────────────────────────
  if (query.isLoading) return <Shell><CardSkeleton /></Shell>;

  if (query.isError) return (
    <Shell><Centered icon={<PhoneOff className="w-8 h-8 text-amber-400" />} title="Couldn't load your call list"
      body="Check your connection and try again." action={<RetryBtn onClick={() => query.refetch()} />} /></Shell>
  );

  if (query.data?.noTenant) return (
    <Shell><Centered icon={<User className="w-8 h-8 text-muted-foreground/50" />} title="No organization on your account"
      body="Ask your manager to finish setting up your login." /></Shell>
  );

  if (queue.length === 0) return (
    <Shell><Centered icon={<Phone className="w-8 h-8 text-muted-foreground/50" />} title="No one to call yet"
      body="Leads with a phone number will show up here. Import or add phone numbers to your leads to start a call session." /></Shell>
  );

  if (!current) return (
    <Shell><Centered icon={<Check className="w-8 h-8 text-emerald-400" />} title="You're all caught up"
      body="Every callable lead has been dispositioned. Nice work." action={<button onClick={() => { setIdx(0); query.refetch(); }} className={`h-11 px-5 rounded-xl bg-primary text-primary-foreground font-semibold ${FOCUS}`}>Refresh list</button>} /></Shell>
  );

  const name = displayName(current);
  const e164 = dialPhone(current);
  const fullAddress = `${current.address}, ${current.city}, ${current.state} ${current.zip}`;

  return (
    <Shell>
      {!online && (
        <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300 [.light_&]:text-amber-700">
          <WifiOff className="w-4 h-4" aria-hidden="true" /> You're offline — calls still work; saving an outcome will wait for a connection.
        </div>
      )}

      {/* Progress + prev/next */}
      <div className="mb-3 flex items-center justify-between">
        <button onClick={() => go(-1)} disabled={idx === 0} aria-label="Previous lead"
          className={`grid h-11 w-11 place-items-center rounded-xl border border-border bg-secondary text-foreground disabled:opacity-40 active:scale-95 transition-transform ${FOCUS}`}>
          <ChevronLeft className="w-5 h-5" />
        </button>
        <span className="text-xs font-semibold tabular-nums text-muted-foreground" aria-live="polite">{idx + 1} of {queue.length}</span>
        <button onClick={() => go(1)} disabled={idx >= queue.length - 1} aria-label="Next lead"
          className={`grid h-11 w-11 place-items-center rounded-xl border border-border bg-secondary text-foreground disabled:opacity-40 active:scale-95 transition-transform ${FOCUS}`}>
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {lockedByOther && (
        <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300 [.light_&]:text-rose-700">
          <PhoneCall className="w-4 h-4" aria-hidden="true" /> {current.lockedByName || "Another rep"} is calling this lead now — skip to the next one.
        </div>
      )}

      {/* Contact card */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden" data-testid="call-card">
        <div className="px-5 pt-6 pb-5 text-center">
          <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-primary text-xl font-bold">
            {isResident(current) ? <User className="w-7 h-7" aria-hidden="true" /> : name.slice(0, 1).toUpperCase()}
          </div>
          <h1 className="text-xl font-bold tracking-tight text-foreground" data-testid="call-name">{name}</h1>
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
            <PhoneCall className="w-3 h-3" aria-hidden="true" /> Kinetic Fiber
          </span>

          {/* Phone — the hero, tappable */}
          {e164 ? (
            <a href={`tel:${e164}`} className="mt-4 block text-2xl font-bold tabular-nums text-primary tracking-tight" data-testid="call-number">{formatDialDisplay(e164)}</a>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No usable phone number</p>
          )}
          <div className="mt-2 flex items-start justify-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span data-testid="call-address">{fullAddress}</span>
          </div>
        </div>

        {/* Call — the big one-tap action */}
        <div className="px-5 pb-4">
          <a href={e164 ? `tel:${e164}` : undefined} aria-disabled={!e164} data-testid="call-button"
            className={`flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-bold shadow-lg transition-transform active:scale-[0.98] ${e164 ? "bg-emerald-500 text-white shadow-emerald-500/25" : "pointer-events-none bg-secondary text-muted-foreground"} ${FOCUS}`}>
            <Phone className="w-5 h-5" aria-hidden="true" /> Call
          </a>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={() => e164 && copy("phone", e164)} disabled={!e164} data-testid="copy-number"
              className={`inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary text-sm font-semibold text-foreground disabled:opacity-40 active:scale-95 transition-transform ${FOCUS}`}>
              {copied === "phone" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />} {copied === "phone" ? "Copied" : "Copy Number"}
            </button>
            <button onClick={() => copy("address", fullAddress)} data-testid="copy-address"
              className={`inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary text-sm font-semibold text-foreground active:scale-95 transition-transform ${FOCUS}`}>
              {copied === "address" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />} {copied === "address" ? "Copied" : "Copy Address"}
            </button>
          </div>
        </div>

        {/* Script */}
        <div className="mx-5 mb-5 rounded-xl border border-border bg-secondary/40 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" /> Suggested opener
          </p>
          <p className="text-[13px] leading-relaxed text-foreground">{buildScript(current)}</p>
        </div>
      </div>

      {/* Outcome */}
      <div className="mt-4 rounded-2xl border border-border bg-card p-4">
        <p className="mb-2 text-sm font-semibold text-foreground">Call outcome</p>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Call outcome">
          {CALL_OUTCOMES.map(o => {
            const active = outcome === o.code;
            return (
              <button key={o.code} onClick={() => setOutcome(o.code)} data-testid={`outcome-${o.code}`}
                aria-pressed={active}
                className={`h-11 rounded-xl border text-sm font-semibold transition-colors ${active ? TONE_ACTIVE[o.tone] : TONE[o.tone]} ${FOCUS}`}>
                {o.label}
              </button>
            );
          })}
        </div>

        {needsCallback && (
          <div className="mt-3 grid grid-cols-2 gap-2" data-testid="callback-fields">
            <label className="text-xs font-medium text-muted-foreground">Callback date
              <input type="date" value={cbDate} onChange={e => setCbDate(e.target.value)} className={`mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground ${FOCUS}`} />
            </label>
            <label className="text-xs font-medium text-muted-foreground">Time
              <input type="time" value={cbTime} onChange={e => setCbTime(e.target.value)} className={`mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground ${FOCUS}`} />
            </label>
          </div>
        )}

        <label className="mt-3 block text-xs font-medium text-muted-foreground">Notes
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="What did they say?"
            className={`mt-1 w-full resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 ${FOCUS}`} />
        </label>

        <button onClick={save} disabled={!canSave} data-testid="save-outcome"
          className={`mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-40 active:scale-[0.98] transition-transform ${FOCUS}`}>
          {saving ? <><Loader2 className="w-5 h-5 animate-spin" /> Saving…</> : <>Save &amp; next lead <ChevronRight className="w-5 h-5" /></>}
        </button>
      </div>
    </Shell>
  );
}

// ── Layout + shared state pieces ─────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md px-4 pb-28 pt-4">
      <h2 className="mb-3 text-lg font-bold tracking-tight text-foreground">Ready to Call</h2>
      {children}
    </div>
  );
}
function Centered({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <div className="max-w-xs text-center">
        <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-secondary">{icon}</div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
function RetryBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className={`h-11 px-5 rounded-xl border border-border bg-secondary font-semibold text-foreground active:scale-95 transition-transform ${FOCUS}`}>Retry</button>;
}
function CardSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <Skeleton className="mx-auto h-16 w-16 rounded-full bg-secondary" />
      <Skeleton className="mx-auto mt-3 h-6 w-40 bg-secondary" />
      <Skeleton className="mx-auto mt-4 h-8 w-48 bg-secondary" />
      <Skeleton className="mt-6 h-14 w-full rounded-2xl bg-secondary" />
    </div>
  );
}
