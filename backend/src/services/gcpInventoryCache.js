import pg from 'pg';

const { Pool } = pg;

let pool;
let initialized = false;
let activeConnectionKey = '';
const memoryStore = new Map();

function useMemoryStore() {
  return process.env.GCP_INVENTORY_STORE === 'memory'
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

function cacheKey(connectorId, scope) {
  return `${connectorId}|${scope || 'project'}`;
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
      CREATE TABLE IF NOT EXISTS gcp_inventory_snapshots (
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

export async function getCachedGcpInventory(connectorId, scope = 'project') {
  const scanScope = scope || 'project';
  if (useMemoryStore()) {
    const row = memoryStore.get(cacheKey(connectorId, scanScope));
    return row ? { ...parsePayload(row.payloadJson), cached: true, cachedAt: row.cachedAt } : null;
  }

  const targetPool = await getPool();
  const { rows } = await targetPool.query(
    'SELECT payload_json, cached_at FROM gcp_inventory_snapshots WHERE connector_id = $1 AND scan_scope = $2',
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

export async function setCachedGcpInventory(connectorId, scope = 'project', payload) {
  const scanScope = scope || 'project';
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
    `INSERT INTO gcp_inventory_snapshots (connector_id, scan_scope, payload_json, cached_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT(connector_id, scan_scope) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       cached_at = EXCLUDED.cached_at`,
    [connectorId, scanScope, JSON.stringify(stored), cachedAt],
  );
  return stored;
}
