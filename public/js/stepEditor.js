// stepEditor.js — рядки кроків (під-дій) і вбудований редактор кроку (без prompt()).
// ЧИСТІ частини (тестуються в node:test, без DOM):
//   healthChip(step)            — чип «здоровʼя» цілі: 🎯 семантичний / ⚠ слабкий / 📍 координати;
//   countLevel(n)               — колір лічильника збігів ×n: ok (1) / warn (>1) / bad (0) / unknown;
//   candidateOptions(step)      — варіанти локатора для дропдауна (specToString + ×n) і «📍 лише координати»;
//   editorValues(step)          — початкові значення полів редактора (legacy random → шаблон {d}/{l});
//   applyEdit(step, values)     — {step: нова копія, errors}; legacy-текст після зміни стає шаблоном v2;
//   insertToken(value, s, e, t) — вставка {d}/{l} у позицію курсора;
//   groupRows(subs, showMoves)  — рядки списку: legacy-рухи згортаються в «+N рухів»;
//   moveStep(subs, si, dir, {hideMoves}) — перестановка ↑↓ (через приховані рухи — до видимого сусіда);
//   pluralUk(n, forms)          — 1 рух / 2 рухи / 5 рухів.
// DOM: buildEditor(step, {onSave, onCancel}) → <form> редактора (створюється лише під час виклику).
import { $, h } from './dom.js';
import { healthOf, escapeTemplate, templatePreview, TRANSIENT_FIELDS, MAX_DELAY_AFTER, normalizeStep } from '../../lib/steps.js';
import { specToString } from '../../lib/locators.js';

export function pluralUk(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const HEALTH = {
  semantic: { icon: '🎯', cls: 'h-ok', label: 'Надійна ціль: унікальний семантичний локатор' },
  weak: { icon: '⚠', cls: 'h-weak', label: 'Слабка ціль: CSS/nth, кілька збігів або без цілі' },
  coords: { icon: '📍', cls: 'h-coords', label: 'Лише координати — чутливо до зсуву верстки' },
};
export function healthChip(step) {
  const k = healthOf(step);
  if (!k) return null;
  const base = HEALTH[k];
  if (k === 'weak' && step && !step.target && (step.type === 'text' || step.type === 'file')) {
    return { ...base, label: step.type === 'text' ? 'Без цілі: друк у поле, що має фокус' : 'Без цілі: файл у n-те поле файлу на сторінці' };
  }
  return { kind: k, ...base };
}

export function countLevel(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'unknown';
  n = Number(n);
  return n === 1 ? 'ok' : n > 1 ? 'warn' : 'bad';
}

const hasXY = (s) => !!s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y)) && s.x !== null && s.y !== null;

// [{value: '0'…'-1', text, level}] для <select>; [] — якщо в кроку немає цілі.
// Ціль кроку в нормалізованому вигляді — з мігрованими кандидатами (напр. input[type=file]
// для старих кроків «Файл»), щоб їх можна було вибрати в редакторі. id не генеруємо.
export function editTarget(step) {
  if (!step || !step.target) return null;
  const n = normalizeStep({ ...step, id: step.id != null && step.id !== '' ? step.id : '_' });
  return n ? n.target : null;
}

export function candidateOptions(step) {
  const t = editTarget(step);
  if (!t || !Array.isArray(t.locs)) return [];
  const out = t.locs.map((l, i) => ({
    value: String(i),
    text: specToString(l) + (l.n != null ? ' ×' + l.n : ''),
    level: countLevel(l.n),
  }));
  if (hasXY(step)) out.push({ value: '-1', text: '📍 лише координати', level: 'unknown' });
  return out;
}

// Шаблон тексту legacy-кроку (старий перемикач random → {d}/{l}; буквальний «{» → «{{»).
function legacyTemplate(step) {
  if (step.random === 'digit') return '{d}';
  if (step.random === 'letter') return '{l}';
  return escapeTemplate(step.text == null ? '' : step.text);
}
const isLegacyText = (s) => s && s.type === 'text' && s.v == null;

export function editorValues(step) {
  const s = step || {};
  const t = editTarget(s);
  return {
    type: s.type,
    pick: t ? String(Number.isInteger(t.pick) ? t.pick : 0) : null,
    text: s.type === 'text' ? (isLegacyText(s) ? legacyTemplate(s) : String(s.text == null ? '' : s.text)) : null,
    legacyRandom: isLegacyText(s) && (s.random === 'digit' || s.random === 'letter') ? s.random : null,
    key: s.type === 'key' ? String(s.key || '') : null,
    waitResponse: !!s.waitResponse,
    optional: !!s.optional,
    timeout: s.timeout != null ? String(s.timeout) : '',
    delayAfter: s.delayAfter != null && s.delayAfter !== 0 ? String(s.delayAfter) : '',
    x: hasXY(s) ? String(s.x) : null,
    y: hasXY(s) ? String(s.y) : null,
    showTimeout: !!t,
    showCoords: hasXY(s) && (s.type === 'click' || s.type === 'move'),
  };
}

const intIn = (v, min, max) => {
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= min && n <= max ? n : null;
};

// values — як від editorValues (рядки/булеві). Невідомі/відсутні поля не чіпаємо.
// Повертає {step, errors}; errors непорожній → step === null.
export function applyEdit(step, values) {
  const errors = {};
  const v = values || {};
  const next = { ...step };
  for (const k of TRANSIENT_FIELDS) delete next[k];

  if (next.target && v.pick != null) {
    next.target = editTarget(step) || next.target; // індекси — як у списку кандидатів редактора
    const p = Number(v.pick);
    const n = (next.target.locs || []).length;
    if (!Number.isInteger(p) || p < -1 || p >= n || (p === -1 && !hasXY(next))) errors.pick = 'Невідомий варіант цілі';
    else next.target = { ...next.target, pick: p };
  }
  if (next.type === 'text' && v.text != null) {
    const txt = String(v.text);
    if (isLegacyText(step)) {
      // Не змінено — лишаємо legacy (щоб злиття посимвольного тексту працювало як раніше).
      if (txt !== legacyTemplate(step)) { next.v = 2; next.text = txt; delete next.random; }
    } else next.text = txt;
  }
  if (next.type === 'key' && v.key != null) {
    const k = String(v.key).trim();
    if (!k) errors.key = 'Вкажи клавішу (Enter, Tab, ArrowDown…)';
    else next.key = k;
  }
  if (v.waitResponse != null) {
    if (next.type === 'click' && v.waitResponse) next.waitResponse = true; else delete next.waitResponse;
  }
  if (v.optional != null) { if (v.optional) next.optional = true; else delete next.optional; }
  if (v.timeout != null) {
    const s = String(v.timeout).trim();
    if (!s) delete next.timeout;
    else {
      const n = intIn(s, 500, 120000);
      if (n == null) errors.timeout = 'Таймаут — ціле число мс від 500 до 120000';
      else next.timeout = n;
    }
  }
  if (v.delayAfter != null) {
    const s = String(v.delayAfter).trim();
    if (!s || s === '0') delete next.delayAfter;
    else {
      const n = intIn(s, 0, MAX_DELAY_AFTER);
      if (n == null) errors.delayAfter = 'Пауза — ціле число мс від 0 до ' + MAX_DELAY_AFTER;
      else if (n === 0) delete next.delayAfter;
      else next.delayAfter = n;
    }
  }
  if (v.x != null || v.y != null) {
    const x = intIn(v.x, 0, 1e6), y = intIn(v.y, 0, 1e6);
    if (x == null || y == null) errors.coords = 'Координати — цілі числа ≥ 0';
    else { next.x = x; next.y = y; }
  }
  return Object.keys(errors).length ? { step: null, errors } : { step: next, errors };
}

export function insertToken(value, start, end, token) {
  const s = String(value == null ? '' : value);
  const a = Math.max(0, Math.min(s.length, start == null ? s.length : start));
  const b = Math.max(a, Math.min(s.length, end == null ? a : end));
  return { value: s.slice(0, a) + token + s.slice(b), caret: a + token.length };
}

// Рядки списку кроків Дії. showMoves=false → кожна серія послідовних рухів —
// один рядок {kind:'moves', sis, count}. Інакше — усі кроки окремо.
export function groupRows(subs, showMoves) {
  const rows = [];
  let group = null;
  (subs || []).forEach((a, si) => {
    const isMove = a && a.type === 'move';
    if (isMove && !showMoves) {
      if (!group) { group = { kind: 'moves', sis: [] }; rows.push(group); }
      group.sis.push(si);
      return;
    }
    group = null;
    rows.push({ kind: 'step', si });
  });
  for (const r of rows) if (r.kind === 'moves') r.count = r.sis.length;
  return rows;
}

// Перестановка кроку на одну позицію серед ВИДИМИХ (при hideMoves рухи перескакуються).
// Мутує subs. Повертає новий індекс або -1 (нікуди рухати).
export function moveStep(subs, si, dir, { hideMoves = false } = {}) {
  if (!Array.isArray(subs) || si < 0 || si >= subs.length || (dir !== -1 && dir !== 1)) return -1;
  const visible = (a) => !(hideMoves && a && a.type === 'move');
  let j = si + dir;
  while (j >= 0 && j < subs.length && !visible(subs[j])) j += dir;
  if (j < 0 || j >= subs.length) return -1;
  const [el] = subs.splice(si, 1);
  subs.splice(j, 0, el);
  return j;
}

// ---------- DOM: редактор ----------
let seq = 0;

// opts: {onSave(nextStep), onCancel()}. Повертає <form class="step-editor">.
export function buildEditor(step, { onSave, onCancel, modal = false } = {}) {
  const id = 'se' + (++seq);
  const v0 = editorValues(step);
  const errEl = h('div', { class: 'se-err', id: id + '_err', role: 'alert' });
  const parts = [];
  const ctl = {};

  // Ціль: дропдаун кандидатів з ×n і кольоровим чипом обраного.
  const opts = candidateOptions(step);
  if (opts.length) {
    const sel = h('select', { id: id + '_pick', 'aria-describedby': id + '_pickhint' },
      opts.map((o) => h('option', { value: o.value, text: o.text, 'data-level': o.level })));
    sel.value = v0.pick;
    const chip = h('span', { class: 'se-count', 'aria-hidden': 'true' });
    const syncChip = () => {
      const o = opts.find((x) => x.value === sel.value);
      chip.dataset.level = o ? o.level : 'unknown';
      chip.textContent = o && o.level === 'ok' ? 'унікальний' : o && o.level === 'warn' ? 'кілька збігів' : o && o.level === 'bad' ? '0 збігів' : sel.value === '-1' ? 'координати' : '—';
    };
    sel.addEventListener('change', syncChip); syncChip();
    ctl.pick = sel;
    parts.push(h('div', { class: 'se-field' },
      h('label', { for: sel.id, text: 'Ціль' }),
      h('div', { class: 'se-inline' }, sel, chip),
      h('div', { class: 'se-hint', id: id + '_pickhint', text: (step.target && step.target.desc ? step.target.desc + ' · ' : '') + '×n — скільки елементів збігалось під час запису' })));
  }

  if (v0.text != null) {
    const inp = h('input', { type: 'text', id: id + '_text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': id + '_texthint' });
    inp.value = v0.text;
    const prev = h('span', { class: 'se-preview', 'aria-live': 'polite' });
    const syncPrev = () => { prev.textContent = /\{(?:d|l)\}/.test(inp.value) ? 'Приклад: ' + templatePreview(inp.value) : ''; };
    inp.addEventListener('input', syncPrev); syncPrev();
    const chipBtn = (token, label) => h('button', {
      type: 'button', class: 'se-chip', 'aria-label': 'Вставити ' + label, title: 'Вставити ' + label, text: token,
      on: { click: () => { const r = insertToken(inp.value, inp.selectionStart, inp.selectionEnd, token); inp.value = r.value; inp.focus(); inp.setSelectionRange(r.caret, r.caret); syncPrev(); } },
    });
    ctl.text = inp;
    parts.push(h('div', { class: 'se-field' },
      h('label', { for: inp.id, text: 'Текст' }),
      inp,
      h('div', { class: 'se-inline' }, chipBtn('{d}', 'випадкову цифру'), chipBtn('{l}', 'випадкову літеру'), prev),
      h('div', { class: 'se-hint', id: id + '_texthint', text: '{d} — випадкова цифра, {l} — випадкова літера a–z, {{ — літерал «{».' +
        (v0.legacyRandom ? ' Старий перемикач: ' + (v0.legacyRandom === 'digit' ? '🎲 цифра' : '🎲 літера') + ' — тепер це шаблон.' : '') })));
  }

  if (v0.key != null) {
    const inp = h('input', { type: 'text', id: id + '_key', autocomplete: 'off', spellcheck: 'false', placeholder: 'Enter, Tab, ArrowDown, ControlOrMeta+a…' });
    inp.value = v0.key;
    ctl.key = inp;
    parts.push(h('div', { class: 'se-field' }, h('label', { for: inp.id, text: 'Клавіша' }), inp));
  }

  if (v0.showCoords) {
    const x = h('input', { type: 'number', id: id + '_x', min: '0', step: '1', inputmode: 'numeric', 'aria-label': 'X' });
    const y = h('input', { type: 'number', id: id + '_y', min: '0', step: '1', inputmode: 'numeric', 'aria-label': 'Y' });
    x.value = v0.x; y.value = v0.y;
    ctl.x = x; ctl.y = y;
    parts.push(h('div', { class: 'se-field' },
      h('span', { class: 'se-label', text: 'Координати (px запису)' }),
      h('div', { class: 'se-inline se-xy' }, h('label', { for: x.id, text: 'x' }), x, h('label', { for: y.id, text: 'y' }), y)));
  }

  const checks = [];
  if (step.type === 'click') {
    ctl.waitResponse = h('input', { type: 'checkbox', id: id + '_wr', checked: v0.waitResponse });
    checks.push(h('label', { class: 'se-check', for: ctl.waitResponse.id }, ctl.waitResponse, ' чекати відповідь сервера (для кнопки сабміту)'));
  }
  ctl.optional = h('input', { type: 'checkbox', id: id + '_opt', checked: v0.optional });
  checks.push(h('label', { class: 'se-check', for: ctl.optional.id }, ctl.optional, ' необовʼязковий (не знайдено → пропустити)'));
  parts.push(h('div', { class: 'se-checks' }, checks));

  if (v0.showTimeout) {
    const inp = h('input', { type: 'number', id: id + '_to', min: '500', max: '120000', step: '500', inputmode: 'numeric', placeholder: '6000' });
    inp.value = v0.timeout;
    ctl.timeout = inp;
    parts.push(h('div', { class: 'se-field se-row' }, h('label', { for: inp.id, text: 'Таймаут пошуку, мс' }), inp));
  }

  {
    const inp = h('input', { type: 'number', id: id + '_da', min: '0', max: String(MAX_DELAY_AFTER), step: '100', inputmode: 'numeric', placeholder: '0' });
    inp.value = v0.delayAfter;
    ctl.delayAfter = inp;
    parts.push(h('div', { class: 'se-field se-row' },
      h('label', { for: inp.id, text: 'Пауза після кроку, мс', title: 'Додаткове очікування після виконання цього кроку (перед наступним)' }), inp));
  }

  const form = h('form', { class: 'step-editor', novalidate: true, 'aria-label': 'Редагування кроку' },
    parts, errEl,
    h('div', { class: modal ? 'se-foot modal-foot' : 'se-foot' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Скасувати', on: { click: () => onCancel && onCancel() } }),
      h('button', { type: 'submit', class: 'btn btn-primary btn-small', text: 'Зберегти' })));

  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (onCancel) onCancel(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = {};
    if (ctl.pick) values.pick = ctl.pick.value;
    if (ctl.text) values.text = ctl.text.value;
    if (ctl.key) values.key = ctl.key.value;
    if (ctl.x) { values.x = ctl.x.value; values.y = ctl.y.value; }
    if (ctl.waitResponse) values.waitResponse = ctl.waitResponse.checked;
    values.optional = ctl.optional.checked;
    if (ctl.timeout) values.timeout = ctl.timeout.value;
    values.delayAfter = ctl.delayAfter.value;
    const r = applyEdit(step, values);
    if (!r.step) { errEl.textContent = Object.values(r.errors).join(' · '); return; }
    if (onSave) onSave(r.step);
  });
  return form;
}

// ---------- Модалка редагування кроку ----------
// openStepEditor(step, {title, subtitle}) → Promise<новий крок | null>.
// Та сама форма (buildEditor), але в окремому <dialog>: Esc / ✕ / клік по фону / «Скасувати»
// → null; «Зберегти» (після валідації) → змінений крок. Фокус повертається туди, звідки відкрили.
export function openStepEditor(step, { title = 'Редагування кроку', subtitle = '' } = {}) {
  return new Promise((resolve) => {
    const id = 'sem' + (++seq);
    const prevFocus = document.activeElement;
    let result = null;
    const dlg = h('dialog', { class: 'modal step-modal', 'aria-labelledby': id + '_t' });
    const close = () => { if (dlg.open) dlg.close(); };
    const form = buildEditor(step, {
      modal: true,
      onSave: (next) => { result = next; close(); },
      onCancel: close,
    });
    const hc = healthChip(step);
    dlg.appendChild(h('div', { class: 'modal-inner' },
      h('div', { class: 'modal-head' },
        h('div', { class: 'sem-titles' },
          h('h2', { id: id + '_t', text: title }),
          subtitle ? h('div', { class: 'sem-sub' },
            hc ? h('span', { class: 'hchip ' + hc.cls, title: hc.label, 'aria-label': hc.label, role: 'img', text: hc.icon }) : null,
            h('span', { text: subtitle })) : null),
        h('button', { type: 'button', class: 'x', 'aria-label': 'Закрити', title: 'Закрити (Esc)', text: '✕', on: { click: close } })),
      form));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // клік по фону
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
      resolve(result);
    });
    ($('dialogs') || document.body).appendChild(dlg);
    dlg.showModal();
    const first = form.querySelector('select, input:not([type=checkbox]), textarea, input');
    if (first) { first.focus(); if (first.select && first.type === 'text') first.select(); }
  });
}
