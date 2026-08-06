/** Formula-safe CSV for data that will be opened in spreadsheet software. */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Neutralize spreadsheet formulas even when an attacker hides the trigger
  // behind spaces/tabs. The apostrophe is the standard literal-text marker.
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(","))].join("\n") + "\n";
}

/** The read half: RFC-4180 text → raw rows of raw fields, and nothing else.
 *
 *  This is the ONE row tokenizer. Three callers used to carry their own copy
 *  (stateMonitorStore, addressDiscovery/sources, tracerfyClient) and each had
 *  independently accreted slightly different newline handling, so an edge case
 *  fixed in one stayed broken in the other two. The strictest of the three
 *  survives here: quoted fields may contain commas and newlines, `""` is an
 *  escaped quote, and a row ends at `\n`, `\r\n` or a lone `\r`.
 *
 *  Deliberately does NOT map headers, trim, lowercase, or drop blank rows —
 *  those are per-caller contracts (record keys are wire format for some
 *  callers, normalised for others), so each caller keeps its own 2-3 line
 *  adapter on top and its output stays byte-identical. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      // \r\n is one break, not two.
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** True when a tokenized row carries no content — the shape every caller uses
 *  to drop blank lines (and the trailing row a file's final newline leaves). */
export function isBlankCsvRow(row: string[]): boolean {
  return !row.some((v) => v !== "");
}
