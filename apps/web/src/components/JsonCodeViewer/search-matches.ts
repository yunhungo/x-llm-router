/**
 * @created 2026-09-20
 * @description 使用编辑器搜索规则统计有上限的匹配位置。
 * @author yunhungo
 */
import type { EditorState } from '@codemirror/state';
import type { SearchQuery } from '@codemirror/search';

export function collectSearchMatches(state: EditorState, query: SearchQuery) {
  const matches: { from: number; to: number }[] = [];
  if (!query.valid) return { matches, limited: false };
  const cursor = query.getCursor(state);
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    if (matches.length === 10_000) return { matches, limited: true };
    matches.push(result.value);
  }
  return { matches, limited: false };
}
