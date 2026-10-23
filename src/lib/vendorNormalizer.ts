/**
 * Supplier-name normalization.
 *
 * OCR and re-keyed uploads read the same legal entity many different ways:
 *   "T & D TRADING PTY. LTD."  vs  "T & D Trading Pty. Ltd."
 *   "Darra Meats Pty Ltd"      vs  "DARRA MEATS PTY LTD"
 *   "T&D Trading"              vs  "T & D TRADING"
 *
 * Two outputs are needed:
 *   1. normalizeVendorName() - a clean, canonical *display* name (single legal-suffix
 *      spelling, sensible ampersand spacing, ALL-CAPS strings title-cased).
 *   2. vendorKey() - a suffix-stripped, punctuation-free key used only to *detect*
 *      duplicates. Display casing is irrelevant to it.
 *
 * Pure module: no file-system or server imports, so it is safe to use on both the
 * server (server.ts) and in the browser (SuppliersView.tsx) from one source of truth.
 */

/** Collapse the many spellings of common legal suffixes into one canonical casing. */
function canonicalizeLegalSuffix(s: string): string {
  // Multi-word forms first so they are not half-mangled by the single-word rules.
  s = s.replace(/\bco\.?\s*ltd\.?\b/gi, 'Co Ltd');
  s = s.replace(/\bpty\.?\s*ltd\.?\b/gi, 'Pty Ltd');
  s = s.replace(/\bpty\b/gi, 'Pty');
  s = s.replace(/\bltd\.?\b/gi, 'Ltd');
  s = s.replace(/\blimited\b/gi, 'Limited');
  s = s.replace(/\binc\.?\b/gi, 'Inc');
  s = s.replace(/\bllc\b/gi, 'LLC');
  s = s.replace(/\bcorp\.?\b/gi, 'Corp');
  s = s.replace(/\bcorporation\b/gi, 'Corporation');
  s = s.replace(/\bco\.\b/gi, 'Co');
  s = s.replace(/\bcooperative\b/gi, 'Cooperative');
  return s;
}

/**
 * Returns a canonical display name.
 *
 * Only strings that are entirely UPPERCASE ("shoutcase", the typical OCR output) are
 * re-cased - deliberately leaving mixed-case names such as "HTC Foods" or
 * "B&E Poultry (Queensland) Pty Ltd" untouched so acronyms and house styling survive.
 */
export function normalizeVendorName(raw?: string | null): string {
  if (raw == null) return '';
  let s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return s;

  // Normalise ampersand spacing: "T&D" / "T &D" / "T& D" -> "T & D".
  s = s.replace(/\s*&\s*/g, ' & ').replace(/\s+/g, ' ').trim();

  const letters = s.replace(/[^a-zA-Z]/g, '');
  const isShout = letters.length > 0 && s === s.toUpperCase();
  if (isShout) {
    s = s.replace(/\b([a-z]+)\b/gi, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }

  s = canonicalizeLegalSuffix(s);
  // Drop any punctuation that the suffix rules left dangling (e.g. a trailing "."), then
  // collapse spacing so "Pty Ltd." and "Pty Ltd" are indistinguishable.
  s = s.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Match key for duplicate detection: lower-cased, legal suffixes removed entirely,
 * ampersands folded to "and", all other punctuation stripped. "T & D TRADING PTY. LTD."
 * and "T & D Trading Pty. Ltd." both reduce to "t and d trading", so they surface as
 * the same supplier.
 */
export function vendorKey(raw?: string | null): string {
  if (raw == null) return '';
  let s = String(raw).toLowerCase();

  s = s.replace(/\bco\.?\s*ltd\.?\b/gi, ' ');
  s = s.replace(/\bpty\.?\s*ltd\.?\b/gi, ' ');
  s = s.replace(/\bpty\b/gi, ' ');
  s = s.replace(/\bltd\.?\b/gi, ' ');
  s = s.replace(/\blimited\b/gi, ' ');
  s = s.replace(/\binc\.?\b/gi, ' ');
  s = s.replace(/\bllc\b/gi, ' ');
  s = s.replace(/\bcorp\.?\b/gi, ' ');
  s = s.replace(/\bco\.?\b/gi, ' ');
  s = s.replace(/\bcooperative\b/gi, ' ');

  s = s.replace(/\s*&\s*/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}
