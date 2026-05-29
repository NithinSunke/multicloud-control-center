import pg from 'pg';

const { Pool } = pg;

let pool;
let initialized = false;
let activeConnectionKey = '';

const memoryStore = new Map();

function useMemoryStore() {
  return process.env.AWS_INVENTORY_STORE === 'memory'
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

function cacheKey(connectorId, region) {
  return `${connectorId}|${region || 'all'}`;
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
      CREATE TABLE IF NOT EXISTS aws_inventory_snapshots (
        connector_id TEXT NOT NULL,
        scan_region TEXT NOT NULL,
        payload_json JSONB NOT NULL,
        cached_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (connector_id, scan_region)
      );
    `);
    initialized = true;
  }
  return pool;
}

function parsePayload(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function getCachedAwsInventory(connectorId, region = 'all') {
  const scanRegion = region || 'all';
  if (useMemoryStore()) {
    const row = memoryStore.get(cacheKey(connectorId, scanRegion));
    return row ? { ...parsePayload(row.payloadJson), cached: true, cachedAt: row.cachedAt } : null;
  }

  const targetPool = await getPool();
  const { rows } = await targetPool.query(
    'SELECT payload_json, cached_at FROM aws_inventory_snapshots WHERE connector_id = $1 AND scan_region = $2',
    [connectorId, scanRegion],
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

export async function setCachedAwsInventory(connectorId, region = 'all', payload) {
  const scanRegion = region || 'all';
  const cachedAt = new Date().toISOString();
  const stored = { ...payload, cachedAt };

  if (useMemoryStore()) {
    memoryStore.set(cacheKey(connectorId, scanRegion), {
      connectorId,
      scanRegion,
      payloadJson: JSON.stringify(stored),
      cachedAt,
    });
    return stored;
  }

  const targetPool = await getPool();
  await targetPool.query(
    `INSERT INTO aws_inventory_snapshots (connector_id, scan_region, payload_json, cached_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT(connector_id, scan_region) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       cached_at = EXCLUDED.cached_at`,
    [connectorId, scanRegion, JSON.stringify(stored), cachedAt],
  );
  return stored;
}

function recomputeSummary(payload) {
  return {
    ...(payload.summary || {}),
    regions: payload.regions?.length || 0,
    instances: payload.instances?.length || 0,
    runningInstances: (payload.instances || []).filter((item) => String(item.status || '').toLowerCase() === 'running').length,
    stoppedInstances: (payload.instances || []).filter((item) => ['stopped', 'stopping'].includes(String(item.status || '').toLowerCase())).length,
    vpcs: payload.vpcs?.length || 0,
    subnets: payload.subnets?.length || 0,
    securityGroups: payload.securityGroups?.length || 0,
    routeTables: payload.routeTables?.length || 0,
    internetGateways: payload.internetGateways?.length || 0,
    natGateways: payload.natGateways?.length || 0,
    ebsVolumes: payload.ebsVolumes?.length || 0,
    ebsSnapshots: payload.ebsSnapshots?.length || 0,
    s3Buckets: payload.s3Buckets?.length || 0,
    rdsDatabases: payload.rdsDatabases?.length || 0,
    loadBalancers: payload.loadBalancers?.length || 0,
    elasticIps: payload.elasticIps?.length || 0,
  };
}

function upsertById(rows = [], item) {
  if (!item?.id) {
    return rows;
  }
  const index = rows.findIndex((row) => row.id === item.id);
  if (index === -1) {
    return [item, ...rows];
  }
  return rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...item } : row));
}

function removeById(rows = [], id) {
  if (!id) {
    return rows;
  }
  return rows.filter((row) => row.id !== id);
}

const AWS_NETWORK_COLLECTIONS = {
  vpc: 'vpcs',
  subnet: 'subnets',
  securityGroup: 'securityGroups',
  routeTable: 'routeTables',
  internetGateway: 'internetGateways',
  natGateway: 'natGateways',
};

function networkCollectionFor(resource) {
  return AWS_NETWORK_COLLECTIONS[resource?.resourceType] || AWS_NETWORK_COLLECTIONS[resource?.providerType] || '';
}

export async function updateCachedAwsInstance(connectorId, instance, regions = []) {
  const targetRegions = Array.from(new Set(['all', instance?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      instances: upsertById(cached.instances || [], instance),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function updateCachedAwsVolume(connectorId, volume, regions = []) {
  const targetRegions = Array.from(new Set(['all', volume?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      ebsVolumes: upsertById(cached.ebsVolumes || [], volume),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function removeCachedAwsVolume(connectorId, volume, regions = []) {
  const targetRegions = Array.from(new Set(['all', volume?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      ebsVolumes: removeById(cached.ebsVolumes || [], volume?.id),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function updateCachedAwsSnapshot(connectorId, snapshot, regions = []) {
  const targetRegions = Array.from(new Set(['all', snapshot?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      ebsSnapshots: upsertById(cached.ebsSnapshots || [], snapshot),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function removeCachedAwsSnapshot(connectorId, snapshot, regions = []) {
  const targetRegions = Array.from(new Set(['all', snapshot?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      ebsSnapshots: removeById(cached.ebsSnapshots || [], snapshot?.id),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function updateCachedAwsBucket(connectorId, bucket, regions = []) {
  const targetRegions = Array.from(new Set(['all', bucket?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      s3Buckets: upsertById(cached.s3Buckets || [], bucket),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function removeCachedAwsBucket(connectorId, bucket, regions = []) {
  const targetRegions = Array.from(new Set(['all', bucket?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      s3Buckets: removeById(cached.s3Buckets || [], bucket?.id || bucket?.name),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function updateCachedAwsNetworkResource(connectorId, resource, regions = []) {
  const collection = networkCollectionFor(resource);
  if (!collection) {
    return;
  }
  const targetRegions = Array.from(new Set(['all', resource?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      [collection]: upsertById(cached[collection] || [], resource),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function removeCachedAwsNetworkResource(connectorId, resource, regions = []) {
  const collection = networkCollectionFor(resource);
  if (!collection) {
    return;
  }
  const targetRegions = Array.from(new Set(['all', resource?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      [collection]: removeById(cached[collection] || [], resource?.id),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function updateCachedAwsRdsDatabase(connectorId, database, regions = []) {
  const targetRegions = Array.from(new Set(['all', database?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      rdsDatabases: upsertById(cached.rdsDatabases || [], database),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}

export async function removeCachedAwsRdsDatabase(connectorId, database, regions = []) {
  const targetRegions = Array.from(new Set(['all', database?.region, ...regions].filter(Boolean)));
  for (const region of targetRegions) {
    const cached = await getCachedAwsInventory(connectorId, region);
    if (!cached) {
      continue;
    }
    const next = {
      ...cached,
      rdsDatabases: removeById(cached.rdsDatabases || [], database?.id || database?.name),
      cached: false,
      cacheMiss: false,
    };
    next.summary = recomputeSummary(next);
    await setCachedAwsInventory(connectorId, region, next);
  }
}
