// --------------------------- WebSocket Client & Realtime Sync ---------------------------
import { state } from './state.js';
import { toast } from './dialogs.js';

export function connectWebSocket(vaultId, onDeltaSync) {
  if (state.wsClient) {
    try {
      state.wsClient.close();
    } catch {}
    state.wsClient = null;
  }

  if (!state.token || !vaultId) return;

  const cleanToken = (state.token || '').replace(/^Bearer\s+/i, '').trim();
  const serverUrl = state.serverBase.replace(/\/$/, '');
  const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?vaultId=${encodeURIComponent(vaultId)}&token=${encodeURIComponent(cleanToken)}&deviceId=Web-Dashboard`;

  try {
    const ws = new WebSocket(wsUrl);
    state.wsClient = ws;

    ws.onopen = () => {
      // connected
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync' || msg.type === 'file_change' || msg.type === 'delta') {
          if (state.wsDebounceTimer) clearTimeout(state.wsDebounceTimer);
          state.wsDebounceTimer = setTimeout(() => {
            if (typeof onDeltaSync === 'function') {
              onDeltaSync(vaultId, msg);
            }
          }, 400);
        } else if (msg.type === 'force_logout' || msg.type === 'auth_revoked') {
          toast('令牌已撤销或会话已失效');
          setTimeout(() => window.location.reload(), 1200);
        }
      } catch {}
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      state.wsClient = null;
    };
  } catch {}
}

export function disconnectWebSocket() {
  if (state.wsClient) {
    try {
      state.wsClient.close();
    } catch {}
    state.wsClient = null;
  }
}
