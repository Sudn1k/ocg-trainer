/**
 * Lightweight, zero-dependency HTML DOM parser for Node.js.
 * Provides a clean subset of Browser DOM APIs (`querySelector`, `querySelectorAll`,
 * `getAttribute`, `textContent`, `innerHTML`, `outerHTML`) so the SyncShare
 * extractor can inspect arbitrary saved HTML pages reliably.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style']);

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  rarr: '→',
  larr: '←',
  bull: '•',
};

export function decodeEntities(str) {
  if (!str || !str.includes('&')) return str;
  return str.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z0-9]+);/g, (full, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity)
      ? NAMED_ENTITIES[entity]
      : full;
  });
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseAttributes(attrString) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    const key = m[1].toLowerCase();
    const rawVal = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeEntities(rawVal);
  }
  return attrs;
}

class HtmlNode {
  constructor(type, tag = null, attrs = {}, text = '') {
    this.type = type; // 'root' | 'element' | 'text'
    this.tag = tag;
    this.attrs = attrs;
    this.text = text;
    this.children = [];
    this.parent = null;
  }

  append(node) {
    node.parent = this;
    this.children.push(node);
  }

  getAttribute(name) {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name.toLowerCase());
  }

  get id() {
    return this.attrs.id || '';
  }

  get tagName() {
    return this.tag ? this.tag.toUpperCase() : '';
  }

  get classList() {
    const raw = this.attrs.class || '';
    const tokens = raw.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => tokens.includes(c),
      values: tokens,
    };
  }

  get textContent() {
    if (this.type === 'text') return this.text;
    let out = '';
    for (const child of this.children) {
      out += child.textContent;
    }
    return out;
  }

  get innerHTML() {
    if (this.type === 'text') return escapeHtml(this.text);
    let out = '';
    for (const child of this.children) {
      out += child.outerHTML;
    }
    return out;
  }

  get outerHTML() {
    if (this.type === 'text') return escapeHtml(this.text);
    if (this.type === 'root') return this.innerHTML;
    const attrStr = Object.entries(this.attrs)
      .map(([k, v]) => (v === '' ? k : `${k}="${escapeHtml(v)}"`))
      .join(' ');
    const open = attrStr ? `<${this.tag} ${attrStr}>` : `<${this.tag}>`;
    if (VOID_TAGS.has(this.tag)) return open;
    return `${open}${this.innerHTML}</${this.tag}>`;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
    const results = [];
    const seen = new Set();

    const walk = (node) => {
      for (const child of node.children) {
        if (child.type === 'element') {
          for (const sel of selectors) {
            if (matchesSelector(child, sel) && !seen.has(child)) {
              seen.add(child);
              results.push(child);
              break;
            }
          }
          walk(child);
        }
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }
}

function matchesSimple(el, part) {
  if (!part || el.type !== 'element') return false;
  let rest = part;

  // Tag at start
  const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    if (el.tag !== tagMatch[1].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }

  // Attribute selectors [attr] or [attr="val"] or [attr^="val"]
  const attrRe = /\[([^\]=^$*]+)(?:([*^$]?)=["']?([^"'\]]*)["']?)?\]/g;
  let am;
  while ((am = attrRe.exec(rest)) !== null) {
    const attrName = am[1].trim().toLowerCase();
    const op = am[2] || '';
    const expected = am[3];
    if (!el.hasAttribute(attrName)) return false;
    if (expected !== undefined) {
      const actual = el.getAttribute(attrName) || '';
      if (op === '' && actual !== expected) return false;
      if (op === '^' && !actual.startsWith(expected)) return false;
      if (op === '$' && !actual.endsWith(expected)) return false;
      if (op === '*' && !actual.includes(expected)) return false;
    }
  }
  rest = rest.replace(attrRe, '');

  // ID and class selectors
  const tokenRe = /([.#])([a-zA-Z0-9_-]+)/g;
  let tm;
  while ((tm = tokenRe.exec(rest)) !== null) {
    if (tm[1] === '#' && el.id !== tm[2]) return false;
    if (tm[1] === '.' && !el.classList.contains(tm[2])) return false;
  }

  return true;
}

function matchesSelector(el, selector) {
  const parts = selector.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  if (!matchesSimple(el, last)) return false;
  if (parts.length === 1) return true;

  let cur = el.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    const target = parts[i];
    if (target === '>') {
      // direct child handled by checking next part on immediate parent
      continue;
    }
    const mustBeDirect = parts[i + 1] === '>';
    if (mustBeDirect) {
      if (!cur || !matchesSimple(cur, target)) return false;
      cur = cur.parent;
    } else {
      while (cur && !matchesSimple(cur, target)) {
        cur = cur.parent;
      }
      if (!cur) return false;
      cur = cur.parent;
    }
  }
  return true;
}

export function parseHtmlDom(html) {
  const root = new HtmlNode('root');
  const stack = [root];
  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      const text = decodeEntities(html.slice(i));
      if (text) stack[stack.length - 1].append(new HtmlNode('text', null, {}, text));
      break;
    }

    if (lt > i) {
      const text = decodeEntities(html.slice(i, lt));
      if (text) stack[stack.length - 1].append(new HtmlNode('text', null, {}, text));
    }

    // Comment <!-- ... -->
    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      i = endComment === -1 ? len : endComment + 3;
      continue;
    }

    // DOCTYPE or processing instruction
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const gt = html.indexOf('>', lt + 2);
      i = gt === -1 ? len : gt + 1;
      continue;
    }

    // Closing tag </tag>
    if (html[lt + 1] === '/') {
      const gt = html.indexOf('>', lt + 2);
      if (gt === -1) break;
      const closeTag = html.slice(lt + 2, gt).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === closeTag) {
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    // Opening tag <tag ...>
    let gt = lt + 1;
    let quote = null;
    while (gt < len) {
      const ch = html[gt];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt++;
    }
    if (gt >= len) break;

    const inside = html.slice(lt + 1, gt).trim();
    const selfClosing = inside.endsWith('/');
    const cleanInside = selfClosing ? inside.slice(0, -1).trim() : inside;
    const spaceIdx = cleanInside.search(/\s/);
    const tagName = (spaceIdx === -1 ? cleanInside : cleanInside.slice(0, spaceIdx)).toLowerCase();
    const attrPart = spaceIdx === -1 ? '' : cleanInside.slice(spaceIdx + 1);

    if (!tagName || !/^[a-z0-9:-]+$/.test(tagName)) {
      stack[stack.length - 1].append(new HtmlNode('text', null, {}, '<'));
      i = lt + 1;
      continue;
    }

    const attrs = attrPart ? parseAttributes(attrPart) : {};
    const el = new HtmlNode('element', tagName, attrs);
    stack[stack.length - 1].append(el);

    if (RAW_TEXT_TAGS.has(tagName) && !selfClosing) {
      const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
      const rest = html.slice(gt + 1);
      const m = closeRe.exec(rest);
      if (m) {
        i = gt + 1 + m.index + m[0].length;
      } else {
        i = len;
      }
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(tagName)) {
      stack.push(el);
    }
    i = gt + 1;
  }

  return root;
}
