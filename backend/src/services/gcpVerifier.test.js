import { EventEmitter } from 'events';
import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyGcpConnector } from './gcpVerifier.js';

function response(statusCode, body) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setEncoding = () => undefined;
  setTimeout(() => {
    res.emit('data', JSON.stringify(body));
    res.emit('end');
  }, 0);
  return res;
}

function mockRequest(responses, calls) {
  return (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.write = (body) => {
      req.body = body;
      calls.at(-1).body = body;
    };
    req.end = () => {
      callback(responses.shift());
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
}

function testPrivateKey() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

function gcpConnector(overrides = {}) {
  return {
    provider: 'gcp',
    name: 'Production GCP',
    gcpProjectId: 'prod-project',
    gcpClientEmail: 'multi-cloud-manager@prod-project.iam.gserviceaccount.com',
    privateKey: testPrivateKey(),
    tlsVerify: true,
    ...overrides,
  };
}

describe('gcp verifier', () => {
  it('verifies GCP credentials through Cloud Resource Manager project lookup', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token-value' }),
      response(200, { projectId: 'prod-project', name: 'Production Project', projectNumber: '1234567890' }),
    ], calls);

    const result = await verifyGcpConnector(gcpConnector(), { request, now: 1760000000 });

    expect(result).toMatchObject({
      ok: true,
      projectId: 'prod-project',
      projectName: 'Production Project',
      projectNumber: '1234567890',
      message: 'Connected to GCP project Production Project.',
    });
    expect(calls[0].hostname).toBe('oauth2.googleapis.com');
    expect(calls[0].path).toBe('/token');
    expect(calls[0].body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(calls[1].hostname).toBe('cloudresourcemanager.googleapis.com');
    expect(calls[1].path).toBe('/v1/projects/prod-project');
    expect(calls[1].headers.Authorization).toBe('Bearer token-value');
  });

  it('returns normalized GCP verification failures without exposing the private key', async () => {
    const privateKey = testPrivateKey();
    const calls = [];
    const request = mockRequest([
      response(401, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
    ], calls);

    const result = await verifyGcpConnector(gcpConnector({ privateKey }), { request });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Google identity returned HTTP 401');
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });
});
