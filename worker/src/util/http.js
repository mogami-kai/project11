export function normalizePath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

export function getAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return '';
  return Array.isArray(allowedOrigins) && allowedOrigins.includes(origin) ? origin : '';
}

export function htmlNoStoreResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
