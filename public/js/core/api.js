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

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.clone().json();
      if (body.error || body.message) msg = body.error || body.message;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return res;
}

export async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  return res.json();
}
