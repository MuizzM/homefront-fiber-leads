// ── Contact — who lives at this door ─────────────────────────────────────────
// The resident gave the rep their name (maybe an email) at the door; this
// records it on the lead through PATCH /api/leads/:id/contact — the same trust
// tier, gate, and card-refresh contract as a field note. Deliberately NO phone
// field: numbers enter through the Calling compliance module or nowhere, and
// the server refuses them here (CALLING_MODULE_REQUIRED).
//
// View state renders the captured identity as plain lines; Edit swaps them for
// two inputs. Traced/GIS names stay in their own lane (ownerName) — this
// section is only the rep-captured truth, which the card's "Ask for" line
// prefers once it exists.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { MUTED } from "./utils";
import { INSET, INSET_ROW, SECTION_LABEL } from "./DetailsBody";

export interface ContactSectionProps {
  leadId: number;
  contactName?: string | null;
  contactEmail?: string | null;
  /** Detail fetch settled — before that, show nothing rather than a wrong
   *  "Add contact" affordance that flickers into values. */
  ready: boolean;
}

const inputCls =
  "w-full h-11 rounded-xl bg-white/[0.05] border border-white/[0.08] px-3 text-[16px] text-white placeholder:text-white/25 focus:outline-none focus:border-primary/60";

export function ContactSection({ leadId, contactName, contactEmail, ready }: ContactSectionProps): JSX.Element | null {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // Card swap: drop any half-typed edit — it belonged to the previous door.
  useEffect(() => { setEditing(false); }, [leadId]);

  const save = useMutation({
    mutationFn: (body: { contactName: string | null; contactEmail: string | null }) =>
      apiRequest("PATCH", `/api/leads/${leadId}/contact`, body).then(r => r.json()),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
    },
    onError: (e: any) => {
      toast({
        title: "Contact wasn't saved",
        description: String(e?.message ?? "Check the values and try again.").slice(0, 140),
        variant: "destructive",
      });
    },
  });

  if (!ready) return null;

  const hasAny = Boolean(contactName?.trim() || contactEmail?.trim());
  const beginEdit = () => {
    setName(contactName ?? "");
    setEmail(contactEmail ?? "");
    setEditing(true);
  };
  const commit = () => {
    if (save.isPending) return;
    save.mutate({ contactName: name.trim() || null, contactEmail: email.trim() || null });
  };

  return (
    <div data-testid="knock-contact-section" className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <span className={SECTION_LABEL} style={{ color: MUTED }}>
          Contact
        </span>
        {!editing && hasAny && (
          <button
            type="button"
            data-testid="contact-edit"
            onClick={beginEdit}
            className="min-h-tap text-[12px] font-semibold text-sky-300 hover:text-sky-200 transition px-1 -mr-1 -my-2"
          >
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        hasAny ? (
          <div className={INSET} data-testid="contact-view">
            {contactName?.trim() && (
              <div className={INSET_ROW}>
                <span className={`${SECTION_LABEL} w-[84px] shrink-0`} style={{ color: MUTED }}>Name</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-white" data-testid="contact-name-line">{contactName}</span>
              </div>
            )}
            {contactEmail?.trim() && (
              <div className={`${INSET_ROW} ${contactName?.trim() ? "border-t border-white/[0.07]" : ""}`}>
                <span className={`${SECTION_LABEL} w-[84px] shrink-0`} style={{ color: MUTED }}>Email</span>
                <a
                  href={`mailto:${contactEmail}`}
                  data-testid="contact-email-line"
                  className="min-w-0 flex-1 truncate text-[13.5px] text-white hover:underline"
                >
                  {contactEmail}
                </a>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            data-testid="contact-add"
            onClick={beginEdit}
            className="w-full h-11 px-3 rounded-xl bg-white/[0.05] border border-white/[0.10] text-[13px] font-semibold text-white/90 inline-flex items-center justify-center active:scale-[0.97] transition"
          >
            Add contact
          </button>
        )
      ) : (
        <div data-testid="contact-editor" className="space-y-2">
          <label className="block">
            <span className="block text-[11px] font-medium mb-1" style={{ color: MUTED }}>Name</span>
            <input
              type="text"
              data-testid="contact-name-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Who answers this door"
              maxLength={120}
              autoComplete="off"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium mb-1" style={{ color: MUTED }}>
              Email <span className="normal-case font-normal text-white/35">(optional)</span>
            </span>
            <input
              type="email"
              data-testid="contact-email-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com"
              maxLength={254}
              autoComplete="off"
              inputMode="email"
              className={inputCls}
            />
          </label>
          <p className="text-[11.5px] leading-snug" style={{ color: MUTED }}>
            Phone numbers are added through Calling, where consent and DNC rules apply.
          </p>
          <div className="flex items-center justify-end gap-2 pt-0.5">
            <button
              type="button"
              data-testid="contact-cancel"
              onClick={() => setEditing(false)}
              className="h-11 px-3.5 rounded-xl text-[13px] font-semibold text-white/60 hover:text-white/85 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="contact-save"
              disabled={save.isPending}
              aria-busy={save.isPending}
              onClick={commit}
              className="h-11 px-4 rounded-xl bg-primary text-primary-foreground text-[13px] font-semibold active:scale-95 transition disabled:opacity-45 disabled:cursor-not-allowed"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ContactSection;
