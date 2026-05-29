import pg from 'pg';

const { Pool } = pg;

let pool;
let initialized = false;
let activeConnectionKey = '';

const memoryStore = new Map();

function useMemoryStore() {
  return process.env.AZURE_INVENTORY_STORE === 'memory'
    || (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL && !process.env.PGHOST);
}

function connectionKey() {
  return process.env.DATABASE_URL
    || [
      process.env.PGHOST || 'localhost',
      process.env.PGPORT || '5432',
      process.env.PGDATABASE || 'multi_cloud_manager',
      process.env.PGUSER || 'multi_cloud_manager',
    ].join('|');
}

function poolConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
      max: Number(process.env.PGPOOL_MAX || 10),
    };
  }

  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'multi_cloud_manager',
    user: process.env.PGUSER || 'multi_cloud_manager',
    password: process.env.PGPASSWORD || 'multi-cloud-manager-local',
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
    max: Number(process.env.PGPOOL_MAX || 10),
  };
}

async function getPool() {
  const key = connectionKey();
  if (!pool || activeConnectionKey !== key) {
    if (pool) {
      await pool.end();
    }
    pool = new Pool(poolConfig());
    initialized = false;
    activeConnectionKey = key;
  }
  if (!initialized) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS azure_inventory_snapshots (
        connector_id TEXT NOT NULL,
        scan_scope TEXT NOT NULL,
        payload_json JSONB NOT NULL,
        cached_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (connector_id, scan_scope)
      );
    `);
    initialized = true;
  }
  return pool;
}

function parsePayload(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function cacheKey(connectorId, scope = 'subscription') {
  return `${connectorId}|${scope || 'subscription'}`;
}

export async function getCachedAzureInventory(connectorId, scope = 'subscription') {
  const scanScope = scope || 'subscription';
  if (useMemoryStore()) {
    const row = memoryStore.get(cacheKey(connectorId, scanScope));
    return row ? { ...parsePayload(row.payloadJson), cached: true, cachedAt: row.cachedAt } : null;
  }

  const targetPool = await getPool();
  const { rows } = await targetPool.query(
    'SELECT payload_json, cached_at FROM azure_inventory_snapshots WHERE connector_id = $1 AND scan_scope = $2',
    [connectorId, scanScope],
  );
  if (!rows[0]) {
    return null;
  }
  return {
    ...parsePayload(rows[0].payload_json),
    cached: true,
    cachedAt: rows[0].cached_at instanceof Date ? rows[0].cached_at.toISOString() : rows[0].cached_at,
  };
}

export async function setCachedAzureInventory(connectorId, scope = 'subscription', payload) {
  const scanScope = scope || 'subscription';
  const cachedAt = new Date().toISOString();
  const stored = { ...payload, cachedAt };

  if (useMemoryStore()) {
    memoryStore.set(cacheKey(connectorId, scanScope), {
      connectorId,
      scanScope,
      payloadJson: JSON.stringify(stored),
      cachedAt,
    });
    return stored;
  }

  const targetPool = await getPool();
  await targetPool.query(
    `INSERT INTO azure_inventory_snapshots (connector_id, scan_scope, payload_json, cached_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT(connector_id, scan_scope) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       cached_at = EXCLUDED.cached_at`,
    [connectorId, scanScope, JSON.stringify(stored), cachedAt],
  );
  return stored;
}

function recomputeSummary(payload) {
  return {
    ...(payload.summary || {}),
    resourceGroups: payload.resourceGroups?.length || 0,
    regions: payload.regions?.length || 0,
    vnets: payload.vnets?.length || 0,
    subnets: payload.subnets?.length || 0,
    routeTables: payload.routeTables?.length || 0,
    routes: payload.routes?.length || 0,
    networkSecurityGroups: payload.networkSecurityGroups?.length || 0,
    networkSecurityRules: payload.networkSecurityRules?.length || 0,
    publicIps: payload.publicIps?.length || 0,
    loadBalancers: payload.loadBalancers?.length || 0,
    natGateways: payload.natGateways?.length || 0,
    privateEndpoints: payload.privateEndpoints?.length || 0,
    appServices: payload.appServices?.length || 0,
    functionApps: payload.functionApps?.length || 0,
    containerApps: payload.containerApps?.length || 0,
    storageAccounts: payload.storageAccounts?.length || 0,
    blobContainers: payload.blobContainers?.length || 0,
    blobs: payload.blobs?.length || 0,
    fileShares: payload.fileShares?.length || 0,
    sqlServers: payload.sqlServers?.length || 0,
    sqlDatabases: payload.sqlDatabases?.length || 0,
    cosmosDbAccounts: payload.cosmosDbAccounts?.length || 0,
    cosmosDbDatabases: payload.cosmosDbDatabases?.length || 0,
    postgresFlexibleServers: payload.postgresFlexibleServers?.length || 0,
    mysqlFlexibleServers: payload.mysqlFlexibleServers?.length || 0,
    virtualMachines: payload.virtualMachines?.length || 0,
    runningVirtualMachines: (payload.virtualMachines || []).filter((vm) => String(vm.status || '').toLowerCase().includes('running')).length,
    managedDisks: payload.managedDisks?.length || 0,
    snapshots: payload.snapshots?.length || 0,
    images: payload.images?.length || 0,
    restorePointCollections: payload.restorePointCollections?.length || 0,
    restorePoints: payload.restorePoints?.length || 0,
    totalResources: payload.allResources?.length || 0,
  };
}

function upsertById(rows = [], item) {
  if (!item?.id) {
    return rows;
  }
  const index = rows.findIndex((row) => String(row.id || '').toLowerCase() === String(item.id).toLowerCase());
  if (index === -1) {
    return [item, ...rows];
  }
  return rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...item } : row));
}

function removeById(rows = [], id) {
  const normalized = String(id || '').toLowerCase();
  if (!normalized) {
    return rows;
  }
  return rows.filter((row) => String(row.id || '').toLowerCase() !== normalized);
}

export async function updateCachedAzureVm(connectorId, vm) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !vm?.id) {
    return;
  }
  const next = {
    ...cached,
    virtualMachines: upsertById(cached.virtualMachines || [], vm),
    allResources: upsertById(cached.allResources || [], { ...vm, providerType: 'virtualMachine', resourceType: 'virtualMachine' }),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureVm(connectorId, vmId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !vmId) {
    return;
  }
  const next = {
    ...cached,
    virtualMachines: removeById(cached.virtualMachines || [], vmId),
    allResources: removeById(cached.allResources || [], vmId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

function azureNetworkCollectionFor(resource) {
  const type = resource?.resourceType || resource?.providerType;
  if (type === 'vnet') return 'vnets';
  if (type === 'subnet') return 'subnets';
  if (type === 'routeTable') return 'routeTables';
  if (type === 'route') return 'routes';
  if (type === 'networkSecurityGroup') return 'networkSecurityGroups';
  if (type === 'networkSecurityRule') return 'networkSecurityRules';
  if (type === 'publicIp') return 'publicIps';
  if (type === 'loadBalancer') return 'loadBalancers';
  if (type === 'natGateway') return 'natGateways';
  if (type === 'privateEndpoint') return 'privateEndpoints';
  return '';
}

function azureDatabaseCollectionFor(resource) {
  const type = resource?.resourceType || resource?.providerType;
  if (type === 'sqlServer') return 'sqlServers';
  if (type === 'sqlDatabase') return 'sqlDatabases';
  if (type === 'cosmosDbAccount') return 'cosmosDbAccounts';
  if (type === 'cosmosDbDatabase') return 'cosmosDbDatabases';
  if (type === 'postgresFlexibleServer') return 'postgresFlexibleServers';
  if (type === 'mysqlFlexibleServer') return 'mysqlFlexibleServers';
  return '';
}

export async function updateCachedAzureDatabaseResource(connectorId, resource) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  const collection = azureDatabaseCollectionFor(resource);
  if (!cached || !resource?.id || !collection) {
    return;
  }
  const next = {
    ...cached,
    [collection]: upsertById(cached[collection] || [], resource),
    allResources: upsertById(cached.allResources || [], resource),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureNetworkResource(connectorId, resource) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  const collection = azureNetworkCollectionFor(resource);
  if (!cached || !resource?.id || !collection) {
    return;
  }
  const next = {
    ...cached,
    [collection]: upsertById(cached[collection] || [], resource),
    allResources: upsertById(cached.allResources || [], resource),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureSqlDatabase(connectorId, database) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !database?.id) {
    return;
  }
  const next = {
    ...cached,
    sqlDatabases: upsertById(cached.sqlDatabases || [], database),
    allResources: upsertById(cached.allResources || [], { ...database, providerType: 'sqlDatabase', resourceType: 'sqlDatabase' }),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureSqlDatabase(connectorId, databaseId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !databaseId) {
    return;
  }
  const next = {
    ...cached,
    sqlDatabases: removeById(cached.sqlDatabases || [], databaseId),
    allResources: removeById(cached.allResources || [], databaseId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureDatabaseResource(connectorId, resource) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  const collection = azureDatabaseCollectionFor(resource);
  const id = resource?.id;
  if (!cached || !id || !collection) {
    return;
  }
  const next = {
    ...cached,
    [collection]: removeById(cached[collection] || [], id),
    allResources: removeById(cached.allResources || [], id),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureNetworkResource(connectorId, resource) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  const collection = azureNetworkCollectionFor(resource);
  const id = resource?.id;
  if (!cached || !id || !collection) {
    return;
  }
  const next = {
    ...cached,
    [collection]: removeById(cached[collection] || [], id),
    allResources: removeById(cached.allResources || [], id),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureSnapshot(connectorId, snapshot) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !snapshot?.id) {
    return;
  }
  const next = {
    ...cached,
    snapshots: upsertById(cached.snapshots || [], snapshot),
    allResources: upsertById(cached.allResources || [], snapshot),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureStorageAccount(connectorId, storageAccount) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !storageAccount?.id) {
    return;
  }
  const next = {
    ...cached,
    storageAccounts: upsertById(cached.storageAccounts || [], storageAccount),
    allResources: upsertById(cached.allResources || [], { ...storageAccount, providerType: 'storageAccount', resourceType: 'storageAccount' }),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureStorageAccount(connectorId, accountId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !accountId) {
    return;
  }
  const next = {
    ...cached,
    storageAccounts: removeById(cached.storageAccounts || [], accountId),
    blobContainers: (cached.blobContainers || []).filter((row) => row.storageAccountId !== accountId),
    blobs: (cached.blobs || []).filter((row) => row.storageAccountId !== accountId),
    fileShares: (cached.fileShares || []).filter((row) => row.storageAccountId !== accountId),
    allResources: (cached.allResources || []).filter((row) => row.id !== accountId && row.storageAccountId !== accountId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureBlobContainer(connectorId, container) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !container?.id) {
    return;
  }
  const next = {
    ...cached,
    blobContainers: upsertById(cached.blobContainers || [], container),
    allResources: upsertById(cached.allResources || [], { ...container, providerType: 'blobContainer', resourceType: 'blobContainer' }),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureBlobContainer(connectorId, containerId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !containerId) {
    return;
  }
  const next = {
    ...cached,
    blobContainers: removeById(cached.blobContainers || [], containerId),
    blobs: (cached.blobs || []).filter((row) => row.containerId !== containerId),
    allResources: removeById(cached.allResources || [], containerId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureFileShare(connectorId, fileShare) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !fileShare?.id) {
    return;
  }
  const next = {
    ...cached,
    fileShares: upsertById(cached.fileShares || [], fileShare),
    allResources: upsertById(cached.allResources || [], { ...fileShare, providerType: 'fileShare', resourceType: 'fileShare' }),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureFileShare(connectorId, shareId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !shareId) {
    return;
  }
  const next = {
    ...cached,
    fileShares: removeById(cached.fileShares || [], shareId),
    allResources: removeById(cached.allResources || [], shareId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function setCachedAzureBlobs(connectorId, blobs = []) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached) {
    return;
  }
  const storageAccountName = blobs[0]?.storageAccountName;
  const containerName = blobs[0]?.containerName;
  const retained = (cached.blobs || []).filter((row) =>
    !storageAccountName
    || !containerName
    || row.storageAccountName !== storageAccountName
    || row.containerName !== containerName);
  const next = {
    ...cached,
    blobs: [...blobs, ...retained],
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureBlob(connectorId, blob) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !blob?.id) {
    return;
  }
  const next = {
    ...cached,
    blobs: upsertById(cached.blobs || [], blob),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureBlob(connectorId, blobId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !blobId) {
    return;
  }
  const next = {
    ...cached,
    blobs: removeById(cached.blobs || [], blobId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureManagedDisk(connectorId, disk) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !disk?.id) {
    return;
  }
  const next = {
    ...cached,
    managedDisks: upsertById(cached.managedDisks || [], disk),
    allResources: upsertById(cached.allResources || [], { ...disk, providerType: 'managedDisk', resourceType: 'managedDisk' }),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureManagedDisk(connectorId, diskId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !diskId) {
    return;
  }
  const next = {
    ...cached,
    managedDisks: removeById(cached.managedDisks || [], diskId),
    allResources: removeById(cached.allResources || [], diskId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function removeCachedAzureSnapshot(connectorId, snapshotId) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !snapshotId) {
    return;
  }
  const next = {
    ...cached,
    snapshots: removeById(cached.snapshots || [], snapshotId),
    allResources: removeById(cached.allResources || [], snapshotId),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureImage(connectorId, image) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !image?.id) {
    return;
  }
  const next = {
    ...cached,
    images: upsertById(cached.images || [], image),
    allResources: upsertById(cached.allResources || [], image),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}

export async function updateCachedAzureRestorePoint(connectorId, restorePoint) {
  const cached = await getCachedAzureInventory(connectorId, 'subscription');
  if (!cached || !restorePoint?.id) {
    return;
  }
  const collection = restorePoint.restorePointCollectionId
    ? {
      id: restorePoint.restorePointCollectionId,
      name: restorePoint.restorePointCollectionName || restorePoint.restorePointCollectionId.split('/').pop(),
      type: 'Microsoft.Compute/restorePointCollections',
      providerType: 'restorePointCollection',
      resourceType: 'restorePointCollection',
      region: restorePoint.region || '',
      resourceGroup: restorePoint.resourceGroup || '',
      status: 'available',
      sourceVmId: restorePoint.sourceVmId || '',
      tags: {},
    }
    : null;
  const next = {
    ...cached,
    restorePointCollections: collection
      ? upsertById(cached.restorePointCollections || [], collection)
      : (cached.restorePointCollections || []),
    restorePoints: upsertById(cached.restorePoints || [], restorePoint),
    allResources: collection
      ? upsertById(upsertById(cached.allResources || [], collection), restorePoint)
      : upsertById(cached.allResources || [], restorePoint),
    cached: false,
    cacheMiss: false,
  };
  next.summary = recomputeSummary(next);
  await setCachedAzureInventory(connectorId, 'subscription', next);
}
