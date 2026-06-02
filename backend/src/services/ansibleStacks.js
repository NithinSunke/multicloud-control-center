import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { access, chmod, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { appendAuditLog } from './auditLog.js';
import { createJob } from './jobStore.js';
import { ensureAnsibleSshIdentity } from './ansibleSshIdentity.js';
import { getGithubConnectorForUse } from './connectorStore.js';
import { redactSecrets } from '../utils/logger.js';

const metadataFileName = 'ansible-stacks.json';
const maxOutputLines = 1000;

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function stacksRoot() {
  return path.join(dataDir(), 'ansible-stacks');
}

function metadataPath() {
  return path.join(stacksRoot(), metadataFileName);
}

function stackDir(stackId) {
  return path.join(stacksRoot(), stackId);
}

function safeName(value) {
  return String(value || 'ansible-stack')
    .trim()
    .replace(/[^a-zA-Z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'ansible-stack';
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
  if (!repoUrl || repoUrl.startsWith('-')) {
    const error = new Error('Git repository URL is required.');
    error.status = 400;
    throw error;
  }
  return repoUrl;
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

function sanitizeStack(stack) {
  const { localPath: _localPath, zipPath: _zipPath, ...safe } = stack;
  if (safe.git?.repoUrl) {
    safe.git = { ...safe.git, repoUrl: redactGitUrl(safe.git.repoUrl) };
  }
  return safe;
}

function appendRun(stack, run) {
  return [
    ...(Array.isArray(stack.runs) ? stack.runs : []),
    {
      id: randomUUID(),
      action: run.action,
      status: run.status,
      message: run.message,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || new Date().toISOString(),
      user: run.user || '',
      output: redactSecrets(run.output || []).slice(-maxOutputLines),
    },
  ].slice(-50);
}

function runCommand(command, args, cwd, timeoutMs = 15 * 60 * 1000, extraEnv = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const lines = [];
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...extraEnv, ANSIBLE_FORCE_COLOR: '0' },
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
      resolve({ success: false, exitCode: 1, output: [`Unable to run ${command}: ${error.message}`], durationMs: Date.now() - startedAt });
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
    const detail = redactSecrets(result.output || []).slice(-8).join(' ').trim();
    const error = new Error(detail ? `${command} failed: ${detail}` : `${command} ${args.join(' ')} failed.`);
    error.commandResult = result;
    throw error;
  }
  return result;
}

async function listZipEntries(zipPath) {
  const result = await runCommand('unzip', ['-Z1', zipPath], stacksRoot(), 60 * 1000);
  if (!result.success) {
    const error = new Error('Unable to inspect ZIP file. Confirm the file is a valid ZIP archive.');
    error.status = 400;
    throw error;
  }
  return result.output;
}

function validateZipEntries(entries) {
  const invalid = entries.find((entry) => {
    const normalized = entry.replace(/\\/g, '/');
    return normalized.startsWith('/') || normalized.includes('../') || normalized === '..' || /^[a-zA-Z]:/.test(normalized);
  });
  if (invalid) {
    const error = new Error(`ZIP contains an unsafe path: ${invalid}`);
    error.status = 400;
    throw error;
  }
}

async function writeUploadZip(zipPath, buffer) {
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(zipPath, { flags: 'wx' });
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(buffer);
  });
}

async function findFiles(root, predicate, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== '__MACOSX' && entry.name !== 'node_modules') {
        matches.push(...await findFiles(root, predicate, absolutePath));
      }
    } else if (entry.isFile() && predicate(entry.name, relativePath)) {
      matches.push(relativePath);
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

async function inspectAnsibleProject(workingDir, preferredInventoryPath = '', preferredPlaybookPath = '') {
  const playbooks = await findFiles(workingDir, (name, relativePath) =>
    /\.(ya?ml)$/i.test(name) && !relativePath.toLowerCase().includes('group_vars/') && !relativePath.toLowerCase().includes('host_vars/'));
  const inventories = await findFiles(workingDir, (name, relativePath) =>
    /(^|\/)(inventory|hosts)(\.(ini|ya?ml|json))?$/i.test(relativePath) || relativePath.toLowerCase().startsWith('inventories/'));
  const inventoryPath = sanitizeGitPath(preferredInventoryPath) || inventories[0] || '';
  const playbookPath = sanitizeGitPath(preferredPlaybookPath) || playbooks.find((item) => /(^|\/)(site|main)\.ya?ml$/i.test(item)) || playbooks[0] || '';
  if (!playbookPath && !playbooks.length) {
    const error = new Error('Ansible stack does not contain any YAML playbooks.');
    error.status = 400;
    throw error;
  }
  if (inventoryPath) {
    await access(path.resolve(workingDir, inventoryPath));
  }
  if (playbookPath) {
    await access(path.resolve(workingDir, playbookPath));
  }
  return { playbooks, inventories, inventoryPath, playbookPath };
}

async function normalizedInventoryPath(stackId, workingDir, inventoryPath, playbookPath = '') {
  if (!inventoryPath) {
    return '';
  }
  const safeInventoryPath = sanitizeGitPath(inventoryPath);
  const sourcePath = path.resolve(workingDir, safeInventoryPath);
  if (!sourcePath.startsWith(path.resolve(workingDir))) {
    const error = new Error('Ansible inventory path escapes the stack working directory.');
    error.status = 400;
    throw error;
  }
  const lowerPath = safeInventoryPath.toLowerCase();
  const isIniInventory = lowerPath.endsWith('.ini') || /(^|\/)(inventory|hosts)$/i.test(safeInventoryPath);
  if (!isIniInventory) {
    return safeInventoryPath;
  }

  let content = await readFile(sourcePath, 'utf8');
  let changed = false;
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
    changed = true;
  }

  const varsByGroup = new Map();
  const outputLines = [];
  const inventoryGroups = new Set();
  let currentGroup = '';
  for (const line of content.split(/\r?\n/)) {
    const groupMatch = line.trim().match(/^\[([^\]]+)]$/);
    if (groupMatch) {
      currentGroup = groupMatch[1].trim();
      if (currentGroup && !currentGroup.includes(':')) {
        inventoryGroups.add(currentGroup);
      }
      outputLines.push(line.replace(/^\uFEFF/, ''));
      continue;
    }
    const varMatch = line.trim().match(/^(ansible_[A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (varMatch && currentGroup && !currentGroup.includes(':')) {
      const groupVars = varsByGroup.get(currentGroup) || [];
      groupVars.push(`${varMatch[1]}=${varMatch[2]}`);
      varsByGroup.set(currentGroup, groupVars);
      changed = true;
      continue;
    }
    outputLines.push(line.replace(/^\uFEFF/, ''));
  }

  const existingHeaders = new Set(outputLines
    .map((line) => line.trim().match(/^\[([^\]]+)]$/)?.[1])
    .filter(Boolean));
  const safePlaybookPath = playbookPath ? sanitizeGitPath(playbookPath) : '';
  if (safePlaybookPath && inventoryGroups.size === 1) {
    try {
      const playbookContent = await readFile(path.resolve(workingDir, safePlaybookPath), 'utf8');
      const hostsGroup = playbookContent.match(/^\s*hosts:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/m)?.[1];
      if (hostsGroup && !['all', 'localhost'].includes(hostsGroup) && !inventoryGroups.has(hostsGroup) && !existingHeaders.has(`${hostsGroup}:children`)) {
        outputLines.push('', `[${hostsGroup}:children]`, [...inventoryGroups][0]);
        existingHeaders.add(`${hostsGroup}:children`);
        changed = true;
      }
    } catch {
      // Playbook host aliasing is best effort; normal Ansible validation will report any real issue.
    }
  }
  for (const [group, vars] of varsByGroup) {
    const header = `${group}:vars`;
    if (!existingHeaders.has(header)) {
      outputLines.push('', `[${header}]`);
    }
    outputLines.push(...vars);
  }

  if (!changed) {
    return safeInventoryPath;
  }

  const targetPath = path.join(stackDir(stackId), '.mc3-normalized-inventory.ini');
  await writeFile(targetPath, `${outputLines.join('\n').trimEnd()}\n`, 'utf8');
  return targetPath;
}

async function resolveGitWorkingDir(repoDir, gitPath) {
  const normalizedPath = sanitizeGitPath(gitPath);
  const workingDir = normalizedPath ? path.resolve(repoDir, normalizedPath) : repoDir;
  if (!workingDir.startsWith(path.resolve(repoDir))) {
    const error = new Error('Git stack path escapes the repository.');
    error.status = 400;
    throw error;
  }
  await access(workingDir);
  return workingDir;
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

export async function listAnsibleStacks() {
  const stacks = await readMetadata();
  return stacks.map(sanitizeStack).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function uploadAnsibleStack({ name, description, buffer, inventoryPath, playbookPath, user }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error('Upload a non-empty Ansible ZIP file.');
    error.status = 400;
    throw error;
  }
  const stackId = randomUUID();
  const now = new Date().toISOString();
  const targetDir = stackDir(stackId);
  const extractDir = path.join(targetDir, 'source');
  const zipPath = path.join(targetDir, 'upload.zip');
  await mkdir(extractDir, { recursive: true });
  try {
    await writeUploadZip(zipPath, buffer);
    const entries = await listZipEntries(zipPath);
    validateZipEntries(entries);
    const unzipResult = await runCommand('unzip', ['-q', zipPath, '-d', extractDir], targetDir, 120 * 1000);
    if (!unzipResult.success) {
      const error = new Error('Unable to extract Ansible ZIP file.');
      error.status = 400;
      throw error;
    }
    const project = await inspectAnsibleProject(extractDir, inventoryPath, playbookPath);
    const stack = {
      id: stackId,
      name: safeName(name),
      description: String(description || '').trim(),
      status: 'uploaded',
      lastAction: 'upload',
      lastMessage: 'Ansible stack uploaded.',
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: user || 'admin',
      sourceType: 'upload',
      localPath: targetDir,
      zipPath,
      workingDir: 'source',
      playbooks: project.playbooks,
      inventories: project.inventories,
      inventoryPath: project.inventoryPath,
      playbookPath: project.playbookPath,
      lastOutput: [],
      runs: [],
    };
    const stacks = await readMetadata();
    stacks.push(stack);
    await writeMetadata(stacks);
    await appendAuditLog({ action: 'ansible-stack.upload', status: 'success', user, resourceType: 'ansibleStack', resourceId: stack.id, resourceName: stack.name, message: 'Ansible stack uploaded.' });
    return sanitizeStack(stack);
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}

export async function importAnsibleStackFromGit({ name, description, repoUrl, branch, gitPath, inventoryPath, playbookPath, githubConnectorId, user }) {
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
    const project = await inspectAnsibleProject(workingDir, inventoryPath, playbookPath);
    const stack = {
      id: stackId,
      name: safeName(name),
      description: String(description || '').trim(),
      status: 'uploaded',
      lastAction: 'git-import',
      lastMessage: 'Ansible stack imported from Git.',
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
      playbooks: project.playbooks,
      inventories: project.inventories,
      inventoryPath: project.inventoryPath,
      playbookPath: project.playbookPath,
      lastOutput: [],
      runs: [],
    };
    const stacks = await readMetadata();
    stacks.push(stack);
    await writeMetadata(stacks);
    await appendAuditLog({ action: 'ansible-stack.git-import', status: 'success', user, resourceType: 'ansibleStack', resourceId: stack.id, resourceName: stack.name, message: 'Ansible stack imported from Git.' });
    return sanitizeStack(stack);
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}

export async function pullAnsibleStackFromGit({ stackId, user }) {
  const stacks = await readMetadata();
  const index = stacks.findIndex((item) => item.id === stackId);
  if (index < 0) {
    const error = new Error('Ansible stack not found.');
    error.status = 404;
    throw error;
  }
  const stack = stacks[index];
  if (stack.sourceType !== 'git' || !stack.git?.repoUrl) {
    const error = new Error('Only Git-backed Ansible stacks can pull latest.');
    error.status = 400;
    throw error;
  }
  const repoDir = path.join(stackDir(stackId), 'repo');
  const branch = validateGitRef(stack.git.branch);
  const githubConnector = stack.git.githubConnectorId ? await getGithubConnectorForUse(stack.git.githubConnectorId) : null;
  await gitPullLatest({ repoDir, branch, connector: githubConnector });
  const workingDir = await resolveGitWorkingDir(repoDir, sanitizeGitPath(stack.git.path));
  const project = await inspectAnsibleProject(workingDir, stack.inventoryPath, stack.playbookPath);
  const updated = {
    ...stack,
    status: 'uploaded',
    lastAction: 'git-pull',
    lastMessage: 'Pulled latest Ansible stack from Git.',
    lastOutput: [],
    updatedAt: new Date().toISOString(),
    workingDir: path.relative(stackDir(stackId), workingDir),
    playbooks: project.playbooks,
    inventories: project.inventories,
    inventoryPath: project.inventoryPath,
    playbookPath: project.playbookPath,
  };
  stacks[index] = updated;
  await writeMetadata(stacks);
  await appendAuditLog({ action: 'ansible-stack.git-pull', status: 'success', user, resourceType: 'ansibleStack', resourceId: stack.id, resourceName: stack.name, message: 'Pulled latest Ansible stack from Git.' });
  return sanitizeStack(updated);
}

export async function validateAnsibleStack({ stackId, user }) {
  const stacks = await readMetadata();
  const index = stacks.findIndex((item) => item.id === stackId);
  if (index < 0) {
    const error = new Error('Ansible stack not found.');
    error.status = 404;
    throw error;
  }
  const stack = stacks[index];
  const workingDir = path.resolve(stackDir(stackId), stack.workingDir || 'source');
  if (!workingDir.startsWith(stackDir(stackId))) {
    const error = new Error('Ansible stack has an invalid working directory.');
    error.status = 400;
    throw error;
  }
  const args = [];
  const inventoryForRun = await normalizedInventoryPath(stackId, workingDir, stack.inventoryPath, stack.playbookPath);
  if (inventoryForRun) {
    args.push('-i', inventoryForRun);
  }
  args.push('--syntax-check', stack.playbookPath);
  const sshIdentity = await ensureAnsibleSshIdentity();
  const startedAt = new Date().toISOString();
  const result = await runCommand('ansible-playbook', args, workingDir, 15 * 60 * 1000, {
    ANSIBLE_PRIVATE_KEY_FILE: sshIdentity.privateKeyPath,
  });
  const ok = result.success;
  const output = redactSecrets(result.output || []).slice(-maxOutputLines);
  const message = ok ? 'Ansible syntax check completed.' : 'Ansible syntax check failed.';
  const updated = {
    ...stack,
    status: ok ? 'succeeded' : 'failed',
    lastAction: 'syntax-check',
    lastMessage: message,
    lastRunAt: new Date().toISOString(),
    lastOutput: output,
    runs: appendRun(stack, {
      action: 'syntax-check',
      status: ok ? 'succeeded' : 'failed',
      message,
      startedAt,
      user,
      output,
    }),
    updatedAt: new Date().toISOString(),
  };
  stacks[index] = updated;
  await writeMetadata(stacks);
  const job = await createJob({
    provider: 'proxmox',
    status: ok ? 'succeeded' : 'failed',
    action: 'ansible.syntax-check',
    resourceType: 'ansibleStack',
    resourceId: stack.id,
    resourceName: stack.name,
    user,
    message: updated.lastMessage,
    output: output.map((text, line) => ({ line: line + 1, text })),
    linkedResource: { provider: 'proxmox', type: 'ansibleStack', id: stack.id, name: stack.name },
  });
  await appendAuditLog({ action: 'ansible-stack.syntax-check', status: ok ? 'success' : 'failed', user, resourceType: 'ansibleStack', resourceId: stack.id, resourceName: stack.name, taskId: job.upid, message: updated.lastMessage });
  if (!ok) {
    const error = new Error(updated.lastMessage);
    error.status = 400;
    error.data = { stack: sanitizeStack(updated), job };
    throw error;
  }
  return { stack: sanitizeStack(updated), job };
}

export async function runAnsibleStack({ stackId, user }) {
  const stacks = await readMetadata();
  const index = stacks.findIndex((item) => item.id === stackId);
  if (index < 0) {
    const error = new Error('Ansible stack not found.');
    error.status = 404;
    throw error;
  }
  const stack = stacks[index];
  const workingDir = path.resolve(stackDir(stackId), stack.workingDir || 'source');
  if (!workingDir.startsWith(stackDir(stackId))) {
    const error = new Error('Ansible stack has an invalid working directory.');
    error.status = 400;
    throw error;
  }
  const args = [];
  const inventoryForRun = await normalizedInventoryPath(stackId, workingDir, stack.inventoryPath, stack.playbookPath);
  if (inventoryForRun) {
    args.push('-i', inventoryForRun);
  }
  args.push(stack.playbookPath);
  const sshIdentity = await ensureAnsibleSshIdentity();
  const startedAt = new Date().toISOString();
  const result = await runCommand('ansible-playbook', args, workingDir, 30 * 60 * 1000, {
    ANSIBLE_PRIVATE_KEY_FILE: sshIdentity.privateKeyPath,
    ANSIBLE_HOST_KEY_CHECKING: 'False',
  });
  const ok = result.success;
  const output = redactSecrets(result.output || []).slice(-maxOutputLines);
  const message = ok ? 'Ansible playbook completed.' : 'Ansible playbook failed.';
  const updated = {
    ...stack,
    status: ok ? 'succeeded' : 'failed',
    lastAction: 'run-playbook',
    lastMessage: message,
    lastRunAt: new Date().toISOString(),
    lastOutput: output,
    runs: appendRun(stack, {
      action: 'run-playbook',
      status: ok ? 'succeeded' : 'failed',
      message,
      startedAt,
      user,
      output,
    }),
    updatedAt: new Date().toISOString(),
  };
  stacks[index] = updated;
  await writeMetadata(stacks);
  const job = await createJob({
    provider: 'proxmox',
    status: ok ? 'succeeded' : 'failed',
    action: 'ansible.run-playbook',
    resourceType: 'ansibleStack',
    resourceId: stack.id,
    resourceName: stack.name,
    user,
    message: updated.lastMessage,
    output: output.map((text, line) => ({ line: line + 1, text })),
    linkedResource: { provider: 'proxmox', type: 'ansibleStack', id: stack.id, name: stack.name },
  });
  await appendAuditLog({ action: 'ansible-stack.run-playbook', status: ok ? 'success' : 'failed', user, resourceType: 'ansibleStack', resourceId: stack.id, resourceName: stack.name, taskId: job.upid, message: updated.lastMessage });
  if (!ok) {
    const error = new Error(updated.lastMessage);
    error.status = 400;
    error.data = { stack: sanitizeStack(updated), job };
    throw error;
  }
  return { stack: sanitizeStack(updated), job };
}

export async function deleteAnsibleStack({ stackId, confirmation, user }) {
  const stacks = await readMetadata();
  const stack = stacks.find((item) => item.id === stackId);
  if (!stack) {
    const error = new Error('Ansible stack not found.');
    error.status = 404;
    throw error;
  }
  if (confirmation !== stack.name && confirmation !== stack.id) {
    const error = new Error('Type stack name or stack ID to confirm delete.');
    error.status = 400;
    throw error;
  }
  await rm(stackDir(stackId), { recursive: true, force: true });
  await writeMetadata(stacks.filter((item) => item.id !== stackId));
  await appendAuditLog({ action: 'ansible-stack.delete', status: 'success', user, resourceType: 'ansibleStack', resourceId: stack.id, resourceName: stack.name, message: 'Ansible stack deleted from MC3.' });
}
