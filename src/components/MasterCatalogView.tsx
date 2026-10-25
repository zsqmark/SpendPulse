import React, { useState } from 'react';
import { MasterProduct, Invoice } from '../types/index.ts';
import {
  PackageCheck,
  Search,
  Plus,
  Tag,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  TrendingUp,
  Sparkles,
  Layers,
  CheckCheck,
  Building2,
  SlidersHorizontal,
  ChevronRight,
  Info,
  Scale,
  Barcode,
  RefreshCw,
  ArrowUpDown,
  ArrowDownAZ,
  ArrowUpZA,
  Combine,
  Boxes,
} from 'lucide-react';
import { formatBaseUnit, formatBasePrice, describePackHierarchy } from '../lib/units.ts';
import { formatLineMeasure, isMeatLine } from '../lib/meatPricing.ts';

interface MasterCatalogViewProps {
  products: MasterProduct[];
  invoices: Invoice[];
  onMapItem: (params: {
    invoiceId: string;
    itemId: string;
    masterProductId?: string;
    createNew?: boolean;
    newProductData?: {
      name: string;
      category: string;
      standardUnit: string;
      standardPackSize?: string;
      sku: string;
    };
  }) => Promise<void>;
  onApproveMatch?: (invoiceId: string, itemId: string, masterProductId: string) => Promise<void>;
  onBulkApprove?: (approvals: { invoiceId: string; itemId: string; masterProductId: string }[]) => Promise<void>;
  onMergeProducts?: (primaryId: string, mergeIds: string[]) => Promise<void>;
  onViewProductTrends: (productId: string) => void;
  /**
   * Replays every stored invoice to rebuild price history with the invoicing unit attached,
   * which is what lets the pack hierarchy convert old prices.
   */
  onRebuildPriceHistory?: () => Promise<any>;
}

/** Price per base unit of the most recent purchase, when the pack hierarchy is known. */
function latestBasePrice(prod: MasterProduct): { value: number; unit: string } | null {
  const history = prod.priceHistory || [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.baseUnitPrice != null && prod.baseUnit) {
      return { value: entry.baseUnitPrice, unit: prod.baseUnit };
    }
  }
  return null;
}

export const MasterCatalogView: React.FC<MasterCatalogViewProps> = ({
  products,
  invoices,
  onMapItem,
  onApproveMatch,
  onBulkApprove,
  onMergeProducts,
  onViewProductTrends,
  onRebuildPriceHistory,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [workbenchFilter, setWorkbenchFilter] = useState<'all' | 'probable' | 'novel'>('all');
  const [workbenchSortBy, setWorkbenchSortBy] = useState<
    'confidence_asc' | 'confidence_desc' | 'price_desc' | 'price_asc' | 'unit_price_desc' | 'vendor' | 'date_desc' | 'name'
  >('confidence_asc');

  // Master Catalog sorting state
  const [catalogSortBy, setCatalogSortBy] = useState<
    'name_asc' | 'name_desc' | 'price_desc' | 'price_asc' | 'recent' | 'sku' | 'aliases'
  >('name_asc');

  // Dropdown list sorting state
  const [dropdownSortBy, setDropdownSortBy] = useState<
    'name_asc' | 'category' | 'price_desc' | 'price_asc' | 'sku'
  >('name_asc');

  // Review item state
  const [selectedReviewProduct, setSelectedReviewProduct] = useState<Record<string, string>>({});
  const [isMappingLoading, setIsMappingLoading] = useState<string | null>(null);
  const [isBulkApproving, setIsBulkApproving] = useState(false);

  // Manual merge state: user picks products they know are the same item
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [primaryMergeId, setPrimaryMergeId] = useState<string>('');
  const [isMerging, setIsMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<string | null>(null);

  // Rebuilding price history replays the stored invoices, which do carry the invoicing unit.
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<string | null>(null);

  const runRebuild = async () => {
    if (!onRebuildPriceHistory) return;
    setIsRebuilding(true);
    setRebuildResult(null);
    try {
      const result = await onRebuildPriceHistory();
      if (result) {
        setRebuildResult(
          `Rebuilt ${result.entriesRebuilt} price records across ${result.productsUpdated} products · ${result.conversionsLearned} pack hierarchies learned.`
        );
      } else {
        setRebuildResult('Could not rebuild the price history.');
      }
    } finally {
      setIsRebuilding(false);
    }
  };

  // New product modal state
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [modalItemContext, setModalItemContext] = useState<{
    invoiceId: string;
    itemId: string;
    rawDescription: string;
    unit: string;
    supplierSku?: string | null;
    packSize?: string | null;
  } | null>(null);

  const [newProdName, setNewProdName] = useState('');
  const [newProdCategory, setNewProdCategory] = useState('Dry Goods & Baking');
  const [newProdUnit, setNewProdUnit] = useState('ea');
  const [newProdPackSize, setNewProdPackSize] = useState('');
  const [newProdSku, setNewProdSku] = useState('');

  // Collect all items needing mapping review from invoices
  const pendingReviewItems: {
    invoiceId: string;
    invoiceNumber: string;
    vendorName: string;
    invoiceDate: string;
    item: any;
  }[] = [];

  invoices.forEach((inv) => {
    inv.items.forEach((item) => {
      if (item.needsMappingReview || !item.masterProductId) {
        pendingReviewItems.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          vendorName: inv.vendorName,
          invoiceDate: inv.invoiceDate,
          item,
        });
      }
    });
  });

  // Filter items into Probable Matches (60% - 84%) and Novel (<60%)
  const probableMatches = pendingReviewItems.filter((p) => {
    const conf = p.item.matchConfidence || 0;
    const hasSuggested = Boolean(p.item.suggestedMasterId || p.item.masterProductId);
    return conf >= 0.60 && hasSuggested;
  });

  const novelItems = pendingReviewItems.filter((p) => {
    const conf = p.item.matchConfidence || 0;
    const hasSuggested = Boolean(p.item.suggestedMasterId || p.item.masterProductId);
    return conf < 0.60 || !hasSuggested;
  });

  const displayedReviewItems =
    workbenchFilter === 'probable'
      ? probableMatches
      : workbenchFilter === 'novel'
      ? novelItems
      : pendingReviewItems;

  const sortedReviewItems = [...displayedReviewItems].sort((a, b) => {
    if (workbenchSortBy === 'confidence_asc') {
      return (a.item.matchConfidence || 0) - (b.item.matchConfidence || 0);
    }
    if (workbenchSortBy === 'confidence_desc') {
      return (b.item.matchConfidence || 0) - (a.item.matchConfidence || 0);
    }
    if (workbenchSortBy === 'price_desc') {
      return (b.item.totalPrice || 0) - (a.item.totalPrice || 0);
    }
    if (workbenchSortBy === 'price_asc') {
      return (a.item.totalPrice || 0) - (b.item.totalPrice || 0);
    }
    if (workbenchSortBy === 'unit_price_desc') {
      return (b.item.unitPrice || 0) - (a.item.unitPrice || 0);
    }
    if (workbenchSortBy === 'vendor') {
      return a.vendorName.localeCompare(b.vendorName);
    }
    if (workbenchSortBy === 'date_desc') {
      return b.invoiceDate.localeCompare(a.invoiceDate);
    }
    if (workbenchSortBy === 'name') {
      return a.item.rawDescription.localeCompare(b.item.rawDescription);
    }
    return 0;
  });

  const categories = Array.from(new Set(products.map((p) => p.category).filter(Boolean)));

  const filteredProducts = products.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.vendorAliases.some(
        (a) =>
          a.aliasName.toLowerCase().includes(searchTerm.toLowerCase()) ||
          a.vendorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (a.supplierSku && a.supplierSku.toLowerCase().includes(searchTerm.toLowerCase()))
      );

    const matchesCategory = selectedCategory === 'all' || p.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const sortedProducts = [...filteredProducts].sort((a, b) => {
    if (catalogSortBy === 'name_asc') return a.name.localeCompare(b.name);
    if (catalogSortBy === 'name_desc') return b.name.localeCompare(a.name);
    if (catalogSortBy === 'price_desc') return b.currentPrice - a.currentPrice;
    if (catalogSortBy === 'price_asc') return a.currentPrice - b.currentPrice;
    if (catalogSortBy === 'recent') return (b.lastPurchaseDate || '').localeCompare(a.lastPurchaseDate || '');
    if (catalogSortBy === 'sku') return a.sku.localeCompare(b.sku);
    if (catalogSortBy === 'aliases') return (b.vendorAliases?.length || 0) - (a.vendorAliases?.length || 0);
    return 0;
  });

  // ---- Manual merge helpers ----
  const selectedProducts = mergeSelection
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is MasterProduct => Boolean(p));
  const mergeTargetId =
    selectedProducts.some((p) => p.id === primaryMergeId) && primaryMergeId
      ? primaryMergeId
      : selectedProducts[0]?.id || '';
  const mergeTarget = selectedProducts.find((p) => p.id === mergeTargetId) || null;
  const canMerge = selectedProducts.length >= 2 && !!mergeTarget;

  const toggleMergeSelection = (id: string) => {
    setMergeResult(null);
    setMergeSelection((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      if (!next.includes(primaryMergeId)) setPrimaryMergeId(next[0] || '');
      return next;
    });
  };

  const runMerge = async () => {
    if (!canMerge || !onMergeProducts) return;
    setIsMerging(true);
    try {
      await onMergeProducts(
        mergeTargetId,
        selectedProducts.filter((p) => p.id !== mergeTargetId).map((p) => p.id)
      );
      setMergeResult(
        `Merged ${selectedProducts.length} products into "${mergeTarget?.name}".`
      );
      setMergeSelection([]);
      setPrimaryMergeId('');
    } finally {
      setIsMerging(false);
    }
  };

  const sortedDropdownProducts = [...products].sort((a, b) => {
    if (dropdownSortBy === 'name_asc') return a.name.localeCompare(b.name);
    if (dropdownSortBy === 'price_desc') return b.currentPrice - a.currentPrice;
    if (dropdownSortBy === 'price_asc') return a.currentPrice - b.currentPrice;
    if (dropdownSortBy === 'category') return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
    if (dropdownSortBy === 'sku') return a.sku.localeCompare(b.sku);
    return 0;
  });

  // 1-Click single approval handler
  const handleApprove = async (invoiceId: string, itemId: string, targetMasterId: string) => {
    setIsMappingLoading(itemId);
    try {
      if (onApproveMatch) {
        await onApproveMatch(invoiceId, itemId, targetMasterId);
      } else {
        await onMapItem({
          invoiceId,
          itemId,
          masterProductId: targetMasterId,
        });
      }
    } finally {
      setIsMappingLoading(null);
    }
  };

  // 1-Click bulk approval handler
  const handleBulkApproveAll = async () => {
    if (probableMatches.length === 0) return;
    setIsBulkApproving(true);
    try {
      const approvals = probableMatches.map((p) => ({
        invoiceId: p.invoiceId,
        itemId: p.item.id,
        masterProductId: p.item.suggestedMasterId || p.item.masterProductId,
      })).filter((a) => Boolean(a.masterProductId));

      if (onBulkApprove && approvals.length > 0) {
        await onBulkApprove(approvals);
      } else {
        for (const app of approvals) {
          await onMapItem(app);
        }
      }
    } finally {
      setIsBulkApproving(false);
    }
  };

  const openCreateModal = (context?: {
    invoiceId: string;
    itemId: string;
    rawDescription: string;
    unit: string;
    supplierSku?: string | null;
    packSize?: string | null;
  }) => {
    if (context) {
      setModalItemContext(context);
      setNewProdName(context.rawDescription.replace(/\b(sysco|usf|gfs)\b/gi, '').trim());
      setNewProdUnit(context.unit || 'ea');
      setNewProdPackSize(context.packSize || '');
      setNewProdSku(context.supplierSku || `SKU-${Math.floor(1000 + Math.random() * 9000)}`);
    } else {
      setModalItemContext(null);
      setNewProdName('');
      setNewProdUnit('ea');
      setNewProdPackSize('');
      setNewProdSku(`SKU-${Math.floor(1000 + Math.random() * 9000)}`);
    }
    setIsCreatingNew(true);
  };

  const handleSaveNewProduct = async () => {
    if (!newProdName.trim()) return;
    setIsMappingLoading('new-product-modal');
    try {
      if (modalItemContext) {
        await onMapItem({
          invoiceId: modalItemContext.invoiceId,
          itemId: modalItemContext.itemId,
          createNew: true,
          newProductData: {
            name: newProdName.trim(),
            category: newProdCategory,
            standardUnit: newProdUnit,
            standardPackSize: newProdPackSize || undefined,
            sku: newProdSku.trim() || `SKU-${Math.floor(1000 + Math.random() * 9000)}`,
          },
        });
      } else {
        // Direct catalog entry
        const dummyInvoiceId = `inv-manual-${Date.now()}`;
        const dummyItemId = `item-manual-${Date.now()}`;
        await onMapItem({
          invoiceId: dummyInvoiceId,
          itemId: dummyItemId,
          createNew: true,
          newProductData: {
            name: newProdName.trim(),
            category: newProdCategory,
            standardUnit: newProdUnit,
            standardPackSize: newProdPackSize || undefined,
            sku: newProdSku.trim() || `SKU-${Math.floor(1000 + Math.random() * 9000)}`,
          },
        });
      }
      setIsCreatingNew(false);
    } finally {
      setIsMappingLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* SECTION 1: RECONCILIATION WORKBENCH */}
      {pendingReviewItems.length > 0 && (
        <div className="border border-slate-800 rounded-xl bg-slate-900/60 p-5 space-y-4 shadow-sm">
          {/* Workbench Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-amber-400">
                <SlidersHorizontal className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <span>Reconciliation Workbench & Match Intelligence</span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    {pendingReviewItems.length} Needs Review
                  </span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Multi-tier waterfall engine matches supplier SKU codes, pack weights, and token stems across vendors
                </p>
              </div>
            </div>

            {/* Filter Tabs, Sort Selector & Bulk Approve Action */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center p-1 bg-slate-950/80 border border-slate-800 rounded-lg text-xs font-mono">
                <button
                  onClick={() => setWorkbenchFilter('all')}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    workbenchFilter === 'all'
                      ? 'bg-slate-800 text-white font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  All ({pendingReviewItems.length})
                </button>
                <button
                  onClick={() => setWorkbenchFilter('probable')}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    workbenchFilter === 'probable'
                      ? 'bg-amber-500/20 text-amber-300 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Probable 60–84% ({probableMatches.length})
                </button>
                <button
                  onClick={() => setWorkbenchFilter('novel')}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    workbenchFilter === 'novel'
                      ? 'bg-slate-800 text-white font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Novel &lt;60% ({novelItems.length})
                </button>
              </div>

              {/* Workbench Sorting Control */}
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-950/80 border border-slate-800 rounded-lg text-xs">
                <ArrowUpDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="text-slate-500 font-mono text-[11px] hidden sm:inline">Sort Queue:</span>
                <select
                  value={workbenchSortBy}
                  onChange={(e) => setWorkbenchSortBy(e.target.value as any)}
                  className="bg-transparent text-slate-200 text-xs focus:outline-none cursor-pointer font-mono"
                >
                  <option value="confidence_asc" className="bg-slate-900 text-slate-200">Confidence (Lowest First)</option>
                  <option value="confidence_desc" className="bg-slate-900 text-slate-200">Confidence (Highest First)</option>
                  <option value="price_desc" className="bg-slate-900 text-slate-200">Line Amount (High → Low)</option>
                  <option value="price_asc" className="bg-slate-900 text-slate-200">Line Amount (Low → High)</option>
                  <option value="unit_price_desc" className="bg-slate-900 text-slate-200">Unit Price (High → Low)</option>
                  <option value="vendor" className="bg-slate-900 text-slate-200">Supplier Name (A → Z)</option>
                  <option value="date_desc" className="bg-slate-900 text-slate-200">Invoice Date (Newest)</option>
                  <option value="name" className="bg-slate-900 text-slate-200">Item Name (A → Z)</option>
                </select>
              </div>

              {probableMatches.length > 0 && (
                <button
                  disabled={isBulkApproving}
                  onClick={handleBulkApproveAll}
                  className="px-3 py-1.5 text-xs font-semibold text-emerald-100 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
                >
                  {isBulkApproving ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <CheckCheck className="w-3.5 h-3.5" />
                  )}
                  <span>Approve All {probableMatches.length} Probable Matches (1-Click)</span>
                </button>
              )}
            </div>
          </div>

          {/* Workbench Item Cards */}
          <div className="space-y-3">
            {sortedReviewItems.map(({ invoiceId, invoiceNumber, vendorName, invoiceDate, item }) => {
              const suggestedProduct = item.suggestedMasterId
                ? products.find((p) => p.id === item.suggestedMasterId)
                : item.masterProductId
                ? products.find((p) => p.id === item.masterProductId)
                : null;

              const confidence = item.matchConfidence || 0;
              const isProbable = confidence >= 0.60 && suggestedProduct;
              const breakdown = item.confidenceBreakdown || {
                skuMatch: Boolean(item.supplierSku && suggestedProduct?.sku === item.supplierSku),
                packMatch: Boolean(item.packSize && suggestedProduct?.standardPackSize),
                nameScore: confidence,
              };

              return (
                <div
                  key={item.id}
                  className="p-4 rounded-xl bg-slate-950/80 border border-slate-800/90 hover:border-slate-750 transition-all text-xs"
                >
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
                    {/* Left: Invoiced Item Context (5 Cols) */}
                    <div className="lg:col-span-5 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-100 text-sm font-mono">
                          {item.rawDescription}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-slate-400 font-mono text-[11px]">
                        <span className="inline-flex items-center gap-1 text-slate-300">
                          <Building2 className="w-3 h-3 text-slate-500" />
                          {vendorName}
                        </span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-400">#{invoiceNumber}</span>
                        <span className="text-slate-600">·</span>
                        <span>{invoiceDate}</span>
                        {item.pageNumber && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span className="px-1.5 py-0.2 rounded bg-blue-950/60 text-blue-300 border border-blue-900/40 text-[10px]">
                              Page {item.pageNumber}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                        {item.supplierSku ? (
                          <span className="px-1.5 py-0.5 rounded bg-blue-950/60 text-blue-300 border border-blue-800/40 inline-flex items-center gap-1">
                            <Barcode className="w-3 h-3" />
                            SKU: {item.supplierSku}
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-slate-900 text-slate-500 border border-slate-800">
                            No SKU printed
                          </span>
                        )}

                        {item.packSize && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800 inline-flex items-center gap-1">
                            <Scale className="w-3 h-3 text-slate-500" />
                            Pack: {item.packSize}
                          </span>
                        )}

                        <span className="text-slate-300 font-bold ml-1">
                          ${item.unitPrice.toFixed(2)} /{item.unit}
                        </span>
                        {/* Meat lines are measured by weight, not by the carton count. */}
                        <span className="text-slate-500">
                          ({isMeatLine(item) ? 'Weight' : 'Qty'}: {formatLineMeasure(item)} ·
                          Total: ${item.totalPrice.toFixed(2)})
                        </span>
                      </div>
                    </div>

                    {/* Middle: Match Intelligence & Diagnostics (4 Cols) */}
                    <div className="lg:col-span-4 p-3 rounded-lg bg-slate-900/60 border border-slate-800 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase font-mono tracking-wider text-slate-500">
                          Suggested Canonical Match
                        </span>
                        <span
                          className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded ${
                            isProbable
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {(confidence * 100).toFixed(0)}% Match
                        </span>
                      </div>

                      {suggestedProduct ? (
                        <div className="space-y-1">
                          <div className="font-semibold text-slate-200 text-xs flex items-center gap-1.5">
                            <PackageCheck className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                            <span>{suggestedProduct.name}</span>
                            <span className="text-[10px] font-mono text-slate-400">
                              ({suggestedProduct.sku})
                            </span>
                          </div>

                          {/* Confidence Breakdown Indicators */}
                          <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono pt-1">
                            <span
                              className={`px-1.5 py-0.5 rounded border ${
                                breakdown.skuMatch
                                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
                                  : 'bg-slate-950 text-slate-500 border-slate-850'
                              }`}
                            >
                              SKU: {breakdown.skuMatch ? 'Exact Match' : 'Unmatched'}
                            </span>

                            <span
                              className={`px-1.5 py-0.5 rounded border ${
                                breakdown.packMatch
                                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
                                  : 'bg-rose-950/40 text-rose-300 border-rose-800/40'
                              }`}
                            >
                              Pack:{' '}
                              {suggestedProduct.standardPackSize
                                ? suggestedProduct.standardPackSize
                                : 'Standard'}
                            </span>

                            <span className="text-slate-400">
                              Sim: {Math.round(breakdown.nameScore * 100)}%
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="text-slate-500 text-xs italic py-1">
                          No matching catalog product found. Recommended to create as new.
                        </div>
                      )}
                    </div>

                    {/* Right: Actions (3 Cols) */}
                    <div className="lg:col-span-3 flex flex-col gap-2 shrink-0">
                      {suggestedProduct ? (
                        <button
                          disabled={isMappingLoading === item.id}
                          onClick={() => handleApprove(invoiceId, item.id, suggestedProduct.id)}
                          className="w-full px-3 py-2 text-xs font-semibold text-emerald-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded-lg shadow-sm transition-colors flex items-center justify-center gap-1.5 font-sans"
                        >
                          {isMappingLoading === item.id ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4 text-emerald-900" />
                          )}
                          <span>Approve Match</span>
                        </button>
                      ) : null}

                      {/* Alternate manual selection dropdown with multiple sort modes */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                          <span>Map to Master:</span>
                          <span className="flex items-center gap-1">
                            <span className="text-slate-600">Sort:</span>
                            <select
                              value={dropdownSortBy}
                              onChange={(e) => setDropdownSortBy(e.target.value as any)}
                              className="bg-slate-950 text-slate-300 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] focus:outline-none focus:border-blue-500 cursor-pointer"
                            >
                              <option value="name_asc" className="bg-slate-900 text-slate-200">Name (A → Z)</option>
                              <option value="category" className="bg-slate-900 text-slate-200">By Category</option>
                              <option value="price_desc" className="bg-slate-900 text-slate-200">Price (High → Low)</option>
                              <option value="price_asc" className="bg-slate-900 text-slate-200">Price (Low → High)</option>
                              <option value="sku" className="bg-slate-900 text-slate-200">SKU Code</option>
                            </select>
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <select
                            value={selectedReviewProduct[item.id] || ''}
                            onChange={(e) =>
                              setSelectedReviewProduct((prev) => ({
                                ...prev,
                                [item.id]: e.target.value,
                              }))
                            }
                            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-blue-500 font-mono"
                          >
                            <option value="">Choose Master ({sortedDropdownProducts.length} available)...</option>
                            {dropdownSortBy === 'category' ? (
                              categories.map((cat) => {
                                const prodsInCat = sortedDropdownProducts.filter((p) => p.category === cat);
                                if (prodsInCat.length === 0) return null;
                                return (
                                  <optgroup key={cat} label={cat} className="bg-slate-900 font-semibold text-slate-400">
                                    {prodsInCat.map((p) => (
                                      <option key={p.id} value={p.id} className="bg-slate-950 text-slate-200 font-normal">
                                        {p.name} · ${p.currentPrice.toFixed(2)} ({p.sku})
                                      </option>
                                    ))}
                                  </optgroup>
                                );
                              })
                            ) : (
                              sortedDropdownProducts.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} · ${p.currentPrice.toFixed(2)} ({p.sku})
                                </option>
                              ))
                            )}
                          </select>

                          {selectedReviewProduct[item.id] && (
                            <button
                              disabled={isMappingLoading === item.id}
                              onClick={() =>
                                handleApprove(invoiceId, item.id, selectedReviewProduct[item.id])
                              }
                              className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shrink-0 transition-colors"
                            >
                              Set
                            </button>
                          )}
                        </div>
                      </div>

                      <button
                        onClick={() =>
                          openCreateModal({
                            invoiceId,
                            itemId: item.id,
                            rawDescription: item.rawDescription,
                            unit: item.unit,
                            supplierSku: item.supplierSku,
                            packSize: item.packSize,
                          })
                        }
                        className="w-full px-2.5 py-1 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-900 hover:bg-slate-850 border border-slate-800 rounded-lg transition-colors text-center"
                      >
                        + Create as New Product
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SECTION 2: STANDARDIZED PRODUCT MASTER CATALOG */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <PackageCheck className="w-5 h-5 text-blue-400" />
              <span>Standardized Product Master Catalog</span>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                {products.length} Products
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Canonical product records aggregating multi-vendor descriptions, supplier SKUs, pack weights, and price histories
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search standard product, SKU, or alias..."
                className="bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/60 w-60"
              />
            </div>

            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-blue-500/60"
            >
              <option value="all">All Categories ({categories.length})</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            {/* Catalog Sorting Control */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs">
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="text-slate-500 font-mono text-[11px] hidden sm:inline">Sort:</span>
              <select
                value={catalogSortBy}
                onChange={(e) => setCatalogSortBy(e.target.value as any)}
                className="bg-transparent text-slate-200 text-xs focus:outline-none cursor-pointer font-mono"
              >
                <option value="name_asc" className="bg-slate-900 text-slate-200">Name (A → Z)</option>
                <option value="name_desc" className="bg-slate-900 text-slate-200">Name (Z → A)</option>
                <option value="price_desc" className="bg-slate-900 text-slate-200">Price (High → Low)</option>
                <option value="price_asc" className="bg-slate-900 text-slate-200">Price (Low → High)</option>
                <option value="recent" className="bg-slate-900 text-slate-200">Recent Purchase Date</option>
                <option value="sku" className="bg-slate-900 text-slate-200">SKU Code (A → Z)</option>
                <option value="aliases" className="bg-slate-900 text-slate-200">Most Aliases</option>
              </select>
            </div>

            {onRebuildPriceHistory && (
              <button
                onClick={runRebuild}
                disabled={isRebuilding}
                title="Replay every stored invoice so each price record carries the unit it was invoiced in - only then can the pack hierarchy convert it."
                className="px-3 py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
              >
                {isRebuilding ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Boxes className="w-3.5 h-3.5" />
                )}
                <span>Rebuild Price History</span>
              </button>
            )}

            <button
              onClick={() => openCreateModal()}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Master Product</span>
            </button>
          </div>
        </div>

        {rebuildResult && (
          <div className="px-3 py-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 text-xs text-emerald-300">
            {rebuildResult}
          </div>
        )}

        {/* Manual merge bar - appears once 2+ products are ticked */}
        {mergeSelection.length > 0 && (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-xl border border-blue-800/40 bg-blue-950/20">
            <div className="flex items-center gap-2 text-xs">
              <Combine className="w-4 h-4 text-blue-400 shrink-0" />
              <span className="text-slate-200">
                <strong className="text-blue-300">{mergeSelection.length}</strong> selected
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">
                {canMerge
                  ? 'Choose which record survives, then merge.'
                  : 'Tick at least 2 products to merge.'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={mergeTargetId}
                onChange={(e) => setPrimaryMergeId(e.target.value)}
                disabled={!canMerge}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/60 max-w-[240px]"
              >
                {selectedProducts.map((p) => (
                  <option key={p.id} value={p.id} className="bg-slate-900 text-slate-200">
                    Keep: {p.name}
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
                  setMergeSelection([]);
                  setPrimaryMergeId('');
                  setMergeResult(null);
                }}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 rounded-lg transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {mergeResult && (
          <div className="px-3 py-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 text-xs text-emerald-300">
            {mergeResult}
          </div>
        )}

        {/* Product Ledger List */}
        <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40 divide-y divide-slate-850">
          {sortedProducts.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-xs">
              No master products found. Upload an invoice or click "+ New Master Product" to create your canonical catalog.
            </div>
          ) : (
            sortedProducts.map((prod) => (
              <div
                key={prod.id}
                onClick={() => toggleMergeSelection(prod.id)}
                className={`p-4 hover:bg-slate-900/30 transition-colors cursor-pointer ${
                  mergeSelection.includes(prod.id) ? 'bg-blue-950/20' : ''
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  {/* Product Title & Info */}
                  <div className="space-y-1.5 flex-1">
                    {(() => {
                      const hierarchy = describePackHierarchy(prod.unitConversions, prod.baseUnit);
                      const base = latestBasePrice(prod);
                      return hierarchy ? (
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
                          <span
                            title="How the packs nest, and the single measure every price is compared on."
                            className="px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-300 border border-emerald-800/40 inline-flex items-center gap-1"
                          >
                            <Boxes className="w-2.5 h-2.5" />
                            {hierarchy}
                          </span>
                          {base ? (
                            <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800">
                              {formatBasePrice(base.value, base.unit)}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <div className="text-[10px] font-mono">
                          <span
                            title="Without a pack size, prices in different units cannot be converted, so they are recorded but never compared."
                            className="px-2 py-0.5 rounded bg-slate-900 text-slate-500 border border-slate-800 inline-flex items-center gap-1"
                          >
                            <Info className="w-2.5 h-2.5" />
                            pack size unknown - prices not compared
                          </span>
                        </div>
                      );
                    })()}
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={mergeSelection.includes(prod.id)}
                        onChange={() => toggleMergeSelection(prod.id)}
                        onClick={(e) => e.stopPropagation()}
                        title="Select to merge with another product"
                        className="w-3.5 h-3.5 accent-blue-500 cursor-pointer shrink-0"
                      />
                      <span className="text-xs font-mono font-bold text-blue-400 bg-blue-950/60 border border-blue-800/40 px-2 py-0.5 rounded">
                        {prod.sku}
                      </span>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-slate-300 font-medium">{prod.category}</span>
                      {prod.standardPackSize && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span className="text-xs font-mono text-slate-400 inline-flex items-center gap-1">
                            <Scale className="w-3 h-3 text-slate-500" />
                            {prod.standardPackSize}
                          </span>
                        </>
                      )}
                    </div>

                    <h3 className="text-base font-bold text-slate-100">{prod.name}</h3>

                    <div className="text-xs text-slate-400 font-mono">
                      Base Unit: <strong className="text-slate-200">{prod.standardUnit}</strong> · Primary Supplier: <strong className="text-slate-200">{prod.primaryVendor || 'Wholesale'}</strong>
                    </div>

                    {/* Registered Vendor Aliases & SKUs */}
                    {prod.vendorAliases && prod.vendorAliases.length > 0 && (
                      <div className="pt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                          Linked Vendor Aliases ({prod.vendorAliases.length}):
                        </span>
                        {prod.vendorAliases.map((alias, idx) => (
                          <span
                            key={idx}
                            className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800 flex items-center gap-1"
                          >
                            <span className="text-slate-400 font-semibold">{alias.vendorName}:</span>
                            <span>{alias.aliasName}</span>
                            {alias.supplierSku && (
                              <span className="text-blue-400 text-[10px] font-mono bg-blue-950/60 px-1 rounded">
                                #{alias.supplierSku}
                              </span>
                            )}
                            {alias.packSize && (
                              <span className="text-amber-300 text-[10px] font-mono bg-amber-950/40 px-1 rounded">
                                {alias.packSize}
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Pricing Overview & Trends Button */}
                  <div className="flex flex-wrap items-center gap-6 font-mono text-xs shrink-0">
                    <div>
                      <span className="text-slate-500 block text-[10px] uppercase">Current Rate</span>
                      <span className="text-base font-bold text-slate-100 tabular-nums">
                        ${prod.currentPrice.toFixed(2)}
                      </span>
                      <span className="text-slate-400 text-[11px]"> /{prod.standardUnit}</span>
                    </div>

                    <div>
                      <span className="text-slate-500 block text-[10px] uppercase">Historic Range</span>
                      <span className="text-slate-300 font-semibold tabular-nums">
                        ${prod.minPrice.toFixed(2)} – ${prod.maxPrice.toFixed(2)}
                      </span>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onViewProductTrends(prod.id);
                      }}
                      className="px-3 py-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 bg-blue-950/40 hover:bg-blue-900/40 border border-blue-800/40 rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <TrendingUp className="w-3.5 h-3.5" />
                      <span>Price Trends</span>
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* CREATE NEW MASTER PRODUCT MODAL */}
      {isCreatingNew && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <PackageCheck className="w-4 h-4 text-blue-400" />
                <span>Create Standard Master Product</span>
              </h3>
              <button
                onClick={() => setIsCreatingNew(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1 font-medium">Canonical Product Name</label>
                <input
                  type="text"
                  value={newProdName}
                  onChange={(e) => setNewProdName(e.target.value)}
                  placeholder="e.g. Sugar, Granulated Pure Cane 50 lb"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Category</label>
                  <select
                    value={newProdCategory}
                    onChange={(e) => setNewProdCategory(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500"
                  >
                    <option value="Dry Goods & Baking">Dry Goods & Baking</option>
                    <option value="Dairy & Eggs">Dairy & Eggs</option>
                    <option value="Oils & Shortening">Oils & Shortening</option>
                    <option value="Produce & Fresh">Produce & Fresh</option>
                    <option value="Meat & Seafood">Meat & Seafood</option>
                    <option value="Packaging & Disposables">Packaging & Disposables</option>
                    <option value="Chemicals & Sanitation">Chemicals & Sanitation</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Base Unit</label>
                  <input
                    type="text"
                    value={newProdUnit}
                    onChange={(e) => setNewProdUnit(e.target.value)}
                    placeholder="bag, case, lb, gal"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Standard Pack Size</label>
                  <input
                    type="text"
                    value={newProdPackSize}
                    onChange={(e) => setNewProdPackSize(e.target.value)}
                    placeholder="e.g. 50 lb, 4/1 gal"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Master SKU Code</label>
                  <input
                    type="text"
                    value={newProdSku}
                    onChange={(e) => setNewProdSku(e.target.value)}
                    placeholder="e.g. SKU-1049"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
              </div>

              {modalItemContext && (
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800 text-[11px] text-slate-400 font-mono">
                  Linking vendor description: <span className="text-slate-200">{modalItemContext.rawDescription}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                onClick={() => setIsCreatingNew(false)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                disabled={!newProdName.trim() || isMappingLoading === 'new-product-modal'}
                onClick={handleSaveNewProduct}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-1.5"
              >
                {isMappingLoading === 'new-product-modal' && (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                )}
                <span>Save Master Product</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
