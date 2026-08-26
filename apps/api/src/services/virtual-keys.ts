import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPool } from '../db/client';
import { createVirtualApiKey, hashApiKey } from '../lib/crypto';
import {
  decryptLangfuseSettings,
  encryptLangfuseSettings,
  ensureApiKeyLangfuse,
  type KeyLangfuseSettings,
} from './langfuse';

export interface VirtualApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  budgetUsd: number | null;
  spendUsd: number;
  rpmLimit: number;
  providerConnectionId: string | null;
  middlewareCode?: string;
  langfuse?: KeyLangfuseSettings;
}

interface VirtualApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  budget_usd: string | null;
  spend_usd: string;
  rpm_limit: number;
  provider_connection_id: string | null;
  middleware_code: string | null;
  langfuse_config_ciphertext: string | null;
}

export async function createApiKeyRecord(input: {
  name: string;
  budgetUsd?: number | null;
  rpmLimit: number;
  expiresAt?: string | null;
  providerConnectionId?: string | null;
  langfuse?: KeyLangfuseSettings;
  createdBy: string;
}): Promise<{ id: string; rawKey: string; prefix: string }> {
  const generated = createVirtualApiKey();
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO virtual_api_keys(
      id, name, key_prefix, key_hash, budget_usd, rpm_limit, expires_at,
      provider_connection_id, langfuse_config_ciphertext, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.name,
      generated.prefix,
      generated.hash,
      input.budgetUsd ?? null,
      input.rpmLimit,
      input.expiresAt ?? null,
      input.providerConnectionId ?? null,
      input.langfuse ? encryptLangfuseSettings(input.langfuse) : null,
      input.createdBy,
    ],
  );
  return { id, rawKey: generated.rawKey, prefix: generated.prefix };
}

export async function requireVirtualApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    await reply.code(401).send({
      error: {
        type: 'authentication_error',
        code: 'missing_api_key',
        message: 'Missing bearer API key.',
      },
    });
    return;
  }

  const rawKey = authorization.slice('Bearer '.length).trim();
  if (!rawKey.startsWith('xr_')) {
    await reply.code(401).send({
      error: {
        type: 'authentication_error',
        code: 'invalid_api_key',
        message: 'Invalid router API key.',
      },
    });
    return;
  }

  const result = await getPool().query<VirtualApiKeyRow>(
    `SELECT id, name, key_prefix, budget_usd, spend_usd, rpm_limit, provider_connection_id,
            middleware_code, langfuse_config_ciphertext
       FROM virtual_api_keys
      WHERE key_hash = $1 AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())`,
    [hashApiKey(rawKey)],
  );
  const row = result.rows[0];
  if (!row) {
    await reply.code(401).send({
      error: {
        type: 'authentication_error',
        code: 'invalid_api_key',
        message: 'Invalid or expired router API key.',
      },
    });
    return;
  }

  const budgetUsd = row.budget_usd === null ? null : Number(row.budget_usd);
  const spendUsd = Number(row.spend_usd);
  if (budgetUsd !== null && spendUsd >= budgetUsd) {
    await reply.code(429).send({
      error: {
        type: 'rate_limit_error',
        code: 'budget_exceeded',
        message: 'API key budget exceeded.',
      },
    });
    return;
  }

  if (row.rpm_limit > 0) {
    const recent = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM usage_logs
        WHERE virtual_api_key_id = $1 AND created_at > now() - interval '1 minute'`,
      [row.id],
    );
    if (Number(recent.rows[0]?.count ?? 0) >= row.rpm_limit) {
      reply.header('retry-after', '60');
      await reply.code(429).send({
        error: {
          type: 'rate_limit_error',
          code: 'rpm_limit_exceeded',
          message: 'API key requests-per-minute limit exceeded.',
        },
      });
      return;
    }
  }

  const langfuse = decryptLangfuseSettings(row.langfuse_config_ciphertext);
  if (langfuse?.enabled) {
    try {
      await ensureApiKeyLangfuse(row.id, langfuse);
    } catch (error) {
      request.log.error(
        { err: error, apiKeyId: row.id },
        'Failed to register Langfuse processor for API key',
      );
    }
  }
  request.routerKey = {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    budgetUsd,
    spendUsd,
    rpmLimit: row.rpm_limit,
    providerConnectionId: row.provider_connection_id,
    ...(row.middleware_code ? { middlewareCode: row.middleware_code } : {}),
    ...(langfuse ? { langfuse } : {}),
  };
}

export async function touchApiKey(id: string): Promise<void> {
  await getPool().query('UPDATE virtual_api_keys SET last_used_at = now() WHERE id = $1', [id]);
}
