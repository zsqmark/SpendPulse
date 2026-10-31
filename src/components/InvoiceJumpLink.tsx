import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { InvoiceFocusTarget } from '../types/index.ts';

/** Everything needed to say "take me to that line of that invoice". */
export type InvoiceJumpRequest = Omit<InvoiceFocusTarget, 'nonce'>;

export interface InvoiceJumpLinkProps {
  invoiceNumber?: string | null;
  invoiceId?: string | null;
  /** The line to land on. Without it the invoice opens at its first line. */
  itemId?: string | null;
  /** Used when the line id is stale, e.g. after a rebuild. */
  masterProductId?: string | null;
  /** Called with the destination. Without it the number is printed as plain text. */
  onJump?: (target: InvoiceJumpRequest) => void;
  /** Text before the number, e.g. "inv #". */
  prefix?: string;
  className?: string;
  title?: string;
}

/**
 * An invoice number that takes you to the invoice it names.
 *
 * A number on a product card, in a price history or in the review list is a reference to
 * something that lives in another view. Reading it and then hunting for the invoice by
 * hand is the tedious part, so every one of those numbers is a link.
 *
 * Renders plain text when no handler is wired, so a component never needs to know whether
 * the jump is available.
 */
export const InvoiceJumpLink: React.FC<InvoiceJumpLinkProps> = ({
  invoiceNumber,
  invoiceId,
  itemId,
  masterProductId,
  onJump,
  prefix,
  className = '',
  title,
}) => {
  const label = invoiceNumber || (invoiceId ? 'this invoice' : '');

  if (!label) return null;

  if (!onJump) {
    return (
      <span className={className}>
        {prefix}
        {label}
      </span>
    );
  }

  // These numbers also sit inside clickable rows and checkbox labels, where a bare click
  // would open something else and toggle a tick box on the way. The jump owns the click.
  const handle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onJump({
      invoiceId: invoiceId ?? null,
      invoiceNumber: invoiceNumber ?? null,
      itemId: itemId ?? null,
      masterProductId: masterProductId ?? null,
    });
  };

  return (
    <button
      type="button"
      onClick={handle}
      title={title || `Open invoice ${label} at this line`}
      className={`group inline-flex items-center gap-0.5 rounded px-0.5 -mx-0.5 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400/60 transition-colors ${className}`}
    >
      {prefix && <span className="text-slate-500">{prefix}</span>}
      <span className="underline decoration-blue-500/30 underline-offset-2 group-hover:decoration-blue-400/70">
        {label}
      </span>
      <ArrowUpRight className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100 transition-opacity" />
    </button>
  );
};
