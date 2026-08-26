import { describe, expect, it } from 'vitest';

import {
  createKeyMiddlewareSession,
  DEFAULT_KEY_MIDDLEWARE_CODE,
  validateKeyMiddlewareCode,
} from './key-middleware';

const metadata = {
  key: { id: 'key-1', name: 'Development', prefix: 'xr_test' },
  endpoint: 'responses',
  requestId: 'request-1',
};

describe('API Key middleware', () => {
  it('accepts the default async hooks', async () => {
    await expect(validateKeyMiddlewareCode(DEFAULT_KEY_MIDDLEWARE_CODE)).resolves.toBeUndefined();
  });

  it('requires both fixed async function names', async () => {
    await expect(
      validateKeyMiddlewareCode(`
        function onRequest(ctx) { return ctx.request; }
        async function onResponse(ctx) { return ctx.response; }
      `),
    ).rejects.toThrow(/onRequest.*async function/);

    await expect(
      validateKeyMiddlewareCode('async function onRequest(ctx) { return ctx.request; }'),
    ).rejects.toThrow(/onResponse/);
  });

  it('transforms request and response data while sharing request state', async () => {
    const session = await createKeyMiddlewareSession({
      metadata,
      code: `
        async function onRequest(ctx) {
          ctx.state.marker = ctx.crypto.sha256(ctx.request.body.model).slice(0, 8);
          ctx.request.body.temperature = 0.25;
          ctx.request.upstreamHeaders['x-marker'] = ctx.state.marker;
          return ctx.request;
        }
        async function onResponse(ctx) {
          ctx.response.headers['x-marker'] = ctx.state.marker;
          ctx.response.body = { ...ctx.response.body, marker: ctx.state.marker };
          return ctx.response;
        }
      `,
    });

    try {
      const request = await session.onRequest({
        method: 'POST',
        url: 'https://router.example/v1/responses',
        headers: {},
        body: { model: 'gpt-test' },
        upstreamHeaders: {},
      });
      expect(request.body).toMatchObject({ model: 'gpt-test', temperature: 0.25 });
      expect(request.upstreamHeaders['x-marker']).toMatch(/^[a-f0-9]{8}$/);

      const response = await session.onResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { ok: true },
        stream: false,
        phase: 'complete',
      });
      expect(response.headers['x-marker']).toBe(request.upstreamHeaders['x-marker']);
      expect(response.body).toMatchObject({
        ok: true,
        marker: request.upstreamHeaders['x-marker'],
      });
    } finally {
      await session.dispose();
    }
  });

  it('allows middleware hooks to run longer than the former one-second limit', async () => {
    const session = await createKeyMiddlewareSession({
      metadata,
      code: `
        async function onRequest(ctx) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < 1_050) {}
          ctx.request.body.completed = true;
          return ctx.request;
        }
        async function onResponse(ctx) { return ctx.response; }
      `,
    });

    try {
      const request = await session.onRequest({
        method: 'POST',
        url: 'https://router.example/v1/responses',
        headers: {},
        body: {},
        upstreamHeaders: {},
      });
      expect(request.body).toMatchObject({ completed: true });
    } finally {
      await session.dispose();
    }
  });
});
