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
import { unitMeasureClass } from './aliasMatcher.ts';
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
