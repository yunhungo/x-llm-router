export interface User {
  id: string;
  username: string;
}

export interface Provider {
  id: string;
  name: string;
  provider: string;
  authType: 'oauth' | 'api_key';
  apiMode: 'responses' | 'chat.completions';
  status: 'active' | 'disabled' | 'error';
  accountId: string | null;
  baseUrl: string;
  defaultModel: string | null;
  priority: number;
  tokenExpiresAt: string | null;
  lastError: string | null;
  models: string[];
  modelsRefreshedAt: string | null;
  modelsRefreshError: string | null;
  createdAt: string;
}

export interface ProviderCatalogItem {
  id: string;
  name: string;
  defaultApiBaseUrl: string | null;
  defaultModel: string | null;
  defaultApiMode: 'responses' | 'chat.completions';
  models: string[];
  capabilities: {
    upstreamApis: Array<'responses' | 'chat.completions'>;
    gatewayApis: Array<'responses' | 'chat.completions'>;
    supportsOAuth: boolean;
  };
}

export interface LangfuseConfig {
  enabled: boolean;
  publicKey: string;
  hasSecretKey: boolean;
  baseUrl: string;
  environment: string;
  traceName: string;
  version: string;
  tags: string[];
  metadata: Record<string, string>;
  userIdHeader: string;
  sessionIdHeader: string;
  captureInput: boolean;
  captureOutput: boolean;
  restartRequiredAfterSave: boolean;
}

export interface VirtualKey {
  id: string;
  name: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  budgetUsd: number | null;
  spendUsd: number;
  rpmLimit: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  providerName: string | null;
  providerConnectionId: string | null;
  langfuse: LangfuseConfig;
}

export interface UsageSummary {
  calls: number;
  successfulCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  averageLatencyMs: number;
}

export interface UsagePoint {
  bucket: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface ModelUsage {
  model: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface UsageLog {
  id: string;
  requestId: string;
  apiKeyId: string | null;
  endpoint: string;
  requestedModel: string;
  model: string;
  callStatus: 'processing' | 'thinking' | 'responding' | 'completed' | 'failed';
  statusCode: number | null;
  success: boolean | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  visibleOutputTokens: number | null;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
  timeToFirstVisibleTokenMs: number | null;
  errorCode: string | null;
  createdAt: string;
  apiKeyName: string | null;
  providerName: string | null;
  detailAvailable: boolean;
}

export interface UsageLogsPage<TLog extends Pick<UsageLog, 'id'> = UsageLog> {
  logs: TLog[];
  hasMore: boolean;
  nextCursor: string | null;
  facets?: {
    models: string[];
    endpoints: string[];
  };
}

export interface UsageCallDetail {
  id: string;
  requestId: string;
  endpoint: string;
  requestedModel: string;
  upstreamModel: string;
  gatewayCurl: string;
  upstreamCurl: string | null;
  clientRequest: unknown;
  upstreamRequest: unknown | null;
  upstreamResponse: unknown | null;
  error: unknown | null;
  capturedAt: string;
  expiresAt: string;
}

export interface UsageCallDetailResponse {
  detail: UsageCallDetail | null;
  expired: boolean;
}

export type KeyAnalyticsRange = '24h' | '7d' | '30d';

export interface KeyDailyModelUsage {
  day: string;
  provider: string;
  model: string;
  calls: number;
  failedCalls: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface KeyDailyUsageResponse {
  year: number;
  timeZone: string;
  days: KeyDailyModelUsage[];
}

export interface KeyAnalyticsSummary {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  averageCostUsd: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  averageTtftMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
  averageFirstVisibleMs: number;
  p50FirstVisibleMs: number;
  averageTps: number;
  averageVisibleTps: number;
  p10Tps: number;
  p50Tps: number;
  p95Tps: number;
  streamingCalls: number;
  peakRpm: number;
}

export interface KeyUsagePoint {
  bucket: string;
  bucketEnd: string;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cachedTokens: number;
  costUsd: number;
  averageTtftMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
  averageTps: number;
  p10Tps: number;
  p50Tps: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export interface KeyModelUsage {
  model: string;
  provider: string;
  calls: number;
  successfulCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  averageLatencyMs: number;
  averageTps: number;
}

export interface KeyModelUsagePoint {
  bucket: string;
  bucketEnd: string;
  provider: string;
  model: string;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  averageTtftMs: number;
  averageTps: number;
  averageLatencyMs: number;
}

export interface KeyEndpointUsage {
  endpoint: string;
  calls: number;
  successfulCalls: number;
  tokens: number;
  costUsd: number;
}

export interface KeyErrorUsage {
  code: string;
  calls: number;
}

export interface KeyUsageLog extends Omit<UsageLog, 'apiKeyId' | 'apiKeyName'> {
  tps: number | null;
  visibleTps: number | null;
}

export type KeyLogMetric = 'recent' | 'errors' | 'latency' | 'ttft' | 'tps';

export interface KeyUsageLogsResponse {
  logs: KeyUsageLog[];
  total: number;
  query: {
    metric: KeyLogMetric;
    threshold: number | null;
    from: string | null;
    to: string | null;
    model: string | null;
    provider: string | null;
  };
}

export interface ModelPriceMatch {
  provider: string;
  model: string;
  matchedProvider: string | null;
  matchedPattern: string | null;
  inputPerMillion: number | null;
  cachedInputPerMillion: number | null;
  outputPerMillion: number | null;
  updatedAt: string | null;
}

export interface KeyAnalyticsResponse {
  range: KeyAnalyticsRange;
  from: string;
  to: string;
  key: VirtualKey & { provider: string | null };
  summary: KeyAnalyticsSummary;
  series: KeyUsagePoint[];
  modelSeries: KeyModelUsagePoint[];
  models: KeyModelUsage[];
  endpoints: KeyEndpointUsage[];
  errors: KeyErrorUsage[];
  prices: ModelPriceMatch[];
}
