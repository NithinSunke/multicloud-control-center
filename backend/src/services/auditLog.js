import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { redactSecrets } from '../utils/logger.js';

const auditFileName = 'audit-log.json';

function auditFilePath() {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), auditFileName);
}

async function readAuditLog() {
  try {
    const raw = await readFile(auditFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function appendAuditLog(entry) {
  const target = auditFilePath();
  const entries = await readAuditLog();
  entries.push(redactSecrets({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  }));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(entries, null, 2), 'utf8');
}

export async function listAuditLog() {
  return readAuditLog();
}
