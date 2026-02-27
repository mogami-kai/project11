import { callGas } from '../clients/gas.js';
import { buildError, fail } from './response.js';

export const REQUIRED_REGISTRATION_FIELDS = [
  'nameKanji',
  'nameKana',
  'birthDate',
  'nearestStation',
  'phone',
  'emergencyRelation',
  'emergencyPhone',
  'postalCode',
  'address'
];

function parseBooleanLike(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'true' || text === '1' || text === 'yes' || text === 'active') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'inactive') return false;
  return fallback;
}

function normalizeFollowStatus(value, fallback = 'follow') {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'follow' || text === 'followed') return 'follow';
  if (text === 'unfollow' || text === 'unfollowed') return 'unfollow';
  return fallback;
}

function normalizeRegisterStatus(data, identity = {}) {
  const payload = data && typeof data === 'object' ? data : {};
  const staffInput = payload.staff && typeof payload.staff === 'object' ? payload.staff : {};
  const missingFields = Array.isArray(payload.missingFields)
    ? payload.missingFields.map((field) => String(field || '').trim()).filter(Boolean)
    : (payload.registered === false ? REQUIRED_REGISTRATION_FIELDS.slice() : []);

  const lineUserId = String(
    staffInput.lineUserId || payload.lineUserId || payload.userId || identity.userId || identity.lineUserId || ''
  ).trim();
  const statusText = String(staffInput.status || payload.status || payload.registrationStatus || '').trim().toLowerCase();
  const followStatusFallback = statusText === 'unfollowed' ? 'unfollow' : 'follow';
  const activeFallback = statusText !== 'inactive';

  const staff = {
    lineUserId,
    nameKanji: String(staffInput.nameKanji || payload.nameKanji || '').trim(),
    nameKana: String(staffInput.nameKana || payload.nameKana || '').trim(),
    birthDate: String(staffInput.birthDate || payload.birthDate || '').trim(),
    nearestStation: String(staffInput.nearestStation || payload.nearestStation || '').trim(),
    phone: String(staffInput.phone || payload.phone || '').trim(),
    emergencyRelation: String(staffInput.emergencyRelation || payload.emergencyRelation || '').trim(),
    emergencyPhone: String(staffInput.emergencyPhone || payload.emergencyPhone || '').trim(),
    postalCode: String(staffInput.postalCode || payload.postalCode || '').trim(),
    address: String(staffInput.address || payload.address || '').trim(),
    isActive: parseBooleanLike(staffInput.isActive ?? payload.isActive, activeFallback),
    lineFollowStatus: normalizeFollowStatus(staffInput.lineFollowStatus || payload.lineFollowStatus, followStatusFallback)
  };

  const registered = Boolean(payload.registered) || (missingFields.length === 0 && Boolean(lineUserId));

  return {
    registered,
    missingFields,
    staff
  };
}

export function isAdminIpAllowed(request, env) {
  const allowRaw = String(env.ADMIN_ALLOWED_IPS || '').trim();
  if (!allowRaw) return true;

  const currentIp = String(request.headers.get('cf-connecting-ip') || '').trim();
  if (!currentIp) return false;

  const allowed = allowRaw.split(',').map((v) => v.trim()).filter(Boolean);
  return allowed.includes(currentIp);
}

export function isAdminUser(userId, env) {
  const uid = String(userId || '').trim();
  if (!uid) return false;

  const list = String(env.LINE_ADMIN_USER_IDS || '')
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  return list.includes(uid);
}

export function requireAdmin(request, env, meta, options = {}) {
  const requireIpAllow = Boolean(options.requireIpAllow);
  const requireAdminUser = Boolean(options.requireAdminUser);
  const userId = String(options.userId || '').trim();

  // Spec: ops_rules 3 Hotel Operations (admin execution paths)
  if (requireIpAllow && !isAdminIpAllowed(request, env)) {
    return {
      ok: false,
      response: fail(buildError('E_FORBIDDEN', 'IP not allowed.', {}, false), meta, { status: 403 })
    };
  }

  if (requireAdminUser && !isAdminUser(userId, env)) {
    return {
      ok: false,
      response: fail(buildError('E_FORBIDDEN', 'Admin only route.', { userId }, false), meta, { status: 403 })
    };
  }

  return { ok: true };
}

export async function fetchRegisterStatus(env, meta, requestId, identity = {}) {
  const userId = String(identity.userId || '').trim();
  const lineUserId = String(identity.lineUserId || '').trim();
  const data = {};
  if (userId) data.userId = userId;
  if (!userId && lineUserId) data.lineUserId = lineUserId;

  if (!data.userId && !data.lineUserId) {
    return {
      ok: false,
      response: fail(
        buildError(
          'E_VALIDATION',
          'Validation failed.',
          { fields: [{ field: 'userId', reason: 'required(userId or lineUserId)' }] },
          false
        ),
        meta,
        { status: 400 }
      )
    };
  }

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    { action: 'staff.register.status', token: env.STAFF_TOKEN_FOR_GAS, requestId, data },
    meta
  );

  if (!gasOk) {
    return { ok: false, response };
  }

  if (!gasJson?.ok) {
    return {
      ok: false,
      response: fail(
        buildError('E_GAS_ERROR', 'Failed to verify registration status.', { gasError: gasJson?.error || {} }, true),
        meta,
        { status: 502 }
      )
    };
  }

  return {
    ok: true,
    data: normalizeRegisterStatus(gasJson.data || {}, identity)
  };
}

export async function requireRegistered(env, meta, requestId, identity = {}) {
  const status = await fetchRegisterStatus(env, meta, requestId, identity);
  if (!status.ok) return status;

  const normalized = status.data;

  // Spec: registration_spec 3 Gating Rules / api_schema 2 Gate
  if (!normalized.registered) {
    return {
      ok: false,
      response: fail(
        buildError(
          'E_REGISTER_REQUIRED',
          'Registration required',
          {
            missingFields: normalized.missingFields,
            lineUserId: normalized.staff.lineUserId || String(identity.userId || identity.lineUserId || '').trim()
          },
          false
        ),
        meta,
        { status: 403 }
      ),
      status: normalized
    };
  }

  // Spec: ops_rules 2 Staff Status / api_schema 2 Gate
  if (normalized.staff.isActive === false) {
    return {
      ok: false,
      response: fail(
        buildError(
          'E_STAFF_INACTIVE',
          'Staff is inactive.',
          {
            lineUserId: normalized.staff.lineUserId || String(identity.userId || identity.lineUserId || '').trim()
          },
          false
        ),
        meta,
        { status: 403 }
      ),
      status: normalized
    };
  }

  return {
    ok: true,
    status: normalized
  };
}
