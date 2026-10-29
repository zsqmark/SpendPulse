/**
 * The wording for historical alignment, shared by the server and the UI.
 *
 * Kept free of database and LLM imports (like `comparisonReason.ts`) so the browser can
 * render the very same sentences the server decided with. Two copies of this wording
 * would drift apart the first time one of them was edited.
 */

import type {
  AlignedField,
  AlignmentIdentityKind,
  AlignmentSource,
  FieldAlignment,
} from '../types/index.ts';

export const FIELD_LABEL: Record<AlignedField, string> = {
  unit: 'Unit',
  packSize: 'Pack size',
  taxRate: 'Tax rate',
  category: 'Category',
};

export const SOURCE_LABEL: Record<AlignmentSource, string> = {
  document: 'as printed',
  history: 'from history',
  converted: 'converted',
  empty: 'no value',
};

export const IDENTITY_LABEL: Record<AlignmentIdentityKind, string> = {
  sku: 'Matched on item code',
  name_spec: 'Matched on name + pack size',
  new: 'First sighting',
};

/** A colour token per source, so a row reads the same everywhere it is shown. */
export const SOURCE_TONE: Record<AlignmentSource, 'neutral' | 'filled' | 'moved' | 'muted'> = {
  document: 'neutral',
  history: 'filled',
  converted: 'moved',
  empty: 'muted',
};

/** Short line for one field: what is there now, and where it came from. */
export function describeField(field: AlignedField, source: AlignmentSource): string {
  const value = FIELD_LABEL[field];
  switch (source) {
    case 'history':
      return `${value} filled from history`;
    case 'converted':
      return `${value} converted to the historical one`;
    case 'empty':
      return `${value} unknown on both sides`;
    default:
      return `${value} taken as printed`;
  }
}

/**
 * The full explanation for one aligned field, shown in a tooltip and in the audit log.
 * Always names both figures, because "aligned" on its own tells the owner nothing
 * about whether anything actually moved.
 */
export function describeFieldAlignment(f: FieldAlignment): { summary: string; detail: string } {
  const label = FIELD_LABEL[f.field];
  const doc = f.documentValue ?? '(blank)';
  const hist = f.historyValue ?? '(blank)';

  if (f.source === 'history') {
    return {
      summary: `${label} filled from history`,
      detail: `The document left ${label.toLowerCase()} blank, so the value held in history was used: ${hist}.`,
    };
  }
  if (f.source === 'converted') {
    const factor = f.conversionFactor ?? 0;
    return {
      summary: `${label} converted to ${f.value}`,
      detail: `The document printed ${doc} but history holds ${hist}. The two are convertible, so the value was converted (x${roundFactor(factor)}) and the historical ${label.toLowerCase()} is now used. The printed value is kept on the line.`,
    };
  }
  if (f.conflict) {
    return {
      summary: `${label} could not be reconciled`,
      detail: `The document printed ${doc} while history holds ${hist}, and there is no conversion between them. The printed value was kept - it needs a human decision.${f.note ? ` ${f.note}` : ''}`,
    };
  }
  if (f.source === 'empty') {
    return {
      summary: `${label} has no value`,
      detail: `Neither the document nor history carries a ${label.toLowerCase()}, so the line was left without one.`,
    };
  }
  return {
    summary: `${label} as printed`,
    detail:
      f.historyValue != null
        ? `The document printed ${doc} and history agrees.`
        : `The document printed ${doc}; history had nothing recorded yet.`,
  };
}

function roundFactor(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '?';
  // 10, 0.1 and 12 read cleanly; 0.453592 does not need six decimals.
  return String(Math.abs(n) >= 1 ? Number(n.toFixed(4)) : Number(n.toFixed(6)));
}
