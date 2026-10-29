import type { AIStatus } from './engine/pipeline.js';

export interface Completion { text: string; tokens: number }

export interface Provider {
  name: string;
  model: string;
  complete(prompt: string): Promise<Completion>;
}

/** A provider failure, already mapped to the status the dashboard shows. */
export class ProviderError extends Error {
  constructor(readonly status: Exclude<AIStatus, 'AVAILABLE' | 'DISABLED'>, message: string) {
    super(message);
  }
}

export interface CallOptions { timeoutMs?: number; retryDelayMs?: number; retries?: number }

const TIMEOUT_MS = 60_000;

function retryWait(response: Response, fallback: number) {
  const header = response.headers.get('retry-after');
  if (!header) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(20_000, Math.max(0, seconds * 1000));
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.min(20_000, Math.max(0, when - Date.now()));
  return fallback;
}

/** One POST with a 60s timeout and up to two retries on 429 or 5xx. */
export async function postJson(url: string, init: { headers: Record<string, string>; body: unknown }, options: CallOptions = {}) {
  const attempt = async () => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: JSON.stringify(init.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('ERROR', 'The model did not answer in time');
      throw new ProviderError('ERROR', 'The model endpoint is unreachable');
    }
  };
  let response = await attempt();
  for (let retry = 0; retry < (options.retries ?? 2) && (response.status === 429 || response.status >= 500); retry += 1) {
    const wait = options.retryDelayMs ?? retryWait(response, 1500);
    await new Promise((resolve) => setTimeout(resolve, wait));
    response = await attempt();
  }
  if (response.status === 429) throw new ProviderError('RATE_LIMITED', 'The model provider is rate limiting requests');
  if (response.status === 401 || response.status === 403) throw new ProviderError('ERROR', 'The model provider rejected the API key');
  if (!response.ok) throw new ProviderError('ERROR', `The model provider returned ${response.status}`);
  try {
    return await response.json() as unknown;
  } catch {
    throw new ProviderError('ERROR', 'The model provider returned invalid JSON');
  }
}

export function anthropicProvider(apiKey: string, model: string, options: CallOptions = {}): Provider {
  return {
    name: 'anthropic',
    model,
    async complete(prompt) {
      const body = await postJson('https://api.anthropic.com/v1/messages', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] },
      }, options) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      return {
        text: body.content?.map((c) => c.text ?? '').join('\n') ?? '',
        tokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
      };
    },
  };
}

const ATTACK_SCHEMA = {
  type: 'object',
  properties: {
    attacks: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['wrong_solution', 'edge_case', 'performance'] },
          description: { type: 'string' },
          language: { type: 'string', enum: ['python', 'javascript', 'c', 'cpp', 'java', 'go'] },
          code: { type: 'string' },
          input: { type: 'string' },
        },
        required: ['type', 'description'],
      },
    },
  },
  required: ['attacks'],
};

function geminiRequest(prompt: string, schema: boolean) {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (schema) generationConfig.responseSchema = ATTACK_SCHEMA;
  return { contents: [{ parts: [{ text: prompt }] }], generationConfig };
}

async function geminiComplete(apiKey: string, model: string, prompt: string, options: CallOptions, schema: boolean): Promise<Completion> {
  const body = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    headers: { 'x-goog-api-key': apiKey },
    body: geminiRequest(prompt, schema),
  }, options) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { totalTokenCount?: number } };
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
  if (!text.trim()) throw new ProviderError('ERROR', 'The model returned an empty reply');
  return { text, tokens: body.usageMetadata?.totalTokenCount ?? 0 };
}

export function geminiProvider(apiKey: string, model: string, options: CallOptions = {}): Provider {
  let schema = true;
  return {
    name: 'gemini',
    model,
    async complete(prompt) {
      try {
        return await geminiComplete(apiKey, model, prompt, options, schema);
      } catch (error) {
        if (schema && error instanceof ProviderError && error.message.includes('returned 400')) {
          schema = false;
          return geminiComplete(apiKey, model, prompt, options, false);
        }
        throw error;
      }
    },
  };
}

/** GEMINI_API_KEY, GEMINI_API_KEY_2 … _8, and comma-separated GEMINI_API_KEYS. Duplicates are dropped. */
export function geminiKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env.GEMINI_API_KEYS ?? '').split(/[\s,]+/).map((key) => key.trim()).filter(Boolean);
  const numbered = [2, 3, 4, 5, 6, 7, 8].flatMap((index) => {
    const key = env[`GEMINI_API_KEY_${index}`];
    return key?.trim() ? [key.trim()] : [];
  });
  const first = (env.GEMINI_API_KEY ?? '').trim();
  return [...new Set([first, ...numbered, ...listed].filter(Boolean))];
}

/**
 * Tries each Gemini key in turn. A rate limit, a rejected key, or an empty reply moves the
 * next call on. A working key is kept until it fails.
 */
export function geminiKeyPool(keys: string[], model: string, options: CallOptions = {}): Provider {
  const perKey = keys.map((key) => geminiProvider(key, model, { ...options, retries: keys.length > 1 ? 0 : (options.retries ?? 2) }));
  const cooledUntil = keys.map(() => 0);
  const dead = keys.map(() => false);
  let cursor = 0;
  return {
    name: 'gemini',
    model,
    async complete(prompt) {
      let last: ProviderError = new ProviderError('RATE_LIMITED', 'Every Gemini key is rate limited or rejected');
      for (let step = 0; step < keys.length; step += 1) {
        const index = (cursor + step) % keys.length;
        if (dead[index] || cooledUntil[index] > Date.now()) continue;
        try {
          const result = await perKey[index]!.complete(prompt);
          cursor = index;
          return result;
        } catch (error) {
          last = error instanceof ProviderError ? error : new ProviderError('ERROR', 'The model call failed');
          if (last.status === 'RATE_LIMITED') cooledUntil[index] = Date.now() + 45_000;
          else if (last.message.includes('rejected the API key')) dead[index] = true;
          else cooledUntil[index] = Date.now() + 5_000;
        }
      }
      throw last;
    },
  };
}

/** OpenAI's chat completions shape, which also covers local servers such as Ollama. */
export function openAiCompatibleProvider(baseUrl: string, apiKey: string | undefined, model: string, options: CallOptions = {}): Provider {
  return {
    name: 'openai-compatible',
    model,
    async complete(prompt) {
      const body = await postJson(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: { model, messages: [{ role: 'user', content: prompt }] },
      }, options) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
      return { text: body.choices?.[0]?.message?.content ?? '', tokens: body.usage?.total_tokens ?? 0 };
    },
  };
}

/** Replays canned replies; used by tests and the offline demo. */
export class FakeProvider implements Provider {
  name = 'fake';
  model = 'scripted';
  constructor(private readonly replies: Array<string | Error>) {}
  async complete(): Promise<Completion> {
    const next = this.replies.shift();
    if (next === undefined) return { text: '{"attacks":[]}', tokens: 1 };
    if (next instanceof Error) throw next;
    return { text: next, tokens: 40 };
  }
}

export interface ProviderConfig { provider: Provider | null; status: AIStatus; reason: string | null }

/** Lists Gemini model ids the key can call. Used once from the dashboard, not on every poll. */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new ProviderError(response.status === 429 ? 'RATE_LIMITED' : 'ERROR', `Model list returned ${response.status}`);
  const body = await response.json() as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  return (body.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => (model.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}

/**
 * `AGENT_PROVIDER` is anthropic, gemini, or openai, and `AGENT_MODEL` names the model; nothing
 * is assumed. Missing pieces leave the agent in deterministic mode.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env, options: CallOptions = {}): ProviderConfig {
  const choice = (env.AGENT_PROVIDER ?? '').trim().toLowerCase();
  const legacy = choice === 'gemini' ? env.GEMINI_MODEL : choice === 'anthropic' || choice === 'haiku' ? env.ANTHROPIC_MODEL : undefined;
  const model = (env.AGENT_MODEL || legacy || '').trim();
  if (!choice || choice === 'none' || choice === 'fake') return { provider: null, status: 'DISABLED', reason: 'No AGENT_PROVIDER is set.' };
  if (!model) return { provider: null, status: 'DISABLED', reason: 'AGENT_MODEL is not set.' };
  if (choice === 'anthropic' || choice === 'haiku') {
    return env.ANTHROPIC_API_KEY
      ? { provider: anthropicProvider(env.ANTHROPIC_API_KEY, model, options), status: 'AVAILABLE', reason: null }
      : { provider: null, status: 'DISABLED', reason: 'ANTHROPIC_API_KEY is not set.' };
  }
  if (choice === 'gemini') {
    const keys = geminiKeysFromEnv(env);
    return keys.length
      ? { provider: geminiKeyPool(keys, model, options), status: 'AVAILABLE', reason: null }
      : { provider: null, status: 'DISABLED', reason: 'GEMINI_API_KEY is not set.' };
  }
  if (choice === 'openai') {
    const baseUrl = env.AGENT_BASE_URL || 'https://api.openai.com/v1';
    const key = env.OPENAI_API_KEY || env.AGENT_API_KEY;
    if (!key && !env.AGENT_BASE_URL) return { provider: null, status: 'DISABLED', reason: 'OPENAI_API_KEY is not set.' };
    return { provider: openAiCompatibleProvider(baseUrl, key, model, options), status: 'AVAILABLE', reason: null };
  }
  return { provider: null, status: 'DISABLED', reason: `Unknown AGENT_PROVIDER "${choice}".` };
}
