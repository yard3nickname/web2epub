// ==UserScript==
// @name         web2epub
// @namespace    web2epub
// @version      1.0.0
// @description  Download the current page as an EPUB (with optional Hebrew RTL layout)
// @match        *://*/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Usage
 *  - Tampermonkey / Violentmonkey: install this file; a "📖 EPUB" button appears bottom-right on every page.
 *  - Without an extension: paste the whole file into the DevTools console. JSZip is loaded from cdnjs.
 *
 * Click the button, tick "Hebrew (RTL)" if needed, then "Create EPUB".
 */
(function () {
  'use strict';

  const UI_ID = 'w2e-ui-host';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

  const RTL_CSS = `@charset "utf-8";

/* Global RTL and alignment settings */
body {
    direction: rtl;
    text-align: right;
    font-family: sans-serif;
    line-height: 1.6;
    margin: 5% 5% 5% 5%;
    padding: 0;
}

p, span, h1, h2, h3, h4, h5, h6, li {
    direction: rtl;
    text-align: right;
}

/* Ensure images and maps stay centered and don't overflow */
img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 10px auto;
}

/* Tables alignment fix for RTL */
table {
    direction: rtl;
    margin: 0 auto;
}

th, td {
    text-align: right;
    padding: 8px;
}
`;

  // Appended to the stylesheet: thumbnail galleries and the full-screen page each thumbnail links to.
  const IMAGE_CSS = `
/* Photo galleries: thumbnails side by side */
.gallery {
    text-align: center;
    margin: 1em 0;
}

.gallery > * {
    display: inline-block;
    width: 31%;
    margin: 1%;
    vertical-align: top;
}

.gallery img {
    width: 100%;
    margin: 0;
    display: block;
}

.gallery figcaption {
    font-size: 0.75em;
    line-height: 1.3;
    text-align: center;
    margin-top: 0.3em;
}

/* Full-screen image pages */
.image-page {
    text-align: center;
}

.image-page p {
    text-align: center;
}
`;

  const LTR_CSS = `@charset "utf-8";

body {
    font-family: serif;
    line-height: 1.6;
    margin: 5% 5% 5% 5%;
    padding: 0;
}

img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 10px auto;
}

table {
    border-collapse: collapse;
    margin: 0 auto;
}

th, td {
    padding: 8px;
}

pre {
    white-space: pre-wrap;
    font-size: 0.9em;
}
`;

  // ---------------------------------------------------------------- helpers

  const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const isHtml = (el) => el.namespaceURI === XHTML_NS;
  const escXml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const safeDecode = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };

  function rename(el, tag) {
    const repl = el.ownerDocument.createElement(tag);
    for (const a of Array.from(el.attributes)) {
      try { repl.setAttribute(a.name, a.value); } catch { /* invalid name */ }
    }
    while (el.firstChild) repl.appendChild(el.firstChild);
    el.replaceWith(repl);
    return repl;
  }

  function unwrap(el) {
    el.replaceWith(...Array.from(el.childNodes));
  }

  function wrapChildren(el, tag) {
    const w = el.ownerDocument.createElement(tag);
    while (el.firstChild) w.appendChild(el.firstChild);
    el.appendChild(w);
  }

  async function pool(items, limit, fn) {
    let i = 0;
    const worker = async () => {
      while (i < items.length) await fn(items[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  const BLOCK_SEL = 'p,div,ul,ol,dl,table,blockquote,pre,section,article,figure,h1,h2,h3,h4,h5,h6,header,main,hr';
  const INLINE_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'em', 'strong', 'b', 'i', 'u', 's',
    'small', 'sub', 'sup', 'code', 'kbd', 'samp', 'var', 'q', 'cite', 'abbr', 'dfn', 'mark', 'time', 'label', 'del', 'ins']);

  // ------------------------------------------------- step 1: text to DOM

  // The rendered page is serialized instead of re-downloaded. That keeps JS-rendered content and lets
  // us record computed styles (hidden / bold / italic / pre) that are lost once we work on a detached DOM.
  // True when the element shows newlines in its text as line breaks (CSS pre-line / pre-wrap / break-spaces).
  function keepsBreaks(cs) {
    if (cs.whiteSpaceCollapse) return cs.whiteSpaceCollapse !== 'collapse';
    return /^(pre|break-spaces)/.test(cs.whiteSpace);
  }

  const ICON_CLASS = /\b(lucide|fa[srbl]?|material-icons|material-symbols-\w+|glyphicon|icon|icons)\b/i;

  // Decorative icons and leftover UI controls. Returns 'x' (remove), 'u' (unwrap, keep the text) or ''.
  function uiLeftover(el, cs, pcs) {
    const tag = el.tagName;
    const isSvg = tag.toLowerCase() === 'svg' && !el.ownerSVGElement;
    if (el.ownerSVGElement) return '';
    if (isSvg || tag === 'IMG') {
      const r = el.getBoundingClientRect();
      const max = isSvg ? 48 : 32;
      // One side can be 0 when a flex row squeezes the icon; it is still drawn small.
      if ((r.width > 0 || r.height > 0) && r.width <= max && r.height <= max) return 'x';
    }
    const len = (el.textContent || '').trim().length;
    if (ICON_CLASS.test(el.getAttribute('class') || '') && len < 30 && !el.querySelector('img,h1,h2,h3,h4,h5,h6')) return 'x';
    // Clickable non-link things with a short label: buttons, chips, map placeholders, injected widgets.
    const clickable = el.getAttribute('role') === 'button' || (cs.cursor === 'pointer' && pcs && pcs.cursor !== 'pointer');
    if (!clickable || tag === 'A' || el.closest('a,summary,h1,h2,h3,h4,h5,h6') || len > 40 ||
        el.querySelector('img,video,picture,h1,h2,h3,h4,h5,h6,a[href]')) return '';
    // A plain inline wrapper inside running text (e.g. an extension highlighting a word) keeps its text;
    // pills and chips (inline-block / inline-flex) are removed.
    const inText = cs.display === 'inline' && el.parentElement &&
      Array.from(el.parentElement.childNodes).some((c) => c.nodeType === 3 && c.data.trim());
    return inText ? 'u' : 'x';
  }

  const INLINE_LIVE = /^(SPAN|A|STRONG|EM|B|I|U|S|LABEL|SMALL|TIME|ABBR|CITE|CODE|MARK|SUB|SUP|Q|DFN|KBD|SAMP|VAR)$/;

  // Ads injected into the page after it loaded, e.g. AdSense "ad intents" chips ("שכור מהנדס").
  const AD_CLASS = /(^|\s)(google-anno[\w-]*|adsbygoogle|google-auto-placed|autors-container)(\s|$)/i;
  const AD_HREF = /^https?:\/\/([^/]+\.)?(googleadservices\.com|doubleclick\.net|googlesyndication\.com|adservice\.google\.[a-z.]+)\/|[?&]client=ca-pub-|\/aclk\?/i;

  function isAd(el) {
    return AD_CLASS.test(el.getAttribute('class') || '') || /^(google_ads|aswift_)/.test(el.id) ||
      el.hasAttribute('data-google-query-id') || el.hasAttribute('data-ad-client') ||
      (el.tagName === 'A' && AD_HREF.test(el.href || ''));
  }

  const normSpace = (str) => str.replace(/\s+/g, ' ');

  // The text of the page as the server sent it, before scripts (and ads) changed it.
  async function fetchOriginalText(ctx) {
    try {
      const raw = ctx.originalHtml ?? await (await fetch(ctx.url, { credentials: 'include' })).text();
      return normSpace(new DOMParser().parseFromString(raw, 'text/html').documentElement.textContent);
    } catch {
      return '';
    }
  }

  // Ads can wrap a word that is really in the article (keep the word) or add new text (drop it).
  // Decide by looking for the ad's text, with a few characters around it, in the original page.
  function adWrapsOriginalText(el, original) {
    const text = normSpace(el.textContent).trim();
    if (!text || !original) return false;
    const prev = el.previousSibling?.nodeType === 3 ? normSpace(el.previousSibling.data).slice(-12) : '';
    const next = el.nextSibling?.nodeType === 3 ? normSpace(el.nextSibling.data).slice(0, 12) : '';
    if (!prev.trim() && !next.trim()) return false;
    return original.includes(prev + text + next) || original.includes((prev + text).trim()) && !!prev.trim() ||
      original.includes((text + next).trim()) && !!next.trim();
  }

  function snapshotLiveDom(original, win) {
    const document = win.document;
    const SEMANTIC_BOLD = new Set(['B', 'STRONG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TH', 'DT', 'SUMMARY', 'LEGEND']);
    const SEMANTIC_ITALIC = new Set(['I', 'EM', 'CITE', 'DFN', 'VAR', 'ADDRESS']);
    const stamped = [];
    const styles = new WeakMap();
    for (const el of Array.from(document.body.getElementsByTagName('*'))) {
      const cs = win.getComputedStyle(el);
      styles.set(el, cs);
      const pcs = styles.get(el.parentElement);
      const tag = el.tagName;
      const flags = [];
      if (isAd(el) && !el.parentElement?.closest('[data-w2e-ad]')) {
        el.setAttribute('data-w2e-ad', '');
        el.setAttribute('data-w2e-f', adWrapsOriginalText(el, original) ? 'k' : 'x');
        stamped.push(el);
        continue;
      }
      if (el.parentElement?.closest('[data-w2e-ad]')) continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' ||
          (cs.position === 'absolute' && cs.overflow === 'hidden' && el.offsetWidth <= 1 && el.offsetHeight <= 1)) {
        flags.push('h');
      } else if (pcs) {
        const ownText = Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.data.trim());
        if (ownText && !SEMANTIC_BOLD.has(tag) && +cs.fontWeight >= 600 && +pcs.fontWeight < 600) flags.push('b');
        if (ownText && !SEMANTIC_ITALIC.has(tag) && cs.fontStyle === 'italic' && pcs.fontStyle !== 'italic') flags.push('i');
        const pre = cs.whiteSpace === 'pre' || (cs.whiteSpace === 'pre-wrap' && /mono/i.test(cs.fontFamily));
        const parentPre = /^pre/.test(pcs.whiteSpace);
        if (pre && !parentPre && !['PRE', 'CODE', 'TEXTAREA'].includes(tag)) flags.push('p');
        else if (!pre && keepsBreaks(cs) && !keepsBreaks(pcs)) flags.push('n');
        // Inline tags laid out as blocks by CSS (e.g. <span> in a flex column) lose their separation without CSS.
        if (INLINE_LIVE.test(tag) && /^(block|flex|grid|list-item|table|flow-root)$/.test(cs.display)) {
          const row = /grid/.test(pcs.display) || (/flex/.test(pcs.display) && !/column/.test(pcs.flexDirection));
          flags.push(row ? 's' : 'd');
        }
      }
      if (el.getAttribute('role') === 'main') flags.push('m');
      if (!flags.includes('h')) { const ui = uiLeftover(el, cs, pcs); if (ui) flags.push(ui); }
      // A grid / wrapping flex box whose items are each one image is a photo gallery.
      if (!flags.includes('h') && (/grid/.test(cs.display) || (/flex/.test(cs.display) && cs.flexWrap === 'wrap'))) {
        const kids = Array.from(el.children);
        // Captions don't count: a gallery item is one image plus at most a short label besides its caption.
        const extraText = (k) => (k.textContent || '').trim().length -
          Array.from(k.querySelectorAll('figcaption')).reduce((n, c) => n + (c.textContent || '').trim().length, 0);
        if (kids.length >= 2 && kids.every((k) => (k.tagName === 'IMG' || k.querySelectorAll('img').length === 1) &&
            extraText(k) < 80)) flags.push('g');
      }
      if (flags.length) { el.setAttribute('data-w2e-f', flags.join(' ')); stamped.push(el); }
      if (tag === 'IMG' && el.currentSrc) { el.setAttribute('data-w2e-src', el.currentSrc); stamped.push(el); }
    }
    const html = '<!DOCTYPE html>' + document.documentElement.outerHTML;
    for (const el of stamped) { el.removeAttribute('data-w2e-f'); el.removeAttribute('data-w2e-src'); el.removeAttribute('data-w2e-ad'); }
    return html;
  }

  async function textToDom(ctx) {
    const html = snapshotLiveDom(await fetchOriginalText(ctx), ctx.win);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.getElementById(UI_ID)?.remove();
    // Move our private markers out of data-* so "Removing custom attributes" doesn't erase them.
    for (const el of $$(doc, '[data-w2e-f]')) {
      const f = el.getAttribute('data-w2e-f').split(' ');
      if (f.includes('m')) el.setAttribute('w2e-main', '');
      const rest = f.filter((x) => x !== 'm');
      if (rest.length) el.setAttribute('w2e-f', rest.join(' '));
      el.removeAttribute('data-w2e-f');
    }
    for (const el of $$(doc, '[data-w2e-src]')) {
      el.setAttribute('w2e-src', el.getAttribute('data-w2e-src'));
      el.removeAttribute('data-w2e-src');
    }
    const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
    ctx.doc = doc;
    ctx.body = doc.body;
    ctx.base = baseHref ? new URL(baseHref, ctx.url).href : ctx.url;
  }

  // ------------------------------------------------------- step 2: metadata

  function retrieveMetadata(ctx) {
    const { doc } = ctx;
    const m = (sel) => doc.querySelector(sel)?.getAttribute('content')?.trim() || '';
    const resolve = (u) => { try { return u ? new URL(u, ctx.base).href : ''; } catch { return ''; } };
    const h1 = doc.querySelector('h1');
    const published = m('meta[property="article:published_time"]') || m('meta[name="date"]') ||
      doc.querySelector('time[datetime]')?.getAttribute('datetime') || '';
    const pubDate = new Date(published);
    ctx.meta = {
      title: m('meta[property="og:title"]') || doc.title.trim() || (h1 && text(h1)) || new URL(ctx.url).hostname,
      author: m('meta[name="author"]') || m('meta[property="article:author"]') ||
        (doc.querySelector('[rel="author"]') && text(doc.querySelector('[rel="author"]'))) ||
        m('meta[property="og:site_name"]') || new URL(ctx.url).hostname,
      lang: (doc.documentElement.getAttribute('lang') || m('meta[http-equiv="content-language"]') || 'en').replace(/_/g, '-'),
      dir: doc.documentElement.getAttribute('dir') || doc.body.getAttribute('dir') || '',
      description: m('meta[name="description"]') || m('meta[property="og:description"]'),
      published: isNaN(pubDate) ? '' : pubDate.toISOString().slice(0, 10),
      cover: resolve(m('meta[property="og:image"]')),
      source: ctx.url,
    };
  }

  // --------------------------------------------------------- step 3: clean

  function removeUnusedElements(ctx) {
    const { body } = ctx;
    // Icons and button leftovers found on the live page.
    $$(body, '[w2e-f~="x"]').forEach((e) => e.remove());
    $$(body, '[w2e-f~="u"]').forEach(unwrap);
    // Ads around words that are really in the article: keep just the words.
    $$(body, '[w2e-f~="k"]').forEach((e) => e.replaceWith(ctx.doc.createTextNode(normSpace(e.textContent))));
    $$(body, '[data-w2e-ad]').forEach((e) => e.remove()); // anything ad-marked that is left
    // Forms often wrap a whole page (e.g. ASP.NET), so they are unwrapped, not removed.
    $$(body, 'form,label,fieldset').forEach(unwrap);
    $$(body, [
      'script', 'style', 'noscript', 'iframe', 'frame', 'frameset', 'input', 'button', 'select', 'textarea', 'legend',
      'nav', 'footer', 'aside', 'link', 'meta', 'base', 'template', 'canvas', 'object', 'embed', 'video', 'audio',
      'source', 'track', 'map', 'area', 'dialog', 'slot',
      '[role=navigation]', '[role=complementary]', '[role=contentinfo]', '[role=search]', '[role=dialog]', '[role=alertdialog]',
    ].join(',')).forEach((e) => e.remove());
    $$(body, 'header,[role=banner]').forEach((h) => { if (!h.querySelector('h1')) h.remove(); });
  }

  function removeHiddenElements(ctx) {
    $$(ctx.body, '[hidden],[aria-hidden="true"],[w2e-f~="h"]').forEach((e) => e.remove());
    $$(ctx.body, '[style]').forEach((e) => {
      const s = e.getAttribute('style').replace(/\s/g, '').toLowerCase();
      if (/display:none|visibility:hidden/.test(s)) e.remove();
    });
  }

  function removeComments(ctx) {
    const walker = ctx.doc.createTreeWalker(ctx.doc, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.remove());
  }

  function bestFromSrcset(srcset) {
    if (!srcset) return '';
    let best = '', bestScore = -1;
    for (const part of srcset.split(/,\s+/)) {
      const [url, desc = '1x'] = part.trim().split(/\s+/);
      const score = parseFloat(desc) || 1;
      if (url && score > bestScore) { best = url; bestScore = score; }
    }
    return best;
  }

  function removeImagesWithoutSource(ctx) {
    for (const img of $$(ctx.body, 'img')) {
      const live = img.getAttribute('w2e-src') || '';
      const src = [
        live.startsWith('data:') ? '' : live,
        img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), img.getAttribute('data-original'),
        bestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset')),
        img.getAttribute('src'), live,
      ].find((s) => s && s.trim());
      img.removeAttribute('w2e-src');
      img.removeAttribute('srcset');
      let resolved = '';
      try { resolved = src ? new URL(src.trim(), ctx.base).href : ''; } catch { /* bad URL */ }
      if (resolved) img.setAttribute('src', resolved);
      else img.removeAttribute('src');
      if (!resolved && !(img.getAttribute('alt') || '').trim()) img.remove();
    }
  }

  const VALID_XML_NAME = /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/;
  const CUSTOM_ATTR = /^(data-|on|aria-|ng-|_ng|v-|x-|js)/i;

  function removeCustomAttributes(ctx) {
    for (const el of $$(ctx.body, '*')) {
      for (const a of Array.from(el.attributes)) {
        if (a.name.startsWith('w2e-')) continue;
        if (CUSTOM_ATTR.test(a.name) || !VALID_XML_NAME.test(a.name)) el.removeAttribute(a.name);
      }
    }
  }

  const GLOBAL_ATTRS = new Set(['id', 'title', 'lang', 'dir']);
  const TAG_ATTRS = {
    a: ['href', 'name'], img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed'], li: ['value'], blockquote: ['cite'], q: ['cite'], time: ['datetime'],
    del: ['datetime'], ins: ['datetime'], col: ['span'], colgroup: ['span'],
  };
  const VALID_ID = /^[\p{L}_][\p{L}\p{N}_.\-·]*$/u;

  function removeUnusedAttributes(ctx) {
    for (const el of $$(ctx.body, '*')) {
      if (!isHtml(el)) { el.removeAttribute('class'); continue; } // SVG/MathML keep their presentation attributes
      const allowed = TAG_ATTRS[el.localName] || [];
      for (const a of Array.from(el.attributes)) {
        if (a.name.startsWith('w2e-') || GLOBAL_ATTRS.has(a.name) || allowed.includes(a.name)) continue;
        el.removeAttribute(a.name);
      }
      if (el.localName === 'a' && el.hasAttribute('name')) {
        if (!el.id) el.id = el.getAttribute('name');
        el.removeAttribute('name');
      }
      if (el.localName === 'img' && !el.hasAttribute('alt')) el.setAttribute('alt', '');
    }
    // XHTML needs unique, XML-valid ids. Renamed ids are remembered so links can follow them.
    const seen = new Set();
    for (const el of $$(ctx.body, '[id]')) {
      const old = el.getAttribute('id').trim();
      let id = old;
      if (!VALID_ID.test(id)) {
        id = id.replace(/[^\p{L}\p{N}_.\-]/gu, '_');
        if (!/^[\p{L}_]/u.test(id)) id = 'id-' + id;
      }
      if (!old || seen.has(id)) { el.removeAttribute('id'); continue; }
      seen.add(id);
      if (id !== old) { el.id = id; ctx.idMap.set(old, id); }
    }
  }

  function removeExtraWhitespace(ctx) {
    const walker = ctx.doc.createTreeWalker(ctx.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      // Characters that are illegal in XML would make the XHTML unreadable.
      let data = node.data.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
      const parent = node.parentElement;
      if (parent?.closest('pre,code,textarea,[w2e-f~="p"]')) {
        if (data !== node.data) node.data = data;
      } else if (parent?.closest('[w2e-f~="n"]') && /[\r\n]/.test(data)) {
        // Text shown with CSS line breaks (white-space: pre-wrap / pre-line): turn each newline into <br/>.
        const lines = data.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t\f]+/g, ' '));
        const frag = ctx.doc.createDocumentFragment();
        lines.forEach((line, k) => {
          if (k) frag.appendChild(ctx.doc.createElement('br'));
          if (line) frag.appendChild(ctx.doc.createTextNode(line));
        });
        node.replaceWith(frag);
      } else {
        data = data.replace(/[ \t\n\r\f]+/g, ' ');
        if (data !== node.data) node.data = data;
      }
    }
  }

  function removeEmptySvgs(ctx) {
    const DRAWABLE = 'path,circle,rect,line,polyline,polygon,ellipse,text,image';
    $$(ctx.body, 'svg').forEach((s) => { if (!s.querySelector(DRAWABLE)) s.remove(); });
  }

  function referencedIds(root, ctx) {
    const ids = new Set();
    for (const a of $$(root, 'a[href*="#"]')) {
      const frag = safeDecode(a.getAttribute('href').split('#')[1] || '');
      if (frag) ids.add(ctx.idMap.get(frag) || frag);
    }
    return ids;
  }

  const KEEP_EMPTY = new Set(['img', 'br', 'hr', 'td', 'th', 'col', 'wbr']);

  function removeEmpty(root, referenced) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const el of $$(root, '*').reverse()) {
        if (!isHtml(el) || KEEP_EMPTY.has(el.localName)) continue;
        if (text(el) || el.querySelector('img,svg,math,table,hr,br')) continue;
        if (el.id && referenced.has(el.id)) continue;
        el.remove();
        changed = true;
      }
    }
  }

  function removeEmptyElements(ctx) {
    removeEmpty(ctx.body, referencedIds(ctx.body, ctx));
  }

  // ------------------------------------------------------- step 4: replace

  function reduceHeadingLevel(ctx) {
    if ($$(ctx.body, 'h1').length <= 1) return;
    for (const h of $$(ctx.body, 'h1,h2,h3,h4,h5,h6')) rename(h, 'h' + Math.min(+h.localName[1] + 1, 6));
  }

  function replaceSimpleTags(ctx) {
    const MAP = { b: 'strong', i: 'em', strike: 'del', s: 'del', tt: 'code', center: 'div', font: 'span', big: 'span',
      acronym: 'abbr', listing: 'pre', xmp: 'pre', plaintext: 'pre', blink: 'span', marquee: 'div' };
    for (const [from, to] of Object.entries(MAP)) $$(ctx.body, from).forEach((e) => rename(e, to));
  }

  const KNOWN_TAGS = new Set(('a abbr address article b bdi bdo blockquote br caption cite code col colgroup dd del ' +
    'details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p pre q rp ' +
    'rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr').split(' '));

  function replaceUnknownElements(ctx) {
    for (const el of $$(ctx.body, '*')) {
      if (!isHtml(el) || KNOWN_TAGS.has(el.localName)) continue;
      // A div inside a paragraph is invalid XHTML, so unknown elements in inline context become spans.
      const inline = el.parentElement && INLINE_TAGS.has(el.parentElement.localName);
      rename(el, inline && !el.querySelector(BLOCK_SEL) ? 'span' : 'div');
    }
  }

  function replaceImagesWithoutSource(ctx) {
    for (const img of $$(ctx.body, 'img')) {
      if (img.getAttribute('src')) continue;
      const span = ctx.doc.createElement('span');
      span.textContent = img.getAttribute('alt') || '';
      img.replaceWith(span);
    }
  }

  function replaceByCssStyle(ctx) {
    const wrap = (el, tag) => {
      if (!el.querySelector(BLOCK_SEL)) return wrapChildren(el, tag);
      for (const t of Array.from(el.childNodes)) {
        if (t.nodeType === 3 && t.data.trim()) {
          const w = ctx.doc.createElement(tag);
          t.replaceWith(w);
          w.appendChild(t);
        }
      }
    };
    for (let el of $$(ctx.body, '[w2e-f]')) {
      const f = el.getAttribute('w2e-f').split(' ');
      el.removeAttribute('w2e-f');
      const next = el.nextSibling;
      const hasNext = next && !(next.nodeType === 3 && !next.data.trim() && !next.nextSibling);
      if (f.includes('d')) {
        const inBlock = el.parentElement && !INLINE_TAGS.has(el.parentElement.localName);
        if (inBlock && ['span', 'label', 'small', 'time'].includes(el.localName)) el = rename(el, 'div');
        else {
          const prev = el.previousSibling;
          if (prev && !(prev.nodeType === 3 && !prev.data.trim() && !prev.previousSibling)) el.before(ctx.doc.createElement('br'));
          if (hasNext) el.after(ctx.doc.createElement('br'));
        }
      } else if (f.includes('s') && hasNext && !(next.nodeType === 3 && /^\s/.test(next.data))) {
        el.after(ctx.doc.createTextNode(' '));
      }
      if (f.includes('g')) {
        if (el.localName !== 'div') el = rename(el, 'div');
        el.setAttribute('class', 'gallery');
      }
      if (f.includes('p')) {
        if (['div', 'p'].includes(el.localName)) el = rename(el, 'pre');
        else if (!el.closest('pre,code')) wrap(el, 'code');
      }
      if (f.includes('b') && !el.closest('strong,h1,h2,h3,h4,h5,h6,th')) {
        if (el.localName === 'span') el = rename(el, 'strong');
        else wrap(el, 'strong');
      }
      if (f.includes('i') && !el.closest('em')) {
        if (el.localName === 'span') rename(el, 'em');
        else wrap(el, 'em');
      }
    }
  }

  // --------------------------------------------------- step 5: main content

  function chooseMainContent(ctx) {
    const { body, doc } = ctx;
    let main = null;

    const semantic = $$(body, 'article,main,[w2e-main]')
      .map((el) => [el, text(el).length])
      .sort((a, b) => b[1] - a[1])[0];
    if (semantic && semantic[1] >= 200) main = semantic[0];

    if (!main) {
      // Readability-style scoring: paragraphs vote for their parent and grandparent.
      const scores = new Map();
      for (const p of $$(body, 'p,pre,blockquote,td')) {
        const t = text(p);
        if (t.length < 25) continue;
        const s = 1 + (t.split(/[,،]/).length - 1) + Math.min(Math.floor(t.length / 100), 3);
        const parent = p.parentElement, grand = parent?.parentElement;
        if (parent) scores.set(parent, (scores.get(parent) || 0) + s);
        if (grand) scores.set(grand, (scores.get(grand) || 0) + s / 2);
      }
      let bestScore = 0;
      for (const [el, s] of scores) {
        const len = text(el).length || 1;
        const linkLen = $$(el, 'a').reduce((n, a) => n + text(a).length, 0);
        const final = s * (1 - linkLen / len);
        if (final > bestScore) { bestScore = final; main = el; }
      }
    }
    main = main || body;

    // Make sure the book starts with the page title as its only h1.
    if (!main.querySelector('h1')) {
      const outsideH1 = $$(body, 'h1').find((h) => !main.contains(h));
      const title = outsideH1 ? text(outsideH1) : ctx.meta.title;
      const firstHeading = main.querySelector('h2,h3,h4,h5,h6');
      if (firstHeading && text(firstHeading) === title) rename(firstHeading, 'h1');
      else {
        const h1 = doc.createElement('h1');
        h1.textContent = title;
        main.prepend(h1);
      }
    }
    for (const el of [main, ...$$(main, '[w2e-main]')]) el.removeAttribute('w2e-main');
    ctx.main = main;
  }

  // -------------------------------------------------------- step 6: images

  const CORE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

  function sniffType(buf) {
    const b = new Uint8Array(buf.slice(0, 16));
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    const ascii = String.fromCharCode(...b);
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
    if (ascii.slice(4, 8) === 'ftyp') return 'image/avif';
    if (/<svg|<\?xml/i.test(new TextDecoder().decode(buf.slice(0, 512)))) return 'image/svg+xml';
    return null;
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 30000,
      onload: (r) => (r.status >= 200 && r.status < 300
        ? resolve({ data: r.response, type: (/content-type:\s*([^\r\n;]+)/i.exec(r.responseHeaders) || [])[1] })
        : reject(new Error('HTTP ' + r.status))),
      onerror: reject, ontimeout: reject,
    }));
  }

  async function fetchBinary(url, ctx) {
    if (ctx.fetchBinary && !url.startsWith('data:')) return ctx.fetchBinary(url);
    const hasGM = typeof GM_xmlhttpRequest === 'function';
    const sameOrigin = url.startsWith('data:') || new URL(url).origin === new URL(ctx.url).origin;
    if (!sameOrigin && hasGM) return gmFetch(url);
    try {
      // Cross-origin: skip the HTTP cache. The page's <img> tags cached the file without CORS headers,
      // and reusing that copy makes a CORS fetch fail even when the server allows it.
      const r = await fetch(url, sameOrigin
        ? { credentials: 'include' }
        : { credentials: 'omit', mode: 'cors', cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { data: await r.arrayBuffer(), type: r.headers.get('content-type') };
    } catch (e) {
      if (hasGM) return gmFetch(url);
      throw e;
    }
  }

  // Re-encodes an image through a canvas. Used for formats readers can't show and to shrink large photos.
  async function reencode(data, type, maxDim = Infinity) {
    const bmp = await createImageBitmap(new Blob([data], { type }));
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const outType = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((r) => canvas.toBlob(r, outType, 0.85));
    return { data: await blob.arrayBuffer(), type: outType, shrunk: scale < 1 };
  }

  async function loadImage(url, ctx, name, maxDim) {
    const { data, type: header } = await fetchBinary(url, ctx);
    let type = sniffType(data) || (header || '').split(';')[0].trim();
    let bytes = data;
    if (!CORE_TYPES[type]) {
      if (!type.startsWith('image/')) throw new Error('not an image: ' + type);
      ({ data: bytes, type } = await reencode(data, type)); // webp/avif/etc. are not readable everywhere
    } else if (maxDim && type !== 'image/svg+xml') {
      const small = await reencode(data, type, maxDim);
      if (small.shrunk) ({ data: bytes, type } = small);
    }
    const image = { path: `images/${name}.${CORE_TYPES[type]}`, type, data: bytes };
    ctx.images.push(image);
    return image;
  }

  // Where to get a bigger copy of a gallery thumbnail. A link around the image wins; otherwise these
  // URL rewrites apply (add rules for other sites' CDNs here).
  const FULL_SIZE_RULES = [
    // sipurderech.co.il: thumbnails are /512x512_fill_80/<file>, the lightbox uses /2400x2400_fit_90/<file>
    [/^(https:\/\/cdn\d*\.sipurderech\.co\.il\/)\d+x\d+_fill_\d+\//, '$12400x2400_fit_90/'],
  ];
  const FULL_SIZE_MAX = 1600;

  function fullSizeUrl(img, src, base) {
    const link = img.closest('a[href]')?.getAttribute('href');
    if (link && /\.(jpe?g|png|gif|webp|avif|heic)(\?|#|$)/i.test(link)) {
      try { return new URL(link, base).href; } catch { /* fall through */ }
    }
    for (const [re, to] of FULL_SIZE_RULES) if (re.test(src)) return src.replace(re, to);
    return src;
  }

  async function loadImages(ctx) {
    const byUrl = new Map();
    let n = 0;
    const load = (url, prefix, maxDim) => {
      const key = url + '|' + (maxDim || '');
      if (!byUrl.has(key)) byUrl.set(key, loadImage(url, ctx, prefix + ++n, maxDim).catch((e) => {
        console.warn('[web2epub] image failed', url, e);
        return null;
      }));
      return byUrl.get(key);
    };
    const imgs = $$(ctx.main, 'img');
    // Number image pages in document order up front; downloads finish in any order.
    const pageNo = new Map(imgs.filter((img) => img.closest('.gallery')).map((img, i) => [img, i + 1]));
    const pages = [];
    await pool(imgs, 6, async (img) => {
      const src = img.getAttribute('src');
      const image = await load(src, 'img-');
      if (!image) {
        const alt = img.getAttribute('alt') || '';
        if (alt) { const span = ctx.doc.createElement('span'); span.textContent = alt; img.replaceWith(span); }
        else img.remove();
        return;
      }
      img.setAttribute('src', image.path);
      if (!img.closest('.gallery')) return;

      // Gallery thumbnail: link it to its own full-screen page with the bigger copy.
      const fullUrl = fullSizeUrl(img, src, ctx.base);
      const full = (fullUrl !== src && await load(fullUrl, 'full-', ctx.fullSizeMax)) || image;
      const k = pageNo.get(img);
      const page = { image: full, alt: img.getAttribute('alt') || '', id: `w2e-img-${k}`, file: `image-${k}.xhtml` };
      pages[k] = page;
      const outer = img.closest('a[href]');
      if (outer) unwrap(outer); // links can't nest; the image page replaces the original link
      const a = ctx.doc.createElement('a');
      a.setAttribute('href', page.file);
      a.setAttribute('w2e-local', '');
      a.id = page.id;
      img.replaceWith(a);
      a.appendChild(img);
    });
    ctx.imagePages = pages.filter(Boolean);
    if (ctx.meta.cover) {
      ctx.cover = await loadImage(ctx.meta.cover, ctx, 'cover').catch(() => null);
    }
  }

  // --------------------------------------------------------- step 7: split

  function splitByHeadings(ctx) {
    const { main, doc } = ctx;
    const referenced = referencedIds(main, ctx);
    const sub = [2, 3, 4, 5, 6].find((l) => main.querySelector('h' + l));
    const heads = $$(main, sub ? `h1,h${sub}` : 'h1');
    const parts = [];
    const range = doc.createRange();
    for (let i = heads.length - 1; i >= 0; i--) {
      range.setStartBefore(heads[i]);
      range.setEnd(main, main.childNodes.length);
      parts.unshift({ title: text(heads[i]), frag: range.extractContents() });
    }
    const rest = doc.createDocumentFragment();
    while (main.firstChild) rest.appendChild(main.firstChild);
    parts.unshift({ title: ctx.meta.title, frag: rest });

    ctx.chapters = parts.map((p) => {
      const el = doc.createElement('div');
      el.appendChild(p.frag);
      removeEmpty(el, referenced); // wrappers left behind by the split
      return { title: p.title || ctx.meta.title, el };
    }).filter((c) => text(c.el) || c.el.querySelector('img,svg,table'));

    if (!ctx.chapters.length) {
      const el = doc.createElement('div');
      el.innerHTML = '<h1></h1>';
      el.firstChild.textContent = ctx.meta.title;
      ctx.chapters = [{ title: ctx.meta.title, el }];
    }
    ctx.chapters.forEach((c, i) => { c.file = `chapter-${i + 1}.xhtml`; });
  }

  // ----------------------------------------------------- step 8: fix links

  const allLinks = (ctx) => ctx.chapters.flatMap((c) => $$(c.el, 'a[href]:not([w2e-local])'));

  function mapIdsToChapters(ctx) {
    ctx.chapterOf = new Map();
    ctx.chapters.forEach((c, i) => {
      for (const el of $$(c.el, '[id]')) if (!ctx.chapterOf.has(el.id)) ctx.chapterOf.set(el.id, i);
    });
  }

  function resolveOriginUrls(ctx) {
    for (const a of allLinks(ctx)) {
      try { a.setAttribute('href', new URL(a.getAttribute('href'), ctx.base).href); }
      catch { unwrap(a); }
    }
  }

  function replaceUrlLinks(ctx) {
    ctx.internal = new Set();
    ctx.broken = new Set();
    const page = ctx.url.split('#')[0];
    for (const a of allLinks(ctx)) {
      const url = new URL(a.getAttribute('href'));
      if (url.protocol === 'javascript:') { ctx.broken.add(a); continue; }
      if (url.href.split('#')[0] !== page) continue;
      const frag = safeDecode(url.hash.slice(1));
      const id = ctx.idMap.get(frag) || frag;
      if (frag && ctx.chapterOf.has(id)) {
        a.setAttribute('href', `${ctx.chapters[ctx.chapterOf.get(id)].file}#${encodeURIComponent(id)}`);
        ctx.internal.add(a);
      } else {
        ctx.broken.add(a);
      }
    }
  }

  function externalLinksNewTab(ctx) {
    for (const a of allLinks(ctx)) {
      if (ctx.internal.has(a) || ctx.broken.has(a)) continue;
      if (/^https?:/i.test(a.getAttribute('href'))) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  function removeBrokenAnchors(ctx) {
    ctx.broken.forEach(unwrap);
  }

  // ------------------------------------------------- step 9: chapters to XHTML

  function htmlRoot(ctx) {
    if (ctx.rtl) return '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="he" lang="he" dir="rtl">';
    const lang = escXml(ctx.meta.lang);
    const dir = ctx.meta.dir ? ` dir="${escXml(ctx.meta.dir)}"` : '';
    return `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"${dir}>`;
  }

  function xhtmlPage(ctx, title, body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
${htmlRoot(ctx)}
<head>
<meta charset="UTF-8"/>
<title>${escXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`;
  }

  function convertToXhtml(ctx) {
    const ser = new XMLSerializer();
    for (const c of ctx.chapters) {
      for (const el of $$(c.el, '*')) for (const a of Array.from(el.attributes)) if (a.name.startsWith('w2e-')) el.removeAttribute(a.name);
      const body = Array.from(c.el.childNodes).map((n) => ser.serializeToString(n)).join('')
        .replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
      c.xhtml = xhtmlPage(ctx, c.title, body);
    }
    const tocTitle = ctx.rtl ? 'תוכן העניינים' : 'Contents';
    const items = ctx.chapters.map((c) => `<li><a href="${c.file}">${escXml(c.title)}</a></li>`).join('\n');
    const back = ctx.rtl ? 'חזרה לטקסט' : 'Back to text';
    for (const pg of ctx.imagePages) {
      const k = ctx.chapterOf.get(pg.id);
      const href = k === undefined ? '' : `${ctx.chapters[k].file}#${pg.id}`;
      const img = `<img src="${pg.image.path}" alt="${escXml(pg.alt)}"/>`;
      pg.xhtml = xhtmlPage(ctx, pg.alt || ctx.meta.title, `<div class="image-page">
${href ? `<a href="${href}">${img}</a>` : img}
${pg.alt ? `<p>${escXml(pg.alt)}</p>\n` : ''}${href ? `<p><a href="${href}">${back}</a></p>` : ''}
</div>`);
    }
    ctx.nav = xhtmlPage(ctx, tocTitle, `<nav epub:type="toc" id="toc">\n<h1>${escXml(tocTitle)}</h1>\n<ol>\n${items}\n</ol>\n</nav>`);
  }

  // ------------------------------------------------------- step 10: EPUB

  async function ensureJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSZIP_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load JSZip (blocked by the page\'s CSP?). Use the userscript version.'));
      document.head.appendChild(s);
    });
    return window.JSZip;
  }

  async function createEpub(ctx) {
    const Zip = await ensureJSZip();
    const { meta } = ctx;
    const uid = 'urn:uuid:' + crypto.randomUUID();
    const lang = ctx.rtl ? 'he' : meta.lang;
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      '<item id="css" href="style.css" media-type="text/css"/>',
      ...ctx.chapters.map((c, i) => `<item id="ch${i + 1}" href="${c.file}" media-type="application/xhtml+xml"${/<svg[\s>]/.test(c.xhtml) ? ' properties="svg"' : ''}/>`),
      ...ctx.imagePages.map((pg, i) => `<item id="ip${i + 1}" href="${pg.file}" media-type="application/xhtml+xml"/>`),
      ...ctx.images.map((img, i) => `<item id="img${i + 1}" href="${img.path}" media-type="${img.type}"${img === ctx.cover ? ' properties="cover-image"' : ''}/>`),
    ];
    const coverId = ctx.cover ? `img${ctx.images.indexOf(ctx.cover) + 1}` : '';
    const spineAttr = ctx.rtl ? ' page-progression-direction="rtl"' : '';

    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escXml(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${escXml(meta.title)}</dc:title>
<dc:language>${escXml(lang)}</dc:language>
<dc:creator>${escXml(meta.author)}</dc:creator>
<dc:source>${escXml(meta.source)}</dc:source>
${meta.description ? `<dc:description>${escXml(meta.description)}</dc:description>\n` : ''}${meta.published ? `<dc:date>${meta.published}</dc:date>\n` : ''}<meta property="dcterms:modified">${modified}</meta>
${coverId ? `<meta name="cover" content="${coverId}"/>\n` : ''}</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx"${spineAttr}>
${ctx.chapters.map((c, i) => `<itemref idref="ch${i + 1}"/>`).join('\n')}
${ctx.imagePages.map((pg, i) => `<itemref idref="ip${i + 1}" linear="no"/>`).join('\n')}
</spine>
</package>
`;

    const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escXml(lang)}">
<head><meta name="dtb:uid" content="${uid}"/><meta name="dtb:depth" content="1"/></head>
<docTitle><text>${escXml(meta.title)}</text></docTitle>
<navMap>
${ctx.chapters.map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escXml(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`;

    const zip = new Zip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); // must be first and uncompressed
    zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`);
    zip.file('OEBPS/content.opf', opf);
    zip.file('OEBPS/toc.ncx', ncx);
    zip.file('OEBPS/nav.xhtml', ctx.nav);
    zip.file('OEBPS/style.css', (ctx.rtl ? RTL_CSS : LTR_CSS) + IMAGE_CSS);
    for (const c of ctx.chapters) zip.file('OEBPS/' + c.file, c.xhtml);
    for (const pg of ctx.imagePages) zip.file('OEBPS/' + pg.file, pg.xhtml);
    for (const img of ctx.images) zip.file('OEBPS/' + img.path, img.data);

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
    ctx.fileSize = blob.size;
    if (window.__w2eDebug) window.__w2eLastBlob = blob;

    const name = (meta.title.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'page') + '.epub';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    ctx.fileName = name;
  }

  // -------------------------------------------------------------- pipeline

  const STEPS = [
    { name: 'Converting downloaded text to DOM', fn: textToDom },
    { name: 'Retrieving metadata from HTML document', fn: retrieveMetadata },
    { group: 'Cleaning HTML document' },
    { group: 'HTML document step', level: 1 },
    { name: 'Removing unused HTML elements', fn: removeUnusedElements, level: 2 },
    { name: 'Removing HTML hidden elements', fn: removeHiddenElements, level: 2 },
    { name: 'Removing all HTML comments', fn: removeComments, level: 2 },
    { name: 'Removing images without source', fn: removeImagesWithoutSource, level: 2 },
    { name: 'Removing custom attributes', fn: removeCustomAttributes, level: 2 },
    { name: 'Removing unused element attributes', fn: removeUnusedAttributes, level: 2 },
    { name: 'Removing extra whitespaces', fn: removeExtraWhitespace, level: 2 },
    { name: 'Remove empty SVGs', fn: removeEmptySvgs, level: 2 },
    { name: 'Removing empty HTML elements', fn: removeEmptyElements, level: 2 },
    { group: 'Replace HTML elements' },
    { group: 'HTML document step', level: 1 },
    { name: 'Reducing the heading level', fn: reduceHeadingLevel, level: 2 },
    { name: 'Replace simple elements tag', fn: replaceSimpleTags, level: 2 },
    { name: 'Replacing unknown HTML elements with div', fn: replaceUnknownElements, level: 2 },
    { name: 'Replacing images without source by their alt text', fn: replaceImagesWithoutSource, level: 2 },
    { name: 'Replace elements by others with CSS style', fn: replaceByCssStyle, level: 2 },
    { name: 'Choosing the main content from HTML document', fn: chooseMainContent },
    { name: 'Loading images', fn: loadImages },
    { name: 'Splitting the main content from HTML document by headings', fn: splitByHeadings },
    { group: 'Fix links' },
    { name: 'Split elements step', fn: mapIdsToChapters, level: 1 },
    { name: 'Origin URL step', fn: resolveOriginUrls, level: 1 },
    { name: 'Replace URL links', fn: replaceUrlLinks, level: 2 },
    { name: 'Set external links to open in a new tab', fn: externalLinksNewTab, level: 2 },
    { name: 'Remove broken anchor links', fn: removeBrokenAnchors, level: 2 },
    { name: 'Convert split content in HTML content', fn: convertToXhtml },
    { name: 'Creating an EPUB file', fn: createEpub },
  ];

  // win / url / originalHtml / fetchBinary let the HTML page version convert a page rendered in a hidden frame.
  async function run({ rtl, onLog = () => {}, onProgress = () => {}, win = window, url = location.href, originalHtml, fetchBinary,
    fullSizeMax = FULL_SIZE_MAX }) {
    const ctx = { rtl, win, url, originalHtml, fetchBinary, fullSizeMax, idMap: new Map(), images: [], imagePages: [] };
    const total = STEPS.filter((s) => s.fn).length;
    let done = 0;
    for (const step of STEPS) {
      const label = '  '.repeat(step.level || 0) + (step.name || step.group);
      onLog(label);
      console.log('[web2epub]', label);
      if (!step.fn) continue;
      await step.fn(ctx);
      onProgress((++done / total) * 100);
    }
    return ctx;
  }

  // -------------------------------------------------------------------- UI

  function pageLooksRtl() {
    const lang = (document.documentElement.lang || '').toLowerCase();
    return lang.startsWith('he') || lang.startsWith('iw') ||
      document.documentElement.dir === 'rtl' || document.body.dir === 'rtl' ||
      getComputedStyle(document.body).direction === 'rtl';
  }

  function buildUi() {
    if (document.getElementById(UI_ID)) return;
    const host = document.createElement('div');
    host.id = UI_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:16px;right:16px;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  :host { font: 13px/1.4 system-ui, sans-serif; color: #1a1a1a; }
  .fab, .go { cursor: pointer; border: 0; border-radius: 8px; font: inherit; }
  .fab { padding: 8px 12px; background: #1f6feb; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
  .panel { position: absolute; bottom: 44px; right: 0; width: min(340px, calc(100vw - 32px)); background: #fff;
           border: 1px solid #d0d7de; border-radius: 10px; padding: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.2); }
  .panel[hidden] { display: none; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .go { padding: 6px 12px; background: #2da44e; color: #fff; }
  .go:disabled { opacity: .6; cursor: default; }
  pre { margin: 10px 0 0; max-height: 280px; overflow: auto; font: 11px/1.45 ui-monospace, monospace;
        background: #f6f8fa; padding: 8px; border-radius: 6px; white-space: pre-wrap; }
  .pct { margin-top: 8px; font: 12px ui-monospace, monospace; }
  .err { color: #cf222e; }
</style>
<button class="fab" type="button">📖 EPUB</button>
<div class="panel" hidden>
  <div class="row">
    <label><input type="checkbox" class="rtl"> Hebrew (RTL)</label>
    <button class="go" type="button">Create EPUB</button>
  </div>
  <pre class="log"></pre>
  <div class="pct"></div>
</div>`;
    const $ = (s) => root.querySelector(s);
    const panel = $('.panel'), log = $('.log'), pct = $('.pct'), go = $('.go'), rtlBox = $('.rtl');
    rtlBox.checked = pageLooksRtl();
    $('.fab').addEventListener('click', () => { panel.hidden = !panel.hidden; });
    go.addEventListener('click', async () => {
      go.disabled = true;
      log.textContent = '';
      pct.textContent = 'progression: 0.00 %';
      try {
        const ctx = await run({
          rtl: rtlBox.checked,
          onLog: (l) => { log.textContent += l + '\n'; log.scrollTop = log.scrollHeight; },
          onProgress: (p) => { pct.textContent = `progression: ${p.toFixed(2)} %`; },
        });
        log.textContent += `\nSaved "${ctx.fileName}" (${ctx.chapters.length} chapters, ${ctx.images.length} images)`;
      } catch (e) {
        console.error('[web2epub]', e);
        pct.innerHTML = '';
        const span = document.createElement('span');
        span.className = 'err';
        span.textContent = 'Error: ' + e.message;
        pct.appendChild(span);
      } finally {
        go.disabled = false;
      }
    });
    document.documentElement.appendChild(host);
  }

  window.web2epub = { run };
  if (!window.__w2eNoUi) buildUi();
})();
