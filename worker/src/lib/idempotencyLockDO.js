function nowMs() {
  return Date.now();
}

function parseSeconds(value, fallbackSeconds) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackSeconds;
  return Math.floor(parsed);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export class IdempotencyLockDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/check-payload') {
      return this.handleCheckPayload(request);
    }
    if (url.pathname === '/acquire') {
      return this.handleAcquire(request);
    }
    if (url.pathname === '/release') {
      return this.handleRelease();
    }

    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }

  async handleCheckPayload(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
    }

    const payloadHash = String(body?.payloadHash || '').trim();
    if (!payloadHash) {
      return jsonResponse({ ok: false, error: 'payload_hash_required' }, 400);
    }

    const ttlSeconds = parseSeconds(body?.ttlSeconds, 86400);
    const now = nowMs();

    const outcome = await this.state.storage.transaction(async (txn) => {
      const stored = await txn.get('payloadHashRecord');
      let active = stored || null;
      if (active && Number(active.expiresAtMs || 0) <= now) {
        await txn.delete('payloadHashRecord');
        active = null;
      }

      if (!active) {
        await txn.put('payloadHashRecord', { hash: payloadHash, expiresAtMs: now + ttlSeconds * 1000 });
        return { matched: true };
      }

      if (String(active.hash || '') !== payloadHash) {
        return { matched: false };
      }

      const nextExpiry = now + ttlSeconds * 1000;
      if (Number(active.expiresAtMs || 0) < nextExpiry) {
        await txn.put('payloadHashRecord', { hash: payloadHash, expiresAtMs: nextExpiry });
      }
      return { matched: true };
    });

    return jsonResponse({ ok: true, matched: Boolean(outcome?.matched) }, 200);
  }

  async handleAcquire(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
    }

    const lockTtlSeconds = Math.max(10, parseSeconds(body?.lockTtlSeconds, 120));
    const now = nowMs();

    const acquired = await this.state.storage.transaction(async (txn) => {
      const lock = await txn.get('lockRecord');
      if (lock && Number(lock.expiresAtMs || 0) > now) return false;
      await txn.put('lockRecord', { expiresAtMs: now + lockTtlSeconds * 1000 });
      return true;
    });

    return jsonResponse({ ok: true, acquired: Boolean(acquired) }, 200);
  }

  async handleRelease() {
    await this.state.storage.delete('lockRecord');
    return jsonResponse({ ok: true }, 200);
  }
}
