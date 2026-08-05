// ── Messages — the one place that writes to every phone in the org ──────────
//
// This used to be the third block down on the Spiffs page, under a heading that
// said "Tell the floor" and next to two things about bonus money. Nobody found
// it, which is its own kind of bug: a manager who cannot find the broadcast
// surface texts the team instead, and then the app is no longer where the floor
// looks for what changed.
//
// So it is a destination now, and it carries the half that was missing.
// Composing was never the hard part — REMEMBERING WHAT YOU ALREADY SENT is. A
// manager with no sent log cannot answer "did I already post the double-spiff
// thing?", so they post it again, and a feed that repeats itself is a feed the
// floor stops reading. The log below is what keeps that from happening, and the
// read count is what tells them whether any of it landed.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { can, type Role as AppRole } from "@shared/capabilities";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { Skeleton } from "@/components/ui/skeleton";
import { AnnouncementComposer } from "@/components/AnnouncementComposer";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BadgeDollarSign, Loader2, Megaphone, MessagesSquare, Trash2 } from "lucide-react";
import { agoLabel, usd, type AnnouncementKind } from "@shared/teamFeed";

interface SentItem {
  id: number;
  kind: AnnouncementKind;
  headline: string;
  body: string;
  amountCents?: number;
  actorName: string;
  createdAtMs: number;
  readCount: number;
  audience: number;
}

const SENT_KEY = ["/api/announcements/sent"];

export default function Messages() {
  const { user } = useAuth();
  // Same capability the server enforces on POST, not a role check — a team lead
  // holds this permission, and a role list here would hide the page from people
  // the API would happily let post.
  const canPost = can(user?.role as AppRole | undefined, "commission.structure.manage");

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 pt-5 pb-24 md:p-6">
      <PageHeader
        title="Messages"
        icon={MessagesSquare}
        subtitle="Promos and updates that go to the whole floor. A promo buzzes every phone; an update waits in the feed."
      />
      {canPost
        ? <><AnnouncementComposer /><SentLog /></>
        // Reachable if the nav and the capability ever drift apart. Says which
        // way to look rather than just refusing.
        : <p className="rounded-2xl border border-border bg-card p-4 text-[13px] text-muted-foreground" data-testid="messages-no-access">
            Only team leads and managers can post to the floor. Messages sent to you show up
            under the bell on your home screen.
          </p>}
    </div>
  );
}

/** Everything this org has broadcast, newest first, with what it reached. */
function SentLog() {
  const { data, isLoading } = useQuery<{ items: SentItem[] }>({ queryKey: SENT_KEY });
  // One clock for the list so every row's "2m" ages together instead of
  // freezing at whatever it was when the page mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const items = data?.items ?? [];

  return (
    <section className="space-y-3" data-testid="sent-log">
      <SectionLabel>Already sent</SectionLabel>

      {isLoading && <Skeleton className="h-24 w-full rounded-2xl" data-testid="sent-log-loading" />}

      {!isLoading && !items.length && (
        <p className="rounded-2xl border border-border bg-card p-4 text-center text-[13px] text-muted-foreground" data-testid="sent-log-empty">
          Nothing sent yet. What you post above shows up here, with how many people read it.
        </p>
      )}

      <ul className="space-y-2">
        {items.map(item => <SentRow key={item.id} item={item} now={now} />)}
      </ul>
    </section>
  );
}

function SentRow({ item, now }: { item: SentItem; now: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const isPromo = item.kind === "promo";
  const Icon = isPromo ? BadgeDollarSign : Megaphone;

  const remove = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/announcements/${item.id}`)).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SENT_KEY });
      qc.invalidateQueries({ queryKey: ["/api/announcements"] });
      toast({
        title: "Post retracted",
        description: isPromo
          // Stated plainly, because the alternative is a manager believing a
          // notification was unsent and not following up with the floor.
          ? "It's off the feed. Phones that already buzzed can't be unbuzzed."
          : "It's off the feed.",
      });
    },
    onError: (e: any) => toast({
      title: "Couldn't retract it", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  return (
    <li
      className="flex items-start gap-3 rounded-2xl border border-border bg-card p-3"
      data-testid={`sent-item-${item.id}`}
    >
      <div className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
        isPromo
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-secondary text-muted-foreground",
      )}>
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-foreground">{item.headline}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{item.body}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/70">{isPromo ? "Promo" : "Update"}</span>
          <span aria-hidden="true">·</span>
          <span>{item.actorName}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{agoLabel(item.createdAtMs, now)}</span>
          {item.amountCents != null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{usd(item.amountCents)}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <ReadCount read={item.readCount} audience={item.audience} />
        </p>
      </div>

      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={remove.isPending}
        aria-label={`Retract "${item.headline}"`}
        data-testid={`sent-delete-${item.id}`}
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
          FOCUS,
        )}
      >
        {remove.isPending
          ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <Trash2 className="h-4 w-4" aria-hidden="true" />}
      </button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="sent-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Retract this post?</AlertDialogTitle>
            <AlertDialogDescription>
              “{item.headline}” comes off the feed for everyone who hasn't opened it yet.
              {isPromo && " The phones it already buzzed can't be unbuzzed — if it needs correcting, post the correction."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Retract
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** "8 of 14 read".
 *
 *  Read, not delivered. A delivery number counts phones we managed to reach,
 *  which reads as attention and is not — and a manager deciding whether to say
 *  something a second time needs to know how many people actually looked. */
function ReadCount({ read, audience }: { read: number; audience: number }) {
  if (audience <= 0) return <span data-testid="sent-read-count">no one to reach yet</span>;
  return (
    <span className="tabular-nums" data-testid="sent-read-count">
      {read} of {audience} read
    </span>
  );
}
