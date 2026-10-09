import type { Config } from '../config';
import { AppError } from '../lib/errors';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiClient {
  readonly configured: boolean;
  readonly model: string | null;
  json<T = unknown>(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<T>;
  text(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

/** OpenAI-compatible chat client used for both OpenAI and OpenRouter. */
export function createAiClient(config: Config, fetchImpl: typeof fetch = fetch): AiClient {
  if (config.AI_PROVIDER === 'none') {
    const fail = async (): Promise<never> => {
      throw new AppError('AI_NOT_CONFIGURED', 'AI features are not configured on this ApplyFlux server (set AI_PROVIDER and an API key).');
    };
    return { configured: false, model: null, json: fail, text: fail };
  }
  const isOpenRouter = config.AI_PROVIDER === 'openrouter';
  const base = config.AI_BASE_URL ?? (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
  const key = isOpenRouter ? config.OPENROUTER_API_KEY! : config.OPENAI_API_KEY!;
  const model = config.AI_MODEL ?? (isOpenRouter ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');

  async function call(messages: ChatMessage[], json: boolean, opts: { maxTokens?: number; temperature?: number } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          ...(isOpenRouter ? { 'x-title': 'ApplyFlux' } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 1200,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new AppError('AI_FAILED', `AI provider returned ${res.status}`, { body: body.slice(0, 300) });
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new AppError('AI_FAILED', 'AI provider returned no content');
      return content;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('AI_FAILED', e instanceof Error && e.name === 'AbortError' ? 'AI request timed out' : 'AI request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    configured: true,
    model,
    async json<T>(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }) {
      const raw = await call(messages, true, opts);
      try {
        return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as T;
      } catch {
        throw new AppError('AI_FAILED', 'AI returned malformed JSON');
      }
    },
    text: (messages, opts) => call(messages, false, opts),
  };
}
