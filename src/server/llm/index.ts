import { getProvider } from './config.ts';
import type { LlmModelKind, LlmProvider, LlmRequest } from './types.ts';

export * from './types.ts';
export {
  getProvider,
  isProviderConfigured,
  resolveDefaultModel,
  resolveModelOverrides,
  resolveProviderId,
  resetProviderCache,
} from './config.ts';

/**
 * The provider a request runs on: the one named on the request when the caller chose one
 * (the scan dialog does), otherwise the server default.
 */
function providerFor(request: Pick<LlmRequest, 'provider'>): LlmProvider {
  return getProvider(request.provider);
}

/** True when the provider a request targets can ingest application/pdf without rasterisation. */
export function providerSupportsPdf(request?: Pick<LlmRequest, 'provider'>): boolean {
  return providerFor(request ?? {}).capabilities.pdfNative;
}

export function activeProviderId(request?: Pick<LlmRequest, 'provider'>): string {
  return providerFor(request ?? {}).id;
}

/**
 * Runs the request against the active provider, walking its model fallback chain.
 * Throws the last error if every model fails.
 */
export async function generateText(request: LlmRequest): Promise<string> {
  const provider = providerFor(request);
  const kind: LlmModelKind = request.modelKind ?? 'text';
  const models = request.model ? [request.model] : provider.resolveModels(kind);

  let lastError: unknown = null;
  for (const model of models) {
    try {
      return await provider.generateText(request, model);
    } catch (err: any) {
      lastError = err;
      console.warn(`[LLM/${provider.id}] model "${model}" failed: ${err?.message || err}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function stripFences(text: string): string {
  let out = text.trim();
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return out;
}

/** Extracts the first balanced JSON object/array from surrounding prose, if present. */
function extractJsonBlock(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonLoose<T = any>(raw: string): T {
  const candidates = [raw.trim(), stripFences(raw), extractJsonBlock(raw) || ''].filter(Boolean);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`LLM returned non-JSON output: ${(lastError as Error)?.message || 'parse failed'}`);
}

/** Structured-output helper: forces JSON mode and parses the result. */
export async function generateJson<T = any>(
  request: Omit<LlmRequest, 'json'> & { json?: LlmRequest['json'] }
): Promise<T> {
  const raw = await generateText({ ...request, json: request.json ?? {} });
  return parseJsonLoose<T>(raw);
}
