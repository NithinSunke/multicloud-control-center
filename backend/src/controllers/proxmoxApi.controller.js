import { getConnectorForUse, getSelectedConnectorForUse } from '../services/connectorStore.js';
import { createProxmoxApiClient, ProxmoxApiError } from '../services/proxmoxApiClient.js';
import { appendAuditLog, listAuditLog as readAuditLog } from '../services/auditLog.js';
import { createConsoleSessionRecord } from '../services/consoleSessions.js';
import {
  createBackupSchedule as createBackupScheduleRecord,
  deleteBackupSchedule as deleteBackupScheduleRecord,
  listBackupSchedules as readBackupSchedules,
  updateBackupSchedule as updateBackupScheduleRecord,
} from '../services/backupSchedules.js';
import { listBackupsForResource } from '../services/backupScheduler.js';
import { createHealthNotifications, createNotification } from '../services/notificationStore.js';
import { logger } from '../utils/logger.js';

const safeActions = ['start', 'shutdown', 'stop', 'reboot', 'suspend'];

function safeError(error) {
  if (error instanceof ProxmoxApiError) {
    return {
      statusCode: error.type === 'auth' ? 401 : error.type === 'timeout' ? 504 : 502,
      body: {
        message: error.message,
        type: error.type,
        statusCode: error.statusCode,
      },
    };
  }

  return {
    statusCode: error.statusCode || 500,
    body: {
      message: error.statusCode ? error.message : 'Unable to process Proxmox API request.',
    },
  };
}

async function connectorFromRequest(req) {
  const connectorId = req.query.connectorId || req.body?.connectorId;
  return connectorId ? getConnectorForUse(connectorId) : getSelectedConnectorForUse();
}

async function withClient(req, res, callback, options = {}) {
  try {
    const connector = await connectorFromRequest(req);
    if (options.requireVerified && connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before loading resources.');
      error.statusCode = 400;
      throw error;
    }
    const client = createProxmoxApiClient(connector);
    const data = await callback(client, connector);
    res.json({ data });
  } catch (error) {
    const safe = safeError(error);
    logger.error('proxmox_request_failed', {
      requestId: req.id,
      path: req.originalUrl,
      statusCode: safe.statusCode,
      error: {
        type: error.type,
        message: error.message,
      },
    });
    res.status(safe.statusCode).json(safe.body);
  }
}

export function listNodes(req, res) {
  return withClient(req, res, (client) => client.listNodes());
}

export function listNodeNetwork(req, res) {
  return withClient(req, res, async (client) => {
    const [interfaces, sdnVnets] = await Promise.all([
      client.listNodeNetwork({ node: req.params.node }),
      client.listSdnVnets().catch(() => []),
    ]);
    const interfaceList = safeArray(interfaces);
    const vnetBridges = safeArray(sdnVnets)
      .map((item) => ({
        name: item.vnet || item.id || '',
        active: true,
        autostart: true,
        method: 'sdn',
        comments: item.alias || item.comment || '',
        source: 'sdn',
        zone: item.zone || '',
      }))
      .filter((item) => item.name);

    return {
      generatedAt: new Date().toISOString(),
      interfaces: interfaceList.map((item) => ({
        iface: item.iface || item.name || '',
        type: item.type || '',
        active: item.active === 1 || item.active === true,
        autostart: item.autostart === 1 || item.autostart === true,
        method: item.method || '',
        address: item.address || '',
        netmask: item.netmask || '',
        gateway: item.gateway || '',
        bridgePorts: item.bridge_ports || item.bridgePorts || '',
        slaves: item.slaves || '',
        bondMode: item.bond_mode || '',
        vlanId: item['vlan-id'] || item.vlan_id || '',
        vlanRawDevice: item['vlan-raw-device'] || item.vlan_raw_device || '',
        ovsBridge: item.ovs_bridge || '',
        ovsBonds: item.ovs_bonds || '',
        ovsPorts: item.ovs_ports || '',
        ovsOptions: item.ovs_options || '',
        ovsTag: item.ovs_tag || '',
        mtu: item.mtu || '',
        vlanAware: item.bridge_vlan_aware === 1 || item.bridge_vlan_aware === true,
        comments: item.comments || '',
      })).filter((item) => item.iface),
      bridges: [
        ...interfaceList
      .filter((item) => item.type === 'bridge' || item.iface?.startsWith('vmbr'))
      .map((item) => ({
        name: item.iface || item.name || '',
        active: item.active === 1 || item.active === true,
        autostart: item.autostart === 1 || item.autostart === true,
        method: item.method || '',
        comments: item.comments || '',
        source: 'node',
      }))
      .filter((item) => item.name),
        ...vnetBridges,
      ],
    };
  }, { requireVerified: true });
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function usageRatio(used = 0, total = 0) {
  if (!total || total <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, used / total));
}

function buildDashboard({ nodes, vms, containers, storage }) {
  const nodeList = safeArray(nodes);
  const qemuList = safeArray(vms);
  const vmTemplateList = qemuList.filter((item) => Boolean(item.template));
  const vmList = qemuList.filter((item) => !item.template);
  const containerList = safeArray(containers);
  const storageList = safeArray(storage);
  const allCompute = [...vmList, ...containerList];
  const runningVMs = vmList.filter((item) => item.status === 'running').length;
  const stoppedVMs = vmList.filter((item) => item.status !== 'running').length;
  const runningContainers = containerList.filter((item) => item.status === 'running').length;
  const onlineNodes = nodeList.filter((item) => item.status === 'online').length;
  const totalCpu = nodeList.reduce((sum, item) => sum + Number(item.cpu || 0), 0);
  const totalMemoryUsed = nodeList.reduce((sum, item) => sum + Number(item.mem || 0), 0);
  const totalMemory = nodeList.reduce((sum, item) => sum + Number(item.maxmem || 0), 0);
  const totalStorageUsed = storageList.reduce((sum, item) => sum + Number(item.disk || 0), 0);
  const totalStorage = storageList.reduce((sum, item) => sum + Number(item.maxdisk || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      clusterHealth: nodeList.length > 0 && onlineNodes === nodeList.length ? 'healthy' : 'attention',
      totalNodes: nodeList.length,
      onlineNodes,
      totalVMs: vmList.length,
      totalVMTemplates: vmTemplateList.length,
      runningVMs,
      stoppedVMs,
      containers: containerList.length,
      runningContainers,
      cpuUsage: nodeList.length ? totalCpu / nodeList.length : 0,
      memoryUsage: usageRatio(totalMemoryUsed, totalMemory),
      storageUsage: usageRatio(totalStorageUsed, totalStorage),
    },
    charts: {
      cpu: nodeList.map((node) => ({
        name: node.node || node.id || 'node',
        usage: Math.round(Number(node.cpu || 0) * 100),
      })),
      memory: nodeList.map((node) => ({
        name: node.node || node.id || 'node',
        used: Number(node.mem || 0),
        total: Number(node.maxmem || 0),
        usage: Math.round(usageRatio(Number(node.mem || 0), Number(node.maxmem || 0)) * 100),
      })),
      storage: storageList.map((item) => ({
        name: item.storage || item.id || 'storage',
        used: Number(item.disk || 0),
        total: Number(item.maxdisk || 0),
        usage: Math.round(usageRatio(Number(item.disk || 0), Number(item.maxdisk || 0)) * 100),
      })),
      status: [
        { name: 'Running VMs', value: runningVMs },
        { name: 'Stopped VMs', value: stoppedVMs },
        { name: 'Running CTs', value: runningContainers },
        { name: 'Stopped CTs', value: containerList.length - runningContainers },
      ],
    },
    resources: {
      nodes: nodeList,
      vms: vmList,
      vmTemplates: vmTemplateList,
      containers: containerList,
      storage: storageList,
      allCompute,
    },
  };
}

function isActionAllowed({ action, type, status }) {
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';
  if (!safeActions.includes(action)) {
    return false;
  }
  if (action === 'suspend' && normalizedType !== 'qemu') {
    return false;
  }
  if (action === 'start') {
    return status !== 'running';
  }
  return status === 'running';
}

function actionRunner(client, action) {
  const runners = {
    start: client.startVM,
    shutdown: client.shutdownVM,
    stop: client.stopVM,
    reboot: client.rebootVM,
    suspend: client.suspendVM,
  };
  return runners[action]?.bind(client);
}

function normalizeClonePayload(payload = {}) {
  return {
    newid: Number(payload.newid),
    name: String(payload.name || '').trim(),
    target: String(payload.target || '').trim(),
    storage: String(payload.storage || '').trim(),
    full: payload.full !== false,
    description: String(payload.description || '').trim(),
  };
}

function addValidationError(errors, message) {
  errors.push(message);
}

const supportedNetworkTypes = ['bridge', 'bond', 'vlan', 'OVSBridge', 'OVSBond', 'OVSIntPort'];

function splitList(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(' ');
}

function normalizeNetworkConfigPayload(payload = {}) {
  const method = String(payload.method || 'manual').trim();
  const type = String(payload.type || 'bridge').trim();
  const bridgePorts = String(payload.bridgePorts || payload.bridge_ports || '').trim();
  const proxmoxBridgePorts = bridgePorts === 'none' ? '' : bridgePorts;
  const address = String(payload.address || '').trim();
  const netmask = String(payload.netmask || '').trim();
  const normalized = {
    iface: String(payload.iface || '').trim(),
    type,
    autostart: payload.autostart === false ? 0 : 1,
    comments: String(payload.comments || '').trim(),
  };

  const mtu = String(payload.mtu || '').trim();
  if (mtu) {
    normalized.mtu = mtu;
  }

  if (type === 'bridge') {
    normalized.bridge_ports = proxmoxBridgePorts;
    normalized.bridge_vlan_aware = payload.vlanAware === true || payload.bridge_vlan_aware === true ? 1 : 0;
  }

  if (type === 'bond') {
    normalized.slaves = splitList(payload.slaves || payload.bridgePorts);
    normalized.bond_mode = String(payload.bondMode || payload.bond_mode || 'balance-rr').trim();
  }

  if (type === 'vlan') {
    normalized['vlan-id'] = String(payload.vlanId || payload['vlan-id'] || '').trim();
    normalized['vlan-raw-device'] = String(payload.vlanRawDevice || payload['vlan-raw-device'] || '').trim();
  }

  if (type === 'OVSBridge') {
    normalized.ovs_ports = splitList(payload.ovsPorts || payload.bridgePorts);
  }

  if (type === 'OVSBond') {
    normalized.ovs_bridge = String(payload.ovsBridge || '').trim();
    normalized.ovs_bonds = splitList(payload.ovsBonds || payload.slaves || payload.bridgePorts);
    normalized.ovs_options = String(payload.ovsOptions || '').trim();
    normalized.ovs_tag = String(payload.ovsTag || '').trim();
  }

  if (type === 'OVSIntPort') {
    normalized.ovs_bridge = String(payload.ovsBridge || '').trim();
    normalized.ovs_options = String(payload.ovsOptions || '').trim();
    normalized.ovs_tag = String(payload.ovsTag || '').trim();
  }

  if (method === 'static') {
    normalized.cidr = cidrFromAddressAndNetmask(address, netmask);
    normalized.gateway = String(payload.gateway || '').trim();
  }

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== ''),
  );
}

function cidrFromAddressAndNetmask(address, netmask) {
  if (!address || !netmask) {
    return '';
  }

  if (address.includes('/')) {
    return address;
  }

  const prefix = netmaskToPrefix(netmask);
  return prefix === null ? '' : `${address}/${prefix}`;
}

function netmaskToPrefix(netmask) {
  const parts = netmask.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  const binary = parts.map((part) => part.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(binary)) {
    return null;
  }
  return binary.indexOf('0') === -1 ? 32 : binary.indexOf('0');
}

function validateNetworkConfigRequest({ payload, interfaces }) {
  const network = normalizeNetworkConfigPayload(payload);
  const method = String(payload.method || 'manual').trim();
  const errors = [];
  const ifaceNames = safeArray(interfaces).map((item) => item.iface || item.name).filter(Boolean);

  if (!network.iface) {
    addValidationError(errors, 'Interface name is required.');
  } else if (ifaceNames.includes(network.iface)) {
    addValidationError(errors, `Interface ${network.iface} already exists.`);
  }

  if (!supportedNetworkTypes.includes(network.type)) {
    addValidationError(errors, 'Select a supported network type.');
  }

  if (network.type === 'bridge' && !/^vmbr\d+$/.test(network.iface)) {
    addValidationError(errors, 'Linux bridge name must look like vmbr1, vmbr2, or another vmbr number.');
  }

  if (network.type === 'bond' && !network.slaves) {
    addValidationError(errors, 'Linux bond requires at least one slave port.');
  }

  if (network.type === 'vlan') {
    if (!network['vlan-id'] || !/^\d+$/.test(String(network['vlan-id'])) || Number(network['vlan-id']) < 1 || Number(network['vlan-id']) > 4094) {
      addValidationError(errors, 'Linux VLAN requires a VLAN ID from 1 to 4094.');
    }
    if (!network['vlan-raw-device']) {
      addValidationError(errors, 'Linux VLAN requires a raw device.');
    }
  }

  if (network.type === 'OVSBond') {
    if (!network.ovs_bridge) {
      addValidationError(errors, 'OVS Bond requires an OVS bridge.');
    }
    if (!network.ovs_bonds) {
      addValidationError(errors, 'OVS Bond requires at least one bond port.');
    }
  }

  if (network.type === 'OVSIntPort' && !network.ovs_bridge) {
    addValidationError(errors, 'OVS IntPort requires an OVS bridge.');
  }

  if (method === 'static' && !network.cidr) {
    addValidationError(errors, 'Static network configuration requires address and netmask.');
  }

  return { network, errors };
}

function networkUpdatePayload(network) {
  const { iface, type, ...payload } = network;
  return payload;
}

function compactPayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

function normalizeSdnZonePayload(payload = {}) {
  return compactPayload({
    zone: String(payload.zone || '').trim(),
    type: String(payload.type || 'simple').trim(),
    ipam: String(payload.ipam || '').trim(),
    nodes: String(payload.nodes || '').trim(),
    mtu: String(payload.mtu || '').trim(),
    dns: String(payload.dns || '').trim(),
    reversedns: String(payload.reversedns || '').trim(),
  });
}

function normalizeSdnVnetPayload(payload = {}) {
  return compactPayload({
    vnet: String(payload.vnet || '').trim(),
    zone: String(payload.zone || '').trim(),
    tag: String(payload.tag || '').trim(),
    alias: String(payload.alias || '').trim(),
    vlanaware: payload.vlanaware === true ? 1 : '',
  });
}

function normalizeSdnIpamPayload(payload = {}) {
  return compactPayload({
    ipam: String(payload.ipam || '').trim(),
    type: String(payload.type || 'pve').trim(),
    url: String(payload.url || '').trim(),
    token: String(payload.token || ''),
    section: String(payload.section || '').trim(),
  });
}

function normalizeSdnRecord(item = {}, fallbackId = '') {
  return {
    id: item.zone || item.vnet || item.ipam || item.id || fallbackId,
    ...item,
  };
}

function validateCloneRequest({ payload, source, nodes, vms, containers, storage }) {
  const clone = normalizeClonePayload(payload);
  const errors = [];
  const existingIds = [...safeArray(vms), ...safeArray(containers)]
    .map((item) => Number(item.vmid))
    .filter((value) => Number.isInteger(value));
  const nodeNames = safeArray(nodes).map((item) => item.node).filter(Boolean);
  const storageRecords = safeArray(storage);

  if (!Number.isInteger(clone.newid) || clone.newid <= 0) {
    addValidationError(errors, 'New VM ID must be a positive number.');
  } else if (existingIds.includes(clone.newid)) {
    addValidationError(errors, `VM ID ${clone.newid} is already in use.`);
  }

  if (!clone.name) {
    addValidationError(errors, 'New VM name is required.');
  }

  if (!clone.target) {
    addValidationError(errors, 'Target node is required.');
  } else if (nodeNames.length && !nodeNames.includes(clone.target)) {
    addValidationError(errors, 'Target node is not available.');
  }

  if (!clone.storage) {
    addValidationError(errors, 'Target storage is required.');
  } else {
    const validStorage = storageRecords.some(
      (item) => item.storage === clone.storage && (!item.node || !clone.target || item.node === clone.target),
    );
    if (!validStorage) {
      addValidationError(errors, 'Selected storage is not valid for the target node.');
    }
  }

  const sourceVmid = Number(source?.vmid);
  const sourceVm = safeArray(vms).find((item) => Number(item.vmid) === sourceVmid && item.node === source?.node);
  if (!sourceVm) {
    addValidationError(errors, 'Source VM was not found in the selected connector inventory.');
  }

  return { clone, errors };
}

function normalizeCreateVmPayload(payload = {}) {
  const vmid = Number(payload.vmid);
  const diskSizeGb = Number(payload.diskSizeGb);
  const storage = String(payload.storage || '').trim();
  const iso = String(payload.iso || '').trim();
  const description = String(payload.description || '').trim();
  const bridge = payload.bridge === undefined ? 'vmbr0' : String(payload.bridge || '').trim();
  const createPayload = {
    vmid,
    name: String(payload.name || '').trim(),
    memory: Number(payload.memoryMb),
    cores: Number(payload.cores),
    sockets: Number(payload.sockets || 1),
    scsihw: String(payload.scsihw || 'virtio-scsi-pci').trim(),
    scsi0: `${storage}:${Number.isFinite(diskSizeGb) ? diskSizeGb : 0}`,
    net0: `virtio,bridge=${bridge}`,
    ostype: String(payload.ostype || 'l26').trim(),
    agent: 1,
  };

  if (iso) {
    createPayload.ide2 = `${iso},media=cdrom`;
    createPayload.boot = 'order=scsi0;ide2';
  } else {
    createPayload.boot = 'order=scsi0';
  }
  if (description) {
    createPayload.description = description;
  }

  return {
    vm: {
      node: String(payload.node || '').trim(),
      vmid,
      name: createPayload.name,
      storage,
      diskSizeGb,
      cores: createPayload.cores,
      sockets: createPayload.sockets,
      memoryMb: createPayload.memory,
      bridge,
      iso,
      ostype: createPayload.ostype,
      scsihw: createPayload.scsihw,
      description,
      startAfterCreate: payload.startAfterCreate === true,
    },
    createPayload,
  };
}

function validateCreateVmRequest({ payload, nodes, vms, containers, storage }) {
  const { vm, createPayload } = normalizeCreateVmPayload(payload);
  const errors = [];
  const existingIds = [...safeArray(vms), ...safeArray(containers)]
    .map((item) => Number(item.vmid))
    .filter((value) => Number.isInteger(value));
  const nodeNames = safeArray(nodes).map((item) => item.node).filter(Boolean);
  const storageRecords = safeArray(storage);

  if (!vm.node) {
    addValidationError(errors, 'Target node is required.');
  } else if (nodeNames.length && !nodeNames.includes(vm.node)) {
    addValidationError(errors, 'Target node is not available.');
  }

  if (!Number.isInteger(vm.vmid) || vm.vmid <= 0) {
    addValidationError(errors, 'VM ID must be a positive number.');
  } else if (existingIds.includes(vm.vmid)) {
    addValidationError(errors, `VM ID ${vm.vmid} is already in use.`);
  }

  if (!vm.name) {
    addValidationError(errors, 'VM name is required.');
  }

  if (!vm.storage) {
    addValidationError(errors, 'Target storage is required.');
  } else {
    const validStorage = storageRecords.some(
      (item) => item.storage === vm.storage && item.status !== 'unknown' && (!item.node || item.node === vm.node),
    );
    if (!validStorage) {
      addValidationError(errors, 'Selected storage is not valid for the target node.');
    }
  }

  if (!Number.isFinite(vm.diskSizeGb) || vm.diskSizeGb <= 0) {
    addValidationError(errors, 'Disk size must be positive.');
  }
  if (!Number.isInteger(vm.cores) || vm.cores <= 0) {
    addValidationError(errors, 'CPU cores must be a positive whole number.');
  }
  if (!Number.isInteger(vm.memoryMb) || vm.memoryMb < 128) {
    addValidationError(errors, 'Memory must be at least 128 MB.');
  }
  if (!vm.bridge) {
    addValidationError(errors, 'Network bridge is required.');
  }

  return { vm, createPayload, errors };
}

function normalizeCreateContainerPayload(payload = {}) {
  const vmid = Number(payload.vmid);
  const diskSizeGb = Number(payload.diskSizeGb);
  const storage = String(payload.storage || '').trim();
  const bridge = payload.bridge === undefined ? 'vmbr0' : String(payload.bridge || '').trim();
  const createPayload = {
    vmid,
    hostname: String(payload.hostname || '').trim(),
    ostemplate: String(payload.template || '').trim(),
    rootfs: `${storage}:${Number.isFinite(diskSizeGb) ? diskSizeGb : 0}`,
    cores: Number(payload.cores),
    memory: Number(payload.memoryMb),
    swap: Number(payload.swapMb ?? 512),
    net0: `name=eth0,bridge=${bridge},ip=dhcp`,
    unprivileged: payload.unprivileged === false ? 0 : 1,
  };

  if (payload.password) {
    createPayload.password = String(payload.password);
  }

  return {
    container: {
      node: String(payload.node || '').trim(),
      vmid,
      hostname: createPayload.hostname,
      storage,
      template: createPayload.ostemplate,
      diskSizeGb,
      cores: createPayload.cores,
      memoryMb: createPayload.memory,
      swapMb: createPayload.swap,
      bridge,
      startAfterCreate: payload.startAfterCreate === true,
    },
    createPayload,
  };
}

function validateCreateContainerRequest({ payload, nodes, vms, containers, storage }) {
  const { container, createPayload } = normalizeCreateContainerPayload(payload);
  const errors = [];
  const existingIds = [...safeArray(vms), ...safeArray(containers)]
    .map((item) => Number(item.vmid))
    .filter((value) => Number.isInteger(value));
  const nodeNames = safeArray(nodes).map((item) => item.node).filter(Boolean);
  const storageRecords = safeArray(storage);

  if (!container.node) {
    addValidationError(errors, 'Target node is required.');
  } else if (nodeNames.length && !nodeNames.includes(container.node)) {
    addValidationError(errors, 'Target node is not available.');
  }
  if (!Number.isInteger(container.vmid) || container.vmid <= 0) {
    addValidationError(errors, 'Container ID must be a positive number.');
  } else if (existingIds.includes(container.vmid)) {
    addValidationError(errors, `VM/CT ID ${container.vmid} is already in use.`);
  }
  if (!container.hostname) {
    addValidationError(errors, 'Hostname is required.');
  }
  if (!container.storage) {
    addValidationError(errors, 'Target storage is required.');
  } else {
    const validStorage = storageRecords.some(
      (item) => item.storage === container.storage && item.status !== 'unknown' && (!item.node || item.node === container.node),
    );
    if (!validStorage) {
      addValidationError(errors, 'Selected storage is not valid for the target node.');
    }
  }
  if (!container.template) {
    addValidationError(errors, 'Template is required.');
  }
  if (!Number.isFinite(container.diskSizeGb) || container.diskSizeGb <= 0) {
    addValidationError(errors, 'Disk size must be positive.');
  }
  if (!Number.isInteger(container.cores) || container.cores <= 0) {
    addValidationError(errors, 'CPU cores must be a positive whole number.');
  }
  if (!Number.isInteger(container.memoryMb) || container.memoryMb < 128) {
    addValidationError(errors, 'Memory must be at least 128 MB.');
  }
  if (!Number.isInteger(container.swapMb) || container.swapMb < 0) {
    addValidationError(errors, 'Swap cannot be negative.');
  }
  if (!container.bridge) {
    addValidationError(errors, 'Network bridge is required.');
  }

  return { container, createPayload, errors };
}

function findVmForDelete({ source, vms }) {
  const sourceVmid = Number(source?.vmid);
  return safeArray(vms).find((item) => Number(item.vmid) === sourceVmid && item.node === source?.node && !item.template);
}

function validateDeleteRequest({ payload, source, vms }) {
  const errors = [];
  const vm = findVmForDelete({ source, vms });
  const confirmation = String(payload?.confirmation || '').trim();

  if (!vm) {
    addValidationError(errors, 'Source VM was not found in the selected connector inventory.');
  } else if (confirmation !== String(vm.vmid) && confirmation !== String(vm.name || '').trim()) {
    addValidationError(errors, 'Type the VM name or VM ID to confirm deletion.');
  }

  return {
    vm,
    force: payload?.force === true,
    confirmation,
    errors,
  };
}

function assertConfirmation(confirmation, expected, message) {
  if (String(confirmation || '').trim() !== String(expected || '').trim()) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

function findVmForTemplate({ source, vms }) {
  const sourceVmid = Number(source?.vmid);
  return safeArray(vms).find((item) => Number(item.vmid) === sourceVmid && item.node === source?.node);
}

function validateTemplateRequest({ payload, source, vms }) {
  const errors = [];
  const vm = findVmForTemplate({ source, vms });
  const confirmation = String(payload?.confirmation || '').trim();

  if (!vm) {
    addValidationError(errors, 'Source VM was not found in the selected connector inventory.');
  } else {
    if (vm.template) {
      addValidationError(errors, 'Source VM is already a template.');
    }
    if (vm.status === 'running') {
      addValidationError(errors, 'Stop the VM before converting it to a template.');
    }
    if (confirmation !== String(vm.vmid) && confirmation !== String(vm.name || '').trim()) {
      addValidationError(errors, 'Type the VM name or VM ID to confirm template conversion.');
    }
  }

  return {
    vm,
    confirmation,
    errors,
  };
}

function storageContentIncludes(storage, contentType) {
  const content = String(storage?.content || '').toLowerCase();
  if (!content) {
    return true;
  }
  return content
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(contentType);
}

function storageAllowedOnNode(storage, node) {
  const nodes = String(storage?.nodes || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return !nodes.length || nodes.includes(node);
}

function mergeStorageWithConfig(storage = [], storageConfig = []) {
  const configById = new Map(safeArray(storageConfig).map((item) => [item.storage, item]));
  const merged = safeArray(storage).map((item) => {
    const config = configById.get(item.storage) || {};
    configById.delete(item.storage);
    return {
      ...item,
      type: item.type || config.type || '',
      content: item.content || config.content || '',
      nodes: item.nodes || config.nodes || '',
      disable: item.disable ?? config.disable,
    };
  });
  return [
    ...merged,
    ...Array.from(configById.values()).map((config) => ({
      ...config,
      status: config.disable === true || config.disable === 1 ? 'disabled' : 'configured',
    })),
  ];
}

function validateBackupRequest({ payload, source, vms, containers, storage, storageConfig = [] }) {
  const normalizedType = source?.type === 'lxc' || source?.type === 'container' ? 'lxc' : 'qemu';
  const records = normalizedType === 'lxc' ? safeArray(containers) : safeArray(vms).filter((item) => !item.template);
  const resource = records.find((item) => Number(item.vmid) === Number(source?.vmid) && item.node === source?.node);
  const storageRecords = mergeStorageWithConfig(storage, storageConfig);
  const backup = {
    storage: String(payload?.storage || '').trim(),
    mode: String(payload?.mode || 'snapshot').trim(),
    compress: String(payload?.compress || 'zstd').trim(),
    notes: String(payload?.notes || '').trim(),
  };
  const errors = [];

  if (!resource) {
    addValidationError(errors, `Source ${normalizedType === 'lxc' ? 'container' : 'VM'} was not found in the selected connector inventory.`);
  }

  if (!backup.storage) {
    addValidationError(errors, 'Backup storage is required.');
  } else {
    const validStorage = storageRecords.some(
      (item) =>
        item.storage === backup.storage &&
        item.status !== 'disabled' &&
        item.disable !== true &&
        item.disable !== 1 &&
        (!item.node || item.node === source?.node) &&
        storageAllowedOnNode(item, source?.node) &&
        storageContentIncludes(item, 'backup'),
    );
    if (!validStorage) {
      addValidationError(errors, 'Selected storage is not valid for backups on this node.');
    }
  }

  return {
    backup,
    resource,
    resourceType: normalizedType,
    errors,
  };
}

function validateRestoreRequest({ payload, source, vms, containers, backups }) {
  const normalizedType = source?.type === 'lxc' || source?.type === 'container' ? 'lxc' : 'qemu';
  const targetVmid = Number(payload?.targetVmid);
  const restoreMode = payload?.restoreMode === 'new' ? 'new' : 'same';
  const archive = String(payload?.archive || '').trim();
  const confirmation = String(payload?.confirmation || '').trim();
  const targetName = String(payload?.targetName || '').trim();
  const existingIds = [...safeArray(vms), ...safeArray(containers)]
    .map((item) => Number(item.vmid))
    .filter((value) => Number.isInteger(value));
  const backup = safeArray(backups).find((item) => item.volid === archive);
  const errors = [];

  if (!backup) {
    addValidationError(errors, 'Backup archive was not found for this resource.');
  }
  if (!payload?.targetNode) {
    addValidationError(errors, 'Target node is required.');
  }
  if (!Number.isInteger(targetVmid) || targetVmid <= 0) {
    addValidationError(errors, 'Target VM/CT ID must be a positive whole number.');
  }
  if (confirmation !== String(targetVmid)) {
    addValidationError(errors, 'Type the target VM/CT ID to confirm restore.');
  }
  if (restoreMode === 'same' && targetVmid !== Number(source?.vmid)) {
    addValidationError(errors, 'Same-ID restore must use the original VM/CT ID.');
  }
  if (restoreMode === 'new' && targetVmid === Number(source?.vmid)) {
    addValidationError(errors, 'Choose a different VM/CT ID for a new-ID restore.');
  }
  if (restoreMode === 'new' && !targetName) {
    addValidationError(errors, 'Target VM/CT name is required for a new-ID restore.');
  }
  if (existingIds.includes(targetVmid) && payload?.force !== true) {
    addValidationError(errors, `VM/CT ID ${targetVmid} already exists. Enable force restore only when you intend to overwrite it.`);
  }

  return {
    restore: {
      archive,
      restoreMode,
      targetNode: String(payload?.targetNode || '').trim(),
      targetVmid,
      targetName,
      targetStorage: String(payload?.targetStorage || '').trim(),
      force: payload?.force === true,
    },
    backup,
    resourceType: normalizedType,
    errors,
  };
}

function normalizeStorageConfigPayload(payload = {}, { includeIdentity = true } = {}) {
  const type = String(payload.type || '').trim();
  const exportPath = String(payload.export || '').trim();
  const share = String(payload.share || '').trim() || (type === 'cifs' ? exportPath : '');
  const normalized = {
    ...(includeIdentity ? {
      storage: String(payload.storage || '').trim(),
      type,
    } : {}),
    content: String(payload.content || '').trim(),
    nodes: String(payload.nodes || '').trim(),
    path: String(payload.path || '').trim(),
    server: String(payload.server || '').trim(),
    export: type === 'cifs' ? '' : exportPath,
    share,
    portal: String(payload.portal || '').trim(),
    target: String(payload.target || '').trim(),
    pool: String(payload.pool || '').trim(),
    vgname: String(payload.vgname || '').trim(),
    thinpool: String(payload.thinpool || '').trim(),
    base: String(payload.base || '').trim(),
    datastore: String(payload.datastore || '').trim(),
    namespace: String(payload.namespace || '').trim(),
    fingerprint: String(payload.fingerprint || '').trim(),
    monhost: String(payload.monhost || '').trim(),
    'fs-name': String(payload.fsName || payload['fs-name'] || '').trim(),
    subdir: String(payload.subdir || '').trim(),
    is_mountpoint: String(payload.isMountpoint || payload.is_mountpoint || '').trim(),
    blocksize: String(payload.blocksize || '').trim(),
    iscsiprovider: String(payload.iscsiprovider || '').trim(),
    lio_tpg: String(payload.lioTpg || payload.lio_tpg || '').trim(),
    domain: String(payload.domain || '').trim(),
    smbversion: String(payload.smbversion || '').trim(),
    preallocation: String(payload.preallocation || '').trim(),
    format: String(payload.format || '').trim(),
    transport: String(payload.transport || '').trim(),
    username: String(payload.username || '').trim(),
    password: String(payload.password || ''),
    sparse: payload.sparse === true ? 1 : '',
    saferemove: payload.saferemove === true ? 1 : '',
    krbd: payload.krbd === true ? 1 : '',
    shared: payload.shared === true ? 1 : 0,
    disable: payload.enabled === false ? 1 : 0,
    comment: String(payload.notes || '').trim(),
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== ''),
  );
}

export function getDashboard(req, res) {
  return withClient(req, res, async (client, connector) => {
    const [nodes, vms, containers, storage, storageConfig] = await Promise.all([
      client.listNodes(),
      client.listVMs(),
      client.listContainers(),
      client.listStorage(),
      client.listStorageConfig().catch(() => []),
    ]);

    const dashboard = buildDashboard({ nodes, vms, containers, storage: mergeStorageWithConfig(storage, storageConfig) });
    await createHealthNotifications({ connectorId: connector.id || '', dashboard });
    return dashboard;
  }, { requireVerified: true });
}

export function listVMs(req, res) {
  return withClient(req, res, (client) => client.listVMs());
}

export function listContainers(req, res) {
  return withClient(req, res, (client) => client.listContainers());
}

export function listStorage(req, res) {
  return withClient(req, res, (client) => client.listStorage());
}

export function listStorageConfig(req, res) {
  return withClient(req, res, async (client) => {
    const [config, resources] = await Promise.all([
      client.listStorageConfig(),
      client.listStorage(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      config: safeArray(config),
      resources: safeArray(resources),
    };
  }, { requireVerified: true });
}

export function listStorageContent(req, res) {
  return withClient(req, res, async (client) => ({
    generatedAt: new Date().toISOString(),
    content: safeArray(await client.listStorageContent({
      node: req.params.node,
      storage: req.params.storage,
      content: req.query.content,
    })),
  }), { requireVerified: true });
}

export function listIsoVolumes(req, res) {
  return withClient(req, res, async (client) => {
    const config = safeArray(await client.listStorageConfig());
    const isoStorage = config.filter((item) => {
      const content = String(item.content || '').split(',').map((value) => value.trim());
      const nodes = String(item.nodes || '').split(',').map((value) => value.trim()).filter(Boolean);
      return content.includes('iso') && (!nodes.length || nodes.includes(req.params.node));
    });

    const results = await Promise.allSettled(
      isoStorage.map((item) => client.listStorageContent({
        node: req.params.node,
        storage: item.storage,
        content: 'iso',
      })),
    );

    const volumes = results.flatMap((result) => (result.status === 'fulfilled' ? safeArray(result.value) : []))
      .map((item) => ({
        volid: item.volid || '',
        name: item.volid ? String(item.volid).split('/').pop() : item.name || '',
        storage: item.storage || String(item.volid || '').split(':')[0] || '',
        size: item.size || 0,
        format: item.format || '',
      }))
      .filter((item) => item.volid);

    return {
      generatedAt: new Date().toISOString(),
      volumes,
    };
  }, { requireVerified: true });
}

export function listTemplateVolumes(req, res) {
  return withClient(req, res, async (client) => {
    const config = safeArray(await client.listStorageConfig());
    const templateStorage = config.filter((item) => {
      const content = String(item.content || '').split(',').map((value) => value.trim());
      const nodes = String(item.nodes || '').split(',').map((value) => value.trim()).filter(Boolean);
      return content.includes('vztmpl') && (!nodes.length || nodes.includes(req.params.node));
    });

    const results = await Promise.allSettled(
      templateStorage.map((item) => client.listStorageContent({
        node: req.params.node,
        storage: item.storage,
        content: 'vztmpl',
      })),
    );

    const volumes = results.flatMap((result) => (result.status === 'fulfilled' ? safeArray(result.value) : []))
      .map((item) => ({
        volid: item.volid || '',
        name: item.volid ? String(item.volid).split('/').pop() : item.name || '',
        storage: item.storage || String(item.volid || '').split(':')[0] || '',
        size: item.size || 0,
        format: item.format || '',
      }))
      .filter((item) => item.volid);

    return {
      generatedAt: new Date().toISOString(),
      volumes,
    };
  }, { requireVerified: true });
}

export async function createNodeNetwork(req, res) {
  const { node } = req.params;

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before creating network configuration.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const interfaces = await client.listNodeNetwork({ node });
    const { network, errors } = validateNetworkConfigRequest({
      payload: req.body,
      interfaces,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await client.createNodeNetwork({ node, payload: network });
    const refreshed = await client.listNodeNetwork({ node });

    await appendAuditLog({
      action: 'network-create',
      connectorId: connector.id,
      node,
      iface: network.iface,
      networkType: network.type,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.status(201).json({
      data: {
        message: `Network ${network.iface} created on ${node}. Apply pending network changes in Proxmox when ready.`,
        network: safeArray(refreshed).find((item) => item.iface === network.iface || item.name === network.iface) || null,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'network-create',
      node,
      iface: req.body?.iface,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function updateNodeNetwork(req, res) {
  const { node, iface } = req.params;

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before editing network configuration.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const interfaces = await client.listNodeNetwork({ node });
    const existing = safeArray(interfaces).find((item) => (item.iface || item.name) === iface);
    if (!existing) {
      const error = new Error(`Interface ${iface} was not found.`);
      error.statusCode = 404;
      throw error;
    }

    const { network, errors } = validateNetworkConfigRequest({
      payload: {
        ...req.body,
        iface,
        type: req.body?.type || existing.type || 'bridge',
      },
      interfaces: safeArray(interfaces).filter((item) => (item.iface || item.name) !== iface),
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await client.updateNodeNetwork({ node, iface, payload: networkUpdatePayload(network) });
    const refreshed = await client.listNodeNetwork({ node });

    await appendAuditLog({
      action: 'network-update',
      connectorId: connector.id,
      node,
      iface,
      networkType: network.type,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        message: `Network ${iface} updated on ${node}. Apply pending network changes when ready.`,
        network: safeArray(refreshed).find((item) => item.iface === iface || item.name === iface) || null,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'network-update',
      node,
      iface,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function deleteNodeNetwork(req, res) {
  const { node, iface } = req.params;

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before removing network configuration.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const interfaces = await client.listNodeNetwork({ node });
    const existing = safeArray(interfaces).find((item) => (item.iface || item.name) === iface);
    if (!existing) {
      const error = new Error(`Interface ${iface} was not found.`);
      error.statusCode = 404;
      throw error;
    }
    assertConfirmation(req.body?.confirmation, iface, 'Type the network interface name to confirm deletion.');

    await client.deleteNodeNetwork({ node, iface });
    const refreshed = await client.listNodeNetwork({ node });

    await appendAuditLog({
      action: 'network-delete',
      connectorId: connector.id,
      node,
      iface,
      networkType: existing.type || '',
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        message: `Network ${iface} removed from ${node}. Apply pending network changes when ready.`,
        interfaces: safeArray(refreshed),
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'network-delete',
      node,
      iface,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function applyNodeNetwork(req, res) {
  const { node } = req.params;

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before applying network configuration.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await client.applyNodeNetwork({ node });
    const refreshed = await client.listNodeNetwork({ node });

    await appendAuditLog({
      action: 'network-apply',
      connectorId: connector.id,
      node,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        message: `Network configuration applied on ${node}.`,
        interfaces: safeArray(refreshed),
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'network-apply',
      node,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function setNodeNetworkActive(req, res) {
  const { node, iface } = req.params;
  const shouldActivate = req.params.state === 'activate';
  const action = shouldActivate ? 'network-activate' : 'network-deactivate';

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before changing network status.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const interfaces = await client.listNodeNetwork({ node });
    const existing = safeArray(interfaces).find((item) => (item.iface || item.name) === iface);
    if (!existing) {
      const error = new Error(`Interface ${iface} was not found.`);
      error.statusCode = 404;
      throw error;
    }

    await client.updateNodeNetwork({
      node,
      iface,
      payload: { autostart: shouldActivate ? 1 : 0 },
    });
    await client.applyNodeNetwork({ node });
    const refreshed = await client.listNodeNetwork({ node });
    const network = safeArray(refreshed).find((item) => item.iface === iface || item.name === iface) || null;

    await appendAuditLog({
      action,
      connectorId: connector.id,
      node,
      iface,
      networkType: existing.type || '',
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        message: shouldActivate
          ? `Network ${iface} activated on ${node}.`
          : `Network ${iface} deactivated on ${node}.`,
        network,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action,
      node,
      iface,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export function getSdn(req, res) {
  return withClient(req, res, async (client) => {
    const [zones, vnets, ipams] = await Promise.all([
      client.listSdnZones(),
      client.listSdnVnets(),
      client.listSdnIpams(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      zones: safeArray(zones).map((item) => normalizeSdnRecord(item, item.zone)),
      vnets: safeArray(vnets).map((item) => normalizeSdnRecord(item, item.vnet)),
      ipams: safeArray(ipams).map((item) => normalizeSdnRecord({ ...item, token: undefined }, item.ipam)),
    };
  }, { requireVerified: true });
}

export async function createSdnZone(req, res) {
  const payload = normalizeSdnZonePayload(req.body);
  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before creating an SDN zone.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await client.createSdnZone(payload);
    const zones = await client.listSdnZones();
    await appendAuditLog({
      action: 'sdn-zone-create',
      connectorId: connector.id,
      zone: payload.zone,
      zoneType: payload.type,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.status(201).json({
      data: {
        message: `SDN zone ${payload.zone} created. Apply SDN changes when ready.`,
        zone: safeArray(zones).find((item) => item.zone === payload.zone) || null,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'sdn-zone-create',
      zone: payload.zone,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function createSdnVnet(req, res) {
  const payload = normalizeSdnVnetPayload(req.body);
  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before creating an SDN VNet.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await client.createSdnVnet(payload);
    const vnets = await client.listSdnVnets();
    await appendAuditLog({
      action: 'sdn-vnet-create',
      connectorId: connector.id,
      vnet: payload.vnet,
      zone: payload.zone,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.status(201).json({
      data: {
        message: `SDN VNet ${payload.vnet} created. Apply SDN changes when ready.`,
        vnet: safeArray(vnets).find((item) => item.vnet === payload.vnet) || null,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'sdn-vnet-create',
      vnet: payload.vnet,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function createSdnIpam(req, res) {
  const payload = normalizeSdnIpamPayload(req.body);
  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before creating an SDN IPAM.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await client.createSdnIpam(payload);
    const ipams = await client.listSdnIpams();
    await appendAuditLog({
      action: 'sdn-ipam-create',
      connectorId: connector.id,
      ipam: payload.ipam,
      ipamType: payload.type,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.status(201).json({
      data: {
        message: `SDN IPAM ${payload.ipam} created. Apply SDN changes when ready.`,
        ipam: safeArray(ipams).find((item) => item.ipam === payload.ipam) || null,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'sdn-ipam-create',
      ipam: payload.ipam,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function deleteSdnZone(req, res) {
  const { zone } = req.params;
  try {
    assertConfirmation(req.body?.confirmation, zone, 'Type the SDN zone ID to confirm deletion.');
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before deleting an SDN zone.');
      error.statusCode = 400;
      throw error;
    }
    const client = createProxmoxApiClient(connector);
    await client.deleteSdnZone({ zone });
    await appendAuditLog({ action: 'sdn-zone-delete', connectorId: connector.id, zone, status: 'succeeded', user: req.user?.username || 'unknown' });
    res.json({ data: { message: `SDN zone ${zone} deleted. Apply SDN changes when ready.` } });
  } catch (error) {
    await appendAuditLog({ action: 'sdn-zone-delete', zone, status: 'failed', message: error.message, user: req.user?.username || 'unknown' }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function deleteSdnVnet(req, res) {
  const { vnet } = req.params;
  try {
    assertConfirmation(req.body?.confirmation, vnet, 'Type the SDN VNet ID to confirm deletion.');
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before deleting an SDN VNet.');
      error.statusCode = 400;
      throw error;
    }
    const client = createProxmoxApiClient(connector);
    await client.deleteSdnVnet({ vnet });
    await appendAuditLog({ action: 'sdn-vnet-delete', connectorId: connector.id, vnet, status: 'succeeded', user: req.user?.username || 'unknown' });
    res.json({ data: { message: `SDN VNet ${vnet} deleted. Apply SDN changes when ready.` } });
  } catch (error) {
    await appendAuditLog({ action: 'sdn-vnet-delete', vnet, status: 'failed', message: error.message, user: req.user?.username || 'unknown' }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function deleteSdnIpam(req, res) {
  const { ipam } = req.params;
  try {
    assertConfirmation(req.body?.confirmation, ipam, 'Type the SDN IPAM ID to confirm deletion.');
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before deleting an SDN IPAM.');
      error.statusCode = 400;
      throw error;
    }
    const client = createProxmoxApiClient(connector);
    await client.deleteSdnIpam({ ipam });
    await appendAuditLog({ action: 'sdn-ipam-delete', connectorId: connector.id, ipam, status: 'succeeded', user: req.user?.username || 'unknown' });
    res.json({ data: { message: `SDN IPAM ${ipam} deleted. Apply SDN changes when ready.` } });
  } catch (error) {
    await appendAuditLog({ action: 'sdn-ipam-delete', ipam, status: 'failed', message: error.message, user: req.user?.username || 'unknown' }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function applySdn(req, res) {
  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before applying SDN configuration.');
      error.statusCode = 400;
      throw error;
    }
    const client = createProxmoxApiClient(connector);
    await client.applySdn();
    await appendAuditLog({ action: 'sdn-apply', connectorId: connector.id, status: 'succeeded', user: req.user?.username || 'unknown' });
    res.json({ data: { message: 'SDN configuration applied.' } });
  } catch (error) {
    await appendAuditLog({ action: 'sdn-apply', status: 'failed', message: error.message, user: req.user?.username || 'unknown' }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function createStorageConfig(req, res) {
  const payload = normalizeStorageConfigPayload(req.body, { includeIdentity: true });

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before creating storage.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await client.createStorageConfig(payload);
    const config = await client.listStorageConfig();

    await appendAuditLog({
      action: 'storage-create',
      connectorId: connector.id,
      storage: payload.storage,
      storageType: payload.type,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.status(201).json({
      data: {
        message: `Storage ${payload.storage} created.`,
        storage: safeArray(config).find((item) => item.storage === payload.storage) || null,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'storage-create',
      storage: payload.storage,
      storageType: payload.type,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function updateStorageConfig(req, res) {
  const { storage } = req.params;
  const payload = normalizeStorageConfigPayload(req.body, { includeIdentity: false });

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before updating storage.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await client.updateStorageConfig({ storage, payload });
    const config = await client.listStorageConfig();

    await appendAuditLog({
      action: 'storage-update',
      connectorId: connector.id,
      storage,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        message: `Storage ${storage} updated.`,
        storage: safeArray(config).find((item) => item.storage === storage) || null,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'storage-update',
      storage,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function deleteStorageConfig(req, res) {
  const { storage } = req.params;
  const confirmation = String(req.body?.confirmation || '').trim();

  try {
    if (confirmation !== storage) {
      const error = new Error('Type the storage ID to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }

    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before deleting storage.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await client.deleteStorageConfig({ storage });

    await appendAuditLog({
      action: 'storage-delete',
      connectorId: connector.id,
      storage,
      status: 'succeeded',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        message: `Storage ${storage} configuration deleted.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'storage-delete',
      storage,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

function formatTaskDescription(task) {
  const type = String(task.type || '').toLowerCase();
  const id = task.id || task.vmid || '';
  const labels = {
    clone: 'Clone',
    qmclone: 'Clone',
    qmsnapshot: 'Snapshot',
    qmstart: 'Start',
    qmstop: 'Stop',
    qmshutdown: 'Shutdown',
    qmreboot: 'Reboot',
    vzstart: 'Start',
    vzstop: 'Stop',
    vzshutdown: 'Shutdown',
    vncproxy: 'Console',
    spiceproxy: 'Console',
  };
  const label = labels[type] || (task.type ? String(task.type) : 'Task');
  return id ? `VM/CT ${id} - ${label}` : label;
}

function taskActionContext(task = {}) {
  const type = String(task.type || '').toLowerCase();
  const id = task.id || task.vmid || '';
  const contexts = {
    qmstart: { action: 'start', resourceType: 'qemu', retryable: true },
    qmstop: { action: 'stop', resourceType: 'qemu', retryable: true },
    qmshutdown: { action: 'shutdown', resourceType: 'qemu', retryable: true },
    qmreboot: { action: 'reboot', resourceType: 'qemu', retryable: true },
    qmsuspend: { action: 'suspend', resourceType: 'qemu', retryable: true },
    vzstart: { action: 'start', resourceType: 'lxc', retryable: true },
    vzstop: { action: 'stop', resourceType: 'lxc', retryable: true },
    vzshutdown: { action: 'shutdown', resourceType: 'lxc', retryable: true },
    vzreboot: { action: 'reboot', resourceType: 'lxc', retryable: true },
  };
  const context = contexts[type] || { action: type || 'task', resourceType: '', retryable: false };
  return {
    ...context,
    vmid: id ? Number(id) : null,
    linkedResource: context.resourceType && id
      ? { type: context.resourceType, vmid: Number(id), node: task.node || '' }
      : null,
  };
}

function normalizeTask(task) {
  const startedAt = task.starttime ? new Date(Number(task.starttime) * 1000).toISOString() : null;
  const endedAt = task.endtime ? new Date(Number(task.endtime) * 1000).toISOString() : null;
  const context = taskActionContext(task);
  return {
    upid: task.upid || '',
    node: task.node || '',
    user: task.user || '',
    type: task.type || '',
    id: task.id || task.vmid || '',
    status: task.status || task.exitstatus || (task.endtime ? 'unknown' : 'running'),
    exitstatus: task.exitstatus || '',
    startedAt,
    endedAt,
    description: formatTaskDescription(task),
    action: context.action,
    resourceType: context.resourceType,
    retryable: context.retryable && Boolean(context.vmid),
    linkedResource: context.linkedResource,
  };
}

function normalizeClusterLogEntry(entry) {
  return {
    id: entry.id || `${entry.time || ''}-${entry.node || ''}-${entry.msg || ''}`,
    time: entry.time ? new Date(Number(entry.time) * 1000).toISOString() : null,
    node: entry.node || '',
    user: entry.user || '',
    priority: entry.priority || entry.pri || '',
    message: entry.msg || entry.message || '',
  };
}

function normalizeTaskLogLine(line) {
  return {
    line: Number(line.n || line.line || 0),
    text: String(line.t || line.text || ''),
  };
}

export function listTasks(req, res) {
  return withClient(req, res, async (client) => {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const nodes = await client.listNodes();
    const taskGroups = await Promise.all(
      safeArray(nodes).map((node) =>
        client.listNodeTasks({
          node: node.node,
          limit,
        }),
      ),
    );
    const tasks = taskGroups
      .flatMap((group) => safeArray(group))
      .sort((left, right) => Number(right.starttime || 0) - Number(left.starttime || 0))
      .slice(0, limit);
    return {
      generatedAt: new Date().toISOString(),
      tasks: safeArray(tasks).map(normalizeTask),
    };
  }, { requireVerified: true });
}

export function getTaskDetail(req, res) {
  return withClient(req, res, async (client) => {
    const [status, log] = await Promise.all([
      client.getTaskStatus({
        node: req.params.node,
        upid: req.params.upid,
      }),
      client.getTaskLog({
        node: req.params.node,
        upid: req.params.upid,
        start: req.query.start ? Number(req.query.start) : 0,
        limit: req.query.limit ? Number(req.query.limit) : 500,
      }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      task: normalizeTask({
        ...status,
        upid: req.params.upid,
        node: req.params.node,
      }),
      status,
      output: safeArray(log).map(normalizeTaskLogLine),
    };
  }, { requireVerified: true });
}

export function stopTask(req, res) {
  return withClient(req, res, async (client) => {
    assertConfirmation(req.body?.confirmation, req.params.upid, 'Type the task ID to confirm cancellation.');
    const status = await client.getTaskStatus({
      node: req.params.node,
      upid: req.params.upid,
    });

    if (status.status === 'stopped') {
      const error = new Error('Task is already stopped.');
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'stop-task',
      node: req.params.node,
      taskId: req.params.upid,
      status: 'requested',
      user: req.user?.username || 'unknown',
    });

    const result = await client.stopTask({
      node: req.params.node,
      upid: req.params.upid,
    });

    return {
      message: 'Task stop requested.',
      result,
    };
  }, { requireVerified: true });
}

export function listClusterLog(req, res) {
  return withClient(req, res, async (client) => {
    const entries = await client.listClusterLog({
      max: req.query.limit ? Number(req.query.limit) : 100,
    });
    return {
      generatedAt: new Date().toISOString(),
      entries: safeArray(entries).map(normalizeClusterLogEntry),
    };
  }, { requireVerified: true });
}

export function getResourceStatus(req, res) {
  return withClient(req, res, (client) =>
    client.getResourceStatus({
      node: req.params.node,
      type: req.params.type,
      vmid: req.params.vmid,
    }),
  );
}

export function startVM(req, res) {
  return withClient(req, res, (client) =>
    client.startVM({
      node: req.params.node,
      type: req.params.type,
      vmid: req.params.vmid,
    }),
  );
}

export function stopVM(req, res) {
  return withClient(req, res, (client) =>
    client.stopVM({
      node: req.params.node,
      type: req.params.type,
      vmid: req.params.vmid,
    }),
  );
}

export async function runResourceAction(req, res) {
  const { type, node, vmid, action } = req.params;
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';
  const target = { node, type: normalizedType, vmid };

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before running operations.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const currentStatus = await client.getResourceStatus(target);

    if (!isActionAllowed({ action, type: normalizedType, status: currentStatus.status })) {
      const error = new Error(`Action ${action} is not valid for a ${normalizedType} resource with status ${currentStatus.status || 'unknown'}.`);
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action,
      connectorId: connector.id,
      node,
      vmid,
      resourceType: normalizedType,
      status: 'requested',
      user: req.user?.username || 'unknown',
    });

    const run = actionRunner(client, action);
    const taskId = await run(target);
    const task = await client.pollTask({
      node,
      upid: taskId,
      timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
    });
    const refreshed = await client.getResourceStatus(target);
    const success = !task.exitstatus || task.exitstatus === 'OK';

    await appendAuditLog({
      action,
      connectorId: connector.id,
      node,
      vmid,
      resourceType: normalizedType,
      status: success ? 'succeeded' : 'failed',
      taskId,
      exitstatus: task.exitstatus || '',
      user: req.user?.username || 'unknown',
    });

    if (!success) {
      await createNotification({
        type: 'vm-action-failed',
        severity: 'critical',
        title: `${action} failed for ${normalizedType.toUpperCase()} ${vmid}`,
        message: `Proxmox task finished with status ${task.exitstatus || 'unknown'}.`,
        connectorId: connector.id,
        node,
        vmid,
        resourceType: normalizedType,
        taskId,
        source: 'operation',
        dedupeKey: `vm-action-failed:${connector.id}:${node}:${normalizedType}:${vmid}:${action}:${taskId}`,
      });
    }

    res.json({
      data: {
        action,
        success,
        taskId,
        task,
        resource: refreshed,
        message: success
          ? `${action} completed for ${normalizedType} ${vmid}.`
          : `${action} finished with status ${task.exitstatus}.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action,
      node,
      vmid,
      resourceType: normalizedType,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    await createNotification({
      type: 'vm-action-failed',
      severity: 'critical',
      title: `${action} failed for ${normalizedType.toUpperCase()} ${vmid}`,
      message: error.message,
      node,
      vmid,
      resourceType: normalizedType,
      source: 'operation',
      dedupeKey: `vm-action-failed:${node}:${normalizedType}:${vmid}:${action}:${error.message}`,
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function listAuditLog(_req, res) {
  const entries = await readAuditLog();
  res.json({ entries: entries.slice(-100).reverse() });
}

export async function cloneVM(req, res) {
  const { node, vmid } = req.params;
  const source = { node, vmid };

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before cloning a VM.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const [nodes, vms, containers, storage] = await Promise.all([
      client.listNodes(),
      client.listVMs(),
      client.listContainers(),
      client.listStorage(),
    ]);
    const { clone, errors } = validateCloneRequest({
      payload: req.body,
      source,
      nodes,
      vms,
      containers,
      storage,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'clone',
      connectorId: connector.id,
      node,
      vmid,
      resourceType: 'qemu',
      status: 'requested',
      targetNode: clone.target,
      newVmid: clone.newid,
      user: req.user?.username || 'unknown',
    });

    const taskId = await client.cloneVM({
      node,
      vmid,
      newid: clone.newid,
      name: clone.name,
      target: clone.target,
      storage: clone.storage,
      full: clone.full,
      description: clone.description,
    });
    const task = await client.pollTask({
      node,
      upid: taskId,
      timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
    });
    const refreshed = await client.listVMs();
    const clonedVm = safeArray(refreshed).find((item) => Number(item.vmid) === clone.newid) || null;
    const success = !task.exitstatus || task.exitstatus === 'OK';

    await appendAuditLog({
      action: 'clone',
      connectorId: connector.id,
      node,
      vmid,
      resourceType: 'qemu',
      status: success ? 'succeeded' : 'failed',
      targetNode: clone.target,
      newVmid: clone.newid,
      taskId,
      exitstatus: task.exitstatus || '',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        action: 'clone',
        success,
        taskId,
        task,
        resource: clonedVm,
        message: success
          ? `Clone completed for VM ${vmid} as ${clone.newid}.`
          : `Clone finished with status ${task.exitstatus}.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'clone',
      node,
      vmid,
      resourceType: 'qemu',
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function createVM(req, res) {
  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before creating a VM.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const [nodes, vms, containers, storage] = await Promise.all([
      client.listNodes(),
      client.listVMs(),
      client.listContainers(),
      client.listStorage(),
    ]);
    const { vm, createPayload, errors } = validateCreateVmRequest({
      payload: req.body,
      nodes,
      vms,
      containers,
      storage,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'create-vm',
      connectorId: connector.id,
      node: vm.node,
      vmid: vm.vmid,
      resourceType: 'qemu',
      status: 'requested',
      user: req.user?.username || 'unknown',
    });

    const taskId = await client.createVM({ node: vm.node, payload: createPayload });
    const task = typeof taskId === 'string' && taskId.startsWith('UPID:')
      ? await client.pollTask({
        node: vm.node,
        upid: taskId,
        timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
      })
      : { status: 'stopped', exitstatus: 'OK' };

    let startTask = null;
    if (vm.startAfterCreate && (!task.exitstatus || task.exitstatus === 'OK')) {
      const startTaskId = await client.startVM({ node: vm.node, type: 'qemu', vmid: vm.vmid });
      startTask = await client.pollTask({
        node: vm.node,
        upid: startTaskId,
        timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
      });
    }

    const refreshed = await client.listVMs();
    const createdVm = safeArray(refreshed).find((item) => Number(item.vmid) === vm.vmid && item.node === vm.node) || null;
    const success = (!task.exitstatus || task.exitstatus === 'OK') && (!startTask || !startTask.exitstatus || startTask.exitstatus === 'OK');

    await appendAuditLog({
      action: 'create-vm',
      connectorId: connector.id,
      node: vm.node,
      vmid: vm.vmid,
      resourceType: 'qemu',
      taskId,
      status: success ? 'succeeded' : 'failed',
      message: `VM ${vm.vmid} creation ${success ? 'completed' : 'finished with errors'}.`,
      user: req.user?.username || 'unknown',
    });

    res.status(201).json({
      data: {
        action: 'create',
        success,
        taskId,
        task,
        startTask,
        resource: createdVm,
        message: success
          ? `VM ${vm.vmid} created${vm.startAfterCreate ? ' and started' : ''}.`
          : `VM ${vm.vmid} creation finished with errors.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'create-vm',
      node: req.body?.node,
      vmid: req.body?.vmid,
      resourceType: 'qemu',
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function createContainer(req, res) {
  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before creating a container.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const [nodes, vms, containers, storage] = await Promise.all([
      client.listNodes(),
      client.listVMs(),
      client.listContainers(),
      client.listStorage(),
    ]);
    const { container, createPayload, errors } = validateCreateContainerRequest({
      payload: req.body,
      nodes,
      vms,
      containers,
      storage,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'create-container',
      connectorId: connector.id,
      node: container.node,
      vmid: container.vmid,
      resourceType: 'lxc',
      status: 'requested',
      user: req.user?.username || 'unknown',
    });

    const taskId = await client.createContainer({ node: container.node, payload: createPayload });
    const task = typeof taskId === 'string' && taskId.startsWith('UPID:')
      ? await client.pollTask({
        node: container.node,
        upid: taskId,
        timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
      })
      : { status: 'stopped', exitstatus: 'OK' };

    let startTask = null;
    if (container.startAfterCreate && (!task.exitstatus || task.exitstatus === 'OK')) {
      const startTaskId = await client.startVM({ node: container.node, type: 'lxc', vmid: container.vmid });
      startTask = await client.pollTask({
        node: container.node,
        upid: startTaskId,
        timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
      });
    }

    const refreshed = await client.listContainers();
    const created = safeArray(refreshed).find((item) => Number(item.vmid) === container.vmid && item.node === container.node) || null;
    const success = (!task.exitstatus || task.exitstatus === 'OK') && (!startTask || !startTask.exitstatus || startTask.exitstatus === 'OK');

    await appendAuditLog({
      action: 'create-container',
      connectorId: connector.id,
      node: container.node,
      vmid: container.vmid,
      resourceType: 'lxc',
      taskId,
      status: success ? 'succeeded' : 'failed',
      message: `Container ${container.vmid} creation ${success ? 'completed' : 'finished with errors'}.`,
      user: req.user?.username || 'unknown',
    });

    res.status(201).json({
      data: {
        action: 'create-container',
        success,
        taskId,
        task,
        startTask,
        resource: created,
        message: success
          ? `Container ${container.vmid} created${container.startAfterCreate ? ' and started' : ''}.`
          : `Container ${container.vmid} creation finished with errors.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'create-container',
      node: req.body?.node,
      vmid: req.body?.vmid,
      resourceType: 'lxc',
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function deleteVM(req, res) {
  const { type, node, vmid } = req.params;
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';

  try {
    if (normalizedType !== 'qemu') {
      const error = new Error('Only VM deletion is supported in this workflow.');
      error.statusCode = 400;
      throw error;
    }

    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before deleting a VM.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const vms = await client.listVMs();
    const { vm, force, confirmation, errors } = validateDeleteRequest({
      payload: req.body,
      source: { node, vmid },
      vms,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'delete',
      connectorId: connector.id,
      node,
      vmid,
      resourceType: 'qemu',
      status: 'requested',
      vmName: vm.name || '',
      force,
      user: req.user?.username || 'unknown',
    });

    const taskId = await client.deleteVM({
      node,
      type: 'qemu',
      vmid,
      force,
    });
    const task = await client.pollTask({
      node,
      upid: taskId,
      timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
    });
    const refreshed = await client.listVMs();
    const stillExists = safeArray(refreshed).some((item) => Number(item.vmid) === Number(vmid) && item.node === node);
    const success = (!task.exitstatus || task.exitstatus === 'OK') && !stillExists;

    await appendAuditLog({
      action: 'delete',
      connectorId: connector.id,
      node,
      vmid,
      resourceType: 'qemu',
      status: success ? 'succeeded' : 'failed',
      vmName: vm.name || '',
      force,
      taskId,
      exitstatus: task.exitstatus || '',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        action: 'delete',
        success,
        taskId,
        task,
        resource: null,
        confirmation,
        message: success
          ? `Delete completed for VM ${vmid}.`
          : `Delete finished but VM ${vmid} is still present or task status was ${task.exitstatus}.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'delete',
      node,
      vmid,
      resourceType: normalizedType,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function retryTask(req, res) {
  const { node, upid } = req.params;

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before retrying jobs.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const originalStatus = await client.getTaskStatus({ node, upid });
    const originalTask = normalizeTask({ ...originalStatus, node, upid });

    if (!originalTask.retryable || !originalTask.linkedResource?.vmid) {
      const error = new Error('This job cannot be retried automatically because the original task does not contain enough safe action details.');
      error.statusCode = 400;
      throw error;
    }

    const retryTarget = {
      node,
      type: originalTask.resourceType,
      vmid: originalTask.linkedResource.vmid,
    };
    const run = actionRunner(client, originalTask.action);
    if (!run) {
      const error = new Error('This job action is not supported for retry.');
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: `retry-${originalTask.action}`,
      connectorId: connector.id,
      node,
      vmid: retryTarget.vmid,
      resourceType: originalTask.resourceType,
      status: 'requested',
      originalTaskId: upid,
      user: req.user?.username || 'unknown',
    });

    const taskId = await run(retryTarget);
    const task = await client.pollTask({
      node,
      upid: taskId,
      timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
    });
    const success = !task.exitstatus || task.exitstatus === 'OK';

    await appendAuditLog({
      action: `retry-${originalTask.action}`,
      connectorId: connector.id,
      node,
      vmid: retryTarget.vmid,
      resourceType: originalTask.resourceType,
      status: success ? 'succeeded' : 'failed',
      originalTaskId: upid,
      taskId,
      exitstatus: task.exitstatus || '',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        action: `retry-${originalTask.action}`,
        success,
        taskId,
        task,
        resource: retryTarget,
        message: success
          ? `Retry completed for ${originalTask.resourceType} ${retryTarget.vmid}.`
          : `Retry finished with status ${task.exitstatus}.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'retry-task',
      node,
      originalTaskId: upid,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function backupResource(req, res) {
  const { type, node, vmid } = req.params;
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before starting a backup.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const [vms, containers, storage, storageConfig] = await Promise.all([
      client.listVMs(),
      client.listContainers(),
      client.listStorage(),
      client.listStorageConfig().catch(() => []),
    ]);
    const { backup, resource, resourceType, errors } = validateBackupRequest({
      payload: req.body,
      source: { type: normalizedType, node, vmid },
      vms,
      containers,
      storage,
      storageConfig,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'backup',
      connectorId: connector.id,
      node,
      vmid,
      resourceType,
      status: 'requested',
      storage: backup.storage,
      mode: backup.mode,
      compress: backup.compress,
      resourceName: resource?.name || resource?.hostname || '',
      user: req.user?.username || 'unknown',
    });

    const taskId = await client.backupResource({
      node,
      vmid,
      storage: backup.storage,
      mode: backup.mode,
      compress: backup.compress,
      notes: backup.notes,
    });
    const task = await client.pollTask({
      node,
      upid: taskId,
      timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
    });
    const success = !task.exitstatus || task.exitstatus === 'OK';

    await appendAuditLog({
      action: 'backup',
      connectorId: connector.id,
      node,
      vmid,
      resourceType,
      status: success ? 'succeeded' : 'failed',
      storage: backup.storage,
      mode: backup.mode,
      compress: backup.compress,
      taskId,
      exitstatus: task.exitstatus || '',
      user: req.user?.username || 'unknown',
    });

    if (!success) {
      await createNotification({
        type: 'backup-failed',
        severity: 'critical',
        title: `Backup failed for ${resourceType === 'lxc' ? 'container' : 'VM'} ${vmid}`,
        message: `Backup task finished with status ${task.exitstatus || 'unknown'}.`,
        connectorId: connector.id,
        node,
        vmid,
        resourceType,
        taskId,
        source: 'backup',
        metadata: { storage: backup.storage },
        dedupeKey: `backup-failed:${connector.id}:${node}:${resourceType}:${vmid}:${taskId}`,
      });
    }

    res.json({
      data: {
        action: 'backup',
        success,
        taskId,
        task,
        resource,
        message: success
          ? `Backup completed for ${resourceType === 'lxc' ? 'container' : 'VM'} ${vmid}.`
          : `Backup finished with status ${task.exitstatus}.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'backup',
      node,
      vmid,
      resourceType: normalizedType,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    await createNotification({
      type: 'backup-failed',
      severity: 'critical',
      title: `Backup failed for ${normalizedType === 'lxc' ? 'container' : 'VM'} ${vmid}`,
      message: error.message,
      node,
      vmid,
      resourceType: normalizedType,
      source: 'backup',
      dedupeKey: `backup-failed:${node}:${normalizedType}:${vmid}:${error.message}`,
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function listBackupSchedules(_req, res) {
  const schedules = await readBackupSchedules();
  res.json({ data: { schedules } });
}

async function validateSchedulePayload(payload) {
  const connector = await getConnectorForUse(payload.connectorId);
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected connector before scheduling backups.');
    error.statusCode = 400;
    throw error;
  }

  const client = createProxmoxApiClient(connector);
  const [vms, containers, storage, storageConfig] = await Promise.all([
    client.listVMs(),
    client.listContainers(),
    client.listStorage(),
    client.listStorageConfig().catch(() => []),
  ]);
  const { errors } = validateBackupRequest({
    payload,
    source: { type: payload.resourceType, node: payload.node, vmid: payload.vmid },
    vms,
    containers,
    storage,
    storageConfig,
  });

  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.statusCode = 400;
    throw error;
  }
}

export async function createBackupSchedule(req, res) {
  try {
    await validateSchedulePayload(req.body);
    const schedule = await createBackupScheduleRecord(req.body);
    await appendAuditLog({
      action: 'backup-schedule-create',
      connectorId: schedule.connectorId,
      node: schedule.node,
      vmid: schedule.vmid,
      resourceType: schedule.resourceType,
      status: 'succeeded',
      scheduleId: schedule.id,
      user: req.user?.username || 'unknown',
    });
    res.status(201).json({ data: { schedule, message: 'Backup schedule created.' } });
  } catch (error) {
    await appendAuditLog({
      action: 'backup-schedule-create',
      node: req.body?.node,
      vmid: req.body?.vmid,
      resourceType: req.body?.resourceType,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function updateBackupSchedule(req, res) {
  try {
    await validateSchedulePayload(req.body);
    const schedule = await updateBackupScheduleRecord(req.params.id, req.body);
    await appendAuditLog({
      action: 'backup-schedule-update',
      connectorId: schedule.connectorId,
      node: schedule.node,
      vmid: schedule.vmid,
      resourceType: schedule.resourceType,
      status: 'succeeded',
      scheduleId: schedule.id,
      user: req.user?.username || 'unknown',
    });
    res.json({ data: { schedule, message: 'Backup schedule updated.' } });
  } catch (error) {
    await appendAuditLog({
      action: 'backup-schedule-update',
      scheduleId: req.params.id,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function deleteBackupSchedule(req, res) {
  try {
    assertConfirmation(req.body?.confirmation, req.params.id, 'Type the backup schedule ID to confirm deletion.');
    await deleteBackupScheduleRecord(req.params.id);
    await appendAuditLog({
      action: 'backup-schedule-delete',
      status: 'succeeded',
      scheduleId: req.params.id,
      user: req.user?.username || 'unknown',
    });
    res.json({ data: { message: 'Backup schedule deleted.' } });
  } catch (error) {
    await appendAuditLog({
      action: 'backup-schedule-delete',
      scheduleId: req.params.id,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function listResourceBackups(req, res) {
  const { type, node, vmid } = req.params;
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';
  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before loading backup history.');
      error.statusCode = 400;
      throw error;
    }
    const client = createProxmoxApiClient(connector);
    const backups = await listBackupsForResource(client, {
      node,
      type: normalizedType,
      vmid,
      storage: req.query.storage,
    });
    res.json({ data: { generatedAt: new Date().toISOString(), backups } });
  } catch (error) {
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function restoreResource(req, res) {
  const { type, node, vmid } = req.params;
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before restoring a backup.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const [vms, containers, backups] = await Promise.all([
      client.listVMs(),
      client.listContainers(),
      listBackupsForResource(client, { node, type: normalizedType, vmid }),
    ]);
    const { restore, errors } = validateRestoreRequest({
      payload: req.body,
      source: { type: normalizedType, node, vmid },
      vms,
      containers,
      backups,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'restore',
      connectorId: connector.id,
      node: restore.targetNode,
      vmid: restore.targetVmid,
      sourceNode: node,
      sourceVmid: vmid,
      resourceType: normalizedType,
      status: 'requested',
      archive: restore.archive,
      restoreMode: restore.restoreMode,
      targetName: restore.targetName,
      targetStorage: restore.targetStorage,
      force: restore.force,
      user: req.user?.username || 'unknown',
    });

    const taskId = normalizedType === 'lxc'
      ? await client.restoreContainer({
        node: restore.targetNode,
        vmid: restore.targetVmid,
        archive: restore.archive,
        storage: restore.targetStorage,
        force: restore.force,
        hostname: restore.targetName,
      })
      : await client.restoreVM({
        node: restore.targetNode,
        vmid: restore.targetVmid,
        archive: restore.archive,
        storage: restore.targetStorage,
        force: restore.force,
        name: restore.targetName,
      });
    const task = await client.pollTask({
      node: restore.targetNode,
      upid: taskId,
      timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : 300000,
    });
    const success = !task.exitstatus || task.exitstatus === 'OK';

    await appendAuditLog({
      action: 'restore',
      connectorId: connector.id,
      node: restore.targetNode,
      vmid: restore.targetVmid,
      sourceNode: node,
      sourceVmid: vmid,
      resourceType: normalizedType,
      status: success ? 'succeeded' : 'failed',
      taskId,
      exitstatus: task.exitstatus || '',
      archive: restore.archive,
      restoreMode: restore.restoreMode,
      targetName: restore.targetName,
      targetStorage: restore.targetStorage,
      force: restore.force,
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        action: 'restore',
        success,
        taskId,
        task,
        resource: { node: restore.targetNode, vmid: restore.targetVmid, name: restore.targetName, type: normalizedType },
        message: success
          ? `Restore completed for ${normalizedType === 'lxc' ? 'container' : 'VM'} ${restore.targetVmid}.`
          : `Restore finished with status ${task.exitstatus}.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'restore',
      node: req.body?.targetNode,
      vmid: req.body?.targetVmid,
      sourceNode: node,
      sourceVmid: vmid,
      resourceType: normalizedType,
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export async function convertVMToTemplate(req, res) {
  const { node, vmid } = req.params;

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before converting a VM to a template.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const vms = await client.listVMs();
    const { vm, confirmation, errors } = validateTemplateRequest({
      payload: req.body,
      source: { node, vmid },
      vms,
    });

    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    await appendAuditLog({
      action: 'template',
      connectorId: connector.id,
      node,
      vmid,
      resourceType: 'qemu',
      status: 'requested',
      vmName: vm.name || '',
      user: req.user?.username || 'unknown',
    });

    const taskId = await client.convertVMToTemplate({ node, vmid });
    const task = typeof taskId === 'string' && taskId.startsWith('UPID:')
      ? await client.pollTask({
        node,
        upid: taskId,
        timeoutMs: req.body?.timeoutMs ? Number(req.body.timeoutMs) : undefined,
      })
      : { status: 'stopped', exitstatus: 'OK' };
    const refreshed = await client.listVMs();
    const templateVm = safeArray(refreshed).find((item) => Number(item.vmid) === Number(vmid) && item.node === node) || null;
    const success = (!task.exitstatus || task.exitstatus === 'OK') && Boolean(templateVm?.template);

    await appendAuditLog({
      action: 'template',
      connectorId: connector.id,
      node,
      vmid,
      resourceType: 'qemu',
      status: success ? 'succeeded' : 'failed',
      vmName: vm.name || '',
      taskId: typeof taskId === 'string' ? taskId : '',
      exitstatus: task.exitstatus || '',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        action: 'template',
        success,
        taskId: typeof taskId === 'string' ? taskId : '',
        task,
        resource: templateVm,
        confirmation,
        message: success
          ? `VM ${vmid} converted to a template.`
          : `Template conversion finished but VM ${vmid} is not marked as a template yet.`,
      },
    });
  } catch (error) {
    await appendAuditLog({
      action: 'template',
      node,
      vmid,
      resourceType: 'qemu',
      status: 'failed',
      message: error.message,
      user: req.user?.username || 'unknown',
    }).catch(() => undefined);

    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export function createNoVncSession(req, res) {
  return withClient(req, res, (client) =>
    client.createNoVncSession({
      node: req.params.node,
      type: req.params.type,
      vmid: req.params.vmid,
    }),
  );
}

export async function createConsoleSession(req, res) {
  const { type, node, vmid } = req.params;
  const normalizedType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';

  try {
    const connector = await connectorFromRequest(req);
    if (connector.status !== 'verified') {
      const error = new Error('Verify the selected connector before opening a console.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    const consoleSession = await client.createConsoleSession({
      node,
      type: normalizedType,
      vmid,
    });
    const record = createConsoleSessionRecord({
      websocketUrl: consoleSession.websocketUrl,
      vncTicket: consoleSession.vncTicket,
      headers: consoleSession.headers,
      rejectUnauthorized: consoleSession.rejectUnauthorized,
      metadata: {
        node,
        vmid,
        type: normalizedType,
        connectorId: connector.id,
      },
    });

    await appendAuditLog({
      action: 'console',
      connectorId: connector.id,
      node,
      vmid,
      resourceType: normalizedType,
      status: 'created',
      user: req.user?.username || 'unknown',
    });

    res.json({
      data: {
        sessionId: record.id,
        websocketPath: `/api/proxmox/console/${record.id}`,
        expiresAt: record.expiresAt,
      },
    });
  } catch (error) {
    const safe = safeError(error);
    res.status(safe.statusCode).json(safe.body);
  }
}

export function pollTask(req, res) {
  return withClient(req, res, (client) =>
    client.pollTask({
      node: req.params.node,
      upid: req.params.upid,
      timeoutMs: req.query.timeoutMs ? Number(req.query.timeoutMs) : undefined,
    }),
  );
}

export {
  buildDashboard,
  isActionAllowed,
  normalizeTask,
  normalizeClusterLogEntry,
  normalizeTaskLogLine,
  normalizeStorageConfigPayload,
  normalizeNetworkConfigPayload,
  validateCreateVmRequest,
  validateCreateContainerRequest,
  validateNetworkConfigRequest,
  validateCloneRequest,
  validateDeleteRequest,
  validateTemplateRequest,
  validateBackupRequest,
  validateRestoreRequest,
};
