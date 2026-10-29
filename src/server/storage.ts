import fs from 'fs';
import path from 'path';
import {
  Invoice,
  MasterProduct,
  PriceAlert,
  InvoiceItem,
  DashboardStats,
  UnitChangeRecord,
  ProductAttributeRecord,
  AlignmentLogEntry,
} from '../types/index.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

export interface DatabaseSchema {
  invoices: Invoice[];
  masterProducts: MasterProduct[];
  alerts: PriceAlert[];
  /** Every unit-of-measure change ever applied, newest first. Never pruned - it is the audit trail. */
  unitChangeLog: UnitChangeRecord[];
  /**
   * The history library alignment reads from: what a product has consistently looked
   * like, keyed by the supplier's item code or by name + pack size.
   */
  productAttributes: ProductAttributeRecord[];
  /** One entry per aligned line, newest first. Never pruned - it is the audit trail. */
  alignmentLog: AlignmentLogEntry[];
  inboxFiles: {
    fileName: string;
    filePath: string;
    size: number;
    detectedAt: string;
    status: 'unprocessed' | 'processing' | 'processed' | 'failed';
  }[];
}

class StorageEngine {
  private data: DatabaseSchema;

  constructor() {
    this.data = this.loadData();
  }

  private loadData(): DatabaseSchema {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Older database files simply have no unit-change log yet.
        if (!Array.isArray(parsed.unitChangeLog)) parsed.unitChangeLog = [];
        if (!Array.isArray(parsed.productAttributes)) parsed.productAttributes = [];
        if (!Array.isArray(parsed.alignmentLog)) parsed.alignmentLog = [];
        return parsed as DatabaseSchema;
      }
    } catch (err) {
      console.error('Error loading database, initializing empty database:', err);
    }

    const emptyData: DatabaseSchema = {
      invoices: [],
      masterProducts: [],
      alerts: [],
      inboxFiles: [],
      unitChangeLog: [],
      productAttributes: [],
      alignmentLog: [],
    };

    this.saveData(emptyData);
    return emptyData;
  }

  private saveData(data: DatabaseSchema) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error writing database file:', err);
    }
  }

  public getInvoices(): Invoice[] {
    return this.data.invoices;
  }

  public getInvoice(id: string): Invoice | undefined {
    return this.data.invoices.find((inv) => inv.id === id);
  }

  public addInvoice(invoice: Invoice): Invoice {
    this.data.invoices.unshift(invoice);
    this.saveData(this.data);
    return invoice;
  }

  public updateInvoice(id: string, updates: Partial<Invoice>): Invoice | undefined {
    const idx = this.data.invoices.findIndex((inv) => inv.id === id);
    if (idx === -1) return undefined;
    this.data.invoices[idx] = { ...this.data.invoices[idx], ...updates };
    this.saveData(this.data);
    return this.data.invoices[idx];
  }

  /** Removes one invoice outright. Callers must rebuild any product it fed. */
  public deleteInvoice(id: string): boolean {
    const before = this.data.invoices.length;
    this.data.invoices = this.data.invoices.filter((inv) => inv.id !== id);
    if (this.data.invoices.length === before) return false;
    this.saveData(this.data);
    return true;
  }

  public getMasterProducts(): MasterProduct[] {
    return this.data.masterProducts;
  }

  public getMasterProduct(id: string): MasterProduct | undefined {
    return this.data.masterProducts.find((p) => p.id === id);
  }

  public saveMasterProduct(product: MasterProduct): MasterProduct {
    const idx = this.data.masterProducts.findIndex((p) => p.id === product.id);
    if (idx >= 0) {
      this.data.masterProducts[idx] = product;
    } else {
      this.data.masterProducts.push(product);
    }
    this.saveData(this.data);
    return product;
  }

  public deleteMasterProduct(id: string): boolean {
    const idx = this.data.masterProducts.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.data.masterProducts.splice(idx, 1);
    this.saveData(this.data);
    return true;
  }

  public getAlerts(): PriceAlert[] {
    return this.data.alerts;
  }

  public updateAlert(id: string, updates: Partial<PriceAlert>): PriceAlert | undefined {
    const alert = this.data.alerts.find((a) => a.id === id);
    if (!alert) return undefined;
    Object.assign(alert, updates);
    this.saveData(this.data);
    return alert;
  }

  public addAlert(alert: PriceAlert): PriceAlert {
    this.data.alerts.unshift(alert);
    this.saveData(this.data);
    return alert;
  }

  /** Drops alerts that no longer stand up, e.g. after the price history was rebuilt. */
  public pruneAlerts(shouldKeep: (alert: PriceAlert) => boolean): number {
    const before = this.data.alerts.length;
    this.data.alerts = this.data.alerts.filter(shouldKeep);
    const removed = before - this.data.alerts.length;
    if (removed > 0) this.saveData(this.data);
    return removed;
  }

  /** Removes alerts raised by an invoice line the user later corrected. */
  public deleteAlertsFor(invoiceId: string, masterProductId: string): number {
    const before = this.data.alerts.length;
    this.data.alerts = this.data.alerts.filter(
      (a) => !(a.invoiceId === invoiceId && a.masterProductId === masterProductId)
    );
    const removed = before - this.data.alerts.length;
    if (removed > 0) this.saveData(this.data);
    return removed;
  }

  public updateAlertStatus(id: string, status: 'active' | 'acknowledged' | 'disputed'): PriceAlert | undefined {
    const alert = this.data.alerts.find((a) => a.id === id);
    if (alert) {
      alert.status = status;
      this.saveData(this.data);
    }
    return alert;
  }

  /** Every unit-of-measure change, newest first. The audit trail for this feature. */
  public getUnitChangeLog(): UnitChangeRecord[] {
    return this.data.unitChangeLog;
  }

  public getUnitChangeRecordsFor(productId: string): UnitChangeRecord[] {
    return this.data.unitChangeLog.filter((r) => r.productId === productId);
  }

  public addUnitChangeRecord(record: UnitChangeRecord): UnitChangeRecord {
    this.data.unitChangeLog.unshift(record);
    this.saveData(this.data);
    return record;
  }

  public updateUnitChangeRecord(
    id: string,
    updates: Partial<UnitChangeRecord>
  ): UnitChangeRecord | undefined {
    const record = this.data.unitChangeLog.find((r) => r.id === id);
    if (!record) return undefined;
    Object.assign(record, updates);
    this.saveData(this.data);
    return record;
  }

  /* ------------------------------------------------- historical alignment ---- */

  public getProductAttributes(): ProductAttributeRecord[] {
    return this.data.productAttributes;
  }

  public getProductAttribute(key: string): ProductAttributeRecord | undefined {
    return this.data.productAttributes.find((r) => r.key === key);
  }

  /** Finds the record for a line, trying the keys in the order given (most reliable first). */
  public findProductAttribute(
    keys: { key: string; kind: 'sku' | 'name_spec' }[]
  ): { record: ProductAttributeRecord; kind: 'sku' | 'name_spec' } | null {
    for (const k of keys) {
      const record = this.data.productAttributes.find((r) => r.key === k.key);
      if (record) return { record, kind: k.kind };
    }
    return null;
  }

  public saveProductAttribute(record: ProductAttributeRecord): ProductAttributeRecord {
    const idx = this.data.productAttributes.findIndex((r) => r.key === record.key);
    if (idx >= 0) this.data.productAttributes[idx] = record;
    else this.data.productAttributes.push(record);
    this.saveData(this.data);
    return record;
  }

  /**
   * Upserts a batch and writes once. Alignment touches a record per line, and saving
   * the whole database per line turns a 30-page statement into hundreds of full writes.
   */
  public saveProductAttributes(records: ProductAttributeRecord[]): void {
    for (const record of records) {
      const idx = this.data.productAttributes.findIndex((r) => r.key === record.key);
      if (idx >= 0) this.data.productAttributes[idx] = record;
      else this.data.productAttributes.push(record);
    }
    this.saveData(this.data);
  }

  /** Replaces the whole history library. Only used by the replay route, which rebuilds
   *  every record from the invoices that are stored. */
  public replaceProductAttributes(records: ProductAttributeRecord[]): void {
    this.data.productAttributes = records;
    this.saveData(this.data);
  }

  public deleteProductAttribute(key: string): boolean {
    const before = this.data.productAttributes.length;
    this.data.productAttributes = this.data.productAttributes.filter((r) => r.key !== key);
    if (this.data.productAttributes.length === before) return false;
    this.saveData(this.data);
    return true;
  }

  public getAlignmentLog(): AlignmentLogEntry[] {
    return this.data.alignmentLog;
  }

  public getAlignmentLogFor(invoiceId: string): AlignmentLogEntry[] {
    return this.data.alignmentLog.filter((e) => e.invoiceId === invoiceId);
  }

  /**
   * Appends one alignment, unless the very same decision for the same supplier, invoice
   * and product is already recorded. That duplicate check is what makes re-processing an
   * invoice leave the log untouched instead of filling it with copies.
   */
  public addAlignmentLogEntry(entry: AlignmentLogEntry): AlignmentLogEntry {
    const already = this.data.alignmentLog.some(
      (e) =>
        e.vendorName === entry.vendorName &&
        e.invoiceNumber === entry.invoiceNumber &&
        e.identityKey === entry.identityKey &&
        e.fingerprint === entry.fingerprint
    );
    if (already) return entry;
    this.data.alignmentLog.unshift(entry);
    this.saveData(this.data);
    return entry;
  }

  /** Appends a whole invoice's alignments with a single write. */
  public addAlignmentLogEntries(entries: AlignmentLogEntry[]): number {
    let added = 0;
    for (const entry of entries) {
      const already = this.data.alignmentLog.some(
        (e) =>
          e.vendorName === entry.vendorName &&
          e.invoiceNumber === entry.invoiceNumber &&
          e.identityKey === entry.identityKey &&
          e.fingerprint === entry.fingerprint
      );
      if (already) continue;
      this.data.alignmentLog.unshift(entry);
      added += 1;
    }
    if (added > 0) this.saveData(this.data);
    return added;
  }

  /** Drops log entries a predicate rejects. Returns how many went. */
  public pruneAlignmentLog(keep: (entry: AlignmentLogEntry) => boolean): number {
    const before = this.data.alignmentLog.length;
    this.data.alignmentLog = this.data.alignmentLog.filter(keep);
    const removed = before - this.data.alignmentLog.length;
    if (removed > 0) this.saveData(this.data);
    return removed;
  }

  public updateAlignmentLogEntry(
    id: string,
    updates: Partial<AlignmentLogEntry>
  ): AlignmentLogEntry | undefined {
    const entry = this.data.alignmentLog.find((e) => e.id === id);
    if (!entry) return undefined;
    Object.assign(entry, updates);
    this.saveData(this.data);
    return entry;
  }

  public getInboxFiles() {
    return this.data.inboxFiles;
  }

  public addInboxFile(file: DatabaseSchema['inboxFiles'][0]) {
    this.data.inboxFiles.unshift(file);
    this.saveData(this.data);
  }

  public updateInboxFileStatus(fileName: string, status: DatabaseSchema['inboxFiles'][0]['status']) {
    const f = this.data.inboxFiles.find((x) => x.fileName === fileName);
    if (f) {
      f.status = status;
      this.saveData(this.data);
    }
  }

  public getStats(): DashboardStats {
    const totalInvoices = this.data.invoices.length;
    const totalSpend = this.data.invoices.reduce((acc, inv) => acc + (inv.totalAmount || 0), 0);
    const activePriceAlerts = this.data.alerts.filter((a) => a.status === 'active').length;
    
    let unmappedItemsCount = 0;
    this.data.invoices.forEach((inv) => {
      inv.items.forEach((item) => {
        if (item.needsMappingReview || !item.masterProductId) {
          unmappedItemsCount++;
        }
      });
    });

    const vendorSpendMap: Record<string, { spend: number; count: number }> = {};
    this.data.invoices.forEach((inv) => {
      const v = inv.vendorName || 'Unknown Vendor';
      if (!vendorSpendMap[v]) vendorSpendMap[v] = { spend: 0, count: 0 };
      vendorSpendMap[v].spend += inv.totalAmount || 0;
      vendorSpendMap[v].count += 1;
    });

    const topVendors = Object.entries(vendorSpendMap)
      .map(([vendor, d]) => ({ vendor, spend: d.spend, count: d.count }))
      .sort((a, b) => b.spend - a.spend);

    const recentPriceIncreases = this.data.alerts.slice(0, 5);

    return {
      totalInvoices,
      totalSpend,
      activePriceAlerts,
      unmappedItemsCount,
      masterProductsCount: this.data.masterProducts.length,
      topVendors,
      recentPriceIncreases,
    };
  }

  public clearAllData() {
    this.data = {
      invoices: [],
      masterProducts: [],
      alerts: [],
      inboxFiles: [],
      unitChangeLog: [],
      productAttributes: [],
      alignmentLog: [],
    };
    this.saveData(this.data);
    return this.data;
  }

  /** Writes the whole dataset back to disk - used after bulk edits that touch alerts. */
  public persist(): void {
    this.saveData(this.data);
  }

  public resetToDefaults() {
    return this.clearAllData();
  }

  /**
   * Drops only the derived data (catalog + alerts) and detaches every invoice line from
   * its product, so canonicalisation can be replayed without re-running OCR.
   */
  public clearCatalogOnly() {
    this.data.masterProducts = [];
    this.data.alerts = [];
    for (const invoice of this.data.invoices) {
      for (const item of invoice.items) {
        item.masterProductId = null;
        item.masterProductName = null;
        item.needsMappingReview = false;
        item.previousPrice = null;
        item.priceDelta = null;
        item.priceDeltaPercent = null;
        item.matchConfidence = 0;
      }
    }
    this.saveData(this.data);
    return this.data;
  }
}

export const db = new StorageEngine();
