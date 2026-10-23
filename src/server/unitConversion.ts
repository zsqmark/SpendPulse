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
