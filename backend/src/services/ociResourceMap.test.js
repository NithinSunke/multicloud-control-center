import { afterEach, describe, expect, it } from 'vitest';
import { setCachedOciInventoryEntry } from './ociInventoryCache.js';
import { getOciResourceMap } from './ociResourceMap.js';

afterEach(() => {
  delete process.env.OCI_INVENTORY_STORE;
});

describe('OCI resource map', () => {
  it('builds VM, network, gateway, and database relationships from cached inventory', async () => {
    process.env.OCI_INVENTORY_STORE = 'memory';
    const connector = {
      id: 'oci-map',
      name: 'OCI',
      region: 'me-jeddah-1',
      tenancyOcid: 'tenancy-root',
      compartmentOcid: 'tenancy-root',
    };

    await setCachedOciInventoryEntry({
      connectorId: connector.id,
      region: 'me-jeddah-1',
      compartmentId: connector.compartmentOcid,
      resourceType: 'allResources',
    }, {
      generatedAt: '2026-05-26T00:00:00.000Z',
      connector,
      summary: {},
      regions: [{ name: 'me-jeddah-1', key: 'JED', status: 'READY', home: true }],
      compartments: [{ id: 'apps', name: 'Apps', status: 'ACTIVE' }],
      instances: [{
        id: 'instance-1',
        name: 'app-server',
        region: 'me-jeddah-1',
        compartmentId: 'apps',
        compartmentName: 'Apps',
        status: 'RUNNING',
        availabilityDomain: 'AD-1',
        privateIp: '10.0.1.10',
      }],
      bootVolumes: [{
        id: 'boot-1',
        name: 'app-server-boot',
        region: 'me-jeddah-1',
        compartmentId: 'apps',
        compartmentName: 'Apps',
        availabilityDomain: 'AD-1',
        status: 'AVAILABLE',
      }],
      blockVolumes: [{
        id: 'volume-1',
        name: 'app-data',
        region: 'me-jeddah-1',
        compartmentId: 'apps',
        compartmentName: 'Apps',
        availabilityDomain: 'AD-1',
        status: 'AVAILABLE',
      }],
      vcns: [{ id: 'vcn-1', name: 'prod-vcn', region: 'me-jeddah-1', compartmentId: 'apps', compartmentName: 'Apps', status: 'AVAILABLE' }],
      subnets: [{
        id: 'subnet-1',
        name: 'private-subnet',
        region: 'me-jeddah-1',
        compartmentId: 'apps',
        compartmentName: 'Apps',
        status: 'AVAILABLE',
        cidrBlock: '10.0.1.0/24',
        vcnId: 'vcn-1',
        routeTableId: 'route-1',
      }],
      routeTables: [{
        id: 'route-1',
        name: 'private-routes',
        region: 'me-jeddah-1',
        compartmentId: 'apps',
        compartmentName: 'Apps',
        vcnId: 'vcn-1',
        routeRules: [{ networkEntityId: 'nat-1' }],
      }],
      natGateways: [{ id: 'nat-1', name: 'nat-gateway', region: 'me-jeddah-1', compartmentId: 'apps', compartmentName: 'Apps', vcnId: 'vcn-1' }],
      internetGateways: [],
      serviceGateways: [],
      drgAttachments: [],
      securityLists: [],
      buckets: [],
      dbSystems: [{
        id: 'db-1',
        name: 'orders-db',
        region: 'me-jeddah-1',
        compartmentId: 'apps',
        compartmentName: 'Apps',
        status: 'AVAILABLE',
        subnetId: 'subnet-1',
      }],
      autonomousDatabases: [],
      autonomousContainerDatabases: [],
      exadataInfrastructures: [],
      errors: [],
      scan: { requestedRegion: 'me-jeddah-1', scannedRegions: ['me-jeddah-1'], compartmentScopeId: connector.compartmentOcid },
    });

    const map = await getOciResourceMap(connector, { region: 'me-jeddah-1' });

    expect(map.cached).toBe(true);
    expect(map.nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      'app-server',
      'app-server-boot',
      'app-data',
      'private-subnet',
      'prod-vcn',
      'private-routes',
      'nat-gateway',
      'orders-db',
    ]));
    expect(map.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'instance:instance-1', to: 'subnet:subnet-1', label: 'private IP in subnet', confidence: 'inferred' }),
      expect.objectContaining({ from: 'subnet:subnet-1', to: 'vcn:vcn-1', label: 'belongs to' }),
      expect.objectContaining({ from: 'subnet:subnet-1', to: 'routeTable:route-1', label: 'uses route table' }),
      expect.objectContaining({ from: 'routeTable:route-1', to: 'natGateway:nat-1', label: 'routes to' }),
      expect.objectContaining({ from: 'dbSystem:db-1', to: 'subnet:subnet-1', label: 'uses subnet' }),
    ]));
  });

  it('returns an empty map when no cached discovery exists', async () => {
    process.env.OCI_INVENTORY_STORE = 'memory';
    const map = await getOciResourceMap({
      id: 'missing-cache',
      name: 'OCI',
      region: 'me-jeddah-1',
      tenancyOcid: 'tenancy-root',
      compartmentOcid: 'tenancy-root',
    }, { region: 'me-jeddah-1' });

    expect(map.cached).toBe(false);
    expect(map.nodes).toEqual([]);
    expect(map.message).toMatch(/Run discovery first/i);
  });
});

