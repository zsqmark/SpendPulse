import React, { useState } from 'react';
import { PriceAlert, Invoice, MasterProduct } from '../types/index.ts';
import { InvoiceJumpLink, type InvoiceJumpRequest } from './InvoiceJumpLink.tsx';
import {
  alertRates,
  changeBetween,
  formatAmount,
  normaliseUnitLabel,
} from '../lib/priceDisplay.ts';
import {
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  FileSpreadsheet,
  ArrowUpRight,
  ExternalLink,
  MessageSquareWarning,
} from 'lucide-react';

interface PriceAlertsFeedProps {
  alerts: PriceAlert[];
  /**
   * Today's invoices. An alert is matched to its line at render time, so a corrected unit
   * or price shows up here instead of the frozen copy taken when the alert was raised.
   */
  invoices?: Invoice[];
  products?: MasterProduct[];
  onAcknowledge: (id: string) => void;
  onDispute: (id: string) => void;
  onViewProductTrends: (productId: string) => void;
  /** Takes the invoice number through to the line that triggered the alert. */
  onJumpToInvoice?: (target: InvoiceJumpRequest) => void;
}

export const PriceAlertsFeed: React.FC<PriceAlertsFeedProps> = ({
  alerts,
  invoices = [],
  products = [],
  onAcknowledge,
  onDispute,
  onViewProductTrends,
  onJumpToInvoice,
}) => {
  const [filter, setFilter] = useState<'all' | 'active' | 'acknowledged' | 'disputed'>('active');

  const filteredAlerts = alerts.filter((a) => {
    if (filter === 'all') return true;
    return a.status === filter;
  });

  const activeCount = alerts.filter((a) => a.status === 'active').length;

  return (
    <div className="space-y-4">
      {/* Feed Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-rose-400" />
            <span>Price Increase Alerts</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Triggered automatically when any item unit price exceeds its previous invoice baseline
          </p>
        </div>

        {/* Filter controls */}
        <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
          <button
            onClick={() => setFilter('active')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              filter === 'active'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Active ({activeCount})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              filter === 'all'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            All ({alerts.length})
          </button>
          <button
            onClick={() => setFilter('acknowledged')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              filter === 'acknowledged'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Acknowledged
          </button>
          <button
            onClick={() => setFilter('disputed')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              filter === 'disputed'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Disputed
          </button>
        </div>
      </div>

      {/* Alert Cards Grid */}
      {filteredAlerts.length === 0 ? (
        <div className="border border-slate-800 rounded-xl p-10 text-center bg-slate-950/40">
          <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto mb-3 opacity-80" />
          <h3 className="text-sm font-medium text-slate-200">No {filter} price alerts</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            {filter === 'active'
              ? 'All item price fluctuations have been reviewed and acknowledged.'
              : 'No alerts match this filter.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredAlerts.map((alert) => {
            // Both figures come from one place, per base unit - the basis the increase
            // was judged on. The live line wins so a correction shows up immediately.
            const rates = alertRates(alert, invoices, products);
            const { printed: printedRate, was: wasRate, now: newRate } = rates;
            const change = changeBetween(wasRate, newRate, {
              percent: alert.percentChange,
              delta: alert.deltaAmount,
            });
            const changePct = change.percent ?? alert.percentChange ?? null;
            const changeDelta = change.delta ?? alert.deltaAmount ?? null;
            const isHighSpike = (changePct ?? 0) >= 10;

            return (
              <div
                key={alert.id}
                className={`p-4 rounded-xl border transition-all ${
                  alert.status === 'active'
                    ? isHighSpike
                      ? 'bg-rose-950/20 border-rose-900/50 hover:border-rose-700/60'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    : 'bg-slate-950/40 border-slate-900 opacity-75'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-slate-400">{alert.vendorName}</span>
                      <span className="text-slate-600 text-xs">·</span>
                      <InvoiceJumpLink
                        className="text-xs font-mono"
                        invoiceNumber={alert.invoiceNumber}
                        invoiceId={alert.invoiceId}
                        masterProductId={alert.masterProductId}
                        onJump={onJumpToInvoice}
                        title={`Open invoice ${alert.invoiceNumber} at this line`}
                      />
                    </div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      {alert.productName}
                    </h3>
                  </div>

                  {/* Percentage Spike Tag - the movement between the two per-base figures.
                      Left out entirely when no shared basis could be found: a number
                      invented from two different measures would be worse than none. */}
                  <div className="text-right shrink-0">
                    {changePct != null ? (
                      <div className="inline-flex items-center gap-0.5 font-mono text-sm font-bold text-rose-400">
                        <ArrowUpRight className="w-4 h-4" />
                        <span>+{changePct.toFixed(1)}%</span>
                      </div>
                    ) : null}
                    {changeDelta != null ? (
                      <p className="text-[11px] font-mono text-slate-400">
                        +${formatAmount(changeDelta)} /{' '}
                        {newRate?.unit ?? normaliseUnitLabel(alert.unit)}
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* Price Baseline Comparison - the same figures the line detail panel shows. */}
                <div className="mt-3.5 p-2.5 rounded-lg bg-slate-950/60 border border-slate-850 flex items-center justify-between text-xs font-mono">
                  <div>
                    <span className="text-slate-500 block text-[10px] uppercase tracking-wider">
                      {wasRate ? `Was per ${wasRate.unit}` : 'Previous Price'}
                    </span>
                    <span className="text-slate-300 font-semibold tabular-nums">
                      {wasRate?.text ?? '—'}
                    </span>
                  </div>

                  <div className="text-slate-600 text-sm">→</div>

                  <div>
                    <span className="text-slate-500 block text-[10px] uppercase tracking-wider">
                      {newRate ? `Now per ${newRate.unit}` : 'New Invoiced Price'}
                    </span>
                    <span className="text-rose-300 font-bold tabular-nums">
                      {newRate?.text ?? printedRate?.text ?? '—'}
                    </span>
                    {newRate && printedRate && newRate.unit !== printedRate.unit ? (
                      <span className="block text-[10px] font-normal text-slate-500">
                        printed {printedRate.text}
                      </span>
                    ) : null}
                  </div>

                  <div className="text-right">
                    <span className="text-slate-500 block text-[10px] uppercase tracking-wider">Invoiced Date</span>
                    <span className="text-slate-300">{alert.invoiceDate}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-3.5 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                  <button
                    onClick={() => onViewProductTrends(alert.masterProductId)}
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
                  >
                    <span>View Price Curve</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>

                  <div className="flex items-center gap-2">
                    {alert.status === 'active' && (
                      <>
                        <button
                          onClick={() => onDispute(alert.id)}
                          className="px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-950/40 border border-amber-500/30 rounded-md transition-colors flex items-center gap-1"
                        >
                          <MessageSquareWarning className="w-3 h-3" />
                          <span>Dispute</span>
                        </button>
                        <button
                          onClick={() => onAcknowledge(alert.id)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 border border-slate-700 rounded-md transition-colors flex items-center gap-1"
                        >
                          <CheckCircle className="w-3 h-3 text-emerald-400" />
                          <span>Acknowledge</span>
                        </button>
                      </>
                    )}
                    {alert.status === 'acknowledged' && (
                      <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Acknowledged
                      </span>
                    )}
                    {alert.status === 'disputed' && (
                      <span className="text-xs font-mono text-amber-400 flex items-center gap-1">
                        <MessageSquareWarning className="w-3 h-3" /> Flagged for Dispute
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
