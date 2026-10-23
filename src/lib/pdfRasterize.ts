import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker';

// pdf.js v5's modern ESM build keeps the `toHex` compatibility helper ONLY inside its
// worker bundle and relies on the worker running the PDF parser. When that worker fails
// to load (or pdf.js falls back to a fake worker on the main thread) EVERY pdf parse
// throws "a.toHex is not a function" / "r.toHex is not a function" - which is exactly
// the error we hit. The LEGACY build polyfills `Uint8Array.prototype.toHex` on the main
// thread, so it works regardless of worker state. We use it for both the API and the
// worker, and still hand pdf.js a ready module-worker instance via workerPort (Vite's
// ?worker import) to avoid the classic-vs-module worker mismatch.
pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

export interface RasterizedPdfPage {
  base64Data: string;
  mimeType: 'image/jpeg';
  previewUrl: string;
  width: number;
  height: number;
  pageNumber: number;
  totalPages: number;
}

/** Longest edge (px) used for the rendered page images. */
const MAX_EDGE = 2000;
const MIN_EDGE = 1100;
const JPEG_QUALITY = 0.88;

/**
 * Rasterises every page of a PDF into JPEG images in the BROWSER.
 *
 * Image-only providers (DeepSeek) cannot read application/pdf, and doing this
 * server-side (pdf.js + native canvas in Node) segfaults on scanned documents,
 * so the conversion is done where PDF rendering is native and reliable.
 */
export async function rasterizePdfToPages(
  file: File | ArrayBuffer,
  fileName = 'document.pdf'
): Promise<RasterizedPdfPage[]> {
  const data =
    file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer());

  const doc = await pdfjs.getDocument({ data }).promise;
  const total = doc.numPages;

  // Keep the total upload payload reasonable for very long invoices.
  const maxEdge = total > 20 ? MIN_EDGE : MAX_EDGE;
  const pages: RasterizedPdfPage[] = [];

  try {
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height) || 1;
      const scale = Math.max(0.5, Math.min(4, maxEdge / longest));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable for PDF rendering');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      pages.push({
        base64Data: dataUrl.split(',')[1] || '',
        mimeType: 'image/jpeg',
        previewUrl: dataUrl,
        width: canvas.width,
        height: canvas.height,
        pageNumber: n,
        totalPages: total,
      });

      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await doc.destroy();
  }

  if (pages.length === 0) throw new Error(`No pages rendered from ${fileName}`);
  return pages;
}
