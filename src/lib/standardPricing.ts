/**
 * How the price of a product is quoted, decided from its NAME.
 *
 * Rule (owner's):
 *   - the name states a capacity ("24*560ML", "20L", "3*4LT")  -> sold by the BOTTLE,
 *     and the product's price is quoted per litre  ($/L)
 *   - the name states a weight ("14KG", "10*1KG", "1kg椰奶")    -> sold by the BAG,
 *     and the product's price is quoted per kilo   ($/kg)
 *   - the name states neither                                  -> sold by the PIECE,
 *     and the price is quoted per each             ($/ea)
 *
 * Meat is the exception and is left alone: it is already priced from the invoice's own
 * Weight column in the meat-pricing layer, so it stays $/kg whatever the name says.
 *
 * Deliberately free of Node / database imports - the browser bundles this too.
 */

export type StandardMeasure = 'volume' | 'weight' | 'count';
export type StandardUnitCode = 'L' | 'kg' | 'ea';
export type StandardSellingUnit = 'bottle' | 'bag' | 'ea';

/** Units that describe a whole case rather than one container. */
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

/** Weight words with their size in kilograms. Longer spellings must come first. */
const WEIGHT_WORDS =
  'kilograms?|kilos?|kgs?|公斤|千克|grams?|grs?|gms?|gm|pounds?|lbs?|克|斤|k|g|lb';
/** Capacity words with their size in litres. */
const VOLUME_WORDS =
  'millilitres?|milliliters?|mls?|litres?|liters?|ltrs?|lts?|毫升|公升|升|gallons?|gal|quarts?|qt|ml|l|m';

/** "24*560ML", "1KG", "20L" - the count is optional. */
function packScan(source: string, words: string): RegExp {
  return new RegExp(
    `(?:(\\d+)\\s*[*xX/]\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(${words})(?![a-z])`,
    'gi'
  );
}

interface PackReading {
  count: number;
  size: number;
  unit: string;
  /** Where in the text it was found, so two readings can be ordered. */
  index: number;
}

/** The last "number + unit" statement in a name - the pack is written at the end. */
function lastPackReading(text: string, words: string): PackReading | null {
  const regex = packScan(text, words);
  let last: PackReading | null = null;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const size = Number(String(match[2]).replace(',', '.'));
    if (!Number.isFinite(size) || !(size > 0)) continue;
    last = {
      count: match[1] ? Number(match[1]) : 1,
      size,
      unit: match[3].toLowerCase(),
      index: match.index,
    };
  }
  return last;
}

function weightFactor(word: string): number | null {
  if (/^(kg|kilos?|kilograms?|公斤|千克|k)$/.test(word)) return 1;
  if (/^(g|gr|gm|gms?|grams?|克)$/.test(word)) return 0.001;
  if (/^(lb|lbs|pound|pounds|磅)$/.test(word)) return 0.453592;
  if (/^斤$/.test(word)) return 0.5;
  return null;
}

function volumeFactor(word: string): number | null {
  if (/^(l|lt|ltr|ltrs?|litre|litres?|liter|liters?|升|公升)$/.test(word)) return 1;
  if (/^(ml|mls|millilitre|millilitre?s|milliliter|milliliters?|毫升|m)$/.test(word)) return 0.001;
  if (/^(gal|gallon|gallons|加仑)$/.test(word)) return 3.78541;
  if (/^(qt|quart|quarts|夸脱)$/.test(word)) return 0.946353;
  return null;
}

function canonicalUnit(unit?: string | null): string {
  return (unit || '').trim().toLowerCase().replace(/[.]+$/, '');
}

export interface StandardPriceInput {
  rawDescription?: string | null;
  masterProductName?: string | null;
  brand?: string | null;
  packSize?: string | null;
  unit?: string | null;
  unitPrice?: number | null;
  /** Set by the caller for meat lines, which are priced from the invoice weight column. */
  isMeat?: boolean;
}

export interface StandardPrice {
  /** The price in the canonical unit, or null when the line says too little to convert. */
  price: number | null;
  /** '$/L' | '$/kg' | '$/ea'. */
  unit: StandardUnitCode;
  measure: StandardMeasure;
  /** What the supplier counts the goods in - 按瓶 / 按包 / 按个. */
  sellingUnit: StandardSellingUnit;
}

/** What the goods are counted in, and therefore what the price is quoted per. */
export function standardMeasure(input: StandardPriceInput): StandardMeasure {
  if (input.isMeat) return 'weight';

  // The pack size column states the pack even when the OCR mangled the product name,
  // but the name is what the rule asks for - so the name is read first.
  const texts = [input.rawDescription, input.masterProductName, input.packSize]
    .filter((t): t is string => Boolean(t && t.trim()))
    .map((t) => t);

  for (const text of texts) {
    const volume = lastPackReading(text, VOLUME_WORDS);
    const weight = lastPackReading(text, WEIGHT_WORDS);
    if (volume && weight) {
      // Both appear: the later statement in the name is the one the pack is sold as.
      return volume.index > weight.index ? 'volume' : 'weight';
    }
    if (volume) return 'volume';
    if (weight) return 'weight';
  }

  return 'count';
}

export function standardUnitCode(measure: StandardMeasure): StandardUnitCode {
  if (measure === 'volume') return 'L';
  if (measure === 'weight') return 'kg';
  return 'ea';
}

export function standardSellingUnit(measure: StandardMeasure): StandardSellingUnit {
  if (measure === 'volume') return 'bottle';
  if (measure === 'weight') return 'bag';
  return 'ea';
}

/**
 * The invoiced price re-expressed in the canonical unit - $/L, $/kg or $/ea.
 *
 * Everything hinges on how much of the product one invoiced unit holds: "24*560ML" sold
 * per carton holds 13.44 L, sold per can holds 0.56 L, and both work out to the same
 * price per litre. When the unit cannot be mapped onto the pack, null is returned - the
 * line is then shown at its printed price rather than at a number nobody asked for.
 */
export function standardPrice(input: StandardPriceInput): StandardPrice {
  const measure = standardMeasure(input);
  const unit = standardUnitCode(measure);
  const sellingUnit = standardSellingUnit(measure);

  const price = Number(input.unitPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { price: null, unit, measure, sellingUnit };
  }

  const invoiced = canonicalUnit(input.unit);

  // Meat is already per kilogram by the time it reaches here.
  if (measure === 'weight' && (input.isMeat || invoiced === 'kg')) {
    return { price: round(price), unit, measure, sellingUnit };
  }

  const source = [input.packSize, input.rawDescription, input.masterProductName]
    .filter((t): t is string => Boolean(t && t.trim()))
    .join(' ');

  const words = measure === 'volume' ? VOLUME_WORDS : measure === 'weight' ? WEIGHT_WORDS : null;
  if (!words) {
    // Sold by the piece: the number of pieces in the pack is the only thing that can
    // convert a case price into a price per piece - "30*CHINA" invoiced per carton is
    // 30 eggs, so the case price divides by 30.
    const perCase = /(\d+)\s*[*xX/]\s*/.exec(source);
    const divisor = AGGREGATE_UNITS.has(invoiced) && perCase ? Number(perCase[1]) : 1;
    if (!(divisor > 0)) return { price: null, unit, measure, sellingUnit };
    return { price: round(price / divisor), unit, measure, sellingUnit };
  }

  const reading = lastPackReading(source, words);
  if (!reading) return { price: null, unit, measure, sellingUnit };

  const factor = measure === 'volume' ? volumeFactor(reading.unit) : weightFactor(reading.unit);
  if (factor == null) return { price: null, unit, measure, sellingUnit };

  const perContainer = reading.size * factor;
  const perCarton = reading.count * perContainer;
  if (!(perContainer > 0)) return { price: null, unit, measure, sellingUnit };

  // A unit that is itself the measure ("$6.00 per kg") needs no pack at all.
  const direct = measure === 'volume' ? volumeFactor(invoiced) : weightFactor(invoiced);
  if (direct != null) return { price: round(price / direct), unit, measure, sellingUnit };

  const divisor = AGGREGATE_UNITS.has(invoiced) && reading.count > 1 ? perCarton : perContainer;
  return { price: round(price / divisor), unit, measure, sellingUnit };
}

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
