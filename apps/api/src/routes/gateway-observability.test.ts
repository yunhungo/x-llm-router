/**
 * @created 2026-10-22
 * @description 通过真实网关、SSE 和观测 SDK 验证工具上下文、调用参数与首 token 时间的导出。
 * @author yunhungo
 */
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defaultLangfuseSettings,
  ensureApiKeyLangfuse,
  shutdownLangfuse,
  type KeyLangfuseSettings,
} from '../services/langfuse';
import type { ProviderRuntime } from '../services/providers';
import type { VirtualApiKeyRecord } from '../services/virtual-keys';

const state = vi.hoisted(() => ({
  settings: undefined as KeyLangfuseSettings | undefined,
  provider: undefined as ProviderRuntime | undefined,
  recordUsage: vi.fn(async () => ({ costUsd: 0.0001 })),
}));

vi.mock('../services/providers', () => ({
  getProviderRuntime: async () => state.provider,
}));

vi.mock('../services/virtual-keys', () => ({
  requireVirtualApiKey: async (request: { routerKey?: VirtualApiKeyRecord }) => {
    request.routerKey = {
      id: 'gateway-verification',
      name: 'Gateway verification',
      keyPrefix: 'test',
      budgetUsd: null,
      spendUsd: 0,
      rpmLimit: 60,
      providerConnectionId: 'verification-provider',
      ...(state.settings ? { langfuse: state.settings } : {}),
    };
  },
}));

vi.mock('../services/usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/usage')>();
  return {
    ...actual,
    beginUsage: async () => undefined,
    updateUsageCallStatus: async () => undefined,
    recordUsage: state.recordUsage,
  };
});

import { gatewayRoutes } from './gateway';

const spanSchema = z.object({
  name: z.string(),
  traceId: z.string(),
  spanId: z.string(),
  attributes: z.array(z.object({ key: z.string(), value: z.record(z.string(), z.unknown()) })),
});
const exportSchema = z.object({
  resourceSpans: z.array(
    z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) }),
  ),
});

describe('gateway observability transport', () => {
  it('exports exact tool calls/results and measured TTFT for Responses and Chat requests', async () => {
    const integrationConfigPath = process.env.XOTEL_TEST_CONFIG;
    const integration = integrationConfigPath
      ? z
          .object({
            baseUrl: z.url(),
            publicKey: z.string(),
            secretKey: z.string(),
            receiptPath: z.string(),
          })
          .parse(JSON.parse(await readFile(integrationConfigPath, 'utf8')))
      : undefined;
    const spans: z.infer<typeof spanSchema>[] = [];
    const transportFailures: string[] = [];
    const functionCall = {
      type: 'function_call',
      id: 'fc_next',
      call_id: 'call_next',
      name: 'lookup_weather',
      arguments: '{"city":"Shanghai"}',
    };
    const responseBody = {
      id: 'response-verification',
      model: 'gpt-5.6-luna',
      output_text: '',
      output: [functionCall],
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    };
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === '/responses') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"response.created"}\n\n');
        setTimeout(() => {
          response.write(
            `data: ${JSON.stringify({
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: functionCall.arguments,
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              type: 'response.output_item.done',
              output_index: 0,
              item: functionCall,
            })}\n\n`,
          );
          response.end(
            `data: ${JSON.stringify({ type: 'response.completed', response: responseBody })}\n\n`,
          );
        }, 20);
        return;
      }
      if (request.url !== '/api/public/otel/v1/traces') {
        transportFailures.push('unexpected endpoint');
        response.writeHead(404).end();
        return;
      }
      try {
        const raw = Buffer.concat(chunks);
        const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
        const parsed = exportSchema.parse(JSON.parse(body.toString('utf8')));
        spans.push(
          ...parsed.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        );
        if (integration) {
          const forwarded = await fetch(`${integration.baseUrl}/api/public/otel/v1/traces`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: request.headers.authorization ?? '',
              ...(request.headers['content-encoding']
                ? { 'content-encoding': request.headers['content-encoding'] }
                : {}),
            },
            body: new Uint8Array(raw),
            signal: AbortSignal.timeout(10_000),
          });
          if (!forwarded.ok) throw new Error(`Integration HTTP ${forwarded.status}`);
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } catch {
        transportFailures.push('invalid OTLP JSON');
        response.writeHead(400).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    state.settings = {
      ...defaultLangfuseSettings(),
      target: 'x-otel',
      enabled: true,
      baseUrl,
      publicKey: integration?.publicKey ?? 'pk_verification',
      secretKey: integration?.secretKey ?? 'sk_verification',
    };
    state.provider = {
      id: 'verification-provider',
      name: 'Verification provider',
      provider: 'openai',
      authType: 'oauth',
      apiMode: 'responses',
      baseUrl,
      defaultModel: 'gpt-5.6-luna',
      authorization: 'Bearer verification-only',
      headers: {},
    };
    const app = Fastify();
    try {
      await ensureApiKeyLangfuse('gateway-verification', state.settings);
      await app.register(gatewayRoutes);
      const responsesInput = {
        model: 'gpt-5.6-luna',
        input: [
          { type: 'function_call', call_id: 'call_previous', name: 'lookup_city', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_previous', output: '{"city":"Shanghai"}' },
        ],
      };
      const responsesResult = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: responsesInput,
      });
      expect(responsesResult.statusCode).toBe(200);
      const chatInput = {
        model: 'gpt-5.6-luna',
        stream: true,
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_previous',
                type: 'function',
                function: { name: 'lookup_city', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_previous', content: '{"city":"Shanghai"}' },
        ],
      };
      const chatResult = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: chatInput,
      });
      expect(chatResult.statusCode).toBe(200);
      await shutdownLangfuse();
      expect(transportFailures).toEqual([]);
      expect(spans).toHaveLength(2);
      const expectedInputs = [responsesInput, chatInput];
      for (const [index, span] of spans.entries()) {
        const attributes = Object.fromEntries(
          span.attributes.map((attribute) => [
            attribute.key,
            z.string().optional().parse(attribute.value.stringValue),
          ]),
        );
        expect(JSON.parse(attributes['langfuse.observation.input'] ?? 'null')).toEqual(
          expectedInputs[index],
        );
        const output: unknown = JSON.parse(attributes['langfuse.observation.output'] ?? 'null');
        expect(output).toEqual(
          index === 0
            ? [functionCall]
            : [
                {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_next',
                      type: 'function',
                      function: { name: 'lookup_weather', arguments: '{"city":"Shanghai"}' },
                    },
                  ],
                },
              ],
        );
        const firstTokenMs = Number(attributes['langfuse.observation.metadata.timeToFirstTokenMs']);
        const latencyMs = Number(attributes['langfuse.observation.metadata.latencyMs']);
        expect(firstTokenMs).toBeGreaterThan(0);
        expect(firstTokenMs).toBeLessThanOrEqual(latencyMs);
        expect(
          JSON.parse(attributes['langfuse.observation.completion_start_time'] ?? 'null'),
        ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(attributes['langfuse.observation.metadata.toolResultSource']).toBe(
          'client_request_context',
        );
        expect(attributes['langfuse.observation.type']).toBe('generation');
      }
      expect(state.recordUsage).toHaveBeenCalledTimes(2);
      if (integration) {
        await writeFile(integration.receiptPath, JSON.stringify({ spans }, null, 2), {
          mode: 0o600,
        });
      }
    } finally {
      await shutdownLangfuse();
      await app.close();
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    }
  }, 15_000);
});
