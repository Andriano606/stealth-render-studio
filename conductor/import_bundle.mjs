// Conductor SETUP helper: імпортує бандл (📦 пресети + сценарії + файли кроків) у
// БД воркспейсу. Викликається з setup.rb ПІСЛЯ `npm ci`:
//
//   node conductor/import_bundle.mjs <workspace_root> <bundle.json>
//   (ENV: DATABASE_URL, UPLOAD_DIR — ті самі, що app_env у conductor_helpers.rb)
//
// Застосунок не змінюється й не запускається (жодного браузера): беремо код
// САМОГО воркспейсу — initDb (таблиці + одноразове засівання вбудованих
// пресетів) і авторитетний роут POST /import (parseBundle → planImport →
// одна транзакція) — та викликаємо його на тимчасовому порту 127.0.0.1.
// Стратегія конфліктів — replace і для пресетів, і для сценаріїв: однойменні
// вбудовані («🧹 Clear all», «☁️ Cloudflare», «📋 Ashby») перезаписуються
// версією з бандла; однаковий зміст → пропуск, тож повторний запуск безпечний.
//
// Файли кроків (base64 у bundle.files) кладемо в UPLOAD_DIR воркспейсу з ТИМ
// САМИМ fileId — посилання в кроках лишаються валідними без remapFileRefs.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const [workspace, bundlePath] = process.argv.slice(2);
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };
if (!workspace || !bundlePath) fail('usage: import_bundle.mjs <workspace_root> <bundle.json>');

const { DATABASE_URL, UPLOAD_DIR } = process.env;
if (!DATABASE_URL || !UPLOAD_DIR) fail('DATABASE_URL і UPLOAD_DIR мають бути задані');

const appModule = (rel) => import(pathToFileURL(path.join(workspace, rel)).href);
const express = createRequire(path.join(workspace, 'package.json'))('express');
const { initDb } = await appModule('lib/db.js');
const { transferRoutes, IMPORT_PATH } = await appModule('routes/transfer.js');
const { resolveUpload } = await appModule('lib/uploads.js');

let bundle;
try {
  bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
} catch (e) {
  fail('не вдалося прочитати бандл ' + bundlePath + ': ' + e.message);
}

const quiet = { log: () => {}, error: (...a) => console.error(...a) };
const db = await initDb(DATABASE_URL, { log: quiet });
if (!db) fail('БД недоступна: ' + DATABASE_URL.replace(/(\/\/[^:/@]+):[^@]*@/, '$1:***@'));

try {
  // 1) файли кроків — з тим самим fileId (resolveUpload валідує id і чистить імʼя)
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  let written = 0;
  for (const f of Array.isArray(bundle.files) ? bundle.files : []) {
    if (!f || typeof f.data !== 'string') continue;
    const dest = resolveUpload(UPLOAD_DIR, f.fileId, f.filename, () => true);
    if (!dest || fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(f.data, 'base64'));
    written += 1;
  }
  if (written) console.log('   📎 файлів кроків записано: ' + written);

  // 2) пресети + сценарії — через роут застосунку
  const app = express();
  app.use(transferRoutes({
    config: { UPLOAD_DIR, IMPORT_JSON_LIMIT: '200mb' },
    getDb: () => db,
    log: quiet,
  }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + IMPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle, onConflict: { presets: 'replace', scenarios: 'replace' } }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) fail('імпорт відхилено (' + res.status + '): ' + (out.error || 'невідома помилка'));

    const line = (p) => '      ' + ({ create: '＋', replace: '↻', skip: '=' }[p.action] || '·') + ' ' + p.name +
      (p.action === 'skip' && p.reason ? '  (' + p.reason + ')' : '');
    if (out.presets.length) console.log('   пресети:\n' + out.presets.map(line).join('\n'));
    if (out.scenarios.length) console.log('   сценарії:\n' + out.scenarios.map(line).join('\n'));
    for (const w of out.warnings) console.log('   ⚠️  ' + w);
    console.log('   📥 ' + out.summary);
  } finally {
    server.close();
  }
} finally {
  await db.end().catch(() => {});
}
