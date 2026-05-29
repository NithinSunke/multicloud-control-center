import pg from 'pg';

const { Pool } = pg;

let pool;
let initialized = false;
let activeConnectionKey = '';

const memoryStore = {
  snapshots: new Map(),
  resources: new Map(),
  regions: new Map(),
  compartments: new Map(),
  scanRuns: [],
};

function useMemoryStore() {
  return process.env.OCI_INVENTORY_STORE === 'memory'
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

function cacheKey({ connectorId, region, compartmentId, resourceType }) {
  return [connectorId, region, compartmentId, resourceType].map((item) => encodeURIComponent(String(item || ''))).join('|');
}

function resourceGroups(value) {
  return [
    ['instance', value.instances || []],
    ['blockVolume', value.blockVolumes || []],
    ['bootVolume', value.bootVolumes || []],
    ['vcn', value.vcns || []],
    ['subnet', value.subnets || []],
    ['internetGateway', value.internetGateways || []],
    ['natGateway', value.natGateways || []],
    ['serviceGateway', value.serviceGateways || []],
    ['drgAttachment', value.drgAttachments || []],
    ['routeTable', value.routeTables || []],
    ['securityList', value.securityLists || []],
    ['bucket', value.buckets || []],
    ['dbSystem', value.dbSystems || []],
    ['autonomousDatabase', value.autonomousDatabases || []],
    ['autonomousContainerDatabase', value.autonomousContainerDatabases || []],
    ['exadataInfrastructure', value.exadataInfrastructures || []],
  ];
}

function resourceCount(value) {
  return resourceGroups(value).reduce((total, [, rows]) => total + rows.length, 0);
}

function updateSummaryForInstances(payload) {
  const instances = payload.instances || [];
  payload.summary = {
    ...(payload.summary || {}),
    instances: instances.length,
    runningInstances: instances.filter((item) => String(item.status || '').toUpperCase() === 'RUNNING').length,
    stoppedInstances: instances.filter((item) => ['STOPPED', 'STOPPING'].includes(String(item.status || '').toUpperCase())).length,
  };
  return payload;
}

function updateSummaryForResource(payload, resourceType) {
  if (resourceType === 'blockVolume') {
    payload.summary = { ...(payload.summary || {}), blockVolumes: (payload.blockVolumes || []).length };
  }
  if (resourceType === 'bootVolume') {
    payload.summary = { ...(payload.summary || {}), bootVolumes: (payload.bootVolumes || []).length };
  }
  if (resourceType === 'bucket') {
    payload.summary = { ...(payload.summary || {}), buckets: (payload.buckets || []).length };
  }
  if (resourceType === 'dbSystem') {
    payload.summary = { ...(payload.summary || {}), dbSystems: (payload.dbSystems || []).length };
  }
  if (resourceType === 'autonomousDatabase') {
    payload.summary = { ...(payload.summary || {}), autonomousDatabases: (payload.autonomousDatabases || []).length };
  }
  if (resourceType === 'autonomousContainerDatabase') {
    payload.summary = { ...(payload.summary || {}), autonomousContainerDatabases: (payload.autonomousContainerDatabases || []).length };
  }
  if (resourceType === 'exadataInfrastructure') {
    payload.summary = { ...(payload.summary || {}), exadataInfrastructures: (payload.exadataInfrastructures || []).length };
  }
  if (resourceType === 'vcn') {
    payload.summary = { ...(payload.summary || {}), vcns: (payload.vcns || []).length };
  }
  if (resourceType === 'subnet') {
    payload.summary = { ...(payload.summary || {}), subnets: (payload.subnets || []).length };
  }
  if (resourceType === 'internetGateway') {
    payload.summary = { ...(payload.summary || {}), internetGateways: (payload.internetGateways || []).length };
  }
  if (resourceType === 'natGateway') {
    payload.summary = { ...(payload.summary || {}), natGateways: (payload.natGateways || []).length };
  }
  if (resourceType === 'serviceGateway') {
    payload.summary = { ...(payload.summary || {}), serviceGateways: (payload.serviceGateways || []).length };
  }
  if (resourceType === 'drgAttachment') {
    payload.summary = { ...(payload.summary || {}), drgAttachments: (payload.drgAttachments || []).length };
  }
  if (resourceType === 'routeTable') {
    payload.summary = { ...(payload.summary || {}), routeTables: (payload.routeTables || []).length };
  }
  if (resourceType === 'securityList') {
    payload.summary = { ...(payload.summary || {}), securityLists: (payload.securityLists || []).length };
  }
  return payload;
}

function mergeOciInstance(previous = {}, instance = {}) {
  return {
    ...previous,
    ...instance,
    compartmentName: instance.compartmentName || previous.compartmentName,
    privateIp: instance.privateIp || previous.privateIp,
    publicIp: instance.publicIp || previous.publicIp,
  };
}

function shouldApplyInstanceToScope(row, instance) {
  const scanRegion = String(row.scan_region || row.scanRegion || '');
  return !instance.region || scanRegion === 'all' || scanRegion === instance.region;
}

function compartmentNameForPayload(payload, instance) {
  if (instance.compartmentName && instance.compartmentName !== instance.compartmentId) {
    return instance.compartmentName;
  }
  const compartment = (payload.compartments || []).find((item) => item.id === instance.compartmentId);
  return compartment?.name || instance.compartmentName || instance.compartmentId || '';
}

function resourceRecord(scopeKey, scope, resourceType, row, cachedAt) {
  const resourceId = String(row.id || row.name || '');
  if (!resourceId) {
    return null;
  }
  return {
    scopeKey,
    connectorId: scope.connectorId,
    scanRegion: scope.region || row.region || 'all',
    resourceType,
    resourceId,
    name: row.name || '',
    status: row.status || '',
    region: row.region || '',
    compartmentId: row.compartmentId || '',
    compartmentName: row.compartmentName || '',
    availabilityDomain: row.availabilityDomain || '',
    shape: row.shape || '',
    sizeGb: row.sizeGb === undefined ? '' : String(row.sizeGb),
    storageSizeGb: row.storageSizeGb === undefined ? '' : String(row.storageSizeGb),
    memoryGb: row.memoryGb === undefined ? '' : String(row.memoryGb),
    ocpus: row.ocpus === undefined ? '' : String(row.ocpus),
    privateIp: row.privateIp || '',
    publicIp: row.publicIp || '',
    rawJson: JSON.stringify(row),
    lastScannedAt: cachedAt,
  };
}

function instanceResourceRecord(scopeKey, connectorId, scanRegion, instance, cachedAt) {
  return {
    scopeKey,
    connectorId,
    scanRegion: scanRegion || instance.region || 'all',
    resourceType: 'instance',
    resourceId: instance.id,
    name: instance.name || '',
    status: instance.status || '-',
    region: instance.region || '',
    compartmentId: instance.compartmentId || '',
    compartmentName: instance.compartmentName || '',
    availabilityDomain: instance.availabilityDomain || '',
    shape: instance.shape || '',
    sizeGb: instance.sizeGb === undefined ? '' : String(instance.sizeGb),
    storageSizeGb: instance.storageSizeGb === undefined ? '' : String(instance.storageSizeGb),
    memoryGb: instance.memoryGb === undefined ? '' : String(instance.memoryGb),
    ocpus: instance.ocpus === undefined ? '' : String(instance.ocpus),
    privateIp: instance.privateIp || '',
    publicIp: instance.publicIp || '',
    rawJson: JSON.stringify(instance),
    lastScannedAt: cachedAt,
  };
}

function resourceListName(resourceType) {
  return {
    blockVolume: 'blockVolumes',
    bootVolume: 'bootVolumes',
    bucket: 'buckets',
    vcn: 'vcns',
    subnet: 'subnets',
    internetGateway: 'internetGateways',
    natGateway: 'natGateways',
    serviceGateway: 'serviceGateways',
    drgAttachment: 'drgAttachments',
    routeTable: 'routeTables',
    securityList: 'securityLists',
    instance: 'instances',
    dbSystem: 'dbSystems',
    autonomousDatabase: 'autonomousDatabases',
    autonomousContainerDatabase: 'autonomousContainerDatabases',
    exadataInfrastructure: 'exadataInfrastructures',
  }[resourceType] || '';
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
    await initializePostgres(pool);
    initialized = true;
  }
  return pool;
}

export async function initializeOciInventoryStore() {
  if (useMemoryStore()) {
    return;
  }
  await getPool();
}

async function initializePostgres(targetPool) {
  await targetPool.query(`
    CREATE TABLE IF NOT EXISTS oci_inventory_snapshots (
      scope_key TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      scan_region TEXT NOT NULL,
      compartment_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      cached_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oci_inventory_snapshots_scope
      ON oci_inventory_snapshots (connector_id, scan_region, compartment_id, resource_type);

    CREATE TABLE IF NOT EXISTS oci_scan_runs (
      id BIGSERIAL PRIMARY KEY,
      scope_key TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      scan_region TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      summary_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oci_regions (
      connector_id TEXT NOT NULL,
      name TEXT NOT NULL,
      region_key TEXT,
      status TEXT,
      home BOOLEAN DEFAULT false,
      last_scanned_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (connector_id, name)
    );

    CREATE TABLE IF NOT EXISTS oci_compartments (
      connector_id TEXT NOT NULL,
      compartment_id TEXT NOT NULL,
      name TEXT,
      description TEXT,
      status TEXT,
      parent_compartment_id TEXT,
      last_scanned_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (connector_id, compartment_id)
    );

    CREATE TABLE IF NOT EXISTS oci_resources (
      scope_key TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      scan_region TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      name TEXT,
      status TEXT,
      region TEXT,
      compartment_id TEXT,
      compartment_name TEXT,
      availability_domain TEXT,
      shape TEXT,
      size_gb TEXT,
      storage_size_gb TEXT,
      memory_gb TEXT,
      ocpus TEXT,
      private_ip TEXT,
      public_ip TEXT,
      raw_json JSONB NOT NULL,
      last_scanned_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope_key, resource_type, resource_id)
    );
    CREATE INDEX IF NOT EXISTS idx_oci_resources_filters
      ON oci_resources (connector_id, scan_region, resource_type, region, compartment_id, status);
  `);
}

function memorySetResource(record) {
  memoryStore.resources.set(`${record.scopeKey}|${record.resourceType}|${record.resourceId}`, record);
}

function persistInventoryRowsMemory(scope, scopeKey, value, cachedAt) {
  for (const region of value.regions || []) {
    if (region.name) {
      memoryStore.regions.set(`${scope.connectorId}|${region.name}`, {
        connectorId: scope.connectorId,
        name: region.name,
        regionKey: region.key || '',
        status: region.status || '',
        home: Boolean(region.home),
        lastScannedAt: cachedAt,
      });
    }
  }

  for (const compartment of value.compartments || []) {
    if (compartment.id) {
      memoryStore.compartments.set(`${scope.connectorId}|${compartment.id}`, {
        connectorId: scope.connectorId,
        compartmentId: compartment.id,
        name: compartment.name || '',
        description: compartment.description || '',
        status: compartment.status || '',
        parentCompartmentId: compartment.parentCompartmentId || '',
        lastScannedAt: cachedAt,
      });
    }
  }

  const keepExistingResources = resourceCount(value) === 0
    && (value.errors || []).length > 0
    && ['allResources', 'scopeResources'].includes(scope.resourceType || '');
  if (!keepExistingResources) {
    for (const key of Array.from(memoryStore.resources.keys())) {
      if (key.startsWith(`${scopeKey}|`)) {
        memoryStore.resources.delete(key);
      }
    }
  }

  for (const [resourceType, rows] of resourceGroups(value)) {
    for (const row of rows) {
      const record = resourceRecord(scopeKey, scope, resourceType, row, cachedAt);
      if (record) {
        memorySetResource(record);
      }
    }
  }
}

async function persistInventoryRowsPostgres(client, scope, scopeKey, value, cachedAt) {
  for (const region of value.regions || []) {
    if (region.name) {
      await client.query(
        `INSERT INTO oci_regions (connector_id, name, region_key, status, home, last_scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(connector_id, name) DO UPDATE SET
           region_key = EXCLUDED.region_key,
           status = EXCLUDED.status,
           home = EXCLUDED.home,
           last_scanned_at = EXCLUDED.last_scanned_at`,
        [scope.connectorId, region.name, region.key || '', region.status || '', Boolean(region.home), cachedAt],
      );
    }
  }

  for (const compartment of value.compartments || []) {
    if (compartment.id) {
      await client.query(
        `INSERT INTO oci_compartments (
           connector_id, compartment_id, name, description, status, parent_compartment_id, last_scanned_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(connector_id, compartment_id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           status = EXCLUDED.status,
           parent_compartment_id = EXCLUDED.parent_compartment_id,
           last_scanned_at = EXCLUDED.last_scanned_at`,
        [
          scope.connectorId,
          compartment.id,
          compartment.name || '',
          compartment.description || '',
          compartment.status || '',
          compartment.parentCompartmentId || '',
          cachedAt,
        ],
      );
    }
  }

  const keepExistingResources = resourceCount(value) === 0
    && (value.errors || []).length > 0
    && ['allResources', 'scopeResources'].includes(scope.resourceType || '');
  if (!keepExistingResources) {
    await client.query('DELETE FROM oci_resources WHERE scope_key = $1', [scopeKey]);
  }
  for (const [resourceType, rows] of resourceGroups(value)) {
    for (const row of rows) {
      const record = resourceRecord(scopeKey, scope, resourceType, row, cachedAt);
      if (record) {
        await upsertResourcePostgres(client, record);
      }
    }
  }
}

async function upsertResourcePostgres(client, record) {
  await client.query(
    `INSERT INTO oci_resources (
       scope_key, connector_id, scan_region, resource_type, resource_id, name, status, region,
       compartment_id, compartment_name, availability_domain, shape, size_gb, storage_size_gb,
       memory_gb, ocpus, private_ip, public_ip, raw_json, last_scanned_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20)
     ON CONFLICT(scope_key, resource_type, resource_id) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), oci_resources.name),
       status = EXCLUDED.status,
       region = COALESCE(NULLIF(EXCLUDED.region, ''), oci_resources.region),
       compartment_id = COALESCE(NULLIF(EXCLUDED.compartment_id, ''), oci_resources.compartment_id),
       compartment_name = COALESCE(NULLIF(EXCLUDED.compartment_name, ''), oci_resources.compartment_name),
       availability_domain = COALESCE(NULLIF(EXCLUDED.availability_domain, ''), oci_resources.availability_domain),
       shape = COALESCE(NULLIF(EXCLUDED.shape, ''), oci_resources.shape),
       size_gb = COALESCE(NULLIF(EXCLUDED.size_gb, ''), oci_resources.size_gb),
       storage_size_gb = COALESCE(NULLIF(EXCLUDED.storage_size_gb, ''), oci_resources.storage_size_gb),
       memory_gb = COALESCE(NULLIF(EXCLUDED.memory_gb, ''), oci_resources.memory_gb),
       ocpus = COALESCE(NULLIF(EXCLUDED.ocpus, ''), oci_resources.ocpus),
       private_ip = COALESCE(NULLIF(EXCLUDED.private_ip, ''), oci_resources.private_ip),
       public_ip = COALESCE(NULLIF(EXCLUDED.public_ip, ''), oci_resources.public_ip),
       raw_json = EXCLUDED.raw_json,
       last_scanned_at = EXCLUDED.last_scanned_at`,
    [
      record.scopeKey,
      record.connectorId,
      record.scanRegion,
      record.resourceType,
      record.resourceId,
      record.name,
      record.status,
      record.region,
      record.compartmentId,
      record.compartmentName,
      record.availabilityDomain,
      record.shape,
      record.sizeGb,
      record.storageSizeGb,
      record.memoryGb,
      record.ocpus,
      record.privateIp,
      record.publicIp,
      record.rawJson,
      record.lastScannedAt,
    ],
  );
}

function parsePayload(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function uniqueBy(items, keyFn) {
  const byKey = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (key && !byKey.has(key)) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values());
}

function compactCachedErrors(errors) {
  const grouped = new Map();
  for (const error of errors || []) {
    const key = [error.scope || '', error.region || '', error.message || ''].join('|');
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    grouped.set(key, { ...error, count: 1 });
  }
  return Array.from(grouped.values()).map((error) => {
    const { count, ...rest } = error;
    return count > 1 ? { ...rest, message: `${rest.message} (${count} scans)` } : rest;
  });
}

function latestIso(values) {
  return values
    .filter(Boolean)
    .sort((left, right) => String(right).localeCompare(String(left)))[0] || '';
}

function combineAllResourcePayloads(rows, connector) {
  const payloads = rows
    .map((row) => ({
      scanRegion: row.scanRegion || row.scan_region || '',
      cachedAt: row.cachedAt || (row.cached_at instanceof Date ? row.cached_at.toISOString() : row.cached_at) || '',
      payload: parsePayload(row.payloadJson || row.payload_json),
    }))
    .filter((row) => row.payload);
  if (!payloads.length) {
    return null;
  }

  const combined = {
    generatedAt: new Date().toISOString(),
    cached: true,
    cachedAt: latestIso(payloads.map((row) => row.cachedAt)),
    lastScannedAt: latestIso(payloads.map((row) => row.payload.lastScannedAt || row.payload.cachedAt || row.payload.generatedAt || row.cachedAt)),
    connector: payloads[0].payload.connector || {
      id: connector.id,
      name: connector.name,
      region: connector.region,
      tenancyOcid: connector.tenancyOcid,
    },
    summary: {
      regions: 0,
      compartments: 0,
      instances: 0,
      runningInstances: 0,
      stoppedInstances: 0,
      blockVolumes: 0,
      bootVolumes: 0,
      vcns: 0,
      subnets: 0,
      internetGateways: 0,
      natGateways: 0,
      serviceGateways: 0,
      drgAttachments: 0,
      routeTables: 0,
      securityLists: 0,
      buckets: 0,
      dbSystems: 0,
      autonomousDatabases: 0,
      autonomousContainerDatabases: 0,
      exadataInfrastructures: 0,
    },
    regions: uniqueBy(payloads.flatMap((row) => row.payload.regions || []), (region) => region.name),
    compartments: uniqueBy(payloads.flatMap((row) => row.payload.compartments || []), (compartment) => compartment.id),
    instances: uniqueBy(payloads.flatMap((row) => row.payload.instances || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    blockVolumes: uniqueBy(payloads.flatMap((row) => row.payload.blockVolumes || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    bootVolumes: uniqueBy(payloads.flatMap((row) => row.payload.bootVolumes || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    vcns: uniqueBy(payloads.flatMap((row) => row.payload.vcns || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    subnets: uniqueBy(payloads.flatMap((row) => row.payload.subnets || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    internetGateways: uniqueBy(payloads.flatMap((row) => row.payload.internetGateways || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    natGateways: uniqueBy(payloads.flatMap((row) => row.payload.natGateways || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    serviceGateways: uniqueBy(payloads.flatMap((row) => row.payload.serviceGateways || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    drgAttachments: uniqueBy(payloads.flatMap((row) => row.payload.drgAttachments || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    routeTables: uniqueBy(payloads.flatMap((row) => row.payload.routeTables || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    securityLists: uniqueBy(payloads.flatMap((row) => row.payload.securityLists || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    buckets: uniqueBy(payloads.flatMap((row) => row.payload.buckets || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    dbSystems: uniqueBy(payloads.flatMap((row) => row.payload.dbSystems || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    autonomousDatabases: uniqueBy(payloads.flatMap((row) => row.payload.autonomousDatabases || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    autonomousContainerDatabases: uniqueBy(payloads.flatMap((row) => row.payload.autonomousContainerDatabases || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    exadataInfrastructures: uniqueBy(payloads.flatMap((row) => row.payload.exadataInfrastructures || []), (resource) => resource.id || `${resource.region}:${resource.name}`),
    errors: compactCachedErrors(payloads.flatMap((row) => row.payload.errors || [])),
    scan: {
      requestedRegion: 'all',
      homeRegion: payloads[0].payload.scan?.homeRegion || connector.region,
      scannedRegions: uniqueBy(payloads.flatMap((row) => row.payload.scan?.scannedRegions || [row.scanRegion]).filter(Boolean), (region) => region),
      compartmentScopeId: payloads[0].payload.scan?.compartmentScopeId || connector.compartmentOcid || connector.tenancyOcid,
      scannedCompartments: Math.max(...payloads.map((row) => Number(row.payload.scan?.scannedCompartments || 0)), 0),
      scannedResourceCompartments: payloads.reduce((total, row) => total + Number(row.payload.scan?.scannedResourceCompartments || 0), 0),
      totalResourceCompartments: payloads.reduce((total, row) => total + Number(row.payload.scan?.totalResourceCompartments || 0), 0),
      instanceScanComplete: payloads.some((row) => row.payload.scan?.instanceScanComplete === true),
      partial: payloads.some((row) => row.payload.scan?.partial === true || (row.payload.errors || []).length > 0),
      inProgress: false,
      phase: 'Loaded cached regional scans',
    },
  };

  combined.summary = {
    regions: combined.regions.length || combined.scan.scannedRegions.length,
    compartments: combined.compartments.length,
    instances: combined.instances.length,
    runningInstances: combined.instances.filter((item) => String(item.status || '').toUpperCase() === 'RUNNING').length,
    stoppedInstances: combined.instances.filter((item) => ['STOPPED', 'STOPPING'].includes(String(item.status || '').toUpperCase())).length,
    blockVolumes: combined.blockVolumes.length,
    bootVolumes: combined.bootVolumes.length,
    vcns: combined.vcns.length,
    subnets: combined.subnets.length,
    internetGateways: combined.internetGateways.length,
    natGateways: combined.natGateways.length,
    serviceGateways: combined.serviceGateways.length,
    drgAttachments: combined.drgAttachments.length,
    routeTables: combined.routeTables.length,
    securityLists: combined.securityLists.length,
    buckets: combined.buckets.length,
    dbSystems: combined.dbSystems.length,
    autonomousDatabases: combined.autonomousDatabases.length,
    autonomousContainerDatabases: combined.autonomousContainerDatabases.length,
    exadataInfrastructures: combined.exadataInfrastructures.length,
  };
  return combined;
}

function inventoryFromResourceRows({ connector, scanRegion = 'all', regions = [], compartments = [], resources = [], cachedAt = '' }) {
  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    cached: true,
    cachedAt,
    lastScannedAt: cachedAt || generatedAt,
    connector: {
      id: connector.id,
      name: connector.name,
      region: connector.region,
      tenancyOcid: connector.tenancyOcid,
    },
    summary: {
      regions: 0,
      compartments: 0,
      instances: 0,
      runningInstances: 0,
      stoppedInstances: 0,
      blockVolumes: 0,
      bootVolumes: 0,
      vcns: 0,
      subnets: 0,
      internetGateways: 0,
      natGateways: 0,
      serviceGateways: 0,
      drgAttachments: 0,
      routeTables: 0,
      securityLists: 0,
      buckets: 0,
    },
    regions,
    compartments,
    instances: [],
    blockVolumes: [],
    bootVolumes: [],
    vcns: [],
    subnets: [],
    internetGateways: [],
    natGateways: [],
    serviceGateways: [],
    drgAttachments: [],
    routeTables: [],
    securityLists: [],
    buckets: [],
    dbSystems: [],
    autonomousDatabases: [],
    autonomousContainerDatabases: [],
    exadataInfrastructures: [],
    errors: [],
    scan: {
      requestedRegion: scanRegion,
      homeRegion: connector.region,
      scannedRegions: scanRegion === 'all'
        ? uniqueBy(resources.map((row) => row.region || row.scanRegion).filter(Boolean), (region) => region)
        : [scanRegion],
      compartmentScopeId: connector.compartmentOcid || connector.tenancyOcid,
      scannedCompartments: compartments.length,
      scannedResourceCompartments: 0,
      totalResourceCompartments: 0,
      instanceScanComplete: true,
      partial: false,
      inProgress: false,
      phase: 'Loaded database resource cache',
    },
  };

  const lists = {
    instance: 'instances',
    blockVolume: 'blockVolumes',
    bootVolume: 'bootVolumes',
    vcn: 'vcns',
    subnet: 'subnets',
    internetGateway: 'internetGateways',
    natGateway: 'natGateways',
    serviceGateway: 'serviceGateways',
    drgAttachment: 'drgAttachments',
    routeTable: 'routeTables',
    securityList: 'securityLists',
    bucket: 'buckets',
    dbSystem: 'dbSystems',
    autonomousDatabase: 'autonomousDatabases',
    autonomousContainerDatabase: 'autonomousContainerDatabases',
    exadataInfrastructure: 'exadataInfrastructures',
  };
  for (const row of resources) {
    const listName = lists[row.resourceType || row.resource_type];
    if (!listName) {
      continue;
    }
    const parsed = parsePayload(row.rawJson || row.raw_json || {});
    payload[listName].push(parsed);
  }

  payload.instances = uniqueBy(payload.instances, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.blockVolumes = uniqueBy(payload.blockVolumes, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.bootVolumes = uniqueBy(payload.bootVolumes, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.vcns = uniqueBy(payload.vcns, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.subnets = uniqueBy(payload.subnets, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.internetGateways = uniqueBy(payload.internetGateways, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.natGateways = uniqueBy(payload.natGateways, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.serviceGateways = uniqueBy(payload.serviceGateways, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.drgAttachments = uniqueBy(payload.drgAttachments, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.routeTables = uniqueBy(payload.routeTables, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.securityLists = uniqueBy(payload.securityLists, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.buckets = uniqueBy(payload.buckets, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.dbSystems = uniqueBy(payload.dbSystems, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.autonomousDatabases = uniqueBy(payload.autonomousDatabases, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.autonomousContainerDatabases = uniqueBy(payload.autonomousContainerDatabases, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.exadataInfrastructures = uniqueBy(payload.exadataInfrastructures, (resource) => resource.id || `${resource.region}:${resource.name}`);
  payload.summary = {
    regions: payload.regions.length || payload.scan.scannedRegions.length,
    compartments: payload.compartments.length,
    instances: payload.instances.length,
    runningInstances: payload.instances.filter((item) => String(item.status || '').toUpperCase() === 'RUNNING').length,
    stoppedInstances: payload.instances.filter((item) => ['STOPPED', 'STOPPING'].includes(String(item.status || '').toUpperCase())).length,
    blockVolumes: payload.blockVolumes.length,
    bootVolumes: payload.bootVolumes.length,
    vcns: payload.vcns.length,
    subnets: payload.subnets.length,
    internetGateways: payload.internetGateways.length,
    natGateways: payload.natGateways.length,
    serviceGateways: payload.serviceGateways.length,
    drgAttachments: payload.drgAttachments.length,
    routeTables: payload.routeTables.length,
    securityLists: payload.securityLists.length,
    buckets: payload.buckets.length,
    dbSystems: payload.dbSystems.length,
    autonomousDatabases: payload.autonomousDatabases.length,
    autonomousContainerDatabases: payload.autonomousContainerDatabases.length,
    exadataInfrastructures: payload.exadataInfrastructures.length,
  };
  return payload;
}

export async function getCachedOciInventoryEntry(scope) {
  const scopeKey = cacheKey(scope);
  if (useMemoryStore()) {
    const row = memoryStore.snapshots.get(scopeKey);
    return row ? { ...parsePayload(row.payloadJson), cachedAt: row.cachedAt } : null;
  }

  const targetPool = await getPool();
  const { rows } = await targetPool.query(
    'SELECT payload_json, cached_at FROM oci_inventory_snapshots WHERE scope_key = $1',
    [scopeKey],
  );
  if (!rows[0]) {
    return null;
  }
  return {
    ...parsePayload(rows[0].payload_json),
    cachedAt: rows[0].cached_at instanceof Date ? rows[0].cached_at.toISOString() : rows[0].cached_at,
  };
}

export async function getCachedOciInventoryFromResources(connector, scanRegion = 'all') {
  if (useMemoryStore()) {
    const regions = Array.from(memoryStore.regions.values())
      .filter((row) => row.connectorId === connector.id)
      .map((row) => ({ name: row.name, key: row.regionKey || '', status: row.status || 'READY', home: Boolean(row.home) }));
    const compartments = Array.from(memoryStore.compartments.values())
      .filter((row) => row.connectorId === connector.id)
      .map((row) => ({
        id: row.compartmentId,
        name: row.name,
        description: row.description || '',
        status: row.status || 'ACTIVE',
        parentCompartmentId: row.parentCompartmentId || '',
      }));
    const resources = Array.from(memoryStore.resources.values())
      .filter((row) => row.connectorId === connector.id && (scanRegion === 'all' || row.scanRegion === scanRegion || row.region === scanRegion));
    if (!resources.length) {
      return null;
    }
    return inventoryFromResourceRows({
      connector,
      scanRegion,
      regions,
      compartments,
      resources: resources.map((row) => ({ ...row, rawJson: row.rawJson })),
      cachedAt: latestIso(resources.map((row) => row.lastScannedAt)),
    });
  }

  const targetPool = await getPool();
  const [regionsResult, compartmentsResult, resourcesResult] = await Promise.all([
    targetPool.query(
      'SELECT name, region_key, status, home FROM oci_regions WHERE connector_id = $1 ORDER BY name',
      [connector.id],
    ),
    targetPool.query(
      `SELECT compartment_id, name, description, status, parent_compartment_id
       FROM oci_compartments
       WHERE connector_id = $1
       ORDER BY name`,
      [connector.id],
    ),
    targetPool.query(
      `SELECT scan_region, resource_type, raw_json, region, last_scanned_at
       FROM oci_resources
       WHERE connector_id = $1
         AND ($2 = 'all' OR scan_region = $2 OR region = $2)
       ORDER BY last_scanned_at DESC`,
      [connector.id, scanRegion],
    ),
  ]);
  if (!resourcesResult.rows.length) {
    return null;
  }
  return inventoryFromResourceRows({
    connector,
    scanRegion,
    regions: regionsResult.rows.map((row) => ({ name: row.name, key: row.region_key || '', status: row.status || 'READY', home: Boolean(row.home) })),
    compartments: compartmentsResult.rows.map((row) => ({
      id: row.compartment_id,
      name: row.name || '',
      description: row.description || '',
      status: row.status || 'ACTIVE',
      parentCompartmentId: row.parent_compartment_id || '',
    })),
    resources: resourcesResult.rows,
    cachedAt: latestIso(resourcesResult.rows.map((row) => row.last_scanned_at instanceof Date ? row.last_scanned_at.toISOString() : row.last_scanned_at)),
  });
}

export async function getCombinedCachedOciAllResources(connector) {
  if (useMemoryStore()) {
    const rows = Array.from(memoryStore.snapshots.values())
      .filter((row) => row.connectorId === connector.id && row.resourceType === 'allResources')
      .map((row) => ({ ...row, payloadJson: row.payloadJson }));
    return combineAllResourcePayloads(rows, connector);
  }

  const targetPool = await getPool();
  const { rows } = await targetPool.query(
    `SELECT scan_region, payload_json, cached_at
     FROM oci_inventory_snapshots
     WHERE connector_id = $1 AND resource_type = 'allResources'
     ORDER BY cached_at DESC`,
    [connector.id],
  );
  return combineAllResourcePayloads(rows, connector);
}

export async function setCachedOciInventoryEntry(scope, value) {
  const scopeKey = cacheKey(scope);
  const cachedAt = new Date().toISOString();
  const existing = await getCachedOciInventoryEntry(scope);
  if (
    existing
    && resourceCount(existing) > 0
    && resourceCount(value) === 0
    && (value.errors || []).length > 0
    && ['allResources', 'scopeResources'].includes(scope.resourceType || '')
  ) {
    return {
      ...existing,
      generatedAt: cachedAt,
      cachedAt,
      cached: true,
      errors: compactCachedErrors(value.errors || []),
      scan: {
        ...(existing.scan || {}),
        inProgress: false,
        partial: true,
        phase: 'Kept previous cache after failed scan',
      },
    };
  }
  const storedValue = {
    ...value,
    cachedAt,
  };

  if (useMemoryStore()) {
    memoryStore.snapshots.set(scopeKey, {
      scopeKey,
      connectorId: scope.connectorId,
      scanRegion: scope.region || 'all',
      compartmentId: scope.compartmentId || '',
      resourceType: scope.resourceType || '',
      payloadJson: JSON.stringify(storedValue),
      cachedAt,
    });
    persistInventoryRowsMemory(scope, scopeKey, storedValue, cachedAt);
    memoryStore.scanRuns.push({
      scopeKey,
      connectorId: scope.connectorId,
      scanRegion: scope.region || 'all',
      status: storedValue.scan?.inProgress ? 'running' : storedValue.errors?.length ? 'partial' : 'completed',
      startedAt: storedValue.lastScannedAt || storedValue.generatedAt || cachedAt,
      finishedAt: storedValue.scan?.inProgress ? null : cachedAt,
      summaryJson: JSON.stringify(storedValue.summary || {}),
    });
    return storedValue;
  }

  const targetPool = await getPool();
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO oci_inventory_snapshots (
         scope_key, connector_id, scan_region, compartment_id, resource_type, payload_json, cached_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT(scope_key) DO UPDATE SET
         payload_json = EXCLUDED.payload_json,
         cached_at = EXCLUDED.cached_at`,
      [
        scopeKey,
        scope.connectorId,
        scope.region || 'all',
        scope.compartmentId || '',
        scope.resourceType || '',
        JSON.stringify(storedValue),
        cachedAt,
      ],
    );
    await persistInventoryRowsPostgres(client, scope, scopeKey, storedValue, cachedAt);
    await client.query(
      `INSERT INTO oci_scan_runs (scope_key, connector_id, scan_region, status, started_at, finished_at, summary_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        scopeKey,
        scope.connectorId,
        scope.region || 'all',
        storedValue.scan?.inProgress ? 'running' : storedValue.errors?.length ? 'partial' : 'completed',
        storedValue.lastScannedAt || storedValue.generatedAt || cachedAt,
        storedValue.scan?.inProgress ? null : cachedAt,
        JSON.stringify(storedValue.summary || {}),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return storedValue;
}

export async function updateCachedOciInstance(connectorId, instance) {
  if (!connectorId || !instance?.id) {
    return;
  }

  if (useMemoryStore()) {
    updateCachedOciInstanceMemory(connectorId, instance);
    return;
  }

  await updateCachedOciInstancePostgres(connectorId, instance);
}

export async function updateCachedOciResource(connectorId, resourceType, resource) {
  if (!connectorId || !resourceType || !resource?.id) {
    return;
  }

  if (resourceType === 'instance') {
    await updateCachedOciInstance(connectorId, resource);
    return;
  }

  if (useMemoryStore()) {
    updateCachedOciResourceMemory(connectorId, resourceType, resource);
    return;
  }

  await updateCachedOciResourcePostgres(connectorId, resourceType, resource);
}

export async function deleteCachedOciResource(connectorId, resourceType, resource) {
  const resourceId = String(resource?.id || resource?.name || '');
  if (!connectorId || !resourceType || !resourceId) {
    return;
  }
  const listName = resourceListName(resourceType);
  if (!listName) {
    return;
  }

  if (useMemoryStore()) {
    for (const row of Array.from(memoryStore.snapshots.values()).filter((item) => item.connectorId === connectorId && item.resourceType === 'allResources')) {
      const payload = parsePayload(row.payloadJson);
      payload[listName] = (payload[listName] || []).filter((item) => String(item.id || item.name || '') !== resourceId);
      row.payloadJson = JSON.stringify(updateSummaryForResource(payload, resourceType));
      row.cachedAt = new Date().toISOString();
    }
    for (const [key, row] of Array.from(memoryStore.resources.entries())) {
      if (row.connectorId === connectorId && row.resourceType === resourceType && row.resourceId === resourceId) {
        memoryStore.resources.delete(key);
      }
    }
    return;
  }

  const targetPool = await getPool();
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const snapshotResult = await client.query(
      "SELECT scope_key, payload_json FROM oci_inventory_snapshots WHERE connector_id = $1 AND resource_type = 'allResources'",
      [connectorId],
    );
    for (const row of snapshotResult.rows) {
      const payload = parsePayload(row.payload_json);
      payload[listName] = (payload[listName] || []).filter((item) => String(item.id || item.name || '') !== resourceId);
      await client.query(
        'UPDATE oci_inventory_snapshots SET payload_json = $1::jsonb, cached_at = $2 WHERE scope_key = $3',
        [JSON.stringify(updateSummaryForResource(payload, resourceType)), new Date().toISOString(), row.scope_key],
      );
    }
    await client.query(
      'DELETE FROM oci_resources WHERE connector_id = $1 AND resource_type = $2 AND resource_id = $3',
      [connectorId, resourceType, resourceId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function updateCachedOciResourceMemory(connectorId, resourceType, resource) {
  const now = new Date().toISOString();
  const listName = resourceListName(resourceType);
  if (!listName) {
    return;
  }

  for (const row of Array.from(memoryStore.snapshots.values()).filter((item) => item.connectorId === connectorId && item.resourceType === 'allResources')) {
    if (!shouldApplyInstanceToScope(row, resource)) {
      continue;
    }
    const payload = parsePayload(row.payloadJson);
    let changed = false;
    payload[listName] = (payload[listName] || []).map((item) => {
      if (item.id !== resource.id) {
        return item;
      }
      changed = true;
      return mergeOciInstance(item, resource);
    });
    if (!changed) {
      payload[listName] = [...(payload[listName] || []), resource];
    }
    row.payloadJson = JSON.stringify(updateSummaryForResource(payload, resourceType));
    row.cachedAt = now;
    memorySetResource(resourceRecord(row.scopeKey, { connectorId, region: row.scanRegion }, resourceType, resource, now));
  }
}

async function updateCachedOciResourcePostgres(connectorId, resourceType, resource) {
  const now = new Date().toISOString();
  const listName = resourceListName(resourceType);
  if (!listName) {
    return;
  }

  const targetPool = await getPool();
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const snapshotResult = await client.query(
      "SELECT scope_key, scan_region, payload_json FROM oci_inventory_snapshots WHERE connector_id = $1 AND resource_type = 'allResources'",
      [connectorId],
    );
    for (const row of snapshotResult.rows) {
      if (!shouldApplyInstanceToScope(row, resource)) {
        continue;
      }
      const payload = parsePayload(row.payload_json);
      let changed = false;
      payload[listName] = (payload[listName] || []).map((item) => {
        if (item.id !== resource.id) {
          return item;
        }
        changed = true;
        return mergeOciInstance(item, resource);
      });
      if (!changed) {
        payload[listName] = [...(payload[listName] || []), resource];
      }
      await client.query(
        'UPDATE oci_inventory_snapshots SET payload_json = $1::jsonb, cached_at = $2 WHERE scope_key = $3',
        [JSON.stringify(updateSummaryForResource(payload, resourceType)), now, row.scope_key],
      );
      await upsertResourcePostgres(client, resourceRecord(row.scope_key, { connectorId, region: row.scan_region }, resourceType, resource, now));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function updateCachedOciInstanceMemory(connectorId, instance) {
  const now = new Date().toISOString();
  const touchedScopes = new Set();

  for (const row of Array.from(memoryStore.snapshots.values()).filter((item) => item.connectorId === connectorId && item.resourceType === 'allResources')) {
    if (!shouldApplyInstanceToScope(row, instance)) {
      continue;
    }
    const payload = parsePayload(row.payloadJson);
    let changed = false;
    const instanceForPayload = { ...instance, compartmentName: compartmentNameForPayload(payload, instance) };
    payload.instances = (payload.instances || []).map((item) => {
      if (item.id !== instance.id) {
        return item;
      }
      changed = true;
      return mergeOciInstance(item, instanceForPayload);
    });
    if (!changed) {
      payload.instances = [...(payload.instances || []), instanceForPayload];
    }
    row.payloadJson = JSON.stringify(updateSummaryForInstances(payload));
    row.cachedAt = now;
    touchedScopes.add(row.scopeKey);
    memorySetResource(instanceResourceRecord(row.scopeKey, connectorId, row.scanRegion, instanceForPayload, now));
  }

  for (const record of Array.from(memoryStore.resources.values())) {
    if (record.connectorId !== connectorId || record.resourceType !== 'instance' || record.resourceId !== instance.id || touchedScopes.has(record.scopeKey)) {
      continue;
    }
    let previous = {};
    try {
      previous = JSON.parse(record.rawJson || '{}');
    } catch {
      previous = {};
    }
    const merged = mergeOciInstance(previous, instance);
    memorySetResource(instanceResourceRecord(record.scopeKey, connectorId, record.scanRegion, merged, now));
  }
}

async function updateCachedOciInstancePostgres(connectorId, instance) {
  const now = new Date().toISOString();
  const targetPool = await getPool();
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const snapshotResult = await client.query(
      "SELECT scope_key, scan_region, payload_json FROM oci_inventory_snapshots WHERE connector_id = $1 AND resource_type = 'allResources'",
      [connectorId],
    );
    const touchedScopes = new Set();

    for (const row of snapshotResult.rows) {
      if (!shouldApplyInstanceToScope(row, instance)) {
        continue;
      }
      const payload = parsePayload(row.payload_json);
      let changed = false;
      const instanceForPayload = { ...instance, compartmentName: compartmentNameForPayload(payload, instance) };
      payload.instances = (payload.instances || []).map((item) => {
        if (item.id !== instance.id) {
          return item;
        }
        changed = true;
        return mergeOciInstance(item, instanceForPayload);
      });
      if (!changed) {
        payload.instances = [...(payload.instances || []), instanceForPayload];
      }

      await client.query(
        'UPDATE oci_inventory_snapshots SET payload_json = $1::jsonb, cached_at = $2 WHERE scope_key = $3',
        [JSON.stringify(updateSummaryForInstances(payload)), now, row.scope_key],
      );
      touchedScopes.add(row.scope_key);
      await upsertResourcePostgres(client, instanceResourceRecord(row.scope_key, connectorId, row.scan_region, instanceForPayload, now));
    }

    const existingRows = await client.query(
      "SELECT scope_key, scan_region, raw_json FROM oci_resources WHERE connector_id = $1 AND resource_type = 'instance' AND resource_id = $2",
      [connectorId, instance.id],
    );
    for (const row of existingRows.rows) {
      if (touchedScopes.has(row.scope_key)) {
        continue;
      }
      const previous = parsePayload(row.raw_json || {});
      const merged = mergeOciInstance(previous, instance);
      await upsertResourcePostgres(client, instanceResourceRecord(row.scope_key, connectorId, row.scan_region, merged, now));
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getCachedOciResourceRowsForTest(connectorId, resourceType = 'instance') {
  if (useMemoryStore()) {
    return Array.from(memoryStore.resources.values())
      .filter((row) => row.connectorId === connectorId && row.resourceType === resourceType)
      .map((row) => ({
        name: row.name,
        status: row.status,
        region: row.region,
        compartment_id: row.compartmentId,
        shape: row.shape,
        memory_gb: row.memoryGb,
        ocpus: row.ocpus,
        raw_json: row.rawJson,
      }));
  }

  const targetPool = await getPool();
  const { rows } = await targetPool.query(
    `SELECT name, status, region, compartment_id, shape, memory_gb, ocpus, raw_json
     FROM oci_resources
     WHERE connector_id = $1 AND resource_type = $2`,
    [connectorId, resourceType],
  );
  return rows;
}
