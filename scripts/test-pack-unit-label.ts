/**
 * Checks the product tagging rule: the unit on the pack specification, and nothing else.
 *
 * Run with:  npx tsx scripts/test-pack-unit-label.ts
 *
 * The old rule read the whole product name and let whichever of weight or capacity appeared
 * LAST win, with a special case for meat. That is what filed `FISH CURRY PWD` (a spice) under
 * Seafood. These tests pin the replacement down: weight -> bag, capacity -> bottle, and
 * anything unreadable falls back to 'ea' with the reason reported.
 */

import {
  classifySpecUnit,
  DEFAULT_SELLING_UNIT,
  explainDefault,
  labelForSpec,
  specMeasureOf,
} from '../src/lib/packUnitLabel.ts';
import { standardPrice, standardSellingUnit } from '../src/lib/standardPricing.ts';

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

function tagOf(packSpec?: string | null): string {
  return labelForSpec(packSpec).unit;
}

console.log('\n1. Weight units are tagged bag');

const weights: string[] = [
  '500g',
  '500G',
  '500 g',
  '1kg',
  '1KG',
  '1 Kg',
  '20KG',
  '1.5kg',
  '250gm',
  '250GMS',
  '5gram',
  '5GRAMS',
  '5kilo',
  '5KILOS',
  '5kilogram',
  '5KILOGRAMS',
  '100mg',
  '100MG',
  '5lb',
  '5LBS',
  '5pound',
  '5POUNDS',
  '11.34K',
  '1斤',
  '1磅',
  '500克',
  '1千克',
  '1公斤',
  '100毫克',
  '10*1KG',
  '40*250G',
  '6*5LB',
];

for (const spec of weights) {
  check(`${spec} -> bag`, tagOf(spec) === 'bag', tagOf(spec));
}

console.log('\n2. Capacity units are tagged bottle');

const volumes: string[] = [
  '1.5L',
  '1.5l',
  '1.5 L',
  '20L',
  '20 l',
  '560ML',
  '560ml',
  '560 mL',
  '4LT',
  '4lt',
  '640ML',
  '1litre',
  '1LITRE',
  '1litres',
  '1liter',
  '1LITERS',
  '1ltr',
  '1LTRS',
  '1升',
  '1公升',
  '500毫升',
  '1gal',
  '1GALLON',
  '1gallons',
  '1qt',
  '1QUART',
  '1quarts',
  '16floz',
  '16 FL OZ',
  '16 fl. oz',
  '1加仑',
  '1夸脱',
  '3*4LT',
  '24*560ML',
  '12*640ML',
  '2*5L',
];

for (const spec of volumes) {
  check(`${spec} -> bottle`, tagOf(spec) === 'bottle', tagOf(spec));
}

console.log('\n3. Case and separators make no difference');

const variants: Array<[string, string]> = [
  ['500g', 'bag'],
  ['500G', 'bag'],
  ['500 G', 'bag'],
  ['500 g.', 'bag'],
  ['1.5L', 'bottle'],
  ['1.5l', 'bottle'],
  ['1.5 L', 'bottle'],
  ['1.5-L', 'bottle'],
  ['1,5L', 'bottle'],
  ['1.5KG', 'bag'],
  ['1.5 Kg', 'bag'],
  ['1.5KGS', 'bag'],
];

for (const [spec, expected] of variants) {
  check(`${spec} -> ${expected}`, tagOf(spec) === expected, tagOf(spec));
}

console.log('\n4. A figure written against the unit is read');

const inline: Array<[string, string]> = [
  ["PG' JASMINE RICE 20KG (2026)", 'bag'],
  ['FRESH GOLD DETERGENT 20L', 'bottle'],
  ['CC AAA C/NUT CREAM 24*560ML', 'bottle'],
  ["BABA'S MEAT CURRY PWD 40*250G", 'bag'],
  ['HEINZ TOMATO SAUCE GFRE 3*4LT', 'bottle'],
  ['1kg椰奶', 'bag'],
  ['椰奶 1升', 'bottle'],
];

for (const [spec, expected] of inline) {
  check(`${spec} -> ${expected}`, tagOf(spec) === expected, tagOf(spec));
}

console.log('\n5. A nested pack is read from the inside out');

// "12*(12*35G)" is a case of twelve inner packs of 35 g: the container is the innermost
// figure, not the leading one.
check('12*(12*35G) -> bag', tagOf('12*(12*35G)') === 'bag', tagOf('12*(12*35G)'));
check('12*(12*35G) reads 35 g', specMeasureOf('12*(12*35G)')?.size === 35);
check('12*(12*35G) counts 12', specMeasureOf('12*(12*35G)')?.count === 12);

console.log('\n6. Nothing readable falls back to the default, and says so');

const blanks: Array<string | null | undefined> = [undefined, null, '', '   '];
for (const spec of blanks) {
  const label = labelForSpec(spec);
  check(
    `${JSON.stringify(spec)} -> ${DEFAULT_SELLING_UNIT} (missing)`,
    label.unit === DEFAULT_SELLING_UNIT && label.isDefault && label.reason === 'missing'
  );
}

const unrecognised = ['22CM', '12P/C', 'N/A', '24 PCS', 'PLAIN'];
for (const spec of unrecognised) {
  const label = labelForSpec(spec);
  check(
    `${spec} -> ${DEFAULT_SELLING_UNIT} (unrecognised)`,
    label.unit === DEFAULT_SELLING_UNIT && label.isDefault && label.reason === 'unrecognised',
    `${label.unit}/${label.reason}`
  );
}

check('a default explains itself', explainDefault(labelForSpec('')) === 'No pack specification');
check(
  'an unrecognised unit explains itself',
  explainDefault(labelForSpec('22CM')) === 'Pack unit not recognised'
);
check('a read pack carries no excuse', explainDefault(labelForSpec('500g')) === '');

console.log('\n7. The unit decides, not the rest of the name');

// The whole point of the change: a spice named after a fish is a spice.
check("FISH CURRY PWD 40*250G -> bag", tagOf("BABA'S FISH CURRY PWD 40*250G") === 'bag');
check('PRAWN CRACKER 24*200G -> bag', tagOf('PRAWN CRACKER 24*200G') === 'bag');
// ...and a capacity printed on a meat-sounding name still reads as capacity.
check('CHICKEN STOCK 12*1L -> bottle', tagOf('CHICKEN STOCK 12*1L') === 'bottle');
check('BEEF STOCK 1KG -> bag', tagOf('BEEF STOCK 1KG') === 'bag');

console.log('\n8. The tag and the quoted price agree');

const quoted = standardPrice({
  rawDescription: 'CC AAA C/NUT CREAM 24*560ML',
  packSize: '24*560ML',
  unit: 'carton',
  unitPrice: 72,
});
check('a carton of 24 x 560 mL quotes per litre', quoted.unit === 'L', quoted.unit);
check('72 / 13.44 L = $5.357/L', Math.abs((quoted.price ?? 0) - 5.3571) < 0.001, String(quoted.price));
check('the tag follows the unit', quoted.sellingUnit === 'bottle', quoted.sellingUnit);
check('a read pack is not a default', quoted.isDefault === false);

const perCan = standardPrice({
  rawDescription: 'CC AAA C/NUT CREAM 24*560ML',
  packSize: '24*560ML',
  unit: 'each',
  unitPrice: 3,
});
check('one can quotes the same per litre', Math.abs((perCan.price ?? 0) - 5.3571) < 0.001, String(perCan.price));

const meaty = standardPrice({
  rawDescription: 'CHICKEN MARYLAND # 22',
  packSize: null,
  unit: 'kg',
  unitPrice: 6,
});
check('a unit that IS the measure needs no pack', meaty.unit === 'kg' && meaty.price === 6, `${meaty.unit}/${meaty.price}`);

const unknown = standardPrice({
  rawDescription: 'CLAY POT 22CM',
  packSize: '22CM',
  unit: 'each',
  unitPrice: 12,
});
check('an unreadable pack quotes no price', unknown.price === null && unknown.isDefault === true);

console.log('\n9. A bare "m" is left unknown rather than guessed');

// "12*640M" is a truncated "640ML" and "600M" is 600 metres of cling film. One letter
// cannot be both, so the table refuses it and the product falls back to the default.
check('640M is not read as millilitres', classifySpecUnit('m') === null);
check('a 640M pack falls back to ea', tagOf('HP COOKING WINE-BLUE 12*640M') === 'ea');
check('and says why', labelForSpec('12*640M').reason === 'unrecognised');
check('600M of cling film falls back too', tagOf('C-WAY CWRAP DISP 6*45CM/600M') === 'ea');

console.log('\n10. The tag is exported in one vocabulary');

check('weight -> bag', standardSellingUnit('weight') === 'bag');
check('volume -> bottle', standardSellingUnit('volume') === 'bottle');
check('count -> ea', standardSellingUnit('count') === DEFAULT_SELLING_UNIT);
check('mg is a weight', classifySpecUnit('mg') === 'weight');
check('mL is a capacity', classifySpecUnit('mL') === 'volume');
check('FL OZ is a capacity', classifySpecUnit('FL OZ') === 'volume');
check('OZ is a weight', classifySpecUnit('OZ') === 'weight');
check('a bare letter is unknown', classifySpecUnit('xyz') === null);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
