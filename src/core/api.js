// HTTP client para llamar al backend Ingenium.
// Maneja JWT, errores tipados y fallback offline para operaciones cr\u00edticas.

// Frontend + backend viven en el mismo origin (Railway sirve ambos).
// En dev local apuntamos al Fastify local por si corren separados (file:// o 5500).
const LOCAL_BASE = 'http://localhost:3000';
const isFileOrEmpty = !location.origin || location.origin === 'null';
const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);
const SAME_ORIGIN = !isFileOrEmpty ? location.origin : '';
const DEFAULT_BASE =
  localStorage.getItem('ingenium_api_base') ||
  (isLocalHost || isFileOrEmpty ? LOCAL_BASE : SAME_ORIGIN);

export function getApiBase() {
  return DEFAULT_BASE;
}

export function setApiBase(url) {
  localStorage.setItem('ingenium_api_base', url);
}

export function getToken() {
  return localStorage.getItem('ingenium_jwt');
}

export function setToken(t) {
  if (t) localStorage.setItem('ingenium_jwt', t);
  else localStorage.removeItem('ingenium_jwt');
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
    this.body = body;
  }
}

export async function api(path, opts = {}) {
  const base = getApiBase();
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      ...opts,
      headers,
      body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)
        ? JSON.stringify(opts.body)
        : opts.body,
    });
  } catch (err) {
    // Network error → offline
    const e = new ApiError(0, { error: 'offline', code: 'OFFLINE' });
    e.networkError = err;
    throw e;
  }

  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    throw new ApiError(res.status, payload);
  }
  return payload;
}

export async function isOnline() {
  if (!navigator.onLine) return false;
  try {
    await fetch(`${getApiBase()}/health`, { method: 'GET' });
    return true;
  } catch {
    return false;
  }
}
