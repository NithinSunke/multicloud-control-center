import { EventEmitter } from 'events';
import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { createGcpBucket, createGcpDisk, createGcpFirewallRule, createGcpInstance, createGcpSqlBackup, createGcpSqlInstance, createGcpSubnet, createGcpVpc, deleteGcpBucketObject, deleteGcpInstance, deleteGcpSqlInstance, getGcpInventory, listGcpBucketObjects, listGcpSqlBackups, reserveGcpExternalIp, restoreGcpSqlBackup, runGcpInstanceAction, runGcpSqlInstanceAction, uploadGcpBucketObject } from './gcpApiClient.js';

function response(statusCode, body) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setEncoding = () => undefined;
  setTimeout(() => {
    res.emit('data', JSON.stringify(body));
    res.emit('end');
  }, 0);
  return res;
}

function mockRequest(responses, calls) {
  return (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.write = (body) => {
      req.body = body;
      options.body = body;
    };
    req.end = () => {
      callback(responses.shift() || response(200, { items: [] }));
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
}

function privateKey() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

function connector() {
  return {
    id: 'gcp-1',
    provider: 'gcp',
    status: 'verified',
    name: 'GCP Lab',
    gcpProjectId: 'project-one',
    gcpProjectName: 'Project One',
    gcpClientEmail: 'sa@project-one.iam.gserviceaccount.com',
    privateKey: privateKey(),
    tlsVerify: true,
  };
}

describe('gcp api client', () => {
  it('scans GCP read-only inventory and normalizes resources', async () => {
    const calls = [];
    const net = 'https://www.googleapis.com/compute/v1/projects/project-one/global/networks/default';
    const subnet = 'https://www.googleapis.com/compute/v1/projects/project-one/regions/us-central1/subnetworks/default';
    const request = mockRequest([
      response(200, { access_token: 'token' }),
      response(200, { projectId: 'project-one', name: 'Project One', projectNumber: '123' }),
      response(200, { items: [{ name: 'us-central1', status: 'UP' }] }),
      response(200, { items: [{ name: 'us-central1-a', region: 'https://www.googleapis.com/compute/v1/projects/project-one/regions/us-central1', status: 'UP' }] }),
      response(200, { items: [{ name: 'default', selfLink: net, routingConfig: { routingMode: 'REGIONAL' } }] }),
      response(200, { items: { 'regions/us-central1': { subnetworks: [{ name: 'default', selfLink: subnet, region: 'https://www.googleapis.com/compute/v1/projects/project-one/regions/us-central1', network: net, ipCidrRange: '10.0.0.0/24' }] } } }),
      response(200, { items: [{ name: 'allow-ssh', network: net, allowed: [{ IPProtocol: 'tcp', ports: ['22'] }] }] }),
      response(200, { items: [{ name: 'default-route', network: net, destRange: '0.0.0.0/0', nextHopGateway: 'default-internet-gateway' }] }),
      response(200, { items: { 'regions/us-central1': { routers: [{ name: 'router-1', region: 'https://www.googleapis.com/compute/v1/projects/project-one/regions/us-central1', network: net, nats: [{ name: 'nat-1' }] }] } } }),
      response(200, { items: { 'regions/us-central1': { addresses: [{ name: 'ip-1', address: '34.1.2.3', status: 'RESERVED', region: 'https://www.googleapis.com/compute/v1/projects/project-one/regions/us-central1' }] } } }),
      response(200, { items: { 'zones/us-central1-a': { instances: [{ name: 'vm-1', status: 'RUNNING', zone: 'https://www.googleapis.com/compute/v1/projects/project-one/zones/us-central1-a', machineType: 'https://www.googleapis.com/compute/v1/projects/project-one/zones/us-central1-a/machineTypes/e2-micro', networkInterfaces: [{ network: net, subnetwork: subnet, networkIP: '10.0.0.2', accessConfigs: [{ natIP: '35.1.2.3' }] }] }] } } }),
      response(200, { items: { 'zones/us-central1-a': { disks: [{ name: 'disk-1', zone: 'https://www.googleapis.com/compute/v1/projects/project-one/zones/us-central1-a', sizeGb: '10' }] } } }),
      response(200, { items: [{ name: 'snap-1', diskSizeGb: '10' }] }),
      response(200, { items: [{ name: 'image-1', status: 'READY' }] }),
      response(200, { items: { 'regions/us-central1': { forwardingRules: [{ name: 'lb-1', IPAddress: '35.2.3.4', loadBalancingScheme: 'EXTERNAL', region: 'https://www.googleapis.com/compute/v1/projects/project-one/regions/us-central1' }] } } }),
      response(200, { items: [{ name: 'bucket-1', location: 'US', storageClass: 'STANDARD' }] }),
      response(200, { items: [{ name: 'sql-1', region: 'us-central1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', settings: { tier: 'db-f1-micro' } }] }),
      response(200, { items: [{ name: 'postgres', instance: 'sql-1', charset: 'UTF8' }] }),
      response(200, { clusters: [{ name: 'gke-1', location: 'us-central1', status: 'RUNNING', currentNodeCount: 1 }] }),
      response(200, { accounts: [{ email: 'sa@project-one.iam.gserviceaccount.com', displayName: 'scanner' }] }),
    ], calls);

    const inventory = await getGcpInventory(connector(), { request, now: 1760000000 });

    expect(inventory.summary.instances).toBe(1);
    expect(inventory.summary.networks).toBe(1);
    expect(inventory.summary.diskUsageGb).toBe(10);
    expect(inventory.summary.buckets).toBe(1);
    expect(inventory.instances[0]).toMatchObject({
      name: 'vm-1',
      status: 'RUNNING',
      providerType: 'computeInstance',
      privateIp: '10.0.0.2',
      publicIp: '35.1.2.3',
    });
    expect(inventory.subnets[0]).toMatchObject({ cidrBlock: '10.0.0.0/24', vpcName: 'default' });
    expect(inventory.allResources.length).toBeGreaterThan(10);
    expect(calls.map((call) => call.hostname)).toContain('compute.googleapis.com');
    expect(calls.map((call) => call.hostname)).toContain('storage.googleapis.com');
    expect(calls.map((call) => call.hostname)).toContain('sqladmin.googleapis.com');
  });

  it('submits lifecycle actions and normalizes the accepted operation', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token' }),
      response(200, { name: 'operation-1', status: 'PENDING', targetLink: 'zones/us-central1-a/instances/vm-1', operationType: 'stop' }),
      response(200, { access_token: 'token' }),
      response(200, { name: 'operation-2', status: 'PENDING', targetLink: 'zones/us-central1-a/instances/vm-1', operationType: 'start' }),
    ], calls);

    const result = await runGcpInstanceAction(connector(), { zone: 'us-central1-a', instanceName: 'vm-1', action: 'stop' }, { request, now: 1760000000 });
    const started = await runGcpInstanceAction(connector(), { zone: 'us-central1-a', instanceName: 'vm-1', action: 'start' }, { request, now: 1760000000 });

    expect(result.instance).toMatchObject({ name: 'vm-1', status: 'STOPPING', providerType: 'computeInstance' });
    expect(started.instance).toMatchObject({ name: 'vm-1', status: 'STARTING', providerType: 'computeInstance' });
    expect(result.operation).toMatchObject({ name: 'operation-1', status: 'PENDING' });
    expect(calls[1].method).toBe('POST');
    expect(calls[1].path).toContain('/instances/vm-1/stop');
    expect(calls[3].path).toContain('/instances/vm-1/start');
  });

  it('guards paid VM create and submits create when explicitly enabled', async () => {
    await expect(createGcpInstance(connector(), {
      zone: 'us-central1-a',
      name: 'vm-new',
      machineType: 'e2-micro',
      sourceImage: 'projects/debian-cloud/global/images/family/debian-12',
      network: 'global/networks/default',
      acceptCostWarning: true,
    })).rejects.toThrow('GCP VM creation is disabled');

    const previous = process.env.GCP_ALLOW_PAID_VM_CREATE;
    process.env.GCP_ALLOW_PAID_VM_CREATE = 'true';
    try {
      const calls = [];
      const request = mockRequest([
        response(200, { access_token: 'token' }),
        response(200, { name: 'insert-op', status: 'PENDING', targetLink: 'zones/us-central1-a/instances/vm-new', operationType: 'insert' }),
      ], calls);
      const result = await createGcpInstance(connector(), {
        zone: 'us-central1-a',
        name: 'vm-new',
        machineType: 'e2-micro',
        sourceImage: 'projects/debian-cloud/global/images/family/debian-12',
        network: 'global/networks/default',
        diskSizeGb: '10',
        diskType: 'pd-balanced',
        labels: { environment: 'test' },
        acceptCostWarning: true,
      }, { request, now: 1760000000 });

      expect(result.instance).toMatchObject({ name: 'vm-new', status: 'PROVISIONING', shape: 'e2-micro' });
      expect(calls[1].method).toBe('POST');
      expect(calls[1].path).toContain('/zones/us-central1-a/instances');
      expect(JSON.parse(calls[1].body).disks[0].initializeParams.sourceImage).toBe('projects/debian-cloud/global/images/family/debian-12');
      expect(JSON.parse(calls[1].body).disks[0].initializeParams.diskType).toBe('zones/us-central1-a/diskTypes/pd-balanced');
    } finally {
      if (previous === undefined) {
        delete process.env.GCP_ALLOW_PAID_VM_CREATE;
      } else {
        process.env.GCP_ALLOW_PAID_VM_CREATE = previous;
      }
    }
  });

  it('supports snapshot and existing disk boot sources when creating a VM', async () => {
    const previous = process.env.GCP_ALLOW_PAID_VM_CREATE;
    process.env.GCP_ALLOW_PAID_VM_CREATE = 'true';
    try {
      const snapshotCalls = [];
      const snapshotRequest = mockRequest([
        response(200, { access_token: 'token' }),
        response(200, { name: 'insert-op', status: 'PENDING', targetLink: 'zones/us-central1-a/instances/vm-snapshot', operationType: 'insert' }),
      ], snapshotCalls);
      await createGcpInstance(connector(), {
        zone: 'us-central1-a',
        name: 'vm-snapshot',
        machineType: 'e2-micro',
        sourceSnapshot: 'projects/demo/global/snapshots/snap-1',
        network: 'global/networks/default',
        diskSizeGb: '20',
        acceptCostWarning: true,
      }, { request: snapshotRequest, now: 1760000000 });
      expect(JSON.parse(snapshotCalls[1].body).disks[0].initializeParams.sourceSnapshot).toBe('projects/demo/global/snapshots/snap-1');

      const diskCalls = [];
      const diskRequest = mockRequest([
        response(200, { access_token: 'token' }),
        response(200, { name: 'insert-op', status: 'PENDING', targetLink: 'zones/us-central1-a/instances/vm-disk', operationType: 'insert' }),
      ], diskCalls);
      await createGcpInstance(connector(), {
        zone: 'us-central1-a',
        name: 'vm-disk',
        machineType: 'e2-micro',
        sourceDisk: 'projects/demo/zones/us-central1-a/disks/boot-disk',
        network: 'global/networks/default',
        acceptCostWarning: true,
      }, { request: diskRequest, now: 1760000000 });
      expect(JSON.parse(diskCalls[1].body).disks[0]).toMatchObject({
        boot: true,
        source: 'projects/demo/zones/us-central1-a/disks/boot-disk',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GCP_ALLOW_PAID_VM_CREATE;
      } else {
        process.env.GCP_ALLOW_PAID_VM_CREATE = previous;
      }
    }
  });

  it('explains missing GCP VM create permission clearly', async () => {
    const previous = process.env.GCP_ALLOW_PAID_VM_CREATE;
    process.env.GCP_ALLOW_PAID_VM_CREATE = 'true';
    try {
      const calls = [];
      const request = mockRequest([
        response(200, { access_token: 'token' }),
        response(403, {
          error: {
            code: 403,
            message: "Required 'compute.instances.create' permission for 'projects/project-one/zones/us-central1-a/instances/vm-denied'",
            status: 'PERMISSION_DENIED',
          },
        }),
      ], calls);

      await expect(createGcpInstance(connector(), {
        zone: 'us-central1-a',
        name: 'vm-denied',
        machineType: 'e2-micro',
        sourceImage: 'projects/debian-cloud/global/images/family/debian-12',
        network: 'global/networks/default',
        acceptCostWarning: true,
      }, { request, now: 1760000000 })).rejects.toThrow('project-one');
    } finally {
      if (previous === undefined) {
        delete process.env.GCP_ALLOW_PAID_VM_CREATE;
      } else {
        process.env.GCP_ALLOW_PAID_VM_CREATE = previous;
      }
    }
  });

  it('requires typed confirmation before deleting a VM', async () => {
    await expect(deleteGcpInstance(connector(), {
      zone: 'us-central1-a',
      instanceName: 'vm-1',
      confirmation: 'wrong',
    })).rejects.toThrow('Type the VM name');
  });

  it('submits persistent disk create and normalizes storage bucket objects', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token' }),
      response(200, { name: 'disk-op', status: 'PENDING', targetLink: 'zones/us-central1-a/disks/data-1', operationType: 'insert' }),
      response(200, { access_token: 'token' }),
      response(200, { items: [{ name: 'folder/file.txt', size: '12', storageClass: 'STANDARD', updated: '2026-01-01T00:00:00Z' }] }),
    ], calls);

    const disk = await createGcpDisk(connector(), { zone: 'us-central1-a', name: 'data-1', sizeGb: '20' }, { request, now: 1760000000 });
    const objects = await listGcpBucketObjects(connector(), { bucketName: 'bucket-1', prefix: 'folder/' }, { request, now: 1760000000 });

    expect(disk.disk).toMatchObject({ name: 'data-1', status: 'CREATING', sizeGb: '20' });
    expect(objects.objects[0]).toMatchObject({ key: 'folder/file.txt', bucketName: 'bucket-1', sizeBytes: '12' });
    expect(calls[1].path).toContain('/zones/us-central1-a/disks');
    expect(calls[3].path).toContain('/storage/v1/b/bucket-1/o');
  });

  it('creates buckets and uploads/deletes objects with safety confirmation', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token' }),
      response(200, { name: 'bucket-1', location: 'US', storageClass: 'STANDARD', versioning: { enabled: true }, iamConfiguration: { publicAccessPrevention: 'enforced' } }),
      response(200, { access_token: 'token' }),
      response(200, { name: 'file.txt', size: '5', contentType: 'text/plain' }),
      response(200, { access_token: 'token' }),
      response(204, {}),
    ], calls);

    const bucket = await createGcpBucket(connector(), { name: 'bucket-1', location: 'US', versioning: true }, { request, now: 1760000000 });
    const uploaded = await uploadGcpBucketObject(connector(), { bucketName: 'bucket-1', objectName: 'file.txt', content: 'hello' }, { request, now: 1760000000 });
    await expect(deleteGcpBucketObject(connector(), { bucketName: 'bucket-1', objectName: 'file.txt', confirmation: 'wrong' })).rejects.toThrow('Type the object name');
    const deleted = await deleteGcpBucketObject(connector(), { bucketName: 'bucket-1', objectName: 'file.txt', confirmation: 'file.txt' }, { request, now: 1760000000 });

    expect(bucket.bucket).toMatchObject({ name: 'bucket-1', versioning: 'enabled', publicAccessStatus: 'enforced' });
    expect(uploaded.object).toMatchObject({ name: 'file.txt', bucketName: 'bucket-1' });
    expect(deleted.object).toMatchObject({ name: 'file.txt' });
    expect(calls[3].path).toContain('/upload/storage/v1/b/bucket-1/o');
    expect(calls[3].headers['Content-Type']).toBe('text/plain');
  });

  it('submits VPC, subnet, and firewall rule network operations', async () => {
    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token' }),
      response(200, { name: 'vpc-op', status: 'PENDING', targetLink: 'global/networks/app-vpc' }),
      response(200, { access_token: 'token' }),
      response(200, { name: 'subnet-op', status: 'PENDING', targetLink: 'regions/us-central1/subnetworks/app-subnet' }),
      response(200, { access_token: 'token' }),
      response(200, { name: 'fw-op', status: 'PENDING', targetLink: 'global/firewalls/allow-ssh' }),
    ], calls);

    const vpc = await createGcpVpc(connector(), { name: 'app-vpc', routingMode: 'REGIONAL' }, { request, now: 1760000000 });
    const subnet = await createGcpSubnet(connector(), { name: 'app-subnet', region: 'us-central1', network: 'global/networks/app-vpc', cidrBlock: '10.1.0.0/24' }, { request, now: 1760000000 });
    const firewall = await createGcpFirewallRule(connector(), { name: 'allow-ssh', network: 'global/networks/app-vpc', protocol: 'tcp', ports: '22', sourceRanges: '10.0.0.0/8' }, { request, now: 1760000000 });

    expect(vpc.network).toMatchObject({ name: 'app-vpc', providerType: 'vpcNetwork' });
    expect(subnet.subnet).toMatchObject({ name: 'app-subnet', cidrBlock: '10.1.0.0/24' });
    expect(firewall.firewallRule).toMatchObject({ name: 'allow-ssh', status: 'enabled' });
    expect(calls[1].path).toContain('/global/networks');
    expect(calls[3].path).toContain('/regions/us-central1/subnetworks');
    expect(calls[5].path).toContain('/global/firewalls');
  });

  it('guards external IP reservation behind paid-resource confirmation', async () => {
    await expect(reserveGcpExternalIp(connector(), { name: 'ip-1', region: 'us-central1', acceptCostWarning: true })).rejects.toThrow('external IP reservation is disabled');

    const previous = process.env.GCP_ALLOW_PAID_EXTERNAL_IP;
    process.env.GCP_ALLOW_PAID_EXTERNAL_IP = 'true';
    try {
      await expect(reserveGcpExternalIp(connector(), { name: 'ip-1', region: 'us-central1' })).rejects.toThrow('Confirm the GCP external IP cost warning');
      const calls = [];
      const request = mockRequest([
        response(200, { access_token: 'token' }),
        response(200, { name: 'ip-op', status: 'PENDING', targetLink: 'regions/us-central1/addresses/ip-1' }),
      ], calls);
      const result = await reserveGcpExternalIp(connector(), { name: 'ip-1', region: 'us-central1', acceptCostWarning: true }, { request, now: 1760000000 });
      expect(result.address).toMatchObject({ name: 'ip-1', status: 'RESERVING', providerType: 'externalIp' });
      expect(calls[1].path).toContain('/regions/us-central1/addresses');
    } finally {
      if (previous === undefined) {
        delete process.env.GCP_ALLOW_PAID_EXTERNAL_IP;
      } else {
        process.env.GCP_ALLOW_PAID_EXTERNAL_IP = previous;
      }
    }
  });

  it('guards Cloud SQL create and submits a cost-acknowledged instance create', async () => {
    await expect(createGcpSqlInstance(connector(), {
      name: 'sql-1',
      region: 'us-central1',
      databaseVersion: 'POSTGRES_16',
      tier: 'db-f1-micro',
      storageSizeGb: '20',
      acceptCostWarning: true,
    })).rejects.toThrow('Cloud SQL creation is disabled');

    const previous = process.env.GCP_ALLOW_PAID_SQL_CREATE;
    process.env.GCP_ALLOW_PAID_SQL_CREATE = 'true';
    try {
      await expect(createGcpSqlInstance(connector(), {
        name: 'sql-1',
        region: 'us-central1',
        databaseVersion: 'POSTGRES_16',
        tier: 'db-f1-micro',
      })).rejects.toThrow('Confirm the GCP Cloud SQL cost warning');

      const calls = [];
      const request = mockRequest([
        response(200, { access_token: 'token' }),
        response(200, { name: 'sql-op', status: 'PENDING', targetLink: 'instances/sql-1' }),
      ], calls);

      const result = await createGcpSqlInstance(connector(), {
        name: 'sql-1',
        region: 'us-central1',
        databaseVersion: 'POSTGRES_16',
        tier: 'db-f1-micro',
        storageSizeGb: '20',
        acceptCostWarning: true,
      }, { request, now: 1760000000 });

      expect(result.instance).toMatchObject({ name: 'sql-1', status: 'PENDING_CREATE', providerType: 'sqlInstance', tier: 'db-f1-micro' });
      expect(calls[1].hostname).toBe('sqladmin.googleapis.com');
      expect(calls[1].path).toBe('/sql/v1beta4/projects/project-one/instances');
    } finally {
      if (previous === undefined) {
        delete process.env.GCP_ALLOW_PAID_SQL_CREATE;
      } else {
        process.env.GCP_ALLOW_PAID_SQL_CREATE = previous;
      }
    }
  });

  it('submits Cloud SQL lifecycle, backup, restore, and delete operations', async () => {
    await expect(deleteGcpSqlInstance(connector(), { instanceName: 'sql-1', confirmation: 'wrong' })).rejects.toThrow('Type the Cloud SQL instance name');

    const calls = [];
    const request = mockRequest([
      response(200, { access_token: 'token' }),
      response(200, { name: 'start-op', status: 'PENDING', targetLink: 'instances/sql-1' }),
      response(200, { access_token: 'token' }),
      response(200, { items: [{ id: '123', status: 'SUCCESSFUL', type: 'ON_DEMAND', startTime: '2026-01-01T00:00:00Z' }] }),
      response(200, { access_token: 'token' }),
      response(200, { id: '124', status: 'RUNNING', type: 'ON_DEMAND' }),
      response(200, { access_token: 'token' }),
      response(200, { name: 'restore-op', status: 'PENDING', targetLink: 'instances/sql-1' }),
      response(200, { access_token: 'token' }),
      response(200, { name: 'delete-op', status: 'PENDING', targetLink: 'instances/sql-1' }),
    ], calls);

    const started = await runGcpSqlInstanceAction(connector(), { instanceName: 'sql-1', action: 'start' }, { request, now: 1760000000 });
    const backups = await listGcpSqlBackups(connector(), { instanceName: 'sql-1' }, { request, now: 1760000000 });
    const backup = await createGcpSqlBackup(connector(), { instanceName: 'sql-1', description: 'manual' }, { request, now: 1760000000 });
    const restored = await restoreGcpSqlBackup(connector(), { instanceName: 'sql-1', backupRunId: '123' }, { request, now: 1760000000 });
    const deleted = await deleteGcpSqlInstance(connector(), { instanceName: 'sql-1', confirmation: 'sql-1' }, { request, now: 1760000000 });

    expect(started.instance).toMatchObject({ name: 'sql-1', status: 'STARTING' });
    expect(backups.backups[0]).toMatchObject({ backupRunId: '123', status: 'SUCCESSFUL' });
    expect(backup.backup).toMatchObject({ backupRunId: '124', status: 'RUNNING' });
    expect(restored.instance).toMatchObject({ name: 'sql-1', status: 'RESTORING' });
    expect(deleted.instance).toMatchObject({ name: 'sql-1', status: 'DELETING' });
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].path).toContain('/instances/sql-1');
    expect(JSON.parse(calls[1].body).settings.activationPolicy).toBe('ALWAYS');
    expect(calls[3].path).toContain('/instances/sql-1/backupRuns');
    expect(calls[7].path).toContain('/instances/sql-1/restoreBackup');
    expect(JSON.parse(calls[7].body).restoreBackupContext.backupRunId).toBe('123');
  });
});
