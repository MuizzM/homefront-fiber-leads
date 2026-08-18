import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isUnsafeHttpMethod, PORTAL_ALLOWED_METHODS } from "../../server/httpMethodPolicy";

describe("portal HTTP method policy", () => {
  it.each(["TRACE", "trace", "TRACK", "track", "CONNECT", "connect"])(
    "rejects %s",
    (method) => expect(isUnsafeHttpMethod(method)).toBe(true),
  );

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "permits the portal method %s",
    (method) => expect(isUnsafeHttpMethod(method)).toBe(false),
  );

  it("publishes an accurate Allow header and is wired before CSRF", () => {
    expect(PORTAL_ALLOWED_METHODS).toBe("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");

    const source = fs.readFileSync(path.resolve(__dirname, "../../server/index.ts"), "utf8");
    const methodPolicy = source.indexOf("isUnsafeHttpMethod(req.method)");
    const csrf = source.indexOf("if (CSRF_EXEMPT.has(req.path))");
    expect(methodPolicy).toBeGreaterThan(-1);
    expect(csrf).toBeGreaterThan(methodPolicy);
  });
});
