import fs from 'fs';
import path from 'path';
import { Invoice, MasterProduct, PriceAlert, InvoiceItem, DashboardStats } from '../types/index.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

export interface DatabaseSchema {
  invoices: Invoice[];
  masterProducts: MasterProduct[];
  alerts: PriceAlert[];
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
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('Error loading database, initializing empty database:', err);
    }

    const emptyData: DatabaseSchema = {
      invoices: [],
      masterProducts: [],
      alerts: [],
      inboxFiles: [],
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
