import type { HarnessConfig, Provider } from '../types';
import { AnthropicProvider } from './anthropic';
import { MockPlannerProvider } from './mock';
import { OpenAiCompatibleProvider } from './openai';

export { AnthropicProvider, MockPlannerProvider, OpenAiCompatibleProvider };
export { toOpenAiMessages } from './openai';
export { toAnthropicMessages } from './anthropic';

export interface CreateProviderOptions {
  config: HarnessConfig;
  /** Resolved API key (settings / secret storage / environment). */
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}

export function createProvider(opts: CreateProviderOptions): Provider {
  const { config, apiKey } = opts;
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey, baseUrl: config.baseUrl, headers: opts.extraHeaders });
    case 'mock':
      return new MockPlannerProvider();
    case 'openai':
    default:
      return new OpenAiCompatibleProvider({ apiKey, baseUrl: config.baseUrl, headers: opts.extraHeaders });
  }
}

/** Environment variable fallbacks, checked in order. */
export function apiKeyFromEnv(provider: HarnessConfig['provider'], env = process.env): string | undefined {
  const candidates =
    provider === 'anthropic'
      ? ['HARNESS_API_KEY', 'ANTHROPIC_API_KEY']
      : ['HARNESS_API_KEY', 'OPENAI_API_KEY'];
  for (const name of candidates) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
