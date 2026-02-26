export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
