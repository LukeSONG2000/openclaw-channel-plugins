const accountFailure = new Set(['quota', 'rate_limit', 'auth']);
const plannerTransient = new Set(['timeout', 'upstream', 'provider', 'transport_uncertain']);

// A reachability check is read-only; a render is not. Only definite rejections may repeat a render.
export async function runProviderJob({
  phase, keys, startAt, routes, check, refresh, attempt, signal, onRetry = () => {}, now = Date.now,
  deadline: jobDeadline = Infinity,
}) {
  const planning = phase === 'plan';
  const deadline = Math.min(jobDeadline, now() + (planning ? 105_000 : 195_000));
  const attemptTimeout = planning ? 45_000 : 180_000;
  const maxAttempts = planning ? 3 : 2;
  const order = keys.map((_, i) => (startAt + i) % keys.length);
  const skipAccount = new Set();
  let lastFailure;
  let attempts = 0;
  for (let round = 0; round < 2; round++) {
    let needsRefresh = false;
    for (const route of routes) {
      let tested = false;
      let passed = false;
      for (const index of order) {
        if (skipAccount.has(index)) continue;
        signal?.throwIfAborted();
        const remaining = deadline - now();
        if (remaining < 1000) throw lastFailure ?? new Error('no_provider');
        tested = true;
        if (!await check(keys[index], route, Math.min(remaining, 6000))) continue;
        passed = true;
        signal?.throwIfAborted();
        const budget = Math.min(attemptTimeout, deadline - now());
        if (budget < 1000) throw lastFailure ?? new Error('no_provider');
        try {
          attempts++;
          return await attempt(keys[index], route, budget);
        } catch (error) {
          signal?.throwIfAborted();
          lastFailure = error;
          const reason = error?.message;
          const rejected = (planning || error?.retrySafe === true) && accountFailure.has(reason);
          const rotateRoute = (reason === 'connection_before_send' && (planning || error?.retrySafe === true)) ||
            (planning && plannerTransient.has(reason));
          if (attempts >= maxAttempts || (!rejected && !rotateRoute)) throw error;
          onRetry({ phase, route: route.provider, account: index + 1, reason });
          if (rejected) skipAccount.add(index);
          else {
            order.splice(order.indexOf(index), 1);
            order.push(index);
            needsRefresh = true;
            break;
          }
        }
      }
      if (tested && !passed) {
        needsRefresh = true;
        onRetry({ phase, route: route.provider, account: 'all', reason: 'preflight_unreachable' });
      }
    }
    if (round || !needsRefresh || skipAccount.size >= keys.length || deadline - now() < 1000 || !routes.length) break;
    signal?.throwIfAborted();
    await refresh(routes);
  }
  throw lastFailure ?? new Error('no_provider');
}
