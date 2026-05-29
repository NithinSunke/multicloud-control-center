import https from 'https';
import { createHash, createHmac } from 'crypto';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function amzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

function parseXmlValue(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return match?.[1] || '';
}

function signedStsRequest({ connector, now = new Date() }) {
  const service = 'sts';
  const region = connector.region || 'us-east-1';
  const host = `sts.${region}.amazonaws.com`;
  const method = 'POST';
  const path = '/';
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const payloadHash = hash(body);
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    Host: host,
    'X-Amz-Date': date,
    'X-Amz-Content-Sha256': payloadHash,
  };

  if (connector.awsSessionToken) {
    headers['X-Amz-Security-Token'] = connector.awsSessionToken;
  }

  const signedHeaderNames = Object.keys(headers).map((key) => key.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames
    .map((key) => `${key}:${headers[Object.keys(headers).find((header) => header.toLowerCase() === key)]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    credentialScope,
    hash(canonicalRequest),
  ].join('\n');
  const signature = hmac(signingKey(connector.awsSecretAccessKey, dateStamp, region, service), stringToSign, 'hex');

  return {
    host,
    body,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${connector.awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      Accept: 'application/xml',
      'Content-Length': Buffer.byteLength(body),
    },
  };
}

function requestSts({ connector, request = https.request }) {
  return new Promise((resolve) => {
    let signed;
    try {
      signed = signedStsRequest({ connector });
    } catch (error) {
      resolve({ ok: false, message: error.message || 'Unable to sign AWS request.' });
      return;
    }

    const req = request(
      {
        protocol: 'https:',
        hostname: signed.host,
        path: '/',
        method: 'POST',
        timeout: 15000,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: signed.headers,
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({
              ok: true,
              statusCode: response.statusCode,
              accountId: parseXmlValue(responseBody, 'Account'),
              arn: parseXmlValue(responseBody, 'Arn'),
              userId: parseXmlValue(responseBody, 'UserId'),
            });
            return;
          }

          const code = parseXmlValue(responseBody, 'Code');
          const message = parseXmlValue(responseBody, 'Message');
          resolve({
            ok: false,
            statusCode: response.statusCode,
            message: message
              ? `AWS returned HTTP ${response.statusCode}: ${code ? `${code}: ` : ''}${message}`
              : `AWS returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('AWS connection timed out.'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, message: error.message || 'Unable to reach AWS STS.' });
    });
    req.write(signed.body);
    req.end();
  });
}

export async function verifyAwsConnector(connector, options = {}) {
  if (!connector.awsAccessKeyId || !connector.awsSecretAccessKey) {
    return { ok: false, message: 'AWS access key and secret access key are required.' };
  }

  const response = await requestSts({ connector, request: options.request });
  if (!response.ok) {
    return response;
  }

  const accountDetail = response.accountId ? ` account ${response.accountId}` : '';
  return {
    ok: true,
    accountId: response.accountId,
    message: `Connected to AWS${accountDetail} in ${connector.region}.`,
  };
}
