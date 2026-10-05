// Шаблон тексту під-дії (чиста функція, без Node-імпортів — придатна і для браузера):
//   {d}  → випадкова цифра 0-9
//   {l}  → випадкова англ. літера a-z
//   {{   → літерал «{»
// Будь-що інше (у т.ч. одинокі «{», «}», «{x}») лишається як є, тож старі
// 1-символьні текстові під-дії відтворюються без змін.
export function expandTemplate(text, rng = Math.random) {
  const s = String(text == null ? '' : text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      if (s[i + 1] === '{') { out += '{'; i++; continue; }
      if (s[i + 2] === '}' && s[i + 1] === 'd') { out += String(Math.floor(rng() * 10) % 10); i += 2; continue; }
      if (s[i + 2] === '}' && s[i + 1] === 'l') { out += String.fromCharCode(97 + (Math.floor(rng() * 26) % 26)); i += 2; continue; }
    }
    out += c;
  }
  return out;
}

// Текст legacy-під-дії: поле random ('digit'|'letter') має пріоритет (старий
// перемикач 🔒/🎲), інакше — шаблон.
export function stepText(a, rng = Math.random) {
  if (a && a.random === 'digit') return String(Math.floor(rng() * 10) % 10);
  if (a && a.random === 'letter') return String.fromCharCode(97 + (Math.floor(rng() * 26) % 26));
  return expandTemplate(a && a.text, rng);
}
