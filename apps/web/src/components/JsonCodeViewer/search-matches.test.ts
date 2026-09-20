/**
 * @created 2026-09-20
 * @description 验证 JSON 搜索的匹配规则、无效输入和计数边界。
 * @author yunhungo
 */
import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { describe, expect, it } from 'vitest';
import { collectSearchMatches } from './search-matches';

const state = EditorState.create({ doc: 'Token token tokens 中文中文 \\n\n7.8 78' });

describe('JSON search matches', () => {
  it('uses the same case and whole-word rules as navigation', () => {
    expect(collectSearchMatches(state, new SearchQuery({ search: 'token' })).matches).toHaveLength(
      3,
    );
    expect(
      collectSearchMatches(
        state,
        new SearchQuery({ search: 'token', caseSensitive: true, wholeWord: true }),
      ).matches,
    ).toHaveLength(1);
  });

  it('finds Chinese and treats JSON escapes literally', () => {
    expect(
      collectSearchMatches(state, new SearchQuery({ search: '中文', literal: true })).matches,
    ).toHaveLength(2);
    const result = collectSearchMatches(state, new SearchQuery({ search: '\\n', literal: true }));
    expect(state.sliceDoc(result.matches[0]!.from, result.matches[0]!.to)).toBe('\\n');
  });

  it('handles literal punctuation, regex, invalid expressions and missing matches', () => {
    expect(
      collectSearchMatches(state, new SearchQuery({ search: '7.8', literal: true })).matches,
    ).toHaveLength(1);
    expect(
      collectSearchMatches(state, new SearchQuery({ search: '7.?8', regexp: true })).matches,
    ).toHaveLength(2);
    for (const search of ['', '[', 'not present']) {
      expect(
        collectSearchMatches(state, new SearchQuery({ search, regexp: true })).matches,
      ).toEqual([]);
    }
  });

  it('caps large result sets without reporting an exact total', () => {
    const large = EditorState.create({ doc: 'x '.repeat(10_001) });
    const query = new SearchQuery({ search: 'x' });
    expect(collectSearchMatches(large, query)).toMatchObject({
      limited: true,
      matches: { length: 10_000 },
    });
    expect(
      collectSearchMatches(EditorState.create({ doc: 'x '.repeat(10_000) }), query).limited,
    ).toBe(false);
  });
});
