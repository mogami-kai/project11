#!/usr/bin/env node
/**
 * local_test_ocr_receipt_rules.mjs
 * 目的: lib/receiptRules.js のルールエンジンを外部APIなしでローカル検証する。
 * 実行: node scripts/local_test_ocr_receipt_rules.mjs
 */

import { applyTransportRules, normalizeItemType } from '../worker/src/lib/receiptRules.js';

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  [PASS] ${label}`);
    passed += 1;
  } else {
    console.error(`  [FAIL] ${label}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed += 1;
  }
}

function assertDeep(label, obj, checks) {
  for (const [key, expected] of Object.entries(checks)) {
    assert(`${label} → ${key}`, obj[key], expected);
  }
}

// ─── normalizeItemType ──────────────────────────────────────────────────────

console.log('\n[normalizeItemType]');
assert('train literal',   normalizeItemType('train'),   'train');
assert('bus literal',     normalizeItemType('bus'),     'bus');
assert('mixed literal',   normalizeItemType('mixed'),   'mixed');
assert('unknown literal', normalizeItemType('unknown'), 'unknown');
assert('other literal',   normalizeItemType('other'),   'other');
assert('電車 → train',    normalizeItemType('電車'),    'train');
assert('JR → train',      normalizeItemType('JR'),      'train');
assert('バス → bus',      normalizeItemType('バス'),    'bus');
assert('物販 → other',    normalizeItemType('物販'),    'other');
assert('食事 → other',    normalizeItemType('食事'),    'other');
assert('empty → unknown', normalizeItemType(''),        'unknown');

// ─── applyTransportRules ────────────────────────────────────────────────────

console.log('\n[applyTransportRules] 基本ケース');
{
  const { items, totals } = applyTransportRules([
    { from: '新宿', to: '渋谷', amount: 240, type: 'train', confidence: 0.95, rawLine: '新宿→渋谷 240円' },
    { from: '',     to: '',     amount: 100, type: 'bus',   confidence: 0.8,  rawLine: 'バス 100円' }
  ]);
  assertDeep('items[0]', items[0], { from: '新宿', to: '渋谷', amount: 240, type: 'train' });
  assertDeep('items[1]', items[1], { from: '', to: '', amount: 100, type: 'bus' });
  assertDeep('totals', totals, { train_total: 240, bus_total: 100, unknown_total: 0, grand_total: 340 });
}

console.log('\n[applyTransportRules] 0円除外');
{
  const { items, totals } = applyTransportRules([
    { from: 'A', to: 'B', amount: 0,   type: 'train', confidence: 0.9, rawLine: '0円' },
    { from: 'C', to: 'D', amount: 300, type: 'train', confidence: 0.9, rawLine: '300円' }
  ]);
  assert('items.length after 0-yen exclusion', items.length, 1);
  assert('surviving item amount', items[0].amount, 300);
  assertDeep('totals', totals, { train_total: 300, bus_total: 0, unknown_total: 0, grand_total: 300 });
}

console.log('\n[applyTransportRules] 物販除外');
{
  const { items, totals } = applyTransportRules([
    { from: '', to: '', amount: 500,  type: 'other',   confidence: 0.1, rawLine: 'コンビニ 500円' },
    { from: 'X', to: 'Y', amount: 180, type: 'train', confidence: 0.9, rawLine: '180円' }
  ]);
  assert('items.length after other exclusion', items.length, 1);
  assert('surviving item type', items[0].type, 'train');
  assertDeep('totals', totals, { train_total: 180, bus_total: 0, unknown_total: 0, grand_total: 180 });
}

console.log('\n[applyTransportRules] unknown は交通費扱い（分類不能は保持）');
{
  const { items, totals } = applyTransportRules([
    { from: 'P', to: 'Q', amount: 400, type: 'unknown', confidence: 0.4, rawLine: '??' }
  ]);
  assert('items.length', items.length, 1);
  assertDeep('totals', totals, { train_total: 0, bus_total: 0, unknown_total: 400, grand_total: 400 });
}

console.log('\n[applyTransportRules] 空配列');
{
  const { items, totals } = applyTransportRules([]);
  assert('items empty', items.length, 0);
  assertDeep('totals all zero', totals, { train_total: 0, bus_total: 0, unknown_total: 0, grand_total: 0 });
}

console.log('\n[applyTransportRules] null/undefined入力');
{
  const r1 = applyTransportRules(null);
  const r2 = applyTransportRules(undefined);
  assert('null input items.length',     r1.items.length, 0);
  assert('undefined input items.length', r2.items.length, 0);
}

console.log('\n[applyTransportRules] confidenceのclamp');
{
  const { items } = applyTransportRules([
    { from: 'A', to: 'B', amount: 100, type: 'train', confidence: 1.5,  rawLine: '' },
    { from: 'C', to: 'D', amount: 200, type: 'train', confidence: -0.3, rawLine: '' }
  ]);
  assert('confidence clamped to 1',   items[0].confidence, 1);
  assert('confidence clamped to 0',   items[1].confidence, 0);
}

console.log('\n[applyTransportRules] 複合ケース（バス+電車+物販+0円）');
{
  const raw = [
    { from: '新宿', to: '渋谷', amount: 240,  type: 'train', confidence: 0.95, rawLine: '電車 240円' },
    { from: '',     to: '',     amount: 210,  type: 'bus',   confidence: 0.85, rawLine: 'バス 210円' },
    { from: '',     to: '',     amount: 550,  type: 'other', confidence: 0.05, rawLine: '昼食 550円' },
    { from: '',     to: '',     amount: 0,    type: 'train', confidence: 0.9,  rawLine: '0円定期' },
    { from: '渋谷', to: '新宿', amount: 240,  type: 'train', confidence: 0.95, rawLine: '電車 240円' }
  ];
  const { items, totals } = applyTransportRules(raw);
  assert('filtered items count', items.length, 3);
  assertDeep('totals', totals, { train_total: 480, bus_total: 210, unknown_total: 0, grand_total: 690 });
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
