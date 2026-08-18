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

  it("rejects unsafe methods at the Caddy edge too", () => {
    const caddy = fs.readFileSync(path.resolve(__dirname, "../../deploy/caddy/Caddyfile"), "utf8");
    expect(caddy).toMatch(/@unsafe_methods\s+method\s+TRACE\s+TRACK\s+CONNECT/);
    expect(caddy).toMatch(/respond\s+@unsafe_methods\s+405/);
  });

  it("deploys and verifies the edge policy instead of leaving a stale bind mount", () => {
    const compose = fs.readFileSync(path.resolve(__dirname, "../../docker-compose.production.yml"), "utf8");
    const deploy = fs.readFileSync(path.resolve(__dirname, "../../scripts/deploy.sh"), "utf8");
    expect(compose).toContain("./deploy/caddy:/etc/caddy:ro");
    expect(deploy).toContain("caddy:2 validate --config /etc/caddy/Caddyfile");
    expect(deploy).toContain("caddy reload --config /etc/caddy/Caddyfile");
    expect(deploy).toContain("TRACE TRACK CONNECT");
    expect(deploy).toContain('expected 405');
  });
});
