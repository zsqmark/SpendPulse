/**
 * Checks what a product is filed as, and what that decision is allowed to change.
 *
 * Run with:  npx tsx scripts/test-category.ts
 *
 * Written after the catalogue's "Meat & Poultry" shelf turned out to hold nothing but
 * lemongrass, garlic, ginger and two curry powders: the meat keyword list matched "MINCE"
 * (which this supplier writes for *minced*) and "MEAT CURRY POWDER" (which contains the
 * word meat). Category is not cosmetic - it selects the weight-pricing rule - so both
 * halves are pinned here: the guess, and the owner's ability to overrule it.
 */

import { guessCategory } from '../src/server/aliasMatcher.ts';
import { applyWeightPricing, isMeatProduct } from '../src/server/productUnits.ts';
import { isMeatDescription, MEAT_CATEGORY } from '../src/lib/meatPricing.ts';
import {
  CATEGORY_OPTIONS,
  isKnownCategory,
  normaliseCategory,
} from '../src/lib/categories.ts';
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

function product(over: Partial<MasterProduct> = {}): MasterProduct {
  return {
    id: 'mp-test',
    sku: 'SKU-1',
    name: 'SOMETHING 1KG',
    category: 'General Supplies',
    categorySource: 'guessed',
    standardUnit: 'bag',
    currentPrice: 0,
    previousPrice: 0,
    minPrice: 0,
    maxPrice: 0,
    lastPurchaseDate: '2026-10-31',
    primaryVendor: 'T & D',
    vendorAliases: [],
    priceHistory: [],
    ...over,
  } as MasterProduct;
}

// ------------------------------------------------------------ the words themselves
console.log('\n1. Butchery words only mean meat when nothing plant-like is named');

check('bare MINCE is still meat', isMeatDescription('MINCE 1KG'));
check('BEEF MINCE is meat (the animal settles it)', isMeatDescription('BEEF MINCE 1KG'));
check(
  'LEMON GRASS MINCE is not meat',
  !isMeatDescription("A1' LEMON GRASS MINCE 20*500G XA BAM (PAKET)")
);
check('GARLIC MINCE is not meat', !isMeatDescription('NP FRESH GARLIC MINCE **2K**'));
check('GINGER MINCE is not meat', !isMeatDescription("NP' FRESH **GINGER** MINCE 2KG"));
check('MEAT CURRY POWDER is not meat', !isMeatDescription("BABA' MEAT CURRY POWDER 10*1KG"));
check('a vegetarian sausage is not meat', !isMeatDescription('VEGETARIAN SAUSAGE 500G'));
check('CHICKEN MARYLAND is meat', isMeatDescription('CHICKEN MARYLAND # 22'));
check('PORK RIBS are meat', isMeatDescription('PORK RIBS'));
check('a bare STEAK is meat', isMeatDescription('SCOTCH STEAK'));
check('the brand text counts too', isMeatDescription('MARYLAND # 22', 'CHICKEN'));
check('an empty description is not meat', !isMeatDescription('') && !isMeatDescription(null));

// ------------------------------------------------------------ what shelf it lands on
console.log('\n2. Which category each real product gets');

const shelves: Array<[string, string]> = [
  ["A1' LEMON GRASS MINCE 20*500G XA BAM (PAKET)", 'Produce'],
  ['NP FRESH GARLIC MINCE **2K**', 'Produce'],
  ["NP' FRESH **GINGER** MINCE 2KG", 'Produce'],
  ["BABA' MEAT CURRY POWDER 10*1KG", 'Dry Goods'],
  ["BABA'S MEAT CURRY PWD 40*250G", 'Dry Goods'],
  ['CHICKEN MARYLAND # 22', MEAT_CATEGORY],
  ['BEEF MINCE 5KG', MEAT_CATEGORY],
  ['MINCE 1KG', MEAT_CATEGORY],
  ['Darra Meats SAUSAGE 2KG', MEAT_CATEGORY],
];

for (const [name, expected] of shelves) {
  const actual = guessCategory(name);
  check(`${name} -> ${expected}`, actual === expected, `got ${actual}`);
}

check(
  'every shelf the guesser can produce is in the shared list',
  shelves.every(([, expected]) => (CATEGORY_OPTIONS as readonly string[]).includes(expected))
);

// ------------------------------------------------------------ the owner's override
console.log('\n3. A category the owner set outranks the guess');

const lemongrass = product({
  name: "A1' LEMON GRASS MINCE 20*500G",
  category: 'Produce',
  categorySource: 'manual',
});
check(
  'a manual Produce category means the weight rule does not apply',
  !isMeatProduct(lemongrass.name, lemongrass)
);

const chicken = product({
  name: 'CHICKEN MARYLAND # 22',
  category: MEAT_CATEGORY,
  categorySource: 'manual',
  baseUnit: 'kg',
});
check('a manual meat category wins even when the name is not meaty', isMeatProduct('MARYLAND # 22', chicken));

check(
  'without a manual choice the description decides',
  isMeatProduct('CHICKEN MARYLAND # 22', product({ name: 'X' }))
);

// The line editor passes the product in; the importer does not have one yet.
const weightLine = {
  rawDescription: 'CHICKEN MARYLAND # 22',
  unit: 'carton',
  unitPrice: 999,
  quantity: 3,
  weight: 57.64,
  totalPrice: 345.84,
};
check(
  'the importer still prices meat from the weight column',
  applyWeightPricing(weightLine).unitPrice === 6
);
check(
  'a meat product the owner kept as meat still prices by weight',
  applyWeightPricing(weightLine, chicken).unitPrice === 6
);
check(
  'minced lemongrass keeps its printed price instead of being divided by a weight',
  applyWeightPricing(
    { ...weightLine, rawDescription: "A1' LEMON GRASS MINCE 20*500G" },
    lemongrass
  ).unitPrice === 999
);

// ------------------------------------------------------------ the vocabulary
console.log('\n4. One vocabulary for the guesser and the picker');

check('Dry Goods is known', isKnownCategory('Dry Goods'));
check('a made-up shelf is not', !isKnownCategory('Dry Goods & Baking'));
check('the old spelling maps onto the new one', normaliseCategory('Dry Goods & Baking') === 'Dry Goods');
check('Produce & Fresh maps onto Produce', normaliseCategory('Produce & Fresh') === 'Produce');
check('a current name is left alone', normaliseCategory('Produce') === 'Produce');
check('an empty value falls back', normaliseCategory('') === 'General Supplies');
check(
  'every option is a category the guesser can return',
  CATEGORY_OPTIONS.every((c) => typeof c === 'string' && c.length > 0)
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
