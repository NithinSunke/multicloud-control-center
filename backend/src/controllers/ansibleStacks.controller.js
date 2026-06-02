import {
  deleteAnsibleStack,
  importAnsibleStackFromGit,
  listAnsibleStacks,
  pullAnsibleStackFromGit,
  runAnsibleStack,
  uploadAnsibleStack,
  validateAnsibleStack,
} from '../services/ansibleStacks.js';
import { ensureAnsibleSshIdentity } from '../services/ansibleSshIdentity.js';

function currentUser(req) {
  return req.user?.username || req.user?.sub || 'admin';
}

export async function getAnsibleStacks(_req, res, next) {
  try {
    res.json({ data: { stacks: await listAnsibleStacks() } });
  } catch (error) {
    next(error);
  }
}

export async function getAnsibleSshIdentity(_req, res, next) {
  try {
    res.json({ data: { identity: await ensureAnsibleSshIdentity() } });
  } catch (error) {
    next(error);
  }
}

export async function uploadAnsibleStackArchive(req, res, next) {
  try {
    const stack = await uploadAnsibleStack({
      name: req.query.name,
      description: req.query.description,
      inventoryPath: req.query.inventoryPath,
      playbookPath: req.query.playbookPath,
      buffer: req.body,
      user: currentUser(req),
    });
    res.status(201).json({ data: { stack, message: 'Ansible stack uploaded.' } });
  } catch (error) {
    next(error);
  }
}

export async function importAnsibleStackGit(req, res, next) {
  try {
    const stack = await importAnsibleStackFromGit({
      name: req.body?.name,
      description: req.body?.description,
      repoUrl: req.body?.repoUrl,
      branch: req.body?.branch,
      gitPath: req.body?.path,
      inventoryPath: req.body?.inventoryPath,
      playbookPath: req.body?.playbookPath,
      githubConnectorId: req.body?.githubConnectorId,
      user: currentUser(req),
    });
    res.status(201).json({ data: { stack, message: 'Ansible stack imported from Git.' } });
  } catch (error) {
    next(error);
  }
}

export async function pullAnsibleStackGit(req, res, next) {
  try {
    const stack = await pullAnsibleStackFromGit({
      stackId: req.params.stackId,
      user: currentUser(req),
    });
    res.json({ data: { stack, message: 'Pulled latest Ansible stack from Git.' } });
  } catch (error) {
    next(error);
  }
}

export async function validateAnsibleStackSyntax(req, res, next) {
  try {
    const result = await validateAnsibleStack({
      stackId: req.params.stackId,
      user: currentUser(req),
    });
    res.json({ data: { ...result, message: result.stack.lastMessage } });
  } catch (error) {
    next(error);
  }
}

export async function runAnsibleStackPlaybook(req, res, next) {
  try {
    const result = await runAnsibleStack({
      stackId: req.params.stackId,
      user: currentUser(req),
    });
    res.json({ data: { ...result, message: result.stack.lastMessage } });
  } catch (error) {
    next(error);
  }
}

export async function removeAnsibleStack(req, res, next) {
  try {
    await deleteAnsibleStack({
      stackId: req.params.stackId,
      confirmation: req.body?.confirmation,
      user: currentUser(req),
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
