// dom.js — крихітні DOM-хелпери, спільні для всіх модулів UI.
//   h(tag, props, ...children) — створення елемента без innerHTML (без XSS);
//   escapeHtml(s)              — екранування для рідкісних HTML-рядків;
//   $(id), clear(el)           — дрібниці;
//   copyText(text)             — у буфер обміну (Clipboard API або запасний textarea) → Promise<bool>.
// Під час імпорту DOM не чіпається (модуль можна імпортувати в node:test).

// props: { class, text, dataset:{}, on:{click: fn}, style:{}, aria-*/title/type/…: значення }.
// Булеві атрибути: true → присутній, false/null/undefined → відсутній.
// children: рядки, вузли, масиви (вкладені), null/false ігноруються.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v; // value, checked, disabled…
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (id) => document.getElementById(id);

export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

// Копіювання в буфер: Clipboard API (потрібен secure context — localhost підходить),
// інакше — тимчасовий <textarea> + execCommand('copy').
export async function copyText(text) {
  const s = String(text == null ? '' : text);
  try {
    if (globalThis.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_e) { /* падаємо на запасний шлях */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (_e) { return false; }
}
