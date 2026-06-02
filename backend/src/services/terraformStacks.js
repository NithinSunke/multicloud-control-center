import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { access, chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { appendAuditLog } from './auditLog.js';
import { getGithubConnectorForUse } from './connectorStore.js';
import { createJob } from './jobStore.js';
import { redactSecrets } from '../utils/logger.js';

const metadataFileName = 'terraform-stacks.json';
const maxOutputLines = 1000;
const zipStoreMethod = 0;
const zipVersionNeeded = 20;

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function stacksRoot() {
  return path.join(dataDir(), 'terraform-stacks');
}

function metadataPath() {
  return path.join(stacksRoot(), metadataFileName);
}

function stackDir(stackId) {
  return path.join(stacksRoot(), stackId);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function shouldExcludeExportEntry(relativePath, entry) {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '.terraform' || segment === '__MACOSX' || segment === 'node_modules')) {
    return true;
  }
  if (entry.isDirectory()) {
    return false;
  }
  const name = segments[segments.length - 1];
  return name === 'tfplan'
    || name === 'terraform.tfstate'
    || name === 'terraform.tfstate.backup'
    || name === '.terraform.tfstate.lock.info'
    || name.endsWith('.tfstate')
    || name.endsWith('.tfstate.backup')
    || name.endsWith('.tfplan');
}

async function collectExportFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');
    if (!relativePath || shouldExcludeExportEntry(relativePath, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await collectExportFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const file of files) {
    const nameBuffer = Buffer.from(file.relativePath, 'utf8');
    const data = file.data;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(zipVersionNeeded, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(zipStoreMethod, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(zipVersionNeeded, 4);
    centralHeader.writeUInt16LE(zipVersionNeeded, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(zipStoreMethod, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function safeName(value) {
  return String(value || 'terraform-stack')
    .trim()
    .replace(/[^a-zA-Z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'terraform-stack';
}

function redactGitUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return raw.replace(/:\/\/([^/@\s]+)@/, '://***@');
  }
}

function sanitizeGitPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }
  if (normalized === '..' || normalized.includes('../') || /^[a-zA-Z]:/.test(normalized)) {
    const error = new Error('Git stack path must be a relative path inside the repository.');
    error.status = 400;
    throw error;
  }
  return normalized;
}

function validateGitRef(value) {
  const ref = String(value || 'main').trim() || 'main';
  if (ref.startsWith('-') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
    const error = new Error('Git branch contains unsupported characters.');
    error.status = 400;
    throw error;
  }
  return ref;
}

function validateGitRepoUrl(value) {
  const repoUrl = String(value || '').trim();
  if (!repoUrl) {
    const error = new Error('Git repository URL is required.');
    error.status = 400;
    throw error;
  }
  if (repoUrl.startsWith('-')) {
    const error = new Error('Git repository URL is invalid.');
    error.status = 400;
    throw error;
  }
  return repoUrl;
}

async function readMetadata() {
  try {
    const raw = await readFile(metadataPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeMetadata(stacks) {
  await mkdir(stacksRoot(), { recursive: true });
  await writeFile(metadataPath(), JSON.stringify(stacks, null, 2), 'utf8');
}

async function updateStack(stackId, patch) {
  const stacks = await readMetadata();
  const index = stacks.findIndex((stack) => stack.id === stackId);
  if (index < 0) {
    const error = new Error('Terraform stack not found.');
    error.status = 404;
    throw error;
  }
  stacks[index] = {
    ...stacks[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeMetadata(stacks);
  return stacks[index];
}

function normalizeRuns(stack) {
  if (Array.isArray(stack.runs)) {
    return stack.runs;
  }
  if (Array.isArray(stack.lastOutput) && stack.lastOutput.length) {
    return [{
      id: `legacy-${stack.lastAction || 'run'}`,
      action: stack.lastAction || 'run',
      status: stack.status || 'unknown',
      message: stack.lastMessage || '',
      startedAt: stack.lastRunAt || stack.updatedAt || stack.createdAt || null,
      finishedAt: stack.status === 'running' ? null : stack.updatedAt || null,
      output: stack.lastOutput,
    }];
  }
  return [];
}

async function createStackRun(stackId, { action, user, startedAt, message }) {
  const run = {
    id: randomUUID(),
    action,
    status: 'running',
    message,
    startedAt,
    finishedAt: null,
    user: user || 'admin',
    output: [`${message} (${startedAt})`],
  };
  const stacks = await readMetadata();
  const index = stacks.findIndex((stack) => stack.id === stackId);
  if (index < 0) {
    const error = new Error('Terraform stack not found.');
    error.status = 404;
    throw error;
  }
  const runs = [run, ...normalizeRuns(stacks[index])].slice(0, 25);
  stacks[index] = {
    ...stacks[index],
    runs,
    status: 'running',
    lastAction: action,
    lastMessage: message,
    lastRunAt: startedAt,
    lastOutput: run.output,
    updatedAt: new Date().toISOString(),
  };
  await writeMetadata(stacks);
  return run;
}

async function updateStackRun(stackId, runId, patch = {}, outputLines = []) {
  const stacks = await readMetadata();
  const index = stacks.findIndex((stack) => stack.id === stackId);
  if (index < 0) {
    const error = new Error('Terraform stack not found.');
    error.status = 404;
    throw error;
  }
  const runs = normalizeRuns(stacks[index]);
  const runIndex = runs.findIndex((run) => run.id === runId);
  if (runIndex < 0) {
    const error = new Error('Terraform stack run not found.');
    error.status = 404;
    throw error;
  }
  const existingOutput = Array.isArray(runs[runIndex].output) ? runs[runIndex].output : [];
  const nextOutput = redactSecrets([...existingOutput, ...outputLines]).slice(-maxOutputLines);
  runs[runIndex] = {
    ...runs[runIndex],
    ...patch,
    output: nextOutput,
  };
  const latestRun = runs[runIndex];
  stacks[index] = {
    ...stacks[index],
    runs,
    lastAction: latestRun.action,
    lastMessage: latestRun.message || stacks[index].lastMessage,
    lastOutput: nextOutput,
    updatedAt: new Date().toISOString(),
    ...(patch.status ? { status: patch.status } : {}),
  };
  await writeMetadata(stacks);
  return stacks[index];
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const check = spawn(command, ['--version'], { stdio: 'ignore' });
    check.on('error', () => resolve(false));
    check.on('exit', (code) => resolve(code === 0));
  });
}

async function terraformBinary() {
  if (await commandExists('tofu')) {
    return 'tofu';
  }
  if (await commandExists('terraform')) {
    return 'terraform';
  }
  const error = new Error('OpenTofu/Terraform is not installed in the backend container.');
  error.status = 500;
  throw error;
}

const terraformCommandTimeouts = {
  init: 15 * 60 * 1000,
  validate: 15 * 60 * 1000,
  plan: 30 * 60 * 1000,
  apply: 4 * 60 * 60 * 1000,
  destroy: 60 * 60 * 1000,
};

function runCommand(command, args, cwd, timeoutMs = 15 * 60 * 1000, extraEnv = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const lines = [];
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        ...extraEnv,
        TF_IN_AUTOMATION: '1',
        TF_INPUT: '0',
      },
    });

    const pushLine = (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .forEach((line) => {
          lines.push(line);
          if (lines.length > maxOutputLines) {
            lines.shift();
          }
        });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', pushLine);
    child.stderr.on('data', pushLine);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        success: false,
        exitCode: 1,
        output: [`Unable to run ${command}: ${error.message}`],
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !timedOut,
        exitCode: timedOut ? 124 : code ?? 1,
        output: timedOut ? [...lines, 'Command timed out.'] : lines,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runRequiredCommand(command, args, cwd, timeoutMs, extraEnv = {}) {
  const result = await runCommand(command, args, cwd, timeoutMs, extraEnv);
  if (!result.success) {
    const detail = redactSecrets(result.output || [])
      .slice(-8)
      .join(' ')
      .trim();
    const error = new Error(detail ? `${command} failed: ${detail}` : `${command} ${args.join(' ')} failed.`);
    error.commandResult = result;
    throw error;
  }
  return result;
}

async function listZipEntries(zipPath) {
  const result = await runCommand('unzip', ['-Z1', zipPath], stacksRoot(), 60 * 1000);
  if (!result.success) {
    const error = new Error('Unable to inspect ZIP file. Confirm the backend container has unzip installed and the file is a valid ZIP archive.');
    error.status = 400;
    error.commandResult = result;
    throw error;
  }
  return result.output;
}

function validateZipEntries(entries) {
  const invalid = entries.find((entry) => {
    const normalized = entry.replace(/\\/g, '/');
    return normalized.startsWith('/')
      || normalized.includes('../')
      || normalized === '..'
      || normalized.includes('..\\')
      || /^[a-zA-Z]:/.test(normalized);
  });
  if (invalid) {
    const error = new Error(`ZIP contains an unsafe path: ${invalid}`);
    error.status = 400;
    throw error;
  }
}

async function findTerraformWorkingDir(root) {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.tf'))) {
      return current;
    }
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX')
      .forEach((entry) => queue.push(path.join(current, entry.name)));
  }
  const error = new Error('Uploaded ZIP does not contain any .tf files.');
  error.status = 400;
  throw error;
}

async function listTerraformFiles(workingDir) {
  const entries = await readdir(workingDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(tf|tfvars|json|sh)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function sanitizeStack(stack) {
  const { localPath: _localPath, zipPath: _zipPath, ...safe } = stack;
  if (safe.git?.repoUrl) {
    safe.git = {
      ...safe.git,
      repoUrl: redactGitUrl(safe.git.repoUrl),
    };
  }
  return safe;
}

export async function listTerraformStacks() {
  const stacks = await readMetadata();
  return stacks.map(sanitizeStack).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function downloadTerraformStack({ stackId }) {
  const { stack, workingDir } = await getStackForRun(stackId);
  const fileEntries = await collectExportFiles(workingDir);
  if (!fileEntries.length) {
    const error = new Error('Terraform stack has no downloadable files.');
    error.status = 404;
    throw error;
  }
  const files = await Promise.all(fileEntries.map(async (file) => ({
    relativePath: file.relativePath,
    data: await readFile(file.absolutePath),
  })));
  return {
    fileName: `${safeName(stack.name)}-${stack.id.slice(0, 8)}.zip`,
    buffer: createZipBuffer(files),
  };
}

export async function uploadTerraformStack({ name, description, buffer, user }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error('Upload a non-empty Terraform ZIP file.');
    error.status = 400;
    throw error;
  }

  const stackId = randomUUID();
  const now = new Date().toISOString();
  const targetDir = stackDir(stackId);
  const extractDir = path.join(targetDir, 'source');
  const zipPath = path.join(targetDir, 'upload.zip');

  await mkdir(extractDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(zipPath, { flags: 'wx' });
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(buffer);
  });

  const entries = await listZipEntries(zipPath);
  validateZipEntries(entries);
  const unzipResult = await runCommand('unzip', ['-q', zipPath, '-d', extractDir], targetDir, 120 * 1000);
  if (!unzipResult.success) {
    const error = new Error('Unable to extract Terraform ZIP file.');
    error.status = 400;
    error.commandResult = unzipResult;
    throw error;
  }

  const workingDir = await findTerraformWorkingDir(extractDir);
  const terraformFiles = await listTerraformFiles(workingDir);
  const stacks = await readMetadata();
  const stack = {
    id: stackId,
    name: safeName(name),
    description: String(description || '').trim(),
    status: 'uploaded',
    lastAction: 'upload',
    lastMessage: 'Terraform stack uploaded.',
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: user || 'admin',
    sourceType: 'upload',
    localPath: targetDir,
    zipPath,
    workingDir: path.relative(targetDir, workingDir),
    terraformFiles,
    lastOutput: [],
    runs: [],
  };
  stacks.push(stack);
  await writeMetadata(stacks);
  await appendAuditLog({
    action: 'terraform-stack.upload',
    status: 'success',
    user,
    resourceType: 'terraformStack',
    resourceId: stack.id,
    resourceName: stack.name,
    message: 'Terraform stack uploaded.',
  });
  return sanitizeStack(stack);
}

async function githubGitEnv(connector, targetDir) {
  if (!connector?.githubToken) {
    return {};
  }
  const askpassPath = path.join(targetDir, 'github-askpass.sh');
  const username = connector.githubUsername || 'x-access-token';
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' '${username.replace(/'/g, "'\\''")}' ;;
  *Password*) printf '%s\n' '${connector.githubToken.replace(/'/g, "'\\''")}' ;;
  *) printf '\n' ;;
esac
`;
  await writeFile(askpassPath, script, 'utf8');
  await chmod(askpassPath, 0o700);
  return {
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function gitClone({ repoUrl, branch, targetDir, connector }) {
  const env = await githubGitEnv(connector, path.dirname(targetDir));
  return runRequiredCommand('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    branch,
    '--single-branch',
    '--',
    repoUrl,
    targetDir,
  ], stacksRoot(), 15 * 60 * 1000, env);
}

async function gitPullLatest({ repoDir, branch, connector }) {
  const env = await githubGitEnv(connector, path.dirname(repoDir));
  await runRequiredCommand('git', ['fetch', '--depth', '1', 'origin', branch], repoDir, 15 * 60 * 1000, env);
  await runRequiredCommand('git', ['reset', '--hard', `origin/${branch}`], repoDir, 15 * 60 * 1000, env);
}

async function resolveGitWorkingDir(repoDir, gitPath) {
  const workingDir = gitPath ? path.resolve(repoDir, gitPath) : await findTerraformWorkingDir(repoDir);
  if (!workingDir.startsWith(path.resolve(repoDir))) {
    const error = new Error('Git stack path escapes the repository.');
    error.status = 400;
    throw error;
  }
  await access(workingDir);
  if (gitPath) {
    const entries = await readdir(workingDir, { withFileTypes: true });
    if (!entries.some((entry) => entry.isFile() && entry.name.endsWith('.tf'))) {
      const error = new Error('Git stack path does not contain any .tf files.');
      error.status = 400;
      throw error;
    }
  }
  return workingDir;
}

export async function importTerraformStackFromGit({ name, description, repoUrl, branch, gitPath, githubConnectorId, user }) {
  const normalizedRepoUrl = validateGitRepoUrl(repoUrl);
  const normalizedBranch = validateGitRef(branch);
  const normalizedPath = sanitizeGitPath(gitPath);
  const stackId = randomUUID();
  const now = new Date().toISOString();
  const targetDir = stackDir(stackId);
  const repoDir = path.join(targetDir, 'repo');

  await mkdir(targetDir, { recursive: true });
  try {
    const githubConnector = githubConnectorId ? await getGithubConnectorForUse(githubConnectorId) : null;
    await gitClone({ repoUrl: normalizedRepoUrl, branch: normalizedBranch, targetDir: repoDir, connector: githubConnector });
    const workingDir = await resolveGitWorkingDir(repoDir, normalizedPath);
    const terraformFiles = await listTerraformFiles(workingDir);
    const stack = {
      id: stackId,
      name: safeName(name),
      description: String(description || '').trim(),
      status: 'uploaded',
      lastAction: 'git-import',
      lastMessage: 'Terraform stack imported from Git.',
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: user || 'admin',
      sourceType: 'git',
      git: {
        repoUrl: normalizedRepoUrl,
        branch: normalizedBranch,
        path: normalizedPath,
        githubConnectorId: githubConnector?.id || '',
        githubConnectorName: githubConnector?.name || '',
      },
      localPath: targetDir,
      workingDir: path.relative(targetDir, workingDir),
      terraformFiles,
      lastOutput: [],
      runs: [],
    };
    const stacks = await readMetadata();
    stacks.push(stack);
    await writeMetadata(stacks);
    await appendAuditLog({
      action: 'terraform-stack.git-import',
      status: 'success',
      user,
      resourceType: 'terraformStack',
      resourceId: stack.id,
      resourceName: stack.name,
      message: 'Terraform stack imported from Git.',
    });
    return sanitizeStack(stack);
  } catch (error) {
    error.statusCode = error.statusCode || error.status || 400;
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}

export async function pullTerraformStackFromGit({ stackId, user }) {
  const stacks = await readMetadata();
  const index = stacks.findIndex((item) => item.id === stackId);
  if (index < 0) {
    const error = new Error('Terraform stack not found.');
    error.status = 404;
    throw error;
  }
  const stack = stacks[index];
  if (stack.sourceType !== 'git' || !stack.git?.repoUrl) {
    const error = new Error('Only Git-backed Terraform stacks can pull latest.');
    error.status = 400;
    throw error;
  }

  const targetDir = stackDir(stackId);
  const repoDir = path.join(targetDir, 'repo');
  const branch = validateGitRef(stack.git.branch);
  const githubConnector = stack.git.githubConnectorId ? await getGithubConnectorForUse(stack.git.githubConnectorId) : null;
  await gitPullLatest({ repoDir, branch, connector: githubConnector });
  const workingDir = await resolveGitWorkingDir(repoDir, sanitizeGitPath(stack.git.path));
  const terraformFiles = await listTerraformFiles(workingDir);
  const updated = {
    ...stack,
    status: 'uploaded',
    lastAction: 'git-pull',
    lastMessage: 'Pulled latest Terraform stack from Git.',
    lastOutput: [],
    updatedAt: new Date().toISOString(),
    workingDir: path.relative(targetDir, workingDir),
    terraformFiles,
  };
  stacks[index] = updated;
  await writeMetadata(stacks);
  await appendAuditLog({
    action: 'terraform-stack.git-pull',
    status: 'success',
    user,
    resourceType: 'terraformStack',
    resourceId: stack.id,
    resourceName: stack.name,
    message: 'Pulled latest Terraform stack from Git.',
  });
  return sanitizeStack(updated);
}

async function writeUploadZip(zipPath, buffer, flags = 'wx') {
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(zipPath, { flags });
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(buffer);
  });
}

async function copyIfExists(source, target) {
  try {
    await cp(source, target, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function preserveTerraformStateFiles(sourceWorkingDir, targetWorkingDir) {
  await copyIfExists(path.join(sourceWorkingDir, 'terraform.tfstate'), path.join(targetWorkingDir, 'terraform.tfstate'));
  await copyIfExists(path.join(sourceWorkingDir, 'terraform.tfstate.backup'), path.join(targetWorkingDir, 'terraform.tfstate.backup'));
  await copyIfExists(path.join(sourceWorkingDir, 'terraform.tfstate.d'), path.join(targetWorkingDir, 'terraform.tfstate.d'));

  const sourceWorkspaceFile = path.join(sourceWorkingDir, '.terraform', 'environment');
  const targetTerraformDir = path.join(targetWorkingDir, '.terraform');
  try {
    await access(sourceWorkspaceFile);
    await mkdir(targetTerraformDir, { recursive: true });
    await cp(sourceWorkspaceFile, path.join(targetTerraformDir, 'environment'), { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function replaceTerraformStackArchive({ stackId, buffer, user }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error('Upload a non-empty Terraform ZIP file.');
    error.status = 400;
    throw error;
  }

  const stacks = await readMetadata();
  const index = stacks.findIndex((item) => item.id === stackId);
  if (index < 0) {
    const error = new Error('Terraform stack not found.');
    error.status = 404;
    throw error;
  }

  const stack = stacks[index];
  const targetDir = stackDir(stackId);
  const root = path.resolve(stacksRoot());
  const resolvedTarget = path.resolve(targetDir);
  if (!resolvedTarget.startsWith(root)) {
    const error = new Error('Invalid stack path.');
    error.status = 400;
    throw error;
  }

  await mkdir(targetDir, { recursive: true });
  const extractDir = path.join(targetDir, 'source');
  const replacementDir = path.join(targetDir, `source-reupload-${Date.now()}`);
  const nextZipPath = path.join(targetDir, 'upload-next.zip');
  const zipPath = path.join(targetDir, 'upload.zip');

  await rm(replacementDir, { recursive: true, force: true });
  await rm(nextZipPath, { force: true });
  await mkdir(replacementDir, { recursive: true });
  await writeUploadZip(nextZipPath, buffer);

  try {
    const entries = await listZipEntries(nextZipPath);
    validateZipEntries(entries);
    const unzipResult = await runCommand('unzip', ['-q', nextZipPath, '-d', replacementDir], targetDir, 120 * 1000);
    if (!unzipResult.success) {
      const error = new Error('Unable to extract Terraform ZIP file.');
      error.status = 400;
      error.commandResult = unzipResult;
      throw error;
    }

    const replacementWorkingDir = await findTerraformWorkingDir(replacementDir);
    try {
      const oldWorkingDir = path.resolve(targetDir, stack.workingDir || 'source');
      if (oldWorkingDir.startsWith(resolvedTarget)) {
        await preserveTerraformStateFiles(oldWorkingDir, replacementWorkingDir);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    const relativeWorkingDir = path.relative(replacementDir, replacementWorkingDir);
    const finalWorkingDir = path.join(extractDir, relativeWorkingDir);
    const terraformFiles = await listTerraformFiles(replacementWorkingDir);
    await rm(extractDir, { recursive: true, force: true });
    await rename(replacementDir, extractDir);
    await rm(zipPath, { force: true });
    await rename(nextZipPath, zipPath);

    const updated = {
      ...stack,
      status: 'uploaded',
      lastAction: 'upload',
      lastMessage: 'Terraform stack ZIP replaced.',
      lastOutput: [],
      updatedAt: new Date().toISOString(),
      zipPath,
      localPath: targetDir,
      workingDir: path.relative(targetDir, finalWorkingDir),
      terraformFiles,
    };
    stacks[index] = updated;
    await writeMetadata(stacks);
    await appendAuditLog({
      action: 'terraform-stack.reupload',
      status: 'success',
      user,
      resourceType: 'terraformStack',
      resourceId: stack.id,
      resourceName: stack.name,
      message: 'Terraform stack ZIP replaced.',
    });
    return sanitizeStack(updated);
  } catch (error) {
    await rm(replacementDir, { recursive: true, force: true });
    await rm(nextZipPath, { force: true });
    throw error;
  }
}

async function getStackForRun(stackId) {
  const stacks = await readMetadata();
  const stack = stacks.find((item) => item.id === stackId);
  if (!stack) {
    const error = new Error('Terraform stack not found.');
    error.status = 404;
    throw error;
  }
  const root = stackDir(stackId);
  const workingDir = path.resolve(root, stack.workingDir || 'source');
  if (!workingDir.startsWith(root)) {
    const error = new Error('Terraform stack has an invalid working directory.');
    error.status = 400;
    throw error;
  }
  await access(workingDir);
  return { stack, workingDir };
}

export async function runTerraformStackAction({ stackId, action, user, confirmation }) {
  if (!['validate', 'plan', 'deploy', 'destroy'].includes(action)) {
    const error = new Error('Unsupported Terraform stack action.');
    error.status = 400;
    throw error;
  }

  const { stack, workingDir } = await getStackForRun(stackId);
  if ((action === 'deploy' || action === 'destroy') && confirmation !== stack.name && confirmation !== stack.id) {
    const error = new Error(`Type ${action === 'deploy' ? 'stack name' : 'stack name or ID'} to confirm ${action}.`);
    error.status = 400;
    throw error;
  }

  const binary = await terraformBinary();
  const startedAt = new Date().toISOString();
  const run = await createStackRun(stackId, {
    action,
    user,
    startedAt,
    message: `${action} started.`,
  });

  const output = [];
  const runStep = async (label, args) => {
    const commandLine = `$ ${binary} ${args.join(' ')}`;
    output.push(commandLine);
    await updateStackRun(stackId, run.id, { message: `${label} running.` }, [commandLine]);
    const result = await runRequiredCommand(binary, args, workingDir, terraformCommandTimeouts[label]);
    output.push(...result.output);
    await updateStackRun(stackId, run.id, { message: `${label} completed.` }, result.output);
    return result;
  };

  try {
    await runStep('init', ['init', '-input=false']);
    if (action === 'validate') {
      await runStep('validate', ['validate', '-no-color']);
    } else if (action === 'plan') {
      await runStep('validate', ['validate', '-no-color']);
      await runStep('plan', ['plan', '-input=false', '-no-color']);
    } else if (action === 'deploy') {
      await runStep('validate', ['validate', '-no-color']);
      await runStep('plan', ['plan', '-input=false', '-no-color', '-out=tfplan']);
      await runStep('apply', ['apply', '-input=false', '-no-color', '-auto-approve', 'tfplan']);
    } else {
      await runStep('destroy', ['destroy', '-input=false', '-no-color', '-auto-approve']);
    }

    const message = action === 'validate'
      ? 'Terraform stack initialized and validated.'
      : action === 'plan'
        ? 'Terraform plan completed.'
        : action === 'deploy'
          ? 'Terraform stack deployed.'
          : 'Terraform stack destroyed.';
    const updated = await updateStack(stackId, {
      status: 'succeeded',
      lastMessage: message,
      lastOutput: redactSecrets(output).slice(-maxOutputLines),
    });
    const updatedWithRun = await updateStackRun(stackId, run.id, {
      status: 'succeeded',
      message,
      finishedAt: new Date().toISOString(),
    });
    const job = await createJob({
      provider: 'proxmox',
      status: 'succeeded',
      action: `terraform.${action}`,
      resourceType: 'terraformStack',
      resourceId: stack.id,
      resourceName: stack.name,
      user,
      message,
      output: updatedWithRun.lastOutput.map((text, index) => ({ line: index + 1, text })),
      linkedResource: { provider: 'proxmox', type: 'terraformStack', id: stack.id, name: stack.name },
    });
    await appendAuditLog({
      action: `terraform-stack.${action}`,
      status: 'success',
      user,
      resourceType: 'terraformStack',
      resourceId: stack.id,
      resourceName: stack.name,
      taskId: job.upid,
      message,
    });
    return { stack: sanitizeStack(updatedWithRun), job };
  } catch (error) {
    const commandOutput = error.commandResult?.output || [];
    output.push(...commandOutput);
    const message = `${action} failed.`;
    const updated = await updateStack(stackId, {
      status: 'failed',
      lastMessage: error.message || message,
      lastOutput: redactSecrets(output).slice(-maxOutputLines),
    });
    const updatedWithRun = await updateStackRun(stackId, run.id, {
      status: 'failed',
      message: error.message || message,
      finishedAt: new Date().toISOString(),
    }, commandOutput);
    const job = await createJob({
      provider: 'proxmox',
      status: 'failed',
      action: `terraform.${action}`,
      resourceType: 'terraformStack',
      resourceId: stack.id,
      resourceName: stack.name,
      user,
      message: error.message || message,
      output: updatedWithRun.lastOutput.map((text, index) => ({ line: index + 1, text })),
      linkedResource: { provider: 'proxmox', type: 'terraformStack', id: stack.id, name: stack.name },
    });
    await appendAuditLog({
      action: `terraform-stack.${action}`,
      status: 'failed',
      user,
      resourceType: 'terraformStack',
      resourceId: stack.id,
      resourceName: stack.name,
      taskId: job.upid,
      message: error.message || message,
    });
    const responseError = new Error(error.message || message);
    responseError.status = error.status || 500;
    responseError.data = { stack: sanitizeStack(updatedWithRun), job };
    throw responseError;
  }
}

export async function deleteTerraformStack({ stackId, confirmation, user }) {
  const stacks = await readMetadata();
  const stack = stacks.find((item) => item.id === stackId);
  if (!stack) {
    const error = new Error('Terraform stack not found.');
    error.status = 404;
    throw error;
  }
  if (confirmation !== stack.name && confirmation !== stack.id) {
    const error = new Error('Type stack name or stack ID to confirm delete.');
    error.status = 400;
    throw error;
  }
  const target = stackDir(stackId);
  const root = path.resolve(stacksRoot());
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(root)) {
    const error = new Error('Invalid stack path.');
    error.status = 400;
    throw error;
  }
  try {
    const targetStat = await stat(resolvedTarget);
    if (targetStat.isDirectory()) {
      await rm(resolvedTarget, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  await writeMetadata(stacks.filter((item) => item.id !== stackId));
  await appendAuditLog({
    action: 'terraform-stack.delete',
    status: 'success',
    user,
    resourceType: 'terraformStack',
    resourceId: stack.id,
    resourceName: stack.name,
    message: 'Terraform stack deleted from MC3.',
  });
}
