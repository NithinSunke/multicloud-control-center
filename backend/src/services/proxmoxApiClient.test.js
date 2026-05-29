import { describe, expect, it, vi } from 'vitest';
import { createProxmoxApiClient, normalizeProxmoxFailure, ProxmoxApiError } from './proxmoxApiClient.js';

function tokenConnector(overrides = {}) {
  return {
    host: 'https://pve.example.local',
    port: 8006,
    realm: 'pam',
    username: 'root',
    authType: 'apiToken',
    apiTokenId: 'automation',
    apiTokenSecret: 'secret-token',
    tlsVerify: true,
    ...overrides,
  };
}

function passwordConnector(overrides = {}) {
  return {
    ...tokenConnector(),
    authType: 'password',
    password: 'secret-password',
    apiTokenId: '',
    apiTokenSecret: '',
    ...overrides,
  };
}

describe('proxmox api client', () => {
  it('lists nodes with API token authorization', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: [{ node: 'pve', status: 'online' }] },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    const nodes = await client.listNodes();

    expect(nodes).toEqual([{ node: 'pve', status: 'online' }]);
    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes');
    expect(transport.mock.calls[0][1].headers.Authorization).toContain('PVEAPIToken=');
  });

  it('lists node network interfaces', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: [{ iface: 'vmbr0', type: 'bridge' }] },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.listNodeNetwork({ node: 'pve' })).resolves.toEqual([{ iface: 'vmbr0', type: 'bridge' }]);
    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/network');
  });

  it('creates node network bridge configuration', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: null },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.createNodeNetwork({
      node: 'pve',
      payload: {
        iface: 'vmbr1',
        type: 'bridge',
        autostart: 1,
        method: 'manual',
        bridge_ports: 'eno1',
        bridge_vlan_aware: 1,
        comments: 'tenant bridge',
      },
    });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/network');
    expect(transport.mock.calls[0][1].method).toBe('POST');
    expect(transport.mock.calls[0][2]).toContain('iface=vmbr1');
    expect(transport.mock.calls[0][2]).toContain('type=bridge');
    expect(transport.mock.calls[0][2]).toContain('bridge_ports=eno1');
    expect(transport.mock.calls[0][2]).toContain('bridge_vlan_aware=1');
  });

  it('edits, removes, and applies node network configuration', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: null },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.updateNodeNetwork({ node: 'pve', iface: 'vmbr1', payload: { autostart: 1, comments: 'updated' } });
    await client.deleteNodeNetwork({ node: 'pve', iface: 'vmbr1' });
    await client.applyNodeNetwork({ node: 'pve' });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/network/vmbr1');
    expect(transport.mock.calls[0][1].method).toBe('PUT');
    expect(transport.mock.calls[0][2]).toContain('comments=updated');
    expect(transport.mock.calls[1][0].pathname).toBe('/api2/json/nodes/pve/network/vmbr1');
    expect(transport.mock.calls[1][1].method).toBe('DELETE');
    expect(transport.mock.calls[2][0].pathname).toBe('/api2/json/nodes/pve/network');
    expect(transport.mock.calls[2][1].method).toBe('PUT');
  });

  it('manages SDN zones, VNets, IPAMs, and apply requests', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ zone: 'zone1' }] } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ vnet: 'vnet1', zone: 'zone1' }] } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ ipam: 'pve', type: 'pve' }] } })
      .mockResolvedValue({ statusCode: 200, payload: { data: null } });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.listSdnZones()).resolves.toEqual([{ zone: 'zone1' }]);
    await expect(client.listSdnVnets()).resolves.toEqual([{ vnet: 'vnet1', zone: 'zone1' }]);
    await expect(client.listSdnIpams()).resolves.toEqual([{ ipam: 'pve', type: 'pve' }]);
    await client.createSdnZone({ zone: 'zone2', type: 'simple' });
    await client.createSdnVnet({ vnet: 'vnet2', zone: 'zone2' });
    await client.createSdnIpam({ ipam: 'pve2', type: 'pve' });
    await client.applySdn();

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/cluster/sdn/zones');
    expect(transport.mock.calls[1][0].pathname).toBe('/api2/json/cluster/sdn/vnets');
    expect(transport.mock.calls[2][0].pathname).toBe('/api2/json/cluster/sdn/ipams');
    expect(transport.mock.calls[3][0].pathname).toBe('/api2/json/cluster/sdn/zones');
    expect(transport.mock.calls[3][1].method).toBe('POST');
    expect(transport.mock.calls[4][0].pathname).toBe('/api2/json/cluster/sdn/vnets');
    expect(transport.mock.calls[5][0].pathname).toBe('/api2/json/cluster/sdn/ipams');
    expect(transport.mock.calls[6][0].pathname).toBe('/api2/json/cluster/sdn');
    expect(transport.mock.calls[6][1].method).toBe('PUT');
  });

  it('filters VMs and containers from cluster resources', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: {
        data: [
          { type: 'qemu', vmid: 100 },
          { type: 'lxc', vmid: 200 },
          { type: 'node', node: 'pve' },
        ],
      },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.listVMs()).resolves.toEqual([{ type: 'qemu', vmid: 100 }]);
    await expect(client.listContainers()).resolves.toEqual([{ type: 'lxc', vmid: 200 }]);
  });

  it('authenticates password connectors in memory and uses ticket headers', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        payload: {
          data: {
            ticket: 'PVE:user-ticket',
            CSRFPreventionToken: 'csrf-token',
          },
        },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        payload: { data: 'UPID:pve:123' },
      });
    const client = createProxmoxApiClient(passwordConnector(), { transport });

    const task = await client.startVM({ node: 'pve', type: 'qemu', vmid: 100 });

    expect(task).toBe('UPID:pve:123');
    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/access/ticket');
    expect(transport.mock.calls[0][2]).toContain('password=secret-password');
    expect(transport.mock.calls[1][1].headers.Cookie).toBe('PVEAuthCookie=PVE:user-ticket');
    expect(transport.mock.calls[1][1].headers.CSRFPreventionToken).toBe('csrf-token');
  });

  it('polls tasks until stopped', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: { status: 'running' } } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: { status: 'stopped', exitstatus: 'OK' } } });
    const client = createProxmoxApiClient(tokenConnector(), {
      transport,
      pollIntervalMs: 1,
      wait: vi.fn().mockResolvedValue(undefined),
    });

    await expect(client.pollTask({ node: 'pve', upid: 'UPID:pve:1' })).resolves.toEqual({
      status: 'stopped',
      exitstatus: 'OK',
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('sends safe resource operations to the expected Proxmox status endpoints', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:action' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.shutdownVM({ node: 'pve', type: 'qemu', vmid: 100 });
    await client.rebootVM({ node: 'pve', type: 'lxc', vmid: 200 });
    await client.suspendVM({ node: 'pve', type: 'qemu', vmid: 100 });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/qemu/100/status/shutdown');
    expect(transport.mock.calls[1][0].pathname).toBe('/api2/json/nodes/pve/lxc/200/status/reboot');
    expect(transport.mock.calls[2][0].pathname).toBe('/api2/json/nodes/pve/qemu/100/status/suspend');
  });

  it('submits clone requests with target, storage, clone type, and description', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:clone' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.cloneVM({
      node: 'pve',
      vmid: 100,
      newid: 120,
      name: 'app-server-clone',
      target: 'pve',
      storage: 'local-lvm',
      full: false,
      description: 'test clone',
    });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/qemu/100/clone');
    expect(transport.mock.calls[0][2]).toContain('newid=120');
    expect(transport.mock.calls[0][2]).toContain('name=app-server-clone');
    expect(transport.mock.calls[0][2]).toContain('target=pve');
    expect(transport.mock.calls[0][2]).toContain('storage=local-lvm');
    expect(transport.mock.calls[0][2]).toContain('full=0');
    expect(transport.mock.calls[0][2]).toContain('description=test+clone');
  });

  it('submits create VM requests to the node QEMU endpoint', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:create' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.createVM({
      node: 'pve',
      payload: {
        vmid: 130,
        name: 'new-vm',
        memory: 2048,
        cores: 2,
        scsi0: 'local-lvm:32',
        net0: 'virtio,bridge=vmbr0',
      },
    });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/qemu');
    expect(transport.mock.calls[0][1].method).toBe('POST');
    expect(transport.mock.calls[0][2]).toContain('vmid=130');
    expect(transport.mock.calls[0][2]).toContain('name=new-vm');
    expect(transport.mock.calls[0][2]).toContain('scsi0=local-lvm%3A32');
  });

  it('submits create container requests to the node LXC endpoint', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:create-container' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.createContainer({
      node: 'pve',
      payload: {
        vmid: 131,
        hostname: 'web-ct',
        ostemplate: 'local:vztmpl/debian-12-standard.tar.zst',
        rootfs: 'local-lvm:8',
        cores: 1,
        memory: 1024,
        swap: 512,
        net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
        unprivileged: 1,
      },
    });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/lxc');
    expect(transport.mock.calls[0][1].method).toBe('POST');
    expect(transport.mock.calls[0][2]).toContain('vmid=131');
    expect(transport.mock.calls[0][2]).toContain('hostname=web-ct');
    expect(transport.mock.calls[0][2]).toContain('ostemplate=local%3Avztmpl%2Fdebian-12-standard.tar.zst');
    expect(transport.mock.calls[0][2]).toContain('rootfs=local-lvm%3A8');
  });

  it('loads Proxmox task and cluster log lists', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ upid: 'UPID:pve:1', type: 'clone' }] } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ time: 1778832000, msg: 'cluster ready' }] } });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.listNodeTasks({ node: 'pve', limit: 50 })).resolves.toEqual([{ upid: 'UPID:pve:1', type: 'clone' }]);
    await expect(client.listClusterLog({ max: 25 })).resolves.toEqual([{ time: 1778832000, msg: 'cluster ready' }]);

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/tasks');
    expect(transport.mock.calls[0][0].searchParams.get('limit')).toBe('50');
    expect(transport.mock.calls[1][0].pathname).toBe('/api2/json/cluster/log');
    expect(transport.mock.calls[1][0].searchParams.get('max')).toBe('25');
  });

  it('loads task status/output and can request task stop', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: { status: 'running' } } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ n: 1, t: 'TASK OK' }] } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: null } });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.getTaskStatus({ node: 'pve', upid: 'UPID:pve:1' })).resolves.toEqual({ status: 'running' });
    await expect(client.getTaskLog({ node: 'pve', upid: 'UPID:pve:1', limit: 25 })).resolves.toEqual([{ n: 1, t: 'TASK OK' }]);
    await expect(client.stopTask({ node: 'pve', upid: 'UPID:pve:1' })).resolves.toEqual({ data: null });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/tasks/UPID%3Apve%3A1/status');
    expect(transport.mock.calls[1][0].pathname).toBe('/api2/json/nodes/pve/tasks/UPID%3Apve%3A1/log');
    expect(transport.mock.calls[1][0].searchParams.get('limit')).toBe('25');
    expect(transport.mock.calls[2][0].pathname).toBe('/api2/json/nodes/pve/tasks/UPID%3Apve%3A1');
    expect(transport.mock.calls[2][1].method).toBe('DELETE');
  });

  it('submits VM delete requests with optional force query', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:delete' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.deleteVM({ node: 'pve', type: 'qemu', vmid: 100, force: true });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/qemu/100');
    expect(transport.mock.calls[0][0].searchParams.get('force')).toBe('1');
    expect(transport.mock.calls[0][1].method).toBe('DELETE');
  });

  it('submits VM template conversion requests', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:template' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.convertVMToTemplate({ node: 'pve', vmid: 100 })).resolves.toBe('UPID:pve:template');

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/qemu/100/template');
    expect(transport.mock.calls[0][1].method).toBe('POST');
  });

  it('submits VM and container backup requests to vzdump', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:backup' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.backupResource({
      node: 'pve',
      vmid: 100,
      storage: 'pbs-backup',
      mode: 'snapshot',
      compress: 'zstd',
      notes: 'nightly backup',
    })).resolves.toBe('UPID:pve:backup');

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/vzdump');
    expect(transport.mock.calls[0][1].method).toBe('POST');
    expect(transport.mock.calls[0][2]).toContain('vmid=100');
    expect(transport.mock.calls[0][2]).toContain('storage=pbs-backup');
    expect(transport.mock.calls[0][2]).toContain('mode=snapshot');
    expect(transport.mock.calls[0][2]).toContain('compress=zstd');
    expect(transport.mock.calls[0][2]).not.toContain('notes=');
  });

  it('submits restore requests and storage backup deletion requests', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { data: 'UPID:pve:restore' },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await client.restoreVM({
      node: 'pve',
      vmid: 150,
      archive: 'pbs:backup/vzdump-qemu-100.vma.zst',
      storage: 'local-lvm',
      force: true,
      name: 'restored-vm',
    });
    await client.restoreContainer({
      node: 'pve',
      vmid: 250,
      archive: 'pbs:backup/vzdump-lxc-200.tar.zst',
      storage: 'local-lvm',
      hostname: 'restored-ct',
    });
    await client.deleteStorageContent({
      node: 'pve',
      storage: 'pbs',
      volume: 'pbs:backup/vzdump-qemu-100.vma.zst',
    });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/nodes/pve/qemu');
    expect(transport.mock.calls[0][2]).toContain('archive=pbs%3Abackup%2Fvzdump-qemu-100.vma.zst');
    expect(transport.mock.calls[0][2]).toContain('vmid=150');
    expect(transport.mock.calls[0][2]).toContain('force=1');
    expect(transport.mock.calls[0][2]).toContain('name=restored-vm');
    expect(transport.mock.calls[1][0].pathname).toBe('/api2/json/nodes/pve/lxc');
    expect(transport.mock.calls[1][2]).toContain('ostemplate=pbs%3Abackup%2Fvzdump-lxc-200.tar.zst');
    expect(transport.mock.calls[1][2]).toContain('hostname=restored-ct');
    expect(transport.mock.calls[1][2]).toContain('restore=1');
    expect(transport.mock.calls[2][0].pathname).toBe('/api2/json/nodes/pve/storage/pbs/content/pbs%3Abackup%2Fvzdump-qemu-100.vma.zst');
    expect(transport.mock.calls[2][1].method).toBe('DELETE');
  });

  it('manages storage configuration and lists storage content', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ storage: 'local', type: 'dir' }] } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: null } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: null } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: [{ volid: 'local:iso/debian.iso' }] } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { data: null } });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    await expect(client.listStorageConfig()).resolves.toEqual([{ storage: 'local', type: 'dir' }]);
    await client.createStorageConfig({ storage: 'nfs-backup', type: 'nfs', content: 'backup' });
    await client.updateStorageConfig({ storage: 'nfs-backup', payload: { content: 'backup,iso' } });
    await expect(client.listStorageContent({ node: 'pve', storage: 'local', content: 'iso' })).resolves.toEqual([
      { volid: 'local:iso/debian.iso' },
    ]);
    await client.deleteStorageConfig({ storage: 'nfs-backup' });

    expect(transport.mock.calls[0][0].pathname).toBe('/api2/json/storage');
    expect(transport.mock.calls[1][0].pathname).toBe('/api2/json/storage');
    expect(transport.mock.calls[1][1].method).toBe('POST');
    expect(transport.mock.calls[1][2]).toContain('storage=nfs-backup');
    expect(transport.mock.calls[2][0].pathname).toBe('/api2/json/storage/nfs-backup');
    expect(transport.mock.calls[2][1].method).toBe('PUT');
    expect(transport.mock.calls[3][0].pathname).toBe('/api2/json/nodes/pve/storage/local/content');
    expect(transport.mock.calls[3][0].searchParams.get('content')).toBe('iso');
    expect(transport.mock.calls[4][0].pathname).toBe('/api2/json/storage/nfs-backup');
    expect(transport.mock.calls[4][1].method).toBe('DELETE');
  });

  it('creates noVNC console session metadata without exposing connector secrets', async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: {
        data: {
          port: 5901,
          ticket: 'PVEVNC:ticket-value',
          cert: 'cert-data',
        },
      },
    });
    const client = createProxmoxApiClient(tokenConnector(), { transport });

    const session = await client.createConsoleSession({ node: 'pve', type: 'qemu', vmid: 100 });

    expect(session.session.port).toBe(5901);
    expect(session.websocketUrl).toContain('/api2/json/nodes/pve/qemu/100/vncwebsocket');
    expect(session.websocketUrl).toContain('port=5901');
    expect(session.websocketUrl).toContain('vncticket=');
    expect(session.headers.Authorization).toContain('PVEAPIToken=');
  });

  it('normalizes auth, TLS, network, and Proxmox API errors', () => {
    expect(normalizeProxmoxFailure({ statusCode: 401 }).type).toBe('auth');
    expect(normalizeProxmoxFailure(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).type).toBe('tls');
    expect(normalizeProxmoxFailure(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })).type).toBe('network');
    expect(normalizeProxmoxFailure({ statusCode: 500, message: 'boom' }).type).toBe('proxmox');
    expect(normalizeProxmoxFailure({
      statusCode: 400,
      message: 'Proxmox API request failed.',
      payload: { errors: { bridge_ports: 'invalid bridge port' } },
    }).message).toContain('bridge_ports: invalid bridge port');
  });

  it('throws a timeout error while polling long-running tasks', async () => {
    const transport = vi.fn().mockResolvedValue({ statusCode: 200, payload: { data: { status: 'running' } } });
    const client = createProxmoxApiClient(tokenConnector(), {
      transport,
      pollIntervalMs: 1,
      wait: vi.fn().mockResolvedValue(undefined),
    });

    await expect(client.pollTask({ node: 'pve', upid: 'UPID:pve:1', timeoutMs: 0 })).rejects.toBeInstanceOf(ProxmoxApiError);
  });
});
