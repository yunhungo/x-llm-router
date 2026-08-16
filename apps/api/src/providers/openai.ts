import type { ProviderRuntime } from '../services/providers';
import { SseAccumulator } from '../services/sse';
import {
  chatCompletionsToResponses,
  ResponsesToChatStreamBridge,
  responsesToChatCompletion,
} from './chat-completions';
import type {
  GatewayEndpoint,
  GatewayStreamBridge,
  PreparedUpstreamRequest,
  ProviderAdapter,
} from './types';

const CHATGPT_RESPONSE_KEYS = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'store',
  'include',
  'tools',
  'tool_choice',
  'reasoning',
  'previous_response_id',
  'truncation',
]);

function normalizeChatGptModel(model: string): string {
  if (model.startsWith('chatgpt/')) return model.slice('chatgpt/'.length);
  if (model.startsWith('chatgpt-gpt-')) return model.slice('chatgpt-'.length);
  return model;
}

function normalizeChatGptInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  return [{ role: 'user', content: [{ type: 'input_text', text: input }] }];
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

function addChatStreamUsage(body: Record<string, unknown>): void {
  if (body.stream !== true) return;
  const options =
    body.stream_options && typeof body.stream_options === 'object'
      ? (body.stream_options as Record<string, unknown>)
      : {};
  body.stream_options = { ...options, include_usage: true };
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

  get hasGeneratedOutput() {
    return this.accumulator.hasGeneratedOutput;
  }

  get hasVisibleOutput() {
    return this.accumulator.hasVisibleOutput;
  }

  feed(chunk: Uint8Array, final = false): Uint8Array[] {
    this.accumulator.feed(chunk, final);
    return chunk.byteLength > 0 ? [chunk] : [];
  }
}

export const openAiProviderAdapter: ProviderAdapter = {
  id: 'openai',
  displayName: 'OpenAI',
  defaultApiBaseUrl: 'https://api.openai.com/v1',
  capabilities: {
    upstreamApis: ['responses', 'chat.completions'],
    gatewayApis: ['responses', 'chat.completions'],
    supportsOAuth: true,
  },

  prepareRequest(endpoint, inputBody, provider): PreparedUpstreamRequest {
    const model = ensureModel(inputBody, provider);
    const clientWantsStream = inputBody.stream === true;
    const includeUsageInStream =
      clientWantsStream &&
      typeof inputBody.stream_options === 'object' &&
      inputBody.stream_options !== null &&
      (inputBody.stream_options as Record<string, unknown>).include_usage === true;
    const body: Record<string, unknown> = { ...inputBody, model };

    if (provider.authType === 'api_key') {
      if (provider.apiMode !== endpoint) {
        const configuredMode = provider.apiMode === 'responses' ? 'Responses' : 'Chat Completions';
        throw Object.assign(
          new Error(`This upstream is configured for the ${configuredMode} API.`),
          { statusCode: 400, code: 'provider_api_mode_mismatch' },
        );
      }
      if (endpoint === 'chat.completions') addChatStreamUsage(body);
      return {
        endpoint,
        path: endpoint === 'responses' ? '/responses' : '/chat/completions',
        body,
        clientWantsStream,
        includeUsageInStream,
        expectsSseOnSuccess: false,
        responseMode: 'passthrough',
      };
    }

    const responsesBody =
      endpoint === 'chat.completions' ? chatCompletionsToResponses(body) : { ...body };
    responsesBody.model = normalizeChatGptModel(model);
    responsesBody.input = normalizeChatGptInput(responsesBody.input);
    responsesBody.stream = true;
    responsesBody.store = false;
    const include = Array.isArray(responsesBody.include) ? [...responsesBody.include] : [];
    if (!include.includes('reasoning.encrypted_content')) {
      include.push('reasoning.encrypted_content');
    }
    responsesBody.include = include;
    if (!responsesBody.instructions) {
      responsesBody.instructions =
        'You are a helpful AI assistant accessed through an OpenAI-compatible router. Follow the user instructions carefully.';
    }
    return {
      endpoint,
      path: '/responses',
      body: Object.fromEntries(
        Object.entries(responsesBody).filter(([key]) => CHATGPT_RESPONSE_KEYS.has(key)),
      ),
      clientWantsStream,
      includeUsageInStream,
      expectsSseOnSuccess: true,
      responseMode:
        endpoint === 'chat.completions' ? 'responses-to-chat-completions' : 'passthrough',
    };
  },

  transformJsonResponse(prepared, payload) {
    return prepared.responseMode === 'responses-to-chat-completions'
      ? responsesToChatCompletion(payload)
      : payload;
  },

  createStreamBridge(prepared) {
    return prepared.responseMode === 'responses-to-chat-completions'
      ? new ResponsesToChatStreamBridge(String(prepared.body.model), prepared.includeUsageInStream)
      : new PassthroughStreamBridge();
  },
};
