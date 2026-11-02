/**
 * An alias is a promise: "an invoice line printed like this belongs to this product".
 *
 * When lines are split away, merged, or re-matched, that promise can outlive the line that
 * created it. A stale alias is not just untidy:
 *
 *   - the catalogue search matches on vendorAliases, so the OLD card still turns up for a
 *     search term that now belongs entirely to the NEW card. Clicking it opens a product
 *     with none of the lines the user was looking for ("it shows here, but it's gone inside");
 *   - the exact-alias matcher returns confidence 1.0, so the same name registered on two
 *     products can route a future OCR line back to the wrong one.
 *
 * The rules here are pure and deliberately conservative. An alias is only removed when we
 * can prove it no longer belongs: either the line it came from has been transferred to
 * another product, or another product now owns that name with a real line behind it. An
 * alias with no backing line but no competing owner is KEPT - it is usually an older OCR
 * spelling of the same goods and is still useful for matching the next invoice.
 *
 * Browser-safe: no db, no LLM, like the other modules in src/lib.
 */

export interface AliasRecord {
  vendorName: string;
  aliasName: string;
  supplierSku?: string;
  packSize?: string;
  lastSeen: string;
}

/** The two facts about a line that can back an alias: its printed name and its SKU. */
export interface OwnedLine {
  rawDescription?: string | null;
  supplierSku?: string | null;
}

export function normaliseAliasName(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Whether one of this product's own lines still supports an alias.
 *
 * The SKU matters as much as the name: OCR spells one product four different ways on four
 * invoices, and the supplier's code is what ties those spellings to the same card.
 */
export function lineBacksAlias(alias: AliasRecord, line: OwnedLine): boolean {
  const name = normaliseAliasName(alias.aliasName);
  if (name && name === normaliseAliasName(line.rawDescription)) return true;

  const sku = (alias.supplierSku ?? '').trim();
  const lineSku = (line.supplierSku ?? '').trim();
  return Boolean(sku && lineSku && sku === lineSku);
}

export interface AliasCleanupOptions {
  /** Printed names of lines just moved to another product. */
  transferredNames?: Iterable<string>;
  /** Supplier SKUs of lines just moved to another product. */
  transferredSkus?: Iterable<string>;
  /** Alias names registered on other products. */
  claimedElsewhere?: Iterable<string>;
}

export type AliasRemovalReason = 'transferred' | 'duplicate';

export interface AliasCleanupPlan {
  keep: AliasRecord[];
  removed: { alias: AliasRecord; reason: AliasRemovalReason }[];
  /** No backing line, but no competing owner either: kept on purpose. */
  orphaned: AliasRecord[];
}

function toNameSet(values?: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const value of values ?? []) {
    const key = normaliseAliasName(value);
    if (key) out.add(key);
  }
  return out;
}

function toSkuSet(values?: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const value of values ?? []) {
    const key = (value ?? '').trim();
    if (key) out.add(key);
  }
  return out;
}

/**
 * Decides what a product may keep after lines have been taken away from it.
 *
 * A backed alias is NEVER removed, even when a line with the same name was transferred: two
 * lines can carry the same description and only one of them may have been selected for the
 * split. Everything else is provably stale once its name or SKU has moved, or once another
 * product has claimed that name.
 */
export function planAliasCleanup(
  aliases: AliasRecord[],
  ownedLines: OwnedLine[],
  options: AliasCleanupOptions = {}
): AliasCleanupPlan {
  const transferredNames = toNameSet(options.transferredNames);
  const transferredSkus = toSkuSet(options.transferredSkus);
  const claimedElsewhere = toNameSet(options.claimedElsewhere);

  const keep: AliasRecord[] = [];
  const removed: { alias: AliasRecord; reason: AliasRemovalReason }[] = [];
  const orphaned: AliasRecord[] = [];

  for (const alias of aliases) {
    const name = normaliseAliasName(alias.aliasName);

    if (ownedLines.some((line) => lineBacksAlias(alias, line))) {
      keep.push(alias);
      continue;
    }

    const wasTransferred =
      (Boolean(name) && transferredNames.has(name)) ||
      Boolean((alias.supplierSku ?? '').trim() && transferredSkus.has((alias.supplierSku ?? '').trim()));
    if (wasTransferred) {
      removed.push({ alias, reason: 'transferred' });
      continue;
    }

    if (name && claimedElsewhere.has(name)) {
      removed.push({ alias, reason: 'duplicate' });
      continue;
    }

    // An unbacked spelling with no competing owner is still a useful OCR variant.
    orphaned.push(alias);
    keep.push(alias);
  }

  return { keep, removed, orphaned };
}

export interface AliasOwner {
  id: string;
  name: string;
  aliases: AliasRecord[];
}

export interface GlobalAliasPlan {
  removals: {
    productId: string;
    productName: string;
    aliasName: string;
    reason: 'duplicate';
  }[];
  /** Names held by several products where the rightful owner is NOT decidable. */
  ambiguous: { aliasName: string; productIds: string[] }[];
  keptAliases: number;
}

/**
 * Repairs alias ownership across the whole catalogue without guessing.
 *
 * For a name held by more than one product, exactly one holder must have a line behind it
 * for us to act. That holder keeps the name; every other holder loses it. If none or several
 * holders are backed, nothing is removed and the name is reported as ambiguous - deleting
 * the only copy of a name, or choosing an owner by array order, would silently change how
 * future invoice lines are matched.
 */
export function planGlobalAliasCleanup(
  owners: AliasOwner[],
  linesByProduct: Record<string, OwnedLine[]>
): GlobalAliasPlan {
  const holders = new Map<
    string,
    { owner: AliasOwner; alias: AliasRecord; backed: boolean }[]
  >();

  for (const owner of owners) {
    const lines = linesByProduct[owner.id] ?? [];
    for (const alias of owner.aliases ?? []) {
      const name = normaliseAliasName(alias.aliasName);
      if (!name) continue;
      const list = holders.get(name) ?? [];
      list.push({ owner, alias, backed: lines.some((line) => lineBacksAlias(alias, line)) });
      holders.set(name, list);
    }
  }

  const removals: GlobalAliasPlan['removals'] = [];
  const ambiguous: GlobalAliasPlan['ambiguous'] = [];
  let keptAliases = 0;

  for (const [name, list] of holders) {
    const productIds = [...new Set(list.map((h) => h.owner.id))];
    if (productIds.length < 2) {
      keptAliases += list.length;
      continue;
    }

    const backedOwners = [...new Set(list.filter((h) => h.backed).map((h) => h.owner.id))];
    if (backedOwners.length !== 1) {
      ambiguous.push({ aliasName: name, productIds });
      keptAliases += list.length;
      continue;
    }

    const winner = backedOwners[0];
    for (const holder of list) {
      if (holder.owner.id === winner) {
        keptAliases += 1;
      } else {
        removals.push({
          productId: holder.owner.id,
          productName: holder.owner.name,
          aliasName: holder.alias.aliasName,
          reason: 'duplicate',
        });
      }
    }
  }

  return { removals, ambiguous, keptAliases };
}
