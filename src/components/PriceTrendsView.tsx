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

  // SVG Chart Dimensions
  const svgWidth = 800;
  const svgHeight = 260;
  const padding = { top: 30, right: 90, bottom: 40, left: 60 };

  const prices = sortedHistory.map((h) => h.unitPrice);
  const minPrice = Math.min(...prices, currentProduct.minPrice) * 0.9;
  const maxPrice = Math.max(...prices, currentProduct.maxPrice) * 1.15;

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
  const points = sortedHistory.map((h, i) => ({
    x: getX(i, sortedHistory.length),
    y: getY(h.unitPrice),
    ...h,
  }));

  const pathD = points.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`;
  }, '');

  // Calculate 60-day predictive projection
  let projectedPrice = currentProduct.currentPrice;
  let projectionSlopePct = 0;
  if (sortedHistory.length >= 2) {
    const first = sortedHistory[0].unitPrice;
    const last = sortedHistory[sortedHistory.length - 1].unitPrice;
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
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (${p.currentPrice.toFixed(2)}/{p.standardUnit})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* KPI Metrics Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-850">
          <span className="text-slate-500 block text-[10px] uppercase font-mono tracking-wider">
            Current Unit Rate
          </span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-xl font-bold font-mono text-slate-100 tabular-nums">
              ${currentProduct.currentPrice.toFixed(2)}
            </span>
            <span className="text-xs text-slate-500 font-mono">/{currentProduct.standardUnit}</span>
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block">
            Previous: ${currentProduct.previousPrice.toFixed(2)}
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-850">
          <span className="text-slate-500 block text-[10px] uppercase font-mono tracking-wider">
            Historical Low vs High
          </span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-base font-bold font-mono text-emerald-400 tabular-nums">
              ${currentProduct.minPrice.toFixed(2)}
            </span>
            <span className="text-slate-500 text-xs">·</span>
            <span className="text-base font-bold font-mono text-rose-400 tabular-nums">
              ${currentProduct.maxPrice.toFixed(2)}
            </span>
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block font-mono">
            Spread: ${(currentProduct.maxPrice - currentProduct.minPrice).toFixed(2)} / {currentProduct.standardUnit}
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
            Across {sortedHistory.length} recorded purchases
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-blue-950/30 border border-blue-900/40">
          <span className="text-blue-400 block text-[10px] uppercase font-mono tracking-wider flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-blue-400" />
            <span>60-Day Forecast Model</span>
          </span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-xl font-bold font-mono text-blue-300 tabular-nums">
              ${projectedPrice.toFixed(2)}
            </span>
            <span className="text-xs text-blue-400/80 font-mono">/{currentProduct.standardUnit}</span>
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
          <span className="font-mono text-slate-500 text-[11px]">Values in USD / {currentProduct.standardUnit}</span>
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
              const isIncrease = idx > 0 && p.unitPrice > points[idx - 1].unitPrice;
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
                ${hoveredPoint.unitPrice.toFixed(2)} /{currentProduct.standardUnit}
              </div>
              <div className="text-slate-500 text-[10px] mt-0.5">
                Invoice {hoveredPoint.invoiceNumber} · {hoveredPoint.date}
              </div>
            </div>
          )}
        </div>
      </div>

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
              <th className="py-2.5 px-4 text-right">Invoiced Unit Price</th>
              <th className="py-2.5 px-4 text-right">Variance vs Prior</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-850">
            {sortedHistory.map((h, i) => {
              const prev = i > 0 ? sortedHistory[i - 1].unitPrice : null;
              const delta = prev != null ? +(h.unitPrice - prev).toFixed(2) : null;
              const isIncrease = delta != null && delta > 0;

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
                    ${h.unitPrice.toFixed(2)} /{currentProduct.standardUnit}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-right tabular-nums">
                    {delta == null ? (
                      <span className="text-slate-600">Baseline</span>
                    ) : isIncrease ? (
                      <span className="text-rose-400 font-bold inline-flex items-center gap-0.5">
                        <ArrowUpRight className="w-3.5 h-3.5" />
                        +${delta.toFixed(2)} (+{((delta / prev!) * 100).toFixed(1)}%)
                      </span>
                    ) : delta < 0 ? (
                      <span className="text-emerald-400 font-semibold">
                        -${Math.abs(delta).toFixed(2)}
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
