import https from 'https';
import { createSign } from 'crypto';

const tokenHost = 'oauth2.googleapis.com';
const tokenPath = '/token';
const resourceManagerHost = 'cloudresourcemanager.googleapis.com';
const cloudPlatformScope = 'https://www.googleapis.com/auth/cloud-platform';

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseJson(body) {
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
}

function normalizedPrivateKey(privateKey) {
  return String(privateKey || '').replace(/\\n/g, '\n');
}

function signJwt(connector, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: connector.gcpClientEmail,
    scope: cloudPlatformScope,
    aud: `https://${tokenHost}${tokenPath}`,
    iat: now,
    exp: now + 3600,
  };
  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  return `${unsignedToken}.${base64Url(signer.sign(normalizedPrivateKey(connector.privateKey)))}`;
}

function requestForm({ connector, body, request = https.request }) {
  return new Promise((resolve) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: tokenHost,
        path: tokenPath,
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
            message: detail ? `Google identity returned HTTP ${response.statusCode}: ${detail}` : `Google identity returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Google identity connection timed out.'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, message: error.message || 'Unable to reach Google identity endpoint.' });
    });
    req.write(body);
    req.end();
  });
}

function requestJson({ connector, path, token, request = https.request }) {
  return new Promise((resolve) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: resourceManagerHost,
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
            message: detail ? `Google Cloud Resource Manager returned HTTP ${response.statusCode}: ${detail}` : `Google Cloud Resource Manager returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Google Cloud Resource Manager connection timed out.'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, message: error.message || 'Unable to reach Google Cloud Resource Manager.' });
    });
    req.end();
  });
}

export async function getGcpAccessToken(connector, options = {}) {
  let assertion;
  try {
    assertion = signJwt(connector, options.now);
  } catch (error) {
    return { ok: false, message: 'Unable to sign Google service account JWT. Check the service account email and private key format.' };
  }

  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString();

  return requestForm({
    connector,
    body: form,
    request: options.request,
  });
}

export async function verifyGcpConnector(connector, options = {}) {
  if (!connector.gcpProjectId || !connector.gcpClientEmail || !connector.privateKey) {
    return { ok: false, message: 'GCP project ID, service account email, and private key are required.' };
  }

  const tokenResponse = await getGcpAccessToken(connector, options);
  if (!tokenResponse.ok) {
    return tokenResponse;
  }

  const accessToken = tokenResponse.payload?.access_token;
  if (!accessToken) {
    return { ok: false, message: 'Google identity did not return an access token.' };
  }

  const projectResponse = await requestJson({
    connector,
    path: `/v1/projects/${encodeURIComponent(connector.gcpProjectId)}`,
    token: accessToken,
    request: options.request,
  });

  if (!projectResponse.ok) {
    return projectResponse;
  }

  const projectName = projectResponse.payload?.name || connector.gcpProjectId;
  const projectNumber = String(projectResponse.payload?.projectNumber || '');
  return {
    ok: true,
    projectId: connector.gcpProjectId,
    projectName,
    projectNumber,
    message: `Connected to GCP project ${projectName}.`,
  };
}
