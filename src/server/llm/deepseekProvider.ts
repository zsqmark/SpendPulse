import type { LlmMessage, LlmModelKind, LlmPart, LlmProvider, LlmRequest } from './types.ts';
import { resolveDefaultModel, resolveModelOverrides } from './config.ts';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const REQUEST_TIMEOUT_MS = 180_000;

function baseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function thinkingEnabled(): boolean {
  const raw = (process.env.DEEPSEEK_THINKING || 'off').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'enabled';
}

/** DeepSeek accepts JPEG/PNG/GIF/WebP only - PDFs must be rasterised upstream. */
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

interface ChatContentText {
  type: 'text';
  text: string;
}

interface ChatContentImage {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' | 'original' };
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
        // Dropping an image silently would leave the model with text only and produce
        // confidently empty extractions - always make this visible.
        console.warn(
          `[LLM/deepseek] Skipping image part with unsupported mime type "${part.mimeType}".`
        );
        continue;
      }
      content.push({
        type: 'image_url',
        // OCR needs small print and dense tables - never downscale.
        image_url: { url: `data:${part.mimeType};base64,${part.base64}`, detail: 'high' },
      });
    }
    out.push({ role: 'user', content });
  }

  if (json) {
    // DeepSeek JSON Output requires the literal word "json" in the prompt.
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

export function createDeepSeekProvider(): LlmProvider {
  const call = async (request: LlmRequest, model: string): Promise<string> => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is not set. Add it to .env.local to enable AI features.');
    }

    const body: Record<string, unknown> = {
      model,
      messages: toChatMessages(request.messages, request.json),
      max_tokens: request.maxOutputTokens ?? 8192,
      thinking: { type: thinkingEnabled() ? 'enabled' : 'disabled' },
    };
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    if (request.json) body.response_format = { type: 'json_object' };

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
      throw new Error(`DeepSeek ${res.status}: ${detail.slice(0, 400)}`);
    }

    const payload: any = await res.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      // Documented DeepSeek behaviour: JSON mode can occasionally return empty content.
      throw new Error('DeepSeek returned empty content. Retrying...');
    }
    return content;
  };

  return {
    id: 'deepseek',
    capabilities: { pdfNative: false },
    resolveModels(kind: LlmModelKind): string[] {
      const overrides = resolveModelOverrides('deepseek', kind);
      return overrides.length ? overrides : [resolveDefaultModel('deepseek', kind)];
    },
    generateText: call,
  };
}
