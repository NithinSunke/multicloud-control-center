import { randomUUID } from 'crypto';
import { getOciInventory } from './ociApiClient.js';
import { setCachedOciInventoryEntry } from './ociInventoryCache.js';
import { logger } from '../utils/logger.js';

const jobs = new Map();

function cloneData(data) {
  return data ? JSON.parse(JSON.stringify(data)) : null;
}

function emptyJobData(connector, scanRegion = 'all', initialData = null) {
  const now = new Date().toISOString();
  if (initialData) {
    return {
      ...cloneData(initialData),
      generatedAt: now,
      cached: false,
      lastScannedAt: initialData.lastScannedAt || initialData.cachedAt || initialData.generatedAt || now,
      scan: {
        ...(initialData.scan || {}),
        requestedRegion: scanRegion,
        phase: 'Refreshing inventory',
        currentRegion: '',
        currentCompartmentName: '',
        inProgress: true,
        partial: true,
      },
    };
  }

  return {
    generatedAt: now,
    cached: false,
    lastScannedAt: now,
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
      buckets: 0,
    },
    regions: [],
    compartments: [],
    instances: [],
    blockVolumes: [],
    bootVolumes: [],
    vcns: [],
    subnets: [],
    buckets: [],
    errors: [],
    scan: {
      requestedRegion: scanRegion,
      homeRegion: connector.region,
      scannedRegions: [],
      compartmentScopeId: connector.compartmentOcid || connector.tenancyOcid,
      scannedCompartments: 0,
      scannedResourceCompartments: 0,
      totalResourceCompartments: 0,
      phase: 'Discovering compartments',
      currentRegion: '',
      currentCompartmentName: '',
      inProgress: true,
      partial: true,
    },
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    error: job.error || '',
    data: cloneData(job.data),
  };
}

export function getOciAllResourceScanJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

export function getRunningOciAllResourceScan(connectorId, scanRegion = 'all') {
  const job = Array.from(jobs.values()).find((item) =>
    item.connectorId === connectorId && item.scanRegion === scanRegion && item.status === 'running',
  );
  return job ? publicJob(job) : null;
}

export function startOciAllResourceScan(connector, cacheScope, scanRegion = 'all', initialData = null) {
  const existing = getRunningOciAllResourceScan(connector.id, scanRegion);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    connectorId: connector.id,
    scanRegion,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    finishedAt: '',
    error: '',
    data: emptyJobData(connector, scanRegion, initialData),
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      const data = await getOciInventory(connector, {
        region: scanRegion,
        compartmentConcurrency: 1,
        maxScanMs: scanRegion === 'all' ? 21600000 : 7200000,
        onProgress: async (partialData) => {
          const updated = {
            ...partialData,
            cached: false,
            lastScannedAt: partialData.generatedAt,
          };
          job.data = updated;
          job.updatedAt = new Date().toISOString();
          await setCachedOciInventoryEntry(cacheScope, updated);
        },
      });

      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.data = {
        ...data,
        cached: false,
        lastScannedAt: data.generatedAt,
      };
      await setCachedOciInventoryEntry(cacheScope, job.data);
    } catch (error) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.error = error instanceof Error ? error.message : 'OCI scan failed.';
      job.data = {
        ...job.data,
        errors: [
          ...(job.data?.errors || []),
          { scope: 'inventoryScan', message: job.error },
        ],
        scan: {
          ...(job.data?.scan || {}),
          inProgress: false,
          partial: true,
          phase: 'Scan failed',
        },
      };
      await setCachedOciInventoryEntry(cacheScope, job.data);
      logger.error('oci_all_resource_scan_failed', {
        connectorId: connector.id,
        jobId: job.id,
        error: { message: job.error },
      });
    }
  })();

  return publicJob(job);
}
