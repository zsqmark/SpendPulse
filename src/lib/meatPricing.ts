/**
 * Whether a line is a meat line, and which number should represent it in the UI.
 *
 * Meat is bought by weight, so the meaningful number on a meat line is the WEIGHT, not
 * the quantity. A Darra Meats invoice prints both, and they are different numbers:
 *
 *   CHICKEN MARYLAND # 22   Qty 3   Weight 57.640   Price $6.00   Amount $345.84
 *   -> the line is 57.640 kg at $6.00/kg; "3" is the number of cartons.
 *
 * Showing "3" for a meat row is what made the catalogue look like $115/kg chicken, so
 * the UI asks here instead of reaching for `quantity` directly.
 *
 * This module is deliberately free of Node / database imports - the browser bundles it.
 */

export const MEAT_CATEGORY = 'Meat & Poultry';

/** Product words that mark a line as meat. Extended here in one place for both sides. */
export const MEAT_PATTERN =
  /\b(beef|pork|lamb|chicken|poultry|meat|sausage|bacon|ribs|steak|mince)\b/i;

/** True when a description (and any brand text) names a meat product. */
export function isMeatDescription(
  description?: string | null,
  brand?: string | null
): boolean {
  const text = `${description ?? ''} ${brand ?? ''}`.trim();
  return !!text && MEAT_PATTERN.test(text);
}

/** Same test, applied to a line item. */
export function isMeatLine(item: {
  rawDescription?: string | null;
  brand?: string | null;
  masterProductName?: string | null;
}): boolean {
  return (
    isMeatDescription(item.rawDescription, item.brand) ||
    isMeatDescription(item.masterProductName)
  );
}

/**
 * The measure a line should be shown and edited in.
 *
 * For meat it is the weight in kg (falling back to a quantity that is already a mass);
 * for everything else it is the plain quantity with its invoicing unit.
 */
export function lineMeasure(item: {
  rawDescription?: string | null;
  brand?: string | null;
  masterProductName?: string | null;
  quantity?: number | null;
  weight?: number | null;
  unit?: string | null;
}): { value: number | null; unit: string; isWeight: boolean } {
  const unit = (item.unit || '').trim();

  if (isMeatLine(item)) {
    const printed = Number(item.weight);
    if (Number.isFinite(printed) && printed > 0) {
      return { value: printed, unit: 'kg', isWeight: true };
    }

    // No weight column: a quantity that is already a mass is still a weight.
    const qty = Number(item.quantity);
    const lower = unit.toLowerCase();
    if (Number.isFinite(qty) && qty > 0) {
      if (lower === 'kg' || lower === 'kilo' || lower === 'kilos' || lower === 'kilogram') {
        return { value: qty, unit: 'kg', isWeight: true };
      }
      if (lower === 'g' || lower === 'gram' || lower === 'grams') {
        return { value: qty / 1000, unit: 'kg', isWeight: true };
      }
    }
  }

  const qty = Number(item.quantity);
  return {
    value: Number.isFinite(qty) ? qty : null,
    unit,
    isWeight: false,
  };
}

/** The number and unit to render in the quantity column of the line-items table. */
export function formatLineMeasure(item: {
  rawDescription?: string | null;
  brand?: string | null;
  masterProductName?: string | null;
  quantity?: number | null;
  weight?: number | null;
  unit?: string | null;
}): string {
  const { value, unit, isWeight } = lineMeasure(item);
  if (value == null) return '-';

  const trimmed = Number(value.toFixed(3));
  if (isWeight) return `${trimmed} kg`;
  return unit ? `${trimmed} ${unit}` : String(trimmed);
}
