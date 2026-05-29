import { z } from 'zod';

export const resourceParamsSchema = z.object({
  type: z.enum(['qemu', 'lxc', 'container']),
  node: z.string().trim().min(1, 'Node is required.').max(128, 'Node is too long.'),
  vmid: z.coerce.number().int('VM ID must be a whole number.').positive('VM ID must be positive.').transform(String),
});

export const taskParamsSchema = z.object({
  node: z.string().trim().min(1, 'Node is required.').max(128, 'Node is too long.'),
  upid: z.string().trim().min(1, 'Task ID is required.').max(512, 'Task ID is too long.'),
});

export const nodeParamsSchema = z.object({
  node: z.string().trim().min(1, 'Node is required.').max(128, 'Node is too long.'),
});

export const networkParamsSchema = nodeParamsSchema.extend({
  iface: z.string().trim().min(1, 'Interface name is required.').max(64, 'Interface name is too long.'),
});

export const confirmationBodySchema = z.object({
  confirmation: z.string().trim().min(1, 'Confirmation is required.').max(512, 'Confirmation is too long.'),
});

export const networkStateParamsSchema = networkParamsSchema.extend({
  state: z.enum(['activate', 'deactivate']),
});

export const networkConfigBodySchema = z.object({
  iface: z.string().trim().min(1, 'Interface name is required.').max(64, 'Interface name is too long.'),
  type: z.enum(['bridge', 'bond', 'vlan', 'OVSBridge', 'OVSBond', 'OVSIntPort']).optional().default('bridge'),
  autostart: z.boolean().optional().default(true),
  method: z.enum(['manual', 'static']).optional().default('manual'),
  address: z.string().trim().max(128, 'Address is too long.').optional().default(''),
  netmask: z.string().trim().max(128, 'Netmask is too long.').optional().default(''),
  gateway: z.string().trim().max(128, 'Gateway is too long.').optional().default(''),
  bridgePorts: z.string().trim().max(255, 'Bridge ports are too long.').optional().default(''),
  slaves: z.string().trim().max(255, 'Slave ports are too long.').optional().default(''),
  bondMode: z.string().trim().max(64, 'Bond mode is too long.').optional().default(''),
  vlanId: z.string().trim().max(8, 'VLAN ID is too long.').optional().default(''),
  vlanRawDevice: z.string().trim().max(64, 'Raw device is too long.').optional().default(''),
  ovsBridge: z.string().trim().max(64, 'OVS bridge is too long.').optional().default(''),
  ovsBonds: z.string().trim().max(255, 'OVS bond ports are too long.').optional().default(''),
  ovsPorts: z.string().trim().max(255, 'OVS ports are too long.').optional().default(''),
  ovsOptions: z.string().trim().max(500, 'OVS options are too long.').optional().default(''),
  ovsTag: z.string().trim().max(8, 'OVS tag is too long.').optional().default(''),
  mtu: z.string().trim().max(16, 'MTU is too long.').optional().default(''),
  vlanAware: z.boolean().optional().default(false),
  comments: z.string().trim().max(2000, 'Comments are too long.').optional().default(''),
});

export const sdnZoneBodySchema = z.object({
  zone: z.string().trim().min(1, 'Zone ID is required.').max(64, 'Zone ID is too long.'),
  type: z.enum(['simple', 'vlan', 'vxlan', 'evpn', 'qinq']).optional().default('simple'),
  ipam: z.string().trim().max(64, 'IPAM ID is too long.').optional().default(''),
  nodes: z.string().trim().max(255, 'Node list is too long.').optional().default(''),
  mtu: z.string().trim().max(16, 'MTU is too long.').optional().default(''),
  dns: z.string().trim().max(64, 'DNS ID is too long.').optional().default(''),
  reversedns: z.string().trim().max(64, 'Reverse DNS ID is too long.').optional().default(''),
});

export const sdnVnetBodySchema = z.object({
  vnet: z.string().trim().min(1, 'VNet ID is required.').max(64, 'VNet ID is too long.'),
  zone: z.string().trim().min(1, 'Zone is required.').max(64, 'Zone is too long.'),
  tag: z.string().trim().max(16, 'Tag is too long.').optional().default(''),
  alias: z.string().trim().max(128, 'Alias is too long.').optional().default(''),
  vlanaware: z.boolean().optional().default(false),
});

export const sdnIpamBodySchema = z.object({
  ipam: z.string().trim().min(1, 'IPAM ID is required.').max(64, 'IPAM ID is too long.'),
  type: z.enum(['pve', 'netbox', 'phpipam']).optional().default('pve'),
  url: z.string().trim().max(500, 'URL is too long.').optional().default(''),
  token: z.string().max(1000, 'Token is too long.').optional().default(''),
  section: z.string().trim().max(128, 'Section is too long.').optional().default(''),
});

export const sdnZoneParamsSchema = z.object({
  zone: z.string().trim().min(1, 'Zone ID is required.').max(64, 'Zone ID is too long.'),
});

export const sdnVnetParamsSchema = z.object({
  vnet: z.string().trim().min(1, 'VNet ID is required.').max(64, 'VNet ID is too long.'),
});

export const sdnIpamParamsSchema = z.object({
  ipam: z.string().trim().min(1, 'IPAM ID is required.').max(64, 'IPAM ID is too long.'),
});

export const cloneParamsSchema = z.object({
  node: z.string().trim().min(1, 'Node is required.').max(128, 'Node is too long.'),
  vmid: z.coerce.number().int('VM ID must be a whole number.').positive('VM ID must be positive.').transform(String),
});

export const actionParamsSchema = resourceParamsSchema.extend({
  action: z.enum(['start', 'shutdown', 'stop', 'reboot', 'suspend']),
});

export const cloneBodySchema = z.object({
  newid: z.coerce.number().int('New VM ID must be a whole number.').positive('New VM ID must be positive.'),
  name: z.string().trim().min(1, 'New VM name is required.').max(128, 'New VM name is too long.'),
  target: z.string().trim().min(1, 'Target node is required.').max(128, 'Target node is too long.'),
  storage: z.string().trim().min(1, 'Target storage is required.').max(128, 'Target storage is too long.'),
  full: z.boolean().optional().default(true),
  description: z.string().trim().max(2000, 'Description is too long.').optional().default(''),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

export const createVmBodySchema = z.object({
  node: z.string().trim().min(1, 'Target node is required.').max(128, 'Target node is too long.'),
  vmid: z.coerce.number().int('VM ID must be a whole number.').positive('VM ID must be positive.'),
  name: z.string().trim().min(1, 'VM name is required.').max(128, 'VM name is too long.'),
  storage: z.string().trim().min(1, 'Target storage is required.').max(128, 'Target storage is too long.'),
  diskSizeGb: z.coerce.number().positive('Disk size must be positive.').max(1048576, 'Disk size is too large.'),
  cores: z.coerce.number().int('Cores must be a whole number.').positive('Cores must be positive.').max(256, 'Cores value is too large.'),
  sockets: z.coerce.number().int('Sockets must be a whole number.').positive('Sockets must be positive.').max(16, 'Sockets value is too large.').optional().default(1),
  memoryMb: z.coerce.number().int('Memory must be a whole number.').min(128, 'Memory must be at least 128 MB.').max(1048576, 'Memory value is too large.'),
  bridge: z.string().trim().min(1, 'Network bridge is required.').max(64, 'Network bridge is too long.').optional().default('vmbr0'),
  iso: z.string().trim().max(500, 'ISO volume is too long.').optional().default(''),
  ostype: z.string().trim().max(64, 'Guest OS type is too long.').optional().default('l26'),
  scsihw: z.string().trim().max(64, 'SCSI controller is too long.').optional().default('virtio-scsi-pci'),
  description: z.string().trim().max(2000, 'Description is too long.').optional().default(''),
  startAfterCreate: z.boolean().optional().default(false),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

export const createContainerBodySchema = z.object({
  node: z.string().trim().min(1, 'Target node is required.').max(128, 'Target node is too long.'),
  vmid: z.coerce.number().int('Container ID must be a whole number.').positive('Container ID must be positive.'),
  hostname: z.string().trim().min(1, 'Hostname is required.').max(128, 'Hostname is too long.'),
  storage: z.string().trim().min(1, 'Target storage is required.').max(128, 'Target storage is too long.'),
  template: z.string().trim().min(1, 'Template is required.').max(500, 'Template volume is too long.'),
  diskSizeGb: z.coerce.number().positive('Disk size must be positive.').max(1048576, 'Disk size is too large.'),
  cores: z.coerce.number().int('Cores must be a whole number.').positive('Cores must be positive.').max(256, 'Cores value is too large.'),
  memoryMb: z.coerce.number().int('Memory must be a whole number.').min(128, 'Memory must be at least 128 MB.').max(1048576, 'Memory value is too large.'),
  swapMb: z.coerce.number().int('Swap must be a whole number.').min(0, 'Swap cannot be negative.').max(1048576, 'Swap value is too large.').optional().default(512),
  bridge: z.string().trim().min(1, 'Network bridge is required.').max(64, 'Network bridge is too long.').optional().default('vmbr0'),
  password: z.string().max(512, 'Password is too long.').optional().default(''),
  unprivileged: z.boolean().optional().default(true),
  startAfterCreate: z.boolean().optional().default(false),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

export const deleteBodySchema = z.object({
  confirmation: z.string().trim().min(1, 'Delete confirmation is required.').max(128, 'Delete confirmation is too long.'),
  force: z.boolean().optional().default(false),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

export const templateBodySchema = z.object({
  confirmation: z.string().trim().min(1, 'Template confirmation is required.').max(128, 'Template confirmation is too long.'),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

export const backupBodySchema = z.object({
  storage: z.string().trim().min(1, 'Backup storage is required.').max(128, 'Backup storage is too long.'),
  mode: z.enum(['snapshot', 'suspend', 'stop']).optional().default('snapshot'),
  compress: z.enum(['zstd', 'gzip', 'lzo', '0']).optional().default('zstd'),
  notes: z.string().trim().max(2000, 'Notes are too long.').optional().default(''),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

export const backupScheduleParamsSchema = z.object({
  id: z.string().trim().min(1, 'Schedule ID is required.').max(128, 'Schedule ID is too long.'),
});

export const backupScheduleBodySchema = z.object({
  connectorId: z.string().trim().min(1, 'Connector is required.').max(128, 'Connector ID is too long.'),
  resourceType: z.enum(['qemu', 'lxc', 'container']).transform((value) => (value === 'container' ? 'lxc' : value)),
  node: z.string().trim().min(1, 'Node is required.').max(128, 'Node is too long.'),
  vmid: z.coerce.number().int('VM/CT ID must be a whole number.').positive('VM/CT ID must be positive.'),
  resourceName: z.string().trim().max(128, 'Resource name is too long.').optional().default(''),
  storage: z.string().trim().min(1, 'Backup storage is required.').max(128, 'Backup storage is too long.'),
  mode: z.enum(['snapshot', 'suspend', 'stop']).optional().default('snapshot'),
  compress: z.enum(['zstd', 'gzip', 'lzo', '0']).optional().default('zstd'),
  notes: z.string().trim().max(2000, 'Notes are too long.').optional().default(''),
  frequency: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
  time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Schedule time must use HH:mm format.').optional().default('02:00'),
  dayOfWeek: z.coerce.number().int().min(0).max(6).optional().default(0),
  dayOfMonth: z.coerce.number().int().min(1).max(31).optional().default(1),
  retention: z.coerce.number().int().refine((value) => [7, 14, 30].includes(value), 'Retention must be 7, 14, or 30.'),
  enabled: z.boolean().optional().default(true),
});

export const restoreBodySchema = z.object({
  archive: z.string().trim().min(1, 'Backup archive is required.').max(500, 'Backup archive is too long.'),
  restoreMode: z.enum(['same', 'new']).optional().default('same'),
  targetNode: z.string().trim().min(1, 'Target node is required.').max(128, 'Target node is too long.'),
  targetVmid: z.coerce.number().int('Target VM/CT ID must be a whole number.').positive('Target VM/CT ID must be positive.'),
  targetName: z.string().trim().max(128, 'Target VM/CT name is too long.').optional().default(''),
  targetStorage: z.string().trim().max(128, 'Target storage is too long.').optional().default(''),
  force: z.boolean().optional().default(false),
  confirmation: z.string().trim().min(1, 'Restore confirmation is required.').max(128, 'Restore confirmation is too long.'),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

export const storageIdParamsSchema = z.object({
  storage: z.string().trim().min(1, 'Storage ID is required.').max(128, 'Storage ID is too long.'),
});

export const storageContentParamsSchema = storageIdParamsSchema.extend({
  node: z.string().trim().min(1, 'Node is required.').max(128, 'Node is too long.'),
});

export const storageConfigBodySchema = z.object({
  storage: z.string().trim().min(1, 'Storage ID is required.').max(128, 'Storage ID is too long.'),
  type: z.enum(['btrfs', 'cephfs', 'cifs', 'dir', 'esxi', 'glusterfs', 'iscsi', 'iscsidirect', 'lvm', 'lvmthin', 'nfs', 'pbs', 'rbd', 'zfs', 'zfspool']),
  content: z.string().trim().min(1, 'At least one content type is required.').max(255, 'Content list is too long.'),
  nodes: z.string().trim().max(255, 'Node restrictions are too long.').optional().default(''),
  path: z.string().trim().max(500, 'Path is too long.').optional().default(''),
  server: z.string().trim().max(255, 'Server is too long.').optional().default(''),
  export: z.string().trim().max(500, 'Export/share is too long.').optional().default(''),
  share: z.string().trim().max(500, 'Share is too long.').optional().default(''),
  portal: z.string().trim().max(255, 'Portal is too long.').optional().default(''),
  target: z.string().trim().max(500, 'Target is too long.').optional().default(''),
  pool: z.string().trim().max(255, 'Pool is too long.').optional().default(''),
  vgname: z.string().trim().max(255, 'Volume group is too long.').optional().default(''),
  thinpool: z.string().trim().max(255, 'Thin pool is too long.').optional().default(''),
  base: z.string().trim().max(500, 'Base volume is too long.').optional().default(''),
  datastore: z.string().trim().max(255, 'Datastore is too long.').optional().default(''),
  namespace: z.string().trim().max(255, 'Namespace is too long.').optional().default(''),
  fingerprint: z.string().trim().max(255, 'Fingerprint is too long.').optional().default(''),
  monhost: z.string().trim().max(500, 'Monitor host list is too long.').optional().default(''),
  fsName: z.string().trim().max(255, 'FS name is too long.').optional().default(''),
  subdir: z.string().trim().max(500, 'Subdirectory is too long.').optional().default(''),
  isMountpoint: z.string().trim().max(500, 'Mount point is too long.').optional().default(''),
  blocksize: z.string().trim().max(64, 'Block size is too long.').optional().default(''),
  iscsiprovider: z.string().trim().max(64, 'iSCSI provider is too long.').optional().default(''),
  lioTpg: z.string().trim().max(128, 'LIO TPG is too long.').optional().default(''),
  domain: z.string().trim().max(255, 'Domain is too long.').optional().default(''),
  smbversion: z.string().trim().max(64, 'SMB version is too long.').optional().default(''),
  preallocation: z.string().trim().max(64, 'Preallocation value is too long.').optional().default(''),
  format: z.string().trim().max(64, 'Format is too long.').optional().default(''),
  transport: z.string().trim().max(64, 'Transport is too long.').optional().default(''),
  username: z.string().trim().max(255, 'Username is too long.').optional().default(''),
  password: z.string().max(512, 'Password is too long.').optional().default(''),
  sparse: z.boolean().optional().default(false),
  saferemove: z.boolean().optional().default(false),
  krbd: z.boolean().optional().default(false),
  shared: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true),
  notes: z.string().trim().max(2000, 'Notes are too long.').optional().default(''),
});

export const storageConfigUpdateBodySchema = storageConfigBodySchema.partial({
  storage: true,
  type: true,
}).extend({
  content: z.string().trim().min(1, 'At least one content type is required.').max(255, 'Content list is too long.'),
});

export const storageDeleteBodySchema = z.object({
  confirmation: z.string().trim().min(1, 'Storage confirmation is required.').max(128, 'Storage confirmation is too long.'),
});
