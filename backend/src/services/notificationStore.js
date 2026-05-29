import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';
import { logger, redactSecrets } from '../utils/logger.js';

const algorithm = 'aes-256-gcm';
const notificationsFileName = 'notifications.json';
const settingsFileName = 'notification-settings.json';
const maxNotifications = 500;
const encryptionSalt = 'multi-cloud-manager-notifications';
const legacyEncryptionSalt = 'proxmox-manager-notifications';

function dataFilePath(fileName) {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), fileName);
}

function encryptionKey(salt = encryptionSalt) {
  const secret = process.env.ENCRYPTION_KEY || 'local-dev-encryption-key';
  return scryptSync(secret, salt, 32);
}

function encrypt(value) {
  if (!value) {
    return null;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    value: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptWithSalt(payload, salt) {
  if (!payload) {
    return '';
  }
  const decipher = createDecipheriv(algorithm, encryptionKey(salt), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.value, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function decrypt(payload) {
  try {
    return decryptWithSalt(payload, encryptionSalt);
  } catch (error) {
    if (legacyEncryptionSalt) {
      return decryptWithSalt(payload, legacyEncryptionSalt);
    }
    throw error;
  }
}

function maskSecret(secret) {
  if (!secret) {
    return '';
  }
  return secret.length <= 8 ? '****' : `**** ${secret.slice(-6)}`;
}

async function readJson(fileName, fallback) {
  try {
    return JSON.parse(await readFile(dataFilePath(fileName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(fileName, value) {
  const target = dataFilePath(fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), 'utf8');
}

function normalizeSeverity(value) {
  return ['info', 'warning', 'critical'].includes(value) ? value : 'info';
}

function normalizeNotification(input) {
  const now = new Date().toISOString();
  return redactSecrets({
    id: input.id || randomUUID(),
    createdAt: input.createdAt || now,
    updatedAt: now,
    type: input.type || 'system',
    severity: normalizeSeverity(input.severity),
    status: input.status || 'unread',
    title: String(input.title || 'Notification'),
    message: String(input.message || ''),
    connectorId: input.connectorId || '',
    node: input.node || '',
    vmid: input.vmid || '',
    resourceType: input.resourceType || '',
    taskId: input.taskId || '',
    source: input.source || 'app',
    dedupeKey: input.dedupeKey || '',
    metadata: input.metadata || {},
  });
}

export async function listNotifications({ limit = 100, status } = {}) {
  const notifications = await readJson(notificationsFileName, []);
  return notifications
    .filter((item) => !status || item.status === status)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, Number(limit || 100));
}

export async function notificationSummary() {
  const notifications = await readJson(notificationsFileName, []);
  const unread = notifications.filter((item) => item.status !== 'read');
  return {
    total: notifications.length,
    unread: unread.length,
    critical: unread.filter((item) => item.severity === 'critical').length,
    warning: unread.filter((item) => item.severity === 'warning').length,
  };
}

export async function createNotification(input) {
  const notifications = await readJson(notificationsFileName, []);
  const normalized = normalizeNotification(input);
  const dedupeIndex = normalized.dedupeKey
    ? notifications.findIndex((item) => item.dedupeKey === normalized.dedupeKey && item.status !== 'read')
    : -1;

  if (dedupeIndex >= 0) {
    notifications[dedupeIndex] = {
      ...notifications[dedupeIndex],
      ...normalized,
      id: notifications[dedupeIndex].id,
      createdAt: notifications[dedupeIndex].createdAt,
      updatedAt: new Date().toISOString(),
      status: 'unread',
    };
  } else {
    notifications.push(normalized);
  }

  await writeJson(notificationsFileName, notifications.slice(-maxNotifications));
  await sendNotification(normalized).catch((error) => {
    logger.warn('notification_delivery_failed', {
      type: normalized.type,
      severity: normalized.severity,
      message: error.message,
    });
  });
  return normalized;
}

export async function markNotificationRead(id, read = true) {
  const notifications = await readJson(notificationsFileName, []);
  const index = notifications.findIndex((item) => item.id === id);
  if (index < 0) {
    const error = new Error('Notification not found.');
    error.statusCode = 404;
    throw error;
  }
  notifications[index] = {
    ...notifications[index],
    status: read ? 'read' : 'unread',
    readAt: read ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(notificationsFileName, notifications);
  return notifications[index];
}

export async function markAllNotificationsRead() {
  const notifications = await readJson(notificationsFileName, []);
  const now = new Date().toISOString();
  const updated = notifications.map((item) => ({
    ...item,
    status: 'read',
    readAt: item.readAt || now,
    updatedAt: now,
  }));
  await writeJson(notificationsFileName, updated);
  return { updated: updated.length };
}

function defaultSettings() {
  return {
    enabled: true,
    minSeverity: 'warning',
    resourceAlerts: {
      enabled: true,
      cpu: { warning: 80, critical: 90 },
      memory: { warning: 80, critical: 90 },
      storage: { warning: 80, critical: 90 },
    },
    email: {
      enabled: false,
      to: '',
      from: '',
      host: '',
      port: 587,
      secure: false,
      username: '',
      encryptedPassword: null,
    },
    slack: { enabled: false, encryptedWebhookUrl: null },
    teams: { enabled: false, encryptedWebhookUrl: null },
    genericWebhook: { enabled: false, encryptedWebhookUrl: null },
  };
}

function publicSettings(settings) {
  return {
    enabled: settings.enabled !== false,
    minSeverity: settings.minSeverity || 'warning',
    resourceAlerts: {
      enabled: settings.resourceAlerts?.enabled !== false,
      cpu: {
        warning: Number(settings.resourceAlerts?.cpu?.warning || 80),
        critical: Number(settings.resourceAlerts?.cpu?.critical || 90),
      },
      memory: {
        warning: Number(settings.resourceAlerts?.memory?.warning || 80),
        critical: Number(settings.resourceAlerts?.memory?.critical || 90),
      },
      storage: {
        warning: Number(settings.resourceAlerts?.storage?.warning || 80),
        critical: Number(settings.resourceAlerts?.storage?.critical || 90),
      },
    },
    email: {
      enabled: settings.email?.enabled === true,
      to: settings.email?.to || '',
      from: settings.email?.from || '',
      host: settings.email?.host || '',
      port: Number(settings.email?.port || 587),
      secure: settings.email?.secure === true,
      username: settings.email?.username || '',
      passwordPreview: maskSecret(decrypt(settings.email?.encryptedPassword)),
    },
    slack: {
      enabled: settings.slack?.enabled === true,
      webhookPreview: maskSecret(decrypt(settings.slack?.encryptedWebhookUrl)),
    },
    teams: {
      enabled: settings.teams?.enabled === true,
      webhookPreview: maskSecret(decrypt(settings.teams?.encryptedWebhookUrl)),
    },
    genericWebhook: {
      enabled: settings.genericWebhook?.enabled === true,
      webhookPreview: maskSecret(decrypt(settings.genericWebhook?.encryptedWebhookUrl)),
    },
  };
}

export async function getNotificationSettings({ includeSecrets = false } = {}) {
  const stored = await readJson(settingsFileName, defaultSettings());
  const settings = {
    ...defaultSettings(),
    ...stored,
    email: { ...defaultSettings().email, ...(stored.email || {}) },
    resourceAlerts: {
      ...defaultSettings().resourceAlerts,
      ...(stored.resourceAlerts || {}),
      cpu: { ...defaultSettings().resourceAlerts.cpu, ...(stored.resourceAlerts?.cpu || {}) },
      memory: { ...defaultSettings().resourceAlerts.memory, ...(stored.resourceAlerts?.memory || {}) },
      storage: { ...defaultSettings().resourceAlerts.storage, ...(stored.resourceAlerts?.storage || {}) },
    },
    slack: { ...defaultSettings().slack, ...(stored.slack || {}) },
    teams: { ...defaultSettings().teams, ...(stored.teams || {}) },
    genericWebhook: { ...defaultSettings().genericWebhook, ...(stored.genericWebhook || {}) },
  };
  return includeSecrets ? settings : publicSettings(settings);
}

export async function updateNotificationSettings(payload) {
  const existing = await getNotificationSettings({ includeSecrets: true });
  const resourceAlerts = normalizeResourceAlertSettings(payload.resourceAlerts || existing.resourceAlerts);
  const next = {
    enabled: payload.enabled !== false,
    minSeverity: ['info', 'warning', 'critical'].includes(payload.minSeverity) ? payload.minSeverity : 'warning',
    resourceAlerts,
    email: {
      ...existing.email,
      enabled: payload.email?.enabled === true,
      to: String(payload.email?.to || '').trim(),
      from: String(payload.email?.from || '').trim(),
      host: String(payload.email?.host || '').trim(),
      port: Number(payload.email?.port || 587),
      secure: payload.email?.secure === true,
      username: String(payload.email?.username || '').trim(),
      encryptedPassword: payload.email?.password
        ? encrypt(String(payload.email.password))
        : existing.email.encryptedPassword,
    },
    slack: {
      enabled: payload.slack?.enabled === true,
      encryptedWebhookUrl: payload.slack?.webhookUrl
        ? encrypt(String(payload.slack.webhookUrl))
        : existing.slack.encryptedWebhookUrl,
    },
    teams: {
      enabled: payload.teams?.enabled === true,
      encryptedWebhookUrl: payload.teams?.webhookUrl
        ? encrypt(String(payload.teams.webhookUrl))
        : existing.teams.encryptedWebhookUrl,
    },
    genericWebhook: {
      enabled: payload.genericWebhook?.enabled === true,
      encryptedWebhookUrl: payload.genericWebhook?.webhookUrl
        ? encrypt(String(payload.genericWebhook.webhookUrl))
        : existing.genericWebhook.encryptedWebhookUrl,
    },
  };
  await writeJson(settingsFileName, next);
  return publicSettings(next);
}

function boundedPercent(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(1, Math.min(100, Math.round(number)));
}

function normalizeThresholdPair(input = {}, fallback = { warning: 80, critical: 90 }) {
  const warning = Math.min(99, boundedPercent(input.warning, fallback.warning));
  const critical = boundedPercent(input.critical, fallback.critical);
  return critical <= warning
    ? { warning, critical: warning + 1 }
    : { warning, critical };
}

function normalizeResourceAlertSettings(input = {}) {
  const defaults = defaultSettings().resourceAlerts;
  return {
    enabled: input.enabled !== false,
    cpu: normalizeThresholdPair(input.cpu, defaults.cpu),
    memory: normalizeThresholdPair(input.memory, defaults.memory),
    storage: normalizeThresholdPair(input.storage, defaults.storage),
  };
}

function severityRank(severity) {
  return { info: 1, warning: 2, critical: 3 }[severity] || 1;
}

function shouldSend(settings, notification) {
  return settings.enabled !== false && severityRank(notification.severity) >= severityRank(settings.minSeverity || 'warning');
}

function outboundText(notification) {
  const target = [
    notification.resourceType ? notification.resourceType.toUpperCase() : '',
    notification.vmid ? notification.vmid : '',
    notification.node ? `on ${notification.node}` : '',
  ].filter(Boolean).join(' ');
  return `${notification.title}\n${notification.message}${target ? `\nTarget: ${target}` : ''}`;
}

async function postWebhook(url, notification, kind) {
  if (!url) {
    return;
  }
  const payload = kind === 'teams'
    ? { text: outboundText(notification) }
    : {
      text: outboundText(notification),
      severity: notification.severity,
      type: notification.type,
      createdAt: notification.createdAt,
    };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`${kind} webhook returned ${response.status}.`);
  }
}

async function sendEmail(settings, notification) {
  const email = settings.email || {};
  if (!email.enabled || !email.host || !email.to || !email.from) {
    return;
  }
  const password = decrypt(email.encryptedPassword);
  const transporter = nodemailer.createTransport({
    host: email.host,
    port: Number(email.port || 587),
    secure: email.secure === true,
    auth: email.username ? { user: email.username, pass: password } : undefined,
  });
  await transporter.sendMail({
    from: email.from,
    to: email.to,
    subject: `[Multi Cloud Manager] ${notification.title}`,
    text: outboundText(notification),
  });
}

export async function sendNotification(notification) {
  const settings = await getNotificationSettings({ includeSecrets: true });
  if (!shouldSend(settings, notification)) {
    return;
  }
  await Promise.allSettled([
    postWebhook(decrypt(settings.slack?.encryptedWebhookUrl), notification, 'slack'),
    postWebhook(decrypt(settings.teams?.encryptedWebhookUrl), notification, 'teams'),
    postWebhook(decrypt(settings.genericWebhook?.encryptedWebhookUrl), notification, 'generic'),
    sendEmail(settings, notification),
  ]);
}

export async function createHealthNotifications({ connectorId = '', dashboard }) {
  const settings = await getNotificationSettings({ includeSecrets: true });
  const created = [];
  for (const node of dashboard?.resources?.nodes || []) {
    if (node.status && node.status !== 'online') {
      created.push(await createNotification({
        type: 'node-offline',
        severity: 'critical',
        title: `Node ${node.node || node.id || 'unknown'} is offline`,
        message: `Node status is ${node.status}. Check cluster health before running operations.`,
        connectorId,
        node: node.node || node.id || '',
        source: 'dashboard',
        dedupeKey: `node-offline:${connectorId}:${node.node || node.id || ''}`,
      }));
    }

    created.push(...await createResourceThresholdNotifications({
      connectorId,
      metric: 'cpu',
      usage: percentFromValue(node.cpu),
      targetName: node.node || node.id || 'unknown',
      node: node.node || node.id || '',
      resourceType: 'node',
      thresholds: settings.resourceAlerts?.cpu,
      enabled: settings.resourceAlerts?.enabled !== false,
    }));

    created.push(...await createResourceThresholdNotifications({
      connectorId,
      metric: 'memory',
      usage: percentFromRatio(Number(node.mem || 0), Number(node.maxmem || 0)),
      targetName: node.node || node.id || 'unknown',
      node: node.node || node.id || '',
      resourceType: 'node',
      thresholds: settings.resourceAlerts?.memory,
      enabled: settings.resourceAlerts?.enabled !== false,
    }));
  }

  for (const storage of dashboard?.resources?.storage || []) {
    const used = Number(storage.disk || 0);
    const total = Number(storage.maxdisk || 0);
    created.push(...await createResourceThresholdNotifications({
      connectorId,
      metric: 'storage',
      usage: percentFromRatio(used, total),
      targetName: storage.storage || storage.id || 'unknown',
      node: storage.node || '',
      resourceType: 'storage',
      thresholds: settings.resourceAlerts?.storage,
      enabled: settings.resourceAlerts?.enabled !== false,
      metadata: { storage: storage.storage || storage.id || '', used, total },
      dedupeKeyTarget: `${storage.node || 'cluster'}:${storage.storage || storage.id || ''}`,
    }));
  }
  return created;
}

function percentFromValue(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return number <= 1 ? number * 100 : number;
}

function percentFromRatio(used, total) {
  if (!total || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (used / total) * 100));
}

async function createResourceThresholdNotifications({
  connectorId,
  metric,
  usage,
  targetName,
  node,
  resourceType,
  thresholds,
  enabled,
  metadata = {},
  dedupeKeyTarget,
}) {
  if (!enabled) {
    return [];
  }
  const limits = normalizeThresholdPair(thresholds);
  const roundedUsage = Math.round(usage);
  const severity = roundedUsage >= limits.critical
    ? 'critical'
    : roundedUsage >= limits.warning
      ? 'warning'
      : '';
  if (!severity) {
    return [];
  }
  const metricLabel = metric === 'memory' ? 'RAM' : metric.toUpperCase();
  const threshold = severity === 'critical' ? limits.critical : limits.warning;
  return [await createNotification({
    type: `${metric}-threshold`,
    severity,
    title: `${metricLabel} alert for ${targetName}`,
    message: `${metricLabel} usage is ${roundedUsage}%, above the ${severity} threshold of ${threshold}%.`,
    connectorId,
    node,
    resourceType,
    source: 'resource-alert',
    metadata: { ...metadata, metric, usage: roundedUsage, threshold },
    dedupeKey: `resource-threshold:${connectorId}:${metric}:${dedupeKeyTarget || node || targetName}`,
  })];
}
