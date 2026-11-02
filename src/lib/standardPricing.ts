/**
 * How the price of a product is quoted, and the tag that product carries.
 *
 * The tag comes from ONE place - the unit written on the pack specification - and that
 * vocabulary lives in packUnitLabel.ts. Everything here only turns it into money.
 *
 *   - a pack written in a WEIGHT   (g, kg, mg, 斤, 磅, lb, oz ...)   -> tag `bag`,    quoted $/kg
 *   - a pack written in a CAPACITY (ml, l, L, 升, 公升, gal, qt ...)  -> tag `bottle`, quoted $/L
 *   - a pack stating nothing readable                                -> tag `ea`,     quoted $/ea
 *
 * Deliberately free of Node / database imports - the browser bundles this too.
 */

import {
  DEFAULT_SELLING_UNIT,
  explainDefaultReason,
  labelForSpec,
  specMeasureOf,
  unitMeasureOf,
} from './packUnitLabel.ts';

export type {
  StandardMeasure,
  StandardUnitCode,
  StandardSellingUnit,
  UnitLabel,
  UnitLabelReason,
} from './packUnitLabel.ts';

import type {
  SpecMeasure,
  StandardMeasure,
  StandardUnitCode,
  StandardSellingUnit,
  UnitLabelReason,
} from './packUnitLabel.ts';

export interface StandardPriceInput {
  rawDescription?: string | null;
  masterProductName?: string | null;
  brand?: string | null;
  /** The pack specification - "24*560ML", "1.5 L", "40*250G". The only thing read. */
  packSize?: string | null;
  unit?: string | null;
  unitPrice?: number | null;
}

export interface StandardPrice {
  /** The price in the canonical unit, or null when the line says too little to convert. */
  price: number | null;
  /** '$/L' | '$/kg' | '$/ea'. */
  unit: StandardUnitCode;
  measure: StandardMeasure;
  /** What the supplier counts the goods in - 按瓶 / 按包 / 按个. */
  sellingUnit: StandardSellingUnit;
  /** True when the pack said nothing readable and the default tag was applied. */
  isDefault: boolean;
  /** Why the default was applied, in words for the UI. Empty when the pack was read. */
  defaultReason: string;
}

/**
 * The pack specification for a line, in the order it is looked for:
 *
 *   1. the pack specification column - the supplier's own statement of the pack;
 *   2. the same figure written into the product name, when OCR left the column empty;
 *   3. the unit the goods are invoiced in, when that unit is itself a measure - a line printed
 *      "$6.00 per kg" states its own basis and needs no pack size at all.
 *
 * All three yield a UNIT, and that unit alone decides the tag. What is never consulted is
 * the rest of the product name, its category, or whether the description sounds like meat.
 */
function resolveSpec(
  input: StandardPriceInput
): { spec: SpecMeasure | null; reason: UnitLabelReason } {
  const fromColumn = specMeasureOf(input.packSize ?? '');
  if (fromColumn) return { spec: fromColumn, reason: fromColumn.measure };

  const fromName = specMeasureOf(
    `${input.rawDescription ?? ''} ${input.masterProductName ?? ''}`
  );
  if (fromName) return { spec: fromName, reason: fromName.measure };

  const fromUnit = unitMeasureOf(input.unit);
  if (fromUnit) {
    return {
      spec: {
        source: fromUnit.source,
        matched: fromUnit.matched,
        measure: fromUnit.measure,
        factor: fromUnit.factor,
        count: 1,
        size: 1,
        perContainer: fromUnit.factor,
        perCarton: fromUnit.factor,
      },
      reason: fromUnit.measure,
    };
  }

  const statedAnything = Boolean(
    [input.packSize, input.rawDescription, input.masterProductName, input.unit].some(
      (t) => Boolean(t && String(t).trim())
    )
  );
  return { spec: null, reason: statedAnything ? 'unrecognised' : 'missing' };
}

/** The quoting basis for a line: which measure, and what one invoiced unit holds. */
export interface LineQuote {
  /** '$/L' | '$/kg' | '$/ea'. */
  unit: StandardUnitCode;
  measure: StandardMeasure;
  /** What the supplier counts the goods in - 按瓶 / 按包 / 按个. */
  sellingUnit: StandardSellingUnit;
  /** The price in that unit, or null when the line says too little to convert. */
  price: number | null;
  /** True when the pack said nothing readable and the default tag was applied. */
  isDefault: boolean;
  /** Why the default was applied, in words for the UI. Empty when the pack was read. */
  defaultReason: string;
}

/**
 * Which measure a product's pack specification states.
 *
 * Thin wrapper kept so existing callers read as before; the rule is in `labelForSpec`.
 */
export function standardMeasure(input: StandardPriceInput): StandardMeasure {
  return resolveSpec(input).spec?.measure ?? 'count';
}

export function standardUnitCode(measure: StandardMeasure): StandardUnitCode {
  if (measure === 'volume') return 'L';
  if (measure === 'weight') return 'kg';
  return 'ea';
}

export function standardSellingUnit(measure: StandardMeasure): StandardSellingUnit {
  if (measure === 'weight') return 'bag';
  if (measure === 'volume') return 'bottle';
  return DEFAULT_SELLING_UNIT;
}

/**
 * The invoiced price re-expressed in the canonical unit - $/L, $/kg or $/ea.
 *
 * The specification's unit fixes the measure; its figure and count then say how much one
 * invoiced unit holds. "24*560ML" invoiced per carton holds 13.44 L and invoiced per can
 * holds 0.56 L, and both come out at the same price per litre. When the unit cannot be
 * mapped onto the pack, null is returned - the line is then shown at its printed price rather
 * than at a number nobody asked for.
 */
export function standardPrice(input: StandardPriceInput): StandardPrice {
  const { spec, reason } = resolveSpec(input);
  const measure: StandardMeasure = spec?.measure ?? 'count';
  const unit = standardUnitCode(measure);
  const sellingUnit = standardSellingUnit(measure);
  const isDefault = !spec;

  // Nothing readable on the pack: tag it 'ea' and say why, rather than dividing by a guess.
  if (!spec) {
    return {
      price: null,
      unit,
      measure,
      sellingUnit,
      isDefault,
      defaultReason: explainDefaultReason(reason),
    };
  }

  const price = Number(input.unitPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { price: null, unit, measure, sellingUnit, isDefault, defaultReason: '' };
  }

  if (!(spec.perContainer > 0)) {
    return { price: null, unit, measure, sellingUnit, isDefault, defaultReason: '' };
  }

  // A unit that IS the measure ("$6.00 per kg") needs no pack at all.
  const invoiced = canonicalUnit(input.unit);
  const directUnit = unitMeasureOf(invoiced);
  if (directUnit && directUnit.measure === measure && directUnit.factor > 0) {
    return {
      price: round(price / directUnit.factor),
      unit,
      measure,
      sellingUnit,
      isDefault,
      defaultReason: '',
    };
  }

  const divisor =
    AGGREGATE_UNITS.has(invoiced) && spec.count > 1
      ? spec.perCarton
      : spec.perContainer;

  if (!(divisor > 0)) {
    return { price: null, unit, measure, sellingUnit, isDefault, defaultReason: '' };
  }

  return {
    price: round(price / divisor),
    unit,
    measure,
    sellingUnit,
    isDefault,
    defaultReason: '',
  };
}

function canonicalUnit(unit?: string | null): string {
  return (unit ?? '').trim().toLowerCase().replace(/[.]+$/, '');
}

/** Units the supplier counts as a whole pack rather than one container. */
const AGGREGATE_UNITS = new Set([
  'case',
  'carton',
  'ctn',
  'ctns',
  'cs',
  'box',
  'boxes',
  'tray',
  'trays',
  'inner',
  'inn',
]);

function round(n: number): number {
  return Number(n.toFixed(4));
}

/** "$5.36/L" for display, or '' when the line cannot be converted. */
export function formatStandardPrice(result: StandardPrice | null | undefined): string {
  if (!result || result.price == null || !Number.isFinite(result.price)) return '';
  const value =
    result.price >= 1
      ? result.price.toFixed(2)
      : result.price >= 0.1
        ? result.price.toFixed(3)
        : result.price.toFixed(4);
  return `$${value}/${result.unit}`;
}

export { labelForSpec, specMeasureOf, unitMeasureOf, explainDefaultReason };
