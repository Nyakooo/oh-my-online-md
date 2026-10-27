import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({ html: true, linkify: true }).use(taskLists);
const dimensions = /^(auto|0|[0-9]+(?:\.[0-9]+)?(?:px|%|em|rem|vw|vh))$/i;
const tags = 'p br hr h1 h2 h3 h4 h5 h6 strong b em i del s strike blockquote ul ol li pre code a img table thead tbody tfoot tr th td div span details summary sub sup kbd mark video source input'.split(' ');
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.hasAttribute('style')) {
    const values = [];
    if (node.matches('img, video')) {
      for (const name of ['width', 'height', 'max-width', 'max-height']) {
        const value = node.style.getPropertyValue(name).trim();
        if (dimensions.test(value)) values.push(`${name}: ${value}`);
      }
    }
    node.removeAttribute('style');
    if (values.length) node.setAttribute('style', values.join('; '));
  }
  if (node.hasAttribute('class') && !/^(language-[a-zA-Z0-9_+-]+|contains-task-list|task-list-item|task-list-item-checkbox)$/.test(node.className)) node.removeAttribute('class');
  if (node.matches('img, video')) {
    for (const name of ['width', 'height']) if (node.hasAttribute(name) && !/^[1-9][0-9]{0,4}%?$/.test(node.getAttribute(name))) node.removeAttribute(name);
  }
  if (node.tagName === 'INPUT') {
    node.type = 'checkbox'; node.disabled = true;
  }
});
export function renderMarkdown(source) {
  return DOMPurify.sanitize(md.render(source), {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['href', 'src', 'title', 'alt', 'width', 'height', 'style', 'class', 'poster', 'controls', 'loop', 'muted', 'playsinline', 'preload', 'type', 'open', 'start', 'colspan', 'rowspan', 'align', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
  });
}
