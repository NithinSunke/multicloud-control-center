import { apiRequest } from './api';

export type AzureResource = {
  id: string;
  name: string;
  type: string;
  providerType: string;
  resourceType: string;
  region: string;
  resourceGroup: string;
  status: string;
  tags: Record<string, string>;
  rawSummary?: Record<string, string>;
  [key: string]: any;
};

export type AzureInventory = {
  generatedAt: string;
  cached?: boolean;
  cachedAt?: string;
  cacheMiss?: boolean;
  scanStatus: 'cached' | 'scan running' | 'partial' | 'failed';
  connector: {
    id: string;
    name: string;
    subscriptionId: string;
    subscriptionName: string;
    tenantId: string;
    cloud: string;
  };
  scan: {
    requestedScope: string;
    scannedSubscriptionId: string;
    scannedRegions: string[];
  };
  summary: Record<string, number>;
  subscriptions: AzureResource[];
  resourceGroups: AzureResource[];
  regions: AzureResource[];
  vnets: AzureResource[];
  subnets: AzureResource[];
  routeTables: AzureResource[];
  routes: AzureResource[];
  networkSecurityGroups: AzureResource[];
  networkSecurityRules: AzureResource[];
  publicIps: AzureResource[];
  loadBalancers: AzureResource[];
  natGateways: AzureResource[];
  privateEndpoints: AzureResource[];
  appServices: AzureResource[];
  functionApps: AzureResource[];
  containerApps: AzureResource[];
  storageAccounts: AzureResource[];
  blobContainers: AzureResource[];
  blobs: AzureResource[];
  fileShares: AzureResource[];
  sqlServers: AzureResource[];
  sqlDatabases: AzureResource[];
  cosmosDbAccounts: AzureResource[];
  cosmosDbDatabases: AzureResource[];
  postgresFlexibleServers: AzureResource[];
  mysqlFlexibleServers: AzureResource[];
  virtualMachines: AzureResource[];
  managedDisks: AzureResource[];
  snapshots: AzureResource[];
  images: AzureResource[];
  restorePointCollections: AzureResource[];
  restorePoints: AzureResource[];
  tags: Array<{ key: string; value: string }>;
  allResources: AzureResource[];
  errors: Array<{ scope: string; message: string }>;
};

export function getAzureInventory(refresh = false) {
  const params = new URLSearchParams();
  if (refresh) {
    params.set('refresh', 'true');
  }
  return apiRequest<{ data: AzureInventory }>(`/azure/inventory?${params.toString()}`);
}

export type AzureVmAction = 'start' | 'stop' | 'deallocate' | 'restart';

export function runAzureVmAction(vmId: string, action: AzureVmAction, payload: { vmName?: string; region?: string; resourceGroup?: string }) {
  return apiRequest<{ data: { message: string; vm: AzureResource; operation?: Record<string, unknown> } }>(
    `/azure/vms/actions/${encodeURIComponent(action)}`,
    { method: 'POST', body: JSON.stringify({ ...payload, vmId }) },
  );
}

export function refreshAzureVmStatus(vmId: string, payload: { vmName?: string; region?: string; resourceGroup?: string }) {
  return apiRequest<{ data: { message: string; vm: AzureResource } }>(
    '/azure/vms/status',
    { method: 'POST', body: JSON.stringify({ ...payload, vmId }) },
  );
}

export function resizeAzureVm(vmId: string, payload: { vmName?: string; region?: string; resourceGroup?: string; vmSize: string }) {
  return apiRequest<{ data: { message: string; vm: AzureResource; operation?: Record<string, unknown> } }>(
    '/azure/vms/size',
    { method: 'PUT', body: JSON.stringify({ ...payload, vmId }) },
  );
}

export function deleteAzureVm(vmId: string, payload: { vmName?: string; region?: string; resourceGroup?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; vm?: AzureResource; operation?: Record<string, unknown> } }>(
    '/azure/vms',
    { method: 'DELETE', body: JSON.stringify({ ...payload, vmId }) },
  );
}

export function createAzureVmSnapshot(vmId: string, payload: { name: string; region: string; resourceGroup: string; osDiskId: string }) {
  return apiRequest<{ data: { message: string; snapshot: AzureResource; operation?: Record<string, unknown> } }>(
    '/azure/vms/snapshots',
    { method: 'POST', body: JSON.stringify({ ...payload, vmId }) },
  );
}

export function createAzureVmImage(vmId: string, payload: { name: string; region: string; resourceGroup: string }) {
  return apiRequest<{ data: { message: string; image: AzureResource; operation?: Record<string, unknown> } }>(
    '/azure/vms/images',
    { method: 'POST', body: JSON.stringify({ ...payload, vmId }) },
  );
}

export function createAzureVmRestorePoint(
  vmId: string,
  payload: { collectionName: string; restorePointName: string; region: string; resourceGroup: string; consistencyMode: string },
) {
  return apiRequest<{ data: { message: string; restorePoint: AzureResource; operation?: Record<string, unknown> } }>(
    '/azure/vms/restore-points',
    { method: 'POST', body: JSON.stringify({ ...payload, vmId }) },
  );
}

export function createAzureVm(payload: {
  name: string;
  resourceGroup: string;
  region: string;
  vmSize: string;
  adminUsername: string;
  adminPassword?: string;
  sshPublicKey?: string;
  networkInterfaceId: string;
  storageAccountType?: string;
  acceptCostWarning: boolean;
}) {
  return apiRequest<{ data: { message: string; vm: AzureResource; operation?: Record<string, unknown> } }>('/azure/vms', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createAzureNetworkResource(payload: {
  resourceType: string;
  name: string;
  resourceGroup: string;
  region: string;
  cidrBlock?: string;
  addressPrefix?: string;
  vnetId?: string;
  routeTableId?: string;
  networkSecurityGroupId?: string;
  addressPrefixRoute?: string;
  nextHopType?: string;
  nextHopIpAddress?: string;
  priority?: string;
  direction?: string;
  access?: string;
  protocol?: string;
  sourceAddressPrefix?: string;
  sourcePortRange?: string;
  destinationAddressPrefix?: string;
  destinationPortRange?: string;
  publicIpId?: string;
  sku?: string;
  allocationMethod?: string;
}) {
  return apiRequest<{ data: { message: string; resource: AzureResource; operation?: Record<string, unknown> } }>('/azure/network/resources', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureNetworkResource(payload: {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  type?: string;
  region?: string;
  resourceGroup?: string;
  confirmation: string;
}) {
  return apiRequest<{ data: { message: string; resource: AzureResource; operation?: Record<string, unknown> } }>('/azure/network/resources', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAzureSqlDatabase(payload: {
  serverId: string;
  name: string;
  region: string;
  resourceGroup?: string;
  skuName?: string;
  tier?: string;
  capacity?: string;
  maxSizeGb?: string;
  autoPauseDelay?: string;
  minCapacity?: string;
}) {
  return apiRequest<{ data: { message: string; database: AzureResource; operation?: Record<string, unknown> } }>('/azure/databases/sql', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createAzureDatabaseResource(payload: {
  databaseType: string;
  name: string;
  resourceGroup?: string;
  region?: string;
  serverId?: string;
  accountId?: string;
  administratorLogin?: string;
  administratorPassword?: string;
  skuName?: string;
  sku?: string;
  tier?: string;
  capacity?: string;
  maxSizeGb?: string;
  autoPauseDelay?: string;
  minCapacity?: string;
  version?: string;
  storageSizeGb?: string;
  backupRetentionDays?: string;
  kind?: string;
  consistencyLevel?: string;
  throughput?: string;
  autoscaleMaxThroughput?: string;
  publicNetworkAccess?: string;
  acceptCostWarning?: boolean;
}) {
  return apiRequest<{ data: { message: string; resource: AzureResource; database?: AzureResource; operation?: Record<string, unknown> } }>('/azure/databases/resources', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runAzureSqlDatabaseAction(payload: {
  databaseId: string;
  databaseName?: string;
  region?: string;
  action: 'pause' | 'resume';
}) {
  return apiRequest<{ data: { message: string; database: AzureResource; operation?: Record<string, unknown> } }>(
    `/azure/databases/sql/actions/${encodeURIComponent(payload.action)}`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export function refreshAzureDatabaseResource(payload: {
  resourceId: string;
  resourceName?: string;
  resourceType?: string;
  region?: string;
  resourceGroup?: string;
}) {
  return apiRequest<{ data: { message: string; resource: AzureResource } }>('/azure/databases/resources/status', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runAzureDatabaseResourceAction(payload: {
  resourceId: string;
  resourceName?: string;
  resourceType?: string;
  region?: string;
  resourceGroup?: string;
  action: 'start' | 'stop';
}) {
  return apiRequest<{ data: { message: string; resource: AzureResource; operation?: Record<string, unknown> } }>(
    `/azure/databases/resources/actions/${encodeURIComponent(payload.action)}`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export function deleteAzureDatabaseResource(payload: {
  resourceId: string;
  resourceName: string;
  resourceType?: string;
  region?: string;
  resourceGroup?: string;
  confirmation: string;
}) {
  return apiRequest<{ data: { message: string; resource: AzureResource; operation?: Record<string, unknown> } }>('/azure/databases/resources', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function scaleAzureSqlDatabase(payload: {
  databaseId: string;
  databaseName?: string;
  region?: string;
  skuName: string;
  tier: string;
  capacity: string;
  maxSizeGb?: string;
  autoPauseDelay?: string;
  minCapacity?: string;
}) {
  return apiRequest<{ data: { message: string; database: AzureResource; operation?: Record<string, unknown> } }>('/azure/databases/sql/scale', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureSqlDatabase(payload: {
  databaseId: string;
  databaseName: string;
  region?: string;
  confirmation: string;
}) {
  return apiRequest<{ data: { message: string; database: AzureResource; operation?: Record<string, unknown> } }>('/azure/databases/sql', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAzureStorageAccount(payload: {
  accountName: string;
  resourceGroup: string;
  region: string;
  sku: string;
  kind: string;
  accessTier: string;
  [key: string]: any;
}) {
  return apiRequest<{ data: { message: string; storageAccount: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/accounts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureStorageAccount(payload: { accountId: string; accountName: string; region?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; storageAccount: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/accounts', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAzureBlobContainer(payload: {
  accountId: string;
  accountName: string;
  resourceGroup: string;
  region?: string;
  containerName: string;
  publicAccess?: string;
}) {
  return apiRequest<{ data: { message: string; container: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/blob-containers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureBlobContainer(payload: { containerId: string; containerName: string; accountId?: string; region?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; container: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/blob-containers', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAzureFileShare(payload: {
  accountId: string;
  accountName: string;
  resourceGroup?: string;
  region?: string;
  shareName: string;
  quotaGb: string;
  accessTier?: string;
}) {
  return apiRequest<{ data: { message: string; fileShare: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/file-shares', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureFileShare(payload: { shareId: string; shareName: string; region?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; fileShare: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/file-shares', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function listAzureBlobs(payload: { accountName: string; resourceGroup: string; containerName: string; region?: string; prefix?: string }) {
  const params = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) => {
    if (value) {
      params.set(key, String(value));
    }
  });
  return apiRequest<{ data: { generatedAt: string; blobs: AzureResource[] } }>(`/azure/storage/blobs?${params.toString()}`);
}

export function uploadAzureBlob(payload: {
  accountName: string;
  resourceGroup: string;
  containerName: string;
  region?: string;
  blobName: string;
  contentType: string;
  content?: string;
  contentBase64?: string;
}) {
  return apiRequest<{ data: { message: string; blob: AzureResource } }>('/azure/storage/blobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureBlob(payload: {
  accountName: string;
  resourceGroup: string;
  containerName: string;
  region?: string;
  blobName: string;
  confirmation: string;
}) {
  return apiRequest<{ data: { message: string; blob: AzureResource } }>('/azure/storage/blobs', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAzureManagedDisk(payload: {
  name: string;
  resourceGroup: string;
  region: string;
  sizeGb: string;
  sku: string;
  snapshotId?: string;
}) {
  return apiRequest<{ data: { message: string; disk: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/disks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function resizeAzureManagedDisk(payload: { diskId: string; diskName?: string; region?: string; sizeGb: string }) {
  return apiRequest<{ data: { message: string; disk: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/disks/resize', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureManagedDisk(payload: { diskId: string; diskName: string; region?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; disk: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/disks', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAzureDiskSnapshot(payload: { diskId: string; name: string; resourceGroup: string; region: string; sku?: string }) {
  return apiRequest<{ data: { message: string; snapshot: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/snapshots', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAzureDiskSnapshot(payload: { snapshotId: string; snapshotName: string; region?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; snapshot: AzureResource; operation?: Record<string, unknown> } }>('/azure/storage/snapshots', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}
