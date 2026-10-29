import React, { useState, useEffect } from 'react';
import { Header } from './components/Header.tsx';
import { InvoicesView } from './components/InvoicesView.tsx';
import { PriceAlertsFeed } from './components/PriceAlertsFeed.tsx';
import { MasterCatalogView } from './components/MasterCatalogView.tsx';
import { PriceTrendsView } from './components/PriceTrendsView.tsx';
import { SuppliersView } from './components/SuppliersView.tsx';
import { AIChatCopilot } from './components/AIChatCopilot.tsx';
import { FolderMonitor } from './components/FolderMonitor.tsx';
import { ExportModal } from './components/ExportModal.tsx';
import { ScanModal } from './components/ScanModal.tsx';
import { apiUrl } from './lib/apiBase.ts';
import {
  Invoice,
  MasterProduct,
  PriceAlert,
  DashboardStats,
  VendorSummary,
  LineItemPatch,
  LineItemUpdateResult,
  ProductLinesPayload,
  SplitOutcome,
  UnitChangeRecord,
  UnitChangePreview,
  UnitChangeScope,
  UnitChangeResult,
} from './types/index.ts';
import type {
  UnitChangeApi,
  UnitChangeContext,
  ApplyUnitChangeOutcome,
  RevertUnitChangeOutcome,
} from './components/UnitChangeModal.tsx';
import {
  FileText,
  TrendingUp,
  AlertTriangle,
  FolderSync,
  DollarSign,
  Package,
  Sparkles,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'invoices' | 'alerts' | 'catalog' | 'trends' | 'vendors' | 'chat'>('invoices');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [masterProducts, setMasterProducts] = useState<MasterProduct[]>([]);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);

  const [isFolderMonitorOpen, setIsFolderMonitorOpen] = useState(false);
  const [isScanModalOpen, setIsScanModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [selectedTrendProductId, setSelectedTrendProductId] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

  // Load all initial data from server
  const safeJson = async (url: string) => {
    const res = await fetch(apiUrl(url));
    if (!res.ok) throw new Error(`Request to ${url} failed (${res.status})`);
    return res.json();
  };

  const loadData = async () => {
    try {
      const [invRes, catRes, alertRes, statsRes, vendorRes] = await Promise.all([
        safeJson('/api/invoices'),
        safeJson('/api/catalog'),
        safeJson('/api/alerts'),
        safeJson('/api/stats'),
        safeJson('/api/vendors'),
      ]);

      setInvoices(Array.isArray(invRes) ? invRes : []);
      setMasterProducts(Array.isArray(catRes) ? catRes : []);
      setAlerts(Array.isArray(alertRes) ? alertRes : []);
      setStats(statsRes ?? null);
      setVendors(Array.isArray(vendorRes) ? vendorRes : []);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAcknowledgeAlert = async (id: string) => {
    try {
      const res = await fetch(apiUrl(`/api/alerts/${id}/acknowledge`), { method: 'POST' });
      if (res.ok) {
        setAlerts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: 'acknowledged' } : a))
        );
        loadData();
      }
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
    }
  };

  const handleDisputeAlert = async (id: string) => {
    try {
      const res = await fetch(apiUrl(`/api/alerts/${id}/dispute`), { method: 'POST' });
      if (res.ok) {
        setAlerts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: 'disputed' } : a))
        );
        loadData();
      }
    } catch (err) {
      console.error('Failed to dispute alert:', err);
    }
  };

  const handleMapItem = async (params: {
    invoiceId: string;
    itemId: string;
    masterProductId?: string;
    createNew?: boolean;
    newProductData?: any;
  }) => {
    try {
      const res = await fetch(apiUrl('/api/catalog/map-item'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (res.ok) {
        await loadData();
      }
    } catch (err) {
      console.error('Failed to map item:', err);
    }
  };

  const handleApproveMatch = async (invoiceId: string, itemId: string, masterProductId: string) => {
    try {
      const res = await fetch(apiUrl('/api/catalog/approve-match'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId, itemId, masterProductId }),
      });
      if (res.ok) {
        await loadData();
      }
    } catch (err) {
      console.error('Failed to approve match:', err);
    }
  };

  const handleBulkApprove = async (approvals: { invoiceId: string; itemId: string; masterProductId: string }[]) => {
    try {
      const res = await fetch(apiUrl('/api/catalog/bulk-approve'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvals }),
      });
      if (res.ok) {
        await loadData();
      }
    } catch (err) {
      console.error('Failed to bulk approve matches:', err);
    }
  };

  // Resolves to null on success, or the server's reason when the merge was refused - the
  // catalogue will not join products that are priced by different measures.
  const handleMergeProducts = async (
    primaryId: string,
    mergeIds: string[]
  ): Promise<string | null> => {
    try {
      const res = await fetch(apiUrl('/api/catalog/merge'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryId, mergeIds }),
      });
      if (res.ok) {
        await loadData();
        return null;
      }
      const errJson = await res.json().catch(() => ({}));
      return errJson.error || `Merge failed (${res.status})`;
    } catch (err: any) {
      return err?.message || 'Merge failed';
    }
  };

  /** Every invoice line a master product owns, each flagged when its unit clashes. */
  const handleFetchProductLines = async (productId: string): Promise<ProductLinesPayload | null> => {
    try {
      const res = await fetch(apiUrl(`/api/catalog/${productId}/lines`));
      if (!res.ok) return null;
      return (await res.json()) as ProductLinesPayload;
    } catch (err) {
      console.error('Failed to load product lines:', err);
      return null;
    }
  };

  /**
   * Takes the given lines out of a product and gives them a product of their own (or moves
   * them into one the user names). Resolves to the server's reason when the split was
   * refused, otherwise to the product the lines now belong to - the catalogue needs that
   * name, because a new card is easy to lose among two hundred.
   */
  const handleSplitProduct = async (payload: {
    productId: string;
    lineRefs: { invoiceId: string; itemId: string }[];
    targetProductId?: string;
    newProduct?: { name?: string; unit?: string; packSize?: string; category?: string };
  }): Promise<SplitOutcome> => {
    try {
      const res = await fetch(apiUrl('/api/catalog/split'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        await loadData();
        return {
          error: null,
          targetId: json?.target?.id ?? null,
          targetName: json?.target?.name ?? null,
          moved: json?.movedLines ?? null,
        };
      }
      const errJson = await res.json().catch(() => ({}));
      return { error: errJson.error || `Split failed (${res.status})` };
    } catch (err: any) {
      return { error: err?.message || 'Split failed' };
    }
  };

  /**
   * The unit-of-measure editor. It is deliberately several calls instead of one: the
   * preview must be re-derived from the server on every change of mind, so what the user
   * confirms is exactly what will happen rather than a count computed earlier.
   */
  const unitApi: UnitChangeApi = {
    fetchContext: async (productId) => {
      try {
        const res = await fetch(apiUrl(`/api/catalog/${productId}/unit-invoices`));
        if (!res.ok) return null;
        return (await res.json()) as UnitChangeContext;
      } catch (err) {
        console.error('Failed to load unit context:', err);
        return null;
      }
    },
    fetchHistory: async (productId) => {
      try {
        const res = await fetch(apiUrl(`/api/catalog/${productId}/unit-changes`));
        if (!res.ok) return [];
        const json = await res.json().catch(() => ({}));
        return (json.records || []) as UnitChangeRecord[];
      } catch (err) {
        console.error('Failed to load unit change history:', err);
        return [];
      }
    },
    preview: async (payload) => {
      try {
        const res = await fetch(
          apiUrl(`/api/catalog/${payload.productId}/unit-change/preview`),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              newUnit: payload.newUnit,
              scope: payload.scope,
              invoiceIds: payload.invoiceIds,
            }),
          }
        );
        if (!res.ok) return null;
        return (await res.json()) as UnitChangePreview;
      } catch (err) {
        console.error('Failed to preview unit change:', err);
        return null;
      }
    },
    apply: async (payload) => {
      try {
        const res = await fetch(apiUrl(`/api/catalog/${payload.productId}/unit-change`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            newUnit: payload.newUnit,
            scope: payload.scope,
            invoiceIds: payload.invoiceIds,
          }),
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          return { error: errJson.error || `Unit change failed (${res.status})` };
        }
        const json = (await res.json()) as UnitChangeResult;
        await loadData();
        return {
          error: null,
          changedLines: json.changedLines,
          affectedInvoices: json.affectedInvoices,
          skipped: json.record?.skipped?.map((s) => ({
            invoiceNumber: s.invoiceNumber,
            reason: s.reason,
          })),
        };
      } catch (err: any) {
        return { error: err?.message || 'Unit change failed' };
      }
    },
    revert: async (recordId) => {
      try {
        const res = await fetch(apiUrl(`/api/unit-changes/${recordId}/revert`), {
          method: 'POST',
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          return { error: errJson.error || `Revert failed (${res.status})` };
        }
        const json = await res.json().catch(() => ({}));
        await loadData();
        return { error: null, restoredLines: json.restoredLines };
      } catch (err: any) {
        return { error: err?.message || 'Revert failed' };
      }
    },
  };

  /**
   * Corrects one extracted line. The server re-teaches the pack hierarchy and re-judges the
   * price, and returns what the line now works out to per base unit.
   */
  const handleUpdateLineItem = async (
    invoiceId: string,
    itemId: string,
    patch: LineItemPatch
  ): Promise<LineItemUpdateResult | null> => {
    try {
      const res = await fetch(apiUrl(`/api/invoices/${invoiceId}/items/${itemId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        console.error('Failed to update line item:', res.status);
        return null;
      }
      const json = await res.json();
      await loadData();
      const comparison = json.comparison || {};
      return {
        comparable: !!comparison.comparable,
        baseUnitPrice: comparison.baseUnitPrice ?? null,
        baseUnit: comparison.baseUnit ?? null,
        previousPrice: comparison.previousPrice ?? null,
        percentChange: comparison.percentChange ?? null,
        alertCreated: !!json.alertCreated,
        alertRemoved: json.alertRemoved || 0,
      };
    } catch (err) {
      console.error('Failed to update line item:', err);
      throw err;
    }
  };

  const handleRebuildPriceHistory = async () => {
    try {
      const res = await fetch(apiUrl('/api/catalog/rebuild-price-history'), { method: 'POST' });
      if (res.ok) {
        const result = await res.json();
        await loadData();
        return result;
      }
      return null;
    } catch (err) {
      console.error('Failed to rebuild price history:', err);
      return null;
    }
  };

  const handleViewProductTrends = (productId: string) => {
    setSelectedTrendProductId(productId);
    setActiveTab('trends');
  };

  const handleNormalizeVendors = async () => {
    try {
      const res = await fetch(apiUrl('/api/vendors/normalize'), { method: 'POST' });
      if (res.ok) {
        const result = await res.json();
        await loadData();
        return result;
      }
      return null;
    } catch (err) {
      console.error('Failed to normalize vendors:', err);
      return null;
    }
  };

  const handleMergeVendors = async (primaryName: string, otherNames: string[]) => {
    try {
      const res = await fetch(apiUrl('/api/vendors/merge'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryName, otherNames }),
      });
      if (res.ok) {
        const result = await res.json();
        await loadData();
        return result;
      } else {
        const errJson = await res.json().catch(() => ({}));
        console.error('Failed to merge vendors:', errJson.error || res.status);
        return null;
      }
    } catch (err) {
      console.error('Failed to merge vendors:', err);
      return null;
    }
  };

  const handleClearAllData = async () => {
    if (confirm('Permanently clear all invoices, catalog records, and price alerts from the database?')) {
      await fetch(apiUrl('/api/reset-data'), { method: 'POST' });
      await loadData();
    }
  };

  const activeAlertCount = alerts.filter((a) => a.status === 'active').length;
  const reviewItemsCount = stats?.unmappedItemsCount || 0;

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100 flex flex-col font-sans">
      {/* Top Bar Navigation */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeAlertCount={activeAlertCount}
        reviewItemsCount={reviewItemsCount}
        onOpenExport={() => setIsExportModalOpen(true)}
        onOpenUpload={() => setIsScanModalOpen(true)}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* KPI Strip & Folder Ingestion Action Row */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Card 1: Total Spend */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
            <span className="text-slate-400 block text-[11px] font-mono uppercase tracking-wider">
              Total Invoiced Spend
            </span>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-2xl font-bold font-mono text-white tabular-nums">
                ${(stats?.totalSpend || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-xs text-slate-500 font-mono">USD</span>
            </div>
            <span className="text-[11px] text-slate-400 mt-1 block">
              Across {invoices.length} extracted invoices
            </span>
          </div>

          {/* Card 2: Price Alerts */}
          <div
            onClick={() => setActiveTab('alerts')}
            className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-rose-500/50 cursor-pointer transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-slate-400 block text-[11px] font-mono uppercase tracking-wider">
                Price Increase Alerts
              </span>
              {activeAlertCount > 0 && (
                <span className="w-2 h-2 rounded-full bg-rose-500" />
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono text-rose-400 tabular-nums">
                {activeAlertCount}
              </span>
              <span className="text-xs text-slate-400 font-mono">active increases</span>
            </div>
            <span className="text-[11px] text-slate-400 mt-1 block">
              Click to inspect vendor price creep
            </span>
          </div>

          {/* Card 3: Standardized Master Products */}
          <div
            onClick={() => setActiveTab('catalog')}
            className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-blue-500/50 cursor-pointer transition-colors"
          >
            <span className="text-slate-400 block text-[11px] font-mono uppercase tracking-wider">
              Master Product Catalog
            </span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono text-blue-400 tabular-nums">
                {masterProducts.length}
              </span>
              <span className="text-xs text-slate-400 font-mono">canonical items</span>
            </div>
            <span className="text-[11px] text-slate-400 mt-1 block">
              {reviewItemsCount > 0 ? (
                <span className="text-amber-400 font-medium">{reviewItemsCount} items need review</span>
              ) : (
                'All vendor aliases normalized'
              )}
            </span>
          </div>

          {/* Card 4: Folder Monitor Quick Ingest */}
          <div className="p-4 rounded-xl bg-blue-950/20 border border-blue-900/40 flex flex-col justify-between">
            <div>
              <span className="text-blue-300 block text-[11px] font-mono uppercase tracking-wider flex items-center gap-1.5">
                <FolderSync className="w-3.5 h-3.5 text-blue-400" />
                <span>Folder Monitor</span>
              </span>
              <p className="text-[11px] text-slate-300 mt-1">
                Automated directory sync & multimodal OCR
              </p>
            </div>
            <button
              onClick={() => setIsFolderMonitorOpen(true)}
              className="mt-2.5 w-full py-1.5 px-3 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors flex items-center justify-center gap-1.5"
            >
              <span>Connect or Drop Files</span>
            </button>
          </div>
        </section>

        {/* Tab View Container */}
        {isLoading ? (
          <div className="p-16 text-center text-slate-500 font-mono text-xs">
            Loading SpendPulse procurement database...
          </div>
        ) : (
          <section>
            {activeTab === 'invoices' && (
              <InvoicesView
                invoices={invoices}
                onOpenReviewModal={(invId, it) => {
                  setActiveTab('catalog');
                }}
                onViewProductTrends={handleViewProductTrends}
                onOpenScan={() => setIsScanModalOpen(true)}
                onUpdateLineItem={handleUpdateLineItem}
              />
            )}

            {activeTab === 'alerts' && (
              <PriceAlertsFeed
                alerts={alerts}
                onAcknowledge={handleAcknowledgeAlert}
                onDispute={handleDisputeAlert}
                onViewProductTrends={handleViewProductTrends}
              />
            )}

            {activeTab === 'catalog' && (
              <MasterCatalogView
                products={masterProducts}
                invoices={invoices}
                onMapItem={handleMapItem}
                onApproveMatch={handleApproveMatch}
                onBulkApprove={handleBulkApprove}
                onMergeProducts={handleMergeProducts}
                onFetchProductLines={handleFetchProductLines}
                onSplitProduct={handleSplitProduct}
                unitApi={unitApi}
                onViewProductTrends={handleViewProductTrends}
                onRebuildPriceHistory={handleRebuildPriceHistory}
              />
            )}

            {activeTab === 'vendors' && (
              <SuppliersView
                vendors={vendors}
                onNormalize={handleNormalizeVendors}
                onMerge={handleMergeVendors}
                onRefresh={loadData}
              />
            )}

            {activeTab === 'trends' && (
              <PriceTrendsView
                products={masterProducts}
                selectedProductId={selectedTrendProductId}
                onSelectProduct={setSelectedTrendProductId}
              />
            )}

            {activeTab === 'chat' && (
              <AIChatCopilot
                onNavigateToProduct={(pName) => {
                  const found = masterProducts.find((p) => p.name === pName);
                  if (found) {
                    setSelectedTrendProductId(found.id);
                    setActiveTab('trends');
                  }
                }}
              />
            )}
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 font-mono">
          <div>
            SpendPulse · Autonomous Invoice Intelligence & Price Monitor
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={handleClearAllData}
              className="hover:text-slate-300 transition-colors flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Clear Database</span>
            </button>
            <span className="text-slate-700">·</span>
            <span>DeepSeek Vision Multimodal OCR</span>
          </div>
        </div>
      </footer>

      {/* Modals */}
      <ScanModal
        isOpen={isScanModalOpen}
        onClose={() => setIsScanModalOpen(false)}
        onInvoiceIngested={loadData}
      />

      <FolderMonitor
        isOpen={isFolderMonitorOpen}
        onClose={() => setIsFolderMonitorOpen(false)}
        onInvoiceIngested={loadData}
      />

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
      />
    </div>
  );
}
