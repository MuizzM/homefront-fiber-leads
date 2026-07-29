// The install appointment, and the one tap that texts the customer about it.
//
// The rep just closed a sale on a doorstep. They need to confirm the install
// window with the customer while they are still standing there — and the text
// has to come from THEIR phone, because a message from the number the customer
// just spoke to gets read and gets a reply. An automated shortcode does not.
//
// So this opens the rep's native Messages app with the whole text pre-written.
// The app never sends anything: no provider, no credentials, no campaign
// registration, and the rep always sees the message before it goes.
//
// Patterns adapted from shipped products (Mobbin):
//
//   * Square Go — Message sits BESIDE Call as a peer circular action directly
//     under the appointment, not buried in a menu. A rep needs both, often in
//     the same minute.
//   * Superpower — the time carries its ZONE. An install window without one is
//     a support call waiting to happen the moment a rep and customer differ.
//   * Fresha — a status pill above the date, and every action carries a short
//     description so it is not a bare verb.
//   * X — the share action appears immediately at creation ("now tell people"),
//     which is exactly this moment: sold, scheduled, tell the customer.
//
// The send control is an <a href="sms:…">, not a button with a handler. A real
// anchor is what lets the OS hand off to Messages; window.open on an sms: URL
// is blocked or silently ignored in several mobile browsers.

import { CalendarDays, Clock, MapPin, MessageSquare, Phone } from "lucide-react";
import {
  buildAppointmentMessage,
  buildSmsLink,
  detectSmsPlatform,
  normalizePhoneForSms,
  type SmsPlatform,
} from "@shared/smsDeepLink";

export type InstallStatus =
  | "scheduled" | "confirmed" | "rescheduled" | "completed"
  | "activated" | "canceled" | "failed" | "chargeback_risk";

const STATUS_STYLE: Record<InstallStatus, { label: string; className: string }> = {
  scheduled:       { label: "Scheduled",       className: "bg-blue-500/15 text-blue-400" },
  confirmed:       { label: "Confirmed",       className: "bg-emerald-500/15 text-emerald-400" },
  rescheduled:     { label: "Rescheduled",     className: "bg-amber-500/15 text-amber-400" },
  completed:       { label: "Completed",       className: "bg-slate-500/15 text-slate-300" },
  activated:       { label: "Activated",       className: "bg-emerald-500/15 text-emerald-400" },
  canceled:        { label: "Canceled",        className: "bg-zinc-500/15 text-zinc-400" },
  failed:          { label: "Failed",          className: "bg-red-500/15 text-red-400" },
  chargeback_risk: { label: "Chargeback risk", className: "bg-red-500/15 text-red-400" },
};

export interface InstallAppointmentCardProps {
  status: InstallStatus;
  customerName: string;
  customerPhone: string;
  /** Human-formatted — "Tue, Aug 4". Never an ISO string. */
  dateLabel: string;
  /** The WINDOW — "8:00–10:00 AM". An installer inside a window is not late. */
  timeWindowLabel: string;
  timezoneLabel?: string;
  serviceAddress?: string;
  repName: string;
  companyName: string;
  /**
   * The referral reward exactly as the customer should read it — "$100 gift
   * card". Omitted means no referral ask at all: a tenant not running the offer
   * must never send a text promising one.
   */
  referralRewardLabel?: string;
  /** Injectable for tests and SSR; falls back to the real navigator. */
  platform?: SmsPlatform;
  onTextOpened?: () => void;
}

/** "Dana Whitfield" → "Dana". The text greets a person, not a record. */
function firstName(full: string): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

export function InstallAppointmentCard({
  status,
  customerName,
  customerPhone,
  dateLabel,
  timeWindowLabel,
  timezoneLabel,
  serviceAddress,
  repName,
  companyName,
  referralRewardLabel,
  platform,
  onTextOpened,
}: InstallAppointmentCardProps) {
  const resolvedPlatform: SmsPlatform =
    platform ??
    (typeof navigator === "undefined"
      ? "other"
      : detectSmsPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0));

  const message = buildAppointmentMessage({
    customerFirstName: firstName(customerName),
    repName, companyName, dateLabel, timeWindowLabel, timezoneLabel, referralRewardLabel,
  });

  const link = message.ok
    ? buildSmsLink({ phone: customerPhone, body: message.body, platform: resolvedPlatform })
    : ({ ok: false, reason: "empty-body" } as const);

  const tel = normalizePhoneForSms(customerPhone);
  const badge = STATUS_STYLE[status] ?? STATUS_STYLE.scheduled;

  // Why the text cannot be sent, in the rep's words. A disabled control with no
  // reason is the dead-Reclaim-button failure this codebase already shipped once.
  const blockedReason = !message.ok
    ? `Missing ${(message as any).missing.join(", ")} — fill in the sale details first`
    : !link.ok
      ? (link as any).reason === "bad-phone"
        ? "No valid mobile number on this sale"
        : "Nothing to send yet"
      : null;

  return (
    <div data-testid="install-card" className="rounded-2xl border border-border bg-card p-4">
      <span
        data-testid="install-status"
        className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${badge.className}`}
      >
        {badge.label}
      </span>

      <h3 className="mt-2 truncate text-base font-bold text-foreground">{customerName}</h3>

      <dl className="mt-3 space-y-2 text-[13px]">
        <div className="flex items-center gap-2 text-foreground">
          <CalendarDays className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <dd data-testid="install-date">{dateLabel}</dd>
        </div>
        <div className="flex items-center gap-2 text-foreground">
          <Clock className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          {/* The zone rides with the time, never on its own line — a window and
              its zone read as one fact or they get separated in a screenshot. */}
          <dd data-testid="install-window">
            {timeWindowLabel}
            {timezoneLabel ? ` ${timezoneLabel}` : ""}
          </dd>
        </div>
        {serviceAddress && (
          <div className="flex items-start gap-2 text-muted-foreground">
            <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <dd data-testid="install-address">{serviceAddress}</dd>
          </div>
        )}
      </dl>

      <div className="mt-4 flex items-stretch gap-2">
        {/* An <a>, not a button: the OS hand-off to Messages needs a real
            navigation. window.open on an sms: URL is blocked or ignored in
            several mobile browsers. h-11 is the 44px touch floor. */}
        {link.ok ? (
          <a
            href={link.href}
            data-testid="install-send-text"
            onClick={onTextOpened}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-teal-500 px-4 text-[13px] font-bold text-[#04241f] transition-colors hover:bg-teal-600"
          >
            <MessageSquare className="h-4 w-4" />
            Text customer
          </a>
        ) : (
          <span
            data-testid="install-send-blocked"
            role="note"
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-secondary px-4 text-[12px] font-semibold text-muted-foreground"
          >
            <MessageSquare className="h-4 w-4" />
            Can't text yet
          </span>
        )}

        {tel && (
          <a
            href={`tel:${tel}`}
            aria-label={`Call ${customerName}`}
            data-testid="install-call"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-border text-foreground transition-colors hover:bg-secondary"
          >
            <Phone className="h-4 w-4" />
          </a>
        )}
      </div>

      {blockedReason && (
        <p data-testid="install-send-reason" className="mt-2 text-[11px] text-amber-500">
          {blockedReason}
        </p>
      )}

      {link.ok && (
        <>
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Opens your Messages app with the text ready — you send it from your own
            number, and you'll see it first.
          </p>
          {referralRewardLabel?.trim() && (
            <p data-testid="install-referral-note" className="mt-1 text-[11px] font-medium text-teal-500">
              Includes the {referralRewardLabel.trim()} referral ask.
            </p>
          )}
          {/* A long text still sends, but it arrives split. Worth saying once,
              quietly, rather than letting a rep wonder why it looked odd. */}
          {message.ok && message.segments.segments > 2 && (
            <p data-testid="install-segment-warning" className="mt-1 text-[11px] text-amber-500">
              Long text - sends as {message.segments.segments} parts
              {message.segments.offenders.length > 0
                ? ` (${message.segments.offenders.join(" ")} shortens each part)`
                : ""}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
