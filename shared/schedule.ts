// ── Schedule calendar math ────────────────────────────────────────────────────
// PURE and framework-free. Dates are local-calendar "YYYY-MM-DD" strings, the
// same shape callbacks are stored in (see todayISO in shared/knock.ts): a rep's
// appointment is the day they picked on their phone, never a UTC instant, so
// every helper here stays in local calendar space and never calls toISOString.

export interface ScheduleFix { lat: number; lng: number }

function parseISO(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `iso` shifted by `days` whole local days (negative allowed). */
export function addDaysISO(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** The seven local dates Monday..Sunday of the week containing `iso`. */
export function weekOf(iso: string): string[] {
  const d = parseISO(iso);
  // getDay(): 0 = Sunday. Monday-first weeks, the way a field schedule reads.
  const offsetToMonday = (d.getDay() + 6) % 7;
  const monday = addDaysISO(iso, -offsetToMonday);
  return Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
}

// ── Quick appointment slots ──────────────────────────────────────────────────
// The four soonest sensible return-visit times, so a rep books with one tap
// instead of two pickers. Working hours are 9:00 to 19:00 local; a "today"
// slot only appears while there is still a working half hour left, rounded UP
// to the next half hour plus a 30 minute buffer so the rep can actually get
// there. Tomorrow and the next weekend day follow, then the next Monday.
export interface QuickSlot {
  /** "Today 5:30 PM", "Tomorrow 10 AM", "Sat 2 PM", "Mon 9 AM" */
  label: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM (24h), what the knock route stores
}

const OPEN_MIN = 9 * 60, CLOSE_MIN = 19 * 60;

function fmtSlotTime(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const ap = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hr} ${ap}` : `${hr}:${String(m).padStart(2, "0")} ${ap}`;
}
function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * @param now local wall-clock time of the device
 * @returns up to four slots, soonest first, never in the past
 */
export function quickSlots(now: Date): QuickSlot[] {
  const today = toISODate(now);
  const slots: QuickSlot[] = [];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Next half hour after a 30 minute buffer: 4:52 PM -> 5:30 PM.
  const nextHalf = Math.ceil((nowMin + 30) / 30) * 30;
  const todayMin = Math.max(nextHalf, OPEN_MIN);
  if (todayMin < CLOSE_MIN) {
    slots.push({ label: `Today ${fmtSlotTime(todayMin)}`, date: today, time: hhmm(todayMin) });
  }
  const tomorrow = addDaysISO(today, 1);
  slots.push({ label: `Tomorrow ${fmtSlotTime(10 * 60)}`, date: tomorrow, time: "10:00" });
  // The next Saturday after tomorrow (weekend visits catch people at home).
  const dow = parseISO(today).getDay(); // 0 Sun .. 6 Sat
  let toSat = (6 - dow + 7) % 7;
  if (toSat <= 1) toSat += 7;
  slots.push({ label: `Sat ${fmtSlotTime(14 * 60)}`, date: addDaysISO(today, toSat), time: "14:00" });
  let toMon = (1 - dow + 7) % 7;
  if (toMon <= 1) toMon += 7;
  slots.push({ label: `Mon ${fmtSlotTime(9 * 60)}`, date: addDaysISO(today, toMon), time: "09:00" });
  return slots.slice(0, 4);
}

/**
 * "today 5:30 PM", "tomorrow 10 AM", "Sat, Aug 29 2 PM", "Sat, Aug 29" - the
 * words a confirm button uses so the rep reads what they are about to book.
 * `today` is injectable for tests; defaults to the device's local date.
 */
export function describeAppointment(date: string, time: string | null | undefined, today = toISODate(new Date())): string {
  const day = date === today ? "today"
    : date === addDaysISO(today, 1) ? "tomorrow"
    : parseISO(date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (!time) return day;
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h)) return day;
  return `${day} ${fmtSlotTime(h * 60 + (Number.isFinite(m) ? m : 0))}`;
}
