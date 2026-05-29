import { getSelectedGcpConnectorForUse } from '../services/connectorStore.js';
import { appendAuditLog } from '../services/auditLog.js';
import { createJob, listJobs } from '../services/jobStore.js';
import {
  attachGcpDisk,
  createGcpBucket,
  createGcpDisk,
  createGcpDiskSnapshot,
  createGcpFirewallRule,
  createGcpInstance,
  createGcpMachineImage,
  createGcpRoute,
  createGcpSqlBackup,
  createGcpSqlInstance,
  createGcpSubnet,
  createGcpVpc,
  deleteGcpBucket,
  deleteGcpBucketObject,
  deleteGcpDisk,
  deleteGcpFirewallRule,
  deleteGcpInstance,
  deleteGcpRoute,
  deleteGcpSqlInstance,
  deleteGcpSubnet,
  deleteGcpVpc,
  describeGcpInstance,
  describeGcpSqlInstance,
  detachGcpDisk,
  getGcpInventory,
  listGcpBucketObjects,
  listGcpSqlBackups,
  releaseGcpExternalIp,
  reserveGcpExternalIp,
  resizeGcpInstance,
  resizeGcpDisk,
  restoreGcpSqlBackup,
  runGcpInstanceAction,
  runGcpSqlInstanceAction,
  uploadGcpBucketObject,
} from '../services/gcpApiClient.js';
import { getCachedGcpInventory, setCachedGcpInventory } from '../services/gcpInventoryCache.js';
import { logger } from '../utils/logger.js';

function handleGcpError(error, req, res) {
  logger.error('gcp_request_failed', {
    requestId: req.id,
    path: req.originalUrl,
    statusCode: error.statusCode || 500,
    error: { message: error.message },
  });
  res.status(error.statusCode || 500).json({
    message: error.statusCode ? error.message : 'Unable to process GCP request.',
    requestId: req.id,
  });
}

function assertVerifiedConnector(connector) {
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected GCP connector before loading inventory.');
    error.statusCode = 400;
    throw error;
  }
}

async function auditGcp(entry, req) {
  await appendAuditLog({
    provider: 'gcp',
    user: req.user?.username || 'unknown',
    ...entry,
  }).catch(() => undefined);
  await createJob({
    provider: 'gcp',
    user: req.user?.username || 'unknown',
    connectorId: entry.connectorId,
    action: entry.action,
    type: entry.action,
    resourceType: entry.resourceType || 'inventory',
    resourceId: entry.resourceId || '',
    resourceName: entry.resourceName || entry.connectorName || 'GCP inventory',
    status: entry.status,
    message: entry.message,
    errorMessage: entry.status === 'failed' ? entry.message : '',
    description: `${entry.action} ${entry.connectorName || ''}`.trim(),
    linkedResource: {
      provider: 'gcp',
      type: entry.resourceType || 'inventory',
      id: entry.resourceId || '',
      name: entry.resourceName || entry.connectorName || '',
    },
    retryable: false,
    cancelable: false,
    output: entry.message ? [{ line: 1, text: entry.message }] : [],
    metadata: {
      projectId: entry.projectId,
      resourceCount: entry.resourceCount,
    },
  }).catch(() => undefined);
}

function emptyCachedInventory(connector) {
  const now = new Date().toISOString();
  return {
    generatedAt: now,
    cached: true,
    cacheMiss: true,
    scanStatus: 'cached',
    connector: {
      id: connector.id,
      name: connector.name,
      projectId: connector.gcpProjectId,
      projectName: connector.gcpProjectName || connector.gcpProjectId,
      projectNumber: connector.gcpProjectNumber || '',
    },
    scan: {
      requestedScope: 'project',
      projectId: connector.gcpProjectId,
      scannedRegions: [],
      scannedZones: [],
    },
    summary: {
      projects: 0,
      regions: 0,
      zones: 0,
      networks: 0,
      subnets: 0,
      firewallRules: 0,
      routes: 0,
      routers: 0,
      externalIps: 0,
      instances: 0,
      runningInstances: 0,
      stoppedInstances: 0,
      disks: 0,
      snapshots: 0,
      images: 0,
      buckets: 0,
      sqlInstances: 0,
      sqlDatabases: 0,
      gkeClusters: 0,
      loadBalancers: 0,
      serviceAccounts: 0,
    },
    projects: [],
    regions: [],
    zones: [],
    networks: [],
    subnets: [],
    firewallRules: [],
    routes: [],
    routers: [],
    externalIps: [],
    instances: [],
    disks: [],
    snapshots: [],
    images: [],
    buckets: [],
    sqlInstances: [],
    sqlDatabases: [],
    gkeClusters: [],
    loadBalancers: [],
    serviceAccounts: [],
    tags: [],
    allResources: [],
    errors: [],
  };
}

function rebuildGcpAllResources(payload) {
  const collections = [
    'projects',
    'regions',
    'zones',
    'networks',
    'subnets',
    'firewallRules',
    'routes',
    'routers',
    'externalIps',
    'instances',
    'disks',
    'snapshots',
    'images',
    'buckets',
    'sqlInstances',
    'sqlDatabases',
    'gkeClusters',
    'loadBalancers',
    'serviceAccounts',
  ];
  payload.allResources = collections.flatMap((key) => payload[key] || []);
  payload.summary = {
    ...(payload.summary || {}),
    instances: payload.instances?.length || 0,
    runningInstances: (payload.instances || []).filter((item) => String(item.status || '').toLowerCase() === 'running').length,
    stoppedInstances: (payload.instances || []).filter((item) => ['terminated', 'stopped', 'stopping'].includes(String(item.status || '').toLowerCase())).length,
    disks: payload.disks?.length || 0,
    diskUsageGb: (payload.disks || []).reduce((sum, item) => sum + Number(item.sizeGb || 0), 0),
    snapshots: payload.snapshots?.length || 0,
    images: payload.images?.length || 0,
    sqlInstances: payload.sqlInstances?.length || 0,
    sqlDatabases: payload.sqlDatabases?.length || 0,
  };
  return payload;
}

function sameResource(left, right) {
  return String(left?.id || left?.name || '') === String(right?.id || right?.name || '')
    || (left?.name && right?.name && String(left.name) === String(right.name));
}

async function upsertCachedGcpResource(connectorId, collection, resource) {
  if (!resource) return;
  const cached = await getCachedGcpInventory(connectorId, 'project').catch(() => null);
  if (!cached) return;
  const rows = cached[collection] || [];
  const nextRows = rows.some((row) => sameResource(row, resource))
    ? rows.map((row) => (sameResource(row, resource) ? { ...row, ...resource } : row))
    : [resource, ...rows];
  await setCachedGcpInventory(connectorId, 'project', rebuildGcpAllResources({ ...cached, [collection]: nextRows }));
}

async function removeCachedGcpResource(connectorId, collection, resource) {
  if (!resource) return;
  const cached = await getCachedGcpInventory(connectorId, 'project').catch(() => null);
  if (!cached) return;
  const rows = cached[collection] || [];
  const nextRows = rows.map((row) => (sameResource(row, resource) ? { ...row, ...resource } : row));
  await setCachedGcpInventory(connectorId, 'project', rebuildGcpAllResources({ ...cached, [collection]: nextRows }));
}

async function deleteCachedGcpResource(connectorId, collection, resource) {
  if (!resource) return;
  const cached = await getCachedGcpInventory(connectorId, 'project').catch(() => null);
  if (!cached) return;
  const rows = cached[collection] || [];
  const nextRows = rows.filter((row) => !sameResource(row, resource));
  await setCachedGcpInventory(connectorId, 'project', rebuildGcpAllResources({ ...cached, [collection]: nextRows }));
}

export async function getInventory(req, res) {
  const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
  const scope = 'project';

  try {
    const connector = await getSelectedGcpConnectorForUse();
    assertVerifiedConnector(connector);

    if (!refresh) {
      const cached = await getCachedGcpInventory(connector.id, scope);
      if (cached) {
        res.json({
          data: {
            ...cached,
            generatedAt: new Date().toISOString(),
            cached: true,
            cacheMiss: false,
          },
        });
        return;
      }
      res.json({ data: emptyCachedInventory(connector) });
      return;
    }

    const data = await getGcpInventory(connector);
    const cached = await setCachedGcpInventory(connector.id, scope, {
      ...data,
      cached: false,
    });

    await auditGcp({
      action: 'gcp-inventory-scan',
      status: data.errors?.length ? 'completed-with-warnings' : 'succeeded',
      connectorId: connector.id,
      connectorName: connector.name,
      projectId: connector.gcpProjectId,
      resourceCount: data.allResources?.length || 0,
      message: data.errors?.length ? `GCP scan loaded with ${data.errors.length} warnings.` : 'GCP inventory scan completed.',
    }, req);

    res.json({ data: { ...cached, cached: false } });
  } catch (error) {
    await auditGcp({
      action: 'gcp-inventory-scan',
      status: 'failed',
      message: error.message,
    }, req);
    handleGcpError(error, req, res);
  }
}

export async function getJobs(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const jobs = await listJobs({ provider: 'gcp', limit });
    res.json({ data: { generatedAt: new Date().toISOString(), tasks: jobs } });
  } catch (error) {
    handleGcpError(error, req, res);
  }
}

async function selectedVerifiedGcp() {
  const connector = await getSelectedGcpConnectorForUse();
  assertVerifiedConnector(connector);
  return connector;
}

export async function createInstance(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await createGcpInstance(connector, req.body || {});
    await upsertCachedGcpResource(connector.id, 'instances', data.instance);
    await auditGcp({ action: 'gcp-vm-create', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'computeInstance', resourceId: data.instance?.id, resourceName: data.instance?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-vm-create', status: 'failed', projectId: req.body?.projectId, resourceName: req.body?.name, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function getInstanceStatus(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const instance = await describeGcpInstance(connector, { zone: req.query.zone, instanceName: req.params.instanceName });
    await upsertCachedGcpResource(connector.id, 'instances', instance);
    res.json({ data: { generatedAt: new Date().toISOString(), instance } });
  } catch (error) {
    handleGcpError(error, req, res);
  }
}

export async function runInstanceAction(req, res) {
  const action = String(req.params.action || '').toLowerCase();
  try {
    const connector = await selectedVerifiedGcp();
    const data = await runGcpInstanceAction(connector, { zone: req.body?.zone, instanceName: req.params.instanceName, action });
    await upsertCachedGcpResource(connector.id, 'instances', data.instance);
    await auditGcp({ action: `gcp-vm-${action}`, status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'computeInstance', resourceId: data.instance?.id, resourceName: req.params.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: `gcp-vm-${action}`, status: 'failed', resourceName: req.params.instanceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function deleteInstance(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await deleteGcpInstance(connector, { zone: req.body?.zone, instanceName: req.params.instanceName, confirmation: req.body?.confirmation });
    await removeCachedGcpResource(connector.id, 'instances', data.instance);
    await auditGcp({ action: 'gcp-vm-delete', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'computeInstance', resourceId: data.instance?.id, resourceName: req.params.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-vm-delete', status: 'failed', resourceName: req.params.instanceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function resizeInstance(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await resizeGcpInstance(connector, { zone: req.body?.zone, instanceName: req.params.instanceName, machineType: req.body?.machineType });
    await upsertCachedGcpResource(connector.id, 'instances', data.instance);
    await auditGcp({ action: 'gcp-vm-resize', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'computeInstance', resourceId: data.instance?.id, resourceName: req.params.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-vm-resize', status: 'failed', resourceName: req.params.instanceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function createMachineImage(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await createGcpMachineImage(connector, { ...req.body, instanceName: req.params.instanceName });
    await upsertCachedGcpResource(connector.id, 'images', data.image);
    await auditGcp({ action: 'gcp-vm-machine-image-create', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'image', resourceId: data.image?.id, resourceName: data.image?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-vm-machine-image-create', status: 'failed', resourceName: req.body?.name, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function createDiskSnapshot(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await createGcpDiskSnapshot(connector, { ...req.body, diskName: req.params.diskName });
    await upsertCachedGcpResource(connector.id, 'snapshots', data.snapshot);
    await auditGcp({ action: 'gcp-disk-snapshot-create', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'snapshot', resourceId: data.snapshot?.id, resourceName: data.snapshot?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-disk-snapshot-create', status: 'failed', resourceName: req.body?.name, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function attachDisk(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await attachGcpDisk(connector, { ...req.body, instanceName: req.params.instanceName });
    await upsertCachedGcpResource(connector.id, 'disks', data.disk);
    await auditGcp({ action: 'gcp-disk-attach', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'disk', resourceId: data.disk?.id, resourceName: data.disk?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-disk-attach', status: 'failed', resourceName: req.body?.disk, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function detachDisk(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await detachGcpDisk(connector, { ...req.body, instanceName: req.params.instanceName, deviceName: req.params.deviceName });
    await upsertCachedGcpResource(connector.id, 'disks', data.disk);
    await auditGcp({ action: 'gcp-disk-detach', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'disk', resourceId: data.disk?.id, resourceName: data.disk?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-disk-detach', status: 'failed', resourceName: req.params.deviceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function createDisk(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await createGcpDisk(connector, req.body || {});
    await upsertCachedGcpResource(connector.id, 'disks', data.disk);
    await auditGcp({ action: req.body?.sourceSnapshot ? 'gcp-disk-restore' : 'gcp-disk-create', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'disk', resourceId: data.disk?.id, resourceName: data.disk?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: req.body?.sourceSnapshot ? 'gcp-disk-restore' : 'gcp-disk-create', status: 'failed', resourceName: req.body?.name, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function deleteDisk(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await deleteGcpDisk(connector, { zone: req.body?.zone, diskName: req.params.diskName, confirmation: req.body?.confirmation });
    await removeCachedGcpResource(connector.id, 'disks', data.disk);
    await auditGcp({ action: 'gcp-disk-delete', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'disk', resourceId: data.disk?.id, resourceName: req.params.diskName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-disk-delete', status: 'failed', resourceName: req.params.diskName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function resizeDisk(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await resizeGcpDisk(connector, { zone: req.body?.zone, diskName: req.params.diskName, sizeGb: req.body?.sizeGb });
    await upsertCachedGcpResource(connector.id, 'disks', data.disk);
    await auditGcp({ action: 'gcp-disk-resize', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'disk', resourceId: data.disk?.id, resourceName: req.params.diskName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-disk-resize', status: 'failed', resourceName: req.params.diskName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function createBucket(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await createGcpBucket(connector, req.body || {});
    await upsertCachedGcpResource(connector.id, 'buckets', data.bucket);
    await auditGcp({ action: 'gcp-bucket-create', status: 'succeeded', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'storageBucket', resourceId: data.bucket?.id, resourceName: data.bucket?.name, message: data.message }, req);
    res.status(201).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-bucket-create', status: 'failed', resourceName: req.body?.name || req.body?.bucketName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function deleteBucket(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await deleteGcpBucket(connector, { bucketName: req.params.bucketName, confirmation: req.body?.confirmation });
    await deleteCachedGcpResource(connector.id, 'buckets', data.bucket);
    await auditGcp({ action: 'gcp-bucket-delete', status: 'succeeded', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'storageBucket', resourceId: req.params.bucketName, resourceName: req.params.bucketName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-bucket-delete', status: 'failed', resourceName: req.params.bucketName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function listBucketObjects(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await listGcpBucketObjects(connector, { bucketName: req.params.bucketName, prefix: req.query.prefix, maxResults: req.query.maxResults });
    res.json({ data });
  } catch (error) {
    handleGcpError(error, req, res);
  }
}

export async function uploadBucketObject(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await uploadGcpBucketObject(connector, { ...req.body, bucketName: req.params.bucketName });
    await auditGcp({ action: 'gcp-object-upload', status: 'succeeded', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'storageObject', resourceId: data.object?.id, resourceName: data.object?.name, message: data.message }, req);
    res.status(201).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-object-upload', status: 'failed', resourceName: req.body?.objectName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function deleteBucketObject(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await deleteGcpBucketObject(connector, { bucketName: req.params.bucketName, objectName: req.body?.objectName || req.query.objectName, confirmation: req.body?.confirmation });
    await auditGcp({ action: 'gcp-object-delete', status: 'succeeded', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'storageObject', resourceId: data.object?.id, resourceName: data.object?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-object-delete', status: 'failed', resourceName: req.body?.objectName || req.query.objectName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

async function submitGcpNetworkCreate(req, res, action, collection, resourceKey, serviceCall) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await serviceCall(connector, req.body || {});
    await upsertCachedGcpResource(connector.id, collection, data[resourceKey]);
    await auditGcp({ action, status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: data[resourceKey]?.resourceType || collection, resourceId: data[resourceKey]?.id, resourceName: data[resourceKey]?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action, status: 'failed', resourceName: req.body?.name, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

async function submitGcpNetworkDelete(req, res, action, collection, resourceKey, serviceCall, payload) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await serviceCall(connector, payload);
    await deleteCachedGcpResource(connector.id, collection, data[resourceKey]);
    await auditGcp({ action, status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: data[resourceKey]?.resourceType || collection, resourceId: data[resourceKey]?.id, resourceName: data[resourceKey]?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action, status: 'failed', resourceName: payload?.vpcName || payload?.subnetName || payload?.firewallName || payload?.routeName || payload?.addressName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function createVpc(req, res) {
  return submitGcpNetworkCreate(req, res, 'gcp-vpc-create', 'networks', 'network', createGcpVpc);
}

export async function deleteVpc(req, res) {
  return submitGcpNetworkDelete(req, res, 'gcp-vpc-delete', 'networks', 'network', deleteGcpVpc, { vpcName: req.params.vpcName, confirmation: req.body?.confirmation });
}

export async function createSubnet(req, res) {
  return submitGcpNetworkCreate(req, res, 'gcp-subnet-create', 'subnets', 'subnet', createGcpSubnet);
}

export async function deleteSubnet(req, res) {
  return submitGcpNetworkDelete(req, res, 'gcp-subnet-delete', 'subnets', 'subnet', deleteGcpSubnet, { region: req.body?.region, subnetName: req.params.subnetName, confirmation: req.body?.confirmation });
}

export async function createFirewallRule(req, res) {
  return submitGcpNetworkCreate(req, res, 'gcp-firewall-create', 'firewallRules', 'firewallRule', createGcpFirewallRule);
}

export async function deleteFirewallRule(req, res) {
  return submitGcpNetworkDelete(req, res, 'gcp-firewall-delete', 'firewallRules', 'firewallRule', deleteGcpFirewallRule, { firewallName: req.params.firewallName, confirmation: req.body?.confirmation });
}

export async function createRoute(req, res) {
  return submitGcpNetworkCreate(req, res, 'gcp-route-create', 'routes', 'route', createGcpRoute);
}

export async function deleteRoute(req, res) {
  return submitGcpNetworkDelete(req, res, 'gcp-route-delete', 'routes', 'route', deleteGcpRoute, { routeName: req.params.routeName, confirmation: req.body?.confirmation });
}

export async function reserveExternalIp(req, res) {
  return submitGcpNetworkCreate(req, res, 'gcp-external-ip-reserve', 'externalIps', 'address', reserveGcpExternalIp);
}

export async function releaseExternalIp(req, res) {
  return submitGcpNetworkDelete(req, res, 'gcp-external-ip-release', 'externalIps', 'address', releaseGcpExternalIp, { region: req.body?.region, addressName: req.params.addressName, confirmation: req.body?.confirmation });
}

export async function createSqlInstance(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await createGcpSqlInstance(connector, req.body || {});
    await upsertCachedGcpResource(connector.id, 'sqlInstances', data.instance);
    await auditGcp({ action: 'gcp-sql-create', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'sqlInstance', resourceId: data.instance?.id, resourceName: data.instance?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-sql-create', status: 'failed', resourceName: req.body?.name, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function runSqlInstanceAction(req, res) {
  const action = String(req.params.action || '').toLowerCase();
  try {
    const connector = await selectedVerifiedGcp();
    const data = await runGcpSqlInstanceAction(connector, { instanceName: req.params.instanceName, action });
    await upsertCachedGcpResource(connector.id, 'sqlInstances', data.instance);
    await auditGcp({ action: `gcp-sql-${action}`, status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'sqlInstance', resourceId: data.instance?.id, resourceName: req.params.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: `gcp-sql-${action}`, status: 'failed', resourceName: req.params.instanceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function getSqlInstanceStatus(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const instance = await describeGcpSqlInstance(connector, { instanceName: req.params.instanceName });
    await upsertCachedGcpResource(connector.id, 'sqlInstances', instance);
    res.json({ data: { generatedAt: new Date().toISOString(), instance } });
  } catch (error) {
    handleGcpError(error, req, res);
  }
}

export async function deleteSqlInstance(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await deleteGcpSqlInstance(connector, { instanceName: req.params.instanceName, confirmation: req.body?.confirmation });
    await removeCachedGcpResource(connector.id, 'sqlInstances', data.instance);
    await auditGcp({ action: 'gcp-sql-delete', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'sqlInstance', resourceId: data.instance?.id, resourceName: req.params.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-sql-delete', status: 'failed', resourceName: req.params.instanceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function listSqlBackups(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await listGcpSqlBackups(connector, { instanceName: req.params.instanceName });
    res.json({ data });
  } catch (error) {
    handleGcpError(error, req, res);
  }
}

export async function createSqlBackup(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await createGcpSqlBackup(connector, { instanceName: req.params.instanceName, description: req.body?.description });
    await auditGcp({ action: 'gcp-sql-backup-create', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'sqlBackup', resourceId: data.backup?.id, resourceName: data.backup?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-sql-backup-create', status: 'failed', resourceName: req.params.instanceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}

export async function restoreSqlBackup(req, res) {
  try {
    const connector = await selectedVerifiedGcp();
    const data = await restoreGcpSqlBackup(connector, { instanceName: req.params.instanceName, backupRunId: req.body?.backupRunId });
    await upsertCachedGcpResource(connector.id, 'sqlInstances', data.instance);
    await auditGcp({ action: 'gcp-sql-restore', status: 'submitted', connectorId: connector.id, projectId: connector.gcpProjectId, resourceType: 'sqlInstance', resourceId: data.instance?.id, resourceName: req.params.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditGcp({ action: 'gcp-sql-restore', status: 'failed', resourceName: req.params.instanceName, message: error.message }, req);
    handleGcpError(error, req, res);
  }
}
