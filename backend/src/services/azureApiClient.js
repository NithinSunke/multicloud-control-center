import crypto from 'crypto';
import https from 'https';

const azureClouds = {
  public: {
    loginHost: 'login.microsoftonline.com',
    managementHost: 'management.azure.com',
    scope: 'https://management.azure.com/.default',
    storageScope: 'https://storage.azure.com/.default',
    storageSuffix: 'core.windows.net',
  },
  gov: {
    loginHost: 'login.microsoftonline.us',
    managementHost: 'management.usgovcloudapi.net',
    scope: 'https://management.usgovcloudapi.net/.default',
    storageScope: 'https://storage.azure.us/.default',
    storageSuffix: 'core.usgovcloudapi.net',
  },
  china: {
    loginHost: 'login.chinacloudapi.cn',
    managementHost: 'management.chinacloudapi.cn',
    scope: 'https://management.chinacloudapi.cn/.default',
    storageScope: 'https://storage.azure.cn/.default',
    storageSuffix: 'core.chinacloudapi.cn',
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

function parseAzureStorageXmlError(body = '') {
  const code = String(body).match(/<Code>([^<]+)<\/Code>/i)?.[1] || '';
  const message = String(body).match(/<Message>([\s\S]*?)<\/Message>/i)?.[1] || '';
  return {
    error: {
      code,
      message: message.replace(/\s*RequestId:[\s\S]*$/i, '').trim(),
    },
  };
}

function normalizeAzureError(prefix, statusCode, body, payload) {
  const detail = payload?.error?.message || payload?.error_description || payload?.error || body.slice(0, 180);
  let message = detail ? `${prefix} returned HTTP ${statusCode}: ${detail}` : `${prefix} returned HTTP ${statusCode}.`;
  if (statusCode === 403 && /does not have authorization to perform action/i.test(String(detail))) {
    const action = String(detail).match(/action '([^']+)'/i)?.[1] || 'the requested Azure action';
    const scope = String(detail).match(/over scope '([^']+)'/i)?.[1] || 'the target resource scope';
    message = [
      `Azure permission denied for ${action}.`,
      `Grant the app registration/service principal a role that includes this action on ${scope}.`,
      'Virtual Machine Contributor on the resource group is usually enough for VM start/stop/restart/deallocate actions.',
      'After changing Azure RBAC, wait a few minutes and retry.',
    ].join(' ');
  }
  const error = new Error(message);
  error.statusCode = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
  error.azureHttpStatus = statusCode;
  error.azureCode = payload?.error?.code || '';
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestForm({ connector, host, path, body, request = https.request }) {
  return new Promise((resolve, reject) => {
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
            resolve(payload);
            return;
          }
          reject(normalizeAzureError('Azure identity', response.statusCode, responseBody, payload));
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('Azure identity connection timed out.')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function requestJsonOnce({ connector, host, path, token, method = 'GET', body = null, request = https.request }) {
  const bodyText = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: host,
        path,
        method,
        timeout: 30000,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } : {}),
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
            resolve(payload);
            return;
          }
          reject(normalizeAzureError('Azure Resource Manager', response.statusCode, responseBody, payload));
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('Azure Resource Manager connection timed out.')));
    req.on('error', reject);
    if (bodyText) {
      req.write(bodyText);
    }
    req.end();
  });
}

async function requestJson(options) {
  const maxAttempts = Number(options.maxAttempts || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestJsonOnce(options);
    } catch (error) {
      lastError = error;
      const status = Number(error.azureHttpStatus || error.statusCode || 0);
      const retryable = status === 429 || status >= 500 || /timed out|ECONNRESET|ETIMEDOUT/i.test(String(error.message || ''));
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function storageHeaders(headers = {}) {
  const xmsHeaders = {};
  const ordinaryHeaders = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (String(key).toLowerCase().startsWith('x-ms-')) {
      xmsHeaders[key] = value;
    } else {
      ordinaryHeaders[key] = value;
    }
  });
  return { ordinaryHeaders, xmsHeaders };
}

function requestStorage({ connector, accountName, path, method = 'GET', body = '', headers = {}, request = https.request }) {
  const config = cloudConfig(connector);
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''));
  const date = new Date().toUTCString();
  const serviceHost = `${accountName}.blob.${config.storageSuffix}`;
  const { ordinaryHeaders, xmsHeaders: customXmsHeaders } = storageHeaders(headers);
  const xmsHeaders = {
    'x-ms-date': date,
    'x-ms-version': '2023-11-03',
    ...customXmsHeaders,
  };
  const canonicalizedHeaders = Object.entries(xmsHeaders)
    .map(([key, value]) => [key.toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join('\n');
  const url = new URL(`https://${serviceHost}${path}`);
  const queryKeys = Array.from(url.searchParams.keys()).sort();
  const canonicalizedResource = [
    `/${accountName}${url.pathname}`,
    ...queryKeys.map((key) => `${key}:${url.searchParams.getAll(key).sort().join(',')}`),
  ].join('\n');
  const contentLength = bodyBuffer.length && method !== 'GET' && method !== 'HEAD' ? String(bodyBuffer.length) : '';
  const stringToSign = [
    method,
    '',
    '',
    contentLength,
    '',
    ordinaryHeaders['Content-Type'] || ordinaryHeaders['content-type'] || '',
    '',
    '',
    '',
    '',
    '',
    '',
    canonicalizedHeaders,
    canonicalizedResource,
  ].join('\n');
  const signature = connector.__storageToken
    ? ''
    : crypto.createHmac('sha256', Buffer.from(connector.__storageKey, 'base64')).update(stringToSign, 'utf8').digest('base64');

  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: serviceHost,
        path,
        method,
        timeout: 30000,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: {
          Accept: 'application/xml,application/json',
          ...(bodyBuffer.length ? { 'Content-Length': bodyBuffer.length } : {}),
          ...xmsHeaders,
          ...ordinaryHeaders,
          Authorization: connector.__storageToken ? `Bearer ${connector.__storageToken}` : `SharedKey ${accountName}:${signature}`,
        },
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ statusCode: response.statusCode, body: responseBody });
            return;
          }
          reject(normalizeAzureError('Azure Storage', response.statusCode, responseBody, parseJson(responseBody).error ? parseJson(responseBody) : parseAzureStorageXmlError(responseBody)));
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('Azure Storage connection timed out.')));
    req.on('error', reject);
    if (bodyBuffer.length) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

async function getAccessToken(connector, options = {}) {
  const config = cloudConfig(connector);
  const form = new URLSearchParams({
    client_id: connector.azureClientId,
    client_secret: connector.azureClientSecret,
    grant_type: 'client_credentials',
    scope: options.scope || config.scope,
  }).toString();

  const payload = await requestForm({
    connector,
    host: config.loginHost,
    path: `/${encodeURIComponent(connector.azureTenantId)}/oauth2/v2.0/token`,
    body: form,
    request: options.request,
  });
  if (!payload.access_token) {
    const error = new Error('Azure identity did not return an access token.');
    error.statusCode = 502;
    throw error;
  }
  return payload.access_token;
}

async function armRequest({ connector, token, path, method = 'GET', body = null, request }) {
  const config = cloudConfig(connector);
  return requestJson({
    connector,
    host: config.managementHost,
    path,
    token,
    method,
    body,
    request,
  });
}

async function listArmPages({ connector, token, path, request }) {
  const config = cloudConfig(connector);
  const values = [];
  let nextPath = path;
  let guard = 0;

  while (nextPath && guard < 100) {
    guard += 1;
    const url = nextPath.startsWith('http') ? new URL(nextPath) : null;
    const payload = await requestJson({
      connector,
      host: url?.hostname || config.managementHost,
      path: url ? `${url.pathname}${url.search}` : nextPath,
      token,
      request,
    });
    values.push(...(Array.isArray(payload.value) ? payload.value : []));
    nextPath = payload.nextLink || '';
  }

  return values;
}

function resourceGroupFromId(id = '') {
  const match = String(id).match(/\/resourceGroups\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function typeKey(type = '') {
  return String(type).toLowerCase();
}

function statusFromResource(resource) {
  return resource.properties?.powerState
    || resource.properties?.provisioningState
    || resource.properties?.state
    || resource.properties?.status
    || resource.properties?.publicNetworkAccess
    || '-';
}

function baseResource(resource, providerType) {
  const sourceVmId = resource.properties?.sourceVirtualMachine?.id
    || resource.properties?.source?.id
    || resource.properties?.sourceMetadata?.sourceResourceId
    || '';
  return {
    id: resource.id,
    name: resource.name || resource.id,
    type: resource.type || providerType,
    providerType,
    resourceType: providerType,
    region: resource.location || 'global',
    resourceGroup: resourceGroupFromId(resource.id),
    status: statusFromResource(resource),
    tags: resource.tags || {},
    sourceVmId,
    rawSummary: {
      kind: resource.kind || '',
      sku: resource.sku?.name || resource.sku?.tier || '',
      status: statusFromResource(resource),
      provisioningState: resource.properties?.provisioningState || '',
    },
  };
}

function mapStorageAccount(account) {
  return {
    ...baseResource(account, 'storageAccount'),
    sku: account.sku?.name || '',
    kind: account.kind || '',
    accessTier: account.properties?.accessTier || '',
    publicAccessStatus: account.properties?.allowBlobPublicAccess === false ? 'Disabled' : 'Account setting',
    primaryEndpoints: account.properties?.primaryEndpoints || {},
  };
}

function mapBlobContainer(container, account) {
  return {
    ...baseResource({
      ...container,
      location: account?.region || account?.location || container.location || 'global',
      tags: account?.tags || container.tags || {},
    }, 'blobContainer'),
    storageAccountId: account?.id || container.storageAccountId || '',
    storageAccountName: account?.name || container.storageAccountName || '',
    publicAccessStatus: container.properties?.publicAccess || 'private',
    leaseStatus: container.properties?.leaseStatus || '',
  };
}

function mapFileShare(share, account) {
  return {
    ...baseResource({
      ...share,
      location: account?.region || account?.location || share.location || 'global',
      tags: account?.tags || share.tags || {},
    }, 'fileShare'),
    storageAccountId: account?.id || share.storageAccountId || '',
    storageAccountName: account?.name || share.storageAccountName || '',
    quotaGb: share.properties?.shareQuota || '',
    accessTier: share.properties?.accessTier || '',
  };
}

function mapManagedDisk(disk) {
  return {
    ...baseResource(disk, 'managedDisk'),
    sizeGb: disk.properties?.diskSizeGB || '',
    diskSizeGb: disk.properties?.diskSizeGB || '',
    sku: disk.sku?.name || '',
    storageType: disk.sku?.name || '',
    os: disk.properties?.osType || '',
    attachedVmId: disk.managedBy || disk.properties?.managedBy || '',
    attachedVmName: idName(disk.managedBy || disk.properties?.managedBy || ''),
    zone: Array.isArray(disk.zones) ? disk.zones.join(', ') : '',
  };
}

function mapSnapshot(snapshot) {
  return {
    ...baseResource(snapshot, 'snapshot'),
    sizeGb: snapshot.properties?.diskSizeGB || '',
    diskSizeGb: snapshot.properties?.diskSizeGB || '',
    sku: snapshot.sku?.name || '',
    storageType: snapshot.sku?.name || '',
    sourceResourceId: snapshot.properties?.creationData?.sourceResourceId || '',
    createdAt: snapshot.properties?.timeCreated || '',
  };
}

function azureProviderTypeForType(type = '', kind = '') {
  const normalized = typeKey(type);
  if (normalized === 'microsoft.network/virtualnetworks') return 'vnet';
  if (normalized === 'microsoft.network/virtualnetworks/subnets') return 'subnet';
  if (normalized === 'microsoft.network/routetables') return 'routeTable';
  if (normalized === 'microsoft.network/networksecuritygroups') return 'networkSecurityGroup';
  if (normalized === 'microsoft.network/networksecuritygroups/securityrules') return 'networkSecurityRule';
  if (normalized === 'microsoft.network/publicipaddresses') return 'publicIp';
  if (normalized === 'microsoft.network/loadbalancers') return 'loadBalancer';
  if (normalized === 'microsoft.network/natgateways') return 'natGateway';
  if (normalized === 'microsoft.network/privateendpoints') return 'privateEndpoint';
  if (normalized === 'microsoft.web/sites' && String(kind || '').includes('functionapp')) return 'functionApp';
  if (normalized === 'microsoft.web/sites') return 'appService';
  if (normalized === 'microsoft.app/containerapps') return 'containerApp';
  if (normalized === 'microsoft.storage/storageaccounts') return 'storageAccount';
  if (normalized === 'microsoft.sql/servers') return 'sqlServer';
  if (normalized === 'microsoft.sql/servers/databases') return 'sqlDatabase';
  if (normalized === 'microsoft.documentdb/databaseaccounts') return 'cosmosDbAccount';
  if (normalized === 'microsoft.documentdb/databaseaccounts/sqldatabases') return 'cosmosDbDatabase';
  if (normalized === 'microsoft.dbforpostgresql/flexibleservers') return 'postgresFlexibleServer';
  if (normalized === 'microsoft.dbformysql/flexibleservers') return 'mysqlFlexibleServer';
  if (normalized === 'microsoft.compute/virtualmachines') return 'virtualMachine';
  if (normalized === 'microsoft.compute/disks') return 'managedDisk';
  if (normalized === 'microsoft.compute/snapshots') return 'snapshot';
  if (normalized === 'microsoft.storage/storageaccounts/blobservices/containers') return 'blobContainer';
  if (normalized === 'microsoft.storage/storageaccounts/fileservices/shares') return 'fileShare';
  if (normalized === 'microsoft.compute/images') return 'image';
  if (normalized === 'microsoft.compute/restorepointcollections') return 'restorePointCollection';
  if (normalized === 'microsoft.compute/restorepointcollections/restorepoints') return 'restorePoint';
  return 'resource';
}

function flattenSubnets(vnet) {
  return (vnet.properties?.subnets || []).map((subnet) => ({
    ...baseResource({
      ...subnet,
      type: 'Microsoft.Network/virtualNetworks/subnets',
      location: vnet.location,
      tags: vnet.tags,
    }, 'subnet'),
    vnetId: vnet.id,
    vnetName: vnet.name,
    addressPrefix: subnet.properties?.addressPrefix || (subnet.properties?.addressPrefixes || []).join(', '),
    networkSecurityGroupId: subnet.properties?.networkSecurityGroup?.id || '',
    routeTableId: subnet.properties?.routeTable?.id || '',
  }));
}

function flattenRoutes(routeTable) {
  return (routeTable.properties?.routes || []).map((route) => ({
    ...baseResource({
      ...route,
      type: 'Microsoft.Network/routeTables/routes',
      location: routeTable.location,
      tags: routeTable.tags,
    }, 'route'),
    routeTableId: routeTable.id,
    routeTableName: routeTable.name,
    addressPrefix: route.properties?.addressPrefix || '',
    nextHopType: route.properties?.nextHopType || '',
    nextHopIpAddress: route.properties?.nextHopIpAddress || '',
  }));
}

function flattenSecurityRules(nsg) {
  return (nsg.properties?.securityRules || []).map((rule) => ({
    ...baseResource({
      ...rule,
      type: 'Microsoft.Network/networkSecurityGroups/securityRules',
      location: nsg.location,
      tags: nsg.tags,
    }, 'networkSecurityRule'),
    networkSecurityGroupId: nsg.id,
    networkSecurityGroupName: nsg.name,
    priority: rule.properties?.priority || '',
    direction: rule.properties?.direction || '',
    access: rule.properties?.access || '',
    protocol: rule.properties?.protocol || '',
    sourceAddressPrefix: rule.properties?.sourceAddressPrefix || (rule.properties?.sourceAddressPrefixes || []).join(', '),
    sourcePortRange: rule.properties?.sourcePortRange || (rule.properties?.sourcePortRanges || []).join(', '),
    destinationAddressPrefix: rule.properties?.destinationAddressPrefix || (rule.properties?.destinationAddressPrefixes || []).join(', '),
    destinationPortRange: rule.properties?.destinationPortRange || (rule.properties?.destinationPortRanges || []).join(', '),
  }));
}

function idName(id = '') {
  const parts = String(id).split('/').filter(Boolean);
  return parts[parts.length - 1] || id;
}

function xmlDecode(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlTag(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? xmlDecode(match[1]) : '';
}

function xmlBlocks(xml, tag) {
  return Array.from(String(xml || '').matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'))).map((match) => match[1]);
}

function mapAzureVm(vm, networkById = new Map(), publicIpById = new Map()) {
  const nicRefs = vm.properties?.networkProfile?.networkInterfaces || [];
  const nics = nicRefs.map((ref) => networkById.get(String(ref.id || '').toLowerCase())).filter(Boolean);
  const privateIps = [];
  const publicIps = [];
  nics.forEach((nic) => {
    (nic.properties?.ipConfigurations || []).forEach((config) => {
      if (config.properties?.privateIPAddress) {
        privateIps.push(config.properties.privateIPAddress);
      }
      const publicIpId = config.properties?.publicIPAddress?.id;
      const publicIp = publicIpById.get(String(publicIpId || '').toLowerCase());
      const address = publicIp?.properties?.ipAddress;
      if (address) {
        publicIps.push(address);
      }
    });
  });
  const osDisk = vm.properties?.storageProfile?.osDisk || {};
  const dataDisks = vm.properties?.storageProfile?.dataDisks || [];
  const osType = osDisk.osType || vm.properties?.storageProfile?.imageReference?.offer || '';
  const powerState = (vm.properties?.instanceView?.statuses || []).find((status) => String(status.code || '').toLowerCase().startsWith('powerstate/'));
  return {
    ...baseResource(vm, 'virtualMachine'),
    status: powerState?.displayStatus || powerState?.code || statusFromResource(vm),
    size: vm.properties?.hardwareProfile?.vmSize || vm.sku?.name || '',
    shape: vm.properties?.hardwareProfile?.vmSize || vm.sku?.name || '',
    os: osType,
    privateIp: privateIps.join(', '),
    publicIp: publicIps.join(', '),
    diskSizeGb: Number(osDisk.diskSizeGB || 0) + dataDisks.reduce((total, disk) => total + Number(disk.diskSizeGB || 0), 0),
    osDiskId: osDisk.managedDisk?.id || '',
    networkInterfaceIds: nicRefs.map((ref) => ref.id).filter(Boolean),
    rawSummary: {
      ...baseResource(vm, 'virtualMachine').rawSummary,
      vmSize: vm.properties?.hardwareProfile?.vmSize || '',
      os: osType,
      privateIp: privateIps.join(', '),
      publicIp: publicIps.join(', '),
      osDiskId: osDisk.managedDisk?.id || '',
    },
  };
}

function mapSqlServer(server) {
  return {
    ...baseResource(server, 'sqlServer'),
    version: server.properties?.version || '',
    administratorLogin: server.properties?.administratorLogin || '',
    publicNetworkAccess: server.properties?.publicNetworkAccess || '',
  };
}

function mapSqlDatabase(database, server = null) {
  return {
    ...baseResource(database, 'sqlDatabase'),
    serverId: server?.id || database.id?.split('/databases/')[0] || '',
    serverName: server?.name || idName(database.id?.split('/databases/')[0] || ''),
    sku: database.sku?.name || '',
    tier: database.sku?.tier || database.properties?.currentServiceObjectiveName || '',
    capacity: database.sku?.capacity || '',
    maxSizeBytes: database.properties?.maxSizeBytes || '',
    autoPauseDelay: database.properties?.autoPauseDelay || '',
    minCapacity: database.properties?.minCapacity || '',
    zoneRedundant: database.properties?.zoneRedundant === true,
  };
}

function mapCosmosAccount(account) {
  return {
    ...baseResource(account, 'cosmosDbAccount'),
    kind: account.kind || '',
    consistencyPolicy: account.properties?.consistencyPolicy?.defaultConsistencyLevel || '',
    locations: (account.properties?.locations || []).map((location) => location.locationName).filter(Boolean).join(', '),
  };
}

function mapCosmosDatabase(database, account = null) {
  return {
    ...baseResource(database, 'cosmosDbDatabase'),
    accountId: account?.id || database.id?.split('/sqlDatabases/')[0] || '',
    accountName: account?.name || idName(database.id?.split('/sqlDatabases/')[0] || ''),
    databaseName: database.properties?.resource?.id || database.name || '',
    throughput: database.properties?.options?.throughput || '',
    autoscaleMaxThroughput: database.properties?.options?.autoscaleSettings?.maxThroughput || '',
  };
}

function mapFlexibleServer(server, providerType) {
  return {
    ...baseResource(server, providerType),
    sku: server.sku?.name || '',
    tier: server.sku?.tier || '',
    version: server.properties?.version || '',
    storageSizeGb: server.properties?.storage?.storageSizeGB || '',
    administratorLogin: server.properties?.administratorLogin || '',
    backupRetentionDays: server.properties?.backup?.backupRetentionDays || '',
    highAvailability: server.properties?.highAvailability?.mode || '',
  };
}

function emptyInventory(connector) {
  const now = new Date().toISOString();
  return {
    generatedAt: now,
    cached: false,
    scanStatus: 'cached',
    connector: {
      id: connector.id,
      name: connector.name,
      subscriptionId: connector.azureSubscriptionId,
      subscriptionName: connector.azureSubscriptionName || '',
      tenantId: connector.azureTenantId,
      cloud: connector.azureCloud || 'public',
    },
    scan: {
      requestedScope: 'subscription',
      scannedSubscriptionId: connector.azureSubscriptionId,
      scannedRegions: [],
    },
    summary: {},
    subscriptions: [],
    resourceGroups: [],
    regions: [],
    vnets: [],
    subnets: [],
    routeTables: [],
    routes: [],
    networkSecurityGroups: [],
    networkSecurityRules: [],
    publicIps: [],
    loadBalancers: [],
    natGateways: [],
    privateEndpoints: [],
    appServices: [],
    functionApps: [],
    containerApps: [],
    storageAccounts: [],
    blobContainers: [],
    blobs: [],
    fileShares: [],
    sqlServers: [],
    sqlDatabases: [],
    cosmosDbAccounts: [],
    cosmosDbDatabases: [],
    postgresFlexibleServers: [],
    mysqlFlexibleServers: [],
    virtualMachines: [],
    managedDisks: [],
    snapshots: [],
    images: [],
    restorePointCollections: [],
    restorePoints: [],
    tags: [],
    allResources: [],
    errors: [],
  };
}

function addUniqueTag(tagMap, tags = {}) {
  Object.entries(tags || {}).forEach(([key, value]) => {
    tagMap.set(key, { key, value: String(value ?? '') });
  });
}

function computeSummary(inventory) {
  return {
    subscriptions: inventory.subscriptions.length,
    resourceGroups: inventory.resourceGroups.length,
    regions: inventory.regions.length,
    vnets: inventory.vnets.length,
    subnets: inventory.subnets.length,
    routeTables: inventory.routeTables.length,
    routes: inventory.routes.length,
    networkSecurityGroups: inventory.networkSecurityGroups.length,
    networkSecurityRules: inventory.networkSecurityRules.length,
    publicIps: inventory.publicIps.length,
    loadBalancers: inventory.loadBalancers.length,
    natGateways: inventory.natGateways.length,
    privateEndpoints: inventory.privateEndpoints.length,
    appServices: inventory.appServices.length,
    functionApps: inventory.functionApps.length,
    containerApps: inventory.containerApps.length,
    storageAccounts: inventory.storageAccounts.length,
    blobContainers: inventory.blobContainers.length,
    blobs: inventory.blobs.length,
    fileShares: inventory.fileShares.length,
    sqlServers: inventory.sqlServers.length,
    sqlDatabases: inventory.sqlDatabases.length,
    cosmosDbAccounts: inventory.cosmosDbAccounts.length,
    cosmosDbDatabases: inventory.cosmosDbDatabases.length,
    postgresFlexibleServers: inventory.postgresFlexibleServers.length,
    mysqlFlexibleServers: inventory.mysqlFlexibleServers.length,
    virtualMachines: inventory.virtualMachines.length,
    runningVirtualMachines: inventory.virtualMachines.filter((vm) => String(vm.status || '').toLowerCase().includes('running')).length,
    managedDisks: inventory.managedDisks.length,
    snapshots: inventory.snapshots.length,
    images: inventory.images.length,
    restorePointCollections: inventory.restorePointCollections.length,
    restorePoints: inventory.restorePoints.length,
    totalResources: inventory.allResources.length,
  };
}

export async function getAzureInventory(connector, options = {}) {
  const token = await getAccessToken(connector, options);
  const subscriptionId = encodeURIComponent(connector.azureSubscriptionId);
  const inventory = emptyInventory(connector);
  const tagMap = new Map();

  const calls = [
    ['subscriptions', `/subscriptions?api-version=2020-01-01`],
    ['regions', `/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`],
    ['resourceGroups', `/subscriptions/${subscriptionId}/resourcegroups?api-version=2021-04-01`],
    ['resources', `/subscriptions/${subscriptionId}/resources?api-version=2021-04-01`],
  ];

  for (const [name, path] of calls) {
    try {
      const values = await listArmPages({ connector, token, path, request: options.request });
      if (name === 'resources') {
        inventory.allResources = values.map((resource) => baseResource(resource, azureProviderTypeForType(resource.type, resource.kind)));
      } else {
        inventory[name] = values.map((resource) => baseResource(resource, name === 'regions' ? 'region' : name.slice(0, -1)));
      }
      values.forEach((resource) => addUniqueTag(tagMap, resource.tags));
    } catch (error) {
      inventory.errors.push({ scope: name, message: error.message });
    }
  }

  const resources = inventory.allResources;
  inventory.vnets = resources.filter((item) => typeKey(item.type) === 'microsoft.network/virtualnetworks').map((item) => ({ ...item, providerType: 'vnet', resourceType: 'vnet' }));
  inventory.subnets = resources.filter((item) => typeKey(item.type) === 'microsoft.network/virtualnetworks/subnets').map((item) => ({ ...item, providerType: 'subnet', resourceType: 'subnet' }));
  inventory.routeTables = resources.filter((item) => typeKey(item.type) === 'microsoft.network/routetables').map((item) => ({ ...item, providerType: 'routeTable', resourceType: 'routeTable' }));
  inventory.routes = resources.filter((item) => typeKey(item.type) === 'microsoft.network/routetables/routes').map((item) => ({ ...item, providerType: 'route', resourceType: 'route' }));
  inventory.networkSecurityGroups = resources.filter((item) => typeKey(item.type) === 'microsoft.network/networksecuritygroups').map((item) => ({ ...item, providerType: 'networkSecurityGroup', resourceType: 'networkSecurityGroup' }));
  inventory.networkSecurityRules = resources.filter((item) => typeKey(item.type) === 'microsoft.network/networksecuritygroups/securityrules').map((item) => ({ ...item, providerType: 'networkSecurityRule', resourceType: 'networkSecurityRule' }));
  inventory.publicIps = resources.filter((item) => typeKey(item.type) === 'microsoft.network/publicipaddresses').map((item) => ({ ...item, providerType: 'publicIp', resourceType: 'publicIp' }));
  inventory.loadBalancers = resources.filter((item) => typeKey(item.type) === 'microsoft.network/loadbalancers').map((item) => ({ ...item, providerType: 'loadBalancer', resourceType: 'loadBalancer' }));
  inventory.natGateways = resources.filter((item) => typeKey(item.type) === 'microsoft.network/natgateways').map((item) => ({ ...item, providerType: 'natGateway', resourceType: 'natGateway' }));
  inventory.privateEndpoints = resources.filter((item) => typeKey(item.type) === 'microsoft.network/privateendpoints').map((item) => ({ ...item, providerType: 'privateEndpoint', resourceType: 'privateEndpoint' }));
  inventory.appServices = resources.filter((item) => typeKey(item.type) === 'microsoft.web/sites' && !String(item.rawSummary.kind || '').includes('functionapp')).map((item) => ({ ...item, providerType: 'appService', resourceType: 'appService' }));
  inventory.functionApps = resources.filter((item) => typeKey(item.type) === 'microsoft.web/sites' && String(item.rawSummary.kind || '').includes('functionapp')).map((item) => ({ ...item, providerType: 'functionApp', resourceType: 'functionApp' }));
  inventory.containerApps = resources.filter((item) => typeKey(item.type) === 'microsoft.app/containerapps').map((item) => ({ ...item, providerType: 'containerApp', resourceType: 'containerApp' }));
  inventory.storageAccounts = resources.filter((item) => typeKey(item.type) === 'microsoft.storage/storageaccounts').map((item) => ({ ...item, providerType: 'storageAccount', resourceType: 'storageAccount' }));
  inventory.sqlServers = resources.filter((item) => typeKey(item.type) === 'microsoft.sql/servers').map((item) => ({ ...item, providerType: 'sqlServer', resourceType: 'sqlServer' }));
  inventory.sqlDatabases = resources.filter((item) => typeKey(item.type) === 'microsoft.sql/servers/databases').map((item) => ({ ...item, providerType: 'sqlDatabase', resourceType: 'sqlDatabase' }));
  inventory.cosmosDbAccounts = resources.filter((item) => typeKey(item.type) === 'microsoft.documentdb/databaseaccounts').map((item) => ({ ...item, providerType: 'cosmosDbAccount', resourceType: 'cosmosDbAccount' }));
  inventory.postgresFlexibleServers = resources.filter((item) => typeKey(item.type) === 'microsoft.dbforpostgresql/flexibleservers').map((item) => ({ ...item, providerType: 'postgresFlexibleServer', resourceType: 'postgresFlexibleServer' }));
  inventory.mysqlFlexibleServers = resources.filter((item) => typeKey(item.type) === 'microsoft.dbformysql/flexibleservers').map((item) => ({ ...item, providerType: 'mysqlFlexibleServer', resourceType: 'mysqlFlexibleServer' }));
  inventory.virtualMachines = resources.filter((item) => typeKey(item.type) === 'microsoft.compute/virtualmachines').map((item) => ({ ...item, providerType: 'virtualMachine', resourceType: 'virtualMachine' }));
  inventory.managedDisks = resources.filter((item) => typeKey(item.type) === 'microsoft.compute/disks').map((item) => ({ ...item, providerType: 'managedDisk', resourceType: 'managedDisk' }));
  inventory.snapshots = resources.filter((item) => typeKey(item.type) === 'microsoft.compute/snapshots').map((item) => ({ ...item, providerType: 'snapshot', resourceType: 'snapshot' }));
  inventory.images = resources.filter((item) => typeKey(item.type) === 'microsoft.compute/images').map((item) => ({ ...item, providerType: 'image', resourceType: 'image' }));
  inventory.restorePointCollections = resources.filter((item) => typeKey(item.type) === 'microsoft.compute/restorepointcollections').map((item) => ({ ...item, providerType: 'restorePointCollection', resourceType: 'restorePointCollection' }));

  try {
    const vnets = await listArmPages({
      connector,
      token,
      path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`,
      request: options.request,
    });
    inventory.vnets = vnets.map((vnet) => ({
      ...baseResource(vnet, 'vnet'),
      addressPrefixes: (vnet.properties?.addressSpace?.addressPrefixes || []).join(', '),
    }));
    const expandedSubnets = vnets.flatMap(flattenSubnets);
    const subnetIds = new Set(inventory.subnets.map((subnet) => subnet.id));
    inventory.subnets = [...inventory.subnets, ...expandedSubnets.filter((subnet) => !subnetIds.has(subnet.id))];
  } catch (error) {
    inventory.errors.push({ scope: 'subnets', message: error.message });
  }

  try {
    const [routeTables, networkSecurityGroups, publicIps, loadBalancers, natGateways, privateEndpoints] = await Promise.all([
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/routeTables?api-version=2023-09-01`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/networkSecurityGroups?api-version=2023-09-01`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/publicIPAddresses?api-version=2023-09-01`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/loadBalancers?api-version=2023-09-01`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/natGateways?api-version=2023-09-01`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/privateEndpoints?api-version=2023-09-01`, request: options.request }),
    ]);
    inventory.routeTables = routeTables.map((routeTable) => ({
      ...baseResource(routeTable, 'routeTable'),
      disableBgpRoutePropagation: routeTable.properties?.disableBgpRoutePropagation === true,
    }));
    inventory.routes = routeTables.flatMap(flattenRoutes);
    inventory.networkSecurityGroups = networkSecurityGroups.map((nsg) => ({
      ...baseResource(nsg, 'networkSecurityGroup'),
      ruleCount: nsg.properties?.securityRules?.length || 0,
    }));
    inventory.networkSecurityRules = networkSecurityGroups.flatMap(flattenSecurityRules);
    inventory.publicIps = publicIps.map((publicIp) => ({
      ...baseResource(publicIp, 'publicIp'),
      publicIp: publicIp.properties?.ipAddress || '',
      allocationMethod: publicIp.properties?.publicIPAllocationMethod || '',
      sku: publicIp.sku?.name || '',
    }));
    inventory.loadBalancers = loadBalancers.map((loadBalancer) => ({
      ...baseResource(loadBalancer, 'loadBalancer'),
      sku: loadBalancer.sku?.name || '',
      frontendIpCount: loadBalancer.properties?.frontendIPConfigurations?.length || 0,
    }));
    inventory.natGateways = natGateways.map((natGateway) => ({
      ...baseResource(natGateway, 'natGateway'),
      sku: natGateway.sku?.name || '',
      publicIpIds: (natGateway.properties?.publicIpAddresses || []).map((ref) => ref.id).filter(Boolean).join(', '),
    }));
    inventory.privateEndpoints = privateEndpoints.map((endpoint) => ({
      ...baseResource(endpoint, 'privateEndpoint'),
      subnetId: endpoint.properties?.subnet?.id || '',
      privateLinkServiceConnections: (endpoint.properties?.privateLinkServiceConnections || []).map((connection) => connection.name).join(', '),
    }));
    const networkTypes = new Set([
      'microsoft.network/virtualnetworks',
      'microsoft.network/virtualnetworks/subnets',
      'microsoft.network/routetables',
      'microsoft.network/routetables/routes',
      'microsoft.network/networksecuritygroups',
      'microsoft.network/networksecuritygroups/securityrules',
      'microsoft.network/publicipaddresses',
      'microsoft.network/loadbalancers',
      'microsoft.network/natgateways',
      'microsoft.network/privateendpoints',
    ]);
    inventory.allResources = [
      ...inventory.allResources.filter((resource) => !networkTypes.has(typeKey(resource.type))),
      ...inventory.vnets,
      ...inventory.subnets,
      ...inventory.routeTables,
      ...inventory.routes,
      ...inventory.networkSecurityGroups,
      ...inventory.networkSecurityRules,
      ...inventory.publicIps,
      ...inventory.loadBalancers,
      ...inventory.natGateways,
      ...inventory.privateEndpoints,
    ];
  } catch (error) {
    inventory.errors.push({ scope: 'networkDetails', message: error.message });
  }

  try {
    const [sqlServers, cosmosAccounts, postgresServers, mysqlServers] = await Promise.all([
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.Sql/servers?api-version=2022-05-01-preview`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.DocumentDB/databaseAccounts?api-version=2023-04-15`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=2023-06-01-preview`, request: options.request }),
      listArmPages({ connector, token, path: `/subscriptions/${subscriptionId}/providers/Microsoft.DBforMySQL/flexibleServers?api-version=2023-06-30`, request: options.request }),
    ]);
    inventory.sqlServers = sqlServers.map(mapSqlServer);
    const databaseResults = await Promise.all(sqlServers.map(async (server) => {
      try {
        const databases = await listArmPages({ connector, token, path: `${server.id}/databases?api-version=2022-05-01-preview`, request: options.request });
        return databases.map((database) => mapSqlDatabase(database, server));
      } catch (error) {
        inventory.errors.push({ scope: 'sqlDatabases', message: `${server.name}: ${error.message}` });
        return [];
      }
    }));
    inventory.sqlDatabases = databaseResults.flat();
    inventory.cosmosDbAccounts = cosmosAccounts.map(mapCosmosAccount);
    const cosmosDatabaseResults = await Promise.all(cosmosAccounts.map(async (account) => {
      try {
        const databases = await listArmPages({ connector, token, path: `${account.id}/sqlDatabases?api-version=2023-04-15`, request: options.request });
        return databases.map((database) => mapCosmosDatabase(database, account));
      } catch (error) {
        inventory.errors.push({ scope: 'cosmosDbDatabases', message: `${account.name}: ${error.message}` });
        return [];
      }
    }));
    inventory.cosmosDbDatabases = cosmosDatabaseResults.flat();
    inventory.postgresFlexibleServers = postgresServers.map((server) => mapFlexibleServer(server, 'postgresFlexibleServer'));
    inventory.mysqlFlexibleServers = mysqlServers.map((server) => mapFlexibleServer(server, 'mysqlFlexibleServer'));
    const databaseTypes = new Set([
      'microsoft.sql/servers',
      'microsoft.sql/servers/databases',
      'microsoft.documentdb/databaseaccounts',
      'microsoft.documentdb/databaseaccounts/sqldatabases',
      'microsoft.dbforpostgresql/flexibleservers',
      'microsoft.dbformysql/flexibleservers',
    ]);
    inventory.allResources = [
      ...inventory.allResources.filter((resource) => !databaseTypes.has(typeKey(resource.type))),
      ...inventory.sqlServers,
      ...inventory.sqlDatabases,
      ...inventory.cosmosDbAccounts,
      ...inventory.cosmosDbDatabases,
      ...inventory.postgresFlexibleServers,
      ...inventory.mysqlFlexibleServers,
    ];
  } catch (error) {
    inventory.errors.push({ scope: 'databases', message: error.message });
  }

  try {
    const [accounts, disks, snapshots] = await Promise.all([
      listArmPages({
        connector,
        token,
        path: `/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`,
        request: options.request,
      }),
      listArmPages({
        connector,
        token,
        path: `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/disks?api-version=2023-04-02`,
        request: options.request,
      }),
      listArmPages({
        connector,
        token,
        path: `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/snapshots?api-version=2023-04-02`,
        request: options.request,
      }),
    ]);
    inventory.storageAccounts = accounts.map(mapStorageAccount);
    inventory.managedDisks = disks.map(mapManagedDisk);
    inventory.snapshots = snapshots.map(mapSnapshot);
    const childResults = await Promise.all(accounts.map(async (account) => {
      const [containers, shares] = await Promise.all([
        listArmPages({
          connector,
          token,
          path: `${account.id}/blobServices/default/containers?api-version=2023-01-01`,
          request: options.request,
        }).catch((error) => {
          inventory.errors.push({ scope: 'blobContainers', message: `${account.name}: ${error.message}` });
          return [];
        }),
        listArmPages({
          connector,
          token,
          path: `${account.id}/fileServices/default/shares?api-version=2023-01-01`,
          request: options.request,
        }).catch((error) => {
          inventory.errors.push({ scope: 'fileShares', message: `${account.name}: ${error.message}` });
          return [];
        }),
      ]);
      const accountResource = mapStorageAccount(account);
      return {
        containers: containers.map((container) => mapBlobContainer(container, accountResource)),
        shares: shares.map((share) => mapFileShare(share, accountResource)),
      };
    }));
    inventory.blobContainers = childResults.flatMap((result) => result.containers);
    inventory.fileShares = childResults.flatMap((result) => result.shares);
    const allResourceIds = new Set(inventory.allResources.map((resource) => String(resource.id || '').toLowerCase()));
    const storageResources = [
      ...inventory.storageAccounts,
      ...inventory.managedDisks,
      ...inventory.snapshots,
      ...inventory.blobContainers,
      ...inventory.fileShares,
    ];
    inventory.allResources = [
      ...inventory.allResources.filter((resource) => ![
        'microsoft.storage/storageaccounts',
        'microsoft.compute/disks',
        'microsoft.compute/snapshots',
      ].includes(typeKey(resource.type))),
      ...storageResources.filter((item) => !allResourceIds.has(String(item.id || '').toLowerCase()) || true),
    ];
  } catch (error) {
    inventory.errors.push({ scope: 'storage', message: error.message });
  }

  try {
    const [vms, nics, publicIps] = await Promise.all([
      listArmPages({
        connector,
        token,
        path: `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2023-09-01`,
        request: options.request,
      }),
      listArmPages({
        connector,
        token,
        path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/networkInterfaces?api-version=2023-09-01`,
        request: options.request,
      }),
      listArmPages({
        connector,
        token,
        path: `/subscriptions/${subscriptionId}/providers/Microsoft.Network/publicIPAddresses?api-version=2023-09-01`,
        request: options.request,
      }),
    ]);
    const networkById = new Map(nics.map((nic) => [String(nic.id || '').toLowerCase(), nic]));
    const publicIpById = new Map(publicIps.map((ip) => [String(ip.id || '').toLowerCase(), ip]));
    const vmsWithInstanceView = await Promise.all(vms.map(async (vm) => {
      try {
        const instanceView = await armRequest({
          connector,
          token,
          path: `${vm.id}/instanceView?api-version=2023-09-01`,
          request: options.request,
        });
        return {
          ...vm,
          properties: {
            ...(vm.properties || {}),
            instanceView,
          },
        };
      } catch (error) {
        inventory.errors.push({ scope: 'virtualMachineInstanceView', message: `${vm.name || vm.id}: ${error.message}` });
        return vm;
      }
    }));
    const detailedVms = vmsWithInstanceView.map((vm) => mapAzureVm(vm, networkById, publicIpById));
    const existingIds = new Set(inventory.allResources.map((resource) => String(resource.id || '').toLowerCase()));
    inventory.virtualMachines = detailedVms;
    inventory.allResources = [
      ...inventory.allResources.filter((resource) => typeKey(resource.type) !== 'microsoft.compute/virtualmachines'),
      ...detailedVms.filter((vm) => !existingIds.has(String(vm.id || '').toLowerCase()) || true),
    ];
  } catch (error) {
    inventory.errors.push({ scope: 'virtualMachines', message: error.message });
  }

  try {
    const restorePointCollections = await listArmPages({
      connector,
      token,
      path: `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/restorePointCollections?api-version=2024-11-01`,
      request: options.request,
    });
    inventory.restorePointCollections = restorePointCollections.map((collection) => ({
      ...baseResource(collection, 'restorePointCollection'),
      sourceVmId: collection.properties?.source?.id || '',
    }));
    inventory.restorePoints = restorePointCollections.flatMap((collection) =>
      (collection.properties?.restorePoints || []).map((point) => ({
        ...baseResource({
          ...point,
          type: 'Microsoft.Compute/restorePointCollections/restorePoints',
          location: collection.location,
          tags: collection.tags,
        }, 'restorePoint'),
        restorePointCollectionId: collection.id,
        restorePointCollectionName: collection.name,
        sourceVmId: collection.properties?.source?.id || point.properties?.sourceMetadata?.vmId || '',
        createdAt: point.properties?.timeCreated || '',
      })),
    );
    const resourceIds = new Set(inventory.allResources.map((resource) => String(resource.id || '').toLowerCase()));
    inventory.allResources = [
      ...inventory.allResources,
      ...inventory.restorePointCollections.filter((item) => !resourceIds.has(String(item.id || '').toLowerCase())),
      ...inventory.restorePoints.filter((item) => !resourceIds.has(String(item.id || '').toLowerCase())),
    ];
  } catch (error) {
    inventory.errors.push({ scope: 'restorePoints', message: error.message });
  }

  inventory.regions = inventory.regions.map((region) => ({
    ...region,
    name: region.name,
    displayName: region.rawSummary?.displayName || region.name,
  }));
  inventory.scan.scannedRegions = Array.from(new Set(resources.map((item) => item.region).filter(Boolean)));
  inventory.tags = Array.from(tagMap.values()).sort((left, right) => left.key.localeCompare(right.key));
  inventory.summary = computeSummary(inventory);
  inventory.scanStatus = inventory.errors.length ? 'partial' : 'cached';
  return inventory;
}

export async function getAzureVmStatus(connector, { vmId }, options = {}) {
  const id = requireText(vmId, 'VM resource ID');
  const token = await getAccessToken(connector, options);
  const vm = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-09-01`,
    request: options.request,
  });
  const instanceView = await armRequest({
    connector,
    token,
    path: `${id}/instanceView?api-version=2023-09-01`,
    request: options.request,
  }).catch(() => null);
  const vmWithInstanceView = {
    ...vm,
    properties: {
      ...(vm.properties || {}),
      ...(instanceView ? { instanceView } : {}),
    },
  };
  const nicRefs = vm.properties?.networkProfile?.networkInterfaces || [];
  const nics = await Promise.all(nicRefs.map((ref) =>
    armRequest({
      connector,
      token,
      path: `${ref.id}?api-version=2023-09-01`,
      request: options.request,
    }).catch(() => null),
  ));
  const publicIpRefs = nics
    .filter(Boolean)
    .flatMap((nic) => nic.properties?.ipConfigurations || [])
    .map((config) => config.properties?.publicIPAddress?.id)
    .filter(Boolean);
  const publicIps = await Promise.all(publicIpRefs.map((publicIpId) =>
    armRequest({
      connector,
      token,
      path: `${publicIpId}?api-version=2023-09-01`,
      request: options.request,
    }).catch(() => null),
  ));
  const networkById = new Map(nics.filter(Boolean).map((nic) => [String(nic.id || '').toLowerCase(), nic]));
  const publicIpById = new Map(publicIps.filter(Boolean).map((ip) => [String(ip.id || '').toLowerCase(), ip]));
  const mapped = mapAzureVm(vmWithInstanceView, networkById, publicIpById);
  return {
    message: 'Azure VM status refreshed.',
    vm: mapped,
  };
}

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${label} is required.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function requireConfirmation(payload, expected, alternateExpected = '') {
  const confirmation = String(payload?.confirmation || '').trim();
  if (confirmation !== expected && (!alternateExpected || confirmation !== alternateExpected)) {
    const error = new Error('Type the VM name or resource ID to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
}

function operationResult(action, vm, response = {}) {
  return {
    message: `Azure VM ${action} submitted.`,
    operation: {
      status: response.status || 'submitted',
      azureAsyncOperation: response.azureAsyncOperation || '',
      location: response.location || '',
    },
    vm,
  };
}

function networkResult(action, resource, response = {}) {
  return {
    message: `Azure network ${action} submitted.`,
    operation: {
      status: response.status || 'submitted',
      azureAsyncOperation: response.azureAsyncOperation || '',
      location: response.location || '',
    },
    resource,
  };
}

function azureResourceId(connector, resourceGroup, providerPath) {
  return `/subscriptions/${encodeURIComponent(connector.azureSubscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/${providerPath}`;
}

function baseNetworkResource({ id, name, type, providerType, region, resourceGroup, status = 'updating', extra = {} }) {
  return {
    id,
    name,
    type,
    providerType,
    resourceType: providerType,
    region,
    resourceGroup,
    status,
    tags: {},
    ...extra,
  };
}

async function submitVmOperation(connector, vmId, actionPath, actionName, options = {}) {
  const token = await getAccessToken(connector, options);
  const path = `${vmId}/${actionPath}?api-version=2023-09-01`;
  const response = await armRequest({ connector, token, path, method: 'POST', request: options.request });
  return operationResult(actionName, { id: vmId, status: 'updating' }, response);
}

export async function runAzureVmAction(connector, { vmId, action }, options = {}) {
  const id = requireText(vmId, 'VM resource ID');
  const actionMap = {
    start: ['start', 'start'],
    stop: ['powerOff', 'stop'],
    deallocate: ['deallocate', 'deallocate'],
    restart: ['restart', 'restart'],
  };
  const [path, label] = actionMap[action] || [];
  if (!path) {
    const error = new Error('Unsupported Azure VM action.');
    error.statusCode = 400;
    throw error;
  }
  return submitVmOperation(connector, id, path, label, options);
}

export async function resizeAzureVm(connector, { vmId, vmSize }, options = {}) {
  const id = requireText(vmId, 'VM resource ID');
  const size = requireText(vmSize, 'VM size');
  const token = await getAccessToken(connector, options);
  const current = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-09-01`,
    request: options.request,
  });
  const body = {
    ...current,
    properties: {
      ...(current.properties || {}),
      hardwareProfile: {
        ...(current.properties?.hardwareProfile || {}),
        vmSize: size,
      },
    },
  };
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-09-01`,
    method: 'PUT',
    body,
    request: options.request,
  });
  return operationResult('resize', { id, size, shape: size, status: 'updating' }, response);
}

export async function deleteAzureVm(connector, { vmId, vmName, confirmation }, options = {}) {
  const id = requireText(vmId, 'VM resource ID');
  requireConfirmation({ confirmation }, vmName || idName(id), id);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-09-01`,
    method: 'DELETE',
    request: options.request,
  });
  return operationResult('delete', { id, name: vmName || idName(id), status: 'deleting' }, response);
}

export async function createAzureVmSnapshot(connector, { vmId, resourceGroup, name, region, osDiskId }, options = {}) {
  const id = requireText(vmId, 'VM resource ID');
  const rg = requireText(resourceGroup || resourceGroupFromId(id), 'Resource group');
  const snapshotName = requireText(name, 'Snapshot name');
  const location = requireText(region, 'Region');
  const sourceDiskId = requireText(osDiskId, 'OS disk ID');
  const token = await getAccessToken(connector, options);
  const snapshotId = `/subscriptions/${connector.azureSubscriptionId}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Compute/snapshots/${encodeURIComponent(snapshotName)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${snapshotId}?api-version=2023-04-02`,
    method: 'PUT',
    body: {
      location,
      properties: {
        creationData: {
          createOption: 'Copy',
          sourceResourceId: sourceDiskId,
        },
      },
    },
    request: options.request,
  });
  return {
    message: 'Azure VM OS disk snapshot submitted.',
    snapshot: { id: snapshotId, name: snapshotName, region: location, resourceGroup: rg, status: 'creating', providerType: 'snapshot', resourceType: 'snapshot' },
    operation: response,
  };
}

export async function createAzureVmImage(connector, { vmId, resourceGroup, name, region }, options = {}) {
  const id = requireText(vmId, 'VM resource ID');
  const rg = requireText(resourceGroup || resourceGroupFromId(id), 'Resource group');
  const imageName = requireText(name, 'Image name');
  const location = requireText(region, 'Region');
  const token = await getAccessToken(connector, options);
  const imageId = `/subscriptions/${connector.azureSubscriptionId}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Compute/images/${encodeURIComponent(imageName)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${imageId}?api-version=2023-07-03`,
    method: 'PUT',
    body: {
      location,
      properties: {
        sourceVirtualMachine: { id },
      },
    },
    request: options.request,
  });
  return {
    message: 'Azure VM image creation submitted.',
    image: { id: imageId, name: imageName, region: location, resourceGroup: rg, status: 'creating', providerType: 'image', resourceType: 'image', sourceVmId: id },
    operation: response,
  };
}

export async function createAzureVmRestorePoint(connector, { vmId, resourceGroup, collectionName, restorePointName, region, consistencyMode = 'CrashConsistent' }, options = {}) {
  const id = requireText(vmId, 'VM resource ID');
  const rg = requireText(resourceGroup || resourceGroupFromId(id), 'Resource group');
  const location = requireText(region, 'Region');
  const rpcName = requireText(collectionName, 'Restore point collection name');
  const rpName = requireText(restorePointName, 'Restore point name');
  const token = await getAccessToken(connector, options);
  const collectionId = `/subscriptions/${connector.azureSubscriptionId}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Compute/restorePointCollections/${encodeURIComponent(rpcName)}`;
  await armRequest({
    connector,
    token,
    path: `${collectionId}?api-version=2024-11-01`,
    method: 'PUT',
    body: {
      location,
      properties: {
        source: { id },
      },
    },
    request: options.request,
  });
  const restorePointId = `${collectionId}/restorePoints/${encodeURIComponent(rpName)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${restorePointId}?api-version=2024-11-01`,
    method: 'PUT',
    body: {
      properties: {
        consistencyMode,
      },
    },
    request: options.request,
  });
  return {
    message: 'Azure VM restore point creation submitted.',
    restorePoint: {
      id: restorePointId,
      name: rpName,
      region: location,
      resourceGroup: rg,
      status: 'creating',
      providerType: 'restorePoint',
      resourceType: 'restorePoint',
      restorePointCollectionId: collectionId,
      restorePointCollectionName: rpcName,
      sourceVmId: id,
    },
    operation: response,
  };
}

export async function createAzureVm(connector, payload = {}, options = {}) {
  if (process.env.AZURE_ALLOW_PAID_VM_CREATE !== 'true') {
    const error = new Error('Azure VM creation is disabled by default because it can create paid resources. Set AZURE_ALLOW_PAID_VM_CREATE=true on the backend to enable it.');
    error.statusCode = 403;
    throw error;
  }
  if (payload.acceptCostWarning !== true) {
    const error = new Error('Confirm the Azure cost warning before creating a VM.');
    error.statusCode = 400;
    throw error;
  }
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const name = requireText(payload.name, 'VM name');
  const region = requireText(payload.region, 'Region');
  const vmSize = requireText(payload.vmSize, 'VM size');
  const adminUsername = requireText(payload.adminUsername, 'Admin username');
  const networkInterfaceId = requireText(payload.networkInterfaceId, 'Network interface ID');
  const token = await getAccessToken(connector, options);
  const imageReference = payload.imageReference || {
    publisher: 'Canonical',
    offer: '0001-com-ubuntu-server-jammy',
    sku: '22_04-lts-gen2',
    version: 'latest',
  };
  const vmId = `/subscriptions/${connector.azureSubscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(name)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${vmId}?api-version=2023-09-01`,
    method: 'PUT',
    body: {
      location: region,
      tags: payload.tags || {},
      properties: {
        hardwareProfile: { vmSize },
        storageProfile: {
          imageReference,
          osDisk: {
            createOption: 'FromImage',
            managedDisk: { storageAccountType: payload.storageAccountType || 'Standard_LRS' },
          },
        },
        osProfile: {
          computerName: name.slice(0, 15),
          adminUsername,
          ...(payload.adminPassword ? { adminPassword: payload.adminPassword } : {}),
          ...(payload.sshPublicKey ? {
            linuxConfiguration: {
              disablePasswordAuthentication: true,
              ssh: {
                publicKeys: [{
                  path: `/home/${adminUsername}/.ssh/authorized_keys`,
                  keyData: payload.sshPublicKey,
                }],
              },
            },
          } : {}),
        },
        networkProfile: {
          networkInterfaces: [{ id: networkInterfaceId, properties: { primary: true } }],
        },
      },
    },
    request: options.request,
  });
  return operationResult('create', { id: vmId, name, region, resourceGroup, size: vmSize, status: 'creating', providerType: 'virtualMachine', resourceType: 'virtualMachine' }, response);
}

async function getStorageKey(connector, resourceGroup, accountName, options = {}) {
  const token = await getAccessToken(connector, options);
  const path = `/subscriptions/${encodeURIComponent(connector.azureSubscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(accountName)}/listKeys?api-version=2023-01-01`;
  const response = await armRequest({ connector, token, path, method: 'POST', request: options.request });
  const key = response.keys?.[0]?.value;
  if (!key) {
    const error = new Error('Azure Storage did not return an account key. Confirm the connector has Microsoft.Storage/storageAccounts/listKeys/action.');
    error.statusCode = 403;
    throw error;
  }
  return key;
}

export async function createAzureNetworkResource(connector, payload = {}, options = {}) {
  const resourceType = requireText(payload.resourceType, 'Network resource type');
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const region = requireText(payload.region, 'Region');
  const name = requireText(payload.name, 'Name');
  const token = await getAccessToken(connector, options);
  let id;
  let body;
  let providerType = resourceType;
  let azureType = '';

  if (resourceType === 'vnet') {
    const cidrBlock = requireText(payload.cidrBlock, 'VNet CIDR block');
    id = azureResourceId(connector, resourceGroup, `Microsoft.Network/virtualNetworks/${encodeURIComponent(name)}`);
    azureType = 'Microsoft.Network/virtualNetworks';
    body = { location: region, properties: { addressSpace: { addressPrefixes: [cidrBlock] } } };
  } else if (resourceType === 'subnet') {
    const vnetId = requireText(payload.vnetId, 'VNet ID');
    const addressPrefix = requireText(payload.addressPrefix || payload.cidrBlock, 'Subnet address prefix');
    id = `${vnetId}/subnets/${encodeURIComponent(name)}`;
    azureType = 'Microsoft.Network/virtualNetworks/subnets';
    body = {
      properties: {
        addressPrefix,
        ...(payload.routeTableId ? { routeTable: { id: payload.routeTableId } } : {}),
        ...(payload.networkSecurityGroupId ? { networkSecurityGroup: { id: payload.networkSecurityGroupId } } : {}),
      },
    };
  } else if (resourceType === 'routeTable') {
    id = azureResourceId(connector, resourceGroup, `Microsoft.Network/routeTables/${encodeURIComponent(name)}`);
    azureType = 'Microsoft.Network/routeTables';
    body = { location: region, properties: { disableBgpRoutePropagation: payload.disableBgpRoutePropagation === true } };
  } else if (resourceType === 'route') {
    const routeTableId = requireText(payload.routeTableId, 'Route table ID');
    const addressPrefix = requireText(payload.addressPrefix, 'Route address prefix');
    const nextHopType = requireText(payload.nextHopType, 'Next hop type');
    id = `${routeTableId}/routes/${encodeURIComponent(name)}`;
    azureType = 'Microsoft.Network/routeTables/routes';
    providerType = 'route';
    body = { properties: { addressPrefix, nextHopType, ...(payload.nextHopIpAddress ? { nextHopIpAddress: payload.nextHopIpAddress } : {}) } };
  } else if (resourceType === 'networkSecurityGroup') {
    id = azureResourceId(connector, resourceGroup, `Microsoft.Network/networkSecurityGroups/${encodeURIComponent(name)}`);
    azureType = 'Microsoft.Network/networkSecurityGroups';
    body = { location: region, properties: { securityRules: [] } };
  } else if (resourceType === 'networkSecurityRule') {
    const networkSecurityGroupId = requireText(payload.networkSecurityGroupId, 'Network security group ID');
    id = `${networkSecurityGroupId}/securityRules/${encodeURIComponent(name)}`;
    azureType = 'Microsoft.Network/networkSecurityGroups/securityRules';
    body = {
      properties: {
        priority: Number(payload.priority || 100),
        direction: payload.direction || 'Inbound',
        access: payload.access || 'Allow',
        protocol: payload.protocol || 'Tcp',
        sourceAddressPrefix: payload.sourceAddressPrefix || '*',
        sourcePortRange: payload.sourcePortRange || '*',
        destinationAddressPrefix: payload.destinationAddressPrefix || '*',
        destinationPortRange: payload.destinationPortRange || '*',
      },
    };
  } else if (resourceType === 'publicIp') {
    id = azureResourceId(connector, resourceGroup, `Microsoft.Network/publicIPAddresses/${encodeURIComponent(name)}`);
    azureType = 'Microsoft.Network/publicIPAddresses';
    body = {
      location: region,
      sku: { name: payload.sku || 'Standard' },
      properties: { publicIPAllocationMethod: payload.allocationMethod || 'Static' },
    };
  } else if (resourceType === 'natGateway') {
    const publicIpId = requireText(payload.publicIpId, 'Public IP ID');
    id = azureResourceId(connector, resourceGroup, `Microsoft.Network/natGateways/${encodeURIComponent(name)}`);
    azureType = 'Microsoft.Network/natGateways';
    body = {
      location: region,
      sku: { name: payload.sku || 'Standard' },
      properties: {
        publicIpAddresses: [{ id: publicIpId }],
        idleTimeoutInMinutes: Number(payload.idleTimeoutInMinutes || 4),
      },
    };
  } else {
    const error = new Error('Unsupported Azure network resource type.');
    error.statusCode = 400;
    throw error;
  }

  const response = await armRequest({ connector, token, path: `${id}?api-version=2023-09-01`, method: 'PUT', body, request: options.request });
  const resource = baseNetworkResource({
    id,
    name,
    type: azureType,
    providerType,
    region,
    resourceGroup,
    status: 'creating',
    extra: {
      cidrBlock: payload.cidrBlock || payload.addressPrefix || '',
      addressPrefix: payload.addressPrefix || payload.cidrBlock || '',
      vnetId: payload.vnetId || '',
      routeTableId: payload.routeTableId || '',
      networkSecurityGroupId: payload.networkSecurityGroupId || '',
      publicIpId: payload.publicIpId || '',
    },
  });
  return networkResult('create', resource, response);
}

export async function deleteAzureNetworkResource(connector, payload = {}, options = {}) {
  const resourceId = requireText(payload.resourceId, 'Network resource ID');
  const resourceName = payload.resourceName || idName(resourceId);
  requireConfirmation({ confirmation: payload.confirmation }, resourceName, resourceId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${resourceId}?api-version=2023-09-01`, method: 'DELETE', request: options.request });
  return networkResult('delete', {
    id: resourceId,
    name: resourceName,
    providerType: payload.resourceType || azureProviderTypeForType(payload.type || ''),
    resourceType: payload.resourceType || azureProviderTypeForType(payload.type || ''),
    region: payload.region || '',
    resourceGroup: payload.resourceGroup || resourceGroupFromId(resourceId),
    status: 'deleting',
  }, response);
}

export async function createAzureSqlDatabase(connector, payload = {}, options = {}) {
  const serverId = requireText(payload.serverId, 'Azure SQL server ID');
  const name = requireText(payload.name, 'Database name');
  const region = requireText(payload.region, 'Region');
  const resourceGroup = payload.resourceGroup || resourceGroupFromId(serverId);
  const token = await getAccessToken(connector, options);
  const id = `${serverId}/databases/${encodeURIComponent(name)}`;
  const skuName = payload.skuName || 'GP_S_Gen5_1';
  const tier = payload.tier || 'GeneralPurpose';
  const capacity = Number(payload.capacity || 1);
  const maxSizeBytes = Number(payload.maxSizeGb || 32) * 1024 * 1024 * 1024;
  const autoPauseDelay = Number(payload.autoPauseDelay || 60);
  const minCapacity = Number(payload.minCapacity || 0.5);
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2022-05-01-preview`,
    method: 'PUT',
    body: {
      location: region,
      sku: { name: skuName, tier, capacity },
      properties: {
        maxSizeBytes,
        autoPauseDelay,
        minCapacity,
        zoneRedundant: false,
      },
    },
    request: options.request,
  });
  return {
    message: 'Azure SQL database creation submitted.',
    database: {
      id,
      name,
      type: 'Microsoft.Sql/servers/databases',
      providerType: 'sqlDatabase',
      resourceType: 'sqlDatabase',
      region,
      resourceGroup,
      status: 'creating',
      serverId,
      serverName: idName(serverId),
      sku: skuName,
      tier,
      capacity,
      maxSizeGb: payload.maxSizeGb || '32',
      autoPauseDelay,
      minCapacity,
      tags: {},
    },
    operation: response,
  };
}

function requireCostAcceptance(payload, label) {
  if (payload.acceptCostWarning !== true) {
    const error = new Error(`${label} can create Azure billable resources. Confirm the cost warning to continue.`);
    error.statusCode = 400;
    throw error;
  }
}

export async function createAzureDatabaseResource(connector, payload = {}, options = {}) {
  const databaseType = requireText(payload.databaseType || payload.resourceType, 'Database type');
  if (databaseType === 'sqlDatabase') {
    return createAzureSqlDatabase(connector, payload, options);
  }

  const name = requireText(payload.name, 'Resource name');
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const region = requireText(payload.region, 'Region');
  const token = await getAccessToken(connector, options);

  if (databaseType === 'sqlServer') {
    requireCostAcceptance(payload, 'Azure SQL server');
    const administratorLogin = requireText(payload.administratorLogin, 'Administrator login');
    const administratorPassword = requireText(payload.administratorPassword, 'Administrator password');
    const id = azureResourceId(connector, resourceGroup, `Microsoft.Sql/servers/${encodeURIComponent(name)}`);
    const response = await armRequest({
      connector,
      token,
      path: `${id}?api-version=2022-05-01-preview`,
      method: 'PUT',
      body: {
        location: region,
        properties: {
          administratorLogin,
          administratorLoginPassword: administratorPassword,
          version: payload.version || '12.0',
          minimalTlsVersion: payload.minimalTlsVersion || '1.2',
          publicNetworkAccess: payload.publicNetworkAccess || 'Disabled',
        },
      },
      request: options.request,
    });
    return {
      message: 'Azure SQL server creation submitted.',
      resource: {
        id,
        name,
        type: 'Microsoft.Sql/servers',
        providerType: 'sqlServer',
        resourceType: 'sqlServer',
        region,
        resourceGroup,
        status: 'creating',
        version: payload.version || '12.0',
        administratorLogin,
        publicNetworkAccess: payload.publicNetworkAccess || 'Disabled',
        tags: {},
      },
      operation: response,
    };
  }

  if (databaseType === 'cosmosDbAccount') {
    requireCostAcceptance(payload, 'Cosmos DB account');
    const id = azureResourceId(connector, resourceGroup, `Microsoft.DocumentDB/databaseAccounts/${encodeURIComponent(name)}`);
    const response = await armRequest({
      connector,
      token,
      path: `${id}?api-version=2023-04-15`,
      method: 'PUT',
      body: {
        location: region,
        kind: payload.kind || 'GlobalDocumentDB',
        properties: {
          databaseAccountOfferType: 'Standard',
          consistencyPolicy: {
            defaultConsistencyLevel: payload.consistencyLevel || 'Session',
          },
          locations: [{
            locationName: region,
            failoverPriority: 0,
            isZoneRedundant: false,
          }],
        },
      },
      request: options.request,
    });
    return {
      message: 'Cosmos DB account creation submitted.',
      resource: {
        id,
        name,
        type: 'Microsoft.DocumentDB/databaseAccounts',
        providerType: 'cosmosDbAccount',
        resourceType: 'cosmosDbAccount',
        region,
        resourceGroup,
        status: 'creating',
        kind: payload.kind || 'GlobalDocumentDB',
        consistencyPolicy: payload.consistencyLevel || 'Session',
        locations: region,
        tags: {},
      },
      operation: response,
    };
  }

  if (databaseType === 'cosmosDbDatabase') {
    requireCostAcceptance(payload, 'Cosmos DB database');
    const accountId = requireText(payload.accountId, 'Cosmos DB account');
    const id = `${accountId}/sqlDatabases/${encodeURIComponent(name)}`;
    const throughput = Number(payload.throughput || 400);
    const body = {
      location: region,
      properties: {
        resource: { id: name },
        options: payload.autoscaleMaxThroughput
          ? { autoscaleSettings: { maxThroughput: Number(payload.autoscaleMaxThroughput) } }
          : { throughput },
      },
    };
    const response = await armRequest({
      connector,
      token,
      path: `${id}?api-version=2023-04-15`,
      method: 'PUT',
      body,
      request: options.request,
    });
    return {
      message: 'Cosmos DB database creation submitted.',
      resource: {
        id,
        name,
        type: 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases',
        providerType: 'cosmosDbDatabase',
        resourceType: 'cosmosDbDatabase',
        region,
        resourceGroup,
        status: 'creating',
        accountId,
        accountName: idName(accountId),
        databaseName: name,
        throughput: payload.autoscaleMaxThroughput ? '' : throughput,
        autoscaleMaxThroughput: payload.autoscaleMaxThroughput || '',
        tags: {},
      },
      operation: response,
    };
  }

  if (databaseType === 'postgresFlexibleServer' || databaseType === 'mysqlFlexibleServer') {
    requireCostAcceptance(payload, databaseType === 'postgresFlexibleServer' ? 'PostgreSQL flexible server' : 'MySQL flexible server');
    const administratorLogin = requireText(payload.administratorLogin, 'Administrator login');
    const administratorPassword = requireText(payload.administratorPassword, 'Administrator password');
    const provider = databaseType === 'postgresFlexibleServer' ? 'Microsoft.DBforPostgreSQL' : 'Microsoft.DBforMySQL';
    const apiVersion = databaseType === 'postgresFlexibleServer' ? '2023-06-01-preview' : '2023-06-30';
    const id = azureResourceId(connector, resourceGroup, `${provider}/flexibleServers/${encodeURIComponent(name)}`);
    const skuName = payload.sku || 'Standard_B1ms';
    const tier = payload.tier || 'Burstable';
    const version = payload.version || (databaseType === 'postgresFlexibleServer' ? '16' : '8.0.21');
    const storageSizeGb = Number(payload.storageSizeGb || 32);
    const response = await armRequest({
      connector,
      token,
      path: `${id}?api-version=${apiVersion}`,
      method: 'PUT',
      body: {
        location: region,
        sku: { name: skuName, tier },
        properties: {
          administratorLogin,
          administratorLoginPassword: administratorPassword,
          version,
          storage: { storageSizeGB: storageSizeGb },
          backup: { backupRetentionDays: Number(payload.backupRetentionDays || 7) },
          highAvailability: { mode: 'Disabled' },
          network: { publicNetworkAccess: payload.publicNetworkAccess || 'Disabled' },
        },
      },
      request: options.request,
    });
    return {
      message: `${databaseType === 'postgresFlexibleServer' ? 'PostgreSQL' : 'MySQL'} flexible server creation submitted.`,
      resource: {
        id,
        name,
        type: `${provider}/flexibleServers`,
        providerType: databaseType,
        resourceType: databaseType,
        region,
        resourceGroup,
        status: 'creating',
        sku: skuName,
        tier,
        version,
        storageSizeGb,
        administratorLogin,
        backupRetentionDays: payload.backupRetentionDays || '7',
        highAvailability: 'Disabled',
        tags: {},
      },
      operation: response,
    };
  }

  const error = new Error('Unsupported Azure database resource type.');
  error.statusCode = 400;
  throw error;
}

export async function deleteAzureSqlDatabase(connector, payload = {}, options = {}) {
  const databaseId = requireText(payload.databaseId, 'Azure SQL database ID');
  const databaseName = payload.databaseName || idName(databaseId);
  requireConfirmation({ confirmation: payload.confirmation }, databaseName, databaseId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${databaseId}?api-version=2022-05-01-preview`, method: 'DELETE', request: options.request });
  return {
    message: 'Azure SQL database deletion submitted.',
    database: { id: databaseId, name: databaseName, status: 'deleting', providerType: 'sqlDatabase', resourceType: 'sqlDatabase' },
    operation: response,
  };
}

function azureDatabaseApiVersion(resourceType = '', resourceId = '') {
  const normalized = String(resourceType || azureProviderTypeForType(resourceId)).toLowerCase();
  const id = String(resourceId || '').toLowerCase();
  if (normalized === 'sqldatabase' || id.includes('/providers/microsoft.sql/servers/') && id.includes('/databases/')) return '2022-05-01-preview';
  if (normalized === 'sqlserver' || id.includes('/providers/microsoft.sql/servers/')) return '2022-05-01-preview';
  if (normalized === 'cosmosdbaccount' || id.includes('/providers/microsoft.documentdb/databaseaccounts/')) return '2023-04-15';
  if (normalized === 'cosmosdbdatabase' || id.includes('/providers/microsoft.documentdb/databaseaccounts/') && id.includes('/sqldatabases/')) return '2023-04-15';
  if (normalized === 'postgresflexibleserver' || id.includes('/providers/microsoft.dbforpostgresql/flexibleservers/')) return '2023-06-01-preview';
  if (normalized === 'mysqlflexibleserver' || id.includes('/providers/microsoft.dbformysql/flexibleservers/')) return '2023-06-30';
  return '2022-05-01-preview';
}

function mapAzureDatabaseResource(resource, resourceType = '') {
  const type = resourceType || azureProviderTypeForType(resource.type || resource.id || '');
  if (type === 'sqlServer') return mapSqlServer(resource);
  if (type === 'sqlDatabase') return mapSqlDatabase(resource);
  if (type === 'cosmosDbAccount') return mapCosmosAccount(resource);
  if (type === 'cosmosDbDatabase') return mapCosmosDatabase(resource);
  if (type === 'postgresFlexibleServer' || type === 'mysqlFlexibleServer') return mapFlexibleServer(resource, type);
  return baseResource(resource, type || 'database');
}

export async function refreshAzureDatabaseResource(connector, payload = {}, options = {}) {
  const resourceId = requireText(payload.resourceId, 'Database resource ID');
  const resourceType = payload.resourceType || azureProviderTypeForType(payload.type || resourceId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({
    connector,
    token,
    path: `${resourceId}?api-version=${azureDatabaseApiVersion(resourceType, resourceId)}`,
    request: options.request,
  });
  const resource = mapAzureDatabaseResource(response, resourceType);
  return {
    message: 'Azure database resource status refreshed.',
    resource,
  };
}

export async function deleteAzureDatabaseResource(connector, payload = {}, options = {}) {
  const resourceId = requireText(payload.resourceId || payload.databaseId, 'Database resource ID');
  const resourceType = payload.resourceType || azureProviderTypeForType(payload.type || resourceId);
  const resourceName = payload.resourceName || payload.databaseName || idName(resourceId);
  if (resourceType === 'sqlDatabase') {
    const data = await deleteAzureSqlDatabase(connector, { ...payload, databaseId: resourceId, databaseName: resourceName }, options);
    return { ...data, resource: data.database };
  }
  requireConfirmation({ confirmation: payload.confirmation }, resourceName, resourceId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({
    connector,
    token,
    path: `${resourceId}?api-version=${azureDatabaseApiVersion(resourceType, resourceId)}`,
    method: 'DELETE',
    request: options.request,
  });
  return {
    message: 'Azure database resource deletion submitted.',
    resource: {
      id: resourceId,
      name: resourceName,
      providerType: resourceType,
      resourceType,
      region: payload.region || '',
      resourceGroup: payload.resourceGroup || resourceGroupFromId(resourceId),
      status: 'deleting',
    },
    operation: response,
  };
}

export async function runAzureDatabaseResourceAction(connector, payload = {}, options = {}) {
  const resourceId = requireText(payload.resourceId || payload.databaseId, 'Database resource ID');
  const action = requireText(payload.action, 'Database action');
  const resourceType = payload.resourceType || azureProviderTypeForType(payload.type || resourceId);
  if (resourceType === 'sqlDatabase') {
    const sqlAction = action === 'start' ? 'resume' : action === 'stop' ? 'pause' : action;
    const data = await runAzureSqlDatabaseAction(connector, { ...payload, databaseId: resourceId, databaseName: payload.resourceName || payload.databaseName, action: sqlAction }, options);
    return { ...data, resource: data.database };
  }
  if (!['postgresFlexibleServer', 'mysqlFlexibleServer'].includes(resourceType) || !['start', 'stop'].includes(action)) {
    const error = new Error('Start and stop are supported only for Azure SQL databases and PostgreSQL/MySQL flexible servers.');
    error.statusCode = 400;
    throw error;
  }
  const token = await getAccessToken(connector, options);
  const response = await armRequest({
    connector,
    token,
    path: `${resourceId}/${action}?api-version=${azureDatabaseApiVersion(resourceType, resourceId)}`,
    method: 'POST',
    request: options.request,
  });
  return {
    message: `Azure database resource ${action} submitted.`,
    resource: {
      id: resourceId,
      name: payload.resourceName || idName(resourceId),
      providerType: resourceType,
      resourceType,
      region: payload.region || '',
      resourceGroup: payload.resourceGroup || resourceGroupFromId(resourceId),
      status: action === 'start' ? 'starting' : 'stopping',
    },
    operation: response,
  };
}

export async function runAzureSqlDatabaseAction(connector, payload = {}, options = {}) {
  const databaseId = requireText(payload.databaseId, 'Azure SQL database ID');
  const action = requireText(payload.action, 'Azure SQL database action');
  if (!['pause', 'resume'].includes(action)) {
    const error = new Error('Unsupported Azure SQL database action.');
    error.statusCode = 400;
    throw error;
  }
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${databaseId}/${action}?api-version=2022-05-01-preview`, method: 'POST', request: options.request });
  return {
    message: `Azure SQL database ${action} submitted.`,
    database: { id: databaseId, name: payload.databaseName || idName(databaseId), status: action === 'pause' ? 'pausing' : 'resuming', providerType: 'sqlDatabase', resourceType: 'sqlDatabase' },
    operation: response,
  };
}

export async function scaleAzureSqlDatabase(connector, payload = {}, options = {}) {
  const databaseId = requireText(payload.databaseId, 'Azure SQL database ID');
  const token = await getAccessToken(connector, options);
  const skuName = payload.skuName || 'GP_S_Gen5_1';
  const tier = payload.tier || 'GeneralPurpose';
  const capacity = Number(payload.capacity || 1);
  const body = {
    location: payload.region,
    sku: { name: skuName, tier, capacity },
    properties: {
      ...(payload.maxSizeGb ? { maxSizeBytes: Number(payload.maxSizeGb) * 1024 * 1024 * 1024 } : {}),
      ...(payload.autoPauseDelay ? { autoPauseDelay: Number(payload.autoPauseDelay) } : {}),
      ...(payload.minCapacity ? { minCapacity: Number(payload.minCapacity) } : {}),
    },
  };
  const response = await armRequest({ connector, token, path: `${databaseId}?api-version=2022-05-01-preview`, method: 'PUT', body, request: options.request });
  return {
    message: 'Azure SQL database scale submitted.',
    database: {
      id: databaseId,
      name: payload.databaseName || idName(databaseId),
      status: 'updating',
      providerType: 'sqlDatabase',
      resourceType: 'sqlDatabase',
      region: payload.region || '',
      resourceGroup: resourceGroupFromId(databaseId),
      sku: skuName,
      tier,
      capacity,
      maxSizeGb: payload.maxSizeGb,
      autoPauseDelay: payload.autoPauseDelay,
      minCapacity: payload.minCapacity,
    },
    operation: response,
  };
}

function shouldRetryStorageWithEntra(error) {
  return error?.statusCode === 403;
}

async function requestStorageWithFallback(connector, resourceGroup, accountName, requestOptions, options = {}) {
  try {
    const storageKey = await getStorageKey(connector, resourceGroup, accountName, options);
    return await requestStorage({
      ...requestOptions,
      connector: { ...connector, __storageKey: storageKey },
      accountName,
      request: options.request,
    });
  } catch (error) {
    if (!shouldRetryStorageWithEntra(error)) {
      throw error;
    }
    const storageToken = await getAccessToken(connector, { ...options, scope: cloudConfig(connector).storageScope });
    try {
      return await requestStorage({
        ...requestOptions,
        connector: { ...connector, __storageToken: storageToken },
        accountName,
        request: options.request,
      });
    } catch (entraError) {
      if (entraError?.statusCode === 403) {
        entraError.message = [
          entraError.message,
          'Grant the Azure connector service principal Storage Blob Data Contributor on this storage account or enable key-based access with listKeys permission.',
        ].join(' ');
      }
      throw entraError;
    }
  }
}

export async function createAzureStorageAccount(connector, payload = {}, options = {}) {
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const accountName = requireText(payload.accountName || payload.name, 'Storage account name').toLowerCase();
  const region = requireText(payload.region, 'Region');
  const sku = payload.sku || 'Standard_LRS';
  const kind = payload.kind || 'StorageV2';
  const networkDefaultAction = payload.publicNetworkAccessScope === 'selected' ? 'Deny' : 'Allow';
  const encryptionServices = payload.customerManagedKeyScope === 'allServices'
    ? {
      blob: { enabled: true, keyType: 'Account' },
      file: { enabled: true, keyType: 'Account' },
      table: { enabled: true, keyType: 'Account' },
      queue: { enabled: true, keyType: 'Account' },
    }
    : {
      blob: { enabled: true, keyType: 'Account' },
      file: { enabled: true, keyType: 'Account' },
    };
  const token = await getAccessToken(connector, options);
  const id = `/subscriptions/${connector.azureSubscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(accountName)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-01-01`,
    method: 'PUT',
    body: {
      location: region,
      sku: { name: sku },
      kind,
      properties: {
        accessTier: payload.accessTier || 'Hot',
        allowBlobPublicAccess: payload.allowBlobPublicAccess === true,
        allowCrossTenantReplication: payload.allowCrossTenantReplication === true,
        allowSharedKeyAccess: payload.allowSharedKeyAccess !== false,
        allowedCopyScope: payload.allowedCopyScope || undefined,
        defaultToOAuthAuthentication: payload.defaultToOAuthAuthentication === true,
        enableHttpsTrafficOnly: payload.requireSecureTransfer !== false,
        enableNfsV3: payload.enableNfsV3 === true,
        isHnsEnabled: payload.enableHierarchicalNamespace === true,
        isSftpEnabled: payload.enableSftp === true,
        largeFileSharesState: payload.preferredStorageType === 'files' ? 'Enabled' : undefined,
        minimumTlsVersion: payload.minimumTlsVersion || 'TLS1_2',
        networkAcls: {
          bypass: 'AzureServices',
          defaultAction: networkDefaultAction,
        },
        publicNetworkAccess: payload.publicNetworkAccess || 'Enabled',
        routingPreference: {
          routingChoice: payload.routingPreference || 'MicrosoftRouting',
          publishMicrosoftEndpoints: true,
          publishInternetEndpoints: payload.routingPreference === 'InternetRouting',
        },
        encryption: {
          keySource: payload.encryptionType === 'CustomerManaged' ? 'Microsoft.Keyvault' : 'Microsoft.Storage',
          requireInfrastructureEncryption: payload.infrastructureEncryption === true,
          services: encryptionServices,
        },
      },
      tags: payload.tags || {},
    },
    request: options.request,
  });
  return {
    message: 'Azure storage account creation submitted.',
    storageAccount: {
      id,
      name: accountName,
      type: 'Microsoft.Storage/storageAccounts',
      providerType: 'storageAccount',
      resourceType: 'storageAccount',
      region,
      resourceGroup,
      status: 'creating',
      sku,
      kind,
      accessTier: payload.accessTier || 'Hot',
      publicAccessStatus: payload.allowBlobPublicAccess === true ? 'Allowed' : 'Disabled',
      networkAccess: payload.publicNetworkAccess || 'Enabled',
      minimumTlsVersion: payload.minimumTlsVersion || 'TLS1_2',
      preferredStorageType: payload.preferredStorageType || 'blob',
      performance: payload.performance || (String(sku).startsWith('Premium') ? 'Premium' : 'Standard'),
      dataProtection: {
        pointInTimeRestore: payload.enablePointInTimeRestore === true,
        blobSoftDelete: payload.enableBlobSoftDelete === true,
        blobSoftDeleteDays: payload.blobSoftDeleteDays,
        containerSoftDelete: payload.enableContainerSoftDelete === true,
        containerSoftDeleteDays: payload.containerSoftDeleteDays,
        fileShareSoftDelete: payload.enableFileShareSoftDelete === true,
        fileShareSoftDeleteDays: payload.fileShareSoftDeleteDays,
        blobVersioning: payload.enableBlobVersioning === true,
        blobChangeFeed: payload.enableBlobChangeFeed === true,
        versionLevelImmutability: payload.enableVersionLevelImmutability === true,
      },
      tags: payload.tags || {},
    },
    operation: response,
  };
}

export async function deleteAzureStorageAccount(connector, payload = {}, options = {}) {
  const id = requireText(payload.accountId, 'Storage account resource ID');
  const name = payload.accountName || idName(id);
  requireConfirmation({ confirmation: payload.confirmation }, name, id);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${id}?api-version=2023-01-01`, method: 'DELETE', request: options.request });
  return {
    message: 'Azure storage account deletion submitted.',
    storageAccount: { id, name, status: 'deleting', providerType: 'storageAccount', resourceType: 'storageAccount' },
    operation: response,
  };
}

export async function createAzureBlobContainer(connector, payload = {}, options = {}) {
  const accountId = requireText(payload.accountId, 'Storage account resource ID');
  const accountName = requireText(payload.accountName, 'Storage account name');
  const containerName = requireText(payload.containerName, 'Blob container name').toLowerCase();
  const token = await getAccessToken(connector, options);
  const id = `${accountId}/blobServices/default/containers/${encodeURIComponent(containerName)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-01-01`,
    method: 'PUT',
    body: {
      properties: {
        publicAccess: payload.publicAccess || 'None',
      },
    },
    request: options.request,
  });
  return {
    message: 'Azure blob container creation submitted.',
    container: {
      id,
      name: containerName,
      type: 'Microsoft.Storage/storageAccounts/blobServices/containers',
      providerType: 'blobContainer',
      resourceType: 'blobContainer',
      region: payload.region || 'global',
      resourceGroup: payload.resourceGroup || resourceGroupFromId(accountId),
      storageAccountId: accountId,
      storageAccountName: accountName,
      publicAccessStatus: payload.publicAccess || 'None',
      status: 'available',
    },
    operation: response,
  };
}

export async function deleteAzureBlobContainer(connector, payload = {}, options = {}) {
  const containerId = requireText(payload.containerId, 'Blob container resource ID');
  const containerName = payload.containerName || idName(containerId);
  requireConfirmation({ confirmation: payload.confirmation }, containerName, containerId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${containerId}?api-version=2023-01-01`, method: 'DELETE', request: options.request });
  return {
    message: 'Azure blob container deletion submitted.',
    container: { id: containerId, name: containerName, status: 'deleting', providerType: 'blobContainer', resourceType: 'blobContainer' },
    operation: response,
  };
}

export async function createAzureFileShare(connector, payload = {}, options = {}) {
  const accountId = requireText(payload.accountId, 'Storage account resource ID');
  const accountName = requireText(payload.accountName, 'Storage account name');
  const shareName = requireText(payload.shareName || payload.name, 'File share name').toLowerCase();
  const quotaGb = Number(payload.quotaGb || 100);
  if (!Number.isFinite(quotaGb) || quotaGb < 1) {
    const error = new Error('File share quota must be at least 1 GB.');
    error.statusCode = 400;
    throw error;
  }
  const token = await getAccessToken(connector, options);
  const id = `${accountId}/fileServices/default/shares/${encodeURIComponent(shareName)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-01-01`,
    method: 'PUT',
    body: {
      properties: {
        shareQuota: quotaGb,
        ...(payload.accessTier ? { accessTier: payload.accessTier } : {}),
      },
    },
    request: options.request,
  });
  return {
    message: 'Azure file share creation submitted.',
    fileShare: {
      id,
      name: shareName,
      type: 'Microsoft.Storage/storageAccounts/fileServices/shares',
      providerType: 'fileShare',
      resourceType: 'fileShare',
      region: payload.region || 'global',
      resourceGroup: payload.resourceGroup || resourceGroupFromId(accountId),
      storageAccountId: accountId,
      storageAccountName: accountName,
      quotaGb,
      accessTier: payload.accessTier || '',
      status: 'creating',
    },
    operation: response,
  };
}

export async function deleteAzureFileShare(connector, payload = {}, options = {}) {
  const shareId = requireText(payload.shareId, 'File share resource ID');
  const shareName = payload.shareName || idName(shareId);
  requireConfirmation({ confirmation: payload.confirmation }, shareName, shareId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${shareId}?api-version=2023-01-01`, method: 'DELETE', request: options.request });
  return {
    message: 'Azure file share deletion submitted.',
    fileShare: { id: shareId, name: shareName, status: 'deleting', providerType: 'fileShare', resourceType: 'fileShare' },
    operation: response,
  };
}

export async function listAzureBlobs(connector, payload = {}, options = {}) {
  const accountName = requireText(payload.accountName, 'Storage account name');
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const containerName = requireText(payload.containerName, 'Blob container name');
  const prefix = String(payload.prefix || '');
  const response = await requestStorageWithFallback(connector, resourceGroup, accountName, {
    path: `/${encodeURIComponent(containerName)}?restype=container&comp=list${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`,
  }, options);
  const blobs = xmlBlocks(response.body, 'Blob').map((block) => {
    const name = xmlTag(block, 'Name');
    const properties = xmlTag(block, 'Properties');
    return {
      id: `${accountName}/${containerName}/${name}`,
      name,
      key: name,
      providerType: 'blob',
      resourceType: 'blob',
      storageAccountName: accountName,
      containerName,
      region: payload.region || 'global',
      resourceGroup,
      sizeBytes: xmlTag(properties, 'Content-Length'),
      contentType: xmlTag(properties, 'Content-Type'),
      lastModified: xmlTag(properties, 'Last-Modified'),
      etag: xmlTag(properties, 'Etag'),
      status: 'available',
    };
  });
  return { generatedAt: new Date().toISOString(), blobs };
}

export async function uploadAzureBlob(connector, payload = {}, options = {}) {
  const accountName = requireText(payload.accountName, 'Storage account name');
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const containerName = requireText(payload.containerName, 'Blob container name');
  const blobName = requireText(payload.blobName || payload.name, 'Blob name');
  const content = payload.contentBase64 ? Buffer.from(String(payload.contentBase64), 'base64') : Buffer.from(String(payload.content || ''), 'utf8');
  await requestStorageWithFallback(connector, resourceGroup, accountName, {
    path: `/${encodeURIComponent(containerName)}/${blobName.split('/').map(encodeURIComponent).join('/')}`,
    method: 'PUT',
    body: content,
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': payload.contentType || 'application/octet-stream',
    },
  }, options);
  return {
    message: 'Azure blob uploaded.',
    blob: {
      id: `${accountName}/${containerName}/${blobName}`,
      name: blobName,
      key: blobName,
      providerType: 'blob',
      resourceType: 'blob',
      storageAccountName: accountName,
      containerName,
      region: payload.region || 'global',
      resourceGroup,
      sizeBytes: content.length,
      contentType: payload.contentType || 'application/octet-stream',
      status: 'available',
    },
  };
}

export async function deleteAzureBlob(connector, payload = {}, options = {}) {
  const accountName = requireText(payload.accountName, 'Storage account name');
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const containerName = requireText(payload.containerName, 'Blob container name');
  const blobName = requireText(payload.blobName || payload.name, 'Blob name');
  requireConfirmation({ confirmation: payload.confirmation }, blobName, `${accountName}/${containerName}/${blobName}`);
  await requestStorageWithFallback(connector, resourceGroup, accountName, {
    path: `/${encodeURIComponent(containerName)}/${blobName.split('/').map(encodeURIComponent).join('/')}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'Azure blob deleted.',
    blob: { id: `${accountName}/${containerName}/${blobName}`, name: blobName, key: blobName, providerType: 'blob', resourceType: 'blob' },
  };
}

export async function createAzureManagedDisk(connector, payload = {}, options = {}) {
  const resourceGroup = requireText(payload.resourceGroup, 'Resource group');
  const name = requireText(payload.name, 'Disk name');
  const region = requireText(payload.region, 'Region');
  const sizeGb = Number(payload.sizeGb || 0);
  if (!Number.isFinite(sizeGb) || sizeGb < 1) {
    const error = new Error('Disk size must be at least 1 GB.');
    error.statusCode = 400;
    throw error;
  }
  const token = await getAccessToken(connector, options);
  const id = `/subscriptions/${connector.azureSubscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/disks/${encodeURIComponent(name)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-04-02`,
    method: 'PUT',
    body: {
      location: region,
      sku: { name: payload.sku || 'Standard_LRS' },
      properties: {
        creationData: payload.snapshotId
          ? { createOption: 'Copy', sourceResourceId: payload.snapshotId }
          : { createOption: 'Empty' },
        diskSizeGB: sizeGb,
      },
      tags: payload.tags || {},
    },
    request: options.request,
  });
  return {
    message: payload.snapshotId ? 'Azure managed disk restore submitted.' : 'Azure managed disk creation submitted.',
    disk: {
      id,
      name,
      type: 'Microsoft.Compute/disks',
      providerType: 'managedDisk',
      resourceType: 'managedDisk',
      region,
      resourceGroup,
      status: 'creating',
      sizeGb,
      diskSizeGb: sizeGb,
      storageType: payload.sku || 'Standard_LRS',
      sku: payload.sku || 'Standard_LRS',
      sourceResourceId: payload.snapshotId || '',
    },
    operation: response,
  };
}

export async function resizeAzureManagedDisk(connector, payload = {}, options = {}) {
  const diskId = requireText(payload.diskId, 'Disk resource ID');
  const sizeGb = Number(payload.sizeGb || 0);
  if (!Number.isFinite(sizeGb) || sizeGb < 1) {
    const error = new Error('Disk size must be at least 1 GB.');
    error.statusCode = 400;
    throw error;
  }
  const token = await getAccessToken(connector, options);
  const current = await armRequest({ connector, token, path: `${diskId}?api-version=2023-04-02`, request: options.request });
  const response = await armRequest({
    connector,
    token,
    path: `${diskId}?api-version=2023-04-02`,
    method: 'PUT',
    body: {
      ...current,
      properties: {
        ...(current.properties || {}),
        diskSizeGB: sizeGb,
      },
    },
    request: options.request,
  });
  return {
    message: 'Azure managed disk resize submitted.',
    disk: { ...mapManagedDisk(current), sizeGb, diskSizeGb: sizeGb, status: 'updating' },
    operation: response,
  };
}

export async function deleteAzureManagedDisk(connector, payload = {}, options = {}) {
  const diskId = requireText(payload.diskId, 'Disk resource ID');
  const diskName = payload.diskName || idName(diskId);
  requireConfirmation({ confirmation: payload.confirmation }, diskName, diskId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${diskId}?api-version=2023-04-02`, method: 'DELETE', request: options.request });
  return {
    message: 'Azure managed disk deletion submitted.',
    disk: { id: diskId, name: diskName, status: 'deleting', providerType: 'managedDisk', resourceType: 'managedDisk' },
    operation: response,
  };
}

export async function createAzureDiskSnapshot(connector, payload = {}, options = {}) {
  const diskId = requireText(payload.diskId, 'Disk resource ID');
  const resourceGroup = requireText(payload.resourceGroup || resourceGroupFromId(diskId), 'Resource group');
  const name = requireText(payload.name, 'Snapshot name');
  const region = requireText(payload.region, 'Region');
  const token = await getAccessToken(connector, options);
  const id = `/subscriptions/${connector.azureSubscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/snapshots/${encodeURIComponent(name)}`;
  const response = await armRequest({
    connector,
    token,
    path: `${id}?api-version=2023-04-02`,
    method: 'PUT',
    body: {
      location: region,
      sku: { name: payload.sku || 'Standard_LRS' },
      properties: {
        creationData: {
          createOption: 'Copy',
          sourceResourceId: diskId,
        },
      },
      tags: payload.tags || {},
    },
    request: options.request,
  });
  return {
    message: 'Azure disk snapshot creation submitted.',
    snapshot: {
      id,
      name,
      type: 'Microsoft.Compute/snapshots',
      providerType: 'snapshot',
      resourceType: 'snapshot',
      region,
      resourceGroup,
      status: 'creating',
      sourceResourceId: diskId,
      sku: payload.sku || 'Standard_LRS',
    },
    operation: response,
  };
}

export async function deleteAzureDiskSnapshot(connector, payload = {}, options = {}) {
  const snapshotId = requireText(payload.snapshotId, 'Snapshot resource ID');
  const snapshotName = payload.snapshotName || idName(snapshotId);
  requireConfirmation({ confirmation: payload.confirmation }, snapshotName, snapshotId);
  const token = await getAccessToken(connector, options);
  const response = await armRequest({ connector, token, path: `${snapshotId}?api-version=2023-04-02`, method: 'DELETE', request: options.request });
  return {
    message: 'Azure disk snapshot deletion submitted.',
    snapshot: { id: snapshotId, name: snapshotName, status: 'deleting', providerType: 'snapshot', resourceType: 'snapshot' },
    operation: response,
  };
}
