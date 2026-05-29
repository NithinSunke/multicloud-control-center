import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { verifyAzureConnector } from './azureVerifier.js';

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
    };
    req.end = () => {
      callback(responses.shift());
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
}

function azureConnector(overrides = {}) {
  return {
    provider: 'azure',
    name: 'Production Azure',
    azureTenantId: 'tenant-id',
    azureSubscriptionId: 'subscription-id',
    azureClientId: 'client-id',
    azureClientSecret: 'client-secret',
    azureCloud: 'public',
    tlsVerify: true,
    ...overrides,
  };
}

describe('azure verifier', () => {
  it('verifies Azure credentials through ARM subscription lookup', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token-value' }),
      response(200, { subscriptionId: 'subscription-id', displayName: 'Production Subscription' }),
    ], calls);

    const result = await verifyAzureConnector(azureConnector(), { request });

    expect(result).toMatchObject({
      ok: true,
      subscriptionName: 'Production Subscription',
      tenantId: 'tenant-id',
      subscriptionId: 'subscription-id',
      message: 'Connected to Azure subscription Production Subscription.',
    });
    expect(calls[0].hostname).toBe('login.microsoftonline.com');
    expect(calls[0].path).toBe('/tenant-id/oauth2/v2.0/token');
    expect(calls[1].hostname).toBe('management.azure.com');
    expect(calls[1].path).toBe('/subscriptions/subscription-id?api-version=2020-01-01');
    expect(calls[1].headers.Authorization).toBe('Bearer token-value');
  });

  it('returns normalized Azure verification failures without exposing the client secret', async () => {
    const calls = [];
    const request = mockRequest([
      response(401, { error: 'invalid_client', error_description: 'Invalid client credential.' }),
    ], calls);

    const result = await verifyAzureConnector(azureConnector(), { request });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Azure identity returned HTTP 401');
    expect(JSON.stringify(result)).not.toContain('client-secret');
  });
});
