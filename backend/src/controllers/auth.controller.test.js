import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../app.js';

describe('auth controller', () => {
  let dataDir;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'pm-auth-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'secret-password';
    delete process.env.ADMIN_PASSWORD_HASH;
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.COOKIE_SECURE = 'false';
    process.env.CORS_ORIGIN = 'http://localhost:5173';
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('logs in with valid credentials and sets an httpOnly cookie', async () => {
    const app = createServer();

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'secret-password' });

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({ username: 'admin', roles: ['admin'] });
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'login',
      status: 'succeeded',
      user: 'admin',
    });
  });

  it('rejects invalid credentials', async () => {
    const app = createServer();

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong' });

    expect(response.status).toBe(401);
    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'login',
      status: 'failed',
      user: 'admin',
    });
  });

  it('protects authenticated routes', async () => {
    const app = createServer();

    await request(app).get('/api/auth/me').expect(401);
  });

  it('sets secure response headers and request ids', async () => {
    const app = createServer();

    const response = await request(app).get('/api/health').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns the current user after login and clears session on logout', async () => {
    const app = createServer();
    const agent = request.agent(app);

    await agent
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'secret-password' })
      .expect(200);

    const meResponse = await agent.get('/api/auth/me').expect(200);
    expect(meResponse.body.user.username).toBe('admin');

    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);

    const audit = JSON.parse(await readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    expect(audit.at(-1)).toMatchObject({
      action: 'logout',
      status: 'succeeded',
      user: 'admin',
    });
  });
});
