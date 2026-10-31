/**
 * The catalogue's category vocabulary.
 *
 * One list, used by the guesser, the manual override and the filter, so the same product
 * cannot be filed under "Dry Goods" by one path and "Dry Goods & Baking" by another - which
 * is exactly what had happened: the add-product form offered a set of names that the
 * automatic classifier never produced.
 *
 * Browser-safe: the catalogue UI imports it.
 */

export const CATEGORY_OPTIONS = [
  'Meat & Poultry',
  'Seafood',
  'Dairy & Eggs',
  'Dry Goods',
  'Produce',
  'Frozen',
  'Cleaning & Disposables',
  'Beverages',
  'General Supplies',
] as const;

export type ProductCategory = (typeof CATEGORY_OPTIONS)[number];

/** The fallback, used when nothing in the description is recognisable. */
export const DEFAULT_CATEGORY: ProductCategory = 'General Supplies';

/**
 * Older spellings that are still sitting in the database. They are not rewritten on read -
 * a stored value is what the owner or the importer put there - but the recategorise sweep
 * uses this to report what it is about to change, and `normaliseCategory` keeps a manual
 * edit from re-introducing a name nothing else produces.
 */
export const CATEGORY_ALIASES: Record<string, ProductCategory> = {
  'dry goods & baking': 'Dry Goods',
  'oils & shortening': 'Dry Goods',
  'produce & fresh': 'Produce',
  'packaging & disposables': 'Cleaning & Disposables',
  'chemicals & sanitation': 'Cleaning & Disposables',
  'dairy': 'Dairy & Eggs',
  'meat': 'Meat & Poultry',
};

/** True for one of the names above. */
export function isKnownCategory(value?: string | null): boolean {
  if (!value) return false;
  return (CATEGORY_OPTIONS as readonly string[]).includes(value);
}

/** Maps an old spelling onto the current one; unknown names come back trimmed, unchanged. */
export function normaliseCategory(value?: string | null): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return DEFAULT_CATEGORY;
  const alias = CATEGORY_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}
