/**
 * Checks the historical-alignment engine against the rules it is supposed to obey.
 *
 * Run with:  npx tsx scripts/test-alignment.ts
 *
 * Everything here is pure - no server, no network. The point is to prove the four
 * outcomes the owner asked for (fill, convert, flag, first entry) and the two safety
 * properties that matter most: a converted price is still worth the same per base unit,
 * and re-processing the same invoice changes nothing.
 */

import {
  alignLine,
  fingerprintOf,
  identityFor,
  lookupKeysFor,
  majorityOf,
  rememberSample,
  sampleFromOutcome,
  unitConversionFactor,
} from '../src/server/lineAlignment.ts';
import { buildUnitConversions } from '../src/server/unitConversion.ts';
import type { AlignmentInput } from '../src/server/lineAlignment.ts';
import type { MasterProduct, ProductAttributeRecord } from '../src/types/index.ts';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

function product(over: Partial<MasterProduct> = {}): MasterProduct {
  return {
    id: 'mp-1',
    sku: 'AUTO-TEST',
    name: 'Test Product 10*1KG',
    category: 'Dry Goods',
    standardUnit: 'ctn',
    standardPackSize: '10*1KG',
    baseUnit: 'kg',
    unitConversions: buildUnitConversions('10*1KG')?.conversions,
    currentPrice: 12,
    previousPrice: 12,
    minPrice: 12,
    maxPrice: 12,
    lastPurchaseDate: '2026-07-01',
    primaryVendor: 'T & D Trading Pty Ltd',
    vendorAliases: [],
    priceHistory: [],
    ...over,
  } as MasterProduct;
}

function input(over: Partial<AlignmentInput> = {}): AlignmentInput {
  return {
    itemId: 'item-1',
    rawDescription: 'TEST PRODUCT 10*1KG',
    supplierSku: null,
    packSize: '10*1KG',
    unit: 'each',
    unitPrice: 1.2,
    vendorName: 'T & D Trading Pty Ltd',
    invoiceId: 'inv-1',
    invoiceNumber: '01330001',
    invoiceDate: '2026-08-01',
    product: null,
    ...over,
  };
}

function record(over: Partial<ProductAttributeRecord> = {}): ProductAttributeRecord {
  return {
    key: 'name:t and d trading|test product 10 1kg|pack:10*1kg',
    kind: 'name_spec',
    vendorName: 'T & D Trading Pty Ltd',
    samples: [],
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

/* ------------------------------------------------------------------ 1. identity */

console.log('\n1. Identity: item code first, then name + pack size');
{
  const withSku = identityFor(input({ supplierSku: 'cm22b' }));
  check('an item code produces a sku key', withSku.kind === 'sku' && withSku.key.startsWith('sku:'));

  const noSku = identityFor(input({ supplierSku: null }));
  check('no item code falls back to name + pack', noSku.kind === 'name_spec' && noSku.key.startsWith('name:'));

  const junkSku = identityFor(input({ supplierSku: 'x' }));
  check('a one-character "code" is treated as noise', junkSku.kind === 'name_spec');

  const a = identityFor(input({ vendorName: 'T & D TRADING PTY. LTD.' }));
  const b = identityFor(input({ vendorName: 'T & D Trading Pty. Ltd.' }));
  check('supplier spelling does not split the key', a.key === b.key);

  const keys = lookupKeysFor(input({ supplierSku: 'cm22b' }));
  check('lookup tries the item code before the name', keys[0].kind === 'sku' && keys[1].kind === 'name_spec');
}

/* ------------------------------------------------------ 2. first sighting (rule 4) */

console.log('\n2. Rule 4 - nothing in history: treated as a first entry');
{
  const out = alignLine(input(), { record: null, recordKind: null });
  check('marked as a first entry', out.alignment.isFirstEntry === true);
  check('identity kind is "new"', out.alignment.identityKind === 'new');
  check('the printed unit is kept', out.unit === 'each');
  check('the printed price is kept', near(out.unitPrice, 1.2));
  check('no conflict is raised', out.alignment.conflicts.length === 0);
  check('the result validates', out.alignment.validated === true);
}

/* ------------------------------------------------- 3. blank filled from history (rule 2) */

console.log('\n3. Rule 2 - a blank field is filled from history');
{
  const rec = record({
    samples: [
      { invoiceNumber: '01330000', values: { unit: 'ctn', packSize: '10*1KG', taxRate: '0.1', category: 'Dry Goods' } },
    ],
  });
  // A line with no pack size of its own and no category/tax of its own.
  const out = alignLine(input({ packSize: null, unit: 'ctn', supplierSku: null }), {
    record: rec,
    recordKind: 'name_spec',
  });
  const pack = out.alignment.fields.find((f) => f.field === 'packSize');
  const cat = out.alignment.fields.find((f) => f.field === 'category');
  const tax = out.alignment.fields.find((f) => f.field === 'taxRate');

  check('pack size filled from history', pack?.source === 'history' && out.packSize === '10*1KG');
  check('category filled from history', cat?.source === 'history' && out.category === 'Dry Goods');
  check('tax rate filled from history', tax?.source === 'history' && out.taxRate === 0.1);
  check('the printed value is still recorded', pack?.documentValue === null);
}

/* ------------------------------------------------------ 4. conversion (rule 3, part 1) */

console.log('\n4. Rule 3 - a convertible disagreement is converted');
{
  const prod = product();
  const out = alignLine(input({ product: prod, unit: 'each', unitPrice: 1.2 }), {
    record: null,
    recordKind: null,
  });
  const unitField = out.alignment.fields.find((f) => f.field === 'unit');

  check('the historical unit is used', out.unit === 'ctn');
  check('the price moved with it (1.20/ea -> 12/ctn)', near(out.unitPrice, 12), `got ${out.unitPrice}`);
  check('the field reports a conversion', unitField?.source === 'converted');
  check('the original unit is kept for reference', unitField?.documentValue === 'each');
  check('the factor is recorded', near(unitField?.conversionFactor ?? 0, 10));

  // The property that matters: the price per base unit has not moved.
  const baseBefore = buildUnitConversions('10*1KG')!.conversions.each; // 1 kg
  const baseAfter = buildUnitConversions('10*1KG')!.conversions.ctn; // 10 kg
  check(
    'the price per kg is unchanged by the conversion',
    near(1.2 / baseBefore, 12 / baseAfter),
    `${1.2 / baseBefore} vs ${12 / baseAfter}`
  );
}

/* --------------------------------------------- 5. unconvertible, flagged (rule 3, part 2) */

console.log('\n5. Rule 3 - a disagreement with no conversion keeps the printed value and is flagged');
{
  const prod = product({ unitConversions: undefined, standardUnit: 'ctn', standardPackSize: undefined });
  const out = alignLine(input({ product: prod, unit: 'kg', unitPrice: 6, packSize: null }), {
    record: null,
    recordKind: null,
  });
  const unitField = out.alignment.fields.find((f) => f.field === 'unit');

  check('the printed unit is kept', out.unit === 'kg');
  check('the printed price is kept', near(out.unitPrice, 6));
  check('a conflict is recorded', out.alignment.conflicts.length === 1);
  check('the conflict says the value was kept', out.alignment.conflicts[0].resolution === 'kept_document');
  check('the line is flagged for a human', out.alignment.needsReview === true);
  check('the reason names both values', /kg/.test(unitField?.note ?? '') && /ctn/.test(unitField?.note ?? ''));
}

/* ------------------------------------------------- 6. a non-numeric field takes history */

console.log('\n6. A non-numeric disagreement takes the historical value and keeps the printed one');
{
  const prod = product({ category: 'Seafood' });
  const out = alignLine(input({ product: prod, packSize: '20*500G', unit: 'ctn', unitPrice: 12 }), {
    record: null,
    recordKind: null,
  });
  const pack = out.alignment.fields.find((f) => f.field === 'packSize');

  // Pack sizes are compared and stored normalised (lower case), like everywhere else.
  check('the historical pack size is applied', out.packSize === '10*1kg', `${out.packSize}`);
  check('the printed pack size is kept for reference', pack?.documentValue === '20*500g', `${pack?.documentValue}`);
  check('it is still recorded as a disagreement', pack?.conflict === true);
  check('the line is flagged', out.alignment.needsReview === true);
}

/* ------------------------------------------------------------- 7. meat is left alone */

console.log('\n7. Weight-priced lines keep the unit the weight rule gave them');
{
  const prod = product({ standardUnit: 'ctn' });
  const out = alignLine(
    input({
      rawDescription: 'CHICKEN MARYLAND # 22',
      product: prod,
      unit: 'kg',
      unitPrice: 6,
      packSize: null,
      weightPriced: true,
    }),
    { record: null, recordKind: null }
  );
  const unitField = out.alignment.fields.find((f) => f.field === 'unit');
  check('the unit is not moved to the historical carton', out.unit === 'kg');
  check('the price is not converted', near(out.unitPrice, 6));
  check('no conflict is raised', out.alignment.conflicts.length === 0);
  check('the reason is recorded', /weight/i.test(unitField?.note ?? ''));
}

/* ------------------------------------------------------------------ 8. validation */

console.log('\n8. A result that fails its checks never reaches the database');
{
  const prod = product({ taxRate: 150 });
  const out = alignLine(input({ product: prod, unit: 'ctn', unitPrice: 12 }), {
    record: null,
    recordKind: null,
  });
  check('the result is rejected', out.alignment.validated === false);
  check('the reason is recorded', out.alignment.validationErrors.length > 0);
  check('the line is flagged for a human', out.alignment.needsReview === true);
  check('the tax rate was not written', out.taxRate === null);
}

/* ---------------------------------------------------------------- 9. idempotency */

console.log('\n9. Re-processing the same invoice changes nothing');
{
  const prod = product();
  const inp = input({ product: prod, unit: 'each', unitPrice: 1.2 });

  const first = alignLine(inp, { record: null, recordKind: null });
  const second = alignLine(inp, { record: null, recordKind: null });
  check('the same input gives the same fingerprint', first.alignment.fingerprint === second.alignment.fingerprint);
  check('the same input gives the same unit', first.unit === second.unit);
  check('the same input gives the same price', near(first.unitPrice, second.unitPrice));

  // The history library: the same invoice twice must not add a second sample.
  const rec = record();
  const sample = {
    invoiceNumber: '01330001',
    invoiceDate: '2026-08-01',
    values: sampleFromOutcome(first),
  };
  rememberSample(rec, sample, '2026-08-01T00:00:00.000Z');
  rememberSample(rec, sample, '2026-08-01T00:00:00.000Z');
  check('the same invoice is recorded once, not twice', rec.samples.length === 1, `${rec.samples.length}`);

  rememberSample(rec, { ...sample, invoiceNumber: '01330002' }, '2026-08-08T00:00:00.000Z');
  check('a different invoice does add a sample', rec.samples.length === 2);

  // Aligning the same invoice a second time, now that its own sample is stored, must
  // not push the price anywhere else.
  const third = alignLine(inp, { record: rec, recordKind: 'name_spec' });
  check(
    'a repeated upload does not move the price a second time',
    near(third.unitPrice, first.unitPrice),
    `${first.unitPrice} -> ${third.unitPrice}`
  );
}

/* ------------------------------------------------------------ 10. majority is stable */

console.log('\n10. History decides by majority, so a flipping label cannot take it over');
{
  check('the most frequent value wins', majorityOf(['ctn', 'ctn', 'each']) === 'ctn');
  check('a tie goes to the most recent', majorityOf(['each', 'ctn']) === 'ctn');
  check('an empty history has no answer', majorityOf([]) === null);

  const flapping = record({
    samples: [
      { invoiceNumber: 'A', values: { unit: 'each' } },
      { invoiceNumber: 'B', values: { unit: 'ctn' } },
      { invoiceNumber: 'C', values: { unit: 'ctn' } },
    ],
  });
  const out = alignLine(input({ product: null, unit: 'each', unitPrice: 1.2 }), {
    record: flapping,
    recordKind: 'name_spec',
  });
  check('the majority unit is the one aligned to', out.unit === 'ctn', out.unit);
}

/* -------------------------------------------------------------- 11. factor helpers */

console.log('\n11. Conversion factors');
{
  const conv = buildUnitConversions('10*1KG')!.conversions;
  check('1 carton = 10 single packs', unitConversionFactor('each', 'ctn', '10*1KG') === conv.ctn / conv.each);
  // The factor turns a price in the first unit into a price in the second:
  // $0.005 per g is $5 per kg, so g -> kg multiplies by 1000.
  check('g to kg multiplies the price by 1000', near(unitConversionFactor('g', 'kg', null) ?? 0, 1000));
  check('mL to L multiplies the price by 1000', near(unitConversionFactor('ml', 'L', null) ?? 0, 1000));
  check('kg to g divides it instead', near(unitConversionFactor('kg', 'g', null) ?? 0, 0.001));
  check('weight and volume never convert', unitConversionFactor('kg', 'L', null) === null);
  check('an unknown unit has no factor', unitConversionFactor('ctn', 'furlong', '10*1KG') === null);

  const fp1 = fingerprintOf({
    identityKey: 'k', unit: 'ctn', unitPrice: 12, packSize: '10*1KG', taxRate: null,
    category: null, conflicts: [], validated: true,
  });
  const fp2 = fingerprintOf({
    identityKey: 'k', unit: 'ctn', unitPrice: 12, packSize: '10*1KG', taxRate: null,
    category: null, conflicts: [], validated: true,
  });
  check('the fingerprint is stable', fp1 === fp2);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
