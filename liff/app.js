const WORKER_ENDPOINT = 'https://<worker-domain>';
const LIFF_ID = '<LIFF_ID>';
const ADMIN_USER_IDS = ['<LINE_ADMIN_USER_ID>'];
const REQUEST_TIMEOUT_MS = 20000;

const state = {
  idToken: '',
  profile: null,
  isAdmin: false,
  lastDashboard: null,
  weekAssignmentsByDate: {}
};

const el = {
  sessionInfo: document.getElementById('sessionInfo'),
  roleBadge: document.getElementById('roleBadge'),
  workerEndpointLabel: document.getElementById('workerEndpointLabel'),
  devApiKey: document.getElementById('devApiKey'),
  responseJson: document.getElementById('responseJson'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  tabMonthly: document.getElementById('tabMonthly'),
  screens: {
    dashboard: document.getElementById('screenDashboard'),
    traffic: document.getElementById('screenTraffic'),
    ocr: document.getElementById('screenOcr'),
    expense: document.getElementById('screenExpense'),
    hotel: document.getElementById('screenHotel'),
    monthly: document.getElementById('screenMonthly')
  },
  dashboardMonth: document.getElementById('dashboardMonth'),
  dashboardRefreshButton: document.getElementById('dashboardRefreshButton'),
  metricShiftDays: document.getElementById('metricShiftDays'),
  metricTrafficTotal: document.getElementById('metricTrafficTotal'),
  metricExpenseTotal: document.getElementById('metricExpenseTotal'),
  metricUnsubmittedTraffic: document.getElementById('metricUnsubmittedTraffic'),
  metricHotelUnanswered: document.getElementById('metricHotelUnanswered'),
  metricHotelConfirmed: document.getElementById('metricHotelConfirmed'),
  manualForm: document.getElementById('manualForm'),
  manualWorkDate: document.getElementById('manualWorkDate'),
  manualAssignedSite: document.getElementById('manualAssignedSite'),
  manualFromStation: document.getElementById('manualFromStation'),
  manualToStation: document.getElementById('manualToStation'),
  manualAmount: document.getElementById('manualAmount'),
  manualRoundTrip: document.getElementById('manualRoundTrip'),
  manualProject: document.getElementById('manualProject'),
  manualName: document.getElementById('manualName'),
  manualMemo: document.getElementById('manualMemo'),
  manualOtherSiteHint: document.getElementById('manualOtherSiteHint'),
  manualSubmit: document.getElementById('manualSubmit'),
  ocrExtractForm: document.getElementById('ocrExtractForm'),
  ocrImage: document.getElementById('ocrImage'),
  ocrWorkDate: document.getElementById('ocrWorkDate'),
  ocrProject: document.getElementById('ocrProject'),
  ocrName: document.getElementById('ocrName'),
  ocrExtractButton: document.getElementById('ocrExtractButton'),
  ocrDraftForm: document.getElementById('ocrDraftForm'),
  draftUserId: document.getElementById('draftUserId'),
  draftName: document.getElementById('draftName'),
  draftProject: document.getElementById('draftProject'),
  draftWorkDate: document.getElementById('draftWorkDate'),
  draftFromStation: document.getElementById('draftFromStation'),
  draftToStation: document.getElementById('draftToStation'),
  draftAmount: document.getElementById('draftAmount'),
  draftRoundTrip: document.getElementById('draftRoundTrip'),
  draftMemo: document.getElementById('draftMemo'),
  ocrSubmitButton: document.getElementById('ocrSubmitButton'),
  expenseForm: document.getElementById('expenseForm'),
  expenseWorkDate: document.getElementById('expenseWorkDate'),
  expenseCategory: document.getElementById('expenseCategory'),
  expenseAmount: document.getElementById('expenseAmount'),
  expensePaymentMethod: document.getElementById('expensePaymentMethod'),
  expenseProject: document.getElementById('expenseProject'),
  expenseName: document.getElementById('expenseName'),
  expenseMemo: document.getElementById('expenseMemo'),
  expenseSubmitButton: document.getElementById('expenseSubmitButton'),
  hotelRefreshButton: document.getElementById('hotelRefreshButton'),
  hotelAnsweredDates: document.getElementById('hotelAnsweredDates'),
  hotelUnansweredDates: document.getElementById('hotelUnansweredDates'),
  monthlyForm: document.getElementById('monthlyForm'),
  monthlyMonth: document.getElementById('monthlyMonth'),
  monthlyResultUrl: document.getElementById('monthlyResultUrl'),
  monthlyExportButton: document.getElementById('monthlyExportButton')
};

bootstrap().catch((error) => {
  setSessionStatus(`LIFF初期化失敗: ${String(error?.message || error)}`, true);
  renderResponse('bootstrap.error', {
    ok: false,
    error: {
      code: 'E_LIFF_INIT',
      message: String(error?.message || error),
      details: {},
      retryable: false
    },
    meta: {
      requestId: '',
      timestamp: new Date().toISOString()
    }
  }, 500);
});

async function bootstrap() {
  el.workerEndpointLabel.textContent = WORKER_ENDPOINT;
  bindTabs();
  bindForms();
  setDefaultDates();
  setMonthlyVisibility(false);
  await initLiffSession();
  await loadWeekAssignmentsForDate(String(el.manualWorkDate.value || ymdToday()));
  await refreshDashboard();
}

function bindTabs() {
  for (const tab of el.tabs) {
    tab.addEventListener('click', () => activateTab(String(tab.dataset.tab || 'dashboard')));
  }
}

function bindForms() {
  el.dashboardRefreshButton.addEventListener('click', refreshDashboard);
  el.manualForm.addEventListener('submit', submitManualTraffic);
  el.manualWorkDate.addEventListener('change', () => loadWeekAssignmentsForDate(String(el.manualWorkDate.value || '').trim()));
  el.manualAssignedSite.addEventListener('change', syncManualProjectFromAssignedSite);
  el.ocrExtractForm.addEventListener('submit', runOcrExtract);
  el.ocrDraftForm.addEventListener('submit', submitOcrDraftTraffic);
  el.expenseForm.addEventListener('submit', submitExpense);
  el.hotelRefreshButton.addEventListener('click', refreshDashboard);
  el.monthlyForm.addEventListener('submit', submitMonthlyExport);
}

function setDefaultDates() {
  const today = ymdToday();
  const month = ymToday();

  el.dashboardMonth.value = month;
  el.manualWorkDate.value = today;
  el.ocrWorkDate.value = today;
  el.draftWorkDate.value = today;
  el.expenseWorkDate.value = today;
  el.monthlyMonth.value = month;
}

async function loadWeekAssignmentsForDate(targetDate) {
  const date = String(targetDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

  const path = `/api/my/week/assignments?targetDate=${encodeURIComponent(date)}`;
  try {
    const result = await callWorkerJson(path, { method: 'GET' });
    if (!result.body?.ok) {
      renderAssignedSiteOptions(null, date);
      return;
    }

    state.weekAssignmentsByDate[date] = result.body.data || {};
    renderAssignedSiteOptions(result.body.data || {}, date);
  } catch (error) {
    renderAssignedSiteOptions(null, date);
    renderResponse('GET /api/my/week/assignments', {
      ok: false,
      error: {
        code: 'E_WEEK_ASSIGNMENTS_FETCH',
        message: String(error?.message || error),
        details: { targetDate: date },
        retryable: true
      },
      meta: {
        requestId: '',
        timestamp: new Date().toISOString()
      }
    }, 500);
  }
}

function renderAssignedSiteOptions(data, targetDate) {
  const options = Array.isArray(data?.siteOptions) ? data.siteOptions : [];
  const currentValue = String(el.manualAssignedSite.value || '').trim();
  const defaultSiteName = String(data?.defaultAssignment?.siteName || '').trim();
  const defaultSiteId = String(data?.defaultAssignment?.siteId || '').trim();
  const defaultKey = defaultSiteId ? `site:${defaultSiteId}` : (defaultSiteName ? `name:${defaultSiteName}` : '');

  el.manualAssignedSite.innerHTML = '';

  if (options.length === 0) {
    const noAssign = document.createElement('option');
    noAssign.value = '__OTHER__';
    noAssign.textContent = 'その他/臨時';
    noAssign.dataset.isOther = 'true';
    noAssign.dataset.siteName = '';
    noAssign.dataset.siteId = '';
    el.manualAssignedSite.appendChild(noAssign);
    el.manualAssignedSite.value = '__OTHER__';
    syncManualProjectFromAssignedSite();
    return;
  }

  for (const option of options) {
    const siteId = String(option?.siteId || '').trim();
    const siteName = String(option?.siteName || option?.siteRaw || '').trim();
    if (!siteName) continue;

    const node = document.createElement('option');
    node.value = siteId ? `site:${siteId}` : `name:${siteName}`;
    node.textContent = siteName;
    node.dataset.siteName = siteName;
    node.dataset.siteId = siteId;
    node.dataset.openChatUrl = String(option?.openChatUrl || '').trim();
    node.dataset.isOther = 'false';
    el.manualAssignedSite.appendChild(node);
  }

  const otherNode = document.createElement('option');
  otherNode.value = '__OTHER__';
  otherNode.textContent = 'その他/臨時';
  otherNode.dataset.isOther = 'true';
  otherNode.dataset.siteName = '';
  otherNode.dataset.siteId = '';
  el.manualAssignedSite.appendChild(otherNode);

  if (defaultKey && el.manualAssignedSite.querySelector(`option[value=\"${cssEscape(defaultKey)}\"]`)) {
    el.manualAssignedSite.value = defaultKey;
  } else if (currentValue && el.manualAssignedSite.querySelector(`option[value=\"${cssEscape(currentValue)}\"]`)) {
    el.manualAssignedSite.value = currentValue;
  } else {
    el.manualAssignedSite.selectedIndex = 0;
  }

  if (!el.manualWorkDate.value) {
    el.manualWorkDate.value = targetDate;
  }

  syncManualProjectFromAssignedSite();
}

function getSelectedAssignedSite() {
  const selected = el.manualAssignedSite.selectedOptions && el.manualAssignedSite.selectedOptions[0];
  if (!selected) return null;
  return {
    siteId: String(selected.dataset.siteId || '').trim(),
    siteName: String(selected.dataset.siteName || '').trim(),
    openChatUrl: String(selected.dataset.openChatUrl || '').trim(),
    isOther: String(selected.dataset.isOther || '').trim() === 'true'
  };
}

function syncManualProjectFromAssignedSite() {
  const selected = getSelectedAssignedSite();
  if (!selected) return;

  if (selected.isOther) {
    el.manualOtherSiteHint.classList.remove('hidden');
    return;
  }

  el.manualOtherSiteHint.classList.add('hidden');
  if (selected.siteName) {
    el.manualProject.value = selected.siteName;
  }
}

async function initLiffSession() {
  if (!window.liff) {
    throw new Error('LIFF SDK v2 is not loaded');
  }

  await window.liff.init({ liffId: LIFF_ID });
  if (!window.liff.isLoggedIn()) {
    window.liff.login({ redirectUri: window.location.href });
    return;
  }

  state.idToken = String(window.liff.getIDToken() || '');
  state.profile = await window.liff.getProfile();

  const userId = String(state.profile?.userId || '').trim();
  const displayName = String(state.profile?.displayName || '').trim();
  if (!userId) throw new Error('LIFF profile userId is empty');

  state.isAdmin = resolveIsAdmin(userId);
  setMonthlyVisibility(state.isAdmin);

  if (!el.manualName.value && displayName) el.manualName.value = displayName;
  if (!el.ocrName.value && displayName) el.ocrName.value = displayName;
  if (!el.expenseName.value && displayName) el.expenseName.value = displayName;
  if (!el.draftUserId.value) el.draftUserId.value = userId;

  el.roleBadge.textContent = state.isAdmin ? 'ADMIN' : 'USER';
  setSessionStatus(`LIFF ready userId=${userId} displayName=${displayName || '(none)'}`, false);
}

function resolveIsAdmin(userId) {
  const uid = String(userId || '').trim();
  const configured = ADMIN_USER_IDS
    .map((value) => String(value || '').trim())
    .filter((value) => value && !value.startsWith('<'));

  if (configured.length === 0) return false;
  return configured.includes(uid);
}

function setMonthlyVisibility(visible) {
  el.tabMonthly.hidden = !visible;
  el.screens.monthly.classList.toggle('hidden', !visible);
}

function activateTab(tabName) {
  if (tabName === 'monthly' && !state.isAdmin) {
    tabName = 'dashboard';
  }

  for (const tab of el.tabs) {
    const active = String(tab.dataset.tab || '') === tabName;
    tab.classList.toggle('active', active);
  }

  Object.entries(el.screens).forEach(([key, node]) => {
    const active = key === tabName;
    node.classList.toggle('active', active);
  });
}

async function refreshDashboard() {
  const userId = resolveActiveUserId();
  const month = String(el.dashboardMonth.value || '').trim();

  if (!userId) {
    renderValidationError('dashboard.validation', [{ field: 'userId', reason: 'required' }]);
    return;
  }

  toggleBusy(el.dashboardRefreshButton, true, '更新中...');
  try {
    const path = `/api/dashboard/month?userId=${encodeURIComponent(userId)}&month=${encodeURIComponent(month)}`;
    const result = await callWorkerJson(path, { method: 'GET' });
    renderResponse(`GET ${path}`, result.body, result.status);

    if (result.body?.ok) {
      state.lastDashboard = result.body.data || null;
      renderDashboardCards(result.body.data || {});
      renderHotelLists(result.body.data || {});
    }
  } finally {
    toggleBusy(el.dashboardRefreshButton, false, '更新');
  }
}

function renderDashboardCards(data) {
  const cards = data?.cards || {};
  el.metricShiftDays.textContent = numberText(cards.shiftDays);
  el.metricTrafficTotal.textContent = yenText(cards.trafficTotal);
  el.metricExpenseTotal.textContent = yenText(cards.expenseTotal);
  el.metricUnsubmittedTraffic.textContent = numberText(cards.unsubmittedTraffic);
  el.metricHotelUnanswered.textContent = numberText(cards.hotelUnanswered);
  el.metricHotelConfirmed.textContent = numberText(cards.hotelConfirmed);
}

function renderHotelLists(data) {
  const answered = Array.isArray(data?.details?.answeredHotelDates) ? data.details.answeredHotelDates : [];
  const planned = Array.isArray(data?.details?.plannedDates) ? data.details.plannedDates : [];
  const answeredSet = new Set(answered);
  const unanswered = planned.filter((date) => !answeredSet.has(date));

  fillList(el.hotelAnsweredDates, answered);
  fillList(el.hotelUnansweredDates, unanswered);
}

function fillList(node, values) {
  node.innerHTML = '';
  if (!values || values.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'なし';
    node.appendChild(li);
    return;
  }

  for (const value of values) {
    const li = document.createElement('li');
    li.textContent = String(value || '');
    node.appendChild(li);
  }
}

async function submitManualTraffic(event) {
  event.preventDefault();

  const selectedSite = getSelectedAssignedSite();
  const memoValue = String(el.manualMemo.value || '').trim();
  const projectValue = selectedSite && selectedSite.siteName && !selectedSite.isOther
    ? selectedSite.siteName
    : String(el.manualProject.value || '').trim();

  const payload = {
    userId: resolveActiveUserId(),
    workDate: String(el.manualWorkDate.value || '').trim(),
    fromStation: String(el.manualFromStation.value || '').trim(),
    toStation: String(el.manualToStation.value || '').trim(),
    amount: Number(el.manualAmount.value || 0),
    roundTrip: String(el.manualRoundTrip.value || '片道').trim(),
    memo: memoValue,
    project: projectValue,
    name: String(el.manualName.value || '').trim(),
    requestId: createRequestId('manual')
  };

  const validation = validateTrafficPayload(payload);
  if (selectedSite && selectedSite.isOther && !memoValue) {
    validation.push({ field: 'memo', reason: 'required when site is その他/臨時' });
  }
  if (validation.length > 0) {
    renderValidationError('traffic.validation', validation);
    return;
  }

  toggleBusy(el.manualSubmit, true, '送信中...');
  try {
    const result = await callWorkerJson('/api/traffic/create', {
      method: 'POST',
      body: payload,
      idempotencyKey: payload.requestId
    });
    renderResponse('POST /api/traffic/create', result.body, result.status);
    await refreshDashboard();
  } finally {
    toggleBusy(el.manualSubmit, false, '送信');
  }
}

async function runOcrExtract(event) {
  event.preventDefault();

  const file = el.ocrImage.files && el.ocrImage.files[0];
  if (!file) {
    renderValidationError('ocr.validation', [{ field: 'image', reason: 'required' }]);
    return;
  }

  const payload = {
    userId: resolveActiveUserId(),
    workDate: String(el.ocrWorkDate.value || '').trim(),
    projectId: String(el.ocrProject.value || '').trim(),
    name: String(el.ocrName.value || '').trim()
  };

  if (!payload.userId || !payload.workDate) {
    renderValidationError('ocr.validation', [
      { field: 'userId', reason: 'required' },
      { field: 'workDate', reason: 'required' }
    ]);
    return;
  }

  toggleBusy(el.ocrExtractButton, true, 'OCR実行中...');
  try {
    const image = await readImageAsBase64(file);
    const result = await callWorkerJson('/api/ocr/extract', {
      method: 'POST',
      body: {
        ...payload,
        imageBase64: image.base64,
        mimeType: image.mimeType
      }
    });

    renderResponse('POST /api/ocr/extract', result.body, result.status);

    if (result.body?.ok && result.body?.data?.normalizedClaimDraft) {
      fillDraftForm(result.body.data.normalizedClaimDraft);
      activateTab('ocr');
    }
  } finally {
    toggleBusy(el.ocrExtractButton, false, 'OCR実行');
  }
}

async function submitOcrDraftTraffic(event) {
  event.preventDefault();

  const requestId = createRequestId('ocr');
  const payload = {
    userId: String(el.draftUserId.value || '').trim(),
    name: String(el.draftName.value || '').trim(),
    project: String(el.draftProject.value || '').trim(),
    workDate: String(el.draftWorkDate.value || '').trim(),
    fromStation: String(el.draftFromStation.value || '').trim(),
    toStation: String(el.draftToStation.value || '').trim(),
    amount: Number(el.draftAmount.value || 0),
    roundTrip: String(el.draftRoundTrip.value || '片道').trim(),
    memo: String(el.draftMemo.value || '').trim(),
    requestId
  };

  const validation = validateTrafficPayload(payload);
  if (validation.length > 0) {
    renderValidationError('ocr.draft.validation', validation);
    return;
  }

  toggleBusy(el.ocrSubmitButton, true, '送信中...');
  try {
    const result = await callWorkerJson('/api/traffic/create', {
      method: 'POST',
      body: payload,
      idempotencyKey: requestId
    });
    renderResponse('POST /api/traffic/create (OCR draft)', result.body, result.status);
    await refreshDashboard();
  } finally {
    toggleBusy(el.ocrSubmitButton, false, 'ドラフト送信');
  }
}

async function submitExpense(event) {
  event.preventDefault();

  const payload = {
    userId: resolveActiveUserId(),
    workDate: String(el.expenseWorkDate.value || '').trim(),
    category: String(el.expenseCategory.value || '').trim(),
    amount: Number(el.expenseAmount.value || 0),
    paymentMethod: String(el.expensePaymentMethod.value || 'advance').trim(),
    project: String(el.expenseProject.value || '').trim(),
    name: String(el.expenseName.value || '').trim(),
    memo: String(el.expenseMemo.value || '').trim(),
    requestId: createRequestId('expense')
  };

  const validation = validateExpensePayload(payload);
  if (validation.length > 0) {
    renderValidationError('expense.validation', validation);
    return;
  }

  toggleBusy(el.expenseSubmitButton, true, '送信中...');
  try {
    const result = await callWorkerJson('/api/expense/create', {
      method: 'POST',
      body: payload,
      idempotencyKey: payload.requestId
    });
    renderResponse('POST /api/expense/create', result.body, result.status);
    await refreshDashboard();
  } finally {
    toggleBusy(el.expenseSubmitButton, false, '経費送信');
  }
}

async function submitMonthlyExport(event) {
  event.preventDefault();

  if (!state.isAdmin) {
    renderValidationError('monthly.export', [{ field: 'admin', reason: 'forbidden' }]);
    return;
  }

  const month = String(el.monthlyMonth.value || '').trim();
  if (!month) {
    renderValidationError('monthly.validation', [{ field: 'month', reason: 'required' }]);
    return;
  }

  toggleBusy(el.monthlyExportButton, true, '生成中...');
  try {
    const result = await callWorkerJson('/api/monthly/export', {
      method: 'POST',
      body: { month }
    });

    renderResponse('POST /api/monthly/export', result.body, result.status);

    if (result.body?.ok && result.body?.data?.fileUrl) {
      el.monthlyResultUrl.value = String(result.body.data.fileUrl || '');
    }
  } finally {
    toggleBusy(el.monthlyExportButton, false, '月次ファイル生成');
  }
}

function fillDraftForm(draft) {
  el.draftUserId.value = String(draft?.userId || resolveActiveUserId() || '').trim();
  el.draftName.value = String(draft?.name || el.ocrName.value || '').trim();
  el.draftProject.value = String(draft?.project || el.ocrProject.value || '').trim();
  el.draftWorkDate.value = String(draft?.workDate || el.ocrWorkDate.value || ymdToday()).trim();
  el.draftFromStation.value = String(draft?.fromStation || '').trim();
  el.draftToStation.value = String(draft?.toStation || '').trim();
  el.draftAmount.value = Number(draft?.amount || 0) > 0 ? String(Number(draft.amount)) : '';
  el.draftRoundTrip.value = String(draft?.roundTrip || '片道').trim() === '往復' ? '往復' : '片道';
  el.draftMemo.value = String(draft?.memo || '').trim();
}

async function callWorkerJson(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers();

  if (state.idToken) headers.set('Authorization', `Bearer ${state.idToken}`);
  const devApiKey = String(el.devApiKey.value || '').trim();
  if (devApiKey) headers.set('x-api-key', devApiKey);
  if (options.idempotencyKey) headers.set('x-idempotency-key', String(options.idempotencyKey));
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetchWithTimeout(buildWorkerUrl(path), {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  }, REQUEST_TIMEOUT_MS);

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = {
      ok: false,
      error: {
        code: 'E_INVALID_JSON',
        message: 'Non-JSON response.',
        details: { raw: text },
        retryable: false
      },
      meta: {
        requestId: '',
        timestamp: new Date().toISOString()
      }
    };
  }

  return {
    status: response.status,
    body
  };
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function buildWorkerUrl(path) {
  const root = String(WORKER_ENDPOINT || '').replace(/\/+$/, '');
  const route = String(path || '').startsWith('/') ? path : `/${String(path || '')}`;
  return `${root}${route}`;
}

function resolveActiveUserId() {
  return String(state.profile?.userId || '').trim();
}

function validateTrafficPayload(payload) {
  const fields = [];
  if (!payload.userId) fields.push({ field: 'userId', reason: 'required' });
  if (!payload.workDate) fields.push({ field: 'workDate', reason: 'required' });
  if (!payload.fromStation) fields.push({ field: 'fromStation', reason: 'required' });
  if (!payload.toStation) fields.push({ field: 'toStation', reason: 'required' });
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) fields.push({ field: 'amount', reason: 'must be > 0' });
  if (payload.roundTrip !== '片道' && payload.roundTrip !== '往復') fields.push({ field: 'roundTrip', reason: 'must be 片道 or 往復' });
  return fields;
}

function validateExpensePayload(payload) {
  const fields = [];
  if (!payload.userId) fields.push({ field: 'userId', reason: 'required' });
  if (!payload.workDate) fields.push({ field: 'workDate', reason: 'required' });
  if (!payload.category) fields.push({ field: 'category', reason: 'required' });
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) fields.push({ field: 'amount', reason: 'must be > 0' });
  if (!payload.memo) fields.push({ field: 'memo', reason: 'required' });
  return fields;
}

function renderValidationError(scope, fields) {
  renderResponse(scope, {
    ok: false,
    error: {
      code: 'E_VALIDATION',
      message: 'Validation failed.',
      details: { fields },
      retryable: false
    },
    meta: {
      requestId: '',
      timestamp: new Date().toISOString()
    }
  }, 400);
}

function renderResponse(scope, body, status) {
  el.responseJson.textContent = JSON.stringify({
    route: scope,
    httpStatus: status,
    body
  }, null, 2);
}

function toggleBusy(button, busy, busyText) {
  if (!button) return;
  const defaultLabel = String(button.dataset.defaultLabel || button.textContent || '');
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = defaultLabel;
  button.disabled = Boolean(busy);
  button.textContent = busy ? busyText : defaultLabel;
}

function setSessionStatus(message, isError) {
  el.sessionInfo.textContent = message;
  el.sessionInfo.classList.toggle('error-text', Boolean(isError));
}

function numberText(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString();
}

function yenText(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '-';
  return `${n.toLocaleString()}円`;
}

function ymToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function ymdToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function createRequestId(prefix) {
  const safePrefix = String(prefix || 'req').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'req';
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `${safePrefix}-${window.crypto.randomUUID()}`;
  }
  return `${safePrefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function cssEscape(value) {
  const text = String(value || '');
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(text);
  }
  return text.replace(/["\\]/g, '\\$&');
}

function readImageAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex < 0) {
        reject(new Error('Invalid data URL.'));
        return;
      }
      resolve({
        mimeType: String(file.type || 'image/jpeg'),
        base64: dataUrl.slice(commaIndex + 1)
      });
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}
