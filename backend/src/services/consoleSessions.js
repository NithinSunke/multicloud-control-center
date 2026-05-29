import { randomUUID } from 'crypto';
import { createCipheriv } from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';

const sessions = new Map();
const consoleSessionTtlMs = 60 * 1000;

export function createConsoleSessionRecord({ websocketUrl, vncTicket, headers, rejectUnauthorized, metadata }) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + consoleSessionTtlMs).toISOString();
  sessions.set(id, {
    id,
    websocketUrl,
    vncTicket,
    headers,
    rejectUnauthorized,
    metadata,
    expiresAt,
  });
  return { id, expiresAt };
}

export function getConsoleSession(id) {
  const session = sessions.get(id);
  if (!session) {
    return null;
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function clearConsoleSessions() {
  sessions.clear();
}

export function attachConsoleWebSocketProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  const normalizeCloseCode = (code, fallback = 1000) => {
    if (typeof code !== 'number') {
      return fallback;
    }
    if (code === 1005 || code === 1006 || code === 1015 || code < 1000 || code > 4999) {
      return fallback;
    }
    return code;
  };

  const reverseByteBits = (value) => {
    let reversed = 0;
    for (let index = 0; index < 8; index += 1) {
      reversed = (reversed << 1) | ((value >> index) & 1);
    }
    return reversed;
  };

  const encryptVncChallenge = (challenge, password) => {
    const key = Buffer.alloc(8);
    Buffer.from(password || '', 'utf8')
      .subarray(0, 8)
      .forEach((byte, index) => {
        key[index] = reverseByteBits(byte);
      });
    const cipher = createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(challenge), cipher.final()]);
  };

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url || '', 'http://localhost');
    if (!requestUrl.pathname.startsWith('/api/proxmox/console/')) {
      return;
    }

    const sessionId = requestUrl.pathname.split('/').at(-1);
    const session = getConsoleSession(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 410 Gone\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (clientSocket) => {
      let proxyState = session.vncTicket ? 'serverProtocol' : 'bridge';
      const proxmoxSocket = new WebSocket(session.websocketUrl, {
        headers: session.headers,
        rejectUnauthorized: session.rejectUnauthorized,
      });

      const closeBoth = (code = 1000, reason = '') => {
        const safeCode = normalizeCloseCode(code);
        const safeReason = reason?.toString() || '';
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.close(safeCode, safeReason);
        }
        if (proxmoxSocket.readyState === WebSocket.OPEN) {
          proxmoxSocket.close(safeCode, safeReason);
        }
      };

      proxmoxSocket.on('open', () => {
        clientSocket.on('message', (message) => {
          if (proxmoxSocket.readyState !== WebSocket.OPEN) {
            return;
          }

          if (proxyState === 'clientProtocol') {
            proxmoxSocket.send(message);
            proxyState = 'serverSecurityTypes';
            return;
          }

          if (proxyState === 'clientSecurityType') {
            const selectedSecurityType = Buffer.from(message)[0];
            if (selectedSecurityType !== 1) {
              closeBoth(1002, 'Unsupported browser console security type');
              return;
            }
            clientSocket.send(Buffer.alloc(4));
            proxyState = 'bridge';
            return;
          }

          if (proxyState === 'bridge') {
            proxmoxSocket.send(message);
          }
        });

        proxmoxSocket.on('message', (message) => {
          if (clientSocket.readyState !== WebSocket.OPEN) {
            return;
          }

          const payload = Buffer.from(message);

          if (proxyState === 'serverProtocol') {
            clientSocket.send(payload);
            proxyState = 'clientProtocol';
            return;
          }

          if (proxyState === 'serverSecurityTypes') {
            const securityTypes = [...payload.subarray(1, 1 + payload[0])];
            if (!securityTypes.includes(2)) {
              closeBoth(1011, 'Proxmox console does not support VNC ticket authentication');
              return;
            }
            proxmoxSocket.send(Buffer.from([2]));
            proxyState = 'serverChallenge';
            return;
          }

          if (proxyState === 'serverChallenge') {
            proxmoxSocket.send(encryptVncChallenge(payload, session.vncTicket));
            proxyState = 'serverSecurityResult';
            return;
          }

          if (proxyState === 'serverSecurityResult') {
            if (payload.readUInt32BE(0) !== 0) {
              closeBoth(1011, 'Proxmox console ticket authentication failed');
              return;
            }
            clientSocket.send(Buffer.from([1, 1]));
            proxyState = 'clientSecurityType';
            return;
          }

          if (proxyState === 'bridge') {
            clientSocket.send(payload);
          }
        });
      });

      proxmoxSocket.on('error', () => closeBoth(1011, 'Proxmox console websocket error'));
      proxmoxSocket.on('close', (code, reason) => closeBoth(normalizeCloseCode(code), reason));
      clientSocket.on('error', () => closeBoth(1011, 'Browser console websocket error'));
      clientSocket.on('close', (code, reason) => closeBoth(normalizeCloseCode(code), reason));
    });
  });
}
