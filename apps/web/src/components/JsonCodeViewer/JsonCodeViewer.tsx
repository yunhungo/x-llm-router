/**
 * @created 2026-09-04
 * @description 展示支持搜索、复制操作和全屏阅读的只读 JSON。
 * @author yunhungo
 */
import { json } from '@codemirror/lang-json';
import {
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
  getSearchQuery,
  setSearchQuery,
  type SearchQuery,
} from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { Maximize, Minimize, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useTheme } from '@/components/theme-provider';
import { jsonSearch } from './search-panel';
import './JsonCodeViewer.scss';

const extensions = [
  json(),
  jsonSearch,
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': 'JSON 代码', tabindex: '0' }),
  EditorView.theme({
    '&': { backgroundColor: 'var(--canvas)', color: 'var(--ink)', fontSize: '12px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, monospace",
      lineHeight: '1.65',
      overflow: 'auto',
    },
    '.cm-content': { padding: '12px 0 20px' },
    '.cm-line': { padding: '0 20px' },
    '.cm-gutters': { backgroundColor: 'var(--canvas)', color: 'var(--mute)', border: 'none' },
  }),
];

const basicSetup = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  autocompletion: false,
};

export function JsonCodeViewer({
  value,
  actions,
  feedback,
}: {
  value: string;
  actions: ReactNode;
  feedback?: ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const [fullscreen, setFullscreen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const savedEditorState = useRef<
    | { query: SearchQuery; selection: EditorView['state']['selection']; searchOpen: boolean }
    | undefined
  >(undefined);
  const scrollSnapshot = useRef<ReturnType<EditorView['scrollSnapshot']> | undefined>(undefined);
  const placeholderHeight = useRef(260);
  const viewerRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = () => {
    const state = editorRef.current?.state;
    savedEditorState.current = state
      ? {
          query: getSearchQuery(state),
          selection: state.selection,
          searchOpen: searchPanelOpen(state),
        }
      : undefined;
    scrollSnapshot.current = editorRef.current?.scrollSnapshot();
    if (!fullscreen) placeholderHeight.current = viewerRef.current?.offsetHeight ?? 260;
    setFullscreen((current) => !current);
  };

  useEffect(() => {
    if (!fullscreen) return;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.showModal();
    toggleRef.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      toggleRef.current?.focus({ preventScroll: true });
    };
  }, [fullscreen]);

  const viewer = (
    <div
      className='json-code-viewer'
      ref={viewerRef}
      onKeyDownCapture={(event) => {
        const view = editorRef.current;
        if (!view || event.nativeEvent.isComposing) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          event.stopPropagation();
          openSearchPanel(view);
        } else if (event.key === 'Escape' && (fullscreen || searchPanelOpen(view.state))) {
          event.preventDefault();
          event.stopPropagation();
          if (searchPanelOpen(view.state)) closeSearchPanel(view);
          else toggleFullscreen();
        }
      }}
    >
      <div className='json-code-toolbar'>
        <button
          type='button'
          className='json-code-search-toggle'
          onClick={() => {
            if (editorRef.current) openSearchPanel(editorRef.current);
          }}
          title='搜索 JSON（⌘F / Ctrl+F）'
        >
          <Search size={15} /> 搜索
        </button>
        <div className='json-code-actions'>{actions}</div>
        <button
          ref={toggleRef}
          type='button'
          className='json-code-fullscreen-toggle'
          onClick={toggleFullscreen}
          aria-label={fullscreen ? '退出全屏' : '全屏查看 JSON'}
          title={fullscreen ? '退出全屏' : '全屏查看 JSON'}
        >
          {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </button>
      </div>
      {feedback}
      <CodeMirror
        className='json-code-editor'
        value={value}
        theme={resolvedTheme}
        editable={false}
        readOnly
        {...(fullscreen ? { height: '100%' } : { minHeight: '210px', maxHeight: '520px' })}
        extensions={extensions}
        basicSetup={basicSetup}
        onCreateEditor={(view) => {
          editorRef.current = view;
          if (savedEditorState.current) {
            const saved = savedEditorState.current;
            if (saved.searchOpen) openSearchPanel(view);
            view.dispatch({ effects: setSearchQuery.of(saved.query), selection: saved.selection });
            savedEditorState.current = undefined;
          }
          if (scrollSnapshot.current) {
            view.dispatch({ effects: scrollSnapshot.current });
            scrollSnapshot.current = undefined;
          }
        }}
      />
    </div>
  );

  return fullscreen ? (
    <>
      <div aria-hidden='true' style={{ height: placeholderHeight.current }} />
      {createPortal(
        <dialog
          ref={dialogRef}
          className='json-code-fullscreen'
          aria-label='JSON 代码全屏查看'
          onCancel={(event) => {
            event.preventDefault();
            if (editorRef.current && searchPanelOpen(editorRef.current.state)) {
              closeSearchPanel(editorRef.current);
            } else {
              toggleFullscreen();
            }
          }}
        >
          {viewer}
        </dialog>,
        document.body,
      )}
    </>
  ) : (
    viewer
  );
}
