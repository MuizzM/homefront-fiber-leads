// ── Gusto adapter (SDK-free payroll seam) ─────────────────────────────────────
// The payroll-provider seam behind the HR onboarding pipeline. Talks to Gusto
// over its REST API (no npm dependency), mirroring stripeAdapter.ts.
//
// FULLY INERT WITHOUT KEYS: every entry point checks gustoConfigured(). With no
// token the "Confirm in Gusto" action still works as a MANUAL confirmation (the
// admin creates the employee in Gusto and records the employee id here) — the
// API is only ever used to VERIFY connectivity, never to move payroll on its
// own. So shipping this changes nothing until you set the env vars.
//
// Optional env to enable the connectivity check (you set these; I never handle
// them):
//   GUSTO_API_TOKEN     access token for the Gusto REST API
//   GUSTO_COMPANY_ID    the company UUID employees are created under
//   GUSTO_API_BASE      override (defaults to the production API host)

const GUSTO_API = process.env.GUSTO_API_BASE || "https://api.gusto.com";

export function gustoConfigured(): boolean {
  return !!(process.env.GUSTO_API_TOKEN && process.env.GUSTO_COMPANY_ID);
}

export interface GustoVerifyResult {
  configured: boolean;
  ok: boolean;
  companyName: string | null;
  message: string;
}

/**
 * Best-effort connectivity check. Never throws — a payroll integration must
 * never take down the onboarding console. Returns configured:false (and does no
 * network) when the env vars are absent, which is the shipped default.
 */
export async function verifyGustoConnection(): Promise<GustoVerifyResult> {
  if (!gustoConfigured()) {
    return {
      configured: false,
      ok: false,
      companyName: null,
      message: "Gusto is not connected. Set GUSTO_API_TOKEN and GUSTO_COMPANY_ID to enable the connectivity check. You can still confirm employees manually.",
    };
  }
  const companyId = String(process.env.GUSTO_COMPANY_ID);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${GUSTO_API}/v1/companies/${encodeURIComponent(companyId)}`, {
      headers: {
        Authorization: `Bearer ${process.env.GUSTO_API_TOKEN}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) {
      return {
        configured: true,
        ok: false,
        companyName: null,
        message: `Gusto rejected the connection (HTTP ${res.status}). Check the API token and company id.`,
      };
    }
    const body: any = await res.json().catch(() => ({}));
    const companyName = typeof body?.name === "string" ? body.name : null;
    return {
      configured: true,
      ok: true,
      companyName,
      message: companyName ? `Connected to ${companyName}.` : "Gusto connection verified.",
    };
  } catch (error: any) {
    return {
      configured: true,
      ok: false,
      companyName: null,
      message: `Could not reach Gusto: ${error?.message ?? String(error)}.`,
    };
  }
}
