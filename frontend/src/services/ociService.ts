import { apiRequest } from './api';
import type { ResourceRecord } from '../types/dashboard';

export type OciRegion = {
  name: string;
  key: string;
  status: string;
  home: boolean;
};

export type OciCompartment = {
  id: string;
  name: string;
  description: string;
  status: string;
  parentCompartmentId?: string;
};

export type OciInventory = {
  generatedAt: string;
  connector: {
    id: string;
    name: string;
    region: string;
    tenancyOcid: string;
  };
  summary: {
    regions: number;
    compartments: number;
    instances: number;
    runningInstances: number;
    stoppedInstances: number;
    blockVolumes: number;
    bootVolumes: number;
    vcns: number;
    subnets: number;
    internetGateways?: number;
    natGateways?: number;
    serviceGateways?: number;
    drgAttachments?: number;
    routeTables?: number;
    securityLists?: number;
    buckets: number;
    dbSystems?: number;
    autonomousDatabases?: number;
    autonomousContainerDatabases?: number;
    exadataInfrastructures?: number;
  };
  regions: OciRegion[];
  scan?: {
    requestedRegion: string;
    homeRegion: string;
    scannedRegions: string[];
    compartmentScopeId: string;
    scannedCompartments: number;
    scannedResourceCompartments?: number;
    totalResourceCompartments?: number;
    phase?: string;
    currentRegion?: string;
    currentCompartmentName?: string;
    inProgress?: boolean;
    instanceScanComplete?: boolean;
    partial?: boolean;
  };
  compartments: OciCompartment[];
  instances: ResourceRecord[];
  blockVolumes: ResourceRecord[];
  bootVolumes: ResourceRecord[];
  vcns: ResourceRecord[];
  subnets: ResourceRecord[];
  internetGateways?: ResourceRecord[];
  natGateways?: ResourceRecord[];
  serviceGateways?: ResourceRecord[];
  drgAttachments?: ResourceRecord[];
  routeTables?: ResourceRecord[];
  securityLists?: ResourceRecord[];
  buckets: ResourceRecord[];
  dbSystems?: ResourceRecord[];
  autonomousDatabases?: ResourceRecord[];
  autonomousContainerDatabases?: ResourceRecord[];
  exadataInfrastructures?: ResourceRecord[];
  errors: Array<{
    scope: string;
    region?: string;
    message: string;
  }>;
};

export type OciInstancesResponse = {
  generatedAt: string;
  region: string;
  compartmentId: string;
  cached: boolean;
  cachedAt?: string;
  lastScannedAt?: string;
  instances: ResourceRecord[];
  errors: Array<{
    scope: string;
    region?: string;
    message: string;
  }>;
};

export type OciScopedResourcesResponse = {
  generatedAt: string;
  region: string;
  compartmentId: string;
  cached: boolean;
  cachedAt?: string;
  lastScannedAt?: string;
  summary: {
    instances: number;
    runningInstances: number;
    stoppedInstances: number;
    blockVolumes: number;
    bootVolumes: number;
    vcns: number;
    subnets: number;
    buckets: number;
    dbSystems?: number;
    autonomousDatabases?: number;
    autonomousContainerDatabases?: number;
    exadataInfrastructures?: number;
  };
  instances: ResourceRecord[];
  blockVolumes: ResourceRecord[];
  bootVolumes: ResourceRecord[];
  vcns: ResourceRecord[];
  subnets: ResourceRecord[];
  buckets: ResourceRecord[];
  dbSystems?: ResourceRecord[];
  autonomousDatabases?: ResourceRecord[];
  autonomousContainerDatabases?: ResourceRecord[];
  exadataInfrastructures?: ResourceRecord[];
  errors: Array<{
    scope: string;
    region?: string;
    message: string;
  }>;
};

export type OciAllResourcesResponse = OciInventory & {
  cached: boolean;
  cachedAt?: string;
  lastScannedAt?: string;
};

export type OciAllResourcesScanJob = {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  error?: string;
  data: OciAllResourcesResponse;
};

export type OciResourceMapNode = {
  id: string;
  ocid: string;
  type: string;
  group: string;
  label: string;
  status: string;
  region: string;
  compartmentId: string;
  compartmentName: string;
  metadata: Record<string, string>;
};

export type OciResourceMapEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  confidence: 'direct' | 'inferred' | string;
};

export type OciResourceMapResponse = {
  generatedAt: string;
  cached: boolean;
  cachedAt?: string;
  filters: {
    region: string;
    compartmentId: string;
    resourceType: string;
    resourceId: string;
    search: string;
    vcnId: string;
  };
  nodes: OciResourceMapNode[];
  edges: OciResourceMapEdge[];
  summary: {
    nodes: number;
    edges: number;
    relationships: number;
    truncated: boolean;
  };
  message?: string;
};

export type OciCustomImage = {
  id: string;
  name: string;
  region: string;
  compartmentId: string;
  providerType: 'customImage';
  resourceType: 'customImage';
  status: string;
  createdAt?: string;
  sizeGb?: number | string;
  operatingSystem?: string;
  operatingSystemVersion?: string;
  launchMode?: string;
  imageType?: string;
  listingType?: string;
  sourceInstanceId?: string;
  sourceInstanceName?: string;
};

export type CreateOciVmInput = {
  region: string;
  compartmentId: string;
  availabilityDomain: string;
  displayName: string;
  shape: string;
  imageId: string;
  subnetId: string;
  ocpus?: string;
  memoryGb?: string;
  bootVolumeSizeGb?: string;
  assignPublicIp: boolean;
  sshPublicKey?: string;
};

export type OciLaunchOptions = {
  generatedAt: string;
  region: string;
  compartmentId: string;
  networkCompartmentId?: string;
  availabilityDomains: string[];
  shapes: Array<{
    name: string;
    processorDescription?: string;
    ocpus?: number | string;
    memoryGb?: number | string;
    isFlexible?: boolean;
  }>;
  images: Array<{
    id: string;
    name: string;
    region: string;
    compartmentId: string;
    status: string;
    operatingSystem?: string;
    operatingSystemVersion?: string;
    imageType?: string;
    listingType?: string;
  }>;
  subnets: ResourceRecord[];
  errors: Array<{ scope: string; region?: string; message: string }>;
};

export type OciAvailabilityDomainsResponse = {
  generatedAt: string;
  region: string;
  availabilityDomains: string[];
  errors: Array<{ scope: string; region?: string; message: string }>;
};

export function getOciInventory() {
  return apiRequest<{ data: OciInventory }>('/oci/inventory');
}

export function getOciInstances(region: string, compartmentId: string, refresh = false) {
  const params = new URLSearchParams({
    region,
    compartmentId,
  });
  if (refresh) {
    params.set('refresh', 'true');
  }
  return apiRequest<{ data: OciInstancesResponse }>(`/oci/instances?${params.toString()}`);
}

export function getOciResources(region: string, compartmentId: string, refresh = false) {
  const params = new URLSearchParams({
    region,
    compartmentId,
  });
  if (refresh) {
    params.set('refresh', 'true');
  }
  return apiRequest<{ data: OciScopedResourcesResponse }>(`/oci/resources?${params.toString()}`);
}

export function getOciAllResources(refresh = false, region = 'all') {
  if (refresh) {
    return startOciAllResourcesScan(region);
  }
  const params = new URLSearchParams({ region });
  return apiRequest<{ data: OciAllResourcesResponse; job?: OciAllResourcesScanJob }>(`/oci/all-resources?${params.toString()}`);
}

export function startOciAllResourcesScan(region = 'all') {
  return apiRequest<{ data: OciAllResourcesResponse; job: OciAllResourcesScanJob }>('/oci/all-resources/scan', {
    method: 'POST',
    body: JSON.stringify({ region }),
  });
}

export function getOciAllResourcesScan(jobId: string) {
  return apiRequest<{ data: OciAllResourcesResponse; job: OciAllResourcesScanJob }>(`/oci/all-resources/scan/${encodeURIComponent(jobId)}`);
}

export function getOciResourceMap(input: { region?: string; compartmentId?: string; resourceType?: string; resourceId?: string; search?: string; vcnId?: string } = {}) {
  const params = new URLSearchParams();
  Object.entries(input).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });
  if (!params.has('region')) {
    params.set('region', 'all');
  }
  return apiRequest<{ data: OciResourceMapResponse }>(`/oci/resource-map?${params.toString()}`);
}

export function runOciVmAction(instanceId: string, action: 'start' | 'stop' | 'reboot', region: string) {
  return apiRequest<{ data: { message: string } }>(`/oci/instances/${encodeURIComponent(instanceId)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify({ region }),
  });
}

export function getOciVmStatus(instanceId: string, region: string) {
  const params = new URLSearchParams({ region });
  return apiRequest<{ data: { generatedAt: string; instance: ResourceRecord } }>(
    `/oci/instances/${encodeURIComponent(instanceId)}/status?${params.toString()}`,
  );
}

export function getOciAvailabilityDomains(region: string) {
  const params = new URLSearchParams({ region });
  return apiRequest<{ data: OciAvailabilityDomainsResponse }>(`/oci/availability-domains?${params.toString()}`);
}

export function getOciLaunchOptions(region: string, compartmentId: string, availabilityDomain = '', networkCompartmentId = '') {
  const params = new URLSearchParams({ region, compartmentId });
  if (availabilityDomain) {
    params.set('availabilityDomain', availabilityDomain);
  }
  if (networkCompartmentId) {
    params.set('networkCompartmentId', networkCompartmentId);
  }
  return apiRequest<{ data: OciLaunchOptions }>(`/oci/launch-options?${params.toString()}`);
}

export function createOciVm(input: CreateOciVmInput) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord } }>('/oci/instances', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateOciVm(instanceId: string, input: { region: string; displayName: string; shape: string; ocpus: string; memoryGb: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord } }>(`/oci/instances/${encodeURIComponent(instanceId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function terminateOciVm(instanceId: string, input: { region: string; instanceName: string; confirmation: string }) {
  return apiRequest<{ data: { message: string } }>(`/oci/instances/${encodeURIComponent(instanceId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function getOciCustomImages(region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: { generatedAt: string; region: string; compartmentId: string; images: OciCustomImage[]; errors: Array<{ scope: string; region?: string; message: string }> } }>(
    `/oci/custom-images?${params.toString()}`,
  );
}

export function getOciCustomImageStatus(imageId: string, region: string) {
  const params = new URLSearchParams({ region });
  return apiRequest<{ data: { generatedAt: string; image: OciCustomImage } }>(
    `/oci/custom-images/${encodeURIComponent(imageId)}/status?${params.toString()}`,
  );
}

export function createOciVmImage(instanceId: string, input: { region: string; compartmentId: string; displayName: string; instanceName?: string }) {
  return apiRequest<{ data: { message: string; image: OciCustomImage } }>(`/oci/instances/${encodeURIComponent(instanceId)}/custom-image`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciCustomImage(imageId: string, input: { region: string; compartmentId?: string; imageName: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; image: OciCustomImage } }>(`/oci/custom-images/${encodeURIComponent(imageId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function moveOciVm(instanceId: string, input: { region: string; targetCompartmentId: string }) {
  return apiRequest<{ data: { message: string } }>(`/oci/instances/${encodeURIComponent(instanceId)}/move`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type OciVolumeType = 'block' | 'boot';

export type OciVolumeBackup = {
  id: string;
  name: string;
  region: string;
  compartmentId: string;
  providerType: string;
  resourceType: string;
  status: string;
  createdAt?: string;
  sizeGb?: string | number;
  backupType?: string;
  sourceVolumeId?: string;
};

export type OciVolumeGroupResourceType = 'volumeGroup' | 'volumeGroupBackup' | 'volumeGroupReplica';

export type OciVolumeGroupResource = {
  id: string;
  name: string;
  region: string;
  compartmentId: string;
  providerType: OciVolumeGroupResourceType;
  resourceType: OciVolumeGroupResourceType;
  status: string;
  createdAt?: string;
  sizeGb?: string | number;
  backupType?: string;
  sourceVolumeGroupId?: string;
  availabilityDomain?: string;
  destinationRegion?: string;
  volumeIds?: string[];
};

export type OciFileStorageResource = {
  id: string;
  name: string;
  region: string;
  compartmentId: string;
  providerType: 'fileSystem' | 'mountTarget' | 'export' | 'snapshot';
  resourceType: 'fileSystem' | 'mountTarget' | 'export' | 'snapshot';
  status: string;
  createdAt?: string;
  availabilityDomain?: string;
  fileSystemId?: string;
  mountTargetId?: string;
  exportSetId?: string;
  path?: string;
  sizeGb?: string | number;
  capacityGb?: string | number;
  subnetId?: string;
  privateIpIds?: string[];
  exportOptionsCount?: number;
};

export type OciObjectPrivateEndpoint = {
  id: string;
  name: string;
  region: string;
  compartmentId: string;
  providerType: 'objectPrivateEndpoint';
  resourceType: 'objectPrivateEndpoint';
  status: string;
  createdAt?: string;
  subnetId?: string;
  nsgIds?: string[];
  accessTargets?: Array<{ namespace?: string; bucket?: string; prefix?: string }>;
  accessTargetCount?: number;
  namespace?: string;
  prefix?: string;
};

export type OciNetworkResourcesResponse = {
  generatedAt: string;
  region: string;
  compartmentId: string;
  vcns: ResourceRecord[];
  subnets: ResourceRecord[];
  internetGateways: ResourceRecord[];
  natGateways: ResourceRecord[];
  serviceGateways: ResourceRecord[];
  drgs: ResourceRecord[];
  drgAttachments: ResourceRecord[];
  remotePeeringConnections: ResourceRecord[];
  routeTables: ResourceRecord[];
  securityLists: ResourceRecord[];
  errors: Array<{ scope: string; region?: string; message: string }>;
};

export type OciDatabaseResourcesResponse = {
  generatedAt: string;
  region: string;
  compartmentId: string;
  dbSystems: ResourceRecord[];
  autonomousDatabases: ResourceRecord[];
  autonomousContainerDatabases: ResourceRecord[];
  exadataInfrastructures: ResourceRecord[];
  errors: Array<{ scope: string; region?: string; message: string }>;
};

export type OciDbVersion = {
  version: string;
  isLatest?: boolean;
  supportsPdb?: boolean;
};

export function getOciDatabaseResources(region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: OciDatabaseResourcesResponse }>(`/oci/databases?${params.toString()}`);
}

export function getOciDbVersions(input: { region: string; compartmentId: string; dbSystemShape?: string; storageManagement?: string }) {
  const params = new URLSearchParams({
    region: input.region,
    compartmentId: input.compartmentId,
    dbSystemShape: input.dbSystemShape || '',
    storageManagement: input.storageManagement || '',
  });
  return apiRequest<{ data: { generatedAt: string; versions: OciDbVersion[]; errors: Array<{ scope: string; message: string }> } }>(`/oci/databases/db-versions?${params.toString()}`);
}

export function generateOciSshKeyPair(comment: string) {
  return apiRequest<{ data: { generatedAt: string; comment: string; publicKey: string; privateKey: string } }>('/oci/databases/ssh-keypair', {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });
}

export type CreateOciAutonomousDatabaseInput = {
  region: string;
  compartmentId: string;
  displayName: string;
  dbName: string;
  adminPassword: string;
  dbWorkload: 'OLTP' | 'DW' | 'AJD' | 'APEX';
  licenseModel: string;
  computeCount: string;
  dataStorageSizeInGBs: string;
  dataStorageSizeInTBs?: string;
  isFreeTier: boolean;
};

export function createOciAutonomousDatabase(input: CreateOciAutonomousDatabaseInput) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>('/oci/databases/autonomous', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type CreateOciDbSystemInput = {
  region: string;
  compartmentId: string;
  availabilityDomain: string;
  displayName: string;
  hostnamePrefix: string;
  shape: string;
  subnetId: string;
  databaseEdition: string;
  licenseModel: string;
  dbName: string;
  dbUniqueName: string;
  pdbName: string;
  dbVersion: string;
  adminPassword: string;
  sshPublicKeys: string;
  cpuCoreCount: string;
  nodeCount: string;
  dataStorageSizeInGBs: string;
  storageManagement: string;
  storageVolumePerformanceMode: string;
  characterSet: string;
  ncharacterSet: string;
  sourceDbSystemId?: string;
};

export function createOciDbSystem(input: CreateOciDbSystemInput) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>('/oci/databases/db-systems', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type OciDbSystemNode = ResourceRecord;

export function getOciDbSystemNodes(dbSystemId: string, input: { region: string; compartmentId: string }) {
  const params = new URLSearchParams({ region: input.region, compartmentId: input.compartmentId });
  return apiRequest<{ data: { generatedAt: string; nodes: OciDbSystemNode[]; errors: Array<{ scope: string; message: string }> } }>(`/oci/databases/db-systems/${encodeURIComponent(dbSystemId)}/nodes?${params.toString()}`);
}

export function runOciDbNodeAction(dbSystemId: string, dbNodeId: string, action: 'start' | 'stop', input: { region: string }) {
  return apiRequest<{ data: { message: string; node: OciDbSystemNode } }>(`/oci/databases/db-systems/${encodeURIComponent(dbSystemId)}/nodes/${encodeURIComponent(dbNodeId)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateOciDbSystem(dbSystemId: string, input: { region: string; databaseName?: string; dataStorageSizeInGBs?: string; sshPublicKeys?: string }) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>(`/oci/databases/db-systems/${encodeURIComponent(dbSystemId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteOciDatabase(databaseId: string, input: { region: string; databaseName?: string; resourceType: 'dbSystem' | 'autonomousDatabase'; confirmation: string }) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>(`/oci/databases/${encodeURIComponent(databaseId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export type OciAutonomousDatabaseAction = 'start' | 'stop' | 'restore' | 'switchover';

export function runOciAutonomousDatabaseAction(databaseId: string, action: OciAutonomousDatabaseAction, input: { region: string; databaseName?: string; restoreTimestamp?: string; peerDbId?: string }) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>(`/oci/databases/autonomous/${encodeURIComponent(databaseId)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cloneOciAutonomousDatabase(databaseId: string, input: { region: string; compartmentId: string; displayName: string; dbName: string; adminPassword: string; cloneType: 'FULL' | 'METADATA' }) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>(`/oci/databases/autonomous/${encodeURIComponent(databaseId)}/clone`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type OciDnsResourcesResponse = {
  generatedAt: string;
  region: string;
  compartmentId: string;
  publicZones: ResourceRecord[];
  privateZones: ResourceRecord[];
  views: ResourceRecord[];
  records: ResourceRecord[];
  errors: Array<{ scope: string; region?: string; message: string }>;
};

export function getOciDnsResources(region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: OciDnsResourcesResponse }>(`/oci/dns?${params.toString()}`);
}

export function getOciDnsZoneRecords(zoneId: string, input: { region: string; compartmentId?: string; zoneName?: string; scope?: string; viewId?: string }) {
  const params = new URLSearchParams({
    region: input.region,
    compartmentId: input.compartmentId || '',
    zoneName: input.zoneName || '',
    scope: input.scope || 'GLOBAL',
    viewId: input.viewId || '',
  });
  return apiRequest<{ data: { generatedAt: string; region: string; compartmentId: string; zoneId: string; zoneName: string; scope: string; viewId: string; records: ResourceRecord[]; errors: Array<{ scope: string; region?: string; message: string }> } }>(`/oci/dns/zones/${encodeURIComponent(zoneId)}/records?${params.toString()}`);
}

export function createOciDnsView(input: { region: string; compartmentId: string; displayName: string }) {
  return apiRequest<{ data: { message: string; view: ResourceRecord } }>('/oci/dns/views', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createOciDnsZone(input: { region: string; compartmentId: string; name: string; scope: 'GLOBAL' | 'PRIVATE'; viewId?: string }) {
  return apiRequest<{ data: { message: string; zone: ResourceRecord } }>('/oci/dns/zones', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciDnsZone(zoneId: string, input: { region: string; zoneName?: string; scope?: string; viewId?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; zone: ResourceRecord } }>(`/oci/dns/zones/${encodeURIComponent(zoneId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function upsertOciDnsRecord(zoneId: string, input: { region: string; compartmentId?: string; zoneName?: string; scope?: string; viewId?: string; domain: string; rtype: string; rdata: string; ttl: string | number }) {
  return apiRequest<{ data: { message: string; record: ResourceRecord } }>(`/oci/dns/zones/${encodeURIComponent(zoneId)}/records`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteOciDnsRecord(zoneId: string, input: { region: string; zoneName?: string; scope?: string; viewId?: string; domain: string; rtype: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; record: ResourceRecord } }>(`/oci/dns/zones/${encodeURIComponent(zoneId)}/records`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function getOciNetworkResources(region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: OciNetworkResourcesResponse }>(`/oci/network?${params.toString()}`);
}

export function createOciVcn(input: { region: string; compartmentId: string; displayName: string; cidrBlock: string; dnsLabel?: string }) {
  return apiRequest<{ data: { message: string; vcn: ResourceRecord } }>('/oci/network/vcns', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciVcn(vcnId: string, input: { region: string; vcnName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; vcn: ResourceRecord } }>(`/oci/network/vcns/${encodeURIComponent(vcnId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function createOciSubnet(input: { region: string; compartmentId: string; vcnId: string; displayName: string; cidrBlock: string; availabilityDomain?: string; routeTableId?: string; securityListIds?: string[] }) {
  return apiRequest<{ data: { message: string; subnet: ResourceRecord } }>('/oci/network/subnets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciSubnet(subnetId: string, input: { region: string; subnetName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; subnet: ResourceRecord } }>(`/oci/network/subnets/${encodeURIComponent(subnetId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function createOciGateway(input: { region: string; compartmentId: string; vcnId: string; displayName: string; gatewayType: 'internetGateway' | 'natGateway' | 'serviceGateway' }) {
  return apiRequest<{ data: { message: string; gateway: ResourceRecord } }>('/oci/network/gateways', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createOciDrg(input: { region: string; compartmentId: string; displayName: string }) {
  return apiRequest<{ data: { message: string; drg: ResourceRecord } }>('/oci/network/drgs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciDrg(drgId: string, input: { region: string; drgName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; drg: ResourceRecord } }>(`/oci/network/drgs/${encodeURIComponent(drgId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function createOciDrgAttachment(input: { region: string; compartmentId: string; drgId: string; vcnId: string; displayName: string }) {
  return apiRequest<{ data: { message: string; attachment: ResourceRecord } }>('/oci/network/drg-attachments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciDrgAttachment(attachmentId: string, input: { region: string; attachmentName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; attachment: ResourceRecord } }>(`/oci/network/drg-attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function createOciRemotePeeringConnection(input: { region: string; compartmentId: string; drgId: string; displayName: string }) {
  return apiRequest<{ data: { message: string; connection: ResourceRecord } }>('/oci/network/remote-peering-connections', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function connectOciRemotePeeringConnection(connectionId: string, input: { region: string; peerId: string; peerRegionName: string }) {
  return apiRequest<{ data: { message: string; connection: ResourceRecord } }>(`/oci/network/remote-peering-connections/${encodeURIComponent(connectionId)}/connect`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciRemotePeeringConnection(connectionId: string, input: { region: string; connectionName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; connection: ResourceRecord } }>(`/oci/network/remote-peering-connections/${encodeURIComponent(connectionId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function createOciRouteTable(input: { region: string; compartmentId: string; vcnId: string; displayName: string; destinationCidrBlock: string; networkEntityId: string }) {
  return apiRequest<{ data: { message: string; routeTable: ResourceRecord } }>('/oci/network/route-tables', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createOciSecurityList(input: { region: string; compartmentId: string; vcnId: string; displayName: string; direction: 'ingress' | 'egress'; protocol: string; source?: string; destination?: string; tcpPort?: string }) {
  return apiRequest<{ data: { message: string; securityList: ResourceRecord } }>('/oci/network/security-lists', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getOciObjectStorageResources(region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: { generatedAt: string; region: string; compartmentId: string; namespace: string; buckets: ResourceRecord[]; privateEndpoints: OciObjectPrivateEndpoint[]; errors: Array<{ scope: string; region?: string; message: string }> } }>(
    `/oci/object-storage?${params.toString()}`,
  );
}

export function createOciBucket(input: { region: string; compartmentId: string; name: string; storageTier: string; publicAccessType: string; objectEventsEnabled: boolean }) {
  return apiRequest<{ data: { message: string; bucket: ResourceRecord } }>('/oci/object-storage/buckets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteOciBucket(bucketName: string, input: { region: string; compartmentId?: string; namespace?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; bucket: ResourceRecord } }>(`/oci/object-storage/buckets/${encodeURIComponent(bucketName)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function getOciVolumeBackups(volumeType: OciVolumeType, volumeId: string, region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: { generatedAt: string; region: string; compartmentId: string; volumeId: string; backups: OciVolumeBackup[]; errors: Array<{ scope: string; region?: string; message: string }> } }>(
    `/oci/volumes/${volumeType}/${encodeURIComponent(volumeId)}/backups?${params.toString()}`,
  );
}

export function getOciVolumeBackupsForCompartment(volumeType: OciVolumeType, region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: { generatedAt: string; region: string; compartmentId: string; volumeId: string; backups: OciVolumeBackup[]; errors: Array<{ scope: string; region?: string; message: string }> } }>(
    `/oci/volumes/${volumeType}/backups?${params.toString()}`,
  );
}

export function getOciVolumeGroupResources(resourceType: OciVolumeGroupResourceType, region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: { generatedAt: string; region: string; compartmentId: string; resourceType: OciVolumeGroupResourceType; resources: OciVolumeGroupResource[]; errors: Array<{ scope: string; region?: string; message: string }> } }>(
    `/oci/volume-groups/${resourceType}?${params.toString()}`,
  );
}

export function getOciFileStorageResources(region: string, compartmentId: string) {
  const params = new URLSearchParams({ region, compartmentId });
  return apiRequest<{ data: { generatedAt: string; region: string; compartmentId: string; fileSystems: OciFileStorageResource[]; mountTargets: OciFileStorageResource[]; exports: OciFileStorageResource[]; snapshots: OciFileStorageResource[]; errors: Array<{ scope: string; region?: string; message: string }> } }>(
    `/oci/file-storage?${params.toString()}`,
  );
}

export function createOciFileSystem(input: { region: string; compartmentId: string; availabilityDomain: string; displayName: string }) {
  return apiRequest<{ data: { message: string; fileSystem: OciFileStorageResource } }>('/oci/file-storage/file-systems', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createOciMountTarget(input: { region: string; compartmentId: string; availabilityDomain: string; subnetId: string; displayName: string; hostnameLabel?: string }) {
  return apiRequest<{ data: { message: string; mountTarget: OciFileStorageResource } }>('/oci/file-storage/mount-targets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function backupOciVolume(volumeType: OciVolumeType, volumeId: string, input: { region: string; volumeName?: string; displayName: string; type: 'FULL' | 'INCREMENTAL' }) {
  return apiRequest<{ data: { message: string; backup: ResourceRecord } }>(`/oci/volumes/${volumeType}/${encodeURIComponent(volumeId)}/backup`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cloneOciVolume(volumeType: OciVolumeType, volumeId: string, input: { region: string; displayName: string; compartmentId: string; availabilityDomain: string; sizeGb?: string }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>(`/oci/volumes/${volumeType}/${encodeURIComponent(volumeId)}/clone`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function restoreOciVolume(volumeType: OciVolumeType, input: { region: string; backupId: string; displayName: string; compartmentId: string; availabilityDomain: string; sizeGb?: string }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>(`/oci/volumes/${volumeType}/restore`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function resizeOciVolume(volumeType: OciVolumeType, volumeId: string, input: { region: string; volumeName?: string; compartmentId?: string; availabilityDomain?: string; sizeGb: string; currentSizeGb?: string }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>(`/oci/volumes/${volumeType}/${encodeURIComponent(volumeId)}/resize`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteOciVolumeBackup(volumeType: OciVolumeType, backupId: string, input: { region: string; backupName?: string; sourceVolumeId?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; backup: OciVolumeBackup } }>(`/oci/volumes/${volumeType}/backups/${encodeURIComponent(backupId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}
