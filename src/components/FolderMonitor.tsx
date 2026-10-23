import React, { useState, useRef, useEffect } from 'react';
import {
  FolderSync,
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FolderOpen,
  Sparkles,
  Archive,
  RefreshCw,
  CopyCheck,
} from 'lucide-react';
import JSZip from 'jszip';
import { rasterizePdfToPages } from '../lib/pdfRasterize.ts';
import { isImageMime, resolveFileMimeType } from '../lib/fileMime.ts';
import { documentStem } from '../lib/documentGrouping.ts';

interface FolderMonitorProps {
  onInvoiceIngested: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export const FolderMonitor: React.FC<FolderMonitorProps> = ({
  onInvoiceIngested,
  isOpen,
  onClose,
}) => {
  const [folderHandle, setFolderHandle] = useState<any>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [isWatching, setIsWatching] = useState(false);
  const [lastCheckTime, setLastCheckTime] = useState<string | null>(null);
  const [knownFiles, setKnownFiles] = useState<Set<string>>(new Set());

  const [processingQueue, setProcessingQueue] = useState<{
    id: string;
    fileName: string;
    status: 'pending' | 'ocr' | 'canonicalizing' | 'done' | 'duplicate' | 'error';
    error?: string;
    duplicateOf?: string;
  }[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const intervalRef = useRef<any>(null);

  // Check if Web File System Access API is supported
  const isFSApiSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  // Poll monitored folder if active
  useEffect(() => {
    if (isWatching && folderHandle) {
      scanMonitoredFolder();
      intervalRef.current = setInterval(() => {
        scanMonitoredFolder();
      }, 5000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isWatching, folderHandle]);

  const handleConnectFolder = async () => {
    if (!isFSApiSupported) {
      alert('The File System Access API is not supported in this browser environment. You can use the direct file dropzone or zip upload below.');
      return;
    }

    try {
      // @ts-ignore
      const handle = await window.showDirectoryPicker({
        mode: 'read',
      });
      setFolderHandle(handle);
      setFolderName(handle.name);
      setIsWatching(true);
      setLastCheckTime(new Date().toLocaleTimeString());
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Failed to select directory:', err);
      }
    }
  };

  const scanMonitoredFolder = async () => {
    if (!folderHandle) return;
    try {
      setLastCheckTime(new Date().toLocaleTimeString());
      const currentFiles: { name: string; file: File }[] = [];

      // @ts-ignore
      for await (const entry of folderHandle.values()) {
        if (entry.kind === 'file') {
          const ext = entry.name.toLowerCase();
          if (ext.endsWith('.pdf') || ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg')) {
            if (!knownFiles.has(entry.name)) {
              const file = await entry.getFile();
              currentFiles.push({ name: entry.name, file });
            }
          }
        }
      }

      if (currentFiles.length > 0) {
        // Add new files to known set
        const updated = new Set(knownFiles);
        currentFiles.forEach((f) => updated.add(f.name));
        setKnownFiles(updated);

        // Queue each statement (page series grouped) for processing
        await ingestFiles(currentFiles.map((f) => f.file));
      }
    } catch (err) {
      console.error('Error scanning folder:', err);
    }
  };

  /**
   * Reads an upload response. A 409 means the document is already stored - that is a
   * skip, not a failure, and it must not be reported as an error.
   */
  const readUploadResult = async (res: Response) => {
    const payload = await res.json().catch(() => ({}));
    if (res.status === 409 && payload.duplicate) {
      return { duplicate: true as const, payload };
    }
    if (!res.ok) {
      throw new Error(payload.error || 'OCR processing failed');
    }
    return { duplicate: false as const, payload };
  };

  const markDuplicate = (queueId: string, payload: any) => {
    const existing = payload?.existingInvoice;
    setProcessingQueue((prev) =>
      prev.map((q) =>
        q.id === queueId
          ? {
              ...q,
              status: 'duplicate' as const,
              duplicateOf: existing
                ? `${existing.vendorName} · ${existing.invoiceNumber}`
                : undefined,
            }
          : q
      )
    );
  };

  const processFile = async (file: File) => {
    const queueId = `q-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    
    setProcessingQueue((prev) => [
      { id: queueId, fileName: file.name, status: 'ocr' },
      ...prev,
    ]);

      try {
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

        if (isPdf) {
          // Image-only providers need rasterised pages; do it in the browser.
          const rendered = await rasterizePdfToPages(file, file.name);
          const res = await fetch('/api/invoices/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: file.name,
              isScannedManual: false,
              pages: rendered.map((p) => ({
                base64Data: p.base64Data,
                mimeType: p.mimeType,
                fileName: `${file.name.replace(/\.pdf$/i, '')}_p${p.pageNumber}.jpg`,
                pageNumber: p.pageNumber,
                totalPages: p.totalPages,
              })),
            }),
          });

          const result = await readUploadResult(res);
          if (result.duplicate) {
            markDuplicate(queueId, result.payload);
            return;
          }

          setProcessingQueue((prev) =>
            prev.map((q) => (q.id === queueId ? { ...q, status: 'done' } : q))
          );
          onInvoiceIngested();
          return;
        }

        // Convert file to base64
        const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Strip data url prefix
          const base64 = result.split(',')[1] || result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // Update queue to canonicalizing
      setProcessingQueue((prev) =>
        prev.map((q) => (q.id === queueId ? { ...q, status: 'canonicalizing' } : q))
      );

      // ZIP entries and some drag&drop sources report application/octet-stream, which the
      // server cannot read - resolve the real type from the file name.
      const mimeType = resolveFileMimeType(file.name, file.type);

      const res = await fetch('/api/invoices/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          base64Data,
          mimeType,
          isScannedManual: isImageMime(mimeType),
        }),
      });

      const result = await readUploadResult(res);
      if (result.duplicate) {
        markDuplicate(queueId, result.payload);
        return;
      }

      setProcessingQueue((prev) =>
        prev.map((q) => (q.id === queueId ? { ...q, status: 'done' } : q))
      );

      onInvoiceIngested();
    } catch (err: any) {
      console.error('File process error:', err);
      setProcessingQueue((prev) =>
        prev.map((q) =>
          q.id === queueId ? { ...q, status: 'error', error: err.message || 'Failed' } : q
        )
      );
    }
  };

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1] || result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  /**
   * Submits several files that are pages of ONE statement as a single invoice
   * (..._page_1.jpg, _page_2.jpg ...). Without this each page became its own invoice.
   */
  const processDocumentGroup = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1) return processFile(files[0]);

    const queueId = `q-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const label = documentStem(files[0].name) || files[0].name;

    setProcessingQueue((prev) => [
      { id: queueId, fileName: `${label} (${files.length} pages)`, status: 'ocr' },
      ...prev,
    ]);

    try {
      const pages: {
        base64Data: string;
        mimeType: string;
        fileName: string;
        pageNumber: number;
        totalPages: number;
      }[] = [];

      for (const file of files) {
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        if (isPdf) {
          const rendered = await rasterizePdfToPages(file, file.name);
          for (const p of rendered) {
            pages.push({
              base64Data: p.base64Data,
              mimeType: p.mimeType,
              fileName: `${file.name.replace(/\.pdf$/i, '')}_p${p.pageNumber}.jpg`,
              pageNumber: pages.length + 1,
              totalPages: 0,
            });
          }
        } else {
          pages.push({
            base64Data: await readFileAsBase64(file),
            mimeType: resolveFileMimeType(file.name, file.type),
            fileName: file.name,
            pageNumber: pages.length + 1,
            totalPages: 0,
          });
        }
      }

      const total = pages.length;
      pages.forEach((p, idx) => {
        p.pageNumber = idx + 1;
        p.totalPages = total;
      });

      const res = await fetch('/api/invoices/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: label, isScannedManual: true, pages }),
      });

      const result = await readUploadResult(res);
      if (result.duplicate) {
        markDuplicate(queueId, result.payload);
        return;
      }

      setProcessingQueue((prev) =>
        prev.map((q) => (q.id === queueId ? { ...q, status: 'done' } : q))
      );
      onInvoiceIngested();
    } catch (err: any) {
      console.error('Document group process error:', err);
      setProcessingQueue((prev) =>
        prev.map((q) => (q.id === queueId ? { ...q, status: 'error', error: err.message || 'Failed' } : q))
      );
    }
  };

  /** Buckets files that share a page-series stem so each statement becomes one invoice. */
  const groupFilesByDocument = (files: File[]): File[][] => {
    const buckets = new Map<string, File[]>();
    const order: string[] = [];
    for (const file of files) {
      // A unique key keeps standalone files (camera photos, one-off scans) separate.
      const key = documentStem(file.name) ?? `\u0000${file.name}`;
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(file);
    }
    return order.map((k) => buckets.get(k)!);
  };

  const ingestFiles = async (files: File[]) => {
    for (const group of groupFilesByDocument(files)) {
      await processDocumentGroup(group);
    }
  };

  // Handle manual file selection
  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await ingestFiles(Array.from(e.target.files));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Handle Drag & Drop
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      const files = Array.from(e.dataTransfer.files);
      const zips = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
      const rest = files.filter((f) => !f.name.toLowerCase().endsWith('.zip'));
      for (const zip of zips) await processZipFile(zip);
      await ingestFiles(rest);
    }
  };

  // Handle Zip archive upload
  const processZipFile = async (zipFile: File) => {
    try {
      const zip = await JSZip.loadAsync(zipFile);
      const entries = Object.keys(zip.files);
      for (const filename of entries) {
        const entry = zip.files[filename];
        if (!entry.dir) {
          const lower = filename.toLowerCase();
          if (lower.endsWith('.pdf') || lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
            const blob = await entry.async('blob');
            const entryName = filename.split('/').pop() || filename;
            const file = new File([blob], entryName, {
              type: resolveFileMimeType(entryName),
            });
            await processFile(file);
          }
        }
      }
    } catch (err) {
      console.error('Failed to unpack zip:', err);
      alert('Could not unpack zip archive.');
    }
  };

  const handleZipSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    await processZipFile(e.target.files[0]);
    if (zipInputRef.current) zipInputRef.current.value = '';
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <FolderSync className="w-5 h-5 text-blue-400" />
            <div>
              <h2 className="text-base font-semibold text-white">Invoice Ingestion & Folder Monitor</h2>
              <p className="text-xs text-slate-400">
                Automatic folder watching, scanned receipt OCR, and product variation mapping
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

        {/* Content */}
        <div className="py-4 space-y-5 overflow-y-auto pr-1">
          {/* Method 1: Folder Picker */}
          <div className="p-4 rounded-lg bg-slate-950/60 border border-slate-800">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-900/30 border border-blue-700/40 flex items-center justify-center text-blue-400">
                  <FolderOpen className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    {folderName ? `Monitoring: ${folderName}` : 'Live Folder Monitoring (File System API)'}
                  </h3>
                  <p className="text-xs text-slate-400">
                    {folderName
                      ? `Active sync · Last checked at ${lastCheckTime || 'just now'}`
                      : 'Grant read access to a local folder to automatically ingest invoices as they arrive'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {folderName ? (
                  <button
                    onClick={() => setIsWatching(!isWatching)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                      isWatching
                        ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/40'
                        : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    {isWatching ? 'Watching (Active)' : 'Paused'}
                  </button>
                ) : (
                  <button
                    onClick={handleConnectFolder}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Select Folder
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Method 2: Drag & Drop Files or Zip */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="border-2 border-dashed border-slate-700 hover:border-blue-500/60 rounded-xl p-6 text-center bg-slate-950/30 transition-colors"
          >
            <div className="mx-auto w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 mb-3">
              <Upload className="w-5 h-5 text-blue-400" />
            </div>
            <p className="text-sm font-medium text-slate-200">
              Drag & drop invoice files or a ZIP archive here
            </p>
            <p className="text-xs text-slate-400 mt-1 mb-4">
              Supports scanned phone photos, PDF invoices, JPG, PNG, and multi-invoice ZIPs
            </p>

            <div className="flex items-center justify-center gap-3">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFilesSelected}
                multiple
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 flex items-center gap-1.5"
              >
                <FileText className="w-3.5 h-3.5" />
                Select Invoices
              </button>

              <input
                type="file"
                ref={zipInputRef}
                onChange={handleZipSelected}
                accept=".zip"
                className="hidden"
              />
              <button
                onClick={() => zipInputRef.current?.click()}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 flex items-center gap-1.5"
              >
                <Archive className="w-3.5 h-3.5" />
                Upload ZIP
              </button>
            </div>
          </div>

          {/* Processing Queue Status */}
          {processingQueue.length > 0 && (
            <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/40">
              <div className="px-3 py-2 bg-slate-900/80 border-b border-slate-800 text-xs font-semibold text-slate-300 flex justify-between">
                <span>Recent Ingestion Pipeline</span>
                <span className="font-mono text-slate-500">{processingQueue.length} files</span>
              </div>
              <div className="divide-y divide-slate-850 max-h-48 overflow-y-auto">
                {processingQueue.map((item) => (
                  <div key={item.id} className="p-2.5 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 truncate pr-2">
                      <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="text-slate-200 truncate">{item.fileName}</span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {item.status === 'ocr' && (
                        <span className="flex items-center gap-1 text-blue-400 font-mono text-[11px]">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>AI OCR...</span>
                        </span>
                      )}
                      {item.status === 'canonicalizing' && (
                        <span className="flex items-center gap-1 text-purple-400 font-mono text-[11px]">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Alias Mapping...</span>
                        </span>
                      )}
                      {item.status === 'done' && (
                        <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Extracted & Stored</span>
                        </span>
                      )}
                      {item.status === 'duplicate' && (
                        <span className="flex items-center gap-1 text-amber-400 font-mono text-[11px]">
                          <CopyCheck className="w-3.5 h-3.5" />
                          <span>
                            Skipped · already imported
                            {item.duplicateOf ? ` (${item.duplicateOf})` : ''}
                          </span>
                        </span>
                      )}
                      {item.status === 'error' && (
                        <span className="flex items-center gap-1 text-rose-400 font-mono text-[11px]">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>{item.error || 'Failed'}</span>
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
