import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  canOpenSigning,
  normalizeDocusignStatus,
  parseDocusignConnectEvent,
  shouldApplyDocumentStatus,
} from "../../shared/onboardingDocuments";
import { verifyDocusignHmac } from "../../server/docusignAdapter";

const originalHmacSecret = process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
afterEach(() => {
  if (originalHmacSecret === undefined) delete process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
  else process.env.DOCUSIGN_CONNECT_HMAC_SECRET = originalHmacSecret;
});

describe("onboarding document state", () => {
  it("normalizes supported DocuSign envelope states", () => {
    expect(normalizeDocusignStatus("created")).toBe("sent");
    expect(normalizeDocusignStatus("Delivered")).toBe("delivered");
    expect(normalizeDocusignStatus("signed")).toBe("completed");
    expect(normalizeDocusignStatus("unknown")).toBeNull();
  });

  it("never downgrades a completed or otherwise terminal envelope", () => {
    expect(shouldApplyDocumentStatus("sent", "delivered")).toBe(true);
    expect(shouldApplyDocumentStatus("delivered", "sent")).toBe(false);
    expect(shouldApplyDocumentStatus("completed", "delivered")).toBe(false);
    expect(shouldApplyDocumentStatus("declined", "completed")).toBe(false);
  });

  it("allows embedded signing only while an envelope awaits a signature", () => {
    expect(canOpenSigning("sent")).toBe(true);
    expect(canOpenSigning("delivered")).toBe(true);
    expect(canOpenSigning("completed")).toBe(false);
    expect(canOpenSigning("failed")).toBe(false);
  });

  it("parses current JSON Connect envelope events", () => {
    expect(parseDocusignConnectEvent({
      event: "envelope-completed",
      generatedDateTime: "2026-07-13T12:00:00Z",
      data: { envelopeId: "env-1", envelopeSummary: { status: "completed" } },
    })).toEqual({
      envelopeId: "env-1",
      status: "completed",
      eventType: "envelope-completed",
      occurredAt: "2026-07-13T12:00:00Z",
    });
    expect(parseDocusignConnectEvent({ event: "recipient-viewed", data: {} })).toBeNull();
  });

  it("accepts only a valid DocuSign Connect HMAC for the exact raw body", () => {
    process.env.DOCUSIGN_CONNECT_HMAC_SECRET = "test-connect-secret";
    const body = Buffer.from('{"event":"envelope-completed"}');
    const signature = crypto.createHmac("sha256", "test-connect-secret").update(body).digest("base64");
    expect(verifyDocusignHmac(body, signature)).toBe(true);
    expect(verifyDocusignHmac(Buffer.from(`${body.toString()} `), signature)).toBe(false);
    expect(verifyDocusignHmac(body, "not-a-valid-signature")).toBe(false);
  });
});
