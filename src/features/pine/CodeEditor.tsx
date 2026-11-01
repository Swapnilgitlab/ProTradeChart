import { useEffect, useRef, type MutableRefObject } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { pineExtensions } from './pineLanguage';

const MONO = '"Cascadia Mono", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace';

/** Every colour is an app token, so the editor follows the theme with no extra plumbing. */
const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface-1)', color: 'var(--text-primary)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--surface-1)', color: 'var(--text-muted)', border: 'none', borderRight: '1px solid var(--border-soft)' },
  '.cm-activeLine': { backgroundColor: 'var(--surface-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)', color: 'var(--text-secondary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '.cm-matchingBracket': { outline: '1px solid var(--accent)', backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-1)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    boxShadow: 'var(--shadow-pop)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul': { fontFamily: MONO, fontSize: '12px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text-primary)' },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-panels': { backgroundColor: 'var(--surface-1)', color: 'var(--text-primary)', borderColor: 'var(--border)' },
  '.cm-panels input, .cm-panels button': { font: 'inherit' },
});

/** What a parent can do to a mounted editor besides remounting it. */
export interface CodeEditorHandle {
  /** Replaces the whole text as one undo step of its own (a single Ctrl+Z puts the old text back),
   *  reported through `onChange` like typing. */
  replaceAll: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+S. */
  onSave: () => void;
  /** Ctrl/Cmd+Enter. */
  onRun: () => void;
  /** Syntax colouring and completion. Pine's, unless another language is given. */
  language?: Extension;
  placeholderText?: string;
  /** Filled while the editor is mounted. */
  handleRef?: MutableRefObject<CodeEditorHandle | null>;
}

const PINE_PLACEHOLDER = 'Write a Pine Script indicator() or strategy() here…';

/** A source editor, for Pine Script unless given another language. Uncontrolled after
 *  mount: the parent remounts it (via `key`) to load a different script, which also gives
 *  that script a fresh undo history. */
export function CodeEditor({ value, onChange, onSave, onRun, language = pineExtensions, placeholderText = PINE_PLACEHOLDER, handleRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The editor is built once, so the callbacks it holds are read through a ref.
  const callbacks = useRef({ onChange, onSave, onRun });
  callbacks.current = { onChange, onSave, onRun };

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          placeholder(placeholderText),
          language,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: () => {
                callbacks.current.onRun();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          editorTheme,
        ],
      }),
    });
    if (handleRef) {
      handleRef.current = {
        replaceAll: (text) =>
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor: 0 },
            scrollIntoView: true,
            annotations: isolateHistory.of('full'),
          }),
      };
    }
    return () => {
      if (handleRef) handleRef.current = null;
      view.destroy();
    };
    // Built once per mount; `value` only seeds the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="pine-code-editor" />;
}
