// ── Money display — integer cents in, formatted USD out ──────────────────────
// One formatter for every commission surface so $1,600 never renders three ways.
export function usd(cents: number | null | undefined): string {
  const n = (cents ?? 0) / 100;
  return n.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// Signed variant for adjustments: +$50 / −$325.
export function usdSigned(cents: number | null | undefined): string {
  const c = cents ?? 0;
  return `${c > 0 ? "+" : c < 0 ? "-" : ""}${usd(Math.abs(c))}`;
}
