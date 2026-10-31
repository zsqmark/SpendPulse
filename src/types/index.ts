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
  /** The invoice's own weight column, in kg. Separate from quantity on meat invoices. */
  weight?: number | null;
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
  /**
   * Why priceComparable is false: 'first_purchase' | 'no_price' | 'implausible_gap' |
   * 'unit_differs'. Drives the short label the invoice view prints under "Not compared".
   */
  notComparableCode?: string | null;
  /** The same thing in full, with the two figures that could not be compared. */
  notComparableReason?: string | null;
  /**
   * The price re-quoted the way the catalogue always shows it: $/L when the name states a
   * capacity, $/kg when it states a weight, $/ea when it states neither. Meat keeps the
   * per-kilo price taken from the invoice's weight column.
   */
  standardUnitPrice?: number | null;
  /** The unit behind standardUnitPrice - 'L' | 'kg' | 'ea'. */
  standardUnit?: 'L' | 'kg' | 'ea' | null;
  /** What the supplier counts the goods in - 按瓶 'bottle' | 按包 'bag' | 按个 'ea'. */
  standardSellingUnit?: 'bottle' | 'bag' | 'ea' | null;
  /** Tax rate printed for this line, when the supplier states one. */
  taxRate?: number | null;
  /** Category this line was filed under by alignment, inherited from the catalogue. */
  category?: string | null;
  /** What historical alignment did to this line, and why. Kept with the line so the
   *  invoice view can show where each value came from without a round trip. */
  alignment?: LineAlignment | null;
}

/* ---------------------------------------------------------------------------
 * Historical alignment
 *
 * A new invoice is compared against what the same product looked like the last
 * time it was bought, and the fields that must stay consistent across invoices
 * (unit, pack size, tax rate, category) are aligned to the historical value.
 * What the document actually printed is never thrown away.
 * ------------------------------------------------------------------------- */

/** The fields alignment is allowed to touch. */
export const ALIGNED_FIELDS = ['unit', 'packSize', 'taxRate', 'category'] as const;
export type AlignedField = (typeof ALIGNED_FIELDS)[number];

/** Where the value now on the line came from. */
export type AlignmentSource =
  /** The document printed it and history agreed, or history had nothing to say. */
  | 'document'
  /** The document left it blank and history filled it in. */
  | 'history'
  /** The two disagreed but were convertible, so the document value was converted. */
  | 'converted'
  /** Neither side had a value. */
  | 'empty';

/** How the line was identified against history. */
export type AlignmentIdentityKind =
  /** Matched on the supplier's own item code. */
  | 'sku'
  /** Matched on normalised name + pack size. */
  | 'name_spec'
  /** No history at all - this is the first time the product has been seen. */
  | 'new';

/** What happened to one field. */
export interface FieldAlignment {
  field: AlignedField;
  /** The value written to the line. Null when neither side had one. */
  value: string | null;
  /** Exactly what the document printed, kept for audit. Never overwritten by alignment. */
  documentValue: string | null;
  /** What history said, before any conversion. */
  historyValue: string | null;
  source: AlignmentSource;
  /** True when the document and history disagreed. */
  conflict: boolean;
  /** Set when the disagreement was reconciled by converting the document value. */
  convertedFrom?: string | null;
  /** The factor the value was multiplied by to reach 'value'. */
  conversionFactor?: number | null;
  /** Why a conflict could not be reconciled, in plain English. */
  note?: string | null;
}

/** A disagreement that a human has to settle. */
export interface AlignmentConflict {
  field: AlignedField;
  documentValue: string | null;
  historyValue: string | null;
  reason: string;
  /**
   * 'kept_document' - no conversion exists, so the printed value was left alone.
   * 'accepted_history' - the historical value was applied; nothing numeric was at stake.
   */
  resolution: 'kept_document' | 'accepted_history';
}

/** The result of aligning one line, stored on the line itself. */
export interface LineAlignment {
  /** The key history was looked up under, e.g. "sku:t & d trading pty ltd|cm22b". */
  identityKey: string;
  identityKind: AlignmentIdentityKind;
  /** Null on a first sighting. */
  matchedProductId?: string | null;
  /** True when nothing was found in history - the line seeds it instead. */
  isFirstEntry: boolean;
  fields: FieldAlignment[];
  conflicts: AlignmentConflict[];
  /** True when a conflict is waiting for a human, or validation refused the result. */
  needsReview: boolean;
  /** The unit price the document printed, before any conversion moved it. */
  originalUnitPrice?: number | null;
  /** False when the aligned result failed its pre-write checks and was discarded. */
  validated: boolean;
  validationErrors: string[];
  /**
   * A hash of the whole outcome. Re-processing the same document produces the same
   * fingerprint, which is how a repeated upload is recognised instead of logged twice.
   */
  fingerprint: string;
  alignedAt: string;
}

/** One line's alignment, as an audit record. */
export interface AlignmentLogEntry {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  vendorName: string;
  itemId: string;
  itemDescription: string;
  productId?: string | null;
  productName?: string | null;
  identityKey: string;
  identityKind: AlignmentIdentityKind;
  isFirstEntry: boolean;
  /** Only the fields that were filled in or moved. */
  changes: FieldAlignment[];
  conflicts: AlignmentConflict[];
  needsReview: boolean;
  validated: boolean;
  validationErrors: string[];
  fingerprint: string;
  /** Set when a human settles the conflict; the chosen value is recorded verbatim. */
  resolvedAt?: string | null;
  resolution?: 'accepted_history' | 'kept_document' | null;
  resolvedValue?: string | null;
  createdAt: string;
}

/**
 * The history library: what a product has consistently looked like, keyed by the
 * identity that found it. Every field keeps every value ever observed, so a value
 * that OCR flips between cannot take the record with it.
 */
export interface ProductAttributeRecord {
  key: string;
  kind: 'sku' | 'name_spec';
  vendorName: string;
  sku?: string | null;
  name?: string | null;
  packSize?: string | null;
  productId?: string | null;
  productName?: string | null;
  /**
   * One entry per invoice the identity has been seen on, newest appended. Re-processing
   * an invoice REPLACES its entry rather than adding another, which is what keeps a
   * repeated upload from skewing the record.
   */
  samples: {
    invoiceNumber: string;
    invoiceDate?: string | null;
    values: Partial<Record<AlignedField, string | null>>;
  }[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * What came of a split: the server's refusal, or the product the lines now belong to.
 * The name matters - a new card is easy to lose among two hundred products.
 */
export interface SplitOutcome {
  error: string | null;
  targetId?: string | null;
  targetName?: string | null;
  moved?: number | null;
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
  /**
   * Set once a bill is settled / reconciled and must not be re-edited. A locked invoice is
   * offered in the unit-of-measure editor but cannot be ticked - see `lockedReason`.
   */
  locked?: boolean;
  /** Why the invoice is locked, shown verbatim to the user. e.g. "Settled 2026-10-30". */
  lockedReason?: string | null;
}

/**
 * How far a unit-of-measure change reaches. There is deliberately NO default: the user has
 * to pick one, because silently rewriting every invoice of a product is not recoverable by
 * eye and the pack maths behind every price alert depends on the unit label.
 */
export type UnitChangeScope = 'all' | 'selected';

/** Why a particular invoice line cannot take a new unit. */
export type UnitChangeBlockReason =
  | 'invoice_locked'
  | 'invoice_processing'
  | 'invoice_error'
  | 'meat_weight_priced';

/** One invoice as offered by the unit-of-measure editor. */
export interface ProductUnitInvoice {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  vendorName: string;
  status: InvoiceStatus;
  locked: boolean;
  /** Every distinct unit this product's lines carry on this invoice ("Carton", "Unit"). */
  units: string[];
  /** The same list joined for display: "Carton, Unit". */
  unitSummary: string;
  lineCount: number;
  packSize: string | null;
  unitPrice: number | null;
  /** True when nothing on this invoice may be re-labelled. */
  blocked: boolean;
  /** Machine-readable reason, for icons and grouping. */
  blockReason: UnitChangeBlockReason | null;
  /** Sentence shown when the row is disabled. */
  blockMessage: string | null;
  /** True when an unresolved price alert already points at this invoice for this product. */
  hasOpenAlert: boolean;
  lines: ProductUnitLine[];
}

export interface ProductUnitLine {
  itemId: string;
  rawDescription: string;
  unit: string;
  packSize: string | null;
  unitPrice: number;
  quantity: number | null;
  totalPrice: number;
  /** Meat lines are priced from the invoice's own Weight column, so their unit is fixed. */
  blocked: boolean;
  blockReason: UnitChangeBlockReason | null;
}

export interface ProductUnitContext {
  product: MasterProduct;
  unitOptions: { value: string; label: string; level: string }[];
  invoices: ProductUnitInvoice[];
}

/** What one executed change would do, before anything is written. */
export interface UnitChangePreview {
  productId: string;
  productName: string;
  newUnit: string;
  newUnitLabel: string;
  scope: UnitChangeScope;
  invoiceCount: number;
  lineCount: number;
  /** The units currently in force across the affected lines. */
  fromUnits: string[];
  perInvoice: {
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    vendorName: string;
    fromUnits: string[];
    lineCount: number;
    unitPrice: number | null;
  }[];
  skippedInvoices: {
    invoiceId: string;
    invoiceNumber: string;
    reason: string;
  }[];
  /** Things worth knowing that do not stop the change. */
  warnings: string[];
}

/** One line's before/after, kept so the change can be undone exactly. */
export interface UnitChangeLineSnapshot {
  invoiceId: string;
  invoiceNumber: string;
  itemId: string;
  previousUnit: string;
  newUnit: string;
}

/**
 * A completed unit-of-measure change. Kept forever (even once reverted) so there is always
 * an answer to "who relabelled this product, when, and which invoices did it touch".
 */
export interface UnitChangeRecord {
  id: string;
  productId: string;
  productName: string;
  /** 'change' for a user edit, 'revert' for undoing one. The log keeps both directions. */
  kind: 'change' | 'revert';
  /** For a revert: the id of the record it undid. */
  revertsRecordId?: string | null;
  scope: UnitChangeScope;
  newUnit: string;
  /** Mixed when the affected lines did not all carry one unit; otherwise that unit. */
  fromUnit: string | null;
  changedAt: string;
  invoiceIds: string[];
  invoiceNumbers: string[];
  lineCount: number;
  lines: UnitChangeLineSnapshot[];
  /** Invoices that were selected but refused, with the reason. */
  skipped: { invoiceId: string; invoiceNumber: string; reason: string }[];
  /** Open price alerts touching these invoices at the time of the change - surfaced, never deleted. */
  openAlertsAtChange: number;
  revertedAt?: string | null;
  revertedByRecordId?: string | null;
}

/** One invoice line as seen from the catalogue, with the measure it is priced by. */
export interface CatalogLine {
  invoiceId: string;
  itemId: string;
  invoiceNumber: string;
  invoiceDate: string;
  vendorName: string;
  rawDescription: string;
  unit?: string | null;
  packSize?: string | null;
  unitPrice: number;
  quantity?: number | null;
  /** 'weight' | 'volume' | 'count', or null when neither the pack nor the unit says. */
  measure: string | null;
  /** True when this line's measure clashes with the product it has been filed under. */
  conflicts: boolean;
}

export interface ProductLinesPayload {
  product: MasterProduct;
  productMeasure: string | null;
  lines: CatalogLine[];
}

/** Result of executing a unit-of-measure change. */
export interface UnitChangeResult {
  success: boolean;
  record: UnitChangeRecord;
  changedLines: number;
  affectedInvoices: number;
  /** Open alerts still pointing at the invoices that were relabelled. Surfaced, not deleted. */
  openAlertsAffected: number;
}

export interface MasterProduct {
  id: string;
  sku: string;
  name: string;
  category: string;
  standardUnit: string;
  standardPackSize?: string;
  /**
   * Tax rate the catalogue holds for this product. Filled in from the invoices that
   * carry one, and used by alignment to populate lines whose supplier left it blank.
   */
  taxRate?: number | null;
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
    /**
     * The pack printed on the invoice this entry came from. Kept because the product's own
     * conversion table can be missing the unit, and one readable pack string is all a
     * conversion needs.
     */
    packSize?: string | null;
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
  /** The invoice's weight column, in kg. For meat this is the measure that is priced. */
  weight?: number | null;
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
