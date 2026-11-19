const definiteRejection = new Set([400, 401, 403, 404, 422, 429]);

export function readHttpAttempts(stderr = '') {
  const attempts = new Map();
  let current;
  for (const line of stderr.split(/\r?\n/u)) {
    const record = /^(?:\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} )?HTTP attempt ([1-9]\d?): (?:response headers received after \d+ ms \(([1-5]\d{2})(?: [^)]*)?\)|transport failed after \d+ ms)$/u.exec(line);
    if (record) {
      current = { id: Number(record[1]), status: record[2] ? Number(record[2]) : null };
      attempts.set(current.id, current);
      continue;
    }
    const request = /^x-request-id: ((?:req_[a-z0-9_-]{6,64})|(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))$/iu.exec(line);
    if (request && current?.status) current.requestId = request[1];
  }
  return [...attempts.values()];
}

export function readProviderFailure({ killed, stderr, stdout } = {}) {
  const attempts = readHttpAttempts(stderr);
  const last = attempts.at(-1);
  const result = (reason, lastNotSent = false) => attempts.length ? {
    reason, attempts,
    retrySafe: !killed && attempts.every(({ id, status }, index) => id === index + 1 &&
      (definiteRejection.has(status) || (lastNotSent && index === attempts.length - 1 && status === null))),
  } : { reason };
  if (killed) return result('timeout');
  let apiStatus = last?.status;
  for (const stream of [stderr, stdout]) {
    if (!stream) continue;
    const json = stream.trim().startsWith('{') ? stream : stream.slice(stream.lastIndexOf('\n{') + 1);
    try {
      const root = JSON.parse(json);
      const err = root.error ?? root;
      const code = err.code ?? root.code;
      apiStatus ??= Number(err.status_code ?? err.http_status ?? err.status ?? root.status_code ?? root.status) || undefined;
      if (err.request_sent === false && ['connect', 'proxy_connect', 'tls_handshake'].includes(err.phase)) {
        return result('connection_before_send', true);
      }
      if (code === 'insufficient_quota') return result('quota');
      if (code === 'rate_limit_exceeded') return result('rate_limit');
      if (['content_policy_violation', 'moderation_blocked', 'safety_violations'].includes(code)) return result('policy');
      if (err.type === 'invalid_request_error' && apiStatus === undefined) return result('invalid_request');
    } catch { /* Never include the raw CLI output in diagnostics. */ }
  }
  if (apiStatus === 429) return result('rate_limit');
  if (apiStatus === 401 || apiStatus === 403) return result('auth');
  if ([400, 404, 422].includes(apiStatus)) return result('invalid_request');
  if (apiStatus >= 500 && apiStatus <= 599) return result('upstream');
  if (attempts.some(x => x.status === null)) return result('transport_uncertain');
  return result('provider');
}
