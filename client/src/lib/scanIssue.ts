export type ScanIssueKind = "address_correction" | "auth_retry" | "provider_issue" | null;

export interface ScanIssueInput {
  stage?: string | null;
  httpStatus?: number | null;
  detail?: string | null;
  retryReason?: string | null;
}

/**
 * Translate pipeline mechanics into the operator-facing cause. A Kinetic HTTP
 * 200 that asks for a corrected address is not a Cloudflare or Decodo failure.
 */
export function classifyScanIssue(input: ScanIssueInput): ScanIssueKind {
  const text = `${input.detail ?? ""} ${input.retryReason ?? ""}`.toLowerCase();
  if (/addressneedsfix|addresssuggestion|address[_ -]?identity|echoed-address|needs correction/.test(text)) {
    return "address_correction";
  }
  if (input.stage === "retry" || input.httpStatus === 401 || input.httpStatus === 403) {
    return "auth_retry";
  }
  if (["error", "blocked", "bad_request"].includes(String(input.stage ?? ""))) {
    return "provider_issue";
  }
  return null;
}

export function scanIssueLabel(kind: ScanIssueKind): string | null {
  if (kind === "address_correction") return "Address correction";
  if (kind === "auth_retry") return "Session retry";
  if (kind === "provider_issue") return "Provider issue";
  return null;
}
