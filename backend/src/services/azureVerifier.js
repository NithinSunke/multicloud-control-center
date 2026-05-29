import https from 'https';

const azureClouds = {
  public: {
    loginHost: 'login.microsoftonline.com',
    managementHost: 'management.azure.com',
    scope: 'https://management.azure.com/.default',
  },
  gov: {
    loginHost: 'login.microsoftonline.us',
    managementHost: 'management.usgovcloudapi.net',
    scope: 'https://management.usgovcloudapi.net/.default',
  },
  china: {
    loginHost: 'login.chinacloudapi.cn',
    managementHost: 'management.chinacloudapi.cn',
    scope: 'https://management.chinacloudapi.cn/.default',
  },
};

function cloudConfig(connector) {
  return azureClouds[connector.azureCloud] || azureClouds.public;
}

function parseJson(body) {
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
}

function requestForm({ connector, host, path, body, request = https.request }) {
  return new Promise((resolve) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: host,
        path,
        method: 'POST',
        timeout: 15000,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          const payload = parseJson(responseBody);
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ ok: true, statusCode: response.statusCode, payload });
            return;
          }

          const detail = payload.error_description || payload.error || responseBody.slice(0, 160);
          resolve({
            ok: false,
            statusCode: response.statusCode,
            message: detail ? `Azure identity returned HTTP ${response.statusCode}: ${detail}` : `Azure identity returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Azure identity connection timed out.'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, message: error.message || 'Unable to reach Azure identity endpoint.' });
    });
    req.write(body);
    req.end();
  });
}

function requestJson({ connector, host, path, token, request = https.request }) {
  return new Promise((resolve) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: host,
        path,
        method: 'GET',
        timeout: 15000,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          const payload = parseJson(responseBody);
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ ok: true, statusCode: response.statusCode, payload });
            return;
          }

          const detail = payload.error?.message || payload.error_description || payload.error || responseBody.slice(0, 160);
          resolve({
            ok: false,
            statusCode: response.statusCode,
            message: detail ? `Azure Resource Manager returned HTTP ${response.statusCode}: ${detail}` : `Azure Resource Manager returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Azure Resource Manager connection timed out.'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, message: error.message || 'Unable to reach Azure Resource Manager.' });
    });
    req.end();
  });
}

async function getAccessToken(connector, options = {}) {
  const config = cloudConfig(connector);
  const form = new URLSearchParams({
    client_id: connector.azureClientId,
    client_secret: connector.azureClientSecret,
    grant_type: 'client_credentials',
    scope: config.scope,
  }).toString();

  return requestForm({
    connector,
    host: config.loginHost,
    path: `/${encodeURIComponent(connector.azureTenantId)}/oauth2/v2.0/token`,
    body: form,
    request: options.request,
  });
}

export async function verifyAzureConnector(connector, options = {}) {
  if (!connector.azureTenantId || !connector.azureSubscriptionId || !connector.azureClientId || !connector.azureClientSecret) {
    return { ok: false, message: 'Azure tenant ID, subscription ID, client ID, and client secret are required.' };
  }

  const config = cloudConfig(connector);
  const tokenResponse = await getAccessToken(connector, options);
  if (!tokenResponse.ok) {
    return tokenResponse;
  }

  const accessToken = tokenResponse.payload?.access_token;
  if (!accessToken) {
    return { ok: false, message: 'Azure identity did not return an access token.' };
  }

  const subscriptionResponse = await requestJson({
    connector,
    host: config.managementHost,
    path: `/subscriptions/${encodeURIComponent(connector.azureSubscriptionId)}?api-version=2020-01-01`,
    token: accessToken,
    request: options.request,
  });

  if (!subscriptionResponse.ok) {
    return subscriptionResponse;
  }

  const subscriptionName = subscriptionResponse.payload?.displayName || connector.azureSubscriptionId;
  return {
    ok: true,
    subscriptionName,
    tenantId: connector.azureTenantId,
    subscriptionId: connector.azureSubscriptionId,
    message: `Connected to Azure subscription ${subscriptionName}.`,
  };
}
