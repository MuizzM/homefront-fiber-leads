// ── Quick links — one-tap research for THIS address ──────────────────────────
// The SalesRabbit "Quick Links" tab, scoped to what a fiber rep actually opens
// at a door: the street view of the house, its listing, the FCC's broadband
// claim for the address, and the sky. Every link is a plain external deep link
// built from data the card already holds — no API calls, no keys, target
// _blank + noopener. Links that need coordinates hide without them (never a
// dead affordance).

import { MUTED } from "./utils";

export interface QuickLinksProps {
  address: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
}

interface QuickLink { key: string; label: string; href: string }

export function buildQuickLinks(p: QuickLinksProps): QuickLink[] {
  const full = [p.address, p.city, p.state, p.zip].filter(Boolean).join(", ");
  const enc = encodeURIComponent(full);
  const links: QuickLink[] = [];
  if (p.lat != null && p.lng != null) {
    links.push({
      key: "streetview", label: "Street View",
      // Official Maps URL API — pano nearest to the door's coordinates.
      href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}`,
    });
  }
  links.push({
    key: "zillow", label: "Zillow",
    href: `https://www.zillow.com/homes/${enc}_rb/`,
  });
  links.push({
    key: "fcc", label: "FCC map",
    href: `https://broadbandmap.fcc.gov/location-summary/fixed?addr=${enc}`,
  });
  const wx = p.zip || p.city;
  if (wx) {
    links.push({
      key: "weather", label: "Weather",
      href: `https://www.google.com/search?q=${encodeURIComponent(`weather ${wx}`)}`,
    });
  }
  return links;
}

export function QuickLinks(props: QuickLinksProps): JSX.Element | null {
  const links = buildQuickLinks(props);
  if (!links.length) return null;
  return (
    <div data-testid="knock-quick-links" className="mt-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mb-2" style={{ color: MUTED }}>
        Quick links
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {links.map(({ key, label, href }) => (
          <a
            key={key}
            data-testid={`quick-link-${key}`}
            href={href}
            target="_blank"
            rel="noopener"
            title={`${label}: opens in a new tab`}
            className="h-10 px-3.5 rounded-full bg-white/[0.06] border border-white/15 text-white/75 text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center hover:text-white hover:bg-white/[0.1] tap-press"
          >
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}

export default QuickLinks;
