/**
 * lib/receiptRules.js
 * Pure rule engine for transport receipt item filtering and classification.
 * No I/O, no external dependencies. Easily unit-testable.
 *
 * Rules applied (in order):
 *   1. Exclude items with amount <= 0  (0円除外)
 *   2. Exclude items typed as 'other'  (物販・食事等除外)
 *   3. Keep train / bus / mixed / unknown items  (交通費のみ)
 *   4. Classify and accumulate totals by type
 */

const ALLOWED_TRANSPORT_TYPES = new Set(['train', 'bus', 'mixed', 'unknown']);

/**
 * Normalise a raw type string to one of:
 * 'train' | 'bus' | 'mixed' | 'other' | 'unknown'
 */
export function normalizeItemType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'train' || v === 'bus' || v === 'mixed' || v === 'unknown') return v;
  if (v === 'other') return 'other';
  if (/電車|jr|私鉄|地下鉄/.test(v)) return 'train';
  if (/バス/.test(v)) return 'bus';
  if (/混在|both/.test(v)) return 'mixed';
  if (/物販|食事|宿泊|その他|shop|retail|food/.test(v)) return 'other';
  return 'unknown';
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Apply transport filtering rules to a raw items array from Gemini OCR.
 *
 * @param {Array} rawItems
 * @returns {{ items: Array, totals: { train_total, bus_total, unknown_total, grand_total } }}
 */
export function applyTransportRules(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];

  const filtered = [];
  for (const item of items) {
    const amount = Number(item?.amount || 0);

    // Rule 1: exclude 0-yen items
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const type = normalizeItemType(String(item?.type || ''));

    // Rule 2: exclude non-transport (物販 etc.)
    if (!ALLOWED_TRANSPORT_TYPES.has(type)) continue;

    filtered.push({
      from: String(item?.from || '').trim(),
      to: String(item?.to || '').trim(),
      amount,
      type,
      confidence: clampConfidence(item?.confidence),
      rawLine: String(item?.rawLine || '').trim().slice(0, 100)
    });
  }

  let trainTotal = 0;
  let busTotal = 0;
  let unknownTotal = 0;

  for (const item of filtered) {
    if (item.type === 'train') trainTotal += item.amount;
    else if (item.type === 'bus') busTotal += item.amount;
    else unknownTotal += item.amount; // mixed / unknown
  }

  return {
    items: filtered,
    totals: {
      train_total: trainTotal,
      bus_total: busTotal,
      unknown_total: unknownTotal,
      grand_total: trainTotal + busTotal + unknownTotal
    }
  };
}
