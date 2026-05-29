import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const storeFileName = 'backup-schedules.json';
const maxHistoryEntries = 100;

function storePath() {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), storeFileName);
}

async function readStore() {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { schedules: [] };
    }
    throw error;
  }
}

async function writeStore(store) {
  const target = storePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(store, null, 2), 'utf8');
}

function lastDayOfMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  if (!match) {
    return { hours: 2, minutes: 0 };
  }
  return {
    hours: Math.min(23, Math.max(0, Number(match[1]))),
    minutes: Math.min(59, Math.max(0, Number(match[2]))),
  };
}

export function computeNextRunAt(schedule, from = new Date()) {
  const frequency = schedule.frequency || 'daily';
  const { hours, minutes } = parseTime(schedule.time);
  const base = new Date(from);
  let candidate = new Date(base);
  candidate.setSeconds(0, 0);
  candidate.setHours(hours, minutes, 0, 0);

  if (frequency === 'weekly') {
    const dayOfWeek = Number.isInteger(Number(schedule.dayOfWeek)) ? Number(schedule.dayOfWeek) : 0;
    const delta = (dayOfWeek - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + delta);
    if (candidate <= base) {
      candidate.setDate(candidate.getDate() + 7);
    }
    return candidate.toISOString();
  }

  if (frequency === 'monthly') {
    const wantedDay = Math.min(31, Math.max(1, Number(schedule.dayOfMonth || 1)));
    candidate.setDate(Math.min(wantedDay, lastDayOfMonth(candidate.getFullYear(), candidate.getMonth())));
    if (candidate <= base) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setDate(Math.min(wantedDay, lastDayOfMonth(candidate.getFullYear(), candidate.getMonth())));
      candidate.setHours(hours, minutes, 0, 0);
    }
    return candidate.toISOString();
  }

  if (candidate <= base) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.toISOString();
}

function normalizeSchedule(payload = {}, existing = {}) {
  const now = new Date().toISOString();
  const normalized = {
    ...existing,
    connectorId: String(payload.connectorId || existing.connectorId || '').trim(),
    resourceType: payload.resourceType === 'lxc' || payload.type === 'lxc' ? 'lxc' : 'qemu',
    node: String(payload.node || existing.node || '').trim(),
    vmid: Number(payload.vmid || existing.vmid),
    resourceName: String(payload.resourceName || existing.resourceName || '').trim(),
    storage: String(payload.storage || existing.storage || '').trim(),
    mode: ['snapshot', 'suspend', 'stop'].includes(payload.mode) ? payload.mode : existing.mode || 'snapshot',
    compress: ['zstd', 'gzip', 'lzo', '0'].includes(payload.compress) ? payload.compress : existing.compress || 'zstd',
    notes: String(payload.notes || existing.notes || '').trim(),
    frequency: ['daily', 'weekly', 'monthly'].includes(payload.frequency) ? payload.frequency : existing.frequency || 'daily',
    time: String(payload.time || existing.time || '02:00').trim(),
    dayOfWeek: Number.isInteger(Number(payload.dayOfWeek ?? existing.dayOfWeek)) ? Number(payload.dayOfWeek ?? existing.dayOfWeek) : 0,
    dayOfMonth: Number.isInteger(Number(payload.dayOfMonth ?? existing.dayOfMonth)) ? Number(payload.dayOfMonth ?? existing.dayOfMonth) : 1,
    retention: [7, 14, 30].includes(Number(payload.retention ?? existing.retention)) ? Number(payload.retention ?? existing.retention) : 7,
    enabled: payload.enabled === undefined ? existing.enabled !== false : payload.enabled === true,
    history: Array.isArray(existing.history) ? existing.history : [],
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };

  normalized.nextRunAt = normalized.enabled ? computeNextRunAt(normalized) : null;
  return normalized;
}

function validateSchedule(schedule) {
  const errors = [];
  if (!schedule.connectorId) errors.push('Connector is required.');
  if (!schedule.node) errors.push('Node is required.');
  if (!Number.isInteger(schedule.vmid) || schedule.vmid <= 0) errors.push('VM/CT ID must be positive.');
  if (!schedule.storage) errors.push('Backup storage is required.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) errors.push('Schedule time must use HH:mm format.');
  if (schedule.frequency === 'weekly' && (schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)) errors.push('Day of week is invalid.');
  if (schedule.frequency === 'monthly' && (schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) errors.push('Day of month is invalid.');

  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.statusCode = 400;
    throw error;
  }
}

export async function listBackupSchedules() {
  const store = await readStore();
  return store.schedules;
}

export async function createBackupSchedule(payload) {
  const schedule = {
    id: randomUUID(),
    ...normalizeSchedule(payload),
  };
  validateSchedule(schedule);
  const store = await readStore();
  store.schedules.push(schedule);
  await writeStore(store);
  return schedule;
}

export async function updateBackupSchedule(id, payload) {
  const store = await readStore();
  const index = store.schedules.findIndex((schedule) => schedule.id === id);
  if (index === -1) {
    const error = new Error('Backup schedule not found.');
    error.statusCode = 404;
    throw error;
  }

  const schedule = normalizeSchedule(payload, store.schedules[index]);
  schedule.id = id;
  validateSchedule(schedule);
  store.schedules[index] = schedule;
  await writeStore(store);
  return schedule;
}

export async function deleteBackupSchedule(id) {
  const store = await readStore();
  const nextSchedules = store.schedules.filter((schedule) => schedule.id !== id);
  if (nextSchedules.length === store.schedules.length) {
    const error = new Error('Backup schedule not found.');
    error.statusCode = 404;
    throw error;
  }
  await writeStore({ schedules: nextSchedules });
}

export async function recordBackupScheduleRun(id, run) {
  const store = await readStore();
  const index = store.schedules.findIndex((schedule) => schedule.id === id);
  if (index === -1) {
    return null;
  }

  const schedule = store.schedules[index];
  const history = [
    {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      ...run,
    },
    ...(Array.isArray(schedule.history) ? schedule.history : []),
  ].slice(0, maxHistoryEntries);

  const updated = {
    ...schedule,
    history,
    lastRunAt: run.finishedAt || new Date().toISOString(),
    lastStatus: run.status,
    lastMessage: run.message || '',
    nextRunAt: schedule.enabled === false ? null : computeNextRunAt(schedule),
    updatedAt: new Date().toISOString(),
  };
  store.schedules[index] = updated;
  await writeStore(store);
  return updated;
}

export async function markBackupScheduleRunning(id) {
  const store = await readStore();
  const index = store.schedules.findIndex((schedule) => schedule.id === id);
  if (index === -1) {
    return null;
  }
  store.schedules[index] = {
    ...store.schedules[index],
    running: true,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
  return store.schedules[index];
}

export async function clearBackupScheduleRunning(id) {
  const store = await readStore();
  const index = store.schedules.findIndex((schedule) => schedule.id === id);
  if (index === -1) {
    return null;
  }
  store.schedules[index] = {
    ...store.schedules[index],
    running: false,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
  return store.schedules[index];
}
