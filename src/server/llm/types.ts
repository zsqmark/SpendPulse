/**
 * Provider-agnostic LLM message model.
 *
 * Both DeepSeek (OpenAI-compatible Chat Completions) and Gemini (generateContent)
 * speak these shapes; each provider adapter is responsible for translation.
 */
export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mimeType: string };

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  parts: LlmPart[];
}

/** Which capability class the caller needs - drives default model selection. */
export type LlmModelKind = 'vision' | 'text';

/**
 * The AI backends this app can talk to. Declared here (not in config.ts) because a request
 * carries its own choice, and types.ts must not import from config.ts.
 */
export type ProviderId = 'deepseek' | 'gemini' | 'hunyuan';

export interface LlmRequest {
  messages: LlmMessage[];
  /**
   * Which AI to use for THIS call. Absent = the server default (LLM_PROVIDER / key
   * presence). The scan dialog sets it so the owner can pick the reader per upload.
   */
  provider?: ProviderId;
  /** Explicit model id override (skips kind-based default). */
  model?: string;
  modelKind?: LlmModelKind;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Ask for machine-parseable JSON. `schema` is a best-effort structural hint:
   * Gemini enforces it natively, DeepSeek receives it as a prompt-level spec.
   */
  json?: { schema?: unknown; name?: string };
}

export interface LlmProviderCapabilities {
  /** Provider can consume application/pdf documents directly (no rasterisation needed). */
  pdfNative: boolean;
}

export interface LlmProvider {
  id: ProviderId;
  capabilities: LlmProviderCapabilities;
  /** Ordered list of models to try (first = primary, rest = fallbacks). */
  resolveModels(kind: LlmModelKind): string[];
  generateText(request: LlmRequest, model: string): Promise<string>;
}
