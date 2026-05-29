import https from 'https';
import { getGcpAccessToken } from './gcpVerifier.js';

function parseJson(body) {
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
}

function normalizeError(host, statusCode, payload, body) {
  const detail = payload.error?.message || payload.error_description || payload.error || body.slice(0, 180);
  const projectFromDetail = String(detail).match(/projects\/([^/]+)/)?.[1];
  const project = payload.error?.details?.[0]?.metadata?.project || projectFromDetail || 'the selected project';
  if (statusCode === 403 && String(detail).includes('compute.instances.create')) {
    return `${host} returned HTTP ${statusCode}: the selected GCP connector service account cannot create Compute Engine VMs in project ${project}. Grant Compute Instance Admin (v1) on that project, and Service Account User if the VM uses a service account. Original GCP message: ${detail}`;
  }
  if (statusCode === 403 && String(detail).includes('iam.serviceAccounts.actAs')) {
    return `${host} returned HTTP ${statusCode}: the selected GCP connector service account cannot attach the target VM service account. Grant Service Account User on the VM service account. Original GCP message: ${detail}`;
  }
  if (statusCode === 403 && (String(detail).includes('compute.subnetworks.use') || String(detail).includes('compute.networks.use'))) {
    return `${host} returned HTTP ${statusCode}: the selected GCP connector service account cannot use the selected network or subnet. Grant Compute Network User on the network project or choose a network in a project where the connector has access. Original GCP message: ${detail}`;
  }
  if (statusCode === 403 && String(detail).includes('compute.disks.create')) {
    return `${host} returned HTTP ${statusCode}: the selected GCP connector service account cannot create boot or data disks. Grant Compute Instance Admin (v1) or a custom role that includes compute.disks.create. Original GCP message: ${detail}`;
  }
  if (statusCode === 400 && String(detail).includes('must specify a subnet')) {
    return `${host} returned HTTP ${statusCode}: the selected VPC network uses custom subnet mode, so a subnet is required. Select a subnet in the same region as the VM zone, then retry. Original GCP message: ${detail}`;
  }
  return detail ? `${host} returned HTTP ${statusCode}: ${detail}` : `${host} returned HTTP ${statusCode}.`;
}

function requestJson({ connector, host, path, token, method = 'GET', body, rawBody, contentType, request = https.request }) {
  return new Promise((resolve) => {
    const requestBody = rawBody !== undefined ? String(rawBody) : body === undefined ? '' : JSON.stringify(body);
    const req = request(
      {
        protocol: 'https:',
        hostname: host,
        path,
        method,
        timeout: 20000,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(requestBody ? { 'Content-Type': contentType || 'application/json', 'Content-Length': Buffer.byteLength(requestBody) } : {}),
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
          resolve({
            ok: false,
            statusCode: response.statusCode,
            message: normalizeError(host, response.statusCode, payload, responseBody),
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`${host} connection timed out.`));
    });
    req.on('error', (error) => {
      resolve({ ok: false, message: error.message || `Unable to reach ${host}.` });
    });
    if (requestBody) {
      req.write(requestBody);
    }
    req.end();
  });
}

async function listPaged({ connector, token, host, path, collection = 'items', request }) {
  const rows = [];
  let pageToken = '';
  do {
    const separator = path.includes('?') ? '&' : '?';
    const response = await requestJson({
      connector,
      host,
      path: `${path}${pageToken ? `${separator}pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      token,
      request,
    });
    if (!response.ok) {
      throw new Error(response.message);
    }
    rows.push(...(response.payload?.[collection] || []));
    pageToken = response.payload?.nextPageToken || '';
  } while (pageToken);
  return rows;
}

async function safeList(label, errors, fn) {
  try {
    return await fn();
  } catch (error) {
    errors.push({ scope: label, message: error.message || `Unable to scan ${label}.` });
    return [];
  }
}

function flattenAggregated(payload, childKey) {
  return Object.entries(payload || {}).flatMap(([scope, group]) =>
    (group?.[childKey] || []).map((item) => ({ ...item, scope })),
  );
}

function labelsFrom(item) {
  return item.labels || item.tags || {};
}

function timestampFrom(item) {
  return item.creationTimestamp || item.timeCreated || item.created || item.creationTime || '';
}

function zoneFrom(url = '') {
  return String(url).split('/zones/').pop() || '';
}

function regionFrom(url = '') {
  return String(url).split('/regions/').pop() || '';
}

function selfId(item) {
  return item.selfLink || item.id || item.name || '';
}

function resource(item, type, extra = {}) {
  return {
    id: String(selfId(item)),
    name: item.name || item.id || '',
    providerType: type,
    resourceType: type,
    type,
    status: item.status || item.lifecycleState || item.state || item.databaseVersion || 'available',
    region: extra.region || regionFrom(item.region || '') || '',
    availabilityDomain: extra.zone || zoneFrom(item.zone || '') || '',
    description: item.description || '',
    labels: labelsFrom(item),
    tags: labelsFrom(item),
    createdAt: timestampFrom(item),
    rawSummary: item,
    ...extra,
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

function zonalComputeResource(value, zone, collection) {
  const text = String(value || '').trim();
  if (!text || text.includes('/')) {
    return text;
  }
  return `zones/${zone}/${collection}/${text}`;
}

function operationSummary(operation, zone = '', region = '') {
  return {
    id: operation.selfLink || operation.name || '',
    name: operation.name || '',
    status: operation.status || 'PENDING',
    zone,
    region,
    operationType: operation.operationType || '',
    targetLink: operation.targetLink || '',
    progress: operation.progress ?? 0,
    error: operation.error,
    rawSummary: operation,
  };
}

async function authed(connector, options = {}) {
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected GCP connector before using compute management.');
    error.statusCode = 400;
    throw error;
  }
  const tokenResponse = await getGcpAccessToken(connector, options);
  if (!tokenResponse.ok || !tokenResponse.payload?.access_token) {
    const error = new Error(tokenResponse.message || 'Unable to authenticate to Google Cloud.');
    error.statusCode = 400;
    throw error;
  }
  return tokenResponse.payload.access_token;
}

async function computeRequest(connector, { path, method = 'GET', body }, options = {}) {
  const token = await authed(connector, options);
  const response = await requestJson({
    connector,
    host: 'compute.googleapis.com',
    path,
    method,
    body,
    token,
    request: options.request,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'Google Compute Engine request failed.');
    error.statusCode = response.statusCode >= 400 && response.statusCode < 500 ? response.statusCode : 502;
    throw error;
  }
  return response.payload;
}

async function storageRequest(connector, { path, method = 'GET', body, rawBody, contentType }, options = {}) {
  const token = await authed(connector, options);
  const response = await requestJson({
    connector,
    host: 'storage.googleapis.com',
    path,
    method,
    body,
    rawBody,
    contentType,
    token,
    request: options.request,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'Google Cloud Storage request failed.');
    error.statusCode = response.statusCode >= 400 && response.statusCode < 500 ? response.statusCode : 502;
    throw error;
  }
  return response.payload;
}

async function sqlRequest(connector, { path, method = 'GET', body }, options = {}) {
  const token = await authed(connector, options);
  const response = await requestJson({
    connector,
    host: 'sqladmin.googleapis.com',
    path,
    method,
    body,
    token,
    request: options.request,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'Google Cloud SQL request failed.');
    error.statusCode = response.statusCode >= 400 && response.statusCode < 500 ? response.statusCode : 502;
    throw error;
  }
  return response.payload;
}

function normalizeGcpInstance(item, projectId) {
  return resource(item, 'computeInstance', {
    id: item.selfLink || item.id || item.name,
    zone: zoneFrom(item.zone || ''),
    region: regionFrom(item.zone ? String(item.zone).replace('/zones/', '/regions/').replace(/-[a-z]$/, '') : ''),
    shape: String(item.machineType || '').split('/').pop() || '',
    privateIp: item.networkInterfaces?.[0]?.networkIP || '',
    publicIp: item.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || '',
    vpcId: item.networkInterfaces?.[0]?.network || '',
    subnetId: item.networkInterfaces?.[0]?.subnetwork || '',
    labels: labelsFrom(item),
    tags: labelsFrom(item),
    projectId,
  });
}

function normalizeGcpDisk(item, projectId) {
  return resource(item, 'disk', {
    id: item.selfLink || item.id || item.name,
    zone: zoneFrom(item.zone || ''),
    sizeGb: item.sizeGb || '',
    storageType: String(item.type || '').split('/').pop() || '',
    attachedInstanceId: item.users?.[0] || '',
    projectId,
  });
}

function normalizeGcpImage(item, projectId) {
  return resource(item, 'image', {
    id: item.selfLink || item.id || item.name,
    sizeGb: item.diskSizeGb || '',
    sourceDisk: item.sourceDisk || '',
    sourceImage: item.sourceImage || '',
    projectId,
  });
}

function normalizeGcpSnapshot(item, projectId) {
  return resource(item, 'snapshot', {
    id: item.selfLink || item.id || item.name,
    sizeGb: item.diskSizeGb || '',
    storageSizeGb: item.storageBytes || '',
    sourceDisk: item.sourceDisk || '',
    projectId,
  });
}

function normalizeGcpBucket(item, projectId) {
  const publicAccessStatus = item.iamConfiguration?.publicAccessPrevention
    || (item.iamConfiguration?.uniformBucketLevelAccess?.enabled ? 'uniformBucketLevelAccess' : '');
  return resource(item, 'storageBucket', {
    id: item.id || item.name,
    name: item.name,
    region: item.location || 'global',
    storageClass: item.storageClass || '',
    publicAccessStatus,
    versioning: item.versioning?.enabled ? 'enabled' : 'disabled',
    projectId,
  });
}

function normalizeGcpObject(item, bucketName) {
  return resource(item, 'storageObject', {
    id: `${bucketName}/${item.name}`,
    name: item.name,
    key: item.name,
    bucketName,
    sizeBytes: item.size || '',
    storageClass: item.storageClass || '',
    contentType: item.contentType || '',
    eTag: item.etag || item.md5Hash || '',
    lastModified: item.updated || item.timeCreated || '',
    updatedAt: item.updated || '',
  });
}

function normalizeGcpNetwork(item, projectId) {
  return resource(item, 'vpcNetwork', {
    id: item.selfLink || item.id || item.name,
    name: item.name,
    status: item.autoCreateSubnetworks ? 'auto' : 'custom',
    cidrBlock: item.IPv4Range || '',
    routingMode: item.routingConfig?.routingMode || '',
    projectId,
  });
}

function normalizeGcpSubnet(item, projectId) {
  return resource(item, 'subnet', {
    id: item.selfLink || item.id || item.name,
    name: item.name,
    region: regionFrom(item.region || ''),
    cidrBlock: item.ipCidrRange || '',
    vpcId: item.network || '',
    projectId,
  });
}

function normalizeGcpFirewall(item, projectId) {
  return resource(item, 'firewallRule', {
    id: item.selfLink || item.id || item.name,
    name: item.name,
    vpcId: item.network || '',
    status: item.disabled ? 'disabled' : 'enabled',
    direction: item.direction || 'INGRESS',
    rulesCount: (item.allowed || []).length + (item.denied || []).length,
    source: (item.sourceRanges || item.destinationRanges || []).join(', '),
    projectId,
  });
}

function normalizeGcpRoute(item, projectId) {
  return resource(item, 'route', {
    id: item.selfLink || item.id || item.name,
    name: item.name,
    vpcId: item.network || '',
    cidrBlock: item.destRange || '',
    priority: item.priority || '',
    gatewayType: item.nextHopGateway ? 'gateway' : item.nextHopInstance ? 'instance' : item.nextHopIp ? 'ip' : item.nextHopVpnTunnel ? 'vpnTunnel' : '',
    projectId,
  });
}

function normalizeGcpAddress(item, projectId) {
  return resource(item, 'externalIp', {
    id: item.selfLink || item.id || item.name,
    name: item.name,
    region: regionFrom(item.region || ''),
    status: item.status || 'RESERVED',
    publicIp: item.address || '',
    attachedInstanceId: item.users?.[0] || '',
    projectId,
  });
}

function normalizeGcpSqlInstance(item, projectId) {
  const publicIp = (item.ipAddresses || []).find((ip) => ip.type === 'PRIMARY')?.ipAddress || '';
  const privateIp = (item.ipAddresses || []).find((ip) => ip.type === 'PRIVATE')?.ipAddress || '';
  return resource(item, 'sqlInstance', {
    id: item.selfLink || item.connectionName || item.name,
    name: item.name,
    status: item.state || item.status || '',
    region: item.region || regionFrom(item.region || '') || '',
    availabilityDomain: item.gceZone || '',
    engine: item.databaseVersion || '',
    dbVersion: item.databaseVersion || '',
    tier: item.settings?.tier || '',
    storageSizeGb: item.settings?.dataDiskSizeGb || '',
    storageType: item.settings?.dataDiskType || '',
    privateIp,
    publicIp,
    endpoint: item.connectionName || '',
    backupRetentionPeriod: item.settings?.backupConfiguration?.backupRetentionSettings?.retainedBackups || '',
    projectId,
  });
}

function normalizeGcpSqlDatabase(item, instanceName, projectId) {
  return resource(item, 'sqlDatabase', {
    id: `${instanceName || item.instance || ''}/${item.name}`,
    name: item.name,
    status: item.charset || 'available',
    engine: instanceName || item.instance || '',
    dbVersion: item.collation || '',
    instanceId: instanceName || item.instance || '',
    projectId,
  });
}

function normalizeGcpSqlBackup(item, instanceName, projectId) {
  const id = item.id || item.backupRunId || item.selfLink || `${instanceName}/${item.startTime || item.enqueuedTime || item.type || 'backup'}`;
  return resource(item, 'sqlBackup', {
    id: String(id),
    name: String(item.id || item.backupRunId || item.description || item.startTime || id),
    status: item.status || '',
    region: item.location || '',
    instanceId: instanceName || item.instance || '',
    backupRunId: item.id || item.backupRunId || '',
    backupKind: item.type || item.kind || '',
    createdAt: item.startTime || item.enqueuedTime || '',
    projectId,
  });
}

function summarize(payload) {
  const sumGb = (rows) => (rows || []).reduce((total, item) => {
    const value = Number(item.sizeGb || item.diskSizeGb || 0);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);

  return {
    projects: payload.projects?.length || 0,
    regions: payload.regions?.length || 0,
    zones: payload.zones?.length || 0,
    networks: payload.networks?.length || 0,
    subnets: payload.subnets?.length || 0,
    firewallRules: payload.firewallRules?.length || 0,
    routes: payload.routes?.length || 0,
    routers: payload.routers?.length || 0,
    externalIps: payload.externalIps?.length || 0,
    instances: payload.instances?.length || 0,
    runningInstances: (payload.instances || []).filter((item) => String(item.status || '').toLowerCase() === 'running').length,
    stoppedInstances: (payload.instances || []).filter((item) => ['terminated', 'stopped', 'stopping'].includes(String(item.status || '').toLowerCase())).length,
    disks: payload.disks?.length || 0,
    diskUsageGb: sumGb(payload.disks),
    snapshots: payload.snapshots?.length || 0,
    snapshotSourceGb: sumGb(payload.snapshots),
    images: payload.images?.length || 0,
    imageSourceGb: sumGb(payload.images),
    buckets: payload.buckets?.length || 0,
    sqlInstances: payload.sqlInstances?.length || 0,
    sqlDatabases: payload.sqlDatabases?.length || 0,
    gkeClusters: payload.gkeClusters?.length || 0,
    loadBalancers: payload.loadBalancers?.length || 0,
    serviceAccounts: payload.serviceAccounts?.length || 0,
  };
}

export async function getGcpInventory(connector, options = {}) {
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected GCP connector before loading inventory.');
    error.statusCode = 400;
    throw error;
  }

  const projectId = connector.gcpProjectId;
  const errors = [];
  const tokenResponse = await getGcpAccessToken(connector, options);
  if (!tokenResponse.ok) {
    const error = new Error(tokenResponse.message || 'Unable to authenticate to Google Cloud.');
    error.statusCode = 400;
    throw error;
  }
  const token = tokenResponse.payload?.access_token;
  if (!token) {
    const error = new Error('Google identity did not return an access token.');
    error.statusCode = 400;
    throw error;
  }

  const compute = 'compute.googleapis.com';
  const storage = 'storage.googleapis.com';
  const sql = 'sqladmin.googleapis.com';
  const container = 'container.googleapis.com';
  const iam = 'iam.googleapis.com';
  const crm = 'cloudresourcemanager.googleapis.com';
  const request = options.request;
  const projectPath = encodeURIComponent(projectId);

  const project = await safeList('project', errors, async () => {
    const response = await requestJson({ connector, host: crm, path: `/v1/projects/${projectPath}`, token, request });
    if (!response.ok) {
      throw new Error(response.message);
    }
    return [response.payload];
  });
  const regionsRaw = await safeList('regions', errors, () => listPaged({ connector, token, host: compute, path: `/compute/v1/projects/${projectPath}/regions`, request }));
  const zonesRaw = await safeList('zones', errors, () => listPaged({ connector, token, host: compute, path: `/compute/v1/projects/${projectPath}/zones`, request }));
  const networksRaw = await safeList('networks', errors, () => listPaged({ connector, token, host: compute, path: `/compute/v1/projects/${projectPath}/global/networks`, request }));
  const subnetAgg = await safeList('subnets', errors, async () => {
    const response = await requestJson({ connector, host: compute, path: `/compute/v1/projects/${projectPath}/aggregated/subnetworks`, token, request });
    if (!response.ok) throw new Error(response.message);
    return flattenAggregated(response.payload.items, 'subnetworks');
  });
  const firewallsRaw = await safeList('firewallRules', errors, () => listPaged({ connector, token, host: compute, path: `/compute/v1/projects/${projectPath}/global/firewalls`, request }));
  const routesRaw = await safeList('routes', errors, () => listPaged({ connector, token, host: compute, path: `/compute/v1/projects/${projectPath}/global/routes`, request }));
  const routersAgg = await safeList('routers', errors, async () => {
    const response = await requestJson({ connector, host: compute, path: `/compute/v1/projects/${projectPath}/aggregated/routers`, token, request });
    if (!response.ok) throw new Error(response.message);
    return flattenAggregated(response.payload.items, 'routers');
  });
  const addressesAgg = await safeList('externalIps', errors, async () => {
    const response = await requestJson({ connector, host: compute, path: `/compute/v1/projects/${projectPath}/aggregated/addresses`, token, request });
    if (!response.ok) throw new Error(response.message);
    return flattenAggregated(response.payload.items, 'addresses');
  });
  const instancesAgg = await safeList('instances', errors, async () => {
    const response = await requestJson({ connector, host: compute, path: `/compute/v1/projects/${projectPath}/aggregated/instances`, token, request });
    if (!response.ok) throw new Error(response.message);
    return flattenAggregated(response.payload.items, 'instances');
  });
  const disksAgg = await safeList('disks', errors, async () => {
    const response = await requestJson({ connector, host: compute, path: `/compute/v1/projects/${projectPath}/aggregated/disks`, token, request });
    if (!response.ok) throw new Error(response.message);
    return flattenAggregated(response.payload.items, 'disks');
  });
  const snapshotsRaw = await safeList('snapshots', errors, () => listPaged({ connector, token, host: compute, path: `/compute/v1/projects/${projectPath}/global/snapshots`, request }));
  const imagesRaw = await safeList('images', errors, () => listPaged({ connector, token, host: compute, path: `/compute/v1/projects/${projectPath}/global/images`, request }));
  const forwardingRulesAgg = await safeList('loadBalancers', errors, async () => {
    const response = await requestJson({ connector, host: compute, path: `/compute/v1/projects/${projectPath}/aggregated/forwardingRules`, token, request });
    if (!response.ok) throw new Error(response.message);
    return flattenAggregated(response.payload.items, 'forwardingRules');
  });
  const bucketsRaw = await safeList('buckets', errors, () => listPaged({ connector, token, host: storage, path: `/storage/v1/b?project=${projectPath}`, request }));
  const sqlInstancesRaw = await safeList('sqlInstances', errors, () => listPaged({ connector, token, host: sql, path: `/sql/v1beta4/projects/${projectPath}/instances`, request }));
  const sqlDatabaseGroups = await Promise.all(sqlInstancesRaw.map((instance) =>
    safeList(`sqlDatabases:${instance.name}`, errors, () => listPaged({ connector, token, host: sql, path: `/sql/v1beta4/projects/${projectPath}/instances/${encodeURIComponent(instance.name)}/databases`, request })),
  ));
  const clustersRaw = await safeList('gkeClusters', errors, async () => {
    const response = await requestJson({ connector, host: container, path: `/v1/projects/${projectPath}/locations/-/clusters`, token, request });
    if (!response.ok) throw new Error(response.message);
    return response.payload.clusters || [];
  });
  const serviceAccountsRaw = await safeList('serviceAccounts', errors, () => listPaged({ connector, token, host: iam, path: `/v1/projects/${projectPath}/serviceAccounts`, collection: 'accounts', request }));

  const sqlDatabasesRaw = sqlDatabaseGroups.flat();
  const networksByUrl = new Map(networksRaw.map((item) => [item.selfLink, item.name]));
  const subnetsByUrl = new Map(subnetAgg.map((item) => [item.selfLink, item.name]));

  const inventory = {
    generatedAt: new Date().toISOString(),
    cached: false,
    cacheMiss: false,
    scanStatus: errors.length ? 'partial' : 'cached',
    connector: {
      id: connector.id,
      name: connector.name,
      projectId,
      projectName: connector.gcpProjectName || project[0]?.name || projectId,
      projectNumber: connector.gcpProjectNumber || project[0]?.projectNumber || '',
    },
    scan: {
      requestedScope: 'project',
      projectId,
      scannedRegions: regionsRaw.map((item) => item.name).filter(Boolean),
      scannedZones: zonesRaw.map((item) => item.name).filter(Boolean),
    },
    projects: project.map((item) => resource(item, 'project', {
      id: item.projectId,
      name: item.name || item.projectId,
      status: item.lifecycleState || 'ACTIVE',
      projectNumber: item.projectNumber,
    })),
    regions: regionsRaw.map((item) => resource(item, 'region', { id: item.name, name: item.name, region: item.name, status: item.status || 'available' })),
    zones: zonesRaw.map((item) => resource(item, 'zone', { id: item.name, name: item.name, region: regionFrom(item.region || ''), status: item.status || 'available' })),
    networks: networksRaw.map((item) => resource(item, 'vpcNetwork', { cidrBlock: item.IPv4Range || '', routingMode: item.routingConfig?.routingMode || '' })),
    subnets: subnetAgg.map((item) => resource(item, 'subnet', { region: regionFrom(item.region || ''), cidrBlock: item.ipCidrRange || '', vpcId: item.network || '', vpcName: networksByUrl.get(item.network) || '' })),
    firewallRules: firewallsRaw.map((item) => resource(item, 'firewallRule', { vpcId: item.network || '', vpcName: networksByUrl.get(item.network) || '', status: item.disabled ? 'disabled' : 'enabled', rulesCount: (item.allowed || []).length + (item.denied || []).length })),
    routes: routesRaw.map((item) => resource(item, 'route', { vpcId: item.network || '', vpcName: networksByUrl.get(item.network) || '', cidrBlock: item.destRange || '', gatewayType: item.nextHopGateway ? 'gateway' : item.nextHopInstance ? 'instance' : item.nextHopIp ? 'ip' : item.nextHopVpnTunnel ? 'vpnTunnel' : '' })),
    routers: routersAgg.map((item) => resource(item, 'cloudRouter', { region: regionFrom(item.region || ''), vpcId: item.network || '', vpcName: networksByUrl.get(item.network) || '', gatewayType: item.nats?.length ? 'Cloud NAT' : 'Router', rulesCount: item.nats?.length || 0 })),
    externalIps: addressesAgg.map((item) => resource(item, 'externalIp', { region: regionFrom(item.region || ''), status: item.status || 'reserved', publicIp: item.address || '', attachedInstanceId: item.users?.[0] || '' })),
    instances: instancesAgg.map((item) => resource(item, 'computeInstance', {
      zone: zoneFrom(item.zone || ''),
      shape: String(item.machineType || '').split('/').pop() || '',
      privateIp: item.networkInterfaces?.[0]?.networkIP || '',
      publicIp: item.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || '',
      vpcId: item.networkInterfaces?.[0]?.network || '',
      vpcName: networksByUrl.get(item.networkInterfaces?.[0]?.network) || '',
      subnetId: item.networkInterfaces?.[0]?.subnetwork || '',
      subnetName: subnetsByUrl.get(item.networkInterfaces?.[0]?.subnetwork) || '',
    })),
    disks: disksAgg.map((item) => resource(item, 'disk', { zone: zoneFrom(item.zone || ''), sizeGb: item.sizeGb || '', storageType: String(item.type || '').split('/').pop() || '', attachedInstanceId: item.users?.[0] || '' })),
    snapshots: snapshotsRaw.map((item) => resource(item, 'snapshot', { sizeGb: item.diskSizeGb || (item.storageBytes ? Math.round(Number(item.storageBytes || 0) / 1024 / 1024 / 1024) : ''), storageSizeGb: item.storageBytes || '', sourceDisk: item.sourceDisk || '' })),
    images: imagesRaw.map((item) => resource(item, 'image', { sizeGb: item.diskSizeGb || '', sourceDisk: item.sourceDisk || '', sourceImage: item.sourceImage || '' })),
    buckets: bucketsRaw.map((item) => resource(item, 'storageBucket', { id: item.id || item.name, name: item.name, region: item.location || 'global', storageClass: item.storageClass || '', publicAccessStatus: item.iamConfiguration?.publicAccessPrevention || '' })),
    sqlInstances: sqlInstancesRaw.map((item) => normalizeGcpSqlInstance(item, projectId)),
    sqlDatabases: sqlDatabasesRaw.map((item) => normalizeGcpSqlDatabase(item, item.instance, projectId)),
    gkeClusters: clustersRaw.map((item) => resource(item, 'gkeCluster', { region: item.location || '', status: item.status || '', endpoint: item.endpoint || '', nodeCount: item.currentNodeCount || item.nodePools?.reduce((total, pool) => total + Number(pool.initialNodeCount || 0), 0) || 0 })),
    loadBalancers: forwardingRulesAgg.map((item) => resource(item, 'loadBalancer', { region: regionFrom(item.region || '') || 'global', status: item.loadBalancingScheme || '', publicIp: item.IPAddress || '', scheme: item.loadBalancingScheme || '', port: (item.ports || [item.portRange || '']).join(',') })),
    serviceAccounts: serviceAccountsRaw.map((item) => resource(item, 'serviceAccount', { id: item.email || item.name, name: item.displayName || item.email, status: item.disabled ? 'disabled' : 'enabled', email: item.email || '' })),
    tags: [],
    errors,
  };

  inventory.allResources = [
    ...inventory.projects,
    ...inventory.regions,
    ...inventory.zones,
    ...inventory.networks,
    ...inventory.subnets,
    ...inventory.firewallRules,
    ...inventory.routes,
    ...inventory.routers,
    ...inventory.externalIps,
    ...inventory.instances,
    ...inventory.disks,
    ...inventory.snapshots,
    ...inventory.images,
    ...inventory.buckets,
    ...inventory.sqlInstances,
    ...inventory.sqlDatabases,
    ...inventory.gkeClusters,
    ...inventory.loadBalancers,
    ...inventory.serviceAccounts,
  ];
  const tagMap = new Map();
  inventory.allResources.forEach((item) => {
    Object.entries(item.labels || {}).forEach(([key, value]) => tagMap.set(`${key}:${value}`, { key, value }));
  });
  inventory.tags = Array.from(tagMap.values());
  inventory.summary = summarize(inventory);
  return inventory;
}

export async function describeGcpInstance(connector, { zone, instanceName }, options = {}) {
  const projectId = connector.gcpProjectId;
  const payload = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(requireText(zone, 'Zone'))}/instances/${encodeURIComponent(requireText(instanceName, 'Instance name'))}`,
  }, options);
  return normalizeGcpInstance(payload, projectId);
}

export async function runGcpInstanceAction(connector, { zone, instanceName, action }, options = {}) {
  const projectId = connector.gcpProjectId;
  const normalizedAction = String(action || '').toLowerCase();
  const actionPath = {
    start: 'start',
    stop: 'stop',
    reset: 'reset',
    reboot: 'reset',
  }[normalizedAction];
  if (!actionPath) {
    const error = new Error('Unsupported GCP instance action.');
    error.statusCode = 400;
    throw error;
  }
  const targetZone = requireText(zone, 'Zone');
  const name = requireText(instanceName, 'Instance name');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/instances/${encodeURIComponent(name)}/${actionPath}`,
    method: 'POST',
  }, options);
  const status = normalizedAction === 'start' ? 'STARTING' : normalizedAction === 'stop' ? 'STOPPING' : 'RESETTING';
  return {
    message: `GCP VM ${normalizedAction === 'reboot' ? 'reset' : normalizedAction} submitted.`,
    operation: operationSummary(operation, targetZone),
    instance: {
      id: operation.targetLink || name,
      name,
      status,
      providerType: 'computeInstance',
      resourceType: 'computeInstance',
      type: 'computeInstance',
      availabilityDomain: targetZone,
      zone: targetZone,
    },
  };
}

export async function deleteGcpInstance(connector, { zone, instanceName, confirmation }, options = {}) {
  const name = requireText(instanceName, 'Instance name');
  const typed = String(confirmation || '').trim();
  if (!typed || typed !== name) {
    const error = new Error('Type the VM name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/instances/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP VM delete submitted.',
    operation: operationSummary(operation, targetZone),
    instance: {
      id: operation.targetLink || name,
      name,
      status: 'DELETING',
      providerType: 'computeInstance',
      resourceType: 'computeInstance',
      type: 'computeInstance',
      availabilityDomain: targetZone,
      zone: targetZone,
    },
  };
}

export async function createGcpInstance(connector, payload = {}, options = {}) {
  if (process.env.GCP_ALLOW_PAID_VM_CREATE !== 'true') {
    const error = new Error('GCP VM creation is disabled by default because it can create paid compute, disk, and network resources. Set GCP_ALLOW_PAID_VM_CREATE=true on the backend to enable it.');
    error.statusCode = 403;
    throw error;
  }
  if (payload.acceptCostWarning !== true) {
    const error = new Error('Confirm the GCP cost warning before creating a VM.');
    error.statusCode = 400;
    throw error;
  }

  const projectId = connector.gcpProjectId;
  const zone = requireText(payload.zone, 'Zone');
  const name = requireText(payload.name, 'VM name');
  const machineType = requireText(payload.machineType, 'Machine type');
  const network = requireText(payload.network, 'Network');
  const sourceImage = String(payload.sourceImage || '').trim();
  const sourceSnapshot = String(payload.sourceSnapshot || '').trim();
  const sourceDisk = String(payload.sourceDisk || '').trim();
  if (!sourceImage && !sourceSnapshot && !sourceDisk) {
    const error = new Error('Select a boot source image, snapshot, or existing disk.');
    error.statusCode = 400;
    throw error;
  }
  const diskSizeGb = Number(payload.diskSizeGb || 10);
  if (!sourceDisk && (!Number.isFinite(diskSizeGb) || diskSizeGb < 10)) {
    const error = new Error('Boot disk size must be at least 10 GB.');
    error.statusCode = 400;
    throw error;
  }
  const bootDisk = sourceDisk
    ? {
      boot: true,
      autoDelete: payload.autoDeleteBootDisk !== false,
      source: sourceDisk,
    }
    : {
      boot: true,
      autoDelete: payload.autoDeleteBootDisk !== false,
      initializeParams: {
        ...(sourceSnapshot ? { sourceSnapshot } : { sourceImage }),
        diskSizeGb: String(Math.round(diskSizeGb)),
        ...(payload.diskType ? { diskType: zonalComputeResource(payload.diskType, zone, 'diskTypes') } : {}),
      },
    };

  const body = {
    name,
    machineType: zonalComputeResource(machineType, zone, 'machineTypes'),
    labels: payload.labels || {},
    ...(payload.hostname ? { hostname: payload.hostname } : {}),
    ...(payload.networkTags?.length ? { tags: { items: payload.networkTags } } : {}),
    ...(payload.ipForwarding ? { canIpForward: true } : {}),
    disks: [bootDisk],
    networkInterfaces: [{
      network,
      ...(payload.subnetwork ? { subnetwork: payload.subnetwork } : {}),
      ...(payload.assignPublicIp ? { accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }] } : {}),
    }],
    ...(payload.serviceAccountEmail ? {
      serviceAccounts: [{
        email: payload.serviceAccountEmail,
        scopes: payload.scopes?.length ? payload.scopes : ['https://www.googleapis.com/auth/cloud-platform'],
      }],
    } : {}),
  };

  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(zone)}/instances`,
    method: 'POST',
    body,
  }, options);
  return {
    message: 'GCP VM create submitted.',
    operation: operationSummary(operation, zone),
    instance: {
      id: operation.targetLink || name,
      name,
      status: 'PROVISIONING',
      providerType: 'computeInstance',
      resourceType: 'computeInstance',
      type: 'computeInstance',
      availabilityDomain: zone,
      zone,
      shape: machineType.split('/').pop(),
      sourceImage,
      sourceDisk: sourceSnapshot || sourceDisk,
      labels: payload.labels || {},
      tags: payload.labels || {},
    },
  };
}

export async function resizeGcpInstance(connector, { zone, instanceName, machineType }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const name = requireText(instanceName, 'Instance name');
  const type = requireText(machineType, 'Machine type');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/instances/${encodeURIComponent(name)}/setMachineType`,
    method: 'POST',
    body: { machineType: type.includes('/') ? type : `zones/${targetZone}/machineTypes/${type}` },
  }, options);
  return {
    message: 'GCP VM resize submitted. The VM must be stopped for machine type changes.',
    operation: operationSummary(operation, targetZone),
    instance: {
      id: operation.targetLink || name,
      name,
      status: 'UPDATING',
      providerType: 'computeInstance',
      resourceType: 'computeInstance',
      type: 'computeInstance',
      availabilityDomain: targetZone,
      zone: targetZone,
      shape: type.split('/').pop(),
    },
  };
}

export async function createGcpMachineImage(connector, { instanceName, zone, name, description }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const sourceName = requireText(instanceName, 'Instance name');
  const imageName = requireText(name, 'Image name');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/global/machineImages`,
    method: 'POST',
    body: {
      name: imageName,
      sourceInstance: `zones/${targetZone}/instances/${sourceName}`,
      ...(description ? { description } : {}),
    },
  }, options);
  return {
    message: 'GCP machine image creation submitted.',
    operation: operationSummary(operation),
    image: normalizeGcpImage({ name: imageName, selfLink: operation.targetLink, status: 'CREATING', sourceImage: sourceName }, projectId),
  };
}

export async function createGcpDiskSnapshot(connector, { zone, diskName, name, description }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const sourceDisk = requireText(diskName, 'Disk name');
  const snapshotName = requireText(name, 'Snapshot name');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/disks/${encodeURIComponent(sourceDisk)}/createSnapshot`,
    method: 'POST',
    body: {
      name: snapshotName,
      ...(description ? { description } : {}),
    },
  }, options);
  return {
    message: 'GCP disk snapshot creation submitted.',
    operation: operationSummary(operation, targetZone),
    snapshot: normalizeGcpSnapshot({ name: snapshotName, selfLink: operation.targetLink, status: 'CREATING', sourceDisk }, projectId),
  };
}

export async function attachGcpDisk(connector, { zone, instanceName, disk, deviceName, mode = 'READ_WRITE' }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const name = requireText(instanceName, 'Instance name');
  const sourceDisk = requireText(disk, 'Disk');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/instances/${encodeURIComponent(name)}/attachDisk`,
    method: 'POST',
    body: {
      source: sourceDisk,
      mode,
      boot: false,
      autoDelete: false,
      ...(deviceName ? { deviceName } : {}),
    },
  }, options);
  return {
    message: 'GCP disk attach submitted.',
    operation: operationSummary(operation, targetZone),
    disk: normalizeGcpDisk({ name: deviceName || sourceDisk.split('/').pop(), selfLink: sourceDisk, status: 'ATTACHING', zone: `zones/${targetZone}`, users: [operation.targetLink || name] }, projectId),
  };
}

export async function detachGcpDisk(connector, { zone, instanceName, deviceName }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const name = requireText(instanceName, 'Instance name');
  const device = requireText(deviceName, 'Device name');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/instances/${encodeURIComponent(name)}/detachDisk?deviceName=${encodeURIComponent(device)}`,
    method: 'POST',
  }, options);
  return {
    message: 'GCP disk detach submitted.',
    operation: operationSummary(operation, targetZone),
    disk: normalizeGcpDisk({ name: device, status: 'DETACHING', zone: `zones/${targetZone}` }, projectId),
  };
}

export async function createGcpDisk(connector, payload = {}, options = {}) {
  const projectId = connector.gcpProjectId;
  const zone = requireText(payload.zone, 'Zone');
  const name = requireText(payload.name, 'Disk name');
  const sizeGb = Number(payload.sizeGb || 10);
  if (!Number.isFinite(sizeGb) || sizeGb < 1) {
    const error = new Error('Disk size must be at least 1 GB.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(zone)}/disks`,
    method: 'POST',
    body: {
      name,
      sizeGb: String(Math.round(sizeGb)),
      ...(payload.type ? { type: payload.type } : {}),
      ...(payload.sourceSnapshot ? { sourceSnapshot: payload.sourceSnapshot } : {}),
      ...(payload.labels ? { labels: payload.labels } : {}),
    },
  }, options);
  return {
    message: payload.sourceSnapshot ? 'GCP disk restore from snapshot submitted.' : 'GCP disk create submitted.',
    operation: operationSummary(operation, zone),
    disk: normalizeGcpDisk({ name, selfLink: operation.targetLink || name, status: 'CREATING', zone: `zones/${zone}`, sizeGb: String(Math.round(sizeGb)), type: payload.type }, projectId),
  };
}

export async function deleteGcpDisk(connector, { zone, diskName, confirmation }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const name = requireText(diskName, 'Disk name');
  const typed = String(confirmation || '').trim();
  if (!typed || typed !== name) {
    const error = new Error('Type the disk name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/disks/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP disk delete submitted.',
    operation: operationSummary(operation, targetZone),
    disk: normalizeGcpDisk({ name, selfLink: operation.targetLink || name, status: 'DELETING', zone: `zones/${targetZone}` }, projectId),
  };
}

export async function resizeGcpDisk(connector, { zone, diskName, sizeGb }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetZone = requireText(zone, 'Zone');
  const name = requireText(diskName, 'Disk name');
  const size = Number(sizeGb || 0);
  if (!Number.isFinite(size) || size < 1) {
    const error = new Error('New disk size must be at least 1 GB.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(targetZone)}/disks/${encodeURIComponent(name)}/resize`,
    method: 'POST',
    body: { sizeGb: String(Math.round(size)) },
  }, options);
  return {
    message: 'GCP disk resize submitted.',
    operation: operationSummary(operation, targetZone),
    disk: normalizeGcpDisk({ name, selfLink: operation.targetLink || name, status: 'RESIZING', zone: `zones/${targetZone}`, sizeGb: String(Math.round(size)) }, projectId),
  };
}

export async function createGcpBucket(connector, payload = {}, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(payload.name || payload.bucketName, 'Bucket name');
  const location = requireText(payload.location || payload.region, 'Bucket location');
  const bucket = await storageRequest(connector, {
    path: `/storage/v1/b?project=${encodeURIComponent(projectId)}`,
    method: 'POST',
    body: {
      name,
      location,
      storageClass: payload.storageClass || 'STANDARD',
      iamConfiguration: {
        publicAccessPrevention: payload.publicAccessPrevention || 'enforced',
        uniformBucketLevelAccess: { enabled: payload.uniformBucketLevelAccess !== false },
      },
      versioning: { enabled: payload.versioning === true },
      labels: payload.labels || {},
    },
  }, options);
  return { message: 'GCP bucket created.', bucket: normalizeGcpBucket(bucket, projectId) };
}

export async function deleteGcpBucket(connector, { bucketName, confirmation }, options = {}) {
  const name = requireText(bucketName, 'Bucket name');
  const typed = String(confirmation || '').trim();
  if (!typed || typed !== name) {
    const error = new Error('Type the bucket name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  await storageRequest(connector, {
    path: `/storage/v1/b/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return { message: 'GCP bucket deleted.', bucket: normalizeGcpBucket({ name, id: name, state: 'deleted' }, connector.gcpProjectId) };
}

export async function listGcpBucketObjects(connector, { bucketName, prefix = '', maxResults = 500 }, options = {}) {
  const name = requireText(bucketName, 'Bucket name');
  const query = new URLSearchParams({ maxResults: String(maxResults || 500) });
  if (prefix) query.set('prefix', String(prefix));
  const payload = await storageRequest(connector, {
    path: `/storage/v1/b/${encodeURIComponent(name)}/o?${query.toString()}`,
  }, options);
  return {
    generatedAt: new Date().toISOString(),
    bucketName: name,
    objects: (payload.items || []).map((item) => normalizeGcpObject(item, name)),
  };
}

export async function uploadGcpBucketObject(connector, { bucketName, objectName, content = '', contentType = 'text/plain' }, options = {}) {
  const bucket = requireText(bucketName, 'Bucket name');
  const name = requireText(objectName, 'Object name');
  const payload = await storageRequest(connector, {
    path: `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`,
    method: 'POST',
    rawBody: content,
    contentType,
  }, options);
  return { message: 'GCP object uploaded.', object: normalizeGcpObject(payload, bucket) };
}

export async function deleteGcpBucketObject(connector, { bucketName, objectName, confirmation }, options = {}) {
  const bucket = requireText(bucketName, 'Bucket name');
  const name = requireText(objectName, 'Object name');
  const typed = String(confirmation || '').trim();
  if (!typed || (typed !== name && typed !== `${bucket}/${name}`)) {
    const error = new Error('Type the object name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  await storageRequest(connector, {
    path: `/storage/v1/b/${encodeURIComponent(bucket)}/o/${name.split('/').map(encodeURIComponent).join('/')}`,
    method: 'DELETE',
  }, options);
  return { message: 'GCP object deleted.', object: normalizeGcpObject({ name, state: 'deleted' }, bucket) };
}

export async function createGcpVpc(connector, payload = {}, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(payload.name, 'VPC name');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/global/networks`,
    method: 'POST',
    body: {
      name,
      autoCreateSubnetworks: payload.autoCreateSubnetworks === true,
      routingConfig: { routingMode: payload.routingMode || 'REGIONAL' },
      ...(payload.description ? { description: payload.description } : {}),
    },
  }, options);
  return {
    message: 'GCP VPC create submitted.',
    operation: operationSummary(operation),
    network: normalizeGcpNetwork({ name, selfLink: operation.targetLink || name, autoCreateSubnetworks: payload.autoCreateSubnetworks === true, routingConfig: { routingMode: payload.routingMode || 'REGIONAL' } }, projectId),
  };
}

export async function deleteGcpVpc(connector, { vpcName, confirmation }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(vpcName, 'VPC name');
  if (String(confirmation || '').trim() !== name) {
    const error = new Error('Type the VPC name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/global/networks/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP VPC delete submitted.',
    operation: operationSummary(operation),
    network: normalizeGcpNetwork({ name, selfLink: operation.targetLink || name, status: 'DELETING' }, projectId),
  };
}

export async function createGcpSubnet(connector, payload = {}, options = {}) {
  const projectId = connector.gcpProjectId;
  const region = requireText(payload.region, 'Region');
  const name = requireText(payload.name, 'Subnet name');
  const network = requireText(payload.network, 'VPC network');
  const cidr = requireText(payload.cidrBlock || payload.ipCidrRange, 'CIDR block');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/regions/${encodeURIComponent(region)}/subnetworks`,
    method: 'POST',
    body: {
      name,
      network,
      ipCidrRange: cidr,
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.privateIpGoogleAccess !== undefined ? { privateIpGoogleAccess: payload.privateIpGoogleAccess === true } : {}),
    },
  }, options);
  return {
    message: 'GCP subnet create submitted.',
    operation: operationSummary(operation, '', region),
    subnet: normalizeGcpSubnet({ name, selfLink: operation.targetLink || name, region: `regions/${region}`, network, ipCidrRange: cidr, status: 'CREATING' }, projectId),
  };
}

export async function deleteGcpSubnet(connector, { region, subnetName, confirmation }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetRegion = requireText(region, 'Region');
  const name = requireText(subnetName, 'Subnet name');
  if (String(confirmation || '').trim() !== name) {
    const error = new Error('Type the subnet name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/regions/${encodeURIComponent(targetRegion)}/subnetworks/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP subnet delete submitted.',
    operation: operationSummary(operation, '', targetRegion),
    subnet: normalizeGcpSubnet({ name, selfLink: operation.targetLink || name, region: `regions/${targetRegion}`, status: 'DELETING' }, projectId),
  };
}

export async function createGcpFirewallRule(connector, payload = {}, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(payload.name, 'Firewall rule name');
  const network = requireText(payload.network, 'VPC network');
  const protocol = requireText(payload.protocol || 'tcp', 'Protocol');
  const ports = String(payload.ports || '').split(',').map((item) => item.trim()).filter(Boolean);
  const direction = String(payload.direction || 'INGRESS').toUpperCase();
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/global/firewalls`,
    method: 'POST',
    body: {
      name,
      network,
      direction,
      priority: Number(payload.priority || 1000),
      disabled: payload.disabled === true,
      ...(direction === 'INGRESS' ? { sourceRanges: [payload.sourceRanges || '0.0.0.0/0'] } : { destinationRanges: [payload.destinationRanges || '0.0.0.0/0'] }),
      allowed: [{ IPProtocol: protocol, ...(ports.length ? { ports } : {}) }],
      ...(payload.targetTags ? { targetTags: String(payload.targetTags).split(',').map((item) => item.trim()).filter(Boolean) } : {}),
      ...(payload.description ? { description: payload.description } : {}),
    },
  }, options);
  return {
    message: 'GCP firewall rule create submitted.',
    operation: operationSummary(operation),
    firewallRule: normalizeGcpFirewall({ name, selfLink: operation.targetLink || name, network, direction, allowed: [{ IPProtocol: protocol, ports }], disabled: payload.disabled === true }, projectId),
  };
}

export async function deleteGcpFirewallRule(connector, { firewallName, confirmation }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(firewallName, 'Firewall rule name');
  if (String(confirmation || '').trim() !== name) {
    const error = new Error('Type the firewall rule name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/global/firewalls/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP firewall rule delete submitted.',
    operation: operationSummary(operation),
    firewallRule: normalizeGcpFirewall({ name, selfLink: operation.targetLink || name, status: 'DELETING' }, projectId),
  };
}

export async function createGcpRoute(connector, payload = {}, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(payload.name, 'Route name');
  const network = requireText(payload.network, 'VPC network');
  const destRange = requireText(payload.destRange || payload.cidrBlock, 'Destination range');
  const nextHopGateway = payload.nextHopGateway || (payload.nextHopType === 'internet' ? `projects/${projectId}/global/gateways/default-internet-gateway` : '');
  const body = {
    name,
    network,
    destRange,
    priority: Number(payload.priority || 1000),
    ...(nextHopGateway ? { nextHopGateway } : {}),
    ...(payload.nextHopIp ? { nextHopIp: payload.nextHopIp } : {}),
    ...(payload.tags ? { tags: String(payload.tags).split(',').map((item) => item.trim()).filter(Boolean) } : {}),
    ...(payload.description ? { description: payload.description } : {}),
  };
  if (!body.nextHopGateway && !body.nextHopIp) {
    const error = new Error('Route next hop is required.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/global/routes`,
    method: 'POST',
    body,
  }, options);
  return {
    message: 'GCP route create submitted.',
    operation: operationSummary(operation),
    route: normalizeGcpRoute({ name, selfLink: operation.targetLink || name, network, destRange, priority: body.priority, nextHopGateway: body.nextHopGateway, nextHopIp: body.nextHopIp }, projectId),
  };
}

export async function deleteGcpRoute(connector, { routeName, confirmation }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(routeName, 'Route name');
  if (String(confirmation || '').trim() !== name) {
    const error = new Error('Type the route name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/global/routes/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP route delete submitted.',
    operation: operationSummary(operation),
    route: normalizeGcpRoute({ name, selfLink: operation.targetLink || name, status: 'DELETING' }, projectId),
  };
}

export async function reserveGcpExternalIp(connector, payload = {}, options = {}) {
  if (process.env.GCP_ALLOW_PAID_EXTERNAL_IP !== 'true') {
    const error = new Error('GCP external IP reservation is disabled by default because static external IPs can create cost. Set GCP_ALLOW_PAID_EXTERNAL_IP=true on the backend to enable it.');
    error.statusCode = 403;
    throw error;
  }
  if (payload.acceptCostWarning !== true) {
    const error = new Error('Confirm the GCP external IP cost warning before reserving an address.');
    error.statusCode = 400;
    throw error;
  }
  const projectId = connector.gcpProjectId;
  const region = requireText(payload.region, 'Region');
  const name = requireText(payload.name, 'Address name');
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/regions/${encodeURIComponent(region)}/addresses`,
    method: 'POST',
    body: {
      name,
      addressType: 'EXTERNAL',
      ...(payload.networkTier ? { networkTier: payload.networkTier } : {}),
      ...(payload.description ? { description: payload.description } : {}),
    },
  }, options);
  return {
    message: 'GCP external IP reservation submitted.',
    operation: operationSummary(operation, '', region),
    address: normalizeGcpAddress({ name, selfLink: operation.targetLink || name, region: `regions/${region}`, status: 'RESERVING' }, projectId),
  };
}

export async function releaseGcpExternalIp(connector, { region, addressName, confirmation }, options = {}) {
  const projectId = connector.gcpProjectId;
  const targetRegion = requireText(region, 'Region');
  const name = requireText(addressName, 'Address name');
  if (String(confirmation || '').trim() !== name) {
    const error = new Error('Type the external IP name to confirm release.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await computeRequest(connector, {
    path: `/compute/v1/projects/${encodeURIComponent(projectId)}/regions/${encodeURIComponent(targetRegion)}/addresses/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP external IP release submitted.',
    operation: operationSummary(operation, '', targetRegion),
    address: normalizeGcpAddress({ name, selfLink: operation.targetLink || name, region: `regions/${targetRegion}`, status: 'RELEASING' }, projectId),
  };
}

export async function createGcpSqlInstance(connector, payload = {}, options = {}) {
  if (process.env.GCP_ALLOW_PAID_SQL_CREATE !== 'true') {
    const error = new Error('GCP Cloud SQL creation is disabled by default because it can create paid database resources. Set GCP_ALLOW_PAID_SQL_CREATE=true on the backend to enable it.');
    error.statusCode = 403;
    throw error;
  }
  if (payload.acceptCostWarning !== true) {
    const error = new Error('Confirm the GCP Cloud SQL cost warning before creating a database instance.');
    error.statusCode = 400;
    throw error;
  }

  const projectId = connector.gcpProjectId;
  const name = requireText(payload.name, 'Cloud SQL instance name');
  const region = requireText(payload.region, 'Region');
  const databaseVersion = requireText(payload.databaseVersion, 'Database version');
  const tier = requireText(payload.tier, 'Machine tier');
  const storageSizeGb = Number(payload.storageSizeGb || 20);
  if (!Number.isFinite(storageSizeGb) || storageSizeGb < 10) {
    const error = new Error('Cloud SQL storage size must be at least 10 GB.');
    error.statusCode = 400;
    throw error;
  }

  const body = {
    name,
    region,
    databaseVersion,
    settings: {
      tier,
      dataDiskSizeGb: String(Math.round(storageSizeGb)),
      dataDiskType: payload.storageType || 'PD_SSD',
      backupConfiguration: { enabled: payload.backupEnabled !== false },
      ipConfiguration: {
        ipv4Enabled: payload.ipv4Enabled !== false,
        ...(payload.privateNetwork ? { privateNetwork: payload.privateNetwork } : {}),
      },
      ...(payload.labels ? { userLabels: payload.labels } : {}),
    },
    ...(payload.rootPassword ? { rootPassword: payload.rootPassword } : {}),
  };

  const operation = await sqlRequest(connector, {
    path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances`,
    method: 'POST',
    body,
  }, options);

  return {
    message: 'GCP Cloud SQL instance create submitted.',
    operation: operationSummary(operation, '', region),
    instance: normalizeGcpSqlInstance({ name, region, state: 'PENDING_CREATE', databaseVersion, settings: body.settings, selfLink: operation.targetLink }, projectId),
  };
}

export async function runGcpSqlInstanceAction(connector, { instanceName, action }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(instanceName, 'Cloud SQL instance name');
  const normalizedAction = String(action || '').toLowerCase();
  if (!['start', 'stop', 'restart'].includes(normalizedAction)) {
    const error = new Error('Unsupported GCP Cloud SQL action.');
    error.statusCode = 400;
    throw error;
  }

  const operation = normalizedAction === 'restart'
    ? await sqlRequest(connector, {
      path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(name)}/restart`,
      method: 'POST',
      body: { settings: { activationPolicy: 'ALWAYS' } },
    }, options)
    : await sqlRequest(connector, {
      path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(name)}`,
      method: 'PATCH',
      body: { settings: { activationPolicy: normalizedAction === 'start' ? 'ALWAYS' : 'NEVER' } },
    }, options);

  const status = normalizedAction === 'start' ? 'STARTING' : normalizedAction === 'stop' ? 'STOPPING' : 'RESTARTING';
  return {
    message: `GCP Cloud SQL ${normalizedAction} submitted.`,
    operation: operationSummary(operation),
    instance: normalizeGcpSqlInstance({ name, state: status, selfLink: operation.targetLink }, projectId),
  };
}

export async function describeGcpSqlInstance(connector, { instanceName }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(instanceName, 'Cloud SQL instance name');
  const payload = await sqlRequest(connector, {
    path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(name)}`,
  }, options);
  return normalizeGcpSqlInstance(payload, projectId);
}

export async function deleteGcpSqlInstance(connector, { instanceName, confirmation }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(instanceName, 'Cloud SQL instance name');
  if (String(confirmation || '').trim() !== name) {
    const error = new Error('Type the Cloud SQL instance name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const operation = await sqlRequest(connector, {
    path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(name)}`,
    method: 'DELETE',
  }, options);
  return {
    message: 'GCP Cloud SQL instance delete submitted.',
    operation: operationSummary(operation),
    instance: normalizeGcpSqlInstance({ name, state: 'DELETING', selfLink: operation.targetLink }, projectId),
  };
}

export async function listGcpSqlBackups(connector, { instanceName }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(instanceName, 'Cloud SQL instance name');
  const payload = await sqlRequest(connector, {
    path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(name)}/backupRuns`,
  }, options);
  return {
    generatedAt: new Date().toISOString(),
    instanceName: name,
    backups: (payload.items || []).map((item) => normalizeGcpSqlBackup(item, name, projectId)),
  };
}

export async function createGcpSqlBackup(connector, { instanceName, description }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(instanceName, 'Cloud SQL instance name');
  const backup = await sqlRequest(connector, {
    path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(name)}/backupRuns`,
    method: 'POST',
    body: {
      instance: name,
      description: description || `Manual backup ${new Date().toISOString()}`,
    },
  }, options);
  return {
    message: 'GCP Cloud SQL backup submitted.',
    backup: normalizeGcpSqlBackup(backup, name, projectId),
  };
}

export async function restoreGcpSqlBackup(connector, { instanceName, backupRunId }, options = {}) {
  const projectId = connector.gcpProjectId;
  const name = requireText(instanceName, 'Cloud SQL instance name');
  const id = requireText(backupRunId, 'Backup run ID');
  const operation = await sqlRequest(connector, {
    path: `/sql/v1beta4/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(name)}/restoreBackup`,
    method: 'POST',
    body: {
      restoreBackupContext: {
        backupRunId: id,
        instanceId: name,
        project: projectId,
      },
    },
  }, options);
  return {
    message: 'GCP Cloud SQL restore submitted.',
    operation: operationSummary(operation),
    instance: normalizeGcpSqlInstance({ name, state: 'RESTORING', selfLink: operation.targetLink }, projectId),
  };
}
