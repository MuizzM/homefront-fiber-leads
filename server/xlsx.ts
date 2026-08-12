// ── XLSX reading, without a dependency ───────────────────────────────────────
//
// An admin exporting a Salesforce report gets a choice of CSV or XLSX, and half
// of them will pick XLSX. Refusing it would push a manual conversion step into
// the middle of a compliance-sensitive workflow, which is where mistakes get
// made - so this reads the format directly.
//
// WHY NOT A LIBRARY. The spreadsheet libraries in this ecosystem are large,
// parse far more of the format than an import needs, and have a history of
// prototype-pollution and formula-evaluation issues. This reads exactly four
// parts of the package and evaluates nothing:
//
//   xl/workbook.xml            which sheets exist and in what order
//   xl/_rels/workbook.xml.rels which file each sheet lives in
//   xl/sharedStrings.xml       the string pool
//   xl/styles.xml              enough to tell a date from a number
//
// WHAT IT DELIBERATELY DOES NOT DO. No formulas (the cached value is read, the
// expression is ignored), no charts, no macros, no external links, no defined
// names. A macro-enabled workbook is refused at the sniffing layer before it
// reaches here.
//
// The output is the same shape parseCsvRows produces - a header row and data
// rows of strings - so everything downstream is identical whichever format the
// admin uploaded.

import { inflateRawSync, inflateSync } from "node:zlib";

/** Bounds. A report row is a customer order; anything past these is a mistake
 *  or an attack, and reading it into memory first is how a 30 MB upload becomes
 *  a 3 GB heap. */
export const MAX_XLSX_ROWS = 200_000;
export const MAX_XLSX_COLUMNS = 512;
/** Guard against a zip bomb: a spreadsheet that inflates past this is refused. */
const MAX_INFLATED_PART_BYTES = 200 * 1024 * 1024;

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxError";
  }
}

// ── ZIP ──────────────────────────────────────────────────────────────────────

interface ZipEntry { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number }

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

function findEocd(buf: Buffer): number {
  // The comment field can be up to 64 KB, so the record is somewhere in the
  // last 64 KB + 22 bytes. Scan backwards; the first hit from the end is the
  // real one for every archive a spreadsheet tool produces.
  const start = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new XlsxError("This file is not a readable spreadsheet.");

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64, for the rare very large export. Only the two fields an import cares
  // about are read from the ZIP64 record.
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        entryCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readPart(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LFH_SIG) {
    throw new XlsxError("This spreadsheet is damaged and cannot be read.");
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;

  // Streamed archives set sizes to zero in the local header and rely on a data
  // descriptor; the central directory always has the truth, so use that.
  const size = entry.compressedSize;
  const data = buf.subarray(dataStart, size > 0 ? dataStart + size : undefined);

  if (entry.uncompressedSize > MAX_INFLATED_PART_BYTES) {
    throw new XlsxError("This spreadsheet is too large to import.");
  }
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_INFLATED_PART_BYTES });
    } catch {
      // A few writers emit zlib-wrapped members. Try the wrapped form before
      // declaring the file unreadable.
      return inflateSync(data, { maxOutputLength: MAX_INFLATED_PART_BYTES });
    }
  }
  throw new XlsxError("This spreadsheet uses a compression method this importer does not support.");
}

/** The four magic bytes every ZIP-based Office file starts with. Sniffed rather
 *  than trusting the extension, same principle as server/uploadSniff.ts. */
export function looksLikeXlsx(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08);
}

// ── XML ──────────────────────────────────────────────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(code: number): string {
  if (code < 0 || code > 0x10ffff) return "";
  try { return String.fromCodePoint(code); } catch { return ""; }
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
}

// ── Shared strings ───────────────────────────────────────────────────────────

/**
 * The string pool.
 *
 * A shared string is a <si> that either holds one <t> or a run of <r><t> pieces
 * (mixed formatting inside one cell). Concatenating the runs is what stops a
 * cell that happens to be bold in the middle from importing as half a value.
 * <rPh> phonetic runs are stripped: they are pronunciation hints, not content.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) != null) {
    const body = m[1] ?? "";
    if (!body) { out.push(""); continue; }
    const withoutPhonetic = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(withoutPhonetic)) != null) text += decodeXml(t[1] ?? "");
    out.push(text);
  }
  return out;
}

// ── Styles: telling a date from a number ─────────────────────────────────────

/** Built-in number-format ids that mean a date or a time. Fixed by the format
 *  and identical in every workbook. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/**
 * Which cell styles render as a date.
 *
 * Without this, an install date comes back as 45871 and the mapping validator
 * rejects the column as unparseable. `parseVendorDate` does understand serials,
 * but only inside a plausibility band - reading the style is what makes a date
 * cell unambiguous instead of a number that looks about right.
 */
function parseDateStyles(xml: string): Set<number> {
  const custom = new Set<number>();
  const numFmtRe = /<numFmt\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = numFmtRe.exec(xml)) != null) {
    const id = Number(attr(m[0], "numFmtId"));
    const code = attr(m[0], "formatCode") ?? "";
    if (!Number.isFinite(id)) continue;
    // Strip quoted literals and colour/condition sections before looking for
    // date tokens, or a currency format like [$-409]#,##0.00 reads as a date.
    const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
    if (/[dmyhs]/i.test(stripped) && !/^[#0.,%\s]*$/.test(stripped)) custom.add(id);
  }

  const dateXfIndexes = new Set<number>();
  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfsBlock) return dateXfIndexes;
  const xfRe = /<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g;
  let index = 0;
  let xf: RegExpExecArray | null;
  while ((xf = xfRe.exec(cellXfsBlock[1])) != null) {
    const numFmtId = Number(attr(xf[0], "numFmtId") ?? "0");
    if (Number.isFinite(numFmtId) && (BUILTIN_DATE_FORMATS.has(numFmtId) || custom.has(numFmtId))) {
      dateXfIndexes.add(index);
    }
    index += 1;
  }
  return dateXfIndexes;
}

/** Excel's day-zero, with the 1900 leap-year bug baked in exactly as Excel has
 *  it. Shared with shared/orderStatusSource.ts by value, not by import, because
 *  that module must stay free of any server dependency. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function serialToIso(serial: number): string {
  const ms = EXCEL_EPOCH_UTC + Math.round(serial * 86_400_000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  // A whole-day serial is a date; a fractional one carries a time. Emitting the
  // date-only form for whole days keeps them timezone-free, which is what the
  // downstream date parser wants.
  return Number.isInteger(serial)
    ? d.toISOString().slice(0, 10)
    : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── Cells and sheets ─────────────────────────────────────────────────────────

/** "BC12" -> 54. Column letters are base-26 with no zero. */
function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseSheet(xml: string, shared: string[], dateStyles: Set<number>): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(xml)) != null) {
    if (rows.length >= MAX_XLSX_ROWS) break;
    const body = rowMatch[2] ?? "";
    const cells: string[] = [];

    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cellMatch: RegExpExecArray | null;
    let autoIndex = 0;

    while ((cellMatch = cellRe.exec(body)) != null) {
      const openTag = `<c${cellMatch[1] ?? cellMatch[3] ?? ""}>`;
      const inner = cellMatch[2] ?? "";
      const ref = attr(openTag, "r");
      // Empty cells are omitted from the XML entirely. Placing each cell at the
      // index its reference names is what stops a row with a blank third column
      // from shifting every later value one place left.
      const col = ref ? columnIndex(ref) : autoIndex;
      autoIndex = col + 1;
      if (col < 0 || col >= MAX_XLSX_COLUMNS) continue;
      while (cells.length < col) cells.push("");
      cells[col] = cellValue(openTag, inner, shared, dateStyles);
    }

    rows.push(cells);
  }
  return rows;
}

function cellValue(openTag: string, inner: string, shared: string[], dateStyles: Set<number>): string {
  const type = attr(openTag, "t") ?? "n";

  if (type === "s") {
    const idx = Number(firstTagText(inner, "v"));
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : "";
  }
  if (type === "inlineStr") {
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner)) != null) text += decodeXml(t[1] ?? "");
    return text;
  }
  if (type === "b") {
    return firstTagText(inner, "v") === "1" ? "TRUE" : "FALSE";
  }
  if (type === "e") {
    // A formula error cell (#N/A, #REF!). Returned verbatim so cleanText can
    // drop it rather than having it silently become a value.
    return firstTagText(inner, "v") ?? "";
  }
  // "str" is a formula's cached string result; "n" and an absent t are numeric.
  const raw = firstTagText(inner, "v");
  if (raw == null || raw === "") return "";
  if (type === "str") return raw;

  const styleIndex = Number(attr(openTag, "s") ?? "-1");
  const num = Number(raw);
  if (Number.isFinite(num) && Number.isInteger(styleIndex) && dateStyles.has(styleIndex)) {
    return serialToIso(num);
  }
  return raw;
}

function firstTagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]) : null;
}

// ── The entry point ──────────────────────────────────────────────────────────

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

/**
 * Read the first worksheet of a workbook.
 *
 * "First" means first in the workbook's own sheet order, resolved through the
 * relationship file - NOT `sheet1.xml`, which is a file name that has nothing
 * to do with tab order and is the classic way an importer reads the wrong tab
 * of a report that has a summary sheet in front of the data.
 */
export function readXlsxFirstSheet(content: Buffer): XlsxSheet {
  const entries = readCentralDirectory(content);
  if (entries.length === 0) throw new XlsxError("This spreadsheet appears to be empty.");

  const byName = new Map(entries.map((e) => [e.name.replace(/^\/+/, ""), e]));
  const text = (name: string): string | null => {
    const entry = byName.get(name);
    if (!entry) return null;
    try { return readPart(content, entry).toString("utf8"); } catch { return null; }
  };

  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new XlsxError("This file is not an Excel workbook.");

  const sheetTag = /<sheet\b[^>]*\/>|<sheet\b[^>]*>/.exec(workbook);
  if (!sheetTag) throw new XlsxError("This workbook has no sheets.");
  const sheetName = attr(sheetTag[0], "name") ?? "Sheet1";
  const relId = attr(sheetTag[0], "r:id") ?? attr(sheetTag[0], "id");

  let sheetPath: string | null = null;
  const rels = text("xl/_rels/workbook.xml.rels");
  if (rels && relId) {
    const relRe = /<Relationship\b[^>]*\/>/g;
    let r: RegExpExecArray | null;
    while ((r = relRe.exec(rels)) != null) {
      if (attr(r[0], "Id") !== relId) continue;
      const target = attr(r[0], "Target") ?? "";
      sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      break;
    }
  }
  if (!sheetPath || !byName.has(sheetPath)) {
    // Fall back to the lowest-numbered worksheet part. Not ideal - it is the
    // guess this function exists to avoid - but a workbook with a broken
    // relationship file is still better read than refused.
    const worksheets = entries
      .map((e) => e.name)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
    sheetPath = worksheets[0] ?? null;
  }
  if (!sheetPath) throw new XlsxError("This workbook has no readable worksheet.");

  const sheetXml = text(sheetPath);
  if (sheetXml == null) throw new XlsxError("This workbook's first sheet could not be read.");

  const shared = parseSharedStrings(text("xl/sharedStrings.xml") ?? "");
  const dateStyles = parseDateStyles(text("xl/styles.xml") ?? "");

  return { name: sheetName, rows: parseSheet(sheetXml, shared, dateStyles) };
}
