/**
 * A folder of scanned statements usually arrives as one file per page, e.g.
 *   2026-09-24_Chiland-Invoices_page_1.jpg ... _page_11.jpg
 * Those files belong to ONE invoice. Without grouping, every page would become its own
 * invoice (or, worse, a whole folder of different suppliers would be merged into a single
 * "invoice" with one vendor name).
 */

/** Strips a trailing page marker. Returns null when the file is not part of a known series. */
export function documentStem(fileName: string): string | null {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  if (!base) return null;

  // "invoice (Page 3 of 12)" - already an explicit page series.
  const withParens = base.replace(/\s*\(\s*page\s*\d+(?:\s*of\s*\d+)?\s*\)\s*$/i, '');
  if (withParens !== base) return withParens || null;

  // "invoice_page_3" / "invoice-page3" / "invoice p3" / "invoice_p3"
  const pageMatch = base.match(/[_\-\s](?:page|pg|p)[_\-\s]*\d+$/i);
  if (pageMatch && pageMatch.index !== undefined) {
    const stem = base.slice(0, pageMatch.index).replace(/[_\-\s]+$/, '');
    return stem || null;
  }

  // NOTE: a bare trailing number ("_3") is deliberately NOT treated as a page marker -
  // camera photos (IMG_2048.jpg, IMG_2049.jpg) would otherwise be merged into one "invoice".
  return null;
}

/** Human label for a group of pages that make up one document. */
export function documentLabel(fileName: string): string {
  return documentStem(fileName) || fileName;
}
