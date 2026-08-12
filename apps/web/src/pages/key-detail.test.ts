import { describe, expect, it } from 'vitest';

import { analyticsModelOptions, modelIdentity, parseModelIdentity } from './key-detail';

describe('key detail model filter', () => {
  it('round-trips provider and model identities without delimiter collisions', () => {
    const identity = modelIdentity('openai-compatible', 'team/model:preview');

    expect(parseModelIdentity(identity)).toEqual({
      provider: 'openai-compatible',
      model: 'team/model:preview',
    });
    expect(parseModelIdentity('invalid')).toBeUndefined();
  });

  it('uses the selected provider catalog and keeps historical models', () => {
    const options = analyticsModelOptions(
      {
        key: { providerConnectionId: 'provider-1', provider: 'openai' },
        models: [{ provider: 'openai', model: 'historical-model' }],
        prices: [{ provider: 'other', model: 'unrelated-model' }],
      } as never,
      [
        {
          id: 'provider-1',
          provider: 'openai',
          defaultModel: 'gpt-default',
          models: ['gpt-default', 'gpt-mini'],
        },
        {
          id: 'provider-2',
          provider: 'other',
          defaultModel: 'other-model',
          models: ['other-model'],
        },
      ] as never,
    );

    expect(options.map((option) => option.label)).toEqual([
      'historical-model · openai',
      'gpt-default · openai',
      'gpt-mini · openai',
    ]);
  });

  it('does not borrow a global price model when the selected connection catalog is empty', () => {
    const options = analyticsModelOptions(
      {
        key: { providerConnectionId: 'provider-1', provider: 'openai' },
        models: [],
        prices: [{ provider: 'openai', model: 'oauth-only-model' }],
      } as never,
      [
        {
          id: 'provider-1',
          provider: 'openai',
          defaultModel: null,
          models: [],
        },
      ] as never,
    );

    expect(options).toEqual([]);
  });
});
