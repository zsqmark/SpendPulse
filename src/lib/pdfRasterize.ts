import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

// pdf.js v5 ships an ES-module worker. It MUST be loaded as a *module* worker.
// The previous setup pointed workerSrc at the `?url` of the .mjs and let pdf.js
// spin up a classic `new Worker(url)`. A classic worker cannot load an ESM file, so
// the worker silently failed and pdf.js fell back to a broken fake-worker path that
// throws "a.toHex is not a function" while parsing ANY pdf (toHex is a worker-only
// parser internal). Passing a ready module-worker instance via workerPort avoids that.
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
