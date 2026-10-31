import type { Invoice, InvoiceFocusTarget, InvoiceItem } from '../types/index.ts';

/**
 * Working out where an invoice-number link points.
 *
 * Kept out of the view and free of React so the rules can be tested directly - a jump that
 * lands on the wrong invoice, or on the wrong row of the right invoice, is indistinguishable
 * from a bug in the data until you can read the rule that chose it.
 */

/** What a jump resolved to. */
export interface JumpResolution {
  /** The invoice to open, or null when the link names one that is no longer there. */
  invoice: Invoice | null;
  /**
   * The line to highlight. Null means "open the invoice but do not claim a line":
   * either no line was asked for, or the line is not on this invoice.
   */
  item: InvoiceItem | null;
  /** True when the link named a specific line, so `item === null` means it is missing. */
  lineRequested: boolean;
}

/**
 * Which invoice a jump means.
 *
 * The id is authoritative. Failing that, the number is matched - and when several invoices
 * carry the same number (a re-import, or a statement read twice) the one that actually holds
 * the line we were sent to wins, because landing on its twin would look like the link went
 * to the wrong place.
 */
export function invoiceForFocus(
  target: InvoiceFocusTarget,
  invoices: Invoice[]
): Invoice | null {
  if (target.invoiceId) {
    const byId = invoices.find((i) => i.id === target.invoiceId);
    if (byId) return byId;
  }
  if (!target.invoiceNumber) return null;

  const sameNumber = invoices.filter((i) => i.invoiceNumber === target.invoiceNumber);
  if (sameNumber.length <= 1) return sameNumber[0] ?? null;

  const holds = sameNumber.find((i) =>
    i.items.some(
      (it) =>
        (target.itemId && it.id === target.itemId) ||
        (target.masterProductId && it.masterProductId === target.masterProductId)
    )
  );
  return holds ?? sameNumber[0];
}

/** The line a jump means: by id, or by product when the id has gone stale. */
export function itemForFocus(
  invoice: Invoice,
  target: InvoiceFocusTarget
): InvoiceItem | null {
  if (target.itemId) {
    const exact = invoice.items.find((it) => it.id === target.itemId);
    if (exact) return exact;
  }
  if (target.masterProductId) {
    return invoice.items.find((it) => it.masterProductId === target.masterProductId) ?? null;
  }
  return null;
}

/** Resolves a link in one step, telling "no line asked for" apart from "line missing". */
export function resolveInvoiceJump(
  target: InvoiceFocusTarget,
  invoices: Invoice[]
): JumpResolution {
  const lineRequested = Boolean(target.itemId || target.masterProductId);
  const invoice = invoiceForFocus(target, invoices);
  const item = invoice && lineRequested ? itemForFocus(invoice, target) : null;
  return { invoice, item, lineRequested };
}

/** DOM id of one line row, used to scroll to it. */
export const lineDomId = (itemId: string) => `invoice-line-${itemId}`;
