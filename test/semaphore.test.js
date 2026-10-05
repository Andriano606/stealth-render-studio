// Юніт-тести семафора (lib/semaphore.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSemaphore } from '../lib/semaphore.js';

const tick = () => new Promise((r) => setImmediate(r));

test('semaphore: пропускає до max, решта чекає в черзі FIFO', async () => {
  const s = createSemaphore(2);
  await s.acquire(); await s.acquire();
  assert.equal(s.active, 2);
  const order = [];
  const p3 = s.acquire().then(() => order.push(3));
  const p4 = s.acquire().then(() => order.push(4));
  await tick();
  assert.deepEqual(order, []);
  assert.equal(s.waiting, 2);
  s.release(); await p3;
  assert.deepEqual(order, [3]);
  assert.equal(s.active, 2); // слот перейшов до наступного
  s.release(); await p4;
  assert.deepEqual(order, [3, 4]);
  s.release(); s.release();
  assert.equal(s.active, 0);
  s.release(); // зайвий release не йде в мінус
  assert.equal(s.active, 0);
});

test('semaphore: acquire з таймаутом відхиляється і звільняє місце в черзі', async () => {
  const s = createSemaphore(1);
  await s.acquire();
  await assert.rejects(s.acquire(20), (e) => e.code === 'ETIMEDOUT' && e.status === 503);
  assert.equal(s.waiting, 0);
  s.release();
  assert.equal(s.active, 0);
  await s.acquire(20); // тепер вільно — одразу
  assert.equal(s.active, 1);
});

test('semaphore: таймаут не спрацьовує, якщо слот звільнився вчасно', async () => {
  const s = createSemaphore(1);
  await s.acquire();
  const p = s.acquire(200);
  setTimeout(() => s.release(), 10);
  await p;
  assert.equal(s.active, 1);
});

test('semaphore: withPermit завжди звільняє слот (і при помилці)', async () => {
  const s = createSemaphore(1);
  assert.equal(await s.withPermit(async () => 42), 42);
  await assert.rejects(s.withPermit(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(s.active, 0);
});

test('semaphore: abort поки в черзі → AbortError, очікувача прибрано; release не віддає слот «мертвому»', async () => {
  const s = createSemaphore(1);
  await s.acquire();
  const ac = new AbortController();
  const p = s.acquire(undefined, { signal: ac.signal });
  await tick();
  assert.equal(s.waiting, 1);
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError' && e.code === 'ABORT_ERR');
  assert.equal(s.waiting, 0);
  s.release();
  assert.equal(s.active, 0); // слот звільнено, а не передано скасованому
});

test('semaphore: уже перерваний signal → одразу відмова (навіть якщо слот вільний)', async () => {
  const s = createSemaphore(2);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(s.acquire(undefined, { signal: ac.signal }), { name: 'AbortError' });
  assert.equal(s.active, 0);
});

test('semaphore: abort ПІСЛЯ отримання слота нічого не ламає (слот тримається до release)', async () => {
  const s = createSemaphore(1);
  await s.acquire();
  const ac = new AbortController();
  const p = s.acquire(undefined, { signal: ac.signal });
  s.release();
  await p;
  ac.abort(); // слухач уже знято — без побічних ефектів
  assert.equal(s.active, 1);
  assert.equal(s.waiting, 0);
  s.release();
  assert.equal(s.active, 0);
});
