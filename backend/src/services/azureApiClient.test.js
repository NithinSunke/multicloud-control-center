import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { createAzureVmImage, createAzureVmRestorePoint, getAzureVmStatus, listAzureBlobs, runAzureVmAction } from './azureApiClient.js';

function response(statusCode, body = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setEncoding = () => undefined;
  setTimeout(() => {
    res.emit('data', JSON.stringify(body));
    res.emit('end');
  }, 0);
  return res;
}

function textResponse(statusCode, body = '') {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setEncoding = () => undefined;
  setTimeout(() => {
    res.emit('data', body);
    res.emit('end');
  }, 0);
  return res;
}

function mockRequest(responses, calls) {
  return (options, callback) => {
    const req = new EventEmitter();
    req.write = (body) => {
      req.body = body;
    };
    req.end = () => {
      calls.push({ ...options, body: req.body });
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
    azureSubscriptionId: 'sub-123',
    azureClientId: 'client-id',
    azureClientSecret: 'client-secret',
    azureCloud: 'public',
    tlsVerify: true,
    ...overrides,
  };
}

describe('azure api client', () => {
  it('creates Azure VM images without returning connector secrets', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token-value' }),
      response(202, { id: 'operation-1' }),
    ], calls);

    const result = await createAzureVmImage(azureConnector(), {
      vmId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/app01',
      resourceGroup: 'rg-prod',
      region: 'eastus',
      name: 'app01-image',
    }, { request });

    expect(calls[1].method).toBe('PUT');
    expect(calls[1].path).toBe('/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/images/app01-image?api-version=2023-07-03');
    expect(JSON.parse(calls[1].body).properties.sourceVirtualMachine.id).toContain('/virtualMachines/app01');
    expect(result.image).toMatchObject({ name: 'app01-image', providerType: 'image', sourceVmId: expect.stringContaining('/virtualMachines/app01') });
    expect(JSON.stringify(result)).not.toContain('client-secret');
  });

  it('creates Azure VM restore point collections and restore points', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token-value' }),
      response(202, { id: 'collection-operation' }),
      response(202, { id: 'restore-point-operation' }),
    ], calls);

    const result = await createAzureVmRestorePoint(azureConnector(), {
      vmId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/app01',
      resourceGroup: 'rg-prod',
      region: 'eastus',
      collectionName: 'app01-restore-points',
      restorePointName: 'app01-rp-20260528',
      consistencyMode: 'CrashConsistent',
    }, { request });

    expect(calls[1].path).toBe('/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/restorePointCollections/app01-restore-points?api-version=2024-11-01');
    expect(JSON.parse(calls[1].body).properties.source.id).toContain('/virtualMachines/app01');
    expect(calls[2].path).toBe('/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/restorePointCollections/app01-restore-points/restorePoints/app01-rp-20260528?api-version=2024-11-01');
    expect(JSON.parse(calls[2].body).properties.consistencyMode).toBe('CrashConsistent');
    expect(result.restorePoint).toMatchObject({
      name: 'app01-rp-20260528',
      providerType: 'restorePoint',
      restorePointCollectionName: 'app01-restore-points',
      sourceVmId: expect.stringContaining('/virtualMachines/app01'),
    });
    expect(JSON.stringify(result)).not.toContain('client-secret');
  });

  it('normalizes Azure VM action authorization failures with a clear RBAC hint', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token-value' }),
      response(403, {
        error: {
          message: "The client 'app-id' with object id 'object-id' does not have authorization to perform action 'Microsoft.Compute/virtualMachines/powerOff/action' over scope '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/app01' or the scope is invalid.",
        },
      }),
    ], calls);

    await expect(runAzureVmAction(azureConnector(), {
      vmId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/app01',
      action: 'stop',
    }, { request })).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Virtual Machine Contributor'),
    });
  });

  it('refreshes a single Azure VM status with network details', async () => {
    const calls = [];
    const vmId = '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/app01';
    const nicId = '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Network/networkInterfaces/app01-nic';
    const publicIpId = '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Network/publicIPAddresses/app01-pip';
    const request = mockRequest([
      response(200, { access_token: 'token-value' }),
      response(200, {
        id: vmId,
        name: 'app01',
        type: 'Microsoft.Compute/virtualMachines',
        location: 'eastus',
        properties: {
          provisioningState: 'Succeeded',
          hardwareProfile: { vmSize: 'Standard_B1s' },
          storageProfile: { osDisk: { osType: 'Linux', diskSizeGB: 30, managedDisk: { id: `${vmId}/osDisk` } } },
          networkProfile: { networkInterfaces: [{ id: nicId }] },
        },
      }),
      response(200, { statuses: [{ code: 'PowerState/running', displayStatus: 'VM running' }] }),
      response(200, {
        id: nicId,
        properties: {
          ipConfigurations: [{
            properties: {
              privateIPAddress: '10.0.0.4',
              publicIPAddress: { id: publicIpId },
            },
          }],
        },
      }),
      response(200, { id: publicIpId, properties: { ipAddress: '20.1.1.1' } }),
    ], calls);

    const result = await getAzureVmStatus(azureConnector(), { vmId }, { request });

    expect(result.vm).toMatchObject({
      name: 'app01',
      status: 'VM running',
      size: 'Standard_B1s',
      os: 'Linux',
      privateIp: '10.0.0.4',
      publicIp: '20.1.1.1',
      diskSizeGb: 30,
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/tenant-id/oauth2/v2.0/token',
      `${vmId}?api-version=2023-09-01`,
      `${vmId}/instanceView?api-version=2023-09-01`,
      `${nicId}?api-version=2023-09-01`,
      `${publicIpId}?api-version=2023-09-01`,
    ]);
  });

  it('falls back to Azure Storage Entra auth when Shared Key signing is rejected', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'management-token' }),
      response(200, { keys: [{ value: Buffer.from('storage-key-value').toString('base64') }] }),
      textResponse(403, '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code><Message>Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.</Message></Error>'),
      response(200, { access_token: 'storage-token' }),
      textResponse(200, '<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs><Blob><Name>file.txt</Name><Properties><Content-Length>12</Content-Length><Content-Type>text/plain</Content-Type><Last-Modified>Thu, 28 May 2026 08:00:00 GMT</Last-Modified></Properties></Blob></Blobs></EnumerationResults>'),
    ], calls);

    const result = await listAzureBlobs(azureConnector(), {
      accountName: 'acct1',
      resourceGroup: 'rg-prod',
      containerName: 'container1',
    }, { request });

    expect(result.blobs).toHaveLength(1);
    expect(result.blobs[0]).toMatchObject({ name: 'file.txt', storageAccountName: 'acct1', containerName: 'container1' });
    expect(calls[3].body).toContain('scope=https%3A%2F%2Fstorage.azure.com%2F.default');
    expect(calls[4].headers.Authorization).toBe('Bearer storage-token');
  });
});
