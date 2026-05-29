import { EventEmitter } from 'events';
import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { cloneOciAutonomousDatabase, connectOciRemotePeeringConnection, createOciAutonomousDatabase, createOciBucket, createOciDbSystem, createOciDnsView, createOciDnsZone, createOciDrg, createOciDrgAttachment, createOciFileSystem, createOciGateway, createOciInstance, createOciInstanceImage, createOciMountTarget, createOciRemotePeeringConnection, createOciRouteTable, createOciSecurityList, createOciSubnet, createOciVcn, deleteOciBucket, deleteOciCustomImage, deleteOciDatabaseResource, deleteOciDnsRecord, deleteOciDnsZone, deleteOciDrg, deleteOciDrgAttachment, deleteOciRemotePeeringConnection, deleteOciSubnet, deleteOciVcn, deleteOciVolumeBackup, getOciAvailabilityDomains, getOciCustomImage, getOciCustomImages, getOciDatabaseResources, getOciDnsResources, getOciDnsZoneRecords, getOciFileStorageResources, getOciInstances, getOciInventory, getOciLaunchOptions, getOciNetworkResources, getOciObjectStorageResources, getOciScopedResources, getOciVolumeBackups, getOciVolumeGroupResources, listOciDbSystemNodes, resizeOciVolume, restoreOciVolume, runOciAutonomousDatabaseAction, runOciDbNodeAction, updateOciDbSystem, updateOciInstance, upsertOciDnsRecord } from './ociApiClient.js';

function privateKey() {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return pair.privateKey;
}

function connector() {
  return {
    id: 'oci-1',
    provider: 'oci',
    name: 'OCI',
    tenancyOcid: 'ocid1.tenancy.oc1..root',
    userOcid: 'ocid1.user.oc1..user',
    compartmentOcid: 'ocid1.tenancy.oc1..root',
    region: 'eu-frankfurt-1',
    fingerprint: 'aa:bb',
    privateKey: privateKey(),
    privateKeyPassphrase: '',
    tlsVerify: true,
    status: 'verified',
  };
}

function responseFor(path, method = 'GET', bodyText = '') {
  if (path.includes('/regionSubscriptions')) {
    return [{ regionName: 'eu-frankfurt-1', regionKey: 'FRA', status: 'READY', isHomeRegion: true }];
  }
  if (path.includes('/compartments')) {
    return [{ id: 'ocid1.compartment.oc1..apps', name: 'apps', lifecycleState: 'ACTIVE', compartmentId: 'ocid1.tenancy.oc1..root' }];
  }
  if (path.includes('/availabilityDomains')) {
    return [{ name: 'FRA-AD-1' }];
  }
  if (path === '/n/') {
    return 'tenantnamespace';
  }
  if (path.includes('/instances')) {
    if (method === 'POST') {
      return {
        id: 'instance-new',
        displayName: 'new-vm',
        lifecycleState: 'PROVISIONING',
        compartmentId: 'ocid1.compartment.oc1..apps',
        availabilityDomain: 'FRA-AD-1',
        shape: 'VM.Standard.E5.Flex',
        shapeConfig: { ocpus: 2, memoryInGBs: 8 },
      };
    }
    if (method === 'PUT') {
      const body = JSON.parse(bodyText || '{}');
      return {
        id: 'instance-1',
        displayName: body.displayName,
        lifecycleState: 'RUNNING',
        compartmentId: 'ocid1.compartment.oc1..apps',
        availabilityDomain: 'FRA-AD-1',
        shape: body.shape,
        shapeConfig: body.shapeConfig,
        sourceDetails: { bootVolumeSizeInGBs: 50 },
      };
    }
    return [{
      id: 'instance-1',
      displayName: 'web-1',
      lifecycleState: 'RUNNING',
      shape: 'VM.Standard.E4.Flex',
      shapeConfig: { ocpus: 2, memoryInGBs: 16 },
      sourceDetails: { bootVolumeSizeInGBs: 50 },
    }];
  }
  if (path.includes('/images/custom-image-1')) {
    return {
      id: 'custom-image-1',
      displayName: 'web-1-image',
      lifecycleState: 'AVAILABLE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      operatingSystem: 'Oracle Linux',
      operatingSystemVersion: '9',
      sizeInMBs: 51200,
    };
  }
  if (path.includes('/images')) {
    if (method === 'POST') {
      return {
        id: 'custom-image-1',
        displayName: 'web-1-image',
        lifecycleState: 'CREATING',
        compartmentId: 'ocid1.compartment.oc1..apps',
      };
    }
    return [{
      id: 'custom-image-1',
      displayName: 'web-1-image',
      lifecycleState: 'CREATING',
      compartmentId: 'ocid1.compartment.oc1..apps',
      operatingSystem: 'Oracle Linux',
      operatingSystemVersion: '9',
      sizeInMBs: 51200,
    }, {
      id: 'platform-image-1',
      displayName: 'Oracle-Linux-10.1-2026.04.30-3',
      lifecycleState: 'AVAILABLE',
      imageType: 'PLATFORM',
      listingType: 'ORACLE',
      operatingSystem: 'Oracle Linux',
      operatingSystemVersion: '10',
      sizeInMBs: 47718,
    }, {
      id: 'other-compartment-image-1',
      displayName: 'other-compartment-image',
      lifecycleState: 'AVAILABLE',
      compartmentId: 'ocid1.compartment.oc1..other',
      imageType: 'CUSTOM',
    }];
  }
  if (path.includes('/vnicAttachments')) {
    return [{ id: 'attachment-1', vnicId: 'vnic-1' }];
  }
  if (path.includes('/vnics/')) {
    return { id: 'vnic-1', privateIp: '10.0.0.10', publicIp: '203.0.113.10' };
  }
  if (path.includes('/volumeBackups')) {
    if (method === 'DELETE') {
      return {};
    }
    return [{
      id: 'volume-backup-1',
      displayName: 'data-backup',
      lifecycleState: 'AVAILABLE',
      sizeInGBs: 100,
      type: 'FULL',
      volumeId: 'volume-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      timeCreated: '2026-05-20T10:00:00Z',
    }];
  }
  if (path.includes('/bootVolumeBackups')) {
    if (method === 'DELETE') {
      return {};
    }
    return [{
      id: 'boot-volume-backup-1',
      displayName: 'web-boot-backup',
      lifecycleState: 'AVAILABLE',
      sizeInGBs: 50,
      type: 'INCREMENTAL',
      bootVolumeId: 'boot-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      timeCreated: '2026-05-20T11:00:00Z',
    }];
  }
  if (path.includes('/volumeGroupReplicas')) {
    return [{
      id: 'volume-group-replica-1',
      displayName: 'prod-volume-group-replica',
      lifecycleState: 'AVAILABLE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      volumeGroupId: 'volume-group-1',
      availabilityDomain: 'FRA-AD-1',
      destinationRegion: 'me-jeddah-1',
      timeCreated: '2026-05-22T12:00:00Z',
    }];
  }
  if (path.includes('/volumeGroupBackups')) {
    return [{
      id: 'volume-group-backup-1',
      displayName: 'prod-volume-group-backup',
      lifecycleState: 'AVAILABLE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      volumeGroupId: 'volume-group-1',
      sizeInGBs: 150,
      type: 'FULL',
      timeCreated: '2026-05-22T11:00:00Z',
    }];
  }
  if (path.includes('/volumeGroups')) {
    return [{
      id: 'volume-group-1',
      displayName: 'prod-volume-group',
      lifecycleState: 'AVAILABLE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      volumeIds: ['volume-1', 'boot-1'],
      timeCreated: '2026-05-22T10:00:00Z',
    }];
  }
  if (path.includes('/fileSystems')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return {
        id: 'file-system-created-1',
        displayName: body.displayName,
        lifecycleState: 'CREATING',
        compartmentId: body.compartmentId,
        availabilityDomain: body.availabilityDomain,
        timeCreated: '2026-05-23T12:00:00Z',
      };
    }
    return [{
      id: 'file-system-1',
      displayName: 'shared-apps-fs',
      lifecycleState: 'ACTIVE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      meteredBytes: 10737418240,
      timeCreated: '2026-05-23T10:00:00Z',
    }];
  }
  if (path.includes('/mountTargets')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return {
        id: 'mount-target-created-1',
        displayName: body.displayName,
        lifecycleState: 'CREATING',
        compartmentId: body.compartmentId,
        availabilityDomain: body.availabilityDomain,
        subnetId: body.subnetId,
        hostnameLabel: body.hostnameLabel,
        exportSetId: 'export-set-created-1',
        timeCreated: '2026-05-23T12:05:00Z',
      };
    }
    return [{
      id: 'mount-target-1',
      displayName: 'apps-mount-target',
      lifecycleState: 'ACTIVE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      subnetId: 'subnet-1',
      privateIpIds: ['private-ip-1'],
      exportSetId: 'export-set-1',
      timeCreated: '2026-05-23T10:05:00Z',
    }];
  }
  if (path.includes('/exports')) {
    return [{
      id: 'export-1',
      lifecycleState: 'ACTIVE',
      fileSystemId: 'file-system-1',
      exportSetId: 'export-set-1',
      path: '/shared-apps',
      exportOptions: [{ source: '10.0.0.0/16', access: 'READ_WRITE' }],
      timeCreated: '2026-05-23T10:10:00Z',
    }];
  }
  if (path.includes('/snapshots')) {
    return [{
      id: 'snapshot-1',
      name: 'shared-apps-snapshot',
      lifecycleState: 'ACTIVE',
      fileSystemId: 'file-system-1',
      timeCreated: '2026-05-23T11:00:00Z',
    }];
  }
  if (path.includes('/privateEndpoints')) {
    return [{
      id: 'object-private-endpoint-1',
      name: 'apps-object-pe',
      lifecycleState: 'ACTIVE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      subnetId: 'subnet-1',
      nsgIds: ['nsg-1'],
      accessTargets: [{ bucket: 'backups' }],
      timeCreated: '2026-05-24T10:00:00Z',
    }];
  }
  if (path.includes('/volumes')) {
    if (method === 'PUT') {
      const body = JSON.parse(bodyText || '{}');
      return {
        id: 'volume-1',
        displayName: 'data',
        lifecycleState: 'AVAILABLE',
        sizeInGBs: body.sizeInGBs,
        compartmentId: 'ocid1.compartment.oc1..apps',
        availabilityDomain: 'FRA-AD-1',
      };
    }
    if (method === 'POST') {
      return {
        id: 'volume-restored-1',
        displayName: 'data-restored',
        lifecycleState: 'PROVISIONING',
        sizeInGBs: 100,
        compartmentId: 'ocid1.compartment.oc1..apps',
        availabilityDomain: 'FRA-AD-1',
      };
    }
    return [{ id: 'volume-1', displayName: 'data', lifecycleState: 'AVAILABLE', sizeInGBs: 100 }];
  }
  if (path.includes('/bootVolumes')) {
    if (method === 'PUT') {
      const body = JSON.parse(bodyText || '{}');
      return {
        id: 'boot-1',
        displayName: 'web-boot',
        lifecycleState: 'AVAILABLE',
        sizeInGBs: body.sizeInGBs,
        compartmentId: 'ocid1.compartment.oc1..apps',
        availabilityDomain: 'FRA-AD-1',
      };
    }
    return [{ id: 'boot-1', displayName: 'web-boot', lifecycleState: 'AVAILABLE', sizeInGBs: 50 }];
  }
  if (path.includes('/vcns')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'vcn-created-1', displayName: body.displayName, lifecycleState: 'PROVISIONING', cidrBlock: body.cidrBlock, dnsLabel: body.dnsLabel, compartmentId: body.compartmentId };
    }
    if (method === 'DELETE') {
      return {};
    }
    return [{ id: 'vcn-1', displayName: 'prod-vcn', lifecycleState: 'AVAILABLE', cidrBlock: '10.0.0.0/16' }];
  }
  if (path.includes('/subnets')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'subnet-created-1', displayName: body.displayName, lifecycleState: 'PROVISIONING', cidrBlock: body.cidrBlock, vcnId: body.vcnId, compartmentId: body.compartmentId };
    }
    if (method === 'DELETE') {
      return {};
    }
    return [{ id: 'subnet-1', displayName: 'web-subnet', lifecycleState: 'AVAILABLE', cidrBlock: '10.0.1.0/24' }];
  }
  if (path.includes('/internetGateways')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'igw-created-1', displayName: body.displayName, lifecycleState: 'AVAILABLE', vcnId: body.vcnId, compartmentId: body.compartmentId };
    }
    return [{ id: 'igw-1', displayName: 'prod-igw', lifecycleState: 'AVAILABLE', vcnId: 'vcn-1' }];
  }
  if (path.includes('/natGateways')) {
    return [{ id: 'nat-1', displayName: 'prod-nat', lifecycleState: 'AVAILABLE', vcnId: 'vcn-1' }];
  }
  if (path.includes('/serviceGateways')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'sgw-created-1', displayName: body.displayName, lifecycleState: 'AVAILABLE', vcnId: body.vcnId, compartmentId: body.compartmentId, services: body.services };
    }
    return [{ id: 'sgw-1', displayName: 'prod-service', lifecycleState: 'AVAILABLE', vcnId: 'vcn-1' }];
  }
  if (path.includes('/drgs')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'drg-created-1', displayName: body.displayName, lifecycleState: 'AVAILABLE', compartmentId: body.compartmentId };
    }
    if (method === 'DELETE') {
      return {};
    }
    return [{ id: 'drg-1', displayName: 'prod-drg', lifecycleState: 'AVAILABLE', compartmentId: 'ocid1.compartment.oc1..apps' }];
  }
  if (path.includes('/drgAttachments')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'drg-attachment-created-1', displayName: body.displayName, lifecycleState: 'ATTACHED', compartmentId: body.compartmentId, drgId: body.drgId, networkDetails: body.networkDetails };
    }
    if (method === 'DELETE') {
      return {};
    }
    return [{ id: 'drg-attachment-1', displayName: 'prod-drg-attachment', lifecycleState: 'ATTACHED', vcnId: 'vcn-1', drgId: 'drg-1' }];
  }
  if (path.includes('/remotePeeringConnections')) {
    if (path.includes('/actions/connect')) {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'rpc-created-1', displayName: 'prod-rpc', lifecycleState: 'AVAILABLE', peeringStatus: 'PEERING', peerId: body.peerId, peerRegionName: body.peerRegionName };
    }
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'rpc-created-1', displayName: body.displayName, lifecycleState: 'AVAILABLE', compartmentId: body.compartmentId, drgId: body.drgId, peeringStatus: 'NEW' };
    }
    if (method === 'DELETE') {
      return {};
    }
    return [{ id: 'rpc-1', displayName: 'prod-rpc', lifecycleState: 'AVAILABLE', drgId: 'drg-1', peeringStatus: 'NEW' }];
  }
  if (path.includes('/services')) {
    return [{ id: 'service-all-1', name: 'All FRA Services in Oracle Services Network', cidrBlock: 'all-fra-services-in-oracle-services-network' }];
  }
  if (path.includes('/routeTables')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'rt-created-1', displayName: body.displayName, lifecycleState: 'AVAILABLE', vcnId: body.vcnId, compartmentId: body.compartmentId, routeRules: body.routeRules };
    }
    return [{ id: 'rt-1', displayName: 'prod-routes', lifecycleState: 'AVAILABLE', vcnId: 'vcn-1', routeRules: [{ destination: '0.0.0.0/0', networkEntityId: 'igw-1' }] }];
  }
  if (path.includes('/securityLists')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'sl-created-1', displayName: body.displayName, lifecycleState: 'AVAILABLE', vcnId: body.vcnId, compartmentId: body.compartmentId, ingressSecurityRules: body.ingressSecurityRules, egressSecurityRules: body.egressSecurityRules };
    }
    return [{ id: 'sl-1', displayName: 'prod-security', lifecycleState: 'AVAILABLE', vcnId: 'vcn-1', ingressSecurityRules: [{ protocol: '6', source: '0.0.0.0/0' }] }];
  }
  if (path.includes('/dbNodes')) {
    if (method === 'POST' && path.includes('?action=')) {
      const action = path.split('?action=')[1];
      return { id: 'db-node-1', hostname: 'ordersdb1', lifecycleState: `${action.toUpperCase()}ING`, dbSystemId: 'db-system-1' };
    }
    return [{ id: 'db-node-1', hostname: 'ordersdb1', lifecycleState: 'AVAILABLE', dbSystemId: 'db-system-1', privateIp: '10.0.0.11' }];
  }
  if (path.includes('/dbVersions')) {
    return [{ version: '19c', isLatestForMajorVersion: true }, { version: '23ai', isLatestForMajorVersion: true }];
  }
  if (path.includes('/dbSystems')) {
    if (method === 'DELETE') {
      return {};
    }
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'db-system-created-1', displayName: body.displayName, lifecycleState: 'PROVISIONING', compartmentId: body.compartmentId, availabilityDomain: body.availabilityDomain, shape: body.shape, dbVersion: body.dbHome?.dbVersion, cpuCoreCount: body.cpuCoreCount, dataStorageSizeInGBs: body.dataStorageSizeInGBs, licenseModel: body.licenseModel, subnetId: body.subnetId, nodeCount: body.nodeCount };
    }
    if (method === 'PATCH') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'db-system-1', displayName: 'orders-db-system', lifecycleState: 'UPDATING', dataStorageSizeInGBs: body.dataStorageSizeInGBs || 256 };
    }
    if (path.includes('/dbSystems/db-system-1')) {
      return { id: 'db-system-1', displayName: 'orders-db-system', lifecycleState: 'AVAILABLE', availabilityDomain: 'FRA-AD-1', shape: 'VM.Standard2.2', dbVersion: '19c', cpuCoreCount: 2, dataStorageSizeInGBs: 256 };
    }
    return [{ id: 'db-system-1', displayName: 'orders-db-system', lifecycleState: 'AVAILABLE', availabilityDomain: 'FRA-AD-1', shape: 'VM.Standard2.2', dbVersion: '19c', cpuCoreCount: 2, dataStorageSizeInGBs: 256 }];
  }
  if (path.includes('/autonomousDatabases')) {
    if (path.includes('/actions/')) {
      const action = path.split('/actions/')[1];
      return { id: 'adb-1', displayName: 'analytics-adb', lifecycleState: `${action.toUpperCase()}_REQUESTED`, dbName: 'ANALYTICS' };
    }
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return { id: 'adb-created-1', displayName: body.displayName, lifecycleState: 'PROVISIONING', compartmentId: body.compartmentId, dbName: body.dbName, dbWorkload: body.dbWorkload, computeModel: body.computeModel, computeCount: body.computeCount, dataStorageSizeInGBs: body.dataStorageSizeInGBs, dataStorageSizeInTBs: body.dataStorageSizeInTBs, licenseModel: body.licenseModel };
    }
    if (method === 'DELETE') {
      return {};
    }
    if (path.includes('/autonomousDatabases/adb-1')) {
      return { id: 'adb-1', displayName: 'analytics-adb', lifecycleState: 'AVAILABLE', dbName: 'ANALYTICS', dbVersion: '23ai', ocpuCount: 4, dataStorageSizeInTBs: 1 };
    }
    return [{ id: 'adb-1', displayName: 'analytics-adb', lifecycleState: 'AVAILABLE', dbName: 'ANALYTICS', dbVersion: '23ai', ocpuCount: 4, dataStorageSizeInTBs: 1 }];
  }
  if (path.includes('/autonomousContainerDatabases')) {
    return [{ id: 'acdb-1', displayName: 'shared-acdb', lifecycleState: 'AVAILABLE', dbVersion: '19c' }];
  }
  if (path.includes('/exadataInfrastructures')) {
    return [{ id: 'exadata-1', displayName: 'finance-exadata', lifecycleState: 'AVAILABLE', shape: 'Exadata.X9M', availabilityDomain: 'FRA-AD-1' }];
  }
  if (path.includes('/20180115/views')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return {
        id: 'dns-view-created-1',
        displayName: body.displayName,
        lifecycleState: 'ACTIVE',
        compartmentId: body.compartmentId,
        timeCreated: '2026-05-24T12:20:00Z',
      };
    }
    return [{
      id: 'dns-view-1',
      displayName: 'apps-private-view',
      lifecycleState: 'ACTIVE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      timeCreated: '2026-05-24T12:00:00Z',
    }];
  }
  if (path.includes('/20180115/zones/') && path.includes('/records/')) {
    if (method === 'DELETE') {
      return {};
    }
    if (method === 'PUT') {
      const body = JSON.parse(bodyText || '{}');
      return { items: body.items || [] };
    }
  }
  if (path.includes('/20180115/zones/') && path.includes('/records')) {
    return {
      items: [{
        domain: path.includes('private-zone-1') ? 'app.internal.example.oraclevcn.com' : 'www.example.com',
        rtype: 'A',
        rdata: path.includes('private-zone-1') ? '10.0.1.10' : '203.0.113.20',
        ttl: 300,
      }],
    };
  }
  if (path.includes('/20180115/zones')) {
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      return {
        id: body.scope === 'PRIVATE' ? 'private-zone-created-1' : 'public-zone-created-1',
        name: body.name,
        lifecycleState: 'ACTIVE',
        compartmentId: body.compartmentId,
        scope: body.scope,
        zoneType: body.zoneType,
        viewId: body.viewId,
        timeCreated: '2026-05-24T12:15:00Z',
      };
    }
    if (method === 'DELETE') {
      return {};
    }
    if (path.includes('scope=PRIVATE')) {
      return [{
        id: 'private-zone-1',
        name: 'internal.example.oraclevcn.com',
        lifecycleState: 'ACTIVE',
        compartmentId: 'ocid1.compartment.oc1..apps',
        scope: 'PRIVATE',
        zoneType: 'PRIMARY',
        viewId: 'dns-view-1',
        timeCreated: '2026-05-24T12:10:00Z',
      }];
    }
    return [{
      id: 'public-zone-1',
      name: 'example.com',
      lifecycleState: 'ACTIVE',
      compartmentId: 'ocid1.compartment.oc1..apps',
      scope: 'GLOBAL',
      zoneType: 'PRIMARY',
      timeCreated: '2026-05-24T12:05:00Z',
    }];
  }
  if (path.endsWith('/b') && method === 'POST') {
    const body = JSON.parse(bodyText || '{}');
    return {
      name: body.name,
      compartmentId: body.compartmentId,
      storageTier: body.storageTier,
      publicAccessType: body.publicAccessType,
      objectEventsEnabled: body.objectEventsEnabled,
      timeCreated: '2026-05-24T12:00:00Z',
    };
  }
  if (path.includes('/b/') && method === 'DELETE') {
    return {};
  }
  if (path.includes('/b?')) {
    return [{ name: 'backups', timeCreated: '2026-05-15T00:00:00Z', publicAccessType: 'NoPublicAccess' }];
  }
  return [];
}

function mockRequest(calls) {
  return (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.body = '';
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      queueMicrotask(() => {
        response.emit('data', JSON.stringify(responseFor(options.path, options.method, options.body || '')));
        response.emit('end');
      });
    };
    req.write = (chunk) => {
      req.body += chunk;
      options.body = req.body;
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
}

function mockLaunchOptionsRequest(calls) {
  return (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      queueMicrotask(() => {
        let payload = [];
        if (options.path.includes('/compartments')) {
          payload = [
            { id: 'ocid1.compartment.oc1..compute', name: 'Compute', lifecycleState: 'ACTIVE', compartmentId: 'ocid1.tenancy.oc1..root' },
            { id: 'ocid1.compartment.oc1..network', name: 'Network', lifecycleState: 'ACTIVE', compartmentId: 'ocid1.tenancy.oc1..root' },
          ];
        } else if (options.path.includes('/availabilityDomains')) {
          payload = [{ name: 'FRA-AD-1' }];
        } else if (options.path.includes('/shapes')) {
          payload = [{ shape: 'VM.Standard.E5.Flex', isFlexible: true }];
        } else if (options.path.includes('/images')) {
          payload = [{ id: 'platform-image-1', displayName: 'Oracle Linux', lifecycleState: 'AVAILABLE' }];
        } else if (options.path.includes('/subnets')) {
          if (options.path.includes('ocid1.compartment.oc1..network')) {
            payload = [{
              id: 'subnet-network-1',
              displayName: 'prod-private-subnet',
              lifecycleState: 'AVAILABLE',
              compartmentId: 'ocid1.compartment.oc1..network',
              cidrBlock: '10.10.1.0/24',
            }];
          } else {
            payload = [];
          }
        }
        response.emit('data', JSON.stringify(payload));
        response.emit('end');
      });
    };
    req.write = () => {};
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
}

describe('OCI API client', () => {
  it('builds a read-only multi-service inventory without returning secrets', async () => {
    const calls = [];
    const inventory = await getOciInventory(connector(), { request: mockRequest(calls) });

    expect(inventory.summary).toMatchObject({
      regions: 1,
      compartments: 2,
      instances: 2,
      runningInstances: 2,
      blockVolumes: 2,
      bootVolumes: 2,
      vcns: 2,
      subnets: 2,
      buckets: 2,
      dbSystems: 2,
      autonomousDatabases: 2,
      autonomousContainerDatabases: 2,
      exadataInfrastructures: 2,
    });
    expect(inventory.instances[0]).toMatchObject({
      name: 'web-1',
      region: 'eu-frankfurt-1',
      status: 'RUNNING',
      shape: 'VM.Standard.E4.Flex',
    });
    expect(inventory.buckets[0]).toMatchObject({ name: 'backups', namespace: 'tenantnamespace' });
    expect(inventory.dbSystems[0]).toMatchObject({ name: 'orders-db-system', resourceType: 'dbSystem' });
    expect(inventory.autonomousDatabases[0]).toMatchObject({ name: 'analytics-adb', resourceType: 'autonomousDatabase' });
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE KEY');
    expect(calls.some((call) => call.hostname === 'iaas.eu-frankfurt-1.oraclecloud.com')).toBe(true);
    expect(calls.some((call) => call.hostname === 'objectstorage.eu-frankfurt-1.oraclecloud.com')).toBe(true);
    expect(calls.some((call) => call.hostname === 'database.eu-frankfurt-1.oraclecloud.com')).toBe(true);
    expect(inventory.scan).toMatchObject({ instanceScanComplete: true, partial: false });
    expect(calls.findIndex((call) => call.path.includes('/instances'))).toBeLessThan(
      calls.findIndex((call) => call.path.includes('/volumes')),
    );
  });

  it('can load only subscribed regions without scanning resources', async () => {
    const calls = [];
    const inventory = await getOciInventory(connector(), { request: mockRequest(calls), regionsOnly: true });

    expect(inventory.summary).toMatchObject({
      regions: 1,
      compartments: 0,
      instances: 0,
      blockVolumes: 0,
      vcns: 0,
      buckets: 0,
    });
    expect(inventory.regions).toEqual([
      { name: 'eu-frankfurt-1', key: 'FRA', status: 'READY', home: true },
    ]);
    expect(inventory.instances).toEqual([]);
    expect(calls.some((call) => call.path.includes('/regionSubscriptions'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/compartments'))).toBe(false);
    expect(calls.some((call) => call.hostname === 'iaas.eu-frankfurt-1.oraclecloud.com')).toBe(false);
    expect(calls.some((call) => call.hostname === 'objectstorage.eu-frankfurt-1.oraclecloud.com')).toBe(false);
  });

  it('can load regions and compartments without scanning cloud resources', async () => {
    const calls = [];
    const inventory = await getOciInventory(connector(), { request: mockRequest(calls), identityOnly: true });

    expect(inventory.summary).toMatchObject({
      regions: 1,
      compartments: 2,
      instances: 0,
      blockVolumes: 0,
      vcns: 0,
      buckets: 0,
    });
    expect(inventory.compartments.map((item) => item.name)).toEqual(['Root tenancy', 'apps']);
    expect(inventory.instances).toEqual([]);
    expect(inventory.blockVolumes).toEqual([]);
    expect(calls.some((call) => call.path.includes('/regionSubscriptions'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/compartments'))).toBe(true);
    expect(calls.some((call) => call.hostname === 'iaas.eu-frankfurt-1.oraclecloud.com')).toBe(false);
    expect(calls.some((call) => call.hostname === 'objectstorage.eu-frankfurt-1.oraclecloud.com')).toBe(false);
  });

  it('loads instances for one selected region and compartment', async () => {
    const calls = [];
    const data = await getOciInstances(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.instances).toHaveLength(1);
    expect(data.instances[0]).toMatchObject({
      name: 'web-1',
      region: 'eu-frankfurt-1',
      status: 'RUNNING',
      shape: 'VM.Standard.E4.Flex',
      ocpus: 2,
      memoryGb: 16,
      storageSizeGb: 50,
      privateIp: '10.0.0.10',
      publicIp: '203.0.113.10',
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].hostname).toBe('iaas.eu-frankfurt-1.oraclecloud.com');
    expect(calls[0].path).toContain('/instances?compartmentId=ocid1.compartment.oc1..apps');
    expect(calls[0].path).not.toContain('/volumes');
    expect(calls.some((call) => call.path.includes('/vnicAttachments'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/vnics/vnic-1'))).toBe(true);
  });

  it('loads selected-scope OCI resources without scanning other compartments', async () => {
    const calls = [];
    const data = await getOciScopedResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.summary).toMatchObject({
      instances: 1,
      runningInstances: 1,
      blockVolumes: 1,
      bootVolumes: 1,
      vcns: 1,
      subnets: 1,
      buckets: 1,
    });
    expect(data.instances[0].name).toBe('web-1');
    expect(data.blockVolumes[0].name).toBe('data');
    expect(data.bootVolumes[0].name).toBe('web-boot');
    expect(data.vcns[0].name).toBe('prod-vcn');
    expect(data.subnets[0].name).toBe('web-subnet');
    expect(data.buckets[0]).toMatchObject({ name: 'backups', namespace: 'tenantnamespace' });
    expect(calls.some((call) => call.path.includes('/compartments'))).toBe(false);
    expect(calls.every((call) => !call.path.includes('ocid1.tenancy.oc1..root') || call.path.includes('/availabilityDomains'))).toBe(true);
  });

  it('launches an OCI VM from an image with network and shape details', async () => {
    const calls = [];
    const data = await createOciInstance(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      displayName: 'new-vm',
      shape: 'VM.Standard.E5.Flex',
      imageId: 'custom-image-1',
      subnetId: 'subnet-1',
      ocpus: '2',
      memoryGb: '8',
      bootVolumeSizeGb: '60',
      assignPublicIp: true,
      sshPublicKey: 'ssh-rsa AAAA test',
    });

    expect(data.instance).toMatchObject({
      id: 'instance-new',
      name: 'new-vm',
      status: 'PROVISIONING',
      ocpus: 2,
      memoryGb: 8,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/20160918/instances',
    });
  });

  it('loads launch subnets from the selected network compartment only', async () => {
    const calls = [];
    const data = await getOciLaunchOptions(connector(), {
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..compute',
      networkCompartmentId: 'ocid1.compartment.oc1..network',
      request: mockLaunchOptionsRequest(calls),
    });

    expect(data.availabilityDomains).toContain('FRA-AD-1');
    expect(data.shapes.map((shape) => shape.name)).toContain('VM.Standard.E5.Flex');
    expect(data.images.map((image) => image.name)).toContain('Oracle Linux');
    expect(data.subnets).toHaveLength(1);
    expect(data.subnets[0]).toMatchObject({
      id: 'subnet-network-1',
      name: 'prod-private-subnet',
      compartmentId: 'ocid1.compartment.oc1..network',
    });
    expect(calls.some((call) => call.path.includes('/subnets?compartmentId=ocid1.compartment.oc1..network'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/subnets?compartmentId=ocid1.compartment.oc1..compute'))).toBe(false);
    expect(calls.some((call) => call.path.includes('/compartments'))).toBe(false);
  });

  it('loads availability domains without scanning launch subnets', async () => {
    const calls = [];
    const data = await getOciAvailabilityDomains(connector(), {
      region: 'eu-frankfurt-1',
      request: mockRequest(calls),
    });

    expect(data.availabilityDomains).toEqual(['FRA-AD-1']);
    expect(calls.some((call) => call.path.includes('/availabilityDomains'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/subnets'))).toBe(false);
  });

  it('lists available backups for the selected OCI volume', async () => {
    const calls = [];
    const data = await getOciVolumeBackups(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'blockVolume',
      volumeId: 'volume-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.backups).toHaveLength(1);
    expect(data.backups[0]).toMatchObject({
      id: 'volume-backup-1',
      name: 'data-backup',
      status: 'AVAILABLE',
      backupType: 'FULL',
      sourceVolumeId: 'volume-1',
      sizeGb: 100,
    });
    expect(calls[0].path).toContain('/volumeBackups?compartmentId=ocid1.compartment.oc1..apps&volumeId=volume-1');
  });

  it('lists OCI volume backups by compartment when no source volume is selected', async () => {
    const calls = [];
    const data = await getOciVolumeBackups(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'blockVolume',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.volumeId).toBe('');
    expect(data.backups).toHaveLength(1);
    expect(data.backups[0]).toMatchObject({
      id: 'volume-backup-1',
      sourceVolumeId: 'volume-1',
    });
    expect(calls[0].path).toContain('/volumeBackups?compartmentId=ocid1.compartment.oc1..apps');
    expect(calls[0].path).not.toContain('&volumeId=');
  });

  it('lists OCI volume group resources by compartment', async () => {
    const calls = [];
    const data = await getOciVolumeGroupResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      resourceType: 'volumeGroup',
    });

    expect(data.resources).toHaveLength(1);
    expect(data.resources[0]).toMatchObject({
      id: 'volume-group-1',
      name: 'prod-volume-group',
      status: 'AVAILABLE',
      volumeIds: ['volume-1', 'boot-1'],
    });
    expect(calls[0].path).toContain('/volumeGroups?compartmentId=ocid1.compartment.oc1..apps');
  });

  it('lists OCI volume group backups and replicas by compartment', async () => {
    const calls = [];
    const backups = await getOciVolumeGroupResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      resourceType: 'volumeGroupBackup',
    });
    const replicas = await getOciVolumeGroupResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      resourceType: 'volumeGroupReplica',
    });

    expect(backups.resources[0]).toMatchObject({
      id: 'volume-group-backup-1',
      sourceVolumeGroupId: 'volume-group-1',
      backupType: 'FULL',
      sizeGb: 150,
    });
    expect(replicas.resources[0]).toMatchObject({
      id: 'volume-group-replica-1',
      sourceVolumeGroupId: 'volume-group-1',
      destinationRegion: 'me-jeddah-1',
    });
    expect(calls.some((call) => call.path.includes('/volumeGroupBackups?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/volumeGroupReplicas?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
  });

  it('lists OCI file storage resources by compartment', async () => {
    const calls = [];
    const data = await getOciFileStorageResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.fileSystems[0]).toMatchObject({
      id: 'file-system-1',
      name: 'shared-apps-fs',
      status: 'ACTIVE',
      sizeGb: 10,
    });
    expect(data.mountTargets[0]).toMatchObject({
      id: 'mount-target-1',
      subnetId: 'subnet-1',
      exportSetId: 'export-set-1',
    });
    expect(data.exports[0]).toMatchObject({
      id: 'export-1',
      path: '/shared-apps',
      fileSystemId: 'file-system-1',
      exportOptionsCount: 1,
    });
    expect(data.snapshots[0]).toMatchObject({
      id: 'snapshot-1',
      name: 'shared-apps-snapshot',
      fileSystemId: 'file-system-1',
    });
    expect(calls.some((call) => call.path.includes('/fileSystems?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/mountTargets?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/exports?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/snapshots?fileSystemId=file-system-1'))).toBe(true);
  });

  it('lists OCI object storage buckets and private endpoints by compartment', async () => {
    const calls = [];
    const data = await getOciObjectStorageResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.namespace).toBe('tenantnamespace');
    expect(data.buckets[0]).toMatchObject({
      name: 'backups',
      namespace: 'tenantnamespace',
      providerType: 'bucket',
    });
    expect(data.privateEndpoints[0]).toMatchObject({
      id: 'object-private-endpoint-1',
      name: 'apps-object-pe',
      status: 'ACTIVE',
      subnetId: 'subnet-1',
      accessTargetCount: 1,
    });
    expect(calls.some((call) => call.path.includes('/n/tenantnamespace/b?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/n/tenantnamespace/privateEndpoints?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
  });

  it('does not fail object storage refresh when private endpoints are unavailable', async () => {
    const calls = [];
    const request = (options, callback) => {
      calls.push(options);
      const req = new EventEmitter();
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = options.path.includes('/privateEndpoints') ? 404 : 200;
        response.setEncoding = () => {};
        callback(response);
        queueMicrotask(() => {
          response.emit('data', response.statusCode === 404
            ? JSON.stringify({ code: 'NotFound', message: 'Not Found' })
            : JSON.stringify(responseFor(options.path, options.method, options.body || '')));
          response.emit('end');
        });
      };
      req.write = (chunk) => {
        options.body = `${options.body || ''}${chunk}`;
      };
      req.destroy = (error) => req.emit('error', error);
      return req;
    };

    const data = await getOciObjectStorageResources(connector(), {
      request,
      region: 'me-jeddah-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.buckets[0]).toMatchObject({ name: 'backups' });
    expect(data.privateEndpoints).toEqual([]);
    expect(data.errors).toEqual([]);
    expect(calls.some((call) => call.path.includes('/privateEndpoints'))).toBe(true);
  });

  it('lists OCI database resources by compartment', async () => {
    const calls = [];
    const data = await getOciDatabaseResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(data.dbSystems[0]).toMatchObject({ id: 'db-system-1', name: 'orders-db-system', resourceType: 'dbSystem' });
    expect(data.autonomousDatabases[0]).toMatchObject({ id: 'adb-1', name: 'analytics-adb', resourceType: 'autonomousDatabase', storageSizeGb: '1024' });
    expect(data.autonomousContainerDatabases[0]).toMatchObject({ id: 'acdb-1', name: 'shared-acdb', resourceType: 'autonomousContainerDatabase' });
    expect(data.exadataInfrastructures[0]).toMatchObject({ id: 'exadata-1', name: 'finance-exadata', resourceType: 'exadataInfrastructure' });
    expect(calls.some((call) => call.path.includes('/20160918/dbSystems?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/20160918/autonomousDatabases?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
  });

  it('creates and deletes OCI database resources safely', async () => {
    const calls = [];
    const createdDbSystem = await createOciDbSystem(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      displayName: 'orders-db-system-copy',
      hostnamePrefix: 'ordersdb',
      shape: 'VM.Standard2.1',
      subnetId: 'subnet-1',
      databaseEdition: 'ENTERPRISE_EDITION',
      licenseModel: 'LICENSE_INCLUDED',
      dbName: 'ORDERS',
      dbUniqueName: 'ORDERS_UNQ',
      pdbName: 'ORDERSPDB',
      dbVersion: '19c',
      adminPassword: 'NotReturned-123',
      sshPublicKeys: 'ssh-rsa AAAATEST user@example',
      cpuCoreCount: '2',
      nodeCount: '1',
      dataStorageSizeInGBs: '256',
      storageManagement: 'ASM',
      storageVolumePerformanceMode: 'HIGH_PERFORMANCE',
      characterSet: 'AL32UTF8',
      ncharacterSet: 'AL16UTF16',
    });
    expect(createdDbSystem.database).toMatchObject({
      id: 'db-system-created-1',
      name: 'orders-db-system-copy',
      resourceType: 'dbSystem',
      status: 'PROVISIONING',
    });
    expect(JSON.stringify(createdDbSystem)).not.toContain('NotReturned-123');
    const dbSystemCreateBody = JSON.parse(calls.find((call) => call.method === 'POST' && call.path.includes('/20160918/dbSystems')).body);
    expect(dbSystemCreateBody).toMatchObject({
      displayName: 'orders-db-system-copy',
      sshPublicKeys: ['ssh-rsa AAAATEST user@example'],
      storageManagement: 'ASM',
      storageVolumePerformanceMode: 'HIGH_PERFORMANCE',
      dbHome: { dbVersion: '19c', database: { dbName: 'ORDERS', dbUniqueName: 'ORDERS_UNQ', pdbName: 'ORDERSPDB', characterSet: 'AL32UTF8', ncharacterSet: 'AL16UTF16' } },
      dataStorageSizeInGBs: 256,
    });

    const nodes = await listOciDbSystemNodes(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      dbSystemId: 'db-system-1',
    });
    expect(nodes.nodes[0]).toMatchObject({ id: 'db-node-1', hostname: 'ordersdb1', resourceType: 'dbNode' });
    const nodeAction = await runOciDbNodeAction(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      dbNodeId: 'db-node-1',
      action: 'start',
    });
    expect(nodeAction.node).toMatchObject({ id: 'db-node-1', status: 'STARTING' });
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/20160918/dbNodes/db-node-1?action=START'))).toBe(true);
    const scaled = await updateOciDbSystem(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      dbSystemId: 'db-system-1',
      dataStorageSizeInGBs: '512',
    });
    expect(scaled.database).toMatchObject({ id: 'db-system-1', status: 'UPDATING', storageSizeGb: 512 });

    const created = await createOciAutonomousDatabase(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      displayName: 'apps-adb',
      dbName: 'APPDB',
      adminPassword: 'NotReturned-123',
      dbWorkload: 'OLTP',
      licenseModel: 'LICENSE_INCLUDED',
      computeCount: '2',
      dataStorageSizeInGBs: '20',
      isFreeTier: false,
    });
    expect(created.database).toMatchObject({
      id: 'adb-created-1',
      name: 'apps-adb',
      resourceType: 'autonomousDatabase',
      status: 'PROVISIONING',
    });
    expect(JSON.stringify(created)).not.toContain('NotReturned-123');
    const createCall = calls.find((call) => call.method === 'POST' && call.path.includes('/20160918/autonomousDatabases'));
    const createBody = JSON.parse(createCall.body);
    expect(createBody).toMatchObject({
      computeModel: 'ECPU',
      computeCount: 2,
      dataStorageSizeInGBs: 20,
    });
    expect(createBody).not.toHaveProperty('cpuCoreCount');

    await createOciAutonomousDatabase(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      displayName: 'warehouse-adb',
      dbName: 'WHDB',
      adminPassword: 'NotReturned-123',
      dbWorkload: 'DW',
      licenseModel: 'LICENSE_INCLUDED',
      computeCount: '2',
      dataStorageSizeInTBs: '1',
      isFreeTier: false,
    });
    const warehouseCreateCall = calls.filter((call) => call.method === 'POST' && call.path.includes('/20160918/autonomousDatabases')).at(-1);
    const warehouseBody = JSON.parse(warehouseCreateCall.body);
    expect(warehouseBody).toMatchObject({
      dbWorkload: 'DW',
      computeModel: 'ECPU',
      computeCount: 2,
      dataStorageSizeInTBs: 1,
    });
    expect(warehouseBody).not.toHaveProperty('dataStorageSizeInGBs');

    const deletedAutonomous = await deleteOciDatabaseResource(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      databaseId: 'adb-1',
      resourceType: 'autonomousDatabase',
      confirmation: 'analytics-adb',
    });
    expect(deletedAutonomous.database).toMatchObject({ id: 'adb-1', status: 'DELETING' });

    const deletedDbSystem = await deleteOciDatabaseResource(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      databaseId: 'db-system-1',
      resourceType: 'dbSystem',
      confirmation: 'orders-db-system',
    });
    expect(deletedDbSystem.database).toMatchObject({ id: 'db-system-1', status: 'DELETING' });
    const stopped = await runOciAutonomousDatabaseAction(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      databaseId: 'adb-1',
      action: 'stop',
    });
    expect(stopped.database).toMatchObject({ id: 'adb-1', status: 'STOP_REQUESTED' });
    const restored = await runOciAutonomousDatabaseAction(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      databaseId: 'adb-1',
      action: 'restore',
      restoreTimestamp: '2026-05-26T00:00:00Z',
    });
    expect(restored.database).toMatchObject({ id: 'adb-1', status: 'RESTORE_REQUESTED' });
    const clone = await cloneOciAutonomousDatabase(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      sourceDatabaseId: 'adb-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      displayName: 'analytics-adb-clone',
      dbName: 'ANALYTICSCL',
      adminPassword: 'NotReturned-456',
      cloneType: 'FULL',
    });
    expect(clone.database).toMatchObject({ id: 'adb-created-1', name: 'analytics-adb-clone', status: 'PROVISIONING' });
    expect(JSON.stringify(clone)).not.toContain('NotReturned-456');
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/autonomousDatabases')).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path.includes('/20160918/autonomousDatabases/adb-1'))).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path.includes('/20160918/dbSystems/db-system-1'))).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/20160918/autonomousDatabases/adb-1/actions/stop'))).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/20160918/autonomousDatabases/adb-1/actions/restore'))).toBe(true);
  });

  it('lists and creates OCI network resources', async () => {
    const calls = [];
    const network = await getOciNetworkResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });
    const vcn = await createOciVcn(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      displayName: 'apps-vcn',
      cidrBlock: '10.1.0.0/16',
      dnsLabel: 'apps',
    });
    const subnet = await createOciSubnet(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      vcnId: 'vcn-created-1',
      displayName: 'apps-subnet',
      cidrBlock: '10.1.1.0/24',
    });
    const gateway = await createOciGateway(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      vcnId: 'vcn-created-1',
      displayName: 'apps-igw',
      gatewayType: 'internetGateway',
    });
    const serviceGateway = await createOciGateway(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      vcnId: 'vcn-created-1',
      displayName: 'apps-service-gateway',
      gatewayType: 'serviceGateway',
    });
    const drg = await createOciDrg(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      displayName: 'apps-drg',
    });
    const drgAttachment = await createOciDrgAttachment(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      drgId: 'drg-created-1',
      vcnId: 'vcn-created-1',
      displayName: 'apps-drg-attachment',
    });
    const rpc = await createOciRemotePeeringConnection(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      drgId: 'drg-created-1',
      displayName: 'apps-rpc',
    });
    const connectedRpc = await connectOciRemotePeeringConnection(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      connectionId: 'rpc-created-1',
      peerId: 'rpc-peer-1',
      peerRegionName: 'me-jeddah-1',
    });
    const routeTable = await createOciRouteTable(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      vcnId: 'vcn-created-1',
      displayName: 'apps-routes',
      destinationCidrBlock: '0.0.0.0/0',
      networkEntityId: 'igw-created-1',
    });
    const securityList = await createOciSecurityList(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      vcnId: 'vcn-created-1',
      displayName: 'apps-security',
      direction: 'ingress',
      protocol: '6',
      source: '0.0.0.0/0',
      tcpPort: '22,443',
    });
    await expect(deleteOciVcn(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      vcnId: 'vcn-created-1',
      vcnName: 'apps-vcn',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the VCN name');
    const deleted = await deleteOciVcn(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      vcnId: 'vcn-created-1',
      vcnName: 'apps-vcn',
      confirmation: 'apps-vcn',
    });
    await expect(deleteOciSubnet(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      subnetId: 'subnet-created-1',
      subnetName: 'apps-subnet',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the subnet name');
    const deletedSubnet = await deleteOciSubnet(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      subnetId: 'subnet-created-1',
      subnetName: 'apps-subnet',
      confirmation: 'apps-subnet',
    });
    await expect(deleteOciDrg(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      drgId: 'drg-created-1',
      drgName: 'apps-drg',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the DRG name');
    const deletedDrg = await deleteOciDrg(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      drgId: 'drg-created-1',
      drgName: 'apps-drg',
      confirmation: 'apps-drg',
    });
    const deletedDrgAttachment = await deleteOciDrgAttachment(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      attachmentId: 'drg-attachment-created-1',
      attachmentName: 'apps-drg-attachment',
      confirmation: 'apps-drg-attachment',
    });
    const deletedRpc = await deleteOciRemotePeeringConnection(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      connectionId: 'rpc-created-1',
      connectionName: 'apps-rpc',
      confirmation: 'apps-rpc',
    });

    expect(network.vcns[0]).toMatchObject({ id: 'vcn-1', name: 'prod-vcn' });
    expect(network.internetGateways[0]).toMatchObject({ id: 'igw-1', name: 'prod-igw' });
    expect(network.drgs[0]).toMatchObject({ id: 'drg-1', name: 'prod-drg' });
    expect(network.drgAttachments[0]).toMatchObject({ id: 'drg-attachment-1', name: 'prod-drg-attachment', drgId: 'drg-1' });
    expect(network.remotePeeringConnections[0]).toMatchObject({ id: 'rpc-1', name: 'prod-rpc', drgId: 'drg-1' });
    expect(vcn.vcn).toMatchObject({ id: 'vcn-created-1', cidrBlock: '10.1.0.0/16' });
    expect(subnet.subnet).toMatchObject({ id: 'subnet-created-1', vcnId: 'vcn-created-1' });
    expect(gateway.gateway).toMatchObject({ id: 'igw-created-1', resourceType: 'internetGateway' });
    expect(serviceGateway.gateway).toMatchObject({ id: 'sgw-created-1', resourceType: 'serviceGateway' });
    expect(drg.drg).toMatchObject({ id: 'drg-created-1', resourceType: 'drg' });
    expect(drgAttachment.attachment).toMatchObject({ id: 'drg-attachment-created-1', vcnId: 'vcn-created-1', drgId: 'drg-created-1' });
    expect(rpc.connection).toMatchObject({ id: 'rpc-created-1', drgId: 'drg-created-1', peeringStatus: 'NEW' });
    expect(connectedRpc.connection).toMatchObject({ id: 'rpc-created-1', peerId: 'rpc-peer-1', peerRegionName: 'me-jeddah-1' });
    expect(routeTable.routeTable).toMatchObject({ id: 'rt-created-1', rulesCount: 1 });
    expect(securityList.securityList).toMatchObject({ id: 'sl-created-1', rulesCount: 2 });
    expect(deleted.vcn).toMatchObject({ id: 'vcn-created-1', status: 'DELETING' });
    expect(deletedSubnet.subnet).toMatchObject({ id: 'subnet-created-1', status: 'DELETING' });
    expect(deletedDrg.drg).toMatchObject({ id: 'drg-created-1', status: 'DELETING' });
    expect(deletedDrgAttachment.attachment).toMatchObject({ id: 'drg-attachment-created-1', status: 'DETACHING' });
    expect(deletedRpc.connection).toMatchObject({ id: 'rpc-created-1', status: 'DELETING' });
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/vcns')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/subnets')).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/20160918/subnets/subnet-created-1')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/internetGateways')).toBe(true);
    expect(calls.some((call) => call.method === 'GET' && call.path.startsWith('/20160918/services'))).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/serviceGateways' && JSON.parse(call.body).services?.[0]?.serviceId === 'service-all-1')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/routeTables')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/securityLists')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/drgs')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/drgAttachments')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/remotePeeringConnections')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20160918/remotePeeringConnections/rpc-created-1/actions/connect')).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/20160918/drgs/drg-created-1')).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/20160918/drgAttachments/drg-attachment-created-1')).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/20160918/remotePeeringConnections/rpc-created-1')).toBe(true);
    const gatewayCreateCall = calls.find((call) => call.method === 'POST' && call.path === '/20160918/internetGateways');
    const securityCreateCall = calls.find((call) => call.method === 'POST' && call.path === '/20160918/securityLists');
    expect(JSON.parse(gatewayCreateCall.body).isEnabled).toBe(true);
    expect(JSON.parse(securityCreateCall.body).ingressSecurityRules).toHaveLength(2);
  });

  it('manages OCI DNS zones, private views, and records', async () => {
    const calls = [];
    const dns = await getOciDnsResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });
    const view = await createOciDnsView(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      displayName: 'apps-private-view-new',
    });
    const publicZone = await createOciDnsZone(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      name: 'apps.example.com',
      scope: 'GLOBAL',
    });
    const privateZone = await createOciDnsZone(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      name: 'apps.internal.example.oraclevcn.com',
      scope: 'PRIVATE',
      viewId: 'dns-view-1',
    });
    const record = await upsertOciDnsRecord(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      zoneId: 'public-zone-1',
      zoneName: 'example.com',
      scope: 'GLOBAL',
      domain: 'api.example.com',
      rtype: 'A',
      rdata: '203.0.113.25',
      ttl: '300',
    });
    const zoneRecords = await getOciDnsZoneRecords(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      zoneId: 'public-zone-1',
      zoneName: 'example.com',
      scope: 'GLOBAL',
    });
    await expect(deleteOciDnsZone(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      zoneId: 'public-zone-1',
      zoneName: 'example.com',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the DNS zone name or OCID');
    const deletedZone = await deleteOciDnsZone(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      zoneId: 'public-zone-1',
      zoneName: 'example.com',
      confirmation: 'example.com',
    });
    const deletedRecord = await deleteOciDnsRecord(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      zoneId: 'public-zone-1',
      zoneName: 'example.com',
      scope: 'GLOBAL',
      domain: 'api.example.com',
      rtype: 'A',
      confirmation: 'api.example.com A',
    });

    expect(dns.publicZones[0]).toMatchObject({ id: 'public-zone-1', name: 'example.com', scope: 'GLOBAL' });
    expect(dns.privateZones[0]).toMatchObject({ id: 'private-zone-1', name: 'internal.example.oraclevcn.com', scope: 'PRIVATE', viewId: 'dns-view-1' });
    expect(dns.views[0]).toMatchObject({ id: 'dns-view-1', name: 'apps-private-view' });
    expect(dns.records.map((item) => item.rdata)).toEqual(expect.arrayContaining(['203.0.113.20', '10.0.1.10']));
    expect(view.view).toMatchObject({ id: 'dns-view-created-1', name: 'apps-private-view-new' });
    expect(publicZone.zone).toMatchObject({ id: 'public-zone-created-1', scope: 'GLOBAL' });
    expect(privateZone.zone).toMatchObject({ id: 'private-zone-created-1', scope: 'PRIVATE', viewId: 'dns-view-1' });
    expect(record.record).toMatchObject({ zoneId: 'public-zone-1', domain: 'api.example.com', rtype: 'A', rdata: '203.0.113.25' });
    expect(zoneRecords.records[0]).toMatchObject({ zoneId: 'public-zone-1', zoneName: 'example.com', domain: 'www.example.com', rdata: '203.0.113.20' });
    expect(deletedZone.zone).toMatchObject({ id: 'public-zone-1', status: 'DELETING' });
    expect(deletedRecord.record).toMatchObject({ zoneId: 'public-zone-1', domain: 'api.example.com', rtype: 'A' });
    expect(calls.some((call) => call.hostname === 'dns.eu-frankfurt-1.oraclecloud.com')).toBe(true);
    expect(calls.some((call) => call.method === 'GET' && call.path.includes('/20180115/zones?compartmentId=ocid1.compartment.oc1..apps&scope=GLOBAL'))).toBe(true);
    expect(calls.some((call) => call.method === 'GET' && call.path.includes('/20180115/views?compartmentId=ocid1.compartment.oc1..apps'))).toBe(true);
    expect(calls.filter((call) => call.hostname === 'dns.eu-frankfurt-1.oraclecloud.com' && call.method === 'GET')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('limit=100') }),
      ]),
    );
    expect(calls.filter((call) => call.hostname === 'dns.eu-frankfurt-1.oraclecloud.com' && call.method === 'GET').some((call) => call.path.includes('limit=1000'))).toBe(false);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20180115/views')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20180115/zones' && JSON.parse(call.body).scope === 'PRIVATE')).toBe(true);
    expect(calls.some((call) => call.method === 'PUT' && call.path.includes('/20180115/zones/public-zone-1/records/api.example.com/A'))).toBe(true);
    expect(calls.some((call) => call.method === 'GET' && call.path.includes('/20180115/zones/public-zone-1/records?scope=GLOBAL') && call.path.includes('limit=100'))).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path.includes('/20180115/zones/public-zone-1?scope=GLOBAL'))).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path.includes('/20180115/zones/public-zone-1/records/api.example.com/A'))).toBe(true);
  });

  it('discovers OCI DNS resources across all connector compartments', async () => {
    const calls = [];
    const dns = await getOciDnsResources(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'all',
    });

    expect(dns.compartmentId).toBe('all');
    expect(dns.scannedCompartments).toBe(2);
    expect(dns.publicZones[0]).toMatchObject({ name: 'example.com' });
    expect(dns.privateZones[0]).toMatchObject({ name: 'internal.example.oraclevcn.com' });
    expect(calls.some((call) => call.hostname === 'identity.eu-frankfurt-1.oraclecloud.com' && call.path.includes('/compartments?'))).toBe(true);
    expect(calls.filter((call) => call.hostname === 'dns.eu-frankfurt-1.oraclecloud.com' && call.method === 'GET').length).toBeGreaterThan(3);
    expect(calls.some((call) => call.hostname === 'dns.eu-frankfurt-1.oraclecloud.com' && call.path.includes('limit=1000'))).toBe(false);
  });

  it('creates and deletes OCI buckets through Object Storage endpoints', async () => {
    const calls = [];
    const created = await createOciBucket(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      name: 'app-logs',
      storageTier: 'Archive',
      publicAccessType: 'NoPublicAccess',
      objectEventsEnabled: true,
    });
    await expect(deleteOciBucket(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      bucketName: 'app-logs',
      namespace: 'tenantnamespace',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the bucket name');
    const deleted = await deleteOciBucket(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      bucketName: 'app-logs',
      namespace: 'tenantnamespace',
      confirmation: 'app-logs',
    });

    expect(created.bucket).toMatchObject({
      id: 'tenantnamespace/app-logs',
      name: 'app-logs',
      storageTier: 'Archive',
      publicAccessType: 'NoPublicAccess',
    });
    expect(deleted.bucket).toMatchObject({ id: 'tenantnamespace/app-logs', name: 'app-logs', status: 'DELETING' });
    const createCall = calls.find((call) => call.method === 'POST' && call.path === '/n/tenantnamespace/b');
    const deleteCall = calls.find((call) => call.method === 'DELETE' && call.path === '/n/tenantnamespace/b/app-logs');
    expect(createCall).toBeTruthy();
    expect(deleteCall).toBeTruthy();
    expect(JSON.parse(createCall.body)).toMatchObject({
      compartmentId: 'ocid1.compartment.oc1..apps',
      name: 'app-logs',
      storageTier: 'Archive',
      objectEventsEnabled: true,
    });
  });

  it('creates OCI file systems and mount targets through File Storage endpoints', async () => {
    const calls = [];
    const fileSystem = await createOciFileSystem(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      displayName: 'shared-apps-fs',
    });
    const mountTarget = await createOciMountTarget(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      subnetId: 'subnet-1',
      displayName: 'apps-mount-target',
      hostnameLabel: 'appsmt',
    });

    expect(fileSystem.fileSystem).toMatchObject({
      id: 'file-system-created-1',
      name: 'shared-apps-fs',
      status: 'CREATING',
    });
    expect(mountTarget.mountTarget).toMatchObject({
      id: 'mount-target-created-1',
      name: 'apps-mount-target',
      status: 'CREATING',
      subnetId: 'subnet-1',
      exportSetId: 'export-set-created-1',
    });
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20171215/fileSystems')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/20171215/mountTargets')).toBe(true);
  });

  it('updates OCI instance shape configuration', async () => {
    const calls = [];
    const data = await updateOciInstance(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      instanceId: 'instance-1',
      displayName: 'web-1-resized',
      shape: 'VM.Standard.E5.Flex',
      ocpus: '4',
      memoryGb: '32',
    });

    expect(data.instance).toMatchObject({
      id: 'instance-1',
      name: 'web-1-resized',
      shape: 'VM.Standard.E5.Flex',
      ocpus: 4,
      memoryGb: 32,
      status: 'RUNNING',
    });
    const updateCall = calls.find((call) => call.method === 'PUT' && call.path === '/20160918/instances/instance-1');
    expect(updateCall).toBeTruthy();
    expect(JSON.parse(updateCall.body)).toMatchObject({
      displayName: 'web-1-resized',
      shape: 'VM.Standard.E5.Flex',
      shapeConfig: { ocpus: 4, memoryInGBs: 32 },
    });
  });

  it('resizes OCI block and boot volumes with a larger size only', async () => {
    const calls = [];
    await expect(resizeOciVolume(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'blockVolume',
      volumeId: 'volume-1',
      sizeGb: '100',
      currentSizeGb: '100',
    })).rejects.toThrow('larger than the current size');

    const blockVolume = await resizeOciVolume(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'blockVolume',
      volumeId: 'volume-1',
      volumeName: 'data',
      sizeGb: '150',
      currentSizeGb: '100',
    });
    const bootVolume = await resizeOciVolume(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'bootVolume',
      volumeId: 'boot-1',
      volumeName: 'web-boot',
      sizeGb: '75',
      currentSizeGb: '50',
    });

    expect(blockVolume.volume).toMatchObject({ id: 'volume-1', sizeGb: 150, resourceType: 'blockVolume' });
    expect(bootVolume.volume).toMatchObject({ id: 'boot-1', sizeGb: 75, resourceType: 'bootVolume' });
    const blockCall = calls.find((call) => call.method === 'PUT' && call.path === '/20160918/volumes/volume-1');
    const bootCall = calls.find((call) => call.method === 'PUT' && call.path === '/20160918/bootVolumes/boot-1');
    expect(blockCall).toBeTruthy();
    expect(bootCall).toBeTruthy();
    expect(JSON.parse(blockCall.body)).toEqual({ sizeInGBs: 150 });
    expect(JSON.parse(bootCall.body)).toEqual({ sizeInGBs: 75 });
  });

  it('restores an OCI volume using sourceDetails.id for the selected backup', async () => {
    const calls = [];
    const data = await restoreOciVolume(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'blockVolume',
      backupId: 'volume-backup-1',
      displayName: 'data-restored',
      compartmentId: 'ocid1.compartment.oc1..apps',
      availabilityDomain: 'FRA-AD-1',
      sizeGb: '100',
    });

    expect(data.volume).toMatchObject({
      id: 'volume-restored-1',
      name: 'data-restored',
      status: 'PROVISIONING',
    });
    const sentBody = JSON.parse(calls[0].body);
    expect(sentBody.sourceDetails).toEqual({
      type: 'volumeBackup',
      id: 'volume-backup-1',
    });
    expect(sentBody.sourceDetails.volumeBackupId).toBeUndefined();
  });

  it('deletes an OCI volume backup only after confirmation', async () => {
    const calls = [];
    await expect(deleteOciVolumeBackup(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'blockVolume',
      backupId: 'volume-backup-1',
      backupName: 'data-backup',
      sourceVolumeId: 'volume-1',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the backup name or OCID');

    const data = await deleteOciVolumeBackup(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      resourceType: 'blockVolume',
      backupId: 'volume-backup-1',
      backupName: 'data-backup',
      sourceVolumeId: 'volume-1',
      confirmation: 'data-backup',
    });

    expect(data.message).toBe('OCI volume backup deletion requested.');
    expect(data.backup).toMatchObject({
      id: 'volume-backup-1',
      name: 'data-backup',
      sourceVolumeId: 'volume-1',
      status: 'DELETING',
    });
    expect(calls.some((call) => call.method === 'DELETE' && call.path.includes('/volumeBackups/volume-backup-1'))).toBe(true);
  });

  it('lists and polls OCI custom images', async () => {
    const calls = [];
    const images = await getOciCustomImages(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
    });

    expect(images.images[0]).toMatchObject({
      id: 'custom-image-1',
      name: 'web-1-image',
      status: 'CREATING',
      sizeGb: 50,
    });
    expect(images.images).toHaveLength(1);
    expect(images.images.map((image) => image.name)).not.toContain('Oracle-Linux-10.1-2026.04.30-3');
    expect(images.images.map((image) => image.name)).not.toContain('other-compartment-image');
    expect(calls[0].path).toContain('/images?compartmentId=ocid1.compartment.oc1..apps&imageType=CUSTOM');

    const status = await getOciCustomImage(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      imageId: 'custom-image-1',
    });
    expect(status.image).toMatchObject({ id: 'custom-image-1', status: 'AVAILABLE' });
  });

  it('returns the created OCI custom image for polling', async () => {
    const calls = [];
    const data = await createOciInstanceImage(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      compartmentId: 'ocid1.compartment.oc1..apps',
      instanceId: 'instance-1',
      displayName: 'web-1-image',
    });

    expect(data.message).toBe('OCI custom image creation requested.');
    expect(data.image).toMatchObject({
      id: 'custom-image-1',
      status: 'CREATING',
      sourceInstanceId: 'instance-1',
    });
  });

  it('deletes an OCI custom image only after confirmation', async () => {
    const calls = [];
    await expect(deleteOciCustomImage(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      imageId: 'custom-image-1',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the custom image name or OCID');

    const data = await deleteOciCustomImage(connector(), {
      request: mockRequest(calls),
      region: 'eu-frankfurt-1',
      imageId: 'custom-image-1',
      confirmation: 'web-1-image',
    });
    expect(data.message).toBe('OCI custom image deletion requested.');
    expect(calls.some((call) => call.method === 'DELETE' && call.path.includes('/images/custom-image-1'))).toBe(true);
  });
});
