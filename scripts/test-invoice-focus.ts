/**
 * Checks where an invoice-number link lands.
 *
 * Run with:  npx tsx scripts/test-invoice-focus.ts
 *
 * The link is the only thing standing between "the alert says invoice 01332254" and seeing
 * the line that caused it, so the resolution rules are pinned here: an id beats a number,
 * a duplicated number resolves to the invoice that actually holds the line, and a link that
 * names no line is not reported as a missing one.
 */

import {
  invoiceForFocus,
  itemForFocus,
  resolveInvoiceJump,
  lineDomId,
} from '../src/lib/invoiceFocus.ts';
import type { Invoice, InvoiceFocusTarget, InvoiceItem } from '../src/types/index.ts';

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

function item(over: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'it-1',
    rawDescription: 'CHICKEN MARYLAND # 22',
    quantity: 3,
    unit: 'carton',
    unitPrice: 6,
    totalPrice: 345.84,
    masterProductId: 'mp-1',
    masterProductName: 'Chicken Maryland',
    matchConfidence: 1,
    pageNumber: 1,
    ...over,
  } as InvoiceItem;
}

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoiceNumber: '01332254',
    vendorName: 'Darra Meats',
    invoiceDate: '2026-10-20',
    items: [item()],
    totalAmount: 345.84,
    status: 'processed',
    ...over,
  } as Invoice;
}

function target(over: Partial<InvoiceFocusTarget> = {}): InvoiceFocusTarget {
  return { nonce: 1, ...over };
}

// ---------------------------------------------------------------- invoice resolution
console.log('\nWhich invoice a link means');

const a = invoice({ id: 'inv-a', invoiceNumber: '01332254' });
const b = invoice({ id: 'inv-b', invoiceNumber: '01332255' });

check(
  'id wins over the number',
  invoiceForFocus(target({ invoiceId: 'inv-b', invoiceNumber: '01332254' }), [a, b])?.id === 'inv-b'
);

check(
  'number is used when the id is unknown',
  invoiceForFocus(target({ invoiceNumber: '01332255' }), [a, b])?.id === 'inv-b'
);

check(
  'a stale id falls back to the number',
  invoiceForFocus(target({ invoiceId: 'gone', invoiceNumber: '01332255' }), [a, b])?.id === 'inv-b'
);

check(
  'no id and no number resolves to nothing',
  invoiceForFocus(target({}), [a, b]) === null
);

check(
  'a number that is gone resolves to nothing',
  invoiceForFocus(target({ invoiceNumber: '99999999' }), [a, b]) === null
);

// ------------------------------------------------- duplicated numbers, e.g. a re-import
console.log('\nWhen two invoices carry the same number');

// The re-import is first in the list and the original is second, so "first match" is wrong.
const reimport = invoice({
  id: 'inv-reimport',
  invoiceNumber: '01332254',
  items: [item({ id: 'it-reimport', masterProductId: 'mp-other' })],
});
const original = invoice({
  id: 'inv-original',
  invoiceNumber: '01332254',
  items: [item({ id: 'it-original', masterProductId: 'mp-1' })],
});

check(
  'the invoice that holds the line wins',
  invoiceForFocus(
    target({ invoiceNumber: '01332254', masterProductId: 'mp-1' }),
    [reimport, original]
  )?.id === 'inv-original'
);

check(
  'the product match also works through the line id',
  invoiceForFocus(
    target({ invoiceNumber: '01332254', itemId: 'it-reimport' }),
    [reimport, original]
  )?.id === 'inv-reimport'
);

check(
  'without a line, the first one with that number is used',
  invoiceForFocus(target({ invoiceNumber: '01332254' }), [reimport, original])?.id === 'inv-reimport'
);

// ---------------------------------------------------------------- line resolution
console.log('\nWhich line a link means');

const withLines = invoice({
  items: [
    item({ id: 'it-1', masterProductId: 'mp-1' }),
    item({ id: 'it-2', masterProductId: 'mp-2', pageNumber: 4 }),
  ],
});

check(
  'the line id wins',
  itemForFocus(withLines, target({ itemId: 'it-2', masterProductId: 'mp-1' }))?.id === 'it-2'
);

check(
  'a stale line id falls back to the product',
  itemForFocus(withLines, target({ itemId: 'gone', masterProductId: 'mp-2' }))?.id === 'it-2'
);

check(
  'no line id and no product means no line',
  itemForFocus(withLines, target({})) === null
);

check(
  'a product that is not on the invoice means no line',
  itemForFocus(withLines, target({ masterProductId: 'mp-absent' })) === null
);

// ---------------------------------------------------------------- combined result
console.log('\nWhat the view is told to do');

const lineHit = resolveInvoiceJump(
  target({ invoiceNumber: '01332254', masterProductId: 'mp-2' }),
  [withLines]
);
check('a line hit opens the invoice', lineHit.invoice?.id === withLines.id);
check('a line hit names the line', lineHit.item?.id === 'it-2');
check('a line hit knows a line was asked for', lineHit.lineRequested === true);

const invoiceOnly = resolveInvoiceJump(target({ invoiceNumber: '01332254' }), [withLines]);
check('invoice only still opens the invoice', invoiceOnly.invoice?.id === withLines.id);
check('invoice only names no line', invoiceOnly.item === null);
check(
  'invoice only is not treated as a missing line',
  invoiceOnly.lineRequested === false,
  'a bare invoice link must not report "this product has no line on it"'
);

const missingLine = resolveInvoiceJump(
  target({ invoiceNumber: '01332254', masterProductId: 'mp-absent' }),
  [withLines]
);
check('a missing product still opens the invoice', missingLine.invoice?.id === withLines.id);
check('a missing product names no line', missingLine.item === null);
check('a missing product is reported as requested-but-absent', missingLine.lineRequested === true);

const missingInvoice = resolveInvoiceJump(target({ invoiceNumber: 'nope' }), [withLines]);
check('a deleted invoice resolves to nothing', missingInvoice.invoice === null);
check('a deleted invoice names no line', missingInvoice.item === null);

// ---------------------------------------------------------------- DOM ids
console.log('\nScroll targets');

check('the row id is derived from the line id', lineDomId('it-2') === 'invoice-line-it-2');
check(
  'two different lines give two different ids',
  lineDomId('it-1') !== lineDomId('it-2')
);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
