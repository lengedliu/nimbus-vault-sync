// --------------------------- WebSocket Client & Realtime Sync ---------------------------
import { state } from './state.js';
import { toast } from './dialogs.js';

const REALTIME_SYNC_EVENTS = new Set([
  'sync',
  'file_change',
  'delta',
  'change',
  'deleted',
  'batch_file_change',
  'batch_change',
  'conflict',
]);

export function connectWebSocket(vaultId, onDeltaSync) {
  disconnectWebSocket();

  if (!state.token || !vaultId) return;

  const cleanToken = (state.token || '').replace(/^Bearer\s+/i, '').trim();
  const serverUrl = state.serverBase.replace(/\/$/, '');
  const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?vaultId=${encodeURIComponent(vaultId)}&token=${encodeURIComponent(cleanToken)}&deviceId=Web-Dashboard&noManifest=1`;

  try {
    const ws = new WebSocket(wsUrl);
    state.wsClient = ws;

    ws.onopen = () => {
      if (state.wsPingTimer) clearInterval(state.wsPingTimer);
      state.wsPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
          } catch {}
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && REALTIME_SYNC_EVENTS.has(msg.type)) {
          if (state.wsDebounceTimer) clearTimeout(state.wsDebounceTimer);
          state.wsDebounceTimer = setTimeout(() => {
            if (typeof onDeltaSync === 'function') {
              onDeltaSync(vaultId, msg);
            }
          }, 400);
        } else if (msg && (msg.type === 'force_logout' || msg.type === 'auth_revoked')) {
          toast('令牌已撤销或会话已失效');
          setTimeout(() => window.location.reload(), 1200);
        }
      } catch {}
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      if (state.wsPingTimer) {
        clearInterval(state.wsPingTimer);
        state.wsPingTimer = null;
      }
      if (state.wsClient === ws) {
        state.wsClient = null;
      }
    };
  } catch {}
}

export function disconnectWebSocket() {
  if (state.wsPingTimer) {
    clearInterval(state.wsPingTimer);
    state.wsPingTimer = null;
  }
  if (state.wsClient) {
    try {
      state.wsClient.close();
    } catch {}
    state.wsClient = null;
  }
}

