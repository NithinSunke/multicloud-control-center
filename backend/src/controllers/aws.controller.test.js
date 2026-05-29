import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../app.js';
import { setCachedAwsInventory } from '../services/awsInventoryCache.js';
import { attachAwsVolume, createAwsBucket, createAwsImage, createAwsInstance, createAwsInternetGateway, createAwsKeyPair, createAwsNatGateway, createAwsRdsInstance, createAwsRdsSnapshot, createAwsRouteTable, createAwsSnapshot, createAwsSubnet, createAwsVolume, createAwsVpc, deleteAwsBucket, deleteAwsBucketObject, deleteAwsInternetGateway, deleteAwsNatGateway, deleteAwsRdsInstance, deleteAwsRdsSnapshot, deleteAwsRouteTable, deleteAwsSnapshot, deleteAwsSubnet, deleteAwsVolume, deleteAwsVpc, describeAwsInstance, describeAwsRdsInstance, describeAwsRouteTable, detachAwsVolume, getAwsBucketObject, getAwsInventory, listAwsBucketObjects, listAwsImages, listAwsKeyPairs, listAwsRdsSnapshots, putAwsBucketObject, resizeAwsVolume, restoreAwsRdsInstanceFromSnapshot, runAwsInstanceAction, runAwsRdsInstanceAction, updateAwsBucketVersioning, updateAwsSecurityGroupRule } from '../services/awsApiClient.js';

vi.mock('../services/awsApiClient.js', () => ({
  attachAwsVolume: vi.fn(),
  changeAwsInstanceType: vi.fn(),
  createAwsBucket: vi.fn(),
  createAwsImage: vi.fn(),
  createAwsInstance: vi.fn(),
  createAwsInternetGateway: vi.fn(),
  createAwsKeyPair: vi.fn(),
  createAwsNatGateway: vi.fn(),
  createAwsRdsInstance: vi.fn(),
  createAwsRdsSnapshot: vi.fn(),
  createAwsRouteTable: vi.fn(),
  createAwsSnapshot: vi.fn(),
  createAwsSubnet: vi.fn(),
  createAwsVolume: vi.fn(),
  createAwsVpc: vi.fn(),
  deleteAwsBucket: vi.fn(),
  deleteAwsBucketObject: vi.fn(),
  deleteAwsInternetGateway: vi.fn(),
  deleteAwsNatGateway: vi.fn(),
  deleteAwsRdsInstance: vi.fn(),
  deleteAwsRdsSnapshot: vi.fn(),
  deleteAwsRouteTable: vi.fn(),
  deleteAwsSnapshot: vi.fn(),
  deleteAwsSubnet: vi.fn(),
  deleteAwsVolume: vi.fn(),
  deleteAwsVpc: vi.fn(),
  describeAwsInstance: vi.fn(),
  describeAwsRdsInstance: vi.fn(),
  describeAwsRouteTable: vi.fn(),
  detachAwsVolume: vi.fn(),
  getAwsBucketObject: vi.fn(),
  getAwsInventory: vi.fn(),
  listAwsBucketObjects: vi.fn(),
  listAwsImages: vi.fn(),
  listAwsKeyPairs: vi.fn(),
  listAwsRdsSnapshots: vi.fn(),
  putAwsBucketObject: vi.fn(),
  resizeAwsVolume: vi.fn(),
  restoreAwsRdsInstanceFromSnapshot: vi.fn(),
  runAwsInstanceAction: vi.fn(),
  runAwsRdsInstanceAction: vi.fn(),
  updateAwsBucketVersioning: vi.fn(),
  updateAwsSecurityGroupRule: vi.fn(),
}));

let dataDir;

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'secret-password' })
    .expect(200);
  return agent;
}

function awsConnectorPayload(overrides = {}) {
  return {
    provider: 'aws',
    name: 'Production AWS',
    region: 'us-east-1',
    awsAccountId: '123456789012',
    awsAccessKeyId: 'AKIATESTKEY123456',
    awsSecretAccessKey: 'aws-secret-access-key',
    awsSessionToken: '',
    tlsVerify: true,
    notes: '',
    ...overrides,
  };
}

async function markAwsConnectorVerified(connectorId) {
  const storePath = path.join(dataDir, 'proxmox-connectors.json');
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  store.connectors = store.connectors.map((connector) =>
    connector.id === connectorId
      ? {
          ...connector,
          status: 'verified',
          verificationMessage: 'Connected to AWS account 123456789012.',
          lastVerifiedAt: '2026-05-15T00:00:00.000Z',
        }
      : connector,
  );
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');
}

describe('aws controller', () => {
  beforeEach(async () => {
    vi.mocked(getAwsInventory).mockReset();
    vi.mocked(listAwsImages).mockReset();
    vi.mocked(listAwsKeyPairs).mockReset();
    vi.mocked(runAwsInstanceAction).mockReset();
    vi.mocked(createAwsInstance).mockReset();
    vi.mocked(createAwsKeyPair).mockReset();
    vi.mocked(createAwsRdsInstance).mockReset();
    vi.mocked(createAwsRdsSnapshot).mockReset();
    vi.mocked(runAwsRdsInstanceAction).mockReset();
    vi.mocked(describeAwsRdsInstance).mockReset();
    vi.mocked(listAwsRdsSnapshots).mockReset();
    vi.mocked(restoreAwsRdsInstanceFromSnapshot).mockReset();
    vi.mocked(deleteAwsRdsInstance).mockReset();
    vi.mocked(deleteAwsRdsSnapshot).mockReset();
    vi.mocked(createAwsVolume).mockReset();
    vi.mocked(resizeAwsVolume).mockReset();
    vi.mocked(deleteAwsVolume).mockReset();
    vi.mocked(createAwsSnapshot).mockReset();
    vi.mocked(deleteAwsSnapshot).mockReset();
    vi.mocked(createAwsBucket).mockReset();
    vi.mocked(createAwsVpc).mockReset();
    vi.mocked(createAwsSubnet).mockReset();
    vi.mocked(createAwsRouteTable).mockReset();
    vi.mocked(createAwsInternetGateway).mockReset();
    vi.mocked(createAwsNatGateway).mockReset();
    vi.mocked(deleteAwsVpc).mockReset();
    vi.mocked(deleteAwsSubnet).mockReset();
    vi.mocked(deleteAwsRouteTable).mockReset();
    vi.mocked(deleteAwsInternetGateway).mockReset();
    vi.mocked(deleteAwsNatGateway).mockReset();
    vi.mocked(updateAwsSecurityGroupRule).mockReset();
    vi.mocked(describeAwsRouteTable).mockReset();
    vi.mocked(deleteAwsBucket).mockReset();
    vi.mocked(listAwsBucketObjects).mockReset();
    vi.mocked(getAwsBucketObject).mockReset();
    vi.mocked(putAwsBucketObject).mockReset();
    vi.mocked(deleteAwsBucketObject).mockReset();
    vi.mocked(updateAwsBucketVersioning).mockReset();
    vi.mocked(describeAwsInstance).mockReset();
    vi.mocked(createAwsImage).mockReset();
    vi.mocked(attachAwsVolume).mockReset();
    vi.mocked(detachAwsVolume).mockReset();
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'pm-aws-api-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENCRYPTION_KEY = 'test-encryption-key-that-is-long-enough';
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'secret-password';
    delete process.env.ADMIN_PASSWORD_HASH;
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.COOKIE_SECURE = 'false';
    process.env.AWS_INVENTORY_STORE = 'memory';
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.AWS_INVENTORY_STORE;
  });

  it('requires authentication for AWS inventory routes', async () => {
    const app = createServer();

    await request(app).get('/api/aws/inventory').expect(401);
  });

  it('requires a verified AWS connector before loading inventory', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);

    const response = await agent.get('/api/aws/inventory').expect(400);

    expect(response.body.message).toBe('Verify the selected AWS connector before loading inventory.');
    expect(JSON.stringify(response.body)).not.toContain('aws-secret-access-key');
  });

  it('returns cached AWS inventory without exposing raw connector secrets', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    await setCachedAwsInventory(created.body.connector.id, 'all', {
      generatedAt: '2026-05-15T00:00:00.000Z',
      cached: false,
      connector: {
        id: created.body.connector.id,
        name: 'Production AWS',
        region: 'us-east-1',
        accountId: '123456789012',
      },
      scan: { requestedRegion: 'all', scannedRegions: ['us-east-1'] },
      summary: { regions: 1, instances: 1, vpcs: 1 },
      regions: [{ name: 'us-east-1', endpoint: 'ec2.us-east-1.amazonaws.com', status: 'available' }],
      instances: [{ id: 'i-123', name: 'aws-web-1', status: 'running', region: 'us-east-1' }],
      vpcs: [{ id: 'vpc-123', name: 'prod-vpc', status: 'available', region: 'us-east-1' }],
      subnets: [],
      securityGroups: [],
      routeTables: [],
      internetGateways: [],
      natGateways: [],
      ebsVolumes: [],
      ebsSnapshots: [],
      s3Buckets: [],
      rdsDatabases: [],
      loadBalancers: [],
      elasticIps: [],
      iamSummary: {},
      errors: [],
    });

    const response = await agent.get('/api/aws/inventory').expect(200);

    expect(response.body.data.cached).toBe(true);
    expect(response.body.data.instances[0].name).toBe('aws-web-1');
    expect(response.body.data.vpcs[0].name).toBe('prod-vpc');
    expect(JSON.stringify(response.body)).not.toContain('aws-secret-access-key');
    expect(getAwsInventory).not.toHaveBeenCalled();
  });

  it('does not scan AWS on cache miss unless refresh is requested', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);

    const response = await agent.get('/api/aws/inventory?region=us-east-1').expect(200);

    expect(response.body.data.cached).toBe(true);
    expect(response.body.data.cacheMiss).toBe(true);
    expect(response.body.data.instances).toEqual([]);
    expect(getAwsInventory).not.toHaveBeenCalled();
  });

  it('scans AWS and stores PostgreSQL cache only when refresh is requested', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    vi.mocked(getAwsInventory).mockResolvedValue({
      generatedAt: '2026-05-15T00:00:00.000Z',
      cached: false,
      connector: {
        id: created.body.connector.id,
        name: 'Production AWS',
        region: 'us-east-1',
        accountId: '123456789012',
      },
      scan: { requestedRegion: 'us-east-1', scannedRegions: ['us-east-1'] },
      summary: { regions: 1, instances: 1, vpcs: 1 },
      regions: [{ name: 'us-east-1', endpoint: 'ec2.us-east-1.amazonaws.com', status: 'available' }],
      instances: [{ id: 'i-123', name: 'aws-web-1', status: 'running', region: 'us-east-1' }],
      vpcs: [{ id: 'vpc-123', name: 'prod-vpc', status: 'available', region: 'us-east-1' }],
      subnets: [],
      securityGroups: [],
      routeTables: [],
      internetGateways: [],
      natGateways: [],
      ebsVolumes: [],
      ebsSnapshots: [],
      s3Buckets: [],
      rdsDatabases: [],
      loadBalancers: [],
      elasticIps: [],
      iamSummary: {},
      errors: [],
    });

    const refreshed = await agent.get('/api/aws/inventory?region=us-east-1&refresh=true').expect(200);
    expect(refreshed.body.data.cached).toBe(false);
    expect(refreshed.body.data.instances[0].name).toBe('aws-web-1');
    expect(getAwsInventory).toHaveBeenCalledTimes(1);

    const cached = await agent.get('/api/aws/inventory?region=us-east-1').expect(200);
    expect(cached.body.data.cached).toBe(true);
    expect(cached.body.data.cacheMiss).toBe(false);
    expect(cached.body.data.instances[0].name).toBe('aws-web-1');
    expect(getAwsInventory).toHaveBeenCalledTimes(1);
  });

  it('submits EC2 lifecycle actions and updates cached instance state', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    await setCachedAwsInventory(created.body.connector.id, 'us-east-1', {
      generatedAt: '2026-05-15T00:00:00.000Z',
      cached: false,
      connector: { id: created.body.connector.id, name: 'Production AWS', region: 'us-east-1', accountId: '123456789012' },
      scan: { requestedRegion: 'us-east-1', scannedRegions: ['us-east-1'] },
      summary: { regions: 1, instances: 1 },
      regions: [],
      instances: [{ id: 'i-123', name: 'aws-web-1', status: 'stopped', region: 'us-east-1' }],
      vpcs: [],
      subnets: [],
      securityGroups: [],
      routeTables: [],
      internetGateways: [],
      natGateways: [],
      ebsVolumes: [],
      ebsSnapshots: [],
      s3Buckets: [],
      rdsDatabases: [],
      loadBalancers: [],
      elasticIps: [],
      iamSummary: {},
      errors: [],
    });
    vi.mocked(runAwsInstanceAction).mockResolvedValue({
      message: 'AWS start request submitted.',
      instance: { id: 'i-123', name: 'aws-web-1', status: 'pending', region: 'us-east-1', providerType: 'ec2Instance', resourceType: 'ec2Instance' },
    });

    const response = await agent
      .post('/api/aws/instances/i-123/actions/start')
      .send({ region: 'us-east-1', scanRegion: 'us-east-1', instanceName: 'aws-web-1' })
      .expect(202);

    expect(response.body.data.instance.status).toBe('pending');
    expect(runAwsInstanceAction).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ action: 'start', instanceId: 'i-123', region: 'us-east-1' }));

    const cached = await agent.get('/api/aws/inventory?region=us-east-1').expect(200);
    expect(cached.body.data.instances[0].status).toBe('pending');
    expect(JSON.stringify(response.body)).not.toContain('aws-secret-access-key');

    const jobs = await agent.get('/api/aws/jobs').expect(200);
    expect(jobs.body.data.tasks).toHaveLength(1);
    expect(jobs.body.data.tasks[0]).toEqual(expect.objectContaining({
      provider: 'aws',
      action: 'aws-ec2-start',
      status: 'running',
      progress: 50,
      message: 'AWS start request submitted.',
      resourceType: 'ec2Instance',
      resourceId: 'i-123',
    }));
    expect(jobs.body.data.tasks[0].linkedResource).toEqual(expect.objectContaining({
      provider: 'aws',
      type: 'ec2Instance',
      id: 'i-123',
      region: 'us-east-1',
    }));
    expect(JSON.stringify(jobs.body)).not.toContain('aws-secret-access-key');
  });

  it('requires typed confirmation before terminating EC2 instances', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);

    await agent
      .delete('/api/aws/instances/i-123')
      .send({ region: 'us-east-1', instanceName: 'aws-web-1', confirmation: 'wrong' })
      .expect(400);

    expect(runAwsInstanceAction).not.toHaveBeenCalled();

    vi.mocked(runAwsInstanceAction).mockResolvedValue({
      message: 'AWS terminate request submitted.',
      instance: { id: 'i-123', name: 'aws-web-1', status: 'shutting-down', region: 'us-east-1', providerType: 'ec2Instance', resourceType: 'ec2Instance' },
    });

    await agent
      .delete('/api/aws/instances/i-123')
      .send({ region: 'us-east-1', instanceName: 'aws-web-1', confirmation: 'aws-web-1' })
      .expect(202);
  });

  it('submits create instance, AMI, attach volume, and detach volume requests', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    vi.mocked(createAwsInstance).mockResolvedValue({
      message: 'AWS instance launch requested.',
      instance: { id: 'i-new', name: 'new-web', status: 'pending', region: 'us-east-1', providerType: 'ec2Instance', resourceType: 'ec2Instance' },
    });
    vi.mocked(createAwsImage).mockResolvedValue({ message: 'AWS AMI creation requested.', imageId: 'ami-123' });
    vi.mocked(attachAwsVolume).mockResolvedValue({
      message: 'AWS volume attach requested.',
      volume: { id: 'vol-123', name: 'vol-123', status: 'in-use', region: 'us-east-1', attachedInstanceId: 'i-new', providerType: 'ebsVolume', resourceType: 'ebsVolume' },
    });
    vi.mocked(detachAwsVolume).mockResolvedValue({
      message: 'AWS volume detach requested.',
      volume: { id: 'vol-123', name: 'vol-123', status: 'available', region: 'us-east-1', attachedInstanceId: '', providerType: 'ebsVolume', resourceType: 'ebsVolume' },
    });

    await agent.post('/api/aws/instances').send({ region: 'us-east-1', imageId: 'ami-base', instanceType: 't3.micro', name: 'new-web' }).expect(202);
    await agent.post('/api/aws/instances/i-new/ami').send({ region: 'us-east-1', name: 'new-web-image' }).expect(202);
    await agent.post('/api/aws/instances/i-new/volumes').send({ region: 'us-east-1', volumeId: 'vol-123', device: '/dev/sdf' }).expect(202);
    await agent.delete('/api/aws/instances/i-new/volumes/vol-123').send({ region: 'us-east-1' }).expect(202);

    expect(createAwsInstance).toHaveBeenCalledTimes(1);
    expect(createAwsImage).toHaveBeenCalledTimes(1);
    expect(attachAwsVolume).toHaveBeenCalledTimes(1);
    expect(detachAwsVolume).toHaveBeenCalledTimes(1);
  });

  it('lists EC2 AMI options for the selected region without returning connector secrets', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    vi.mocked(listAwsImages).mockResolvedValue({
      generatedAt: '2026-05-15T00:05:00.000Z',
      region: 'us-east-1',
      images: [
        { id: 'ami-123', name: 'Amazon Linux 2023 kernel-6.1 AMI', status: 'available', region: 'us-east-1', architecture: 'x86_64' },
      ],
    });

    const response = await agent.get('/api/aws/images?region=us-east-1&search=linux').expect(200);

    expect(response.body.data.images[0].id).toBe('ami-123');
    expect(listAwsImages).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ region: 'us-east-1', search: 'linux' }));
    expect(JSON.stringify(response.body)).not.toContain('aws-secret-access-key');
  });

  it('lists and creates EC2 key pairs for the selected region', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    vi.mocked(listAwsKeyPairs).mockResolvedValue({
      generatedAt: '2026-05-15T00:06:00.000Z',
      region: 'us-east-1',
      keyPairs: [{ id: 'key-123', name: 'prod-key', fingerprint: 'aa:bb', region: 'us-east-1' }],
    });
    vi.mocked(createAwsKeyPair).mockResolvedValue({
      message: 'AWS key pair created. Save the private key now; it cannot be retrieved again.',
      keyPair: { id: 'key-new', name: 'new-key', fingerprint: 'cc:dd', region: 'us-east-1' },
      privateKeyMaterial: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
    });

    const listResponse = await agent.get('/api/aws/key-pairs?region=us-east-1').expect(200);
    expect(listResponse.body.data.keyPairs[0].name).toBe('prod-key');
    expect(listAwsKeyPairs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ region: 'us-east-1' }));

    const createResponse = await agent.post('/api/aws/key-pairs').send({ region: 'us-east-1', name: 'new-key' }).expect(201);
    expect(createResponse.body.data.keyPair.name).toBe('new-key');
    expect(createResponse.body.data.privateKeyMaterial).toContain('BEGIN RSA PRIVATE KEY');
    expect(createAwsKeyPair).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ region: 'us-east-1', name: 'new-key' }));
    expect(JSON.stringify(createResponse.body)).not.toContain('aws-secret-access-key');
  });

  it('submits AWS storage operations and writes cache-safe responses', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    await setCachedAwsInventory(created.body.connector.id, 'us-east-1', {
      generatedAt: '2026-05-15T00:00:00.000Z',
      cached: false,
      connector: { id: created.body.connector.id, name: 'Production AWS', region: 'us-east-1', accountId: '123456789012' },
      scan: { requestedRegion: 'us-east-1', scannedRegions: ['us-east-1'] },
      summary: { regions: 1, ebsVolumes: 1, ebsSnapshots: 1, s3Buckets: 1 },
      regions: [],
      instances: [],
      vpcs: [],
      subnets: [],
      securityGroups: [],
      routeTables: [],
      internetGateways: [],
      natGateways: [],
      ebsVolumes: [{ id: 'vol-123', name: 'data', status: 'available', region: 'us-east-1' }],
      ebsSnapshots: [{ id: 'snap-123', name: 'data-snap', status: 'completed', region: 'us-east-1' }],
      s3Buckets: [{ id: 'prod-bucket', name: 'prod-bucket', status: 'available', region: 'us-east-1' }],
      rdsDatabases: [],
      loadBalancers: [],
      elasticIps: [],
      iamSummary: {},
      errors: [],
    });
    vi.mocked(createAwsVolume).mockResolvedValue({ message: 'AWS EBS volume creation requested.', volume: { id: 'vol-new', name: 'new-data', status: 'creating', region: 'us-east-1', providerType: 'ebsVolume', resourceType: 'ebsVolume' } });
    vi.mocked(resizeAwsVolume).mockResolvedValue({ message: 'AWS EBS volume resize requested.', volume: { id: 'vol-123', name: 'data', sizeGb: '40', status: 'modifying', region: 'us-east-1', providerType: 'ebsVolume', resourceType: 'ebsVolume' } });
    vi.mocked(createAwsSnapshot).mockResolvedValue({ message: 'AWS EBS snapshot creation requested.', snapshot: { id: 'snap-new', name: 'data-new', status: 'pending', region: 'us-east-1', providerType: 'ebsSnapshot', resourceType: 'ebsSnapshot' } });
    vi.mocked(deleteAwsSnapshot).mockResolvedValue({ message: 'AWS EBS snapshot deleted.', snapshot: { id: 'snap-123', name: 'snap-123', region: 'us-east-1' } });
    vi.mocked(deleteAwsVolume).mockResolvedValue({ message: 'AWS EBS volume deletion requested.', volume: { id: 'vol-123', name: 'vol-123', region: 'us-east-1' } });
    vi.mocked(createAwsBucket).mockResolvedValue({ message: 'AWS S3 bucket created.', bucket: { id: 'new-bucket', name: 'new-bucket', region: 'us-east-1', providerType: 's3Bucket', resourceType: 's3Bucket' } });
    vi.mocked(updateAwsBucketVersioning).mockResolvedValue({ message: 'AWS S3 bucket versioning enabled.', bucket: { id: 'prod-bucket', name: 'prod-bucket', region: 'us-east-1', versioning: 'Enabled' } });
    vi.mocked(deleteAwsBucket).mockResolvedValue({ message: 'AWS S3 bucket deleted.', bucket: { id: 'prod-bucket', name: 'prod-bucket', region: 'us-east-1' } });
    vi.mocked(listAwsBucketObjects).mockResolvedValue({ generatedAt: '2026-05-15T00:00:00.000Z', bucketName: 'prod-bucket', region: 'us-east-1', prefix: '', truncated: false, objects: [{ id: 'readme.txt', key: 'readme.txt', name: 'readme.txt', sizeBytes: '12', region: 'us-east-1' }] });
    vi.mocked(getAwsBucketObject).mockResolvedValue({ generatedAt: '2026-05-15T00:00:00.000Z', bucketName: 'prod-bucket', region: 'us-east-1', object: { id: 'readme.txt', key: 'readme.txt', name: 'readme.txt', sizeBytes: '12', content: 'hello', region: 'us-east-1' } });
    vi.mocked(putAwsBucketObject).mockResolvedValue({ message: 'AWS S3 object saved.', object: { id: 'readme.txt', key: 'readme.txt', name: 'readme.txt', bucketName: 'prod-bucket', region: 'us-east-1' } });
    vi.mocked(deleteAwsBucketObject).mockResolvedValue({ message: 'AWS S3 object deleted.', object: { id: 'readme.txt', key: 'readme.txt', name: 'readme.txt', bucketName: 'prod-bucket', region: 'us-east-1' } });

    await agent.post('/api/aws/volumes').send({ region: 'us-east-1', availabilityZone: 'us-east-1a', sizeGb: 20, name: 'new-data' }).expect(202);
    await agent.put('/api/aws/volumes/vol-123/size').send({ region: 'us-east-1', sizeGb: 40 }).expect(202);
    await agent.post('/api/aws/volumes/vol-123/snapshots').send({ region: 'us-east-1', name: 'data-new' }).expect(202);
    await agent.delete('/api/aws/snapshots/snap-123').send({ region: 'us-east-1', confirmation: 'snap-123' }).expect(200);
    await agent.delete('/api/aws/volumes/vol-123').send({ region: 'us-east-1', confirmation: 'vol-123' }).expect(202);
    await agent.post('/api/aws/buckets').send({ region: 'us-east-1', bucketName: 'new-bucket' }).expect(201);
    await agent.put('/api/aws/buckets/prod-bucket/versioning').send({ region: 'us-east-1', enabled: true }).expect(200);
    await agent.get('/api/aws/buckets/prod-bucket/objects?region=us-east-1').expect(200);
    await agent.get('/api/aws/buckets/prod-bucket/object?region=us-east-1&key=readme.txt').expect(200);
    await agent.put('/api/aws/buckets/prod-bucket/objects').send({ region: 'us-east-1', key: 'readme.txt', content: 'hello' }).expect(201);
    await agent.delete('/api/aws/buckets/prod-bucket/objects').send({ region: 'us-east-1', key: 'readme.txt', confirmation: 'readme.txt' }).expect(200);
    await agent.delete('/api/aws/buckets/prod-bucket').send({ region: 'us-east-1', confirmation: 'prod-bucket' }).expect(200);

    expect(createAwsVolume).toHaveBeenCalledTimes(1);
    expect(resizeAwsVolume).toHaveBeenCalledTimes(1);
    expect(createAwsSnapshot).toHaveBeenCalledTimes(1);
    expect(deleteAwsSnapshot).toHaveBeenCalledTimes(1);
    expect(deleteAwsVolume).toHaveBeenCalledTimes(1);
    expect(createAwsBucket).toHaveBeenCalledTimes(1);
    expect(updateAwsBucketVersioning).toHaveBeenCalledTimes(1);
    expect(listAwsBucketObjects).toHaveBeenCalledTimes(1);
    expect(getAwsBucketObject).toHaveBeenCalledTimes(1);
    expect(putAwsBucketObject).toHaveBeenCalledTimes(1);
    expect(deleteAwsBucketObject).toHaveBeenCalledTimes(1);
    expect(deleteAwsBucket).toHaveBeenCalledTimes(1);
  });

  it('submits AWS network operations, updates cache, and returns a VPC relationship map', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    await setCachedAwsInventory(created.body.connector.id, 'us-east-1', {
      generatedAt: '2026-05-15T00:00:00.000Z',
      cached: false,
      connector: { id: created.body.connector.id, name: 'Production AWS', region: 'us-east-1', accountId: '123456789012' },
      scan: { requestedRegion: 'us-east-1', scannedRegions: ['us-east-1'] },
      summary: { regions: 1, vpcs: 1, subnets: 1, securityGroups: 1, routeTables: 1, internetGateways: 1, natGateways: 0 },
      regions: [],
      instances: [{ id: 'i-123', name: 'web', status: 'running', region: 'us-east-1', vpcId: 'vpc-123', subnetId: 'subnet-123' }],
      vpcs: [{ id: 'vpc-123', name: 'prod-vpc', status: 'available', region: 'us-east-1', cidrBlock: '10.0.0.0/16', providerType: 'vpc', resourceType: 'vpc' }],
      subnets: [{ id: 'subnet-123', name: 'app-subnet', status: 'available', region: 'us-east-1', vpcId: 'vpc-123', cidrBlock: '10.0.1.0/24', providerType: 'subnet', resourceType: 'subnet' }],
      securityGroups: [{ id: 'sg-123', name: 'web-sg', status: 'available', region: 'us-east-1', vpcId: 'vpc-123', providerType: 'securityGroup', resourceType: 'securityGroup' }],
      routeTables: [{ id: 'rtb-123', name: 'main', status: 'available', region: 'us-east-1', vpcId: 'vpc-123', routes: [{ destination: '0.0.0.0/0', target: 'igw-123' }], providerType: 'routeTable', resourceType: 'routeTable' }],
      internetGateways: [{ id: 'igw-123', name: 'igw', status: 'attached', region: 'us-east-1', vpcId: 'vpc-123', providerType: 'internetGateway', resourceType: 'internetGateway' }],
      natGateways: [],
      ebsVolumes: [],
      ebsSnapshots: [],
      s3Buckets: [],
      rdsDatabases: [],
      loadBalancers: [],
      elasticIps: [{ id: 'eipalloc-123', name: '203.0.113.10', region: 'us-east-1' }],
      iamSummary: {},
      errors: [],
    });
    vi.mocked(createAwsVpc).mockResolvedValue({ message: 'AWS VPC creation requested.', vpc: { id: 'vpc-new', name: 'new-vpc', status: 'pending', region: 'us-east-1', providerType: 'vpc', resourceType: 'vpc' } });
    vi.mocked(createAwsSubnet).mockResolvedValue({ message: 'AWS subnet creation requested.', subnet: { id: 'subnet-new', name: 'new-subnet', status: 'pending', region: 'us-east-1', vpcId: 'vpc-123', providerType: 'subnet', resourceType: 'subnet' } });
    vi.mocked(createAwsRouteTable).mockResolvedValue({ message: 'AWS route table creation requested.', routeTable: { id: 'rtb-new', name: 'new-rtb', region: 'us-east-1', vpcId: 'vpc-123', providerType: 'routeTable', resourceType: 'routeTable' } });
    vi.mocked(createAwsInternetGateway).mockResolvedValue({ message: 'AWS internet gateway created and attached.', internetGateway: { id: 'igw-new', name: 'new-igw', region: 'us-east-1', vpcId: 'vpc-123', providerType: 'internetGateway', resourceType: 'internetGateway' } });
    vi.mocked(createAwsNatGateway).mockResolvedValue({ message: 'AWS NAT gateway creation requested.', natGateway: { id: 'nat-new', name: 'new-nat', region: 'us-east-1', subnetId: 'subnet-123', vpcId: 'vpc-123', providerType: 'natGateway', resourceType: 'natGateway' } });
    vi.mocked(updateAwsSecurityGroupRule).mockResolvedValue({ message: 'AWS security group rule added.', securityGroup: { id: 'sg-123', name: 'sg-123', region: 'us-east-1', providerType: 'securityGroup', resourceType: 'securityGroup' } });
    vi.mocked(deleteAwsSubnet).mockResolvedValue({ message: 'AWS subnet deletion requested.', subnet: { id: 'subnet-123', name: 'subnet-123', region: 'us-east-1', providerType: 'subnet', resourceType: 'subnet' } });
    vi.mocked(describeAwsRouteTable).mockResolvedValue({ id: 'rtb-123', name: 'main', status: 'available', region: 'us-east-1', vpcId: 'vpc-123', routes: [{ destination: '0.0.0.0/0', target: 'igw-123', state: 'active', origin: 'CreateRoute' }], associations: [{ id: 'rtbassoc-123', subnetId: 'subnet-123', main: false, state: 'associated' }], providerType: 'routeTable', resourceType: 'routeTable' });

    await agent.post('/api/aws/vpcs').send({ region: 'us-east-1', name: 'new-vpc', cidrBlock: '10.1.0.0/16' }).expect(202);
    await agent.post('/api/aws/subnets').send({ region: 'us-east-1', name: 'new-subnet', vpcId: 'vpc-123', cidrBlock: '10.0.2.0/24' }).expect(202);
    await agent.post('/api/aws/route-tables').send({ region: 'us-east-1', name: 'new-rtb', vpcId: 'vpc-123' }).expect(202);
    await agent.post('/api/aws/internet-gateways').send({ region: 'us-east-1', name: 'new-igw', vpcId: 'vpc-123' }).expect(202);
    await agent.post('/api/aws/nat-gateways').send({ region: 'us-east-1', name: 'new-nat', subnetId: 'subnet-123', allocationId: 'eipalloc-123' }).expect(202);
    await agent.post('/api/aws/security-groups/sg-123/rules').send({ region: 'us-east-1', operation: 'authorize', direction: 'ingress', protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '10.0.0.0/16' }).expect(202);
    const routeDetail = await agent.get('/api/aws/route-tables/rtb-123?region=us-east-1').expect(200);
    expect(routeDetail.body.data.routeTable.routes[0].target).toBe('igw-123');

    const map = await agent.get('/api/aws/network-map?region=us-east-1&vpcId=vpc-123').expect(200);
    expect(map.body.data.nodes.some((node) => node.id === 'vpc-123')).toBe(true);
    expect(map.body.data.edges.some((edge) => edge.to === 'vpc-123')).toBe(true);

    await agent.delete('/api/aws/subnets/subnet-123').send({ region: 'us-east-1', resourceName: 'app-subnet', confirmation: 'app-subnet' }).expect(202);
    const cached = await agent.get('/api/aws/inventory?region=us-east-1').expect(200);
    expect(cached.body.data.subnets.some((subnet) => subnet.id === 'subnet-123')).toBe(false);
    expect(createAwsVpc).toHaveBeenCalledTimes(1);
    expect(createAwsSubnet).toHaveBeenCalledTimes(1);
    expect(createAwsRouteTable).toHaveBeenCalledTimes(1);
    expect(createAwsInternetGateway).toHaveBeenCalledTimes(1);
    expect(createAwsNatGateway).toHaveBeenCalledTimes(1);
    expect(updateAwsSecurityGroupRule).toHaveBeenCalledTimes(1);
    expect(deleteAwsSubnet).toHaveBeenCalledTimes(1);
  });

  it('submits AWS RDS operations, enforces delete confirmation, and updates cached inventory', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    await setCachedAwsInventory(created.body.connector.id, 'us-east-1', {
      generatedAt: '2026-05-15T00:00:00.000Z',
      cached: false,
      connector: { id: created.body.connector.id, name: 'Production AWS', region: 'us-east-1', accountId: '123456789012' },
      scan: { requestedRegion: 'us-east-1', scannedRegions: ['us-east-1'] },
      summary: { regions: 1, rdsDatabases: 1 },
      regions: [],
      instances: [],
      vpcs: [],
      subnets: [],
      securityGroups: [],
      routeTables: [],
      internetGateways: [],
      natGateways: [],
      ebsVolumes: [],
      ebsSnapshots: [],
      s3Buckets: [],
      rdsDatabases: [{ id: 'orders-db', name: 'orders-db', status: 'available', region: 'us-east-1', engine: 'postgres', dbVersion: '16.1', storageSizeGb: 100, endpoint: 'orders-db.abc.us-east-1.rds.amazonaws.com' }],
      loadBalancers: [],
      elasticIps: [],
      iamSummary: {},
      errors: [],
    });

    vi.mocked(createAwsRdsInstance).mockResolvedValue({ message: 'AWS RDS DB instance creation requested.', database: { id: 'new-db', name: 'new-db', status: 'creating', region: 'us-east-1', engine: 'postgres', providerType: 'rdsDatabase', resourceType: 'rdsDatabase' } });
    vi.mocked(runAwsRdsInstanceAction).mockResolvedValue({ message: 'AWS RDS DB instance stop requested.', database: { id: 'orders-db', name: 'orders-db', status: 'stopping', region: 'us-east-1', providerType: 'rdsDatabase', resourceType: 'rdsDatabase' } });
    vi.mocked(createAwsRdsSnapshot).mockResolvedValue({ message: 'AWS RDS snapshot creation requested.', snapshot: { id: 'orders-db-snap', name: 'orders-db-snap', status: 'creating', region: 'us-east-1', providerType: 'rdsSnapshot', resourceType: 'rdsSnapshot' } });
    vi.mocked(listAwsRdsSnapshots).mockResolvedValue({ generatedAt: '2026-05-15T00:10:00.000Z', region: 'us-east-1', snapshots: [{ id: 'orders-db-snap', name: 'orders-db-snap', status: 'available', region: 'us-east-1' }] });
    vi.mocked(deleteAwsRdsSnapshot).mockResolvedValue({ message: 'AWS RDS snapshot deletion requested.', snapshot: { id: 'orders-db-snap', name: 'orders-db-snap', status: 'deleting', region: 'us-east-1', providerType: 'rdsSnapshot', resourceType: 'rdsSnapshot' } });
    vi.mocked(restoreAwsRdsInstanceFromSnapshot).mockResolvedValue({ message: 'AWS RDS DB instance restore requested.', database: { id: 'orders-db-restored', name: 'orders-db-restored', status: 'creating', region: 'us-east-1', providerType: 'rdsDatabase', resourceType: 'rdsDatabase' } });
    vi.mocked(describeAwsRdsInstance).mockResolvedValue({ id: 'orders-db', name: 'orders-db', status: 'stopped', region: 'us-east-1', endpoint: 'orders-db.abc.us-east-1.rds.amazonaws.com', providerType: 'rdsDatabase', resourceType: 'rdsDatabase' });
    vi.mocked(deleteAwsRdsInstance).mockResolvedValue({ message: 'AWS RDS DB instance deletion requested.', database: { id: 'orders-db', name: 'orders-db', status: 'deleting', region: 'us-east-1', providerType: 'rdsDatabase', resourceType: 'rdsDatabase' } });

    await agent.post('/api/aws/rds/instances').send({
      region: 'us-east-1',
      dbInstanceIdentifier: 'new-db',
      engine: 'postgres',
      dbInstanceClass: 'db.t3.micro',
      allocatedStorage: 20,
      masterUsername: 'admin',
      masterUserPassword: 'secret-password',
      backupRetentionPeriod: 0,
    }).expect(202);
    await agent.post('/api/aws/rds/instances/orders-db/actions/stop').send({ region: 'us-east-1', dbInstanceName: 'orders-db' }).expect(202);
    await agent.post('/api/aws/rds/instances/orders-db/snapshots').send({ region: 'us-east-1', snapshotIdentifier: 'orders-db-snap' }).expect(202);
    const snapshots = await agent.get('/api/aws/rds/snapshots?region=us-east-1&dbInstanceIdentifier=orders-db').expect(200);
    expect(snapshots.body.data.snapshots[0].id).toBe('orders-db-snap');
    await agent.delete('/api/aws/rds/snapshots/orders-db-snap').send({ region: 'us-east-1', snapshotName: 'orders-db-snap', confirmation: 'wrong' }).expect(400);
    await agent.delete('/api/aws/rds/snapshots/orders-db-snap').send({ region: 'us-east-1', snapshotName: 'orders-db-snap', confirmation: 'orders-db-snap' }).expect(202);
    await agent.post('/api/aws/rds/restore').send({ region: 'us-east-1', snapshotIdentifier: 'orders-db-snap', dbInstanceIdentifier: 'orders-db-restored' }).expect(202);
    const status = await agent.get('/api/aws/rds/instances/orders-db?region=us-east-1&scanRegion=us-east-1').expect(200);
    expect(status.body.data.database.status).toBe('stopped');
    await agent.delete('/api/aws/rds/instances/orders-db').send({ region: 'us-east-1', dbInstanceName: 'orders-db', confirmation: 'wrong' }).expect(400);
    await agent.delete('/api/aws/rds/instances/orders-db').send({ region: 'us-east-1', dbInstanceName: 'orders-db', confirmation: 'orders-db' }).expect(202);

    const cached = await agent.get('/api/aws/inventory?region=us-east-1').expect(200);
    expect(cached.body.data.rdsDatabases.some((database) => database.id === 'orders-db')).toBe(false);
    expect(cached.body.data.rdsDatabases.some((database) => database.id === 'new-db')).toBe(true);
    expect(cached.body.data.rdsDatabases.some((database) => database.id === 'orders-db-restored')).toBe(true);
    expect(createAwsRdsInstance).toHaveBeenCalledTimes(1);
    expect(createAwsRdsInstance).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ backupRetentionPeriod: 0, dbInstanceIdentifier: 'new-db', region: 'us-east-1' }));
    expect(runAwsRdsInstanceAction).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ action: 'stop', dbInstanceIdentifier: 'orders-db', region: 'us-east-1' }));
    expect(createAwsRdsSnapshot).toHaveBeenCalledTimes(1);
    expect(deleteAwsRdsSnapshot).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ snapshotIdentifier: 'orders-db-snap', region: 'us-east-1' }));
    expect(restoreAwsRdsInstanceFromSnapshot).toHaveBeenCalledTimes(1);
    expect(deleteAwsRdsInstance).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cached.body)).not.toContain('secret-password');
  });

  it('refreshes EC2 instance status and updates cached inventory', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    await markAwsConnectorVerified(created.body.connector.id);
    await setCachedAwsInventory(created.body.connector.id, 'us-east-1', {
      generatedAt: '2026-05-15T00:00:00.000Z',
      cached: false,
      connector: { id: created.body.connector.id, name: 'Production AWS', region: 'us-east-1', accountId: '123456789012' },
      scan: { requestedRegion: 'us-east-1', scannedRegions: ['us-east-1'] },
      summary: { regions: 1, instances: 1 },
      regions: [],
      instances: [{ id: 'i-123', name: 'aws-web-1', status: 'pending', region: 'us-east-1' }],
      vpcs: [],
      subnets: [],
      securityGroups: [],
      routeTables: [],
      internetGateways: [],
      natGateways: [],
      ebsVolumes: [],
      ebsSnapshots: [],
      s3Buckets: [],
      rdsDatabases: [],
      loadBalancers: [],
      elasticIps: [],
      iamSummary: {},
      errors: [],
    });
    vi.mocked(describeAwsInstance).mockResolvedValue({
      id: 'i-123',
      name: 'aws-web-1',
      status: 'running',
      region: 'us-east-1',
      providerType: 'ec2Instance',
      resourceType: 'ec2Instance',
    });

    const response = await agent.get('/api/aws/instances/i-123/status?region=us-east-1&scanRegion=us-east-1').expect(200);
    expect(response.body.data.instance.status).toBe('running');
    expect(describeAwsInstance).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ region: 'us-east-1', instanceId: 'i-123' }));

    const cached = await agent.get('/api/aws/inventory?region=us-east-1').expect(200);
    expect(cached.body.data.instances[0].status).toBe('running');
  });
});
