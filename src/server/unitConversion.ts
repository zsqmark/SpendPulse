/**
 * Wholesale invoices sell the same product in a hierarchy: a carton holds several packs,
 * a pack holds several bags. A price of "$12 / carton" and "$1.20 / pack" can look like a
 * 900% increase while the product has not moved at all.
 *
 * This module turns a pack description ("10*1KG", "3*4LT", "12*640ML") into a conversion
 * table so every price can be expressed per base unit before it is compared.
 */

import { canonicalUnit } from './aliasMatcher.ts';

export const BASE_UNITS = ['each', 'kg', 'g', 'l', 'ml'] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];

/** Base units that measure the same thing, with their size relative to the primary one. */
/** Base measure tables, exported so callers can seed a product's conversions from a
 *  base-unit line alone (no pack size required). */
export const WEIGHT_IN_KG: Record<string, number> = { kg: 1, g: 0.001, lb: 0.453592 };
export const VOLUME_IN_L: Record<string, number> = { l: 1, ml: 0.001, gal: 3.78541, qt: 0.946353 };

/** Units that hold a whole pack/carton rather than a base measure. */
const PACK_UNITS = ['case', 'carton', 'ctn', 'cs', 'pack', 'bag', 'box', 'tray', 'tin', 'tub', 'bottle', 'roll'];

/** Aggregate units that hold MANY single containers - their count is only known when the pack says so. */
const AGGREGATE_PACK_UNITS = ['case', 'carton', 'ctn', 'cs'];
/** Single-container units: each one names exactly one container of the pack size. */
const SINGLE_CONTAINER_PACK_UNITS = PACK_UNITS.filter((u) => !AGGREGATE_PACK_UNITS.includes(u));

export interface UnitConversions {
  /** The measure every price of this product is normalised to. */
  baseUnit: BaseUnit;
  /** canonical unit -> how many base units one of that unit contains. */
  conversions: Record<string, number>;
}

/** Normalises "10*1KG" / "12 x 640ML" / "700G" into a count × size × unit triple. */
function parsePackExpression(packSize: string): { count: number; size: number; unit: string } | null {
  const s = packSize.toLowerCase().replace(/\s+/g, '').replace(/,/g, '');
  if (!s) return null;

  // "10*1kg", "3x4lt", "12*640ml", "4/1gal"
  const compound = s.match(/^(\d+)\s*[*x\/]\s*(\d+(?:\.\d+)?)([a-z]+)$/);
  if (compound) {
    return { count: Number(compound[1]), size: Number(compound[2]), unit: compound[3] };
  }

  // "1kg", "700g", "4lt"
  const simple = s.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
  if (simple) {
    return { count: 1, size: Number(simple[1]), unit: simple[2] };
  }

  return null;
}

function baseUnitFor(unit: string): { baseUnit: BaseUnit; sizeInBase: number } | null {
  const u = canonicalUnit(unit);
  if (u in WEIGHT_IN_KG) return { baseUnit: 'kg', sizeInBase: WEIGHT_IN_KG[u] };
  if (u in VOLUME_IN_L) return { baseUnit: 'l', sizeInBase: VOLUME_IN_L[u] };
  return null;
}

/**
 * Whether a single invoicing unit is itself a base measure (kg / g / l / ml / each).
 * Such a line is comparable on its own unit from just the unit + unitPrice - it does
 * NOT need a pack size, and the product name is never consulted for one.
 *
 * Returns the base unit and the factor to turn one of that unit into one base unit
 * (e.g. 1 g -> 0.001 kg), or null for pack/aggregate units (carton, pack, bottle, ...)
 * that only become comparable once a pack size teaches their content.
 */
export function baseUnitForDirectUnit(unit?: string | null): { baseUnit: BaseUnit; factor: number } | null {
  if (!unit) return null;
  const u = canonicalUnit(unit);
  if (u in WEIGHT_IN_KG) return { baseUnit: 'kg', factor: WEIGHT_IN_KG[u] };
  if (u in VOLUME_IN_L) return { baseUnit: 'l', factor: VOLUME_IN_L[u] };
  if (u === 'each') return { baseUnit: 'each', factor: 1 };
  return null;
}

/**
 * Builds the conversion table for a product from its pack description.
 * Returns null when the pack size says nothing usable - those prices must then be
 * treated as non-comparable instead of being guessed at.
 */
export function buildUnitConversions(packSize?: string | null): UnitConversions | null {
  if (!packSize) return null;
  const parsed = parsePackExpression(packSize);
  if (!parsed) return null;

  const measure = baseUnitFor(parsed.unit);
  if (!measure) return null;

  const onePack = parsed.size * measure.sizeInBase;
  const perCarton = parsed.count * onePack;
  if (!(perCarton > 0)) return null;

  const baseUnit: BaseUnit = measure.baseUnit;
  const conversions: Record<string, number> = {};

  // The measured units themselves (kg / g / lb, or l / ml / gal / qt).
  const measureTable = baseUnit === 'kg' ? WEIGHT_IN_KG : VOLUME_IN_L;
  for (const [unit, factor] of Object.entries(measureTable)) {
    conversions[unit] = factor;
  }
  conversions[baseUnit] = 1;

  if (parsed.count > 1) {
    // "10*1KG" -> a carton/case holds 10 packs, but a single pack/bottle/tin still holds 1.
    for (const u of AGGREGATE_PACK_UNITS) conversions[u] = perCarton;
    for (const u of SINGLE_CONTAINER_PACK_UNITS) conversions[u] = onePack;
    conversions.each = onePack;
  } else {
    // A single container: every single-container unit names that one container, so
    // "1*8l" invoiced per bottle means 1 bottle = 8 L. Aggregate units (case/carton/...)
    // are left unset because their count is genuinely unknown.
    for (const u of SINGLE_CONTAINER_PACK_UNITS) conversions[u] = onePack;
    conversions.each = onePack;
  }

  return { baseUnit, conversions };
}

/**
 * Converts a price into the product's base unit.
 * Returns null when the unit has no known conversion - i.e. the price is not comparable.
 */
export function toBasePrice(
  unitPrice: number,
  unit: string | undefined,
  conversions: Record<string, number> | undefined,
  baseUnit: BaseUnit | undefined
): number | null {
  if (!conversions || !baseUnit) return null;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;

  const factor = conversions[canonicalUnit(unit)];
  if (!factor || !(factor > 0)) return null;

  return unitPrice / factor;
}

/**
 * Converts a base price back into an invoicing unit, so an alert can be shown in the
 * same unit as the invoice instead of an abstract base measure.
 */
export function fromBasePrice(
  basePrice: number,
  unit: string | undefined,
  conversions: Record<string, number> | undefined
): number | null {
  if (!conversions || !Number.isFinite(basePrice)) return null;
  const factor = conversions[canonicalUnit(unit)];
  if (!factor || !(factor > 0)) return null;
  return basePrice * factor;
}

/** Merges newly learned conversions into an existing table without inventing values. */
export function mergeConversions(
  existing: Record<string, number> | undefined,
  incoming: Record<string, number> | undefined
): Record<string, number> | undefined {
  if (!incoming) return existing;
  const merged = { ...(existing || {}) };
  for (const [unit, factor] of Object.entries(incoming)) {
    if (!(unit in merged) && factor > 0) merged[unit] = factor;
  }
  return merged;
}

/** How a base unit is written on screen. */
export function formatBaseUnit(baseUnit?: string | null): string {
  if (!baseUnit) return '';
  if (baseUnit === 'kg') return 'kg';
  if (baseUnit === 'g') return 'g';
  if (baseUnit === 'l') return 'L';
  if (baseUnit === 'ml') return 'mL';
  if (baseUnit === 'each') return 'ea';
  return baseUnit;
}

/** Invoicing units that count containers rather than measuring content. */
const COUNTING_UNITS = ['case', 'each', 'pack', 'bag', 'box', 'tray', 'roll', 'tin', 'tub', 'bottle'];

/**
 * The coarse thing a product is priced by - weight, volume, or a count of containers.
 *
 * Two lines priced by different measures can never be the same product: a drum of bleach
 * sold per 20 L has nothing to do with a box of salt sold per 14 kg, however similar their
 * names look to a matcher. Keeping them apart is the difference between a price history
 * and a pile of unrelated numbers.
 */
export type MeasureClass = 'weight' | 'volume' | 'count';

/**
 * Reads the measure out of a pack description even when it hides behind a container word.
 * OCR writes these constantly - "1bag*1KG", "2jars*20L", "700g (15 dozens/box)",
 * "5bottles*200G" - and every one of them is a weight or a volume, not a new kind of unit.
 */
const MEASURE_IN_TEXT =
  /(\d+(?:\.\d+)?)\s*(kilograms?|kilos?|kgs?|ks?|grams?|gr|gms?|gm|lbs?|pounds?|millilitres?|milliliters?|mls?|litres?|liters?|ltrs?|gals?|gallons?|qts?|quarts?|g|l|m|k)\b/;

function measureFromPackText(packSize?: string | null): MeasureClass | null {
  if (!packSize) return null;
  const match = String(packSize).toLowerCase().replace(/,/g, ' ').match(MEASURE_IN_TEXT);
  if (!match) return null;
  // Wholesale shorthand arrives without its vowels - "20K" is 20 kg, "500gr" is 500 g and
  // "12*400M" (a recurring truncation of this supplier's "12*400ML") is 400 mL.
  const measure = canonicalUnit(
    match[2].replace(/^k$/, 'kg').replace(/^(gr|gm|gms)$/, 'g').replace(/^m$/, 'ml')
  );
  if (['kg', 'g', 'lb'].includes(measure)) return 'weight';
  if (['l', 'ml', 'gal', 'qt'].includes(measure)) return 'volume';
  return null;
}

/**
 * What a line (or a catalogue product) is priced by.
 *
 * The pack size is asked first because it states what is actually inside the container -
 * "14KG" is sold by weight even when the invoice label says "Carton". The invoicing unit
 * is only consulted when the pack says nothing.
 *
 * Returns null when neither is informative. An unknown measure must never be the reason
 * two products are kept apart; only a *known conflict* blocks a merge.
 */
export function measureClassOf(packSize?: string | null, unit?: string | null): MeasureClass | null {
  const fromPack = buildUnitConversions(packSize);
  if (fromPack) return fromPack.baseUnit === 'kg' ? 'weight' : 'volume';

  const fromPackText = measureFromPackText(packSize);
  if (fromPackText) return fromPackText;

  const direct = baseUnitForDirectUnit(unit);
  if (direct) {
    if (direct.baseUnit === 'kg') return 'weight';
    if (direct.baseUnit === 'l') return 'volume';
    // "each" names nothing about what is in the container - a "per each" price can sit on
    // a kilogram, a litre or a single can. Treating it as unknown keeps one product from
    // being split apart whenever OCR misses the pack column on a single invoice.
    return null;
  }

  return COUNTING_UNITS.includes(canonicalUnit(unit)) ? 'count' : null;
}

/** Plain-English description for error messages shown to the user. */
export function describeMeasure(measure: MeasureClass | null): string {
  if (measure === 'weight') return 'by weight (kg / g)';
  if (measure === 'volume') return 'by volume (L / mL)';
  if (measure === 'count') return 'by the container (each / carton)';
  return 'by an unstated measure';
}

/**
 * True only when two prices genuinely measure different things - weight against volume.
 *
 * A "count" price is deliberately NOT a conflict: "$14 per box" says nothing about what is
 * in the box, and OCR drops the pack column often enough that treating count as a separate
 * measure would scatter one product across several master products. Mass versus litres is
 * a different story - those can never describe the same goods.
 */
export function measuresConflict(a: MeasureClass | null, b: MeasureClass | null): boolean {
  if (!a || !b) return false;
  const pair = [a, b].sort().join('|');
  return pair === 'volume|weight';
}
