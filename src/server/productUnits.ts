/**
 * The bridge between a raw pack description on an invoice ("10*1KG") and the numbers
 * stored on a master product.
 *
 * A wholesale product is sold at several levels of the same hierarchy: per carton, per
 * pack, per kilogram. Without this layer a carton at $12 and a pack at $1.20 look like
 * a 900% price increase. Everything that compares prices goes through here, and when the
 * hierarchy is unknown the price is reported as NOT comparable rather than guessed at.
 */

import { MasterProduct } from '../types/index.ts';
import {
  buildUnitConversions,
  mergeConversions,
  toBasePrice,
  fromBasePrice,
  baseUnitForDirectUnit,
  WEIGHT_IN_KG,
  VOLUME_IN_L,
  type BaseUnit,
} from './unitConversion.ts';
import { canonicalUnit, guessCategory, MEAT_CATEGORY } from './aliasMatcher.ts';

/**
 * Teaches a product the hierarchy implied by a pack description.
 * Returns true when something new was learned (i.e. stored data should be recalculated).
 */
export function learnPackHierarchy(product: MasterProduct, packSize?: string | null): boolean {
  const learned = buildUnitConversions(packSize);
  if (!learned) return false;

  // A product is measured by weight or by volume, not both. If a later invoice reports
  // the other measure, the pack size is probably OCR noise - keep the original.
  //
  // 'each' is the exception, and it matters: a count says nothing about what is inside
  // the container, so a product that only ever got as far as "one each" is not committed
  // to a measure at all. Refusing to upgrade from it means one bad pack string early on
  // can lock the product out of every good reading that arrives afterwards.
  const existingBase = product.baseUnit;
  const upgradingFromCount = existingBase === 'each';
  if (existingBase && existingBase !== learned.baseUnit && !upgradingFromCount) return false;

  if (upgradingFromCount) {
    // The table that came with 'each' is the degenerate { each: 1 } - meaningless once the
    // product is measured by weight or volume, and actively wrong if merged ('each' would
    // keep its old value of 1 instead of the real content of one container). Replace it.
    product.unitConversions = { ...learned.conversions };
    product.baseUnit = learned.baseUnit;
    return true;
  }

  const knownBefore = product.unitConversions ? Object.keys(product.unitConversions).length : 0;
  const merged = mergeConversions(product.unitConversions, learned.conversions);

  product.unitConversions = merged;
  if (!product.baseUnit) product.baseUnit = learned.baseUnit;

  return Object.keys(merged || {}).length > knownBefore;
}

/** The product's price expressed per base unit. Null when it cannot be compared. */
export function basePriceFor(
  product: MasterProduct,
  unitPrice: number,
  unit?: string | null,
  packSize?: string | null
): number | null {
  const normal = toBasePrice(
    unitPrice,
    unit ?? undefined,
    product.unitConversions,
    product.baseUnit as BaseUnit | undefined
  );
  if (normal != null) return normal;

  // The product's own table may not cover this unit yet - typically because every earlier
  // pack string was unreadable. The pack printed on THIS line is a second, equally valid
  // source, and one good reading is all a conversion needs. Without this a single bad pack
  // string early on leaves every later invoice uncomparable.
  const lineTable = buildUnitConversions(packSize);
  if (lineTable) {
    const viaLine = toBasePrice(unitPrice, unit ?? undefined, lineTable.conversions, lineTable.baseUnit);
    if (viaLine != null) {
      // Keep what this line proved, so the next invoice does not depend on luck.
      if (!product.baseUnit || product.baseUnit === 'each') {
        product.unitConversions = { ...lineTable.conversions };
        product.baseUnit = lineTable.baseUnit;
      } else if (product.baseUnit === lineTable.baseUnit) {
        product.unitConversions = mergeConversions(product.unitConversions, lineTable.conversions);
      }
      return viaLine;
    }
  }

  // Fallback: a line invoiced in a base measure (kg / g / l / ml / each) with a price is
  // comparable on that unit by itself. No pack size is required, and the product name is
  // never consulted - the structured unit + unitPrice are authoritative. Garbled pack
  // strings embedded in a name (e.g. "2KG(6) R/W" on a meat item) must not block this.
  const direct = baseUnitForDirectUnit(unit);
  if (!direct || !(Number.isFinite(unitPrice) && unitPrice > 0)) return null;
  // Seed the line's own base unit so it is comparable on that unit. A product priced in
  // both "each" and a weight/volume measure (e.g. pork bone sold per bone and per kg) is
  // allowed - "each" is just a count and coexists with either. Only a genuine
  // weight<->volume conflict is refused. The product name is never consulted.
  if (product.baseUnit && product.baseUnit !== direct.baseUnit) {
    const involvesEach = product.baseUnit === 'each' || direct.baseUnit === 'each';
    const bothMeasure =
      (product.baseUnit === 'kg' || product.baseUnit === 'l') &&
      (direct.baseUnit === 'kg' || direct.baseUnit === 'l');
    if (!involvesEach && bothMeasure) return null;
  }

  if (!product.baseUnit) product.baseUnit = direct.baseUnit;
  if (!product.unitConversions) product.unitConversions = {};
  const measureTable =
    direct.baseUnit === 'kg' ? WEIGHT_IN_KG : direct.baseUnit === 'l' ? VOLUME_IN_L : { each: 1 };
  for (const [k, v] of Object.entries(measureTable)) {
    if (!(k in product.unitConversions)) product.unitConversions[k] = v;
  }
  product.unitConversions[direct.baseUnit] = 1;
  return unitPrice / direct.factor;
}

/**
 * Meat is bought by weight, so the only meaningful price is the one per kilogram.
 *
 * A meat invoice prints Quantity and Weight as two DIFFERENT columns, and the line
 * amount is built from the weight, not the carton count:
 *
 *   CHICKEN MARYLAND # 22   Qty 3   Weight 57.640   Price $6.00   Amount $345.84
 *   -> 57.640 kg x $6.00/kg = $345.84
 *
 * So the unit price is **total / weight (kg)**, never total / quantity. Dividing by the
 * carton count is the specific error this prevents: it would report $115.28/kg for a
 * product that actually costs $6.00/kg, a 19x overstatement, and every price alert
 * built on it would be nonsense.
 *
 * When no weight can be established the stored values are returned untouched. A line is
 * never silently repriced to force a comparison - an unpriceable meat line is simply
 * left as recorded.
 */
export function applyWeightPricing(
  item: {
    rawDescription?: string | null;
    brand?: string | null;
    unit?: string | null;
    unitPrice?: number | null;
    quantity?: number | null;
    weight?: number | null;
    totalPrice?: number | null;
  },
  /**
   * The catalogue entry this line belongs to, when it is known. A category the owner set
   * by hand outranks the keyword guess - that is the whole point of setting it.
   */
  product?: MasterProduct | null
): { unitPrice: number | null; unit: string | null } {
  const untouched = { unitPrice: item.unitPrice ?? null, unit: item.unit ?? null };
  if (!isMeatProduct(`${item.rawDescription ?? ''} ${item.brand ?? ''}`.trim(), product)) {
    return untouched;
  }

  const total = Number(item.totalPrice);
  if (!(total > 0)) return untouched;

  const weightKg = resolveWeightKg(item);
  if (weightKg == null) return untouched;

  // Rounded to 4dp: 345.84 / 57.64 is 5.999999999999999 in floating point, and a price
  // that leaks that into the UI (or into an alert's delta) looks like a bug.
  return { unitPrice: Number((total / weightKg).toFixed(4)), unit: 'kg' };
}

/**
 * The weight to divide the line amount by, in kg - or null when nothing reliable exists.
 *
 * Order of trust:
 *   1. The invoice's own Weight column. Suppliers compute the amount from it, so it is
 *      the measure the price is actually built on.
 *   2. A quantity that is itself already a mass ("3.5 kg", "750 g"). Invoices that bill
 *      meat by the kilogram have no separate weight column and need no conversion.
 *   3. Nothing. A carton/pack/each count is NOT a weight, and a pack string embedded in
 *      the description ("2KG(6) R/W") is far too noisy to convert - so neither is used.
 */
function resolveWeightKg(item: {
  unit?: string | null;
  quantity?: number | null;
  weight?: number | null;
}): number | null {
  const printed = Number(item.weight);
  if (Number.isFinite(printed) && printed > 0) {
    // A vendor that prints grams must be scaled; the column is otherwise already kg.
    return canonicalUnit(item.unit) === 'g' ? printed / 1000 : printed;
  }

  const qty = Number(item.quantity);
  const unit = canonicalUnit(item.unit);
  if (Number.isFinite(qty) && qty > 0) {
    if (unit === 'kg') return qty;
    if (unit === 'g') return qty / 1000;
  }

  return null;
}

/**
 * True for the products whose price only makes sense per kilogram.
 *
 * A category the owner set by hand wins outright: "file this under Produce" has to mean
 * the weight rule stops applying, otherwise the override would only repaint the badge.
 * Everything else is decided from the description, which is what the importer has.
 */
export function isMeatProduct(
  description: string,
  product?: MasterProduct | null
): boolean {
  if (product?.categorySource === 'manual') return product.category === MEAT_CATEGORY;
  return !!description && guessCategory(description) === MEAT_CATEGORY;
}

/** The same price converted back into an invoicing unit, for display. */
export function priceInUnit(
  product: MasterProduct,
  basePrice: number,
  unit?: string | null
): number | null {
  return fromBasePrice(basePrice, unit ?? undefined, product.unitConversions);
}

/**
 * Recomputes current / previous / min / max purely from the stored history.
 *
 * Every history entry is converted into the unit of the MOST RECENT entry, so the whole
 * history is expressed in one unit and genuinely comparable. Entries that cannot be
 * converted are skipped instead of being mixed in at their raw value.
 */
export function recalculateProductStats(product: MasterProduct): void {
  const history = (product.priceHistory || []).filter((h) => Number.isFinite(h.unitPrice) && h.unitPrice > 0);
  if (history.length === 0) return;

  // Keep chronological order: newest last.
  history.sort((a, b) => {
    const byDate = (a.date || '').localeCompare(b.date || '');
    if (byDate !== 0) return byDate;
    return (a.invoiceNumber || '').localeCompare(b.invoiceNumber || '');
  });

  const last = history[history.length - 1];
  product.currentPrice = last.unitPrice;
  if (last.unit) product.standardUnit = last.unit;
  product.lastPurchaseDate = last.date || product.lastPurchaseDate;

  const lastBase = basePriceFor(product, last.unitPrice, last.unit, last.packSize);
  const comparable: { raw: number; converted: number | null; base: number | null }[] = history.map((h) => {
    const base = basePriceFor(product, h.unitPrice, h.unit, h.packSize);
    const converted =
      lastBase != null && base != null ? priceInUnit(product, base, last.unit) : null;
    return { raw: h.unitPrice, converted, base };
  });

  // A recording whose unit label was wrong works out absurdly high or low once converted.
  // It is left out of the range rather than allowed to drag the minimum or maximum.
  const usable = comparable
    .filter((c) => lastBase == null || c.base == null || isPlausibleStep(lastBase, c.base))
    .map((c) => (lastBase != null ? c.converted : c.raw))
    .filter((v): v is number => v != null);

  if (usable.length > 0) {
    product.minPrice = Math.min(...usable);
    product.maxPrice = Math.max(...usable);
  } else {
    product.minPrice = last.unitPrice;
    product.maxPrice = last.unitPrice;
  }

  if (history.length > 1) {
    const prev = comparable[comparable.length - 2];
    product.previousPrice =
      lastBase != null ? (prev.converted ?? prev.raw) : prev.raw;
  } else {
    product.previousPrice = last.unitPrice;
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * One purchase, one history entry.
 *
 * OCR reads the unit off whatever word sits next to the price, so one product on one
 * invoice routinely appears as "3.10 ea", "3.10 CARTON" and "3.10 CTN" at the same time.
 * Those are the same purchase listed three times, and comparing them produces a 3000%
 * "increase" out of nothing. The unit most rows of that invoice agree on is the real one.
 */
function collapseToPerInvoice<
  T extends { date: string; unitPrice: number; invoiceNumber: string; unit?: string | null }
>(entries: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const e of entries) {
    const list = groups.get(e.invoiceNumber);
    if (list) list.push(e);
    else groups.set(e.invoiceNumber, [e]);
  }

  const collapsed: T[] = [];
  for (const rows of groups.values()) {
    // Majority vote on the unit. Ties are broken by the row that appears first, which is
    // the order the supplier printed them in.
    const votes = new Map<string, number>();
    for (const r of rows) {
      const key = canonicalUnit(r.unit);
      votes.set(key, (votes.get(key) || 0) + 1);
    }
    let winner = canonicalUnit(rows[0].unit);
    let best = 0;
    for (const r of rows) {
      const key = canonicalUnit(r.unit);
      const v = votes.get(key) || 0;
      if (v > best) {
        best = v;
        winner = key;
      }
    }

    const inWinner = rows.filter((r) => canonicalUnit(r.unit) === winner);
    const price = medianOf((inWinner.length ? inWinner : rows).map((r) => r.unitPrice));
    const representative = (inWinner.length ? inWinner : rows)[0];

    collapsed.push({ ...representative, unitPrice: price });
  }

  return collapsed.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Rebuilds a product's history from the invoice lines that reference it.
 * Older records were stored without the invoicing unit, which made them impossible to
 * convert - this replays them from the invoices, which do carry the unit.
 */
export function rebuildHistoryFromInvoices(
  product: MasterProduct,
  entries: {
    date: string;
    vendor: string;
    unitPrice: number;
    invoiceNumber: string;
    unit?: string | null;
    packSize?: string | null;
  }[]
): number {
  if (entries.length === 0) return 0;

  const cleaned = entries.filter((e) => Number.isFinite(e.unitPrice) && e.unitPrice > 0);

  for (const e of cleaned) {
    if (e.packSize) learnPackHierarchy(product, e.packSize);
  }

  const sorted = collapseToPerInvoice(cleaned);

  product.priceHistory = sorted.map((e) => {
    const unit = e.unit || product.standardUnit;
    return {
      date: e.date,
      vendor: e.vendor,
      unitPrice: e.unitPrice,
      invoiceNumber: e.invoiceNumber,
      unit,
      packSize: e.packSize ?? undefined,
      baseUnitPrice: basePriceFor(product, e.unitPrice, unit, e.packSize),
    };
  });

  recalculateProductStats(product);
  return product.priceHistory.length;
}

/** True when two prices of this product can be compared at all. */
export function isComparable(product: MasterProduct, unit?: string | null): boolean {
  if (!product.baseUnit || !product.unitConversions) return false;
  return canonicalUnit(unit) in product.unitConversions;
}

/** Below this relative movement two prices are the same number rounded differently. */
const NEGLIGIBLE_RELATIVE_CHANGE = 0.0005;

/** A real increase, as opposed to rounding noise between two recordings. */
export function isRealIncrease(previous: number, current: number): boolean {
  if (!(previous > 0) || !Number.isFinite(current)) return false;
  return (current - previous) / previous > NEGLIGIBLE_RELATIVE_CHANGE;
}

/**
 * How far apart two recordings of the same product may be before the unit labels are
 * assumed to be wrong rather than the price.
 *
 * A jump of this size does not happen in wholesale food between two invoices. What does
 * happen constantly is OCR attaching "ea" to a carton price, which the pack conversion
 * then faithfully turns into a 3000% increase. Past this ratio the numbers are not being
 * compared at all.
 */
export const MAX_PLAUSIBLE_PRICE_RATIO = 4;

/** False when the gap between two recordings is too wide to be a real price move. */
export function isPlausibleStep(previous: number, current: number): boolean {
  if (!(previous > 0) || !(current > 0)) return false;
  const ratio = current / previous;
  return ratio <= MAX_PLAUSIBLE_PRICE_RATIO && ratio >= 1 / MAX_PLAUSIBLE_PRICE_RATIO;
}
