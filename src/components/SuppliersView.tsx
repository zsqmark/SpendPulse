import React, { useState, useMemo } from 'react';
import { VendorSummary } from '../types/index.ts';
import { vendorKey } from '../lib/vendorNormalizer.ts';
import {
  Building2,
  Search,
  Combine,
  Sparkles,
  RefreshCw,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Layers,
} from 'lucide-react';

interface SuppliersViewProps {
  vendors: VendorSummary[];
  onNormalize: () => Promise<any>;
  onMerge: (primaryName: string, otherNames: string[]) => Promise<any>;
  onRefresh: () => void;
}

const fmtMoney = (n: number) =>
  `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const SuppliersView: React.FC<SuppliersViewProps> = ({
  vendors,
  onNormalize,
  onMerge,
  onRefresh,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [primaryName, setPrimaryName] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [bannerKind, setBannerKind] = useState<'ok' | 'warn' | 'err'>('ok');

  // Group vendors by match key so the page can suggest which spellings are the same supplier.
  const dupGroups = useMemo(() => {
    const byKey = new Map<string, VendorSummary[]>();
    for (const v of vendors) {
      const k = v.key || v.name;
      const list = byKey.get(k) || [];
      list.push(v);
      byKey.set(k, list);
    }
    return Array.from(byKey.entries())
      .filter(([, list]) => list.length > 1)
      .map(([k, list]) => ({ key: k, list }))
      .sort((a, b) => b.list.reduce((s, v) => s + v.spend, 0) - a.list.reduce((s, v) => s + v.spend, 0));
  }, [vendors]);

  const filtered = vendors.filter((v) =>
    v.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    v.normalized.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const selected = selection
    .map((n) => vendors.find((v) => v.name === n))
    .filter((v): v is VendorSummary => Boolean(v));

  const mergeTargetId =
    selected.some((v) => v.name === primaryName) && primaryName
      ? primaryName
      : selected[0]?.name || '';
  const mergeTarget = selected.find((v) => v.name === mergeTargetId) || null;
  const canMerge = selected.length >= 2 && !!mergeTarget;

  const toggle = (name: string) => {
    setBanner(null);
    setSelection((prev) => {
      const next = prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name];
      if (!next.includes(primaryName)) setPrimaryName(next[0] || '');
      return next;
    });
  };

  const runNormalize = async () => {
    setIsNormalizing(true);
    setBanner(null);
    try {
      const result = await onNormalize();
      if (result) {
        setBanner(
          result.renamed?.length
            ? `Normalized ${result.renamed.length} name variant(s). ${result.vendorsNow} distinct supplier(s) remain.`
            : 'All supplier names already conform to the canonical format.'
        );
        setBannerKind('ok');
        onRefresh();
        setSelection([]);
      } else {
        setBanner('Could not normalize supplier names.');
        setBannerKind('err');
      }
    } finally {
      setIsNormalizing(false);
    }
  };

  const runMerge = async () => {
    if (!canMerge || !onMerge) return;
    setIsMerging(true);
    setBanner(null);
    try {
      const result = await onMerge(
        mergeTargetId,
        selected.filter((v) => v.name !== mergeTargetId).map((v) => v.name)
      );
      if (result) {
        setBanner(
          `Merged ${selected.length} supplier names into "${mergeTarget?.name}". ` +
            `${result.invoicesUpdated} invoice(s), ${result.productsUpdated} product(s), ` +
            `${result.aliasesUpdated} alias(es) re-pointed.`
        );
        setBannerKind('ok');
        onRefresh();
        setSelection([]);
        setPrimaryName('');
      }
    } finally {
      setIsMerging(false);
    }
  };

  const mergeGroup = async (list: VendorSummary[]) => {
    // Default the surviving name to the one with the most invoices (keeps real data).
    const primary = [...list].sort((a, b) => b.invoices - a.invoices)[0];
    const others = list.filter((v) => v.name !== primary.name).map((v) => v.name);
    setIsMerging(true);
    setBanner(null);
    try {
      const result = await onMerge(primary.name, others);
      if (result) {
        setBanner(`Merged ${list.length} duplicate spellings into "${primary.name}".`);
        setBannerKind('ok');
        onRefresh();
      }
    } finally {
      setIsMerging(false);
    }
  };

  const totalSpend = vendors.reduce((s, v) => s + v.spend, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-400" />
            <span>Supplier Management</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
              {vendors.length} Suppliers
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Normalize OCR-mangled names (e.g. <span className="font-mono text-slate-300">PTY. LTD.</span> →{' '}
            <span className="font-mono text-slate-300">Pty Ltd</span>) and merge duplicate suppliers
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runNormalize}
            disabled={isNormalizing}
            title="Rewrite every stored supplier name into the canonical format."
            className="px-3 py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
          >
            {isNormalizing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>Normalize All Names</span>
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <span className="text-slate-400 block text-[11px] font-mono uppercase tracking-wider">Distinct Suppliers</span>
          <div className="mt-1 text-2xl font-bold font-mono text-white tabular-nums">{vendors.length}</div>
        </div>
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <span className="text-slate-400 block text-[11px] font-mono uppercase tracking-wider">Total Supplier Spend</span>
          <div className="mt-1 text-2xl font-bold font-mono text-emerald-400 tabular-nums">{fmtMoney(totalSpend)}</div>
        </div>
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <span className="text-slate-400 block text-[11px] font-mono uppercase tracking-wider">Likely Duplicates</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-amber-400 tabular-nums">{dupGroups.length}</span>
            <span className="text-xs text-slate-400 font-mono">group(s)</span>
          </div>
        </div>
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <span className="text-slate-400 block text-[11px] font-mono uppercase tracking-wider">Catalog Aliases</span>
          <div className="mt-1 text-2xl font-bold font-mono text-blue-400 tabular-nums">
            {vendors.reduce((s, v) => s + v.aliases, 0)}
          </div>
        </div>
      </div>

      {banner && (
        <div
          className={`px-3 py-2 rounded-lg border text-xs ${
            bannerKind === 'ok'
              ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-300'
              : bannerKind === 'warn'
              ? 'border-amber-800/40 bg-amber-950/20 text-amber-300'
              : 'border-rose-800/40 bg-rose-950/20 text-rose-300'
          }`}
        >
          {banner}
        </div>
      )}

      {/* Duplicate suggestions */}
      {dupGroups.length > 0 && (
        <div className="border border-amber-800/40 rounded-xl bg-amber-950/10 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-amber-200">
              Likely Duplicate Suppliers ({dupGroups.length})
            </h3>
            <span className="text-xs text-slate-400">
              Same entity read multiple ways by OCR. Merge to consolidate spend &amp; history.
            </span>
          </div>

          {dupGroups.map(({ key, list }) => {
            const allNames = list.map((v) => v.name);
            const alreadySame = new Set(list.map((v) => v.normalized)).size === 1;
            return (
              <div
                key={key}
                className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {list.map((v) => (
                    <span
                      key={v.name}
                      className="px-2 py-1 rounded bg-slate-900 text-slate-200 border border-slate-800 font-mono flex items-center gap-1.5"
                    >
                      {v.name}
                      <span className="text-slate-500">
                        ({v.invoices} inv · {fmtMoney(v.spend)})
                      </span>
                    </span>
                  ))}
                  {alreadySame ? (
                    <span className="text-[11px] text-emerald-300 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> normalized to same name - merge to finish
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-300 flex items-center gap-1">
                      <ArrowRight className="w-3 h-3" /> {list[0].normalized}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => mergeGroup(list)}
                  disabled={isMerging}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors flex items-center gap-1.5 shrink-0"
                >
                  <Combine className="w-3.5 h-3.5" />
                  <span>Merge {list.length} as one</span>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Merge bar - appears once 2+ suppliers are ticked */}
      {selection.length > 0 && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-xl border border-blue-800/40 bg-blue-950/20">
          <div className="flex items-center gap-2 text-xs">
            <Combine className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="text-slate-200">
              <strong className="text-blue-300">{selection.length}</strong> selected
            </span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-400">
              {canMerge ? 'Choose which name survives, then merge.' : 'Tick at least 2 suppliers to merge.'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={mergeTargetId}
              onChange={(e) => setPrimaryName(e.target.value)}
              disabled={!canMerge}
              className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/60 max-w-[260px]"
            >
              {selected.map((v) => (
                <option key={v.name} value={v.name} className="bg-slate-900 text-slate-200">
                  Keep: {v.name}
                </option>
              ))}
            </select>

            <button
              onClick={runMerge}
              disabled={!canMerge || isMerging}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed rounded-lg shadow-sm transition-colors inline-flex items-center gap-1.5"
            >
              <Combine className="w-3.5 h-3.5" />
              <span>{isMerging ? 'Merging...' : `Merge into "${mergeTarget?.name || '...'}"`}</span>
            </button>

            <button
              onClick={() => {
                setSelection([]);
                setPrimaryName('');
                setBanner(null);
              }}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 rounded-lg transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Supplier list */}
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search supplier or normalized name..."
            className="bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/60 w-72"
          />
        </div>
        <span className="text-xs text-slate-500">
          {filtered.length} of {vendors.length}
        </span>
      </div>

      <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40 divide-y divide-slate-850">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-xs">No suppliers found.</div>
        ) : (
          filtered.map((v) => {
            const isDirty = v.normalized !== v.name;
            const inDupGroup = dupGroups.some((g) => g.list.some((x) => x.name === v.name));
            return (
              <div
                key={v.name}
                onClick={() => toggle(v.name)}
                className={`p-4 hover:bg-slate-900/30 transition-colors cursor-pointer ${
                  selection.includes(v.name) ? 'bg-blue-950/20' : ''
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selection.includes(v.name)}
                        onChange={() => toggle(v.name)}
                        onClick={(e) => e.stopPropagation()}
                        title="Select to merge"
                        className="w-3.5 h-3.5 accent-blue-500 cursor-pointer shrink-0"
                      />
                      <Building2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="text-sm font-semibold text-slate-100 font-mono">{v.name}</span>
                      {inDupGroup && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300 border border-amber-800/40">
                          duplicate?
                        </span>
                      )}
                      {isDirty && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800 inline-flex items-center gap-1">
                          → {v.normalized}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 pl-6">
                      match key: <span className="text-slate-400">{v.key || '—'}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-5 font-mono text-xs shrink-0">
                    <div>
                      <span className="text-slate-500 block text-[10px] uppercase">Invoices</span>
                      <span className="text-slate-200">{v.invoices}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px] uppercase">Spend</span>
                      <span className="text-emerald-400 font-semibold tabular-nums">{fmtMoney(v.spend)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px] uppercase">Products</span>
                      <span className="text-slate-200">{v.products}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px] uppercase">Aliases</span>
                      <span className="text-blue-300">{v.aliases}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px] uppercase">Alerts</span>
                      <span className={v.alerts > 0 ? 'text-rose-400' : 'text-slate-400'}>{v.alerts}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
