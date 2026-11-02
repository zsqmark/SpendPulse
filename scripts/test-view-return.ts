/**
 * Checks where "go back" lands after a task is finished.
 *
 * Run with:  npx tsx scripts/test-view-return.ts
 *
 * The rule that matters: following an invoice number from the trends page and then closing
 * the inspector has to put the reader back on the trends page, with the same product
 * selected, at the same scroll position - while Escape, the backdrop and a cancel button
 * leave them exactly where they are. Pinning it here keeps the navigation from drifting
 * back to "always land on the home tab".
 */

import {
  buildReturnOrigin,
  goesBackOnClose,
  resolveReturnTarget,
  fallbackTab,
  tabLabel,
} from '../src/lib/viewReturn.ts';

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

console.log('\nRecording where the jump came from');

const fromTrends = buildReturnOrigin('trends', 'invoices', null, 640);
check('a jump records the tab it left', fromTrends?.tab === 'trends');
check('a jump keeps the scroll position it left', fromTrends?.scrollY === 640);
check('the tab is named for a button', fromTrends?.label === 'Trends');

const fromAlerts = buildReturnOrigin('alerts', 'invoices', fromTrends, 120);
check('a second jump starts a new journey', fromAlerts?.tab === 'alerts');
check('a second jump takes its own scroll position', fromAlerts?.scrollY === 120);

const sameTab = buildReturnOrigin('invoices', 'invoices', fromTrends, 40);
check(
  'a jump inside the same tab is not a journey',
  sameTab === fromTrends,
  'the origin that brought the reader here must survive'
);
check('a jump inside the same tab keeps the old tab', sameTab?.tab === 'trends');

check(
  'an unknown tab still gets a label',
  tabLabel('vendors') === 'Suppliers' && tabLabel('nowhere') === 'nowhere'
);

const badScroll = buildReturnOrigin('trends', 'invoices', null, Number.NaN);
check('an unreadable scroll position becomes the top', badScroll?.scrollY === 0);

const emptyOrigin = buildReturnOrigin('', 'invoices', fromTrends, 0);
check('a jump with no page behind it keeps the old origin', emptyOrigin === fromTrends);

console.log('\nWhich closes go back');

check('finishing the task goes back', goesBackOnClose('complete'));
check('cancelling does not go back', !goesBackOnClose('cancel'));

const done = resolveReturnTarget(fromTrends, 'complete', 'invoices');
check('a completed close lands on the origin', done.tab === 'trends');
check('a completed close is reported as a journey', done.wentBack === true);

const cancelled = resolveReturnTarget(fromTrends, 'cancel', 'invoices');
check('a cancelled close stays on the current page', cancelled.tab === 'invoices');
check('a cancelled close is not reported as a journey', cancelled.wentBack === false);

const noOrigin = resolveReturnTarget(null, 'complete', 'invoices');
check('with no origin the close stays put', noOrigin.tab === 'invoices');
check('with no origin nothing is replayed', noOrigin.wentBack === false);

const backToSelf = resolveReturnTarget({ tab: 'invoices', label: 'Invoices', scrollY: 0 }, 'complete', 'invoices');
check('returning to the page you are on is a no-op', backToSelf.tab === 'invoices');

console.log('\nArriving with nothing to go back to');

check('a direct visit falls back to the home page', fallbackTab(undefined, 'invoices') === 'invoices');
check('a known page is kept', fallbackTab('catalog', 'invoices') === 'catalog');
check('an empty page name falls back too', fallbackTab('', 'invoices') === 'invoices');

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
