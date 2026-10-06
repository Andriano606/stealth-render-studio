// Локатори цілей (спільний, ЧИСТИЙ, ізоморфний модуль).
// Без імпортів Node — сервер і фронтенд (як ES-модуль /lib/locators.js) ділять
// один код. Тут: кандидати-локатори з опису елемента, їх ранжування з
// лічильниками збігів, фрейми (CSS-ланцюг + URL-глоб), математика точки в боксі,
// і перетворення локатора в дескриптор виклику Playwright.
//
// ─────────────────────────────────────────────────────────────────────────────
// Вхідна форма: що повертає браузерна функція DESCRIBE_FN (lib/capture.js).
// DESCRIBE_FN лише ЧИТАЄ DOM (без глобалів сторінки — у Camoufox evaluate
// працює в ізольованому світі) і повертає РІВНО такий обʼєкт:
//
/**
 * @typedef {Object} ElementDesc
 * @property {string}  tag          tagName у ВЕРХНЬОМУ регістрі: 'BUTTON', 'INPUT', 'A', 'DIV'…
 * @property {?string} type         атрибут type у нижньому регістрі (input/button), інакше null
 * @property {?string} role         ЯВНИЙ атрибут role (як є), інакше null
 * @property {?string} name         наближення accessible name: aria-label → текст
 *                                  aria-labelledby → текст <label> (для полів) → alt/title →
 *                                  value (input type=button/submit) → innerText. Пробіли
 *                                  стиснуті, trim, ≤ 200 символів. null якщо порожньо.
 * @property {?string} label        текст повʼязаного <label> (for=… або обгортка) чи
 *                                  aria-labelledby; стиснутий, ≤ 200; інакше null
 * @property {?string} placeholder  атрибут placeholder
 * @property {?string} nameAttr     атрибут name (input/select/textarea/button)
 * @property {?string} id           атрибут id
 * @property {?{attr:string,value:string}} testid  перший знайдений із
 *                                  data-testid / data-test / data-qa / data-cy (у цьому порядку)
 * @property {?string} text         innerText елемента, стиснутий, ≤ 200; null для полів вводу
 * @property {?string} href         атрибут href (для <a>), інакше null
 * @property {?string} alt          атрибут alt (для <img>/<input type=image>)
 * @property {boolean} [editable]   isContentEditable
 * @property {boolean} [multiple]   атрибут multiple (select/file)
 * @property {number}  [size]       атрибут size для <select>
 * @property {Array<{tag:string,id?:?string,classes?:string[],nth?:number}>} [path]
 *                                  ланцюг предків ВІД КОРЕНЯ ДО елемента (включно):
 *                                  tag (нижній регістр), id, класи, nth = 1-based
 *                                  :nth-of-type серед братів. З нього buildCssPath
 *                                  будує CSS, відкидаючи хешовані id/класи.
 * @property {?string} cssPath      (альтернатива path) готовий CSS-шлях, якщо path немає
 * @property {?number} nth          0-based індекс елемента серед УСІХ збігів cssPath
 *                                  у документі (для .nth()), null якщо невідомо
 * @property {{x:number,y:number,w:number,h:number}} box  бокс у CSS px ДОКУМЕНТА фрейму
 * @property {?string} [kind]       необовʼязково: якщо не задано — рахує kindOf(desc)
 * @property {Array<{value:string,label:string,selected:boolean}>} [options]  для <select>
 */
//
// Опис iframe у ланцюгу фреймів (від зовнішнього до внутрішнього):
/**
 * @typedef {Object} IframeDesc
 * @property {?string} id
 * @property {?string} name
 * @property {?string} title
 * @property {?string} src
 * @property {?string} cssPath   CSS-шлях до <iframe> у батьківському документі
 * @property {number}  index     0-based індекс серед <iframe> батьківського документа
 */
//
// Локатор (елемент target.locs[]):
/**
 * @typedef {Object} Loc
 * @property {'testid'|'role'|'label'|'placeholder'|'name'|'id'|'type'|'text'|'css'} by
 * @property {string} [value]   значення (текст мітки/placeholder/атрибута/CSS)
 * @property {string} [attr]    для testid — назва атрибута (data-testid…)
 * @property {string} [role]    для role
 * @property {string} [name]    для role — accessible name
 * @property {boolean} [exact]
 * @property {string} [tag]     для name/type — тег у нижньому регістрі (input[name=…], input[type=…])
 * @property {?number} [nth]    для css — 0-based індекс серед збігів
 * @property {?number} [n]      кількість збігів, порахована під час запису
 */
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_LOCS = 5;
const ROLE_NAME_MAX = 80;
const TEXT_MAX = 50;
const LABEL_MAX = 80;

const norm = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());

// ---------- Стабільність токенів (id / класи / testid) ----------
// Відкидаємо згенеровані: CSS-in-JS (css-1x2y3z, sc-, jsx-123, emotion-…),
// CSS-модулі (Button_root__a1B2c), uuid, довгі цифри, hex-хеші, React useId
// (:r1:), автоідентифікатори бібліотек (headlessui-…, radix-…, react-select-2-…).
const GENERATED_PREFIX = /^(css|sc|astro|jsx|emotion|svelte|makeStyles|ng-tns|_ngcontent|_nghost|data-v|headlessui|radix|react-select|react-aria|mui-\d+|downshift|rc|chakra-\d+|yui|gwt-uid|tippy-\d+|popover-\d+|tooltip-\d+|jss\d+|ember\d+|ext-gen\d+)([-_:]|$)/i;
const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

export function isStableToken(tok) {
  const s = tok == null ? '' : String(tok);
  if (!s || s.length > 64) return false;
  if (/\s/.test(s)) return false;
  if (/[:«»{}]/.test(s)) return false;          // React useId (:r1:, «r1»), шаблони
  if (/^\d/.test(s)) return false;               // починається з цифри — згенероване/невалідний ident
  if (GENERATED_PREFIX.test(s)) return false;
  if (UUID.test(s)) return false;
  if (/\d{4,}/.test(s)) return false;            // довгі цифрові серії (id-1693…)
  if (/^[0-9a-f]{8,}$/i.test(s)) return false;   // чистий hex-хеш
  if (/__[A-Za-z0-9_-]{5,}$/.test(s) && /\d/.test(s.split('__').pop())) return false; // CSS-модулі
  // CSS-модулі Vite за замовчуванням: _<local>_<хеш5>_<рядок> — напр. _container_f7cvd_28
  // (хеш base64url, часто з однією цифрою або без — правило «≥2 цифри» його не ловить).
  if (/^_[A-Za-z][\w-]*_[A-Za-z0-9-]{5}_\d+$/.test(s)) return false;
  // webpack css-loader: <name>__<local>___<хеш>
  if (/___[A-Za-z0-9_-]{5,}$/.test(s)) return false;
  // CSS-модулі Next.js/CRA: <file>_<local>__<хеш5>. Файл буває з малої (page/layout/styles/index),
  // тож дивимось на хвіст: випадковий base64url-хеш складається лише з малих літер ~1% разів,
  // а BEM-подібний хвіст-слово (search_form__input) лишається стабільним.
  { const m = /^[A-Za-z][\w-]*_[A-Za-z][\w-]*__([A-Za-z0-9_-]{5})$/.exec(s);
    if (m && !/^[a-z]{5}$/.test(m[1])) return false; }
  // Turbopack / LightningCSS (Next.js 16 за замовчуванням): <file>-module__<хеш>__<local>
  // — напр. page-module__E0vvGG__main, Details-module-scss-module__MGoXJG__label.
  { const m = /-module__([A-Za-z0-9_-]{5,10})__[A-Za-z_]/.exec(s);
    if (m && !/^[a-z]+$/.test(m[1])) return false; }
  // сегмент ≥ 5 символів, де і літери, і ≥ 2 цифри → хеш (x7f3k, a1b2c3)
  for (const seg of s.split(/[-_]/)) {
    if (seg.length >= 5 && /[a-z]/i.test(seg) && (seg.match(/\d/g) || []).length >= 2) return false;
  }
  return true;
}

// ---------- Ролі та типи елементів ----------
const TEXTBOX_TYPES = new Set(['', 'text', 'email', 'tel', 'url']);
const BUTTON_TYPES = new Set(['button', 'submit', 'reset', 'image']);

// Неявна ARIA-роль (як її бачить getByRole), або явна з атрибута role.
export function implicitRole(d) {
  if (!d) return null;
  if (d.role) return String(d.role).trim().split(/\s+/)[0].toLowerCase() || null;
  const tag = String(d.tag || '').toUpperCase();
  const type = String(d.type || '').toLowerCase();
  switch (tag) {
    case 'BUTTON': return 'button';
    case 'A': case 'AREA': return d.href != null && d.href !== '' ? 'link' : null;
    case 'TEXTAREA': return 'textbox';
    case 'SELECT': return (d.multiple || Number(d.size) > 1) ? 'listbox' : 'combobox';
    case 'OPTION': return 'option';
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
    case 'IMG': return d.alt ? 'img' : null;
    case 'LI': return 'listitem';
    case 'NAV': return 'navigation';
    case 'DIALOG': return 'dialog';
    case 'INPUT':
      if (BUTTON_TYPES.has(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (TEXTBOX_TYPES.has(type)) return 'textbox';
      return null; // password, file, hidden, date… — без ролі для getByRole
  }
  if (d.editable) return 'textbox';
  return null;
}

// Тип цілі для UI/логіки: button | link | input | textarea | editable | select |
// file | checkbox | radio | other.
export function kindOf(d) {
  if (!d) return 'other';
  if (d.kind) return d.kind;
  const tag = String(d.tag || '').toUpperCase();
  const type = String(d.type || '').toLowerCase();
  if (tag === 'SELECT') return 'select';
  if (tag === 'TEXTAREA') return 'textarea';
  if (tag === 'INPUT') {
    if (type === 'file') return 'file';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (BUTTON_TYPES.has(type)) return 'button';
    if (type === 'hidden') return 'other';
    return 'input';
  }
  if (d.editable) return 'editable';
  const role = implicitRole(d);
  if (role === 'button') return 'button';
  if (role === 'link') return 'link';
  if (role === 'checkbox' || role === 'switch') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'textbox' || role === 'searchbox') return 'input';
  if (role === 'combobox' || role === 'listbox') return 'select';
  return 'other';
}

const EDITABLE_KINDS = new Set(['input', 'textarea', 'editable']);
export function isEditableKind(kind) { return EDITABLE_KINDS.has(kind); }

const KIND_WORD = {
  button: 'кнопка', link: 'посилання', input: 'поле', textarea: 'поле', editable: 'поле',
  select: 'список', file: 'поле файлу', checkbox: 'чекбокс', radio: 'перемикач', other: 'елемент',
};

export function truncate(s, max) {
  const t = norm(s);
  if (t.length <= max) return t;
  return t.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

// Людський опис цілі українською: «кнопка «Submit»», «поле «Email»».
export function describeTarget(d) {
  const kind = kindOf(d);
  const word = KIND_WORD[kind] || 'елемент';
  const nm = norm(d && (d.label || d.name || d.placeholder || d.text || d.nameAttr || d.alt || d.id));
  if (nm) return word + ' «' + truncate(nm, 40) + '»';
  if (kind === 'other' && d && d.tag) return word + ' <' + String(d.tag).toLowerCase() + '>';
  return word;
}

// ---------- CSS ----------
// Екранування значення для [attr="…"] (у подвійних лапках).
export function cssEscapeAttr(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\a ')
    .replace(/\0/g, '�');
}

// Поліфіл CSS.escape (CSSOM) для ідентифікаторів (#id, .class).
export function cssEscapeIdent(v) {
  const s = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i), c = s.charCodeAt(i);
    if (c === 0) { out += '�'; continue; }
    if ((c >= 1 && c <= 31) || c === 127 ||
        (i === 0 && c >= 48 && c <= 57) ||
        (i === 1 && c >= 48 && c <= 57 && s.charCodeAt(0) === 45)) {
      out += '\\' + c.toString(16) + ' '; continue;
    }
    if (i === 0 && c === 45 && s.length === 1) { out += '\\' + ch; continue; }
    if (c >= 128 || c === 45 || c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      out += ch; continue;
    }
    out += '\\' + ch;
  }
  return out;
}

// CSS-шлях із ланцюга предків (desc.path). Якщо в ланцюгу є стабільний id —
// починаємо з нього (найближчий до елемента). Хешовані класи відкидаємо; для
// кожного сегмента додаємо :nth-of-type, якщо він не перший серед братів.
export function buildCssPath(path) {
  if (!Array.isArray(path) || !path.length) return null;
  let start = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] && isStableToken(path[i].id)) { start = i; break; }
  }
  const parts = [];
  for (let i = start; i < path.length; i++) {
    const seg = path[i] || {};
    const tag = String(seg.tag || '*').toLowerCase();
    if (i === start && isStableToken(seg.id)) { parts.push(tag + '#' + cssEscapeIdent(seg.id)); continue; }
    if (tag === 'html' || tag === 'body') { parts.push(tag); continue; }
    const raw = seg.classes || [];
    // styled-components: поруч із sc-<componentId> ставить хеш із 5–8 літер змішаного регістру
    // (kQfLtv, bZkfAp) — він змінюється з кожним білдом. Звичайні класи (button, header) лишаємо.
    const styled = raw.some(c => /^sc-/.test(String(c)));
    const scHash = (c) => styled && /^(?=[A-Za-z]*[a-z])(?=[A-Za-z]*[A-Z])[A-Za-z]{5,8}$/.test(String(c));
    const cls = raw.filter(c => isStableToken(c) && !scHash(c)).slice(0, 2).map(c => '.' + cssEscapeIdent(c)).join('');
    const nth = Number(seg.nth) > 1 ? ':nth-of-type(' + Number(seg.nth) + ')' : '';
    parts.push(tag + cls + nth);
  }
  // Зрізаємо надто довгі шляхи: лишаємо останні 5 сегментів (і корінь-якір, якщо є id)
  if (parts.length > 6) {
    const anchored = isStableToken((path[start] || {}).id);
    const tail = parts.slice(-5);
    return (anchored ? parts[0] + ' ' : '') + tail.join(' > ');
  }
  return parts.join(' > ');
}

// ---------- Стабільність збереженого CSS-шляху ----------
// Токени .class / #id у CSS-рядку (з урахуванням \-екранування).
const CSS_TOKEN = /([.#])((?:\\.|[A-Za-z0-9_ -￿-])+)/g;
const unescapeIdent = (t) => t.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_m, e) => (/^[0-9a-fA-F]{1,6}\s?$/.test(e) ? String.fromCodePoint(parseInt(e, 16)) : e));

// Прибирає з CSS-шляху згенеровані класи (хеші CSS-модулів тощо): так старі записи
// (зроблені до фільтра) отримують шлях, що переживає деплой сайту. id не чіпаємо.
export function stripUnstableClasses(css) {
  const s = String(css == null ? '' : css);
  return s.replace(CSS_TOKEN, (m, kind, tok) => (kind === '.' && !isStableToken(unescapeIdent(tok)) ? '' : m));
}

// Чи CSS-шлях стабільний: без :nth-*, усі класи/id стабільні, і якір (клас/id) описує
// сам елемент, а не лише далекого предка. Голий «div > input» чи «div#root > div > div > input»
// — це структура DOM, а не ознака елемента. Правила: після останнього сегмента з якорем —
// щонайбільше 1 голий сегмент (сам елемент), і якір мають ≥ половини сегментів (крім html/body).
export function isStableCss(css) {
  const s = String(css == null ? '' : css).trim();
  if (!s || /:nth-|>>/.test(s)) return false;
  let anchors = 0, ok = true;
  s.replace(CSS_TOKEN, (_m, _kind, tok) => { anchors++; if (!isStableToken(unescapeIdent(tok))) ok = false; return ''; });
  if (!ok || !anchors) return false;
  // сегменти шляху (вміст [атрибутів] і лапок не ріжемо по пробілах/комбінаторах)
  const flat = s.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, '[]');
  const segs = flat.split(/\s*[>+~]\s*|\s+/).filter(x => x && !/^(html|body)$/i.test(x));
  const hasAnchor = (seg) => { CSS_TOKEN.lastIndex = 0; const r = CSS_TOKEN.test(seg); CSS_TOKEN.lastIndex = 0; return r; };
  const anchored = segs.filter(hasAnchor).length;
  let bareTail = 0;
  for (let i = segs.length - 1; i >= 0 && !hasAnchor(segs[i]); i--) bareTail++;
  return anchored > 0 && bareTail <= 1 && anchored * 2 >= segs.length;
}

// ---------- Кандидати ----------
function locKey(l) {
  if (!l) return '';
  return [l.by, l.attr || '', l.role || '', l.name || '', l.value || '', l.tag || '', l.nth == null ? '' : l.nth].join('\u0001');
}
export { locKey };

// Кандидати-локатори з опису елемента, у порядку пріоритету:
// testid → role+name (≤80) → label → placeholder → [name] → стабільний #id →
// тип поля (лише для файлу: input[type=file]) → короткий текст → CSS-шлях (+nth).
// Хешовані/згенеровані токени (зокрема класи CSS-модулів) відкидаються.
export function buildCandidates(d) {
  if (!d) return [];
  const out = [];
  const seen = new Set();
  const push = (l) => { const k = locKey(l); if (!seen.has(k)) { seen.add(k); out.push(l); } };
  const kind = kindOf(d);
  const editable = isEditableKind(kind) || kind === 'select' || kind === 'file';
  const tag = String(d.tag || '').toLowerCase();

  if (d.testid && d.testid.value != null) {
    const v = String(d.testid.value);
    if (v && v.length <= 100 && !UUID.test(v) && !/\d{6,}/.test(v)) {
      push({ by: 'testid', attr: d.testid.attr || 'data-testid', value: v });
    }
  }
  const role = implicitRole(d);
  const name = norm(d.name);
  if (role && name && name.length <= ROLE_NAME_MAX) push({ by: 'role', role, name, exact: true });
  const label = norm(d.label);
  if (label && label.length <= LABEL_MAX && (editable || kind === 'checkbox' || kind === 'radio')) {
    push({ by: 'label', value: label, exact: true });
  }
  const ph = norm(d.placeholder);
  if (ph && ph.length <= LABEL_MAX) push({ by: 'placeholder', value: ph, exact: true });
  if (d.nameAttr && String(d.nameAttr).length <= 100 && !UUID.test(d.nameAttr) && !/\d{6,}/.test(d.nameAttr)) {
    push({ by: 'name', tag: tag || undefined, value: String(d.nameAttr) });
  }
  if (isStableToken(d.id)) push({ by: 'id', value: String(d.id) });
  // Поле файлу часто приховане й без жодної семантики (підпису/name/id/testid) — тоді
  // тип поля в межах свого фрейму стабільніший за CSS-шлях: не залежить ні від верстки,
  // ні від класів. Унікальне (n=1) — 🎯; кілька — вирішує найближчий бокс.
  if (kind === 'file') push({ by: 'type', tag: 'input', value: 'file' });
  const text = norm(d.text);
  if (text && text.length <= TEXT_MAX && !isEditableKind(kind) && kind !== 'select') {
    push({ by: 'text', value: text, exact: true });
  }
  const css = Array.isArray(d.path) && d.path.length ? buildCssPath(d.path) : (d.cssPath ? String(d.cssPath) : null);
  if (css) push({ by: 'css', value: css, nth: Number.isInteger(d.nth) ? d.nth : null });
  return out;
}

// Ранжування з лічильниками збігів (counts[i] — для cands[i]; null = невідомо,
// напр. вийшов бюджет часу). Порядок груп: рівно 1 збіг → невідомо → >1 збігу;
// 0 збігів — відкидаємо (на момент запису не знаходить нічого). Усередині групи
// — вихідний пріоритет. Обрізаємо до max, але ЗАВЖДИ лишаємо CSS-кандидата як
// не-текстову альтернативу (імена залежать від локалі).
export function rankWithCounts(cands, counts, max = MAX_LOCS) {
  const list = (cands || []).map((c, i) => {
    const raw = counts ? counts[i] : undefined;
    const n = Number.isFinite(raw) ? raw : null;
    return { c: { ...c, n }, i, n };
  });
  const group = (e) => (e.n === 1 ? 0 : e.n == null ? 1 : 2);
  let ranked = list.filter(e => e.n !== 0).sort((a, b) => group(a) - group(b) || a.i - b.i);
  if (!ranked.length) ranked = list; // усі 0 — краще щось, ніж нічого (поза DOM-моментом)
  let res = ranked.slice(0, max);
  const cssOut = ranked.slice(max).find(e => e.c.by === 'css');
  if (cssOut && !res.some(e => e.c.by === 'css')) res = [...res.slice(0, max - 1), cssOut];
  return res.map(e => e.c);
}

// ---------- Ціль ----------
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Збирає target для кроку з опису елемента.
//   opts.frame  — специфікація фрейму (frameSpecFrom) або null
//   opts.point  — {x,y} точка кліку в тих самих координатах, що й desc.box → rel
//   opts.counts — лічильники для buildCandidates(desc) (той самий порядок)
export function targetFromDesc(d, { frame = null, point = null, counts = null, max = MAX_LOCS } = {}) {
  const cands = buildCandidates(d);
  const locs = counts ? rankWithCounts(cands, counts, max) : rankWithCounts(cands, null, max);
  const box = d && d.box ? { x: Math.round(d.box.x), y: Math.round(d.box.y), w: Math.round(d.box.w), h: Math.round(d.box.h) } : null;
  let rel = { rx: 0.5, ry: 0.5 };
  if (point && box && box.w > 0 && box.h > 0) {
    rel = { rx: r3(clamp((point.x - box.x) / box.w, 0, 1)), ry: r3(clamp((point.y - box.y) / box.h, 0, 1)) };
  }
  return {
    frame: frame || null,
    locs,
    pick: locs.length ? 0 : -1,
    rel,
    box,
    tag: d && d.tag ? String(d.tag).toUpperCase() : null,
    kind: kindOf(d),
    desc: describeTarget(d),
  };
}

// ---------- Фрейми ----------
// CSS-селектор <iframe> у батьківському документі (для frameLocator).
export function frameSelector(f) {
  if (!f) return 'iframe';
  if (isStableToken(f.id)) return 'iframe#' + cssEscapeIdent(f.id);
  if (f.name && isStableToken(f.name)) return 'iframe[name="' + cssEscapeAttr(f.name) + '"]';
  if (f.title && norm(f.title).length <= 80) return 'iframe[title="' + cssEscapeAttr(norm(f.title)) + '"]';
  const pat = f.src ? frameUrlPattern(f.src) : null;
  if (pat) {
    const prefix = pat.replace(/\*$/, '').replace(/\/$/, '');
    if (prefix) return 'iframe[src^="' + cssEscapeAttr(prefix) + '"]';
  }
  if (f.cssPath) return String(f.cssPath);
  return 'iframe >> nth=' + (Number.isInteger(f.index) ? f.index : 0);
}

function parseUrl(url) {
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)/i.exec(String(url || ''));
  if (!m) return null;
  return { origin: (m[1] + '//' + m[2]).toLowerCase(), path: m[3] || '/' };
}

// origin + pathname (без query/hash) — для точного порівняння фреймів.
export function originPath(url) {
  const p = parseUrl(url);
  return p ? p.origin + p.path : null;
}

function dynamicSegment(seg) {
  if (!seg) return false;
  let s = seg;
  try { s = decodeURIComponent(seg); } catch (_e) { /* як є */ }
  return UUID.test(s) || /\d{3,}/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || !isStableToken(s.replace(/[.~]/g, '-'));
}

// URL-глоб для фрейму: origin + стабільні сегменти шляху + '*'. Динамічні
// сегменти (uuid, номери, хеші) і все після них замінюються на '*'.
// 'https://jobs.ashbyhq.com/preply/<uuid>/application?x' → 'https://jobs.ashbyhq.com/preply/*'
export function frameUrlPattern(url) {
  const p = parseUrl(url);
  if (!p || !/^https?:/.test(p.origin)) return null;
  const segs = p.path.split('/').filter(Boolean);
  const keep = [];
  for (const s of segs) { if (dynamicSegment(s)) break; keep.push(s); }
  if (keep.length < segs.length) return p.origin + '/' + keep.map(s => s + '/').join('') + '*';
  return p.origin + '/' + keep.join('/') + '*';
}

// Глоб: '*' — будь-які символи (включно з '/'), інше — буквально; повний збіг.
export function matchGlob(pattern, str) {
  if (pattern == null) return false;
  const re = '^' + String(pattern).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
  return new RegExp(re).test(String(str == null ? '' : str));
}

// Специфікація фрейму для target.frame. iframes — ланцюг IframeDesc від
// зовнішнього до внутрішнього; info — {url, name, index} самого фрейму (index —
// позиція в списку дочірніх фреймів сторінки на момент запису).
export function frameSpecFrom(iframes, info = {}) {
  if (!iframes || !iframes.length) return null;
  return {
    chain: iframes.map(frameSelector),
    url: info.url ? frameUrlPattern(info.url) : null,
    path: info.url ? originPath(info.url) : null,
    name: info.name || '',
    index: Number.isInteger(info.index) ? info.index : 0,
  };
}

// Пошук фрейму серед простих обʼєктів {url, name, index?}. Порядок:
// origin+pathname → URL-глоб → name → index. Index-фолбек — лише коли спец не
// має URL або opts.loose (інакше фрейм, мабуть, ще не завантажився — краще
// почекати, ніж клікнути в чужий). Повертає {frame, i, by} або null.
export function matchFrame(frames, spec, { loose = false } = {}) {
  if (!Array.isArray(frames) || !frames.length || !spec) return null;
  const list = frames.map((f, i) => ({ f, i }));
  const narrow = (cands) => {
    if (cands.length <= 1) return cands[0] || null;
    if (spec.name) { const byName = cands.filter(c => c.f.name === spec.name); if (byName.length) cands = byName; }
    if (cands.length === 1) return cands[0];
    const idx = Number.isInteger(spec.index) ? spec.index : 0;
    return cands.slice().sort((a, b) => Math.abs(fi(a) - idx) - Math.abs(fi(b) - idx))[0];
  };
  const fi = (c) => (Number.isInteger(c.f.index) ? c.f.index : c.i);
  const out = (c, by) => (c ? { frame: c.f, i: c.i, by } : null);
  if (spec.path) {
    const c = list.filter(e => originPath(e.f.url) === spec.path);
    if (c.length) return out(narrow(c), 'path');
  }
  if (spec.url) {
    const c = list.filter(e => matchGlob(spec.url, e.f.url));
    if (c.length) return out(narrow(c), 'url');
  }
  if (spec.name) {
    const c = list.filter(e => e.f.name === spec.name);
    if (c.length) return out(narrow(c), 'name');
  }
  if ((!spec.url && !spec.path) || loose) {
    const idx = Number.isInteger(spec.index) ? spec.index : 0;
    const c = list.find(e => fi(e) === idx);
    if (c) return out(c, 'index');
  }
  return null;
}

// ---------- Геометрія ----------
// Індекс боксу з найближчим центром до записаного box. null-бокси пропускаються.
// Повертає {index, dist} (index -1, dist Infinity — якщо нічого).
export function pickNearest(boxes, box) {
  let best = -1, bestD = Infinity;
  if (!Array.isArray(boxes) || !box) return { index: -1, dist: Infinity };
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  boxes.forEach((b, i) => {
    if (!b) return;
    const d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
    if (d < bestD) { bestD = d; best = i; }
  });
  return { index: best, dist: best < 0 ? Infinity : Math.round(bestD) };
}

// Точка всередині боксу: rel {rx,ry} (0..1) + джитер ±jitter, затиснуто в 10–90%
// розміру (щоб не влучати в край/рамку). rnd — інʼєкований генератор [0,1).
export function pointInBox(box, rel, jitter = 0, rnd = Math.random) {
  if (!box) return null;
  const rx0 = rel && Number.isFinite(rel.rx) ? rel.rx : 0.5;
  const ry0 = rel && Number.isFinite(rel.ry) ? rel.ry : 0.5;
  const j = Number(jitter) || 0;
  const rx = clamp(rx0 + (j ? (rnd() * 2 - 1) * j : 0), 0.1, 0.9);
  const ry = clamp(ry0 + (j ? (rnd() * 2 - 1) * j : 0), 0.1, 0.9);
  return { x: Math.round((box.x + rx * box.w) * 10) / 10, y: Math.round((box.y + ry * box.h) * 10) / 10 };
}

// ---------- Відображення / Playwright ----------
const q = (s) => JSON.stringify(String(s));

// CSS-селектор для локаторів, що виражаються через locator(css).
function cssFor(l) {
  if (l.by === 'testid') return '[' + (l.attr || 'data-testid') + '="' + cssEscapeAttr(l.value) + '"]';
  if (l.by === 'name') return (l.tag || '') + '[name="' + cssEscapeAttr(l.value) + '"]';
  if (l.by === 'id') return '#' + cssEscapeIdent(l.value);
  if (l.by === 'type') return (l.tag || 'input') + '[type="' + cssEscapeAttr(l.value) + '"]';
  if (l.by === 'css') return String(l.value);
  return null;
}

// Короткий рядок локатора для UI (Playwright-подібний синтаксис).
export function specToString(l) {
  if (!l) return '📍 координати';
  let s;
  switch (l.by) {
    case 'testid': s = cssFor(l); break;
    case 'role': s = 'role=' + l.role + (l.name ? '[name=' + q(truncate(l.name, 40)) + ']' : ''); break;
    case 'label': s = 'label=' + q(truncate(l.value, 40)); break;
    case 'placeholder': s = 'placeholder=' + q(truncate(l.value, 40)); break;
    case 'text': s = 'text=' + q(truncate(l.value, 40)); break;
    case 'name': case 'id': case 'type': case 'css': s = cssFor(l); break;
    default: s = String(l.by);
  }
  if (l.nth != null && l.by === 'css') s += ' >> nth=' + l.nth;
  return s;
}

// Дескриптор виклику Playwright, який застосовує сервер:
//   scope[method](...args) і, якщо nth != null, .nth(nth).
export function toPlaywright(l) {
  if (!l) return null;
  const withNth = (d) => (l.by === 'css' && l.nth != null ? { ...d, nth: l.nth } : d);
  switch (l.by) {
    case 'testid':
      if ((l.attr || 'data-testid') === 'data-testid') return { method: 'getByTestId', args: [String(l.value)] };
      return { method: 'locator', args: [cssFor(l)] };
    case 'role':
      return { method: 'getByRole', args: l.name ? [l.role, { name: l.name, exact: l.exact !== false }] : [l.role] };
    case 'label': return { method: 'getByLabel', args: [String(l.value), { exact: l.exact !== false }] };
    case 'placeholder': return { method: 'getByPlaceholder', args: [String(l.value), { exact: l.exact !== false }] };
    case 'text': return { method: 'getByText', args: [String(l.value), { exact: l.exact !== false }] };
    case 'name': case 'id': case 'type': case 'css': return withNth({ method: 'locator', args: [cssFor(l)] });
    default: return null;
  }
}
