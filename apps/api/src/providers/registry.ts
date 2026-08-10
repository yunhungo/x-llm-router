import { deepSeekProviderAdapter, openAiCompatibleProviderAdapter } from './openai-compatible';
import { openAiProviderAdapter } from './openai';
import type { ProviderAdapter } from './types';

const adapters = new Map<string, ProviderAdapter>([
  [openAiProviderAdapter.id, openAiProviderAdapter],
  [deepSeekProviderAdapter.id, deepSeekProviderAdapter],
  [openAiCompatibleProviderAdapter.id, openAiCompatibleProviderAdapter],
]);

export function getProviderAdapter(provider: string): ProviderAdapter {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw Object.assign(new Error(`Provider adapter is not registered: ${provider}.`), {
      statusCode: 503,
      code: 'provider_adapter_unavailable',
    });
  }
  return adapter;
}

export function providerCatalog() {
  return [...adapters.values()].map((adapter) => ({
    id: adapter.id,
    name: adapter.displayName,
    defaultApiBaseUrl: adapter.defaultApiBaseUrl ?? null,
    defaultModel: adapter.defaultModel ?? null,
    capabilities: adapter.capabilities,
  }));
}
