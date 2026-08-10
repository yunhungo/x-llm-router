export interface User {
  id: string;
  username: string;
}

export interface Provider {
  id: string;
  name: string;
  authType: 'oauth' | 'api_key';
  status: 'active' | 'disabled' | 'error';
  accountId: string | null;
  baseUrl: string;
  defaultModel: string | null;
  priority: number;
  tokenExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface LangfuseConfig {
  enabled: boolean;
  publicKey: string;
  hasSecretKey: boolean;
  baseUrl: string;
  environment: string;
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
  endpoint: string;
  model: string;
  statusCode: number;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
  errorCode: string | null;
  createdAt: string;
  apiKeyName: string | null;
  providerName: string | null;
}
