// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResendDeliveryError, sendResendEmail } from "../../server/resendMail";
const message = { from: "Frozen <sender@example.invalid>", to: "receiver@example.invalid", subject: "Fixture", html: "Fixture", text: "Fixture", idempotencyKey: "fixture-stable-key" };
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", "fixture-key"); vi.stubEnv("RESEND_DELIVERY_MODE", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each([[409, "concurrent_idempotent_requests", true], [409, "invalid_idempotent_request", false], [429, "rate_limit_exceeded", true], [500, "server_error", true], [400, "validation_error", false]])("classifies HTTP %s %s safely", async (status, name, retryable) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ name, message: "private recipient text" }, { status: Number(status) })));
  await expect(sendResendEmail(message)).rejects.toMatchObject({ retryable });
  await expect(sendResendEmail(message)).rejects.not.toThrow("private recipient");
});
it("requires a provider receipt even after HTTP success and freezes body/from/key", async () => {
  const fetcher = vi.fn(async () => Response.json({ id: "" })); vi.stubGlobal("fetch", fetcher);
  await expect(sendResendEmail(message)).rejects.toBeInstanceOf(ResendDeliveryError);
  expect((fetcher.mock.calls[0] as any)[1]).toMatchObject({ headers: expect.objectContaining({ "Idempotency-Key": message.idempotencyKey }), body: expect.stringContaining(message.from) });
});
it("passes actual cancellation to the transport", async () => {
  const stop = new AbortController();
  vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  })));
  const delivery = sendResendEmail({ ...message, signal: stop.signal }); stop.abort(new Error("fixture stop"));
  await expect(delivery).rejects.toThrow("fixture stop");
});
