// ── Recovery message templates - the rendering contract ──────────────────────
// PURE and framework-free.
//
// A template is the only thing that produces the words we send. That makes it
// the highest-risk piece of text in the system, so this module is built around
// three refusals:
//
//   1. NO UNKNOWN VARIABLES. `{{ballance}}` is a typo, not a feature. Rendering
//      refuses rather than shipping a message with a literal brace pair in it.
//   2. NO EMPTY SUBSTITUTIONS. "Hi , this is about your order" is worse than no
//      message at all - it tells the customer we do not know who they are.
//      A missing value is a render ERROR, and the send is blocked.
//   3. NO INJECTION. Provider data is customer-controlled in practice: a
//      customer name field can hold anything the door rep typed. HTML rendering
//      escapes every substitution, and no template variable is ever
//      interpolated into a URL without encoding.
//
// APPROVAL AND VERSIONING. Templates are versioned and a version is approved by
// a named admin. Editing an approved template publishes a NEW version in draft;
// it never silently changes the words that an approval was granted for. The
// consent gate refuses to send an unapproved version, so the approval is a
// real control rather than a label.

import { SMS_OPT_OUT_SENTENCE } from "./contactConsent";

export const TEMPLATE_KINDS = [
  "install_reminder",
  "missed_install",
  "customer_action",
  "missing_documents",
  "failed_install",
  "canceled_recovery",
  "final_follow_up",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_KIND_LABELS: Readonly<Record<TemplateKind, string>> = {
  install_reminder: "Install appointment reminder",
  missed_install: "Missed installation follow-up",
  customer_action: "Customer action needed",
  missing_documents: "Missing information or documents",
  failed_install: "Failed installation recovery",
  canceled_recovery: "Canceled order recovery",
  final_follow_up: "Final follow-up",
};

/**
 * The variables a template may use.
 *
 * A closed list, not "whatever the caller passes". Adding one is a code change
 * with a test, which is the point: a template author cannot reach into the
 * order record and pull out a field nobody reviewed for disclosure.
 */
export const TEMPLATE_VARIABLES = [
  "customer_first_name",
  "carrier",
  "product_sold",
  "program",
  "service_address",
  "install_date",
  "support_phone",
  "rep_name",
  "company_name",
  "company_address",
  "callback_link",
  "unsubscribe_link",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export const VARIABLE_LABELS: Readonly<Record<TemplateVariable, string>> = {
  customer_first_name: "Customer first name",
  carrier: "Carrier",
  product_sold: "Product sold",
  program: "Program",
  service_address: "Service address",
  install_date: "Install date",
  support_phone: "Support phone",
  rep_name: "Rep name",
  company_name: "Company name",
  company_address: "Company mailing address",
  callback_link: "Callback link",
  unsubscribe_link: "Unsubscribe link",
};

/** Variables that are only meaningful in an email. Using one in an SMS body is
 *  a validation error rather than a runtime surprise. */
const EMAIL_ONLY_VARIABLES: readonly TemplateVariable[] = ["unsubscribe_link", "company_address"];

export function isTemplateVariable(name: string): name is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** `{{ name }}` with optional inner whitespace. Nothing else is a placeholder,
 *  so an apostrophe or a stray brace in customer data cannot become one. */
const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

export type TemplateValues = Partial<Record<TemplateVariable, string | null | undefined>>;

export interface RenderResult {
  ok: boolean;
  text: string;
  /** Variables the template used that are not in the closed list. */
  unknownVariables: string[];
  /** Variables that are valid but had no value for this order. */
  missingValues: TemplateVariable[];
}

/**
 * Substitute values into a template.
 *
 * `escape` decides how each substituted value is treated. Plain text for SMS,
 * HTML-escaped for an email body. The template's own literal text is never
 * escaped - it is authored by an admin and may legitimately contain markup in
 * an HTML template.
 */
export function renderTemplate(
  template: string,
  values: TemplateValues,
  escape: (v: string) => string = (v) => v,
): RenderResult {
  const unknown: string[] = [];
  const missing: TemplateVariable[] = [];

  const text = String(template ?? "").replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!isTemplateVariable(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      // Left verbatim so an admin previewing a draft sees exactly which token
      // is wrong instead of a hole where a word used to be.
      return `{{${name}}}`;
    }
    const value = values[name];
    const clean = value == null ? "" : String(value).trim();
    if (!clean) {
      if (!missing.includes(name)) missing.push(name);
      return `{{${name}}}`;
    }
    return escape(clean);
  });

  return { ok: unknown.length === 0 && missing.length === 0, text, unknownVariables: unknown, missingValues: missing };
}

/** HTML-escape a substituted value. Ampersand first, or the other replacements
 *  double-escape their own output. */
export function escapeHtmlValue(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface TemplateValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

/** SMS length. Not a hard protocol limit - a longer message is split into
 *  segments and billed per segment - but a recovery text that runs to four
 *  segments reads as spam and costs four times as much. */
export const SMS_SOFT_LIMIT = 320;

/**
 * Check a template BEFORE it can be approved.
 *
 * The channel-specific requirements here are the same ones the consent gate
 * enforces at send time. Checking both is deliberate: the gate is the wall, and
 * this is the door that stops an admin walking into it.
 */
export function validateTemplate(input: {
  channel: "sms" | "email";
  kind: TemplateKind;
  subject: string | null;
  body: string;
}): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const body = String(input.body ?? "");

  if (!body.trim()) {
    issues.push({ severity: "error", code: "EMPTY_BODY", message: "The message body is empty." });
    return issues;
  }

  const used = new Set<string>();
  let m: RegExpExecArray | null;
  const scan = new RegExp(PLACEHOLDER.source, "g");
  while ((m = scan.exec(body)) != null) used.add(m[1].trim());
  if (input.subject) {
    const subjectScan = new RegExp(PLACEHOLDER.source, "g");
    while ((m = subjectScan.exec(input.subject)) != null) used.add(m[1].trim());
  }

  for (const name of used) {
    if (!isTemplateVariable(name)) {
      issues.push({
        severity: "error", code: "UNKNOWN_VARIABLE",
        message: `"{{${name}}}" is not a variable this system can fill. Remove it or pick one from the list.`,
      });
    }
  }

  if (input.channel === "sms") {
    if (!/\breply\s+stop\b/i.test(body) && !/\btext\s+stop\b/i.test(body)) {
      issues.push({
        severity: "error", code: "NO_OPT_OUT",
        message: `A text must tell the customer how to stop. Include "${SMS_OPT_OUT_SENTENCE}"`,
      });
    }
    for (const v of EMAIL_ONLY_VARIABLES) {
      if (used.has(v)) {
        issues.push({
          severity: "error", code: "EMAIL_ONLY_VARIABLE",
          message: `"{{${v}}}" only works in an email.`,
        });
      }
    }
    if (input.subject) {
      issues.push({ severity: "warning", code: "SMS_SUBJECT", message: "A text has no subject line. This one is ignored." });
    }
    if (body.length > SMS_SOFT_LIMIT) {
      issues.push({
        severity: "warning", code: "SMS_LENGTH",
        message: `This text is ${body.length} characters and will send as multiple segments. Under ${SMS_SOFT_LIMIT} is one to two.`,
      });
    }
  }

  if (input.channel === "email") {
    if (!input.subject || !input.subject.trim()) {
      issues.push({ severity: "error", code: "NO_SUBJECT", message: "An email needs a subject line." });
    } else if (/^(re|fwd):/i.test(input.subject.trim())) {
      // A subject that fakes a reply to a conversation that never happened is
      // deceptive, and it is exactly the pattern a recovery sequence is tempted
      // to reach for.
      issues.push({
        severity: "error", code: "DECEPTIVE_SUBJECT",
        message: 'A subject may not start with "Re:" or "Fwd:" on a message that is not a reply.',
      });
    }
    if (!used.has("unsubscribe_link")) {
      issues.push({
        severity: "error", code: "NO_UNSUBSCRIBE",
        message: "An email must include {{unsubscribe_link}}.",
      });
    }
    if (!used.has("company_address")) {
      issues.push({
        severity: "error", code: "NO_POSTAL_ADDRESS",
        message: "An email must include {{company_address}}, the company's physical mailing address.",
      });
    }
  }

  if (!used.has("company_name") && !used.has("rep_name")) {
    issues.push({
      severity: "warning", code: "NO_SENDER_IDENTITY",
      message: "The message does not say who it is from. Include {{company_name}} or {{rep_name}}.",
    });
  }

  return issues;
}

// ── The starting set ─────────────────────────────────────────────────────────
//
// Seeded per organization on first use, in DRAFT. Nothing here is approved by
// being shipped: an admin reads each one, edits it into their own voice, and
// approves it. The wording is deliberately plain and non-urgent - a recovery
// message is a service update about an order the customer already placed, and
// anything that reads like a sales push turns a fixable order into a complaint.

export interface SeedTemplate {
  kind: TemplateKind;
  channel: "sms" | "email";
  name: string;
  subject: string | null;
  body: string;
}

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    kind: "install_reminder", channel: "sms", name: "Install reminder (text)", subject: null,
    body: `Hi {{customer_first_name}}, this is {{rep_name}} with {{company_name}}. Your {{carrier}} {{product_sold}} installation is set for {{install_date}}. Someone 18 or older needs to be home. Questions? Call {{support_phone}}. ${SMS_OPT_OUT_SENTENCE}`,
  },
  {
    kind: "missed_install", channel: "sms", name: "Missed installation (text)", subject: null,
    body: `Hi {{customer_first_name}}, this is {{rep_name}} with {{company_name}} about your {{carrier}} {{product_sold}} order. It looks like the install on {{install_date}} did not happen. Reply here or call {{support_phone}} and we will get you rebooked. ${SMS_OPT_OUT_SENTENCE}`,
  },
  {
    kind: "customer_action", channel: "sms", name: "Customer action needed (text)", subject: null,
    body: `Hi {{customer_first_name}}, this is {{rep_name}} with {{company_name}} regarding your {{carrier}} {{product_sold}} order. It looks like your installation may need a quick update. Reply here or call {{support_phone}} and we will help get it back on track. ${SMS_OPT_OUT_SENTENCE}`,
  },
  {
    kind: "missing_documents", channel: "sms", name: "Missing documents (text)", subject: null,
    body: `Hi {{customer_first_name}}, {{company_name}} here about your {{carrier}} order. We are waiting on one item before {{carrier}} can schedule your install. Call {{support_phone}} or use {{callback_link}} and it takes a minute. ${SMS_OPT_OUT_SENTENCE}`,
  },
  {
    kind: "failed_install", channel: "sms", name: "Failed installation (text)", subject: null,
    body: `Hi {{customer_first_name}}, this is {{rep_name}} with {{company_name}}. The {{carrier}} technician was not able to finish your install. We can sort out what is needed and rebook it. Call {{support_phone}} or reply here. ${SMS_OPT_OUT_SENTENCE}`,
  },
  {
    kind: "final_follow_up", channel: "sms", name: "Final follow-up (text)", subject: null,
    body: `Hi {{customer_first_name}}, {{rep_name}} with {{company_name}}. This is my last message about your {{carrier}} {{product_sold}} order. If you still want it, call {{support_phone}} and we will finish it. Otherwise you will not hear from me again. ${SMS_OPT_OUT_SENTENCE}`,
  },
  {
    kind: "customer_action", channel: "email", name: "Customer action needed (email)",
    subject: "Action needed for your {{carrier}} installation",
    body: `Hi {{customer_first_name}},

We are following up about your {{carrier}} {{product_sold}} order for {{service_address}}. Our records show that your order may need an update before installation can be completed.

Please contact us at {{support_phone}} or use {{callback_link}} so we can help.

Thanks,
{{rep_name}}
{{company_name}}

{{company_address}}
Prefer not to receive these? {{unsubscribe_link}}`,
  },
  {
    kind: "missing_documents", channel: "email", name: "Missing documents (email)",
    subject: "One item left on your {{carrier}} order",
    body: `Hi {{customer_first_name}},

Your {{carrier}} {{product_sold}} order for {{service_address}} is waiting on one piece of information before {{carrier}} can schedule the installation.

Call {{support_phone}} or use {{callback_link}} and we will walk you through it.

Thanks,
{{rep_name}}
{{company_name}}

{{company_address}}
Prefer not to receive these? {{unsubscribe_link}}`,
  },
  {
    kind: "missed_install", channel: "email", name: "Missed installation (email)",
    subject: "Rebooking your {{carrier}} installation",
    body: `Hi {{customer_first_name}},

Your {{carrier}} installation at {{service_address}} was scheduled for {{install_date}} and our records show it was not completed.

We can get it rebooked. Call {{support_phone}} or use {{callback_link}}.

Thanks,
{{rep_name}}
{{company_name}}

{{company_address}}
Prefer not to receive these? {{unsubscribe_link}}`,
  },
  {
    kind: "canceled_recovery", channel: "email", name: "Canceled order (email)",
    subject: "Your {{carrier}} order at {{service_address}}",
    body: `Hi {{customer_first_name}},

Our records show your {{carrier}} {{product_sold}} order for {{service_address}} was canceled. If that was not what you intended, we can look at restarting it.

Call {{support_phone}} or use {{callback_link}}. If the cancellation was intentional, no action is needed.

Thanks,
{{rep_name}}
{{company_name}}

{{company_address}}
Prefer not to receive these? {{unsubscribe_link}}`,
  },
];

/** Which template kind fits a recovery reason. A default only - the rep picks,
 *  and an org may have several approved templates of the same kind. */
export const REASON_TO_TEMPLATE_KIND: Readonly<Record<string, TemplateKind>> = {
  stale_submitted: "customer_action",
  stale_accepted: "customer_action",
  install_overdue: "missed_install",
  failed_install: "failed_install",
  missed_appointment: "missed_install",
  pending_customer_action: "customer_action",
  pending_documents: "missing_documents",
  on_hold: "customer_action",
  recoverable_cancellation: "canceled_recovery",
  vendor_recoverable_flag: "customer_action",
};
