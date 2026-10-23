import { db } from './storage.ts';

// Safely serialize values into SQL literal text.
// Escapes BOTH backslashes and single quotes (single-quote doubling alone is NOT sufficient
// when a value can contain a backslash), and emits NULL for missing/non-finite numbers.
function sqlStr(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v).replace(/\\/g, '\\\\').replace(/'/g, "''");
  return `'${s}'`;
}

function sqlNum(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

export function generateCsvExport(): string {
  const invoices = db.getInvoices();
  const headers = [
    'Invoice Number',
    'Vendor Name',
    'Invoice Date',
    'Due Date',
    'Raw Item Description',
    'Standard Master Product',
    'Category',
    'Quantity',
    'Unit',
    'Unit Price',
    'Total Price',
    'Previous Price',
    'Price Delta',
    'Price Delta Pct',
    'Is Scanned',
    'Status',
  ];

  const rows: string[] = [headers.join(',')];

  invoices.forEach((inv) => {
    inv.items.forEach((item) => {
      const row = [
        `"${inv.invoiceNumber}"`,
        `"${inv.vendorName.replace(/"/g, '""')}"`,
        `"${inv.invoiceDate}"`,
        `"${inv.dueDate || ''}"`,
        `"${item.rawDescription.replace(/"/g, '""')}"`,
        `"${(item.masterProductName || 'Unmapped').replace(/"/g, '""')}"`,
        `"${(item.masterProductId ? db.getMasterProduct(item.masterProductId)?.category : 'N/A') || 'N/A'}"`,
        item.quantity,
        `"${item.unit}"`,
        item.unitPrice.toFixed(2),
        item.totalPrice.toFixed(2),
        item.previousPrice != null ? item.previousPrice.toFixed(2) : '',
        item.priceDelta != null ? item.priceDelta.toFixed(2) : '',
        item.priceDeltaPercent != null ? `${item.priceDeltaPercent.toFixed(2)}%` : '',
        inv.isScanned ? 'YES' : 'NO',
        `"${inv.status}"`,
      ];
      rows.push(row.join(','));
    });
  });

  return rows.join('\n');
}

export function generateJsonExport(): string {
  const fullData = {
    exportDate: new Date().toISOString(),
    invoices: db.getInvoices(),
    masterProducts: db.getMasterProducts(),
    alerts: db.getAlerts(),
    stats: db.getStats(),
  };
  return JSON.stringify(fullData, null, 2);
}

export function generateSqlDump(): string {
  const invoices = db.getInvoices();
  const products = db.getMasterProducts();
  const alerts = db.getAlerts();

  let sql = `-- SpendPulse Database Export Dump
-- Generated at: ${new Date().toISOString()}

BEGIN TRANSACTION;

-- Master Products Catalog
CREATE TABLE IF NOT EXISTS master_products (
  id VARCHAR(64) PRIMARY KEY,
  sku VARCHAR(64) UNIQUE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(128),
  standard_unit VARCHAR(32),
  current_price NUMERIC(10,2),
  previous_price NUMERIC(10,2),
  min_price NUMERIC(10,2),
  max_price NUMERIC(10,2),
  last_purchase_date DATE,
  primary_vendor VARCHAR(255)
);

-- Invoices Table
CREATE TABLE IF NOT EXISTS invoices (
  id VARCHAR(64) PRIMARY KEY,
  file_name VARCHAR(255),
  vendor_name VARCHAR(255) NOT NULL,
  invoice_number VARCHAR(128) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE,
  subtotal NUMERIC(10,2),
  tax_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2),
  currency VARCHAR(10) DEFAULT 'USD',
  status VARCHAR(32),
  is_scanned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP
);

-- Invoice Line Items Table
CREATE TABLE IF NOT EXISTS invoice_items (
  id VARCHAR(64) PRIMARY KEY,
  invoice_id VARCHAR(64) REFERENCES invoices(id),
  raw_description TEXT NOT NULL,
  master_product_id VARCHAR(64) REFERENCES master_products(id),
  quantity NUMERIC(10,2) NOT NULL,
  unit VARCHAR(32),
  unit_price NUMERIC(10,2) NOT NULL,
  total_price NUMERIC(10,2) NOT NULL,
  previous_price NUMERIC(10,2),
  price_delta NUMERIC(10,2),
  price_delta_percent NUMERIC(10,2),
  match_confidence NUMERIC(3,2),
  needs_mapping_review BOOLEAN DEFAULT FALSE
);

-- Price Increase Alerts Table
CREATE TABLE IF NOT EXISTS price_alerts (
  id VARCHAR(64) PRIMARY KEY,
  master_product_id VARCHAR(64) REFERENCES master_products(id),
  product_name VARCHAR(255) NOT NULL,
  vendor_name VARCHAR(255) NOT NULL,
  invoice_id VARCHAR(64) REFERENCES invoices(id),
  invoice_number VARCHAR(128),
  invoice_date DATE,
  previous_price NUMERIC(10,2),
  new_price NUMERIC(10,2),
  delta_amount NUMERIC(10,2),
  percent_change NUMERIC(10,2),
  unit VARCHAR(32),
  detected_at TIMESTAMP,
  status VARCHAR(32) DEFAULT 'active'
);

`;

  // Insert master products
  for (const p of products) {
    sql += `INSERT INTO master_products (id, sku, name, category, standard_unit, current_price, previous_price, min_price, max_price, last_purchase_date, primary_vendor) VALUES (${sqlStr(p.id)}, ${sqlStr(p.sku)}, ${sqlStr(p.name)}, ${sqlStr(p.category)}, ${sqlStr(p.standardUnit)}, ${sqlNum(p.currentPrice)}, ${sqlNum(p.previousPrice)}, ${sqlNum(p.minPrice)}, ${sqlNum(p.maxPrice)}, ${sqlStr(p.lastPurchaseDate)}, ${sqlStr(p.primaryVendor)}) ON CONFLICT (id) DO NOTHING;\n`;
  }

  // Insert invoices & items
  for (const inv of invoices) {
    sql += `INSERT INTO invoices (id, file_name, vendor_name, invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, currency, status, is_scanned, created_at) VALUES (${sqlStr(inv.id)}, ${sqlStr(inv.fileName)}, ${sqlStr(inv.vendorName)}, ${sqlStr(inv.invoiceNumber)}, ${sqlStr(inv.invoiceDate)}, ${inv.dueDate ? sqlStr(inv.dueDate) : 'NULL'}, ${sqlNum(inv.subtotal)}, ${sqlNum(inv.taxAmount)}, ${sqlNum(inv.totalAmount)}, ${sqlStr(inv.currency)}, ${sqlStr(inv.status)}, ${inv.isScanned ? 'TRUE' : 'FALSE'}, ${sqlStr(inv.createdAt)}) ON CONFLICT (id) DO NOTHING;\n`;

    for (const it of inv.items) {
      sql += `INSERT INTO invoice_items (id, invoice_id, raw_description, master_product_id, quantity, unit, unit_price, total_price, previous_price, price_delta, price_delta_percent, match_confidence, needs_mapping_review) VALUES (${sqlStr(it.id)}, ${sqlStr(inv.id)}, ${sqlStr(it.rawDescription)}, ${it.masterProductId ? sqlStr(it.masterProductId) : 'NULL'}, ${sqlNum(it.quantity)}, ${sqlStr(it.unit)}, ${sqlNum(it.unitPrice)}, ${sqlNum(it.totalPrice)}, ${it.previousPrice != null ? sqlNum(it.previousPrice) : 'NULL'}, ${it.priceDelta != null ? sqlNum(it.priceDelta) : 'NULL'}, ${it.priceDeltaPercent != null ? sqlNum(it.priceDeltaPercent) : 'NULL'}, ${sqlNum(it.matchConfidence)}, ${it.needsMappingReview ? 'TRUE' : 'FALSE'}) ON CONFLICT (id) DO NOTHING;\n`;
    }
  }

  // Insert alerts
  for (const a of alerts) {
    sql += `INSERT INTO price_alerts (id, master_product_id, product_name, vendor_name, invoice_id, invoice_number, invoice_date, previous_price, new_price, delta_amount, percent_change, unit, detected_at, status) VALUES (${sqlStr(a.id)}, ${sqlStr(a.masterProductId)}, ${sqlStr(a.productName)}, ${sqlStr(a.vendorName)}, ${sqlStr(a.invoiceId)}, ${sqlStr(a.invoiceNumber)}, ${sqlStr(a.invoiceDate)}, ${sqlNum(a.previousPrice)}, ${sqlNum(a.newPrice)}, ${sqlNum(a.deltaAmount)}, ${sqlNum(a.percentChange)}, ${sqlStr(a.unit)}, ${sqlStr(a.detectedAt)}, ${sqlStr(a.status)}) ON CONFLICT (id) DO NOTHING;\n`;
  }

  sql += '\nCOMMIT;\n';
  return sql;
}
