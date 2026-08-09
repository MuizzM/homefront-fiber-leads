// ── Tax & direct deposit — the rep-facing side of the pay plane ──────────────
//
// A contractor cannot be paid until two things exist: a signed IRS Form W-9
// (so the org can issue a 1099 and knows whether to withhold) and bank details
// (so the money has somewhere to land). Both endpoints have existed on the
// server for a while; this page is the only way a rep can actually complete
// them.
//
// Three rules this screen is built around:
//
//  1. THE W-9 IS SIGNED UNDER PENALTIES OF PERJURY. Every question is asked in
//     plain language, the actual Part II certification text is shown before the
//     rep affirms it, and the backup-withholding question is asked out loud
//     rather than assumed. A rep who does not understand "S corporation" must
//     still be able to answer correctly.
//  2. SECRETS ARE WRITE-ONLY. The TIN and the account number are masked while
//     typing, cleared from component state the instant the server accepts them,
//     and never reconstructed — after submission the screen renders only the
//     server's own masked view (`tinMasked`, `last4`).
//  3. THE SERVER IS AUTHORITATIVE. Client validation exists for fast feedback
//     and mirrors server/payValidation.ts exactly; every server 400 is surfaced
//     verbatim, including W9_NAME_NOT_PRINTABLE (which asks the rep for the
//     romanized spelling of their name).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Banknote, CheckCircle2, Download, Eye, EyeOff, FileText,
  Landmark, Loader2, Lock, ShieldCheck,
} from "lucide-react";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { PdfReviewer } from "@/components/PdfReviewer";
import { Button } from "@/components/ui/button";
import { PdfReviewPane } from "@/components/PdfReviewPane";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";

// ── Server contract (server/payValidation.ts + server/payRoutes.ts) ──────────

const TAX_CLASSIFICATIONS = [
  "individual", "c_corp", "s_corp", "partnership", "trust_estate", "llc", "other",
] as const;
type TaxClassification = (typeof TAX_CLASSIFICATIONS)[number];

const LLC_TAX_CLASSES = ["C", "S", "P"] as const;
type LlcTaxClass = (typeof LLC_TAX_CLASSES)[number];

interface W9Status {
  submitted: true;
  w9Id: number;
  legalName: string;
  businessName: string | null;
  tinType: string;
  /** The ONLY form of the TIN this client ever holds. */
  tinMasked: string;
  taxClassification: TaxClassification;
  llcTaxClass: LlcTaxClass | null;
  otherClassification: string | null;
  foreignPartners: boolean;
  exemptPayeeCode: string | null;
  fatcaExemptionCode: string | null;
  subjectToBackupWithholding: boolean;
  signatureName: string;
  signatureDate: string;
  createdAt: string;
}

interface BankStatus {
  last4: string;
  accountType: string;
  status: string;
  updatedAt?: string;
}

// Plain-language copy for Form W-9 Line 3a. Most reps have never had to pick a
// federal tax classification; the label alone ("S corporation") is useless
// without the sentence that tells them whether it is them.
const CLASSIFICATION_COPY: Record<TaxClassification, { label: string; blurb: string }> = {
  individual: {
    label: "Individual / sole proprietor, or single-member LLC",
    blurb: "You work for yourself and report this income on Schedule C of your personal tax return. This is the right answer for almost every rep - including a single-member LLC that has not elected corporate tax treatment.",
  },
  c_corp: {
    label: "C corporation",
    blurb: "Your business is incorporated and files its own return (Form 1120). Pay goes to the company, not to you personally.",
  },
  s_corp: {
    label: "S corporation",
    blurb: "Your business elected S-corporation status with the IRS and files Form 1120-S. You would have a signed IRS acceptance letter for it.",
  },
  partnership: {
    label: "Partnership",
    blurb: "Two or more owners share the business and it files Form 1065.",
  },
  trust_estate: {
    label: "Trust or estate",
    blurb: "You are signing on behalf of a trust or an estate, not for yourself.",
  },
  llc: {
    label: "Limited liability company (LLC)",
    blurb: "An LLC with more than one member, or one that elected corporate tax treatment. Pick this only if you then know how the IRS taxes it - you must give the letter C, S or P below.",
  },
  other: {
    label: "Something else",
    blurb: "Anything the options above do not cover. You will be asked to describe it in a few words.",
  },
};

const LLC_CLASS_COPY: Record<LlcTaxClass, string> = {
  C: "C - the LLC is taxed as a C corporation",
  S: "S - the LLC is taxed as an S corporation",
  P: "P - the LLC is taxed as a partnership",
};

// The certification the signer is affirming, verbatim from IRS Form W-9
// (Rev. 3-2024), Part II. Shown IN FULL — nobody should agree to text they
// cannot read. Item 2 is struck on the rendered PDF when the rep answers "Yes"
// to backup withholding (server/w9Pdf.ts does the striking), so it is struck
// here too and the screen matches the document that gets filed.
const CERTIFICATION_ITEMS = [
  "1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and",
  "2. I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and",
  "3. I am a U.S. citizen or other U.S. person (defined in the Form W-9 instructions); and",
  "4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.",
] as const;

const CERTIFICATION_INSTRUCTION =
  "Certification instructions. You must cross out item 2 above if you have been notified by the IRS that you are currently subject to backup withholding because you have failed to report all interest and dividends on your tax return.";

// ── Validation — mirrors server/payValidation.ts one-for-one ─────────────────

const isValidState = (s: string) => /^[A-Z]{2}$/.test(s);
const isValidZip = (s: string) => /^\d{5}(-\d{4})?$/.test(s);
const isValidTin = (t: string) => /^\d{9}$/.test(t) && !/^0{9}$/.test(t) && !/^9{9}$/.test(t);
const isValidAccountNumber = (a: string) => /^\d{4,17}$/.test(a);

/** ABA routing transit checksum (the same 3-7-1 weighting the server uses), run
 *  client-side so a typo is caught before the rep submits their pay details. */
export function isValidAbaRouting(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split("").map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

const digitsOnly = (v: string) => v.replace(/\D/g, "");

/** Strips apiRequest's "400: " status prefix so the rep reads the sentence the
 *  server wrote, not an HTTP code. */
function serverMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/^\d{3}:\s*/, "") || "Something went wrong. Please try again.";
}

const statusOf = (error: unknown): number | null => {
  const s = (error as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
};

/** GET that treats the server's "nothing on file yet" 404 as an empty state
 *  rather than an error — a rep who has not filed anything is the normal case. */
async function getOrNull<T>(url: string): Promise<T | null> {
  try {
    const response = await apiRequest("GET", url);
    return (await response.json()) as T;
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

// ── Small shared building blocks ─────────────────────────────────────────────

function Field({ id, label, hint, error, children, optional }: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: (aria: { id: string; "aria-describedby": string | undefined; "aria-invalid": boolean }) => React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[13px] font-semibold text-foreground">
        {label}
        {optional && <span className="ml-1.5 font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {hint && <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": !!error })}
      {error && (
        <p id={errorId} className="text-xs font-medium text-destructive" data-testid={`error-${id}`}>{error}</p>
      )}
    </div>
  );
}

/** A native radio in a card. Native on purpose: it is the control screen
 *  readers and keyboard users handle best, and it needs no JS to be correct. */
function RadioCard({ name, value, checked, onChange, title, blurb, testId }: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  title: string;
  blurb?: string;
  testId?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors",
        checked ? "border-primary bg-primary/[0.07]" : "border-border bg-secondary/20 hover:border-primary/40",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className={cn("mt-0.5 h-4 w-4 shrink-0 accent-primary", FOCUS)}
        data-testid={testId}
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        {blurb && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{blurb}</span>}
      </span>
    </label>
  );
}

function LegalCheckbox({ checked, onChange, children, testId }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-secondary/20 px-3.5 py-3 hover:border-primary/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className={cn("mt-0.5 h-5 w-5 shrink-0 rounded accent-primary", FOCUS)}
        data-testid={testId}
      />
      <span className="text-xs leading-relaxed text-foreground">{children}</span>
    </label>
  );
}

function CardSection({ title, description, icon: Icon, children, testId }: {
  title: string;
  description?: string;
  icon: typeof Landmark;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5" data-testid={testId} aria-label={title}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SummaryRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-right text-[13px] font-medium text-foreground", mono && "font-mono tabular-nums")}>{value}</dd>
    </div>
  );
}

// ── W-9 form ─────────────────────────────────────────────────────────────────

type W9Errors = Partial<Record<
  | "legalName" | "businessName" | "taxClassification" | "llcTaxClass" | "otherClassification"
  | "line1" | "city" | "state" | "zip" | "tin" | "backupWithholding" | "consent" | "signatureName"
  | "exemptPayeeCode" | "fatcaExemptionCode" | "accountNumbers",
  string
>>;

function W9Form({ onSubmitted, onCancel, showCancel }: {
  onSubmitted: (status: W9Status) => void;
  onCancel: () => void;
  showCancel: boolean;
}) {
  const { toast } = useToast();
  const [legalName, setLegalName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [taxClassification, setTaxClassification] = useState<TaxClassification | "">("");
  const [llcTaxClass, setLlcTaxClass] = useState<LlcTaxClass | "">("");
  const [otherClassification, setOtherClassification] = useState("");
  const [foreignPartners, setForeignPartners] = useState(false);
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [tinType, setTinType] = useState<"ssn" | "ein">("ssn");
  const [tin, setTin] = useState("");
  const [showTin, setShowTin] = useState(false);
  const [exemptPayeeCode, setExemptPayeeCode] = useState("");
  const [fatcaExemptionCode, setFatcaExemptionCode] = useState("");
  const [accountNumbers, setAccountNumbers] = useState("");
  // Deliberately UNANSWERED until the rep picks one. The server refuses to
  // infer it (payValidation.ts: silence used to mean "not subject", which every
  // signer certified whether it was true or not), so the form must not either.
  const [backupWithholding, setBackupWithholding] = useState<"no" | "yes" | "">("");
  const [consent, setConsent] = useState(false);
  const [signatureName, setSignatureName] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Collapsed by default: the official form is 6 pages, and a signer who wants
  // it should get it on demand rather than have it pushed in front of the fields.
  const [showOfficialW9, setShowOfficialW9] = useState(false);

  const errors = useMemo<W9Errors>(() => {
    const e: W9Errors = {};
    const name = legalName.trim();
    if (name.length < 2 || name.length > 120) e.legalName = "Enter your full legal name as it appears on your Social Security card or IRS notice (2–120 characters).";
    if (businessName.trim().length > 120) e.businessName = "Business name must be 120 characters or fewer.";
    if (!taxClassification) e.taxClassification = "Choose the one federal tax classification that describes you. This is required on the form.";
    if (taxClassification === "llc" && !llcTaxClass) e.llcTaxClass = "An LLC must say how the IRS taxes it - choose C, S or P.";
    if (taxClassification === "other") {
      const desc = otherClassification.trim();
      if (desc.length < 2 || desc.length > 60) e.otherClassification = "Describe your classification in 2–60 characters.";
    }
    if (line1.trim().length < 3 || line1.trim().length > 120) e.line1 = "Enter your street address (3–120 characters).";
    if (city.trim().length < 2 || city.trim().length > 60) e.city = "Enter your city (2–60 characters).";
    if (!isValidState(state.trim().toUpperCase())) e.state = "Use the 2-letter state code, for example NC.";
    if (!isValidZip(zip.trim())) e.zip = "Enter a 5-digit ZIP code (ZIP+4 also accepted).";
    if (!isValidTin(digitsOnly(tin))) {
      e.tin = tinType === "ssn"
        ? "Enter the 9 digits of your Social Security number."
        : "Enter the 9 digits of your Employer Identification Number.";
    }
    if (exemptPayeeCode.trim().length > 8) e.exemptPayeeCode = "Exempt payee code must be 8 characters or fewer.";
    if (fatcaExemptionCode.trim().length > 12) e.fatcaExemptionCode = "FATCA exemption code must be 12 characters or fewer.";
    if (accountNumbers.trim().length > 80) e.accountNumbers = "Account numbers must be 80 characters or fewer.";
    if (backupWithholding !== "no" && backupWithholding !== "yes") e.backupWithholding = "Answer the backup-withholding question - the IRS certification requires an explicit yes or no.";
    if (!consent) e.consent = "You must agree to the certification to sign this form electronically.";
    if (signatureName.trim().toLowerCase() !== name.toLowerCase() || !signatureName.trim()) {
      e.signatureName = "Type your legal name exactly as you entered it above - this is your signature.";
    }
    return e;
  }, [legalName, businessName, taxClassification, llcTaxClass, otherClassification, line1, city, state,
      zip, tin, tinType, exemptPayeeCode, fatcaExemptionCode, accountNumbers, backupWithholding, consent, signatureName]);

  const errorCount = Object.keys(errors).length;
  const show = (key: keyof W9Errors) => (submitted ? errors[key] : undefined);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        legalName: legalName.trim(),
        businessName: businessName.trim() || undefined,
        address: { line1: line1.trim(), city: city.trim(), state: state.trim().toUpperCase(), zip: zip.trim() },
        tin: digitsOnly(tin),
        tinType,
        taxClassification,
        foreignPartners,
        exemptPayeeCode: exemptPayeeCode.trim() || undefined,
        fatcaExemptionCode: fatcaExemptionCode.trim() || undefined,
        accountNumbers: accountNumbers.trim() || undefined,
        subjectToBackupWithholding: backupWithholding === "yes",
        consent: true,
        signatureName: signatureName.trim(),
      };
      // The server rejects a letter/description supplied for the wrong
      // classification, so send them only when they apply.
      if (taxClassification === "llc") body.llcTaxClass = llcTaxClass;
      if (taxClassification === "other") body.otherClassification = otherClassification.trim();
      const response = await apiRequest("POST", "/api/me/w9", body);
      return (await response.json()) as W9Status;
    },
    onSuccess: status => {
      // The full TIN leaves this client the moment the server has it. From here
      // on the screen renders only status.tinMasked.
      setTin("");
      setShowTin(false);
      setServerError(null);
      toast({ title: "W-9 filed", description: "Your tax form is on file. You can download your copy any time." });
      onSubmitted(status);
    },
    onError: error => setServerError(serverMessage(error)),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (errorCount > 0) return;
    mutation.mutate();
  };

  const item2Struck = backupWithholding === "yes";

  return (
    <form onSubmit={submit} noValidate className="space-y-6" data-testid="w9-form">
      {submitted && errorCount > 0 && (
        <Alert variant="destructive" data-testid="w9-validation-summary">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>This form is not finished</AlertTitle>
          <AlertDescription>
            {errorCount === 1 ? "One answer still needs your attention." : `${errorCount} answers still need your attention.`} They are marked below.
          </AlertDescription>
        </Alert>
      )}

      {serverError && (
        <Alert variant="destructive" role="alert" data-testid="w9-server-error">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Your W-9 was not filed</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* ── Read the real form first ─────────────────────────────────────────
           This page asks the W-9's questions in plain language, which is the
           right way to COLLECT them — but a form signed under penalties of
           perjury should never be the first and only version of itself a signer
           sees. This opens the actual IRS document, all six pages including the
           certification language and the instructions that explain it, before
           anyone types a TIN. ── */}
      <div className="rounded-xl border border-border bg-secondary/30 p-4" data-testid="w9-official-form">
        <div className="flex items-start gap-3 flex-wrap">
          <FileText className="w-4 h-4 text-primary mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">Read the official IRS Form W-9</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              The questions below are the same ones on the government form, asked in plain language.
              You are signing under penalties of perjury - open the real form and its instructions first.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setShowOfficialW9(v => !v)}
            aria-expanded={showOfficialW9}
            data-testid="w9-official-toggle"
          >
            {showOfficialW9 ? "Hide the form" : "Open the form"}
          </Button>
        </div>
        {showOfficialW9 && (
          <div className="mt-3 h-[60vh] min-h-[380px] rounded-lg border border-border overflow-hidden flex">
            <PdfReviewPane
              url="/api/onboarding/w9/blank.pdf"
              fileName="irs-form-w9.pdf"
              title="IRS Form W-9 (Rev. 3-2024) - official form and instructions"
              testId="w9-official-pane"
            />
          </div>
        )}
      </div>

      {/* ── Lines 1 & 2 ── */}
      <fieldset className="space-y-4">
        <legend className="sr-only">Your name</legend>
        <SectionLabel>Who is being paid</SectionLabel>
        <Field
          id="w9-legal-name"
          label="Full legal name"
          hint="Exactly as it appears on your Social Security card or IRS notice. Use the Latin (romanized) spelling - the IRS form is printed in a Latin-alphabet font."
          error={show("legalName")}
        >
          {aria => (
            <Input {...aria} value={legalName} onChange={e => setLegalName(e.target.value)} autoComplete="name" className="h-11" data-testid="input-legal-name" />
          )}
        </Field>
        <Field
          id="w9-business-name"
          label="Business or trade name"
          optional
          hint="Only if it is different from your legal name (a DBA, for example)."
          error={show("businessName")}
        >
          {aria => (
            <Input {...aria} value={businessName} onChange={e => setBusinessName(e.target.value)} autoComplete="organization" className="h-11" data-testid="input-business-name" />
          )}
        </Field>
      </fieldset>

      {/* ── Line 3a ── */}
      <fieldset className="space-y-3" aria-describedby={show("taxClassification") ? "w9-classification-error" : undefined}>
        <legend className="sr-only">Federal tax classification</legend>
        <div>
          <SectionLabel>Federal tax classification</SectionLabel>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Pick the one that is true of you. Guessing here makes you certify something false and sends you the wrong 1099 in January.
          </p>
        </div>
        <div className="space-y-2">
          {TAX_CLASSIFICATIONS.map(value => (
            <RadioCard
              key={value}
              name="w9-tax-classification"
              value={value}
              checked={taxClassification === value}
              onChange={v => setTaxClassification(v as TaxClassification)}
              title={CLASSIFICATION_COPY[value].label}
              blurb={CLASSIFICATION_COPY[value].blurb}
              testId={`classification-${value}`}
            />
          ))}
        </div>
        {show("taxClassification") && (
          <p id="w9-classification-error" className="text-xs font-medium text-destructive" data-testid="error-taxClassification">{errors.taxClassification}</p>
        )}

        {taxClassification === "llc" && (
          <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3.5" data-testid="llc-followup">
            <p className="text-[13px] font-semibold text-foreground">How is your LLC taxed? This is required.</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              The IRS form asks for a single letter. If you do not know, it is on the letter the IRS sent when your election was accepted. A single-member LLC that never made an election should go back and pick "Individual / sole proprietor" instead.
            </p>
            <div className="mt-3 space-y-2">
              {LLC_TAX_CLASSES.map(letter => (
                <RadioCard
                  key={letter}
                  name="w9-llc-tax-class"
                  value={letter}
                  checked={llcTaxClass === letter}
                  onChange={v => setLlcTaxClass(v as LlcTaxClass)}
                  title={LLC_CLASS_COPY[letter]}
                  testId={`llc-class-${letter}`}
                />
              ))}
            </div>
            {show("llcTaxClass") && <p className="mt-2 text-xs font-medium text-destructive" data-testid="error-llcTaxClass">{errors.llcTaxClass}</p>}
          </div>
        )}

        {taxClassification === "other" && (
          <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3.5" data-testid="other-followup">
            <Field
              id="w9-other-classification"
              label="Describe your classification. This is required."
              hint="A few words, 2–60 characters - this is printed on the form's 'Other' line."
              error={show("otherClassification")}
            >
              {aria => (
                <Input {...aria} value={otherClassification} onChange={e => setOtherClassification(e.target.value)} maxLength={60} className="h-11" data-testid="input-other-classification" />
              )}
            </Field>
          </div>
        )}
      </fieldset>

      {/* ── Line 3b ── */}
      <fieldset className="space-y-2">
        <legend className="sr-only">Foreign partners, owners or beneficiaries</legend>
        <SectionLabel>Line 3b</SectionLabel>
        <LegalCheckbox checked={foreignPartners} onChange={setForeignPartners} testId="checkbox-foreign-partners">
          My partnership, trust or estate has foreign partners, owners or beneficiaries and I am providing this form to a partnership, trust or estate that has a direct or indirect foreign partner, owner or beneficiary. Leave this unticked if you are an individual - it does not apply to you.
        </LegalCheckbox>
      </fieldset>

      {/* ── Lines 5 & 6 ── */}
      <fieldset className="space-y-4">
        <legend className="sr-only">Address</legend>
        <div>
          <SectionLabel>Address</SectionLabel>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Where the IRS should send your 1099 in January.</p>
        </div>
        <Field id="w9-line1" label="Street address" error={show("line1")}>
          {aria => <Input {...aria} value={line1} onChange={e => setLine1(e.target.value)} autoComplete="address-line1" className="h-11" data-testid="input-address-line1" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
          <Field id="w9-city" label="City" error={show("city")}>
            {aria => <Input {...aria} value={city} onChange={e => setCity(e.target.value)} autoComplete="address-level2" className="h-11" data-testid="input-city" />}
          </Field>
          <Field id="w9-state" label="State" error={show("state")}>
            {aria => (
              <Input
                {...aria}
                value={state}
                onChange={e => setState(e.target.value.toUpperCase().slice(0, 2))}
                autoComplete="address-level1"
                maxLength={2}
                className="h-11 w-full sm:w-20 uppercase"
                data-testid="input-state"
              />
            )}
          </Field>
          <Field id="w9-zip" label="ZIP" error={show("zip")}>
            {aria => (
              <Input
                {...aria}
                value={zip}
                onChange={e => setZip(e.target.value.slice(0, 10))}
                autoComplete="postal-code"
                inputMode="numeric"
                className="h-11 w-full tabular-nums sm:w-32"
                data-testid="input-zip"
              />
            )}
          </Field>
        </div>
      </fieldset>

      {/* ── Part I: TIN ── */}
      <fieldset className="space-y-4">
        <legend className="sr-only">Taxpayer identification number</legend>
        <div>
          <SectionLabel>Taxpayer identification number</SectionLabel>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Stored encrypted. Nobody in the app - including your manager - can read it back; after you file, this screen shows only the last four digits.
          </p>
        </div>
        {/* Native radios already form a group by `name`; the nested fieldset
            gives that group its own accessible name. */}
        <fieldset className="space-y-2">
          <legend className="mb-2 text-[13px] font-semibold text-foreground">Which number are you giving us?</legend>
          <RadioCard
            name="w9-tin-type"
            value="ssn"
            checked={tinType === "ssn"}
            onChange={() => { setTinType("ssn"); setTin(""); }}
            title="Social Security number (SSN)"
            blurb="Use this if you are paid as yourself - the answer for most reps."
            testId="tin-type-ssn"
          />
          <RadioCard
            name="w9-tin-type"
            value="ein"
            checked={tinType === "ein"}
            onChange={() => { setTinType("ein"); setTin(""); }}
            title="Employer Identification Number (EIN)"
            blurb="Use this if you are paid through a business entity that has its own IRS number."
            testId="tin-type-ein"
          />
        </fieldset>
        <Field
          id="w9-tin"
          label={tinType === "ssn" ? "Social Security number" : "Employer Identification Number"}
          hint="9 digits. Hidden as you type - use Show to check it before you sign."
          error={show("tin")}
        >
          {aria => (
            <div className="flex items-center gap-2">
              <Input
                {...aria}
                type={showTin ? "text" : "password"}
                value={tin}
                onChange={e => setTin(digitsOnly(e.target.value).slice(0, 9))}
                inputMode="numeric"
                autoComplete="off"
                className="h-11 flex-1 tabular-nums tracking-[0.2em]"
                data-testid="input-tin"
              />
              <Button
                type="button"
                variant="outline"
                className="h-11 shrink-0"
                onClick={() => setShowTin(v => !v)}
                aria-pressed={showTin}
                data-testid="toggle-tin-visibility"
              >
                {showTin ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                <span className="ml-1.5">{showTin ? "Hide" : "Show"}</span>
              </Button>
            </div>
          )}
        </Field>
      </fieldset>

      {/* ── Line 4 / Line 7 — rarely used, kept out of the main flow ── */}
      <details className="rounded-xl border border-border bg-secondary/20 px-3.5 py-3">
        <summary className={cn("cursor-pointer text-[13px] font-semibold text-foreground", FOCUS)} data-testid="w9-optional-codes">
          Exemption codes and account numbers (almost nobody needs these)
        </summary>
        <div className="mt-3 space-y-4">
          <Field id="w9-exempt-payee" label="Exempt payee code" optional hint="Line 4. Only certain entities (not individuals) have one." error={show("exemptPayeeCode")}>
            {aria => <Input {...aria} value={exemptPayeeCode} onChange={e => setExemptPayeeCode(e.target.value)} maxLength={8} className="h-11" data-testid="input-exempt-payee-code" />}
          </Field>
          <Field id="w9-fatca" label="FATCA reporting exemption code" optional hint="Line 4. Applies to some accounts held outside the United States." error={show("fatcaExemptionCode")}>
            {aria => <Input {...aria} value={fatcaExemptionCode} onChange={e => setFatcaExemptionCode(e.target.value)} maxLength={12} className="h-11" data-testid="input-fatca-code" />}
          </Field>
          <Field id="w9-account-numbers" label="Account number(s)" optional hint="Line 7. Leave blank unless you were asked for it." error={show("accountNumbers")}>
            {aria => <Input {...aria} value={accountNumbers} onChange={e => setAccountNumbers(e.target.value)} maxLength={80} className="h-11" data-testid="input-account-numbers" />}
          </Field>
        </div>
      </details>

      {/* ── Part II item 2: backup withholding, asked out loud ── */}
      <fieldset className="space-y-3 rounded-xl border border-border bg-secondary/20 p-3.5" aria-describedby="w9-backup-withholding-help">
        <legend className="px-1 text-[13px] font-semibold text-foreground">
          Has the IRS notified you that you are subject to backup withholding?
        </legend>
        <p id="w9-backup-withholding-help" className="text-xs leading-relaxed text-muted-foreground">
          Backup withholding means the IRS told you, in writing, that 24% of payments like these must be withheld and sent to them - usually after unreported interest or dividends. If that has never happened to you, the answer is No. Answering Yes means 24% of every payout is withheld from you and paid to the IRS.
        </p>
        <div className="space-y-2">
          <RadioCard
            name="w9-backup-withholding"
            value="no"
            checked={backupWithholding === "no"}
            onChange={() => setBackupWithholding("no")}
            title="No - the IRS has never notified me"
            blurb="This is the answer for almost everyone."
            testId="backup-withholding-no"
          />
          <RadioCard
            name="w9-backup-withholding"
            value="yes"
            checked={backupWithholding === "yes"}
            onChange={() => setBackupWithholding("yes")}
            title="Yes - the IRS notified me and it has not been lifted"
            blurb="Item 2 of the certification below is crossed out on your filed form, and 24% of your pay is withheld."
            testId="backup-withholding-yes"
          />
        </div>
        {show("backupWithholding") && <p className="text-xs font-medium text-destructive" data-testid="error-backupWithholding">{errors.backupWithholding}</p>}
      </fieldset>

      {/* ── Part II: the certification itself ── */}
      <fieldset className="space-y-3">
        <legend className="sr-only">Certification</legend>
        <SectionLabel>What you are signing</SectionLabel>
        <div
          className="max-h-72 overflow-y-auto rounded-xl border border-border bg-background p-3.5"
          tabIndex={0}
          role="document"
          aria-label="Form W-9 Part II certification text"
          data-testid="w9-certification-text"
        >
          <p className="text-[13px] font-semibold text-foreground">Under penalties of perjury, I certify that:</p>
          <ol className="mt-2 space-y-2">
            {CERTIFICATION_ITEMS.map((item, index) => {
              const struck = index === 1 && item2Struck;
              return (
                <li
                  key={item}
                  className="text-xs leading-relaxed text-muted-foreground"
                  data-testid={index === 1 ? "certification-item-2" : undefined}
                >
                  <span className={cn(struck && "line-through opacity-70")}>{item}</span>
                  {struck && <span className="ml-1.5 font-semibold text-warning">(crossed out on your filed form, because you answered Yes above)</span>}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{CERTIFICATION_INSTRUCTION}</p>
        </div>

        <LegalCheckbox checked={consent} onChange={setConsent} testId="w9-consent">
          I have read the certification above and I make it under penalties of perjury. I consent to sign this Form W-9 electronically, I understand my typed name below is my signature, and I understand that certifying something false here is a false certification to the IRS.
        </LegalCheckbox>
        {show("consent") && <p className="text-xs font-medium text-destructive" data-testid="error-consent">{errors.consent}</p>}

        <Field
          id="w9-signature"
          label="Type your full legal name to sign"
          hint="It must match the legal name you entered at the top of this form."
          error={show("signatureName")}
        >
          {aria => (
            <Input {...aria} value={signatureName} onChange={e => setSignatureName(e.target.value)} placeholder={legalName || undefined} autoComplete="off" className="h-11 font-medium" data-testid="input-signature-name" />
          )}
        </Field>
      </fieldset>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {showCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} data-testid="w9-cancel">Cancel</Button>
        )}
        <Button type="submit" className="h-11" disabled={mutation.isPending} data-testid="w9-submit">
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Lock className="mr-2 h-4 w-4" aria-hidden="true" />}
          File my W-9
        </Button>
      </div>
    </form>
  );
}

// ── W-9 filed summary ────────────────────────────────────────────────────────

function classificationSummary(status: W9Status): string {
  const base = CLASSIFICATION_COPY[status.taxClassification]?.label ?? status.taxClassification;
  if (status.taxClassification === "llc" && status.llcTaxClass) return `${base} - taxed as ${status.llcTaxClass}`;
  if (status.taxClassification === "other" && status.otherClassification) return `${base}: ${status.otherClassification}`;
  return base;
}

function W9Filed({ status, onRefile }: { status: W9Status; onRefile: () => void }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const response = await apiRequest("GET", "/api/me/w9/pdf");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `form-w9-${status.w9Id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "Download failed", description: serverMessage(error), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const filedOn = new Date(status.signatureDate);

  return (
    <div className="space-y-4" data-testid="w9-filed">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/20 px-3.5 py-3">
        <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-foreground">
          Your Form W-9 is on file, signed {Number.isNaN(filedOn.valueOf()) ? "recently" : filedOn.toLocaleDateString()}.
        </p>
      </div>

      <dl className="divide-y divide-border">
        <SummaryRow label="Legal name" value={status.legalName} />
        {status.businessName && <SummaryRow label="Business name" value={status.businessName} />}
        <SummaryRow label="Tax classification" value={classificationSummary(status)} />
        <SummaryRow
          label={status.tinType === "ein" ? "EIN on file" : "SSN on file"}
          value={<span data-testid="w9-tin-masked">{status.tinMasked}</span>}
          mono
        />
        <SummaryRow
          label="Backup withholding"
          value={status.subjectToBackupWithholding ? "Yes - 24% is withheld from your pay" : "No"}
        />
        <SummaryRow label="Signed by" value={status.signatureName} />
      </dl>

      {status.subjectToBackupWithholding && (
        <Alert data-testid="w9-backup-withholding-notice">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>You certified you are subject to backup withholding</AlertTitle>
          <AlertDescription>
            24% of each payout is withheld and sent to the IRS. If the IRS has since told you the withholding is lifted, file an updated W-9 below.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" onClick={onRefile} data-testid="w9-refile">
          Something changed - file a new W-9
        </Button>
        <Button type="button" variant="outline" onClick={() => setReviewing(true)} data-testid="w9-review">
          <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
          Review full W-9
        </Button>
        <Button type="button" variant="outline" onClick={download} disabled={downloading} data-testid="w9-download">
          {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="mr-2 h-4 w-4" aria-hidden="true" />}
          Download my copy
        </Button>
      </div>

      {reviewing && (
        <PdfReviewer
          url="/api/me/w9/pdf"
          title="Your Form W-9 (official IRS document)"
          downloadName={`form-w9-${status.w9Id}.pdf`}
          onClose={() => setReviewing(false)}
        />
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Your downloaded copy shows your full number, so it is generated fresh each time and never stored as a file.
      </p>
    </div>
  );
}

// ── Bank details ─────────────────────────────────────────────────────────────

type BankErrors = Partial<Record<"routing" | "account" | "confirmAccount" | "accountType", string>>;

function BankForm({ onSaved, onCancel, showCancel }: {
  onSaved: (status: BankStatus) => void;
  onCancel: () => void;
  showCancel: boolean;
}) {
  const { toast } = useToast();
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [confirmAccount, setConfirmAccount] = useState("");
  const [showAccount, setShowAccount] = useState(false);
  const [accountType, setAccountType] = useState<"checking" | "savings" | "">("");
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = useMemo<BankErrors>(() => {
    const e: BankErrors = {};
    if (!/^\d{9}$/.test(routing)) e.routing = "A routing number is exactly 9 digits - it is the leftmost number on the bottom of a check.";
    else if (!isValidAbaRouting(routing)) e.routing = "That routing number fails the bank checksum, so it is not a real one. Check it against your bank's app or a check.";
    if (!isValidAccountNumber(account)) e.account = "An account number is 4–17 digits.";
    if (!confirmAccount) e.confirmAccount = "Enter your account number a second time so we can be sure it is right.";
    else if (confirmAccount !== account) e.confirmAccount = "The two account numbers do not match.";
    if (accountType !== "checking" && accountType !== "savings") e.accountType = "Tell us whether this is a checking or a savings account.";
    return e;
  }, [routing, account, confirmAccount, accountType]);

  const errorCount = Object.keys(errors).length;
  const show = (key: keyof BankErrors) => (submitted ? errors[key] : undefined);

  const mutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PUT", "/api/me/bank", { routing, account, accountType });
      return (await response.json()) as BankStatus;
    },
    onSuccess: status => {
      // Same rule as the TIN: the full number is gone from this client the
      // moment the server has it.
      setRouting("");
      setAccount("");
      setConfirmAccount("");
      setShowAccount(false);
      setServerError(null);
      toast({ title: "Direct deposit saved", description: `Your pay will go to the account ending ${status.last4}.` });
      onSaved(status);
    },
    onError: error => setServerError(serverMessage(error)),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (errorCount > 0) return;
    mutation.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5" data-testid="bank-form">
      {submitted && errorCount > 0 && (
        <Alert variant="destructive" data-testid="bank-validation-summary">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Check these details before saving</AlertTitle>
          <AlertDescription>This is where your pay is sent, so it has to be exactly right.</AlertDescription>
        </Alert>
      )}
      {serverError && (
        <Alert variant="destructive" role="alert" data-testid="bank-server-error">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Your bank details were not saved</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <Field id="bank-routing" label="Routing number" hint="9 digits, bottom-left of a check. Checked against the bank checksum as you type." error={show("routing")}>
        {aria => (
          <Input
            {...aria}
            value={routing}
            onChange={e => setRouting(digitsOnly(e.target.value).slice(0, 9))}
            inputMode="numeric"
            autoComplete="off"
            className="h-11 tabular-nums tracking-[0.2em]"
            data-testid="input-routing"
          />
        )}
      </Field>

      <Field id="bank-account" label="Account number" hint="4–17 digits. Hidden as you type." error={show("account")}>
        {aria => (
          <div className="flex items-center gap-2">
            <Input
              {...aria}
              type={showAccount ? "text" : "password"}
              value={account}
              onChange={e => setAccount(digitsOnly(e.target.value).slice(0, 17))}
              inputMode="numeric"
              autoComplete="off"
              className="h-11 flex-1 tabular-nums tracking-[0.2em]"
              data-testid="input-account"
            />
            <Button
              type="button"
              variant="outline"
              className="h-11 shrink-0"
              onClick={() => setShowAccount(v => !v)}
              aria-pressed={showAccount}
              data-testid="toggle-account-visibility"
            >
              {showAccount ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              <span className="ml-1.5">{showAccount ? "Hide" : "Show"}</span>
            </Button>
          </div>
        )}
      </Field>

      <Field id="bank-account-confirm" label="Confirm account number" hint="Type it again. A single wrong digit sends your pay to a stranger." error={show("confirmAccount")}>
        {aria => (
          <Input
            {...aria}
            type="password"
            value={confirmAccount}
            onChange={e => setConfirmAccount(digitsOnly(e.target.value).slice(0, 17))}
            inputMode="numeric"
            autoComplete="off"
            className="h-11 tabular-nums tracking-[0.2em]"
            data-testid="input-account-confirm"
          />
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-semibold text-foreground">Account type</legend>
        <div className="space-y-2">
          <RadioCard name="bank-account-type" value="checking" checked={accountType === "checking"} onChange={() => setAccountType("checking")} title="Checking" testId="account-type-checking" />
          <RadioCard name="bank-account-type" value="savings" checked={accountType === "savings"} onChange={() => setAccountType("savings")} title="Savings" testId="account-type-savings" />
        </div>
        {show("accountType") && <p className="text-xs font-medium text-destructive" data-testid="error-accountType">{errors.accountType}</p>}
      </fieldset>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {showCancel && <Button type="button" variant="ghost" onClick={onCancel} data-testid="bank-cancel">Cancel</Button>}
        <Button type="submit" className="h-11" disabled={mutation.isPending} data-testid="bank-submit">
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Lock className="mr-2 h-4 w-4" aria-hidden="true" />}
          Save direct deposit
        </Button>
      </div>
    </form>
  );
}

function BankSaved({ status, onReplace }: { status: BankStatus; onReplace: () => void }) {
  const updated = status.updatedAt ? new Date(status.updatedAt) : null;
  return (
    <div className="space-y-4" data-testid="bank-saved">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/20 px-3.5 py-3">
        <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-foreground">
          Your pay goes to this account. We keep only the last four digits on screen - nobody in the app can read the rest back.
        </p>
      </div>
      <dl className="divide-y divide-border">
        <SummaryRow
          label="Account"
          value={<span data-testid="bank-last4">{"•••• "}{status.last4}</span>}
          mono
        />
        <SummaryRow label="Type" value={status.accountType === "savings" ? "Savings" : "Checking"} />
        <SummaryRow label="Status" value={status.status === "active" ? "Active" : status.status} />
        {updated && !Number.isNaN(updated.valueOf()) && <SummaryRow label="Last updated" value={updated.toLocaleDateString()} />}
      </dl>
      <Button type="button" variant="outline" onClick={onReplace} data-testid="bank-replace">
        Use a different account
      </Button>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function SectionSkeleton() {
  return (
    <div className="space-y-3" data-testid="section-skeleton" role="status" aria-busy="true" aria-label="Loading this section">
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="h-11 w-full rounded-xl" />
      <Skeleton className="h-11 w-full rounded-xl" />
    </div>
  );
}

function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="space-y-3" role="alert">
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>Couldn't load {what}</AlertTitle>
        <AlertDescription>Check your connection and try again. Nothing you have filed was lost.</AlertDescription>
      </Alert>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}

export default function TaxAndPay() {
  const queryClient = useQueryClient();
  const [refilingW9, setRefilingW9] = useState(false);
  const [replacingBank, setReplacingBank] = useState(false);

  const w9 = useQuery<W9Status | null>({
    queryKey: ["/api/me/w9"],
    queryFn: () => getOrNull<W9Status>("/api/me/w9"),
    staleTime: 30_000,
  });

  const bank = useQuery<BankStatus | null>({
    queryKey: ["/api/me/bank"],
    queryFn: () => getOrNull<BankStatus>("/api/me/bank"),
    staleTime: 30_000,
  });

  // "No rep profile linked to your login" is the server's 400 for a user whose
  // account was never joined to a team member. It is a manager fix, not a rep
  // one, so say so instead of showing a form that can never succeed.
  const noRepProfile = [w9.error, bank.error].some(
    error => statusOf(error) === 400 && /rep profile/i.test(serverMessage(error)),
  );

  const w9Done = !!w9.data;
  const bankDone = !!bank.data;
  const stepsDone = (w9Done ? 1 : 0) + (bankDone ? 1 : 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title="Tax & direct deposit"
        icon={Landmark}
        subtitle="Two things have to be on file before you can be paid: your signed IRS Form W-9 and the bank account your pay lands in."
      />

      {!noRepProfile && (
        <section className="rounded-2xl border border-border bg-card p-4" aria-label="Setup progress" data-testid="pay-setup-progress">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <SectionLabel>Getting paid</SectionLabel>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{stepsDone} of 2 complete</div>
            </div>
            <span
              className={cn(
                "grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-bold tabular-nums",
                stepsDone === 2 ? "bg-success/15 text-success" : "bg-primary/10 text-primary",
              )}
            >
              {stepsDone}/2
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {stepsDone === 2
              ? "You are set up. Update either section any time your details change."
              : "Payouts cannot be released until both are done, so finish them on your first day."}
          </p>
        </section>
      )}

      {noRepProfile && (
        <Alert data-testid="no-rep-profile">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>No rep profile is linked to your login</AlertTitle>
          <AlertDescription>
            Ask your manager to link your login to your team profile. Once they do, you can file your W-9 and add your direct deposit here.
          </AlertDescription>
        </Alert>
      )}

      {!noRepProfile && (
        <>
          <CardSection
            title="IRS Form W-9"
            description="Your tax form. It tells us who to issue a 1099 to in January and whether the IRS requires anything to be withheld."
            icon={FileText}
            testId="w9-section"
          >
            {w9.isLoading && <SectionSkeleton />}
            {!w9.isLoading && w9.isError && <LoadFailed what="your W-9" onRetry={() => w9.refetch()} />}
            {!w9.isLoading && !w9.isError && (
              w9.data && !refilingW9
                ? <W9Filed status={w9.data} onRefile={() => setRefilingW9(true)} />
                : (
                  <W9Form
                    showCancel={!!w9.data}
                    onCancel={() => setRefilingW9(false)}
                    onSubmitted={status => {
                      setRefilingW9(false);
                      queryClient.setQueryData(["/api/me/w9"], status);
                      queryClient.invalidateQueries({ queryKey: ["/api/me/w9"] });
                    }}
                  />
                )
            )}
          </CardSection>

          <CardSection
            title="Direct deposit"
            description="Where your commission and spiff payouts are sent. Get one digit wrong and the money goes to somebody else's account."
            icon={Banknote}
            testId="bank-section"
          >
            {bank.isLoading && <SectionSkeleton />}
            {!bank.isLoading && bank.isError && <LoadFailed what="your bank details" onRetry={() => bank.refetch()} />}
            {!bank.isLoading && !bank.isError && (
              bank.data && !replacingBank
                ? <BankSaved status={bank.data} onReplace={() => setReplacingBank(true)} />
                : (
                  <BankForm
                    showCancel={!!bank.data}
                    onCancel={() => setReplacingBank(false)}
                    onSaved={status => {
                      setReplacingBank(false);
                      queryClient.setQueryData(["/api/me/bank"], status);
                      queryClient.invalidateQueries({ queryKey: ["/api/me/bank"] });
                    }}
                  />
                )
            )}
          </CardSection>

          <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              Your Social Security number and bank account are encrypted before they are stored and are never shown again - not to you, not to your manager. Every access to your signed W-9 document is recorded.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
