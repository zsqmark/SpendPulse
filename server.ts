import express from 'express';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db } from './src/server/storage.ts';
import { mergeDuplicateLineItems, extractInvoicesFromDocument } from './src/server/ocrService.ts';
import { batchMatchItems, guessCategory } from './src/server/aliasMatcher.ts';
import {
  alignLine,
  identityFor,
  lookupKeysFor,
  majorityOf,
  rememberSample,
  sampleFromOutcome,
  unitConversionFactor,
} from './src/server/lineAlignment.ts';
import {
  checkAndRecordPriceChange,
  compareAgainstHistory,
  revalidateActiveAlerts,
} from './src/server/priceAlertService.ts';
import {
  learnPackHierarchy,
  basePriceFor,
  recalculateProductStats,
  rebuildHistoryFromInvoices,
  applyWeightPricing,
} from './src/server/productUnits.ts';
import { handleProcurementChat } from './src/server/chatService.ts';
import { generateCsvExport, generateJsonExport, generateSqlDump } from './src/server/exportService.ts';
import {
  saveInvoicePages,
  listInvoicePages,
  getInvoicePageFile,
  deleteAllDocuments,
  deleteInvoiceDocuments,
} from './src/server/documentStore.ts';
import {
  Invoice,
  InvoiceItem,
  PriceAlert,
  MasterProduct,
  VendorSummary,
  UnitChangeRecord,
  UnitChangeScope,
  UnitChangeBlockReason,
  ProductUnitInvoice,
  ProductUnitLine,
  UnitChangePreview,
  UnitChangeLineSnapshot,
  AlignmentLogEntry,
  ProductAttributeRecord,
  LineAlignment,
} from './src/types/index.ts';
import { standardPrice } from './src/lib/standardPricing.ts';
import { isMeatDescription } from './src/lib/meatPricing.ts';
import { UNIT_OPTIONS, type UnitOption } from './src/lib/units.ts';
import { normalizeVendorName, vendorKey } from './src/lib/vendorNormalizer.ts';
import { measureClassOf, measuresConflict, describeMeasure } from './src/server/unitConversion.ts';

dotenv.config();
// .env.local overrides .env (git-ignored local secrets).
dotenv.config({ path: '.env.local', override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// CORS: the API is called same-origin when Vercel rewrites /api/* to this backend, but if a
// standalone subdomain is used instead, the browser needs CORS. Reflect the requesting origin
// so one backend can serve both setups without hard-coding domains.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Long invoices ship many rasterised pages at once. A multi-page PDF can easily produce
// tens of MB of base64; allow a generous ceiling (but keep one to avoid unbounded memory).
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

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

/**
 * Takes one invoice out of the alignment history library.
 *
 * A sample is stored per invoice number, so dropping the invoice's own samples puts every
 * record back exactly where it was before that invoice arrived - the same guarantee the
 * sample-per-invoice design gives a repeated upload.
 */
function forgetInvoiceFromAttributes(invoiceNumber: string, vendorName: string): number {
  const key = String(invoiceNumber || '').trim();
  if (!key) return 0;

  const kept: ProductAttributeRecord[] = [];
  const empty: string[] = [];
  let removed = 0;

  for (const record of db.getProductAttributes()) {
    if (record.vendorName !== vendorName) continue;
    const before = record.samples.length;
    record.samples = record.samples.filter((s) => String(s.invoiceNumber || '').trim() !== key);
    if (record.samples.length === before) continue;
    removed += before - record.samples.length;
    // A record with no samples left has no history to offer, so it goes too.
    if (record.samples.length === 0) empty.push(record.key);
    else kept.push(record);
  }

  if (kept.length > 0) db.saveProductAttributes(kept);
  for (const k of empty) db.deleteProductAttribute(k);
  return removed;
}

/**
 * Rebuilds one product's history and stats from the invoice lines that still reference it.
 * Used after lines are taken away from it, so it stops quoting prices that belonged to
 * something else.
 */
function refreshProductFromInvoices(productId: string): void {
  const product = db.getMasterProduct(productId);
  if (!product) return;

  const entries: Parameters<typeof rebuildHistoryFromInvoices>[1] = [];
  for (const invoice of db.getInvoices()) {
    for (const item of invoice.items) {
      if (item.masterProductId !== productId) continue;
      entries.push({
        date: invoice.invoiceDate,
        vendor: invoice.vendorName,
        unitPrice: item.unitPrice,
        invoiceNumber: invoice.invoiceNumber,
        unit: item.unit,
        packSize: item.packSize,
      });
    }
  }

  if (entries.length === 0) {
    // Everything was split away from it. The record stays, but it no longer claims prices.
    product.priceHistory = [];
    recalculateProductStats(product);
    db.saveMasterProduct(product);
    return;
  }

  rebuildHistoryFromInvoices(product, entries);
  db.saveMasterProduct(product);
}

/** Re-judges every line of one invoice against the product it now belongs to. */
function refreshLineComparisons(invoiceId: string): void {
  const invoice = db.getInvoice(invoiceId);
  if (!invoice) return;

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
    item.notComparableCode = cmp.notComparableCode ?? null;
    item.notComparableReason = cmp.notComparableReason ?? null;
    attachStandardPricing(item);
  }
  db.updateInvoice(invoice.id, invoice);
}

/**
 * Re-quotes a line the way the catalogue always shows it: $/L when the name states a
 * capacity, $/kg when it states a weight, $/ea when it states neither. Meat keeps the
 * per-kilo price it was given from the invoice's weight column.
 */
function attachStandardPricing(item: InvoiceItem): void {
  const std = standardPrice({
    rawDescription: item.rawDescription,
    masterProductName: item.masterProductName,
    brand: item.brand,
    packSize: item.packSize,
    unit: item.unit,
    unitPrice: item.unitPrice,
    isMeat: isMeatDescription(item.rawDescription, item.brand),
  });
  item.standardUnitPrice = std.price;
  item.standardUnit = std.unit;
  item.standardSellingUnit = std.sellingUnit;
}

/** How many invoice lines currently point at a product. */
function countLines(productId: string): number {
  let n = 0;
  for (const invoice of db.getInvoices()) {
    for (const item of invoice.items) {
      if (item.masterProductId === productId) n++;
    }
  }
  return n;
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

/**
 * Takes one import back out, the way a bad upload has to be undone before it is re-scanned.
 *
 * A mis-segmented document leaves three kinds of debris behind: its own record, the price
 * alerts raised from its lines, and master products that were auto-created from lines that
 * now no longer exist. All three are cleaned up here, and every product it fed has its price
 * history replayed from the invoices that remain - never patched by hand.
 *
 * `?keepOrphans=1` leaves childless master products in place; by default they are dropped,
 * because a product with no lines cannot carry a price and only clutters the catalogue.
 */
app.delete('/api/invoices/:id', async (req, res) => {
  try {
    const inv = db.getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const affectedProductIds = Array.from(
      new Set((inv.items || []).map((it) => it.masterProductId).filter((id): id is string => Boolean(id)))
    );

    const alertsBefore = db.getAlerts().length;
    db.pruneAlerts((a) => a.invoiceId !== inv.id);
    const alertsRemoved = alertsBefore - db.getAlerts().length;

    await deleteInvoiceDocuments(inv.id);

    if (!db.deleteInvoice(inv.id)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    for (const productId of affectedProductIds) refreshProductFromInvoices(productId);

    // The history library must not keep remembering an invoice that no longer exists,
    // or the next upload would align against a purchase that was withdrawn.
    const samplesRemoved = forgetInvoiceFromAttributes(inv.invoiceNumber, inv.vendorName);
    const alignmentEntriesRemoved = db.pruneAlignmentLog((e) => e.invoiceId !== inv.id);

    const orphanIds: string[] = [];
    if (req.query.keepOrphans !== '1') {
      for (const product of db.getMasterProducts()) {
        const stillUsed = db
          .getInvoices()
          .some((i) => (i.items || []).some((it) => it.masterProductId === product.id));
        if (!stillUsed) orphanIds.push(product.id);
      }
      for (const id of orphanIds) db.deleteMasterProduct(id);
    }

    res.json({
      success: true,
      deleted: {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        vendorName: inv.vendorName,
        lineCount: (inv.items || []).length,
      },
      alertsRemoved,
      productsRebuilt: affectedProductIds.length,
      orphanProductsRemoved: orphanIds.length,
      alignmentSamplesRemoved: samplesRemoved,
      alignmentEntriesRemoved,
    });
  } catch (err: any) {
    console.error('Invoice delete failed:', err);
    res.status(500).json({ error: err.message || 'Invoice delete failed' });
  }
});

// Original source pages, so extracted values can be checked against the scan.
app.get('/api/invoices/:id/pages', async (req, res) => {
  res.json(await listInvoicePages(req.params.id));
});

/* ---------------------------------------------------------------------------
 * Historical alignment
 *
 * Every line of a new invoice is brought onto the values history holds for that
 * product. What moved is recorded here, and a disagreement nobody could reconcile
 * waits in the review queue for a human.
 * ------------------------------------------------------------------------- */

/** The audit trail: what alignment did, newest first. */
app.get('/api/alignment/log', (req, res) => {
  const limit = Number(req.query.limit) || 200;
  const invoiceId = req.query.invoiceId ? String(req.query.invoiceId) : null;
  const all = db.getAlignmentLog();
  const rows = invoiceId ? all.filter((e) => e.invoiceId === invoiceId) : all;
  res.json({ total: all.length, entries: rows.slice(0, limit) });
});

/** The history library itself, so what alignment is working from can be inspected. */
app.get('/api/alignment/memory', (req, res) => {
  const records = db.getProductAttributes();
  const limit = Number(req.query.limit) || 200;
  const search = req.query.search ? String(req.query.search).toLowerCase() : '';
  const rows = search
    ? records.filter(
        (r) =>
          (r.name || '').toLowerCase().includes(search) ||
          (r.sku || '').toLowerCase().includes(search) ||
          (r.productName || '').toLowerCase().includes(search)
      )
    : records;
  res.json({
    total: records.length,
    records: rows.slice(0, limit).map((r) => ({
      key: r.key,
      kind: r.kind,
      vendorName: r.vendorName,
      sku: r.sku,
      name: r.name,
      packSize: r.packSize,
      productId: r.productId,
      productName: r.productName,
      seenCount: r.samples.length,
      // What history would answer for each field right now.
      current: currentFromSamples(r),
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    })),
  });
});

/** What history currently holds for each field of one record. */
function currentFromSamples(record: ProductAttributeRecord): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of ['unit', 'packSize', 'taxRate', 'category'] as const) {
    const seen = (record.samples || [])
      .map((s) => s.values?.[field])
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    out[field] = majorityOf(seen);
  }
  return out;
}

/** The queue: alignments nobody could settle on their own. */
app.get('/api/alignment/review', (req, res) => {
  const all = db.getAlignmentLog();
  const open = all.filter((e) => e.conflicts.length > 0 && !e.resolvedAt);
  const unresolved = req.query.all === '1' ? open : open.filter((e) => e.needsReview);
  res.json({
    total: open.length,
    entries: unresolved.map((e) => ({
      id: e.id,
      invoiceId: e.invoiceId,
      invoiceNumber: e.invoiceNumber,
      vendorName: e.vendorName,
      itemId: e.itemId,
      itemDescription: e.itemDescription,
      productId: e.productId,
      productName: e.productName,
      identityKey: e.identityKey,
      identityKind: e.identityKind,
      isFirstEntry: e.isFirstEntry,
      changes: e.changes,
      conflicts: e.conflicts,
      createdAt: e.createdAt,
    })),
  });
});

/**
 * Settles one conflict.
 *
 * 'accepted_history' writes the historical value onto the line (and, when the field is
 * the unit, converts the price by the same factor so the price per base unit does not
 * move). 'kept_document' just closes the item and leaves the printed value alone.
 */
app.post('/api/alignment/:logId/resolve', (req, res) => {
  const entry = db.getAlignmentLog().find((e) => e.id === req.params.logId);
  if (!entry) return res.status(404).json({ error: 'Alignment entry not found' });
  if (entry.resolvedAt) {
    return res.status(409).json({ error: 'This alignment has already been settled.' });
  }

  const resolution = req.body?.resolution;
  if (resolution !== 'accepted_history' && resolution !== 'kept_document') {
    return res.status(400).json({ error: "resolution must be 'accepted_history' or 'kept_document'" });
  }

  const invoice = db.getInvoice(entry.invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const item = (invoice.items || []).find((i) => i.id === entry.itemId);
  if (!item) return res.status(404).json({ error: 'Line not found' });

  let applied: string | null = null;
  if (resolution === 'accepted_history') {
    for (const conflict of entry.conflicts) {
      const historyValue = conflict.historyValue;
      if (historyValue == null) continue;

      if (conflict.field === 'unit') {
        const factor = unitConversionFactor(
          item.unit,
          historyValue,
          item.packSize,
          entry.productId ? db.getMasterProduct(entry.productId) ?? null : null
        );
        if (factor == null || !(factor > 0)) {
          return res.status(400).json({
            error: `No conversion between ${item.unit} and ${historyValue}, so the historical unit cannot be applied.`,
          });
        }
        item.unit = historyValue;
        item.unitPrice = Number((item.unitPrice * factor).toFixed(4));
      } else if (conflict.field === 'packSize') {
        item.packSize = historyValue;
      } else if (conflict.field === 'taxRate') {
        item.taxRate = Number(historyValue);
      } else if (conflict.field === 'category') {
        item.category = historyValue;
      }
      applied = historyValue;
    }
  }

  // The line's own alignment record is refreshed so it does not keep claiming a
  // conflict that a human has just settled.
  if (item.alignment) {
    item.alignment.conflicts = [];
    item.alignment.needsReview = false;
    for (const f of item.alignment.fields) {
      if (f.conflict && resolution === 'accepted_history' && f.historyValue != null) {
        f.value = f.historyValue;
        f.source = 'history';
      }
      f.conflict = false;
    }
  }

  db.updateInvoice(invoice.id, { items: invoice.items });
  db.updateAlignmentLogEntry(entry.id, {
    resolvedAt: new Date().toISOString(),
    resolution,
    resolvedValue: applied,
  });

  // Re-derive the price history, because a resolved unit can move the price.
  if (item.masterProductId) refreshProductFromInvoices(item.masterProductId);

  res.json({ success: true, resolution, appliedValue: applied, item });
});

/**
 * Rebuilds the history library from the invoices that are stored.
 *
 * Safe to run at any time: samples are keyed by invoice number, so replaying produces
 * exactly the same records the original import did. It is the way to repair the library
 * after an alignment rule changes.
 */
app.post('/api/alignment/replay', (req, res) => {
  const before = db.getProductAttributes().length;
  const rebuilt = new Map<string, ProductAttributeRecord>();
  let lines = 0;

  for (const invoice of db.getInvoices()) {
    for (const item of invoice.items || []) {
      if (!item.alignment) continue;
      const record: ProductAttributeRecord = rebuilt.get(item.alignment.identityKey) || {
        key: item.alignment.identityKey,
        kind: item.alignment.identityKind === 'sku' ? 'sku' : 'name_spec',
        vendorName: invoice.vendorName,
        sku: item.supplierSku ?? null,
        name: item.rawDescription,
        packSize: item.packSize ?? null,
        productId: item.masterProductId ?? null,
        productName: item.masterProductName ?? null,
        samples: [],
        firstSeenAt: invoice.createdAt,
        lastSeenAt: invoice.createdAt,
      };
      const values: Partial<Record<'unit' | 'packSize' | 'taxRate' | 'category', string | null>> = {};
      for (const f of item.alignment.fields) values[f.field] = f.value ?? null;
      rememberSample(
        record,
        { invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, values },
        invoice.createdAt
      );
      rebuilt.set(record.key, record);
      lines += 1;
    }
  }

  db.replaceProductAttributes(Array.from(rebuilt.values()));
  res.json({ success: true, linesReplayed: lines, recordsBefore: before, recordsAfter: rebuilt.size });
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

    // Step 1: Multimodal OCR extraction. A single uploaded document (e.g. a combined
    // statement PDF) may actually contain SEVERAL invoices. We segment the page-images
    // into invoice groups, then process each group as its own invoice record.
    const extractedGroups = await extractInvoicesFromDocument({
      base64Data,
      mimeType,
      textPayload,
      fileName,
      pages,
    });

    const invoices: Invoice[] = [];
    const alertsCreated: PriceAlert[] = [];
    const duplicateSummaries: any[] = [];
    let needsReview = false;
    /** Lines whose values were filled in or moved by history, and how many are disputed. */
    let alignmentApplied = 0;
    let alignmentConflicts = 0;

    for (const { result: extracted, pages: groupPages } of extractedGroups) {
      // Clean the supplier name before it is stored or used for dedupe, so "T & D TRADING
      // PTY. LTD." and "T & D Trading Pty. Ltd." collapse to one identity going forward.
      if (extracted.vendorName) {
        extracted.vendorName = normalizeVendorName(extracted.vendorName);
      }

      // Guard 2: the same supplier + invoice number + date, e.g. re-uploading a statement
      // that is already stored. Within a multi-invoice document we skip just this invoice
      // (recording it as a duplicate) rather than aborting the whole import.
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
          duplicateSummaries.push(invoiceSummary(sameInvoice));
          continue;
        }
      }

      // Group repeated rows of the same product before matching, so identical lines
      // (very common across the pages of a long statement) become one catalogue entry.
      const groupedItems = mergeDuplicateLineItems(extracted.items);

      // Meat is bought by weight: re-express it per kilogram (total / weight) before it is
      // matched, so a noisy meat pack string never turns into a phantom price move.
      const normalisedItems = groupedItems.map((it) => {
        const derived = applyWeightPricing(it);
        return {
          ...it,
          unitPrice: derived.unitPrice ?? it.unitPrice,
          unit: derived.unit ?? it.unit,
        };
      });

      const invoiceId = `inv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const processedItems: InvoiceItem[] = [];

      let hasUnmappedItems = false;
      /** Products already priced in this invoice - later rows of the same invoice never alert. */
      const pricedInThisInvoice = new Set<string>();

      // Prepare line items for single batch matching with multi-tier SKU & pack size
      const rawItemsForBatch = normalisedItems.map((it, idx) => ({
        id: `item-${Date.now()}-${idx}`,
        rawDescription: it.rawDescription,
        supplierSku: it.supplierSku,
        brand: it.brand,
        packSize: it.packSize,
        unit: it.unit,
        unitPrice: it.unitPrice,
        quantity: it.quantity,
        weight: it.weight ?? null,
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

      // Step 2: Align each line against history, then check its price.
      /** History records this invoice touched, written back once after the loop. */
      const touchedAttributes = new Map<string, ProductAttributeRecord>();
      const alignmentEntries: AlignmentLogEntry[] = [];
      let hasAlignmentConflicts = false;
      const alignedAt = new Date().toISOString();

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

        const product = match.masterProductId
          ? db.getMasterProduct(match.masterProductId) ?? null
          : null;

        // Historical alignment. The lookup keys are tried item code first, then
        // name + pack size, which is the order the owner asked for.
        const alignmentInput = {
          itemId: it.id,
          rawDescription: it.rawDescription,
          supplierSku: it.supplierSku,
          packSize: it.packSize,
          unit: it.unit,
          unitPrice: it.unitPrice,
          vendorName: extracted.vendorName,
          invoiceId,
          invoiceNumber: extracted.invoiceNumber,
          invoiceDate: extracted.invoiceDate,
          product,
          weightPriced: isMeatDescription(it.rawDescription, it.brand),
        };
        const lookupKeys = lookupKeysFor(alignmentInput);
        const found = db.findProductAttribute(lookupKeys);
        const aligned = alignLine(alignmentInput, {
          record: found?.record ?? null,
          recordKind: found?.kind ?? null,
        });
        const alignment: LineAlignment = aligned.alignment;

        // Fold the line back into the history library so the next invoice aligns against
        // it. A sample is stored per invoice number, so re-processing this invoice
        // replaces its own sample instead of adding a second one.
        const identity = identityFor(alignmentInput);
        const target = found
          ? { key: found.record.key, kind: found.kind }
          : { key: identity.key, kind: identity.kind };
        let record = db.getProductAttribute(target.key) ?? touchedAttributes.get(target.key);
        if (!record) {
          record = {
            key: target.key,
            kind: target.kind,
            vendorName: extracted.vendorName || '',
            sku: it.supplierSku ?? null,
            name: it.rawDescription,
            packSize: it.packSize ?? null,
            productId: product?.id ?? null,
            productName: product?.name ?? null,
            samples: [],
            firstSeenAt: alignedAt,
            lastSeenAt: alignedAt,
          };
        }
        rememberSample(
          record,
          {
            invoiceNumber: extracted.invoiceNumber || '',
            invoiceDate: extracted.invoiceDate ?? null,
            values: sampleFromOutcome(aligned),
          },
          alignedAt
        );
        if (product) {
          record.productId = product.id;
          record.productName = product.name;
        }
        touchedAttributes.set(record.key, record);

        if (alignment.conflicts.length > 0) hasAlignmentConflicts = true;

        // A row that simply agreed with history is recorded on the line itself; only what
        // moved - or what was seen for the very first time - earns an audit entry, so the
        // log stays about decisions rather than about every row of every statement.
        const changes = alignment.fields.filter(
          (f) => f.source === 'history' || f.source === 'converted' || f.conflict
        );
        if (changes.length > 0 || alignment.isFirstEntry) {
          alignmentEntries.push({
            id: `al-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            invoiceId,
            invoiceNumber: extracted.invoiceNumber,
            vendorName: extracted.vendorName,
            itemId: it.id,
            itemDescription: it.rawDescription,
            productId: product?.id ?? null,
            productName: product?.name ?? null,
            identityKey: target.key,
            identityKind: alignment.identityKind,
            isFirstEntry: alignment.isFirstEntry,
            changes,
            conflicts: alignment.conflicts,
            needsReview: alignment.needsReview,
            validated: alignment.validated,
            validationErrors: alignment.validationErrors,
            fingerprint: alignment.fingerprint,
            resolvedAt: null,
            resolution: null,
            resolvedValue: null,
            createdAt: alignedAt,
          });
        }

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
            unitPrice: aligned.unitPrice,
            unit: aligned.unit,
            packSize: aligned.packSize ?? undefined,
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
          packSize: aligned.packSize,
          masterProductId: match.needsMappingReview ? null : match.masterProductId,
          masterProductName: match.needsMappingReview ? null : match.masterProductName,
          quantity: it.quantity,
          weight: it.weight ?? null,
          unit: aligned.unit,
          unitPrice: aligned.unitPrice,
          totalPrice: it.totalPrice,
          previousPrice: priceCheck.previousPrice,
          priceDelta: priceCheck.deltaAmount,
          priceDeltaPercent: priceCheck.percentChange,
          baseUnitPrice: priceCheck.baseUnitPrice,
          baseUnit: priceCheck.baseUnit,
          priceComparable: priceCheck.comparable,
          notComparableCode: priceCheck.notComparableCode ?? null,
          notComparableReason: priceCheck.notComparableReason ?? null,
          standardUnitPrice: null,
          standardUnit: null,
          standardSellingUnit: null,
          taxRate: aligned.taxRate,
          category: aligned.category,
          alignment,
          matchConfidence: match.confidence,
          matchTier: match.matchTier,
          needsMappingReview: match.needsMappingReview,
          suggestedMasterId: match.masterProductId,
          suggestedMasterName: match.masterProductName,
          confidenceBreakdown: match.confidenceBreakdown,
          pageNumber: it.pageNumber,
          mergedCount: it.mergedCount,
        });
        attachStandardPricing(processedItems[processedItems.length - 1]);
      }

      // One write for the whole invoice instead of one per line.
      if (touchedAttributes.size > 0) {
        db.saveProductAttributes(Array.from(touchedAttributes.values()));
      }
      if (alignmentEntries.length > 0) {
        db.addAlignmentLogEntries(alignmentEntries);
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
        // A line history could not agree with is left as printed and waits for a human,
        // which is exactly what "needs review" is for.
        status: hasUnmappedItems || hasAlignmentConflicts ? 'needs_review' : 'processed',
        items: processedItems,
        itemCount: processedItems.length,
        pageCount: extracted.pageCount || 1,
        notes: extracted.notes,
        isScanned: isScannedManual ?? extracted.isScanned,
        createdAt: new Date().toISOString(),
        contentHash: contentHash || undefined,
      };

      // Keep the source pages on disk so the extraction can be audited against the scan.
      // For a multi-invoice document, archive only the pages that belong to THIS invoice.
      try {
        await saveInvoicePages(
          invoiceId,
          groupPages && groupPages.length > 0
            ? groupPages
            : [{ base64Data, mimeType, pageNumber: 1 }]
        );
        newInvoice.documentPages = await listInvoicePages(invoiceId);
      } catch (docErr: any) {
        // Never fail an otherwise successful OCR run just because archiving failed.
        console.warn(`[Documents] Could not archive source pages for ${invoiceId}: ${docErr.message}`);
      }

      db.addInvoice(newInvoice);
      invoices.push(newInvoice);
      if (hasUnmappedItems || hasAlignmentConflicts) needsReview = true;
      alignmentConflicts += alignmentEntries.reduce((n, e) => n + e.conflicts.length, 0);
      alignmentApplied += alignmentEntries.length;
    }

    const primaryInvoice = invoices[0] || null;

    res.json({
      success: true,
      invoices,
      invoice: primaryInvoice,
      invoicesCount: invoices.length,
      alertsCreated,
      duplicates: duplicateSummaries,
      needsReview,
      alignment: { applied: alignmentApplied, conflicts: alignmentConflicts },
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
      item.notComparableCode = priceCheck.notComparableCode ?? null;
      item.notComparableReason = priceCheck.notComparableReason ?? null;
      attachStandardPricing(item);
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
      item.notComparableCode = priceCheck.notComparableCode ?? null;
      item.notComparableReason = priceCheck.notComparableReason ?? null;
      attachStandardPricing(item);

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

    // A merge joins one price history. That is only honest while every product in it is
    // measured the same way - "$38 per 20 L" and "$14 per 14 kg" have no common basis, so
    // combining them produces a history whose "increases" are unit artefacts. This is what
    // put a drum of bleach inside the box of table salt. Refuse it up front rather than
    // letting someone untangle it later.
    const primaryMeasure = measureClassOf(primary.standardPackSize, primary.standardUnit);
    const conflicts = sources
      .map((src) => ({
        product: src,
        measure: measureClassOf(src.standardPackSize, src.standardUnit),
      }))
      .filter((entry) => measuresConflict(primaryMeasure, entry.measure));

    if (conflicts.length > 0) {
      const names = conflicts
        .map(
          (c) =>
            `"${c.product.name}" (${c.product.standardPackSize || c.product.standardUnit || 'no unit'} - ${describeMeasure(c.measure)})`
        )
        .join(', ');
      return res.status(400).json({
        error:
          `Cannot merge: "${primary.name}" is sold ${describeMeasure(primaryMeasure)}, ` +
          `but ${names} ${conflicts.length > 1 ? 'are' : 'is'} sold differently. ` +
          `Give every product the same unit before merging them.`,
      });
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
 * Every invoice line attached to one master product, tagged with the measure it is priced
 * by, so the catalogue screen can show which rows do not belong.
 */
app.get('/api/catalog/:productId/lines', (req, res) => {
  try {
    const product = db.getMasterProduct(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const productMeasure = measureClassOf(product.standardPackSize, product.standardUnit);
    const lines = [];

    for (const invoice of db.getInvoices()) {
      for (const item of invoice.items) {
        if (item.masterProductId !== product.id) continue;
        const lineMeasure = measureClassOf(item.packSize, item.unit);
        lines.push({
          invoiceId: invoice.id,
          itemId: item.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          vendorName: invoice.vendorName,
          rawDescription: item.rawDescription,
          unit: item.unit,
          packSize: item.packSize,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          measure: lineMeasure,
          conflicts: measuresConflict(productMeasure, lineMeasure),
        });
      }
    }

    lines.sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || ''));
    res.json({ product, productMeasure, lines });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The opposite of a merge: takes chosen invoice lines out of a product and gives them a
 * product of their own.
 *
 * Needed because the matcher occasionally glues two different goods together - a drum of
 * bleach inside the box of table salt, maltose inside the coconut milk. Those rows poison
 * the price history of the product they landed in, and there was no way to take them out
 * again other than re-importing everything.
 *
 * Both sides are rebuilt from the invoices afterwards, so the product that lost rows no
 * longer quotes a price that belongs to something else.
 */
app.post('/api/catalog/split', (req, res) => {
  try {
    const {
      productId,
      lineRefs,
      targetProductId,
      newProduct,
    } = req.body as {
      productId?: string;
      lineRefs?: { invoiceId: string; itemId: string }[];
      targetProductId?: string;
      newProduct?: { name?: string; unit?: string; packSize?: string; category?: string; sku?: string };
    };

    if (!productId) return res.status(400).json({ error: 'productId is required' });
    if (!Array.isArray(lineRefs) || lineRefs.length === 0) {
      return res.status(400).json({ error: 'Select at least one line to split off' });
    }

    const source = db.getMasterProduct(productId);
    if (!source) return res.status(404).json({ error: 'Product not found' });

    // Resolve the requested lines up front: nothing is written until every one of them is
    // known to exist, so a typo cannot leave half a split behind.
    const found: { invoice: any; item: InvoiceItem }[] = [];
    for (const ref of lineRefs) {
      const invoice = db.getInvoice(ref.invoiceId);
      const item = invoice?.items.find((it) => it.id === ref.itemId);
      if (!invoice || !item) {
        return res.status(404).json({ error: `Line ${ref.itemId} was not found` });
      }
      if (item.masterProductId !== source.id) {
        return res.status(400).json({
          error: `"${item.rawDescription}" already belongs to another product`,
        });
      }
      found.push({ invoice, item });
    }

    const remaining = found.length === countLines(source.id);
    if (remaining) {
      return res.status(400).json({
        error: `"${source.name}" has only those lines - there is nothing left to keep. Use rename instead.`,
      });
    }

    let target = targetProductId ? db.getMasterProduct(targetProductId) : undefined;
    if (targetProductId && !target) {
      return res.status(404).json({ error: 'Target product not found' });
    }

    if (!target) {
      // The longest surviving description is usually the fullest name on an invoice line;
      // anything shorter tends to be an abbreviation OCR salvaged from a torn corner.
      const seedName = found
        .map((f) => (f.item.rawDescription || '').trim())
        .sort((a, b) => b.length - a.length)[0];
      const seed = found.find((f) => (f.item.rawDescription || '').trim() === seedName)?.item;

      target = {
        id: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sku: newProduct?.sku || seed?.supplierSku?.trim() || `SPLIT-${Date.now().toString().slice(-5)}`,
        name: (newProduct?.name || seedName || 'Split product').trim(),
        // A piece split off a product is the same KIND of goods as its parent, so it keeps
        // the parent's category. Guessing from the name instead is what filed "FISH CURRY
        // POWDER" under Seafood: the new card then lands in a different category from the
        // one it came out of and disappears the moment a category filter is applied.
        category: newProduct?.category || source.category || guessCategory(newProduct?.name || seedName || ''),
        standardUnit: newProduct?.unit || seed?.unit || 'ea',
        standardPackSize: newProduct?.packSize ?? seed?.packSize ?? undefined,
        currentPrice: seed?.unitPrice ?? 0,
        previousPrice: seed?.unitPrice ?? 0,
        minPrice: seed?.unitPrice ?? 0,
        maxPrice: seed?.unitPrice ?? 0,
        lastPurchaseDate: seed ? found[0].invoice.invoiceDate : new Date().toISOString(),
        primaryVendor: found[0].invoice.vendorName,
        vendorAliases: [],
        priceHistory: [],
      } as MasterProduct;
      db.saveMasterProduct(target);
    }

    for (const { invoice, item } of found) {
      if (item.packSize) learnPackHierarchy(target as MasterProduct, item.packSize);

      const exists = (target as MasterProduct).vendorAliases.some(
        (a) => a.aliasName.toLowerCase() === item.rawDescription.trim().toLowerCase()
      );
      if (!exists) {
        (target as MasterProduct).vendorAliases.push({
          vendorName: invoice.vendorName,
          aliasName: item.rawDescription.trim(),
          supplierSku: item.supplierSku || undefined,
          packSize: item.packSize || undefined,
          lastSeen: invoice.invoiceDate,
        });
      }

      item.masterProductId = (target as MasterProduct).id;
      item.masterProductName = (target as MasterProduct).name;
      item.needsMappingReview = false;
      item.matchConfidence = 1;
      item.matchTier = 'manual';

      const cmp = compareAgainstHistory(
        target as MasterProduct,
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
      item.notComparableCode = cmp.notComparableCode ?? null;
      item.notComparableReason = cmp.notComparableReason ?? null;

      db.updateInvoice(invoice.id, invoice);
    }

    // Both products are now re-derived from the invoices, so the one that lost these rows
    // stops quoting their prices, and every affected line is re-judged by the rule the
    // upload pipeline uses. No manual history writing: one rebuild, one source of truth.
    const touchedInvoices = new Set(found.map((f) => f.invoice.id));
    refreshProductFromInvoices(source.id);
    refreshProductFromInvoices((target as MasterProduct).id);
    for (const invoiceId of touchedInvoices) {
      refreshLineComparisons(invoiceId);
    }

    let alertsMoved = 0;
    for (const alert of db.getAlerts()) {
      const stillOwnsLine = found.some((f) => f.invoice.id === alert.invoiceId);
      if (alert.masterProductId === source.id && stillOwnsLine) {
        const stillHere = db
          .getInvoice(alert.invoiceId)
          ?.items.some((it) => it.masterProductId === source.id);
        if (!stillHere) {
          db.updateAlert(alert.id, {
            masterProductId: (target as MasterProduct).id,
            productName: (target as MasterProduct).name,
          });
          alertsMoved++;
        }
      }
    }

    res.json({
      success: true,
      source: db.getMasterProduct(source.id),
      target: db.getMasterProduct((target as MasterProduct).id),
      movedLines: found.length,
      alertsMoved,
      createdNew: !targetProductId,
    });
  } catch (err: any) {
    console.error('Split failed:', err);
    res.status(500).json({ error: err.message || 'Split failed' });
  }
});

// =====================================================================================
// UNIT OF MEASURE EDITOR
//
// OCR reads the unit column inconsistently - one invoice prints "Carton", the next "Unit"
// for the very same product - and every price comparison downstream is divided by that
// label. Letting the owner relabel a product line by line is therefore the one correction
// that fixes a whole class of false alerts.
//
// Three things make it safe to offer: nothing happens until the user states the scope,
// each line's previous unit is snapshotted so the change can be undone exactly, and every
// change is written to an append-only log.
// =====================================================================================

/**
 * Why a line cannot be relabelled - or null when it can be.
 *
 * There is no "settled" flag anywhere in the bills themselves, so the check uses what the
 * system genuinely knows: an invoice that is still being ingested or that failed ingestion
 * is not trustworthy to hand-edit, a locked invoice is one the business has closed off,
 * and a meat line's unit belongs to the weight-pricing rule rather than to the user.
 */
function unitChangeBlockFor(
  invoice: Invoice,
  item: InvoiceItem
): { reason: UnitChangeBlockReason; message: string } | null {
  if (invoice.locked) {
    return {
      reason: 'invoice_locked',
      message: invoice.lockedReason
        ? `Locked - ${invoice.lockedReason}`
        : 'Locked - this invoice has been closed off and can no longer be edited.',
    };
  }
  if (invoice.status === 'processing') {
    return {
      reason: 'invoice_processing',
      message: 'Still being processed - wait until extraction finishes so the label is not overwritten.',
    };
  }
  if (invoice.status === 'error') {
    return {
      reason: 'invoice_error',
      message: 'This invoice failed extraction, so its lines are incomplete. Re-import it first.',
    };
  }
  if (isMeatDescription(item.rawDescription, item.brand)) {
    return {
      reason: 'meat_weight_priced',
      message: 'Meat is priced from the invoice Weight column, and that rule sets the unit. Correct the weight instead.',
    };
  }
  return null;
}

/** Every invoice carrying this product, with the units its lines currently use. */
function collectProductUnitInvoices(product: MasterProduct): ProductUnitInvoice[] {
  const openAlerts = new Set(
    db
      .getAlerts()
      .filter((a) => a.status === 'active' && a.masterProductId === product.id)
      .map((a) => a.invoiceId)
  );

  const rows: ProductUnitInvoice[] = [];

  for (const invoice of db.getInvoices()) {
    const owned = invoice.items.filter((it) => it.masterProductId === product.id);
    if (owned.length === 0) continue;

    const lines: ProductUnitLine[] = owned.map((item) => {
      const block = unitChangeBlockFor(invoice, item);
      return {
        itemId: item.id,
        rawDescription: item.rawDescription,
        unit: item.unit,
        packSize: item.packSize ?? null,
        unitPrice: item.unitPrice,
        quantity: item.quantity ?? null,
        totalPrice: item.totalPrice,
        blocked: Boolean(block),
        blockReason: block?.reason ?? null,
      };
    });

    const units = Array.from(new Set(lines.map((l) => l.unit).filter(Boolean)));
    const firstBlockedLine = lines.find((l) => l.blocked);

    rows.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      vendorName: invoice.vendorName,
      status: invoice.status,
      locked: Boolean(invoice.locked),
      units,
      unitSummary: units.join(', ') || '(none)',
      lineCount: lines.length,
      packSize: owned.find((o) => o.packSize)?.packSize ?? null,
      unitPrice: owned.find((o) => Number.isFinite(o.unitPrice))?.unitPrice ?? null,
      blocked: Boolean(firstBlockedLine),
      blockReason: firstBlockedLine?.blockReason ?? null,
      blockMessage: firstBlockedLine
        ? unitChangeBlockFor(invoice, owned.find((o) => o.id === firstBlockedLine.itemId)!)
            ?.message ?? null
        : null,
      hasOpenAlert: openAlerts.has(invoice.id),
      lines,
    });
  }

  rows.sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || ''));
  return rows;
}

function unitOptionFor(value: string): UnitOption | null {
  return UNIT_OPTIONS.find((o) => o.value === value) ?? null;
}

/**
 * Chooses which invoices a change reaches. Nothing is inferred - 'all' and 'selected' are
 * both explicit user choices, and an empty selection is an error rather than a silent
 * whole-catalogue rewrite.
 */
function resolveUnitChangeTargets(
  rows: ProductUnitInvoice[],
  scope: UnitChangeScope,
  selectedInvoiceIds: string[]
): { targets: ProductUnitInvoice[]; skipped: { invoiceId: string; invoiceNumber: string; reason: string }[] } {
  const selected = new Set(selectedInvoiceIds);
  const targets: ProductUnitInvoice[] = [];
  const skipped: { invoiceId: string; invoiceNumber: string; reason: string }[] = [];

  for (const row of rows) {
    const wanted = scope === 'all' || selected.has(row.invoiceId);
    if (!wanted) continue;
    if (row.blocked) {
      skipped.push({
        invoiceId: row.invoiceId,
        invoiceNumber: row.invoiceNumber,
        reason: row.blockMessage ?? 'This invoice cannot be edited.',
      });
      continue;
    }
    targets.push(row);
  }

  return { targets, skipped };
}

function buildUnitChangePreview(
  product: MasterProduct,
  rows: ProductUnitInvoice[],
  newUnit: string,
  scope: UnitChangeScope,
  selectedInvoiceIds: string[]
): UnitChangePreview {
  const option = unitOptionFor(newUnit);
  const { targets, skipped } = resolveUnitChangeTargets(rows, scope, selectedInvoiceIds);

  const fromUnits = Array.from(new Set(targets.flatMap((t) => t.units)));
  const warnings: string[] = [];

  const alreadyCount = targets.filter((t) => t.units.includes(newUnit)).length;
  if (alreadyCount > 0) {
    warnings.push(
      `${alreadyCount} of the selected invoice(s) already use "${newUnit}" - those lines will simply keep their unit.`
    );
  }
  const alertCount = targets.filter((t) => t.hasOpenAlert).length;
  if (alertCount > 0) {
    warnings.push(
      `${alertCount} of the selected invoice(s) already carry an open price alert for this product. Relabelling changes how that line is judged, so review those alerts afterwards.`
    );
  }
  if (targets.length > 0) {
    warnings.push(
      'The product’s price history is rebuilt from its lines, so its current / previous / min / max price may move. Nothing else about the product is touched.'
    );
  }

  return {
    productId: product.id,
    productName: product.name,
    newUnit,
    newUnitLabel: option?.label ?? newUnit,
    scope,
    invoiceCount: targets.length,
    lineCount: targets.reduce((n, t) => n + t.lineCount, 0),
    fromUnits,
    perInvoice: targets.map((t) => ({
      invoiceId: t.invoiceId,
      invoiceNumber: t.invoiceNumber,
      invoiceDate: t.invoiceDate,
      vendorName: t.vendorName,
      fromUnits: t.units,
      lineCount: t.lineCount,
      unitPrice: t.unitPrice,
    })),
    skippedInvoices: skipped,
    warnings,
  };
}

/**
 * Writes the new unit onto every line of the chosen invoices, relabels nothing else, then
 * rebuilds the one product the lines belong to.
 *
 * Order matters: the lines take their new label first, then the product's history is
 * replayed from them, then every touched invoice is re-judged - so what is shown is always
 * derived from the same source rather than patched in place.
 */
function applyUnitChange(
  product: MasterProduct,
  targets: ProductUnitInvoice[],
  newUnit: string
): { lines: UnitChangeLineSnapshot[]; invoiceIds: string[]; invoiceNumbers: string[] } {
  const snapshots: UnitChangeLineSnapshot[] = [];
  const touchOrder: string[] = [];
  const invoiceNumbers: string[] = [];

  for (const row of targets) {
    const invoice = db.getInvoice(row.invoiceId);
    if (!invoice) continue;

    for (const line of row.lines) {
      const item = invoice.items.find((it) => it.id === line.itemId);
      if (!item || item.masterProductId !== product.id) continue;
      if (unitChangeBlockFor(invoice, item)) continue;

      const previousUnit = item.unit;
      if (previousUnit === newUnit) {
        // Nothing to write, but still worth recording so the preview matches the outcome.
        snapshots.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          itemId: item.id,
          previousUnit,
          newUnit,
        });
        continue;
      }

      item.unit = newUnit;
      snapshots.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        itemId: item.id,
        previousUnit,
        newUnit,
      });
    }

    db.updateInvoice(invoice.id, invoice);
    if (!touchOrder.includes(invoice.id)) {
      touchOrder.push(invoice.id);
      invoiceNumbers.push(invoice.invoiceNumber);
    }
  }

  refreshProductFromInvoices(product.id);
  for (const invoiceId of touchOrder) refreshLineComparisons(invoiceId);

  return { lines: snapshots, invoiceIds: touchOrder, invoiceNumbers };
}

/**
 * Every line of one product, across every invoice it appears on.
 *
 * The unit column is the input OCR gets wrong most often, and it is the input every price
 * comparison divides by - so this is also the list to look at when a product's history
 * makes no sense.
 */
app.get('/api/catalog/:productId/unit-invoices', (req, res) => {
  const product = db.getMasterProduct(req.params.productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  res.json({
    product,
    unitOptions: UNIT_OPTIONS.map((o) => ({ value: o.value, label: o.label, level: o.level })),
    invoices: collectProductUnitInvoices(product),
  });
});

/** What a change would touch. Writes nothing, so it is safe to call on every keystroke. */
app.post('/api/catalog/:productId/unit-change/preview', (req, res) => {
  const product = db.getMasterProduct(req.params.productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { newUnit, scope, invoiceIds } = req.body as {
    newUnit?: string;
    scope?: UnitChangeScope;
    invoiceIds?: string[];
  };

  if (!newUnit || !unitOptionFor(newUnit)) {
    return res
      .status(400)
      .json({ error: `"${newUnit ?? ''}" is not one of this system's units. Pick one from the list.` });
  }
  if (scope !== 'all' && scope !== 'selected') {
    return res.status(400).json({ error: 'Choose whether this applies to all invoices or only selected ones.' });
  }
  if (scope === 'selected' && (!Array.isArray(invoiceIds) || invoiceIds.length === 0)) {
    return res.status(400).json({ error: 'Tick at least one invoice, or switch the scope to all invoices.' });
  }

  const rows = collectProductUnitInvoices(product);
  res.json(buildUnitChangePreview(product, rows, newUnit, scope, invoiceIds ?? []));
});

/** Applies the change and writes the record that makes it reversible. */
app.post('/api/catalog/:productId/unit-change', (req, res) => {
  try {
    const product = db.getMasterProduct(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const { newUnit, scope, invoiceIds } = req.body as {
      newUnit?: string;
      scope?: UnitChangeScope;
      invoiceIds?: string[];
    };

    if (!newUnit || !unitOptionFor(newUnit)) {
      return res.status(400).json({ error: `"${newUnit ?? ''}" is not one of this system's units.` });
    }
    if (scope !== 'all' && scope !== 'selected') {
      return res.status(400).json({ error: 'Choose a scope before applying this change.' });
    }

    const rows = collectProductUnitInvoices(product);
    const { targets, skipped } = resolveUnitChangeTargets(rows, scope, invoiceIds ?? []);
    if (targets.length === 0) {
      return res.status(400).json({
        error:
          skipped.length > 0
            ? `Nothing to change - every invoice selected is locked or otherwise uneditable.`
            : 'No invoices selected.',
        skipped,
      });
    }

    const openAlertsBefore = db
      .getAlerts()
      .filter((a) => a.status === 'active' && a.masterProductId === product.id).length;

    const applied = applyUnitChange(product, targets, newUnit);

    const record: UnitChangeRecord = {
      id: `uc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productId: product.id,
      productName: product.name,
      kind: 'change',
      scope,
      newUnit,
      fromUnit: applied.lines.length
        ? Array.from(new Set(applied.lines.map((l) => l.previousUnit))).join(', ')
        : null,
      changedAt: new Date().toISOString(),
      invoiceIds: applied.invoiceIds,
      invoiceNumbers: applied.invoiceNumbers,
      lineCount: applied.lines.length,
      lines: applied.lines,
      skipped,
      openAlertsAtChange: openAlertsBefore,
      revertedAt: null,
    };
    db.addUnitChangeRecord(record);

    const refreshed = db.getMasterProduct(product.id) ?? product;
    res.json({
      success: true,
      record,
      changedLines: applied.lines.length,
      affectedInvoices: applied.invoiceIds.length,
      openAlertsAffected: openAlertsBefore,
      skipped,
      product: {
        id: refreshed.id,
        standardUnit: refreshed.standardUnit,
        currentPrice: refreshed.currentPrice,
      },
    });
  } catch (err: any) {
    console.error('Unit change failed:', err);
    res.status(500).json({ error: err.message || 'Unit change failed' });
  }
});

/** The audit trail for one product, newest first. */
app.get('/api/catalog/:productId/unit-changes', (req, res) => {
  res.json({ records: db.getUnitChangeRecordsFor(req.params.productId) });
});

/**
 * Undoes a recorded change from the snapshot taken at the time.
 *
 * Each line is restored to the unit it carried before - not to today's product standard -
 * so a revert is exact even when later edits have moved things around. Rows whose invoice
 * has since disappeared are reported rather than silently dropped.
 */
app.post('/api/unit-changes/:recordId/revert', (req, res) => {
  try {
    const record = db.getUnitChangeLog().find((r) => r.id === req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Change record not found' });
    if (record.revertedAt) {
      return res.status(400).json({ error: `This change was already reverted on ${record.revertedAt.slice(0, 10)}.` });
    }

    const product = db.getMasterProduct(record.productId);
    if (!product) return res.status(404).json({ error: 'The product of this change no longer exists' });

    const restored: UnitChangeLineSnapshot[] = [];
    const missing: { invoiceId: string; invoiceNumber: string; reason: string }[] = [];
    const touched: string[] = [];
    const touchedNumbers: string[] = [];

    for (const snapshot of record.lines) {
      const invoice = db.getInvoice(snapshot.invoiceId);
      const item = invoice?.items.find((it) => it.id === snapshot.itemId);
      if (!invoice || !item) {
        missing.push({
          invoiceId: snapshot.invoiceId,
          invoiceNumber: snapshot.invoiceNumber,
          reason: 'This invoice no longer exists, so its line cannot be restored.',
        });
        continue;
      }
      if (item.masterProductId !== product.id) {
        missing.push({
          invoiceId: snapshot.invoiceId,
          invoiceNumber: snapshot.invoiceNumber,
          reason: 'The line now belongs to a different product (it was split since).',
        });
        continue;
      }

      const currentUnit = item.unit;
      item.unit = snapshot.previousUnit;
      restored.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        itemId: item.id,
        previousUnit: currentUnit,
        newUnit: snapshot.previousUnit,
      });
      db.updateInvoice(invoice.id, invoice);
      if (!touched.includes(invoice.id)) {
        touched.push(invoice.id);
        touchedNumbers.push(invoice.invoiceNumber);
      }
    }

    refreshProductFromInvoices(product.id);
    for (const invoiceId of touched) refreshLineComparisons(invoiceId);

    const revertedUnits = Array.from(new Set(restored.map((r) => r.newUnit)));
    const revertRecord: UnitChangeRecord = {
      id: `uc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productId: product.id,
      productName: product.name,
      kind: 'revert',
      revertsRecordId: record.id,
      scope: 'selected',
      newUnit: revertedUnits.length === 1 ? revertedUnits[0] : (revertedUnits.join(', ') || '(mixed)'),
      fromUnit: Array.from(new Set(restored.map((r) => r.previousUnit))).join(', ') || null,
      changedAt: new Date().toISOString(),
      invoiceIds: touched,
      invoiceNumbers: touchedNumbers,
      lineCount: restored.length,
      lines: restored,
      skipped: missing,
      openAlertsAtChange: db
        .getAlerts()
        .filter((a) => a.status === 'active' && a.masterProductId === product.id).length,
      revertedAt: null,
    };
    db.addUnitChangeRecord(revertRecord);
    db.updateUnitChangeRecord(record.id, {
      revertedAt: revertRecord.changedAt,
      revertedByRecordId: revertRecord.id,
    });

    res.json({
      success: true,
      record: revertRecord,
      restoredLines: restored.length,
      affectedInvoices: touched.length,
      skipped: missing,
    });
  } catch (err: any) {
    console.error('Unit change revert failed:', err);
    res.status(500).json({ error: err.message || 'Revert failed' });
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
      weight?: number | null;
      unitPrice?: number;
      totalPrice?: number;
    };

    // Meat is priced by weight: accept the corrected weight first, because the per-kg
    // price is re-derived from it below (total / weight).
    if (body.weight !== undefined) {
      const w = Number(body.weight);
      item.weight = Number.isFinite(w) && w > 0 ? w : null;
    }

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

    // Meat is priced by weight: re-derive the per-kg price from the corrected total /
    // weight so an edited line is judged in kilograms. A unit price the user typed in
    // themselves is respected and left alone.
    if (!unitPriceChanged) {
      const derived = applyWeightPricing(item);
      if (derived.unitPrice != null) item.unitPrice = derived.unitPrice;
      if (derived.unit) item.unit = derived.unit;
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
        packSize: item.packSize ?? undefined,
        baseUnitPrice: basePriceFor(product, item.unitPrice, item.unit, item.packSize),
      };
      if (target >= 0) product.priceHistory[target] = entry;
      else product.priceHistory.push(entry);

      recalculateProductStats(product);
      comparison = compareAgainstHistory(
        product,
        item.unitPrice,
        item.unit,
        invoice.invoiceNumber,
        invoice.invoiceDate,
        item.packSize
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
      item.notComparableCode = comparison.notComparableCode ?? null;
      item.notComparableReason = comparison.notComparableReason ?? null;
      attachStandardPricing(item);

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
        weight: it.weight ?? null,
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
          it.notComparableCode = check.notComparableCode ?? null;
          it.notComparableReason = check.notComparableReason ?? null;
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
          invoice.invoiceDate,
          item.packSize
        );
        item.previousPrice = cmp.previousPrice;
        item.priceDelta = cmp.deltaAmount;
        item.priceDeltaPercent = cmp.percentChange;
        item.baseUnitPrice = cmp.baseUnitPrice;
        item.baseUnit = cmp.baseUnit;
        item.priceComparable = cmp.comparable;
        item.notComparableCode = cmp.notComparableCode ?? null;
        item.notComparableReason = cmp.notComparableReason ?? null;
        attachStandardPricing(item);
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

/**
 * Re-judges every open alert with the current rules and drops the ones that no longer
 * hold: copies of a move already reported, and "increases" that are only the unit label
 * moving. Safe to run repeatedly.
 */
app.post('/api/alerts/revalidate', (req, res) => {
  try {
    res.json(revalidateActiveAlerts());
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Could not revalidate alerts' });
  }
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

  // Global JSON error handler. An error thrown OUTSIDE a route's own try/catch - most
  // commonly `express.json` rejecting an oversized body - would otherwise reach Express's
  // default HTML error page. The browser then fails to JSON.parse it and the UI only ever
  // shows a bare "OCR failed". Always answer with JSON so the real cause is visible.
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (res.headersSent) return _next(err);
    const status = err?.status || err?.statusCode || 500;
    console.error('[Unhandled error]', err);
    res.status(status).json({ error: err?.message || 'Internal server error' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SpendPulse server ready on 0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup failure:', err);
  process.exit(1);
});
