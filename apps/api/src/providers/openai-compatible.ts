import type { ProviderRuntime } from '../services/providers';
import { SseAccumulator } from '../services/sse';
import type {
  GatewayEndpoint,
  GatewayStreamBridge,
  PreparedUpstreamRequest,
  ProviderAdapter,
  ProviderCapabilities,
} from './types';

interface CompatibleProviderOptions {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  defaultApiBaseUrl?: string;
  defaultModel?: string;
}

class PassthroughStreamBridge implements GatewayStreamBridge {
  private readonly accumulator = new SseAccumulator();

  get usage() {
    return this.accumulator.usage;
  }

  get completedResponse() {
    return this.accumulator.completedResponse;
  }

  get errorCode() {
    return this.accumulator.errorCode;
  }

  feed(chunk: Uint8Array, final = false): Uint8Array[] {
    this.accumulator.feed(chunk, final);
    return chunk.byteLength > 0 ? [chunk] : [];
  }
}

function ensureModel(body: Record<string, unknown>, provider: ProviderRuntime): string {
  const model = typeof body.model === 'string' && body.model ? body.model : provider.defaultModel;
  if (!model) {
    throw Object.assign(
      new Error('A model is required and the selected provider has no default model.'),
      { statusCode: 400, code: 'model_required' },
    );
  }
  return model;
}

function createOpenAiCompatibleAdapter(options: CompatibleProviderOptions): ProviderAdapter {
  return {
    ...options,
    prepareRequest(endpoint, inputBody, provider): PreparedUpstreamRequest {
      if (!options.capabilities.gatewayApis.includes(endpoint)) {
        throw Object.assign(
          new Error(`${options.displayName} does not support the ${endpoint} endpoint.`),
          { statusCode: 400, code: 'provider_endpoint_unsupported' },
        );
      }
      const body = { ...inputBody, model: ensureModel(inputBody, provider) };
      return {
        endpoint,
        path: endpoint === 'responses' ? '/responses' : '/chat/completions',
        body,
        clientWantsStream: inputBody.stream === true,
        includeUsageInStream: false,
        expectsSseOnSuccess: false,
        responseMode: 'passthrough',
      };
    },
    transformJsonResponse(_prepared, payload) {
      return payload;
    },
    createStreamBridge() {
      return new PassthroughStreamBridge();
    },
  };
}

export const deepSeekProviderAdapter = createOpenAiCompatibleAdapter({
  id: 'deepseek',
  displayName: 'DeepSeek',
  defaultApiBaseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-flash',
  capabilities: {
    upstreamApis: ['chat.completions'],
    gatewayApis: ['chat.completions'],
    supportsOAuth: false,
  },
});

export const openAiCompatibleProviderAdapter = createOpenAiCompatibleAdapter({
  id: 'openai-compatible',
  displayName: 'OpenAI Compatible',
  capabilities: {
    upstreamApis: ['chat.completions'],
    gatewayApis: ['chat.completions'],
    supportsOAuth: false,
  },
});
