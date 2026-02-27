import { sha256Hex, stableStringify } from '../util/hash.js';

const memoryStore = new Map();
const memoryLocks = new Map();
const memoryPayloadHashes = new Map();

function nowMs() {
  return Date.now();
}

function parseTtlSeconds(value, fallbackSeconds = 86400) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackSeconds;
  }
  return Math.floor(parsed);
}

function parseLockTtlSeconds(value, fallbackSeconds = 120) {
  const ttl = parseTtlSeconds(value, fallbackSeconds);
  return ttl < 10 ? 10 : ttl;
}

function makeStoreKey(path, key) {
  return `${path}::${key}`;
}

function makeLockKey(path, key) {
  return `LOCK::${path}::${key}`;
}

function makePayloadHashKey(path, key) {
  return `HASH::${path}::${key}`;
}

function cleanup() {
  const now = nowMs();

  for (const [k, v] of memoryStore.entries()) {
    if (v.expiresAtMs <= now) {
      memoryStore.delete(k);
    }
  }

  for (const [k, expiresAtMs] of memoryLocks.entries()) {
    if (expiresAtMs <= now) {
      memoryLocks.delete(k);
    }
  }

  for (const [k, v] of memoryPayloadHashes.entries()) {
    if (v.expiresAtMs <= now) {
      memoryPayloadHashes.delete(k);
    }
  }
}

async function callLockDo(env, path, key, action, payload) {
  if (!env?.IDEMPOTENCY_LOCK) return null;
  try {
    const objectName = makeStoreKey(path, key);
    const id = env.IDEMPOTENCY_LOCK.idFromName(objectName);
    const stub = env.IDEMPOTENCY_LOCK.get(id);
    const response = await stub.fetch(`https://idempotency/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload || {})
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function resolvePayloadHash(payload) {
  return sha256Hex(stableStringify(payload ?? null));
}

export async function ensureIdempotencyPayloadMatch(env, path, key, payloadHash) {
  if (!key) return true;

  const ttl = parseTtlSeconds(env.IDEMPOTENCY_TTL_SECONDS, 86400);
  const hashKey = makePayloadHashKey(path, key);

  const doResult = await callLockDo(env, path, key, 'check-payload', { payloadHash, ttlSeconds: ttl });
  if (doResult && doResult.ok) {
    return Boolean(doResult.matched);
  }

  const kv = env.IDEMPOTENCY_KV;
  if (kv) {
    try {
      const stored = await kv.get(hashKey);
      if (stored && stored !== payloadHash) return false;
      if (!stored) {
        await kv.put(hashKey, payloadHash, { expirationTtl: ttl });
      }
      return true;
    } catch {
      return false;
    }
  }

  cleanup();
  const cached = memoryPayloadHashes.get(hashKey);
  if (cached && cached.hash !== payloadHash) return false;
  if (!cached) {
    memoryPayloadHashes.set(hashKey, { hash: payloadHash, expiresAtMs: nowMs() + ttl * 1000 });
  }
  return true;
}

export async function getIdempotentResponse(env, path, key) {
  if (!key) return null;

  const storeKey = makeStoreKey(path, key);
  const kv = env.IDEMPOTENCY_KV;

  if (kv) {
    try {
      return (await kv.get(storeKey, { type: 'json' })) || null;
    } catch {
      return null;
    }
  }

  cleanup();

  const cached = memoryStore.get(storeKey);
  if (!cached) return null;

  if (cached.expiresAtMs <= nowMs()) {
    memoryStore.delete(storeKey);
    return null;
  }

  return cached.payload;
}

export async function acquireLock(env, path, key) {
  if (!key) return true;

  const kv = env.IDEMPOTENCY_KV;
  const lockKey = makeLockKey(path, key);
  const lockTtl = parseLockTtlSeconds(env.IDEMPOTENCY_LOCK_TTL_SECONDS, 120);

  const doResult = await callLockDo(env, path, key, 'acquire', { lockTtlSeconds: lockTtl });
  if (doResult && doResult.ok) {
    return Boolean(doResult.acquired);
  }

  if (kv) {
    try {
      const exists = await kv.get(lockKey);
      if (exists) return false;

      await kv.put(lockKey, '1', { expirationTtl: lockTtl });
      return true;
    } catch {
      return false;
    }
  }

  cleanup();
  if (memoryLocks.has(lockKey)) return false;

  memoryLocks.set(lockKey, nowMs() + lockTtl * 1000);
  return true;
}

export async function releaseLock(env, path, key) {
  if (!key) return;

  const kv = env.IDEMPOTENCY_KV;
  const lockKey = makeLockKey(path, key);

  const doResult = await callLockDo(env, path, key, 'release', {});
  if (doResult && doResult.ok) return;

  if (kv) {
    try {
      await kv.delete(lockKey);
      return;
    } catch {
      return;
    }
  }

  memoryLocks.delete(lockKey);
}

function resolveResponseTtlSeconds(env, ttlOverrideSeconds) {
  const override = Number(ttlOverrideSeconds);
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return parseTtlSeconds(env.IDEMPOTENCY_TTL_SECONDS, 86400);
}

export async function setIdempotentResponse(env, path, key, payload, options = {}) {
  if (!key) return;

  const ttl = resolveResponseTtlSeconds(env, options?.ttlSeconds);
  const storeKey = makeStoreKey(path, key);
  const kv = env.IDEMPOTENCY_KV;

  if (kv) {
    try {
      await kv.put(storeKey, JSON.stringify(payload), {
        expirationTtl: ttl
      });
      return;
    } catch {
      // fall through
    }
  }

  memoryStore.set(storeKey, {
    payload,
    expiresAtMs: nowMs() + ttl * 1000
  });
}
