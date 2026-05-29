import {
  createConnector,
  deleteConnector,
  getConnectorForUse,
  listConnectors,
  selectConnector,
  updateConnector,
  updateConnectorVerification,
} from '../services/connectorStore.js';
import { appendAuditLog } from '../services/auditLog.js';
import { verifyAwsConnector } from '../services/awsVerifier.js';
import { verifyAzureConnector } from '../services/azureVerifier.js';
import { verifyGcpConnector } from '../services/gcpVerifier.js';
import { verifyOciConnector } from '../services/ociVerifier.js';
import { verifyProxmoxConnector } from '../services/proxmoxVerifier.js';
import { logger } from '../utils/logger.js';

function handleError(error, req, res) {
  logger.error('connector_request_failed', {
    requestId: req.id,
    path: req.originalUrl,
    statusCode: error.statusCode || 500,
    error: { message: error.message },
  });
  res.status(error.statusCode || 500).json({
    message: error.statusCode ? error.message : 'Unable to process connector request.',
    requestId: req.id,
  });
}

export async function getConnectors(req, res) {
  try {
    res.json(await listConnectors());
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function addConnector(req, res) {
  try {
    const connector = await createConnector(req.body);
    await appendAuditLog({
      action: 'connector-create',
      status: 'succeeded',
      connectorId: connector.id,
      connectorName: connector.name,
      provider: connector.provider || 'proxmox',
      authType: connector.authType,
      user: req.user?.username || 'unknown',
      requestId: req.id,
    });
    res.status(201).json({ connector });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function editConnector(req, res) {
  try {
    const connector = await updateConnector(req.params.id, req.body);
    await appendAuditLog({
      action: 'connector-update',
      status: 'succeeded',
      connectorId: connector.id,
      connectorName: connector.name,
      provider: connector.provider || 'proxmox',
      authType: connector.authType,
      user: req.user?.username || 'unknown',
      requestId: req.id,
    });
    res.json({ connector });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function removeConnector(req, res) {
  try {
    const connector = await getConnectorForUse(req.params.id);
    const confirmation = String(req.body?.confirmation || '').trim();
    if (confirmation !== connector.id && confirmation !== String(connector.name || '').trim()) {
      const error = new Error('Type the connector name or ID to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }
    await deleteConnector(req.params.id);
    await appendAuditLog({
      action: 'connector-delete',
      status: 'succeeded',
      connectorId: req.params.id,
      connectorName: connector.name,
      provider: connector.provider || 'proxmox',
      user: req.user?.username || 'unknown',
      requestId: req.id,
    });
    res.status(204).send();
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function chooseConnector(req, res) {
  try {
    res.json({ connector: await selectConnector(req.params.id) });
  } catch (error) {
    handleError(error, req, res);
  }
}

export async function verifyConnector(req, res) {
  try {
    const connector = await getConnectorForUse(req.params.id);
    const result = connector.provider === 'oci'
      ? await verifyOciConnector(connector)
      : connector.provider === 'aws'
        ? await verifyAwsConnector(connector)
        : connector.provider === 'azure'
          ? await verifyAzureConnector(connector)
          : connector.provider === 'gcp'
            ? await verifyGcpConnector(connector)
            : await verifyProxmoxConnector(connector);
    const publicConnector = await updateConnectorVerification(req.params.id, result);
    await appendAuditLog({
      action: 'connector-verify',
      status: result.ok ? 'succeeded' : 'failed',
      connectorId: publicConnector.id,
      connectorName: publicConnector.name,
      provider: publicConnector.provider || 'proxmox',
      message: result.message,
      user: req.user?.username || 'unknown',
      requestId: req.id,
    });
    res.json({ connector: publicConnector, result });
  } catch (error) {
    handleError(error, req, res);
  }
}
