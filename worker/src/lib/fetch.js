function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timerId);
  }
}

export async function fetchWithRetry(url, options = {}, config = {}) {
  const {
    retries = 1,
    timeoutMs = 15000,
    retryDelayMs = 250,
    shouldRetry = (response, error) => {
      if (error) return true;
      if (!response) return true;
      return response.status === 429 || response.status >= 500;
    }
  } = config;

  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    lastError = null;

    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      lastResponse = response;
      if (!shouldRetry(response, null) || attempt === retries) {
        return { response, error: null, attempts: attempt + 1 };
      }
    } catch (error) {
      lastError = error;
      if (!shouldRetry(null, error) || attempt === retries) {
        return { response: null, error, attempts: attempt + 1 };
      }
    }

    await sleep(retryDelayMs * (attempt + 1));
  }

  return { response: lastResponse, error: lastError, attempts: retries + 1 };
}
