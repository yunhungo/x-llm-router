/**
 * @created 2026-09-20
 * @description 提供中文 JSON 搜索面板、匹配反馈与键盘导航。
 * @author yunhungo
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import { collectSearchMatches } from './search-matches';

function button(label: string, title: string, action: () => void) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.title = title;
  element.setAttribute('aria-label', title);
  element.addEventListener('click', action);
  return element;
}

class JsonSearchPanel implements Panel {
  readonly dom = document.createElement('div');
  readonly top = true;
  private readonly input = document.createElement('input');
  private readonly status = document.createElement('span');
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly options = new Map<'caseSensitive' | 'wholeWord' | 'regexp', HTMLButtonElement>();
  private composing = false;
  private query: SearchQuery;
  private results: ReturnType<typeof collectSearchMatches>;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.results = collectSearchMatches(view.state, this.query);
    this.dom.className = 'json-search-panel';
    this.dom.setAttribute('role', 'search');
    this.dom.setAttribute('aria-label', '搜索 JSON');
    this.input.type = 'text';
    this.input.placeholder = '搜索 JSON 内容…';
    this.input.setAttribute('aria-label', '搜索 JSON 内容');
    this.input.setAttribute('main-field', 'true');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.addEventListener('input', (event) => {
      if (!(event instanceof InputEvent) || !event.isComposing) this.commit();
    });
    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.commit();
    });
    this.status.className = 'json-search-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
    const field = document.createElement('div');
    field.className = 'json-search-field';
    field.append(this.input, this.status);
    this.previous = button('↑', '上一项（Shift+Enter）', () => findPrevious(view));
    this.next = button('↓', '下一项（Enter）', () => findNext(view));
    const navigation = document.createElement('div');
    navigation.className = 'json-search-navigation';
    navigation.append(this.previous, this.next);
    const options = document.createElement('div');
    options.className = 'json-search-options';
    for (const [key, label] of [
      ['caseSensitive', '区分大小写'],
      ['wholeWord', '全词'],
      ['regexp', '正则'],
    ] as const) {
      const control = button(label, label, () => this.commit({ [key]: !this.query[key] }));
      this.options.set(key, control);
      options.append(control);
    }
    const close = button('×', '关闭搜索（Esc）', () => closeSearchPanel(view));
    close.className = 'json-search-close';
    this.dom.append(field, navigation, options, close);
    this.dom.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSearchPanel(view);
      } else if (event.key === 'Enter' && event.target === this.input) {
        event.preventDefault();
        (event.shiftKey ? findPrevious : findNext)(view);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        this.input.focus();
        this.input.select();
      } else if (runScopeHandlers(view, event, 'search-panel')) {
        event.preventDefault();
      }
    });
    this.render();
  }

  private commit(
    options: Partial<Pick<SearchQuery, 'caseSensitive' | 'wholeWord' | 'regexp'>> = {},
  ) {
    const query = new SearchQuery({
      search: this.input.value,
      literal: true,
      caseSensitive: this.query.caseSensitive,
      wholeWord: this.query.wholeWord,
      regexp: this.query.regexp,
      ...options,
    });
    if (query.eq(this.query)) return;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    const first = this.results.matches[0];
    if (first) {
      this.view.dispatch({
        selection: { anchor: first.from, head: first.to },
        effects: EditorView.scrollIntoView(first.from, { y: 'center' }),
      });
    }
  }

  mount() {
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  update(update: ViewUpdate) {
    const query = getSearchQuery(update.state);
    if (!query.eq(this.query) || update.docChanged) {
      this.query = query;
      this.results = collectSearchMatches(update.state, query);
    }
    this.render();
  }

  private render() {
    if (!this.composing && this.input.value !== this.query.search)
      this.input.value = this.query.search;
    for (const [key, control] of this.options) {
      control.setAttribute('aria-pressed', String(this.query[key]));
    }
    const { matches, limited } = this.results;
    const selection = this.view.state.selection.main;
    const current = matches.findIndex(
      ({ from, to }) => from === selection.from && to === selection.to,
    );
    const invalid = !!this.query.search && !this.query.valid;
    const text = !this.query.search
      ? '输入关键词'
      : invalid
        ? '正则表达式无效'
        : !matches.length
          ? '无匹配结果'
          : limited
            ? '10,000+ 项'
            : current < 0
              ? `共 ${matches.length} 项`
              : `${current + 1} / ${matches.length}`;
    if (this.status.textContent !== text) this.status.textContent = text;
    this.input.setAttribute('aria-invalid', String(invalid));
    this.dom.dataset.empty = String(!!this.query.search && !matches.length);
    this.previous.disabled = this.next.disabled = !matches.length;
  }
}

export const jsonSearch = search({
  top: true,
  literal: true,
  createPanel: (view) => new JsonSearchPanel(view),
});
