import express from 'express';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db } from './src/server/storage.ts';
import { extractInvoiceData, mergeDuplicateLineItems } from './src/server/ocrService.ts';
import { batchMatchItems } from './src/server/aliasMatcher.ts';
import {
  checkAndRecordPriceChange,
  compareAgainstHistory,
} from './src/server/priceAlertService.ts';
import {
  learnPackHierarchy,
  basePriceFor,
  recalculateProductStats,
  rebuildHistoryFromInvoices,
} from './src/server/productUnits.ts';
import { handleProcurementChat } from './src/server/chatService.ts';
import { generateCsvExport, generateJsonExport, generateSqlDump } from './src/server/exportService.ts';
import {
  saveInvoicePages,
  listInvoicePages,
  getInvoicePageFile,
  deleteAllDocuments,
} from './src/server/documentStore.ts';
import { Invoice, InvoiceItem, PriceAlert, MasterProduct, VendorSummary } from './src/types/index.ts';
import { normalizeVendorName, vendorKey } from './src/lib/vendorNormalizer.ts';

dotenv.config();
// .env.local overrides .env (git-ignored local secrets).
dotenv.config({ path: '.env.local', override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Long invoices ship many rasterised pages at once - keep enough headroom for 40+ pages.
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

/**
 * Order-insensitive fingerprint of the uploaded pages, so re-importing the same statement
 * (even with the pages selected in a different order) is recognised before OCR runs.
 */
function fingerprintPages(pages: { base64Data?: string }[]): string {
  const pageHashes = (pages || [])
    .map((p) => (p?.base64Data ? createHash('sha256').update(p.base64Data).digest('hex') : null))
    .filter((h): h is string => Boolean(h))
    .sort();

  if (pageHashes.length === 0) return '';
  return createHash('sha256').update(pageHashes.join('|')).digest('hex');
}

function invoiceSummary(inv: Invoice) {
  return {
    id: inv.id,
    fileName: inv.fileName,
    vendorName: inv.vendorName,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    totalAmount: inv.totalAmount,
    itemCount: inv.itemCount,
    importedAt: inv.createdAt,
  };
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Health check & dashboard stats
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

// 2. Invoices list & single invoice
app.get('/api/invoices', async (req, res) => {
  const invoices = await Promise.all(
    db.getInvoices().map(async (inv) => ({ ...inv, documentPages: await listInvoicePages(inv.id) }))
  );
  res.json(invoices);
});

app.get('/api/invoices/:id', async (req, res) => {
  const inv = db.getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ ...inv, documentPages: await listInvoicePages(inv.id) });
});

// Original source pages, so extracted values can be checked against the scan.
app.get('/api/invoices/:id/pages', async (req, res) => {
  res.json(await listInvoicePages(req.params.id));
});

app.get('/api/invoices/:id/pages/:pageNumber', async (req, res) => {
  const pageNumber = Number.parseInt(req.params.pageNumber, 10);
  if (!Number.isFinite(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });

  const page = await getInvoicePageFile(req.params.id, pageNumber);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type(page.mimeType).sendFile(page.file);
});

// 3. Process Invoice (OCR + Alias Canonicalization + Price Alert Detection)
app.post('/api/invoices/process', async (req, res) => {
  try {
    const { fileName, base64Data, mimeType, textPayload, isScannedManual, pages } = req.body;

    if (!fileName && !base64Data && !textPayload && (!pages || pages.length === 0)) {
      return res.status(400).json({ error: 'Missing document or text content' });
    }

    console.log(`Processing invoice: ${fileName || 'unnamed'} (${pages ? `${pages.length} pages` : 'single binary'})`);

    // Guard 1: identical file content - caught before any OCR is paid for.
    const incomingPages =
      Array.isArray(pages) && pages.length > 0 ? pages : [{ base64Data, mimeType }];
    const contentHash = fingerprintPages(incomingPages);

    if (contentHash) {
      const sameFile = db.getInvoices().find((i) => i.contentHash === contentHash);
      if (sameFile) {
        console.log(`[Dedupe] Identical file already imported as ${sameFile.invoiceNumber} - skipping.`);
        return res.status(409).json({
          error: `Already imported as "${sameFile.invoiceNumber}" from ${sameFile.vendorName}. Skipped to avoid a duplicate.`,
          duplicate: true,
          reason: 'identical_file',
          existingInvoice: invoiceSummary(sameFile),
        });
      }
    }

    // Step 1: Multimodal OCR extraction via DeepSeek Vision
    const extracted = await extractInvoiceData({
      base64Data,
      mimeType,
      textPayload,
      fileName,
      pages,
    });

    // Clean the supplier name before it is stored or used for dedupe, so "T & D TRADING
    // PTY. LTD." and "T & D Trading Pty. Ltd." collapse to one identity going forward.
    if (extracted.vendorName) {
      extracted.vendorName = normalizeVendorName(extracted.vendorName);
    }

    // Guard 2: the same supplier + invoice number + date, e.g. re-uploading one page of a
    // statement that is already stored. Catches duplicates the file hash cannot see.
    if (extracted.invoiceNumber && !extracted.invoiceNumber.startsWith('INV-')) {
      const sameInvoice = db.getInvoices().find(
        (i) =>
          i.vendorName === extracted.vendorName &&
          i.invoiceNumber === extracted.invoiceNumber &&
          i.invoiceDate === extracted.invoiceDate
      );
      if (sameInvoice) {
        console.log(
          `[Dedupe] Invoice ${extracted.invoiceNumber} from ${extracted.vendorName} already stored - skipping.`
        );
        return res.status(409).json({
          error: `Invoice "${extracted.invoiceNumber}" from ${extracted.vendorName} is already imported. Skipped to avoid a duplicate.`,
          duplicate: true,
          reason: 'same_invoice_number',
          existingInvoice: invoiceSummary(sameInvoice),
        });
      }
    }

    // Group repeated rows of the same product before matching, so identical lines
    // (very common across the pages of a long statement) become one catalogue entry.
    const groupedItems = mergeDuplicateLineItems(extracted.items);

    const invoiceId = `inv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const alertsCreated: PriceAlert[] = [];
    const processedItems: InvoiceItem[] = [];

    let hasUnmappedItems = false;
    /** Products already priced in this invoice - later rows of the same invoice never alert. */
    const pricedInThisInvoice = new Set<string>();

    // Prepare line items for single batch matching with multi-tier SKU & pack size
    const rawItemsForBatch = groupedItems.map((it, idx) => ({
      id: `item-${Date.now()}-${idx}`,
      rawDescription: it.rawDescription,
      supplierSku: it.supplierSku,
      brand: it.brand,
      packSize: it.packSize,
      unit: it.unit,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      totalPrice: it.totalPrice,
      pageNumber: it.pageNumber || 1,
      mergedCount: it.mergedCount || 1,
    }));

    const productsBefore = new Set(db.getMasterProducts().map((p) => p.id));
    const batchMatches = await batchMatchItems(rawItemsForBatch, extracted.vendorName);
    // Products created here were seeded from this invoice - they cannot alert against it.
    for (const p of db.getMasterProducts()) {
      if (!productsBefore.has(p.id)) pricedInThisInvoice.add(p.id);
    }

    // Step 2: Canonicalize each line item & check price change
    for (const it of rawItemsForBatch) {
      const match = batchMatches[it.id] || {
        masterProductId: null,
        masterProductName: null,
        confidence: 0,
        matchTier: 'rule_pack_match' as const,
        needsMappingReview: true,
        reasoning: 'Unmapped',
        confidenceBreakdown: { skuMatch: false, packMatch: false, nameScore: 0 },
      };

      let priceCheck: any = {
        hasPriceIncrease: false,
        previousPrice: null,
        deltaAmount: null,
        percentChange: null,
        baseUnitPrice: null,
        baseUnit: null,
        comparable: false,
      };

      if (match.masterProductId && !match.needsMappingReview) {
        priceCheck = checkAndRecordPriceChange({
          masterProductId: match.masterProductId,
          unitPrice: it.unitPrice,
          unit: it.unit,
          packSize: it.packSize,
          vendorName: extracted.vendorName,
          invoiceId,
          invoiceNumber: extracted.invoiceNumber,
          invoiceDate: extracted.invoiceDate,
          suppressAlert: pricedInThisInvoice.has(match.masterProductId),
        });
        pricedInThisInvoice.add(match.masterProductId);

        if (priceCheck.alertCreated) {
          alertsCreated.push(priceCheck.alertCreated);
        }
      } else if (!match.isNonProduct) {
        // Fees/surcharges are not products - they must not put the invoice into review.
        hasUnmappedItems = true;
      }

      processedItems.push({
        id: it.id,
        rawDescription: it.rawDescription,
        supplierSku: it.supplierSku,
        brand: it.brand,
        packSize: it.packSize,
        masterProductId: match.needsMappingReview ? null : match.masterProductId,
        masterProductName: match.needsMappingReview ? null : match.masterProductName,
        quantity: it.quantity,
        unit: it.unit,
        unitPrice: it.unitPrice,
        totalPrice: it.totalPrice,
        previousPrice: priceCheck.previousPrice,
        priceDelta: priceCheck.deltaAmount,
        priceDeltaPercent: priceCheck.percentChange,
        baseUnitPrice: priceCheck.baseUnitPrice,
        baseUnit: priceCheck.baseUnit,
        priceComparable: priceCheck.comparable,
        matchConfidence: match.confidence,
        matchTier: match.matchTier,
        needsMappingReview: match.needsMappingReview,
        suggestedMasterId: match.masterProductId,
        suggestedMasterName: match.masterProductName,
        confidenceBreakdown: match.confidenceBreakdown,
        pageNumber: it.pageNumber,
        mergedCount: it.mergedCount,
      });
    }

    const newInvoice: Invoice = {
      id: invoiceId,
      fileName: fileName || `Invoice_${extracted.invoiceNumber}.pdf`,
      vendorName: extracted.vendorName,
      invoiceNumber: extracted.invoiceNumber,
      invoiceDate: extracted.invoiceDate,
      dueDate: extracted.dueDate,
      subtotal: extracted.subtotal,
      taxAmount: extracted.taxAmount,
      totalAmount: extracted.totalAmount,
      currency: extracted.currency || 'USD',
      status: hasUnmappedItems ? 'needs_review' : 'processed',
      items: processedItems,
      itemCount: processedItems.length,
      pageCount: extracted.pageCount || 1,
      notes: extracted.notes,
      isScanned: isScannedManual ?? extracted.isScanned,
      createdAt: new Date().toISOString(),
      contentHash: contentHash || undefined,
    };

    // Keep the source pages on disk so the extraction can be audited against the scan.
    try {
      await saveInvoicePages(
        invoiceId,
        Array.isArray(pages) && pages.length > 0 ? pages : [{ base64Data, mimeType, pageNumber: 1 }]
      );
      newInvoice.documentPages = await listInvoicePages(invoiceId);
    } catch (docErr: any) {
      // Never fail an otherwise successful OCR run just because archiving failed.
      console.warn(`[Documents] Could not archive source pages for ${invoiceId}: ${docErr.message}`);
    }

    db.addInvoice(newInvoice);

    res.json({
      success: true,
      invoice: newInvoice,
      alertsCreated,
      needsReview: hasUnmappedItems,
    });
  } catch (err: any) {
    console.error('Invoice processing error:', err);
    res.status(500).json({ error: err.message || 'Failed to process invoice' });
  }
});

// 4. Master Product Catalog routes
app.get('/api/catalog', (req, res) => {
  res.json(db.getMasterProducts());
});

// User reviews / confirms an uncertain alias mapping from review queue
app.post('/api/catalog/map-item', (req, res) => {
  try {
    const { invoiceId, itemId, masterProductId, createNew, newProductData } = req.body;
    const invoice = db.getInvoice(invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const item = invoice.items.find((it) => it.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found in invoice' });

    let targetProduct: MasterProduct | undefined;

    if (createNew && newProductData) {
      const newId = `prod-${Date.now()}`;
      targetProduct = {
        id: newId,
        sku: newProductData.sku || item.supplierSku || `SKU-${Date.now().toString().slice(-4)}`,
        name: newProductData.name || item.rawDescription,
        category: newProductData.category || 'General Supplies',
        standardUnit: newProductData.standardUnit || item.unit,
        standardPackSize: newProductData.standardPackSize || item.packSize || undefined,
        currentPrice: item.unitPrice,
        previousPrice: item.unitPrice,
        minPrice: item.unitPrice,
        maxPrice: item.unitPrice,
        lastPurchaseDate: invoice.invoiceDate,
        primaryVendor: invoice.vendorName,
        vendorAliases: [
          {
            vendorName: invoice.vendorName,
            aliasName: item.rawDescription,
            supplierSku: item.supplierSku || undefined,
            packSize: item.packSize || undefined,
            lastSeen: invoice.invoiceDate,
          },
        ],
        priceHistory: [
          {
            date: invoice.invoiceDate,
            vendor: invoice.vendorName,
            unitPrice: item.unitPrice,
            invoiceNumber: invoice.invoiceNumber,
          },
        ],
      };
      db.saveMasterProduct(targetProduct);
    } else if (masterProductId) {
      targetProduct = db.getMasterProduct(masterProductId);
      if (!targetProduct) return res.status(404).json({ error: 'Target master product not found' });

      // Add or update alias with SKU and pack size
      const aliasIdx = targetProduct.vendorAliases.findIndex(
        (a) =>
          a.aliasName.toLowerCase() === item.rawDescription.toLowerCase() ||
          (item.supplierSku && a.supplierSku === item.supplierSku)
      );

      if (aliasIdx >= 0) {
        targetProduct.vendorAliases[aliasIdx].lastSeen = invoice.invoiceDate;
        if (item.supplierSku) targetProduct.vendorAliases[aliasIdx].supplierSku = item.supplierSku;
        if (item.packSize) targetProduct.vendorAliases[aliasIdx].packSize = item.packSize;
      } else {
        targetProduct.vendorAliases.push({
          vendorName: invoice.vendorName,
          aliasName: item.rawDescription,
          supplierSku: item.supplierSku || undefined,
          packSize: item.packSize || undefined,
          lastSeen: invoice.invoiceDate,
        });
      }

      // Check price change
      const priceCheck = checkAndRecordPriceChange({
        masterProductId: targetProduct.id,
        unitPrice: item.unitPrice,
        unit: item.unit,
        packSize: item.packSize,
        vendorName: invoice.vendorName,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
      });

      item.previousPrice = priceCheck.previousPrice;
      item.priceDelta = priceCheck.deltaAmount;
      item.priceDeltaPercent = priceCheck.percentChange;
      item.baseUnitPrice = priceCheck.baseUnitPrice;
      item.baseUnit = priceCheck.baseUnit;
      item.priceComparable = priceCheck.comparable;
      db.saveMasterProduct(targetProduct);
    }

    if (targetProduct) {
      item.masterProductId = targetProduct.id;
      item.masterProductName = targetProduct.name;
      item.needsMappingReview = false;
      item.matchConfidence = 1.0;
      item.matchTier = item.supplierSku ? 'sku_exact' : 'manual';
    }

    // Check if invoice still has items needing review
    const anyStillNeedsReview = invoice.items.some((it) => it.needsMappingReview);
    if (!anyStillNeedsReview && invoice.status === 'needs_review') {
      invoice.status = 'processed';
    }

    db.updateInvoice(invoice.id, invoice);

    res.json({ success: true, invoice, product: targetProduct });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 1-Click single approval for suggested matches from workbench
app.post('/api/catalog/approve-match', (req, res) => {
  try {
    const { invoiceId, itemId, masterProductId } = req.body;
    const invoice = db.getInvoice(invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const item = invoice.items.find((it) => it.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found in invoice' });

    const targetProduct = db.getMasterProduct(masterProductId);
    if (!targetProduct) return res.status(404).json({ error: 'Target master product not found' });

    // Register / update vendor alias with SKU & pack size
    const aliasIdx = targetProduct.vendorAliases.findIndex(
      (a) =>
        a.aliasName.toLowerCase() === item.rawDescription.toLowerCase() ||
        (item.supplierSku && a.supplierSku === item.supplierSku)
    );

    if (aliasIdx >= 0) {
      targetProduct.vendorAliases[aliasIdx].lastSeen = invoice.invoiceDate;
      if (item.supplierSku) targetProduct.vendorAliases[aliasIdx].supplierSku = item.supplierSku;
      if (item.packSize) targetProduct.vendorAliases[aliasIdx].packSize = item.packSize;
    } else {
      targetProduct.vendorAliases.push({
        vendorName: invoice.vendorName,
        aliasName: item.rawDescription,
        supplierSku: item.supplierSku || undefined,
        packSize: item.packSize || undefined,
        lastSeen: invoice.invoiceDate,
      });
    }

    const priceCheck = checkAndRecordPriceChange({
      masterProductId: targetProduct.id,
      unitPrice: item.unitPrice,
      unit: item.unit,
      vendorName: invoice.vendorName,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
    });

    item.masterProductId = targetProduct.id;
    item.masterProductName = targetProduct.name;
    item.needsMappingReview = false;
    item.matchConfidence = 1.0;
    item.matchTier = item.supplierSku ? 'sku_exact' : 'manual';
    item.previousPrice = priceCheck.previousPrice;
    item.priceDelta = priceCheck.deltaAmount;
    item.priceDeltaPercent = priceCheck.percentChange;

    const anyStillNeedsReview = invoice.items.some((it) => it.needsMappingReview);
    if (!anyStillNeedsReview && invoice.status === 'needs_review') {
      invoice.status = 'processed';
    }

    db.updateInvoice(invoice.id, invoice);
    db.saveMasterProduct(targetProduct);

    res.json({
      success: true,
      invoice,
      product: targetProduct,
      alertCreated: priceCheck.alertCreated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk 1-Click Approval for multiple probable matches
app.post('/api/catalog/bulk-approve', (req, res) => {
  try {
    const { approvals } = req.body as {
      approvals: { invoiceId: string; itemId: string; masterProductId: string }[];
    };

    if (!Array.isArray(approvals) || approvals.length === 0) {
      return res.status(400).json({ error: 'No approvals provided' });
    }

    let approvedCount = 0;
    const modifiedInvoices = new Set<string>();

    for (const app of approvals) {
      const invoice = db.getInvoice(app.invoiceId);
      if (!invoice) continue;

      const item = invoice.items.find((it) => it.id === app.itemId);
      if (!item) continue;

      const targetProduct = db.getMasterProduct(app.masterProductId);
      if (!targetProduct) continue;

      const aliasIdx = targetProduct.vendorAliases.findIndex(
        (a) =>
          a.aliasName.toLowerCase() === item.rawDescription.toLowerCase() ||
          (item.supplierSku && a.supplierSku === item.supplierSku)
      );

      if (aliasIdx >= 0) {
        targetProduct.vendorAliases[aliasIdx].lastSeen = invoice.invoiceDate;
        if (item.supplierSku) targetProduct.vendorAliases[aliasIdx].supplierSku = item.supplierSku;
        if (item.packSize) targetProduct.vendorAliases[aliasIdx].packSize = item.packSize;
      } else {
        targetProduct.vendorAliases.push({
          vendorName: invoice.vendorName,
          aliasName: item.rawDescription,
          supplierSku: item.supplierSku || undefined,
          packSize: item.packSize || undefined,
          lastSeen: invoice.invoiceDate,
        });
      }

      const priceCheck = checkAndRecordPriceChange({
        masterProductId: targetProduct.id,
        unitPrice: item.unitPrice,
        unit: item.unit,
        packSize: item.packSize,
        vendorName: invoice.vendorName,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
      });

      item.masterProductId = targetProduct.id;
      item.masterProductName = targetProduct.name;
      item.needsMappingReview = false;
      item.matchConfidence = 1.0;
      item.matchTier = item.supplierSku ? 'sku_exact' : 'manual';
      item.previousPrice = priceCheck.previousPrice;
      item.priceDelta = priceCheck.deltaAmount;
      item.priceDeltaPercent = priceCheck.percentChange;
      item.baseUnitPrice = priceCheck.baseUnitPrice;
      item.baseUnit = priceCheck.baseUnit;
      item.priceComparable = priceCheck.comparable;

      db.saveMasterProduct(targetProduct);
      modifiedInvoices.add(invoice.id);
      approvedCount++;
    }

    for (const invId of modifiedInvoices) {
      const inv = db.getInvoice(invId);
      if (inv) {
        const anyStillNeedsReview = inv.items.some((it) => it.needsMappingReview);
        if (!anyStillNeedsReview && inv.status === 'needs_review') {
          inv.status = 'processed';
        }
        db.updateInvoice(inv.id, inv);
      }
    }

    res.json({ success: true, approvedCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Merge two or more master products the user knows are the same item. Everything attached
// to the absorbed products (aliases, price history, invoice lines, alerts) moves to the
// primary one; the absorbed products are then removed.
app.post('/api/catalog/merge', (req, res) => {
  try {
    const { primaryId, mergeIds } = req.body as { primaryId?: string; mergeIds?: string[] };

    if (!primaryId) return res.status(400).json({ error: 'primaryId is required' });
    if (!Array.isArray(mergeIds) || mergeIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one product to merge' });
    }

    const primary = db.getMasterProduct(primaryId);
    if (!primary) return res.status(404).json({ error: 'Primary product not found' });

    const sources = mergeIds
      .filter((id) => id !== primaryId)
      .map((id) => db.getMasterProduct(id))
      .filter((p): p is MasterProduct => Boolean(p));

    if (sources.length === 0) {
      return res.status(400).json({ error: 'No valid products to merge' });
    }

    let itemsUpdated = 0;
    let aliasesAdded = 0;
    let historyAdded = 0;
    let alertsMoved = 0;

    for (const src of sources) {
      for (const alias of src.vendorAliases || []) {
        const dup = primary.vendorAliases.some(
          (a) =>
            a.aliasName.toLowerCase() === alias.aliasName.toLowerCase() &&
            a.vendorName === alias.vendorName
        );
        if (!dup) {
          primary.vendorAliases.push(alias);
          aliasesAdded++;
        }
      }

      for (const entry of src.priceHistory || []) {
        const dup = primary.priceHistory.some(
          (p) =>
            p.date === entry.date &&
            p.invoiceNumber === entry.invoiceNumber &&
            p.unitPrice === entry.unitPrice
        );
        if (!dup) {
          primary.priceHistory.push(entry);
          historyAdded++;
        }
      }

      for (const invoice of db.getInvoices()) {
        let changed = false;
        for (const item of invoice.items) {
          if (item.masterProductId === src.id) {
            item.masterProductId = primary.id;
            item.masterProductName = primary.name;
            item.needsMappingReview = false;
            changed = true;
            itemsUpdated++;
          }
        }
        if (changed) db.updateInvoice(invoice.id, invoice);
      }

      for (const alert of db.getAlerts()) {
        if (alert.masterProductId === src.id) {
          db.updateAlert(alert.id, { masterProductId: primary.id, productName: primary.name });
          alertsMoved++;
        }
      }

      db.deleteMasterProduct(src.id);
    }

    // Recompute the price envelope from the combined history (oldest -> newest).
    primary.priceHistory.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const prices = primary.priceHistory
      .map((p) => Number(p.unitPrice))
      .filter((p) => Number.isFinite(p) && p > 0);

    if (prices.length > 0) {
      primary.minPrice = Math.min(...prices);
      primary.maxPrice = Math.max(...prices);
      primary.currentPrice = prices[prices.length - 1];
      primary.previousPrice = prices.length > 1 ? prices[prices.length - 2] : prices[0];
      primary.lastPurchaseDate =
        primary.priceHistory[primary.priceHistory.length - 1].date || primary.lastPurchaseDate;
    }

    db.saveMasterProduct(primary);

    console.log(
      `[Merge] "${primary.name}" absorbed ${sources.length} product(s): ${itemsUpdated} line(s), ${aliasesAdded} alias(es), ${historyAdded} price point(s)`
    );

    res.json({
      success: true,
      product: primary,
      mergedCount: sources.length,
      itemsUpdated,
      aliasesAdded,
      historyAdded,
      alertsMoved,
    });
  } catch (err: any) {
    console.error('Merge failed:', err);
    res.status(500).json({ error: err.message || 'Merge failed' });
  }
});

/**
 * Corrects one extracted line. OCR misreads pack sizes and units constantly, and a wrong
 * unit silently poisons every later price comparison, so the user has to be able to fix
 * the line itself.
 *
 * Saving re-teaches the pack hierarchy, rewrites that invoice's history entry and
 * re-judges the price against other invoices with the same rule used at upload time.
 */
app.put('/api/invoices/:invoiceId/items/:itemId', (req, res) => {
  try {
    const invoice = db.getInvoice(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const item = invoice.items.find((it) => it.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line item not found' });

    const body = (req.body || {}) as {
      rawDescription?: string;
      supplierSku?: string | null;
      packSize?: string | null;
      unit?: string;
      quantity?: number;
      unitPrice?: number;
      totalPrice?: number;
    };

    const previousUnitPrice = item.unitPrice;
    const previousLineTotal = item.totalPrice;

    if (body.rawDescription !== undefined) {
      const trimmed = String(body.rawDescription).trim();
      if (trimmed) item.rawDescription = trimmed;
    }
    if (body.supplierSku !== undefined) {
      item.supplierSku = String(body.supplierSku || '').trim() || null;
    }
    if (body.packSize !== undefined) {
      item.packSize = String(body.packSize || '').trim() || null;
    }
    if (body.unit !== undefined) {
      const u = String(body.unit || '').trim();
      if (u) item.unit = u;
    }

    let quantityChanged = false;
    if (body.quantity !== undefined) {
      const q = Number(body.quantity);
      if (Number.isFinite(q) && q >= 0) {
        item.quantity = q;
        quantityChanged = true;
      }
    }

    let unitPriceChanged = false;
    if (body.unitPrice !== undefined) {
      const p = Number(body.unitPrice);
      if (Number.isFinite(p) && p >= 0) {
        item.unitPrice = p;
        unitPriceChanged = true;
      }
    }

    if (body.totalPrice !== undefined) {
      const t = Number(body.totalPrice);
      if (Number.isFinite(t)) item.totalPrice = +t.toFixed(2);
    } else if (quantityChanged || unitPriceChanged) {
      // Keep the line total consistent with the corrected quantity and price.
      item.totalPrice = +(item.quantity * item.unitPrice).toFixed(2);
    }

    let product = item.masterProductId ? db.getMasterProduct(item.masterProductId) : null;
    let comparison: ReturnType<typeof compareAgainstHistory> | null = null;
    let alertRemoved = 0;
    let alertCreated = null as PriceAlert | null;

    if (product) {
      // A corrected pack size is the best source of the carton -> pack relationship.
      if (item.packSize) learnPackHierarchy(product, item.packSize);

      const alias = product.vendorAliases.find(
        (a) =>
          a.aliasName.toLowerCase() === item.rawDescription.toLowerCase() ||
          (item.supplierSku && a.supplierSku === item.supplierSku)
      );
      if (alias) {
        if (item.supplierSku) alias.supplierSku = item.supplierSku;
        if (item.packSize) alias.packSize = item.packSize;
      }

      // Rewrite this invoice's own entry instead of stacking a second one on top of it.
      const target =
        product.priceHistory.findIndex(
          (h) => h.invoiceNumber === invoice.invoiceNumber && h.unitPrice === previousUnitPrice
        ) >= 0
          ? product.priceHistory.findIndex(
              (h) => h.invoiceNumber === invoice.invoiceNumber && h.unitPrice === previousUnitPrice
            )
          : product.priceHistory.findIndex((h) => h.invoiceNumber === invoice.invoiceNumber);

      const entry = {
        date: invoice.invoiceDate,
        vendor: invoice.vendorName,
        unitPrice: item.unitPrice,
        invoiceNumber: invoice.invoiceNumber,
        unit: item.unit,
        baseUnitPrice: basePriceFor(product, item.unitPrice, item.unit),
      };
      if (target >= 0) product.priceHistory[target] = entry;
      else product.priceHistory.push(entry);

      recalculateProductStats(product);
      comparison = compareAgainstHistory(
        product,
        item.unitPrice,
        item.unit,
        invoice.invoiceNumber,
        invoice.invoiceDate
      );

      // An alert raised by the wrong price is not a real increase - drop it, and only
      // raise a new one if the corrected line genuinely is more expensive.
      alertRemoved = db.deleteAlertsFor(invoice.id, product.id);
      if (comparison.isIncrease) {
        const alert: PriceAlert = {
          id: `alert-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          masterProductId: product.id,
          productName: product.name,
          vendorName: invoice.vendorName,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          previousPrice: comparison.previousPrice ?? 0,
          newPrice: item.unitPrice,
          deltaAmount: comparison.deltaAmount ?? 0,
          percentChange: comparison.percentChange ?? 0,
          detectedAt: new Date().toISOString(),
          status: 'active',
          unit: item.unit,
        };
        db.addAlert(alert);
        alertCreated = alert;
      }

      item.previousPrice = comparison.previousPrice;
      item.priceDelta = comparison.deltaAmount;
      item.priceDeltaPercent = comparison.percentChange;
      item.baseUnitPrice = comparison.baseUnitPrice;
      item.baseUnit = comparison.baseUnit;
      item.priceComparable = comparison.comparable;

      db.saveMasterProduct(product);
    }

    // Move the invoice totals by exactly what this line changed. Any gap between the OCR
    // line total and the printed invoice total was there before, so it is left alone.
    const totalDelta = (item.totalPrice || 0) - (previousLineTotal || 0);
    if (Math.abs(totalDelta) > 0.0001) {
      invoice.subtotal = +((invoice.subtotal || 0) + totalDelta).toFixed(2);
      invoice.totalAmount = +((invoice.totalAmount || 0) + totalDelta).toFixed(2);
    }

    db.updateInvoice(invoice.id, invoice);

    res.json({
      success: true,
      invoice,
      item,
      product,
      comparison,
      alertCreated,
      alertRemoved,
    });
  } catch (err: any) {
    console.error('Line item update failed:', err);
    res.status(500).json({ error: err.message || 'Line item update failed' });
  }
});

// Re-runs alias canonicalisation + price alerts over every stored invoice.
// Useful after changing the grouping rules: fixes the catalog without paying for OCR again.
app.post('/api/catalog/regroup', async (req, res) => {
  try {
    const invoices = [...db.getInvoices()].sort((a, b) =>
      (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
    );

    db.clearCatalogOnly();

    let mapped = 0;
    let unmapped = 0;
    let alertsCreated = 0;

    for (const invoice of invoices) {
      const pricedInThisInvoice = new Set<string>();

      // Products created by this batch get their seed price from this very invoice, so
      // they must not alert against it either - only later invoices can show a real trend.
      const productsBefore = new Set(db.getMasterProducts().map((p) => p.id));

      const inputs = invoice.items.map((it) => ({
        id: it.id,
        rawDescription: it.rawDescription,
        supplierSku: it.supplierSku,
        brand: it.brand,
        packSize: it.packSize,
        unit: it.unit,
        unitPrice: it.unitPrice,
        quantity: it.quantity,
        totalPrice: it.totalPrice,
        pageNumber: it.pageNumber || 1,
        mergedCount: it.mergedCount || 1,
      }));

      const matches = await batchMatchItems(inputs, invoice.vendorName);

      for (const p of db.getMasterProducts()) {
        if (!productsBefore.has(p.id)) pricedInThisInvoice.add(p.id);
      }

      for (const it of invoice.items) {
        const match = matches[it.id];
        if (!match) continue;

        it.masterProductId = match.needsMappingReview ? null : match.masterProductId;
        it.masterProductName = match.needsMappingReview ? null : match.masterProductName;
        it.matchConfidence = match.confidence;
        it.matchTier = match.matchTier;
        it.needsMappingReview = match.needsMappingReview;
        it.suggestedMasterId = match.masterProductId;
        it.suggestedMasterName = match.masterProductName;
        it.confidenceBreakdown = match.confidenceBreakdown;

        if (match.isNonProduct) {
          // Fees stay out of the catalog and never block the invoice.
          continue;
        }
        if (it.masterProductId) {
          mapped++;
          const check = checkAndRecordPriceChange({
            masterProductId: it.masterProductId,
            unitPrice: it.unitPrice,
            unit: it.unit,
            packSize: it.packSize,
            vendorName: invoice.vendorName,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            suppressAlert: pricedInThisInvoice.has(it.masterProductId),
          });
          pricedInThisInvoice.add(it.masterProductId);
          it.previousPrice = check.previousPrice;
          it.priceDelta = check.deltaAmount;
          it.priceDeltaPercent = check.percentChange;
          it.baseUnitPrice = check.baseUnitPrice;
          it.baseUnit = check.baseUnit;
          it.priceComparable = check.comparable;
          if (check.alertCreated) alertsCreated++;
        } else {
          unmapped++;
        }
      }

      db.updateInvoice(invoice.id, invoice);
    }

    res.json({
      success: true,
      invoices: invoices.length,
      mapped,
      unmapped,
      alertsCreated,
      masterProducts: db.getMasterProducts().length,
    });
  } catch (err: any) {
    console.error('Regroup failed:', err);
    res.status(500).json({ error: err.message || 'Regroup failed' });
  }
});

/**
 * Rebuilds every product's price history straight from the stored invoices.
 *
 * History recorded before the invoicing unit was kept had no unit, so it could never be
 * converted into a base price. The invoices themselves do carry the unit on every line,
 * so replaying them restores a history that the pack-hierarchy comparison can actually use.
 */
app.post('/api/catalog/rebuild-price-history', (req, res) => {
  try {
    const invoices = [...db.getInvoices()].sort((a, b) =>
      (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
    );

    // productId -> the lines that reference it, in invoice date order.
    const byProduct = new Map<
      string,
      { date: string; vendor: string; unitPrice: number; invoiceNumber: string; unit?: string | null; packSize?: string | null }[]
    >();

    for (const invoice of invoices) {
      for (const item of invoice.items) {
        if (!item.masterProductId) continue;
        if (!Number.isFinite(item.unitPrice) || item.unitPrice <= 0) continue;
        const list = byProduct.get(item.masterProductId) || [];
        list.push({
          date: invoice.invoiceDate,
          vendor: invoice.vendorName,
          unitPrice: item.unitPrice,
          invoiceNumber: invoice.invoiceNumber,
          unit: item.unit,
          packSize: item.packSize,
        });
        byProduct.set(item.masterProductId, list);
      }
    }

    let productsUpdated = 0;
    let entriesRebuilt = 0;
    let conversionsLearned = 0;

    for (const [productId, entries] of byProduct) {
      const product = db.getMasterProduct(productId);
      if (!product) continue;
      const before = product.unitConversions ? Object.keys(product.unitConversions).length : 0;
      entriesRebuilt += rebuildHistoryFromInvoices(product, entries);
      const after = product.unitConversions ? Object.keys(product.unitConversions).length : 0;
      if (after > before) conversionsLearned++;
      productsUpdated++;
      db.saveMasterProduct(product);
    }

    // Refresh what each invoice line shows now that the history is comparable.
    for (const invoice of invoices) {
      for (const item of invoice.items) {
        if (!item.masterProductId) continue;
        const product = db.getMasterProduct(item.masterProductId);
        if (!product) continue;
        const cmp = compareAgainstHistory(
          product,
          item.unitPrice,
          item.unit,
          invoice.invoiceNumber,
          invoice.invoiceDate
        );
        item.previousPrice = cmp.previousPrice;
        item.priceDelta = cmp.deltaAmount;
        item.priceDeltaPercent = cmp.percentChange;
        item.baseUnitPrice = cmp.baseUnitPrice;
        item.baseUnit = cmp.baseUnit;
        item.priceComparable = cmp.comparable;
      }
      db.updateInvoice(invoice.id, invoice);
    }

    // Re-judge every alert against the rebuilt history. An alert raised because the OCR
    // read a carton price and a pack price as the same unit was never a real increase.
    const invoiceIdByNumber = new Map(invoices.map((i) => [i.invoiceNumber, i.id]));
    const realPairs = new Set<string>();
    const alertsCreated = [];

    for (const product of db.getMasterProducts()) {
      for (const entry of product.priceHistory || []) {
        // Judged by exactly the same rule the upload pipeline uses, so a replayed
        // invoice and a freshly scanned one agree on what an increase is.
        const cmp = compareAgainstHistory(
          product,
          entry.unitPrice,
          entry.unit || product.standardUnit,
          entry.invoiceNumber,
          entry.date
        );
        if (!cmp.isIncrease) continue;

        const after = entry;
        const invoiceId = invoiceIdByNumber.get(after.invoiceNumber);
        if (!invoiceId) continue;
        realPairs.add(`${product.id}|${invoiceId}`);

        const alreadyRaised = db
          .getAlerts()
          .some((a) => a.masterProductId === product.id && a.invoiceId === invoiceId);
        if (alreadyRaised) continue;

        // The old price is shown in the unit the new one was invoiced in, so the two
        // numbers on the alert can be compared by eye.
        const previousShown = cmp.previousPrice ?? 0;

        const alert: PriceAlert = {
          id: `alert-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          masterProductId: product.id,
          productName: product.name,
          vendorName: after.vendor,
          invoiceId,
          invoiceNumber: after.invoiceNumber,
          invoiceDate: after.date,
          previousPrice: previousShown,
          newPrice: after.unitPrice,
          deltaAmount: cmp.deltaAmount ?? 0,
          percentChange: cmp.percentChange ?? 0,
          detectedAt: new Date().toISOString(),
          status: 'active',
          unit: after.unit || product.standardUnit,
        };
        db.addAlert(alert);
        alertsCreated.push(alert);
      }
    }

    const alertsRemoved = db.pruneAlerts(
      (a) => a.status !== 'active' || realPairs.has(`${a.masterProductId}|${a.invoiceId}`)
    );

    res.json({
      success: true,
      productsUpdated,
      entriesRebuilt,
      conversionsLearned,
      alertsRemoved,
      alertsCreated: alertsCreated.length,
    });
  } catch (err: any) {
    console.error('Price history rebuild failed:', err);
    res.status(500).json({ error: err.message || 'Price history rebuild failed' });
  }
});

// 4b. Supplier / Vendor endpoints
// List every supplier name currently in the database with how heavily it is used, plus
// the canonical name and match key so the UI can both clean names and suggest duplicates.
app.get('/api/vendors', (req, res) => {
  const buckets: Record<string, VendorSummary> = {};
  const bump = (name: string): VendorSummary => {
    const key = name || 'Unknown Vendor';
    if (!buckets[key]) {
      buckets[key] = {
        name: key,
        normalized: normalizeVendorName(key),
        key: vendorKey(key),
        invoices: 0,
        spend: 0,
        products: 0,
        aliases: 0,
        alerts: 0,
      };
    }
    return buckets[key];
  };

  for (const inv of db.getInvoices()) bump(inv.vendorName).invoices++;
  for (const inv of db.getInvoices()) bump(inv.vendorName).spend += inv.totalAmount || 0;
  for (const p of db.getMasterProducts()) {
    bump(p.primaryVendor).products++;
    for (const a of p.vendorAliases || []) bump(a.vendorName).aliases++;
  }
  for (const al of db.getAlerts()) bump(al.vendorName).alerts++;

  const list = Object.values(buckets).sort((a, b) => b.spend - a.spend);
  res.json(list);
});

/**
 * Re-points every occurrence of a set of vendor names to one primary name. Used by the
 * Suppliers page "merge" action: invoices, catalog primary vendors, alias entries, price
 * history and alerts all follow. The chosen primary keeps its identity; the others vanish.
 */
app.post('/api/vendors/merge', (req, res) => {
  try {
    const { primaryName, otherNames } = (req.body || {}) as {
      primaryName?: string;
      otherNames?: string[];
    };
    if (!primaryName) return res.status(400).json({ error: 'primaryName is required' });
    if (!Array.isArray(otherNames) || otherNames.length === 0) {
      return res.status(400).json({ error: 'Select at least one vendor to merge' });
    }

    const targets = otherNames.filter((n) => n && n !== primaryName);
    if (targets.length === 0) {
      return res.status(400).json({ error: 'No valid vendors to merge' });
    }

    let invoicesUpdated = 0;
    let productsUpdated = 0;
    let aliasesUpdated = 0;
    let historyUpdated = 0;
    let alertsUpdated = 0;

    for (const inv of db.getInvoices()) {
      if (targets.includes(inv.vendorName)) {
        inv.vendorName = primaryName;
        invoicesUpdated++;
        db.updateInvoice(inv.id, inv);
      }
    }

    for (const p of db.getMasterProducts()) {
      let changed = false;
      if (targets.includes(p.primaryVendor)) {
        p.primaryVendor = primaryName;
        productsUpdated++;
        changed = true;
      }
      for (const a of p.vendorAliases || []) {
        if (targets.includes(a.vendorName)) {
          a.vendorName = primaryName;
          aliasesUpdated++;
          changed = true;
        }
      }
      for (const h of p.priceHistory || []) {
        if (targets.includes(h.vendor)) {
          h.vendor = primaryName;
          historyUpdated++;
          changed = true;
        }
      }
      if (changed) db.saveMasterProduct(p);
    }

    for (const al of db.getAlerts()) {
      if (targets.includes(al.vendorName)) {
        al.vendorName = primaryName;
        alertsUpdated++;
      }
    }
    db.persist();

    console.log(
      `[Vendors] Merged ${targets.length} name(s) into "${primaryName}": ${invoicesUpdated} invoice(s), ${productsUpdated} product(s), ${aliasesUpdated} alias(es), ${historyUpdated} history point(s), ${alertsUpdated} alert(s)`
    );

    res.json({
      success: true,
      primaryName,
      merged: targets,
      invoicesUpdated,
      productsUpdated,
      aliasesUpdated,
      historyUpdated,
      alertsUpdated,
    });
  } catch (err: any) {
    console.error('Vendor merge failed:', err);
    res.status(500).json({ error: err.message || 'Vendor merge failed' });
  }
});

/**
 * Applies normalizeVendorName() to every stored vendor string (invoices, catalog primary
 * vendors, alias entries, price history, alerts). Two distinct spellings that normalize to
 * the same canonical name automatically collapse into one supplier identity. Does not touch
 * anything the normalizer leaves unchanged.
 */
app.post('/api/vendors/normalize', (req, res) => {
  try {
    const renamed: { from: string; to: string }[] = [];
    const seen = new Set<string>();

    const norm = (name: string): string => {
      const to = normalizeVendorName(name);
      if (to && to !== name && !seen.has(name)) {
        seen.add(name);
        renamed.push({ from: name, to });
      }
      return to || name;
    };

    for (const inv of db.getInvoices()) {
      if (inv.vendorName) {
        inv.vendorName = norm(inv.vendorName);
        db.updateInvoice(inv.id, inv);
      }
    }

    for (const p of db.getMasterProducts()) {
      if (p.primaryVendor) p.primaryVendor = norm(p.primaryVendor);
      for (const a of p.vendorAliases || []) if (a.vendorName) a.vendorName = norm(a.vendorName);
      for (const h of p.priceHistory || []) if (h.vendor) h.vendor = norm(h.vendor);
      db.saveMasterProduct(p);
    }

    for (const al of db.getAlerts()) {
      if (al.vendorName) al.vendorName = norm(al.vendorName);
    }
    db.persist();

    const before = new Set(db.getInvoices().map((i) => i.vendorName)).size;
    console.log(`[Vendors] Normalized ${renamed.length} name variant(s) across the dataset.`);

    res.json({
      success: true,
      renamed,
      vendorsNow: before,
    });
  } catch (err: any) {
    console.error('Vendor normalization failed:', err);
    res.status(500).json({ error: err.message || 'Vendor normalization failed' });
  }
});

// 5. Price Alerts endpoints
app.get('/api/alerts', (req, res) => {
  res.json(db.getAlerts());
});

app.post('/api/alerts/:id/acknowledge', (req, res) => {
  const alert = db.updateAlertStatus(req.params.id, 'acknowledged');
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json(alert);
});

app.post('/api/alerts/:id/dispute', (req, res) => {
  const alert = db.updateAlertStatus(req.params.id, 'disputed');
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json(alert);
});

// 6. Conversational Procurement Intelligence & Future Forecasts
app.post('/api/chat/analyze', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const result = await handleProcurementChat({ message, history });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Chat analysis failed' });
  }
});

// 7. Database Export routes (CSV, JSON, SQL)
app.get('/api/export/:format', (req, res) => {
  const { format } = req.params;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="spendpulse_invoices_${timestamp}.csv"`);
    return res.send(generateCsvExport());
  }

  if (format === 'sql') {
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="spendpulse_dump_${timestamp}.sql"`);
    return res.send(generateSqlDump());
  }

  // Default JSON
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="spendpulse_database_${timestamp}.json"`);
  return res.send(generateJsonExport());
});

// 8. Reset data / clear all data
app.post('/api/reset-data', async (req, res) => {
  db.clearAllData();
  await deleteAllDocuments().catch((err) =>
    console.warn(`[Documents] Could not clear stored documents: ${err.message}`)
  );
  res.json({ success: true, message: 'Database cleared of all records' });
});

// ----------------------------------------------------
// VITE INTEGRATION
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`SpendPulse server ready at http://127.0.0.1:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup failure:', err);
  process.exit(1);
});
