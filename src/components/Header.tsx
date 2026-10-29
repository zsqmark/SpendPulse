import React from 'react';
import { ShieldAlert, Database, Sparkles, FolderSync, PlusCircle, Building2, History } from 'lucide-react';

export type HeaderTab =
  | 'invoices'
  | 'alerts'
  | 'catalog'
  | 'alignment'
  | 'trends'
  | 'vendors'
  | 'chat';

interface HeaderProps {
  activeTab: HeaderTab;
  setActiveTab: (tab: HeaderTab) => void;
  activeAlertCount: number;
  reviewItemsCount: number;
  /** Alignments nobody could settle on their own. */
  alignmentConflicts?: number;
  onOpenExport: () => void;
  onOpenUpload: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  activeAlertCount,
  reviewItemsCount,
  alignmentConflicts = 0,
  onOpenExport,
  onOpenUpload,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-8 h-16">
          {/* Zone 1: Single text element wordmark */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-sm">
              SP
            </div>
            <a
              href="#dashboard"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab('invoices');
              }}
              className="text-lg font-bold tracking-tight text-white whitespace-nowrap"
            >
              SpendPulse
            </a>
          </div>

          {/* Zone 2: Single-line text navigation links */}
          <nav className="hidden md:flex items-center gap-1 sm:gap-2">
            <button
              onClick={() => setActiveTab('invoices')}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'invoices'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              Invoices & OCR
            </button>

            <button
              onClick={() => setActiveTab('alerts')}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                activeTab === 'alerts'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              <span>Price Alerts</span>
              {activeAlertCount > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  {activeAlertCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('catalog')}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                activeTab === 'catalog'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              <span>Master Catalog & Aliases</span>
              {reviewItemsCount > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  {reviewItemsCount} review
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('alignment')}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                activeTab === 'alignment'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              <History className="w-3.5 h-3.5 text-violet-400" />
              <span>Alignment</span>
              {alignmentConflicts > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  {alignmentConflicts}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('trends')}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'trends'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              Price Trends
            </button>

            <button
              onClick={() => setActiveTab('vendors')}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                activeTab === 'vendors'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              <Building2 className="w-3.5 h-3.5 text-blue-400" />
              <span>Suppliers</span>
            </button>

            <button
              onClick={() => setActiveTab('chat')}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                activeTab === 'chat'
                  ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                  : 'text-slate-400 hover:text-blue-300 hover:bg-slate-900/60'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-blue-400" />
              <span>AI Copilot</span>
            </button>
          </nav>

          {/* Zone 3: Primary action button & database export */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              onClick={onOpenExport}
              title="Export database to CSV, JSON, or SQL"
              className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Database className="w-3.5 h-3.5 text-slate-400" />
              <span className="hidden sm:inline">Export</span> Database
            </button>

            <button
              onClick={onOpenUpload}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Scan / Ingest</span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation bar */}
        <div className="flex md:hidden items-center justify-between py-2 border-t border-slate-900 overflow-x-auto gap-1">
          <button
            onClick={() => setActiveTab('invoices')}
            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap ${
              activeTab === 'invoices' ? 'bg-slate-800 text-white' : 'text-slate-400'
            }`}
          >
            Invoices
          </button>
          <button
            onClick={() => setActiveTab('alerts')}
            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap flex items-center gap-1 ${
              activeTab === 'alerts' ? 'bg-slate-800 text-white' : 'text-slate-400'
            }`}
          >
            Alerts {activeAlertCount > 0 && `(${activeAlertCount})`}
          </button>
          <button
            onClick={() => setActiveTab('catalog')}
            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap flex items-center gap-1 ${
              activeTab === 'catalog' ? 'bg-slate-800 text-white' : 'text-slate-400'
            }`}
          >
            Catalog {reviewItemsCount > 0 && `(${reviewItemsCount})`}
          </button>
          <button
            onClick={() => setActiveTab('alignment')}
            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap flex items-center gap-1 ${
              activeTab === 'alignment' ? 'bg-slate-800 text-white' : 'text-slate-400'
            }`}
          >
            <History className="w-3 h-3 text-violet-400" />
            Align {alignmentConflicts > 0 && `(${alignmentConflicts})`}
          </button>
          <button
            onClick={() => setActiveTab('trends')}
            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap ${
              activeTab === 'trends' ? 'bg-slate-800 text-white' : 'text-slate-400'
            }`}
          >
            Trends
          </button>
          <button
            onClick={() => setActiveTab('vendors')}
            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap flex items-center gap-1 ${
              activeTab === 'vendors' ? 'bg-slate-800 text-white' : 'text-slate-400'
            }`}
          >
            <Building2 className="w-3 h-3 text-blue-400" />
            Suppliers
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap text-blue-400 ${
              activeTab === 'chat' ? 'bg-blue-950/60' : ''
            }`}
          >
            AI Copilot
          </button>
        </div>
      </div>
    </header>
  );
};
