import { EventEmitter } from 'events';
import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyOciConnector } from './ociVerifier.js';

function createPrivateKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

function mockRequest({ statusCode = 200, body = '[]', capture }) {
  return (options, callback) => {
    capture?.(options);
    const req = new EventEmitter();
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.setEncoding = () => {};
      callback(response);
      queueMicrotask(() => {
        response.emit('data', body);
        response.emit('end');
      });
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
}

describe('oci verifier', () => {
  it('signs an OCI identity request without exposing secrets', async () => {
    let requestOptions;
    const result = await verifyOciConnector(
      {
        provider: 'oci',
        name: 'OCI',
        tenancyOcid: 'ocid1.tenancy.oc1..aaaa',
        userOcid: 'ocid1.user.oc1..bbbb',
        compartmentOcid: 'ocid1.compartment.oc1..cccc',
        region: 'us-ashburn-1',
        fingerprint: 'aa:bb:cc:dd',
        privateKey: createPrivateKey(),
        privateKeyPassphrase: '',
        tlsVerify: true,
      },
      {
        request: mockRequest({
          body: JSON.stringify([{ name: 'Uocm:US-ASHBURN-AD-1' }]),
          capture: (options) => {
            requestOptions = options;
          },
        }),
      },
    );

    expect(result).toEqual({
      ok: true,
      message: 'Connected to OCI us-ashburn-1. Found 1 availability domain.',
    });
    expect(requestOptions.hostname).toBe('identity.us-ashburn-1.oraclecloud.com');
    expect(requestOptions.path).toBe('/20160918/availabilityDomains?compartmentId=ocid1.compartment.oc1..cccc');
    expect(requestOptions.headers.Authorization).toContain('Signature version="1"');
    expect(requestOptions.headers.Authorization).not.toContain('PRIVATE KEY');
  });

  it('normalizes OCI HTTP failures', async () => {
    const result = await verifyOciConnector(
      {
        provider: 'oci',
        tenancyOcid: 'ocid1.tenancy.oc1..aaaa',
        userOcid: 'ocid1.user.oc1..bbbb',
        compartmentOcid: 'ocid1.compartment.oc1..cccc',
        region: 'us-ashburn-1',
        fingerprint: 'aa:bb:cc:dd',
        privateKey: createPrivateKey(),
        tlsVerify: true,
      },
      {
        request: mockRequest({
          statusCode: 401,
          body: JSON.stringify({ code: 'NotAuthenticated', message: 'Invalid key' }),
        }),
      },
    );

    expect(result).toEqual({
      ok: false,
      statusCode: 401,
      message: 'OCI returned HTTP 401: Invalid key',
    });
  });
});
