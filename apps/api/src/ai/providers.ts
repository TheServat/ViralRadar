/**
 * Vendor adapters. Each one is small on purpose: the only thing the
 * application needs from a model here is a short piece of text.
 *
 * Requests go through the shared fetcher, so AI calls obey the same timeouts,
 * retry policy and SSRF rules as everything else. A local Ollama is reachable
 * because its host is passed to the guard explicitly, not because the guard is
 * switched off.
 */
import { config } from '../config.ts';
import { err } from '../errors.ts';
import { request } from '../net/fetcher.ts';
import type { AiProvider, CompletionRequest } from './types.ts';

function localAllowance(baseUrl: string): string[] {
  try {
    return [new URL(baseUrl).hostname];
  } catch {
    return [];
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, allowHosts: string[]): Promise<unknown> {
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    retries: 1,
    rps: 2,
    timeoutMs: 60_000,
    context: 'ai',
    guard: { allowHosts },
  });
  try {
    return JSON.parse(res.body) as unknown;
  } catch (e) {
    throw err.parsing('AI provider returned a non-JSON response', e);
  }
}

/** OpenAI and every service that speaks its chat-completions shape. */
function createOpenAiLike(id: string, defaultBase: string, defaultModel: string): AiProvider {
  const base = (config.ai.baseUrl === '' ? defaultBase : config.ai.baseUrl).replace(/\/+$/, '');
  const model = config.ai.model === '' ? defaultModel : config.ai.model;

  return {
    id,
    model,
    async complete(req: CompletionRequest): Promise<string> {
      const payload = await postJson(
        `${base}/chat/completions`,
        {
          model,
          max_tokens: req.maxTokens,
          temperature: 0.3,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        },
        config.ai.apiKey === '' ? {} : { Authorization: `Bearer ${config.ai.apiKey}` },
        localAllowance(base),
      );
      const choice = (payload as { choices?: { message?: { content?: string } }[] }).choices?.[0];
      return choice?.message?.content?.trim() ?? '';
    },
  };
}

function createAnthropic(): AiProvider {
  const base = (config.ai.baseUrl === '' ? 'https://api.anthropic.com/v1' : config.ai.baseUrl).replace(/\/+$/, '');
  const model = config.ai.model === '' ? 'claude-sonnet-5' : config.ai.model;

  return {
    id: 'anthropic',
    model,
    async complete(req: CompletionRequest): Promise<string> {
      const payload = await postJson(
        `${base}/messages`,
        {
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        },
        { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' },
        localAllowance(base),
      );
      const blocks = (payload as { content?: { type?: string; text?: string }[] }).content ?? [];
      return blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
    },
  };
}

/** Ollama exposes an OpenAI-compatible endpoint; that is the one used here. */
function createOllama(): AiProvider {
  return createOpenAiLike('ollama', 'http://127.0.0.1:11434/v1', 'llama3.2');
}

export function createProvider(): AiProvider | null {
  switch (config.ai.provider) {
    case 'openai':
      return config.ai.apiKey === '' ? null : createOpenAiLike('openai', 'https://api.openai.com/v1', 'gpt-4o-mini');
    case 'anthropic':
      return config.ai.apiKey === '' ? null : createAnthropic();
    case 'ollama':
      return createOllama();
    case '':
      return null;
    default:
      return null;
  }
}
