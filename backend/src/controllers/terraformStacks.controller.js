import {
  deleteTerraformStack,
  listTerraformStacks,
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
