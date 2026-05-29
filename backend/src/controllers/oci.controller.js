import { getSelectedOciConnectorForUse } from '../services/connectorStore.js';
import { appendAuditLog } from '../services/auditLog.js';
import {
  cloneOciVolume,
  cloneOciAutonomousDatabase,
  connectOciRemotePeeringConnection,
  createOciAutonomousDatabase,
  createOciDbSystem,
  createOciBucket,
  createOciDnsView,
  createOciDnsZone,
  createOciDrg,
  createOciDrgAttachment,
  createOciGateway,
  createOciFileSystem,
  createOciInstance,
  createOciInstanceImage,
  createOciMountTarget,
  createOciRouteTable,
  createOciSecurityList,
  createOciSubnet,
  createOciVcn,
  createOciRemotePeeringConnection,
  createOciVolumeBackup,
  deleteOciCustomImage,
  deleteOciDatabaseResource,
  deleteOciBucket,
  deleteOciDnsRecord,
  deleteOciDnsZone,
  deleteOciDrg,
  deleteOciDrgAttachment,
  deleteOciSubnet,
  deleteOciRemotePeeringConnection,
  deleteOciVolumeBackup,
  deleteOciVcn,
  getOciAvailabilityDomains,
  getOciCustomImage,
  getOciCustomImages,
  getOciDatabaseResources,
  generateOciSshKeyPair,
  getOciDbVersions,
  listOciDbSystemNodes,
  getOciInstanceStatus,
  getOciInstances,
  getOciFileStorageResources,
  getOciInventory,
  getOciLaunchOptions,
  getOciDnsResources,
  getOciDnsZoneRecords,
  getOciNetworkResources,
  getOciObjectStorageResources,
  getOciVolumeBackups,
  getOciVolumeGroupResources,
  getOciScopedResources,
  moveOciInstance,
  resizeOciVolume,
  restoreOciVolume,
  runOciAutonomousDatabaseAction,
  runOciDbNodeAction,
  runOciInstanceAction,
  terminateOciInstance,
  upsertOciDnsRecord,
  updateOciInstance,
  updateOciDbSystem,
} from '../services/ociApiClient.js';
import { deleteCachedOciResource, getCachedOciInventoryEntry, getCachedOciInventoryFromResources, getCombinedCachedOciAllResources, setCachedOciInventoryEntry, updateCachedOciInstance, updateCachedOciResource } from '../services/ociInventoryCache.js';
import { getOciResourceMap as buildOciResourceMap } from '../services/ociResourceMap.js';
import { getOciAllResourceScanJob, getRunningOciAllResourceScan, startOciAllResourceScan } from '../services/ociScanJobs.js';
import { logger } from '../utils/logger.js';

function handleError(error, req, res) {
  logger.error('oci_request_failed', {
    requestId: req.id,
    path: req.originalUrl,
    statusCode: error.statusCode || 500,
    error: { message: error.message },
  });
  res.status(error.statusCode || 500).json({
    message: error.statusCode ? error.message : 'Unable to process OCI request.',
    requestId: req.id,
  });
}

function normalizedScanRegion(value) {
  const region = String(value || '').trim();
  return region && region !== 'all' ? region : 'all';
}

function allResourcesCacheScope(connector, scanRegion = 'all') {
  return {
    connectorId: connector.id,
    region: scanRegion,
    compartmentId: connector.compartmentOcid || connector.tenancyOcid,
    resourceType: 'allResources',
  };
}

function ociResourceCount(data = {}) {
  return [
    ...(data.instances || []),
    ...(data.blockVolumes || []),
    ...(data.bootVolumes || []),
    ...(data.vcns || []),
    ...(data.subnets || []),
    ...(data.buckets || []),
    ...(data.dbSystems || []),
    ...(data.autonomousDatabases || []),
    ...(data.autonomousContainerDatabases || []),
    ...(data.exadataInfrastructures || []),
  ].length;
}

function auditUser(req) {
  return req.user?.username || 'unknown';
}

async function auditOci(entry, req) {
  await appendAuditLog({
    provider: 'oci',
    user: auditUser(req),
    ...entry,
  }).catch(() => undefined);
}

export async function getInventory(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciInventory(connector, { identityOnly: true });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getInstances(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const region = String(req.query.region || '').trim();
    const compartmentId = String(req.query.compartmentId || '').trim();
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';

    if (!region || !compartmentId) {
      res.status(400).json({ message: 'Region and compartment are required.' });
      return;
    }

    const cacheScope = {
      connectorId: connector.id,
      region,
      compartmentId,
      resourceType: 'instances',
    };

    if (!refresh) {
      const cached = await getCachedOciInventoryEntry(cacheScope);
      if (cached) {
        res.json({
          data: {
            ...cached,
            generatedAt: new Date().toISOString(),
            cached: true,
          },
        });
        return;
      }
    }

    const data = await getOciInstances(connector, { region, compartmentId });
    const cached = await setCachedOciInventoryEntry(cacheScope, {
      ...data,
      cached: false,
    });
    res.json({ data: { ...cached, cached: false } });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getResources(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const region = String(req.query.region || '').trim();
    const compartmentId = String(req.query.compartmentId || '').trim();
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';

    if (!region || !compartmentId) {
      res.status(400).json({ message: 'Region and compartment are required.' });
      return;
    }

    const cacheScope = {
      connectorId: connector.id,
      region,
      compartmentId,
      resourceType: 'scopeResources',
    };

    if (!refresh) {
      const cached = await getCachedOciInventoryEntry(cacheScope);
      if (cached) {
        res.json({
          data: {
            ...cached,
            generatedAt: new Date().toISOString(),
            cached: true,
          },
        });
        return;
      }
    }

    const data = await getOciScopedResources(connector, { region, compartmentId });
    const cached = await setCachedOciInventoryEntry(cacheScope, {
      ...data,
      cached: false,
    });
    res.json({ data: { ...cached, cached: false } });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getLaunchOptions(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const region = String(req.query.region || '').trim();
    const compartmentId = String(req.query.compartmentId || '').trim();
    const networkCompartmentId = String(req.query.networkCompartmentId || '').trim();
    const availabilityDomain = String(req.query.availabilityDomain || '').trim();

    if (!region || !compartmentId) {
      res.status(400).json({ message: 'Region and compartment are required.' });
      return;
    }

    const data = await getOciLaunchOptions(connector, { region, compartmentId, networkCompartmentId, availabilityDomain });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getAvailabilityDomains(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const region = String(req.query.region || '').trim();

    if (!region) {
      res.status(400).json({ message: 'Region is required.' });
      return;
    }

    const data = await getOciAvailabilityDomains(connector, { region });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getAllResources(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const scanRegion = normalizedScanRegion(req.query.region);

    const cacheScope = allResourcesCacheScope(connector, scanRegion);

    const running = getRunningOciAllResourceScan(connector.id, scanRegion);
    if (running) {
      res.json({ job: running, data: running.data });
      return;
    }

    const cached = await getCachedOciInventoryEntry(cacheScope);
    if (cached) {
      const rowCache = await getCachedOciInventoryFromResources(connector, scanRegion);
      if (rowCache && (cached.errors?.length || scanRegion === 'all') && ociResourceCount(rowCache) > ociResourceCount(cached)) {
        res.json({
          data: {
            ...rowCache,
            generatedAt: new Date().toISOString(),
            cached: true,
          },
        });
        return;
      }
      res.json({
        data: {
          ...cached,
          generatedAt: new Date().toISOString(),
          cached: true,
        },
      });
      return;
    }

    if (scanRegion === 'all') {
      const rowCache = await getCachedOciInventoryFromResources(connector, scanRegion);
      if (rowCache) {
        res.json({
          data: {
            ...rowCache,
            generatedAt: new Date().toISOString(),
            cached: true,
          },
        });
        return;
      }
      const combined = await getCombinedCachedOciAllResources(connector);
      if (combined) {
        res.json({
          data: {
            ...combined,
            generatedAt: new Date().toISOString(),
            cached: true,
          },
        });
        return;
      }
    }

    if (scanRegion !== 'all') {
      const rowCache = await getCachedOciInventoryFromResources(connector, scanRegion);
      if (rowCache) {
        res.json({
          data: {
            ...rowCache,
            generatedAt: new Date().toISOString(),
            cached: true,
          },
        });
        return;
      }
    }

    res.json({
      data: {
        generatedAt: new Date().toISOString(),
        cached: false,
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
          dbSystems: 0,
          autonomousDatabases: 0,
          autonomousContainerDatabases: 0,
          exadataInfrastructures: 0,
        },
        regions: [],
        compartments: [],
        instances: [],
        blockVolumes: [],
        bootVolumes: [],
        vcns: [],
        subnets: [],
        buckets: [],
        dbSystems: [],
        autonomousDatabases: [],
        autonomousContainerDatabases: [],
        exadataInfrastructures: [],
        errors: [],
        scan: {
          requestedRegion: scanRegion,
          homeRegion: connector.region,
          scannedRegions: [],
          compartmentScopeId: connector.compartmentOcid || connector.tenancyOcid,
          scannedCompartments: 0,
          scannedResourceCompartments: 0,
          totalResourceCompartments: 0,
          phase: 'No scan has been run yet',
          inProgress: false,
          partial: false,
        },
      },
    });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function startAllResourcesScan(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const scanRegion = normalizedScanRegion(req.body?.region || req.query.region);
    const cacheScope = allResourcesCacheScope(connector, scanRegion);
    const cached = await getCachedOciInventoryEntry(cacheScope);
    const job = startOciAllResourceScan(connector, cacheScope, scanRegion, cached);
    res.status(202).json({ job, data: job.data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getAllResourcesScan(req, res) {
  try {
    const job = getOciAllResourceScanJob(String(req.params.jobId || ''));
    if (!job) {
      res.status(404).json({ message: 'OCI scan job was not found.' });
      return;
    }
    res.json({ job, data: job.data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getResourceMap(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await buildOciResourceMap(connector, {
      region: normalizedScanRegion(req.query.region),
      compartmentId: req.query.compartmentId,
      resourceType: req.query.resourceType,
      resourceId: req.query.resourceId,
      search: req.query.search,
      vcnId: req.query.vcnId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function runInstanceAction(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const action = String(req.params.action || '').toLowerCase();
    const data = await runOciInstanceAction(connector, {
      region: req.body?.region,
      instanceId: req.params.instanceId,
      action: req.params.action,
    });
    const status = action === 'start' ? 'STARTING' : action === 'stop' ? 'STOPPING' : action === 'reboot' ? 'REBOOTING' : '';
    if (status) {
      await updateCachedOciInstance(connector.id, {
        id: req.params.instanceId,
        region: req.body?.region,
        status,
      });
    }
    await auditOci({
      action: `oci-vm-${action}`,
      connectorId: connector.id,
      instanceId: req.params.instanceId,
      region: req.body?.region,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-vm-${String(req.params.action || '').toLowerCase()}`,
      instanceId: req.params.instanceId,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function getInstanceStatus(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciInstanceStatus(connector, {
      region: req.query.region || req.body?.region,
      instanceId: req.params.instanceId,
    });
    await updateCachedOciInstance(connector.id, data.instance);
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function createInstance(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciInstance(connector, req.body || {});
    await updateCachedOciInstance(connector.id, data.instance);
    await auditOci({
      action: 'oci-vm-create',
      connectorId: connector.id,
      instanceId: data.instance?.id || '',
      instanceName: req.body?.displayName,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-vm-create',
      instanceName: req.body?.displayName,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function updateInstance(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await updateOciInstance(connector, {
      region: req.body?.region,
      instanceId: req.params.instanceId,
      displayName: req.body?.displayName,
      shape: req.body?.shape,
      ocpus: req.body?.ocpus,
      memoryGb: req.body?.memoryGb,
    });
    await updateCachedOciInstance(connector.id, data.instance);
    await auditOci({
      action: 'oci-vm-update',
      connectorId: connector.id,
      instanceId: req.params.instanceId,
      instanceName: data.instance?.name || req.body?.displayName,
      region: req.body?.region,
      compartmentId: data.instance?.compartmentId || req.body?.compartmentId,
      shape: data.instance?.shape || req.body?.shape,
      ocpus: data.instance?.ocpus || req.body?.ocpus,
      memoryGb: data.instance?.memoryGb || req.body?.memoryGb,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-vm-update',
      instanceId: req.params.instanceId,
      instanceName: req.body?.displayName,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function terminateInstance(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await terminateOciInstance(connector, {
      region: req.body?.region,
      instanceId: req.params.instanceId,
      confirmation: req.body?.confirmation,
      instanceName: req.body?.instanceName,
    });
    await auditOci({
      action: 'oci-vm-terminate',
      connectorId: connector.id,
      instanceId: req.params.instanceId,
      region: req.body?.region,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-vm-terminate',
      instanceId: req.params.instanceId,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function listCustomImages(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciCustomImages(connector, {
      region: req.query.region,
      compartmentId: req.query.compartmentId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function getCustomImageStatus(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciCustomImage(connector, {
      region: req.query.region || req.body?.region,
      imageId: req.params.imageId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function deleteCustomImage(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciCustomImage(connector, {
      region: req.body?.region || req.query.region,
      imageId: req.params.imageId,
      imageName: req.body?.imageName,
      confirmation: req.body?.confirmation,
    });
    await auditOci({
      action: 'oci-custom-image-delete',
      connectorId: connector.id,
      imageId: req.params.imageId,
      imageName: data.image?.name || req.body?.imageName,
      region: req.body?.region || req.query.region,
      compartmentId: data.image?.compartmentId || req.body?.compartmentId,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-custom-image-delete',
      imageId: req.params.imageId,
      imageName: req.body?.imageName,
      region: req.body?.region || req.query.region,
      compartmentId: req.body?.compartmentId,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function createInstanceImage(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciInstanceImage(connector, {
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      instanceId: req.params.instanceId,
      displayName: req.body?.displayName,
    });
    data.image.sourceInstanceName = req.body?.instanceName || '';
    await auditOci({
      action: 'oci-custom-image-create',
      connectorId: connector.id,
      instanceId: req.params.instanceId,
      imageId: data.image?.id || '',
      imageName: req.body?.displayName,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-custom-image-create',
      instanceId: req.params.instanceId,
      imageName: req.body?.displayName,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function moveInstance(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await moveOciInstance(connector, {
      region: req.body?.region,
      instanceId: req.params.instanceId,
      targetCompartmentId: req.body?.targetCompartmentId,
    });
    await auditOci({
      action: 'oci-vm-move',
      connectorId: connector.id,
      instanceId: req.params.instanceId,
      region: req.body?.region,
      targetCompartmentId: req.body?.targetCompartmentId,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-vm-move',
      instanceId: req.params.instanceId,
      region: req.body?.region,
      targetCompartmentId: req.body?.targetCompartmentId,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

function volumeResourceType(req) {
  return String(req.params.volumeType || req.body?.resourceType || '').toLowerCase() === 'boot'
    || String(req.params.volumeType || req.body?.resourceType || '').toLowerCase() === 'bootvolume'
    ? 'bootVolume'
    : 'blockVolume';
}

export async function backupVolume(req, res) {
  const resourceType = volumeResourceType(req);
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciVolumeBackup(connector, {
      region: req.body?.region,
      resourceType,
      volumeId: req.params.volumeId,
      volumeName: req.body?.volumeName,
      displayName: req.body?.displayName,
      type: req.body?.type,
    });
    await auditOci({
      action: `oci-${resourceType}-backup`,
      connectorId: connector.id,
      volumeId: req.params.volumeId,
      region: req.body?.region,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-${resourceType}-backup`,
      volumeId: req.params.volumeId,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function listVolumeBackups(req, res) {
  const resourceType = volumeResourceType(req);
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciVolumeBackups(connector, {
      region: req.query?.region,
      resourceType,
      volumeId: req.params.volumeId || '',
      compartmentId: req.query?.compartmentId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function listVolumeGroupResources(req, res) {
  const resourceType = String(req.params.resourceType || '').trim();
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciVolumeGroupResources(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
      resourceType,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function listFileStorageResources(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciFileStorageResources(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function listObjectStorageResources(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciObjectStorageResources(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function listDatabaseResources(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciDatabaseResources(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function listDbVersions(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciDbVersions(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
      dbSystemShape: req.query?.dbSystemShape,
      storageManagement: req.query?.storageManagement,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function generateSshKeyPair(req, res) {
  try {
    const data = generateOciSshKeyPair({ comment: req.body?.comment });
    await auditOci({
      action: 'oci-ssh-keypair-generate',
      status: 'completed',
      message: 'SSH key pair generated for DB System form.',
    }, req);
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function createAutonomousDatabase(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciAutonomousDatabase(connector, req.body || {});
    await updateCachedOciResource(connector.id, 'autonomousDatabase', data.database);
    await auditOci({
      action: 'oci-autonomous-database-create',
      connectorId: connector.id,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      databaseId: data.database?.id,
      databaseName: data.database?.name || req.body?.displayName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-autonomous-database-create',
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      databaseName: req.body?.displayName,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function createDbSystem(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciDbSystem(connector, req.body || {});
    await updateCachedOciResource(connector.id, 'dbSystem', data.database);
    await auditOci({
      action: req.body?.sourceDbSystemId ? 'oci-db-system-clone' : 'oci-db-system-create',
      connectorId: connector.id,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      databaseId: data.database?.id,
      databaseName: data.database?.name || req.body?.displayName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: req.body?.sourceDbSystemId ? 'oci-db-system-clone' : 'oci-db-system-create',
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      databaseName: req.body?.displayName,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function listDbSystemNodes(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await listOciDbSystemNodes(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
      dbSystemId: req.params.dbSystemId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function runDbNodeAction(req, res) {
  const action = String(req.params.action || '').trim().toLowerCase();
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await runOciDbNodeAction(connector, {
      region: req.body?.region,
      dbNodeId: req.params.dbNodeId,
      action,
    });
    await auditOci({
      action: `oci-db-node-${action}`,
      connectorId: connector.id,
      region: req.body?.region,
      databaseId: req.body?.dbSystemId,
      nodeId: req.params.dbNodeId,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-db-node-${action}`,
      region: req.body?.region,
      databaseId: req.body?.dbSystemId,
      nodeId: req.params.dbNodeId,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function updateDbSystem(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await updateOciDbSystem(connector, {
      ...(req.body || {}),
      dbSystemId: req.params.dbSystemId,
    });
    await updateCachedOciResource(connector.id, 'dbSystem', data.database);
    await auditOci({
      action: req.body?.sshPublicKeys !== undefined ? 'oci-db-system-ssh-keys-update' : 'oci-db-system-storage-scale',
      connectorId: connector.id,
      region: req.body?.region,
      databaseId: req.params.dbSystemId,
      databaseName: data.database?.name || req.body?.databaseName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: req.body?.sshPublicKeys !== undefined ? 'oci-db-system-ssh-keys-update' : 'oci-db-system-storage-scale',
      region: req.body?.region,
      databaseId: req.params.dbSystemId,
      databaseName: req.body?.databaseName,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function deleteDatabaseResource(req, res) {
  const resourceType = String(req.body?.resourceType || req.query?.resourceType || '').trim() === 'dbSystem'
    ? 'dbSystem'
    : 'autonomousDatabase';
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciDatabaseResource(connector, {
      region: req.body?.region,
      databaseId: req.params.databaseId,
      databaseName: req.body?.databaseName,
      resourceType,
      confirmation: req.body?.confirmation,
    });
    await deleteCachedOciResource(connector.id, resourceType, data.database);
    await auditOci({
      action: resourceType === 'dbSystem' ? 'oci-db-system-delete' : 'oci-autonomous-database-delete',
      connectorId: connector.id,
      region: req.body?.region,
      databaseId: req.params.databaseId,
      databaseName: data.database?.name || req.body?.databaseName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: resourceType === 'dbSystem' ? 'oci-db-system-delete' : 'oci-autonomous-database-delete',
      region: req.body?.region,
      databaseId: req.params.databaseId,
      databaseName: req.body?.databaseName,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function runAutonomousDatabaseAction(req, res) {
  const action = String(req.params.action || '').trim().toLowerCase();
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await runOciAutonomousDatabaseAction(connector, {
      region: req.body?.region,
      databaseId: req.params.databaseId,
      action,
      restoreTimestamp: req.body?.restoreTimestamp,
      peerDbId: req.body?.peerDbId,
    });
    await updateCachedOciResource(connector.id, 'autonomousDatabase', data.database);
    await auditOci({
      action: `oci-autonomous-database-${action}`,
      connectorId: connector.id,
      region: req.body?.region,
      databaseId: req.params.databaseId,
      databaseName: req.body?.databaseName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-autonomous-database-${action}`,
      region: req.body?.region,
      databaseId: req.params.databaseId,
      databaseName: req.body?.databaseName,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function cloneAutonomousDatabase(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await cloneOciAutonomousDatabase(connector, {
      ...(req.body || {}),
      sourceDatabaseId: req.params.databaseId,
    });
    await updateCachedOciResource(connector.id, 'autonomousDatabase', data.database);
    await auditOci({
      action: 'oci-autonomous-database-clone',
      connectorId: connector.id,
      region: req.body?.region,
      sourceDatabaseId: req.params.databaseId,
      databaseId: data.database?.id,
      databaseName: data.database?.name || req.body?.displayName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-autonomous-database-clone',
      region: req.body?.region,
      sourceDatabaseId: req.params.databaseId,
      databaseName: req.body?.displayName,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function listNetworkResources(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciNetworkResources(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function listDnsResources(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciDnsResources(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function listDnsZoneRecords(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await getOciDnsZoneRecords(connector, {
      region: req.query?.region,
      compartmentId: req.query?.compartmentId,
      zoneId: req.params.zoneId,
      zoneName: req.query?.zoneName,
      scope: req.query?.scope,
      viewId: req.query?.viewId,
    });
    res.json({ data });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function createDnsView(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciDnsView(connector, req.body || {});
    await auditOci({ action: 'oci-dns-view-create', connectorId: connector.id, region: req.body?.region, viewId: data.view?.id, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-dns-view-create', region: req.body?.region, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createDnsZone(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciDnsZone(connector, req.body || {});
    await auditOci({ action: 'oci-dns-zone-create', connectorId: connector.id, region: req.body?.region, zoneId: data.zone?.id, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-dns-zone-create', region: req.body?.region, zoneName: req.body?.name, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function deleteDnsZone(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciDnsZone(connector, {
      region: req.body?.region,
      zoneId: req.params.zoneId,
      zoneName: req.body?.zoneName,
      scope: req.body?.scope,
      viewId: req.body?.viewId,
      confirmation: req.body?.confirmation,
    });
    await auditOci({ action: 'oci-dns-zone-delete', connectorId: connector.id, region: req.body?.region, zoneId: req.params.zoneId, status: 'submitted', message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-dns-zone-delete', region: req.body?.region, zoneId: req.params.zoneId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function upsertDnsRecord(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await upsertOciDnsRecord(connector, {
      ...(req.body || {}),
      zoneId: req.params.zoneId,
    });
    await auditOci({ action: 'oci-dns-record-upsert', connectorId: connector.id, region: req.body?.region, zoneId: req.params.zoneId, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-dns-record-upsert', region: req.body?.region, zoneId: req.params.zoneId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function deleteDnsRecord(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciDnsRecord(connector, {
      region: req.body?.region,
      zoneId: req.params.zoneId,
      zoneName: req.body?.zoneName,
      scope: req.body?.scope,
      viewId: req.body?.viewId,
      domain: req.body?.domain,
      rtype: req.body?.rtype,
      confirmation: req.body?.confirmation,
    });
    await auditOci({ action: 'oci-dns-record-delete', connectorId: connector.id, region: req.body?.region, zoneId: req.params.zoneId, status: 'submitted', message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-dns-record-delete', region: req.body?.region, zoneId: req.params.zoneId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createVcn(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciVcn(connector, req.body || {});
    await updateCachedOciResource(connector.id, 'vcn', data.vcn);
    await auditOci({ action: 'oci-vcn-create', connectorId: connector.id, region: req.body?.region, vcnId: data.vcn?.id, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-vcn-create', region: req.body?.region, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function deleteVcn(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciVcn(connector, {
      region: req.body?.region,
      vcnId: req.params.vcnId,
      vcnName: req.body?.vcnName,
      confirmation: req.body?.confirmation,
    });
    await deleteCachedOciResource(connector.id, 'vcn', data.vcn);
    await auditOci({ action: 'oci-vcn-delete', connectorId: connector.id, region: req.body?.region, vcnId: req.params.vcnId, status: 'submitted', message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-vcn-delete', region: req.body?.region, vcnId: req.params.vcnId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createSubnet(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciSubnet(connector, req.body || {});
    await updateCachedOciResource(connector.id, 'subnet', data.subnet);
    await auditOci({ action: 'oci-subnet-create', connectorId: connector.id, region: req.body?.region, subnetId: data.subnet?.id, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-subnet-create', region: req.body?.region, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function deleteSubnet(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciSubnet(connector, {
      region: req.body?.region,
      subnetId: req.params.subnetId,
      subnetName: req.body?.subnetName,
      confirmation: req.body?.confirmation,
    });
    await deleteCachedOciResource(connector.id, 'subnet', data.subnet);
    await auditOci({ action: 'oci-subnet-delete', connectorId: connector.id, region: req.body?.region, subnetId: req.params.subnetId, status: 'submitted', message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-subnet-delete', region: req.body?.region, subnetId: req.params.subnetId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createGateway(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciGateway(connector, req.body || {});
    await auditOci({ action: 'oci-gateway-create', connectorId: connector.id, region: req.body?.region, gatewayId: data.gateway?.id, gatewayType: req.body?.gatewayType, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-gateway-create', region: req.body?.region, gatewayType: req.body?.gatewayType, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createDrg(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciDrg(connector, req.body || {});
    await auditOci({ action: 'oci-drg-create', connectorId: connector.id, region: req.body?.region, drgId: data.drg?.id, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-drg-create', region: req.body?.region, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function deleteDrg(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciDrg(connector, {
      region: req.body?.region,
      drgId: req.params.drgId,
      drgName: req.body?.drgName,
      confirmation: req.body?.confirmation,
    });
    await auditOci({ action: 'oci-drg-delete', connectorId: connector.id, region: req.body?.region, drgId: req.params.drgId, status: 'submitted', message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-drg-delete', region: req.body?.region, drgId: req.params.drgId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createDrgAttachment(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciDrgAttachment(connector, req.body || {});
    await auditOci({ action: 'oci-drg-attachment-create', connectorId: connector.id, region: req.body?.region, attachmentId: data.attachment?.id, drgId: req.body?.drgId, vcnId: req.body?.vcnId, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-drg-attachment-create', region: req.body?.region, drgId: req.body?.drgId, vcnId: req.body?.vcnId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function deleteDrgAttachment(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciDrgAttachment(connector, {
      region: req.body?.region,
      attachmentId: req.params.attachmentId,
      attachmentName: req.body?.attachmentName,
      confirmation: req.body?.confirmation,
    });
    await auditOci({ action: 'oci-drg-attachment-delete', connectorId: connector.id, region: req.body?.region, attachmentId: req.params.attachmentId, status: 'submitted', message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-drg-attachment-delete', region: req.body?.region, attachmentId: req.params.attachmentId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createRemotePeeringConnection(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciRemotePeeringConnection(connector, req.body || {});
    await auditOci({ action: 'oci-rpc-create', connectorId: connector.id, region: req.body?.region, connectionId: data.connection?.id, drgId: req.body?.drgId, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-rpc-create', region: req.body?.region, drgId: req.body?.drgId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function connectRemotePeeringConnection(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await connectOciRemotePeeringConnection(connector, {
      region: req.body?.region,
      connectionId: req.params.connectionId,
      peerId: req.body?.peerId,
      peerRegionName: req.body?.peerRegionName,
    });
    await auditOci({ action: 'oci-rpc-connect', connectorId: connector.id, region: req.body?.region, connectionId: req.params.connectionId, peerRegionName: req.body?.peerRegionName, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-rpc-connect', region: req.body?.region, connectionId: req.params.connectionId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function deleteRemotePeeringConnection(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciRemotePeeringConnection(connector, {
      region: req.body?.region,
      connectionId: req.params.connectionId,
      connectionName: req.body?.connectionName,
      confirmation: req.body?.confirmation,
    });
    await auditOci({ action: 'oci-rpc-delete', connectorId: connector.id, region: req.body?.region, connectionId: req.params.connectionId, status: 'submitted', message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-rpc-delete', region: req.body?.region, connectionId: req.params.connectionId, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createRouteTable(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciRouteTable(connector, req.body || {});
    await auditOci({ action: 'oci-route-table-create', connectorId: connector.id, region: req.body?.region, routeTableId: data.routeTable?.id, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-route-table-create', region: req.body?.region, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createSecurityList(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciSecurityList(connector, req.body || {});
    await auditOci({ action: 'oci-security-list-create', connectorId: connector.id, region: req.body?.region, securityListId: data.securityList?.id, status: 'submitted', message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({ action: 'oci-security-list-create', region: req.body?.region, status: 'failed', message: error.message }, req);
    handleError(error, req, res);
  }
}

export async function createBucket(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciBucket(connector, req.body || {});
    await updateCachedOciResource(connector.id, 'bucket', data.bucket);
    await auditOci({
      action: 'oci-bucket-create',
      connectorId: connector.id,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      bucketName: data.bucket?.name || req.body?.name,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-bucket-create',
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      bucketName: req.body?.name,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function deleteBucket(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciBucket(connector, {
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      bucketName: req.params.bucketName,
      namespace: req.body?.namespace,
      confirmation: req.body?.confirmation,
    });
    await deleteCachedOciResource(connector.id, 'bucket', data.bucket);
    await auditOci({
      action: 'oci-bucket-delete',
      connectorId: connector.id,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      bucketName: req.params.bucketName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-bucket-delete',
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      bucketName: req.params.bucketName,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function createFileSystem(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciFileSystem(connector, req.body || {});
    await auditOci({
      action: 'oci-file-system-create',
      connectorId: connector.id,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      fileSystemId: data.fileSystem?.id,
      fileSystemName: data.fileSystem?.name || req.body?.displayName,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-file-system-create',
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function createMountTarget(req, res) {
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await createOciMountTarget(connector, req.body || {});
    await auditOci({
      action: 'oci-mount-target-create',
      connectorId: connector.id,
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      mountTargetId: data.mountTarget?.id,
      mountTargetName: data.mountTarget?.name || req.body?.displayName,
      subnetId: req.body?.subnetId,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: 'oci-mount-target-create',
      region: req.body?.region,
      compartmentId: req.body?.compartmentId,
      subnetId: req.body?.subnetId,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function cloneVolume(req, res) {
  const resourceType = volumeResourceType(req);
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await cloneOciVolume(connector, {
      region: req.body?.region,
      resourceType,
      volumeId: req.params.volumeId,
      displayName: req.body?.displayName,
      compartmentId: req.body?.compartmentId,
      availabilityDomain: req.body?.availabilityDomain,
      sizeGb: req.body?.sizeGb,
    });
    await updateCachedOciResource(connector.id, resourceType, data.volume);
    await auditOci({
      action: `oci-${resourceType}-clone`,
      connectorId: connector.id,
      volumeId: req.params.volumeId,
      newVolumeId: data.volume?.id,
      region: req.body?.region,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-${resourceType}-clone`,
      volumeId: req.params.volumeId,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function restoreVolume(req, res) {
  const resourceType = volumeResourceType(req);
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await restoreOciVolume(connector, {
      region: req.body?.region,
      resourceType,
      backupId: req.body?.backupId,
      displayName: req.body?.displayName,
      compartmentId: req.body?.compartmentId,
      availabilityDomain: req.body?.availabilityDomain,
      sizeGb: req.body?.sizeGb,
    });
    await updateCachedOciResource(connector.id, resourceType, data.volume);
    await auditOci({
      action: `oci-${resourceType}-restore`,
      connectorId: connector.id,
      backupId: req.body?.backupId,
      newVolumeId: data.volume?.id,
      region: req.body?.region,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-${resourceType}-restore`,
      backupId: req.body?.backupId,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function resizeVolume(req, res) {
  const resourceType = volumeResourceType(req);
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await resizeOciVolume(connector, {
      region: req.body?.region,
      resourceType,
      volumeId: req.params.volumeId,
      volumeName: req.body?.volumeName,
      compartmentId: req.body?.compartmentId,
      availabilityDomain: req.body?.availabilityDomain,
      sizeGb: req.body?.sizeGb,
      currentSizeGb: req.body?.currentSizeGb,
    });
    await updateCachedOciResource(connector.id, resourceType, data.volume);
    await auditOci({
      action: `oci-${resourceType}-resize`,
      connectorId: connector.id,
      volumeId: req.params.volumeId,
      newSizeGb: req.body?.sizeGb,
      region: req.body?.region,
      status: 'submitted',
      message: data.message,
    }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-${resourceType}-resize`,
      volumeId: req.params.volumeId,
      newSizeGb: req.body?.sizeGb,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}

export async function deleteVolumeBackup(req, res) {
  const resourceType = volumeResourceType(req);
  try {
    const connector = await getSelectedOciConnectorForUse();
    const data = await deleteOciVolumeBackup(connector, {
      region: req.body?.region,
      resourceType,
      backupId: req.params.backupId,
      backupName: req.body?.backupName,
      sourceVolumeId: req.body?.sourceVolumeId,
      confirmation: req.body?.confirmation,
    });
    await auditOci({
      action: `oci-${resourceType}-backup-delete`,
      connectorId: connector.id,
      backupId: req.params.backupId,
      backupName: req.body?.backupName,
      sourceVolumeId: req.body?.sourceVolumeId,
      region: req.body?.region,
      status: 'submitted',
      message: data.message,
    }, req);
    res.json({ data });
  } catch (error) {
    await auditOci({
      action: `oci-${resourceType}-backup-delete`,
      backupId: req.params.backupId,
      sourceVolumeId: req.body?.sourceVolumeId,
      region: req.body?.region,
      status: 'failed',
      message: error.message,
    }, req);
    handleError(error, req, res);
  }
}
