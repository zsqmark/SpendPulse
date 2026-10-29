/**
 * Why a line was recorded WITHOUT being judged against the product's history.
 *
 * The invoice view used to print a bare "Not compared", which tells the reader nothing
 * about what to do next: a product bought for the first time is fine, but a line whose
 * unit was misread is a data problem worth fixing. Each exit in the price check now
 * names itself, and both the server and the UI read the wording from here so the two
 * can never drift apart.
 *
 * Deliberately free of Node / database imports - the browser bundles this too.
 */

export type NotComparableCode =
  | 'first_purchase'
  | 'no_price'
  | 'implausible_gap'
  | 'unit_differs'
  | 'unknown';

/** The short chip shown under "Not compared" in the price column. */
export const NOT_COMPARABLE_LABEL: Record<NotComparableCode, string> = {
  first_purchase: 'First purchase',
  no_price: 'No unit price',
  implausible_gap: 'Unit misread?',
  unit_differs: 'Different unit',
  unknown: 'Cannot convert',
};

/**
 * What would make the line comparable again. Shown when there is no stored detail,
 * so an old record still explains itself.
 */
export const NOT_COMPARABLE_HINT: Record<NotComparableCode, string> = {
  first_purchase:
    'Nothing to compare against yet - the next invoice for this product will be judged against this one.',
  no_price: 'Edit the line and give it a unit price so it can be judged.',
  implausible_gap:
    'Check the pack size and unit on this line and on the previous one - a gap this wide is almost always a misread, not a price move.',
  unit_differs:
    'Add a pack size (e.g. 12*400ML) so the two can be converted into each other.',
  unknown:
    'The pack size or unit does not let this price be converted, so it is recorded without being judged.',
};

/** Falls back to a generic explanation for records saved before the reason existed. */
export function describeNotComparable(
  code?: string | null,
  detail?: string | null
): { label: string; detail: string } {
  const key = (code || 'unknown') as NotComparableCode;
  const label = NOT_COMPARABLE_LABEL[key] ?? NOT_COMPARABLE_LABEL.unknown;
  return { label, detail: detail || NOT_COMPARABLE_HINT[key] || NOT_COMPARABLE_HINT.unknown };
}
