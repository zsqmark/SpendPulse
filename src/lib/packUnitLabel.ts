/**
 * The one rule for tagging a product: read the unit off its pack specification.
 *
 * Rule (owner's, restated 2026-11-02):
 *   - the pack is written in a WEIGHT   (g, kg, mg, 斤, 磅, lb, oz ...)   -> tag `bag`
 *   - the pack is written in a CAPACITY (ml, l, L, 升, 公升, gal, qt ...) -> tag `bottle`
 *   - the pack states nothing readable                                    -> tag `ea` (DEFAULT_SELLING_UNIT)
 *
 * The unit is the ONLY input. The product's other words, its category and whether the
 * description looks like meat are deliberately not consulted - hunting for keywords across
 * the description is what filed `FISH CURRY PWD` under seafood and priced a 10 kg carton of
 * curry powder as though it were a single 250 g packet.
 *
 * Browser-safe and React-free: no db, no LLM - the same rule as the other modules in src/lib.
 */

/** What the pack is measured in. */
export type StandardMeasure = 'volume' | 'weight' | 'count';
/** How the price is quoted once the measure is known: '$/L' | '$/kg' | '$/ea'. */
export type StandardUnitCode = 'L' | 'kg' | 'ea';
/** The tag a product carries: 按瓶 / 按包 / 按个. */
export type StandardSellingUnit = 'bottle' | 'bag' | 'ea';

/**
 * Why a tag was chosen.
 *
 * `weight` / `volume` mean the pack said so. `missing` means there was no specification at
 * all; `unrecognised` means there was one but its unit is not in the table. Both fall back to
 * DEFAULT_SELLING_UNIT, and the difference is reported so a default is never mistaken for a
 * reading.
 */
export type UnitLabelReason = 'weight' | 'volume' | 'missing' | 'unrecognised';

/** What a unit word means: which measure it belongs to, and its size in that measure. */
interface UnitMeaning {
  measure: 'weight' | 'volume';
  /** How many primary units one of this unit holds: kg for weight, L for volume. */
  inPrimary: number;
}

function weight(sizeInKg: number): UnitMeaning {
  return { measure: 'weight', inPrimary: sizeInKg };
}

function volume(sizeInL: number): UnitMeaning {
  return { measure: 'volume', inPrimary: sizeInL };
}

/**
 * Every spelling we accept for a pack unit.
 *
 * Keys are lowercase with separators removed, and `foldUnitWord` folds a word the same way
 * before it is looked up - so "Kg", "K.G.", "k g" and "kg." all read as `kg`, and
 * "fl oz" / "fl.oz" / "FL OZ" all fold to `floz`.
 *
 * Because this is a plain lookup there is no ordering to get wrong, unlike the alternation
 * it replaced, where listing "g" ahead of "gm" let the shorter word swallow the longer one and
 * turned a gram-scale packet into a plain gram.
 *
 * `oz` is weight and `floz` is capacity: the ounce and the fluid ounce are different units,
 * and a pack printed "16 floz" is not the same size as one printed "16 oz".
 *
 * Note what is absent on purpose: no bare `m`. It is genuinely ambiguous - millilitre in one
 * supplier's shorthand, metre in another's - and a cling-film roll printed "600M" is 600 m of
 * film, not 0.6 L. Leaving it unknown tags such a product `ea` rather than guessing.
 */
const UNIT_TABLE: Record<string, UnitMeaning> = {
  // ---- weight, sized in kilograms ----
  kg: weight(1),
  kgs: weight(1),
  kilo: weight(1),
  kilos: weight(1),
  kilogram: weight(1),
  kilograms: weight(1),
  k: weight(1),
  千克: weight(1),
  公斤: weight(1),
  g: weight(0.001),
  gr: weight(0.001),
  gm: weight(0.001),
  gms: weight(0.001),
  gram: weight(0.001),
  grams: weight(0.001),
  克: weight(0.001),
  mg: weight(0.000001),
  毫克: weight(0.000001),
  斤: weight(0.5),
  两: weight(0.05),
  lb: weight(0.453592),
  lbs: weight(0.453592),
  pound: weight(0.453592),
  pounds: weight(0.453592),
  磅: weight(0.453592),
  oz: weight(0.0283495),
  ounce: weight(0.0283495),
  ounces: weight(0.0283495),
  盎司: weight(0.0283495),

  // ---- capacity, sized in litres ----
  l: volume(1),
  lt: volume(1),
  ltr: volume(1),
  ltrs: volume(1),
  litre: volume(1),
  litres: volume(1),
  liter: volume(1),
  liters: volume(1),
  升: volume(1),
  公升: volume(1),
  ml: volume(0.001),
  mls: volume(0.001),
  millilitre: volume(0.001),
  millilitres: volume(0.001),
  milliliter: volume(0.001),
  milliliters: volume(0.001),
  毫升: volume(0.001),
  floz: volume(0.0295735),
  fluidounce: volume(0.0295735),
  液量盎司: volume(0.0295735),
  cl: volume(0.01),
  厘升: volume(0.01),
  dl: volume(0.1),
  分升: volume(0.1),
  gal: volume(3.78541),
  gallon: volume(3.78541),
  gallons: volume(3.78541),
  加仑: volume(3.78541),
  qt: volume(0.946353),
  quart: volume(0.946353),
  quarts: volume(0.946353),
  夸脱: volume(0.946353),
};

/**
 * Folds a unit word ready for the table.
 *
 * Suppliers write one unit as "Kg", "K G", "kg." and "KG", and OCR adds stray dots and
 * hyphens, so case, whitespace and separator punctuation are all dropped. "fl. oz"
 * therefore folds to `floz`, which is how it is spelled above.
 */
function foldUnitWord(word?: string | null): string {
  return (word ?? '').trim().toLowerCase().replace(/[\s.\-_/]+/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A figure followed by a unit word: "560ML" inside "24*560ML".
 *
 * The unit is matched against the vocabulary above rather than as "any run of letters":
 * the latter reads `4.5L SQUARE CONTAINER+LID` as a unit called "lsquarecontainer",
 * because there is no word boundary between the pack and the description that follows it.
 * Longest spellings are tried first so "kilograms" is read before "kg".
 */
const FIGURE_UNIT_PAIR = new RegExp(
  `(\\d+(?:[.,]\\d+)?)\\s*(${Object.keys(UNIT_TABLE)
    .sort((a, b) => b.length - a.length)
    .map((key) => key.split('').map(escapeRegExp).join('[\\s.\\-_/]*'))
    .join('|')})`,
  'gi'
);

/**
 * The figure-and-unit a pack specification states, taken from the LAST such statement.
 *
 * Specifications are written from the outside in - "12*(12*35G)" is a case of twelve inner
 * packs of 35 g - so the container is whatever follows the last figure. Reading the first
 * figure instead would size a twelve-pack as though it were one 12 g packet.
 */
function lastFigureUnit(text: string): { source: string; count: number; size: number } | null {
  // Drop whitespace, thousands separators and hyphens first: "1.5 L", "1,5L" and "1.5-L" then
  // all read as "1.5l". The figure is still parsed from the folded text.
  const folded = text.toLowerCase().replace(/[\s,\-]+/g, '');
  const regex = new RegExp(FIGURE_UNIT_PAIR.source, FIGURE_UNIT_PAIR.flags);
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = regex.exec(folded)) !== null) last = match;
  if (!last) return null;

  const size = Number(String(last[1]).replace(',', '.'));
  if (!Number.isFinite(size) || !(size > 0)) return null;

  // "24*560ML" -> the "24*" standing immediately before the size figure.
  const prefix = /(\d+)\s*[*x/]\s*$/.exec(folded.slice(0, last.index));
  const count = prefix ? Number(prefix[1]) : 1;

  return { source: last[2], count: count > 0 ? count : 1, size };
}

/** What a pack specification tells us, once its unit has been recognised. */
export interface SpecMeasure {
  /** The unit as printed, so the UI can quote the pack's own wording. */
  source: string;
  /** The same unit folded, which is what the table is keyed by. */
  matched: string;
  measure: 'weight' | 'volume';
  /** How many primary units one of this unit holds. */
  factor: number;
  /** How many containers the pack holds: "24*560ML" -> 24. */
  count: number;
  /** The figure printed for ONE container: "24*560ML" -> 560. */
  size: number;
  /** Primary units per container: 560 mL -> 0.56 L. */
  perContainer: number;
  /** Primary units per whole pack: 24 x 0.56 = 13.44 L. */
  perCarton: number;
}

/**
 * Reads a pack specification - "24*560ML", "1.5 L", "40*250G".
 *
 * Returns the unit it is written in, how big that unit is, and how many containers the pack
 * holds. Null when the text states no figure-and-unit, or states one in a unit the table
 * does not know - either way there is nothing to classify.
 */
export function specMeasureOf(text?: string | null): SpecMeasure | null {
  const source = (text ?? '').trim();
  if (!source) return null;

  const pair = lastFigureUnit(source);
  if (!pair) return null;

  const meaning = UNIT_TABLE[foldUnitWord(pair.source)];
  if (!meaning) return null;

  const perContainer = pair.size * meaning.inPrimary;

  return {
    source: pair.source,
    matched: foldUnitWord(pair.source),
    measure: meaning.measure,
    factor: meaning.inPrimary,
    count: pair.count,
    size: pair.size,
    perContainer,
    perCarton: pair.count * perContainer,
  };
}

/** Classifying a unit given on its own, with no figure in front of it. */
export interface UnitMeasure {
  /** The word as given. */
  source: string;
  /** The same word, folded. */
  matched: string;
  measure: 'weight' | 'volume';
  /** How many primary units one of this unit holds. */
  factor: number;
}

/**
 * Classifies a unit given on its own, with no figure in front of it.
 *
 * For the case where the unit the goods are invoiced in IS the measure - a line printed
 * "$6.00 per kg" states its own basis and needs no pack size. Containers (bag, bottle,
 * carton...) are not measures and return null.
 */
export function unitMeasureOf(unit?: string | null): UnitMeasure | null {
  const key = foldUnitWord(unit);
  if (!key) return null;
  const meaning = UNIT_TABLE[key];
  if (!meaning) return null;
  return {
    source: (unit ?? '').trim(),
    matched: key,
    measure: meaning.measure,
    factor: meaning.inPrimary,
  };
}

/** The tag a product carries, decided from its pack specification alone. */
export interface UnitLabel {
  /** `bag` for a weight, `bottle` for a capacity, `ea` when nothing was readable. */
  unit: StandardSellingUnit;
  measure: StandardMeasure;
  /** The unit word as printed. Absent when the specification was missing entirely. */
  source?: string;
  /** The unit word, folded. Absent when the specification was missing entirely. */
  matched?: string;
  reason: UnitLabelReason;
  /**
   * True when nothing readable was found and `DEFAULT_SELLING_UNIT` was applied, so the UI can
   * say so instead of implying the tag was worked out from the pack.
   */
  isDefault: boolean;
}

/**
 * What a product is not telling us - the tag to fall back on.
 *
 * A product with no readable pack specification is priced per item, not per kilo or per litre.
 * Inventing a measure would put a number on the catalogue nobody signed off.
 */
export const DEFAULT_SELLING_UNIT: StandardSellingUnit = 'ea';

const DEFAULT_REASON: Record<'missing' | 'unrecognised', string> = {
  missing: 'No pack specification',
  unrecognised: 'Pack unit not recognised',
};

/**
 * The tag for one product.
 *
 * The unit on the specification decides everything: a weight tags `bag`, a capacity tags
 * `bottle`. Anything else - no specification, or one written in a unit we do not know -
 * falls to DEFAULT_SELLING_UNIT with `isDefault` set, so a default is always visible as one.
 */
export function labelForSpec(packSpec?: string | null): UnitLabel {
  const text = (packSpec ?? '').trim();
  if (!text) {
    return { unit: DEFAULT_SELLING_UNIT, measure: 'count', reason: 'missing', isDefault: true };
  }

  const pair = lastFigureUnit(text);
  if (!pair) {
    return {
      unit: DEFAULT_SELLING_UNIT,
      measure: 'count',
      reason: 'unrecognised',
      isDefault: true,
    };
  }

  const matched = foldUnitWord(pair.source);
  const meaning = UNIT_TABLE[matched];
  if (!meaning) {
    return {
      unit: DEFAULT_SELLING_UNIT,
      measure: 'count',
      source: pair.source,
      matched,
      reason: 'unrecognised',
      isDefault: true,
    };
  }

  return {
    unit: meaning.measure === 'weight' ? 'bag' : 'bottle',
    measure: meaning.measure,
    source: pair.source,
    matched,
    reason: meaning.measure,
    isDefault: false,
  };
}

/** Why a default was used, in words for the UI. Empty when the pack was read. */
export function explainDefaultReason(reason: UnitLabelReason): string {
  if (reason === 'weight' || reason === 'volume') return '';
  return DEFAULT_REASON[reason] ?? '';
}

/** Why a default was used, in words for the UI. Empty when the pack was read. */
export function explainDefault(label: UnitLabel): string {
  return explainDefaultReason(label.reason);
}

/** How much of the product the whole pack holds, in the primary unit. */
export function packSizeInPrimary(text?: string | null): number | null {
  return specMeasureOf(text)?.perCarton ?? null;
}

/**
 * Which measure a unit belongs to, without needing a figure in front of it.
 *
 * Same table, same vocabulary - declared last because it reads the one above.
 */
export function classifySpecUnit(unit?: string | null): 'weight' | 'volume' | null {
  return unitMeasureOf(unit)?.measure ?? null;
}

/** How many primary units one of a unit holds. Null for a word we do not know. */
export function measureFactorOf(unit?: string | null): number | null {
  return unitMeasureOf(unit)?.factor ?? null;
}

/** The unit word printed on a pack specification, or null when there is none. */
export function specUnitOf(text?: string | null): { source: string; matched: string } | null {
  const pair = lastFigureUnit((text ?? '').trim());
  if (!pair) return null;
  return { source: pair.source, matched: foldUnitWord(pair.source) };
}
