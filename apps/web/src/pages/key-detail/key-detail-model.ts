import { langfusePayload, type LangfuseDraft } from '../../components/langfuse-fields';
import type {
  KeyAnalyticsRange,
  KeyAnalyticsResponse,
  KeyLogMetric,
  Provider,
  VirtualKey,
} from '../../types';

export const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});
export const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
export const allModelsValue = '__all_models__';

export type DetailTab = 'overview' | 'charts' | 'logs' | 'settings' | 'middleware';

const detailTabValues: DetailTab[] = ['overview', 'charts', 'logs', 'settings', 'middleware'];

export function parseDetailTab(value: string | null): DetailTab {
  return detailTabValues.includes(value as DetailTab) ? (value as DetailTab) : 'overview';
}

export function detailTabSearchParams(current: URLSearchParams, nextTab: DetailTab) {
  const next = new URLSearchParams(current);
  next.set('tab', nextTab);
  return next;
}

export interface GeneralDraft {
  name: string;
  rpmLimit: string;
  budgetUsd: string;
  expiresAt: string;
  providerConnectionId: string;
}

export interface LogDrilldown {
  label: string;
  metric: KeyLogMetric;
  threshold?: number;
  from?: string;
  to?: string;
  model?: string;
  provider?: string;
}

export interface AnalyticsModelOption {
  identity: string;
  model: string;
  provider: string;
  label: string;
}

export interface ModelAnalyticsState {
  keyId: string;
  identity: string;
  range: KeyAnalyticsRange;
  data: KeyAnalyticsResponse;
}

export const rangeLabels: Record<KeyAnalyticsRange, string> = {
  '24h': '近 24 小时',
  '7d': '近 7 天',
  '30d': '近 30 天',
};

export function modelIdentity(provider: string, model: string) {
  return JSON.stringify([provider, model]);
}

export function parseModelIdentity(identity: string) {
  try {
    const parsed: unknown = JSON.parse(identity);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((value) => typeof value === 'string' && value.length > 0)
    ) {
      const [provider, model] = parsed as [string, string];
      return { provider, model };
    }
  } catch {
    // Invalid identities fall back to the aggregate view.
  }
  return undefined;
}

export function analyticsModelOptions(
  data: KeyAnalyticsResponse,
  providers: readonly Provider[],
): AnalyticsModelOption[] {
  const options: AnalyticsModelOption[] = [];
  const seen = new Set<string>();
  const add = (provider: string, model: string) => {
    const identity = modelIdentity(provider, model);
    if (!model || seen.has(identity)) return;
    seen.add(identity);
    options.push({ identity, provider, model, label: `${model} · ${provider}` });
  };

  data.models.forEach((item) => add(item.provider, item.model));
  const matchingProviders = data.key.providerConnectionId
    ? providers.filter((provider) => provider.id === data.key.providerConnectionId)
    : providers;
  const catalogStart = options.length;
  matchingProviders.forEach((provider) => {
    if (provider.defaultModel) add(provider.provider, provider.defaultModel);
    (provider.models ?? []).forEach((model) => add(provider.provider, model));
  });

  // Automatic routing may draw from the global price catalog. A Key pinned to one
  // connection must not inherit models from a different connection of the same provider.
  if (!data.key.providerConnectionId && options.length === catalogStart) {
    data.prices.forEach((item) => {
      if (!data.key.provider || item.provider === data.key.provider) add(item.provider, item.model);
    });
  }
  return options;
}

function datetimeLocalValue(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function generalDraft(key: VirtualKey): GeneralDraft {
  return {
    name: key.name,
    rpmLimit: String(key.rpmLimit),
    budgetUsd: key.budgetUsd?.toString() ?? '',
    expiresAt: datetimeLocalValue(key.expiresAt),
    providerConnectionId: key.providerConnectionId ?? '',
  };
}

export function sameGeneralDraft(left: GeneralDraft, right: GeneralDraft) {
  return (
    left.name === right.name &&
    left.rpmLimit === right.rpmLimit &&
    left.budgetUsd === right.budgetUsd &&
    left.expiresAt === right.expiresAt &&
    left.providerConnectionId === right.providerConnectionId
  );
}

export function sameLangfuseDraft(left: LangfuseDraft, right: LangfuseDraft) {
  return JSON.stringify(langfusePayload(left)) === JSON.stringify(langfusePayload(right));
}

export function successRate(calls: number, successfulCalls: number) {
  return calls ? (successfulCalls / calls) * 100 : 0;
}

export function finiteMetric(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatFullDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function endpointLabel(endpoint: string) {
  return endpoint === 'responses' ? '/responses' : '/chat/completions';
}
