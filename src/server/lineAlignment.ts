/**
 * Historical alignment.
 *
 * When a new invoice is read, every line is compared with what the same product looked
 * like the last time it was bought, and the fields that must not drift between invoices
 * (unit, pack size, tax rate, category) are brought onto the historical value.
 *
 * Three rules govern everything here:
 *
 *   1. What the document printed is never destroyed. It stays on the line as
 *      `documentValue`, so a decision can always be re-examined.
 *   2. History wins only when it is safe. A unit is only moved when the two units can
 *      be converted into each other; otherwise the printed value stays and the line is
 *      flagged. A price is never invented - converting a unit converts its price by the
 *      same factor, which leaves the price per base unit untouched.
 *   3. The result is deterministic. The same document produces the same outcome and the
 *      same fingerprint, which is how a repeated upload is recognised rather than
 *      recorded twice.
 */

import { createHash } from 'node:crypto';
import {
  ALIGNED_FIELDS,
  type AlignedField,
  type AlignmentConflict,
  type AlignmentIdentityKind,
  type AlignmentSource,
  type FieldAlignment,
  type LineAlignment,
  type MasterProduct,
  type ProductAttributeRecord,
} from '../types/index.ts';
import {
  canonicalUnit,
  normalizePackForIdentity,
  normalizePackSize,
  normalizeTokens,
} from './aliasMatcher.ts';
import { buildUnitConversions, VOLUME_IN_L, WEIGHT_IN_KG } from './unitConversion.ts';
import { vendorKey } from '../lib/vendorNormalizer.ts';

/** One line waiting to be aligned, straight out of the extraction pipeline. */
export interface AlignmentInput {
  itemId: string;
  rawDescription: string;
  supplierSku?: string | null;
  packSize?: string | null;
  unit: string;
  unitPrice: number;
  vendorName?: string | null;
  invoiceId: string;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  /** The catalogue entry the matcher filed this line under, if any. */
  product?: MasterProduct | null;
  /**
   * True when weight pricing has already set this line's unit (meat). That unit belongs
   * to the weight rule, not to history, and must not be moved.
   */
  weightPriced?: boolean;
  /** Tax rate the document stated for the line, when the supplier prints one. */
  taxRate?: number | null;
}

/** What alignment decided, ready to be written onto the line. */
export interface AlignmentOutcome {
  unit: string;
  unitPrice: number;
  packSize: string | null;
  taxRate: number | null;
  category: string | null;
  alignment: LineAlignment;
}

/* ------------------------------------------------------------------ identity */

export interface LineIdentity {
  /** "sku:" when the supplier's own item code was usable, otherwise "name:". */
  key: string;
  kind: 'sku' | 'name_spec';
  skuKey: string | null;
  nameKey: string;
}

/**
 * A usable item code: letters and digits only, and long enough not to be OCR noise.
 * A one or two character "code" is almost always a stray fragment of a column.
 */
function cleanSku(sku?: string | null): string | null {
  const s = String(sku || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 3 ? s : null;
}

export function identityFor(input: AlignmentInput): LineIdentity {
  const vendor = vendorKey(input.vendorName);
  const sku = cleanSku(input.supplierSku);
  const skuKey = sku ? `sku:${vendor}|${sku}` : null;

  const tokens = Array.from(normalizeTokens(input.rawDescription)).sort().join(' ');
  const nameKey = `name:${vendor}|${tokens}|pack:${normalizePackForIdentity(input.packSize)}`;

  return { key: skuKey || nameKey, kind: skuKey ? 'sku' : 'name_spec', skuKey, nameKey };
}

/** The keys to try when looking a line up, most reliable first. */
export function lookupKeysFor(input: AlignmentInput): { key: string; kind: 'sku' | 'name_spec' }[] {
  const id = identityFor(input);
  const keys: { key: string; kind: 'sku' | 'name_spec' }[] = [];
  if (id.skuKey) keys.push({ key: id.skuKey, kind: 'sku' });
  keys.push({ key: id.nameKey, kind: 'name_spec' });
  return keys;
}

/* ------------------------------------------------------------- history values */

/**
 * The value history holds for one field.
 *
 * The vendor-scoped record is asked first: it captures how THIS supplier prints this
 * item, and it decides by majority, so a unit OCR flips between cannot take it over.
 * The catalogue entry is the fallback - it is what the owner curates, and it is the
 * only source for a product bought from several suppliers.
 */
function historyValueFor(
  field: AlignedField,
  record: ProductAttributeRecord | null,
  product: MasterProduct | null
): string | null {
  if (record) {
    const seen = (record.samples || [])
      .map((s) => s.values?.[field])
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    const majority = majorityOf(seen);
    if (majority) return majority;
  }

  if (product) {
    switch (field) {
      case 'unit':
        return product.standardUnit || null;
      case 'packSize':
        return normalizePackSize(product.standardPackSize) || null;
      case 'taxRate':
        return product.taxRate == null ? null : String(product.taxRate);
      case 'category':
        return product.category || null;
    }
  }
  return null;
}

/** Most frequent value; a tie goes to the one seen most recently. Deterministic. */
export function majorityOf(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  values.forEach((v, i) => {
    counts.set(v, (counts.get(v) || 0) + 1);
    lastSeen.set(v, i);
  });
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== null && (lastSeen.get(v) || 0) > (lastSeen.get(best) || 0))) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** What the document itself says for one field, normalised for comparison. */
function documentValueFor(field: AlignedField, input: AlignmentInput): string | null {
  switch (field) {
    case 'unit': {
      const u = String(input.unit || '').trim();
      return u ? u : null;
    }
    case 'packSize':
      return normalizePackSize(input.packSize) || null;
    case 'taxRate':
      return input.taxRate == null ? null : String(input.taxRate);
    case 'category':
      // An invoice line never carries a category - it inherits the catalogue's.
      return null;
  }
}

function sameValue(field: AlignedField, a: string | null, b: string | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (field === 'unit') return canonicalUnit(a) === canonicalUnit(b);
  if (field === 'packSize') return normalizePackSize(a) === normalizePackSize(b);
  if (field === 'taxRate') return Number(a) === Number(b);
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ---------------------------------------------------------------- conversion */

/**
 * How many of `toUnit` one `fromUnit` is worth, or null when they cannot be converted.
 *
 * Sources, most specific first: the conversions the catalogue has learned for this
 * product, the table implied by this line's own pack description, then the plain
 * weight and volume measures. Weight and volume are tried as separate tables because
 * merging them would declare 1 kg = 1 L.
 */
export function unitConversionFactor(
  fromUnit: string,
  toUnit: string,
  packSize?: string | null,
  product?: MasterProduct | null
): number | null {
  const from = canonicalUnit(fromUnit);
  const to = canonicalUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return 1;

  const packTable = buildUnitConversions(packSize)?.conversions;
  const tables: (Record<string, number> | undefined)[] = [
    product?.unitConversions,
    packTable,
    from in WEIGHT_IN_KG && to in WEIGHT_IN_KG ? WEIGHT_IN_KG : undefined,
    from in VOLUME_IN_L && to in VOLUME_IN_L ? VOLUME_IN_L : undefined,
  ];

  for (const t of tables) {
    if (!t) continue;
    const a = t[from];
    const b = t[to];
    if (a > 0 && b > 0) return b / a;
  }
  return null;
}

/* ------------------------------------------------------------------ the pass */

/**
 * Aligns one line against history. Pure: it reads a record and a product and returns
 * what to write, touching nothing.
 */
export function alignLine(
  input: AlignmentInput,
  history: { record: ProductAttributeRecord | null; recordKind: 'sku' | 'name_spec' | null }
): AlignmentOutcome {
  const identity = identityFor(input);
  const record = history.record;
  const product = input.product ?? null;
  const isFirstEntry = !record && !product;

  const fields: FieldAlignment[] = [];
  const conflicts: AlignmentConflict[] = [];

  let unit = String(input.unit || '').trim();
  let unitPrice = Number(input.unitPrice);
  let packSize = normalizePackSize(input.packSize) || null;
  let taxRate = input.taxRate ?? null;
  let category: string | null = null;

  for (const field of ALIGNED_FIELDS) {
    const docValue = documentValueFor(field, input);
    const histValue = historyValueFor(field, record, product);

    // Meat is priced per kilogram by rule. Its unit is not history's to move.
    if (field === 'unit' && input.weightPriced) {
      fields.push({
        field,
        value: docValue,
        documentValue: docValue,
        historyValue: histValue,
        source: 'document',
        conflict: false,
        note: 'Weight-priced line: the unit belongs to the weight rule, so history was not applied.',
      });
      continue;
    }

    if (sameValue(field, docValue, histValue)) {
      // Agreed, or history simply had nothing to say.
      fields.push({
        field,
        value: docValue,
        documentValue: docValue,
        historyValue: histValue,
        source: docValue == null ? 'empty' : 'document',
        conflict: false,
      });
      continue;
    }

    // The document left it blank: fill it from history.
    if (docValue == null && histValue != null) {
      fields.push({
        field,
        value: histValue,
        documentValue: null,
        historyValue: histValue,
        source: 'history',
        conflict: false,
      });
      if (field === 'unit') unit = histValue;
      if (field === 'packSize') packSize = histValue;
      if (field === 'taxRate') taxRate = Number(histValue);
      if (field === 'category') category = histValue;
      continue;
    }

    // History is silent but the document has a value: nothing to align against.
    if (histValue == null) {
      fields.push({
        field,
        value: docValue,
        documentValue: docValue,
        historyValue: null,
        source: 'document',
        conflict: false,
      });
      continue;
    }

    // Genuine disagreement. Only a unit can be reconciled by conversion; every other
    // field has no arithmetic behind it.
    let factor = field === 'unit' ? unitConversionFactor(docValue!, histValue, input.packSize, product) : null;
    let convertedPrice = unitPrice;

    if (factor != null && Number.isFinite(factor) && factor > 0) {
      convertedPrice = roundPrice(unitPrice * factor);
      // The whole point of converting is that the price per base unit - the only figure
      // alerts compare - does not move. If it does, the factor is wrong and the
      // conversion is refused rather than silently applied.
      if (!conversionIsPriceNeutral(unitPrice, docValue!, convertedPrice, histValue, input.packSize, product)) {
        factor = null;
      }
    }

    if (factor != null && Number.isFinite(factor) && factor > 0) {
      fields.push({
        field,
        value: histValue,
        documentValue: docValue,
        historyValue: histValue,
        source: 'converted',
        conflict: true,
        convertedFrom: docValue,
        conversionFactor: factor,
      });
      if (field === 'unit') {
        unit = histValue;
        // Same price, different label: the price moves by the very same factor, so the
        // price per base unit is untouched.
        unitPrice = convertedPrice;
      }
      continue;
    }

    // No usable conversion between them. The unit keeps the printed value and the line
    // is flagged; a non-numeric field takes the historical value because no number
    // is at stake.
    if (field === 'unit') {
      fields.push({
        field,
        value: docValue,
        documentValue: docValue,
        historyValue: histValue,
        source: 'document',
        conflict: true,
        note: `No conversion between "${docValue}" and the historical "${histValue}".`,
      });
      conflicts.push({
        field,
        documentValue: docValue,
        historyValue: histValue,
        reason: `No conversion is known between ${docValue} and ${histValue}, so the printed value was kept.`,
        resolution: 'kept_document',
      });
    } else {
      fields.push({
        field,
        value: histValue,
        documentValue: docValue,
        historyValue: histValue,
        source: 'history',
        conflict: true,
        note: `History holds "${histValue}"; the document printed "${docValue}".`,
      });
      if (field === 'packSize') packSize = histValue;
      if (field === 'taxRate') taxRate = Number(histValue);
      if (field === 'category') category = histValue;
      conflicts.push({
        field,
        documentValue: docValue,
        historyValue: histValue,
        reason: `The document printed ${docValue} where history holds ${histValue}. The historical value was applied and the printed one kept for reference.`,
        resolution: 'accepted_history',
      });
    }
  }

  const identityKind: AlignmentIdentityKind = isFirstEntry ? 'new' : history.recordKind || 'name_spec';

  const validationErrors = validate({
    identityKey: identity.key,
    unit,
    unitPrice,
    packSize,
    taxRate,
    fields,
  });
  const validated = validationErrors.length === 0;

  // A result that failed its checks must not reach the database.
  if (!validated) {
    unit = String(input.unit || '').trim();
    unitPrice = Number(input.unitPrice);
    packSize = normalizePackSize(input.packSize) || null;
    taxRate = input.taxRate ?? null;
    category = null;
  }

  const fingerprint = fingerprintOf({
    identityKey: identity.key,
    unit,
    unitPrice,
    packSize,
    taxRate,
    category,
    conflicts,
    validated,
  });

  const alignment: LineAlignment = {
    identityKey: identity.key,
    identityKind,
    matchedProductId: product?.id ?? null,
    isFirstEntry,
    fields,
    conflicts,
    needsReview: conflicts.length > 0 || !validated,
    originalUnitPrice: Number.isFinite(Number(input.unitPrice)) ? Number(input.unitPrice) : null,
    validated,
    validationErrors,
    fingerprint,
    alignedAt: new Date().toISOString(),
  };

  return { unit, unitPrice, packSize, taxRate, category, alignment };
}

function roundPrice(n: number): number {
  if (!Number.isFinite(n)) return n;
  // Four decimals is the precision the rest of the system stores prices at.
  return Number(n.toFixed(4));
}

/* --------------------------------------------------------------- validation */

interface ValidationInput {
  identityKey: string;
  unit: string;
  unitPrice: number;
  packSize: string | null;
  taxRate: number | null;
  fields: FieldAlignment[];
}

/** Checks run before anything is written. A single failure rejects the whole result. */
export function validate(v: ValidationInput): string[] {
  const errors: string[] = [];

  if (!v.identityKey || !v.identityKey.split('|')[0]) {
    errors.push('No identity could be built for the line, so it cannot be aligned.');
  }
  if (!String(v.unit || '').trim()) {
    errors.push('The line would be left without a unit.');
  }
  if (!Number.isFinite(v.unitPrice) || v.unitPrice < 0) {
    errors.push(`The unit price is not a usable number: ${v.unitPrice}.`);
  }
  if (v.packSize != null && v.packSize.length > 64) {
    errors.push(`The pack size is implausibly long (${v.packSize.length} characters) - probably OCR noise.`);
  }
  if (v.taxRate != null && (!Number.isFinite(v.taxRate) || v.taxRate < 0 || v.taxRate > 100)) {
    errors.push(`The tax rate is out of range: ${v.taxRate}.`);
  }

  for (const f of v.fields) {
    if (f.source !== 'converted') continue;
    const factor = f.conversionFactor;
    if (!Number.isFinite(factor) || !factor || factor <= 0) {
      errors.push(`${f.field}: the conversion factor is not usable (${factor}).`);
    }
  }

  return errors;
}

/**
 * Price-per-base-unit neutrality for a converted unit.
 *
 * converting a unit and its price by the same factor must leave (price / factor-to-base)
 * untouched. If it does not, the conversion is wrong and the result must be refused.
 */
export function conversionIsPriceNeutral(
  printedPrice: number,
  printedUnit: string,
  newPrice: number,
  newUnit: string,
  packSize?: string | null,
  product?: MasterProduct | null
): boolean {
  const toBase = (price: number, unit: string) => {
    const table =
      product?.unitConversions && canonicalUnit(unit) in product.unitConversions
        ? product.unitConversions
        : buildUnitConversions(packSize)?.conversions;
    const factor = table?.[canonicalUnit(unit)];
    if (!factor || !(factor > 0) || !(price > 0)) return null;
    return price / factor;
  };
  const before = toBase(printedPrice, printedUnit);
  const after = toBase(newPrice, newUnit);
  if (before == null || after == null) return true; // nothing to contradict
  const drift = Math.abs(after - before) / before;
  return drift < 1e-6;
}

/* ------------------------------------------------------------- fingerprint */

/**
 * A hash of the decision itself - no timestamps, no ids. Re-processing the same
 * document yields the same string, which is how a repeated upload is recognised
 * instead of being recorded as a second alignment.
 */
export function fingerprintOf(parts: {
  identityKey: string;
  unit: string;
  unitPrice: number;
  packSize: string | null;
  taxRate: number | null;
  category: string | null;
  conflicts: AlignmentConflict[];
  validated: boolean;
}): string {
  const payload = JSON.stringify({
    identityKey: parts.identityKey,
    unit: parts.unit,
    unitPrice: parts.unitPrice,
    packSize: parts.packSize,
    taxRate: parts.taxRate,
    category: parts.category,
    conflicts: parts.conflicts.map((c) => [c.field, c.documentValue, c.historyValue, c.resolution]),
    validated: parts.validated,
  });
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------- memory */

/**
 * Folds one line into the history record.
 *
 * Idempotent by construction: a sample is stored per invoice number, so re-processing
 * an invoice that is already recorded REPLACES its sample instead of adding another.
 * Uploading the same invoice twice therefore leaves the record exactly as it was.
 */
export function rememberSample(
  record: ProductAttributeRecord,
  sample: { invoiceNumber: string; invoiceDate?: string | null; values: Partial<Record<AlignedField, string | null>> },
  now: string,
  /** How many samples to keep. Older ones fall off the front; the majority still holds. */
  maxSamples = 50
): void {
  const key = String(sample.invoiceNumber || '').trim();
  const idx = record.samples.findIndex((s) => String(s.invoiceNumber || '').trim() === key);
  if (idx >= 0) {
    record.samples[idx] = sample;
  } else {
    record.samples.push(sample);
    if (record.samples.length > maxSamples) {
      record.samples.splice(0, record.samples.length - maxSamples);
    }
  }
  record.lastSeenAt = now;
}

/** The values a finished line contributes back to history. */
export function sampleFromOutcome(outcome: AlignmentOutcome): Partial<Record<AlignedField, string | null>> {
  const values: Partial<Record<AlignedField, string | null>> = {};
  for (const f of outcome.alignment.fields) {
    // Only a value that actually landed on the line is worth remembering.
    values[f.field] = f.value ?? null;
  }
  return values;
}
