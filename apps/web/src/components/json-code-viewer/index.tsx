import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { Maximize, Minimize } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useTheme } from '../theme-provider';
import './json-code-viewer.css';

const extensions = [
  json(),
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
  const scrollSnapshot = useRef<ReturnType<EditorView['scrollSnapshot']> | undefined>(undefined);
  const placeholderHeight = useRef(260);
  const viewerRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = () => {
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
    <div className="json-code-viewer" ref={viewerRef}>
      <div className="json-code-toolbar">
        <div className="json-code-actions">{actions}</div>
        <button
          ref={toggleRef}
          type="button"
          className="json-code-fullscreen-toggle"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? '退出全屏' : '全屏查看 JSON'}
          title={fullscreen ? '退出全屏' : '全屏查看 JSON'}
        >
          {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </button>
      </div>
      {feedback}
      <CodeMirror
        className="json-code-editor"
        value={value}
        theme={resolvedTheme}
        editable={false}
        readOnly
        {...(fullscreen ? { height: '100%' } : { minHeight: '210px', maxHeight: '520px' })}
        extensions={extensions}
        basicSetup={basicSetup}
        onCreateEditor={(view) => {
          editorRef.current = view;
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
      <div aria-hidden="true" style={{ height: placeholderHeight.current }} />
      {createPortal(
        <dialog
          ref={dialogRef}
          className="json-code-fullscreen"
          aria-label="JSON 代码全屏查看"
          onCancel={(event) => {
            event.preventDefault();
            toggleFullscreen();
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
