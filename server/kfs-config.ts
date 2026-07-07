// ── Kinetic fiber-scan endpoint config ────────────────────────────────────────
// HomeFront replicates the way FiberFocus scans Kinetic fiber: it talks to the
// real Kinetic (gokinetic) v2 address API directly with a bearer token — no
// dependency on any third-party proxy. Base host is overridable via KFS_BASE_URL
// so it can be repointed (e.g. at a self-hosted proxy) without code changes.
export const KFS_BASE_URL = (process.env.KFS_BASE_URL || "https://buy.gokinetic.com").replace(/\/+$/, "");

// The v2 address/fiber search endpoint used by every scanner.
export const KFS_SCAN_URL = `${KFS_BASE_URL}/api/v2/address/search`;

// Referer/Origin the Kinetic upstream expects — kept consistent with the base host.
export const KFS_REFERER = `${KFS_BASE_URL}/`;
export const KFS_ORIGIN = KFS_BASE_URL;
