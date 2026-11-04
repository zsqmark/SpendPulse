import type { LlmModelKind, LlmProvider, ProviderId } from './types.ts';
import { createDeepSeekProvider } from './deepseekProvider.ts';
import { createGeminiProvider } from './geminiProvider.ts';
import { createHunyuanProvider } from './hunyuanProvider.ts';

export type { ProviderId } from './types.ts';

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Provider selection order: explicit LLM_PROVIDER > whichever key is present > gemini.
 * Precedence between keys follows the order the providers were added, so existing
 * deployments keep the provider they already resolve to.
 */
export function resolveProviderId(): ProviderId {
  const raw = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (raw === 'deepseek' || raw === 'gemini' || raw === 'hunyuan') return raw;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.HUNYUAN_API_KEY) return 'hunyuan';
  return 'gemini';
}

/** True when the credentials this provider needs are present in the environment. */
export function isProviderConfigured(provider: ProviderId): boolean {
  switch (provider) {
    case 'deepseek':
      return Boolean(process.env.DEEPSEEK_API_KEY);
    case 'hunyuan':
      return Boolean(process.env.HUNYUAN_API_KEY);
    case 'gemini':
      return Boolean(process.env.GEMINI_API_KEY);
  }
}

export function resolveDefaultModel(provider: ProviderId, kind: LlmModelKind): string {
  if (provider === 'deepseek') {
    // deepseek-flash (V4.1-Flash) is the only DeepSeek model with image input.
    return kind === 'vision' ? 'deepseek-flash' : 'deepseek-flash';
  }
  if (provider === 'hunyuan') {
    // TokenHub names: hy-vision-2.0-instruct reads images, hy4 is the text flagship.
    // (glm-5v-turbo also reads images but is pre-offline; the legacy Hunyuan platform's
    // hunyuan-vision-latest / hunyuan-turbos-latest do not exist on TokenHub.)
    return kind === 'vision' ? 'hy-vision-2.0-instruct' : 'hy4';
  }
  return 'gemini-flash-latest';
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

  if (provider === 'hunyuan') {
    const primary =
      kind === 'vision'
        ? firstNonEmpty(env.HUNYUAN_VISION_MODEL, env.HUNYUAN_MODEL, env.HUNYUAN_OCR_MODEL)
        : firstNonEmpty(env.HUNYUAN_TEXT_MODEL, env.HUNYUAN_CHAT_MODEL, env.HUNYUAN_MODEL);
    const fallback =
      kind === 'vision'
        ? firstNonEmpty(env.HUNYUAN_VISION_MODEL_FALLBACK)
        : firstNonEmpty(env.HUNYUAN_TEXT_MODEL_FALLBACK);
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

const cache = new Map<ProviderId, LlmProvider>();

function buildProvider(id: ProviderId): LlmProvider {
  if (id === 'hunyuan') return createHunyuanProvider();
  if (id === 'deepseek') return createDeepSeekProvider();
  return createGeminiProvider();
}

/**
 * The provider to run a request on. Without an explicit choice this is the server default
 * (LLM_PROVIDER / key presence). An explicit choice is still built lazily so a request for
 * a provider whose key is missing fails inside the provider itself, with a clear message.
 */
export function getProvider(requested?: ProviderId): LlmProvider {
  const id =
    requested === 'deepseek' || requested === 'gemini' || requested === 'hunyuan'
      ? requested
      : resolveProviderId();
  let provider = cache.get(id);
  if (!provider) {
    provider = buildProvider(id);
    cache.set(id, provider);
  }
  return provider;
}

/** Test seam: drop the cached providers after mutating env vars. */
export function resetProviderCache(): void {
  cache.clear();
}
