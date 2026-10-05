// scenarioModel.js — ЧИСТА логіка моделі сценаріїв для UI (без DOM, тестується в node:test).
//   validateUrl / normalizeUrlInput — перевірка стартового URL у діалозі;
//   pagesFromApi(list, expand)      — відповідь GET /pages → модель UI (з памʼяттю розгортання);
//   maxId(list)                     — для лічильників id;
//   nextPageId(counter, now)        — id нового сценарію (часова мітка, без колізій між вкладками);
//   nextRecName(page)               — назва нової Дії в межах СЦЕНАРІЮ («Дія N», а не глобальний лічильник);
//   guardUndo(fn, {isBusy, onBlocked}) — «Скасувати» з тосту не мутує модель під час прогону/запису;
//   subsStamp(rec) / subsUnchanged(rec, stamp) — чи Дію не змінено відтоді (для відкату з тосту);
// План і події прогону — runner.js (createRunPlan/applyRunEvent/finishRun).

// Дозволяємо URL без схеми (як сервер: example.com → https://example.com).
export function normalizeUrlInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s;
}

// '' — валідний; інакше текст помилки українською.
export function validateUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'Вкажи стартовий URL';
  if (/\s/.test(s)) return 'URL не може містити пробілів';
  let u;
  try { u = new URL(normalizeUrlInput(s)); } catch (_e) { return 'Некоректний URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Підтримуються лише http:// і https://';
  if (!u.hostname) return 'У URL немає домену';
  return '';
}

// Id нового сценарію: не менше за «лічильник + 1» і за поточний час у мс — дві вкладки
// (або два клієнти) не видадуть однаковий id, як це було з простим ++pageCounter.
export function nextPageId(counter, now = Date.now()) {
  const c = Number(counter) || 0;
  return Math.max(c + 1, Math.floor(Number(now) || 0));
}

export function maxId(list) {
  let m = 0;
  for (const x of list || []) { const n = Number(x && x.id); if (Number.isFinite(n) && n > m) m = n; }
  return m;
}

// expand: {get(kind, id, def)} (див. state.createExpandStore).
export function pagesFromApi(list, expand) {
  const get = expand && expand.get ? (k, id, d) => expand.get(k, id, d) : (_k, _id, d) => d;
  return (list || []).map((p) => ({
    id: Number(p.id), name: p.name, url: p.url, expanded: get('p', Number(p.id), true),
    recs: (p.recs || []).map((r) => ({
      id: Number(r.id), name: r.name,
      subs: (r.subs || []).map((a) => ({ ...a })), expanded: get('r', Number(r.id), false),
    })),
  }));
}

// Назва нової Дії: max N серед «Дія N» цього сценарію + 1 (не менше recs.length + 1 — без
// збігу з перейменованими; монотонно в межах сценарію). Глобальний id Дії — окремо (recCounter).
export function nextRecName(page) {
  const recs = (page && page.recs) || [];
  let max = 0;
  for (const r of recs) {
    const m = /^Дія\s+(\d+)$/.exec(String((r && r.name) || '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'Дія ' + Math.max(max + 1, recs.length + 1);
}

// Обгортка для onAction тостів «Скасувати»: поки йде прогін чи запис, індекси кроків
// використовуються планом прогону/рекордером — відновлення зсунуло б їх.
export const UNDO_BLOCKED = 'Скасування недоступне під час прогону чи запису — дочекайся завершення.';
export function guardUndo(fn, { isBusy = () => false, onBlocked = () => {} } = {}) {
  return (...args) => {
    if (isBusy()) { onBlocked(UNDO_BLOCKED); return false; }
    return fn(...args);
  };
}

// Відбиток списку кроків Дії для безпечного відкату з тосту (обʼєднання, ⚡ оптимізація).
// Перевірки лише ідентичності масиву мало: перестановка/видалення/✎/додавання файлу/запис
// мутують rec.subs НА МІСЦІ. Тож порівнюємо і масив, і поелементно вміст.
export function subsStamp(rec) {
  const arr = rec && Array.isArray(rec.subs) ? rec.subs : null;
  return { arr, items: arr ? arr.slice() : [] };
}
export function subsUnchanged(rec, stamp) {
  if (!rec || !stamp || rec.subs !== stamp.arr || !Array.isArray(rec.subs)) return false;
  return rec.subs.length === stamp.items.length && rec.subs.every((x, i) => x === stamp.items[i]);
}
