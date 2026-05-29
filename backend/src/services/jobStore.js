import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { redactSecrets } from '../utils/logger.js';

const jobsFileName = 'job-center.json';

function jobsFilePath() {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), jobsFileName);
}

async function readJobs() {
  try {
    const raw = await readFile(jobsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeJobs(jobs) {
  const target = jobsFilePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(jobs.slice(-500), null, 2), 'utf8');
}

function normalizeStatus(status) {
  if (status === 'failed') {
    return { status: 'stopped', exitstatus: 'ERROR', progress: 100, endedAt: new Date().toISOString() };
  }
  if (status === 'succeeded' || status === 'completed') {
    return { status: 'stopped', exitstatus: 'OK', progress: 100, endedAt: new Date().toISOString() };
  }
  return { status: 'running', exitstatus: '', progress: 50, endedAt: null };
}

export async function createJob(entry) {
  const now = new Date().toISOString();
  const normalized = normalizeStatus(entry.status);
  const job = redactSecrets({
    id: randomUUID(),
    upid: `${String(entry.provider || 'job').toUpperCase()}:${randomUUID()}`,
    provider: entry.provider || 'app',
    connectorId: entry.connectorId || '',
    region: entry.region || '',
    node: entry.node || String(entry.provider || 'app').toUpperCase(),
    user: entry.user || 'unknown',
    type: entry.type || entry.action || 'operation',
    action: entry.action || 'operation',
    resourceType: entry.resourceType || '',
    resourceId: entry.resourceId || '',
    resourceName: entry.resourceName || '',
    idRef: entry.resourceId || '',
    status: normalized.status,
    rawStatus: entry.status || normalized.status,
    exitstatus: normalized.exitstatus,
    progress: entry.progress ?? normalized.progress,
    startedAt: entry.startedAt || now,
    endedAt: entry.endedAt === undefined ? normalized.endedAt : entry.endedAt,
    description: entry.description || entry.action || 'Operation',
    message: entry.message || '',
    errorMessage: entry.errorMessage || (entry.status === 'failed' ? entry.message : '') || '',
    linkedResource: entry.linkedResource || null,
    retryable: Boolean(entry.retryable),
    cancelable: Boolean(entry.cancelable),
    output: entry.output || [],
    metadata: entry.metadata || {},
  });
  const jobs = await readJobs();
  jobs.push(job);
  await writeJobs(jobs);
  return job;
}

export async function listJobs({ provider, limit = 200 } = {}) {
  const jobs = await readJobs();
  return jobs
    .filter((job) => !provider || job.provider === provider)
    .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime())
    .slice(0, limit);
}
