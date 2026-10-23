export type InvoiceStatus = 'processed' | 'needs_review' | 'processing' | 'error';

export interface InvoiceItem {
  id: string;
  rawDescription: string;
  supplierSku?: string | null;
  brand?: string | null;
  packSize?: string | null;
  masterProductId: string | null;
  masterProductName: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  previousPrice?: number | null;
  priceDelta?: number | null;
  priceDeltaPercent?: number | null;
  matchConfidence: number; // 0 to 1
  matchTier?: 'sku_exact' | 'rule_pack_match' | 'ai_semantic' | 'manual';
  needsMappingReview: boolean;
  suggestedMasterId?: string | null;
  suggestedMasterName?: string | null;
  pageNumber?: number;
  confidenceBreakdown?: {
    skuMatch: boolean;
    packMatch: boolean;
    nameScore: number;
  };
  /** Number of identical rows from the source document collapsed into this line. */
  mergedCount?: number;
  /**
   * The invoice price converted into the product's base measure ("$1.20 per kg" for a
   * carton invoiced at $12). Null when the pack hierarchy is unknown, which means the
   * number is not comparable with other invoices.
   */
  baseUnitPrice?: number | null;
  /** The base measure the conversion was made into, e.g. "kg". */
  baseUnit?: string | null;
  /**
   * False when the pack size or the unit means this line cannot be compared with the
   * product's other invoices. The price is still recorded - it is just not judged.
   */
  priceComparable?: boolean | null;
}

/** A stored copy of one page of the original source document. */
export interface InvoiceDocumentPage {
  pageNumber: number;
  mimeType: string;
  url: string;
}

export interface Invoice {
  id: string;
  fileName: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate?: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  status: InvoiceStatus;
  items: InvoiceItem[];
  itemCount: number;
  pageCount?: number;
  notes?: string;
  isScanned: boolean;
  createdAt: string;
  /** Original scan pages kept on the server so extracted values can be verified. */
  documentPages?: InvoiceDocumentPage[];
  /**
   * Order-insensitive fingerprint of the uploaded page images. Used to refuse the same
   * document being imported twice before any OCR is spent.
   */
  contentHash?: string;
}

export interface MasterProduct {
  id: string;
  sku: string;
  name: string;
  category: string;
  standardUnit: string;
  standardPackSize?: string;
  /**
   * The measure every price of this product is converted into before it is compared.
   * Absent when the pack description could not be parsed.
   */
  baseUnit?: string;
  /** canonical unit -> how many base units one of that unit holds ("ctn" -> 10 for 10*1KG). */
  unitConversions?: Record<string, number>;
  currentPrice: number;
  previousPrice: number;
  minPrice: number;
  maxPrice: number;
  lastPurchaseDate: string;
  primaryVendor: string;
  vendorAliases: {
    vendorName: string;
    aliasName: string;
    supplierSku?: string;
    packSize?: string;
    lastSeen: string;
  }[];
  priceHistory: {
    date: string;
    vendor: string;
    unitPrice: number;
    invoiceNumber: string;
    /** The unit the price was invoiced in. Needed to convert history back to a base price. */
    unit?: string;
    /** The same price expressed per base unit, when the conversion is known. */
    baseUnitPrice?: number | null;
  }[];
}

/** What the user is allowed to correct on one extracted line. */
export interface LineItemPatch {
  rawDescription?: string;
  supplierSku?: string | null;
  packSize?: string | null;
  unit?: string;
  quantity?: number;
  unitPrice?: number;
  totalPrice?: number;
}

/** What the server reports back after a line was corrected. */
export interface LineItemUpdateResult {
  comparable: boolean;
  baseUnitPrice: number | null;
  baseUnit: string | null;
  previousPrice: number | null;
  percentChange: number | null;
  alertCreated?: boolean;
  alertRemoved?: number;
}

export interface PriceAlert {
  id: string;
  masterProductId: string;
  productName: string;
  vendorName: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  previousPrice: number;
  newPrice: number;
  deltaAmount: number;
  percentChange: number;
  detectedAt: string;
  status: 'active' | 'acknowledged' | 'disputed';
  unit: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  suggestedActions?: string[];
  referencedProducts?: string[];
}

export interface FolderWatchStatus {
  isSupported: boolean;
  isWatching: boolean;
  folderName: string | null;
  fileCount: number;
  lastChecked: string | null;
  autoSync: boolean;
}

export interface DashboardStats {
  totalInvoices: number;
  totalSpend: number;
  activePriceAlerts: number;
  unmappedItemsCount: number;
  masterProductsCount: number;
  topVendors: { vendor: string; spend: number; count: number }[];
  recentPriceIncreases: PriceAlert[];
}

/** One row on the Suppliers page: a stored vendor name plus how much it is used. */
export interface VendorSummary {
  /** The raw name as currently stored across invoices / catalog / alerts. */
  name: string;
  /** The canonical name normalizeVendorName() would turn it into. */
  normalized: string;
  /** Suffix-stripped, punctuation-free match key (groups likely duplicates). */
  key: string;
  invoices: number;
  spend: number;
  /** Master products whose primaryVendor is this name. */
  products: number;
  /** Catalog vendor-alias entries pointing at this name. */
  aliases: number;
  alerts: number;
}
