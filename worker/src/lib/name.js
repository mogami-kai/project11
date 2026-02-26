const SMALL_KANA_MAP = {
  'ぁ': 'あ',
  'ぃ': 'い',
  'ぅ': 'う',
  'ぇ': 'え',
  'ぉ': 'お',
  'っ': 'つ',
  'ゃ': 'や',
  'ゅ': 'ゆ',
  'ょ': 'よ',
  'ゎ': 'わ',
  'ゕ': 'か',
  'ゖ': 'け',
  'ァ': 'ア',
  'ィ': 'イ',
  'ゥ': 'ウ',
  'ェ': 'エ',
  'ォ': 'オ',
  'ッ': 'ツ',
  'ャ': 'ヤ',
  'ュ': 'ユ',
  'ョ': 'ヨ',
  'ヮ': 'ワ',
  'ヵ': 'カ',
  'ヶ': 'ケ'
};

function toHiragana(text) {
  return String(text || '').replace(/[\u30A1-\u30F6]/g, (ch) => {
    const code = ch.charCodeAt(0) - 0x60;
    return String.fromCharCode(code);
  });
}

function foldSmallKana(text) {
  return String(text || '').replace(/[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ]/g, (ch) => {
    return SMALL_KANA_MAP[ch] || ch;
  });
}

function stripKanaMarks(text) {
  if (typeof text.normalize !== 'function') {
    return text;
  }

  return text
    .normalize('NFKD')
    .replace(/[\u3099\u309A]/g, '')
    .normalize('NFC');
}

export function normalizeName(value) {
  let text = String(value || '').trim();
  if (!text) return '';

  // Spec: v5_spec 3.2 Hotel OCR normalization
  if (typeof text.normalize === 'function') {
    text = text.normalize('NFKC');
  }

  text = toHiragana(text);
  text = foldSmallKana(text);
  text = stripKanaMarks(text);

  return text
    .toLowerCase()
    .replace(/[\s\u3000]/g, '');
}
