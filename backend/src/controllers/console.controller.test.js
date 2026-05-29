import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir;

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'secret-password' })
    .expect(200);
  return agent;
}

async function markSelectedConnectorVerified() {
  const storePath = path.join(dataDir, 'proxmox-connectors.json');
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  store.connectors[0].status = 'verified';
  store.connectors[0].verificationMessage = 'Connection verified.';
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');
}

describe('console controller', () => {
  beforeEach(async () => {
    vi.resetModules();
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'pm-console-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENCRYPTION_KEY = 'test-encryption-key-that-is-long-enough';
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'secret-password';
    delete process.env.ADMIN_PASSWORD_HASH;
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.COOKIE_SECURE = 'false';

    vi.doMock('../services/proxmoxApiClient.js', async () => {
      const actual = await vi.importActual('../services/proxmoxApiClient.js');
      return {
        ...actual,
        createProxmoxApiClient: vi.fn(() => ({
          createConsoleSession: vi.fn().mockResolvedValue({
            session: {
              port: 5901,
              ticket: 'PVEVNC:ticket-value',
            },
            websocketUrl: 'wss://pve.example.local/api2/json/nodes/pve/qemu/100/vncwebsocket',
            headers: { Authorization: 'PVEAPIToken=root@pam!automation=super-secret-token' },
            rejectUnauthorized: true,
          }),
        })),
      };
    });
  });

  afterEach(async () => {
    vi.doUnmock('../services/proxmoxApiClient.js');
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('creates a short-lived app console session without returning Proxmox tickets or credentials', async () => {
    const { createServer } = await import('../app.js');
    const app = createServer();
    const agent = await loginAgent(app);

    await agent
      .post('/api/connectors')
      .send({
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
        notes: '',
      })
      .expect(201);
    await markSelectedConnectorVerified();

    const response = await agent.post('/api/proxmox/resources/qemu/pve/100/console').expect(200);
    const raw = JSON.stringify(response.body);

    expect(response.body.data.sessionId).toBeTruthy();
    expect(response.body.data.websocketPath).toMatch(/^\/api\/proxmox\/console\//);
    expect(response.body.data.expiresAt).toBeTruthy();
    expect(raw).not.toContain('PVEVNC:ticket-value');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('PVEAPIToken');
  });
});
