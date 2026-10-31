import React, { useState } from 'react';
import { MasterProduct } from '../types/index.ts';
import { InvoiceJumpLink, type InvoiceJumpRequest } from './InvoiceJumpLink.tsx';
import {
  TrendingUp,
  ArrowUpRight,
  Calendar,
  Sparkles,
  DollarSign,
  AlertTriangle,
  History,
} from 'lucide-react';

/**
 * A price with as many decimals as its size deserves.
 *
 * Per-kilo figures live in dollars and cents, but per-each figures for disposables are
 * fractions of a cent, and "$0.01" for 20 skewers hides the only meaningful digits.
 */
const money = (value: number): string =>
  Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(2);

/**
 * The comparable rate for a product: its most recent price expressed per kg / per litre.
 *
 * The picker used to list the printed amount, so two brands of rice appeared 2x apart when
 * they cost the same per kilo and the bigger bag looked the expensive one.
 */
const baseRateOf = (product: MasterProduct): { price: number; unit: string } | null => {
  if (!product.baseUnit) return null;
  const newestFirst = [...(product.priceHistory ?? [])].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const hit = newestFirst.find((h) => h.baseUnitPrice != null);
  return hit ? { price: hit.baseUnitPrice as number, unit: product.baseUnit } : null;
};

interface PriceTrendsViewProps {
  products: MasterProduct[];
  selectedProductId?: string;
  onSelectProduct: (id: string) => void;
  /** Takes an invoice number through to the line it came from. */
  onJumpToInvoice?: (target: InvoiceJumpRequest) => void;
}

export const PriceTrendsView: React.FC<PriceTrendsViewProps> = ({
  products,
  selectedProductId,
  onSelectProduct,
  onJumpToInvoice,
}) => {
  const currentProduct =
    products.find((p) => p.id === selectedProductId) || products[0];

  const [hoveredPoint, setHoveredPoint] = useState<any>(null);

  if (!currentProduct || products.length === 0) {
    return (
      <div className="border border-slate-800 rounded-xl p-12 text-center bg-slate-950/40">
        <TrendingUp className="w-10 h-10 text-slate-600 mx-auto mb-3" />
        <h3 className="text-sm font-semibold text-slate-200">No Product Price Trends Yet</h3>
        <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
          Ingest your first invoices using the Scan Receipt or Folder Monitor tools. Once invoices are parsed, price fluctuation curves and 60-day inflation projections will appear here.
        </p>
      </div>
    );
  }

  // Sort history chronologically
  const sortedHistory = [...currentProduct.priceHistory].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  /**
   * The figure a comparison is made on.
   *
   * A supplier changes the pack without changing the product: 20kg of rice one month, 10kg
   * the next, at $62 and $32. Compared per bag that reads as a 48% collapse; per kilogram it
   * is $3.10 -> $3.20. So whenever the pack hierarchy is known, everything on this screen
   * - the curve, the range, the variance column - is per kg / per litre. The printed amount
   * is still shown beside it, because that is what the invoice says.
   *
   * An entry whose pack could not be read has no base price, and it must NOT fall back to
   * the printed one: $55 a carton next to $2.20 a kilogram on one axis would flatten every
   * real move into a straight line and rescale the chart by 25x. It stays out of the curve
   * and says so in the table - the same "never invent a price" rule the alerts follow.
   */
  const baseUnit = currentProduct.baseUnit || null;
  const compareInBase = Boolean(baseUnit) && sortedHistory.some((h) => h.baseUnitPrice != null);
  const unitLabel = compareInBase ? (baseUnit as string) : currentProduct.standardUnit;

  const series = sortedHistory.map((h) => {
    const comparable = compareInBase && h.baseUnitPrice != null;
    return {
      ...h,
      comparePrice: comparable ? (h.baseUnitPrice as number) : compareInBase ? null : h.unitPrice,
      compareUnit: comparable ? (baseUnit as string) : h.unit || currentProduct.standardUnit,
      /** The printed price, always available - what the row shows when it cannot be compared. */
      printedUnit: h.unit || currentProduct.standardUnit,
    };
  });

  /** The rows that can share one axis. Everything numeric on this screen reads from this. */
  const plotted = series.filter((h): h is typeof h & { comparePrice: number } => h.comparePrice != null);

  /**
   * The price each row is measured against: the previous row that could be compared.
   *
   * Measured against the previous ROW instead, one unreadable pack would blank the variance
   * of the purchase after it, and the buyer would lose the change across that gap.
   */
  const previousComparable: (number | null)[] = series.map((_, i) => {
    for (let j = i - 1; j >= 0; j -= 1) {
      const value = series[j].comparePrice;
      if (value != null) return value;
    }
    return null;
  });

  // SVG Chart Dimensions
  const svgWidth = 800;
  const svgHeight = 260;
  const padding = { top: 30, right: 90, bottom: 40, left: 60 };

  const prices = plotted.length > 0 ? plotted.map((h) => h.comparePrice) : [currentProduct.currentPrice];
  const minPrice = Math.min(...prices) * 0.9;
  const maxPrice = Math.max(...prices) * 1.15;

  const getX = (index: number, total: number) => {
    const availableWidth = svgWidth - padding.left - padding.right;
    return padding.left + (index / Math.max(total - 1, 1)) * availableWidth;
  };

  const getY = (val: number) => {
    const availableHeight = svgHeight - padding.top - padding.bottom;
    const norm = (val - minPrice) / (maxPrice - minPrice || 1);
    return svgHeight - padding.bottom - norm * availableHeight;
  };

  // Build SVG Path
  const points = plotted.map((h, i) => ({
    x: getX(i, plotted.length),
    y: getY(h.comparePrice),
    ...h,
  }));

  const pathD = points.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`;
  }, '');

  // Calculate 60-day predictive projection
  let projectedPrice = plotted.length > 0 ? plotted[plotted.length - 1].comparePrice : currentProduct.currentPrice;
  let projectionSlopePct = 0;
  if (plotted.length >= 2) {
    const first = plotted[0].comparePrice;
    const last = plotted[plotted.length - 1].comparePrice;
    const totalGrowth = (last - first) / first;
    projectionSlopePct = +(totalGrowth * 100).toFixed(1);
    // Extrapolate next 60 days
    projectedPrice = +(last * (1 + totalGrowth * 0.4)).toFixed(2);
  }

  const lastPoint = points[points.length - 1];
  const projectedX = svgWidth - padding.right + 40;
  const projectedY = getY(projectedPrice);

  return (
    <div className="space-y-6">
      {/* Product Selector Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-blue-400" />
            <span>Price Fluctuation History & Predictive Cost Forecast</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Cross-vendor price trajectories and automated 60-day inflation extrapolation
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">Product:</label>
          <select
            value={currentProduct.id}
            onChange={(e) => onSelectProduct(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 font-semibold focus:outline-none focus:border-blue-500 max-w-xs"
          >
            {products.map((p) => {
              const quoted = baseRateOf(p);
              return (
                <option key={p.id} value={p.id}>
                  {p.name} (
                  {quoted
                    ? `$${money(quoted.price)}/${quoted.unit}`
                    : `$${p.currentPrice.toFixed(2)}/${p.standardUnit}`}
                  )
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {/* KPI Metrics Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-850">
          <span className="text-slate-500 block text-[10px] uppercase font-mono tracking-wider">
            Current Rate
          </span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-xl font-bold font-mono text-slate-100 tabular-nums">
              ${money(plotted.length > 0 ? plotted[plotted.length - 1].comparePrice : currentProduct.currentPrice)}
            </span>
            <span className="text-xs text-slate-500 font-mono">/{unitLabel}</span>
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block font-mono">
            {plotted.length > 1 ? (
              <>Previous: ${money(plotted[plotted.length - 2].comparePrice)}/{unitLabel}</>
            ) : (
              <>Last invoiced: ${currentProduct.currentPrice.toFixed(2)}/{currentProduct.standardUnit}</>
            )}
          </span>
          {compareInBase && (
            <span className="text-[10px] text-slate-500 mt-0.5 block font-mono">
              last invoiced ${currentProduct.currentPrice.toFixed(2)}/{currentProduct.standardUnit}
            </span>
          )}
        </div>

        <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-850">
          <span className="text-slate-500 block text-[10px] uppercase font-mono tracking-wider">
            Historical Low vs High
          </span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-base font-bold font-mono text-emerald-400 tabular-nums">
              ${Math.min(...prices).toFixed(2)}
            </span>
            <span className="text-slate-500 text-xs">·</span>
            <span className="text-base font-bold font-mono text-rose-400 tabular-nums">
              ${Math.max(...prices).toFixed(2)}
            </span>
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block font-mono">
            Spread: ${(Math.max(...prices) - Math.min(...prices)).toFixed(2)} / {unitLabel}
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-850">
          <span className="text-slate-500 block text-[10px] uppercase font-mono tracking-wider">
            Observed Price Drift
          </span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className={`text-xl font-bold font-mono tabular-nums ${projectionSlopePct > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
              {projectionSlopePct > 0 ? `+${projectionSlopePct}%` : `${projectionSlopePct}%`}
            </span>
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block">
            Across {plotted.length} of {sortedHistory.length} recorded purchases
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-blue-950/30 border border-blue-900/40">
          <span className="text-blue-400 block text-[10px] uppercase font-mono tracking-wider flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-blue-400" />
            <span>60-Day Forecast Model</span>
          </span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-xl font-bold font-mono text-blue-300 tabular-nums">
              ${money(projectedPrice)}
            </span>
            <span className="text-xs text-blue-400/80 font-mono">/{unitLabel}</span>
          </div>
          <span className="text-[11px] text-blue-300/70 mt-1 block">
            Projected trajectory
          </span>
        </div>
      </div>

      {/* SVG Interactive Curve */}
      <div className="p-5 rounded-xl bg-slate-950/70 border border-slate-850 space-y-3">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-0.5 bg-blue-500" />
              <span>Historical Invoiced Purchases</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-0.5 border-t border-dashed border-purple-400" />
              <span>60-Day Projected Corridor</span>
            </div>
          </div>
          <span className="font-mono text-slate-500 text-[11px]">
            Values in USD / {unitLabel}
            {compareInBase && <span className="text-slate-600"> · invoiced amounts are per {currentProduct.standardUnit}</span>}
          </span>
        </div>

        <div className="relative w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-64 select-none"
          >
            {/* Horizontal Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
              const val = minPrice + pct * (maxPrice - minPrice);
              const y = getY(val);
              return (
                <g key={idx}>
                  <line
                    x1={padding.left}
                    y1={y}
                    x2={svgWidth - padding.right + 45}
                    stroke="#1e293b"
                    strokeWidth="1"
                    strokeDasharray="2 4"
                  />
                  <text
                    x={padding.left - 8}
                    y={y + 4}
                    fill="#64748b"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    ${val.toFixed(2)}
                  </text>
                </g>
              );
            })}

            {/* Historical Trend Line */}
            {pathD && (
              <path
                d={pathD}
                fill="none"
                stroke="#3b82f6"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Projected Corridor Line */}
            {lastPoint && (
              <line
                x1={lastPoint.x}
                y1={lastPoint.y}
                x2={projectedX}
                y2={projectedY}
                stroke="#a855f7"
                strokeWidth="2"
                strokeDasharray="4 4"
              />
            )}

            {/* Projected Point Marker */}
            <circle
              cx={projectedX}
              cy={projectedY}
              r="4.5"
              fill="#a855f7"
              stroke="#0f172a"
              strokeWidth="2"
            />
            <text
              x={projectedX}
              y={projectedY - 10}
              fill="#c084fc"
              fontSize="10"
              fontFamily="monospace"
              textAnchor="middle"
              fontWeight="bold"
            >
              ~${projectedPrice.toFixed(2)}
            </text>

            {/* Historical Data Points */}
            {points.map((p, idx) => {
              // A rise is a rise per kilo too, but not always per bag: a smaller pack at a
              // lower bag price is still a price rise. Judge the point on what is compared.
              const isIncrease = idx > 0 && p.comparePrice > points[idx - 1].comparePrice;
              return (
                <g
                  key={idx}
                  onMouseEnter={() => setHoveredPoint(p)}
                  onMouseLeave={() => setHoveredPoint(null)}
                  className="cursor-pointer"
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isIncrease ? '6' : '4.5'}
                    fill={isIncrease ? '#ef4444' : '#3b82f6'}
                    stroke="#0b0f19"
                    strokeWidth="2"
                  />
                  {/* Point Date Label */}
                  <text
                    x={p.x}
                    y={svgHeight - padding.bottom + 16}
                    fill="#64748b"
                    fontSize="9.5"
                    fontFamily="monospace"
                    textAnchor="middle"
                  >
                    {p.date.slice(5)}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Hover Tooltip */}
          {hoveredPoint && (
            <div className="absolute top-2 right-4 p-2.5 rounded-lg bg-slate-900 border border-slate-700 shadow-xl text-xs font-mono z-10 pointer-events-none">
              <div className="text-slate-400 text-[10px]">{hoveredPoint.vendor}</div>
              <div className="text-white font-bold text-sm">
                ${money(hoveredPoint.comparePrice)} /{hoveredPoint.compareUnit}
              </div>
              {compareInBase && (
                <div className="text-slate-500 text-[10px] mt-0.5">
                  invoiced ${hoveredPoint.unitPrice.toFixed(2)} /{hoveredPoint.unit || currentProduct.standardUnit}
                  {hoveredPoint.packSize ? ` · ${hoveredPoint.packSize}` : ''}
                </div>
              )}
              <div className="text-slate-500 text-[10px] mt-0.5">
                Invoice {hoveredPoint.invoiceNumber} · {hoveredPoint.date}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Why a row is missing from the curve - silence would read as a data loss. */}
      {compareInBase && plotted.length < sortedHistory.length && (
        <p className="text-[11px] text-amber-400/80 flex items-start gap-1.5 px-1 -mt-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-none mt-0.5" />
          <span>
            {sortedHistory.length - plotted.length} purchase
            {sortedHistory.length - plotted.length === 1 ? '' : 's'} could not be converted to
            per {unitLabel} because the pack on those invoices was unreadable, so
            {sortedHistory.length - plotted.length === 1 ? ' it is' : ' they are'} left off the
            curve and kept at the invoiced price in the table below.
          </span>
        </p>
      )}

      {/* Historical Purchases Breakdown Table */}
      <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
        <div className="p-3 bg-slate-900/70 border-b border-slate-800 text-xs font-semibold text-slate-300 flex items-center gap-2">
          <History className="w-4 h-4 text-slate-400" />
          <span>Historical Purchase Transactions for {currentProduct.name}</span>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 font-mono">
            <tr>
              <th className="py-2.5 px-4">Purchase Date</th>
              <th className="py-2.5 px-4">Supplier / Vendor</th>
              <th className="py-2.5 px-4">Invoice #</th>
              <th className="py-2.5 px-4 text-right">
                {compareInBase ? `Price per ${unitLabel}` : 'Invoiced Unit Price'}
              </th>
              <th className="py-2.5 px-4 text-right">Variance vs Prior</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-850">
            {series.map((h, i) => {
              const prev = previousComparable[i];
              const delta =
                h.comparePrice != null && prev != null ? +(h.comparePrice - prev).toFixed(4) : null;
              const isIncrease = delta != null && delta > 0;
              const deltaDp = delta != null && Math.abs(delta) < 0.01 ? 4 : 2;

              return (
                <tr key={i} className="hover:bg-slate-900/30">
                  <td className="py-2.5 px-4 font-mono text-slate-300">{h.date}</td>
                  <td className="py-2.5 px-4 font-medium text-slate-200">{h.vendor}</td>
                  <td className="py-2.5 px-4 font-mono text-slate-400">
                    {/* History stores the invoice number only, so the product id is what
                        carries the jump to the right line of that invoice. */}
                    <InvoiceJumpLink
                      invoiceNumber={h.invoiceNumber}
                      masterProductId={currentProduct.id}
                      onJump={onJumpToInvoice}
                    />
                  </td>
                  <td className="py-2.5 px-4 font-mono text-right font-bold text-slate-100 tabular-nums">
                    {h.comparePrice != null ? (
                      <>
                        ${money(h.comparePrice)} /{h.compareUnit}
                        {/* The amount actually printed on the invoice, so the two figures
                            can be reconciled without reopening the scan. */}
                        {compareInBase && (
                          <span className="block text-[10px] font-normal text-slate-500">
                            ${h.unitPrice.toFixed(2)} /{h.printedUnit}
                            {h.packSize ? ` · ${h.packSize}` : ''}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-slate-300 font-semibold">
                          ${h.unitPrice.toFixed(2)} /{h.printedUnit}
                        </span>
                        <span className="block text-[10px] font-normal text-amber-500/70">
                          no readable pack · not comparable
                        </span>
                      </>
                    )}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-right tabular-nums">
                    {delta == null ? (
                      <span className="text-slate-600">
                        {h.comparePrice == null ? '—' : 'Baseline'}
                      </span>
                    ) : isIncrease ? (
                      <span className="text-rose-400 font-bold inline-flex items-center gap-0.5">
                        <ArrowUpRight className="w-3.5 h-3.5" />
                        +${delta.toFixed(deltaDp)} (+{((delta / prev!) * 100).toFixed(1)}%)
                      </span>
                    ) : delta < 0 ? (
                      <span className="text-emerald-400 font-semibold">
                        -${Math.abs(delta).toFixed(deltaDp)} ({((delta / prev!) * 100).toFixed(1)}%)
                      </span>
                    ) : (
                      <span className="text-slate-500">Unchanged</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
