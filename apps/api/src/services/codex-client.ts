/**
 * @created 2026-10-26
 * @description 查询 Codex 官方稳定版本并生成兼容目录所需的客户端标识。
 * @author yunhungo
 */
import { getConfig } from '../config';

const FALLBACK_VERSION = '0.164.0';
const VERSION_CACHE_MS = 60 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const VERSION_URL = 'https://registry.npmjs.org/@openai/codex/latest';

interface ClientVersion {
  version: string;
  warning: string | null;
}

let cached: ClientVersion | undefined;
let checkAfter = 0;
let pending: Promise<ClientVersion> | undefined;

export function codexClientHeaders(version?: string): Record<string, string> {
  const configured = getConfig().OPENAI_CODEX_CLIENT_VERSION;
  const resolved =
    version ?? (configured === 'auto' ? (cached?.version ?? FALLBACK_VERSION) : configured);
  return {
    originator: 'codex_cli_rs',
    'user-agent': `x-llm-router/${resolved}`,
    version: resolved,
  };
}

export async function resolveCodexClientVersion(
  previousVersion?: string | null,
): Promise<ClientVersion> {
  const configured = getConfig().OPENAI_CODEX_CLIENT_VERSION;
  if (configured !== 'auto') return { version: configured, warning: null };
  if (!cached && previousVersion && STABLE_VERSION.test(previousVersion)) {
    cached = { version: previousVersion, warning: null };
  }
  if (cached && Date.now() < checkAfter) return cached;
  if (pending) return pending;

  pending = (async () => {
    try {
      // Fetch package metadata only. No packages or remote code are installed or executed.
      const response = await fetch(VERSION_URL, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('Version metadata unavailable');
      const body: unknown = await response.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !('version' in body) ||
        typeof body.version !== 'string' ||
        !STABLE_VERSION.test(body.version)
      )
        throw new Error('Invalid stable version');
      cached = { version: body.version, warning: null };
      checkAfter = Date.now() + VERSION_CACHE_MS;
    } catch {
      cached = {
        version: cached?.version ?? FALLBACK_VERSION,
        warning: '暂时无法检查客户端更新，兼容目录沿用上次可用版本，稍后自动重试。',
      };
      checkAfter = Date.now() + RETRY_DELAY_MS;
    }
    return cached;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
