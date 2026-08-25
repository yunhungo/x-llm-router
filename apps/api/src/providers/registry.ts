import { openAiProviderAdapter } from './openai';
import { getPiProviderDefinition, piProviderCatalog } from './pi-ai';
import type { ProviderAdapter } from './types';

const adapters = new Map<string, ProviderAdapter>([
  [openAiProviderAdapter.id, openAiProviderAdapter],
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
  return piProviderCatalog();
}

export function isProviderRegistered(provider: string): boolean {
  return adapters.has(provider) || Boolean(getPiProviderDefinition(provider));
}
