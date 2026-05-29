import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../app.js';
import {
  buildDashboard,
  isActionAllowed,
  normalizeClusterLogEntry,
  normalizeNetworkConfigPayload,
  normalizeStorageConfigPayload,
  normalizeTask,
  normalizeTaskLogLine,
  validateCloneRequest,
  validateBackupRequest,
  validateCreateContainerRequest,
  validateCreateVmRequest,
  validateDeleteRequest,
  validateNetworkConfigRequest,
  validateRestoreRequest,
  validateTemplateRequest,
} from './proxmoxApi.controller.js';

let dataDir;

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'secret-password' })
    .expect(200);
  return agent;
}

describe('proxmox api controller', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'pm-proxmox-api-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENCRYPTION_KEY = 'test-encryption-key-that-is-long-enough';
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'secret-password';
    delete process.env.ADMIN_PASSWORD_HASH;
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.COOKIE_SECURE = 'false';
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('requires authentication for Proxmox API routes', async () => {
    const app = createServer();

    await request(app).get('/api/proxmox/nodes').expect(401);
  });

  it('uses the selected connector and never returns raw connector secrets in errors', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    await agent
      .post('/api/connectors')
      .send({
        name: 'Invalid Proxmox',
        host: 'https://example.invalid',
        port: 8006,
        realm: 'pam',
        username: 'root',
        authType: 'apiToken',
        apiTokenId: 'automation',
        apiTokenSecret: 'super-secret-token',
        password: '',
        tlsVerify: true,
        notes: '',
      })
      .expect(201);

    const response = await agent.get('/api/proxmox/nodes').expect(502);
    const raw = JSON.stringify(response.body);

    expect(response.body.type).toBe('network');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('automation=');
  });

  it('requires a verified connector before returning dashboard resources', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    await agent
      .post('/api/connectors')
      .send({
        name: 'Unverified Proxmox',
        host: 'https://example.invalid',
        port: 8006,
        realm: 'pam',
        username: 'root',
        authType: 'apiToken',
        apiTokenId: 'automation',
        apiTokenSecret: 'super-secret-token',
        password: '',
        tlsVerify: true,
        notes: '',
      })
      .expect(201);

    const response = await agent.get('/api/proxmox/dashboard').expect(400);

    expect(response.body.message).toBe('Verify the selected connector before loading resources.');
    expect(JSON.stringify(response.body)).not.toContain('super-secret-token');
  });

  it('rejects operation endpoints for unverified connectors and writes an audit entry', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    await agent
      .post('/api/connectors')
      .send({
        name: 'Unverified Proxmox',
        host: 'https://example.invalid',
        port: 8006,
        realm: 'pam',
        username: 'root',
        authType: 'apiToken',
        apiTokenId: 'automation',
        apiTokenSecret: 'super-secret-token',
        password: '',
        tlsVerify: true,
        notes: '',
      })
      .expect(201);

    await agent.post('/api/proxmox/resources/qemu/pve/100/actions/stop').expect(400);

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'stop',
      node: 'pve',
      vmid: '100',
      resourceType: 'qemu',
      status: 'failed',
      user: 'admin',
    });
    expect(JSON.stringify(audit)).not.toContain('super-secret-token');
  });
});

describe('dashboard aggregation', () => {
  it('builds summary and chart data from partial Proxmox resources', () => {
    const dashboard = buildDashboard({
      nodes: [{ node: 'pve', status: 'online', cpu: 0.5, mem: 50, maxmem: 100 }],
      vms: [
        { type: 'qemu', vmid: 100, name: 'vm1', status: 'running' },
        { type: 'qemu', vmid: 101, name: 'vm2', status: 'stopped' },
        { type: 'qemu', vmid: 9000, name: 'ubuntu-template', status: 'stopped', template: 1 },
      ],
      containers: [{ type: 'lxc', vmid: 200, name: 'ct1', status: 'running' }],
      storage: [{ storage: 'local', disk: 25, maxdisk: 100 }],
    });

    expect(dashboard.summary.clusterHealth).toBe('healthy');
    expect(dashboard.summary.runningVMs).toBe(1);
    expect(dashboard.summary.stoppedVMs).toBe(1);
    expect(dashboard.summary.totalVMs).toBe(2);
    expect(dashboard.summary.totalVMTemplates).toBe(1);
    expect(dashboard.summary.containers).toBe(1);
    expect(dashboard.summary.cpuUsage).toBe(0.5);
    expect(dashboard.summary.memoryUsage).toBe(0.5);
    expect(dashboard.summary.storageUsage).toBe(0.25);
    expect(dashboard.charts.status).toEqual([
      { name: 'Running VMs', value: 1 },
      { name: 'Stopped VMs', value: 1 },
      { name: 'Running CTs', value: 1 },
      { name: 'Stopped CTs', value: 0 },
    ]);
    expect(dashboard.resources.vms.map((item) => item.name)).toEqual(['vm1', 'vm2']);
    expect(dashboard.resources.vmTemplates.map((item) => item.name)).toEqual(['ubuntu-template']);
  });

  it('handles empty datasets for dashboard charts', () => {
    const dashboard = buildDashboard({ nodes: [], vms: [], containers: [], storage: [] });

    expect(dashboard.summary.totalNodes).toBe(0);
    expect(dashboard.summary.cpuUsage).toBe(0);
    expect(dashboard.charts.cpu).toEqual([]);
    expect(dashboard.resources.vmTemplates).toEqual([]);
    expect(dashboard.charts.status).toEqual([
      { name: 'Running VMs', value: 0 },
      { name: 'Stopped VMs', value: 0 },
      { name: 'Running CTs', value: 0 },
      { name: 'Stopped CTs', value: 0 },
    ]);
  });
});

describe('safe operation rules', () => {
  it('allows only valid operations for the current resource status and type', () => {
    expect(isActionAllowed({ action: 'start', type: 'qemu', status: 'stopped' })).toBe(true);
    expect(isActionAllowed({ action: 'start', type: 'qemu', status: 'running' })).toBe(false);
    expect(isActionAllowed({ action: 'shutdown', type: 'qemu', status: 'running' })).toBe(true);
    expect(isActionAllowed({ action: 'stop', type: 'lxc', status: 'running' })).toBe(true);
    expect(isActionAllowed({ action: 'reboot', type: 'lxc', status: 'stopped' })).toBe(false);
    expect(isActionAllowed({ action: 'suspend', type: 'qemu', status: 'running' })).toBe(true);
    expect(isActionAllowed({ action: 'suspend', type: 'lxc', status: 'running' })).toBe(false);
  });
});

describe('storage configuration validation', () => {
  it('normalizes storage payloads for Proxmox without leaking empty fields', () => {
    expect(normalizeStorageConfigPayload({
      storage: ' local-nfs ',
      type: ' nfs ',
      content: ' images,backup ',
      nodes: '',
      server: '192.168.1.20',
      export: '/exports/proxmox',
      shared: true,
      enabled: false,
      password: '',
    })).toEqual({
      storage: 'local-nfs',
      type: 'nfs',
      content: 'images,backup',
      server: '192.168.1.20',
      export: '/exports/proxmox',
      shared: 1,
      disable: 1,
    });
  });

  it('maps plugin-specific storage fields to Proxmox parameter names', () => {
    expect(normalizeStorageConfigPayload({
      storage: 'pbs-backup',
      type: 'pbs',
      content: 'backup',
      server: 'pbs.local',
      datastore: 'datastore-1',
      namespace: 'tenant-a',
      fingerprint: 'AA:BB:CC',
    })).toMatchObject({
      type: 'pbs',
      datastore: 'datastore-1',
      namespace: 'tenant-a',
      fingerprint: 'AA:BB:CC',
    });

    expect(normalizeStorageConfigPayload({
      storage: 'windows-share',
      type: 'cifs',
      content: 'backup',
      server: 'files.local',
      export: 'vm-backups',
      domain: 'WORKGROUP',
      smbversion: '3.0',
    })).toMatchObject({
      type: 'cifs',
      share: 'vm-backups',
      domain: 'WORKGROUP',
      smbversion: '3.0',
    });
  });

  it('rejects storage delete when the confirmation does not match', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    await agent
      .post('/api/connectors')
      .send({
        name: 'Unverified Proxmox',
        host: 'https://example.invalid',
        port: 8006,
        realm: 'pam',
        username: 'root',
        authType: 'apiToken',
        apiTokenId: 'automation',
        apiTokenSecret: 'super-secret-token',
        password: '',
        tlsVerify: true,
        notes: '',
      })
      .expect(201);

    const response = await agent
      .delete('/api/proxmox/storage/config/local')
      .send({ confirmation: 'wrong' })
      .expect(400);

    expect(response.body.message).toBe('Type the storage ID to confirm deletion.');
    expect(JSON.stringify(response.body)).not.toContain('super-secret-token');
  });
});

describe('network configuration validation', () => {
  const interfaces = [
    { iface: 'lo', type: 'loopback' },
    { iface: 'eno1', type: 'eth' },
    { iface: 'vmbr0', type: 'bridge' },
  ];

  it('normalizes bridge payloads for Proxmox', () => {
    expect(normalizeNetworkConfigPayload({
      iface: ' vmbr1 ',
      method: 'manual',
      bridgePorts: ' eno1 ',
      vlanAware: true,
      autostart: true,
      comments: ' tenant bridge ',
    })).toEqual({
      iface: 'vmbr1',
      type: 'bridge',
      autostart: 1,
      bridge_ports: 'eno1',
      bridge_vlan_aware: 1,
      comments: 'tenant bridge',
    });
  });

  it('accepts a valid static bridge request', () => {
    const result = validateNetworkConfigRequest({
      interfaces,
      payload: {
        iface: 'vmbr1',
        method: 'static',
        address: '192.168.1.20',
        netmask: '255.255.255.0',
        gateway: '192.168.1.1',
        bridgePorts: 'eno1',
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.network).not.toHaveProperty('method');
    expect(result.network).not.toHaveProperty('address');
    expect(result.network).not.toHaveProperty('netmask');
    expect(result.network).toMatchObject({
      iface: 'vmbr1',
      type: 'bridge',
      cidr: '192.168.1.20/24',
      gateway: '192.168.1.1',
      bridge_ports: 'eno1',
    });
  });

  it('omits bridge_ports for isolated bridges', () => {
    const result = validateNetworkConfigRequest({
      interfaces,
      payload: {
        iface: 'vmbr2',
        method: 'manual',
        bridgePorts: 'none',
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.network).not.toHaveProperty('method');
    expect(result.network).not.toHaveProperty('bridge_ports');
    expect(result.network).toMatchObject({
      iface: 'vmbr2',
    });
  });

  it('normalizes Linux bond, VLAN, and OVS network payloads', () => {
    expect(normalizeNetworkConfigPayload({
      iface: 'bond0',
      type: 'bond',
      slaves: ' eno1,eno2 ',
      bondMode: '802.3ad',
    })).toMatchObject({
      iface: 'bond0',
      type: 'bond',
      slaves: 'eno1 eno2',
      bond_mode: '802.3ad',
    });

    expect(normalizeNetworkConfigPayload({
      iface: 'vlan100',
      type: 'vlan',
      vlanId: '100',
      vlanRawDevice: 'bond0',
    })).toMatchObject({
      iface: 'vlan100',
      type: 'vlan',
      'vlan-id': '100',
      'vlan-raw-device': 'bond0',
    });

    expect(normalizeNetworkConfigPayload({
      iface: 'bond1',
      type: 'OVSBond',
      ovsBridge: 'vmbr1',
      ovsBonds: ' eno1 eno2 ',
      ovsOptions: 'bond_mode=balance-tcp',
      ovsTag: '20',
    })).toMatchObject({
      iface: 'bond1',
      type: 'OVSBond',
      ovs_bridge: 'vmbr1',
      ovs_bonds: 'eno1 eno2',
      ovs_options: 'bond_mode=balance-tcp',
      ovs_tag: '20',
    });
  });

  it('rejects duplicate, non-bridge, and incomplete static requests', () => {
    expect(validateNetworkConfigRequest({
      interfaces,
      payload: {
        iface: 'vmbr0',
        method: 'manual',
      },
    }).errors).toEqual(['Interface vmbr0 already exists.']);

    expect(validateNetworkConfigRequest({
      interfaces,
      payload: {
        iface: 'br-public',
        method: 'static',
      },
    }).errors).toEqual([
      'Linux bridge name must look like vmbr1, vmbr2, or another vmbr number.',
      'Static network configuration requires address and netmask.',
    ]);

    expect(validateNetworkConfigRequest({
      interfaces,
      payload: {
        iface: 'bond0',
        type: 'bond',
        slaves: '',
      },
    }).errors).toEqual(['Linux bond requires at least one slave port.']);

    expect(validateNetworkConfigRequest({
      interfaces,
      payload: {
        iface: 'vlan0',
        type: 'vlan',
        vlanId: '5000',
      },
    }).errors).toEqual([
      'Linux VLAN requires a VLAN ID from 1 to 4094.',
      'Linux VLAN requires a raw device.',
    ]);
  });
});

describe('clone validation', () => {
  const inventory = {
    nodes: [{ node: 'pve', status: 'online' }],
    vms: [{ type: 'qemu', vmid: 100, name: 'app-server', node: 'pve', status: 'stopped' }],
    containers: [{ type: 'lxc', vmid: 200, name: 'nginx', node: 'pve', status: 'running' }],
    storage: [{ storage: 'local-lvm', node: 'pve', status: 'available' }],
    source: { node: 'pve', vmid: 100 },
  };

  it('accepts a valid clone request', () => {
    const result = validateCloneRequest({
      ...inventory,
      payload: {
        newid: 120,
        name: 'app-server-clone',
        target: 'pve',
        storage: 'local-lvm',
        full: true,
        description: 'test clone',
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.clone).toMatchObject({
      newid: 120,
      name: 'app-server-clone',
      target: 'pve',
      storage: 'local-lvm',
      full: true,
      description: 'test clone',
    });
  });

  it('rejects duplicate VM IDs, missing names, and invalid storage', () => {
    const result = validateCloneRequest({
      ...inventory,
      payload: {
        newid: 200,
        name: '',
        target: 'pve',
        storage: 'missing-storage',
        full: false,
      },
    });

    expect(result.errors).toEqual([
      'VM ID 200 is already in use.',
      'New VM name is required.',
      'Selected storage is not valid for the target node.',
    ]);
  });
});

describe('create VM validation', () => {
  const inventory = {
    nodes: [{ node: 'pve', status: 'online' }],
    vms: [{ type: 'qemu', vmid: 100, name: 'app-server', node: 'pve', status: 'stopped' }],
    containers: [{ type: 'lxc', vmid: 200, name: 'nginx', node: 'pve', status: 'running' }],
    storage: [{ storage: 'local-lvm', node: 'pve', status: 'available' }],
  };

  it('accepts a valid create VM request and builds Proxmox payload', () => {
    const result = validateCreateVmRequest({
      ...inventory,
      payload: {
        node: 'pve',
        vmid: 130,
        name: 'new-vm',
        storage: 'local-lvm',
        diskSizeGb: 32,
        cores: 2,
        sockets: 1,
        memoryMb: 4096,
        bridge: 'vmbr0',
        iso: 'local:iso/debian.iso',
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.createPayload).toMatchObject({
      vmid: 130,
      name: 'new-vm',
      memory: 4096,
      cores: 2,
      scsi0: 'local-lvm:32',
      ide2: 'local:iso/debian.iso,media=cdrom',
      net0: 'virtio,bridge=vmbr0',
    });
  });

  it('rejects duplicate IDs and invalid target storage', () => {
    const result = validateCreateVmRequest({
      ...inventory,
      payload: {
        node: 'pve',
        vmid: 200,
        name: '',
        storage: 'missing',
        diskSizeGb: 0,
        cores: 0,
        memoryMb: 64,
        bridge: '',
      },
    });

    expect(result.errors).toEqual([
      'VM ID 200 is already in use.',
      'VM name is required.',
      'Selected storage is not valid for the target node.',
      'Disk size must be positive.',
      'CPU cores must be a positive whole number.',
      'Memory must be at least 128 MB.',
      'Network bridge is required.',
    ]);
  });
});

describe('create container validation', () => {
  const inventory = {
    nodes: [{ node: 'pve', status: 'online' }],
    vms: [{ type: 'qemu', vmid: 100, name: 'app-server', node: 'pve', status: 'stopped' }],
    containers: [{ type: 'lxc', vmid: 200, name: 'nginx', node: 'pve', status: 'running' }],
    storage: [{ storage: 'local-lvm', node: 'pve', status: 'available' }],
  };

  it('accepts a valid create container request and builds Proxmox payload', () => {
    const result = validateCreateContainerRequest({
      ...inventory,
      payload: {
        node: 'pve',
        vmid: 131,
        hostname: 'web-ct',
        storage: 'local-lvm',
        template: 'local:vztmpl/debian-12-standard.tar.zst',
        diskSizeGb: 8,
        cores: 1,
        memoryMb: 1024,
        swapMb: 512,
        bridge: 'vmbr0',
        unprivileged: true,
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.createPayload).toMatchObject({
      vmid: 131,
      hostname: 'web-ct',
      ostemplate: 'local:vztmpl/debian-12-standard.tar.zst',
      rootfs: 'local-lvm:8',
      cores: 1,
      memory: 1024,
      swap: 512,
      net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
      unprivileged: 1,
    });
  });

  it('rejects duplicate IDs, missing templates, and invalid storage', () => {
    const result = validateCreateContainerRequest({
      ...inventory,
      payload: {
        node: 'pve',
        vmid: 200,
        hostname: '',
        storage: 'missing',
        template: '',
        diskSizeGb: 0,
        cores: 0,
        memoryMb: 64,
        swapMb: -1,
        bridge: '',
      },
    });

    expect(result.errors).toEqual([
      'VM/CT ID 200 is already in use.',
      'Hostname is required.',
      'Selected storage is not valid for the target node.',
      'Template is required.',
      'Disk size must be positive.',
      'CPU cores must be a positive whole number.',
      'Memory must be at least 128 MB.',
      'Swap cannot be negative.',
      'Network bridge is required.',
    ]);
  });
});

describe('Proxmox log normalization', () => {
  it('normalizes task rows for live task display', () => {
    expect(normalizeTask({
      upid: 'UPID:pve:1',
      node: 'pve',
      user: 'root@pam',
      type: 'clone',
      id: '205',
      starttime: 1778834986,
    })).toMatchObject({
      upid: 'UPID:pve:1',
      node: 'pve',
      user: 'root@pam',
      type: 'clone',
      id: '205',
      status: 'running',
      description: 'VM/CT 205 - Clone',
      startedAt: '2026-05-15T08:49:46.000Z',
      endedAt: null,
    });
  });

  it('normalizes cluster log rows', () => {
    expect(normalizeClusterLogEntry({
      time: 1778834986,
      node: 'pve',
      user: 'root@pam',
      priority: 'info',
      msg: 'task started',
    })).toMatchObject({
      time: '2026-05-15T08:49:46.000Z',
      node: 'pve',
      user: 'root@pam',
      priority: 'info',
      message: 'task started',
    });
  });

  it('normalizes task viewer output lines', () => {
    expect(normalizeTaskLogLine({ n: 2, t: 'TASK OK' })).toEqual({
      line: 2,
      text: 'TASK OK',
    });
  });
});

describe('delete validation', () => {
  const inventory = {
    vms: [
      { type: 'qemu', vmid: 100, name: 'app-server', node: 'pve', status: 'stopped' },
      { type: 'qemu', vmid: 9000, name: 'template', node: 'pve', status: 'stopped', template: 1 },
    ],
    source: { node: 'pve', vmid: 100 },
  };

  it('accepts VM name or VM ID as delete confirmation', () => {
    expect(validateDeleteRequest({
      ...inventory,
      payload: { confirmation: 'app-server', force: true },
    })).toMatchObject({
      errors: [],
      force: true,
      vm: { vmid: 100, name: 'app-server' },
    });

    expect(validateDeleteRequest({
      ...inventory,
      payload: { confirmation: '100' },
    }).errors).toEqual([]);
  });

  it('rejects missing VMs, templates, and wrong confirmation phrases', () => {
    expect(validateDeleteRequest({
      ...inventory,
      payload: { confirmation: 'wrong' },
    }).errors).toEqual(['Type the VM name or VM ID to confirm deletion.']);

    expect(validateDeleteRequest({
      ...inventory,
      source: { node: 'pve', vmid: 9000 },
      payload: { confirmation: '9000' },
    }).errors).toEqual(['Source VM was not found in the selected connector inventory.']);
  });
});

describe('template conversion validation', () => {
  const inventory = {
    vms: [
      { type: 'qemu', vmid: 100, name: 'app-server', node: 'pve', status: 'stopped' },
      { type: 'qemu', vmid: 101, name: 'running-vm', node: 'pve', status: 'running' },
      { type: 'qemu', vmid: 9000, name: 'template', node: 'pve', status: 'stopped', template: 1 },
    ],
  };

  it('accepts stopped VM name or ID as template confirmation', () => {
    expect(validateTemplateRequest({
      ...inventory,
      source: { node: 'pve', vmid: 100 },
      payload: { confirmation: 'app-server' },
    })).toMatchObject({
      errors: [],
      vm: { vmid: 100, name: 'app-server' },
    });

    expect(validateTemplateRequest({
      ...inventory,
      source: { node: 'pve', vmid: 100 },
      payload: { confirmation: '100' },
    }).errors).toEqual([]);
  });

  it('rejects running VMs, templates, and wrong confirmation phrases', () => {
    expect(validateTemplateRequest({
      ...inventory,
      source: { node: 'pve', vmid: 101 },
      payload: { confirmation: 'running-vm' },
    }).errors).toEqual(['Stop the VM before converting it to a template.']);

    expect(validateTemplateRequest({
      ...inventory,
      source: { node: 'pve', vmid: 9000 },
      payload: { confirmation: 'template' },
    }).errors).toEqual(['Source VM is already a template.']);

    expect(validateTemplateRequest({
      ...inventory,
      source: { node: 'pve', vmid: 100 },
      payload: { confirmation: 'wrong' },
    }).errors).toEqual(['Type the VM name or VM ID to confirm template conversion.']);
  });
});

describe('backup validation', () => {
  const inventory = {
    vms: [
      { type: 'qemu', vmid: 100, name: 'app-server', node: 'pve', status: 'running' },
      { type: 'qemu', vmid: 9000, name: 'template', node: 'pve', status: 'stopped', template: 1 },
    ],
    containers: [
      { type: 'lxc', vmid: 200, name: 'web-ct', node: 'pve', status: 'running' },
    ],
    storage: [
      { storage: 'pbs-backup', node: 'pve', status: 'available', content: 'backup' },
      { storage: 'pbs-unknown', node: 'pve', status: 'unknown' },
      { storage: 'local-lvm', node: 'pve', status: 'available', content: 'images' },
      { storage: 'local', node: 'pve', status: 'available' },
    ],
    storageConfig: [
      { storage: 'pbs-unknown', content: 'backup' },
      { storage: 'config-only-pbs', nodes: 'pve', content: 'backup' },
      { storage: 'local', content: 'images,iso,vztmpl' },
    ],
  };

  it('accepts VM and container backups on backup-capable storage', () => {
    expect(validateBackupRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: { storage: 'pbs-backup', mode: 'snapshot', compress: 'zstd' },
    })).toMatchObject({
      errors: [],
      resourceType: 'qemu',
      backup: { storage: 'pbs-backup', mode: 'snapshot', compress: 'zstd' },
    });

    expect(validateBackupRequest({
      ...inventory,
      source: { type: 'lxc', node: 'pve', vmid: 200 },
      payload: { storage: 'pbs-backup' },
    })).toMatchObject({
      errors: [],
      resourceType: 'lxc',
    });

    expect(validateBackupRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: { storage: 'pbs-unknown' },
    }).errors).toEqual([]);

    expect(validateBackupRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: { storage: 'config-only-pbs' },
    }).errors).toEqual([]);
  });

  it('rejects missing resources, templates, and non-backup storage', () => {
    expect(validateBackupRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 9000 },
      payload: { storage: 'pbs-backup' },
    }).errors).toEqual(['Source VM was not found in the selected connector inventory.']);

    expect(validateBackupRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: { storage: 'local-lvm' },
    }).errors).toEqual(['Selected storage is not valid for backups on this node.']);

    expect(validateBackupRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: { storage: 'local' },
    }).errors).toEqual(['Selected storage is not valid for backups on this node.']);
  });
});

describe('restore validation', () => {
  const inventory = {
    vms: [
      { type: 'qemu', vmid: 100, name: 'app-server', node: 'pve', status: 'running' },
      { type: 'qemu', vmid: 101, name: 'db-server', node: 'pve', status: 'stopped' },
    ],
    containers: [
      { type: 'lxc', vmid: 200, name: 'web-ct', node: 'pve', status: 'running' },
    ],
    backups: [
      { volid: 'pbs:backup/vzdump-qemu-100.vma.zst', storage: 'pbs' },
    ],
  };

  it('accepts same-ID overwrite and new-ID restore with confirmation', () => {
    expect(validateRestoreRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: {
        archive: 'pbs:backup/vzdump-qemu-100.vma.zst',
        restoreMode: 'same',
        targetNode: 'pve',
        targetVmid: 100,
        targetStorage: 'local-lvm',
        force: true,
        confirmation: '100',
      },
    })).toMatchObject({
      errors: [],
      restore: { restoreMode: 'same', targetVmid: 100, force: true },
    });

    expect(validateRestoreRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: {
        archive: 'pbs:backup/vzdump-qemu-100.vma.zst',
        restoreMode: 'new',
        targetNode: 'pve',
        targetVmid: 120,
        targetName: 'app-server-restore',
        confirmation: '120',
      },
    }).errors).toEqual([]);
  });

  it('rejects missing confirmation and unsafe target IDs', () => {
    expect(validateRestoreRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: {
        archive: 'pbs:backup/vzdump-qemu-100.vma.zst',
        restoreMode: 'same',
        targetNode: 'pve',
        targetVmid: 100,
        force: true,
        confirmation: 'wrong',
      },
    }).errors).toEqual(['Type the target VM/CT ID to confirm restore.']);

    expect(validateRestoreRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: {
        archive: 'pbs:backup/vzdump-qemu-100.vma.zst',
        restoreMode: 'new',
        targetNode: 'pve',
        targetVmid: 100,
        targetName: 'app-server-restore',
        confirmation: '100',
      },
    }).errors).toEqual([
      'Choose a different VM/CT ID for a new-ID restore.',
      'VM/CT ID 100 already exists. Enable force restore only when you intend to overwrite it.',
    ]);

    expect(validateRestoreRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: {
        archive: 'pbs:backup/vzdump-qemu-100.vma.zst',
        restoreMode: 'new',
        targetNode: 'pve',
        targetVmid: 101,
        targetName: 'db-restore',
        confirmation: '101',
      },
    }).errors).toEqual(['VM/CT ID 101 already exists. Enable force restore only when you intend to overwrite it.']);

    expect(validateRestoreRequest({
      ...inventory,
      source: { type: 'qemu', node: 'pve', vmid: 100 },
      payload: {
        archive: 'pbs:backup/vzdump-qemu-100.vma.zst',
        restoreMode: 'new',
        targetNode: 'pve',
        targetVmid: 120,
        confirmation: '120',
      },
    }).errors).toEqual(['Target VM/CT name is required for a new-ID restore.']);
  });
});
