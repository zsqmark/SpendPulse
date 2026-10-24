import React, { useState, useEffect } from 'react';
import { apiUrl } from '../lib/apiBase.ts';
import {
  Database,
  Download,
  Copy,
  Check,
  FileSpreadsheet,
  FileJson,
  Code2,
  TableProperties,
} from 'lucide-react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose }) => {
  const [activeFormat, setActiveFormat] = useState<'sql' | 'csv' | 'json'>('sql');
  const [previewContent, setPreviewContent] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadPreview(activeFormat);
    }
  }, [isOpen, activeFormat]);

  const loadPreview = async (format: 'sql' | 'csv' | 'json') => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/export/${format}`));
      const text = await res.text();
      // Show first 1500 chars for preview
      setPreviewContent(text);
    } catch (err) {
      setPreviewContent('-- Failed to load preview --');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = (format: 'sql' | 'csv' | 'json') => {
    window.location.href = apiUrl(`/api/export/${format}`);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(previewContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-3xl w-full p-6 shadow-2xl relative max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-blue-950/70 border border-blue-800/40 flex items-center justify-center text-blue-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Database Export Engine</h2>
              <p className="text-xs text-slate-400">
                Export normalized line items, master catalog mappings, price histories, and alert records
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
        <div className="py-4 space-y-4 overflow-y-auto pr-1">
          {/* Format selector buttons */}
          <div className="grid grid-cols-3 gap-3">
            <button
              onClick={() => {
                setActiveFormat('sql');
                loadPreview('sql');
              }}
              className={`p-3 rounded-lg border text-left transition-colors flex items-start gap-2.5 ${
                activeFormat === 'sql'
                  ? 'bg-blue-950/40 border-blue-500/60 text-white'
                  : 'bg-slate-950/50 border-slate-850 text-slate-300 hover:bg-slate-900'
              }`}
            >
              <Code2 className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-xs block">SQL Relational Dump</span>
                <span className="text-[11px] text-slate-400 block mt-0.5">
                  DDL Schema + INSERT statements for Postgres/SQLite
                </span>
              </div>
            </button>

            <button
              onClick={() => {
                setActiveFormat('csv');
                loadPreview('csv');
              }}
              className={`p-3 rounded-lg border text-left transition-colors flex items-start gap-2.5 ${
                activeFormat === 'csv'
                  ? 'bg-blue-950/40 border-blue-500/60 text-white'
                  : 'bg-slate-950/50 border-slate-850 text-slate-300 hover:bg-slate-900'
              }`}
            >
              <FileSpreadsheet className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-xs block">CSV Line Item Ledger</span>
                <span className="text-[11px] text-slate-400 block mt-0.5">
                  Flat spreadsheet for Excel, Google Sheets & ERP
                </span>
              </div>
            </button>

            <button
              onClick={() => {
                setActiveFormat('json');
                loadPreview('json');
              }}
              className={`p-3 rounded-lg border text-left transition-colors flex items-start gap-2.5 ${
                activeFormat === 'json'
                  ? 'bg-blue-950/40 border-blue-500/60 text-white'
                  : 'bg-slate-950/50 border-slate-850 text-slate-300 hover:bg-slate-900'
              }`}
            >
              <FileJson className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-xs block">Full JSON Export</span>
                <span className="text-[11px] text-slate-400 block mt-0.5">
                  Nested object tree of all invoices & alerts
                </span>
              </div>
            </button>
          </div>

          {/* Action bar */}
          <div className="flex items-center justify-between text-xs pt-1">
            <span className="font-mono text-slate-400">
              Format: <strong className="text-white uppercase">{activeFormat}</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors font-medium"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy to Clipboard</span>
                  </>
                )}
              </button>

              <button
                onClick={() => handleDownload(activeFormat)}
                className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg shadow-sm flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .{activeFormat}</span>
              </button>
            </div>
          </div>

          {/* Preview window */}
          <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950">
            <div className="px-3 py-2 bg-slate-900/80 border-b border-slate-800 text-[11px] font-mono text-slate-400 flex justify-between">
              <span>Preview Data Stream</span>
              <span>UTF-8 Plaintext</span>
            </div>
            <pre className="p-3 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-72 leading-relaxed whitespace-pre select-all">
              {loading ? 'Generating export stream...' : previewContent.slice(0, 5000)}
              {previewContent.length > 5000 && '\n\n-- [Preview truncated; full content will be downloaded] --'}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-end">
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
