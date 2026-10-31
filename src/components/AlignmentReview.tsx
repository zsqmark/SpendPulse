import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../lib/apiBase.ts';
import {
  AlignmentConflict,
  AlignmentLogEntry,
  FieldAlignment,
  LineAlignment,
} from '../types/index.ts';
import {
  FIELD_LABEL,
  IDENTITY_LABEL,
  SOURCE_LABEL,
  describeFieldAlignment,
} from '../lib/alignmentLabels.ts';
import { InvoiceJumpLink, type InvoiceJumpRequest } from './InvoiceJumpLink.tsx';
import { AlertTriangle, Check, History, Loader2, RefreshCw, ShieldQuestion, X } from 'lucide-react';

/** One row of the review queue, as the API returns it. */
interface ReviewEntry {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  vendorName: string;
  itemId: string;
  itemDescription: string;
  productId?: string | null;
  productName?: string | null;
  identityKey: string;
  identityKind: LineAlignment['identityKind'];
  isFirstEntry: boolean;
  changes: FieldAlignment[];
  conflicts: AlignmentConflict[];
  createdAt: string;
}

export interface AlignmentReviewProps {
  /** Called after a conflict is settled, so the invoice list behind it reloads. */
  onResolved?: () => void;
  /** Opens the invoice line an alignment entry came from. */
  onJumpToInvoice?: (target: InvoiceJumpRequest) => void;
}

export const AlignmentReview: React.FC<AlignmentReviewProps> = ({ onResolved, onJumpToInvoice }) => {
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [log, setLog] = useState<AlignmentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reviewRes, logRes] = await Promise.all([
        fetch(apiUrl('/api/alignment/review')),
        fetch(apiUrl('/api/alignment/log?limit=100')),
      ]);
      if (!reviewRes.ok || !logRes.ok) throw new Error('Could not load the alignment queue.');
      const reviewJson = await reviewRes.json();
      const logJson = await logRes.json();
      setEntries(reviewJson.entries || []);
      setLog(logJson.entries || []);
    } catch (err: any) {
      setError(err.message || 'Could not load the alignment queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const resolve = async (entry: ReviewEntry, resolution: 'accepted_history' | 'kept_document') => {
    setBusyId(entry.id);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/alignment/${entry.id}/resolve`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not settle this alignment.');
      setMessage(
        resolution === 'accepted_history'
          ? `Applied the historical value to "${entry.itemDescription}".`
          : `Left "${entry.itemDescription}" exactly as it was printed.`
      );
      await load();
      onResolved?.();
    } catch (err: any) {
      setError(err.message || 'Could not settle this alignment.');
    } finally {
      setBusyId(null);
    }
  };

  const openCount = entries.length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <History className="w-4 h-4 text-blue-400" />
            Historical Alignment
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Every line of a new invoice is brought onto the values history holds for that
            product. Most settle themselves. These are the ones that cannot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLog((v) => !v)}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors flex items-center gap-1.5"
          >
            {showLog ? 'Hide' : 'Show'} audit log ({log.length})
          </button>
          <button
            onClick={load}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {message && (
        <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
          {message}
        </div>
      )}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-slate-500 text-xs font-mono flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading alignment queue...
        </div>
      ) : openCount === 0 ? (
        <div className="p-12 text-center border border-slate-800 rounded-xl bg-slate-900/40">
          <ShieldQuestion className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-sm text-slate-300">Nothing is waiting on you.</p>
          <p className="text-xs text-slate-500 mt-1">
            Every imported line agreed with history, or could be converted into it.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-400 font-mono">
            {openCount} line{openCount === 1 ? '' : 's'} need a decision
          </p>
          {entries.map((entry) => (
            <ConflictCard
              key={entry.id}
              entry={entry}
              busy={busyId === entry.id}
              onResolve={resolve}
              onJumpToInvoice={onJumpToInvoice}
            />
          ))}
        </div>
      )}

      {showLog && (
        <div className="border border-slate-800 rounded-xl bg-slate-900/40 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-800 text-xs font-mono uppercase tracking-wider text-slate-400">
            Audit log — newest first
          </div>
          {log.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">
              No line has needed aligning yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-800/60 max-h-[28rem] overflow-y-auto">
              {log.map((e) => (
                <LogRow key={e.id} entry={e} onJumpToInvoice={onJumpToInvoice} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ConflictCard: React.FC<{
  entry: ReviewEntry;
  busy: boolean;
  onResolve: (entry: ReviewEntry, resolution: 'accepted_history' | 'kept_document') => void;
  onJumpToInvoice?: (target: InvoiceJumpRequest) => void;
}> = ({ entry, busy, onResolve, onJumpToInvoice }) => {
  return (
    <div className="border border-amber-500/30 bg-amber-500/[0.04] rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-white truncate">{entry.itemDescription}</div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">
            {entry.vendorName} ·{' '}
            <InvoiceJumpLink
              invoiceNumber={entry.invoiceNumber}
              invoiceId={entry.invoiceId}
              itemId={entry.itemId}
              masterProductId={entry.productId}
              onJump={onJumpToInvoice}
            />{' '}
            · {IDENTITY_LABEL[entry.identityKind]}
            {entry.isFirstEntry && ' · first sighting'}
          </div>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 whitespace-nowrap">
          {entry.conflicts.length} conflict{entry.conflicts.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {entry.conflicts.map((c, i) => (
          <div key={`${c.field}-${i}`} className="rounded-lg bg-slate-950/50 border border-slate-800 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              {FIELD_LABEL[c.field]}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded bg-slate-900/70 border border-slate-800 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Printed</div>
                <div className="font-mono text-slate-200 mt-0.5 break-words">
                  {c.documentValue ?? '—'}
                </div>
              </div>
              <div className="rounded bg-blue-500/[0.07] border border-blue-500/20 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">History</div>
                <div className="font-mono text-blue-200 mt-0.5 break-words">
                  {c.historyValue ?? '—'}
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">{c.reason}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          disabled={busy}
          onClick={() => onResolve(entry, 'accepted_history')}
          className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-1.5"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Use the historical value
        </button>
        <button
          disabled={busy}
          onClick={() => onResolve(entry, 'kept_document')}
          className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-1.5"
        >
          <X className="w-3.5 h-3.5" />
          Keep what was printed
        </button>
      </div>
    </div>
  );
};

const LogRow: React.FC<{
  entry: AlignmentLogEntry;
  onJumpToInvoice?: (target: InvoiceJumpRequest) => void;
}> = ({ entry, onJumpToInvoice }) => {
  const { resolved, summary } = useMemo(() => {
    const parts = entry.changes.map((f) => describeFieldAlignment(f).summary);
    return {
      resolved: entry.resolvedAt
        ? entry.resolution === 'accepted_history'
          ? 'settled: historical value applied'
          : 'settled: printed value kept'
        : null,
      summary: parts.join(' · ') || 'no change',
    };
  }, [entry]);

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-slate-200 truncate">{entry.itemDescription}</div>
          <div className="text-[11px] text-slate-500 font-mono">
            {entry.vendorName} ·{' '}
            <InvoiceJumpLink
              invoiceNumber={entry.invoiceNumber}
              invoiceId={entry.invoiceId}
              itemId={entry.itemId}
              masterProductId={entry.productId}
              onJump={onJumpToInvoice}
            />
          </div>
        </div>
        <div className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
          {new Date(entry.createdAt).toLocaleString()}
        </div>
      </div>
      <div className="mt-1 text-[11px] text-slate-400">{summary}</div>
      {entry.changes.map((f, i) => (
        <div key={`${f.field}-${i}`} className="mt-1 text-[11px]">
          <span className="font-mono text-slate-500">{FIELD_LABEL[f.field]}:</span>{' '}
          <span className="text-slate-400">{describeFieldAlignment(f).detail}</span>
          <span className="ml-1 text-[10px] text-slate-600">({SOURCE_LABEL[f.source]})</span>
        </div>
      ))}
      {!entry.validated && (
        <div className="mt-1 text-[11px] text-rose-300">
          Rejected before it reached the database: {entry.validationErrors.join(' ')}
        </div>
      )}
      {resolved && <div className="mt-1 text-[11px] text-emerald-400">{resolved}</div>}
    </div>
  );
};
