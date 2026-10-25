/**
 * Decides whether a line on a new invoice is a real price increase.
 *
 * Invoices price the same product at different levels of its pack hierarchy - a carton
 * holds ten packs, a pack weighs a kilo. "$12 a carton" and "$1.20 a pack" are the SAME
 * price, so every comparison here is made per base unit (kg / L / each) once the pack
 * hierarchy is known.
 *
 * When the hierarchy is unknown the two numbers are simply not comparable. The product is
 * re-baselined instead of raising an alert, because an invented comparison is worse than
 * no comparison at all.
 */

import { db } from './storage.ts';
import { canonicalUnit, unitMeasureClass } from './aliasMatcher.ts';
import { baseUnitForDirectUnit } from './unitConversion.ts';
import {
  learnPackHierarchy,
  basePriceFor,
  priceInUnit,
  recalculateProductStats,
  isRealIncrease,
  isPlausibleStep,
} from './productUnits.ts';
import { PriceAlert, MasterProduct } from '../types/index.ts';

export interface PriceCheckResult {
  hasPriceIncrease: boolean;
  previousPrice: number | null;
  deltaAmount: number | null;
  percentChange: number | null;
  /** The incoming price expressed per base unit, ready to show on the invoice. */
  baseUnitPrice: number | null;
  /** The base measure the conversion was made into ("kg" / "L" / "each"). */
  baseUnit: string | null;
  /**
   * False when the pack hierarchy is unknown, so the previous and new prices were NOT
   * compared. The UI must say so rather than implying the price held steady.
   */
  comparable: boolean;
  alertCreated?: PriceAlert;
}

const NEUTRAL = {
  hasPriceIncrease: false,
  previousPrice: null,
  deltaAmount: null,
  percentChange: null,
  baseUnitPrice: null,
  baseUnit: null,
  comparable: false,
};

/**
 * The most recent recording that came from a DIFFERENT invoice and is not dated after
 * this one. Two suppliers can invoice the same day, and an entry from later the same day
 * is not the "previous price" - it is the same day's price.
 */
function lastEntryBefore(
  product: MasterProduct,
  invoiceNumber: string,
  invoiceDate?: string
) {
  for (let i = product.priceHistory.length - 1; i >= 0; i--) {
    const entry = product.priceHistory[i];
    if (entry.invoiceNumber === invoiceNumber) continue;
    if (invoiceDate && entry.date && entry.date >= invoiceDate) continue;
    return entry;
  }
  return null;
}

export interface PriceComparison {
  previousPrice: number | null;
  deltaAmount: number | null;
  percentChange: number | null;
  baseUnitPrice: number | null;
  baseUnit: string | null;
  comparable: boolean;
  /** True when the movement is a genuine increase worth raising. */
  isIncrease: boolean;
}

/**
 * Two numbers that close together are the supplier printing the same price again.
 * Rounding and re-keying move a price by cents, never by a whole pack multiplier.
 */
const SAME_PRINTED_PRICE_TOLERANCE = 0.005; // 0.5%

/**
 * True when the supplier printed the same number as last time.
 *
 * This is the plainest fact available: whatever unit label OCR attached to it, the price
 * on the invoice did not go up. A line that reads "21.50 Unit" after "21.50 Carton" is
 * the same money, not a 100% increase.
 */
function isSamePrintedPrice(previous: number, current: number): boolean {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
  const scale = Math.max(Math.abs(previous), Math.abs(current), 0.01);
  return Math.abs(previous - current) <= SAME_PRINTED_PRICE_TOLERANCE * scale;
}

/**
 * True when the whole gap between two recordings is explained by their unit labels.
 *
 * OCR reads the unit column inconsistently for one and the same product - "Unit" one
 * week, "Carton" the next. For a 2*8L product a carton holds 2 units, so the same
 * printed price converts into 2.6875/L one week and 1.34375/L the next, and the system
 * reports a 100% increase that never happened. The tell is that the ratio between the
 * two prices is exactly the ratio between the two labels and nothing else.
 */
export function isUnitLabelSwing(
  product: MasterProduct,
  previousShown: number,
  current: number,
  previousUnit?: string | null,
  currentUnit?: string | null
): boolean {
  const from = canonicalUnit(previousUnit);
  const to = canonicalUnit(currentUnit);
  if (!from || !to || from === to) return false;

  const table = product.unitConversions;
  if (!table) return false;
  const fromSize = table[from];
  const toSize = table[to];
  if (!(fromSize > 0) || !(toSize > 0)) return false;
  if (!(previousShown > 0) || !(current > 0)) return false;

  const expected = fromSize / toSize; // the gap the labels alone would produce
  const actual = current / previousShown;
  return Math.abs(actual - expected) <= 0.02 * Math.max(expected, 1);
}

/**
 * Compares a price against the product's history without writing anything.
 * Shared by the upload pipeline and by the line editor, so a corrected line is judged
 * by exactly the same rule as a freshly scanned one.
 */
export function compareAgainstHistory(
  product: MasterProduct,
  unitPrice: number,
  unit: string,
  invoiceNumber: string,
  invoiceDate?: string
): PriceComparison {
  const incomingBase = basePriceFor(product, unitPrice, unit);
  const prior = lastEntryBefore(product, invoiceNumber, invoiceDate);
  const priorUnit = prior?.unit || product.standardUnit;
  const prevBase = prior ? basePriceFor(product, prior.unitPrice, priorUnit) : null;

  // When the line is priced in a base measure, show that measure on the line (e.g. a
  // "per kg" line reads /kg even if the product's catalogue base was set to "each").
  const directBase = baseUnitForDirectUnit(unit);
  const reportedBase =
    incomingBase != null && directBase ? directBase.baseUnit : product.baseUnit || null;

  const base: PriceComparison = {
    previousPrice: null,
    deltaAmount: null,
    percentChange: null,
    baseUnitPrice: incomingBase,
    baseUnit: reportedBase,
    comparable: false,
    isIncrease: false,
  };

  if (!prior || !Number.isFinite(unitPrice) || unitPrice <= 0) return base;

  let previousShown: number | null = null;
  let increase = false;

  // The supplier printed the same number again. That fact outranks any conversion: the
  // price on the invoice did not move, whatever label OCR attached to each line.
  //
  // It has to be settled here, ahead of the plausibility guard below. Two recordings of
  // one product routinely carry different labels (each one week, carton the next), which
  // turns an unchanged price into a 10x / 24x / 50x gap once each side is divided by its
  // own pack size. Those pairs were being thrown out as implausible and reported as "not
  // comparable" - roughly half the catalogue. The printed number is the ground truth.
  if (isSamePrintedPrice(prior.unitPrice, unitPrice)) {
    base.comparable = true;
    base.previousPrice = prior.unitPrice;
    base.deltaAmount = +(unitPrice - prior.unitPrice).toFixed(2);
    base.percentChange = prior.unitPrice
      ? +(((unitPrice - prior.unitPrice) / prior.unitPrice) * 100).toFixed(2)
      : 0;
    base.isIncrease = false;
    return base;
  }

  if (incomingBase != null && prevBase != null) {
    // The pack conversion is only trustworthy while the two recordings are in the same
    // ballpark. A carton price mislabelled "each" converts into a 3000% increase, which is
    // a unit problem, not a price move - so such a pair is not compared at all.
    if (!isPlausibleStep(prevBase, incomingBase)) return base;

    // Both convertible - compare per base unit, then show the old price in the new unit
    // so the two numbers on screen can be compared by eye.
    base.comparable = true;
    previousShown = priceInUnit(product, prevBase, unit) ?? prior.unitPrice;
    increase = isRealIncrease(prevBase, incomingBase);

    // A gap that is exactly the ratio between the two unit labels is the label moving,
    // not the price. See isUnitLabelSwing.
    if (increase && isUnitLabelSwing(product, previousShown, unitPrice, priorUnit, unit)) {
      increase = false;
    }
  } else if (unitMeasureClass(unit) === unitMeasureClass(priorUnit)) {
    // No hierarchy known, but the prices are quoted on the same basis.
    if (!isPlausibleStep(prior.unitPrice, unitPrice)) return base;
    base.comparable = true;
    previousShown = prior.unitPrice;
    increase = isRealIncrease(prior.unitPrice, unitPrice);
  }
  // Otherwise the two numbers measure different things - not comparable.

  if (!base.comparable || previousShown == null) return base;

  base.previousPrice = previousShown;
  base.deltaAmount = +(unitPrice - previousShown).toFixed(2);
  base.percentChange = +(((unitPrice - previousShown) / previousShown) * 100).toFixed(2);
  base.isIncrease = increase;
  return base;
}

/**
 * Re-runs the open alerts through today's rules and drops the ones that no longer stand
 * up: exact copies of a move already reported, and alerts whose "increase" is only the
 * unit label moving.
 *
 * The catalogue accumulated a good number of these before the guards existed - 100% and
 * 200% "increases" on products whose printed price never changed. They are removed rather
 * than corrected, because the comparison that produced them was never valid.
 */
export function revalidateActiveAlerts(): {
  removed: number;
  duplicate: number;
  labelSwing: number;
  oneOff: number;
  baseline: number;
  kept: number;
} {
  const active = db
    .getAlerts()
    .filter((a) => a.status === 'active')
    .sort((a, b) => (a.detectedAt || '').localeCompare(b.detectedAt || ''));

  const doomed = new Set<string>();
  const seenMoves = new Set<string>();
  let duplicate = 0;
  let labelSwing = 0;
  let oneOff = 0;
  let baseline = 0;

  for (const alert of active) {
    // One move, one alert - the earliest copy is the one worth keeping.
    const moveKey = [
      alert.masterProductId,
      alert.vendorName,
      Number(alert.previousPrice ?? 0).toFixed(2),
      Number(alert.newPrice ?? 0).toFixed(2),
    ].join('|');
    if (seenMoves.has(moveKey)) {
      doomed.add(alert.id);
      duplicate += 1;
      continue;
    }
    seenMoves.add(moveKey);

    const product = db.getMasterProduct(alert.masterProductId);
    if (!product) continue;

    const comparison = compareAgainstHistory(
      product,
      alert.newPrice,
      alert.unit,
      alert.invoiceNumber,
      alert.invoiceDate
    );
    if (!comparison.isIncrease) {
      doomed.add(alert.id);
      labelSwing += 1;
      continue;
    }

    // A price that jumps for exactly one invoice and then goes straight back was never a
    // rise - it is one bad read. This can only be seen after the fact, which is why it
    // belongs here and not in the live check: a real increase stays at the new level.
    if (isOneOffSpike(product, alert)) {
      doomed.add(alert.id);
      oneOff += 1;
      continue;
    }

    // The mirror image: the OLD price is the odd one out. BABA curry powder sits at
    // $4.00-$4.30 on every invoice except one that read $1.45, and the "increase" to
    // $4.30 is nothing more than a return to normal. If the new price is the product's
    // ordinary level, nothing happened - the baseline was the outlier.
    if (isContaminatedBaseline(product, alert)) {
      doomed.add(alert.id);
      baseline += 1;
    }
  }

  const removed = db.pruneAlerts((a) => !doomed.has(a.id));
  return {
    removed,
    duplicate,
    labelSwing,
    oneOff,
    baseline,
    kept: db.getAlerts().filter((a) => a.status === 'active').length,
  };
}

/**
 * True when the alert's "new" price appears once and every later invoice contradicts it.
 *
 * Olsson's table salt is $14.00 on thirteen of fourteen invoices; one read it as $26.00
 * and the next five went straight back to $14.00. That is a misread, not a price rise -
 * but at upload time it is indistinguishable from a real jump, because nothing after it
 * exists yet.
 *
 * Both halves of the test are needed. "Came back to the old price" alone is far too keen:
 * eggs went 62 -> 63 -> 64, and the middle step sits within 2% of the old price, so a
 * genuine climb would lose its first rung. The price must also have FAILED to hold the
 * new level - a rise that sticks is real, whatever it looks like against the old price.
 */
export function isOneOffSpike(product: MasterProduct, alert: PriceAlert): boolean {
  const later = (product.priceHistory || [])
    .filter((h) => (h.date || '') > (alert.invoiceDate || ''))
    .map((h) => Number(h.unitPrice))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (later.length < 2) return false;

  const sorted = [...later].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const baseline = Number(alert.previousPrice);
  const spike = Number(alert.newPrice);
  if (!(baseline > 0) || !(mid > 0) || !(spike > 0)) return false;

  // 1. it went back to (or below) the old price, and
  // 2. the new price was never sustained.
  return Math.abs(mid - baseline) <= 0.02 * baseline && mid < spike * 0.98;
}

/**
 * True when the alert's "previous" price is the outlier and the new one is normal.
 *
 * isOneOffSpike asks whether the NEW price was ever sustained. This asks the opposite:
 * was the OLD price ever real? Curry powder is $4.00-$4.30 across the whole history
 * apart from one invoice that read $1.45, and the +197% "increase" back to $4.30 is a
 * return to the ordinary level, not news.
 *
 * Only drops an alert when the new price sits at the product's normal level AND the old
 * one is far away from it, so a genuine rise above the norm is untouched.
 */
export function isContaminatedBaseline(product: MasterProduct, alert: PriceAlert): boolean {
  const prices = (product.priceHistory || [])
    .filter((h) => h.invoiceNumber !== alert.invoiceNumber)
    .map((h) => Number(h.unitPrice))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (prices.length < 3) return false;

  const median = prices[Math.floor(prices.length / 2)];
  const baseline = Number(alert.previousPrice);
  const current = Number(alert.newPrice);
  if (!(median > 0) || !(baseline > 0) || !(current > 0)) return false;

  // The new price is ordinary; the old one is not.
  return (
    Math.abs(current - median) <= 0.25 * median && Math.abs(baseline - median) > 0.5 * median
  );
}

/**
 * True when this exact price move has already been reported and is still open.
 *
 * The pair (previous -> new) is compared with a small tolerance so a re-rounded figure
 * is still recognised as the same move.
 */
function hasSameActiveAlert(
  masterProductId: string,
  vendorName: string,
  previousPrice: number | null,
  newPrice: number
): boolean {
  if (previousPrice == null) return false;
  return db.getAlerts().some(
    (a) =>
      a.status === 'active' &&
      a.masterProductId === masterProductId &&
      a.vendorName === vendorName &&
      Math.abs((a.newPrice ?? 0) - newPrice) <= 0.01 &&
      Math.abs((a.previousPrice ?? 0) - previousPrice) <= 0.01
  );
}

export function checkAndRecordPriceChange(params: {
  masterProductId: string;
  unitPrice: number;
  unit: string;
  /** Pack description on the invoice line ("10*1KG") - this is what teaches the hierarchy. */
  packSize?: string | null;
  vendorName: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  /**
   * Set when this product was already priced earlier in the SAME invoice. Two rows of one
   * invoice are the same purchase, so a difference between them is not a price increase -
   * comparing them only manufactures false alerts from OCR noise.
   */
  suppressAlert?: boolean;
}): PriceCheckResult {
  const {
    masterProductId,
    unitPrice,
    unit,
    packSize,
    vendorName,
    invoiceId,
    invoiceNumber,
    invoiceDate,
    suppressAlert = false,
  } = params;

  const product = db.getMasterProduct(masterProductId);
  if (!product) return { ...NEUTRAL };
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return { ...NEUTRAL };

  // Teach the product how many packs are in a carton before any price is compared.
  if (packSize) learnPackHierarchy(product, packSize);

  const comparison = compareAgainstHistory(product, unitPrice, unit, invoiceNumber, invoiceDate);

  const result: PriceCheckResult = {
    hasPriceIncrease: false,
    previousPrice: comparison.previousPrice,
    deltaAmount: comparison.deltaAmount,
    percentChange: comparison.percentChange,
    baseUnitPrice: comparison.baseUnitPrice,
    baseUnit: comparison.baseUnit,
    comparable: comparison.comparable,
  };

  // One move, one alert. The same product re-crossing the same two prices later is the
  // same news, not new news - otherwise a price that oscillates between two values
  // (or a unit label that keeps flipping back) fills the inbox with copies.
  if (comparison.isIncrease && !suppressAlert && hasSameActiveAlert(product.id, vendorName, comparison.previousPrice, unitPrice)) {
    comparison.isIncrease = false;
  }

  if (comparison.isIncrease && !suppressAlert) {
    const alert: PriceAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      masterProductId: product.id,
      productName: product.name,
      vendorName,
      invoiceId,
      invoiceNumber,
      invoiceDate,
      previousPrice: comparison.previousPrice ?? 0,
      newPrice: unitPrice,
      deltaAmount: comparison.deltaAmount ?? 0,
      percentChange: comparison.percentChange ?? 0,
      detectedAt: new Date().toISOString(),
      status: 'active',
      unit: unit || product.standardUnit,
    };
    db.addAlert(alert);
    result.hasPriceIncrease = true;
    result.alertCreated = alert;
  }

  product.priceHistory.push({
    date: invoiceDate,
    vendor: vendorName,
    unitPrice,
    invoiceNumber,
    unit: unit || undefined,
    baseUnitPrice: comparison.baseUnitPrice,
  });
  recalculateProductStats(product);
  product.lastPurchaseDate = invoiceDate;
  db.saveMasterProduct(product);

  return result;
}

/** Recalculates stored prices after a user corrected a line, without inventing alerts. */
export function rebaseProductPrices(product: MasterProduct): void {
  recalculateProductStats(product);
  db.saveMasterProduct(product);
}
