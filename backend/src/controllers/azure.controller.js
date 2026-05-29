import { getSelectedAzureConnectorForUse } from '../services/connectorStore.js';
import { appendAuditLog } from '../services/auditLog.js';
import { createJob, listJobs } from '../services/jobStore.js';
import {
  createAzureBlobContainer,
  createAzureDiskSnapshot,
  createAzureFileShare,
  createAzureManagedDisk,
  createAzureNetworkResource,
  createAzureDatabaseResource,
  createAzureSqlDatabase,
  createAzureStorageAccount,
  createAzureVm,
  createAzureVmImage,
  createAzureVmRestorePoint,
  createAzureVmSnapshot,
  deleteAzureBlob,
  deleteAzureBlobContainer,
  deleteAzureDiskSnapshot,
  deleteAzureFileShare,
  deleteAzureManagedDisk,
  deleteAzureNetworkResource,
  deleteAzureDatabaseResource,
  deleteAzureSqlDatabase,
  deleteAzureStorageAccount,
  deleteAzureVm,
  getAzureInventory,
  refreshAzureDatabaseResource,
  getAzureVmStatus,
  listAzureBlobs,
  resizeAzureVm,
  resizeAzureManagedDisk,
  runAzureDatabaseResourceAction,
  runAzureSqlDatabaseAction,
  runAzureVmAction,
  scaleAzureSqlDatabase,
  uploadAzureBlob,
} from '../services/azureApiClient.js';
import {
  getCachedAzureInventory,
  removeCachedAzureBlob,
  removeCachedAzureBlobContainer,
  removeCachedAzureDatabaseResource,
  removeCachedAzureFileShare,
  removeCachedAzureManagedDisk,
  removeCachedAzureNetworkResource,
  removeCachedAzureSnapshot,
  removeCachedAzureSqlDatabase,
  removeCachedAzureStorageAccount,
  removeCachedAzureVm,
  setCachedAzureBlobs,
  updateCachedAzureBlob,
  updateCachedAzureBlobContainer,
  updateCachedAzureDatabaseResource,
  updateCachedAzureFileShare,
  updateCachedAzureImage,
  updateCachedAzureManagedDisk,
  updateCachedAzureNetworkResource,
  updateCachedAzureRestorePoint,
  setCachedAzureInventory,
  updateCachedAzureSqlDatabase,
  updateCachedAzureSnapshot,
  updateCachedAzureStorageAccount,
  updateCachedAzureVm,
} from '../services/azureInventoryCache.js';
import { logger } from '../utils/logger.js';

function auditUser(req) {
  return req.user?.username || 'unknown';
}

function handleAzureError(error, req, res) {
  logger.error('azure_request_failed', {
    requestId: req.id,
    path: req.originalUrl,
    statusCode: error.statusCode || 500,
    error: { message: error.message },
  });
  res.status(error.statusCode || 500).json({
    message: error.statusCode ? error.message : 'Unable to process Azure request.',
    requestId: req.id,
  });
}

function assertVerifiedConnector(connector) {
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected Azure connector before loading inventory.');
    error.statusCode = 400;
    throw error;
  }
}

function decodePossiblyEncoded(value = '') {
  let decoded = String(value || '');
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function vmIdFromRequest(req) {
  return decodePossiblyEncoded(req.params.vmId || req.body?.vmId || '');
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
    summary: {
      subscriptions: 0,
      resourceGroups: 0,
      regions: 0,
      vnets: 0,
      subnets: 0,
      routeTables: 0,
      routes: 0,
      networkSecurityGroups: 0,
      networkSecurityRules: 0,
      publicIps: 0,
      loadBalancers: 0,
      natGateways: 0,
      privateEndpoints: 0,
      appServices: 0,
      functionApps: 0,
      containerApps: 0,
      storageAccounts: 0,
      blobContainers: 0,
      blobs: 0,
      fileShares: 0,
      sqlServers: 0,
      sqlDatabases: 0,
      cosmosDbAccounts: 0,
      cosmosDbDatabases: 0,
      postgresFlexibleServers: 0,
      mysqlFlexibleServers: 0,
      virtualMachines: 0,
      runningVirtualMachines: 0,
      managedDisks: 0,
      snapshots: 0,
      images: 0,
      restorePointCollections: 0,
      restorePoints: 0,
      totalResources: 0,
    },
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

function buildAzureJobEntry(entry, req) {
  const resourceType = entry.resourceType || (entry.action?.includes('vm') ? 'virtualMachine' : 'inventory');
  const resourceId = entry.resourceId || entry.vmId || entry.diskId || entry.snapshotId || entry.imageId || entry.accountId || entry.containerId || entry.shareId || entry.blobId || entry.subscriptionId || '';
  const resourceName = entry.resourceName || entry.vmName || entry.diskName || entry.snapshotName || entry.imageName || entry.accountName || entry.containerName || entry.shareName || entry.blobName || entry.subscriptionName || entry.subscriptionId || 'Azure resource';
  return {
    provider: 'azure',
    user: auditUser(req),
    connectorId: entry.connectorId,
    region: entry.region,
    action: entry.action,
    type: entry.action,
    resourceType,
    resourceId,
    resourceName,
    status: entry.status,
    message: entry.message,
    errorMessage: entry.status === 'failed' ? entry.message : '',
    description: entry.message || 'Azure inventory scan',
    linkedResource: {
      provider: 'azure',
      type: resourceType,
      id: resourceId,
      name: resourceName,
      region: entry.region || '',
    },
    retryable: false,
    cancelable: false,
    output: entry.message ? [{ line: 1, text: entry.message }] : [],
    metadata: {
      resourceCount: entry.resourceCount,
      warningCount: entry.warningCount,
      vmSize: entry.vmSize,
      operation: entry.operation,
    },
  };
}

async function auditAzure(entry, req) {
  await appendAuditLog({
    provider: 'azure',
    user: auditUser(req),
    ...entry,
  }).catch(() => undefined);
  await createJob(buildAzureJobEntry(entry, req)).catch(() => undefined);
}

export async function getJobs(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const jobs = await listJobs({ provider: 'azure', limit });
    res.json({ data: { generatedAt: new Date().toISOString(), tasks: jobs } });
  } catch (error) {
    handleAzureError(error, req, res);
  }
}

export async function getInventory(req, res) {
  const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
  const scope = 'subscription';

  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);

    if (!refresh) {
      const cached = await getCachedAzureInventory(connector.id, scope);
      if (cached) {
        res.json({
          data: {
            ...cached,
            generatedAt: new Date().toISOString(),
            cached: true,
            cacheMiss: false,
            scanStatus: cached.errors?.length ? 'partial' : 'cached',
          },
        });
        return;
      }
      res.json({ data: emptyCachedInventory(connector) });
      return;
    }

    const data = await getAzureInventory(connector);
    const cached = await setCachedAzureInventory(connector.id, scope, {
      ...data,
      cached: false,
      scanStatus: data.errors?.length ? 'partial' : 'cached',
    });
    const resourceCount = data.summary?.totalResources || 0;
    await auditAzure({
      action: 'azure-inventory-scan',
      status: data.errors?.length ? 'completed-with-warnings' : 'succeeded',
      connectorId: connector.id,
      connectorName: connector.name,
      subscriptionId: connector.azureSubscriptionId,
      subscriptionName: connector.azureSubscriptionName,
      resourceCount,
      warningCount: data.errors?.length || 0,
      message: data.errors?.length ? `Azure scan loaded with ${data.errors.length} warnings.` : 'Azure inventory scan completed.',
    }, req);

    res.json({ data: { ...cached, cached: false } });
  } catch (error) {
    await auditAzure({
      action: 'azure-inventory-scan',
      status: 'failed',
      message: error.message,
    }, req);
    handleAzureError(error, req, res);
  }
}

export async function createVm(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureVm(connector, req.body || {});
    await updateCachedAzureVm(connector.id, data.vm);
    await auditAzure({
      action: 'azure-vm-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.vm?.region || req.body?.region,
      resourceType: 'virtualMachine',
      resourceId: data.vm?.id,
      resourceName: data.vm?.name,
      vmSize: data.vm?.size,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-vm-create', status: 'failed', region: req.body?.region, resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function runVmAction(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const vmId = vmIdFromRequest(req);
    const data = await runAzureVmAction(connector, { vmId, action: req.params.action });
    const statusByAction = {
      start: 'starting',
      restart: 'restarting',
      stop: 'stopping',
      deallocate: 'deallocating',
    };
    const vm = {
      id: vmId,
      name: req.body?.vmName,
      region: req.body?.region,
      resourceGroup: req.body?.resourceGroup,
      status: statusByAction[req.params.action] || 'updating',
      providerType: 'virtualMachine',
      resourceType: 'virtualMachine',
    };
    await updateCachedAzureVm(connector.id, vm);
    await auditAzure({
      action: `azure-vm-${req.params.action}`,
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'virtualMachine',
      resourceId: vmId,
      resourceName: req.body?.vmName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data: { ...data, vm } });
  } catch (error) {
    await auditAzure({ action: `azure-vm-${req.params.action}`, status: 'failed', region: req.body?.region, resourceId: vmIdFromRequest(req), resourceName: req.body?.vmName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function refreshVmStatus(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const vmId = vmIdFromRequest(req);
    const data = await getAzureVmStatus(connector, { vmId });
    await updateCachedAzureVm(connector.id, data.vm);
    await auditAzure({
      action: 'azure-vm-refresh-status',
      status: 'succeeded',
      connectorId: connector.id,
      region: data.vm?.region || req.body?.region,
      resourceType: 'virtualMachine',
      resourceId: vmId,
      resourceName: data.vm?.name || req.body?.vmName,
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-vm-refresh-status', status: 'failed', region: req.body?.region, resourceId: vmIdFromRequest(req), resourceName: req.body?.vmName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function resizeVm(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const vmId = vmIdFromRequest(req);
    const data = await resizeAzureVm(connector, { vmId, vmSize: req.body?.vmSize });
    const vm = {
      id: vmId,
      name: req.body?.vmName,
      region: req.body?.region,
      resourceGroup: req.body?.resourceGroup,
      size: req.body?.vmSize,
      shape: req.body?.vmSize,
      status: 'resizing',
      providerType: 'virtualMachine',
      resourceType: 'virtualMachine',
    };
    await updateCachedAzureVm(connector.id, vm);
    await auditAzure({
      action: 'azure-vm-resize',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'virtualMachine',
      resourceId: vmId,
      resourceName: req.body?.vmName,
      vmSize: req.body?.vmSize,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data: { ...data, vm } });
  } catch (error) {
    await auditAzure({ action: 'azure-vm-resize', status: 'failed', region: req.body?.region, resourceId: vmIdFromRequest(req), resourceName: req.body?.vmName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteVm(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const vmId = vmIdFromRequest(req);
    const data = await deleteAzureVm(connector, { vmId, vmName: req.body?.vmName, confirmation: req.body?.confirmation });
    await removeCachedAzureVm(connector.id, vmId);
    await auditAzure({
      action: 'azure-vm-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'virtualMachine',
      resourceId: vmId,
      resourceName: req.body?.vmName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-vm-delete', status: 'failed', region: req.body?.region, resourceId: vmIdFromRequest(req), resourceName: req.body?.vmName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createVmSnapshot(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const vmId = vmIdFromRequest(req);
    const data = await createAzureVmSnapshot(connector, { vmId, ...req.body });
    await updateCachedAzureSnapshot(connector.id, data.snapshot);
    await auditAzure({
      action: 'azure-vm-snapshot-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.snapshot?.region || req.body?.region,
      resourceType: 'snapshot',
      resourceId: data.snapshot?.id,
      resourceName: data.snapshot?.name,
      vmId,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-vm-snapshot-create', status: 'failed', region: req.body?.region, resourceId: vmIdFromRequest(req), resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createVmImage(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const vmId = vmIdFromRequest(req);
    const data = await createAzureVmImage(connector, { vmId, ...req.body });
    await updateCachedAzureImage(connector.id, data.image);
    await auditAzure({
      action: 'azure-vm-image-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.image?.region || req.body?.region,
      resourceType: 'image',
      resourceId: data.image?.id,
      resourceName: data.image?.name,
      vmId,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-vm-image-create', status: 'failed', region: req.body?.region, resourceId: vmIdFromRequest(req), resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createVmRestorePoint(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const vmId = vmIdFromRequest(req);
    const data = await createAzureVmRestorePoint(connector, { vmId, ...req.body });
    await updateCachedAzureRestorePoint(connector.id, data.restorePoint);
    await auditAzure({
      action: 'azure-vm-restore-point-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.restorePoint?.region || req.body?.region,
      resourceType: 'restorePoint',
      resourceId: data.restorePoint?.id,
      resourceName: data.restorePoint?.name,
      vmId,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-vm-restore-point-create', status: 'failed', region: req.body?.region, resourceId: vmIdFromRequest(req), resourceName: req.body?.restorePointName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createStorageAccount(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureStorageAccount(connector, req.body || {});
    await updateCachedAzureStorageAccount(connector.id, data.storageAccount);
    await auditAzure({
      action: 'azure-storage-account-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.storageAccount?.region || req.body?.region,
      resourceType: 'storageAccount',
      resourceId: data.storageAccount?.id,
      resourceName: data.storageAccount?.name,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-storage-account-create', status: 'failed', region: req.body?.region, resourceName: req.body?.accountName || req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteStorageAccount(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const accountId = decodePossiblyEncoded(req.params.accountId || req.body?.accountId || '');
    const data = await deleteAzureStorageAccount(connector, { ...req.body, accountId });
    await removeCachedAzureStorageAccount(connector.id, accountId);
    await auditAzure({
      action: 'azure-storage-account-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'storageAccount',
      resourceId: accountId,
      resourceName: req.body?.accountName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-storage-account-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.accountId || req.body?.accountId || ''), resourceName: req.body?.accountName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createNetworkResource(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureNetworkResource(connector, req.body || {});
    await updateCachedAzureNetworkResource(connector.id, data.resource);
    await auditAzure({
      action: 'azure-network-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.resource?.region || req.body?.region,
      resourceType: data.resource?.resourceType || req.body?.resourceType,
      resourceId: data.resource?.id,
      resourceName: data.resource?.name,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-network-create', status: 'failed', region: req.body?.region, resourceType: req.body?.resourceType, resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteNetworkResource(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const resourceId = decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || '');
    const data = await deleteAzureNetworkResource(connector, { ...req.body, resourceId });
    await removeCachedAzureNetworkResource(connector.id, data.resource);
    await auditAzure({
      action: 'azure-network-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: data.resource?.region || req.body?.region,
      resourceType: data.resource?.resourceType || req.body?.resourceType,
      resourceId,
      resourceName: data.resource?.name || req.body?.resourceName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-network-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || ''), resourceName: req.body?.resourceName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createSqlDatabase(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureSqlDatabase(connector, req.body || {});
    await updateCachedAzureSqlDatabase(connector.id, data.database);
    await auditAzure({
      action: 'azure-sql-database-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.database?.region || req.body?.region,
      resourceType: 'sqlDatabase',
      resourceId: data.database?.id,
      resourceName: data.database?.name,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-sql-database-create', status: 'failed', region: req.body?.region, resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createDatabaseResource(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureDatabaseResource(connector, req.body || {});
    const resource = data.resource || data.database;
    await updateCachedAzureDatabaseResource(connector.id, resource);
    await auditAzure({
      action: `azure-database-${resource?.resourceType || req.body?.databaseType}-create`,
      status: 'submitted',
      connectorId: connector.id,
      region: resource?.region || req.body?.region,
      resourceType: resource?.resourceType || req.body?.databaseType,
      resourceId: resource?.id,
      resourceName: resource?.name,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data: { ...data, resource } });
  } catch (error) {
    await auditAzure({ action: `azure-database-${req.body?.databaseType || 'resource'}-create`, status: 'failed', region: req.body?.region, resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteSqlDatabase(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const databaseId = decodePossiblyEncoded(req.params.databaseId || req.body?.databaseId || '');
    const data = await deleteAzureSqlDatabase(connector, { ...req.body, databaseId });
    await removeCachedAzureSqlDatabase(connector.id, databaseId);
    await auditAzure({
      action: 'azure-sql-database-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'sqlDatabase',
      resourceId: databaseId,
      resourceName: req.body?.databaseName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-sql-database-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.databaseId || req.body?.databaseId || ''), resourceName: req.body?.databaseName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function refreshDatabaseResource(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const resourceId = decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || '');
    const data = await refreshAzureDatabaseResource(connector, { ...req.body, resourceId });
    await updateCachedAzureDatabaseResource(connector.id, data.resource);
    await auditAzure({
      action: 'azure-database-refresh-status',
      status: 'succeeded',
      connectorId: connector.id,
      region: data.resource?.region || req.body?.region,
      resourceType: data.resource?.resourceType || req.body?.resourceType,
      resourceId,
      resourceName: data.resource?.name || req.body?.resourceName,
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-database-refresh-status', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || ''), resourceName: req.body?.resourceName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function runDatabaseResourceAction(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const resourceId = decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || '');
    const action = req.params.action || req.body?.action;
    const data = await runAzureDatabaseResourceAction(connector, { ...req.body, resourceId, action });
    await updateCachedAzureDatabaseResource(connector.id, data.resource);
    await auditAzure({
      action: `azure-database-${action}`,
      status: 'submitted',
      connectorId: connector.id,
      region: data.resource?.region || req.body?.region,
      resourceType: data.resource?.resourceType || req.body?.resourceType,
      resourceId,
      resourceName: data.resource?.name || req.body?.resourceName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: `azure-database-${req.params.action || req.body?.action || 'action'}`, status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || ''), resourceName: req.body?.resourceName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteDatabaseResource(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const resourceId = decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || '');
    const data = await deleteAzureDatabaseResource(connector, { ...req.body, resourceId });
    await removeCachedAzureDatabaseResource(connector.id, data.resource);
    await auditAzure({
      action: 'azure-database-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: data.resource?.region || req.body?.region,
      resourceType: data.resource?.resourceType || req.body?.resourceType,
      resourceId,
      resourceName: data.resource?.name || req.body?.resourceName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-database-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.resourceId || req.body?.resourceId || ''), resourceName: req.body?.resourceName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function runSqlDatabaseAction(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const databaseId = decodePossiblyEncoded(req.params.databaseId || req.body?.databaseId || '');
    const action = req.params.action || req.body?.action;
    const data = await runAzureSqlDatabaseAction(connector, { ...req.body, databaseId, action });
    await updateCachedAzureSqlDatabase(connector.id, data.database);
    await auditAzure({
      action: `azure-sql-database-${action}`,
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'sqlDatabase',
      resourceId: databaseId,
      resourceName: req.body?.databaseName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: `azure-sql-database-${req.params.action || req.body?.action || 'action'}`, status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.databaseId || req.body?.databaseId || ''), resourceName: req.body?.databaseName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function scaleSqlDatabase(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const databaseId = decodePossiblyEncoded(req.params.databaseId || req.body?.databaseId || '');
    const data = await scaleAzureSqlDatabase(connector, { ...req.body, databaseId });
    await updateCachedAzureSqlDatabase(connector.id, data.database);
    await auditAzure({
      action: 'azure-sql-database-scale',
      status: 'submitted',
      connectorId: connector.id,
      region: data.database?.region || req.body?.region,
      resourceType: 'sqlDatabase',
      resourceId: databaseId,
      resourceName: data.database?.name || req.body?.databaseName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-sql-database-scale', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.databaseId || req.body?.databaseId || ''), resourceName: req.body?.databaseName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createBlobContainer(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureBlobContainer(connector, req.body || {});
    await updateCachedAzureBlobContainer(connector.id, data.container);
    await auditAzure({
      action: 'azure-blob-container-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.container?.region || req.body?.region,
      resourceType: 'blobContainer',
      resourceId: data.container?.id,
      resourceName: data.container?.name,
      accountId: req.body?.accountId,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-blob-container-create', status: 'failed', region: req.body?.region, accountId: req.body?.accountId, resourceName: req.body?.containerName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteBlobContainer(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const containerId = decodePossiblyEncoded(req.params.containerId || req.body?.containerId || '');
    const data = await deleteAzureBlobContainer(connector, { ...req.body, containerId });
    await removeCachedAzureBlobContainer(connector.id, containerId);
    await auditAzure({
      action: 'azure-blob-container-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'blobContainer',
      resourceId: containerId,
      resourceName: req.body?.containerName,
      accountId: req.body?.accountId,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-blob-container-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.containerId || req.body?.containerId || ''), resourceName: req.body?.containerName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createFileShare(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureFileShare(connector, req.body || {});
    await updateCachedAzureFileShare(connector.id, data.fileShare);
    await auditAzure({
      action: 'azure-file-share-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.fileShare?.region || req.body?.region,
      resourceType: 'fileShare',
      resourceId: data.fileShare?.id,
      resourceName: data.fileShare?.name,
      accountId: req.body?.accountId,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-file-share-create', status: 'failed', region: req.body?.region, accountId: req.body?.accountId, resourceName: req.body?.shareName || req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteFileShare(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const shareId = decodePossiblyEncoded(req.params.shareId || req.body?.shareId || '');
    const data = await deleteAzureFileShare(connector, { ...req.body, shareId });
    await removeCachedAzureFileShare(connector.id, shareId);
    await auditAzure({
      action: 'azure-file-share-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'fileShare',
      resourceId: shareId,
      resourceName: req.body?.shareName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-file-share-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.shareId || req.body?.shareId || ''), resourceName: req.body?.shareName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function getBlobs(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await listAzureBlobs(connector, req.query || {});
    await setCachedAzureBlobs(connector.id, data.blobs);
    res.json({ data });
  } catch (error) {
    handleAzureError(error, req, res);
  }
}

export async function uploadBlob(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await uploadAzureBlob(connector, req.body || {});
    await updateCachedAzureBlob(connector.id, data.blob);
    await auditAzure({
      action: 'azure-blob-upload',
      status: 'succeeded',
      connectorId: connector.id,
      region: data.blob?.region || req.body?.region,
      resourceType: 'blob',
      resourceId: data.blob?.id,
      resourceName: data.blob?.name,
      accountName: req.body?.accountName,
      containerName: req.body?.containerName,
      message: data.message,
    }, req);
    res.status(201).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-blob-upload', status: 'failed', region: req.body?.region, accountName: req.body?.accountName, containerName: req.body?.containerName, resourceName: req.body?.blobName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteBlob(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const blobName = decodePossiblyEncoded(req.params.blobName || req.body?.blobName || '');
    const data = await deleteAzureBlob(connector, { ...req.body, blobName });
    await removeCachedAzureBlob(connector.id, data.blob?.id);
    await auditAzure({
      action: 'azure-blob-delete',
      status: 'succeeded',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'blob',
      resourceId: data.blob?.id,
      resourceName: blobName,
      accountName: req.body?.accountName,
      containerName: req.body?.containerName,
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-blob-delete', status: 'failed', region: req.body?.region, accountName: req.body?.accountName, containerName: req.body?.containerName, resourceName: decodePossiblyEncoded(req.params.blobName || req.body?.blobName || ''), message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createManagedDisk(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureManagedDisk(connector, req.body || {});
    await updateCachedAzureManagedDisk(connector.id, data.disk);
    await auditAzure({
      action: data.disk?.sourceResourceId ? 'azure-disk-restore' : 'azure-disk-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.disk?.region || req.body?.region,
      resourceType: 'managedDisk',
      resourceId: data.disk?.id,
      resourceName: data.disk?.name,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: req.body?.snapshotId ? 'azure-disk-restore' : 'azure-disk-create', status: 'failed', region: req.body?.region, resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function resizeManagedDisk(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const diskId = decodePossiblyEncoded(req.params.diskId || req.body?.diskId || '');
    const data = await resizeAzureManagedDisk(connector, { ...req.body, diskId });
    await updateCachedAzureManagedDisk(connector.id, data.disk);
    await auditAzure({
      action: 'azure-disk-resize',
      status: 'submitted',
      connectorId: connector.id,
      region: data.disk?.region || req.body?.region,
      resourceType: 'managedDisk',
      resourceId: diskId,
      resourceName: data.disk?.name || req.body?.diskName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-disk-resize', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.diskId || req.body?.diskId || ''), resourceName: req.body?.diskName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteManagedDisk(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const diskId = decodePossiblyEncoded(req.params.diskId || req.body?.diskId || '');
    const data = await deleteAzureManagedDisk(connector, { ...req.body, diskId });
    await removeCachedAzureManagedDisk(connector.id, diskId);
    await auditAzure({
      action: 'azure-disk-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'managedDisk',
      resourceId: diskId,
      resourceName: req.body?.diskName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-disk-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.diskId || req.body?.diskId || ''), resourceName: req.body?.diskName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function createDiskSnapshot(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAzureDiskSnapshot(connector, req.body || {});
    await updateCachedAzureSnapshot(connector.id, data.snapshot);
    await auditAzure({
      action: 'azure-disk-snapshot-create',
      status: 'submitted',
      connectorId: connector.id,
      region: data.snapshot?.region || req.body?.region,
      resourceType: 'snapshot',
      resourceId: data.snapshot?.id,
      resourceName: data.snapshot?.name,
      diskId: req.body?.diskId,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-disk-snapshot-create', status: 'failed', region: req.body?.region, diskId: req.body?.diskId, resourceName: req.body?.name, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}

export async function deleteDiskSnapshot(req, res) {
  try {
    const connector = await getSelectedAzureConnectorForUse();
    assertVerifiedConnector(connector);
    const snapshotId = decodePossiblyEncoded(req.params.snapshotId || req.body?.snapshotId || '');
    const data = await deleteAzureDiskSnapshot(connector, { ...req.body, snapshotId });
    await removeCachedAzureSnapshot(connector.id, snapshotId);
    await auditAzure({
      action: 'azure-disk-snapshot-delete',
      status: 'submitted',
      connectorId: connector.id,
      region: req.body?.region,
      resourceType: 'snapshot',
      resourceId: snapshotId,
      resourceName: req.body?.snapshotName,
      operation: data.operation,
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAzure({ action: 'azure-disk-snapshot-delete', status: 'failed', region: req.body?.region, resourceId: decodePossiblyEncoded(req.params.snapshotId || req.body?.snapshotId || ''), resourceName: req.body?.snapshotName, message: error.message }, req);
    handleAzureError(error, req, res);
  }
}
