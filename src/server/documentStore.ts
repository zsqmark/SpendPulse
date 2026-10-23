import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Persists the source document pages of an invoice so the extracted data can be
 * checked against the original scan later. Stored under data/documents (git-ignored).
 */

const ROOT = path.join(process.cwd(), 'data', 'documents');
/** Hard cap per invoice so long statements cannot quietly fill the disk. */
const MAX_TOTAL_BYTES = Number(process.env.DOCUMENT_STORE_MAX_MB || 120) * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

export interface IncomingPage {
  base64Data?: string;
  mimeType?: string;
  pageNumber?: number;
}

export interface StoredPage {
  pageNumber: number;
  mimeType: string;
  bytes: number;
}

function extensionFor(mimeType?: string): string {
  return EXT_BY_MIME[(mimeType || '').toLowerCase()] || 'jpg';
}

function assertSafeId(invoiceId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(invoiceId)) {
    throw new Error(`Unsafe invoice id for document storage: ${invoiceId}`);
  }
}

export async function saveInvoicePages(
  invoiceId: string,
  pages: IncomingPage[]
): Promise<StoredPage[]> {
  assertSafeId(invoiceId);
  if (!Array.isArray(pages) || pages.length === 0) return [];

  const dir = path.join(ROOT, invoiceId);
  await fs.mkdir(dir, { recursive: true });

  const stored: StoredPage[] = [];
  let totalBytes = 0;

  for (const page of pages) {
    if (!page?.base64Data) continue;
    const buffer = Buffer.from(page.base64Data, 'base64');
    if (buffer.length === 0) continue;
    if (totalBytes + buffer.length > MAX_TOTAL_BYTES) {
      console.warn(
        `[Documents] Page budget of ${MAX_TOTAL_BYTES / 1024 / 1024}MB reached for ${invoiceId}; remaining pages skipped.`
      );
      break;
    }

    const pageNumber = Number(page.pageNumber) || stored.length + 1;
    const file = path.join(dir, `${pageNumber}.${extensionFor(page.mimeType)}`);
    await fs.writeFile(file, buffer);
    totalBytes += buffer.length;
    stored.push({ pageNumber, mimeType: page.mimeType || 'image/jpeg', bytes: buffer.length });
  }

  if (stored.length > 0) {
    console.log(
      `[Documents] Stored ${stored.length} page(s) for ${invoiceId} (${Math.round(totalBytes / 1024)} KB)`
    );
  }
  return stored;
}

export async function listInvoicePages(
  invoiceId: string
): Promise<Array<{ pageNumber: number; mimeType: string; url: string }>> {
  assertSafeId(invoiceId);
  const dir = path.join(ROOT, invoiceId);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  return entries
    .map((name) => {
      const pageNumber = Number.parseInt(name.split('.')[0], 10);
      const ext = path.extname(name).replace('.', '').toLowerCase();
      const mimeType =
        Object.keys(EXT_BY_MIME).find((m) => EXT_BY_MIME[m] === ext) || 'image/jpeg';
      return {
        pageNumber,
        mimeType,
        url: `/api/invoices/${invoiceId}/pages/${pageNumber}`,
      };
    })
    .filter((p) => Number.isFinite(p.pageNumber))
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function getInvoicePageFile(
  invoiceId: string,
  pageNumber: number
): Promise<{ file: string; mimeType: string } | null> {
  assertSafeId(invoiceId);
  const pages = await listInvoicePages(invoiceId);
  const match = pages.find((p) => p.pageNumber === pageNumber);
  if (!match) return null;

  const ext = EXT_BY_MIME[match.mimeType] || 'jpg';
  return { file: path.join(ROOT, invoiceId, `${pageNumber}.${ext}`), mimeType: match.mimeType };
}

export async function deleteInvoiceDocuments(invoiceId: string): Promise<void> {
  assertSafeId(invoiceId);
  await fs.rm(path.join(ROOT, invoiceId), { recursive: true, force: true });
}

/** Wipes every stored source document (used by the "reset data" action). */
export async function deleteAllDocuments(): Promise<void> {
  await fs.rm(ROOT, { recursive: true, force: true });
}
