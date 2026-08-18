import crypto from "node:crypto";

// Keep correlation IDs useful in headers and one-line logs. Reverse proxies
// commonly use UUIDs, trace IDs, dots, colons and dashes; everything else is
// rejected rather than echoed into responses, logs or commission audit rows.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function safeRequestId(
  header: unknown,
  mint: () => string = () => crypto.randomUUID(),
): string {
  return typeof header === "string" && SAFE_REQUEST_ID.test(header)
    ? header
    : mint();
}
