/**
 * Pins the rule for alias ownership after a split.
 *
 * Run with:  npm run test:alias
 *
 * The bug this protects against: "BABA'FISH CURRY PWD 40*250G" was split out of
 * "BABA'S MEAT CURRY PWD 40*250G". The invoice lines moved, but the MEAT card kept the
 * FISH alias. Searching "FISH CURRY" then showed the MEAT card (search matches aliases),
 * while opening it showed no FISH lines at all. The same alias on two cards also lets the
 * exact-alias matcher send a future OCR line back to the wrong product.
 */

import {
  lineBacksAlias,
  normaliseAliasName,
  planAliasCleanup,
  planGlobalAliasCleanup,
  type AliasOwner,
  type AliasRecord,
  type OwnedLine,
} from '../src/lib/vendorAliasAudit.ts';

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

function alias(aliasName: string, supplierSku?: string): AliasRecord {
  return {
    vendorName: 'T & D Trading Pty Ltd',
    aliasName,
    supplierSku,
    lastSeen: '2026-10-08',
  };
}

function line(rawDescription: string, supplierSku?: string): OwnedLine {
  return { rawDescription, supplierSku };
}

console.log('\nNames and the lines that back them');

check('names are folded for comparison', normaliseAliasName("  BABA'FISH CURRY  ") === "baba'fish curry");
check('an empty name folds to empty', normaliseAliasName(undefined) === '');
check('a line with the same printed name backs the alias', lineBacksAlias(alias('FISH CURRY'), line('FISH CURRY')));
check('name matching ignores case and padding', lineBacksAlias(alias('Fish Curry'), line('  fish curry  ')));
check('a different name does not back the alias', !lineBacksAlias(alias('FISH CURRY'), line('MEAT CURRY')));
check('a shared supplier SKU backs an OCR variant', lineBacksAlias(alias("'BABA'FISH CURRY", '394101'), line('BABA FISH CURRY', '394101')));
check('a different SKU does not back it', !lineBacksAlias(alias('FISH CURRY', '394101'), line('MEAT CURRY', '394100')));
check('two empty SKUs never back anything', !lineBacksAlias(alias('FISH CURRY'), line('MEAT CURRY')));

console.log('\nCleaning the product a split took lines out of');

const sourceAliases = [
  alias("BABA'S MEAT CURRY PWD 40*250G", '394100'),
  alias("BABA'FISH CURRY PWD 40*250G", '394101'),
  alias("BABA' MEAT CURRY POWDER 10*1KG", '55220479'),
];
const remainingLines = [
  line("BABA'S MEAT CURRY PWD 40*250G", '394100'),
  line("BABA' MEAT CURRY POWDER 10*1KG", '55220479'),
];

const splitPlan = planAliasCleanup(sourceAliases, remainingLines, {
  transferredNames: ["BABA'FISH CURRY PWD 40*250G"],
  transferredSkus: ['394101'],
  claimedElsewhere: ["BABA'FISH CURRY PWD 40*250G"],
});

check('a backed alias survives', splitPlan.keep.some((a) => a.aliasName === "BABA'S MEAT CURRY PWD 40*250G"));
check('the other backed alias survives', splitPlan.keep.some((a) => a.aliasName === "BABA' MEAT CURRY POWDER 10*1KG"));
check('the transferred alias is removed', splitPlan.removed.some((r) => r.alias.aliasName === "BABA'FISH CURRY PWD 40*250G" && r.reason === 'transferred'));
check('exactly one alias is removed', splitPlan.removed.length === 1);
check('nothing is reported orphaned', splitPlan.orphaned.length === 0);

const bySku = planAliasCleanup([alias('OLD OCR SPELLING', '394101')], [], {
  transferredNames: [],
  transferredSkus: ['394101'],
});
check('a stale alias goes when only its SKU moved', bySku.removed.length === 1 && bySku.removed[0].reason === 'transferred');

const byClaim = planAliasCleanup([alias('FISH CURRY')], [], {
  claimedElsewhere: ['fish curry'],
});
check('a stale alias claimed by another card is removed', byClaim.removed.length === 1 && byClaim.removed[0].reason === 'duplicate');

const orphan = planAliasCleanup([alias('EDLY\'N LEMON JUICE 12*11')], []);
check('an unbacked spelling with no competing owner is kept', orphan.keep.length === 1 && orphan.removed.length === 0);
check('and is reported as orphaned', orphan.orphaned.length === 1);

const stillOwned = planAliasCleanup(
  [alias('FISH CURRY')],
  [line('FISH CURRY')],
  { transferredNames: ['FISH CURRY'], transferredSkus: ['394101'], claimedElsewhere: ['fish curry'] }
);
check('a backed alias is never removed even if that name was transferred', stillOwned.keep.length === 1 && stillOwned.removed.length === 0);

const noOptions = planAliasCleanup([alias('A'), alias('B')], [line('A'), line('B')]);
check('no cleanup options means no removals', noOptions.removed.length === 0 && noOptions.keep.length === 2);

console.log('\nRepairing ownership across the whole catalogue');

const owners: AliasOwner[] = [
  {
    id: 'meat',
    name: "BABA'S MEAT CURRY PWD 40*250G",
    aliases: [alias("BABA'S MEAT CURRY PWD 40*250G", '394100'), alias("BABA'FISH CURRY PWD 40*250G", '394101')],
  },
  {
    id: 'fish',
    name: "BABA'S FISH CURRY PWD 40*250G",
    aliases: [alias("BABA'FISH CURRY PWD 40*250G", '394101')],
  },
];
const linesByProduct: Record<string, OwnedLine[]> = {
  meat: [line("BABA'S MEAT CURRY PWD 40*250G", '394100')],
  fish: [line("BABA'FISH CURRY PWD 40*250G", '394101')],
};

const globalPlan = planGlobalAliasCleanup(owners, linesByProduct);
check('exactly one alias is marked for removal', globalPlan.removals.length === 1);
check('it is removed from the old card', globalPlan.removals[0]?.productId === 'meat');
check('the new card keeps its alias', !globalPlan.removals.some((r) => r.productId === 'fish'));
check('no name is ambiguous', globalPlan.ambiguous.length === 0);
check('the remaining aliases are counted', globalPlan.keptAliases === 2);

const noBacking = planGlobalAliasCleanup(
  [
    { id: 'a', name: 'A', aliases: [alias('SHARED NAME')] },
    { id: 'b', name: 'B', aliases: [alias('SHARED NAME')] },
  ],
  { a: [], b: [] }
);
check('a contested name with no backed owner is not deleted', noBacking.removals.length === 0);
check('and is reported ambiguous', noBacking.ambiguous.length === 1 && noBacking.ambiguous[0].productIds.length === 2);

const twoBacked = planGlobalAliasCleanup(
  [
    { id: 'a', name: 'A', aliases: [alias('SHARED NAME')] },
    { id: 'b', name: 'B', aliases: [alias('SHARED NAME')] },
  ],
  { a: [line('SHARED NAME')], b: [line('SHARED NAME')] }
);
check('two backed owners are left for a human to decide', twoBacked.removals.length === 0 && twoBacked.ambiguous.length === 1);

const uniqueNames = planGlobalAliasCleanup(
  [
    { id: 'a', name: 'A', aliases: [alias('ONLY ON A')] },
    { id: 'b', name: 'B', aliases: [alias('ONLY ON B')] },
  ],
  { a: [line('ONLY ON A')], b: [line('ONLY ON B')] }
);
check('names held by one card are untouched', uniqueNames.removals.length === 0 && uniqueNames.keptAliases === 2);

const skuWinner = planGlobalAliasCleanup(
  [
    { id: 'a', name: 'A', aliases: [alias('AN OLD OCR SPELLING', '394101')] },
    { id: 'b', name: 'B', aliases: [alias('AN OLD OCR SPELLING', '394101')] },
  ],
  { a: [], b: [line('A DIFFERENT SPELLING', '394101')] }
);
check('the owner with a line carrying the SKU wins', skuWinner.removals.length === 1 && skuWinner.removals[0].productId === 'a');
check('the SKU-backed name is not ambiguous', skuWinner.ambiguous.length === 0);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
