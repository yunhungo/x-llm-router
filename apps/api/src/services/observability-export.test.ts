/**
 * @created 2026-10-22
 * @description 使用真实 SDK 和本地 HTTP 接收端验证 X-Otel 导出协议、批次边界及项目隔离。
 * @author yunhungo
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';

import { propagateAttributes, startObservation } from '@langfuse/tracing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkLangfuseConnection,
  defaultLangfuseSettings,
  ensureApiKeyLangfuse,
  shutdownLangfuse,
} from './langfuse';

const spanSchema = z.object({
  name: z.string(),
  traceId: z.string(),
  attributes: z.array(z.object({ key: z.string(), value: z.record(z.string(), z.unknown()) })),
});
const requestSchema = z.object({
  resourceSpans: z.array(
    z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) }),
  ),
});

describe('real X-Otel SDK transport', () => {
  it('exports bounded OTLP JSON batches with Basic auth and no cross-project spans', async () => {
    const batches: Array<{ destination: string; spans: z.infer<typeof spanSchema>[] }> = [];
    const failures: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const destination = request.url?.split('/')[1] ?? '';
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from(`pk_${destination}:sk_${destination}`).toString('base64')}`
      ) {
        failures.push('incorrect authorization');
        response.writeHead(401).end();
        return;
      }
      if (request.url?.endsWith('/api/public/projects')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      } else if (request.url?.endsWith('/api/public/otel/v1/traces')) {
        if (body.length) {
          try {
            if (!request.headers['content-type']?.includes('application/json'))
              throw new Error('wrong content type');
            const decoded =
              request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
            const parsed = requestSchema.parse(JSON.parse(decoded.toString('utf8')));
            batches.push({
              destination,
              spans: parsed.resourceSpans.flatMap((resource) =>
                resource.scopeSpans.flatMap((scope) => scope.spans),
              ),
            });
          } catch {
            failures.push('invalid OTLP JSON');
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } else {
        failures.push('unexpected endpoint');
        response.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');

    try {
      for (const destination of ['first', 'second']) {
        const settings = {
          ...defaultLangfuseSettings(),
          target: 'x-otel' as const,
          enabled: true,
          publicKey: `pk_${destination}`,
          secretKey: `sk_${destination}`,
          baseUrl: `http://127.0.0.1:${address.port}/${destination}`,
        };
        await checkLangfuseConnection(settings);
        await ensureApiKeyLangfuse(destination, settings);
      }

      for (let i = 0; i < 40; i += 1) {
        const destination = i % 2 === 0 ? 'first' : 'second';
        propagateAttributes(
          { metadata: { apiKeyId: destination }, traceName: 'router-export' },
          () => {
            const observation = startObservation(
              `${destination}-${i}`,
              {
                model: 'test-model',
                input: i === 0 ? '😃'.repeat(20_000) : 'request',
                output: 'response',
                usageDetails: { input: 12, output: 5 },
                costDetails: { total: 0.0001 },
                completionStartTime: new Date('2026-10-22T08:40:00.125Z'),
                metadata: { timeToFirstTokenMs: 125, timeToFirstVisibleTokenMs: 150 },
              },
              { asType: 'generation' },
            );
            observation.end();
          },
        );
      }
      await shutdownLangfuse();
      expect(failures).toEqual([]);
      expect(batches.flatMap((batch) => batch.spans)).toHaveLength(40);
      for (const batch of batches) {
        expect(batch.spans.length).toBeLessThanOrEqual(16);
        for (const span of batch.spans) {
          expect(span.name.startsWith(`${batch.destination}-`)).toBe(true);
          expect(span.attributes).toEqual(
            expect.arrayContaining([
              { key: 'langfuse.observation.model.name', value: { stringValue: 'test-model' } },
              {
                key: 'langfuse.observation.usage_details',
                value: { stringValue: '{"input":12,"output":5}' },
              },
              {
                key: 'langfuse.observation.completion_start_time',
                value: { stringValue: '"2026-10-22T08:40:00.125Z"' },
              },
              {
                key: 'langfuse.observation.metadata.timeToFirstTokenMs',
                value: { stringValue: '125' },
              },
              {
                key: 'langfuse.observation.metadata.timeToFirstVisibleTokenMs',
                value: { stringValue: '150' },
              },
            ]),
          );
          if (span.name === 'first-0') {
            const input = span.attributes.find(
              (attribute) => attribute.key === 'langfuse.observation.input',
            );
            const marker = z
              .object({ xotel_truncated: z.literal(true), original_json_bytes: z.number() })
              .parse(JSON.parse(z.string().parse(input?.value.stringValue)));
            expect(marker.original_json_bytes).toBeGreaterThan(80_000);
          }
        }
      }
    } finally {
      await shutdownLangfuse();
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    }
  }, 15_000);
});
