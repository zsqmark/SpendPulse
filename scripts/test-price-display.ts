/**
 * Checks that a price and its unit read the same way everywhere they appear.
 *
 * Run with:  npx tsx scripts/test-price-display.ts
 *
 * The bug this pins down: the alert feed printed the figure as invoiced with whatever unit
 * label OCR had produced ("$1.85 /carton"), while the line detail panel quoted the per-kilo
 * figure the comparison is made on - two prices for one line. Suppliers also abbreviate freely,
 * so a single unit arrived as CTN, Ctn, ctn and carton. Both screens now call one function,
 * so they cannot drift apart again.
 */

import {
  canonicalUnit,
  formatAmount,
  formatRate,
  lineForAlert,
  normaliseUnitLabel,
  perBaseFromPrinted,
  previousHistoryEntry,
  productOf,
  ratesForHistory,
  ratesForLine,
} from '../src/lib/priceDisplay.ts';
import type { Invoice, InvoiceItem, MasterProduct, PriceAlert } from '../src/types/index.ts';

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

const rice: MasterProduct = {
  id: 'mp-rice',
  sku: 'RICE-20KG',
  name: "PG' JASMINE RICE 20KG (2026)",
  category: 'Dry Goods',
  categorySource: 'guessed',
  standardUnit: 'bag',
  standardPackSize: '20KG',
  currentPrice: 62,
  previousPrice: 60,
  minPrice: 31,
  maxPrice: 62,
  lastPurchaseDate: '2026-10-08',
  primaryVendor: 'T & D Trading Pty Ltd',
  vendorAliases: [],
  baseUnit: 'kg',
  unitConversions: { kg: 1, g: 0.001, lb: 0.453592, pack: 20, bag: 20, box: 20, each: 20 },
  priceHistory: [
    { date: '2026-08-03', vendor: 'T & D', unitPrice: 31, invoiceNumber: '01330000', unit: 'bag', packSize: '20kg', baseUnitPrice: 1.55 },
    { date: '2026-09-07', vendor: 'T & D', unitPrice: 32, invoiceNumber: '01335482', unit: 'bag', packSize: '10kg', baseUnitPrice: 3.2 },
    { date: '2026-10-08', vendor: 'T & D', unitPrice: 62, invoiceNumber: '01332254', unit: 'bag', packSize: '20kg', baseUnitPrice: 3.1 },
  ],
} as MasterProduct;

const riceLine: InvoiceItem = {
  id: 'it-rice',
  rawDescription: "PG' JASMINE RICE 20KG (2026)",
  quantity: 3,
  unit: 'bag',
  unitPrice: 62,
  totalPrice: 186,
  masterProductId: rice.id,
  masterProductName: rice.name,
  matchConfidence: 1,
  pageNumber: 1,
  baseUnitPrice: 3.1,
  baseUnit: 'kg',
} as InvoiceItem;

const invoice: Invoice = {
  id: 'inv-1',
  invoiceNumber: '01332254',
  invoiceDate: '2026-10-08',
  vendorName: 'T & D Trading Pty Ltd',
  fileName: 'x.pdf',
  currency: 'USD',
  status: 'processed',
  items: [riceLine],
} as Invoice;

const alert: PriceAlert = {
  id: 'alert-1',
  masterProductId: rice.id,
  productName: rice.name,
  vendorName: 'T & D Trading Pty Ltd',
  invoiceId: 'inv-1',
  invoiceNumber: '01332254',
  invoiceDate: '2026-10-08',
  previousPrice: 60,
  newPrice: 62,
  deltaAmount: 2,
  percentChange: 3.33,
  detectedAt: '2026-10-31T00:00:00.000Z',
  status: 'active',
  unit: 'bag',
} as PriceAlert;

console.log('\nUnit spellings collapse onto one word');

check('CTN becomes carton', canonicalUnit('CTN') === 'carton');
check('Ctn becomes carton', canonicalUnit('Ctn') === 'carton');
check('case becomes carton', canonicalUnit('case') === 'carton');
check('cs becomes carton', canonicalUnit('cs') === 'carton');
check('bags becomes bag', canonicalUnit('bags') === 'bag');
check('pcs becomes each', canonicalUnit('pcs') === 'each');
check('a trailing full stop is dropped', canonicalUnit('ctn.') === 'carton');
check('a known unit is left alone', canonicalUnit('kg') === 'kg');
check('the lookup key stays lowercase', canonicalUnit('ml') === 'ml');
check('millilitres are spelled with a capital on screen', normaliseUnitLabel('ml') === 'mL');
check('litres are spelled with a capital on screen', normaliseUnitLabel('l') === 'L');
check('each is shortened on screen', normaliseUnitLabel('each') === 'ea');
check('an empty unit is safe', canonicalUnit(null) === '');

console.log('\nDecimals follow the size of the number');

check('dollars take two decimals', formatAmount(3.1) === '3.10');
check('tens of cents take three', formatAmount(0.135) === '0.135');
check('fractions of a cent take four', formatAmount(0.0142) === '0.0142');
check('a missing amount never invents one', formatAmount(null) === '—');
check('a broken amount never invents one', formatAmount(Number.NaN) === '—');

console.log('\nOne rate, one string');

const rate = formatRate(3.1, 'kg');
check('the rate carries its value', rate?.value === '3.10');
check('the rate carries its unit', rate?.unit === 'kg');
check('the rate carries the finished text', rate?.text === '$3.10/kg');
check('a rate without a unit is refused', formatRate(3.1, null) === null);
check('a rate without a price is refused', formatRate(null, 'kg') === null);
check('a unit label is normalised in the rate', formatRate(62, 'CTN')?.unit === 'carton');

console.log('\nThe line, printed and per base');

const rates = ratesForLine(riceLine, rice);
check('the printed figure keeps the invoiced unit', rates.printed?.text === '$62.00/bag');
check('the per-base figure is per kilo', rates.perBase?.text === '$3.10/kg');
check('a line with no item gives nothing', ratesForLine(null, rice).printed === null);

const noPack = ratesForLine({ ...riceLine, baseUnitPrice: null, baseUnit: null }, rice);
check(
  'a line whose pack cannot be read has no per-base price',
  noPack.perBase === null
);

console.log('\nWhere an alert points - today, not the day it was raised');

const found = lineForAlert(alert, [invoice], [rice]);
check('an alert resolves to its line', found?.item.id === 'it-rice');
check('an alert resolves to its product', found?.product.id === rice.id);
check('an alert whose invoice is gone resolves to nothing', lineForAlert(alert, [], [rice]) === null);
check(
  'an alert whose line is gone resolves to nothing',
  lineForAlert(alert, [{ ...invoice, items: [] }], [rice]) === null
);
check(
  'an alert can be matched by invoice number when the id moved',
  lineForAlert({ ...alert, invoiceId: 'stale' }, [invoice], [rice])?.item.id === 'it-rice'
);

console.log('\nThe earlier purchase an alert measures against');

const prev = previousHistoryEntry(rice, '01332254', '2026-10-08');
check('the prior entry is the one before this invoice', prev?.invoiceNumber === '01335482');
check('the prior entry keeps its printed figure', prev?.unitPrice === 32);

const first = previousHistoryEntry(rice, '01330000', '2026-08-03');
check(
  'the very first entry has nothing before it',
  first === null || first.invoiceNumber !== '01330000'
);

check('a product with no history has nothing before it', previousHistoryEntry(null, 'x', 'x') === null);

console.log('\nAlert and detail panel read the same number');

const perBase = ratesForLine(riceLine, rice).perBase;
const viaAlert = perBaseFromPrinted(alert.newPrice, alert.unit, productOf(alert, [rice]));
check(
  'the alert resolves to the same per-kilo price as the line',
  perBase?.text === viaAlert?.text,
  `${perBase?.text} vs ${viaAlert?.text}`
);

const historyRates = ratesForHistory(prev, rice);
check(
  'the prior purchase quotes the same way as the current one',
  historyRates.perBase?.unit === perBase?.unit
);

const unknown = perBaseFromPrinted(62, 'carton', {
  ...rice,
  unitConversions: { kg: 1, g: 0.001 },
});
check(
  'a price in a unit the product does not know is left unconverted',
  unknown === null || unknown.unit !== 'carton'
);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
