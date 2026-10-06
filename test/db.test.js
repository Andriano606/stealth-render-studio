// Юніт-тести репозиторіїв БД (lib/db.js) з фейковим query — без Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepos, seedPresets, initDb, BUILTIN_PRESETS, redactDbUrl } from '../lib/db.js';

function fakeQ(responder = () => ({ rows: [] })) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return responder(sql, params); } };
}
const quiet = { log() {}, error() {} };

test('pages.list: id → Number (BIGINT приходить рядком)', async () => {
  const q = fakeQ(() => ({ rows: [{ id: '3', name: 'S', url: 'u', recs: [] }] }));
  const rows = await createRepos(q).pages.list();
  assert.deepEqual(rows, [{ id: 3, name: 'S', url: 'u', recs: [] }]);
  assert.match(q.calls[0].sql, /FROM pages ORDER BY id ASC/);
});

test('pages.upsert: дефолтні name/url і JSON recs', async () => {
  const q = fakeQ();
  await createRepos(q).pages.upsert(7, { recs: [{ id: 1, subs: [] }] });
  assert.deepEqual(q.calls[0].params, [7, 'Сторінка 7', '', '[{"id":1,"subs":[]}]']);
  assert.match(q.calls[0].sql, /ON CONFLICT \(id\) DO UPDATE/);
});

test('presets: create/update/remove (builtin не видаляється)', async () => {
  const q = fakeQ((sql) => (/RETURNING id/.test(sql) ? { rows: [{ id: '12' }] } : { rows: [] }));
  const r = createRepos(q).presets;
  assert.equal(await r.create({ body: { a: 1 } }), 12);
  assert.deepEqual(q.calls[0].params, ['Новий пресет', '{"a":1}']);
  await r.update(5, { name: 'X' });
  assert.deepEqual(q.calls[1].params, [5, 'X', null]); // body не передано → COALESCE лишає старе
  await r.remove(5);
  assert.match(q.calls[2].sql, /builtin = false/);
});

test('seedPresets: лише в порожню таблицю', async () => {
  const empty = fakeQ((sql) => (/COUNT/.test(sql) ? { rows: [{ n: 0 }] } : { rows: [] }));
  assert.equal(await seedPresets(empty, quiet), true);
  assert.equal(empty.calls.filter((c) => /INSERT INTO presets/.test(c.sql)).length, BUILTIN_PRESETS.length);
  const full = fakeQ(() => ({ rows: [{ n: 4 }] }));
  assert.equal(await seedPresets(full, quiet), false);
  assert.equal(full.calls.length, 1);
});

test('пресет Ashby тримає siteIsolationDisabled=true; «All» видалено з вбудованих', () => {
  assert.equal(BUILTIN_PRESETS.find((p) => p.name === '📋 Ashby').body.launch.siteIsolationDisabled, true);
  assert.equal(BUILTIN_PRESETS.some((p) => /All$/.test(p.name) && !/Clear/.test(p.name)), false);
  assert.deepEqual(BUILTIN_PRESETS.map((p) => p.name), ['🧹 Clear all', '☁️ Cloudflare', '📋 Ashby']);
});

test('initDb: недоступна БД → null (режим у пам\'яті), пул закрито', async () => {
  let ended = false;
  class FailPool { async query() { throw new Error('ECONNREFUSED'); } async end() { ended = true; } on() {} }
  assert.equal(await initDb('postgres://x@h/db', { log: quiet, Pool: FailPool }), null);
  assert.equal(ended, true);
});

test('initDb: успіх → репозиторії', async () => {
  class OkPool { async query(sql) { return /COUNT/.test(sql) ? { rows: [{ n: 1 }] } : { rows: [] }; } async end() {} on() {} }
  const db = await initDb('postgres://x@h/db', { log: quiet, Pool: OkPool });
  assert.ok(db.pages && db.presets && db.recordings);
});

test('redactDbUrl: ховає пароль', () => {
  assert.equal(redactDbUrl('postgres://u:secret@h:5432/db'), 'postgres://u:***@h:5432/db');
  assert.equal(redactDbUrl('postgres://u@h/db'), 'postgres://u@h/db');
});
