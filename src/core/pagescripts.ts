/**
 * Code that runs INSIDE the page. Kept as plain strings on purpose: bundlers and transpilers
 * (esbuild keepNames, eve's build, tsx) rewrite named functions with helpers such as `__name`
 * that do not exist in the page, which breaks Playwright's function serialisation.
 * Strings are never transformed. Keep these free of backticks and `${}`.
 */

/** Evaluated as an expression; returns { els, headings, mutations }. */
export const COLLECT_SCRIPT = String.raw`(() => {
  var MAX = 150;
  function norm(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }
  function visible(e) {
    var s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden' && e.getClientRects().length > 0;
  }
  function roleOf(e) {
    var explicit = e.getAttribute('role');
    if (explicit) return explicit;
    var tag = e.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = e.type;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].indexOf(t) >= 0) return 'button';
      return 'textbox';
    }
    return 'generic';
  }
  function nameOf(e) {
    var aria = e.getAttribute('aria-label');
    if (aria) return norm(aria);
    var lb = e.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
      if (norm(t)) return norm(t);
    }
    if (e.labels && e.labels.length) return norm(Array.prototype.map.call(e.labels, function (l) { return l.textContent; }).join(' '));
    var tag = e.tagName.toLowerCase();
    if (tag === 'input') {
      if (['submit', 'button', 'reset'].indexOf(e.type) >= 0) return norm(e.value);
      if (e.placeholder) return norm(e.placeholder);
    }
    var txt = norm(e.innerText || e.textContent);
    if (txt) return txt;
    return norm(e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') || e.placeholder);
  }
  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function unique(sel, el) {
    try { var m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch (err) { return false; }
  }
  function selectorOf(el) {
    var attrs = ['data-testid', 'data-test', 'data-qa'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) { var s1 = '[' + attrs[i] + '="' + v.replace(/"/g, '\\"') + '"]'; if (unique(s1, el)) return s1; }
    }
    if (el.id) { var s2 = '#' + esc(el.id); if (unique(s2, el)) return s2; }
    var nm = el.getAttribute('name');
    if (nm) { var s3 = el.tagName.toLowerCase() + '[name="' + nm.replace(/"/g, '\\"') + '"]'; if (unique(s3, el)) return s3; }
    var path = [];
    var cur = el;
    while (cur && cur !== document.documentElement) {
      var tag = cur.tagName.toLowerCase();
      if (cur.id) { path.unshift('#' + esc(cur.id)); break; }
      var parent = cur.parentElement;
      if (!parent) { path.unshift(tag); break; }
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
      path.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
      cur = parent;
    }
    return path.join(' > ');
  }

  var nodes = Array.prototype.slice.call(document.querySelectorAll(
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[contenteditable=true]'
  )).filter(visible).slice(0, MAX);

  var els = nodes.map(function (el) {
    var tag = el.tagName.toLowerCase();
    var role = roleOf(el);
    var name = nameOf(el).slice(0, 80);
    var form = el.form;
    var isSubmit = (tag === 'button' && el.type !== 'button') || (tag === 'input' && ['submit', 'image'].indexOf(el.type) >= 0);
    var raw = {
      selector: selectorOf(el),
      fingerprint: tag + '|' + role + '|' + name,
      role: role,
      name: name,
      tag: tag,
      type: tag === 'input' ? el.type : undefined,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      inputName: el.getAttribute('name') || undefined,
      href: tag === 'a' ? (el.getAttribute('href') || undefined) : undefined,
      formAction: (isSubmit && form) ? ((form.method || 'get').toUpperCase() + ' ' + (form.getAttribute('action') || '')).trim() : undefined,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      required: el.required === true
    };
    if (tag === 'input' && el.type === 'password') raw.hasPassword = el.value.length > 0;
    else if (tag === 'input' && ['checkbox', 'radio', 'submit', 'button', 'reset'].indexOf(el.type) < 0) raw.value = el.value.slice(0, 40);
    else if (tag === 'textarea') raw.value = el.value.slice(0, 40);
    else if (tag === 'select') raw.value = el.selectedOptions[0] ? el.selectedOptions[0].text.slice(0, 40) : undefined;
    if (tag === 'input' && ['checkbox', 'radio'].indexOf(el.type) >= 0) raw.checked = el.checked;
    return raw;
  });

  var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'))
    .filter(visible)
    .map(function (h) { return norm(h.innerText).slice(0, 60); })
    .filter(Boolean)
    .slice(0, 6);

  return { els: els, headings: headings, mutations: window.__guMut || 0 };
})()`;

/** Visible alert/status/toast text. Evaluated as an expression. */
export const LIVE_MESSAGES_SCRIPT = String.raw`(() => {
  function vis(e) {
    var s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden' && e.getClientRects().length > 0;
  }
  return Array.prototype.slice.call(document.querySelectorAll(
    '[role=alert],[role=status],[aria-live]:not([aria-live=off]),.toast,.alert,.flash,.notification,.banner'
  )).filter(vis)
    .map(function (e) { return (e.innerText || '').trim().replace(/\s+/g, ' '); })
    .filter(Boolean)
    .slice(0, 3);
})()`;

/** Function expression: (node) => { tag, name }. Used to detect stale refs. */
export const FINGERPRINT_FN = String.raw`(e) => {
  function norm(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }
  var tag = e.tagName.toLowerCase();
  var aria = e.getAttribute('aria-label');
  var name = aria ? norm(aria) : ((e.labels && e.labels.length) ? norm(Array.prototype.map.call(e.labels, function (l) { return l.textContent; }).join(' ')) : '');
  if (!name && tag === 'input' && ['submit', 'button', 'reset'].indexOf(e.type) >= 0) name = norm(e.value);
  if (!name && tag === 'input' && e.placeholder) name = norm(e.placeholder);
  if (!name) name = norm(e.innerText || e.textContent) || norm(e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') || e.placeholder);
  return { tag: tag, name: name.slice(0, 80) };
}`;

/** Count matches for a selector and fingerprint the single match. Selector is JSON-embedded. */
export function resolveScript(selector: string): string {
  return "(() => { try { var els = document.querySelectorAll(" + JSON.stringify(selector) + "); if (els.length !== 1) return { count: els.length }; var f = (" + FINGERPRINT_FN + ")(els[0]); return { count: 1, tag: f.tag, name: f.name }; } catch (err) { return { count: -1 }; } })()";
}

export const MUTATION_COUNT_SCRIPT = "window.__guMut || 0";
