// ── Template rendering and approval, pinned ──────────────────────────────────
//
// A template is the only thing that produces the words we send, so the three
// refusals it is built around are the ones asserted here: unknown variables,
// empty substitutions, and injection through customer-controlled data.
//
// The last one is not theoretical. A customer name comes from whatever a rep
// typed at a door and then travelled through a provider's report; treating it
// as trusted markup in an HTML email is how a name becomes a link.

import { describe, expect, it } from "vitest";
import {
  SEED_TEMPLATES, TEMPLATE_KINDS, TEMPLATE_VARIABLES,
  escapeHtmlValue, renderTemplate, validateTemplate,
} from "@shared/orderRecoveryTemplates";
import { SMS_OPT_OUT_SENTENCE, bodyCarriesOptOut } from "@shared/contactConsent";

const VALUES = {
  customer_first_name: "Jane",
  carrier: "Kinetic",
  product_sold: "Fiber 1 Gig",
  program: "Door to Door",
  service_address: "123 N Main St",
  install_date: "2026-08-14",
  support_phone: "704-555-0100",
  rep_name: "Sam Rivera",
  company_name: "Home Front Solutions",
  company_address: "1 Example Way, Charlotte NC 28202",
  callback_link: "https://example.com/callback",
  unsubscribe_link: "https://example.com/api/order-recovery/unsubscribe?token=abc",
};

describe("renderTemplate", () => {
  it("substitutes every known variable", () => {
    const out = renderTemplate("Hi {{customer_first_name}}, your {{carrier}} order.", VALUES);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("Hi Jane, your Kinetic order.");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{ customer_first_name }}", VALUES).text).toBe("Hi Jane");
  });

  it("refuses an unknown variable rather than shipping a hole", () => {
    const out = renderTemplate("Hi {{ballance}}", VALUES);
    expect(out.ok).toBe(false);
    expect(out.unknownVariables).toEqual(["ballance"]);
    // The token is left verbatim so an admin previewing sees WHICH one is wrong.
    expect(out.text).toContain("{{ballance}}");
  });

  it("refuses an empty value rather than greeting nobody", () => {
    const out = renderTemplate("Hi {{customer_first_name}}", { ...VALUES, customer_first_name: null });
    expect(out.ok).toBe(false);
    expect(out.missingValues).toEqual(["customer_first_name"]);
  });

  it("treats a whitespace-only value as missing", () => {
    const out = renderTemplate("Hi {{customer_first_name}}", { ...VALUES, customer_first_name: "   " });
    expect(out.ok).toBe(false);
    expect(out.missingValues).toEqual(["customer_first_name"]);
  });

  it("escapes customer data when rendering for HTML", () => {
    const hostile = { ...VALUES, customer_first_name: '<img src=x onerror="alert(1)">' };
    const out = renderTemplate("Hi {{customer_first_name}}", hostile, escapeHtmlValue);
    expect(out.text).not.toContain("<img");
    expect(out.text).toContain("&lt;img");
    expect(out.text).not.toContain("onerror=\"");
  });

  it("does not escape the template's own literal text", () => {
    const out = renderTemplate("<p>Hi {{customer_first_name}}</p>", VALUES, escapeHtmlValue);
    expect(out.text).toBe("<p>Hi Jane</p>");
  });

  it("never treats braces inside customer data as a placeholder", () => {
    const out = renderTemplate("Hi {{customer_first_name}}", { ...VALUES, customer_first_name: "{{support_phone}}" });
    expect(out.text).toBe("Hi {{support_phone}}");
    expect(out.ok).toBe(true);
  });
});

describe("validateTemplate", () => {
  const sms = (body: string) => validateTemplate({ channel: "sms", kind: "customer_action", subject: null, body });
  const email = (body: string, subject: string | null = "Action needed") =>
    validateTemplate({ channel: "email", kind: "customer_action", subject, body });

  it("refuses an empty body", () => {
    expect(sms("   ").map((i) => i.code)).toContain("EMPTY_BODY");
  });

  it("refuses a text with no opt-out wording", () => {
    expect(sms("Hi {{customer_first_name}}, call {{support_phone}}.").map((i) => i.code)).toContain("NO_OPT_OUT");
    expect(sms(`Hi. ${SMS_OPT_OUT_SENTENCE}`).filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("refuses an unknown variable", () => {
    expect(sms(`Hi {{nope}}. ${SMS_OPT_OUT_SENTENCE}`).map((i) => i.code)).toContain("UNKNOWN_VARIABLE");
  });

  it("refuses an email-only variable in a text", () => {
    expect(sms(`Hi. {{unsubscribe_link}} ${SMS_OPT_OUT_SENTENCE}`).map((i) => i.code)).toContain("EMAIL_ONLY_VARIABLE");
  });

  it("warns about a text long enough to split into several segments", () => {
    const long = `${"x".repeat(400)} ${SMS_OPT_OUT_SENTENCE}`;
    expect(sms(long).map((i) => i.code)).toContain("SMS_LENGTH");
    expect(sms(long).filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("requires a subject, an unsubscribe link and a postal address on email", () => {
    expect(email("Hi", null).map((i) => i.code)).toContain("NO_SUBJECT");
    expect(email("Hi {{company_address}}").map((i) => i.code)).toContain("NO_UNSUBSCRIBE");
    expect(email("Hi {{unsubscribe_link}}").map((i) => i.code)).toContain("NO_POSTAL_ADDRESS");
    const good = email("Hi {{customer_first_name}} from {{company_name}}. {{company_address}} {{unsubscribe_link}}");
    expect(good.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("refuses a subject that fakes a reply", () => {
    const codes = email("Hi {{company_address}} {{unsubscribe_link}}", "Re: your order").map((i) => i.code);
    expect(codes).toContain("DECEPTIVE_SUBJECT");
  });

  it("warns when the message never says who it is from", () => {
    expect(sms(`Your order needs an update. ${SMS_OPT_OUT_SENTENCE}`).map((i) => i.code))
      .toContain("NO_SENDER_IDENTITY");
  });
});

describe("the seeded set", () => {
  it("passes its own validator, so nothing ships that cannot be approved", () => {
    for (const seed of SEED_TEMPLATES) {
      const issues = validateTemplate({
        channel: seed.channel, kind: seed.kind, subject: seed.subject, body: seed.body,
      }).filter((i) => i.severity === "error");
      expect(issues, `${seed.name}: ${issues.map((i) => i.message).join("; ")}`).toHaveLength(0);
    }
  });

  it("renders every seeded template completely from a full value set", () => {
    for (const seed of SEED_TEMPLATES) {
      const body = renderTemplate(seed.body, VALUES);
      expect(body.ok, `${seed.name} body: ${body.unknownVariables.concat(body.missingValues).join(", ")}`).toBe(true);
      if (seed.subject) {
        const subject = renderTemplate(seed.subject, VALUES);
        expect(subject.ok, `${seed.name} subject`).toBe(true);
      }
    }
  });

  it("puts the opt-out sentence in every text", () => {
    for (const seed of SEED_TEMPLATES.filter((s) => s.channel === "sms")) {
      expect(bodyCarriesOptOut(seed.body), seed.name).toBe(true);
    }
  });

  it("uses only variables the engine knows about", () => {
    const known = new Set<string>(TEMPLATE_VARIABLES);
    for (const seed of SEED_TEMPLATES) {
      const used = [...`${seed.subject ?? ""} ${seed.body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
      for (const name of used) expect(known.has(name), `${seed.name} uses {{${name}}}`).toBe(true);
    }
  });

  it("covers every template kind the brief asks for", () => {
    const covered = new Set(SEED_TEMPLATES.map((s) => s.kind));
    for (const kind of TEMPLATE_KINDS) {
      expect(covered.has(kind), `no seeded template for ${kind}`).toBe(true);
    }
  });
});
