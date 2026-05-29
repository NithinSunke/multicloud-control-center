import { afterEach, describe, expect, it } from 'vitest';
import { getCachedOciInventoryEntry, getCachedOciInventoryFromResources, getCachedOciResourceRowsForTest, getCombinedCachedOciAllResources, setCachedOciInventoryEntry, updateCachedOciInstance } from './ociInventoryCache.js';

afterEach(() => {
  delete process.env.OCI_INVENTORY_STORE;
});

describe('OCI inventory cache', () => {
  it('inserts a newly created instance into cached snapshots and resource rows', async () => {
    process.env.OCI_INVENTORY_STORE = 'memory';
    const scope = {
      connectorId: 'oci-1',
      region: 'me-jeddah-1',
      compartmentId: 'ocid1.tenancy.oc1..root',
      resourceType: 'allResources',
    };

    await setCachedOciInventoryEntry(scope, {
      generatedAt: '2026-05-21T00:00:00.000Z',
      connector: { id: 'oci-1', name: 'OCI', region: 'me-jeddah-1', tenancyOcid: scope.compartmentId },
      summary: { instances: 0, runningInstances: 0, stoppedInstances: 0 },
      regions: [{ name: 'me-jeddah-1', key: 'JED', status: 'READY', home: true }],
      compartments: [{ id: 'ocid1.compartment.oc1..compute', name: 'Compute', status: 'ACTIVE' }],
      instances: [],
      blockVolumes: [],
      bootVolumes: [],
      vcns: [],
      subnets: [],
      buckets: [],
      errors: [],
      scan: { requestedRegion: 'me-jeddah-1', scannedRegions: ['me-jeddah-1'], compartmentScopeId: scope.compartmentId },
    });

    await updateCachedOciInstance('oci-1', {
      id: 'ocid1.instance.oc1.me-jeddah-1..new',
      name: 'created-vm',
      region: 'me-jeddah-1',
      compartmentId: 'ocid1.compartment.oc1..compute',
      status: 'PROVISIONING',
      shape: 'VM.Standard.E5.Flex',
      availabilityDomain: 'kWcK:ME-JEDDAH-1-AD-1',
      ocpus: 2,
      memoryGb: 8,
      storageSizeGb: 60,
    });

    const cached = await getCachedOciInventoryEntry(scope);
    expect(cached.instances).toHaveLength(1);
    expect(cached.instances[0]).toMatchObject({
      id: 'ocid1.instance.oc1.me-jeddah-1..new',
      name: 'created-vm',
      compartmentName: 'Compute',
      status: 'PROVISIONING',
    });
    expect(cached.summary).toMatchObject({ instances: 1, runningInstances: 0, stoppedInstances: 0 });

    const row = (await getCachedOciResourceRowsForTest('oci-1', 'instance'))[0];

    expect(row).toMatchObject({
      name: 'created-vm',
      status: 'PROVISIONING',
      region: 'me-jeddah-1',
      compartment_id: 'ocid1.compartment.oc1..compute',
      shape: 'VM.Standard.E5.Flex',
      memory_gb: '8',
      ocpus: '2',
    });
  });

  it('combines cached regional all-resource scans for the all regions view', async () => {
    process.env.OCI_INVENTORY_STORE = 'memory';
    const connector = {
      id: 'oci-combined',
      name: 'OCI',
      region: 'eu-frankfurt-1',
      tenancyOcid: 'ocid1.tenancy.oc1..root',
      compartmentOcid: 'ocid1.tenancy.oc1..root',
    };

    await setCachedOciInventoryEntry({
      connectorId: connector.id,
      region: 'me-riyadh-1',
      compartmentId: connector.compartmentOcid,
      resourceType: 'allResources',
    }, {
      generatedAt: '2026-05-21T00:00:00.000Z',
      connector,
      summary: { regions: 1, compartments: 1, instances: 1, runningInstances: 1, stoppedInstances: 0, blockVolumes: 1, bootVolumes: 0, vcns: 1, subnets: 0, buckets: 0, dbSystems: 1, autonomousDatabases: 0, autonomousContainerDatabases: 0, exadataInfrastructures: 0 },
      regions: [{ name: 'me-riyadh-1', key: 'RUH', status: 'READY', home: false }],
      compartments: [{ id: 'compartment-a', name: 'Compute', status: 'ACTIVE' }],
      instances: [{ id: 'instance-1', name: 'vm-1', region: 'me-riyadh-1', compartmentId: 'compartment-a', status: 'RUNNING' }],
      blockVolumes: [{ id: 'volume-1', name: 'data-1', region: 'me-riyadh-1', compartmentId: 'compartment-a', status: 'AVAILABLE' }],
      bootVolumes: [],
      vcns: [{ id: 'vcn-1', name: 'vcn-1', region: 'me-riyadh-1', compartmentId: 'compartment-a', status: 'AVAILABLE' }],
      subnets: [],
      buckets: [],
      dbSystems: [{ id: 'db-system-1', name: 'orders-db-system', region: 'me-riyadh-1', compartmentId: 'compartment-a', status: 'AVAILABLE' }],
      autonomousDatabases: [],
      autonomousContainerDatabases: [],
      exadataInfrastructures: [],
      errors: [],
      scan: { requestedRegion: 'me-riyadh-1', scannedRegions: ['me-riyadh-1'], compartmentScopeId: connector.compartmentOcid, scannedCompartments: 1, scannedResourceCompartments: 1, totalResourceCompartments: 1, partial: false },
    });

    await setCachedOciInventoryEntry({
      connectorId: connector.id,
      region: 'us-sanjose-1',
      compartmentId: connector.compartmentOcid,
      resourceType: 'allResources',
    }, {
      generatedAt: '2026-05-21T01:00:00.000Z',
      connector,
      summary: { regions: 1, compartments: 1, instances: 0, runningInstances: 0, stoppedInstances: 0, blockVolumes: 0, bootVolumes: 1, vcns: 0, subnets: 1, buckets: 1, dbSystems: 0, autonomousDatabases: 1, autonomousContainerDatabases: 0, exadataInfrastructures: 1 },
      regions: [{ name: 'us-sanjose-1', key: 'SJC', status: 'READY', home: false }],
      compartments: [{ id: 'compartment-b', name: 'Network', status: 'ACTIVE' }],
      instances: [],
      blockVolumes: [],
      bootVolumes: [{ id: 'boot-1', name: 'boot-1', region: 'us-sanjose-1', compartmentId: 'compartment-b', status: 'AVAILABLE' }],
      vcns: [],
      subnets: [{ id: 'subnet-1', name: 'subnet-1', region: 'us-sanjose-1', compartmentId: 'compartment-b', status: 'AVAILABLE' }],
      buckets: [{ id: 'bucket-1', name: 'bucket-1', region: 'us-sanjose-1', compartmentId: 'compartment-b', status: 'AVAILABLE' }],
      dbSystems: [],
      autonomousDatabases: [{ id: 'adb-1', name: 'analytics-adb', region: 'us-sanjose-1', compartmentId: 'compartment-b', status: 'AVAILABLE' }],
      autonomousContainerDatabases: [],
      exadataInfrastructures: [{ id: 'exadata-1', name: 'finance-exadata', region: 'us-sanjose-1', compartmentId: 'compartment-b', status: 'AVAILABLE' }],
      errors: [{ scope: 'instances', region: 'us-sanjose-1', message: 'OCI returned HTTP 404: Authorization failed or requested resource not found.' }],
      scan: { requestedRegion: 'us-sanjose-1', scannedRegions: ['us-sanjose-1'], compartmentScopeId: connector.compartmentOcid, scannedCompartments: 1, scannedResourceCompartments: 1, totalResourceCompartments: 1, partial: true },
    });

    const combined = await getCombinedCachedOciAllResources(connector);

    expect(combined.summary).toMatchObject({
      regions: 2,
      compartments: 2,
      instances: 1,
      runningInstances: 1,
      blockVolumes: 1,
      bootVolumes: 1,
      vcns: 1,
      subnets: 1,
      buckets: 1,
      dbSystems: 1,
      autonomousDatabases: 1,
      exadataInfrastructures: 1,
    });
    expect(combined.scan.scannedRegions).toEqual(['me-riyadh-1', 'us-sanjose-1']);
    expect(combined.instances.map((item) => item.name)).toEqual(['vm-1']);
    expect(combined.dbSystems.map((item) => item.name)).toEqual(['orders-db-system']);
    expect(combined.autonomousDatabases.map((item) => item.name)).toEqual(['analytics-adb']);
    expect(combined.exadataInfrastructures.map((item) => item.name)).toEqual(['finance-exadata']);
    expect(combined.errors).toHaveLength(1);
  });

  it('does not replace a useful cache with an empty failed scan', async () => {
    process.env.OCI_INVENTORY_STORE = 'memory';
    const scope = {
      connectorId: 'oci-protect',
      region: 'us-sanjose-1',
      compartmentId: 'ocid1.tenancy.oc1..root',
      resourceType: 'allResources',
    };

    await setCachedOciInventoryEntry(scope, {
      generatedAt: '2026-05-21T00:00:00.000Z',
      connector: { id: 'oci-protect', name: 'OCI', region: 'eu-frankfurt-1', tenancyOcid: scope.compartmentId },
      summary: { regions: 1, compartments: 1, instances: 1, runningInstances: 1, stoppedInstances: 0, blockVolumes: 0, bootVolumes: 0, vcns: 0, subnets: 0, buckets: 0 },
      regions: [{ name: 'us-sanjose-1', key: 'SJC', status: 'READY', home: false }],
      compartments: [{ id: 'compartment-a', name: 'Compute', status: 'ACTIVE' }],
      instances: [{ id: 'instance-1', name: 'vm-1', region: 'us-sanjose-1', compartmentId: 'compartment-a', status: 'RUNNING' }],
      blockVolumes: [],
      bootVolumes: [],
      vcns: [],
      subnets: [],
      buckets: [],
      errors: [],
      scan: { requestedRegion: 'us-sanjose-1', scannedRegions: ['us-sanjose-1'], compartmentScopeId: scope.compartmentId },
    });

    const protectedCache = await setCachedOciInventoryEntry(scope, {
      generatedAt: '2026-05-21T01:00:00.000Z',
      connector: { id: 'oci-protect', name: 'OCI', region: 'eu-frankfurt-1', tenancyOcid: scope.compartmentId },
      summary: { regions: 1, compartments: 1, instances: 0, runningInstances: 0, stoppedInstances: 0, blockVolumes: 0, bootVolumes: 0, vcns: 0, subnets: 0, buckets: 0 },
      regions: [{ name: 'us-sanjose-1', key: 'SJC', status: 'READY', home: false }],
      compartments: [{ id: 'compartment-a', name: 'Compute', status: 'ACTIVE' }],
      instances: [],
      blockVolumes: [],
      bootVolumes: [],
      vcns: [],
      subnets: [],
      buckets: [],
      errors: [{ scope: 'instances', region: 'us-sanjose-1', message: 'OCI returned HTTP 404: Authorization failed or requested resource not found.' }],
      scan: { requestedRegion: 'us-sanjose-1', scannedRegions: ['us-sanjose-1'], compartmentScopeId: scope.compartmentId, partial: true },
    });

    expect(protectedCache.instances).toHaveLength(1);
    expect(protectedCache.scan.phase).toBe('Kept previous cache after failed scan');

    const cached = await getCachedOciInventoryEntry(scope);
    expect(cached.instances).toHaveLength(1);

    const rowCache = await getCachedOciInventoryFromResources({
      id: 'oci-protect',
      name: 'OCI',
      region: 'eu-frankfurt-1',
      tenancyOcid: scope.compartmentId,
      compartmentOcid: scope.compartmentId,
    }, 'us-sanjose-1');
    expect(rowCache.instances).toHaveLength(1);
  });
});
