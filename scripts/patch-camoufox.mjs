// Автопатч camoufox-js: у версії 0.10.2 генератор fingerprint видає навігатор-
// властивості (navigator.product, appCodeName тощо), яких немає в properties.json,
// і власний валідатор падає з UnknownProperty. Робимо валідатор поблажливим —
// невідомі властивості пропускаємо замість кидання помилки.
// Запускається автоматично через "postinstall", тож переживає npm install.
import fs from 'fs';

const file = 'node_modules/camoufox-js/dist/utils.js';

try {
  if (!fs.existsSync(file)) {
    console.log('[patch-camoufox] camoufox-js не знайдено — пропускаю');
    process.exit(0);
  }
  let s = fs.readFileSync(file, 'utf8');

  if (s.includes('/* CAMOUFOX_PATCHED */')) {
    console.log('[patch-camoufox] вже пропатчено');
    process.exit(0);
  }

  // Замінюємо `throw new UnknownProperty(...)` на `continue` у циклі валідатора.
  const re = /throw new UnknownProperty\(`Unknown property \$\{key\} in config`\);/;
  if (re.test(s)) {
    s = s.replace(re, 'continue; /* CAMOUFOX_PATCHED: skip unknown props */');
    fs.writeFileSync(file, s);
    console.log('[patch-camoufox] пропатчено ✅');
  } else {
    console.log('[patch-camoufox] шаблон не знайдено — можливо, інша версія camoufox-js');
  }
} catch (e) {
  console.log('[patch-camoufox] пропущено:', e.message);
}
