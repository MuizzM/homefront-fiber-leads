// ── Kinetic fiber-scan endpoint config ────────────────────────────────────────
// Environment-configured endpoint for an authorized Kinetic availability
// integration. KFS_BASE_URL also supports a licensed partner gateway in front
// of the carrier endpoint without changing application code.
export const KFS_BASE_URL = (process.env.KFS_BASE_URL || "https://buy.gokinetic.com").replace(/\/+$/, "");

// Confirmed permissioned address-search contract used by every scanner.
export const KFS_SCAN_URL = `${KFS_BASE_URL}/api/v1/address/search`;

// Referer/Origin the Kinetic upstream expects — kept consistent with the base host.
export const KFS_REFERER = `${KFS_BASE_URL}/`;
export const KFS_ORIGIN = KFS_BASE_URL;
