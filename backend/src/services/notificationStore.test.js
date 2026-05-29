import { mkdtemp, rm, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHealthNotifications,
  createNotification,
  getNotificationSettings,
  listNotifications,
  markNotificationRead,
  notificationSummary,
  updateNotificationSettings,
} from './notificationStore.js';

let dataDir;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'pm-notifications-'));
  process.env.DATA_DIR = dataDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.ENCRYPTION_KEY;
});

describe('notification store', () => {
  it('creates, deduplicates, summarizes, and marks notifications read', async () => {
    await createNotification({
      type: 'node-offline',
      severity: 'critical',
      title: 'Node pve is offline',
      message: 'Node status is offline.',
      node: 'pve',
      dedupeKey: 'node:pve',
    });
    await createNotification({
      type: 'node-offline',
      severity: 'critical',
      title: 'Node pve is still offline',
      message: 'Node status is offline.',
      node: 'pve',
      dedupeKey: 'node:pve',
    });

    const notifications = await listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Node pve is still offline');
    expect(await notificationSummary()).toMatchObject({ total: 1, unread: 1, critical: 1 });

    await markNotificationRead(notifications[0].id);
    expect(await notificationSummary()).toMatchObject({ total: 1, unread: 0, critical: 0 });
  });

  it('stores delivery secrets encrypted and returns only masked previews', async () => {
    const settings = await updateNotificationSettings({
      enabled: true,
      minSeverity: 'warning',
      slack: { enabled: true, webhookUrl: 'https://hooks.slack.test/secret-value' },
      teams: { enabled: true, webhookUrl: 'https://teams.test/secret-value' },
      genericWebhook: { enabled: true, webhookUrl: 'https://generic.test/secret-value' },
      email: {
        enabled: true,
        to: 'ops@example.com',
        from: 'proxmox@example.com',
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: 'smtp-user',
        password: 'smtp-secret',
      },
      resourceAlerts: {
        enabled: true,
        cpu: { warning: 75, critical: 90 },
        memory: { warning: 80, critical: 95 },
        storage: { warning: 70, critical: 90 },
      },
    });

    expect(settings.slack.webhookPreview).toBe('**** -value');
    expect(settings.email.passwordPreview).toBe('**** secret');
    expect(settings.resourceAlerts.storage).toEqual({ warning: 70, critical: 90 });
    expect(JSON.stringify(await getNotificationSettings())).not.toContain('secret-value');

    const raw = await readFile(path.join(dataDir, 'notification-settings.json'), 'utf8');
    expect(raw).not.toContain('secret-value');
    expect(raw).not.toContain('smtp-secret');
  });

  it('creates resource threshold notifications for CPU, memory, storage, and offline nodes', async () => {
    await updateNotificationSettings({
      enabled: true,
      minSeverity: 'warning',
      resourceAlerts: {
        enabled: true,
        cpu: { warning: 80, critical: 90 },
        memory: { warning: 80, critical: 90 },
        storage: { warning: 80, critical: 90 },
      },
    });

    await createHealthNotifications({
      connectorId: 'connector-1',
      dashboard: {
        resources: {
          nodes: [{ node: 'pve', status: 'offline', cpu: 0.82, mem: 95, maxmem: 100 }],
          storage: [{ node: 'pve', storage: 'local', disk: 91, maxdisk: 100 }],
        },
      },
    });

    const notifications = await listNotifications();
    expect(notifications.map((item) => item.type).sort()).toEqual([
      'cpu-threshold',
      'memory-threshold',
      'node-offline',
      'storage-threshold',
    ]);
    expect(notifications.find((item) => item.type === 'storage-threshold')).toMatchObject({
      severity: 'critical',
      source: 'resource-alert',
    });
  });
});
