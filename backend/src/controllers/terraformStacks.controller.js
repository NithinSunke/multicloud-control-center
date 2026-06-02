import {
  deleteTerraformStack,
  downloadTerraformStack,
  importTerraformStackFromGit,
  listTerraformStacks,
  pullTerraformStackFromGit,
  replaceTerraformStackArchive,
  runTerraformStackAction,
  uploadTerraformStack,
} from '../services/terraformStacks.js';

function currentUser(req) {
  return req.user?.username || req.user?.sub || 'admin';
}

export async function getTerraformStacks(_req, res, next) {
  try {
    const stacks = await listTerraformStacks();
    res.json({ data: { stacks } });
  } catch (error) {
    next(error);
  }
}

export async function uploadTerraformStackArchive(req, res, next) {
  try {
    const stack = await uploadTerraformStack({
      name: req.query.name,
      description: req.query.description,
      buffer: req.body,
      user: currentUser(req),
    });
    res.status(201).json({ data: { stack, message: 'Terraform stack uploaded.' } });
  } catch (error) {
    next(error);
  }
}

export async function reuploadTerraformStackArchive(req, res, next) {
  try {
    const stack = await replaceTerraformStackArchive({
      stackId: req.params.stackId,
      buffer: req.body,
      user: currentUser(req),
    });
    res.json({ data: { stack, message: 'Terraform stack ZIP replaced.' } });
  } catch (error) {
    next(error);
  }
}

export async function importTerraformStackGit(req, res, next) {
  try {
    const stack = await importTerraformStackFromGit({
      name: req.body?.name,
      description: req.body?.description,
      repoUrl: req.body?.repoUrl,
      branch: req.body?.branch,
      gitPath: req.body?.path,
      githubConnectorId: req.body?.githubConnectorId,
      user: currentUser(req),
    });
    res.status(201).json({ data: { stack, message: 'Terraform stack imported from Git.' } });
  } catch (error) {
    next(error);
  }
}

export async function pullTerraformStackGit(req, res, next) {
  try {
    const stack = await pullTerraformStackFromGit({
      stackId: req.params.stackId,
      user: currentUser(req),
    });
    res.json({ data: { stack, message: 'Pulled latest Terraform stack from Git.' } });
  } catch (error) {
    next(error);
  }
}

export async function downloadTerraformStackArchive(req, res, next) {
  try {
    const archive = await downloadTerraformStack({ stackId: req.params.stackId });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.fileName}"`);
    res.setHeader('Content-Length', String(archive.buffer.length));
    res.send(archive.buffer);
  } catch (error) {
    next(error);
  }
}

export async function validateTerraformStack(req, res, next) {
  try {
    const result = await runTerraformStackAction({
      stackId: req.params.stackId,
      action: 'validate',
      user: currentUser(req),
    });
    res.json({ data: { ...result, message: result.stack.lastMessage } });
  } catch (error) {
    next(error);
  }
}

export async function planTerraformStack(req, res, next) {
  try {
    const result = await runTerraformStackAction({
      stackId: req.params.stackId,
      action: 'plan',
      user: currentUser(req),
    });
    res.json({ data: { ...result, message: result.stack.lastMessage } });
  } catch (error) {
    next(error);
  }
}

export async function deployTerraformStack(req, res, next) {
  try {
    const result = await runTerraformStackAction({
      stackId: req.params.stackId,
      action: 'deploy',
      confirmation: req.body?.confirmation,
      user: currentUser(req),
    });
    res.json({ data: { ...result, message: result.stack.lastMessage } });
  } catch (error) {
    next(error);
  }
}

export async function destroyTerraformStack(req, res, next) {
  try {
    const result = await runTerraformStackAction({
      stackId: req.params.stackId,
      action: 'destroy',
      confirmation: req.body?.confirmation,
      user: currentUser(req),
    });
    res.json({ data: { ...result, message: result.stack.lastMessage } });
  } catch (error) {
    next(error);
  }
}

export async function removeTerraformStack(req, res, next) {
  try {
    await deleteTerraformStack({
      stackId: req.params.stackId,
      confirmation: req.body?.confirmation,
      user: currentUser(req),
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
