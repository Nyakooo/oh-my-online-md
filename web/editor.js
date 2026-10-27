import { EditorState, Compartment, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

const md = new MarkdownIt({ html: false, linkify: true }).use(taskLists);
let diagramLoader;
function loadDiagrams() {
  if (!diagramLoader) diagramLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/diagrams.bundle.js';
    script.onload = resolve;
    script.onerror = () => { script.remove(); diagramLoader = null; reject(new Error('图表组件加载失败，请切回编辑后重试')); };
    document.head.append(script);
  });
  return diagramLoader;
}

window.createNoteEditor = function(parent, { onChange, onPaste, resolveImage }) {
  const editable = new Compartment();
  let suppressChange = false, canEdit = true, mode = 'edit', revision = 0;
  parent.innerHTML = `<div class="editor-toolbar"><div role="tablist" aria-label="正文模式"><button type="button" id="edit-tab" role="tab" aria-selected="true" aria-controls="write-panel">编辑</button><button type="button" id="preview-tab" role="tab" aria-selected="false" aria-controls="preview-panel" tabindex="-1">预览</button></div><div class="format-tools" role="group" aria-label="Markdown 格式"></div></div><div id="write-panel" role="tabpanel" aria-labelledby="edit-tab"></div><div id="preview-panel" class="markdown" role="tabpanel" aria-labelledby="preview-tab" tabindex="0" hidden></div><div class="editor-help">支持 Markdown · Tab 缩进 / Shift+Tab 取消缩进 · Esc 后 Tab 离开编辑区 <button type="button" class="shortcut-help">快捷键</button></div><div class="shortcut-details" hidden>Ctrl / ⌘ + B 加粗 · I 斜体 · K 链接 · E 行内代码 · Shift+P 切换预览 · S 保存。支持粘贴、拖放或选择图片；图片随笔记保存后上传。</div>`;
  const write = parent.querySelector('#write-panel');
  const preview = parent.querySelector('#preview-panel');
  const tools = parent.querySelector('.format-tools');
  function format(before, after = '', sample = '文本', line = false) {
    if (!canEdit) return false;
    setMode('edit');
    const range = view.state.selection.main;
    const from = line ? view.state.doc.lineAt(range.from).from : range.from;
    const selected = view.state.sliceDoc(from, range.to);
    const insert = line ? (selected || sample).split('\n').map(text => before + text).join('\n') : before + (selected || sample) + after;
    view.dispatch({ changes: { from, to: range.to, insert }, selection: { anchor: from + before.length, head: from + insert.length - after.length }, scrollIntoView: true, userEvent: 'input' });
    view.focus();
    return true;
  }
  const extensions = [history(), keymap.of([
    { key: 'Mod-b', run: () => format('**', '**') },
    { key: 'Mod-i', run: () => format('_', '_') },
    { key: 'Mod-k', run: () => format('[', '](https://)', '链接文字') },
    { key: 'Mod-e', run: () => format('`', '`', '代码') },
    { key: 'Mod-Shift-7', run: () => format('1. ', '', '列表项', true) },
    { key: 'Mod-Shift-8', run: () => format('- ', '', '列表项', true) },
    ...markdownKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap
  ]), markdown(), EditorState.tabSize.of(2), EditorView.lineWrapping,
  placeholder('使用 Markdown 记录想法…'),
  editable.of([EditorView.editable.of(true), EditorState.readOnly.of(false)]),
  EditorView.contentAttributes.of({ 'aria-label': '笔记正文', 'aria-multiline': 'true', spellcheck: 'false' }),
  EditorView.domEventHandlers({ paste: event => canEdit ? onPaste(event) : false }),
  EditorView.updateListener.of(update => { if (update.docChanged && !suppressChange) onChange(); }),
  EditorView.theme({
    '&': { backgroundColor: 'transparent', color: 'var(--body-text)', fontSize: '15px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', overflow: 'auto' },
    '.cm-content': { padding: '16px', minHeight: '45vh', caretColor: 'var(--text)' },
    '.cm-line': { padding: '0', lineHeight: '1.8' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '.cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' }
  })];
  const view = new EditorView({ parent: write, state: EditorState.create({ extensions }) });
  for (const [label, text, before, after, sample, line] of [
    ['标题', 'H', '## ', '', '标题', true], ['加粗 (Ctrl/⌘ B)', 'B', '**', '**'],
    ['斜体 (Ctrl/⌘ I)', 'I', '_', '_'], ['删除线', 'S̶', '~~', '~~'],
    ['引用', '❞', '> ', '', '引用内容', true], ['行内代码 (Ctrl/⌘ E)', '<>', '`', '`', '代码'],
    ['代码块', '{ }', '\n```\n', '\n```\n', '代码'], ['链接 (Ctrl/⌘ K)', '↗', '[', '](https://)', '链接文字'],
    ['无序列表', '•', '- ', '', '列表项', true], ['有序列表', '1.', '1. ', '', '列表项', true],
    ['任务列表', '☑', '- [ ] ', '', '待办事项', true],
    ['表格', '▦', '\n', '\n', '| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |'],
    ['Mermaid 图表', '◇', '\n```mermaid\n', '\n```\n', 'flowchart LR\n  A[开始] --> B[完成]']
  ]) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text; button.title = label; button.setAttribute('aria-label', label);
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => format(before, after, sample, line)); tools.append(button);
  }
  function setMode(next) {
    mode = next;
    write.hidden = mode !== 'edit'; preview.hidden = mode === 'edit'; tools.hidden = mode !== 'edit';
    for (const name of ['edit', 'preview']) {
      const tab = parent.querySelector(`#${name}-tab`);
      tab.setAttribute('aria-selected', String(name === mode)); tab.tabIndex = name === mode ? 0 : -1;
    }
    if (mode === 'preview') renderPreview();
    else { revision++; view.requestMeasure(); }
  }
  async function renderPreview() {
    const version = ++revision;
    preview.innerHTML = md.render(view.state.doc.toString()) || '<p class="preview-empty">暂无内容可预览</p>';
    for (const img of preview.querySelectorAll('img')) img.src = resolveImage(img.getAttribute('src'));
    const diagrams = [...preview.querySelectorAll('pre > code.language-mermaid')];
    for (const code of diagrams) {
      const source = code.textContent;
      const box = document.createElement('div'); box.className = 'diagram';
      box.innerHTML = '<div class="diagram-tools"><button type="button" aria-label="缩小图表">−</button><output>100%</output><button type="button" aria-label="放大图表">+</button><button type="button" aria-label="重置图表缩放">重置</button></div><div class="diagram-viewport"><div class="diagram-canvas"></div></div><p class="diagram-status" role="status">正在绘制图表…</p>';
      code.parentElement.replaceWith(box);
      try {
        await loadDiagrams();
        if (version !== revision) return;
        const svg = await window.renderNoteDiagram(source);
        if (version !== revision) return;
        const canvas = box.querySelector('.diagram-canvas'); canvas.innerHTML = svg;
        const graphic = canvas.querySelector('svg');
        graphic.style.maxWidth = 'none';
        const width = graphic.viewBox.baseVal.width || 600;
        const height = graphic.viewBox.baseVal.height || 300;
        const base = Math.min(1, (preview.clientWidth - 32) / width);
        let zoom = 1;
        const resize = value => {
          zoom = Math.max(.25, Math.min(4, value));
          graphic.style.width = `${width * base * zoom}px`; graphic.style.height = `${height * base * zoom}px`;
          box.querySelector('output').textContent = `${Math.round(zoom * 100)}%`;
        };
        const buttons = box.querySelectorAll('button');
        buttons[0].onclick = () => resize(zoom - .25); buttons[1].onclick = () => resize(zoom + .25); buttons[2].onclick = () => resize(1);
        box.querySelector('.diagram-viewport').addEventListener('wheel', event => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault(); resize(zoom + (event.deltaY < 0 ? .1 : -.1));
        }, { passive: false });
        resize(1); box.querySelector('.diagram-status').remove();
      } catch {
        if (version !== revision) return;
        box.querySelector('.diagram-status').textContent = '图表无法渲染，请检查 Mermaid 语法或切回编辑后重试。';
        const pre = document.createElement('pre'); pre.textContent = source; box.append(pre);
        box.querySelectorAll('button').forEach(button => { button.disabled = true; });
      }
    }
  }
  for (const name of ['edit', 'preview']) parent.querySelector(`#${name}-tab`).onclick = () => setMode(name);
  parent.querySelector('[role=tablist]').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); setMode(event.key === 'Home' ? 'edit' : event.key === 'End' ? 'preview' : mode === 'edit' ? 'preview' : 'edit');
    parent.querySelector(`#${mode}-tab`).focus();
  });
  parent.querySelector('.shortcut-help').onclick = () => { const help = parent.querySelector('.shortcut-details'); help.hidden = !help.hidden; };
  return {
    getValue: () => view.state.doc.toString(),
    setMode,
    togglePreview() { setMode(mode === 'edit' ? 'preview' : 'edit'); },
    setValue(value, resetHistory = false) {
      suppressChange = true;
      try {
        if (resetHistory) { view.setState(EditorState.create({ doc: value, extensions })); this.setEditable(canEdit); }
        else if (value !== view.state.doc.toString()) {
          const previous = view.state.doc.toString();
          let from = 0, suffix = 0;
          while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
          while (suffix < previous.length - from && suffix < value.length - from && previous[previous.length - suffix - 1] === value[value.length - suffix - 1]) suffix++;
          view.dispatch({ changes: { from, to: previous.length - suffix, insert: value.slice(from, value.length - suffix) }, annotations: Transaction.addToHistory.of(false) });
        }
        if (mode === 'preview') renderPreview();
      } finally { suppressChange = false; }
    },
    insertText(text) {
      if (!canEdit) return;
      setMode('edit');
      const range = view.state.selection.main;
      view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length }, scrollIntoView: true, userEvent: 'input' }); view.focus();
    },
    refreshImages() { if (mode === 'preview') renderPreview(); },
    setEditable(value) {
      canEdit = value;
      view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(value), EditorState.readOnly.of(!value)]) });
      tools.querySelectorAll('button').forEach(button => { button.disabled = !value; });
    },
    focus() { setMode('edit'); view.focus(); },
    blur() { view.contentDOM.blur(); },
    destroy() { revision++; view.destroy(); }
  };
};
