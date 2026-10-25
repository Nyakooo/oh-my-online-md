import { EditorState, StateField, StateEffect, Compartment, Transaction } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { parser, GFM } from '@lezer/markdown';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

// The document stays plain Markdown. Decorations replace only inactive source;
// CodeMirror owns selection, IME composition, and undo/redo throughout.
const md = new MarkdownIt({ html: false, linkify: true }).use(taskLists);
const blockParser = parser.configure(GFM);
const focusChanged = StateEffect.define();
const imagesChanged = StateEffect.define();

window.createNoteEditor = function(parent, { onChange, onPaste, resolveImage }) {
  const editable = new Compartment();
  let suppressChange = false;
  let imageVersion = 0;

  class PreviewBlock extends WidgetType {
    constructor(source, from, html, version) {
      super();
      this.source = source;
      this.from = from;
      this.html = html;
      this.version = version;
    }
    eq(other) {
      return this.source === other.source && this.from === other.from && this.html === other.html && this.version === other.version;
    }
    toDOM(view) {
      const dom = document.createElement('div');
      dom.className = 'markdown rendered-block';
      dom.dataset.from = this.from;
      const template = document.createElement('template');
      template.innerHTML = this.html;
      for (const img of template.content.querySelectorAll('img')) {
        img.src = resolveImage(img.getAttribute('src'));
        img.addEventListener('load', () => view.requestMeasure());
      }
      dom.append(template.content);
      const activate = event => {
        if (!view.state.facet(EditorView.editable) || event.button > 0 || event.ctrlKey || event.metaKey) return;
        // Map the clicked visible text back through the Markdown punctuation.
        // If a browser cannot supply a text caret (e.g. an image), edit the
        // beginning of that source block instead.
        let offset = 0;
        const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
        const legacy = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
        const node = caret?.offsetNode || legacy?.startContainer;
        const nodeOffset = caret?.offset ?? legacy?.startOffset;
        if (node && dom.contains(node)) {
          const range = document.createRange();
          range.selectNodeContents(dom);
          range.setEnd(node, nodeOffset);
          for (const char of range.toString()) {
            const found = this.source.indexOf(char, offset);
            if (found >= 0) offset = found + char.length;
          }
        }
        event.preventDefault();
        view.dispatch({ selection: { anchor: this.from + Math.min(offset, this.source.length) }, effects: focusChanged.of(true) });
        view.focus();
      };
      dom.addEventListener('mousedown', activate);
      let touchStart;
      dom.addEventListener('touchstart', event => {
        const touch = event.touches[0];
        touchStart = touch && { x: touch.clientX, y: touch.clientY };
      }, { passive: true });
      dom.addEventListener('touchend', event => {
        if (event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        if (!touchStart || Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 8) return;
        activate({ button: 0, clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => event.preventDefault() });
      });
      return dom;
    }
    ignoreEvent() { return true; }
  }

  function buildDecorations(state, focused) {
    const source = state.doc.toString();
    const decorations = [];
    const environment = {};
    // Resolve reference-style links using the entire document, even when an
    // individual block is rendered independently.
    md.parse(source, environment);
    function decorate(from, to) {
      if (to <= from) return;
      const active = focused && state.selection.ranges.some(range => {
        const first = state.doc.lineAt(range.from).from;
        const last = state.doc.lineAt(range.to).to;
        return first <= to && last >= from;
      });
      if (active) return;
      const raw = source.slice(from, to);
      const html = md.render(raw, { ...environment });
      if (!html.trim()) return;
      decorations.push(Decoration.replace({ widget: new PreviewBlock(raw, from, html, imageVersion), block: true }).range(from, to));
    }
    for (let node = blockParser.parse(source).topNode.firstChild; node; node = node.nextSibling) {
      if (node.name === 'Paragraph') {
        // Ordinary prose switches one line at a time. Structured Markdown such
        // as tables, lists, and fences stays together to preserve its meaning.
        for (let pos = node.from; pos < node.to;) {
          const line = state.doc.lineAt(pos);
          decorate(pos, Math.min(line.to, node.to));
          pos = line.to + 1;
        }
      } else {
        decorate(node.from, node.to);
      }
    }
    return Decoration.set(decorations, true);
  }

  const preview = StateField.define({
    create(state) { return { focused: false, decorations: buildDecorations(state, false) }; },
    update(value, transaction) {
      let focused = value.focused;
      for (const effect of transaction.effects) if (effect.is(focusChanged)) focused = effect.value;
      if (transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(focusChanged) || effect.is(imagesChanged))) {
        return { focused, decorations: buildDecorations(transaction.state, focused) };
      }
      return value;
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations)
  });

  const extensions = [
    history(), keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(), EditorView.lineWrapping, preview,
    editable.of([EditorView.editable.of(true), EditorState.readOnly.of(false)]),
    EditorView.contentAttributes.of({ 'aria-label': '笔记正文', 'aria-multiline': 'true', spellcheck: 'false' }),
    EditorView.domEventHandlers({
      focus(_event, view) { view.dispatch({ effects: focusChanged.of(true) }); },
      blur(_event, view) { view.dispatch({ effects: focusChanged.of(false) }); },
      paste(event) { return onPaste(event); }
    }),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !suppressChange) onChange();
    }),
    EditorView.theme({
      '&': { backgroundColor: 'transparent', color: 'var(--body-text)', fontSize: '15px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'inherit', overflow: 'visible' },
      '.cm-content': { padding: '0', minHeight: '55vh', caretColor: 'var(--text)' },
      '.cm-line': { padding: '0', lineHeight: '1.9', minHeight: '1.9em', whiteSpace: 'pre-wrap' },
      '.cm-cursor': { borderLeftColor: 'var(--text)' },
      '.cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' },
      '.cm-gutters': { display: 'none' }
    })
  ];
  const view = new EditorView({ parent, state: EditorState.create({ extensions }) });
  return {
    getValue: () => view.state.doc.toString(),
    setValue(value, resetHistory = false) {
      suppressChange = true;
      try {
        if (resetHistory) view.setState(EditorState.create({ doc: value, extensions }));
        else if (value !== view.state.doc.toString()) {
          const previous = view.state.doc.toString();
          let from = 0, suffix = 0;
          while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
          while (suffix < previous.length - from && suffix < value.length - from && previous[previous.length - suffix - 1] === value[value.length - suffix - 1]) suffix++;
          view.dispatch({ changes: { from, to: previous.length - suffix, insert: value.slice(from, value.length - suffix) }, annotations: Transaction.addToHistory.of(false) });
        }
      } finally { suppressChange = false; }
    },
    insertText(text) {
      const range = view.state.selection.main;
      view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length }, scrollIntoView: true });
      view.focus();
    },
    refreshImages() { imageVersion++; view.dispatch({ effects: imagesChanged.of(null) }); },
    setEditable(value) { view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(value), EditorState.readOnly.of(!value)]) }); },
    focus() { view.focus(); },
    blur() { view.contentDOM.blur(); },
    destroy() { view.destroy(); }
  };
};
