import { describe, expect, it } from 'vitest';
import { createAiClient } from '../src/ai/provider';
import { loadConfig } from '../src/config';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  SUPABASE_JWT_SECRET: 'x',
  STORAGE_DRIVER: 'memory',
  DOWNLOAD_SIGNING_SECRET: 'download-signing-secret-for-tests-0123456789',
};

type Captured = { url: string; headers: Record<string, string>; body: Record<string, any> };

/** HTTP test double at the network boundary for both providers. */
function fakeFetch(handlers: { anthropic?: (b: any) => [number, unknown]; openai?: (b: any) => [number, unknown] }, calls: Captured[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, headers, body });
    const h = url.includes('anthropic.com') ? handlers.anthropic : handlers.openai;
    const [status, json] = h ? h(body) : [500, {}];
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const claudeMessage = (content: unknown[], stop_reason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 20 },
});

describe('AI provider configuration', () => {
  it('requires the key for each chosen provider', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY is required/);
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AI_FALLBACK_PROVIDER: 'openai' } as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY is required/);
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k', AI_FALLBACK_PROVIDER: 'openai' } as NodeJS.ProcessEnv)).toThrow(/must differ/);
  });
});

describe('Anthropic provider', () => {
  const config = loadConfig({ ...base, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', AI_FALLBACK_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

  it('calls the Messages API with the Claude model, system prompt and refusal fallbacks', async () => {
    const calls: Captured[] = [];
    const ai = createAiClient(config, fakeFetch({ anthropic: () => [200, claudeMessage([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '```json\n{"ok":true}\n```' }])] }, calls));
    expect(ai.model).toBe('claude-opus-5-5');
    const out = await ai.json<{ ok: boolean }>([
      { role: 'system', content: 'You extract data.' },
      { role: 'user', content: 'Resume text' },
    ]);
    expect(out).toEqual({ ok: true });
    const c = calls[0];
    expect(c.url).toMatch(/api\.anthropic\.com\/v1\/messages/);
    expect(c.headers['x-api-key']).toBe('sk-ant-test');
    expect(c.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(c.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(c.body.system).toContain('You extract data.');
    expect(c.body.system).toContain('JSON');
    expect(c.body.messages).toEqual([{ role: 'user', content: 'Resume text' }]);
    expect(c.body.temperature).toBeUndefined();
  });

  it('falls back to OpenAI when Anthropic fails', async () => {
    const calls: Captured[] = [];
    const ai = createAiClient(
      config,
      fakeFetch(
        {
          anthropic: () => [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }],
          openai: () => [200, { choices: [{ message: { content: 'Dear Hiring Team,' } }] }],
        },
        calls,
      ),
    );
    expect(await ai.text([{ role: 'user', content: 'Write a letter' }])).toBe('Dear Hiring Team,');
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['api.anthropic.com', 'api.openai.com']);
  });

  it('does not route a safety refusal to another provider', async () => {
    const calls: Captured[] = [];
    const ai = createAiClient(config, fakeFetch({ anthropic: () => [200, claudeMessage([], 'refusal')], openai: () => [200, { choices: [{ message: { content: 'x' } }] }] }, calls));
    await expect(ai.text([{ role: 'user', content: 'x' }])).rejects.toThrow(/declined/);
    expect(calls).toHaveLength(1);
  });

  it('OpenAI can be primary with Anthropic as fallback', async () => {
    const cfg = loadConfig({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', AI_FALLBACK_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' } as NodeJS.ProcessEnv);
    const calls: Captured[] = [];
    const ai = createAiClient(cfg, fakeFetch({ openai: () => [503, {}], anthropic: () => [200, claudeMessage([{ type: 'text', text: 'Hello' }])] }, calls));
    expect(await ai.text([{ role: 'user', content: 'hi' }])).toBe('Hello');
    expect(calls).toHaveLength(2);
  });
});
