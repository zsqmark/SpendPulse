import React, { useState } from 'react';
import {
  Scan,
  Upload,
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  Plus,
  Trash2,
  Layers,
  CopyCheck,
} from 'lucide-react';
import { rasterizePdfToPages } from '../lib/pdfRasterize.ts';
import { isImageMime, resolveFileMimeType } from '../lib/fileMime.ts';
import { documentStem } from '../lib/documentGrouping.ts';

interface ScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvoiceIngested: () => void;
}

interface PageItem {
  id: string;
  file?: File;
  name: string;
  previewUrl: string | null;
  base64Data?: string;
  mimeType: string;
  pageNumber?: number;
  totalPages?: number;
}

export const ScanModal: React.FC<ScanModalProps> = ({ isOpen, onClose, onInvoiceIngested }) => {
  const [pages, setPages] = useState<PageItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [extractedResult, setExtractedResult] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSplittingPdf, setIsSplittingPdf] = useState(false);

  const handleFilesAdded = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    setErrorMessage(null);
    setExtractedResult(null);

    const newPages: PageItem[] = [];

    for (const file of files) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        setIsSplittingPdf(true);
        setCurrentStep(`Rendering PDF pages locally: ${file.name}...`);
        try {
          // DeepSeek reads images only, so every page is rasterised here in the browser.
          const rendered = await rasterizePdfToPages(file, file.name);
          const baseName = file.name.replace(/\.pdf$/i, '');
          console.log(`[ScanModal] Rendered ${rendered.length} page(s) from ${file.name}`);

          rendered.forEach((p) => {
            newPages.push({
              id: `page-${Date.now()}-${p.pageNumber}-${Math.random().toString(36).slice(2, 6)}`,
              name: `${baseName} (Page ${p.pageNumber} of ${p.totalPages})`,
              previewUrl: p.previewUrl,
              base64Data: p.base64Data,
              mimeType: p.mimeType,
              pageNumber: p.pageNumber,
              totalPages: p.totalPages,
            });
          });
        } catch (pdfErr: any) {
          console.error('[ScanModal] PDF rasterisation failed:', pdfErr);
          setErrorMessage(
            `Could not read "${file.name}" as a PDF: ${pdfErr?.message || 'unsupported or corrupt file'}`
          );
        } finally {
          setIsSplittingPdf(false);
          setCurrentStep(null);
        }
      } else {
        // Image formats - resolve from the name so ZIP/drag&drop sources still work.
        const mimeType = resolveFileMimeType(file.name, file.type);

        let previewUrl: string | null = null;
        if (isImageMime(mimeType)) {
          previewUrl = URL.createObjectURL(file);
        }

        newPages.push({
          id: `page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          file,
          name: file.name,
          previewUrl,
          mimeType,
          pageNumber: pages.length + newPages.length + 1,
        });
      }
    }

    setPages((prev) => [...prev, ...newPages]);
    e.target.value = '';
  };

  const handleRemovePage = (id: string) => {
    setPages((prev) => prev.filter((p) => p.id !== id));
  };

  const handleStartOCR = async () => {
    if (pages.length === 0) {
      setErrorMessage('Please select or upload at least one invoice file (PDF or scanned page).');
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);
    setExtractedResult(null);

    try {
      setCurrentStep(`Preparing ${pages.length} document page(s) for DeepSeek Vision...`);

      // Convert any pending page files to base64
      const encodedPages: {
        base64Data: string;
        mimeType: string;
        fileName: string;
        pageNumber: number;
        totalPages: number;
      }[] = [];

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        let b64 = p.base64Data;
        if (!b64 && p.file) {
          b64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const res = reader.result as string;
              resolve(res.split(',')[1] || res);
            };
            reader.onerror = reject;
            reader.readAsDataURL(p.file!);
          });
        }

        if (b64) {
          encodedPages.push({
            base64Data: b64,
            mimeType: p.mimeType,
            fileName: p.name,
            pageNumber: p.pageNumber || i + 1,
            totalPages: pages.length,
          });
        }
      }

      /**
       * Each real-world invoice is submitted as its own document. Pages that belong to
       * the same statement share a file-name stem (..._page_1, _page_2, ...); pages
       * rendered from one PDF share the "(Page N of M)" suffix. Anything else is treated
       * as a standalone document, so a folder of different suppliers never collapses into
       * a single invoice with one vendor name.
       */
      const documents = new Map<string, typeof encodedPages>();
      const docOrder: string[] = [];
      for (const page of encodedPages) {
        const key = documentStem(page.fileName) ?? `#${documents.size}:${page.fileName}`;
        if (!documents.has(key)) {
          documents.set(key, []);
          docOrder.push(key);
        }
        documents.get(key)!.push(page);
      }

      const results: any[] = [];
      const failures: string[] = [];
      const duplicates: {
        fileName: string;
        reason?: string;
        existingInvoice?: any;
      }[] = [];

      for (let d = 0; d < docOrder.length; d++) {
        const docPages = documents.get(docOrder[d])!;
        const docName = docPages[0].fileName.replace(/\s*\(Page \d+ of \d+\)/, '');

        setCurrentStep(
          docOrder.length > 1
            ? `Scanning document ${d + 1} of ${docOrder.length}: ${docName} (${docPages.length} page(s))...`
            : docPages.length > 1
            ? `Scanning all line items across Page 1 to Page ${docPages.length} via DeepSeek Vision...`
            : 'Scanning invoice document via DeepSeek Vision...'
        );

        // Renumber pages per document so page numbers stay meaningful.
        const response = await fetch('/api/invoices/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: docName,
            pages: docPages.map((p, idx) => ({ ...p, pageNumber: idx + 1, totalPages: docPages.length })),
            isScannedManual: true,
          }),
        });

        const payload = await response.json().catch(() => ({}));

        if (response.status === 409 && payload.duplicate) {
          // Already imported - not an error, just nothing new to add.
          duplicates.push({
            fileName: docName,
            reason: payload.reason,
            existingInvoice: payload.existingInvoice,
          });
          continue;
        }

        if (!response.ok) {
          failures.push(`${docName}: ${payload.error || 'OCR failed'}`);
          continue;
        }

        results.push(payload);
      }

      if (results.length === 0 && duplicates.length === 0) {
        throw new Error(failures.join(' · ') || 'OCR processing failed on server');
      }

      setCurrentStep('Reconciling line items across all pages into Master Catalog...');

      const totalItems = results.reduce((sum, r) => sum + (r.invoice?.itemCount || 0), 0);
      const vendors = Array.from(
        new Set(results.map((r) => r.invoice?.vendorName).filter(Boolean))
      );

      setExtractedResult({
        ...(results[results.length - 1] ?? {}),
        invoices: results.map((r) => r.invoice),
        documentsProcessed: results.length,
        totalItems,
        vendors,
        failures,
        duplicates,
      });
      onInvoiceIngested();
    } catch (err: any) {
      console.error('OCR Process failed:', err);
      setErrorMessage(err.message || 'OCR processing failed. Please check the files and try again.');
    } finally {
      setIsProcessing(false);
      setCurrentStep(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-4xl w-full p-6 shadow-2xl relative max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <Scan className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span>Multi-Page Receipt & Invoice OCR Studio</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                  DeepSeek Vision
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Full-document multi-page scanning: automatically unpacks and extracts every line item across Page 1, Page 2, Page 3+
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-md hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="py-4 space-y-4 overflow-y-auto pr-1">
          {/* Upload or Drop Area */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left: Input & Document Preview */}
            <div className="space-y-3">
              <div className="border-2 border-dashed border-slate-700 hover:border-blue-500/60 rounded-xl p-5 text-center bg-slate-950/40 transition-colors">
                <input
                  type="file"
                  id="scan-file-input"
                  multiple
                  onChange={handleFilesAdded}
                  accept="image/*,.pdf,.png,.jpg,.jpeg,.webp"
                  className="hidden"
                />
                <label htmlFor="scan-file-input" className="cursor-pointer block space-y-2">
                  <div className="w-9 h-9 rounded-full bg-slate-800 text-blue-400 flex items-center justify-center mx-auto">
                    <Upload className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-medium text-slate-200 block">
                    Upload Multi-Page Invoice (PDF or Multiple Photos)
                  </span>
                  <span className="text-[11px] text-slate-400 block">
                    Upload a 2, 3, or 5+ page PDF — each page is automatically isolated and scanned
                  </span>
                </label>
              </div>

              {/* Uploaded Pages List */}
              {pages.length > 0 && (
                <div className="border border-slate-800 rounded-lg bg-slate-950/70 p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-blue-400" />
                      Document Pages Detected ({pages.length})
                    </span>
                    <label
                      htmlFor="scan-file-input"
                      className="cursor-pointer text-blue-400 hover:text-blue-300 text-[11px] flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Add Page</span>
                    </label>
                  </div>

                  <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                    {pages.map((p, idx) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between p-2 rounded bg-slate-900 border border-slate-800 text-xs"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800/40 shrink-0">
                            Page {p.pageNumber || idx + 1}
                          </span>
                          {p.previewUrl ? (
                            <img
                              src={p.previewUrl}
                              alt={`Page ${idx + 1}`}
                              className="w-7 h-7 object-cover rounded shrink-0 border border-slate-800"
                            />
                          ) : (
                            <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                          )}
                          <span className="font-mono text-slate-200 text-xs truncate max-w-[190px]">
                            {p.name}
                          </span>
                          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/50 px-1 py-0.2 rounded shrink-0">
                            {p.mimeType === 'application/pdf' ? 'PDF Page' : 'Photo'}
                          </span>
                        </div>

                        <button
                          onClick={() => handleRemovePage(p.id)}
                          className="text-slate-500 hover:text-rose-400 p-1 transition-colors"
                          title="Remove this page"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="p-2 rounded bg-blue-950/30 border border-blue-900/40 text-[11px] text-blue-300 font-mono">
                    ✓ Full Multi-Page Coverage: All {pages.length} page(s) will be scanned and consolidated into a unified ledger.
                  </div>
                </div>
              )}

              {/* Action Button */}
              <button
                onClick={handleStartOCR}
                disabled={isProcessing || isSplittingPdf || pages.length === 0}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white font-semibold text-xs rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
              >
                {isProcessing || isSplittingPdf ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{isSplittingPdf ? 'Unpacking PDF Pages...' : `Extracting All ${pages.length} Pages...`}</span>
                  </>
                ) : (
                  <>
                    <Scan className="w-4 h-4" />
                    <span>
                      Scan All {pages.length === 0 ? '' : `${pages.length} `}Pages ({pages.length} page{pages.length === 1 ? '' : 's'})
                    </span>
                  </>
                )}
              </button>

              {currentStep && (
                <div className="text-xs font-mono text-blue-300 flex items-center gap-1.5 p-2 bg-blue-950/40 rounded border border-blue-900/50">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>{currentStep}</span>
                </div>
              )}

              {errorMessage && (
                <div className="text-xs text-rose-300 p-2.5 bg-rose-950/40 border border-rose-900/60 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}
            </div>

            {/* Right: Real-Time Extracted Output */}
            <div className="border border-slate-800 rounded-xl bg-slate-950/60 p-4 space-y-3 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <span className="text-xs font-mono font-semibold text-slate-300 uppercase">
                    Extracted Multi-Page Data
                  </span>
                  {extractedResult && (
                    <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Saved to Ledger</span>
                    </span>
                  )}
                </div>

                {!extractedResult && !isProcessing && (
                  <div className="py-16 text-center text-slate-500 text-xs">
                    Upload a multi-page PDF invoice or multiple photos of each page, then click "Scan All Pages" to extract every line item from start to finish.
                  </div>
                )}

                {isProcessing && (
                  <div className="py-16 text-center space-y-2">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-400 mx-auto" />
                    <p className="text-xs text-slate-300 font-mono">
                      Extracting line items across Page 1, Page 2, Page 3+ via DeepSeek Vision...
                    </p>
                  </div>
                )}

                {extractedResult && (
                  <div className="space-y-3 pt-2 text-xs">
                    {/* Multi-document runs: one card per real invoice */}
                    {(extractedResult.documentsProcessed || 1) > 1 && (
                      <div className="p-2.5 rounded bg-slate-900 border border-slate-800 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-300 font-semibold">
                            {extractedResult.documentsProcessed} invoices created
                          </span>
                          <span className="text-slate-500 font-mono text-[10px]">
                            {extractedResult.totalItems} line items total
                          </span>
                        </div>
                        <div className="divide-y divide-slate-800">
                          {(extractedResult.invoices || []).map((inv: any) => (
                            <div key={inv.id} className="py-1 flex items-center justify-between gap-2 font-mono text-[10px]">
                              <span className="text-slate-200 truncate">
                                {inv.vendorName}
                                <span className="text-slate-500"> · {inv.invoiceNumber}</span>
                              </span>
                              <span className="text-slate-400 shrink-0">
                                {inv.itemCount} items · ${inv.totalAmount?.toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                        {(extractedResult.failures || []).length > 0 && (
                          <div className="text-[10px] text-amber-400">
                            Failed: {extractedResult.failures.join(' · ')}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Skipped duplicates */}
                    {(extractedResult.duplicates || []).length > 0 && (
                      <div className="p-2.5 rounded bg-amber-950/20 border border-amber-800/40 space-y-1">
                        <div className="flex items-center gap-1.5 text-amber-300">
                          <CopyCheck className="w-3.5 h-3.5" />
                          <span className="font-semibold">
                            {extractedResult.duplicates.length} already imported - skipped
                          </span>
                        </div>
                        {(extractedResult.duplicates || []).map((d: any, i: number) => (
                          <div key={i} className="text-[10px] text-slate-400 font-mono">
                            <span className="text-slate-300">{d.fileName}</span>
                            {d.existingInvoice && (
                              <span>
                                {' '}
                                → {d.existingInvoice.vendorName} · {d.existingInvoice.invoiceNumber} (
                                {d.existingInvoice.itemCount} items)
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Header values */}
                    <div className="grid grid-cols-2 gap-2 p-2.5 rounded bg-slate-900 border border-slate-800 font-mono text-[11px]">
                      <div>
                        <span className="text-slate-500 block">Vendor:</span>
                        <span className="text-slate-200 font-bold">{extractedResult.invoice?.vendorName}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Invoice #:</span>
                        <span className="text-slate-200">{extractedResult.invoice?.invoiceNumber}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Total Pages Scanned:</span>
                        <span className="text-blue-400 font-bold">
                          {extractedResult.invoice?.pageCount || 1} Page(s) Verified
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Grand Total Due:</span>
                        <span className="text-emerald-400 font-bold">
                          ${extractedResult.invoice?.totalAmount.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    {/* Extracted Line Items */}
                    <div>
                      <div className="flex items-center justify-between mb-1 text-[11px] font-mono text-slate-400">
                        <span>Extracted Items ({extractedResult.invoice?.items?.length || 0}):</span>
                        <span className="text-emerald-400">
                          All {extractedResult.invoice?.pageCount || 1} pages captured
                        </span>
                      </div>
                      <div className="divide-y divide-slate-800 border border-slate-800 rounded max-h-52 overflow-y-auto">
                        {extractedResult.invoice?.items?.map((it: any, i: number) => (
                          <div key={i} className="p-2 flex items-center justify-between font-mono text-[11px]">
                            <div className="truncate pr-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[9px] px-1.5 py-0.2 rounded bg-blue-950/80 text-blue-300 border border-blue-800/40 shrink-0 font-bold">
                                  Page {it.pageNumber || 1}
                                </span>
                                {it.supplierSku && (
                                  <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-400 shrink-0">
                                    #{it.supplierSku}
                                  </span>
                                )}
                                <span className="text-slate-200 truncate">{it.rawDescription}</span>
                              </div>
                              <span className="text-slate-500 text-[10px] block mt-0.5">
                                {it.packSize ? `Pack: ${it.packSize} · ` : ''}
                                {it.masterProductName
                                  ? `→ Linked to: ${it.masterProductName}`
                                  : '→ Needs alias review'}
                              </span>
                            </div>
                            <div className="text-right shrink-0">
                              <span className="text-slate-200 font-semibold block">
                                ${it.unitPrice?.toFixed(2)} /{it.unit}
                              </span>
                              <span className="text-slate-400 text-[10px] block">
                                Tot: ${it.totalPrice?.toFixed(2)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Alerts Flag */}
                    {extractedResult.alertsCreated?.length > 0 && (
                      <div className="p-2.5 rounded bg-rose-950/40 border border-rose-900/60 text-xs text-rose-300 flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 shrink-0" />
                        <span>
                          {extractedResult.alertsCreated.length} price increase alert(s) automatically created!
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {extractedResult && (
                <button
                  onClick={onClose}
                  className="w-full py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium"
                >
                  View In Invoices Ledger
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
          <span className="text-xs text-slate-500 font-mono">
            {pages.length > 0
              ? `${pages.length} page(s) ready for extraction (all pages guaranteed)`
              : 'Accepts multi-page PDFs, multiple photos, or single tickets'}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
