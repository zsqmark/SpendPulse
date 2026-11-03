import React, { useState, useEffect } from 'react';
import {
  Menu,
  X,
  FileText,
  AlertTriangle,
  Package,
  History,
  TrendingUp,
  Building2,
  Sparkles,
  Database,
  PlusCircle,
  ChevronRight,
} from 'lucide-react';

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
  const [isOpen, setIsOpen] = useState(false);

  // Close side menu with Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Lock body scroll when side drawer is open on mobile
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const navItems: Array<{
    id: HeaderTab;
    label: string;
    subtitle: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: {
      count: number;
      label?: string;
      color: 'rose' | 'amber' | 'blue';
    };
    highlight?: boolean;
  }> = [
    {
      id: 'invoices',
      label: 'Invoices & OCR',
      subtitle: 'Uploads, multi-page OCR & review',
      icon: FileText,
    },
    {
      id: 'alerts',
      label: 'Price Alerts',
      subtitle: 'Vendor price creep & unexpected increases',
      icon: AlertTriangle,
      badge:
        activeAlertCount > 0
          ? { count: activeAlertCount, color: 'rose' }
          : undefined,
    },
    {
      id: 'catalog',
      label: 'Master Catalog & Aliases',
      subtitle: 'Canonical items, pack sizes & SKU mapping',
      icon: Package,
      badge:
        reviewItemsCount > 0
          ? { count: reviewItemsCount, label: `${reviewItemsCount} review`, color: 'amber' }
          : undefined,
    },
    {
      id: 'alignment',
      label: 'Alignment',
      subtitle: 'Historical unit & attribute reconciliation',
      icon: History,
      badge:
        alignmentConflicts > 0
          ? { count: alignmentConflicts, color: 'amber' }
          : undefined,
    },
    {
      id: 'trends',
      label: 'Price Trends',
      subtitle: 'Historical pricing curves & unit changes',
      icon: TrendingUp,
    },
    {
      id: 'vendors',
      label: 'Suppliers',
      subtitle: 'Vendor directory & entity normalization',
      icon: Building2,
    },
    {
      id: 'chat',
      label: 'AI Copilot',
      subtitle: 'Autonomous procurement assistant',
      icon: Sparkles,
      highlight: true,
    },
  ];

  const currentTab = navItems.find((item) => item.id === activeTab) || navItems[0];
  const totalNotifications = activeAlertCount + reviewItemsCount + alignmentConflicts;

  const handleSelectTab = (tab: HeaderTab) => {
    setActiveTab(tab);
    setIsOpen(false);
  };

  return (
    <>
      <header className="border-b border-slate-800/90 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            {/* Left section: Hamburger button + Logo + Active view indicator */}
            <div className="flex items-center gap-3 shrink-0">
              {/* Side Hamburger Menu Toggle Button */}
              <button
                type="button"
                onClick={() => setIsOpen((prev) => !prev)}
                aria-label={isOpen ? 'Close navigation menu' : 'Open navigation menu'}
                className="relative p-2 -ml-1 text-slate-300 hover:text-white bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors focus:outline-hidden focus:ring-2 focus:ring-blue-500/50"
              >
                {isOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                {/* Notification indicator dot if any alerts or conflicts exist */}
                {!isOpen && totalNotifications > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500 border border-slate-950" />
                  </span>
                )}
              </button>

              {/* Wordmark logo */}
              <div
                onClick={() => handleSelectTab('invoices')}
                className="flex items-center gap-2.5 cursor-pointer group"
                title="SpendPulse - Go to Invoices"
              >
                <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-sm group-hover:border-blue-400/50 group-hover:bg-blue-600/30 transition-all">
                  SP
                </div>
                <div className="flex flex-col">
                  <span className="text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap leading-tight">
                    SpendPulse
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono hidden xs:inline tracking-wide">
                    Procurement Monitor
                  </span>
                </div>
              </div>

              {/* Breadcrumb separator and current section name */}
              <div className="hidden sm:flex items-center gap-2 pl-3 ml-1 border-l border-slate-800">
                <currentTab.icon className="w-4 h-4 text-blue-400 shrink-0" />
                <span className="text-xs sm:text-sm font-medium text-slate-200 whitespace-nowrap">
                  {currentTab.label}
                </span>
                {currentTab.badge && (
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                      currentTab.badge.color === 'rose'
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    }`}
                  >
                    {currentTab.badge.label || currentTab.badge.count}
                  </span>
                )}
              </div>
            </div>

            {/* Right action buttons */}
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <button
                type="button"
                onClick={onOpenExport}
                title="Export database to CSV, JSON, or SQL"
                className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap"
              >
                <Database className="w-3.5 h-3.5 text-slate-400" />
                <span className="hidden sm:inline">Export</span>
                <span className="sm:hidden">Export</span>
              </button>

              <button
                type="button"
                onClick={onOpenUpload}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors flex items-center gap-1.5 whitespace-nowrap"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>Scan / Ingest</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Slide-out Side Hamburger Menu */}
      {/* Backdrop */}
      <div
        onClick={() => setIsOpen(false)}
        className={`fixed inset-0 bg-black/60 backdrop-blur-xs z-50 transition-opacity duration-200 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden="true"
      />

      {/* Side Drawer Panel */}
      <aside
        aria-label="Navigation Sidebar"
        aria-hidden={!isOpen}
        className={`fixed inset-y-0 left-0 w-80 max-w-[85vw] bg-[#0c1222] border-r border-slate-800 shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-out transform ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Drawer Header */}
        <div className="p-4 sm:p-5 border-b border-slate-800/80 flex items-center justify-between gap-3 bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-sm">
              SP
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight leading-tight">
                SpendPulse
              </h2>
              <p className="text-[11px] text-slate-400 font-mono">
                Invoice & Price Monitor
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Close navigation menu"
            className="p-1.5 text-slate-400 hover:text-white bg-slate-900/60 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors focus:outline-hidden"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Items List */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1.5">
          <div className="px-3 pb-2 text-[10px] font-mono uppercase tracking-wider text-slate-400">
            Navigation
          </div>

          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectTab(item.id)}
                className={`w-full text-left px-3.5 py-3 rounded-xl transition-all flex items-center justify-between gap-3 group border ${
                  isActive
                    ? 'bg-blue-600/15 border-blue-500/30 text-white shadow-xs'
                    : item.highlight
                    ? 'bg-blue-950/20 hover:bg-blue-900/30 border-blue-500/20 text-blue-300 hover:text-white'
                    : 'text-slate-300 hover:text-white hover:bg-slate-900/70 border-transparent hover:border-slate-800/80'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                      isActive
                        ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
                        : item.highlight
                        ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                        : 'bg-slate-900 text-slate-400 group-hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="truncate">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm font-medium leading-snug truncate ${
                          isActive ? 'text-white font-semibold' : ''
                        }`}
                      >
                        {item.label}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">
                      {item.subtitle}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {item.badge && (
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                        item.badge.color === 'rose'
                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/30 font-semibold'
                          : 'bg-amber-500/20 text-amber-300 border-amber-500/30 font-semibold'
                      }`}
                    >
                      {item.badge.label || item.badge.count}
                    </span>
                  )}
                  <ChevronRight
                    className={`w-4 h-4 transition-transform ${
                      isActive
                        ? 'text-blue-400 translate-x-0.5'
                        : 'text-slate-600 group-hover:text-slate-400 group-hover:translate-x-0.5'
                    }`}
                  />
                </div>
              </button>
            );
          })}
        </nav>

        {/* Drawer Footer / Quick Actions */}
        <div className="p-4 border-t border-slate-800/80 bg-slate-950/60 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400 px-1">
            <span>Quick Actions</span>
            {totalNotifications > 0 && (
              <span className="text-[11px] text-rose-400 font-mono">
                {totalNotifications} item{totalNotifications === 1 ? '' : 's'} to review
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onOpenUpload();
              }}
              className="px-3 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors flex items-center justify-center gap-1.5"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Scan / Ingest</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onOpenExport();
              }}
              className="px-3 py-2 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors flex items-center justify-center gap-1.5"
            >
              <Database className="w-3.5 h-3.5 text-slate-400" />
              <span>Export</span>
            </button>
          </div>

          <div className="pt-1 text-[11px] text-slate-500 text-center font-mono flex items-center justify-center gap-1.5">
            <span>Press</span>
            <kbd className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 text-[10px]">
              Esc
            </kbd>
            <span>to close menu</span>
          </div>
        </div>
      </aside>
    </>
  );
};
