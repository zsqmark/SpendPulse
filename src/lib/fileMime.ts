/**
 * Browsers do not always give a usable `File.type`: entries pulled out of a ZIP
 * archive are re-wrapped as `application/octet-stream`, and some OS/drag-drop
 * combinations leave it empty. The server drops anything that is not a known
 * image type, so always resolve the type from the file name as well.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function isImageMime(mimeType?: string): boolean {
  return !!mimeType && IMAGE_MIMES.has(mimeType.toLowerCase());
}

/** Best-effort mime type for a file, preferring the name over a generic browser type. */
export function resolveFileMimeType(name: string, browserType?: string): string {
  const dot = name.lastIndexOf('.');
  if (dot !== -1) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  }
  return browserType && browserType !== 'application/octet-stream' ? browserType : 'image/jpeg';
}
