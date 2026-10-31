/**
 * Checks the pack-hierarchy learning and the base-price conversion that depends on it.
 *
 * Run with:  npx tsx scripts/test-pack-units.ts
 *
 * Written after a real product ("KAW' PLAIN PARATHA-25PC 8*2K") could not show a
 * per-kilogram price: its pack string was unreadable, so the catalogue had only ever
 * learned "one each", and the one readable pack that eventually arrived was thrown away
 * by the measure guard. These checks pin both halves of that fix.
 */

import {
  basePriceFor,
  applyWeightPricing,
  learnPackHierarchy,
  recalculateProductStats,
} from '../src/server/productUnits.ts';
import { buildUnitConversions } from '../src/server/unitConversion.ts';
import type { MasterProduct } from '../src/types/index.ts';

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

function near(a: number | null, b: number, tol = 1e-6): boolean {
  return a != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

function product(over: Partial<MasterProduct> = {}): MasterProduct {
  return {
    id: 'mp-test',
    sku: '46001715',
    name: "KAW' PLAIN PARATHA-25PC 8*2K",
    category: 'General Supplies',
    standardUnit: 'bag',
    standardPackSize: '25PC 8*2K',
    currentPrice: 13.8,
    previousPrice: 13.8,
    minPrice: 13.8,
    maxPrice: 13.8,
    lastPurchaseDate: '2026-10-08',
    primaryVendor: 'T & D Trading Pty Ltd',
    vendorAliases: [],
    priceHistory: [],
    ...over,
  } as MasterProduct;
}

/* ------------------------------------------------ 1. the pack strings in question */

console.log('\n1. Which pack strings can be read');
{
  check('"2kg" parses', buildUnitConversions('2kg') !== null);
  check('"8*2KG" parses', buildUnitConversions('8*2KG') !== null);

  // The real string on most of this product's invoices. It cannot be read, and that is
  // the honest answer: "25PC 8*2K" mixes a piece count with a carton configuration, so
  // reading it as 8 x 2kg would claim a carton holds 16kg and turn $13.80 into $0.86/kg.
  check('"25PC 8*2K" is rejected rather than guessed at', buildUnitConversions('25PC 8*2K') === null);
}

/* ------------------------------------- 2. a count base must not block a real measure */

console.log('\n2. "each" is not a committed measure, so a real one can replace it');
{
  const p = product({ baseUnit: 'each', unitConversions: { each: 1 } });
  const learned = learnPackHierarchy(p, '2kg');

  check('the pack is accepted', learned === true);
  check('the base becomes a weight', p.baseUnit === 'kg', String(p.baseUnit));
  check('one bag is 2 kg', p.unitConversions?.bag === 2, String(p.unitConversions?.bag));
  // The stale { each: 1 } must be replaced, not merged - merged it would keep "1 each = 1".
  check('the stale each=1 is replaced, not kept', p.unitConversions?.each === 2, String(p.unitConversions?.each));
  check('kg itself is 1', p.unitConversions?.kg === 1);
}

console.log('\n3. A weight/volume flip is still refused');
{
  const p = product({ baseUnit: 'kg', unitConversions: { kg: 1, bag: 2 } });
  const learned = learnPackHierarchy(p, '12*750ML');
  check('a litre pack cannot take over a kilogram product', learned === false);
  check('the original measure is untouched', p.baseUnit === 'kg');
  check('the original table is untouched', p.unitConversions?.bag === 2);
}

console.log('\n4. An unreadable pack teaches nothing, and says so');
{
  const p = product({ baseUnit: 'each', unitConversions: { each: 1 } });
  const learned = learnPackHierarchy(p, '25PC 8*2K');
  check('nothing is learned', learned === false);
  check('the product is not damaged', p.baseUnit === 'each');
}

/* ------------------------------------------------------ 5. the base price resolves */

console.log('\n5. The per-kilogram price finally resolves');
{
  // The state the live catalogue was actually in: only the degenerate count table.
  const local = product({ baseUnit: 'each', unitConversions: { each: 1 } });
  const viaLinePack = basePriceFor(local, 13.8, 'bag', '2kg');
  check('the line\'s own pack is enough: 13.80 per 2kg bag = 6.90/kg', near(viaLinePack, 6.9), String(viaLinePack));
  check('and the product adopts what the line proved', local.baseUnit === 'kg' && local.unitConversions?.bag === 2);

  // Once learned, the product's own table answers without the line's help.
  check('afterwards the table answers on its own', near(basePriceFor(local, 13.8, 'bag'), 6.9));
}

console.log('\n6. Nothing is invented when a conversion genuinely does not exist');
{
  const p = product({ baseUnit: 'each', unitConversions: { each: 1 } });
  // "Carton" against a pack that only describes a single container: the carton count is
  // genuinely unknown, so there is no price per base unit and none may be guessed.
  check('a carton with an unreadable pack stays uncomparable', basePriceFor(p, 13.8, 'Carton', '25PC 8*2K') === null);
  check('an unknown unit stays uncomparable', basePriceFor(product(), 13.8, 'furlong', '2kg') === null);
  check('a zero price is not converted', basePriceFor(product(), 0, 'kg', '2kg') === null);
}

/* -------------------------------------------------------- 7. end to end on the scans */

console.log("\n7. The product's real history, replayed");
{
  // All six invoices, exactly as they were stored: the bag line and five "Carton" lines.
  const p = product({ baseUnit: 'each', unitConversions: { each: 1 } });
  const lines = [
    { date: '2026-08-03', invoiceNumber: '01331466', unit: 'carton', packSize: '25pc 8*2k', unitPrice: 13.8 },
    { date: '2026-10-08', invoiceNumber: '01332254', unit: 'bag', packSize: '2kg', unitPrice: 13.8 },
    { date: '2026-08-31', invoiceNumber: '01334603', unit: 'Carton', packSize: '25pc 8*2k', unitPrice: 13.8 },
    { date: '2026-09-14', invoiceNumber: '01336186', unit: 'CARTON', packSize: '25pc 8*2k', unitPrice: 13.8 },
    { date: '2026-09-21', invoiceNumber: '01337017', unit: 'Ctn', packSize: '25pc 8*2k', unitPrice: 13.8 },
    { date: '2026-09-28', invoiceNumber: '01337826', unit: 'Carton', packSize: '25pc 8*2k', unitPrice: 13.8 },
  ];

  for (const l of lines) learnPackHierarchy(p, l.packSize);

  const bagLine = lines.find((l) => l.unit === 'bag')!;
  check(
    'the bag line now shows a per-kg price',
    near(basePriceFor(p, bagLine.unitPrice, bagLine.unit, bagLine.packSize), 6.9),
    String(basePriceFor(p, bagLine.unitPrice, bagLine.unit, bagLine.packSize))
  );

  const cartonLine = lines.find((l) => l.unit === 'Carton')!;
  check(
    'the mislabelled "Carton" lines stay uncomparable rather than become 8x wrong',
    basePriceFor(p, cartonLine.unitPrice, cartonLine.unit, cartonLine.packSize) === null
  );

  check('the product is measured by weight after the replay', p.baseUnit === 'kg');
}

console.log('\n8. Meat is still priced from its weight column, not from a pack');
{
  const meat = applyWeightPricing({
    rawDescription: 'CHICKEN MARYLAND # 22',
    unit: 'carton',
    unitPrice: 999,
    quantity: 3,
    weight: 57.64,
    totalPrice: 345.84,
  });
  check('total / weight, never total / quantity', near(meat.unitPrice, 6), String(meat.unitPrice));
  check('and it is expressed per kg', meat.unit === 'kg');
}

console.log('\n9. Recalculating stats does not blow up on the mixed units');
{
  const p = product({ baseUnit: 'each', unitConversions: { each: 1 } });
  p.priceHistory = [
    { date: '2026-10-08', vendor: 'T & D', unitPrice: 13.8, invoiceNumber: '01332254', unit: 'bag', packSize: '2kg' },
    { date: '2026-08-31', vendor: 'T & D', unitPrice: 13.8, invoiceNumber: '01334603', unit: 'Carton', packSize: '25pc 8*2k' },
  ];
  recalculateProductStats(p);
  check('currentPrice comes from the newest entry', near(p.currentPrice, 13.8));
  check('min/max stay finite', Number.isFinite(p.minPrice) && Number.isFinite(p.maxPrice));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
