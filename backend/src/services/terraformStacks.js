import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { appendAuditLog } from './auditLog.js';
import { createJob } from './jobStore.js';
import { redactSecrets } from '../utils/logger.js';

const metadataFileName = 'terraform-stacks.json';
const maxOutputLines = 1000;

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

function safeName(value) {
  return String(value || 'terraform-stack')
    .trim()
    .replace(/[^a-zA-Z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'terraform-stack';
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

function runCommand(command, args, cwd, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const lines = [];
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
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

async function runRequiredCommand(command, args, cwd) {
  const result = await runCommand(command, args, cwd);
  if (!result.success) {
    const error = new Error(`${command} ${args.join(' ')} failed.`);
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
    .filter((entry) => entry.isFile() && /\.(tf|tfvars|json)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function sanitizeStack(stack) {
  const { localPath: _localPath, zipPath: _zipPath, ...safe } = stack;
  return safe;
}

export async function listTerraformStacks() {
  const stacks = await readMetadata();
  return stacks.map(sanitizeStack).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
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
    const result = await runRequiredCommand(binary, args, workingDir);
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
