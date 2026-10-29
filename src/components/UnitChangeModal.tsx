import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Check,
  AlertTriangle,
  Search,
  Loader2,
  History,
  Undo2,
  Lock,
  ArrowRight,
  Ruler,
} from 'lucide-react';
import {
  MasterProduct,
  ProductUnitInvoice,
  UnitChangePreview,
  UnitChangeRecord,
  UnitChangeScope,
} from '../types/index.ts';
import { UNIT_OPTIONS } from '../lib/units.ts';

/**
 * Relabels how a product is counted on its invoice lines.
 *
 * The unit column is the single input OCR gets wrong most often, and it is the input every
 * price comparison divides by - so this is powerful enough to need guardrails:
 *
 *   - nothing happens until the user states a SCOPE (all invoices / only the ones ticked);
 *     there is no default, because a silent whole-history relabel is not recoverable by eye
 *   - every invoice is listed with the unit it currently carries, so the change can be
 *     read before it is made
 *   - invoices that cannot be touched are disabled and say why
 *   - a second confirmation spells out product, old unit, new unit and reach
 *   - every change is recorded server-side and can be reverted from this same dialog
 */

interface UnitChangeModalProps {
  product: MasterProduct;
  unitApi: UnitChangeApi;
  onClose: () => void;
  /** The catalogue is re-read after a change, since prices move with the unit. */
  onApplied: () => Promise<void>;
}

/** Every invoice of one product, with the units they carry and whether they may be edited. */
export interface UnitChangeContext {
  product: MasterProduct;
  unitOptions: { value: string; label: string; level: string }[];
  invoices: ProductUnitInvoice[];
}

/** Everything the unit editor needs from the server, in one prop. */
export interface UnitChangeApi {
  fetchContext: (productId: string) => Promise<UnitChangeContext | null>;
  fetchHistory: (productId: string) => Promise<UnitChangeRecord[]>;
  preview: (payload: UnitChangePayload) => Promise<UnitChangePreview | null>;
  apply: (payload: UnitChangePayload) => Promise<ApplyUnitChangeOutcome>;
  revert: (recordId: string) => Promise<RevertUnitChangeOutcome>;
}

export interface UnitChangePayload {
  productId: string;
  newUnit: string;
  scope: UnitChangeScope;
  invoiceIds: string[];
}

export interface ApplyUnitChangeOutcome {
  error: string | null;
  changedLines?: number;
  affectedInvoices?: number;
  skipped?: { invoiceNumber: string; reason: string }[];
}

export interface RevertUnitChangeOutcome {
  error: string | null;
  restoredLines?: number;
}

type Tab = 'change' | 'history';

const LEVEL_LABEL: Record<string, string> = {
  pack: 'Packs & containers',
  weight: 'Weight',
  volume: 'Volume',
  each: 'Count',
};

function todayStamp(iso?: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

export const UnitChangeModal: React.FC<UnitChangeModalProps> = ({
  product,
  unitApi,
  onClose,
  onApplied,
}) => {
  const [tab, setTab] = useState<Tab>('change');
  const [context, setContext] = useState<UnitChangeContext | null>(null);
  const [history, setHistory] = useState<UnitChangeRecord[]>([]);
  const [contextError, setContextError] = useState<string | null>(null);
  const [newUnit, setNewUnit] = useState('');
  const [scope, setScope] = useState<UnitChangeScope | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [unitFilter, setUnitFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const [preview, setPreview] = useState<UnitChangePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertResult, setRevertResult] = useState<{ ok: boolean; text: string } | null>(null);

  const rows = context?.invoices ?? [];

  const reload = async () => {
    const [ctx, hist] = await Promise.all([
      unitApi.fetchContext(product.id),
      unitApi.fetchHistory(product.id),
    ]);
    setContext(ctx);
    setHistory(hist);
    setContextError(ctx ? null : 'Could not load this product’s invoices.');
  };

  useEffect(() => {
    void reload();
    // The server is the source of truth; reload when a different product is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  // Every unit this product currently appears under - used to filter the invoice list.
  const availableUnits = useMemo(
    () => Array.from(new Set(rows.flatMap((r) => r.units))).sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (unitFilter !== 'all' && !r.units.includes(unitFilter)) return false;
      if (statusFilter === 'blocked' && !r.blocked) return false;
      if (statusFilter === 'open' && !r.hasOpenAlert) return false;
      if (statusFilter === 'locked' && !r.locked) return false;
      if (!q) return true;
      return (
        r.invoiceNumber.toLowerCase().includes(q) ||
        r.vendorName.toLowerCase().includes(q) ||
        r.lines.some((l) => l.rawDescription.toLowerCase().includes(q))
      );
    });
  }, [rows, search, unitFilter, statusFilter]);

  const selectedRows = rows.filter((r) => selected.includes(r.invoiceId) && !r.blocked);

  const canPreview =
    Boolean(newUnit) && scope !== null && (scope === 'all' || selectedRows.length > 0);

  // The preview is re-derived on every change of mind, so what the user confirms is always
  // what the server would do - never a stale count from an earlier selection.
  useEffect(() => {
    if (!canPreview || tab !== 'change') {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setIsPreviewing(true);
    const timer = setTimeout(async () => {
      const next = await unitApi.preview({
        productId: product.id,
        newUnit,
        scope: scope as UnitChangeScope,
        invoiceIds: selectedRows.map((r) => r.invoiceId),
      });
      if (cancelled) return;
      if (next) {
        setPreview(next);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError('Could not build a preview for this selection.');
      }
      setIsPreviewing(false);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setIsPreviewing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newUnit, scope, selected.join(','), tab, canPreview]);

  const toggleRow = (row: ProductUnitInvoice) => {
    if (row.blocked) return;
    setResult(null);
    setSelected((prev) =>
      prev.includes(row.invoiceId)
        ? prev.filter((id) => id !== row.invoiceId)
        : [...prev, row.invoiceId]
    );
  };

  const selectAllVisible = () => {
    const addable = filtered.filter((r) => !r.blocked).map((r) => r.invoiceId);
    setSelected((prev) => Array.from(new Set([...prev, ...addable])));
  };

  const clearSelection = () => setSelected([]);

  const runApply = async () => {
    if (!canPreview || !preview) return;
    setIsApplying(true);
    try {
      const outcome = await unitApi.apply({
        productId: product.id,
        newUnit,
        scope: scope as UnitChangeScope,
        invoiceIds: selectedRows.map((r) => r.invoiceId),
      });
      if (outcome.error) {
        setResult({ ok: false, text: outcome.error });
      } else {
        const skippedNote = outcome.skipped?.length
          ? ` ${outcome.skipped.length} invoice(s) were skipped as uneditable.`
          : '';
        setResult({
          ok: true,
          text: `Updated ${outcome.changedLines} line(s) across ${outcome.affectedInvoices} invoice(s) to "${unitLabel(newUnit)}".${skippedNote}`,
        });
        setConfirming(false);
        setSelected([]);
        setScope(null);
        setNewUnit('');
        setPreview(null);
        // Catalogue prices move with the unit, so the parent re-reads everything.
        await onApplied();
        await reload();
        setTab('history');
      }
    } finally {
      setIsApplying(false);
    }
  };

  const runRevert = async (recordId: string) => {
    setRevertingId(recordId);
    setRevertResult(null);
    try {
      const outcome = await unitApi.revert(recordId);
      setRevertResult(
        outcome.error
          ? { ok: false, text: outcome.error }
          : {
              ok: true,
              text: `Reverted ${outcome.restoredLines} line(s). Prices have been re-derived from the restored units.`,
            }
      );
      await reload();
      await onApplied();
    } finally {
      setRevertingId(null);
    }
  };

  const unitLabel = (value: string) =>
    UNIT_OPTIONS.find((o) => o.value === value)?.label ?? value;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof UNIT_OPTIONS>();
    for (const option of UNIT_OPTIONS) {
      const list = map.get(option.level) ?? [];
      list.push(option);
      map.set(option.level, list);
    }
    return Array.from(map.entries());
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-4xl w-full shadow-xl my-8">
        {/* ---------- header ---------- */}
        <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Ruler className="w-4 h-4 text-cyan-400" />
              Change unit of measure
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              {product.name}
              <span className="text-slate-600"> · pack {product.standardPackSize || '—'} · current standard unit{' '}
                <span className="text-slate-300">{product.standardUnit || '—'}</span>
              </span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-white rounded hover:bg-slate-800 transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ---------- tabs ---------- */}
        <div className="flex items-center gap-1 px-5 pt-4">
          {(['change', 'history'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                tab === t
                  ? 'bg-cyan-950/50 text-cyan-300 border-cyan-800/50'
                  : 'text-slate-400 hover:text-slate-200 border-slate-800'
              }`}
            >
              {t === 'change' ? 'New change' : `History (${history.length})`}
            </button>
          ))}
        </div>

        {!context ? (
          <div className="p-10 text-center text-xs text-slate-500">
            {contextError ?? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading this product’s invoices…
              </span>
            )}
          </div>
        ) : tab === 'change' ? (
          <div className="p-5 space-y-5">
            {/* ---------- 1. the new unit ---------- */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 text-[10px] font-bold flex items-center justify-center">
                  1
                </span>
                <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
                  Pick the new unit
                </h4>
              </div>
              <select
                value={newUnit}
                onChange={(e) => {
                  setNewUnit(e.target.value);
                  setResult(null);
                }}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-700"
              >
                <option value="">— choose a unit —</option>
                {grouped.map(([level, options]) => (
                  <optgroup key={level} label={LEVEL_LABEL[level] ?? level}>
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-[11px] text-slate-500">
                Only units this system already knows can be used, so the pack maths and every
                later comparison stay valid.
              </p>
            </section>

            {/* ---------- 2. the scope ---------- */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 text-[10px] font-bold flex items-center justify-center">
                  2
                </span>
                <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
                  How far should it apply?
                </h4>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {(
                  [
                    {
                      key: 'all' as UnitChangeScope,
                      title: 'Every invoice for this product',
                      body: `All ${rows.length} invoice(s) that carry this product. Use when OCR has been reading the unit wrong all along.`,
                    },
                    {
                      key: 'selected' as UnitChangeScope,
                      title: 'Only the invoices I tick',
                      body: 'Pick the invoices below. Nothing outside your selection is touched.',
                    },
                  ]
                ).map((choice) => (
                  <button
                    key={choice.key}
                    onClick={() => {
                      setScope(choice.key);
                      setResult(null);
                    }}
                    className={`text-left p-3 rounded-lg border transition-colors ${
                      scope === choice.key
                        ? 'border-cyan-700 bg-cyan-950/30'
                        : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-3 h-3 rounded-full border flex items-center justify-center ${
                          scope === choice.key ? 'border-cyan-400 bg-cyan-400/30' : 'border-slate-600'
                        }`}
                      >
                        {scope === choice.key ? <span className="w-1.5 h-1.5 rounded-full bg-cyan-300" /> : null}
                      </span>
                      <span className="text-xs font-semibold text-slate-200">{choice.title}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">{choice.body}</p>
                  </button>
                ))}
              </div>
              {scope === null ? (
                <p className="text-[11px] text-amber-300/90 inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  There is no default — you must choose one before anything can be applied.
                </p>
              ) : null}
            </section>

            {/* ---------- 3. the invoices ---------- */}
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 text-[10px] font-bold flex items-center justify-center">
                    3
                  </span>
                  <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
                    Invoices carrying this product
                  </h4>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAllVisible}
                    className="px-2 py-1 text-[11px] text-slate-300 hover:text-white border border-slate-800 rounded hover:bg-slate-800 transition-colors"
                  >
                    Select shown
                  </button>
                  <button
                    onClick={clearSelection}
                    className="px-2 py-1 text-[11px] text-slate-400 hover:text-white border border-slate-800 rounded hover:bg-slate-800 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-2">
                <div className="relative sm:col-span-1">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-600" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search no. / vendor / line"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-2 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-700"
                  />
                </div>
                <select
                  value={unitFilter}
                  onChange={(e) => setUnitFilter(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-700"
                >
                  <option value="all">All current units</option>
                  {availableUnits.map((u) => (
                    <option key={u} value={u}>
                      {u || '(none)'}
                    </option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-700"
                >
                  <option value="all">Any state</option>
                  <option value="open">Has an open alert</option>
                  <option value="locked">Locked</option>
                  <option value="blocked">Cannot be edited</option>
                </select>
              </div>

              <div className="border border-slate-800 rounded-lg overflow-hidden max-h-72 overflow-y-auto divide-y divide-slate-850">
                {filtered.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-500">
                    No invoices match this filter.
                  </div>
                ) : (
                  filtered.map((row) => {
                    const checked = selected.includes(row.invoiceId);
                    return (
                      <label
                        key={row.invoiceId}
                        title={row.blocked ? (row.blockMessage ?? 'Cannot be edited') : undefined}
                        className={`flex items-start gap-3 px-3 py-2.5 ${
                          row.blocked
                            ? 'opacity-60 cursor-not-allowed bg-slate-950/60'
                            : 'cursor-pointer hover:bg-slate-900/40'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={row.blocked}
                          onChange={() => toggleRow(row)}
                          className="mt-1 accent-cyan-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono text-slate-200">
                              {row.invoiceNumber}
                            </span>
                            <span className="text-[10px] text-slate-500">{row.invoiceDate}</span>
                            <span className="text-[10px] text-slate-500 truncate">
                              {row.vendorName}
                            </span>
                            {row.lineCount > 1 ? (
                              <span className="text-[10px] text-slate-500">
                                {row.lineCount} lines
                              </span>
                            ) : null}
                            {row.hasOpenAlert ? (
                              <span className="px-1.5 py-0.5 rounded bg-rose-950/40 text-rose-300 border border-rose-800/40 text-[10px]">
                                open alert
                              </span>
                            ) : null}
                            {row.blocked ? (
                              <span className="px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-700 text-[10px] inline-flex items-center gap-1">
                                <Lock className="w-2.5 h-2.5" />
                                cannot edit
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                            <span className="text-slate-500">now:</span>
                            <span className="font-mono text-amber-300">{row.unitSummary}</span>
                            {!row.blocked && newUnit && !row.units.includes(newUnit) ? (
                              <>
                                <ArrowRight className="w-3 h-3 text-slate-600" />
                                <span className="font-mono text-emerald-300">
                                  {unitLabel(newUnit)}
                                </span>
                              </>
                            ) : null}
                          </div>
                          {row.blocked && row.blockMessage ? (
                            <p className="mt-1 text-[10px] text-amber-300/90 leading-snug">
                              {row.blockMessage}
                            </p>
                          ) : null}
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                {selectedRows.length} of {rows.length} invoice(s) selected
                {rows.some((r) => r.blocked)
                  ? ` · ${rows.filter((r) => r.blocked).length} cannot be edited`
                  : ''}
              </p>
            </section>

            {/* ---------- 4. the impact preview ---------- */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 text-[10px] font-bold flex items-center justify-center">
                  4
                </span>
                <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
                  Impact preview
                </h4>
                {isPreviewing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />
                ) : null}
              </div>

              {!canPreview ? (
                <p className="text-[11px] text-slate-500 p-3 rounded-lg border border-slate-800 bg-slate-950/40">
                  Choose a unit and a scope{scope === 'selected' ? ', and tick at least one invoice' : ''} to see exactly what would change.
                </p>
              ) : previewError ? (
                <p className="text-[11px] text-rose-300 p-3 rounded-lg border border-rose-900/50 bg-rose-950/20">
                  {previewError}
                </p>
              ) : preview ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="Invoices" value={String(preview.invoiceCount)} />
                    <Stat label="Lines" value={String(preview.lineCount)} />
                    <Stat
                      label="Unit change"
                      value={`${preview.fromUnits.length > 1 ? preview.fromUnits.join('/') : (preview.fromUnits[0] ?? '—')} → ${newUnit}`}
                      accent
                    />
                  </div>

                  <div className="max-h-40 overflow-y-auto border border-slate-800 rounded-lg divide-y divide-slate-850">
                    {preview.perInvoice.map((r) => (
                      <div key={r.invoiceId} className="px-3 py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs font-mono text-slate-200">
                            {r.invoiceNumber}
                            <span className="text-slate-500 font-sans"> · {r.invoiceDate}</span>
                          </div>
                          <div className="text-[10px] text-slate-500 truncate">{r.vendorName}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-[10px] font-mono">
                            <span className="text-amber-300">{r.fromUnits.join(', ') || '—'}</span>
                            <ArrowRight className="w-2.5 h-2.5 inline mx-1 text-slate-600" />
                            <span className="text-emerald-300">{newUnit}</span>
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {r.lineCount} line{r.lineCount === 1 ? '' : 's'}
                            {r.unitPrice != null ? ` · $${r.unitPrice.toFixed(2)}` : ''}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {preview.skippedInvoices.length > 0 ? (
                    <div className="p-2.5 rounded-lg border border-amber-900/50 bg-amber-950/20 text-[11px] text-amber-200">
                      <div className="font-semibold mb-1">
                        {preview.skippedInvoices.length} invoice(s) will be skipped
                      </div>
                      {preview.skippedInvoices.map((s) => (
                        <div key={s.invoiceId}>
                          <span className="font-mono">{s.invoiceNumber}</span> — {s.reason}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {preview.warnings.length > 0 ? (
                    <ul className="p-2.5 rounded-lg border border-slate-800 bg-slate-950/40 space-y-1">
                      {preview.warnings.map((w, i) => (
                        <li key={i} className="text-[11px] text-slate-400 flex gap-1.5">
                          <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <button
                    onClick={() => setConfirming(true)}
                    disabled={preview.invoiceCount === 0}
                    className="w-full px-4 py-2.5 rounded-lg text-sm font-semibold bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                  >
                    Review & confirm change
                  </button>
                </div>
              ) : null}
            </section>

            {result ? (
              <div
                className={`p-3 rounded-lg text-xs flex items-start gap-2 ${
                  result.ok
                    ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/40'
                    : 'bg-rose-950/40 text-rose-300 border border-rose-800/40'
                }`}
              >
                {result.ok ? <Check className="w-3.5 h-3.5 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />}
                <span>{result.text}</span>
              </div>
            ) : null}
          </div>
        ) : (
          /* ---------- history / audit tab ---------- */
          <div className="p-5 space-y-3">
            <p className="text-[11px] text-slate-500">
              Every unit change made to this product, newest first. Reverting restores each line
              to the unit it carried before that change — prices are then re-derived, nothing is
              invented.
            </p>
            {revertResult ? (
              <div
                className={`p-3 rounded-lg text-xs ${
                  revertResult.ok
                    ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/40'
                    : 'bg-rose-950/40 text-rose-300 border border-rose-800/40'
                }`}
              >
                {revertResult.text}
              </div>
            ) : null}
            {history.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500 border border-slate-800 rounded-lg">
                No unit changes recorded for this product yet.
              </div>
            ) : (
              <div className="space-y-2">
                {history.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-3 rounded-lg border border-slate-800 bg-slate-950/40 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            rec.kind === 'revert'
                              ? 'bg-slate-900 text-slate-300 border-slate-700'
                              : 'bg-cyan-950/50 text-cyan-300 border-cyan-800/50'
                          }`}
                        >
                          {rec.kind === 'revert' ? 'revert' : 'change'}
                        </span>
                        <span className="text-xs font-mono text-slate-200">
                          {rec.fromUnit ?? '—'} → {rec.newUnit}
                        </span>
                        <span className="text-[10px] text-slate-500">
                          {rec.scope === 'all' ? 'all invoices' : `${rec.invoiceNumbers.length} selected`}
                          {' · '}
                          {rec.lineCount} line(s)
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-500">{todayStamp(rec.changedAt)}</span>
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {rec.invoiceNumbers.map((n, i) => (
                        <span
                          key={`${rec.id}-${i}`}
                          className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400"
                        >
                          {n}
                        </span>
                      ))}
                    </div>

                    {rec.revertedAt ? (
                      <div className="text-[10px] text-slate-500">
                        Reverted {todayStamp(rec.revertedAt)}
                      </div>
                    ) : rec.kind === 'change' ? (
                      <button
                        onClick={() => runRevert(rec.id)}
                        disabled={revertingId === rec.id}
                        className="px-2.5 py-1 text-[11px] text-slate-300 hover:text-white border border-slate-800 rounded hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                      >
                        {revertingId === rec.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Undo2 className="w-3 h-3" />
                        )}
                        Revert this change
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => void reload()}
              className="px-2.5 py-1 text-[11px] text-slate-400 hover:text-white border border-slate-800 rounded hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors"
            >
              <History className="w-3 h-3" />
              Refresh
            </button>
          </div>
        )}
      </div>

      {/* ---------- the second confirmation ---------- */}
      {confirming && preview ? (
        <div className="fixed inset-0 z-60 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <h4 className="text-sm font-semibold text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              Confirm unit change
            </h4>
            <dl className="space-y-2 text-xs">
              <Row label="Product" value={product.name} />
              <Row
                label="Unit"
                value={`${preview.fromUnits.length > 1 ? preview.fromUnits.join(' / ') : (preview.fromUnits[0] ?? '—')}  →  ${preview.newUnitLabel}`}
                accent
              />
              <Row
                label="Scope"
                value={
                  preview.scope === 'all'
                    ? `Every invoice carrying this product (${preview.invoiceCount})`
                    : `${preview.invoiceCount} selected invoice(s)`
                }
              />
              <Row label="Lines affected" value={String(preview.lineCount)} />
              <Row
                label="Invoices"
                value={preview.perInvoice.map((r) => r.invoiceNumber).join(', ') || '—'}
              />
            </dl>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              The new unit is written onto those lines only. Other products are untouched, and
              nothing else about this product changes — though its current, previous, min and max
              price are derived from its lines, so they are re-derived afterwards. The change is
              recorded and can be reverted from the History tab.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="px-3 py-2 text-xs text-slate-300 hover:text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={runApply}
                disabled={isApplying}
                className="px-4 py-2 text-xs font-semibold text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
              >
                {isApplying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Apply change
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="p-2.5 rounded-lg border border-slate-800 bg-slate-950/40">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className={`text-xs font-mono mt-0.5 ${accent ? 'text-cyan-300' : 'text-slate-200'}`}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-slate-500">{label}</dt>
      <dd className={`flex-1 ${accent ? 'text-cyan-300 font-mono' : 'text-slate-200'}`}>{value}</dd>
    </div>
  );
}
