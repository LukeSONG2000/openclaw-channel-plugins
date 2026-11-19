export function createJobPool({ concurrency = 4, queueLimit = 8, waitMs = 35_000 } = {}) {
  let active = 0;
  const pending = [];
  function next() {
    const item = pending.shift();
    if (item) {
      clearTimeout(item.timer);
      item.resolve(next);
    } else active--;
  }
  return {
    acquire() {
      if (active < concurrency) {
        active++;
        return Promise.resolve(next);
      }
      if (pending.length >= queueLimit) return Promise.resolve(null);
      return new Promise(resolve => {
        const item = { resolve, timer: setTimeout(() => {
          pending.splice(pending.indexOf(item), 1);
          resolve(null);
        }, waitMs) };
        pending.push(item);
      });
    },
  };
}
