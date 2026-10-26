/**
 * @created 2026-10-26
 * @description 从账号实时目录或旧 Codex 兼容目录发现模型并记录来源。
 * @author yunhungo
 */
import type { ModelCatalog } from '@x-router/contracts';

import { getConfig } from '../config';
import { codexClientHeaders, resolveCodexClientVersion } from './codex-client';

const MAX_MODELS = 500;
const COMPATIBLE_REJECTIONS = new Set([401, 403, 404]);

export interface OpenAiModelDiscoveryInput {
  baseUrl: string;
  authorization: string;
  authType: 'oauth' | 'api_key';
  headers?: Record<string, string>;
  previousClientVersion?: string | null;
  signal?: AbortSignal;
}

function catalogError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, statusCode: 502, exposeMessage: true });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelSlugs(body: unknown, oauth: boolean): string[] {
  const root = record(body);
  const models = root?.models;
  const data =
    !oauth && !Array.isArray(models) && Array.isArray(root?.data) ? root.data : undefined;
  const entries = Array.isArray(models) ? models : data;
  if (!entries) {
    throw catalogError(
      'model_catalog_invalid_response',
      '上游模型目录响应格式无效，已保留上次成功的列表。',
    );
  }
  const slugs = new Set<string>();
  let validEntries = 0;
  for (const entry of entries) {
    const item = record(entry);
    const id = data ? item?.id : item?.slug;
    if (typeof id !== 'string' || !id.trim() || id.length > 120) continue;
    if (!data && item?.visibility !== 'list' && item?.visibility !== 'hide') continue;
    validEntries += 1;
    if (!data && item?.visibility !== 'list') continue;
    slugs.add(id.trim());
    if (slugs.size > MAX_MODELS) {
      throw catalogError(
        'model_catalog_too_large',
        '上游模型目录超出同步上限，已保留上次成功的列表。',
      );
    }
  }
  if (entries.length && !validEntries) {
    throw catalogError(
      'model_catalog_invalid_response',
      '上游模型目录缺少有效模型，已保留上次成功的列表。',
    );
  }
  return [...slugs];
}

async function requestCatalog(
  url: URL,
  input: OpenAiModelDiscoveryInput,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { accept: 'application/json', ...headers, authorization: input.authorization },
      redirect: 'error',
      cache: 'no-store',
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
  } catch {
    throw catalogError(
      'model_catalog_unavailable',
      '无法获取上游模型目录，请检查网络或代理；已保留上次成功的列表。',
    );
  }
}

async function readCatalog(response: Response, oauth: boolean): Promise<string[]> {
  if (!response.ok) {
    // Upstream error bodies may contain sensitive account information; keep them out of logs/UI.
    await response.body?.cancel();
    throw catalogError(
      'model_catalog_unavailable',
      `上游模型目录请求失败（HTTP ${response.status}），已保留上次成功的列表。`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw catalogError(
      'model_catalog_invalid_response',
      '上游模型目录没有返回有效 JSON，已保留上次成功的列表。',
    );
  }
  return modelSlugs(body, oauth);
}

export async function discoverOpenAiModels(
  input: OpenAiModelDiscoveryInput,
): Promise<ModelCatalog> {
  if (input.authType === 'api_key') {
    const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/models`);
    const response = await requestCatalog(url, input, input.headers ?? {});
    return {
      models: await readCatalog(response, false),
      source: 'upstream',
      clientVersion: null,
      warning: null,
    };
  }

  // Public account catalogs have no Codex client-version gate. Do not forward legacy headers.
  const publicUrl = new URL(`${getConfig().OPENAI_API_BASE.replace(/\/+$/, '')}/models`);
  const response = await requestCatalog(publicUrl, input, {});
  if (response.ok || !COMPATIBLE_REJECTIONS.has(response.status)) {
    return {
      models: await readCatalog(response, true),
      source: 'openai',
      clientVersion: null,
      warning: null,
    };
  }
  await response.body?.cancel();

  const { version, warning } = await resolveCodexClientVersion(input.previousClientVersion);
  const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/models`);
  url.searchParams.set('client_version', version);
  const legacy = await requestCatalog(url, input, {
    ...input.headers,
    ...codexClientHeaders(version),
  });
  return {
    models: await readCatalog(legacy, true),
    source: 'codex',
    clientVersion: version,
    warning: [
      '当前授权使用兼容模型目录；公共账号目录尚未接受此授权，模型可见性仍受账号权限与客户端兼容性影响。',
      warning,
    ]
      .filter(Boolean)
      .join(' '),
  };
}
