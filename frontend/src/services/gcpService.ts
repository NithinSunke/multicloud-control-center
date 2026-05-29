import { apiRequest } from './api';
import type { ResourceRecord } from '../types/dashboard';

export type GcpInventory = {
  generatedAt: string;
  cached?: boolean;
  cachedAt?: string;
  cacheMiss?: boolean;
  scanStatus: 'cached' | 'partial' | 'failed' | 'scan running';
  connector: {
    id: string;
    name: string;
    projectId: string;
    projectName: string;
    projectNumber?: string;
  };
  scan: {
    requestedScope: string;
    projectId: string;
    scannedRegions: string[];
    scannedZones: string[];
  };
  summary: Record<string, number>;
  projects: ResourceRecord[];
  regions: ResourceRecord[];
  zones: ResourceRecord[];
  networks: ResourceRecord[];
  subnets: ResourceRecord[];
  firewallRules: ResourceRecord[];
  routes: ResourceRecord[];
  routers: ResourceRecord[];
  externalIps: ResourceRecord[];
  instances: ResourceRecord[];
  disks: ResourceRecord[];
  snapshots: ResourceRecord[];
  images: ResourceRecord[];
  buckets: ResourceRecord[];
  sqlInstances: ResourceRecord[];
  sqlDatabases: ResourceRecord[];
  gkeClusters: ResourceRecord[];
  loadBalancers: ResourceRecord[];
  serviceAccounts: ResourceRecord[];
  tags: Array<{ key: string; value: string }>;
  allResources: ResourceRecord[];
  errors: Array<{ scope: string; message: string }>;
};

export function getGcpInventory(refresh = false) {
  const params = new URLSearchParams();
  if (refresh) {
    params.set('refresh', 'true');
  }
  return apiRequest<{ data: GcpInventory }>(`/gcp/inventory?${params.toString()}`);
}

export type GcpInstanceAction = 'start' | 'stop' | 'reset' | 'reboot';

export type GcpCreateInstanceInput = {
  zone: string;
  name: string;
  machineType: string;
  sourceImage?: string;
  sourceSnapshot?: string;
  sourceDisk?: string;
  diskSizeGb?: string | number;
  diskType?: string;
  network: string;
  subnetwork?: string;
  assignPublicIp?: boolean;
  networkTags?: string[];
  hostname?: string;
  ipForwarding?: boolean;
  serviceAccountEmail?: string;
  labels?: Record<string, string>;
  acceptCostWarning: boolean;
  autoDeleteBootDisk?: boolean;
};

export function createGcpInstance(payload: GcpCreateInstanceInput) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>('/gcp/instances', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runGcpInstanceAction(instanceName: string, action: GcpInstanceAction, payload: { zone: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>(`/gcp/instances/${encodeURIComponent(instanceName)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getGcpInstanceStatus(instanceName: string, zone: string) {
  const params = new URLSearchParams({ zone });
  return apiRequest<{ data: { generatedAt: string; instance: ResourceRecord } }>(`/gcp/instances/${encodeURIComponent(instanceName)}/status?${params.toString()}`);
}

export function deleteGcpInstance(instanceName: string, payload: { zone: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>(`/gcp/instances/${encodeURIComponent(instanceName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function resizeGcpInstance(instanceName: string, payload: { zone: string; machineType: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>(`/gcp/instances/${encodeURIComponent(instanceName)}/type`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function createGcpMachineImage(instanceName: string, payload: { zone: string; name: string; description?: string }) {
  return apiRequest<{ data: { message: string; image: ResourceRecord; operation: ResourceRecord } }>(`/gcp/instances/${encodeURIComponent(instanceName)}/machine-images`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createGcpDiskSnapshot(diskName: string, payload: { zone: string; name: string; description?: string }) {
  return apiRequest<{ data: { message: string; snapshot: ResourceRecord; operation: ResourceRecord } }>(`/gcp/disks/${encodeURIComponent(diskName)}/snapshots`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function attachGcpDisk(instanceName: string, payload: { zone: string; disk: string; deviceName?: string; mode?: 'READ_WRITE' | 'READ_ONLY' }) {
  return apiRequest<{ data: { message: string; disk: ResourceRecord; operation: ResourceRecord } }>(`/gcp/instances/${encodeURIComponent(instanceName)}/disks`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function detachGcpDisk(instanceName: string, deviceName: string, payload: { zone: string }) {
  return apiRequest<{ data: { message: string; disk: ResourceRecord; operation: ResourceRecord } }>(`/gcp/instances/${encodeURIComponent(instanceName)}/disks/${encodeURIComponent(deviceName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export type GcpStorageObject = ResourceRecord & {
  key?: string;
  bucketName?: string;
  sizeBytes?: string | number;
  contentType?: string;
  eTag?: string;
};

export function createGcpDisk(payload: { zone: string; name: string; sizeGb: string | number; type?: string; sourceSnapshot?: string; labels?: Record<string, string> }) {
  return apiRequest<{ data: { message: string; disk: ResourceRecord; operation: ResourceRecord } }>('/gcp/disks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function resizeGcpDisk(diskName: string, payload: { zone: string; sizeGb: string | number }) {
  return apiRequest<{ data: { message: string; disk: ResourceRecord; operation: ResourceRecord } }>(`/gcp/disks/${encodeURIComponent(diskName)}/resize`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteGcpDisk(diskName: string, payload: { zone: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; disk: ResourceRecord; operation: ResourceRecord } }>(`/gcp/disks/${encodeURIComponent(diskName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createGcpBucket(payload: { name: string; location: string; storageClass?: string; publicAccessPrevention?: string; uniformBucketLevelAccess?: boolean; versioning?: boolean; labels?: Record<string, string> }) {
  return apiRequest<{ data: { message: string; bucket: ResourceRecord } }>('/gcp/buckets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteGcpBucket(bucketName: string, payload: { confirmation: string }) {
  return apiRequest<{ data: { message: string; bucket: ResourceRecord } }>(`/gcp/buckets/${encodeURIComponent(bucketName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function listGcpBucketObjects(bucketName: string, input: { prefix?: string; maxResults?: string | number } = {}) {
  const params = new URLSearchParams();
  if (input.prefix) params.set('prefix', input.prefix);
  if (input.maxResults) params.set('maxResults', String(input.maxResults));
  return apiRequest<{ data: { generatedAt: string; bucketName: string; objects: GcpStorageObject[] } }>(`/gcp/buckets/${encodeURIComponent(bucketName)}/objects?${params.toString()}`);
}

export function uploadGcpBucketObject(bucketName: string, payload: { objectName: string; content: string; contentType?: string }) {
  return apiRequest<{ data: { message: string; object: GcpStorageObject } }>(`/gcp/buckets/${encodeURIComponent(bucketName)}/objects`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteGcpBucketObject(bucketName: string, payload: { objectName: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; object: GcpStorageObject } }>(`/gcp/buckets/${encodeURIComponent(bucketName)}/objects`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createGcpVpc(payload: { name: string; autoCreateSubnetworks?: boolean; routingMode?: string; description?: string }) {
  return apiRequest<{ data: { message: string; network: ResourceRecord; operation: ResourceRecord } }>('/gcp/networks/vpcs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteGcpVpc(vpcName: string, payload: { confirmation: string }) {
  return apiRequest<{ data: { message: string; network: ResourceRecord; operation: ResourceRecord } }>(`/gcp/networks/vpcs/${encodeURIComponent(vpcName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createGcpSubnet(payload: { name: string; region: string; network: string; cidrBlock: string; privateIpGoogleAccess?: boolean; description?: string }) {
  return apiRequest<{ data: { message: string; subnet: ResourceRecord; operation: ResourceRecord } }>('/gcp/networks/subnets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteGcpSubnet(subnetName: string, payload: { region: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; subnet: ResourceRecord; operation: ResourceRecord } }>(`/gcp/networks/subnets/${encodeURIComponent(subnetName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createGcpFirewallRule(payload: { name: string; network: string; direction: string; protocol: string; ports?: string; sourceRanges?: string; destinationRanges?: string; priority?: string | number; targetTags?: string; disabled?: boolean; description?: string }) {
  return apiRequest<{ data: { message: string; firewallRule: ResourceRecord; operation: ResourceRecord } }>('/gcp/networks/firewall-rules', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteGcpFirewallRule(firewallName: string, payload: { confirmation: string }) {
  return apiRequest<{ data: { message: string; firewallRule: ResourceRecord; operation: ResourceRecord } }>(`/gcp/networks/firewall-rules/${encodeURIComponent(firewallName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function createGcpRoute(payload: { name: string; network: string; destRange: string; priority?: string | number; nextHopType?: string; nextHopGateway?: string; nextHopIp?: string; tags?: string; description?: string }) {
  return apiRequest<{ data: { message: string; route: ResourceRecord; operation: ResourceRecord } }>('/gcp/networks/routes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteGcpRoute(routeName: string, payload: { confirmation: string }) {
  return apiRequest<{ data: { message: string; route: ResourceRecord; operation: ResourceRecord } }>(`/gcp/networks/routes/${encodeURIComponent(routeName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function reserveGcpExternalIp(payload: { name: string; region: string; networkTier?: string; description?: string; acceptCostWarning: boolean }) {
  return apiRequest<{ data: { message: string; address: ResourceRecord; operation: ResourceRecord } }>('/gcp/networks/external-ips', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function releaseGcpExternalIp(addressName: string, payload: { region: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; address: ResourceRecord; operation: ResourceRecord } }>(`/gcp/networks/external-ips/${encodeURIComponent(addressName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export type GcpSqlAction = 'start' | 'stop' | 'restart';

export type GcpCreateSqlInstanceInput = {
  name: string;
  region: string;
  databaseVersion: string;
  tier: string;
  storageSizeGb: string | number;
  storageType?: string;
  rootPassword?: string;
  privateNetwork?: string;
  ipv4Enabled?: boolean;
  backupEnabled?: boolean;
  labels?: Record<string, string>;
  acceptCostWarning: boolean;
};

export type GcpSqlBackup = ResourceRecord & {
  backupRunId?: string | number;
  backupKind?: string;
  instanceId?: string;
};

export function createGcpSqlInstance(payload: GcpCreateSqlInstanceInput) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>('/gcp/sql/instances', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runGcpSqlInstanceAction(instanceName: string, action: GcpSqlAction) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>(`/gcp/sql/instances/${encodeURIComponent(instanceName)}/actions/${action}`, {
    method: 'POST',
  });
}

export function getGcpSqlInstanceStatus(instanceName: string) {
  return apiRequest<{ data: { generatedAt: string; instance: ResourceRecord } }>(`/gcp/sql/instances/${encodeURIComponent(instanceName)}/status`);
}

export function deleteGcpSqlInstance(instanceName: string, payload: { confirmation: string }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>(`/gcp/sql/instances/${encodeURIComponent(instanceName)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

export function listGcpSqlBackups(instanceName: string) {
  return apiRequest<{ data: { generatedAt: string; instanceName: string; backups: GcpSqlBackup[] } }>(`/gcp/sql/instances/${encodeURIComponent(instanceName)}/backups`);
}

export function createGcpSqlBackup(instanceName: string, payload: { description?: string } = {}) {
  return apiRequest<{ data: { message: string; backup: GcpSqlBackup } }>(`/gcp/sql/instances/${encodeURIComponent(instanceName)}/backups`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function restoreGcpSqlBackup(instanceName: string, payload: { backupRunId: string | number }) {
  return apiRequest<{ data: { message: string; instance: ResourceRecord; operation: ResourceRecord } }>(`/gcp/sql/instances/${encodeURIComponent(instanceName)}/restore`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
