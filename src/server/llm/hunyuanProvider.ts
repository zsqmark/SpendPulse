/**
 * Tencent Hunyuan, spoken to through an OpenAI-compatible Chat Completions endpoint.
 *
 * Default endpoint is TokenHub - Tencent's unified model platform and where new Hunyuan
 * accounts are provisioned (the legacy Hunyuan-only platform no longer sells to new users):
 *
 *   - base URL  https://tokenhub.tencentmaas.com/v1
 *   - auth      Authorization: Bearer <HUNYUAN_API_KEY> (TokenHub console -> API Key)
 *   - models    hy-vision-2.0-instruct (images), hy4 (text); hy3 / hunyuan-t1-vision-20250916
 *               make good fallbacks. Accounts still on the LEGACY Hunyuan platform set
 *               HUNYUAN_BASE_URL=https://api.hunyuan.cloud.tencent.com/v1 and the
 *               HUNYUAN_(VISION|TEXT)_MODEL overrides instead.
 *
 * Deliberately a sibling of deepseekProvider rather than a shared base class: the two
 * differ in the small, important ways (TokenHub models have no `thinking` switch, and
 * JSON mode is not advertised, so JSON is enforced by prompt only - parseJsonLoose already
 * tolerates the prose fences that produces).
 *
 * Like DeepSeek, these endpoints accept JPEG/PNG/GIF/WebP images only - PDFs must be
 * rasterised by the browser before upload (capabilities.pdfNative = false).
 */
import type { LlmMessage, LlmModelKind, LlmPart, LlmProvider, LlmRequest } from './types.ts';
import { resolveDefaultModel, resolveModelOverrides } from './config.ts';

const DEFAULT_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
const REQUEST_TIMEOUT_MS = 180_000;

function baseUrl(): string {
  return (process.env.HUNYUAN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Same image set as DeepSeek's OpenAI-compatible endpoint. */
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

interface ChatContentText {
  type: 'text';
  text: string;
}

interface ChatContentImage {
  type: 'image_url';
  image_url: { url: string };
}

type ChatContent = ChatContentText | ChatContentImage;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContent[];
}

function toChatMessages(messages: LlmMessage[], json: LlmRequest['json']): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const msg of messages) {
    const textParts = msg.parts.filter((p) => p.type === 'text') as Extract<
      LlmPart,
      { type: 'text' }
    >[];
    const imageParts = msg.parts.filter((p) => p.type === 'image') as Extract<
      LlmPart,
      { type: 'image' }
    >[];

    if (msg.role === 'system') {
      out.push({ role: 'system', content: textParts.map((p) => p.text).join('\n') });
      continue;
    }

    if (imageParts.length === 0) {
      out.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: textParts.map((p) => p.text).join('\n'),
      });
      continue;
    }

    const content: ChatContent[] = [];
    for (const part of textParts) content.push({ type: 'text', text: part.text });
    for (const part of imageParts) {
      if (!IMAGE_MIME_TYPES.has(part.mimeType)) {
        // An image dropped without a word would leave the model reading text only and
        // producing confidently empty extractions - always make it visible.
        console.warn(
          `[LLM/hunyuan] Skipping image part with unsupported mime type "${part.mimeType}".`
        );
        continue;
      }
      content.push({
        type: 'image_url',
        image_url: { url: `data:${part.mimeType};base64,${part.base64}` },
      });
    }
    out.push({ role: 'user', content });
  }

  if (json) {
    // No native JSON mode is documented for Hunyuan - the prompt instruction plus
    // parseJsonLoose's fence-stripping is what makes structured output work.
    const spec = json.schema ? JSON.stringify(json.schema, null, 2) : null;
    const instruction =
      `Return ONLY a valid JSON document - no prose, no markdown fences.\n` +
      (spec
        ? `The JSON must conform to this JSON Schema:\n${spec}\n`
        : `The JSON must match the structure requested above.\n`);
    out.push({ role: 'user', content: instruction });
  }

  return out;
}

export function createHunyuanProvider(): LlmProvider {
  const call = async (request: LlmRequest, model: string): Promise<string> => {
    const apiKey = process.env.HUNYUAN_API_KEY;
    if (!apiKey) {
      throw new Error('HUNYUAN_API_KEY is not set. Add it to .env.local to enable Hunyuan.');
    }

    const body: Record<string, unknown> = {
      model,
      messages: toChatMessages(request.messages, request.json),
      max_tokens: request.maxOutputTokens ?? 8192,
    };
    if (typeof request.temperature === 'number') body.temperature = request.temperature;

    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Hunyuan ${res.status}: ${detail.slice(0, 400)}`);
    }

    const payload: any = await res.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Hunyuan returned empty content. Retrying...');
    }
    return content;
  };

  return {
    id: 'hunyuan',
    capabilities: { pdfNative: false },
    resolveModels(kind: LlmModelKind): string[] {
      const overrides = resolveModelOverrides('hunyuan', kind);
      return overrides.length ? overrides : [resolveDefaultModel('hunyuan', kind)];
    },
    generateText: call,
  };
}
