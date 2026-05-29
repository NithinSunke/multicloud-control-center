import { apiRequest } from './api';
import type { DashboardData } from '../types/dashboard';

export function getDashboard() {
  return apiRequest<{ data: DashboardData }>('/proxmox/dashboard');
}

export function getTerraformStacks() {
  return apiRequest<{ data: { stacks: TerraformStack[] } }>('/proxmox/terraform-stacks');
}

export async function uploadTerraformStack({ file, name, description }: { file: File; name: string; description: string }) {
  const query = new URLSearchParams({ name, description });
  const response = await fetch(`/api/proxmox/terraform-stacks/upload?${query.toString()}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/zip',
    },
    body: file,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Terraform stack upload failed.' }));
    throw new Error(error.message || 'Terraform stack upload failed.');
  }

  return response.json() as Promise<{ data: { stack: TerraformStack; message: string } }>;
}

export function validateTerraformStack(stackId: string) {
  return apiRequest<{ data: TerraformStackActionResult }>(`/proxmox/terraform-stacks/${encodeURIComponent(stackId)}/validate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function deployTerraformStack(stackId: string, confirmation: string) {
  return apiRequest<{ data: TerraformStackActionResult }>(`/proxmox/terraform-stacks/${encodeURIComponent(stackId)}/deploy`, {
    method: 'POST',
    body: JSON.stringify({ confirmation }),
  });
}

export function destroyTerraformStack(stackId: string, confirmation: string) {
  return apiRequest<{ data: TerraformStackActionResult }>(`/proxmox/terraform-stacks/${encodeURIComponent(stackId)}/destroy`, {
    method: 'POST',
    body: JSON.stringify({ confirmation }),
  });
}

export function deleteTerraformStack(stackId: string, confirmation: string) {
  return apiRequest<void>(`/proxmox/terraform-stacks/${encodeURIComponent(stackId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  });
}

export type ResourceAction = 'start' | 'shutdown' | 'stop' | 'reboot' | 'suspend';

export type OperationResult = {
  action: ResourceAction | 'clone' | 'create' | 'create-container' | 'delete' | 'template' | 'backup' | 'restore';
  success: boolean;
  taskId: string;
  task: {
    status: string;
    exitstatus?: string;
  };
  resource: Record<string, unknown>;
  message: string;
};

export type TerraformStack = {
  id: string;
  name: string;
  description: string;
  status: 'uploaded' | 'running' | 'succeeded' | 'failed' | string;
  lastAction: string;
  lastMessage: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  workingDir: string;
  terraformFiles: string[];
  lastOutput: string[];
};

export type TerraformStackActionResult = {
  stack: TerraformStack;
  job: ProxmoxTask;
  message: string;
};

export type CreateVmInput = {
  node: string;
  vmid: number;
  name: string;
  storage: string;
  diskSizeGb: number;
  cores: number;
  sockets: number;
  memoryMb: number;
  bridge: string;
  iso: string;
  ostype: string;
  scsihw: string;
  description: string;
  startAfterCreate: boolean;
};

export type CreateContainerInput = {
  node: string;
  vmid: number;
  hostname: string;
  storage: string;
  template: string;
  diskSizeGb: number;
  cores: number;
  memoryMb: number;
  swapMb: number;
  bridge: string;
  password: string;
  unprivileged: boolean;
  startAfterCreate: boolean;
};

export type CloneVmInput = {
  node: string;
  vmid: number;
  newid: number;
  name: string;
  target: string;
  storage: string;
  full: boolean;
  description: string;
};

export type DeleteVmInput = {
  type?: 'qemu' | 'lxc';
  node: string;
  vmid: number;
  confirmation: string;
  force: boolean;
};

export type ConvertTemplateInput = {
  node: string;
  vmid: number;
  confirmation: string;
};

export type BackupInput = {
  type: 'qemu' | 'lxc';
  node: string;
  vmid: number;
  storage: string;
  mode: 'snapshot' | 'suspend' | 'stop';
  compress: 'zstd' | 'gzip' | 'lzo' | '0';
  notes: string;
};

export type BackupSchedule = {
  id: string;
  connectorId: string;
  resourceType: 'qemu' | 'lxc';
  node: string;
  vmid: number;
  resourceName: string;
  storage: string;
  mode: 'snapshot' | 'suspend' | 'stop';
  compress: 'zstd' | 'gzip' | 'lzo' | '0';
  notes: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  retention: 7 | 14 | 30;
  enabled: boolean;
  running?: boolean;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastStatus?: string;
  lastMessage?: string;
  history: Array<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    taskId?: string;
    message?: string;
  }>;
};

export type BackupScheduleInput = Omit<BackupSchedule, 'id' | 'running' | 'nextRunAt' | 'lastRunAt' | 'lastStatus' | 'lastMessage' | 'history'>;

export type BackupVolume = {
  volid: string;
  storage: string;
  content: string;
  format: string;
  size: number;
  createdAt: string | null;
  notes: string;
  protected: boolean;
  vmid?: number;
};

export type RestoreInput = {
  type: 'qemu' | 'lxc';
  node: string;
  vmid: number;
  archive: string;
  restoreMode: 'same' | 'new';
  targetNode: string;
  targetVmid: number;
  targetName: string;
  targetStorage: string;
  force: boolean;
  confirmation: string;
};

export type ConsoleSession = {
  sessionId: string;
  websocketPath: string;
  expiresAt: string;
};

export type ProxmoxTask = {
  upid: string;
  node: string;
  user: string;
  type: string;
  id: string;
  status: string;
  exitstatus: string;
  startedAt: string | null;
  endedAt: string | null;
  description: string;
  provider?: 'proxmox' | 'aws' | 'oci' | string;
  action?: string;
  resourceType?: 'qemu' | 'lxc' | string;
  resourceId?: string;
  resourceName?: string;
  progress?: number;
  message?: string;
  errorMessage?: string;
  cancelable?: boolean;
  retryable?: boolean;
  linkedResource?: {
    provider?: string;
    type: string;
    vmid?: number;
    node?: string;
    id?: string;
    name?: string;
    region?: string;
  } | null;
  output?: TaskOutputLine[];
};

export type TaskOutputLine = {
  line: number;
  text: string;
};

export type TaskDetailResponse = {
  generatedAt: string;
  task: ProxmoxTask;
  status: {
    status?: string;
    exitstatus?: string;
    [key: string]: unknown;
  };
  output: TaskOutputLine[];
};

export type ClusterLogEntry = {
  id: string;
  time: string | null;
  node: string;
  user: string;
  priority: string;
  message: string;
};

export type AuditLogEntry = {
  id: string;
  timestamp: string;
  action: string;
  status: string;
  user?: string;
  connectorName?: string;
  connectorId?: string;
  node?: string;
  vmid?: string | number;
  resourceType?: string;
  taskId?: string;
  message?: string;
  [key: string]: unknown;
};

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export type AppNotification = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  type: string;
  severity: NotificationSeverity;
  status: 'read' | 'unread';
  title: string;
  message: string;
  connectorId?: string;
  node?: string;
  vmid?: string | number;
  resourceType?: string;
  taskId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type NotificationSummary = {
  total: number;
  unread: number;
  critical: number;
  warning: number;
};

export type NotificationSettings = {
  enabled: boolean;
  minSeverity: NotificationSeverity;
  resourceAlerts: {
    enabled: boolean;
    cpu: { warning: number; critical: number };
    memory: { warning: number; critical: number };
    storage: { warning: number; critical: number };
  };
  email: {
    enabled: boolean;
    to: string;
    from: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    passwordPreview?: string;
  };
  slack: { enabled: boolean; webhookPreview?: string };
  teams: { enabled: boolean; webhookPreview?: string };
  genericWebhook: { enabled: boolean; webhookPreview?: string };
};

export type NotificationSettingsInput = NotificationSettings & {
  email: NotificationSettings['email'] & { password?: string };
  slack: NotificationSettings['slack'] & { webhookUrl?: string };
  teams: NotificationSettings['teams'] & { webhookUrl?: string };
  genericWebhook: NotificationSettings['genericWebhook'] & { webhookUrl?: string };
};

export type StorageConfig = {
  storage: string;
  type: string;
  content?: string;
  nodes?: string;
  path?: string;
  server?: string;
  export?: string;
  share?: string;
  portal?: string;
  target?: string;
  pool?: string;
  vgname?: string;
  thinpool?: string;
  base?: string;
  datastore?: string;
  namespace?: string;
  fingerprint?: string;
  monhost?: string;
  'fs-name'?: string;
  fsName?: string;
  subdir?: string;
  is_mountpoint?: string;
  isMountpoint?: string;
  blocksize?: string;
  iscsiprovider?: string;
  lio_tpg?: string;
  lioTpg?: string;
  domain?: string;
  smbversion?: string;
  preallocation?: string;
  format?: string;
  transport?: string;
  username?: string;
  sparse?: boolean | number;
  saferemove?: boolean | number;
  krbd?: boolean | number;
  shared?: boolean | number;
  disable?: boolean | number;
  comment?: string;
  notes?: string;
  [key: string]: unknown;
};

export type StorageConfigInput = {
  storage: string;
  type: string;
  content: string;
  nodes: string;
  path: string;
  server: string;
  export: string;
  share: string;
  portal: string;
  target: string;
  pool: string;
  vgname: string;
  thinpool: string;
  base: string;
  datastore: string;
  namespace: string;
  fingerprint: string;
  monhost: string;
  fsName: string;
  subdir: string;
  isMountpoint: string;
  blocksize: string;
  iscsiprovider: string;
  lioTpg: string;
  domain: string;
  smbversion: string;
  preallocation: string;
  format: string;
  transport: string;
  username: string;
  password: string;
  sparse: boolean;
  saferemove: boolean;
  krbd: boolean;
  shared: boolean;
  enabled: boolean;
  notes: string;
};

export type StorageContentItem = {
  volid?: string;
  content?: string;
  format?: string;
  size?: number;
  used?: number;
  vmid?: number;
  ctime?: number;
  notes?: string;
  [key: string]: unknown;
};

export type NetworkBridge = {
  name: string;
  active: boolean;
  autostart: boolean;
  method: string;
  comments: string;
  source?: string;
  zone?: string;
};

export type NetworkInterface = {
  iface: string;
  type: string;
  active: boolean;
  autostart: boolean;
  method: string;
  address: string;
  netmask: string;
  gateway: string;
  bridgePorts: string;
  slaves?: string;
  bondMode?: string;
  vlanId?: string | number;
  vlanRawDevice?: string;
  ovsBridge?: string;
  ovsBonds?: string;
  ovsPorts?: string;
  ovsOptions?: string;
  ovsTag?: string | number;
  mtu?: string | number;
  vlanAware: boolean;
  comments: string;
};

export type NetworkConfigType = 'bridge' | 'bond' | 'vlan' | 'OVSBridge' | 'OVSBond' | 'OVSIntPort';

export type NetworkConfigInput = {
  iface: string;
  type: NetworkConfigType;
  autostart: boolean;
  method: 'manual' | 'static';
  address: string;
  netmask: string;
  gateway: string;
  bridgePorts: string;
  slaves: string;
  bondMode: string;
  vlanId: string;
  vlanRawDevice: string;
  ovsBridge: string;
  ovsBonds: string;
  ovsPorts: string;
  ovsOptions: string;
  ovsTag: string;
  mtu: string;
  vlanAware: boolean;
  comments: string;
};

export type IsoVolume = {
  volid: string;
  name: string;
  storage: string;
  size: number;
  format: string;
};

export type TemplateVolume = IsoVolume;

export type StorageConfigResponse = {
  generatedAt: string;
  config: StorageConfig[];
  resources: Array<Record<string, unknown>>;
};

export type NodeNetworkResponse = {
  generatedAt: string;
  interfaces: NetworkInterface[];
  bridges: NetworkBridge[];
};

export type SdnZone = {
  id: string;
  zone?: string;
  type?: string;
  ipam?: string;
  nodes?: string;
  mtu?: string | number;
  [key: string]: unknown;
};

export type SdnVnet = {
  id: string;
  vnet?: string;
  zone?: string;
  tag?: string | number;
  alias?: string;
  vlanaware?: boolean | number;
  [key: string]: unknown;
};

export type SdnIpam = {
  id: string;
  ipam?: string;
  type?: string;
  url?: string;
  section?: string;
  [key: string]: unknown;
};

export type SdnResponse = {
  generatedAt: string;
  zones: SdnZone[];
  vnets: SdnVnet[];
  ipams: SdnIpam[];
};

export type SdnZoneInput = {
  zone: string;
  type: string;
  ipam: string;
  nodes: string;
  mtu: string;
  dns: string;
  reversedns: string;
};

export type SdnVnetInput = {
  vnet: string;
  zone: string;
  tag: string;
  alias: string;
  vlanaware: boolean;
};

export type SdnIpamInput = {
  ipam: string;
  type: string;
  url: string;
  token: string;
  section: string;
};

export type IsoVolumeResponse = {
  generatedAt: string;
  volumes: IsoVolume[];
};

export type TemplateVolumeResponse = {
  generatedAt: string;
  volumes: TemplateVolume[];
};

export type StorageContentResponse = {
  generatedAt: string;
  content: StorageContentItem[];
};

export type TaskLogResponse = {
  generatedAt: string;
  tasks: ProxmoxTask[];
};

export type ClusterLogResponse = {
  generatedAt: string;
  entries: ClusterLogEntry[];
};

export function runResourceAction({
  type,
  node,
  vmid,
  action,
}: {
  type: 'qemu' | 'lxc';
  node: string;
  vmid: number;
  action: ResourceAction;
}) {
  return apiRequest<{ data: OperationResult }>(
    `/proxmox/resources/${type}/${encodeURIComponent(node)}/${vmid}/actions/${action}`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export function createConsoleSession({
  type,
  node,
  vmid,
}: {
  type: 'qemu' | 'lxc';
  node: string;
  vmid: number;
}) {
  return apiRequest<{ data: ConsoleSession }>(
    `/proxmox/resources/${type}/${encodeURIComponent(node)}/${vmid}/console`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export function createVM(input: CreateVmInput) {
  return apiRequest<{ data: OperationResult }>('/proxmox/vms', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createContainer(input: CreateContainerInput) {
  return apiRequest<{ data: OperationResult }>('/proxmox/containers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cloneVM(input: CloneVmInput) {
  return apiRequest<{ data: OperationResult }>(
    `/proxmox/vms/${encodeURIComponent(input.node)}/${input.vmid}/clone`,
    {
      method: 'POST',
      body: JSON.stringify({
        newid: input.newid,
        name: input.name,
        target: input.target,
        storage: input.storage,
        full: input.full,
        description: input.description,
      }),
    },
  );
}

export function deleteVM(input: DeleteVmInput) {
  return apiRequest<{ data: OperationResult }>(
    `/proxmox/resources/${input.type || 'qemu'}/${encodeURIComponent(input.node)}/${input.vmid}`,
    {
      method: 'DELETE',
      body: JSON.stringify({
        confirmation: input.confirmation,
        force: input.force,
      }),
    },
  );
}

export function convertVMToTemplate(input: ConvertTemplateInput) {
  return apiRequest<{ data: OperationResult }>(
    `/proxmox/vms/${encodeURIComponent(input.node)}/${input.vmid}/template`,
    {
      method: 'POST',
      body: JSON.stringify({
        confirmation: input.confirmation,
      }),
    },
  );
}

export function backupResource(input: BackupInput) {
  return apiRequest<{ data: OperationResult }>(
    `/proxmox/resources/${input.type}/${encodeURIComponent(input.node)}/${input.vmid}/backup`,
    {
      method: 'POST',
      body: JSON.stringify({
        storage: input.storage,
        mode: input.mode,
        compress: input.compress,
        notes: input.notes,
        timeoutMs: 300000,
      }),
    },
  );
}

export function getBackupSchedules() {
  return apiRequest<{ data: { schedules: BackupSchedule[] } }>('/proxmox/backup-schedules');
}

export function createBackupSchedule(input: BackupScheduleInput) {
  return apiRequest<{ data: { schedule: BackupSchedule; message: string } }>('/proxmox/backup-schedules', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateBackupSchedule(id: string, input: BackupScheduleInput) {
  return apiRequest<{ data: { schedule: BackupSchedule; message: string } }>(`/proxmox/backup-schedules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteBackupSchedule(id: string, confirmation: string) {
  return apiRequest<{ data: { message: string } }>(`/proxmox/backup-schedules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  });
}

export function getResourceBackups({ type, node, vmid }: { type: 'qemu' | 'lxc'; node: string; vmid: number }) {
  return apiRequest<{ data: { generatedAt: string; backups: BackupVolume[] } }>(
    `/proxmox/resources/${type}/${encodeURIComponent(node)}/${vmid}/backups`,
  );
}

export function restoreResource(input: RestoreInput) {
  return apiRequest<{ data: OperationResult }>(
    `/proxmox/resources/${input.type}/${encodeURIComponent(input.node)}/${input.vmid}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({
        archive: input.archive,
        restoreMode: input.restoreMode,
        targetNode: input.targetNode,
        targetVmid: input.targetVmid,
        targetName: input.targetName,
        targetStorage: input.targetStorage,
        force: input.force,
        confirmation: input.confirmation,
        timeoutMs: 300000,
      }),
    },
  );
}

export function getStorageConfig() {
  return apiRequest<{ data: StorageConfigResponse }>('/proxmox/storage/config');
}

export function getStorageContent({ node, storage, content }: { node: string; storage: string; content?: string }) {
  const query = content ? `?content=${encodeURIComponent(content)}` : '';
  return apiRequest<{ data: StorageContentResponse }>(
    `/proxmox/storage/${encodeURIComponent(node)}/${encodeURIComponent(storage)}/content${query}`,
  );
}

export function getNodeNetwork(node: string) {
  return apiRequest<{ data: NodeNetworkResponse }>(`/proxmox/nodes/${encodeURIComponent(node)}/network`);
}

export function createNodeNetwork(node: string, input: NetworkConfigInput) {
  return apiRequest<{ data: { message: string; network: NetworkInterface | null } }>(
    `/proxmox/nodes/${encodeURIComponent(node)}/network`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function updateNodeNetwork(node: string, iface: string, input: NetworkConfigInput) {
  return apiRequest<{ data: { message: string; network: NetworkInterface | null } }>(
    `/proxmox/nodes/${encodeURIComponent(node)}/network/${encodeURIComponent(iface)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
    },
  );
}

export function deleteNodeNetwork(node: string, iface: string, confirmation: string) {
  return apiRequest<{ data: { message: string; interfaces: NetworkInterface[] } }>(
    `/proxmox/nodes/${encodeURIComponent(node)}/network/${encodeURIComponent(iface)}`,
    { method: 'DELETE', body: JSON.stringify({ confirmation }) },
  );
}

export function applyNodeNetwork(node: string) {
  return apiRequest<{ data: { message: string; interfaces: NetworkInterface[] } }>(
    `/proxmox/nodes/${encodeURIComponent(node)}/network/apply`,
    { method: 'PUT' },
  );
}

export function setNodeNetworkActive(node: string, iface: string, active: boolean) {
  return apiRequest<{ data: { message: string; network: NetworkInterface | null } }>(
    `/proxmox/nodes/${encodeURIComponent(node)}/network/${encodeURIComponent(iface)}/${active ? 'activate' : 'deactivate'}`,
    { method: 'POST' },
  );
}

export function getSdn() {
  return apiRequest<{ data: SdnResponse }>('/proxmox/sdn');
}

export function createSdnZone(input: SdnZoneInput) {
  return apiRequest<{ data: { message: string; zone: SdnZone | null } }>('/proxmox/sdn/zones', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createSdnVnet(input: SdnVnetInput) {
  return apiRequest<{ data: { message: string; vnet: SdnVnet | null } }>('/proxmox/sdn/vnets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createSdnIpam(input: SdnIpamInput) {
  return apiRequest<{ data: { message: string; ipam: SdnIpam | null } }>('/proxmox/sdn/ipams', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteSdnZone(zone: string, confirmation: string) {
  return apiRequest<{ data: { message: string } }>(`/proxmox/sdn/zones/${encodeURIComponent(zone)}`, { method: 'DELETE', body: JSON.stringify({ confirmation }) });
}

export function deleteSdnVnet(vnet: string, confirmation: string) {
  return apiRequest<{ data: { message: string } }>(`/proxmox/sdn/vnets/${encodeURIComponent(vnet)}`, { method: 'DELETE', body: JSON.stringify({ confirmation }) });
}

export function deleteSdnIpam(ipam: string, confirmation: string) {
  return apiRequest<{ data: { message: string } }>(`/proxmox/sdn/ipams/${encodeURIComponent(ipam)}`, { method: 'DELETE', body: JSON.stringify({ confirmation }) });
}

export function applySdn() {
  return apiRequest<{ data: { message: string } }>('/proxmox/sdn/apply', { method: 'PUT' });
}

export function getIsoVolumes(node: string) {
  return apiRequest<{ data: IsoVolumeResponse }>(`/proxmox/nodes/${encodeURIComponent(node)}/iso`);
}

export function getTemplateVolumes(node: string) {
  return apiRequest<{ data: TemplateVolumeResponse }>(`/proxmox/nodes/${encodeURIComponent(node)}/templates`);
}

export function createStorageConfig(input: StorageConfigInput) {
  return apiRequest<{ data: { message: string; storage: StorageConfig | null } }>('/proxmox/storage/config', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateStorageConfig(storage: string, input: StorageConfigInput) {
  const { storage: _storage, type: _type, ...payload } = input;
  return apiRequest<{ data: { message: string; storage: StorageConfig | null } }>(
    `/proxmox/storage/config/${encodeURIComponent(storage)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  );
}

export function deleteStorageConfig({ storage, confirmation }: { storage: string; confirmation: string }) {
  return apiRequest<{ data: { message: string } }>(`/proxmox/storage/config/${encodeURIComponent(storage)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  });
}

export function getTasks(limit = 100) {
  return apiRequest<{ data: TaskLogResponse }>(`/proxmox/logs/tasks?limit=${limit}`);
}

export function getAwsJobs(limit = 200) {
  return apiRequest<{ data: TaskLogResponse }>(`/aws/jobs?limit=${limit}`);
}

export function getAzureJobs(limit = 200) {
  return apiRequest<{ data: TaskLogResponse }>(`/azure/jobs?limit=${limit}`);
}

export function getTaskDetail({ node, upid, limit = 500 }: { node: string; upid: string; limit?: number }) {
  return apiRequest<{ data: TaskDetailResponse }>(
    `/proxmox/tasks/${encodeURIComponent(node)}/${encodeURIComponent(upid)}/detail?limit=${limit}`,
  );
}

export function stopTask({ node, upid, confirmation }: { node: string; upid: string; confirmation: string }) {
  return apiRequest<{ data: { message: string; result: unknown } }>(
    `/proxmox/tasks/${encodeURIComponent(node)}/${encodeURIComponent(upid)}`,
    { method: 'DELETE', body: JSON.stringify({ confirmation }) },
  );
}

export function retryTask({ node, upid }: { node: string; upid: string }) {
  return apiRequest<{ data: OperationResult }>(
    `/proxmox/tasks/${encodeURIComponent(node)}/${encodeURIComponent(upid)}/retry`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export function getClusterLog(limit = 100) {
  return apiRequest<{ data: ClusterLogResponse }>(`/proxmox/logs/cluster?limit=${limit}`);
}

export function getAuditLog() {
  return apiRequest<{ entries: AuditLogEntry[] }>('/proxmox/audit-log');
}

export function getNotifications() {
  return apiRequest<{
    data: {
      generatedAt: string;
      summary: NotificationSummary;
      notifications: AppNotification[];
    };
  }>('/notifications');
}

export function markNotificationRead(id: string, read = true) {
  return apiRequest<{ data: { notification: AppNotification } }>(`/notifications/${encodeURIComponent(id)}/read`, {
    method: 'PATCH',
    body: JSON.stringify({ read }),
  });
}

export function markAllNotificationsRead() {
  return apiRequest<{ data: { updated: number } }>('/notifications/read-all', {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
}

export function getNotificationSettings() {
  return apiRequest<{ data: { settings: NotificationSettings } }>('/notifications/settings');
}

export function updateNotificationSettings(input: NotificationSettingsInput) {
  return apiRequest<{ data: { settings: NotificationSettings; message: string } }>('/notifications/settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
