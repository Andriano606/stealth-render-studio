// dialogs.js — <dialog>-діалоги замість prompt()/confirm() (модальні, Esc = скасувати,
// фокус на першому полі й повернення фокусу після закриття, валідація з підказкою під полем).
//   formDialog({title, message, fields:[{name,label,value,type,placeholder,hint,required,validate}], okText, danger})
//       → Promise<{name: value}|null>
//   promptDialog({title, label, value, placeholder, hint, required, validate, okText}) → Promise<string|null>
//   confirmDialog({title, message, okText, cancelText, danger}) → Promise<boolean>
//   validateFields(fields, values) → {name: 'текст помилки'} — чиста, тестована.
//   toast(text, {kind, actionText, onAction, timeout}) → {close()} — ненавʼязливе сповіщення
//       (#toasts, role=status), опційна дія (напр. «Скасувати» для undo). Таймер ПРИЗУПИНЯЄТЬСЯ,
//       поки курсор/фокус на тості або вкладка прихована (WCAG 2.2.1); тости з дією — ≥ 10 с.
//   createPausableTimer(fn, ms, {now, setTimer, clearTimer, minResume}) — чистий таймер з паузою.
// Діалоги монтуються в #dialogs (або body) і видаляються після закриття.
import { $, h } from './dom.js';

let seq = 0;

// field.validate(value, values) → '' | 'помилка'. required → «Заповни поле».
export function validateFields(fields, values) {
  const errors = {};
  for (const f of fields || []) {
    const v = values[f.name];
    const s = typeof v === 'string' ? v.trim() : v;
    if (f.required && (s === '' || s == null)) { errors[f.name] = f.requiredMsg || 'Заповни поле'; continue; }
    if (typeof f.validate === 'function') {
      const msg = f.validate(v, values);
      if (msg) errors[f.name] = msg;
    }
  }
  return errors;
}

export function formDialog({ title, message, fields = [], okText = 'OK', cancelText = 'Скасувати', danger = false } = {}) {
  return new Promise((resolve) => {
    const id = 'dlg' + (++seq);
    const prevFocus = document.activeElement;
    let result = null;

    const inputs = {};
    const errs = {};
    const fieldEls = fields.map((f) => {
      const inputId = id + '_' + f.name;
      const errId = inputId + '_err';
      const common = {
        id: inputId, name: f.name, placeholder: f.placeholder || null,
        'aria-describedby': errId + (f.hint ? ' ' + inputId + '_hint' : ''),
        autocomplete: 'off', spellcheck: 'false',
      };
      const input = f.type === 'textarea'
        ? h('textarea', { ...common, rows: f.rows || 3 })
        : h('input', { ...common, type: f.type === 'number' ? 'number' : 'text', inputmode: f.inputmode || (f.type === 'url' ? 'url' : null) });
      input.value = f.value == null ? '' : String(f.value);
      inputs[f.name] = input;
      errs[f.name] = h('div', { class: 'error', id: errId, 'aria-live': 'polite' });
      return h('div', { class: 'field' },
        h('label', { for: inputId, text: f.label || f.name }),
        input,
        f.hint ? h('div', { class: 'hint', id: inputId + '_hint', text: f.hint }) : null,
        errs[f.name]);
    });

    const values = () => Object.fromEntries(fields.map((f) => [f.name, inputs[f.name].value]));
    const showErrors = (errors) => {
      let first = null;
      for (const f of fields) {
        const msg = errors[f.name] || '';
        errs[f.name].textContent = msg;
        inputs[f.name].setAttribute('aria-invalid', msg ? 'true' : 'false');
        if (msg && !first) first = inputs[f.name];
      }
      if (first) first.focus();
      return !first;
    };

    const dlg = h('dialog', { class: 'modal small', 'aria-labelledby': id + '_t' });
    const form = h('form', { method: 'dialog', novalidate: true, class: 'modal-inner' },
      h('div', { class: 'modal-head' }, h('h2', { id: id + '_t', text: title || '' })),
      h('div', { class: 'dlg-body' },
        message ? h('p', { class: 'dlg-msg', text: message }) : null,
        fieldEls),
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn btn-ghost', text: cancelText, on: { click: () => dlg.close() } }),
        h('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: okText })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = values();
      if (!showErrors(validateFields(fields, v))) return;
      result = v;
      dlg.close();
    });
    // Клік по фону (поза вмістом) — скасування.
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
      resolve(result);
    });
    dlg.appendChild(form);
    ($('dialogs') || document.body).appendChild(dlg);
    dlg.showModal();
    // Без полів: фокус на «OK», але для небезпечних дій (danger) — на безпечному «Скасувати».
    const first = fields.length ? inputs[fields[0].name]
      : form.querySelector(danger ? '.modal-foot button[type=button]' : 'button[type=submit]');
    if (first) { first.focus(); if (first.select && fields.length) first.select(); }
  });
}

export async function promptDialog({ title, label, value = '', placeholder, hint, required = false, validate, okText = 'Зберегти', type } = {}) {
  const r = await formDialog({
    title, okText,
    fields: [{ name: 'v', label: label || title, value, placeholder, hint, required, validate, type }],
  });
  return r ? r.v : null;
}

export async function confirmDialog({ title = 'Підтвердження', message = '', okText = 'Так', cancelText = 'Скасувати', danger = false } = {}) {
  const r = await formDialog({ title, message, fields: [], okText, cancelText, danger });
  return r != null;
}

// ---------- Тости ----------
// Таймер, що вміє паузу: pause() зберігає залишок, resume() продовжує (не менше minResume мс,
// щоб після відведення курсору тост не зник миттєво).
export function createPausableTimer(fn, ms, {
  now = () => Date.now(), setTimer = (f, t) => setTimeout(f, t), clearTimer = (t) => clearTimeout(t), minResume = 2000,
} = {}) {
  let remaining = ms, startedAt = 0, t = null, done = false;
  const fire = () => { t = null; done = true; fn(); };
  const api = {
    start() { if (done || t != null || !(ms > 0)) return; startedAt = now(); t = setTimer(fire, Math.max(remaining, 0)); },
    pause() { if (t == null) return; clearTimer(t); t = null; remaining -= now() - startedAt; },
    resume() { if (done || t != null || !(ms > 0)) return; remaining = Math.max(remaining, minResume); api.start(); },
    cancel() { if (t != null) clearTimer(t); t = null; done = true; },
    get running() { return t != null; },
    get remaining() { return t != null ? remaining - (now() - startedAt) : remaining; },
  };
  return api;
}

// kind: info | ok | warn | error. timeout 0 = не зникає сам (лише ✕ або дія);
// за замовчуванням 5 с, а з дією (undo) — 10 с.
export function toast(text, { kind = 'info', actionText, onAction, timeout } = {}) {
  if (timeout == null) timeout = actionText ? 10000 : 5000;
  let host = $('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  let hovered = false, focused = false;
  const timer = createPausableTimer(() => close(), timeout);
  const onVis = () => { if (document.hidden) timer.pause(); else if (!hovered && !focused) timer.resume(); };
  const close = () => { timer.cancel(); document.removeEventListener('visibilitychange', onVis); el.remove(); };
  const el = h('div', { class: 'toast toast-' + kind },
    h('span', { class: 'toast-text', text: String(text == null ? '' : text) }),
    actionText ? h('button', {
      type: 'button', class: 'toast-act', text: actionText,
      on: { click: () => { close(); if (onAction) onAction(); } },
    }) : null,
    h('button', { type: 'button', class: 'toast-x', 'aria-label': 'Закрити сповіщення', text: '✕', on: { click: close } }));
  el.addEventListener('mouseenter', () => { hovered = true; timer.pause(); });
  el.addEventListener('mouseleave', () => { hovered = false; if (!focused && !document.hidden) timer.resume(); });
  el.addEventListener('focusin', () => { focused = true; timer.pause(); });
  el.addEventListener('focusout', (e) => { if (el.contains(e.relatedTarget)) return; focused = false; if (!hovered && !document.hidden) timer.resume(); });
  document.addEventListener('visibilitychange', onVis);
  host.appendChild(el);
  // Не більше 4 одночасно — найстаріші йдуть.
  while (host.children.length > 4) host.firstChild.remove();
  if (!document.hidden) timer.start();
  return { close, el };
}
