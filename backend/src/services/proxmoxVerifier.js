import https from 'https';

function baseUrlFor(connector) {
  const rawHost = connector.host.match(/^https?:\/\//i) ? connector.host : `https://${connector.host}`;
  const url = new URL(rawHost);

  if (!url.port) {
    url.port = String(connector.port || 8006);
  }

  return url;
}

function versionEndpointFor(connector) {
  const url = baseUrlFor(connector);
  url.pathname = '/api2/json/version';
  url.search = '';
  url.hash = '';
  return url;
}

function ticketEndpointFor(connector) {
  const url = baseUrlFor(connector);
  url.pathname = '/api2/json/access/ticket';
  url.search = '';
  url.hash = '';
  return url;
}

function authHeaders(connector) {
  if (connector.authType === 'apiToken') {
    return {
      Authorization: `PVEAPIToken=${connector.username}@${connector.realm}!${connector.apiTokenId}=${connector.apiTokenSecret}`,
    };
  }

  return {};
}

function requestJson(url, options = {}, body = '') {
  return new Promise((resolve) => {
    const request = https.request(
      url,
      {
        timeout: 10000,
        ...options,
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve({
                ok: true,
                statusCode: response.statusCode,
                payload: JSON.parse(responseBody || '{}'),
              });
            } catch {
              resolve({ ok: true, statusCode: response.statusCode, payload: {} });
            }
            return;
          }

          resolve({
            ok: false,
            message: `Proxmox returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Connection timed out.'));
    });

    request.on('error', (error) => {
      resolve({
        ok: false,
        message: error.message || 'Unable to reach Proxmox.',
      });
    });

    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function verifyWithApiToken(connector) {
  const response = await requestJson(versionEndpointFor(connector), {
    method: 'GET',
    rejectUnauthorized: connector.tlsVerify !== false,
    headers: {
      Accept: 'application/json',
      ...authHeaders(connector),
    },
  });

  if (!response.ok) {
    return response;
  }

  const version = response.payload?.data?.version;
  return {
    ok: true,
    message: version ? `Connected to Proxmox VE ${version}.` : 'Connected to Proxmox.',
  };
}

async function verifyWithPassword(connector) {
  const username = connector.username.includes('@')
    ? connector.username
    : `${connector.username}@${connector.realm}`;
  const body = new URLSearchParams({
    username,
    password: connector.password,
  }).toString();

  const response = await requestJson(
    ticketEndpointFor(connector),
    {
      method: 'POST',
      rejectUnauthorized: connector.tlsVerify !== false,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body,
  );

  if (!response.ok) {
    return response;
  }

  if (!response.payload?.data?.ticket) {
    return {
      ok: false,
      message: 'Proxmox accepted the request but did not return a login ticket.',
    };
  }

  return {
    ok: true,
    message: 'Connected to Proxmox with password authentication.',
  };
}

export function verifyProxmoxConnector(connector) {
  if (connector.authType === 'password') {
    return verifyWithPassword(connector);
  }

  return verifyWithApiToken(connector);
}
