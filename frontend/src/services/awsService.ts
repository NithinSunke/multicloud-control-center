import { apiRequest } from './api';
import type { ResourceRecord } from '../types/dashboard';

export type AwsRegion = {
  name: string;
  endpoint?: string;
  status?: string;
};

export type AwsInventory = {
  generatedAt: string;
  cached?: boolean;
  cacheMiss?: boolean;
  cachedAt?: string;
  connector: {
    id: string;
    name: string;
    region: string;
    accountId?: string;
  };
  scan: {
    requestedRegion: string;
    scannedRegions: string[];
  };
  summary: {
    regions: number;
    instances: number;
    runningInstances: number;
    stoppedInstances: number;
    vpcs: number;
    subnets: number;
    securityGroups: number;
    routeTables: number;
    internetGateways: number;
    natGateways: number;
    ebsVolumes: number;
    ebsSnapshots: number;
    s3Buckets: number;
    rdsDatabases: number;
    loadBalancers: number;
    elasticIps: number;
  };
  regions: AwsRegion[];
  instances: ResourceRecord[];
  vpcs: ResourceRecord[];
  subnets: ResourceRecord[];
  securityGroups: ResourceRecord[];
  routeTables: ResourceRecord[];
  internetGateways: ResourceRecord[];
  natGateways: ResourceRecord[];
  ebsVolumes: ResourceRecord[];
  ebsSnapshots: ResourceRecord[];
  s3Buckets: ResourceRecord[];
  rdsDatabases: ResourceRecord[];
  loadBalancers: ResourceRecord[];
  elasticIps: ResourceRecord[];
  iamSummary: Record<string, number | string>;
  errors: Array<{ scope: string; region?: string; message: string }>;
};

export type AwsImage = {
  id: string;
  name: string;
  description?: string;
  status?: string;
  region: string;
  architecture?: string;
  platform?: string;
  ownerId?: string;
  rootDeviceType?: string;
  virtualizationType?: string;
  enaSupport?: string;
  createdAt?: string;
};

export type AwsKeyPair = {
  id?: string;
  name: string;
  fingerprint?: string;
  region: string;
  providerType?: string;
  resourceType?: string;
};

export type AwsS3Object = ResourceRecord & {
  key?: string;
  bucketName?: string;
  sizeBytes?: string | number;
  eTag?: string;
  lastModified?: string;
  contentType?: string;
  content?: string;
};

export type AwsRdsSnapshot = ResourceRecord & {
  dbInstanceId?: string;
  snapshotType?: string;
};

export type AwsNetworkMapNode = {
  id: string;
  type: string;
  label: string;
  region?: string;
  status?: string;
  cidrBlock?: string;
};

export type AwsNetworkMapEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
};

export type AwsNetworkMap = {
  generatedAt: string;
  region: string;
  vpcId?: string;
  message?: string;
  nodes: AwsNetworkMapNode[];
  edges: AwsNetworkMapEdge[];
};

export function getAwsInventory(refresh = false, region = 'all') {
  const params = new URLSearchParams({
    refresh: String(refresh),
    region,
  });
  return apiRequest<{ data: AwsInventory }>(`/aws/inventory?${params.toString()}`);
}

export function getAwsImages(region: string, search = '') {
  const params = new URLSearchParams({ region });
  if (search.trim()) {
    params.set('search', search.trim());
  }
  return apiRequest<{ data: { generatedAt: string; region: string; images: AwsImage[] } }>(`/aws/images?${params.toString()}`);
}

export function getAwsKeyPairs(region: string) {
  const params = new URLSearchParams({ region });
  return apiRequest<{ data: { generatedAt: string; region: string; keyPairs: AwsKeyPair[] } }>(`/aws/key-pairs?${params.toString()}`);
}

export function createAwsKeyPair(payload: { region: string; name: string }) {
  return apiRequest<{ data: { message: string; keyPair: AwsKeyPair; privateKeyMaterial: string } }>('/aws/key-pairs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export type AwsInstanceAction = 'start' | 'stop' | 'reboot';

export type AwsCreateInstanceInput = {
  region: string;
  scanRegion?: string;
  name: string;
  imageId: string;
  instanceType: string;
  subnetId: string;
  securityGroupIds: string[];
  keyName?: string;
};

export function createAwsInstance(payload: AwsCreateInstanceInput) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord } }>('/aws/instances', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runAwsInstanceAction(instanceId: string, action: AwsInstanceAction, payload: { region: string; scanRegion?: string; instanceName?: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord } }>(`/aws/instances/${encodeURIComponent(instanceId)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getAwsInstanceStatus(instanceId: string, region: string, scanRegion = 'all') {
  const params = new URLSearchParams({ region, scanRegion });
  return apiRequest<{ data: { generatedAt: string; instance: ResourceRecord } }>(`/aws/instances/${encodeURIComponent(instanceId)}/status?${params.toString()}`);
}

export function getAwsRouteTable(routeTableId: string, region: string, scanRegion = 'all') {
  const params = new URLSearchParams({ region, scanRegion });
  return apiRequest<{ data: { generatedAt: string; routeTable: ResourceRecord } }>(`/aws/route-tables/${encodeURIComponent(routeTableId)}?${params.toString()}`);
}

export function getAwsRdsInstance(dbInstanceIdentifier: string, region: string, scanRegion = 'all') {
  const params = new URLSearchParams({ region, scanRegion });
  return apiRequest<{ data: { generatedAt: string; database: ResourceRecord } }>(`/aws/rds/instances/${encodeURIComponent(dbInstanceIdentifier)}?${params.toString()}`);
}

export function listAwsRdsSnapshots(input: { region: string; dbInstanceIdentifier?: string; snapshotType?: string }) {
  const params = new URLSearchParams({ region: input.region });
  if (input.dbInstanceIdentifier) params.set('dbInstanceIdentifier', input.dbInstanceIdentifier);
  if (input.snapshotType) params.set('snapshotType', input.snapshotType);
  return apiRequest<{ data: { generatedAt: string; region: string; snapshots: AwsRdsSnapshot[] } }>(`/aws/rds/snapshots?${params.toString()}`);
}

export function createAwsRdsInstance(payload: {
  region: string;
  scanRegion?: string;
  dbInstanceIdentifier: string;
  dbInstanceClass: string;
  engine: string;
  engineVersion?: string;
  allocatedStorage: string | number;
  masterUsername: string;
  masterUserPassword: string;
  dbName?: string;
  storageType?: string;
  dbSubnetGroupName?: string;
  vpcSecurityGroupIds?: string[];
  publiclyAccessible?: boolean;
  backupRetentionPeriod?: string | number;
  multiAz?: boolean;
}) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>('/aws/rds/instances', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runAwsRdsAction(dbInstanceIdentifier: string, action: 'start' | 'stop', payload: { region: string; scanRegion?: string; dbInstanceName?: string }) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>(`/aws/rds/instances/${encodeURIComponent(dbInstanceIdentifier)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createAwsRdsSnapshot(dbInstanceIdentifier: string, payload: { region: string; snapshotIdentifier: string }) {
  return apiRequest<{ data: { message: string; snapshot: AwsRdsSnapshot } }>(`/aws/rds/instances/${encodeURIComponent(dbInstanceIdentifier)}/snapshots`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsRdsSnapshot(snapshotIdentifier: string, payload: { region: string; snapshotName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; snapshot: AwsRdsSnapshot } }>(`/aws/rds/snapshots/${encodeURIComponent(snapshotIdentifier)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function restoreAwsRdsInstance(payload: { region: string; scanRegion?: string; dbInstanceIdentifier: string; snapshotIdentifier: string; dbInstanceClass?: string; dbSubnetGroupName?: string; publiclyAccessible?: boolean }) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>('/aws/rds/restore', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsRdsInstance(dbInstanceIdentifier: string, payload: { region: string; scanRegion?: string; dbInstanceName?: string; confirmation: string; skipFinalSnapshot?: boolean; finalSnapshotIdentifier?: string }) {
  return apiRequest<{ data: { message: string; database: ResourceRecord } }>(`/aws/rds/instances/${encodeURIComponent(dbInstanceIdentifier)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function terminateAwsInstance(instanceId: string, payload: { region: string; scanRegion?: string; instanceName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord } }>(`/aws/instances/${encodeURIComponent(instanceId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAwsInstanceImage(instanceId: string, payload: { region: string; name: string; description?: string; noReboot?: boolean }) {
  return apiRequest<{ data: { message: string; imageId: string } }>(`/aws/instances/${encodeURIComponent(instanceId)}/ami`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function changeAwsInstanceType(instanceId: string, payload: { region: string; scanRegion?: string; instanceType: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord } }>(`/aws/instances/${encodeURIComponent(instanceId)}/type`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function attachAwsVolume(instanceId: string, payload: { region: string; scanRegion?: string; volumeId: string; device: string }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>(`/aws/instances/${encodeURIComponent(instanceId)}/volumes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function detachAwsVolume(instanceId: string, volumeId: string, payload: { region: string; scanRegion?: string; device?: string; force?: boolean }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>(`/aws/instances/${encodeURIComponent(instanceId)}/volumes/${encodeURIComponent(volumeId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function getAwsNetworkMap(input: { region: string; vpcId?: string }) {
  const params = new URLSearchParams({ region: input.region || 'all' });
  if (input.vpcId) {
    params.set('vpcId', input.vpcId);
  }
  return apiRequest<{ data: AwsNetworkMap }>(`/aws/network-map?${params.toString()}`);
}

export function createAwsVpc(payload: { region: string; scanRegion?: string; name?: string; cidrBlock: string }) {
  return apiRequest<{ data: { message: string; vpc: ResourceRecord } }>('/aws/vpcs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsVpc(vpcId: string, payload: { region: string; scanRegion?: string; resourceName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; vpc: ResourceRecord } }>(`/aws/vpcs/${encodeURIComponent(vpcId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAwsSubnet(payload: { region: string; scanRegion?: string; name?: string; vpcId: string; cidrBlock: string; availabilityZone?: string }) {
  return apiRequest<{ data: { message: string; subnet: ResourceRecord } }>('/aws/subnets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsSubnet(subnetId: string, payload: { region: string; scanRegion?: string; resourceName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; subnet: ResourceRecord } }>(`/aws/subnets/${encodeURIComponent(subnetId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAwsRouteTable(payload: { region: string; scanRegion?: string; name?: string; vpcId: string }) {
  return apiRequest<{ data: { message: string; routeTable: ResourceRecord } }>('/aws/route-tables', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsRouteTable(routeTableId: string, payload: { region: string; scanRegion?: string; resourceName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; routeTable: ResourceRecord } }>(`/aws/route-tables/${encodeURIComponent(routeTableId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAwsInternetGateway(payload: { region: string; scanRegion?: string; name?: string; vpcId?: string }) {
  return apiRequest<{ data: { message: string; internetGateway: ResourceRecord } }>('/aws/internet-gateways', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsInternetGateway(internetGatewayId: string, payload: { region: string; scanRegion?: string; resourceName?: string; vpcId?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; internetGateway: ResourceRecord } }>(`/aws/internet-gateways/${encodeURIComponent(internetGatewayId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAwsNatGateway(payload: { region: string; scanRegion?: string; name?: string; subnetId: string; allocationId: string }) {
  return apiRequest<{ data: { message: string; natGateway: ResourceRecord } }>('/aws/nat-gateways', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsNatGateway(natGatewayId: string, payload: { region: string; scanRegion?: string; resourceName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; natGateway: ResourceRecord } }>(`/aws/nat-gateways/${encodeURIComponent(natGatewayId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function updateAwsSecurityGroupRule(groupId: string, payload: { region: string; scanRegion?: string; operation: 'authorize' | 'revoke'; direction: 'ingress' | 'egress'; protocol: string; fromPort?: string | number; toPort?: string | number; cidrIp?: string; sourceGroupId?: string; description?: string }) {
  return apiRequest<{ data: { message: string; securityGroup: ResourceRecord } }>(`/aws/security-groups/${encodeURIComponent(groupId)}/rules`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createAwsVolume(payload: { region: string; scanRegion?: string; availabilityZone: string; sizeGb: number | string; volumeType?: string; name?: string; snapshotId?: string }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>('/aws/volumes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function resizeAwsVolume(volumeId: string, payload: { region: string; scanRegion?: string; sizeGb: number | string }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>(`/aws/volumes/${encodeURIComponent(volumeId)}/size`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsVolume(volumeId: string, payload: { region: string; scanRegion?: string; volumeName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; volume: ResourceRecord } }>(`/aws/volumes/${encodeURIComponent(volumeId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAwsSnapshot(volumeId: string, payload: { region: string; scanRegion?: string; name?: string; description?: string }) {
  return apiRequest<{ data: { message: string; snapshot: ResourceRecord } }>(`/aws/volumes/${encodeURIComponent(volumeId)}/snapshots`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsSnapshot(snapshotId: string, payload: { region: string; scanRegion?: string; snapshotName?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; snapshot: ResourceRecord } }>(`/aws/snapshots/${encodeURIComponent(snapshotId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createAwsBucket(payload: { region: string; scanRegion?: string; bucketName: string }) {
  return apiRequest<{ data: { message: string; bucket: ResourceRecord } }>('/aws/buckets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsBucket(bucketName: string, payload: { region: string; scanRegion?: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; bucket: ResourceRecord } }>(`/aws/buckets/${encodeURIComponent(bucketName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function updateAwsBucketVersioning(bucketName: string, payload: { region: string; scanRegion?: string; enabled: boolean }) {
  return apiRequest<{ data: { message: string; bucket: ResourceRecord } }>(`/aws/buckets/${encodeURIComponent(bucketName)}/versioning`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function listAwsBucketObjects(bucketName: string, input: { region: string; prefix?: string; maxKeys?: number }) {
  const params = new URLSearchParams({ region: input.region });
  if (input.prefix) {
    params.set('prefix', input.prefix);
  }
  if (input.maxKeys) {
    params.set('maxKeys', String(input.maxKeys));
  }
  return apiRequest<{ data: { generatedAt: string; bucketName: string; region: string; prefix: string; objects: AwsS3Object[] } }>(
    `/aws/buckets/${encodeURIComponent(bucketName)}/objects?${params.toString()}`,
  );
}

export function getAwsBucketObject(bucketName: string, input: { region: string; key: string }) {
  const params = new URLSearchParams({ region: input.region, key: input.key });
  return apiRequest<{ data: { generatedAt: string; bucketName: string; region: string; object: AwsS3Object } }>(
    `/aws/buckets/${encodeURIComponent(bucketName)}/object?${params.toString()}`,
  );
}

export function putAwsBucketObject(bucketName: string, payload: { region: string; key: string; content: string; contentType?: string }) {
  return apiRequest<{ data: { message: string; object: AwsS3Object } }>(`/aws/buckets/${encodeURIComponent(bucketName)}/objects`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteAwsBucketObject(bucketName: string, payload: { region: string; key: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; object: AwsS3Object } }>(`/aws/buckets/${encodeURIComponent(bucketName)}/objects`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}
