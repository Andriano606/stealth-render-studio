// Юніт-тести репозиторіїв БД (lib/db.js) з фейковим query — без Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepos, seedPresets, initDb, BUILTIN_PRESETS, redactDbUrl, withTransaction } from '../lib/db.js';

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
  assert.match(q.calls[2].sql, /DELETE FROM presets WHERE id = \$1 RETURNING id/);
  assert.doesNotMatch(q.calls[2].sql, /builtin/, 'вбудовані теж можна видаляти');
});

test('presets.update: RETURNING id → true/false', async () => {
  const hit = createRepos(fakeQ(() => ({ rows: [{ id: 6 }] })));
  assert.equal(await hit.presets.update(6, { name: 'X' }), true);
  const miss = createRepos(fakeQ(() => ({ rows: [] })));
  assert.equal(await miss.presets.update(99, { name: 'X' }), false);
});

test('presets.remove: true — видалено, false — не знайдено', async () => {
  const hit = createRepos(fakeQ(() => ({ rows: [{ id: 5 }] })));
  assert.equal(await hit.presets.remove(5), true);
  const miss = createRepos(fakeQ(() => ({ rows: [] })));
  assert.equal(await miss.presets.remove(99), false);
});

// Фейкова БД для засівання: app_meta + лічильник пресетів.
function seedDb({ seeded = false, n = 0 } = {}) {
  return fakeQ((sql) => {
    if (/FROM app_meta/.test(sql)) return { rows: seeded ? [{ value: '1' }] : [] };
    if (/COUNT/.test(sql)) return { rows: [{ n }] };
    return { rows: [] };
  });
}

test('seedPresets: нова БД — засіяти вбудовані й поставити прапорець', async () => {
  const q = seedDb();
  assert.equal(await seedPresets(q, quiet), true);
  assert.equal(q.calls.filter((c) => /INSERT INTO presets/.test(c.sql)).length, BUILTIN_PRESETS.length);
  assert.ok(q.calls.some((c) => /INSERT INTO app_meta/.test(c.sql)));
});

test('seedPresets: наявна БД з пресетами — лише прапорець, без вставок', async () => {
  const q = seedDb({ n: 4 });
  assert.equal(await seedPresets(q, quiet), false);
  assert.equal(q.calls.filter((c) => /INSERT INTO presets/.test(c.sql)).length, 0);
  assert.ok(q.calls.some((c) => /INSERT INTO app_meta/.test(c.sql)));
});

test('seedPresets: уже засіяно, а користувач видалив УСІ пресети — вбудовані НЕ повертаються', async () => {
  const q = seedDb({ seeded: true, n: 0 });
  assert.equal(await seedPresets(q, quiet), false);
  assert.equal(q.calls.length, 1, 'лише перевірка прапорця');
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

test('withTransaction: BEGIN → fn(репозиторії на тому самому клієнті) → COMMIT; збій → ROLLBACK, клієнт звільнено', async () => {
  const mk = () => {
    const c = fakeQ((sql) => (/RETURNING id/.test(sql) ? { rows: [{ id: '5' }] } : { rows: [] }));
    c.released = 0; c.release = () => { c.released++; };
    return c;
  };
  const c1 = mk();
  const r = await withTransaction({ connect: async () => c1 }, async (repos) => repos.presets.create({ name: 'P', body: {} }));
  assert.equal(r, 5);
  assert.deepEqual(c1.calls.map((x) => x.sql.split(' ')[0]), ['BEGIN', 'INSERT', 'COMMIT']);
  assert.equal(c1.released, 1);
  const c2 = mk();
  await assert.rejects(withTransaction({ connect: async () => c2 }, async (repos) => { await repos.pages.upsert(1, {}); throw new Error('boom'); }), /boom/);
  assert.deepEqual(c2.calls.map((x) => x.sql.split(' ')[0]), ['BEGIN', 'INSERT', 'ROLLBACK']);
  assert.equal(c2.released, 1);
});
