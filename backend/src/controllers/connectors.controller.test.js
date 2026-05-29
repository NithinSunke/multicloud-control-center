import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../app.js';

let dataDir;

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'secret-password' })
    .expect(200);
  return agent;
}

function connectorPayload(overrides = {}) {
  return {
    name: 'Lab Cluster',
    host: 'https://pve.example.local',
    port: 8006,
    realm: 'pam',
    username: 'root',
    authType: 'apiToken',
    apiTokenId: 'automation',
    apiTokenSecret: 'super-secret-token',
    password: '',
    tlsVerify: true,
    notes: 'primary lab',
    ...overrides,
  };
}

function ociConnectorPayload(overrides = {}) {
  return {
    provider: 'oci',
    name: 'Production OCI',
    tenancyOcid: 'ocid1.tenancy.oc1..aaaa',
    userOcid: 'ocid1.user.oc1..bbbb',
    compartmentOcid: 'ocid1.compartment.oc1..cccc',
    region: 'us-ashburn-1',
    fingerprint: 'aa:bb:cc:dd',
    privateKey: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
    privateKeyPassphrase: '',
    tlsVerify: true,
    notes: 'cloud tenancy',
    ...overrides,
  };
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
    notes: 'cloud account',
    ...overrides,
  };
}

function azureConnectorPayload(overrides = {}) {
  return {
    provider: 'azure',
    name: 'Production Azure',
    azureTenantId: '11111111-1111-1111-1111-111111111111',
    azureSubscriptionId: '22222222-2222-2222-2222-222222222222',
    azureClientId: '33333333-3333-3333-3333-333333333333',
    azureClientSecret: 'azure-client-secret',
    azureCloud: 'public',
    tlsVerify: true,
    notes: 'cloud subscription',
    ...overrides,
  };
}

function gcpConnectorPayload(overrides = {}) {
  return {
    provider: 'gcp',
    name: 'Production GCP',
    gcpProjectId: 'prod-project',
    gcpClientEmail: 'multi-cloud-manager@prod-project.iam.gserviceaccount.com',
    gcpOrganizationId: '1234567890',
    gcpBillingAccountId: '000000-111111-222222',
    privateKey: '-----BEGIN PRIVATE KEY-----\nnot-a-real-gcp-key\n-----END PRIVATE KEY-----',
    tlsVerify: true,
    notes: 'cloud project',
    ...overrides,
  };
}

describe('connectors controller', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'pm-connectors-'));
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

  it('requires authentication', async () => {
    const app = createServer();

    await request(app).get('/api/connectors').expect(401);
  });

  it('creates a connector, masks secrets, and stores secrets encrypted', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const response = await agent.post('/api/connectors').send(connectorPayload()).expect(201);

    expect(response.body.connector.secretPreview).toBe('**** oken');
    expect(response.body.connector.apiTokenSecret).toBeUndefined();
    expect(response.body.connector.password).toBeUndefined();
    expect(response.body.connector.selected).toBe(true);

    const rawStore = await readFile(path.join(dataDir, 'proxmox-connectors.json'), 'utf8');
    expect(rawStore).not.toContain('super-secret-token');

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'connector-create',
      status: 'succeeded',
      connectorName: 'Lab Cluster',
    });
    expect(JSON.stringify(audit)).not.toContain('super-secret-token');
  });

  it('creates OCI connectors without returning or logging private keys', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const response = await agent.post('/api/connectors').send(ociConnectorPayload()).expect(201);

    expect(response.body.connector).toMatchObject({
      provider: 'oci',
      name: 'Production OCI',
      region: 'us-ashburn-1',
      fingerprint: 'aa:bb:cc:dd',
      selected: true,
      secretStored: true,
    });
    expect(response.body.connector.privateKey).toBeUndefined();
    expect(response.body.connector.privateKeyPassphrase).toBeUndefined();

    const rawStore = await readFile(path.join(dataDir, 'proxmox-connectors.json'), 'utf8');
    expect(rawStore).not.toContain('not-a-real-key');

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'connector-create',
      provider: 'oci',
      connectorName: 'Production OCI',
    });
    expect(JSON.stringify(audit)).not.toContain('not-a-real-key');
  });

  it('creates AWS connectors without returning or logging access secrets', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const response = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);

    expect(response.body.connector).toMatchObject({
      provider: 'aws',
      name: 'Production AWS',
      region: 'us-east-1',
      awsAccountId: '123456789012',
      awsAccessKeyId: 'AKIATESTKEY123456',
      selected: true,
      secretStored: true,
    });
    expect(response.body.connector.awsSecretAccessKey).toBeUndefined();
    expect(response.body.connector.awsSessionToken).toBeUndefined();

    const rawStore = await readFile(path.join(dataDir, 'proxmox-connectors.json'), 'utf8');
    expect(rawStore).not.toContain('aws-secret-access-key');

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'connector-create',
      provider: 'aws',
      connectorName: 'Production AWS',
    });
    expect(JSON.stringify(audit)).not.toContain('aws-secret-access-key');
  });

  it('creates Azure connectors without returning or logging client secrets', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const response = await agent.post('/api/connectors').send(azureConnectorPayload()).expect(201);

    expect(response.body.connector).toMatchObject({
      provider: 'azure',
      name: 'Production Azure',
      azureTenantId: '11111111-1111-1111-1111-111111111111',
      azureSubscriptionId: '22222222-2222-2222-2222-222222222222',
      azureClientId: '33333333-3333-3333-3333-333333333333',
      azureCloud: 'public',
      selected: true,
      secretStored: true,
    });
    expect(response.body.connector.azureClientSecret).toBeUndefined();

    const rawStore = await readFile(path.join(dataDir, 'proxmox-connectors.json'), 'utf8');
    expect(rawStore).not.toContain('azure-client-secret');

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'connector-create',
      provider: 'azure',
      connectorName: 'Production Azure',
    });
    expect(JSON.stringify(audit)).not.toContain('azure-client-secret');
  });

  it('creates GCP connectors without returning or logging private keys', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const response = await agent.post('/api/connectors').send(gcpConnectorPayload()).expect(201);

    expect(response.body.connector).toMatchObject({
      provider: 'gcp',
      name: 'Production GCP',
      gcpProjectId: 'prod-project',
      gcpClientEmail: 'multi-cloud-manager@prod-project.iam.gserviceaccount.com',
      gcpOrganizationId: '1234567890',
      gcpBillingAccountId: '000000-111111-222222',
      selected: true,
      secretStored: true,
    });
    expect(response.body.connector.privateKey).toBeUndefined();

    const rawStore = await readFile(path.join(dataDir, 'proxmox-connectors.json'), 'utf8');
    expect(rawStore).not.toContain('not-a-real-gcp-key');

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'connector-create',
      provider: 'gcp',
      connectorName: 'Production GCP',
    });
    expect(JSON.stringify(audit)).not.toContain('not-a-real-gcp-key');
  });

  it('supports list, update, select, and delete', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const first = await agent.post('/api/connectors').send(connectorPayload({ name: 'First' })).expect(201);
    const second = await agent
      .post('/api/connectors')
      .send(connectorPayload({ name: 'Second', apiTokenSecret: 'another-secret' }))
      .expect(201);

    await agent
      .put(`/api/connectors/${first.body.connector.id}`)
      .send(connectorPayload({ name: 'Updated First', apiTokenSecret: '' }))
      .expect(200);

    const selected = await agent.post(`/api/connectors/${second.body.connector.id}/select`).expect(200);
    expect(selected.body.connector.selected).toBe(true);

    const list = await agent.get('/api/connectors').expect(200);
    expect(list.body.connectors).toHaveLength(2);
    expect(list.body.selectedConnectorId).toBe(second.body.connector.id);

    await agent.delete(`/api/connectors/${first.body.connector.id}`).send({ confirmation: 'Updated First' }).expect(204);
    const afterDelete = await agent.get('/api/connectors').expect(200);
    expect(afterDelete.body.connectors).toHaveLength(1);

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      'connector-create',
      'connector-update',
      'connector-delete',
    ]));
  });

  it('records verification failures without returning raw secrets', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent
      .post('/api/connectors')
      .send(connectorPayload({ host: 'https://example.invalid' }))
      .expect(201);

    const response = await agent.post(`/api/connectors/${created.body.connector.id}/verify`).expect(200);

    expect(response.body.connector.status).toBe('error');
    expect(response.body.connector.lastVerifiedAt).toBeTruthy();
    expect(response.body.connector.apiTokenSecret).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('super-secret-token');

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'connector-verify',
      status: 'failed',
    });
    expect(JSON.stringify(audit)).not.toContain('super-secret-token');
  });

  it('records OCI verification failures without returning raw private keys', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(ociConnectorPayload()).expect(201);
    const response = await agent.post(`/api/connectors/${created.body.connector.id}/verify`).expect(200);

    expect(response.body.connector.status).toBe('error');
    expect(response.body.connector.verificationMessage).toBeTruthy();
    expect(response.body.connector.privateKey).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('not-a-real-key');
  });

  it('records AWS verification failures without returning raw access secrets', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(awsConnectorPayload()).expect(201);
    const response = await agent.post(`/api/connectors/${created.body.connector.id}/verify`).expect(200);

    expect(response.body.connector.status).toBe('error');
    expect(response.body.connector.verificationMessage).toBeTruthy();
    expect(response.body.connector.awsSecretAccessKey).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('aws-secret-access-key');
  });

  it('records Azure verification failures without returning raw client secrets', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(azureConnectorPayload()).expect(201);
    const response = await agent.post(`/api/connectors/${created.body.connector.id}/verify`).expect(200);

    expect(response.body.connector.status).toBe('error');
    expect(response.body.connector.verificationMessage).toBeTruthy();
    expect(response.body.connector.azureClientSecret).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('azure-client-secret');
  });

  it('records GCP verification failures without returning raw private keys', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent.post('/api/connectors').send(gcpConnectorPayload()).expect(201);
    const response = await agent.post(`/api/connectors/${created.body.connector.id}/verify`).expect(200);

    expect(response.body.connector.status).toBe('error');
    expect(response.body.connector.verificationMessage).toBeTruthy();
    expect(response.body.connector.privateKey).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('not-a-real-gcp-key');
  });

  it('verifies password connectors through Proxmox login instead of a placeholder', async () => {
    const app = createServer();
    const agent = await loginAgent(app);

    const created = await agent
      .post('/api/connectors')
      .send(
        connectorPayload({
          authType: 'password',
          apiTokenId: '',
          apiTokenSecret: '',
          password: 'password-secret',
          host: 'https://example.invalid',
        }),
      )
      .expect(201);

    const response = await agent.post(`/api/connectors/${created.body.connector.id}/verify`).expect(200);

    expect(response.body.connector.status).toBe('error');
    expect(response.body.connector.verificationMessage).not.toContain('Phase');
    expect(response.body.connector.password).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('password-secret');
  });
});
