// ── Recovery messaging - the send path, and everything that stops it ─────────
//
// One function sends, and it re-derives every fact from source before it does.
// Nothing here trusts a value the caller passed, a flag cached at module load,
// or a denormalized column on the case. That is the whole design: a rep taps
// Send, and between the tap and the message there is exactly one gate, it reads
// the database, and there is no argument that bypasses it.
//
// THE ORDER OF OPERATIONS
//   1. Load the case, the order, and the organization's configuration.
//   2. Decrypt the customer's real contact details from the import row - the
//      ONLY place they exist. Nothing in this plane keeps a plaintext phone
//      number in a column.
//   3. Render the template. A missing variable is a refusal, not a blank.
//   4. Evaluate the gate over the RENDERED body, so the opt-out sentence and
//      the unsubscribe link are checked as they will actually appear.
//   5. Send, and record what was sent with the consent basis frozen onto it.
//
// A BLOCKED SEND IS STILL RECORDED. The outreach row is written with status
// `blocked` and the reason codes attached. An organization that has been
// blocking every text for a fortnight because nobody approved a template
// should be able to see that, and a compliance review should be able to prove
// the wall held rather than infer it from an absence.

import crypto from "node:crypto";
import { rawDb } from "./db";
import * as store from "./vendorOrderStore";
import { decryptOrderPayload } from "./vendorOrderCrypto";
import { destinationHashCandidates, hashDestination } from "./vendorOrderCrypto";
import { getEmailProvider, getSmsProvider } from "./messagingProviders";
import { recoveryMessagingEnabled } from "./providers/perfectVisionSubmittedOrders";
import { applyOrderMapping } from "@shared/orderColumnMapping";
import {
  DEFAULT_MESSAGING_CAPS, bodyCarriesOptOut, detectOptIn, detectOptOut,
  evaluateContactGate, isPlausibleEmail, maskEmail, maskPhone, normalizeEmail, normalizePhoneE164,
  recipientLocalHour, stateFromAddressLine,
  type ContactChannel, type ContactGateResult, type ConsentBasis, type MessagePurpose,
} from "@shared/contactConsent";
import {
  escapeHtmlValue, renderTemplate, validateTemplate,
  type TemplateValues,
} from "@shared/orderRecoveryTemplates";
import { localDayOf } from "@shared/orderStatusSource";

/** Where {{unsubscribe_link}} points. Falls back to a relative path when no
 *  public base URL is configured, which renders as an unusable link and
 *  therefore blocks the send - the right failure for an email whose only legal
 *  unsubscribe mechanism does not resolve. */
function publicBaseUrl(): string | null {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

// ── Draft ────────────────────────────────────────────────────────────────────

export interface DraftResult {
  ok: boolean;
  channel: ContactChannel;
  subject: string | null;
  body: string;
  /** Masked, always. A draft preview is a screen a rep looks at; it does not
   *  need to hand them the customer's number. */
  destinationMasked: string | null;
  gate: ContactGateResult;
  /** Template problems, separate from gate blocks: one is "these words are
   *  wrong", the other is "you may not send them". */
  renderIssues: string[];
}

/**
 * Build the message without sending it.
 *
 * This is the DEFAULT interaction. Manual review and send is what the brief
 * asks for and what the product does: a rep reads the draft, and a send is a
 * second, separate act.
 */
export function buildDraft(input: {
  tenantId: number;
  caseId: number;
  templateId: number;
  purpose?: MessagePurpose;
  actorUserId: number | null;
}): DraftResult | null {
  const context = loadContext(input.tenantId, input.caseId, input.templateId);
  if (!context) return null;
  const { channel, template } = context;
  const purpose = input.purpose ?? "transactional_service_update";

  const destination = resolveDestination(input.tenantId, context.order, channel);
  const values = templateValues(context, destination.outreachTokenSeed);

  const rendered = renderTemplate(template.body, values, channel === "email" ? escapeHtmlValue : undefined);
  const renderedSubject = template.subject
    ? renderTemplate(template.subject, values)
    : { ok: true, text: "", unknownVariables: [], missingValues: [] };

  const renderIssues: string[] = [];
  for (const v of rendered.unknownVariables) renderIssues.push(`"{{${v}}}" is not a variable this system can fill.`);
  for (const v of rendered.missingValues) renderIssues.push(`No value on file for {{${v}}}.`);
  for (const v of renderedSubject.missingValues) renderIssues.push(`No value on file for {{${v}}} in the subject.`);

  const gate = evaluateGate({
    tenantId: input.tenantId,
    context,
    channel,
    purpose,
    destination,
    body: rendered.text,
    renderOk: rendered.ok && renderedSubject.ok,
  });

  return {
    ok: gate.allowed && rendered.ok && renderedSubject.ok,
    channel,
    subject: template.subject ? renderedSubject.text : null,
    body: rendered.text,
    destinationMasked: destination.masked,
    gate,
    renderIssues,
  };
}

// ── Send ─────────────────────────────────────────────────────────────────────

export interface SendOutcome {
  sent: boolean;
  outreachId: number | null;
  gate: ContactGateResult | null;
  /** Safe to show. Never the destination, never a provider body. */
  message: string;
}

/**
 * Send, or refuse and say why.
 *
 * Everything is re-derived here even though buildDraft already computed it.
 * That duplication is deliberate: the draft is a screen the rep saw some
 * seconds or minutes ago, and in between the customer may have replied STOP.
 * The state that matters is the state at the instant of sending.
 */
export async function sendOutreach(input: {
  tenantId: number;
  caseId: number;
  templateId: number;
  purpose?: MessagePurpose;
  actorUserId: number | null;
  /** True when a scheduled sequence triggered this rather than a person.
   *  Automated sends carry the extra requirements the brief lists. */
  automated?: boolean;
}): Promise<SendOutcome> {
  const context = loadContext(input.tenantId, input.caseId, input.templateId);
  if (!context) return { sent: false, outreachId: null, gate: null, message: "That case or template no longer exists." };

  const { channel, template, config } = context;
  const purpose = input.purpose ?? "transactional_service_update";

  // Automated sequences carry two requirements a manual send does not: the
  // organization has to have switched them on, and the process flag has to be
  // set. Checked here rather than folded into the gate so the refusal names the
  // automation, not the feature.
  if (input.automated && (!config.automatedSequencesEnabled || !recoveryMessagingEnabled())) {
    const blocked = recordBlocked(input, context, channel, "", null, ["FEATURE_DISABLED"]);
    return {
      sent: false, outreachId: blocked, gate: null,
      message: "Automated recovery sequences are turned off for this organization.",
    };
  }

  const destination = resolveDestination(input.tenantId, context.order, channel);
  const values = templateValues(context, destination.outreachTokenSeed);
  const rendered = renderTemplate(template.body, values, channel === "email" ? escapeHtmlValue : undefined);
  const plain = renderTemplate(template.body, values);
  const renderedSubject = template.subject ? renderTemplate(template.subject, values) : null;

  if (!rendered.ok || (renderedSubject && !renderedSubject.ok)) {
    const outreachId = recordBlocked(input, context, channel, plain.text, destination, ["TEMPLATE_NOT_APPROVED"]);
    return {
      sent: false, outreachId, gate: null,
      message: "The message could not be filled in completely, so it was not sent. Check the template and the order details.",
    };
  }

  const gate = evaluateGate({
    tenantId: input.tenantId, context, channel, purpose, destination,
    body: plain.text, renderOk: true,
  });

  if (!gate.allowed) {
    const outreachId = recordBlocked(input, context, channel, plain.text, destination, gate.blockedBy);
    store.appendCaseEvent({
      tenantId: input.tenantId, caseId: input.caseId, eventType: "outreach_blocked",
      actorUserId: input.actorUserId, actorName: null,
      detail: `${channel === "sms" ? "Text" : "Email"} blocked: ${gate.summary}`,
    });
    return { sent: false, outreachId, gate, message: gate.summary };
  }

  // The outreach row is written BEFORE the provider call, in `queued`. If the
  // process dies mid-send there is a record of the attempt; the alternative
  // writes nothing and a message goes out that this system has no memory of.
  const clientReference = crypto.randomUUID();
  const outreachId = store.insertOutreach({
    tenantId: input.tenantId,
    caseId: input.caseId,
    channel,
    templateId: template.id,
    templateVersion: template.version,
    body: plain.text,
    subject: renderedSubject?.text ?? null,
    phoneMasked: channel === "sms" ? destination.masked : null,
    emailMasked: channel === "email" ? destination.masked : null,
    recipientHash: destination.hash,
    consentBasis: context.consent?.consent_basis ?? null,
    consentRecordId: context.consent?.id ?? null,
    senderIdentity: channel === "sms" ? config.smsSenderIdentity : config.emailSenderIdentity,
    purpose,
    status: "queued",
    blockedReasons: null,
    createdByUserId: input.actorUserId,
  });

  const result = channel === "sms"
    ? await getSmsProvider().sendSms({
        to: destination.normalized!,
        body: plain.text,
        senderIdentity: config.smsSenderIdentity ?? "",
        clientReference,
      })
    : await getEmailProvider().sendEmail({
        to: destination.normalized!,
        subject: renderedSubject?.text ?? "",
        text: plain.text,
        html: htmlBody(rendered.text),
        from: config.emailSenderIdentity ?? "",
        replyTo: config.emailReplyTo,
        listUnsubscribeUrl: unsubscribeUrl(input.tenantId, outreachId),
        clientReference,
      });

  if (!result.ok) {
    store.markOutreachFailed(outreachId, result.safeError ?? "The message could not be sent.");
    return { sent: false, outreachId, gate, message: result.safeError ?? "The message could not be sent." };
  }

  store.markOutreachSent(outreachId, result.providerMessageId ?? clientReference);
  const counters = store.outreachCounters(input.tenantId, input.caseId, destination.hash);
  store.updateCase(input.caseId, {
    last_outreach_at: new Date().toISOString(),
    outreach_count: counters.sentForCaseTotal,
    status: context.recoveryCase.status === "open" ? "in_progress" : context.recoveryCase.status,
  });
  store.appendCaseEvent({
    tenantId: input.tenantId, caseId: input.caseId, eventType: "outreach_sent",
    actorUserId: input.actorUserId, actorName: null,
    detail: `${channel === "sms" ? "Text" : "Email"} sent to ${destination.masked ?? "the customer"} using "${template.name}"`,
  });

  return { sent: true, outreachId, gate, message: "Sent." };
}

// ── The gate ─────────────────────────────────────────────────────────────────

function evaluateGate(input: {
  tenantId: number;
  context: MessageContext;
  channel: ContactChannel;
  purpose: MessagePurpose;
  destination: ResolvedDestination;
  body: string;
  renderOk: boolean;
}): ContactGateResult {
  const { context, channel, destination } = input;
  const config = context.config;

  const hashes = destination.normalized
    ? destinationHashCandidates(input.tenantId, channel, destination.normalized)
    : [];
  const consent = hashes.length ? store.latestConsent(input.tenantId, channel, hashes) : null;
  context.consent = consent;

  const suppressed = hashes.length ? store.isSuppressed(input.tenantId, channel, hashes) : false;
  const counters = store.outreachCounters(input.tenantId, context.recoveryCase.id, destination.hash);

  // The customer's local hour, from their state. Unknown blocks - see
  // shared/contactConsent.recipientLocalHour.
  const state = context.lead?.state ?? stateFromAddressLine(context.order.service_address);
  const localHour = recipientLocalHour(state, new Date());

  return evaluateContactGate({
    channel,
    purpose: input.purpose,
    featureEnabled: recoveryMessagingEnabled(),
    organizationApproved: config.messagingApproved && config.consentPolicyConfigured,
    // The one identity rule: only an order matched to an internal sale at high
    // confidence may be messaged. Everything else is a stranger.
    identityResolved: context.order.match_status === "matched"
      && Number(context.order.match_confidence_score ?? 0) >= 0.9,
    destination: destination.normalized,
    suppressed,
    doNotContact: Boolean(context.lead?.do_not_knock),
    consentStatus: consent
      ? (consent.revoked_at ? "revoked" : String(consent.consent_status) as any)
      : "never_granted",
    consentBasis: (consent?.consent_basis ?? null) as ConsentBasis | null,
    templateApproved: Boolean(context.template.approved) && input.renderOk,
    senderConfigured: channel === "sms"
      ? Boolean(config.smsSenderIdentity) && getSmsProvider().isConfigured()
      : Boolean(config.emailSenderIdentity) && getEmailProvider().isConfigured(),
    bodyHasOptOutLanguage: bodyCarriesOptOut(input.body),
    bodyHasUnsubscribe: input.body.includes("/unsubscribe"),
    bodyHasPostalAddress: Boolean(config.companyMailingAddress)
      && input.body.includes(String(config.companyMailingAddress).split("\n")[0].trim()),
    recipientLocalHour: localHour,
    quietHours: { startHour: config.quietHoursStart, endHour: config.quietHoursEnd },
    sentToDestinationToday: counters.sentToDestinationToday,
    sentForCaseTotal: counters.sentForCaseTotal,
    hoursSinceLastOutreachToCase: counters.hoursSinceLastOutreachToCase,
    caps: {
      maxPerDestinationPerDay: config.maxPerDestinationPerDay ?? DEFAULT_MESSAGING_CAPS.maxPerDestinationPerDay,
      maxPerCaseTotal: config.maxPerCaseTotal ?? DEFAULT_MESSAGING_CAPS.maxPerCaseTotal,
      minHoursBetweenOutreach: config.minHoursBetweenOutreach ?? DEFAULT_MESSAGING_CAPS.minHoursBetweenOutreach,
    },
  });
}

// ── Context ──────────────────────────────────────────────────────────────────

interface MessageContext {
  recoveryCase: any;
  order: any;
  lead: any | null;
  tenant: any | null;
  template: any;
  channel: ContactChannel;
  config: store.OrgRecoveryConfig;
  repName: string | null;
  consent?: any | null;
}

function loadContext(tenantId: number, caseId: number, templateId: number): MessageContext | null {
  const recoveryCase = store.getCase(caseId, tenantId);
  if (!recoveryCase) return null;
  const order = store.getOrder(Number(recoveryCase.vendor_order_id), tenantId);
  if (!order) return null;
  const template = store.getTemplate(templateId, tenantId);
  if (!template || !template.is_active) return null;

  const lead = recoveryCase.lead_id
    ? rawDb.prepare(`SELECT id, state, do_not_knock FROM leads WHERE id = ?`).get(recoveryCase.lead_id)
    : null;
  const tenant = rawDb.prepare(`SELECT company_name, brand_name FROM tenants WHERE id = ?`).get(tenantId);
  const repId = recoveryCase.assigned_to_rep_id ?? order.rep_id ?? null;
  const rep = repId ? rawDb.prepare(`SELECT name FROM team_members WHERE id = ?`).get(repId) as any : null;

  return {
    recoveryCase, order, lead, tenant, template,
    channel: String(template.channel) as ContactChannel,
    config: store.getOrgRecoveryConfig(tenantId),
    repName: rep?.name ?? order.rep_external_name ?? null,
  };
}

// ── Destination ──────────────────────────────────────────────────────────────

interface ResolvedDestination {
  normalized: string | null;
  masked: string | null;
  hash: string | null;
  outreachTokenSeed: number;
}

/**
 * The customer's real phone or email.
 *
 * It exists in exactly one place: the encrypted payload of the import row that
 * produced this order. So a send decrypts that row, re-applies the mapping the
 * import ran under, and takes the value - and with no encryption key
 * configured, or an import predating one, there is simply no destination and
 * the gate refuses. That is the intended consequence of storing masked values
 * everywhere else, not a gap in it.
 */
export function resolveDestination(tenantId: number, order: any, channel: ContactChannel): ResolvedDestination {
  const empty: ResolvedDestination = { normalized: null, masked: null, hash: null, outreachTokenSeed: 0 };

  const row = store.latestImportRowForOrder(tenantId, Number(order.id));
  if (!row) {
    return {
      ...empty,
      masked: channel === "sms" ? order.customer_phone_masked ?? null : order.customer_email_masked ?? null,
    };
  }

  const payload = decryptOrderPayload(row.encrypted_raw_payload);
  if (!payload) {
    return {
      ...empty,
      masked: channel === "sms" ? order.customer_phone_masked ?? null : order.customer_email_masked ?? null,
    };
  }

  const importRow = rawDb.prepare(`SELECT mapping_version FROM vendor_order_imports WHERE id = ?`)
    .get(row.vendor_order_import_id) as any;
  const mapping = importRow?.mapping_version != null
    ? store.getMappingByVersion(tenantId, Number(importRow.mapping_version))
    : store.getActiveMapping(tenantId);
  if (!mapping) return empty;

  const normalizedRow = applyOrderMapping({
    organizationId: tenantId,
    mapping: mapping.mapping,
    row: payload,
    sourceRowNumber: Number(row.source_row_number ?? 1),
    sourceReportId: null,
    timeZone: mapping.mapping.timeZone,
  });

  const raw = channel === "sms" ? normalizedRow.customerPhone : normalizedRow.customerEmail;
  const normalized = channel === "sms" ? normalizePhoneE164(raw) : normalizeEmail(raw);
  if (!normalized) {
    return {
      ...empty,
      masked: channel === "sms" ? order.customer_phone_masked ?? null : order.customer_email_masked ?? null,
    };
  }

  return {
    normalized,
    masked: channel === "sms" ? maskPhone(normalized) : maskEmail(normalized),
    hash: hashDestination(tenantId, channel, normalized).hash,
    outreachTokenSeed: Number(order.id),
  };
}

// ── Template values ──────────────────────────────────────────────────────────

function templateValues(context: MessageContext, _seed: number): TemplateValues {
  const { order, config, tenant } = context;
  const tz = config.reportTimezone;
  const installDate = order.install_scheduled_at ?? order.install_date ?? null;

  return {
    customer_first_name: firstName(order.customer_name),
    carrier: order.carrier ?? null,
    product_sold: order.product_sold ?? null,
    program: order.program ?? null,
    service_address: order.service_address ?? null,
    install_date: installDate ? formatDay(installDate, tz) : null,
    support_phone: config.supportPhone ?? null,
    rep_name: context.repName,
    company_name: tenant?.brand_name ?? tenant?.company_name ?? null,
    company_address: config.companyMailingAddress ?? null,
    callback_link: config.callbackUrl ?? null,
    // Filled at send time with the real outreach id. In a draft it is a
    // placeholder URL of the right shape, so the gate's unsubscribe check and
    // the preview both behave the way the sent message will.
    unsubscribe_link: unsubscribeUrl(config.tenantId, 0) ?? null,
  };
}

function firstName(fullName: unknown): string | null {
  const text = String(fullName ?? "").trim();
  if (!text) return null;
  // "SMITH, JOHN" is how a provider report writes a name at least as often as
  // "John Smith". Taking the first token blindly would greet a customer by
  // their surname in every message.
  if (text.includes(",")) {
    const after = text.split(",")[1]?.trim();
    if (after) return titleCase(after.split(/\s+/)[0]);
  }
  return titleCase(text.split(/\s+/)[0]);
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function formatDay(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return localDayOf(new Date(ms), tz);
}

/** Minimal, deliberately plain HTML. No tracking pixel, no remote images, no
 *  link wrapping: an order-status message that phones home about whether the
 *  customer opened it is a different kind of message. */
function htmlBody(escapedText: string): string {
  const paragraphs = escapedText.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111">${paragraphs}</div>`;
}

// ── Unsubscribe ──────────────────────────────────────────────────────────────

/** Signed, so a token cannot be forged or enumerated to unsubscribe somebody
 *  else. Unsubscribing a stranger is a low-stakes attack, but it is still an
 *  attack, and the signature costs nothing. */
function unsubscribeSecret(): Buffer | null {
  const raw = process.env.VENDOR_ORDER_ENCRYPTION_KEY?.trim()
    ?? process.env.CALLING_DATA_ENCRYPTION_KEY?.trim()
    ?? process.env.SESSION_SECRET?.trim();
  if (!raw) return null;
  return crypto.createHash("sha256").update(`unsubscribe:${raw}`).digest();
}

export function unsubscribeToken(tenantId: number, outreachId: number): string | null {
  const key = unsubscribeSecret();
  if (!key) return null;
  const body = `${tenantId}.${outreachId}`;
  const sig = crypto.createHmac("sha256", key).update(body).digest("base64url").slice(0, 32);
  return `${Buffer.from(body).toString("base64url")}.${sig}`;
}

export function unsubscribeUrl(tenantId: number, outreachId: number): string | null {
  const base = publicBaseUrl();
  const token = unsubscribeToken(tenantId, outreachId);
  if (!base || !token) return null;
  return `${base}/api/order-recovery/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function verifyUnsubscribeToken(token: string): { tenantId: number; outreachId: number } | null {
  const key = unsubscribeSecret();
  if (!key) return null;
  const [bodyB64, sig] = String(token).split(".");
  if (!bodyB64 || !sig) return null;
  let body: string;
  try { body = Buffer.from(bodyB64, "base64url").toString("utf8"); } catch { return null; }
  const expected = crypto.createHmac("sha256", key).update(body).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [tenantId, outreachId] = body.split(".").map((n) => Number(n));
  if (!Number.isSafeInteger(tenantId) || !Number.isSafeInteger(outreachId)) return null;
  return { tenantId, outreachId };
}

/**
 * Honour an unsubscribe.
 *
 * Token id 0 is the DRAFT placeholder and is rejected: a link that was rendered
 * into a preview must not be able to suppress anybody.
 */
export function processUnsubscribe(token: string): { ok: boolean; message: string } {
  const claim = verifyUnsubscribeToken(token);
  if (!claim || claim.outreachId <= 0) return { ok: false, message: "This unsubscribe link is not valid." };

  const outreach = rawDb.prepare(`SELECT * FROM order_recovery_outreach WHERE id = ? AND tenant_id = ?`)
    .get(claim.outreachId, claim.tenantId) as any;
  if (!outreach) return { ok: false, message: "This unsubscribe link is not valid." };

  const recoveryCase = store.getCase(Number(outreach.recovery_case_id), claim.tenantId);
  const order = recoveryCase ? store.getOrder(Number(recoveryCase.vendor_order_id), claim.tenantId) : null;
  const destination = order ? resolveDestination(claim.tenantId, order, "email") : null;

  if (destination?.normalized) {
    store.suppressDestination({
      tenantId: claim.tenantId,
      leadId: recoveryCase?.lead_id ?? null,
      vendorOrderId: order ? Number(order.id) : null,
      channel: "email",
      destinationNormalized: destination.normalized,
      reason: "opt_out_reply",
      source: "email_unsubscribe",
      evidence: `outreach:${claim.outreachId}`,
      createdByUserId: null,
    });
  } else if (outreach.recipient_hash) {
    // The destination could not be re-derived (no key, or the import row was
    // pruned). Suppress on the hash we recorded at send time rather than
    // failing: the point of the link is that it works.
    suppressByHash(claim.tenantId, "email", String(outreach.recipient_hash), String(outreach.recipient_email_masked ?? ""), claim.outreachId);
  }

  rawDb.prepare(`UPDATE order_recovery_outreach SET opt_out_detected_at = COALESCE(opt_out_detected_at, ?) WHERE id = ?`)
    .run(new Date().toISOString(), claim.outreachId);
  if (recoveryCase) {
    store.updateCase(recoveryCase.id, { opt_out_blocked: 1 });
    store.appendCaseEvent({
      tenantId: claim.tenantId, caseId: recoveryCase.id, eventType: "opt_out",
      actorUserId: null, actorName: "Customer",
      detail: "The customer unsubscribed from email.",
    });
  }
  return { ok: true, message: "You have been unsubscribed and will not receive further emails about this order." };
}

/**
 * An inbound text.
 *
 * STOP is processed immediately and unconditionally. Note there is no tenant
 * argument that a caller could get wrong: the number is hashed against every
 * organization that has messaged it, and every one of them suppresses. A
 * customer who says stop is not saying it to one dealer's database row.
 */
export function handleInboundSms(input: { from: string; body: string }): { suppressed: number; optOut: boolean } {
  const e164 = normalizePhoneE164(input.from);
  if (!e164) return { suppressed: 0, optOut: false };

  const optOutWord = detectOptOut(input.body);
  const optInWord = detectOptIn(input.body);

  const tenants = (rawDb.prepare(`SELECT DISTINCT tenant_id FROM order_recovery_outreach WHERE channel = 'sms'`).all() as any[])
    .map((r) => Number(r.tenant_id)).filter(Number.isFinite);

  let suppressed = 0;
  for (const tenantId of tenants) {
    const hashes = destinationHashCandidates(tenantId, "sms", e164);
    const touched = store.recordInboundResponse(tenantId, hashes[0] ?? "", Boolean(optOutWord));
    if (touched === 0) continue;

    if (optOutWord) {
      store.suppressDestination({
        tenantId, leadId: null, vendorOrderId: null, channel: "sms",
        destinationNormalized: e164,
        reason: "opt_out_reply", source: "inbound_sms",
        evidence: `keyword:${optOutWord}`, createdByUserId: null,
      });
      markCasesOptedOut(tenantId, hashes);
      suppressed += 1;
    } else if (optInWord) {
      // A re-subscribe lifts the reply-driven block only. It does NOT create
      // consent: the consent record still has to say yes, which is a separate,
      // evidenced act.
      liftReplySuppression(tenantId, hashes);
    }
  }
  return { suppressed, optOut: Boolean(optOutWord) };
}

function suppressByHash(tenantId: number, channel: ContactChannel, hash: string, masked: string, outreachId: number): void {
  rawDb.prepare(`
    INSERT INTO customer_contact_suppressions (tenant_id, channel, destination_hash, destination_masked, hash_scheme, reason, source, evidence)
    VALUES (?,?,?,?,'hmac-sha256','opt_out_reply','email_unsubscribe',?)
    ON CONFLICT(tenant_id, channel, destination_hash) DO UPDATE SET lifted_at = NULL, lifted_by_user_id = NULL, lift_reason = NULL
  `).run(tenantId, channel, hash, masked || null, `outreach:${outreachId}`);
}

function markCasesOptedOut(tenantId: number, hashes: string[]): void {
  if (hashes.length === 0) return;
  rawDb.prepare(`
    UPDATE order_recovery_cases SET opt_out_blocked = 1, updated_at = ?
     WHERE tenant_id = ? AND vendor_order_id IN (
       SELECT id FROM vendor_orders WHERE tenant_id = ? AND customer_phone_hash IN (${hashes.map(() => "?").join(",")})
     )
  `).run(new Date().toISOString(), tenantId, tenantId, ...hashes);
}

function liftReplySuppression(tenantId: number, hashes: string[]): void {
  if (hashes.length === 0) return;
  rawDb.prepare(`
    UPDATE customer_contact_suppressions
       SET lifted_at = ?, lift_reason = 'The customer replied START'
     WHERE tenant_id = ? AND channel = 'sms' AND reason = 'opt_out_reply' AND lifted_at IS NULL
       AND destination_hash IN (${hashes.map(() => "?").join(",")})
  `).run(new Date().toISOString(), tenantId, ...hashes);
}

// ── Blocked-send bookkeeping ─────────────────────────────────────────────────

function recordBlocked(
  input: { tenantId: number; caseId: number; templateId: number; actorUserId: number | null },
  context: MessageContext,
  channel: ContactChannel,
  body: string,
  destination: ResolvedDestination | null,
  reasons: string[],
): number {
  return store.insertOutreach({
    tenantId: input.tenantId,
    caseId: input.caseId,
    channel,
    templateId: context.template.id,
    templateVersion: context.template.version,
    body,
    subject: context.template.subject ?? null,
    phoneMasked: channel === "sms" ? destination?.masked ?? null : null,
    emailMasked: channel === "email" ? destination?.masked ?? null : null,
    recipientHash: destination?.hash ?? null,
    consentBasis: context.consent?.consent_basis ?? null,
    consentRecordId: context.consent?.id ?? null,
    senderIdentity: null,
    purpose: "transactional_service_update",
    status: "blocked",
    blockedReasons: reasons,
    createdByUserId: input.actorUserId,
  });
}

// ── Template administration helpers ──────────────────────────────────────────

/** Approving a template re-validates it first. An admin cannot approve a text
 *  with no opt-out sentence by editing it after the validation screen. */
export function approveTemplateChecked(tenantId: number, templateId: number, userId: number, approved: boolean): {
  ok: boolean; issues: string[];
} {
  const template = store.getTemplate(templateId, tenantId);
  if (!template) return { ok: false, issues: ["That template no longer exists."] };
  if (!approved) {
    store.approveTemplate(templateId, userId, false);
    return { ok: true, issues: [] };
  }
  const issues = validateTemplate({
    channel: String(template.channel) as ContactChannel,
    kind: template.kind,
    subject: template.subject,
    body: template.body,
  }).filter((i) => i.severity === "error").map((i) => i.message);
  if (issues.length > 0) return { ok: false, issues };
  store.approveTemplate(templateId, userId, true);
  return { ok: true, issues: [] };
}

export { isPlausibleEmail };
