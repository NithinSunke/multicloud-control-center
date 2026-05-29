import https from 'https';
import { createSign } from 'crypto';

function normalizePrivateKey(privateKey) {
  return String(privateKey || '').replace(/\\n/g, '\n').trim();
}

function identityHost(region) {
  return `identity.${region}.oraclecloud.com`;
}

function signedHeaders({ connector, method, pathWithQuery, host, date }) {
  const keyId = `${connector.tenancyOcid}/${connector.userOcid}/${connector.fingerprint}`;
  const signingString = [
    `(request-target): ${method.toLowerCase()} ${pathWithQuery}`,
    `host: ${host}`,
    `date: ${date}`,
  ].join('\n');
  const signer = createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();

  const signature = signer.sign(
    {
      key: normalizePrivateKey(connector.privateKey),
      passphrase: connector.privateKeyPassphrase || undefined,
    },
    'base64',
  );

  return {
    Authorization:
      `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
    Date: date,
    Host: host,
    Accept: 'application/json',
  };
}

function requestJson({ connector, method = 'GET', pathWithQuery, request = https.request }) {
  return new Promise((resolve) => {
    const host = identityHost(connector.region);
    const date = new Date().toUTCString();
    let headers;

    try {
      headers = signedHeaders({ connector, method, pathWithQuery, host, date });
    } catch (error) {
      resolve({
        ok: false,
        message: error.message || 'Unable to sign OCI request.',
      });
      return;
    }

    const req = request(
      {
        protocol: 'https:',
        hostname: host,
        path: pathWithQuery,
        method,
        timeout: 15000,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers,
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
              resolve({ ok: true, statusCode: response.statusCode, payload: JSON.parse(responseBody || '{}') });
            } catch {
              resolve({ ok: true, statusCode: response.statusCode, payload: {} });
            }
            return;
          }

          let detail = '';
          try {
            const parsed = JSON.parse(responseBody || '{}');
            detail = parsed.message || parsed.code || '';
          } catch {
            detail = responseBody.slice(0, 120);
          }

          resolve({
            ok: false,
            statusCode: response.statusCode,
            message: detail
              ? `OCI returned HTTP ${response.statusCode}: ${detail}`
              : `OCI returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('OCI connection timed out.'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, message: error.message || 'Unable to reach OCI.' });
    });
    req.end();
  });
}

export async function verifyOciConnector(connector, options = {}) {
  if (!connector.privateKey) {
    return { ok: false, message: 'OCI private key is not stored.' };
  }

  const compartmentId = encodeURIComponent(connector.compartmentOcid || connector.tenancyOcid);
  const response = await requestJson({
    connector,
    pathWithQuery: `/20160918/availabilityDomains?compartmentId=${compartmentId}`,
    request: options.request,
  });

  if (!response.ok) {
    return response;
  }

  const count = Array.isArray(response.payload) ? response.payload.length : 0;
  return {
    ok: true,
    message: count
      ? `Connected to OCI ${connector.region}. Found ${count} availability domain${count === 1 ? '' : 's'}.`
      : `Connected to OCI ${connector.region}.`,
  };
}
