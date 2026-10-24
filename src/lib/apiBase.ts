/**
 * Resolves a same-origin API path against an optional external API host.
 *
 * When VITE_API_BASE_URL is NOT set (local dev, or Vercel's rewrite proxy) this returns the
 * path unchanged - behaviour is identical to before, so nothing regresses.
 *
 * When it IS set (e.g. pointing at the Lightsail backend) calls go straight to that host.
 * That matters for OCR: a multi-page PDF rasterises into a very large upload and can take
 * 30-120s to process, both of which can exceed a shared proxy's request-body or timeout
 * limits. Talking to the backend directly avoids routing those through Vercel at all.
 */
const rawBase: string = String(
  (import.meta.env as Record<string, unknown>).VITE_API_BASE_URL ?? ''
)
  .trim()
  .replace(/\/+$/, '');

export function apiUrl(path: string): string {
  if (!rawBase) return path;
  return `${rawBase}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The configured external API host, or '' when running same-origin. */
export const API_BASE = rawBase;
