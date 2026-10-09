import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config';
import { AppError } from '../lib/errors';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCallOptions {
  /** Output budget for OpenAI-compatible providers. Claude gets a larger budget because its thinking counts toward max_tokens. */
  maxTokens?: number;
  /** Used by OpenAI-compatible providers only; current Claude models reject sampling parameters. */
  temperature?: number;
}

export interface AiClient {
  readonly configured: boolean;
  readonly model: string | null;
  json<T = unknown>(messages: ChatMessage[], opts?: AiCallOptions): Promise<T>;
  text(messages: ChatMessage[], opts?: AiCallOptions): Promise<string>;
}

type ProviderId = 'anthropic' | 'openai' | 'openrouter';

interface Provider {
  id: ProviderId;
  model: string;
  call(messages: ChatMessage[], json: boolean, opts: AiCallOptions): Promise<string>;
}

const JSON_INSTRUCTION = 'Respond with a single valid JSON object only — no prose, no Markdown code fences.';

/* ------------------------------------------------------------------ */
/* Anthropic (Claude) — official SDK                                    */
/* ------------------------------------------------------------------ */

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

function anthropicProvider(config: Config, fetchImpl: typeof fetch): Provider {
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY!, fetch: fetchImpl, maxRetries: 2, timeout: 120_000 });
  const model = config.ANTHROPIC_MODEL ?? DEFAULT_CLAUDE_MODEL;
  return {
    id: 'anthropic',
    model,
    async call(messages, json) {
      const system = [...messages.filter((m) => m.role === 'system').map((m) => m.content), ...(json ? [JSON_INSTRUCTION] : [])].join('\n\n');
      const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await client.beta.messages.create({
          model,
          // Thinking is always on for current Claude models and counts toward max_tokens.
          max_tokens: 16000,
          system,
          messages: turns,
          output_config: { effort: 'medium' },
          // If a safety classifier declines, the API re-runs the request on a suitable model in the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      } catch (e) {
        // Log the cause (never the prompt: it holds personal data) so failures are visible in the server logs.
        console.error(JSON.stringify({ level: 'error', msg: 'Anthropic request failed', status: e instanceof Anthropic.APIError ? e.status : undefined, message: e instanceof Error ? e.message.slice(0, 500) : String(e) }));
        if (e instanceof Anthropic.AuthenticationError) throw new AppError('AI_FAILED', 'Anthropic rejected the API key');
        if (e instanceof Anthropic.RateLimitError) throw new AppError('AI_FAILED', 'Anthropic rate limit reached');
        if (e instanceof Anthropic.APIError) throw new AppError('AI_FAILED', `Anthropic returned ${e.status ?? 'an error'}`);
        throw new AppError('AI_FAILED', 'Anthropic request failed');
      }
      if (res.stop_reason === 'refusal') throw new AppError('AI_FAILED', 'The AI declined this request', { refusal: true });
      if (res.stop_reason === 'max_tokens') throw new AppError('AI_FAILED', 'The AI response was cut off');
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) throw new AppError('AI_FAILED', 'Anthropic returned no text');
      return text;
    },
  };
}

/* ------------------------------------------------------------------ */
/* OpenAI / OpenRouter — OpenAI-compatible chat completions             */
/* ------------------------------------------------------------------ */

function openAiCompatibleProvider(config: Config, id: 'openai' | 'openrouter', fetchImpl: typeof fetch): Provider {
  const isOpenRouter = id === 'openrouter';
  const base = config.AI_BASE_URL ?? (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
  const key = isOpenRouter ? config.OPENROUTER_API_KEY! : config.OPENAI_API_KEY!;
  const model = config.AI_MODEL ?? (isOpenRouter ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');
  return {
    id,
    model,
    async call(messages, json, opts) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const res = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(isOpenRouter ? { 'x-title': 'ApplyFlux' } : {}) },
          body: JSON.stringify({
            model,
            // JSON mode requires the word "JSON" in the messages; add the same instruction Claude gets.
            messages: json ? [{ role: 'system', content: JSON_INSTRUCTION }, ...messages] : messages,
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 1200,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          console.error(JSON.stringify({ level: 'error', msg: `${id} request failed`, status: res.status, message: detail.slice(0, 500) }));
          throw new AppError('AI_FAILED', `${isOpenRouter ? 'OpenRouter' : 'OpenAI'} returned ${res.status}`);
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
    },
  };
}

function build(config: Config, id: ProviderId, fetchImpl: typeof fetch): Provider {
  return id === 'anthropic' ? anthropicProvider(config, fetchImpl) : openAiCompatibleProvider(config, id, fetchImpl);
}

function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Tolerate a stray sentence around the object.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new AppError('AI_FAILED', 'AI returned malformed JSON');
  }
}

/**
 * AI client with an optional fallback provider: when the primary fails
 * (outage, rate limit, bad key, malformed output), the same request is sent to
 * AI_FALLBACK_PROVIDER. A safety refusal is never retried on another provider.
 */
export function createAiClient(config: Config, fetchImpl: typeof fetch = fetch): AiClient {
  if (config.AI_PROVIDER === 'none') {
    const fail = async (): Promise<never> => {
      throw new AppError('AI_NOT_CONFIGURED', 'AI features are not configured on this ApplyFlux server (set AI_PROVIDER and an API key).');
    };
    return { configured: false, model: null, json: fail, text: fail };
  }
  const chain = [build(config, config.AI_PROVIDER, fetchImpl)];
  if (config.AI_FALLBACK_PROVIDER !== 'none') chain.push(build(config, config.AI_FALLBACK_PROVIDER, fetchImpl));

  async function run<T>(messages: ChatMessage[], json: boolean, opts: AiCallOptions, map: (raw: string) => T): Promise<T> {
    let last: unknown;
    for (const [i, p] of chain.entries()) {
      try {
        return map(await p.call(messages, json, opts));
      } catch (e) {
        last = e;
        const refusal = e instanceof AppError && (e.details as { refusal?: boolean } | undefined)?.refusal;
        if (refusal || i === chain.length - 1) break;
        console.warn(JSON.stringify({ level: 'warn', msg: 'AI provider failed; trying fallback', provider: p.id, next: chain[i + 1].id, reason: (e as Error).message }));
      }
    }
    throw last;
  }

  return {
    configured: true,
    model: chain[0].model,
    json: <T>(messages: ChatMessage[], opts: AiCallOptions = {}) => run<T>(messages, true, opts, (raw) => parseJson<T>(raw)),
    text: (messages, opts = {}) => run(messages, false, opts, (raw) => raw.trim()),
  };
}
