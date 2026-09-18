// --------------------------- API & HTTP Client ---------------------------
import { state, setAppVersion } from './state.js';

export async function fetchServerVersion() {
  try {
    const res = await fetch(state.serverBase.replace(/\/$/, '') + '/api/version');
    if (res.ok) {
      const data = await res.json();
      if (data && data.version) {
        setAppVersion(data.version);
      }
    }
  } catch {
    // safe fallback
  }
}

export async function api(path, opts = {}) {
  const url = state.serverBase.replace(/\/$/, '') + path;
  const headers = { ...opts.headers };

  if (state.token) {
    headers['Authorization'] = 'Bearer ' + state.token;
  }
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    // Token expired or invalid
    state.token = '';
    state.user = null;
    localStorage.removeItem('nimbus_token');
    localStorage.removeItem('nimbus_user');
    window.location.reload();
    throw new Error('Unauthorized');
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.message || data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(text || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res;
}
