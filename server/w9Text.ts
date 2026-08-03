// ── PAY-A2 hardening: W-9 text encoding ──────────────────────────────────────
// The IRS Form W-9 acroform is filled with the PDF standard fonts, whose only
// simple encoding is WinAnsi (≈ Latin-1 + a handful of typographic extras).
// A rep whose legal name is Cyrillic, Greek, Vietnamese, or CJK used to make
// pdf-lib throw from form.flatten()/drawText() OUTSIDE the route's try/catch —
// a raw 500 that blocked onboarding entirely.
//
// We do NOT embed a Unicode font: a full CJK face is a multi-megabyte binary,
// and nothing shippable is vendored in this repo (@fontsource ships woff2 only
// and @pdf-lib/fontkit is not a dependency). Instead we TRANSLITERATE to the
// closest Latin representation, persist BOTH the original and the rendered
// form on the w9_forms row, and — when a script has no sensible Latin
// representation (CJK) — fail with a typed error the route maps to 400 with a
// clear explanation. Never a 500.

/** The WinAnsiEncoding repertoire (derived from pdf-lib's standard-font
 *  encoder: ASCII, Latin-1 minus the C1 block, plus 27 typographic extras). */
const WIN_ANSI_EXTRAS = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e,
  0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

export function isWinAnsiEncodable(text: string): boolean {
  for (const ch of text) if (!isEncodableCodePoint(ch.codePointAt(0)!)) return false;
  return true;
}

function isEncodableCodePoint(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WIN_ANSI_EXTRAS.has(cp);
}

// Letters that Unicode decomposition cannot reduce to a WinAnsi base, plus the
// Cyrillic and Greek repertoires in a conventional romanization (BGN/PCGN-ish
// for Cyrillic, ISO-843-ish for Greek). Anything decomposable (é, ñ, ễ, ğ, ş…)
// is handled generically below and never needs a table entry.
const TRANSLITERATIONS: Record<string, string> = {
  // ── Latin letters with no decomposition ────────────────────────────────────
  "ı": "i", "İ": "I", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ħ": "h", "Ħ": "H",
  "ŋ": "ng", "Ŋ": "NG", "ĸ": "k", "ſ": "s", "ƒ": "f",
  // ── Cyrillic ───────────────────────────────────────────────────────────────
  "А": "A", "Б": "B", "В": "V", "Г": "G", "Ґ": "G", "Д": "D", "Е": "E", "Ё": "Yo",
  "Є": "Ye", "Ж": "Zh", "З": "Z", "И": "I", "І": "I", "Ї": "Yi", "Й": "Y", "К": "K",
  "Л": "L", "М": "M", "Н": "N", "О": "O", "П": "P", "Р": "R", "С": "S", "Т": "T",
  "У": "U", "Ў": "U", "Ф": "F", "Х": "Kh", "Ц": "Ts", "Ч": "Ch", "Ш": "Sh",
  "Щ": "Shch", "Ъ": "", "Ы": "Y", "Ь": "", "Э": "E", "Ю": "Yu", "Я": "Ya",
  "Ђ": "Dj", "Ј": "J", "Љ": "Lj", "Њ": "Nj", "Ћ": "C", "Џ": "Dz",
  "а": "a", "б": "b", "в": "v", "г": "g", "ґ": "g", "д": "d", "е": "e", "ё": "yo",
  "є": "ye", "ж": "zh", "з": "z", "и": "i", "і": "i", "ї": "yi", "й": "y", "к": "k",
  "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
  "у": "u", "ў": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh",
  "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
  "ђ": "dj", "ј": "j", "љ": "lj", "њ": "nj", "ћ": "c", "џ": "dz",
  // ── Greek ──────────────────────────────────────────────────────────────────
  "Α": "A", "Β": "V", "Γ": "G", "Δ": "D", "Ε": "E", "Ζ": "Z", "Η": "I", "Θ": "Th",
  "Ι": "I", "Κ": "K", "Λ": "L", "Μ": "M", "Ν": "N", "Ξ": "X", "Ο": "O", "Π": "P",
  "Ρ": "R", "Σ": "S", "Τ": "T", "Υ": "Y", "Φ": "F", "Χ": "Ch", "Ψ": "Ps", "Ω": "O",
  "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th",
  "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p",
  "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps",
  "ω": "o",
  // ── Punctuation / spacing that would otherwise be unmappable ───────────────
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2015": "-", "\u2212": "-",  // dashes
  "\u2007": " ", "\u2009": " ", "\u200a": " ", "\u202f": " ", "\u3000": " ", // exotic spaces
  "\u200b": "", "\u200c": "", "\u200d": "", "\ufeff": "",                     // zero-width
};

/** A legal name we cannot represent on the printed form at all (e.g. CJK). */
export class W9EncodingError extends Error {
  constructor(public field: string, public unmappable: string[]) {
    super(
      `${field} contains character(s) the IRS Form W-9 cannot print (${unmappable.map(c => `"${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ")}). ` +
      `The official form is filled with a Latin-alphabet font. Please enter the Latin (romanized) spelling of the name exactly as it appears on your Social Security card or IRS notice.`,
    );
    this.name = "W9EncodingError";
  }
}

export interface TransliterationResult {
  /** The WinAnsi-safe string actually printed on the PDF. */
  text: string;
  /** True when `text` differs from the submitted value. */
  changed: boolean;
  /** Characters with no Latin representation (empty ⇒ the value is printable). */
  unmappable: string[];
}

/**
 * Reduce `value` to the closest WinAnsi-printable Latin form.
 * Characters already in WinAnsi (including accented Latin — José Núñez) are
 * preserved verbatim; everything else is transliterated, then diacritic-
 * stripped, and only reported as unmappable if both fail.
 */
export function toPrintableLatin(value: string): TransliterationResult {
  let out = "";
  const unmappable: string[] = [];
  for (const ch of value) out += reduceChar(ch, unmappable);
  return { text: out, changed: out !== value, unmappable };
}

/** One character → its printable form, applying each strategy until fixpoint.
 *  ώ (Greek omega + tonos) needs BOTH: decompose to ω, then transliterate. */
function reduceChar(ch: string, unmappable: string[], depth = 0): string {
  if (isEncodableCodePoint(ch.codePointAt(0)!)) return ch;
  if (depth >= 4) { unmappable.push(ch); return ""; }
  const candidates = [
    TRANSLITERATIONS[ch],
    // Canonical decomposition, combining marks removed (ễ → e, ğ → g, ώ → ω).
    ch.normalize("NFD").replace(/\p{M}+/gu, ""),
    // Compatibility decomposition catches ligatures / fullwidth forms (ﬁ, Ａ).
    ch.normalize("NFKD").replace(/\p{M}+/gu, ""),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === ch) continue;
    if (candidate === "") return "";                       // deliberately dropped
    if (isWinAnsiEncodable(candidate)) return candidate;
    // Partially reduced (ώ → ω): keep going.
    const before = unmappable.length;
    let deeper = "";
    for (const sub of candidate) deeper += reduceChar(sub, unmappable, depth + 1);
    if (unmappable.length === before) return deeper;
    unmappable.length = before;                            // that branch failed
  }
  unmappable.push(ch);
  return "";
}

/** Transliterate or throw W9EncodingError — the route maps it to a 400. */
export function sanitizeForW9(value: string, field: string): string {
  const r = toPrintableLatin(value);
  if (r.unmappable.length) throw new W9EncodingError(field, [...new Set(r.unmappable)]);
  return r.text;
}
