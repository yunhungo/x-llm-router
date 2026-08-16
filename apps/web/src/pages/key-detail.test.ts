import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Field, Input } from '../components/ui';

import {
  analyticsModelOptions,
  detailTabSearchParams,
  modelIdentity,
  parseDetailTab,
  parseModelIdentity,
} from './key-detail';

describe('key detail tab URL state', () => {
  it('restores valid tabs and falls back to overview for invalid values', () => {
    expect(parseDetailTab('charts')).toBe('charts');
    expect(parseDetailTab('logs')).toBe('logs');
    expect(parseDetailTab('settings')).toBe('settings');
    expect(parseDetailTab('unknown')).toBe('overview');
    expect(parseDetailTab(null)).toBe('overview');
  });

  it('writes the selected tab without dropping other query parameters', () => {
    const next = detailTabSearchParams(new URLSearchParams('range=7d&tab=overview'), 'logs');

    expect(next.get('tab')).toBe('logs');
    expect(next.get('range')).toBe('7d');
  });
});

describe('key settings feedback', () => {
  it('renders field help as a focusable tooltip instead of a layout row', () => {
    const markup = renderToStaticMarkup(
      createElement(Field, { label: 'RPM', helpText: '0 表示不限制' }, createElement(Input)),
    );

    expect(markup).toContain('class="field-help"');
    expect(markup).toContain('aria-label="0 表示不限制"');
    expect(markup).toContain('class="field-help-tooltip"');
    expect(markup).not.toContain('class="field-hint"');
  });
});

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
