// ── Post a promo or an update to the whole floor ────────────────────────────
//
// The only place in the app where one person's words reach every phone in the
// org, so the form is built around the two things that decide whether that is
// worth doing:
//
//   1. A LIVE PREVIEW of the phone notification, because the author is writing
//      a lock-screen line, not a paragraph. Seeing it truncate is the only
//      reliable way to learn that 80 characters is the budget.
//   2. An honest statement of REACH — "goes to 14 phones now" — so posting is
//      a decision rather than a reflex.
//
// Promo vs update is not a category, it is a DELIVERY choice, and the form says
// so: a promo buzzes phones, an update only lands in the feed. Getting that
// wrong is how a team learns to swipe notifications away without reading them.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, BadgeDollarSign, Loader2, Megaphone, Send } from "lucide-react";
import {
  validateAuthoredAnnouncement, ANNOUNCEMENT_TITLE_MAX, ANNOUNCEMENT_BODY_MAX,
  type AuthoredKind,
} from "@shared/teamFeed";

export function AnnouncementComposer({ className }: { className?: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<AuthoredKind>("promo");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [amount, setAmount] = useState("");

  const payload = {
    kind, title, body,
    amountCents: kind === "promo" && amount.trim() ? Math.round(Number(amount) * 100) : undefined,
  };
  const problem = validateAuthoredAnnouncement(payload);

  const post = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/announcements", payload)).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/announcements"] });
      // The sent log sits directly under this form — it must not still be
      // showing "nothing sent yet" a moment after the toast says it went.
      qc.invalidateQueries({ queryKey: ["/api/announcements/sent"] });
      toast({
        title: kind === "promo" ? "Promo sent" : "Update posted",
        description: kind === "promo"
          ? "It's on the feed and on their phones."
          : "It's on the feed. No phones were buzzed.",
      });
      setTitle(""); setBody(""); setAmount("");
    },
    onError: (e: any) => toast({
      title: "Couldn't post it", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  const KINDS: Array<{ id: AuthoredKind; label: string; hint: string; icon: typeof Megaphone }> = [
    { id: "promo", label: "Promo", hint: "Buzzes every phone", icon: BadgeDollarSign },
    { id: "update", label: "Update", hint: "Feed only - no buzz", icon: Megaphone },
  ];

  return (
    <section className={cn("space-y-3", className)} data-testid="announcement-composer">
      <SectionLabel className="flex items-center gap-1.5">
        <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
        Tell the floor
      </SectionLabel>

      {/* Delivery, not category — so the choice is made knowingly. */}
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Announcement type">
        {KINDS.map(k => {
          const Icon = k.icon;
          const on = kind === k.id;
          return (
            <button
              key={k.id} type="button" role="radio" aria-checked={on}
              onClick={() => setKind(k.id)}
              data-testid={`announcement-kind-${k.id}`}
              className={cn(
                "flex min-h-[56px] flex-col items-start justify-center rounded-xl border px-3 text-left transition-colors",
                on ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-secondary/50",
                FOCUS,
              )}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />{k.label}
              </span>
              <span className="text-[11px] text-muted-foreground">{k.hint}</span>
            </button>
          );
        })}
      </div>

      <div>
        <Label htmlFor="announcement-title">Headline</Label>
        <Input
          id="announcement-title" value={title} maxLength={ANNOUNCEMENT_TITLE_MAX + 20}
          data-testid="announcement-title"
          placeholder={kind === "promo" ? "Double bonuses tonight" : "New: door drops are live"}
          onChange={e => setTitle(e.target.value)}
        />
        <CharCount value={title.length} max={ANNOUNCEMENT_TITLE_MAX} />
      </div>

      <div>
        <Label htmlFor="announcement-body">What it means for them</Label>
        <Textarea
          id="announcement-body" value={body} rows={2}
          maxLength={ANNOUNCEMENT_BODY_MAX + 40}
          data-testid="announcement-body"
          placeholder={kind === "promo" ? "Every close after 5 PM pays twice." : "Any verified door can now drop a $5–$25 bonus."}
          onChange={e => setBody(e.target.value)}
        />
        <CharCount value={body.length} max={ANNOUNCEMENT_BODY_MAX} />
      </div>

      {kind === "promo" && (
        <div className="w-40">
          <Label htmlFor="announcement-amount">Amount (optional)</Label>
          <Input
            id="announcement-amount" inputMode="decimal" value={amount}
            data-testid="announcement-amount" placeholder="50"
            onChange={e => setAmount(e.target.value)}
          />
          {/* Said plainly, because the alternative is a manager assuming this
              creates a bonus and reps assuming they've been paid one. */}
          <p className="mt-1 text-[12px] text-muted-foreground">
            Shown on the card. It does not pay anything on its own - set up the incentive below.
          </p>
        </div>
      )}

      {/* The lock screen, as it will actually look. */}
      <div className="rounded-2xl border border-border bg-secondary/40 p-3" data-testid="announcement-preview">
        <SectionLabel className="mb-1.5">On their phone</SectionLabel>
        <div className="rounded-xl border border-border bg-card p-2.5 shadow-sm">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="grid h-3.5 w-3.5 place-items-center rounded bg-primary text-[7px] font-black text-primary-foreground">HF</span>
            Homefront · now
          </div>
          <p className="mt-1 truncate text-[13px] font-bold text-foreground">
            {title.trim() || "Your headline"}
          </p>
          <p className="line-clamp-2 text-[12px] text-muted-foreground">
            {body.trim() || "What it means for them."}
          </p>
        </div>
        {kind === "update" && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            An update won't buzz anyone - it waits in the feed until they look.
          </p>
        )}
      </div>

      {problem && (
        <p className="flex items-start gap-1.5 text-[13px] font-medium text-destructive" data-testid="announcement-error">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {problem}
        </p>
      )}

      <button
        type="button" disabled={!!problem || post.isPending}
        onClick={() => post.mutate()}
        data-testid="announcement-send"
        className={cn(
          "inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50",
          FOCUS,
        )}
      >
        {post.isPending
          ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <Send className="h-4 w-4" aria-hidden="true" />}
        {kind === "promo" ? "Send to the floor" : "Post update"}
      </button>
    </section>
  );
}

/** Counts DOWN near the limit rather than always showing "12/80" - a counter
 *  that is always on trains people to ignore it. */
function CharCount({ value, max }: { value: number; max: number }) {
  const left = max - value;
  if (left > 20) return null;
  return (
    <p className={cn("mt-1 text-right text-[11px] tabular-nums", left < 0 ? "text-destructive" : "text-muted-foreground")}>
      {left < 0 ? `${-left} over` : `${left} left`}
    </p>
  );
}
