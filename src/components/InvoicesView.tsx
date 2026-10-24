import React, { useEffect, useState } from 'react';
import { Invoice, InvoiceItem } from '../types/index.ts';
import { apiUrl } from '../lib/apiBase.ts';
import {
  FileText,
  Search,
  Filter,
  Eye,
  CheckCircle2,
  AlertCircle,
  Scan,
  TrendingUp,
  ArrowUpRight,
  ExternalLink,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  ImageIcon,
  Pencil,
  Check,
  X,
  Info,
  Save,
} from 'lucide-react';
import {
  UNIT_OPTIONS,
  formatBasePrice,
  previewBasePrice,
  previewBaseUnit,
} from '../lib/units.ts';
import type { LineItemPatch, LineItemUpdateResult } from '../types/index.ts';

interface InvoicesViewProps {
  invoices: Invoice[];
  onOpenReviewModal?: (invoiceId: string, item: InvoiceItem) => void;
  onViewProductTrends?: (productId: string) => void;
  onOpenScan?: () => void;
  /** Saves a corrected line and re-runs the pack-aware price comparison. */
  onUpdateLineItem?: (
    invoiceId: string,
    itemId: string,
    patch: LineItemPatch
  ) => Promise<LineItemUpdateResult | null>;
}

export const InvoicesView: React.FC<InvoicesViewProps> = ({
  invoices,
  onOpenReviewModal,
  onViewProductTrends,
  onOpenScan,
  onUpdateLineItem,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [vendorFilter, setVendorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'needs_review' | 'processed'>('all');
  const [invoiceSortBy, setInvoiceSortBy] = useState<
    'date_desc' | 'date_asc' | 'total_desc' | 'total_asc' | 'vendor_asc' | 'items_desc'
  >('date_desc');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [detailTab, setDetailTab] = useState<'source' | 'items'>('items');
  const [activePage, setActivePage] = useState(1);
  const [zoomPct, setZoomPct] = useState(100);
  const [imageError, setImageError] = useState(false);

  // Line editor: OCR misreads pack sizes and units, and a wrong unit silently poisons
  // every later price comparison, so the user has to be able to correct the line itself.
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LineItemPatch>({});
  const [customUnit, setCustomUnit] = useState('');
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<{ itemId: string; ok: boolean; text: string } | null>(
    null
  );

  const startEditing = (item: InvoiceItem) => {
    setEditingItemId(item.id);
    setSaveNote(null);
    setDraft({
      rawDescription: item.rawDescription,
      supplierSku: item.supplierSku ?? '',
      packSize: item.packSize ?? '',
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
    });
    const known = UNIT_OPTIONS.some((o) => o.value.toLowerCase() === (item.unit || '').toLowerCase());
    setCustomUnit(known ? '' : item.unit || '');
  };

  const resolveUnit = () => (customUnit.trim() ? customUnit.trim() : draft.unit || '');

  const saveEditing = async (invoiceId: string, itemId: string) => {
    if (!onUpdateLineItem) return;
    setSavingItemId(itemId);
    try {
      const result = await onUpdateLineItem(invoiceId, itemId, {
        rawDescription: draft.rawDescription,
        supplierSku: draft.supplierSku ?? null,
        packSize: draft.packSize ?? null,
        unit: resolveUnit(),
        quantity: Number(draft.quantity),
        unitPrice: Number(draft.unitPrice),
        totalPrice: Number(draft.totalPrice),
      });
      setEditingItemId(null);
      const base = formatBasePrice(result?.baseUnitPrice, result?.baseUnit);
      if (result?.alertCreated) {
        setSaveNote({ itemId, ok: false, text: 'Saved - this line is a real price increase.' });
      } else if (result?.alertRemoved) {
        setSaveNote({ itemId, ok: true, text: 'Saved - the price increase it claimed was not real.' });
      } else if (base) {
        setSaveNote({ itemId, ok: true, text: `Saved - this line works out to ${base}.` });
      } else if (result && !result.comparable) {
        setSaveNote({ itemId, ok: true, text: 'Saved - pack size unknown, so this price is not compared.' });
      } else {
        setSaveNote({ itemId, ok: true, text: 'Saved.' });
      }
    } catch {
      setSaveNote({ itemId, ok: false, text: 'Could not save this line.' });
    } finally {
      setSavingItemId(null);
    }
  };

  // What the draft would work out to per base unit, before it is saved.
  const draftPreview = previewBasePrice(draft.packSize, resolveUnit(), Number(draft.unitPrice));
  const draftPreviewUnit = previewBaseUnit(draft.packSize);

  // Extract unique vendors
  const vendors = Array.from(new Set(invoices.map((inv) => inv.vendorName).filter(Boolean)));

  const filtered = invoices.filter((inv) => {
    const matchesSearch =
      inv.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inv.vendorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inv.fileName.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesVendor = vendorFilter === 'all' || inv.vendorName === vendorFilter;
    const matchesStatus = statusFilter === 'all' || inv.status === statusFilter;

    return matchesSearch && matchesVendor && matchesStatus;
  });

  const sortedInvoices = [...filtered].sort((a, b) => {
    if (invoiceSortBy === 'date_desc') return b.invoiceDate.localeCompare(a.invoiceDate);
    if (invoiceSortBy === 'date_asc') return a.invoiceDate.localeCompare(b.invoiceDate);
    if (invoiceSortBy === 'total_desc') return b.totalAmount - a.totalAmount;
    if (invoiceSortBy === 'total_asc') return a.totalAmount - b.totalAmount;
    if (invoiceSortBy === 'vendor_asc') return a.vendorName.localeCompare(b.vendorName);
    if (invoiceSortBy === 'items_desc') return b.items.length - a.items.length;
    return 0;
  });

  // Whatever is reloaded from the server (after an edit, a scan or an approval) must reach
  // the invoice already open in the inspector, or the user would be looking at stale numbers.
  useEffect(() => {
    const id = selectedInvoice?.id;
    if (!id) return;
    const fresh = invoices.find((inv) => inv.id === id);
    if (fresh && fresh !== selectedInvoice) setSelectedInvoice(fresh);
  }, [invoices]);

  const closeInspector = () => {
    setSelectedInvoice(null);
    setEditingItemId(null);
    setSaveNote(null);
  };

  /** Clicking any row opens the inspector on the original scan when we archived it. */
  const openInvoice = (inv: Invoice) => {
    setEditingItemId(null);
    setSaveNote(null);
    setSelectedInvoice(inv);
    setActivePage(1);
    setZoomPct(100);
    setImageError(false);
    setDetailTab(inv.documentPages && inv.documentPages.length > 0 ? 'source' : 'items');
  };

  const goToPage = (pageNumber: number) => {
    setActivePage(pageNumber);
    setImageError(false);
  };

  const selectedPages = selectedInvoice?.documentPages ?? [];
  // Page URLs are stored as server-relative paths, so they need the API host prefixed
  // when the frontend is served from a different origin than the backend.
  const rawPageUrl = selectedPages.find((p) => p.pageNumber === activePage)?.url ?? null;
  const activePageUrl = rawPageUrl ? apiUrl(rawPageUrl) : null;

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search invoice number, supplier, or filename..."
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/60"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Vendor Filter */}
          <select
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-blue-500/60"
          >
            <option value="all">All Suppliers ({vendors.length})</option>
            {vendors.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>

          {/* Status Filter */}
          <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                statusFilter === 'all' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setStatusFilter('needs_review')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                statusFilter === 'needs_review'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Needs Review
            </button>
            <button
              onClick={() => setStatusFilter('processed')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                statusFilter === 'processed' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Processed
            </button>
          </div>

          {/* Invoice Sort Control */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs">
            <ArrowUpDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="text-slate-500 font-mono text-[11px] hidden sm:inline">Sort:</span>
            <select
              value={invoiceSortBy}
              onChange={(e) => setInvoiceSortBy(e.target.value as any)}
              className="bg-transparent text-slate-200 text-xs focus:outline-none cursor-pointer font-mono"
            >
              <option value="date_desc" className="bg-slate-900 text-slate-200">Date: Newest First</option>
              <option value="date_asc" className="bg-slate-900 text-slate-200">Date: Oldest First</option>
              <option value="total_desc" className="bg-slate-900 text-slate-200">Total: High → Low</option>
              <option value="total_asc" className="bg-slate-900 text-slate-200">Total: Low → High</option>
              <option value="vendor_asc" className="bg-slate-900 text-slate-200">Supplier: A → Z</option>
              <option value="items_desc" className="bg-slate-900 text-slate-200">Items: Most First</option>
            </select>
          </div>

          {onOpenScan && (
            <button
              onClick={onOpenScan}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <Scan className="w-3.5 h-3.5" />
              <span>Scan / OCR Receipt</span>
            </button>
          )}
        </div>
      </div>

      {/* Invoice Table */}
      <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/80 border-b border-slate-800 text-slate-400 font-mono">
              <tr>
                <th className="py-2.5 px-4">Invoice / File</th>
                <th className="py-2.5 px-4">Supplier</th>
                <th className="py-2.5 px-4">Invoice Date</th>
                <th className="py-2.5 px-4">Type</th>
                <th className="py-2.5 px-4 text-center">Items</th>
                <th className="py-2.5 px-4 text-right">Total Amount</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850">
              {sortedInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    No invoices match your search query or filter.
                  </td>
                </tr>
              ) : (
                sortedInvoices.map((inv) => (
                  <tr
                    key={inv.id}
                    onClick={() => openInvoice(inv)}
                    className="hover:bg-slate-900/50 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                        <div>
                          <div className="font-mono font-semibold text-slate-200">
                            {inv.invoiceNumber}
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 truncate max-w-[240px]">
                            <span className="truncate">{inv.fileName}</span>
                            {inv.pageCount && inv.pageCount > 1 ? (
                              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-blue-950 text-blue-300 border border-blue-800/40 shrink-0 font-medium">
                                {inv.pageCount} Pages
                              </span>
                            ) : null}
                            {inv.documentPages && inv.documentPages.length > 0 ? (
                              <span
                                title="Original scan archived - click to view"
                                className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40 shrink-0"
                              >
                                <ImageIcon className="w-2.5 h-2.5" />
                                {inv.documentPages.length}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="py-3 px-4 font-medium text-slate-300">
                      {inv.vendorName}
                    </td>

                    <td className="py-3 px-4 font-mono text-slate-400">
                      {inv.invoiceDate}
                    </td>

                    <td className="py-3 px-4">
                      {inv.isScanned ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-purple-300 bg-purple-950/40 border border-purple-800/40 px-2 py-0.5 rounded">
                          <Scan className="w-3 h-3" /> Scanned OCR
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                          Digital PDF
                        </span>
                      )}
                    </td>

                    <td className="py-3 px-4 font-mono text-center text-slate-400">
                      {inv.itemCount || inv.items.length}
                    </td>

                    <td className="py-3 px-4 text-right font-mono font-bold text-slate-100 tabular-nums">
                      ${inv.totalAmount.toFixed(2)}
                    </td>

                    <td className="py-3 px-4">
                      {inv.status === 'needs_review' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300">
                          <AlertCircle className="w-3 h-3" /> Review Pending
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" /> Processed
                        </span>
                      )}
                    </td>

                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openInvoice(inv);
                        }}
                        className="px-2.5 py-1 text-xs text-blue-400 hover:text-blue-300 bg-blue-950/30 hover:bg-blue-950/60 rounded border border-blue-900/40 inline-flex items-center gap-1 transition-colors"
                      >
                        <Eye className="w-3 h-3" />
                        <span>Inspect</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Invoice Detail Inspector Modal */}
      {selectedInvoice && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-5xl w-full p-6 shadow-2xl relative max-h-[92vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-950/60 border border-blue-800/40 flex items-center justify-center text-blue-400">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-white font-mono">
                      {selectedInvoice.invoiceNumber}
                    </h2>
                    {selectedInvoice.isScanned && (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950/50 text-purple-300 border border-purple-800/40">
                        Scanned Optical OCR
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400">
                    Supplier: <strong className="text-slate-200">{selectedInvoice.vendorName}</strong> · File: {selectedInvoice.fileName}
                  </p>
                </div>
              </div>
              <button
                onClick={closeInspector}
                className="text-slate-400 hover:text-white p-1 rounded-md hover:bg-slate-800"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="py-4 space-y-4 overflow-y-auto pr-1">
              {/* Source document / extracted data switch */}
              <div className="flex items-center gap-1 p-1 bg-slate-950/80 border border-slate-800 rounded-lg w-fit">
                <button
                  onClick={() => setDetailTab('source')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 ${
                    detailTab === 'source'
                      ? 'bg-blue-600/20 text-blue-300 border border-blue-700/40'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  Original Invoice
                  {selectedPages.length > 0 ? (
                    <span className="font-mono text-[10px]">({selectedPages.length})</span>
                  ) : null}
                </button>
                <button
                  onClick={() => setDetailTab('items')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 ${
                    detailTab === 'items'
                      ? 'bg-slate-800 text-white border border-slate-700'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  Extracted Data ({selectedInvoice.items.length})
                </button>
              </div>

              {/* Financial Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-850 font-mono text-xs">
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Invoice Date</span>
                  <span className="text-slate-200 font-semibold">{selectedInvoice.invoiceDate}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Pages Scanned</span>
                  <span className="text-blue-400 font-bold">{selectedInvoice.pageCount || 1} Page(s)</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Subtotal</span>
                  <span className="text-slate-200 font-semibold tabular-nums">
                    ${selectedInvoice.subtotal?.toFixed(2) || selectedInvoice.totalAmount.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Tax Amount</span>
                  <span className="text-slate-200 font-semibold tabular-nums">
                    ${(selectedInvoice.taxAmount || 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Total Payable</span>
                  <span className="text-emerald-400 font-bold tabular-nums text-sm">
                    ${selectedInvoice.totalAmount.toFixed(2)} {selectedInvoice.currency}
                  </span>
                </div>
              </div>

              {selectedInvoice.notes && detailTab === 'items' && (
                <div className="p-2.5 rounded bg-slate-950/40 border border-slate-800/80 text-xs text-slate-400">
                  <strong className="text-slate-300">OCR Notes:</strong> {selectedInvoice.notes}
                </div>
              )}

              {/* ---- Original source document viewer ---- */}
              {detailTab === 'source' && (
                <div className="space-y-3">
                  {selectedPages.length === 0 ? (
                    <div className="py-12 text-center text-slate-500 text-xs">
                      <ImageIcon className="w-9 h-9 mx-auto mb-2 text-slate-700" />
                      <p className="text-slate-400 font-medium mb-1">No source image archived for this invoice</p>
                      <p>Invoices uploaded from now on are stored automatically, so their scan can be re-opened here.</p>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {/* Page navigation */}
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => goToPage(Math.max(1, activePage - 1))}
                            disabled={activePage <= 1}
                            className="p-1 rounded border border-slate-800 bg-slate-900 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <span className="text-xs font-mono text-slate-300 px-2 tabular-nums">
                            Page {activePage} / {selectedPages.length}
                          </span>
                          <button
                            onClick={() => goToPage(Math.min(selectedPages.length, activePage + 1))}
                            disabled={activePage >= selectedPages.length}
                            className="p-1 rounded border border-slate-800 bg-slate-900 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Zoom + open original */}
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setZoomPct((z) => Math.max(50, z - 25))}
                            className="p-1 rounded border border-slate-800 bg-slate-900 text-slate-300 hover:text-white hover:bg-slate-800"
                            title="Zoom out"
                          >
                            <ZoomOut className="w-3.5 h-3.5" />
                          </button>
                          <span className="text-[11px] font-mono text-slate-400 w-12 text-center tabular-nums">
                            {zoomPct}%
                          </span>
                          <button
                            onClick={() => setZoomPct((z) => Math.min(300, z + 25))}
                            className="p-1 rounded border border-slate-800 bg-slate-900 text-slate-300 hover:text-white hover:bg-slate-800"
                            title="Zoom in"
                          >
                            <ZoomIn className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setZoomPct(100)}
                            className="px-2 py-1 text-[11px] font-mono rounded border border-slate-800 bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800"
                          >
                            Fit
                          </button>
                          {activePageUrl && (
                            <a
                              href={activePageUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-1 px-2 py-1 text-[11px] rounded border border-blue-900/40 bg-blue-950/30 text-blue-400 hover:text-blue-300 hover:bg-blue-950/60 inline-flex items-center gap-1 transition-colors"
                            >
                              <ExternalLink className="w-3 h-3" />
                              Open full size
                            </a>
                          )}
                        </div>
                      </div>

                      {/* The page image itself */}
                      <div className="rounded-lg border border-slate-800 bg-slate-950/70 overflow-auto max-h-[58vh] p-3 flex justify-center">
                        {imageError || !activePageUrl ? (
                          <div className="py-10 text-center text-xs text-slate-500">
                            This page image could not be loaded.
                          </div>
                        ) : (
                          <img
                            key={activePageUrl}
                            src={activePageUrl}
                            alt={`${selectedInvoice.invoiceNumber} - page ${activePage}`}
                            onError={() => setImageError(true)}
                            style={{ width: `${zoomPct}%`, maxWidth: 'none' }}
                            className="block rounded shadow-lg bg-white"
                          />
                        )}
                      </div>

                      {/* Page jump chips */}
                      {selectedPages.length > 1 && (
                        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                          {selectedPages.map((p) => (
                            <button
                              key={p.pageNumber}
                              onClick={() => goToPage(p.pageNumber)}
                              className={`shrink-0 w-7 py-1 text-[11px] font-mono rounded border transition-colors ${
                                p.pageNumber === activePage
                                  ? 'bg-blue-600/20 text-blue-300 border-blue-700/50'
                                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                              }`}
                            >
                              {p.pageNumber}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ---- Extracted Line Items ---- */}
              {detailTab === 'items' && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider font-mono flex items-center justify-between">
                    <span>Extracted Line Items ({selectedInvoice.items.length})</span>
                    <span className="text-blue-400 text-[11px] font-normal">
                      Across {selectedInvoice.pageCount || 1} Page(s)
                    </span>
                  </h3>

                  <div className="border border-slate-800 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 font-mono">
                        <tr>
                          <th className="py-2 px-3">Raw Item (From Invoice)</th>
                          <th className="py-2 px-3">Standard Master Product</th>
                          <th className="py-2 px-3 text-center">Qty</th>
                          <th className="py-2 px-3 text-right">Unit Price</th>
                          <th className="py-2 px-3 text-right">Line Total</th>
                          <th className="py-2 px-3 text-right">Price Variance</th>
                          <th className="py-2 px-3 text-right">Correct</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-850">
                        {selectedInvoice.items.map((item) => (
                          <React.Fragment key={item.id}>
                          <tr
                            className={
                              editingItemId === item.id
                                ? 'bg-blue-950/30'
                                : 'hover:bg-slate-900/40'
                            }
                          >
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[9px] px-1.5 py-0.2 rounded bg-blue-950/80 text-blue-300 border border-blue-800/40 shrink-0 font-bold">
                                  Page {item.pageNumber || 1}
                                </span>
                                <span className="font-mono text-slate-200 text-xs font-medium">{item.rawDescription}</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5 mt-1 font-mono text-[10px]">
                                {item.supplierSku && (
                                  <span className="px-1.5 py-0.2 rounded bg-blue-950/60 text-blue-300 border border-blue-800/40">
                                    SKU: {item.supplierSku}
                                  </span>
                                )}
                                {item.packSize && (
                                  <span className="px-1.5 py-0.2 rounded bg-slate-900 text-slate-300 border border-slate-800">
                                    Pack: {item.packSize}
                                  </span>
                                )}
                                <span className="text-slate-500">Unit: {item.unit}</span>
                              </div>
                              {/* The whole point of the pack hierarchy: what this line
                                  actually costs once it is reduced to one base measure. */}
                              <div className="mt-1 font-mono text-[10px]">
                                {item.baseUnitPrice != null ? (
                                  <span
                                    title={`Compared with other invoices at ${formatBasePrice(item.baseUnitPrice, item.baseUnit)}`}
                                    className="text-emerald-400"
                                  >
                                    = {formatBasePrice(item.baseUnitPrice, item.baseUnit)}
                                  </span>
                                ) : item.masterProductId ? (
                                  <span
                                    title="The pack size or unit is unknown, so this price cannot be converted. It is recorded but not compared."
                                    className="text-slate-500 inline-flex items-center gap-1"
                                  >
                                    <Info className="w-2.5 h-2.5" />
                                    not comparable - add a pack size to compare it
                                  </span>
                                ) : null}
                              </div>
                            </td>

                            <td className="py-2.5 px-3">
                              {item.masterProductId ? (
                                <div>
                                  <span className="font-medium text-slate-200">
                                    {item.masterProductName}
                                  </span>
                                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px] font-mono">
                                    <span className="text-emerald-400">
                                      {(item.matchConfidence * 100).toFixed(0)}% Match
                                    </span>
                                    {item.matchTier && (
                                      <span className="px-1 py-0.2 rounded bg-slate-900 text-slate-400 border border-slate-800">
                                        {item.matchTier === 'sku_exact'
                                          ? 'Tier 1: SKU Match'
                                          : item.matchTier === 'rule_pack_match'
                                          ? 'Tier 2: Pack Rules'
                                          : 'Tier 3: AI Semantic'}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-amber-400 text-xs font-medium">Unmapped</span>
                                    <span className="text-[10px] font-mono text-amber-300/80">
                                      ({(item.matchConfidence * 100).toFixed(0)}% Probable)
                                    </span>
                                  </div>
                                  {item.suggestedMasterName && (
                                    <div className="text-[11px] text-slate-400">
                                      Suggested: <span className="text-slate-300 font-medium">{item.suggestedMasterName}</span>
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>

                            <td className="py-2.5 px-3 font-mono text-center text-slate-300 tabular-nums">
                              {item.quantity}
                            </td>

                            <td className="py-2.5 px-3 font-mono text-right text-slate-200 tabular-nums">
                              ${item.unitPrice.toFixed(2)}
                            </td>

                            <td className="py-2.5 px-3 font-mono text-right font-semibold text-slate-100 tabular-nums">
                              ${item.totalPrice.toFixed(2)}
                            </td>

                            <td className="py-2.5 px-3 font-mono text-right tabular-nums">
                              {item.priceDelta != null && item.priceDelta > 0 ? (
                                <span className="text-rose-400 font-bold inline-flex items-center gap-0.5">
                                  <ArrowUpRight className="w-3.5 h-3.5" />
                                  +${item.priceDelta.toFixed(2)} ({item.priceDeltaPercent?.toFixed(1)}%)
                                </span>
                              ) : item.priceComparable === false ? (
                                <span
                                  title="The pack size or unit does not let this price be converted, so it is recorded without being judged."
                                  className="text-slate-500"
                                >
                                  Not compared
                                </span>
                              ) : item.previousPrice != null ? (
                                <span className="text-slate-500">No increase</span>
                              ) : (
                                <span className="text-slate-600">First recorded</span>
                              )}
                            </td>

                            <td className="py-2.5 px-3 text-right">
                              {onUpdateLineItem && editingItemId !== item.id ? (
                                <button
                                  onClick={() => startEditing(item)}
                                  className="px-2 py-1 text-[11px] text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 rounded border border-slate-800 inline-flex items-center gap-1 transition-colors"
                                  title="Correct this line"
                                >
                                  <Pencil className="w-3 h-3" />
                                  Edit
                                </button>
                              ) : null}
                            </td>
                          </tr>

                          {/* Result of the last save on this line */}
                          {saveNote && saveNote.itemId === item.id && editingItemId !== item.id ? (
                            <tr>
                              <td colSpan={7} className="px-3 pb-2 -mt-1">
                                <div
                                  className={`text-[11px] font-mono px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                                    saveNote.ok
                                      ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/40'
                                      : 'bg-amber-950/40 text-amber-300 border border-amber-800/40'
                                  }`}
                                >
                                  {saveNote.ok ? (
                                    <Check className="w-3 h-3" />
                                  ) : (
                                    <TrendingUp className="w-3 h-3" />
                                  )}
                                  {saveNote.text}
                                </div>
                              </td>
                            </tr>
                          ) : null}

                          {/* ---- Inline line editor ---- */}
                          {editingItemId === item.id ? (
                            <tr className="bg-blue-950/20 border-y border-blue-900/40">
                              <td colSpan={7} className="px-3 py-3">
                                <div className="space-y-3">
                                  <div className="grid grid-cols-12 gap-2">
                                    <label className="col-span-5 space-y-1">
                                      <span className="text-[10px] uppercase font-mono text-slate-500">
                                        Description
                                      </span>
                                      <input
                                        value={draft.rawDescription ?? ''}
                                        onChange={(e) =>
                                          setDraft({ ...draft, rawDescription: e.target.value })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500/60"
                                      />
                                    </label>

                                    <label className="col-span-3 space-y-1">
                                      <span className="text-[10px] uppercase font-mono text-slate-500">
                                        Supplier SKU
                                      </span>
                                      <input
                                        value={draft.supplierSku ?? ''}
                                        onChange={(e) =>
                                          setDraft({ ...draft, supplierSku: e.target.value })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500/60"
                                      />
                                    </label>

                                    <label className="col-span-4 space-y-1">
                                      <span className="text-[10px] uppercase font-mono text-slate-500">
                                        Pack size (e.g. 10*1KG, 12x640ML)
                                      </span>
                                      <input
                                        value={draft.packSize ?? ''}
                                        onChange={(e) =>
                                          setDraft({ ...draft, packSize: e.target.value })
                                        }
                                        placeholder="10*1KG"
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500/60"
                                      />
                                    </label>
                                  </div>

                                  <div className="grid grid-cols-12 gap-2 items-end">
                                    <label className="col-span-3 space-y-1">
                                      <span className="text-[10px] uppercase font-mono text-slate-500">
                                        Unit
                                      </span>
                                      <select
                                        value={customUnit ? '__custom' : (draft.unit ?? 'each')}
                                        onChange={(e) => {
                                          if (e.target.value === '__custom') {
                                            setCustomUnit(draft.unit ?? '');
                                          } else {
                                            setCustomUnit('');
                                            setDraft({ ...draft, unit: e.target.value });
                                          }
                                        }}
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500/60"
                                      >
                                        <optgroup label="Outer">
                                          {UNIT_OPTIONS.filter((o) => o.level === 'pack').map((o) => (
                                            <option key={o.value} value={o.value}>
                                              {o.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                        <optgroup label="Weight">
                                          {UNIT_OPTIONS.filter((o) => o.level === 'weight').map((o) => (
                                            <option key={o.value} value={o.value}>
                                              {o.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                        <optgroup label="Volume">
                                          {UNIT_OPTIONS.filter((o) => o.level === 'volume').map((o) => (
                                            <option key={o.value} value={o.value}>
                                              {o.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                        <optgroup label="Count">
                                          {UNIT_OPTIONS.filter((o) => o.level === 'each').map((o) => (
                                            <option key={o.value} value={o.value}>
                                              {o.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                        <option value="__custom">Other (type it)</option>
                                      </select>
                                    </label>

                                    {customUnit ? (
                                      <label className="col-span-2 space-y-1">
                                        <span className="text-[10px] uppercase font-mono text-slate-500">
                                          Custom unit
                                        </span>
                                        <input
                                          value={customUnit}
                                          onChange={(e) => setCustomUnit(e.target.value)}
                                          className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500/60"
                                        />
                                      </label>
                                    ) : null}

                                    <label className="col-span-1 space-y-1">
                                      <span className="text-[10px] uppercase font-mono text-slate-500">
                                        Qty
                                      </span>
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={draft.quantity ?? 0}
                                        onChange={(e) =>
                                          setDraft({ ...draft, quantity: Number(e.target.value) })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 tabular-nums focus:outline-none focus:border-blue-500/60"
                                      />
                                    </label>

                                    <label className="col-span-2 space-y-1">
                                      <span className="text-[10px] uppercase font-mono text-slate-500">
                                        Unit price
                                      </span>
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={draft.unitPrice ?? 0}
                                        onChange={(e) =>
                                          setDraft({ ...draft, unitPrice: Number(e.target.value) })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 tabular-nums focus:outline-none focus:border-blue-500/60"
                                      />
                                    </label>

                                    <label className="col-span-2 space-y-1">
                                      <span className="text-[10px] uppercase font-mono text-slate-500">
                                        Line total
                                      </span>
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={draft.totalPrice ?? 0}
                                        onChange={(e) =>
                                          setDraft({ ...draft, totalPrice: Number(e.target.value) })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 tabular-nums focus:outline-none focus:border-blue-500/60"
                                      />
                                    </label>

                                    <div className="col-span-2 flex items-center justify-end gap-1.5 pb-0.5">
                                      <button
                                        onClick={() =>
                                          saveEditing(selectedInvoice.id, item.id)
                                        }
                                        disabled={savingItemId === item.id}
                                        className="px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded inline-flex items-center gap-1 transition-colors"
                                      >
                                        {savingItemId === item.id ? (
                                          <Save className="w-3 h-3 animate-pulse" />
                                        ) : (
                                          <Check className="w-3 h-3" />
                                        )}
                                        Save
                                      </button>
                                      <button
                                        onClick={() => setEditingItemId(null)}
                                        className="px-2 py-1 text-[11px] text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 rounded border border-slate-800 inline-flex items-center gap-1"
                                      >
                                        <X className="w-3 h-3" />
                                        Cancel
                                      </button>
                                    </div>
                                  </div>

                                  {/* Live result of the pack hierarchy, before saving */}
                                  <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-slate-950/60 border border-slate-800">
                                    <span className="text-[11px] text-slate-400">
                                      {draftPreview != null ? (
                                        <>
                                          This line works out to{' '}
                                          <strong className="text-emerald-400 font-mono">
                                            {formatBasePrice(draftPreview, draftPreviewUnit)}
                                          </strong>
                                          , which is what other invoices are compared against.
                                        </>
                                      ) : (
                                        <>
                                          No pack size could be read, so this price{' '}
                                          <strong className="text-slate-300">
                                            will not be compared
                                          </strong>
                                          . Enter a pack size such as 10*1KG to make it comparable.
                                        </>
                                      )}
                                    </span>
                                    <button
                                      onClick={() =>
                                        setDraft({
                                          ...draft,
                                          totalPrice:
                                            +((Number(draft.quantity) || 0) *
                                              (Number(draft.unitPrice) || 0)).toFixed(2),
                                        })
                                      }
                                      className="shrink-0 px-2 py-0.5 text-[10px] font-mono text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 rounded border border-slate-800"
                                    >
                                      Recalc total
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
              <span className="text-xs text-slate-500 font-mono">
                Invoice UUID: {selectedInvoice.id}
              </span>
              <button
                onClick={closeInspector}
                className="px-4 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg transition-colors"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
