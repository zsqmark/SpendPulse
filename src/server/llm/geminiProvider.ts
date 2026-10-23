import { ai } from '../geminiClient.ts';
import type { LlmMessage, LlmModelKind, LlmProvider, LlmRequest } from './types.ts';
import { resolveDefaultModel, resolveModelOverrides } from './config.ts';

type GeminiPart = { text: string } | { inlineData: { data: string; mimeType: string } };

function toGeminiParts(message: LlmMessage): GeminiPart[] {
  return message.parts.map((part) =>
    part.type === 'text'
      ? { text: part.text }
      : { inlineData: { data: part.base64, mimeType: part.mimeType } }
  );
}

export function createGeminiProvider(): LlmProvider {
  const call = async (request: LlmRequest, model: string): Promise<string> => {
    const systemInstruction = request.messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => (p as any).text))
      .join('\n');

    const contents = request.messages
      .filter((m) => m.role !== 'system' && m.parts.length > 0)
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(m),
      }));

    const config: Record<string, unknown> = {
      maxOutputTokens: request.maxOutputTokens ?? 8192,
    };
    if (typeof request.temperature === 'number') config.temperature = request.temperature;
    if (systemInstruction) config.systemInstruction = systemInstruction;
    if (request.json) {
      config.responseMimeType = 'application/json';
      if (request.json.schema) config.responseSchema = request.json.schema;
    }

    const response = await ai.models.generateContent({
      model,
      contents,
      config,
    } as any);

    return response.text || '';
  };

  return {
    id: 'gemini',
    capabilities: { pdfNative: true },
    resolveModels(kind: LlmModelKind): string[] {
      const overrides = resolveModelOverrides('gemini', kind);
      return overrides.length ? overrides : [resolveDefaultModel('gemini', kind)];
    },
    generateText: call,
  };
}
