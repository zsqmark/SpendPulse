import { Type } from '@google/genai';
import {
  activeProviderId,
  generateText,
  parseJsonLoose,
  providerSupportsPdf,
  type LlmMessage,
} from './llm/index.ts';
import { lineMergeKey } from './aliasMatcher.ts';
import { PDFDocument } from 'pdf-lib';

/** Pages per AI request. Long invoices are chunked so output stays inside maxOutputTokens. */
const MAX_PAGES_PER_REQUEST = Number(process.env.OCR_PAGES_PER_REQUEST || 4);
/** Dense wholesale pages produce a lot of JSON - keep generous headroom. */
const OCR_MAX_OUTPUT_TOKENS = Number(process.env.OCR_MAX_OUTPUT_TOKENS || 32768);

export interface ExtractedInvoiceItem {
  rawDescription: string;
  supplierSku?: string | null;
  brand?: string | null;
  packSize?: string | null;
  quantity: number;
  /**
   * The weight printed on the line, in kg. Meat invoices print Quantity (cartons) and
   * Weight (kg) as two separate columns, and the line amount is Weight x Price. Keeping
   * them apart is what makes a per-kg price derivable at all.
   */
  weight?: number | null;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  pageNumber?: number;
  /** How many original rows were collapsed into this line by duplicate grouping. */
  mergedCount?: number;
}

export interface ExtractedInvoiceResult {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  isScanned: boolean;
  pageCount?: number;
  notes?: string;
  items: ExtractedInvoiceItem[];
}

export interface DocumentPage {
  base64Data: string;
  mimeType: string;
  fileName?: string;
  pageNumber?: number;
  totalPages?: number;
}

/** Image types the vision providers accept. Anything else is silently dropped upstream. */
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Some upload paths (ZIP extraction, folder drag & drop) hand us a generic
 * `application/octet-stream` mime. Vision providers skip anything they do not
 * recognise, which used to send a text-only request and produce empty results.
 * Recover the real type from the file name before giving up.
 */
function normalizeImageMime(mimeType: string | undefined, fileName?: string): string {
  const mime = (mimeType || '').toLowerCase().trim();
  if (SUPPORTED_IMAGE_MIMES.has(mime)) return mime === 'image/jpg' ? 'image/jpeg' : mime;

  if (fileName) {
    const dot = fileName.lastIndexOf('.');
    if (dot !== -1) {
      const ext = fileName.slice(dot).toLowerCase();
      if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
    }
  }
  return mime;
}

// Heuristic extractor for SKU, Brand, and Pack Size from raw line item text
export function parseItemTokens(raw: string): {
  supplierSku?: string;
  brand?: string;
  packSize?: string;
  cleanName: string;
} {
  let text = raw.trim();
  let sku: string | undefined;
  let packSize: string | undefined;
  let brand: string | undefined;

  // 1. Detect SKU/Item Code (e.g., "#592014", "SKU: 88124"). Requires a keyword/# anchor so
  //    bare 5-8 digit numbers (prices, quantities, ZIP codes) are NOT misclassified as SKUs.
  const skuMatch = text.match(/(?:(?:item|sku|code|ref|art|#)\s*[:#-]?\s*([A-Z0-9-]{4,10}))\b/i);
  if (skuMatch) {
    sku = skuMatch[1];
    text = text.replace(skuMatch[0], ' ').trim();
  }

  // 2. Detect Pack Size / Weight (e.g. "50#", "50 lb", "4/1 gal", "12/32 oz", "6/5#", "30 dz", "100 ct")
  const packMatch =
    text.match(
      /\b(\d+(?:\/\d+)?\s*(?:#|lb|lbs|oz|fl\s*oz|gal|gals|qt|qts|ct|dz|doz|cs|case|bag|can|pk|pack|box))\b/i
    ) || text.match(/\b(50#|35#|25#|10#|5#|1gl)\b/i);
  if (packMatch) {
    packSize = packMatch[1].replace(/#/g, ' lb').replace(/\s+/g, ' ').trim();
    text = text.replace(packMatch[0], ' ').trim();
  }

  // 3. Detect known supplier house brands
  const knownBrands = [
    'Sysco Classic',
    'Sysco Imperial',
    'Sysco Reliance',
    'Glenview Farms',
    'Monarch',
    'Harvest Value',
    'Cattlemans',
    'Dean Foods',
    'Vital Farms',
    'Domino',
    'Pillsbury',
    'Ecolab',
  ];
  for (const b of knownBrands) {
    if (new RegExp(`\\b${b}\\b`, 'i').test(raw)) {
      brand = b;
      text = text.replace(new RegExp(`\\b${b}\\b`, 'i'), ' ').trim();
      break;
    }
  }

  const cleanName = text.replace(/\s+/g, ' ').trim();
  return { supplierSku: sku, brand, packSize, cleanName };
}

/**
 * Collapses repeated rows of the same product inside one invoice (very common on
 * multi-page distributor statements) into a single line with summed quantity and total.
 * The unit price becomes the quantity-weighted average.
 */
export function mergeDuplicateLineItems<T extends ExtractedInvoiceItem>(items: T[]): T[] {
  const byKey = new Map<string, T>();
  const order: string[] = [];

  for (const item of items) {
    const key = lineMergeKey({
      rawDescription: item.rawDescription,
      packSize: item.packSize,
      unit: item.unit,
    });
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, { ...item, mergedCount: 1 });
      order.push(key);
      continue;
    }

    const qty = Number(existing.quantity || 0) + Number(item.quantity || 0);
    const total = Number(existing.totalPrice || 0) + Number(item.totalPrice || 0);
    existing.quantity = qty;
    existing.totalPrice = Number(total.toFixed(2));

    // A merged line's weight is the sum of its weights. Pricing off the summed carton
    // count would be wrong wherever the supplier prints a real weight column, so the
    // weight wins whenever one of the merged rows carried it.
    const weight = Number(existing.weight || 0) + Number(item.weight || 0);
    if (weight > 0) existing.weight = Number(weight.toFixed(3));

    const divisor = weight > 0 ? weight : qty;
    existing.unitPrice = divisor > 0 ? Number((total / divisor).toFixed(4)) : existing.unitPrice;
    existing.mergedCount = (existing.mergedCount || 1) + 1;
    existing.supplierSku = existing.supplierSku || item.supplierSku;
    existing.brand = existing.brand || item.brand;
    existing.packSize = existing.packSize || item.packSize;
    existing.pageNumber = existing.pageNumber || item.pageNumber;
  }

  const merged = order.map((k) => byKey.get(k)!);
  const collapsed = items.length - merged.length;
  if (collapsed > 0) {
    console.log(`[OCR] Grouped ${items.length} rows into ${merged.length} unique line item(s) (${collapsed} duplicate(s) merged).`);
  }
  return merged;
}

/**
 * Automatically inspects a base64 PDF and splits it into individual 1-page PDF documents
 * if it contains more than 1 page.
 */
export async function splitPdfIfNeeded(
  base64Data: string,
  fileName?: string
): Promise<DocumentPage[]> {
  try {
    const pdfBytes = Buffer.from(base64Data, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    if (pageCount <= 1) {
      return [
        {
          base64Data,
          mimeType: 'application/pdf',
          fileName: fileName || 'invoice_page_1.pdf',
          pageNumber: 1,
          totalPages: 1,
        },
      ];
    }

    console.log(`[OCR] Multi-page PDF detected with ${pageCount} pages. Splitting into individual pages...`);
    const pages: DocumentPage[] = [];
    const baseName = fileName ? fileName.replace(/\.pdf$/i, '') : 'invoice';

    for (let i = 0; i < pageCount; i++) {
      const subDoc = await PDFDocument.create();
      const [copiedPage] = await subDoc.copyPages(pdfDoc, [i]);
      subDoc.addPage(copiedPage);
      const subBytes = await subDoc.save();
      pages.push({
        base64Data: Buffer.from(subBytes).toString('base64'),
        mimeType: 'application/pdf',
        fileName: `${baseName}_p${i + 1}.pdf`,
        pageNumber: i + 1,
        totalPages: pageCount,
      });
    }

    return pages;
  } catch (err: any) {
    console.warn('[OCR] PDF split failed or not a valid PDF buffer:', err.message);
    return [
      {
        base64Data,
        mimeType: 'application/pdf',
        fileName: fileName || 'invoice.pdf',
        pageNumber: 1,
        totalPages: 1,
      },
    ];
  }
}

/**
 * Targeted continuation extractor for any page that was skipped in the first multi-page pass
 */
async function extractSinglePageContinuation(params: {
  pageData: string;
  mimeType: string;
  pageNumber: number;
  totalPages: number;
  vendorName?: string;
  invoiceNumber?: string;
}): Promise<ExtractedInvoiceItem[]> {
  const { pageData, mimeType, pageNumber, totalPages, vendorName, invoiceNumber } = params;

  const prompt = `
Extract ALL invoice line items from this CONTINUATION PAGE (Page ${pageNumber} of ${totalPages})
Invoice Reference: ${invoiceNumber || 'Unknown'} from vendor: ${vendorName || 'Distributor'}.

You must extract every single product or supply item row appearing on this specific page.
Do not miss any row.
For each item row:
- rawDescription: exact item text as printed
- supplierSku: vendor SKU/item code if printed, else null
- brand: brand if printed, else null
- packSize: pack configuration (e.g. 50 lb, 4/1 gal, 12/32 oz)
- quantity: the Quantity column (number of cartons/packs/units billed)
- weight: the Weight column in kg (decimal). Read it even when a Quantity column is
  also printed - they are DIFFERENT numbers (e.g. Qty 3, Weight 57.640). null if the
  line prints no weight at all.
- unit: unit of measure (e.g. cs, bag, ea, lb)
- unitPrice: the printed Price column (number). Do NOT compute it - copy what is printed.
- totalPrice: the printed Amount / line total (number)
- pageNumber: ${pageNumber}
`;

  const messages: LlmMessage[] = [
    {
      role: 'user',
      parts: [
        { type: 'text', text: prompt },
        { type: 'image', base64: pageData, mimeType },
      ],
    },
  ];

  const continuationSchema = {
    type: Type.OBJECT,
    properties: {
      items: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            rawDescription: { type: Type.STRING },
            supplierSku: { type: Type.STRING },
            brand: { type: Type.STRING },
            packSize: { type: Type.STRING },
            quantity: { type: Type.NUMBER },
            weight: { type: Type.NUMBER },
            unit: { type: Type.STRING },
            unitPrice: { type: Type.NUMBER },
            totalPrice: { type: Type.NUMBER },
            pageNumber: { type: Type.INTEGER },
          },
          required: ['rawDescription', 'quantity', 'unit', 'unitPrice', 'totalPrice'],
        },
      },
    },
    required: ['items'],
  };

  try {
    const raw = await generateText({
      messages,
      modelKind: 'vision',
      maxOutputTokens: 8192,
      json: { schema: continuationSchema, name: 'continuation_items' },
    });

    const parsed = parseJsonLoose<any>(raw);
    if (Array.isArray(parsed.items)) {
      return parsed.items.map((it: any) => {
        const parsedTokens = parseItemTokens(String(it.rawDescription || ''));
        return {
          rawDescription: String(it.rawDescription || 'Item'),
          supplierSku: it.supplierSku?.trim() || parsedTokens.supplierSku || null,
          brand: it.brand?.trim() || parsedTokens.brand || null,
          packSize: it.packSize?.trim() || parsedTokens.packSize || null,
          quantity: Number(it.quantity) || 1,
          weight: Number(it.weight) > 0 ? Number(it.weight) : null,
          unit: String(it.unit || 'ea'),
          unitPrice: Number(it.unitPrice) || 0,
          totalPrice:
            Number(it.totalPrice) ||
            (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0),
          pageNumber,
        };
      });
    }
  } catch (err: any) {
    console.warn(
      `[OCR Continuation] Targeted pass for page ${pageNumber} failed:`,
      err?.message || err
    );
  }

  return [];
}

export async function extractInvoiceData(params: {
  base64Data?: string;
  mimeType?: string;
  textPayload?: string;
  fileName?: string;
  pages?: DocumentPage[];
}): Promise<ExtractedInvoiceResult> {
  let { base64Data, mimeType, textPayload, fileName, pages } = params;

  const PDF_NOT_SUPPORTED_MSG =
    'This AI provider reads images only, not PDFs. Upload through the web UI, which converts each PDF page to an image before scanning.';

  // 1. Prepare pages. For image-only providers the client must rasterise PDFs first;
  //    server-side PDF rendering is intentionally not supported (unstable in Node).
  if ((!pages || pages.length === 0) && base64Data && mimeType === 'application/pdf') {
    if (!providerSupportsPdf()) {
      throw new Error(PDF_NOT_SUPPORTED_MSG);
    }
    pages = await splitPdfIfNeeded(base64Data, fileName);
  }

  const effectivePages: DocumentPage[] =
    pages && pages.length > 0
      ? pages
      : base64Data && mimeType
      ? [{ base64Data, mimeType, fileName: fileName || 'document', pageNumber: 1, totalPages: 1 }]
      : [];

  if (!providerSupportsPdf() && effectivePages.some((p) => p.mimeType === 'application/pdf')) {
    throw new Error(PDF_NOT_SUPPORTED_MSG);
  }

  // Repair generic mime types (ZIP extracts arrive as application/octet-stream) so the
  // page image actually reaches the model instead of being dropped silently.
  for (const page of effectivePages) {
    const normalized = normalizeImageMime(page.mimeType, page.fileName || fileName);
    if (normalized !== page.mimeType) {
      console.warn(
        `[OCR] Page ${page.pageNumber ?? 1}: mime "${page.mimeType}" is not a supported image - using "${normalized}" instead.`
      );
      page.mimeType = normalized;
    }
  }

  if (
    effectivePages.length > 0 &&
    effectivePages.every((p) => !SUPPORTED_IMAGE_MIMES.has(p.mimeType))
  ) {
    throw new Error(
      `Cannot read "${fileName || 'document'}": unsupported file type "${
        effectivePages[0].mimeType || 'unknown'
      }". Use a JPG, PNG, WebP or GIF image (or upload through the Scan dialog, which converts PDFs for you).`
    );
  }

  const totalPagesCount = effectivePages.length > 0 ? effectivePages.length : 1;

  console.log(
    `[OCR] Preparing extraction for "${fileName || 'document'}" with ${totalPagesCount} page(s)...`
  );

  const promptIntro = `
You are an expert optical character recognition (OCR) and financial document extraction model for wholesale procurement and commercial food & beverage operations.
Thoroughly examine the provided invoice, delivery ticket, or scanned document and extract ALL structured data with comprehensive precision.
Document file name: "${fileName || 'invoice_document'}"
Total document pages: ${totalPagesCount}
${textPayload ? `Accompanying document text / payload:\n${textPayload}\n` : ''}

======================================================================
CRITICAL MULTI-PAGE EXTRACTION MANDATE (MANDATORY):
======================================================================
1. TOTAL PAGES TO INSPECT: This document contains exactly ${totalPagesCount} page(s).
2. MULTI-PAGE COMPLETENESS: In wholesale distributor invoices (e.g. Sysco, US Foods, Gordon Food Service, PFG, Shamrock, KeHE, UNFI), line items frequently flow across Page 1, Page 2, Page 3, etc.
3. EXTRACT FROM EVERY SINGLE PAGE: You MUST examine and extract every single line item from Page 1 all the way to Page ${totalPagesCount}.
4. DO NOT STOP AFTER PAGE 1: You must output entries in the "pages" array for EVERY page (pageNumber: 1, 2, ..., ${totalPagesCount}) containing all product rows appearing on that specific page.
5. CONSOLIDATED ITEMS ARRAY: Also output all rows in the top-level "items" array in exact document sequence with their corresponding "pageNumber".
6. FINAL INVOICE TOTAL: In multi-page invoices, the true grand total ("Total Due", "Net Invoice Total", "Balance") is printed on the FINAL page. Extract the final total payable across all pages.

======================================================================
COLUMN SEMANTICS (MANDATORY - do not collapse columns):
======================================================================
Read the line-item table column by column and keep each column in its own field.
Wholesale food invoices frequently print BOTH a Quantity column and a Weight column:

  Product | Description | Quantity | Weight | Price | Amount
  CM22B   | CHICKEN ... |    3     | 57.640 | $6.00 | $345.84

- quantity  = the Quantity column (3). Cartons / packs / units billed. NOT kilograms.
- weight    = the Weight column (57.640), in kg. This is the physical weight delivered.
- unitPrice = the printed Price column ($6.00). That is the price PER KG here, because
              Amount = Weight x Price. Copy the printed number; never compute it.
- totalPrice= the printed Amount column ($345.84).

Rules:
- If a Weight column is printed, you MUST fill "weight" with that number in kg. Never
  reuse the Quantity value as the weight - they are different numbers on these lines.
- If a weight is printed in grams (e.g. 250 g) convert it to kg (0.25).
- If the line prints no weight at all, set weight to null. Do not guess.
- If the only weight hint is inside the description or pack string (e.g. "2KG(6) R/W"),
  leave "weight" null - pack strings are unreliable and must not be used as a weight.
- amount must equal weight x price on a weight-based line; if your numbers disagree,
  re-read the row.
`;

  // Response schema enforcing page-by-page and flat items extraction
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      vendorName: { type: Type.STRING, description: 'Supplier or vendor name (e.g. Sysco, US Foods, GFS)' },
      invoiceNumber: { type: Type.STRING, description: 'Invoice number or order reference' },
      invoiceDate: { type: Type.STRING, description: 'Date of invoice in YYYY-MM-DD format' },
      dueDate: { type: Type.STRING, description: 'Due date if available' },
      subtotal: { type: Type.NUMBER, description: 'Subtotal before tax' },
      taxAmount: { type: Type.NUMBER, description: 'Tax amount' },
      totalAmount: { type: Type.NUMBER, description: 'Total amount payable across all pages from final page' },
      currency: { type: Type.STRING, description: 'Currency code, e.g. USD, EUR' },
      pageCount: { type: Type.INTEGER, description: 'Total number of pages scanned' },
      isScanned: { type: Type.BOOLEAN, description: 'True if scanned physical paper receipt/photo' },
      notes: { type: Type.STRING, description: 'Any payment terms or summary notes' },
      pages: {
        type: Type.ARRAY,
        description: `Array of extracted pages. You MUST create an entry for each page from 1 to ${totalPagesCount}.`,
        items: {
          type: Type.OBJECT,
          properties: {
            pageNumber: { type: Type.INTEGER, description: 'Page number (1, 2, ...)' },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  rawDescription: { type: Type.STRING, description: 'Raw description exactly as printed' },
                  supplierSku: { type: Type.STRING, description: 'Supplier item code or SKU number' },
                  brand: { type: Type.STRING, description: 'Brand or manufacturer' },
                  packSize: { type: Type.STRING, description: 'Pack configuration or net weight' },
                  quantity: { type: Type.NUMBER, description: 'Quantity column (cartons/packs/units billed) - not kilograms' },
                  weight: { type: Type.NUMBER, description: 'Weight column in kg as printed on the line (e.g. 57.64). null when the line prints no weight' },
                  unit: { type: Type.STRING, description: 'Unit of measure, e.g. bag, case, lb, quart' },
                  unitPrice: { type: Type.NUMBER, description: 'The printed Price column value, copied as-is' },
                  totalPrice: { type: Type.NUMBER, description: 'Total price for line' },
                  pageNumber: { type: Type.INTEGER, description: 'Page number' },
                },
                required: ['rawDescription', 'quantity', 'unit', 'unitPrice', 'totalPrice'],
              },
            },
          },
          required: ['pageNumber', 'items'],
        },
      },
      items: {
        type: Type.ARRAY,
        description: 'All line items extracted across all pages in sequential order',
        items: {
          type: Type.OBJECT,
          properties: {
            rawDescription: { type: Type.STRING, description: 'Raw description exactly as printed' },
            supplierSku: { type: Type.STRING, description: 'Supplier item code or SKU number' },
            brand: { type: Type.STRING, description: 'Brand or manufacturer' },
            packSize: { type: Type.STRING, description: 'Pack configuration or net weight' },
            quantity: { type: Type.NUMBER, description: 'Quantity column (cartons/packs/units billed) - not kilograms' },
            weight: { type: Type.NUMBER, description: 'Weight column in kg as printed on the line (e.g. 57.64). null when the line prints no weight' },
            unit: { type: Type.STRING, description: 'Unit of measure, e.g. bag, case, lb, quart' },
            unitPrice: { type: Type.NUMBER, description: 'The printed Price column value, copied as-is' },
            totalPrice: { type: Type.NUMBER, description: 'Total price for line' },
            pageNumber: { type: Type.INTEGER, description: 'Page number where this item appears (1, 2, ...)' },
          },
          required: ['rawDescription', 'quantity', 'unit', 'unitPrice', 'totalPrice'],
        },
      },
    },
    required: ['vendorName', 'invoiceNumber', 'invoiceDate', 'totalAmount'],
  };

  const collectedItems: ExtractedInvoiceItem[] = [];
  let firstParsed: any = null;
  let finalParsed: any = null;
  let lastError: any = null;

  const chunks: DocumentPage[][] = [];
  if (effectivePages.length > MAX_PAGES_PER_REQUEST) {
    for (let i = 0; i < effectivePages.length; i += MAX_PAGES_PER_REQUEST) {
      chunks.push(effectivePages.slice(i, i + MAX_PAGES_PER_REQUEST));
    }
    console.log(
      `[OCR] ${effectivePages.length} pages exceed ${MAX_PAGES_PER_REQUEST}/request - splitting into ${chunks.length} chunks.`
    );
  } else {
    chunks.push(effectivePages);
  }

  // Processing one chunk. If a chunk fails (usually the response was truncated by the
  // output token limit) it is split in half and retried - that way long invoices still
  // finish instead of silently dropping pages.
  const processChunk = async (
    chunk: DocumentPage[],
    chunkIndex: number,
    chunkTotal: number
  ): Promise<void> => {
    const parts: LlmMessage['parts'] = [{ type: 'text', text: promptIntro }];

    // Add each page of this chunk with explicit boundary markers
    chunk.forEach((p, idx) => {
      const pageNum = p.pageNumber || idx + 1;
      parts.push({
        type: 'text',
        text: `\n=======================================================\n>>> DOCUMENT PAGE ${pageNum} OF ${totalPagesCount} <<<\nExtract all line item rows from this page below:\n=======================================================\n`,
      });
      parts.push({ type: 'image', base64: p.base64Data, mimeType: p.mimeType });
      parts.push({
        type: 'text',
        text: `\n>>> END OF DOCUMENT PAGE ${pageNum} OF ${totalPagesCount} <<<\n`,
      });
    });

    const messages: LlmMessage[] = [{ role: 'user', parts }];

    try {
    console.log(
      `[OCR] Calling ${activeProviderId()} vision model for file: ${fileName} (chunk ${chunkIndex + 1}/${chunkTotal}, ${chunk.length} page(s))...`
    );
    const raw = await generateText({
      messages,
      modelKind: 'vision',
      maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
      json: { schema: responseSchema, name: 'invoice_extraction' },
    });

    if (process.env.OCR_DEBUG_RAW === '1') {
      console.log(`[OCR DEBUG] raw length=${(raw || '').length}`);
      console.log(`[OCR DEBUG] raw head:\n${(raw || '(empty)').slice(0, 3000)}`);
    }

    const parsed = parseJsonLoose<any>(raw || '{}');
    if (!firstParsed) firstParsed = parsed;
    finalParsed = parsed;

    // Collect items from both parsed.pages and parsed.items
    let rawItemList: any[] = [];

    if (Array.isArray(parsed.pages) && parsed.pages.length > 0) {
      for (const pg of parsed.pages) {
        const pgNum = Number(pg.pageNumber) || 1;
        if (Array.isArray(pg.items)) {
          for (const it of pg.items) {
            rawItemList.push({
              ...it,
              pageNumber: Number(it.pageNumber) || pgNum,
            });
          }
        }
      }
    }

    if (rawItemList.length === 0 && Array.isArray(parsed.items) && parsed.items.length > 0) {
      rawItemList = parsed.items.map((it: any) => ({
        ...it,
        pageNumber: Number(it.pageNumber) || 1,
      }));
    }

    // Safety check: did any page of THIS chunk return zero items?
    if (chunk.length > 0) {
      const coveredPages = new Set(rawItemList.map((it) => it.pageNumber));
      const missingPages: number[] = [];
      for (let pNum = 1; pNum <= totalPagesCount; pNum++) {
        if (chunk.some((cp) => (cp.pageNumber || 0) === pNum) && !coveredPages.has(pNum)) {
          missingPages.push(pNum);
        }
      }

      if (missingPages.length > 0) {
        console.warn(
          `[OCR] Safety check: Page(s) [${missingPages.join(
            ', '
          )}] had 0 items extracted in initial pass. Running targeted extraction for missed pages...`
        );

        for (const missNum of missingPages) {
          const missed = effectivePages.find((ep) => (ep.pageNumber || 0) === missNum);
          if (missed) {
            const recovered = await extractSinglePageContinuation({
              pageData: missed.base64Data,
              mimeType: missed.mimeType,
              pageNumber: missNum,
              totalPages: totalPagesCount,
              vendorName: parsed.vendorName,
              invoiceNumber: parsed.invoiceNumber,
            });
            if (recovered.length > 0) {
              console.log(`[OCR] Recovered ${recovered.length} items from Page ${missNum}!`);
              rawItemList.push(...recovered);
            }
          }
        }
      }
    }

    // Format this chunk's line items. Only fall back to a placeholder row when the
    // whole document produced nothing at all.
    const chunkItems: ExtractedInvoiceItem[] =
      rawItemList.length > 0
        ? rawItemList.map((it: any) => {
            const parsedTokens = parseItemTokens(String(it.rawDescription || ''));
            return {
              rawDescription: String(it.rawDescription || 'Item'),
              supplierSku: it.supplierSku?.trim() || parsedTokens.supplierSku || null,
              brand: it.brand?.trim() || parsedTokens.brand || null,
              packSize: it.packSize?.trim() || parsedTokens.packSize || null,
              quantity: Number(it.quantity) || 1,
              weight: Number(it.weight) > 0 ? Number(it.weight) : null,
              unit: String(it.unit || 'ea'),
              unitPrice: Number(it.unitPrice) || 0,
              totalPrice:
                Number(it.totalPrice) ||
                (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0),
              pageNumber: Number(it.pageNumber) || 1,
            };
          })
        : collectedItems.length === 0
          ? [
              {
                rawDescription: 'General Invoiced Items',
                supplierSku: null,
                brand: null,
                packSize: null,
                quantity: 1,
                unit: 'lot',
                unitPrice: Number(parsed.totalAmount) || 0,
                totalPrice: Number(parsed.totalAmount) || 0,
                pageNumber: 1,
              },
            ]
          : [];

    collectedItems.push(...chunkItems);

    console.log(
      `[OCR] Chunk ${chunkIndex + 1}/${chunkTotal} via ${activeProviderId()}: ${
        chunkItems.length
      } item(s) - ${collectedItems.length} total so far`
    );
    } catch (err: any) {
      lastError = err;
      if (chunk.length > 1) {
        console.warn(
          `[OCR] Chunk ${chunkIndex + 1}/${chunkTotal} failed (${err?.message}). Splitting it and retrying...`
        );
        const mid = Math.ceil(chunk.length / 2);
        await processChunk(chunk.slice(0, mid), chunkIndex, chunkTotal);
        await processChunk(chunk.slice(mid), chunkIndex, chunkTotal);
        return;
      }
      console.warn(
        `[OCR] Page ${chunk[0]?.pageNumber ?? '?'} could not be extracted via ${activeProviderId()}: ${
          err?.message || err
        }`
      );
    }
  };

  for (let i = 0; i < chunks.length; i++) {
    await processChunk(chunks[i], i, chunks.length);
  }

  if (finalParsed) {
    const header = firstParsed || {};
    const items = [...collectedItems].sort(
      (a, b) => (a.pageNumber || 1) - (b.pageNumber || 1)
    );

    console.log(
      `[OCR] Completed extraction via ${activeProviderId()}: ${header.vendorName} (${items.length} items across ${totalPagesCount} pages)`
    );

    return {
      vendorName: header.vendorName || 'Unknown Vendor',
      invoiceNumber: header.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`,
      invoiceDate: header.invoiceDate || new Date().toISOString().split('T')[0],
      dueDate: header.dueDate,
      subtotal: Number(finalParsed.subtotal) || Number(finalParsed.totalAmount) || 0,
      taxAmount: Number(finalParsed.taxAmount) || 0,
      totalAmount: Number(finalParsed.totalAmount) || 0,
      currency: finalParsed.currency || 'USD',
      isScanned: Boolean(finalParsed.isScanned),
      pageCount: totalPagesCount,
      notes: finalParsed.notes,
      items,
    };
  }

  // Fallback parser if textPayload was provided or if the AI provider is unavailable
  if (textPayload) {
    console.log('[OCR] Using fallback text parser for payload...');
    const lines = textPayload.split('\n').map((l) => l.trim()).filter(Boolean);
    const vendorLine =
      lines.find((l) => /vendor|supplier|from/i.test(l)) || lines[0] || 'Unknown Supplier';
    const cleanVendor = vendorLine.replace(/vendor:|supplier:|from:/i, '').trim();

    const fallbackDesc = lines[1] || 'Invoiced Supplies';
    const parsedTokens = parseItemTokens(fallbackDesc);

    return {
      vendorName: cleanVendor || 'Uploaded Vendor',
      invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
      invoiceDate: new Date().toISOString().split('T')[0],
      subtotal: 100.0,
      taxAmount: 0.0,
      totalAmount: 100.0,
      currency: 'USD',
      isScanned: false,
      pageCount: 1,
      notes: 'Parsed from document text stream',
      items: [
        {
          rawDescription: fallbackDesc,
          supplierSku: parsedTokens.supplierSku || null,
          brand: parsedTokens.brand || null,
          packSize: parsedTokens.packSize || null,
          quantity: 1,
          unit: 'ea',
          unitPrice: 100.0,
          totalPrice: 100.0,
          pageNumber: 1,
        },
      ],
    };
  }

  console.error(`[OCR] All ${activeProviderId()} models failed:`, lastError);
  throw new Error(
    `AI OCR extraction failed: ${
      lastError?.message || 'Provider unavailable or quota exceeded'
    }. Please wait a few seconds and retry.`
  );
}

/**
 * Detects whether a set of page-images belongs to ONE invoice or SEVERAL, and groups the
 * pages into separate invoices. This is what lets one uploaded PDF that actually contains
 * multiple statements produce several invoice records instead of one merged, mis-attributed
 * one.
 *
 * Returns an array of page-groups. A single group (the common case) means "one invoice" and
 * downstream behaviour is unchanged. On any failure it falls back to a single group so the
 * pipeline never breaks.
 */
/**
 * How many page images are sent to the vision model in ONE segmentation call.
 *
 * This matters more than it looks. Line extraction is already chunked (MAX_PAGES_PER_REQUEST),
 * but segmentation used to send every page of a document at once - a 30-page statement pack
 * put 30 full-size images in a single request, the model answered with empty content, and the
 * whole document silently collapsed into ONE invoice carrying hundreds of mixed-up lines.
 * Windows of this size keep each request comfortably within what the model will answer.
 */
const SEGMENT_PAGES_PER_REQUEST = Number(process.env.OCR_SEGMENT_PAGES_PER_REQUEST || 6);

/**
 * Asks the model to group ONE window of pages into invoices.
 *
 * Page numbers are labelled with their number in the WHOLE document, not their position in
 * the window, so the answers of separate windows can be stitched back together. Returns
 * arrays of 1-based global page numbers, or null when the call failed or was unusable.
 */
async function segmentWindowIntoGroups(
  window: DocumentPage[],
  offset: number,
  totalPages: number
): Promise<number[][] | null> {
  const parts: LlmMessage['parts'] = [
    {
      type: 'text',
      text: `These ${window.length} page images are an extract from a ${totalPages}-page document. They may contain ONE or SEVERAL separate invoices, statements, or delivery dockets, possibly from different vendors.

Group the pages by which invoice they belong to. Invoices are usually separated by a new vendor / supplier header, a new invoice number, or a page that begins with a tax / summary / "amount due" totals block.

Each page is labelled with its number in the ORIGINAL document. Return JSON with a "groups" array: one object per invoice, each with "pageNumbers" - a sorted array of those original page numbers. Every page shown must appear in EXACTLY one group, with no gaps and no overlaps. If it is a single multi-page invoice, return one group containing all the pages shown.`,
    },
  ];

  window.forEach((p, idx) => {
    parts.push({ type: 'text', text: `\n----- PAGE ${offset + idx + 1} OF ${totalPages} -----` });
    parts.push({ type: 'image', base64: p.base64Data, mimeType: p.mimeType });
  });

  const schema = {
    type: Type.OBJECT,
    properties: {
      groups: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            pageNumbers: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          },
          required: ['pageNumbers'],
        },
      },
    },
    required: ['groups'],
  };

  try {
    const raw = await generateText({
      messages: [{ role: 'user', parts }],
      modelKind: 'vision',
      maxOutputTokens: 2048,
      json: { schema, name: 'invoice_segmentation' },
    });
    const parsed = parseJsonLoose<any>(raw);
    if (!Array.isArray(parsed?.groups) || parsed.groups.length === 0) return null;

    const inWindow = new Set<number>();
    window.forEach((_, idx) => inWindow.add(offset + idx + 1));

    const groups: number[][] = [];
    for (const g of parsed.groups) {
      const nums: number[] = (Array.isArray(g?.pageNumbers) ? g.pageNumbers : [])
        .filter((n: unknown) => typeof n === 'number' && inWindow.has(n))
        .sort((a: number, b: number) => a - b);
      if (nums.length > 0) groups.push(nums);
    }
    return groups.length > 0 ? groups : null;
  } catch (err: any) {
    console.warn('[OCR] Segmentation window failed:', err?.message);
    return null;
  }
}

export async function segmentPagesIntoInvoices(
  pages: DocumentPage[]
): Promise<DocumentPage[][]> {
  if (!pages || pages.length <= 1) {
    return [pages || []];
  }

  // Only segment when every page is an image we can show the model. A raw-PDF / mixed input
  // is left as one invoice rather than guessing boundaries from non-image data.
  if (!pages.every((p) => p.mimeType !== 'application/pdf')) {
    return [pages];
  }

  const total = pages.length;
  const windowSize = Math.max(2, SEGMENT_PAGES_PER_REQUEST);
  const windows: { start: number; pages: DocumentPage[] }[] = [];

  // Consecutive windows share one page. That shared page is how the boundaries between two
  // windows are joined: if both windows put it in a group, those groups are the same invoice.
  for (let start = 0; start < total; ) {
    const end = Math.min(start + windowSize, total);
    windows.push({ start, pages: pages.slice(start, end) });
    if (end >= total) break;
    start = end - 1;
  }

  if (windows.length > 1) {
    console.log(
      `[OCR] ${total} pages exceed ${windowSize}/segmentation-request - splitting into ${windows.length} overlapping windows.`
    );
  }

  // page number -> which group (index) it was filed under, so a group can be extended later.
  const groups: number[][] = [];
  const used = new Set<number>();

  for (const win of windows) {
    const winGroups = await segmentWindowIntoGroups(win.pages, win.start, total);
    if (!winGroups) {
      // One unusable window means the boundaries cannot be trusted - collapse to a single
      // invoice rather than invent a split across a gap.
      console.warn('[OCR] Segmentation incomplete, treating document as one invoice.');
      return [pages];
    }

    const sharedPage = win.start + 1; // the page this window repeats from the previous one
    const isContinuation = win.start > 0;

    for (const nums of winGroups) {
      const fresh = nums.filter((n) => !used.has(n));
      if (fresh.length === 0) continue; // entirely the shared page - already filed

      const continues = isContinuation && nums.includes(sharedPage) && groups.length > 0;
      if (continues) {
        groups[groups.length - 1].push(...fresh);
      } else {
        groups.push(fresh);
      }
      for (const n of fresh) used.add(n);
    }
  }

  // Safety: trust the split only when every page landed in exactly one group. Anything less
  // (a page the model dropped, or a boundary it never confirmed) is worse than one invoice.
  if (groups.length === 0 || used.size !== total) {
    console.warn(
      `[OCR] Segmentation covered ${used.size}/${total} pages, treating document as one invoice.`
    );
    return [pages];
  }

  const byPage = new Map<number, DocumentPage>();
  pages.forEach((p, idx) => byPage.set(idx + 1, p));

  const selected = groups
    .map((nums) => nums.map((n) => byPage.get(n)).filter((p): p is DocumentPage => Boolean(p)))
    .filter((g) => g.length > 0);

  if (selected.length <= 1) return [pages];

  console.log(`[OCR] Segmented ${total} page(s) into ${selected.length} invoice(s).`);
  return selected;
}

/**
 * End-to-end extraction that supports MULTIPLE invoices inside one uploaded document.
 * Segments the supplied page-images into invoice groups, then runs the normal single-invoice
 * extraction on each. Returns one result per detected invoice.
 */
export async function extractInvoicesFromDocument(params: {
  base64Data?: string;
  mimeType?: string;
  textPayload?: string;
  fileName?: string;
  pages?: DocumentPage[];
}): Promise<{ result: ExtractedInvoiceResult; pages: DocumentPage[] }[]> {
  // The normal Scan dialog path hands us rasterised page-images - segment those.
  if (params.pages && params.pages.length > 0) {
    const groups = await segmentPagesIntoInvoices(params.pages);
    const out: { result: ExtractedInvoiceResult; pages: DocumentPage[] }[] = [];
    for (const group of groups) {
      const result = await extractInvoiceData({ pages: group, fileName: params.fileName });
      result.pageCount = group.length;
      out.push({ result, pages: group });
    }
    return out;
  }

  // Raw base64Data / textPayload: nothing to segment - single invoice.
  const single = await extractInvoiceData(params);
  return [{ result: single, pages: [] }];
}
