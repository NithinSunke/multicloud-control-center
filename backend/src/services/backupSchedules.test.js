import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeNextRunAt,
  createBackupSchedule,
  deleteBackupSchedule,
  listBackupSchedules,
  recordBackupScheduleRun,
  updateBackupSchedule,
} from './backupSchedules.js';

let dataDir;

describe('backup schedules store', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'pm-backup-schedules-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('computes next daily, weekly, and monthly run times', () => {
    expect(computeNextRunAt({ frequency: 'daily', time: '02:00' }, new Date('2026-05-15T01:00:00Z'))).toBe('2026-05-15T02:00:00.000Z');
    expect(computeNextRunAt({ frequency: 'weekly', time: '02:00', dayOfWeek: 5 }, new Date('2026-05-15T03:00:00Z'))).toBe('2026-05-22T02:00:00.000Z');
    expect(computeNextRunAt({ frequency: 'monthly', time: '02:00', dayOfMonth: 31 }, new Date('2026-04-30T03:00:00Z'))).toBe('2026-05-31T02:00:00.000Z');
  });

  it('creates, updates, records history, and deletes schedules', async () => {
    const schedule = await createBackupSchedule({
      connectorId: 'connector-1',
      resourceType: 'qemu',
      node: 'pve',
      vmid: 100,
      resourceName: 'app-server',
      storage: 'pbs',
      frequency: 'daily',
      time: '02:00',
      retention: 7,
    });

    expect(schedule.id).toBeTruthy();
    expect((await listBackupSchedules())).toHaveLength(1);

    const updated = await updateBackupSchedule(schedule.id, {
      ...schedule,
      frequency: 'weekly',
      dayOfWeek: 1,
      retention: 14,
    });
    expect(updated.frequency).toBe('weekly');
    expect(updated.retention).toBe(14);

    const recorded = await recordBackupScheduleRun(schedule.id, {
      status: 'succeeded',
      finishedAt: '2026-05-15T02:10:00.000Z',
      taskId: 'UPID:pve:backup',
      message: 'ok',
    });
    expect(recorded.history[0]).toMatchObject({ status: 'succeeded', taskId: 'UPID:pve:backup' });

    await deleteBackupSchedule(schedule.id);
    expect((await listBackupSchedules())).toEqual([]);
  });
});
