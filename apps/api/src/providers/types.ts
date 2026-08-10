import type { ProviderRuntime } from '../services/providers';
import type { TokenUsage } from '../services/usage';

export type GatewayEndpoint = 'responses' | 'chat.completions';
export type GatewayResponseMode = 'passthrough' | 'responses-to-chat-completions';

export interface PreparedUpstreamRequest {
  endpoint: GatewayEndpoint;
  path: string;
  body: Record<string, unknown>;
  clientWantsStream: boolean;
  includeUsageInStream: boolean;
  expectsSseOnSuccess: boolean;
  responseMode: GatewayResponseMode;
}

export interface GatewayStreamBridge {
  readonly usage: TokenUsage;
  readonly completedResponse: Record<string, unknown> | null;
  readonly errorCode: string | undefined;
  feed(chunk: Uint8Array, final?: boolean): Uint8Array[];
}

export interface ProviderCapabilities {
  upstreamApis: GatewayEndpoint[];
  gatewayApis: GatewayEndpoint[];
  supportsOAuth: boolean;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly defaultApiBaseUrl?: string;
  readonly defaultModel?: string;
  readonly capabilities: ProviderCapabilities;
  prepareRequest(
    endpoint: GatewayEndpoint,
    body: Record<string, unknown>,
    provider: ProviderRuntime,
  ): PreparedUpstreamRequest;
  transformJsonResponse(prepared: PreparedUpstreamRequest, payload: unknown): unknown;
  createStreamBridge(prepared: PreparedUpstreamRequest): GatewayStreamBridge;
}
