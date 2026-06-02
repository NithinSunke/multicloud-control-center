import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { access, chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const keyFileName = 'id_ed25519';

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function identityDir() {
  return path.join(dataDir(), 'ansible-ssh');
}

function privateKeyPath() {
  return path.join(identityDir(), keyFileName);
}

function publicKeyPath() {
  return `${privateKeyPath()}.pub`;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function chmodIfSupported(target, mode) {
  try {
    await chmod(target, mode);
  } catch {
    // Windows development hosts may not support POSIX modes.
  }
}

async function ensurePublicKey() {
  if (await exists(publicKeyPath())) {
    return;
  }
  const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', privateKeyPath()]);
  await writeFile(publicKeyPath(), stdout.trimEnd() + '\n', 'utf8');
  await chmodIfSupported(publicKeyPath(), 0o644);
}

async function fingerprintForPublicKey() {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-lf', publicKeyPath()]);
    const parts = stdout.trim().split(/\s+/);
    return parts[1] || '';
  } catch {
    return '';
  }
}

export async function ensureAnsibleSshIdentity() {
  await mkdir(identityDir(), { recursive: true });
  if (!(await exists(privateKeyPath()))) {
    await execFileAsync('ssh-keygen', [
      '-t',
      'ed25519',
      '-a',
      '100',
      '-N',
      '',
      '-C',
      `mc3-ansible-${randomUUID()}@backend`,
      '-f',
      privateKeyPath(),
    ]);
    await chmodIfSupported(privateKeyPath(), 0o600);
  }
  await ensurePublicKey();
  const publicKey = (await readFile(publicKeyPath(), 'utf8')).trim();
  return {
    keyType: 'ed25519',
    publicKey,
    fingerprint: await fingerprintForPublicKey(),
    privateKeyPath: privateKeyPath(),
    publicKeyPath: publicKeyPath(),
  };
}
