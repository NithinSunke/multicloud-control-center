import { getConnectorForUse } from './connectorStore.js';
import { createProxmoxApiClient } from './proxmoxApiClient.js';
import {
  clearBackupScheduleRunning,
  listBackupSchedules,
  markBackupScheduleRunning,
  recordBackupScheduleRun,
} from './backupSchedules.js';
import { appendAuditLog } from './auditLog.js';
import { createNotification } from './notificationStore.js';
import { logger } from '../utils/logger.js';

const schedulerIntervalMs = 60 * 1000;
const runningSchedules = new Set();

export function isBackupVolumeForResource(item = {}, { type, vmid }) {
  const resourceType = type === 'lxc' || type === 'container' ? 'lxc' : 'qemu';
  const volume = String(item.volid || item.volume || item.filename || '');
  const itemVmid = Number(item.vmid);
  if (Number.isInteger(itemVmid) && itemVmid === Number(vmid)) {
    return true;
  }
  return volume.includes(`vzdump-${resourceType}-${vmid}-`) || volume.includes(`vzdump-${resourceType}-${vmid}.`);
}

export function normalizeBackupVolume(item = {}) {
  const createdAt = item.ctime ? new Date(Number(item.ctime) * 1000).toISOString() : null;
  return {
    volid: item.volid || item.volume || '',
    storage: item.storage || '',
    content: item.content || 'backup',
    format: item.format || '',
    size: Number(item.size || 0),
    createdAt,
    notes: item.notes || '',
    protected: item.protected === 1 || item.protected === true,
    vmid: item.vmid ? Number(item.vmid) : undefined,
  };
}

export async function listBackupsForResource(client, { node, type, vmid, storage }) {
  const storageRecords = storage
    ? [{ storage, node }]
    : await client.listStorage();
  const backups = [];

  for (const record of Array.isArray(storageRecords) ? storageRecords : []) {
    if (!record.storage || (record.node && record.node !== node)) {
      continue;
    }
    try {
      const content = await client.listStorageContent({ node, storage: record.storage, content: 'backup' });
      backups.push(
        ...(Array.isArray(content) ? content : [])
          .filter((item) => isBackupVolumeForResource(item, { type, vmid }))
          .map((item) => normalizeBackupVolume({ ...item, storage: record.storage })),
      );
    } catch (error) {
      logger.warn('backup_history_storage_skipped', {
        node,
        storage: record.storage,
        message: error.message,
      });
    }
  }

  return backups.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function enforceRetention(client, schedule) {
  const backups = await listBackupsForResource(client, {
    node: schedule.node,
    type: schedule.resourceType,
    vmid: schedule.vmid,
    storage: schedule.storage,
  });
  const removable = backups.filter((backup) => !backup.protected);
  const stale = removable.slice(Number(schedule.retention || 7));
  const deleted = [];
  const failed = [];

  for (const backup of stale) {
    try {
      await client.deleteStorageContent({
        node: schedule.node,
        storage: backup.storage || schedule.storage,
        volume: backup.volid,
      });
      deleted.push(backup.volid);
    } catch (error) {
      failed.push({ volid: backup.volid, message: error.message });
    }
  }

  return { deleted, failed };
}

export async function runBackupSchedule(schedule) {
  if (runningSchedules.has(schedule.id)) {
    return null;
  }

  runningSchedules.add(schedule.id);
  await markBackupScheduleRunning(schedule.id);

  const startedAt = new Date().toISOString();
  let taskId = '';
  try {
    const connector = await getConnectorForUse(schedule.connectorId);
    if (connector.status !== 'verified') {
      const error = new Error('Connector must be verified before scheduled backups can run.');
      error.statusCode = 400;
      throw error;
    }

    const client = createProxmoxApiClient(connector);
    await appendAuditLog({
      action: 'scheduled-backup',
      connectorId: connector.id,
      node: schedule.node,
      vmid: schedule.vmid,
      resourceType: schedule.resourceType,
      status: 'requested',
      storage: schedule.storage,
      scheduleId: schedule.id,
      user: 'scheduler',
    });

    taskId = await client.backupResource({
      node: schedule.node,
      vmid: schedule.vmid,
      storage: schedule.storage,
      mode: schedule.mode,
      compress: schedule.compress,
      notes: schedule.notes,
    });
    const task = await client.pollTask({ node: schedule.node, upid: taskId, timeoutMs: 300000 });
    const success = !task.exitstatus || task.exitstatus === 'OK';
    const retention = success ? await enforceRetention(client, schedule) : { deleted: [], failed: [] };
    const finishedAt = new Date().toISOString();
    const message = success
      ? `Scheduled backup completed for ${schedule.resourceType === 'lxc' ? 'container' : 'VM'} ${schedule.vmid}.`
      : `Scheduled backup finished with status ${task.exitstatus}.`;

    await appendAuditLog({
      action: 'scheduled-backup',
      connectorId: connector.id,
      node: schedule.node,
      vmid: schedule.vmid,
      resourceType: schedule.resourceType,
      status: success ? 'succeeded' : 'failed',
      taskId,
      exitstatus: task.exitstatus || '',
      retentionDeleted: retention.deleted.length,
      retentionFailed: retention.failed.length,
      scheduleId: schedule.id,
      user: 'scheduler',
    });

    if (!success) {
      await createNotification({
        type: 'backup-failed',
        severity: 'critical',
        title: `Scheduled backup failed for ${schedule.resourceType === 'lxc' ? 'container' : 'VM'} ${schedule.vmid}`,
        message,
        connectorId: connector.id,
        node: schedule.node,
        vmid: schedule.vmid,
        resourceType: schedule.resourceType,
        taskId,
        source: 'backup-scheduler',
        metadata: { scheduleId: schedule.id, storage: schedule.storage },
        dedupeKey: `scheduled-backup-failed:${connector.id}:${schedule.id}:${taskId}`,
      });
    }

    return recordBackupScheduleRun(schedule.id, {
      status: success ? 'succeeded' : 'failed',
      startedAt,
      finishedAt,
      taskId,
      exitstatus: task.exitstatus || '',
      message,
      retention,
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await appendAuditLog({
      action: 'scheduled-backup',
      node: schedule.node,
      vmid: schedule.vmid,
      resourceType: schedule.resourceType,
      status: 'failed',
      message: error.message,
      taskId,
      scheduleId: schedule.id,
      user: 'scheduler',
    }).catch(() => undefined);

    await createNotification({
      type: 'backup-failed',
      severity: 'critical',
      title: `Scheduled backup failed for ${schedule.resourceType === 'lxc' ? 'container' : 'VM'} ${schedule.vmid}`,
      message: error.message,
      node: schedule.node,
      vmid: schedule.vmid,
      resourceType: schedule.resourceType,
      taskId,
      source: 'backup-scheduler',
      metadata: { scheduleId: schedule.id, storage: schedule.storage },
      dedupeKey: `scheduled-backup-failed:${schedule.id}:${error.message}`,
    }).catch(() => undefined);

    return recordBackupScheduleRun(schedule.id, {
      status: 'failed',
      startedAt,
      finishedAt,
      taskId,
      message: error.message,
    });
  } finally {
    runningSchedules.delete(schedule.id);
    await clearBackupScheduleRunning(schedule.id).catch(() => undefined);
  }
}

export async function runDueBackupSchedules(now = new Date()) {
  const schedules = await listBackupSchedules();
  const due = schedules.filter(
    (schedule) =>
      schedule.enabled !== false &&
      schedule.nextRunAt &&
      new Date(schedule.nextRunAt) <= now &&
      !schedule.running,
  );

  for (const schedule of due) {
    await runBackupSchedule(schedule);
  }
  return due.length;
}

export function startBackupScheduler() {
  const timer = setInterval(() => {
    runDueBackupSchedules().catch((error) => {
      logger.error('backup_scheduler_failed', { message: error.message });
    });
  }, schedulerIntervalMs);
  timer.unref?.();
  return timer;
}
