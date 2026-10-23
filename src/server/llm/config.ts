import type { LlmModelKind, LlmProvider } from './types.ts';
import { createDeepSeekProvider } from './deepseekProvider.ts';
import { createGeminiProvider } from './geminiProvider.ts';

export type ProviderId = 'deepseek' | 'gemini';

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Provider selection order: explicit LLM_PROVIDER > whichever key is present > deepseek.
 * DeepSeek is the project default so a single DEEPSEEK_API_KEY is enough to run everything.
 */
export function resolveProviderId(): ProviderId {
  const raw = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (raw === 'deepseek' || raw === 'gemini') return raw;
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'deepseek';
}

export function resolveDefaultModel(provider: ProviderId, kind: LlmModelKind): string {
  if (provider === 'deepseek') {
    // deepseek-flash (V4.1-Flash) is the only DeepSeek model with image input.
    return kind === 'vision' ? 'deepseek-flash' : 'deepseek-flash';
  }
  return 'gemini-2.5-flash';
}

export function resolveModelOverrides(provider: ProviderId, kind: LlmModelKind): string[] {
  const env = process.env;
  if (provider === 'deepseek') {
    const primary =
      kind === 'vision'
        ? firstNonEmpty(env.DEEPSEEK_VISION_MODEL, env.DEEPSEEK_MODEL, env.DEEPSEEK_OCR_MODEL)
        : firstNonEmpty(env.DEEPSEEK_TEXT_MODEL, env.DEEPSEEK_MODEL, env.DEEPSEEK_CHAT_MODEL);
    const fallback =
      kind === 'vision'
        ? firstNonEmpty(env.DEEPSEEK_VISION_MODEL_FALLBACK)
        : firstNonEmpty(env.DEEPSEEK_TEXT_MODEL_FALLBACK);
    const chains = [primary, fallback].filter(Boolean) as string[];
    return chains.length ? chains : [resolveDefaultModel(provider, kind)];
  }

  const primary =
    kind === 'vision'
      ? firstNonEmpty(env.GEMINI_OCR_MODEL, env.GEMINI_VISION_MODEL)
      : firstNonEmpty(env.GEMINI_CHAT_MODEL, env.GEMINI_TEXT_MODEL);
  const fallback =
    kind === 'vision'
      ? firstNonEmpty(env.GEMINI_OCR_MODEL_FALLBACK, env.GEMINI_VISION_MODEL_FALLBACK)
      : firstNonEmpty(env.GEMINI_CHAT_MODEL_FALLBACK, env.GEMINI_TEXT_MODEL_FALLBACK);
  const chains = [primary, fallback].filter(Boolean) as string[];
  return chains.length ? chains : [resolveDefaultModel(provider, kind)];
}

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  const id = resolveProviderId();
  cached = id === 'gemini' ? createGeminiProvider() : createDeepSeekProvider();
  return cached;
}

/** Test seam: drop the cached provider after mutating env vars. */
export function resetProviderCache(): void {
  cached = null;
}
