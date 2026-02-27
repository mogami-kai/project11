#!/usr/bin/env node
/**
 * local_test_ocr_gemini_normalize.mjs
 * 目的: OCR正規化ロジックをモック応答で検証する（外部API不使用）。
 *
 * カバー範囲:
 *   A) normalizeOcrExtraction — items複数・0円・other混在・日付あり/なし
 *   B) readJpegExifOrientation — JPEG EXIFバイトパーサ
 *
 * 実行: node scripts/local_test_ocr_gemini_normalize.mjs
 */

import { normalizeOcrExtraction } from '../worker/src/clients/gemini.js';
import { readJpegExifOrientation } from '../worker/src/lib/imagePrep.js';

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

function eq(label, actual, expected) {
  assert(label, actual, expected);
}

// ─── Helper: build minimal JPEG bytes with an EXIF Orientation tag ───────────

function makeJpegWithExif(orientation) {
  // TIFF IFD0 with one entry (Orientation), little-endian
  const ifdData = [
    0x01, 0x00,                           // entry count = 1
    0x12, 0x01,                           // tag 0x0112 (Orientation)
    0x03, 0x00,                           // type SHORT
    0x01, 0x00, 0x00, 0x00,               // count 1
    orientation & 0xFF, (orientation >> 8) & 0xFF, 0x00, 0x00,  // value
    0x00, 0x00, 0x00, 0x00                // next IFD offset = 0
  ];

  // TIFF header (little-endian)
  const tiff = [
    0x49, 0x49,                           // byte order "II"
    0x2A, 0x00,                           // magic 42
    0x08, 0x00, 0x00, 0x00,               // IFD0 offset = 8
    ...ifdData
  ];

  // Exif\0\0 identifier
  const exifData = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];

  // APP1 segment length (includes 2-byte length field itself)
  const segLen = 2 + exifData.length;
  const app1 = [
    0xFF, 0xE1,
    (segLen >> 8) & 0xFF, segLen & 0xFF,
    ...exifData
  ];

  return new Uint8Array([0xFF, 0xD8, ...app1]);
}

// ─── A) normalizeOcrExtraction mock tests ────────────────────────────────────

console.log('\n[normalizeOcrExtraction] items複数・0円・other混在・日付あり');
{
  const geminiResponse = {
    items: [
      { from: '新宿',  to: '渋谷',  amount: 240,  type: 'train',   confidence: 0.95, rawLine: '電車 240円' },
      { from: '',      to: '',      amount: 550,  type: 'other',   confidence: 0.05, rawLine: 'コンビニ' },
      { from: '',      to: '',      amount: 0,    type: 'train',   confidence: 0.8,  rawLine: '0円定期' },
      { from: '',      to: '',      amount: 210,  type: 'bus',     confidence: 0.85, rawLine: 'バス 210円' }
    ],
    issuedAtCandidate: '2026-03-01 09:32',
    workDate: '2026-03-01',
    rawText: '新宿→渋谷 240円 コンビニ 550円'
  };
  const result = normalizeOcrExtraction(geminiResponse);

  // items: 物販(other)除外、0円除外 → train + bus の2件
  eq('items.length', result.items.length, 2);
  eq('items[0].type', result.items[0].type, 'train');
  eq('items[0].amount', result.items[0].amount, 240);
  eq('items[1].type', result.items[1].type, 'bus');
  eq('items[1].amount', result.items[1].amount, 210);

  // totals
  eq('totals.train_total',   result.totals.train_total,   240);
  eq('totals.bus_total',     result.totals.bus_total,     210);
  eq('totals.unknown_total', result.totals.unknown_total, 0);
  eq('totals.grand_total',   result.totals.grand_total,   450);

  // 後方互換フィールド (primary = items[0] = train)
  eq('fromCandidate', result.fromCandidate, '新宿');
  eq('toCandidate',   result.toCandidate,   '渋谷');
  eq('fromStation',   result.fromStation,   '新宿');
  eq('toStation',     result.toStation,     '渋谷');
  eq('amount',        result.amount,        240);
  eq('transportTypeCandidate', result.transportTypeCandidate, 'train');

  // 日時フィールド
  eq('issuedAtCandidate', result.issuedAtCandidate, '2026-03-01 09:32');
  eq('workDate',          result.workDate,           '2026-03-01');
  eq('roundTrip',         result.roundTrip,          '片道');
}

console.log('\n[normalizeOcrExtraction] 全items 0円 → 空結果');
{
  const geminiResponse = {
    items: [
      { from: 'A', to: 'B', amount: 0, type: 'train', confidence: 0.9, rawLine: '' }
    ],
    issuedAtCandidate: '',
    workDate: '',
    rawText: ''
  };
  const result = normalizeOcrExtraction(geminiResponse);

  eq('items.length', result.items.length, 0);
  eq('totals.grand_total', result.totals.grand_total, 0);
  eq('amount', result.amount, 0);
  eq('fromCandidate', result.fromCandidate, '');
  eq('toCandidate',   result.toCandidate,   '');
}

console.log('\n[normalizeOcrExtraction] 日付なし');
{
  const geminiResponse = {
    items: [
      { from: '梅田', to: '天王寺', amount: 180, type: 'train', confidence: 0.9, rawLine: '大阪環状線' }
    ],
    issuedAtCandidate: '',
    workDate: '',
    rawText: '梅田→天王寺 180円'
  };
  const result = normalizeOcrExtraction(geminiResponse);

  eq('issuedAtCandidate', result.issuedAtCandidate, '');
  eq('workDate',          result.workDate,           '');
  eq('amount',            result.amount,             180);
  eq('totals.grand_total', result.totals.grand_total, 180);
}

console.log('\n[normalizeOcrExtraction] バスのみ');
{
  const geminiResponse = {
    items: [
      { from: '', to: '', amount: 230, type: 'bus', confidence: 0.88, rawLine: 'バス路線 230円' }
    ],
    issuedAtCandidate: '2026-03-05',
    workDate: '2026-03-05',
    rawText: 'バス 230円'
  };
  const result = normalizeOcrExtraction(geminiResponse);

  eq('totals.bus_total',   result.totals.bus_total,   230);
  eq('totals.train_total', result.totals.train_total, 0);
  eq('transportTypeCandidate', result.transportTypeCandidate, 'bus');
  eq('amount', result.amount, 230);
}

console.log('\n[normalizeOcrExtraction] items[]なし（旧フォーマットフォールバック）');
{
  // items配列が無い場合、旧フラットフィールドから後方互換フィールドを構築する
  const geminiResponse = {
    fromCandidate: '池袋',
    toCandidate:   '渋谷',
    amount:        190,
    transportTypeCandidate: 'train',
    issuedAtCandidate: '2026-02-01',
    workDate: '2026-02-01',
    rawText: '池袋→渋谷 190円'
  };
  const result = normalizeOcrExtraction(geminiResponse);

  // items[]なし → フォールバック
  eq('items.length', result.items.length, 0);
  eq('fromCandidate', result.fromCandidate, '池袋');
  eq('toCandidate',   result.toCandidate,   '渋谷');
  eq('amount',        result.amount,        190);
}

console.log('\n[normalizeOcrExtraction] unknown typeは保持');
{
  const geminiResponse = {
    items: [
      { from: 'X', to: 'Y', amount: 350, type: 'unknown', confidence: 0.4, rawLine: '??' }
    ],
    issuedAtCandidate: '',
    workDate: '',
    rawText: ''
  };
  const result = normalizeOcrExtraction(geminiResponse);

  eq('items.length',           result.items.length,           1);
  eq('totals.unknown_total',   result.totals.unknown_total,   350);
  eq('totals.grand_total',     result.totals.grand_total,     350);
  eq('transportTypeCandidate', result.transportTypeCandidate, 'unknown');
}

console.log('\n[normalizeOcrExtraction] mixed typeは保持（unknownバケットに合算）');
{
  const geminiResponse = {
    items: [
      { from: 'P', to: 'Q', amount: 500, type: 'mixed', confidence: 0.7, rawLine: 'バス+電車 500円' }
    ],
    issuedAtCandidate: '',
    workDate: '',
    rawText: ''
  };
  const result = normalizeOcrExtraction(geminiResponse);

  eq('items.length',         result.items.length,         1);
  eq('totals.unknown_total', result.totals.unknown_total, 500);  // mixed → unknownバケット
  eq('totals.grand_total',   result.totals.grand_total,   500);
}

// ─── B) readJpegExifOrientation ───────────────────────────────────────────────

console.log('\n[readJpegExifOrientation] 各Orientationが正しく読まれる');
for (const orient of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const bytes = makeJpegWithExif(orient);
  eq(`orientation ${orient}`, readJpegExifOrientation(bytes), orient);
}

console.log('\n[readJpegExifOrientation] エラーハンドリング');
{
  eq('empty Uint8Array → 1',  readJpegExifOrientation(new Uint8Array(0)), 1);
  eq('null → 1',              readJpegExifOrientation(null),              1);
  eq('not JPEG → 1',          readJpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4E, 0x47])), 1); // PNG header
  eq('too short → 1',         readJpegExifOrientation(new Uint8Array([0xFF, 0xD8])), 1);  // SOI only
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`結果: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
