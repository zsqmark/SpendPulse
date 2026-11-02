/**
 * The one way a price and its unit are written on screen.
 *
 * Two screens used to disagree: the alert feed printed the number as invoiced with whatever
 * label OCR had attached ("$1.85 /carton"), while the line detail panel quoted the per-kilo
 * figure the comparison is actually made on. Same product, same invoice, two prices. Worse, one
 * supplier's labels vary between invoices - CTN here, Carton there - so the feed showed three
 * spellings of one unit.
 *
 * Everything money-related now comes through here: the unit is canonicalised, the number gets
 * as many decimals as its size needs, and the currency symbol is added in one place. Callers
 * get the pieces as well as the finished string, so a row can put them in separate cells
 * without inventing its own formatting.
 *
 * Browser-safe and React-free: no db, no LLM - the same rule as the other modules in src/lib.
 */

import type { Invoice, InvoiceItem, MasterProduct } from '../types/index.ts';

/** A price written out for display. */
export interface RateDisplay {
  /** The number on its own, already rounded: "1.85". */
  value: string;
  /** The unit as the app writes it: "kg", "L", "carton", "Pack". */
  unit: string;
  /** The two together with the currency: "$1.85/Pack". */
  text: string;
}

/**
 * Unit spellings collapsed onto one canonical word.
 *
 * OCR hands back CTN, Ctn, ctn and carton for the same column, and suppliers abbreviate
 * freely; left alone, those become four different units in the reader's head.
 */
const UNIT_ALIASES: Record<string, string> = {
  // Carton words: one supplier's "case" is another's "ctn", and OCR picks one at random.
  ctn: 'carton',
  ctns: 'carton',
  cs: 'carton',
  case: 'carton',
  cases: 'carton',
  cartons: 'carton',
  // Inner pack words.
  pk: 'pack',
  pkt: 'pack',
  packs: 'pack',
  pkts: 'pack',
  packets: 'pack',
  bags: 'bag',
  // Count words.
  unit: 'each',
  units: 'each',
  ea: 'each',
  each: 'each',
  pc: 'each',
  pcs: 'each',
  piece: 'each',
  pieces: 'each',
  // Volume and weight spellings. Note these stay LOWERCASE - they are the keys the
  // pack maths looks up, not the words shown to the reader (see UNIT_LABELS).
  lt: 'l',
  ltr: 'l',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  mls: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
};

/** Lowercases and collapses a unit spelling onto its canonical word. */
export function canonicalUnit(unit?: string | null): string {
  const raw = (unit ?? '').trim().toLowerCase().replace(/[.\s]+$/, '');
  return UNIT_ALIASES[raw] ?? raw;
}

/**
 * How a unit is written on screen.
 *
 * Kept separate from the key above on purpose: `ml` is the key the pack maths looks up,
 * `mL` is the way the word is spelled to the reader. Collapsing the two would break
 * the conversion table for every product measured in millilitres.
 */
const UNIT_LABELS: Record<string, string> = {
  l: 'L',
  ml: 'mL',
  each: 'ea',
  kg: 'kg',
  g: 'g',
  lb: 'lb',
  carton: 'carton',
  case: 'carton',
  pack: 'pack',
  bag: 'bag',
  box: 'box',
  tray: 'tray',
  tin: 'tin',
  tub: 'tub',
  bottle: 'bottle',
  roll: 'roll',
};

export function normaliseUnitLabel(unit?: string | null): string {
  const key = canonicalUnit(unit);
  if (!key) return '';
  return UNIT_LABELS[key] ?? key;
}

/**
 * Decimals by size, not by unit.
 *
 * A kilogram of rice wants cents ($3.10); a disposable skewer is a fraction of a cent and
 * needs four decimals or it reads as $0.01. The old code rounded everything to two, which
 * flattened most of the catalogue to either "$0.00" or a round number.
 */
export function formatAmount(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.1 ? 3 : 4;
  return value.toFixed(digits);
}

/** "$1.85/Pack" */
export function formatRate(
  value?: number | null,
  unit?: string | null,
  currency: string = 'USD'
): RateDisplay | null {
  if (value == null || !Number.isFinite(value) || !unit) return null;
  const u = normaliseUnitLabel(unit);
  const v = formatAmount(value);
  return { value: v, unit: u, text: `$${v}/${u}` };
}

/**
 * How one invoiced line reads.
 *
 * `printed` is what the invoice says and what accounts for the money; `perBase` is the figure
 * every comparison - trends, variance, alerts - is made on. Both are returned together so a
 * screen cannot show one and imply the other. Either may be null: an unreadable pack has no
 * per-base price, and that absence is information, never something to paper over.
 */
export interface LineRates {
  printed: RateDisplay | null;
  perBase: RateDisplay | null;
}

export function ratesForLine(item?: InvoiceItem | null, product?: MasterProduct | null): LineRates {
  if (!item) return { printed: null, perBase: null };

  const printed = formatRate(item.unitPrice, item.unit || 'each');
  const perBase = formatRate(item.baseUnitPrice ?? null, item.baseUnit ?? product?.baseUnit ?? null);
  return { printed, perBase };
}

/**
 * What the invoice printed: "$1.85/Pack".
 *
 * The money the supplier charged, in the unit the supplier wrote. Kept beside the per-base
 * figure everywhere, because it is what the accounts close against.
 */
export function printedRateOf(item?: InvoiceItem | null, currency: string = 'USD'): RateDisplay | null {
  if (!item) return null;
  return formatRate(item.unitPrice, item.unit || 'each', currency);
}

/** A price history record, in the shape the catalogue stores it. */
export interface HistoryRateEntry {
  unitPrice: number;
  /** Purchase date - what the trend is ordered and the previous entry found by. */
  date?: string;
  unit?: string | null;
  packSize?: string | null;
  baseUnitPrice?: number | null;
  /** Which invoice this entry was recorded from, so it can be skipped when looking back. */
  invoiceNumber?: string;
}

export function ratesForHistory(
  entry?: HistoryRateEntry | null,
  product?: MasterProduct | null
): LineRates {
  if (!entry) return { printed: null, perBase: null };
  return {
    printed: formatRate(entry.unitPrice, entry.unit || 'each'),
    perBase: formatRate(entry.baseUnitPrice ?? null, product?.baseUnit ?? null),
  };
}

/** The catalogue entry an alert was raised for, when it is still in the catalogue. */
export function productOf(
  alert: { masterProductId?: string },
  products: MasterProduct[] = []
): MasterProduct | null {
  return products.find((p) => p.id === alert.masterProductId) ?? null;
}

/**
 * A printed price turned into the figure comparisons are made on.
 *
 * Used for the "was" side of an alert, whose earlier invoice no longer has a line of its own
 * on screen. Null whenever the product's pack hierarchy says nothing about that unit - no
 * guess is better than a wrong comparison.
 */
export function perBaseFromPrinted(
  price?: number | null,
  unit?: string | null,
  product?: MasterProduct | null,
  currency: string = 'USD'
): RateDisplay | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const base = product?.baseUnit;
  if (!base) return null;
  const factor = product?.unitConversions?.[canonicalUnit(unit)];
  if (factor == null || !(factor > 0)) return null;
  return formatRate(price / factor, base, currency);
}

/**
 * The purchase an alert measured itself against: the last recorded price for this product
 * from a different invoice. Read from the product's own history, which is the same table
 * the trends curve and the history table draw from - so the two can never disagree.
 */
export function previousHistoryEntry(
  product?: MasterProduct | null,
  invoiceNumber?: string | null,
  invoiceDate?: string | null
): HistoryRateEntry | null {
  const history = product?.priceHistory || [];
  if (history.length === 0) return null;

  const dated = (entry: HistoryRateEntry) => entry.unitPrice != null && Number.isFinite(entry.unitPrice);
  const older = history.filter(
    (entry) => dated(entry) && entry.invoiceNumber !== invoiceNumber
  );
  if (older.length === 0) return null;

  const byDate = [...older].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || ''))
  );
  if (invoiceDate) {
    const atOrBefore = byDate.filter((entry) => String(entry.date || '') <= invoiceDate);
    if (atOrBefore.length > 0) return atOrBefore[atOrBefore.length - 1];
  }
  return byDate[byDate.length - 1];
}

/**
 * The line an alert was raised from - read from today's data, not from the snapshot taken
 * when the alert was created.
 *
 * The alert keeps its own copy of the price and unit so it can be listed on its own, but that
 * copy is frozen: correct the unit on a line and the alert goes on showing the old label.
 * Reading the live line keeps the feed and the detail panel telling the same story.
 */
export function lineForAlert(
  alert: { invoiceId?: string; invoiceNumber?: string; masterProductId?: string },
  invoices: Invoice[] = [],
  products: MasterProduct[] = []
): { item: InvoiceItem; product: MasterProduct } | null {
  const invoice =
    invoices.find((inv) => Boolean(alert.invoiceId) && inv.id === alert.invoiceId) ||
    (alert.invoiceNumber
      ? invoices.find((inv) => inv.invoiceNumber === alert.invoiceNumber)
      : undefined);
  if (!invoice) return null;

  const item = (invoice.items || []).find(
    (it) => Boolean(alert.masterProductId) && it.masterProductId === alert.masterProductId
  );
  if (!item) return null;

  const product =
    products.find((p) => p.id === alert.masterProductId) ||
    (item.masterProductId ? products.find((p) => p.id === item.masterProductId) : undefined);
  if (!product) return null;

  return { item, product };
}
