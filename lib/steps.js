// Модель кроків (під-дій) — спільний, ЧИСТИЙ, ізоморфний модуль.
// Без імпортів Node: сервер і фронтенд (ES-модуль /lib/steps.js) ділять код.
// Тут: нормалізація кроку (v2 + legacy), сплющення сценарію в плаский список
// для /replay (зі злиттям legacy-тексту по 1 символу в шаблон), підписи
// українською, «здоровʼя» локатора, клавіатура → крок, буфер тексту, «оптимізація».
//
// Шаблон тексту (поле text): {d} — випадкова цифра, {l} — випадкова літера a–z,
// {{ — буквальна «{». Розгортання (expandTemplate) — у lib/textTemplate.js;
// тут лише escapeTemplate для буквального тексту.
import { locKey, isEditableKind, truncate, stripUnstableClasses, isStableCss } from './locators.js';

export const STEP_TYPES = ['click', 'text', 'key', 'file', 'select', 'scroll', 'move'];
const KNOWN = new Set(STEP_TYPES);
// Тимчасові (рантайм/UI) поля — не зберігаються в БД.
export const TRANSIENT_FIELDS = ['status', 'strategy', 'ms', 'error', 'failShot', 'pending', 'healed', 'fallback', 'pausing'];

export function isKnownType(type) { return KNOWN.has(type); }

// ---------- Пауза після кроку ----------
// step.delayAfter — додаткова пауза (мс), яку користувач задає на кроці: виконується
// ПІСЛЯ кроку (і його settle), перед наступним. Межі — захист від сміття в даних.
export const MAX_DELAY_AFTER = 60000;
export function delayAfterMs(step) {
  const v = step && step.delayAfter;
  if (typeof v !== 'number' && typeof v !== 'string') return 0;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_DELAY_AFTER);
}
// Короткий підпис паузи для чіпа кроку: 300 → «+300 мс», 1500 → «+1,5 с», 0 → ''.
// {plus:false} — без «+» (для тексту: «пауза 1,5 с»).
export function formatDelay(ms, { plus = true } = {}) {
  const n = delayAfterMs({ delayAfter: ms });
  if (!n) return '';
  const p = plus ? '+' : '';
  if (n < 1000) return p + n + ' мс';
  const sec = Math.round(n / 100) / 10;
  return p + String(sec).replace('.', ',') + ' с';
}

// Legacy-крок: без версії і без цілі → координатний шлях (gid/detectDeviceGids).
export function isLegacyStep(s) { return !!s && s.v == null && !s.target; }

// Чи потрібна «підготовка як у /render» (autoScroll) перед відтворенням: лише якщо
// є legacy-координатні click/move — їх записано на fullPage-скрині після autoScroll,
// тож верстка має збігатися. Кроки v2 (локатори; x/y записано в живій сесії без
// підготовки) і legacy text/key/file її не потребують. Спільне правило для /replay і /live.
export function needsLegacyPrep(actions) {
  return Array.isArray(actions) && actions.some((a) => a && !a.disabled && (a.type === 'click' || a.type === 'move') && isLegacyStep(a));
}

// Ідентифікатор кроку: 's_' + 8 символів base36. rnd — інʼєкований [0,1).
export function newStepId(rnd = Math.random) {
  const abc = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = 's_';
  for (let i = 0; i < 8; i++) s += abc[Math.floor(rnd() * 36) % 36];
  return s;
}

// Нормалізація кроку: копія (вхід не мутується), додає id, якщо немає;
// dblclick → click+clicks:2; target приводиться до форми {locs[], pick, …}.
// Координати (x, y, sw, sh) НІКОЛИ не переписуються. Невідомий type лишається
// як є (виконавець пропускає його з логом). Не-обʼєкт → null.
//   opts.id  — явний id (напр. детермінований для legacy), opts.rnd — для newStepId
export function normalizeStep(step, opts = {}) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  const s = { ...step };
  if (s.id == null || s.id === '') s.id = opts.id != null ? opts.id : newStepId(opts.rnd);
  if (s.type === 'dblclick') { s.type = 'click'; s.clicks = 2; }
  if (s.target != null) {
    if (typeof s.target !== 'object') delete s.target;
    else {
      const t = { ...s.target };
      t.locs = Array.isArray(t.locs) ? t.locs.filter(l => l && typeof l === 'object' && l.by) : [];
      if (!Number.isInteger(t.pick) || t.pick >= t.locs.length || t.pick < -1) t.pick = t.locs.length ? 0 : -1;
      if (t.frame === undefined) t.frame = null;
      // Старі кроки «Файл» (записані до локатора input[type=file]) мають лише CSS-шлях, часто
      // з хешем CSS-модуля, що ламається з новим білдом. Додаємо input[type=file] як
      // альтернативу перед text/css — pick НЕ чіпаємо (живий CSS лишається першим), але
      // зламаний CSS більше не чекає таймауту: 1 збіг → loc-alt, кілька → найближчий бокс
      // або (без геометрії) поле за порядком. n невідомий → healthOf лишає ⚠.
      if (s.type === 'file' && (t.kind == null || t.kind === 'file') && t.pick >= 0 && !t.locs.some(l => l.by === 'type')) {
        let at = t.locs.findIndex(l => l.by === 'text' || l.by === 'css');
        if (at < 0) at = t.locs.length;
        t.locs = [...t.locs.slice(0, at), { by: 'type', tag: 'input', value: 'file' }, ...t.locs.slice(at)];
        if (t.pick >= at) t.pick += 1;
      }
      // Старі CSS-шляхи з хеш-класами (_container_f7cvd_28…) ламаються з новим білдом сайту.
      // Перед таким шляхом додаємо його очищену копію (без згенерованих класів); оригінал
      // лишається запасним. pick не міняємо — його переведе «покращення цілі» після прогону.
      for (let i = 0; i < t.locs.length; i++) {
        const l = t.locs[i];
        if (l.by !== 'css' || l.nth != null) continue;
        const clean = stripUnstableClasses(l.value).replace(/\s+/g, ' ').trim();
        // лише якщо очищений шлях сам стабільний (має клас/id-якір): «div > input» — не ознака елемента
        if (!clean || clean === String(l.value).trim() || !isStableCss(clean) || t.locs.some(x => x.by === 'css' && x.value === clean)) continue;
        t.locs = [...t.locs.slice(0, i), { by: 'css', value: clean, nth: null }, ...t.locs.slice(i)];
        if (t.pick >= i) t.pick += 1;
        i++; // пропустити оригінал
      }
      s.target = t;
    }
  }
  return s;
}

// Прибирає тимчасові поля кроку (для збереження в БД).
export function stripTransient(step) {
  if (!step || typeof step !== 'object') return step;
  const out = { ...step };
  for (const k of TRANSIENT_FIELDS) delete out[k];
  return out;
}

// Payload сценарію для PUT /pages/:id — без тимчасових полів і UI-стану, і БЕЗ кроків,
// що ще виконуються в живій сесії (pending:true — плейсхолдер «…⏳» до підтвердження).
export function pagePayload(p) {
  return {
    name: p.name, url: p.url,
    recs: (p.recs || []).map(r => ({
      id: r.id, name: r.name,
      subs: (r.subs || []).filter(x => !(x && typeof x === 'object' && x.pending === true)).map(stripTransient),
    })),
  };
}

// ---------- Шаблони тексту ----------
// Буквальний текст → шаблон: «{» → «{{».
export function escapeTemplate(s) { return String(s == null ? '' : s).replace(/\{/g, '{{'); }

// Шаблон для UI-прев'ю без рандому: {{ → {, {d} → 🎲ц, {l} → 🎲л.
export function templatePreview(t) {
  return String(t == null ? '' : t).replace(/\{\{|\{d\}|\{l\}/g, m => (m === '{{' ? '{' : m === '{d}' ? '🎲ц' : '🎲л'));
}

// ---------- Злиття legacy-тексту ----------
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock']);
export function isBareModifier(key) { return MODIFIERS.has(String(key)); }

// Legacy-текст, який можна зливати: без версії, без цілі, не вимкнений.
function mergeableText(s) { return s && s.type === 'text' && s.v == null && !s.target && !s.disabled; }
// Legacy «голий» модифікатор (Shift перед великою літерою) — поглинається злиттям.
function absorbableKey(s) { return s && s.type === 'key' && s.v == null && !s.target && !s.disabled && isBareModifier(s.key); }

function legacyCharTemplate(s) {
  if (s.random === 'digit') return '{d}';
  if (s.random === 'letter') return '{l}';
  return escapeTemplate(s.text == null ? '' : s.text);
}

// entries: [{sub, si}] у порядку. Повертає [{step, subIdxs}], де послідовні
// legacy-текстові під-дії (разом із «голими» модифікаторами між ними) злиті в один
// text-крок v:2 з шаблоном. Група з самих модифікаторів лишається як є.
function mergeTextRuns(entries) {
  const out = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (mergeableText(e.sub) || absorbableKey(e.sub)) {
      let j = i;
      // Під-дія з паузою після себе закриває групу: пауза лишається саме після неї.
      while (j < entries.length && (mergeableText(entries[j].sub) || absorbableKey(entries[j].sub))) {
        j++;
        if (delayAfterMs(entries[j - 1].sub)) break;
      }
      const group = entries.slice(i, j);
      const texts = group.filter(g => mergeableText(g.sub));
      if (texts.length) {
        const first = texts[0].sub;
        const step = { ...first, type: 'text', v: 2, text: texts.map(g => legacyCharTemplate(g.sub)).join('') };
        delete step.random;
        const d = delayAfterMs(group[group.length - 1].sub);
        if (d) step.delayAfter = d; else delete step.delayAfter;
        if (texts.length > 1 || group.length > 1) step.merged = group.length;
        out.push({ step, subIdxs: group.map(g => g.si) });
      } else {
        for (const g of group) out.push({ step: { ...g.sub }, subIdxs: [g.si] });
      }
      i = j;
    } else {
      out.push({ step: { ...e.sub }, subIdxs: [e.si] });
      i++;
    }
  }
  return out;
}

// ---------- Сплющення сценарію ----------
// page = {id, url, recs:[{id, name, subs:[…]}]}. uptoRecId — виконати до цієї
// Дії включно (невідомий id → помилка, а не тихий порожній прогін).
// Повертає:
//   flat    — кроки для /replay (нормалізовані, з gid = id Дії; legacy-текст злитий);
//   map     — паралельний flat: [{recId, subIdxs, recPos}] (recPos — 1-based у Дії);
//   skipped — [{recId, si, reason: 'move'|'unknown'|'invalid'}];
//   recs    — [{recId, total}] (кроків у кожній Дії).
// Під-дії не мутуються. Legacy-кроки без id отримують детермінований id 'L<rec>_<si>'.
export function flattenScenario(page, uptoRecId, { skipMoves = true } = {}) {
  const all = (page && Array.isArray(page.recs)) ? page.recs : [];
  let recs = all;
  if (uptoRecId != null) {
    const idx = all.findIndex(r => String(r.id) === String(uptoRecId));
    if (idx < 0) throw new Error('Дію ' + uptoRecId + ' не знайдено у сценарії');
    recs = all.slice(0, idx + 1);
  }
  const flat = [], map = [], skipped = [], recInfo = [];
  for (const rec of recs) {
    const entries = [];
    (rec.subs || []).forEach((sub, si) => {
      if (!sub || typeof sub !== 'object') { skipped.push({ recId: rec.id, si, reason: 'invalid' }); return; }
      const type = sub.type === 'dblclick' ? 'click' : sub.type;
      if (!isKnownType(type)) { skipped.push({ recId: rec.id, si, reason: 'unknown' }); return; }
      if (skipMoves && type === 'move') { skipped.push({ recId: rec.id, si, reason: 'move' }); return; }
      entries.push({ sub, si });
    });
    let pos = 0;
    for (const { step, subIdxs } of mergeTextRuns(entries)) {
      const n = normalizeStep(step, { id: step.id != null ? step.id : 'L' + rec.id + '_' + subIdxs[0] });
      n.gid = rec.id;
      flat.push(n);
      map.push({ recId: rec.id, subIdxs, recPos: ++pos });
    }
    recInfo.push({ recId: rec.id, total: pos });
  }
  return { flat, map, skipped, recs: recInfo };
}

// ---------- «Оптимізувати Дію» ----------
export function countMoves(subs) { return (subs || []).filter(s => s && s.type === 'move').length; }

// Прибирає рухи миші і зливає legacy-текст по символу в шаблонні кроки.
// Повертає {subs, movesRemoved, textMerged (скільки під-дій злито в текст)}.
// Не мутує вхід. Застосовується користувачем явно, не як тиха міграція.
export function compactMoves(subs, { dropMoves = true, mergeText = true } = {}) {
  const entries = [];
  let movesRemoved = 0;
  (subs || []).forEach((sub, si) => {
    if (dropMoves && sub && sub.type === 'move') { movesRemoved++; return; }
    entries.push({ sub, si });
  });
  if (!mergeText) return { subs: entries.map(e => e.sub), movesRemoved, textMerged: 0 };
  let textMerged = 0;
  const out = mergeTextRuns(entries.filter(e => e.sub && typeof e.sub === 'object')).map(({ step, subIdxs }) => {
    if (subIdxs.length > 1) textMerged += subIdxs.length;
    const s = { ...step };
    delete s.merged;
    return s;
  });
  return { subs: out, movesRemoved, textMerged };
}

// ---------- Обʼєднання двох текстових кроків (ручне, з UI) ----------
// Шаблон тексту кроку: legacy (без v) — буквальний текст/рандом → шаблон; v2 — як є.
export function textTemplateOf(step) {
  if (!step || step.type !== 'text') return '';
  return step.v == null ? legacyCharTemplate(step) : String(step.text == null ? '' : step.text);
}

// Індекс наступного ВИДИМОГО кроку після si (hideMoves → рухи перескакуються) або -1.
export function nextVisibleIndex(subs, si, { hideMoves = false } = {}) {
  if (!Array.isArray(subs)) return -1;
  for (let j = si + 1; j < subs.length; j++) {
    const b = subs[j];
    if (hideMoves && b && b.type === 'move') continue;
    return j;
  }
  return -1;
}

// Чи можна злити текстовий крок a з наступним b. → {ok, reason}
// Різні поля (цілі) не зливаємо: інакше другий текст пішов би не в те поле.
export function canMergeText(a, b) {
  if (!a || !b || a.type !== 'text' || b.type !== 'text') return { ok: false, reason: 'Обʼєднувати можна лише два кроки введення тексту' };
  if (a.pending || b.pending) return { ok: false, reason: 'Крок ще виконується' };
  if (a.disabled || b.disabled) return { ok: false, reason: 'Один із кроків вимкнено' };
  if (a.target && b.target && !sameTarget(a.target, b.target)) return { ok: false, reason: 'Кроки вводять текст у різні поля' };
  return { ok: true, reason: '' };
}

// Зливає крок si з наступним видимим текстовим кроком. Не мутує вхід.
// → {ok:false, reason} | {ok:true, subs, step, removed, droppedDelay} — step стоїть на місці si,
//   крок removed прибрано (рухи між ними, якщо приховані, лишаються на місці).
// Злитий крок: v:2, text = шаблон(a) + шаблон(b), ціль — a (або b, якщо в a немає),
// пауза після — від b (вона була після всього введення), решта прапорців — від a.
export function mergeTextSteps(subs, si, { hideMoves = false } = {}) {
  const a = Array.isArray(subs) ? subs[si] : null;
  const j = nextVisibleIndex(subs, si, { hideMoves });
  if (!a || j < 0) return { ok: false, reason: 'Немає наступного кроку' };
  const b = subs[j];
  const chk = canMergeText(a, b);
  if (!chk.ok) return chk;
  const step = stripTransient({ ...a, type: 'text', v: 2, text: textTemplateOf(a) + textTemplateOf(b) });
  delete step.random;
  delete step.merged;
  if (!step.target && b.target) step.target = b.target;
  const d = delayAfterMs(b);
  if (d) step.delayAfter = d; else delete step.delayAfter;
  const out = subs.slice();
  out[si] = step;
  out.splice(j, 1);
  // Пауза після a (між двома введеннями) в одному кроці неможлива — повідомляємо UI, що її прибрано.
  return { ok: true, subs: out, step, removed: j, droppedDelay: delayAfterMs(a) };
}

// ---------- Цілі ----------
// Чи це та сама ціль: однаковий фрейм і (обраний локатор збігається, або є спільний
// унікальний локатор, або — без локаторів — бокси майже збігаються).
export function sameTarget(a, b) {
  if (!a || !b) return false;
  if (frameKey(a.frame) !== frameKey(b.frame)) return false;
  const la = a.locs || [], lb = b.locs || [];
  const pa = la[a.pick], pb = lb[b.pick];
  if (pa && pb && locKey(pa) === locKey(pb)) return true;
  const ua = new Set(la.filter(l => l.n === 1).map(locKey));
  if (lb.some(l => l.n === 1 && ua.has(locKey(l)))) return true;
  if (!la.length && !lb.length && a.box && b.box) {
    return Math.abs(a.box.x - b.box.x) <= 2 && Math.abs(a.box.y - b.box.y) <= 2 &&
      Math.abs(a.box.w - b.box.w) <= 2 && Math.abs(a.box.h - b.box.h) <= 2;
  }
  return false;
}
// Ключ фрейму цілі ('' — головний фрейм). Спільний для sameTarget і памʼяті фреймів у replay.
export function frameKey(f) {
  if (!f) return '';
  return (f.chain || []).join(' >>> ') + '|' + (f.url || '');
}

// Клавіші, що не переносять фокус — ціль після них лишається тією ж.
const FOCUS_NEUTRAL = /^(?:(?:Shift\+)?(?:Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)|ControlOrMeta\+[acvxz]|Control\+[acvxz]|Meta\+[acvxz])$/;
export function isFocusNeutralKey(key) { return FOCUS_NEUTRAL.test(String(key || '')); }

// Ціль для тексту, що щойно надрукували: успадковуємо від попереднього кроку,
// якщо це клік/текст/«нейтральна» клавіша по РЕДАГОВАНОМУ елементу. Інакше null.
export function inheritTextTarget(prev) {
  if (!prev || !prev.target || prev.disabled) return null;
  const okType = prev.type === 'click' || prev.type === 'text' || (prev.type === 'key' && isFocusNeutralKey(prev.key));
  if (!okType) return null;
  return isEditableKind(prev.target.kind) ? prev.target : null;
}

// Чи треба перед текстом клікнути в його ціль (повернути фокус): так, якщо ціль є
// і попередній крок не тримав фокус на ній самій.
export function needsFocusClick(prev, step) {
  if (!step || step.type !== 'text' || !step.target) return false;
  if (!prev || prev.disabled) return true;
  const holdsFocus = prev.type === 'click' || prev.type === 'text' || prev.type === 'select' ||
    (prev.type === 'key' && isFocusNeutralKey(prev.key));
  return !(holdsFocus && sameTarget(prev.target, step.target));
}

// «Здоровʼя» кроку для чипа в UI:
//   'semantic' — унікальний (n===1 або не рахувався) семантичний локатор;
//   'weak'     — CSS / nth / кілька збігів / 0 збігів, або текст/файл без цілі;
//   'coords'   — лише координати (клік/рух без цілі або pick === -1).
//   null       — для кроків без цілі за природою (key, scroll).
const SEMANTIC_BY = new Set(['testid', 'role', 'label', 'placeholder', 'text', 'name', 'id', 'type']);
export function healthOf(step) {
  if (!step) return null;
  const t = step.target;
  const loc = t && Array.isArray(t.locs) && t.pick >= 0 ? t.locs[t.pick] : null;
  if (!loc) {
    if (step.type === 'click' || step.type === 'move' || step.type === 'select') return 'coords';
    if (step.type === 'text' || step.type === 'file') return 'weak';
    return null;
  }
  // CSS-шлях лише зі стабільних класів/id (без nth), що знаходив рівно 1 елемент, — надійний.
  if (loc.by === 'css') return loc.nth == null && loc.n === 1 && isStableCss(loc.value) ? 'semantic' : 'weak';
  if (!SEMANTIC_BY.has(loc.by)) return 'weak';
  if (loc.by === 'type' && loc.n == null) return 'weak'; // input[type=file] без підрахунку — може бути кілька
  if (loc.n != null && loc.n !== 1) return 'weak';
  return 'semantic';
}

// ---------- Покращення цілі після успішного відтворення ----------
// Якщо крок знайдено слабким локатором (CSS-шлях / n невідомий), відтворення перевіряє,
// чи надійніший локатор знаходить ТОЙ САМИЙ елемент рівно один раз — тоді ціль кроку
// оновлюється (⚠ → 🎯) без перезапису. usedIdx — індекс локатора, яким знайшли; usedN — збігів.
// → {direct: idx|null, list: [idx…]}: direct — сам використаний семантичний локатор
//   (досить записати n=1), list — семантичні кандидати для перевірки «той самий елемент».
export function upgradeCandidates(target, usedIdx, usedN) {
  const locs = (target && Array.isArray(target.locs)) ? target.locs : [];
  const used = locs[usedIdx];
  if (!used) return { direct: null, list: [] };
  // «Надійний» = семантичний локатор або CSS-шлях лише зі стабільних класів/id (без nth).
  const strong = (l) => !!l && (SEMANTIC_BY.has(l.by) || (l.by === 'css' && l.nth == null && isStableCss(l.value)));
  const pickIdx = target && Number.isInteger(target.pick) ? target.pick : usedIdx;
  // pick уже 🎯 (надійний з n=1) — не чіпаємо, навіть якщо цього разу знайшли іншим локатором:
  // разовий 🔁 (повільний рендер, інша мова) не привід назавжди міняти добру/обрану користувачем ціль.
  const pickLoc = locs[pickIdx];
  if (strong(pickLoc) && pickLoc.n === 1) return { direct: null, list: [] };
  // Знайдено надійним локатором рівно 1 раз → досить записати n=1 і (якщо це не pick) перевести pick.
  if (strong(used) && usedN === 1) return { direct: usedIdx, list: [] };
  const list = [];
  locs.forEach((l, i) => { if (i !== usedIdx && strong(l)) list.push(i); });
  return { direct: null, list };
}

// Застосовує покращення до цілі кроку: pick → idx, n=1 у цього локатора. Не мутує.
// normTarget — нормалізована ціль (з мігрованими локаторами, напр. input[type=file]).
export function applyTargetUpgrade(normTarget, idx) {
  if (!normTarget || !Array.isArray(normTarget.locs) || !normTarget.locs[idx]) return null;
  const locs = normTarget.locs.map((l, i) => (i === idx ? { ...l, n: 1 } : l));
  return { ...normTarget, locs, pick: idx };
}

// ---------- Підписи ----------
function textPreview(t, max = 20) { return truncate(templatePreview(t), max); }
const xy = (s) => '(' + s.x + ', ' + s.y + ')';

// Підпис кроку українською. З описом цілі — «Клік: кнопка «Submit»»,
// «Ввести «john…» у поле «Email»»; legacy — «👆 клік (x, y)».
export function stepLabel(step) {
  if (!step) return '';
  const desc = step.target && step.target.desc ? String(step.target.desc) : '';
  switch (step.type) {
    case 'click': {
      const what = step.clicks === 2 ? 'Подвійний клік' : 'Клік';
      if (desc) return what + ': ' + desc;
      return (step.clicks === 2 ? '👆👆 подвійний клік ' : '👆 клік ') + xy(step);
    }
    case 'move': return '🖱️ рух ' + xy(step);
    case 'text': {
      if (step.v == null && step.random === 'digit') return '🎲 рандомна цифра (0–9)';
      if (step.v == null && step.random === 'letter') return '🎲 рандомна літера (a–z)';
      const shown = step.v == null ? truncate(step.text == null ? '' : String(step.text), 20) : textPreview(step.text);
      return (step.clear ? 'Замінити на' : 'Ввести') + ' «' + shown + '»' + (desc ? ' у ' + desc : '');
    }
    case 'key': return 'Клавіша: ' + (step.key || '—') + (desc ? ' у ' + desc : '');
    case 'file': return 'Файл «' + (step.filename || '—') + '»' + (desc ? ' у ' + desc : '');
    case 'select': return 'Вибрати «' + truncate(step.label || step.value || '—', 30) + '»' + (desc ? ' у ' + desc : '');
    case 'scroll': {
      const dy = Number(step.dy) || 0, dx = Number(step.dx) || 0;
      const parts = [];
      if (dy) parts.push((dy > 0 ? '↓' : '↑') + Math.abs(dy));
      if (dx) parts.push((dx > 0 ? '→' : '←') + Math.abs(dx));
      return 'Прокрутка ' + (parts.join(' ') || '0');
    }
    default: return String(step.type || '?');
  }
}

// Іконка кроку для рядка списку.
export function stepIcon(step) {
  const t = step && step.type;
  return t === 'click' ? '👆' : t === 'text' ? '⌨️' : t === 'key' ? '⌨️' : t === 'file' ? '📎'
    : t === 'select' ? '🔽' : t === 'scroll' ? '↕️' : t === 'move' ? '🖱️' : '•';
}

// Крок із побічним ефектом (сабміт форми) — перед перепрогоном потрібне підтвердження.
const SIDE_EFFECT = /submit|apply|send|відправ|надіслати|подати/i;
export function isSideEffectStep(step) {
  if (!step) return false;
  if (step.waitResponse === true) return true;
  const t = step.target;
  if (!t) return false;
  if (t.desc && SIDE_EFFECT.test(t.desc)) return true;
  return (t.locs || []).some(l => SIDE_EFFECT.test(String(l.name || '')) || (l.by !== 'css' && SIDE_EFFECT.test(String(l.value || ''))));
}

// ---------- Клавіатура ----------
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'ContextMenu']);
const isPrintable = (k) => typeof k === 'string' && [...k].length === 1;

// Подія клавіатури (keydown-подібна: {key, ctrlKey, metaKey, altKey, shiftKey, repeat})
// → крок або null:
//   • повтор (repeat) і «голі» модифікатори → null;
//   • Ctrl/Cmd+V → {type:'paste'} (НЕ зберігається: UI читає буфер обміну і шле текст);
//   • Ctrl/Cmd+клавіша → {type:'key', key:'ControlOrMeta+a'} (+Alt/+Shift);
//   • друкований символ (у т.ч. Alt-символи macOS і AltGr) → {type:'text', text};
//   • Enter/Tab/Esc/стрілки/… → {type:'key', key:'Shift+Tab'…}; інше → null.
export function keyToStep(e) {
  if (!e || typeof e.key !== 'string' || !e.key) return null;
  if (e.repeat) return null;
  const key = e.key;
  if (isBareModifier(key) || key === 'Dead' || key === 'Unidentified' || key === 'Process') return null;
  const ctrl = !!e.ctrlKey, meta = !!e.metaKey, alt = !!e.altKey, shift = !!e.shiftKey;
  const altGr = ctrl && alt && !meta && isPrintable(key);
  if ((ctrl || meta) && !altGr) {
    const k = key === ' ' ? 'Space' : isPrintable(key) ? key.toLowerCase() : (NAMED_KEYS.has(key) || /^F\d{1,2}$/.test(key) ? key : null);
    if (!k) return null;
    const mod = ctrl && meta ? 'Control+Meta' : 'ControlOrMeta';
    if (k === 'v' && !alt && !shift) return { type: 'paste' };
    return { type: 'key', key: mod + '+' + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + k };
  }
  if (isPrintable(key)) return { type: 'text', text: key };
  if (NAMED_KEYS.has(key) || /^F\d{1,2}$/.test(key)) {
    return { type: 'key', key: (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + key };
  }
  return null;
}

// Редьюсер клієнтського буфера тексту під час живого запису. buf — НЕвідісланий
// буквальний текст; input — результат keyToStep, або рядок-клавіша, або подія.
// Повертає {buf, emit:[кроки до відправки по порядку]}:
//   text → дописуємо в буфер; Backspace при непорожньому буфері → редагуємо буфер;
//   будь-що інше → спершу скидаємо буфер як text-крок (з escapeTemplate), потім сам крок.
export function textBufferReduce(buf, input) {
  const b = buf == null ? '' : String(buf);
  let step = input;
  if (typeof input === 'string') step = keyToStep({ key: input });
  else if (input && input.key !== undefined && input.type === undefined) step = keyToStep(input);
  if (!step) return { buf: b, emit: [] };
  if (step.type === 'text') return { buf: b + String(step.text == null ? '' : step.text), emit: [] };
  if (step.type === 'key' && step.key === 'Backspace' && b.length) {
    const cps = [...b]; cps.pop();
    return { buf: cps.join(''), emit: [] };
  }
  return { buf: '', emit: [...flushTextBuffer(b).emit, step] };
}

// Скидання буфера (простій 400 мс, клік, скрол…): {buf:'', emit:[text-крок]|[]}.
export function flushTextBuffer(buf) {
  const b = buf == null ? '' : String(buf);
  return { buf: '', emit: b ? [{ type: 'text', v: 2, text: escapeTemplate(b) }] : [] };
}
