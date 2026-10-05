// Простий семафор: обмежує кількість одночасних контекстів/рендерів.
// acquire(timeoutMs?, { signal }?) — чекає вільний слот; із таймаутом відхиляє
// Promise помилкою з code='ETIMEDOUT'; з AbortSignal — помилкою name='AbortError'
// (code='ABORT_ERR'), щойно сигнал перервано. В обох випадках очікувач прибирає
// себе з черги, тож release() не віддасть слот «мертвому» очікувачу.

const abortError = () => Object.assign(new Error('Скасовано (чекав вільний слот)'), { name: 'AbortError', code: 'ABORT_ERR' });

export function createSemaphore(max) {
  let active = 0;
  const queue = []; // [{ grant }]

  function acquire(timeoutMs, { signal = null } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { grant: null, timer: null };
      const leave = () => {
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { leave(); reject(abortError()); };
      waiter.grant = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      };
      if (timeoutMs != null && timeoutMs >= 0) {
        waiter.timer = setTimeout(() => {
          leave();
          const err = new Error('Немає вільного слота за ' + timeoutMs + ' мс');
          err.code = 'ETIMEDOUT';
          err.status = 503;
          reject(err);
        }, timeoutMs);
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }

  function release() {
    const next = queue.shift();
    if (next) { next.grant(); return; } // слот одразу переходить наступному (active не змінюється)
    if (active > 0) active--;
  }

  // Виконує fn під дозволом і ЗАВЖДИ звільняє слот.
  async function withPermit(fn, timeoutMs) {
    await acquire(timeoutMs);
    try { return await fn(); } finally { release(); }
  }

  return {
    acquire, release, withPermit,
    get active() { return active; },
    get waiting() { return queue.length; },
    get max() { return max; },
  };
}
