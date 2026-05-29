import https from 'https';

export class ProxmoxApiError extends Error {
  constructor({ type, message, statusCode, details }) {
    super(message);
    this.name = 'ProxmoxApiError';
    this.type = type;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const passwordTicketCache = new Map();
const passwordTicketTtlMs = 90 * 60 * 1000;

function baseUrlFor(connector) {
  const rawHost = connector.host.match(/^https?:\/\//i) ? connector.host : `https://${connector.host}`;
  const url = new URL(rawHost);

  if (!url.port) {
    url.port = String(connector.port || 8006);
  }

  return url;
}

function urlFor(connector, apiPath, query) {
  const url = baseUrlFor(connector);
  url.pathname = `/api2/json${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  url.search = '';
  url.hash = '';

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url;
}

function webSocketUrlFor(connector, apiPath, query) {
  const url = urlFor(connector, apiPath, query);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url;
}

function proxmoxUsername(connector) {
  return connector.username.includes('@')
    ? connector.username
    : `${connector.username}@${connector.realm}`;
}

function classifyError(error) {
  const code = error?.code || '';
  const message = error?.message || 'Unable to reach Proxmox.';

  if (
    code.includes('CERT') ||
    message.toLowerCase().includes('certificate') ||
    message.toLowerCase().includes('self-signed')
  ) {
    return 'tls';
  }

  if (
    ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code) ||
    message.toLowerCase().includes('timed out')
  ) {
    return 'network';
  }

  return 'network';
}

export function normalizeProxmoxFailure(failure) {
  if (failure instanceof ProxmoxApiError) {
    return failure;
  }

  if (failure?.statusCode === 401 || failure?.statusCode === 403) {
    return new ProxmoxApiError({
      type: 'auth',
      statusCode: failure.statusCode,
      message: 'Proxmox authentication failed.',
      details: failure.payload,
    });
  }

  if (failure?.statusCode) {
    const errorDetails = failure.payload?.errors && typeof failure.payload.errors === 'object'
      ? Object.entries(failure.payload.errors)
        .map(([field, message]) => `${field}: ${message}`)
        .join(' ')
      : '';
    const payloadMessage = typeof failure.payload?.message === 'string' ? failure.payload.message : '';
    const message = [payloadMessage || failure.message || `Proxmox returned HTTP ${failure.statusCode}.`, errorDetails]
      .filter(Boolean)
      .join(' ');

    return new ProxmoxApiError({
      type: 'proxmox',
      statusCode: failure.statusCode,
      message,
      details: failure.payload,
    });
  }

  return new ProxmoxApiError({
    type: classifyError(failure),
    message: failure?.message || 'Unable to reach Proxmox.',
  });
}

export function requestJson(url, options = {}, body = '') {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        timeout: options.timeoutMs || 10000,
        method: options.method || 'GET',
        rejectUnauthorized: options.rejectUnauthorized !== false,
        headers: options.headers || {},
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          let payload = {};
          try {
            payload = JSON.parse(responseBody || '{}');
          } catch {
            payload = { raw: responseBody };
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ statusCode: response.statusCode, payload });
            return;
          }

          reject(
            normalizeProxmoxFailure({
              statusCode: response.statusCode,
              payload,
              message: payload?.errors ? 'Proxmox API request failed.' : `Proxmox returned HTTP ${response.statusCode}.`,
            }),
          );
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('Connection timed out.'), { code: 'ETIMEDOUT' }));
    });

    request.on('error', (error) => {
      reject(normalizeProxmoxFailure(error));
    });

    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function encodeForm(payload) {
  return new URLSearchParams(
    Object.entries(payload).reduce((acc, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        acc[key] = String(value);
      }
      return acc;
    }, {}),
  ).toString();
}

function compactPayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

function resourcePath(type, node, vmid, suffix = '') {
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';
  return `/nodes/${encodeURIComponent(node)}/${normalizedType}/${encodeURIComponent(vmid)}${suffix}`;
}

export function createProxmoxApiClient(connector, options = {}) {
  const transport = options.transport || requestJson;
  const timeoutMs = options.timeoutMs || 10000;
  const pollIntervalMs = options.pollIntervalMs || 1000;
  let ticketSession = null;
  const ticketCacheKey = [
    connector.id || connector.host,
    connector.username,
    connector.realm,
    connector.updatedAt || '',
  ].join('|');

  async function authenticate() {
    if (connector.authType !== 'password') {
      return null;
    }
    if (ticketSession) {
      return ticketSession;
    }

    const cached = passwordTicketCache.get(ticketCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      ticketSession = {
        ticket: cached.ticket,
        csrfToken: cached.csrfToken,
      };
      return ticketSession;
    }

    const body = encodeForm({
      username: proxmoxUsername(connector),
      password: connector.password,
    });
    const response = await transport(
      urlFor(connector, '/access/ticket'),
      {
        method: 'POST',
        timeoutMs,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      body,
    ).catch((error) => {
      throw normalizeProxmoxFailure(error);
    });

    const data = response.payload?.data;
    if (!data?.ticket || !data?.CSRFPreventionToken) {
      throw new ProxmoxApiError({
        type: 'auth',
        message: 'Proxmox did not return a usable login ticket.',
      });
    }

    ticketSession = {
      ticket: data.ticket,
      csrfToken: data.CSRFPreventionToken,
    };
    passwordTicketCache.set(ticketCacheKey, {
      ...ticketSession,
      expiresAt: Date.now() + passwordTicketTtlMs,
    });
    return ticketSession;
  }

  async function headersFor(method) {
    if (connector.authType === 'apiToken') {
      return {
        Authorization: `PVEAPIToken=${connector.username}@${connector.realm}!${connector.apiTokenId}=${connector.apiTokenSecret}`,
      };
    }

    const session = await authenticate();
    return {
      Cookie: `PVEAuthCookie=${session.ticket}`,
      ...(method !== 'GET' ? { CSRFPreventionToken: session.csrfToken } : {}),
    };
  }

  async function request(method, apiPath, { query, body } = {}) {
    const requestBody = body ? encodeForm(body) : '';
    const headers = {
      Accept: 'application/json',
      ...(body
        ? {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(requestBody),
          }
        : {}),
      ...(await headersFor(method)),
    };

    const response = await transport(
      urlFor(connector, apiPath, query),
      {
        method,
        timeoutMs,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers,
      },
      requestBody,
    ).catch((error) => {
      throw normalizeProxmoxFailure(error);
    });

    return response.payload?.data ?? response.payload;
  }

  async function wait(ms) {
    if (options.wait) {
      await options.wait(ms);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    request,

    listNodes() {
      return request('GET', '/nodes');
    },

    listNodeNetwork({ node }) {
      return request('GET', `/nodes/${encodeURIComponent(node)}/network`);
    },

    listSdnZones() {
      return request('GET', '/cluster/sdn/zones');
    },

    listSdnVnets() {
      return request('GET', '/cluster/sdn/vnets');
    },

    listSdnIpams() {
      return request('GET', '/cluster/sdn/ipams');
    },

    createSdnZone(payload) {
      return request('POST', '/cluster/sdn/zones', { body: payload });
    },

    createSdnVnet(payload) {
      return request('POST', '/cluster/sdn/vnets', { body: payload });
    },

    createSdnIpam(payload) {
      return request('POST', '/cluster/sdn/ipams', { body: payload });
    },

    deleteSdnZone({ zone }) {
      return request('DELETE', `/cluster/sdn/zones/${encodeURIComponent(zone)}`);
    },

    deleteSdnVnet({ vnet }) {
      return request('DELETE', `/cluster/sdn/vnets/${encodeURIComponent(vnet)}`);
    },

    deleteSdnIpam({ ipam }) {
      return request('DELETE', `/cluster/sdn/ipams/${encodeURIComponent(ipam)}`);
    },

    applySdn() {
      return request('PUT', '/cluster/sdn');
    },

    createNodeNetwork({ node, payload }) {
      return request('POST', `/nodes/${encodeURIComponent(node)}/network`, { body: payload });
    },

    updateNodeNetwork({ node, iface, payload }) {
      return request('PUT', `/nodes/${encodeURIComponent(node)}/network/${encodeURIComponent(iface)}`, { body: payload });
    },

    deleteNodeNetwork({ node, iface }) {
      return request('DELETE', `/nodes/${encodeURIComponent(node)}/network/${encodeURIComponent(iface)}`);
    },

    applyNodeNetwork({ node }) {
      return request('PUT', `/nodes/${encodeURIComponent(node)}/network`);
    },

    async listVMs() {
      const resources = await request('GET', '/cluster/resources', { query: { type: 'vm' } });
      return Array.isArray(resources) ? resources.filter((item) => item.type === 'qemu') : [];
    },

    async listContainers() {
      const resources = await request('GET', '/cluster/resources', { query: { type: 'vm' } });
      return Array.isArray(resources) ? resources.filter((item) => item.type === 'lxc') : [];
    },

    listStorage() {
      return request('GET', '/cluster/resources', { query: { type: 'storage' } });
    },

    listStorageConfig() {
      return request('GET', '/storage');
    },

    createStorageConfig(payload) {
      return request('POST', '/storage', { body: payload });
    },

    updateStorageConfig({ storage, payload }) {
      return request('PUT', `/storage/${encodeURIComponent(storage)}`, { body: payload });
    },

    deleteStorageConfig({ storage }) {
      return request('DELETE', `/storage/${encodeURIComponent(storage)}`);
    },

    listStorageContent({ node, storage, content }) {
      return request('GET', `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`, {
        query: { content },
      });
    },

    deleteStorageContent({ node, storage, volume }) {
      return request('DELETE', `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volume)}`);
    },

    listTasks({ limit = 100, start } = {}) {
      return request('GET', '/cluster/tasks', { query: { limit, start } });
    },

    listNodeTasks({ node, limit = 100, start } = {}) {
      return request('GET', `/nodes/${encodeURIComponent(node)}/tasks`, { query: { limit, start } });
    },

    getTaskStatus({ node, upid }) {
      return request('GET', `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
    },

    getTaskLog({ node, upid, start = 0, limit = 500 } = {}) {
      return request('GET', `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log`, {
        query: { start, limit },
      });
    },

    stopTask({ node, upid }) {
      return request('DELETE', `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`);
    },

    listClusterLog({ max = 100 } = {}) {
      return request('GET', '/cluster/log', { query: { max } });
    },

    getResourceStatus({ node, type = 'qemu', vmid }) {
      return request('GET', resourcePath(type, node, vmid, '/status/current'));
    },

    startVM({ node, type = 'qemu', vmid }) {
      return request('POST', resourcePath(type, node, vmid, '/status/start'));
    },

    shutdownVM({ node, type = 'qemu', vmid }) {
      return request('POST', resourcePath(type, node, vmid, '/status/shutdown'));
    },

    stopVM({ node, type = 'qemu', vmid }) {
      return request('POST', resourcePath(type, node, vmid, '/status/stop'));
    },

    rebootVM({ node, type = 'qemu', vmid }) {
      return request('POST', resourcePath(type, node, vmid, '/status/reboot'));
    },

    suspendVM({ node, type = 'qemu', vmid }) {
      return request('POST', resourcePath(type, node, vmid, '/status/suspend'));
    },

    cloneVM({ node, vmid, newid, name, target, storage, full = true, description }) {
      return request('POST', resourcePath('qemu', node, vmid, '/clone'), {
        body: { newid, name, target, storage, full: full ? 1 : 0, description },
      });
    },

    createVM({ node, payload }) {
      return request('POST', `/nodes/${encodeURIComponent(node)}/qemu`, { body: payload });
    },

    createContainer({ node, payload }) {
      return request('POST', `/nodes/${encodeURIComponent(node)}/lxc`, { body: payload });
    },

    convertVMToTemplate({ node, vmid }) {
      return request('POST', resourcePath('qemu', node, vmid, '/template'));
    },

    deleteVM({ node, type = 'qemu', vmid, force = false }) {
      return request('DELETE', resourcePath(type, node, vmid), {
        query: force ? { force: 1 } : undefined,
      });
    },

    backupResource({ node, vmid, storage, mode = 'snapshot', compress = 'zstd' }) {
      return request('POST', `/nodes/${encodeURIComponent(node)}/vzdump`, {
        body: compactPayload({
          vmid,
          storage,
          mode,
          compress,
        }),
      });
    },

    restoreVM({ node, vmid, archive, storage, force = false, name = '' }) {
      return request('POST', `/nodes/${encodeURIComponent(node)}/qemu`, {
        body: compactPayload({
          vmid,
          archive,
          storage,
          force: force ? 1 : '',
          name,
        }),
      });
    },

    restoreContainer({ node, vmid, archive, storage, force = false, hostname = '' }) {
      return request('POST', `/nodes/${encodeURIComponent(node)}/lxc`, {
        body: compactPayload({
          vmid,
          ostemplate: archive,
          storage,
          force: force ? 1 : '',
          hostname,
          restore: 1,
        }),
      });
    },

    createNoVncSession({ node, type = 'qemu', vmid }) {
      return request('POST', resourcePath(type, node, vmid, '/vncproxy'), {
        body: { websocket: 1 },
      });
    },

    async createConsoleSession({ node, type = 'qemu', vmid }) {
      const session = await this.createNoVncSession({ node, type, vmid });
      return {
        session,
        vncTicket: session.ticket,
        websocketUrl: webSocketUrlFor(connector, resourcePath(type, node, vmid, '/vncwebsocket'), {
          port: session.port,
          vncticket: session.ticket,
        }).toString(),
        headers: await headersFor('GET'),
        rejectUnauthorized: connector.tlsVerify !== false,
      };
    },

    async pollTask({ node, upid, timeoutMs: taskTimeoutMs = 120000 }) {
      const startedAt = Date.now();
      while (Date.now() - startedAt <= taskTimeoutMs) {
        const status = await this.getTaskStatus({ node, upid });
        if (status.status === 'stopped') {
          return status;
        }
        await wait(pollIntervalMs);
      }

      throw new ProxmoxApiError({
        type: 'timeout',
        message: 'Timed out waiting for Proxmox task to finish.',
      });
    },
  };
}
