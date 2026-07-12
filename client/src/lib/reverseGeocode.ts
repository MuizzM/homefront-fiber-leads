// ── Tap-a-house: turn a tapped map point into a street address ────────────────
// Thin client over GET /api/geocode/reverse (server-side Mapbox + cache). Lets a
// rep tap a rooftop and get the address without typing it.
import { apiRequest } from "@/lib/queryClient";

export interface TappedAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
  placeName: string;
  cached?: boolean;
}

export async function reverseGeocode(lat: number, lng: number): Promise<TappedAddress> {
  const res = await apiRequest("GET", `/api/geocode/reverse?lat=${lat}&lng=${lng}`);
  return res.json();
}

/** One-line "123 Main St, Inman SC 29349" from any address-ish object. */
export function formatFullAddress(a: { address: string; city?: string | null; state?: string | null; zip?: string | null }): string {
  const tail = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return tail ? `${a.address}, ${tail}` : a.address;
}
