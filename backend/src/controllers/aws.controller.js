import { getSelectedAwsConnectorForUse } from '../services/connectorStore.js';
import { appendAuditLog } from '../services/auditLog.js';
import { createJob, listJobs } from '../services/jobStore.js';
import {
  attachAwsVolume,
  changeAwsInstanceType,
  createAwsBucket,
  createAwsImage,
  createAwsInstance,
  createAwsInternetGateway,
  createAwsKeyPair,
  createAwsNatGateway,
  createAwsRouteTable,
  createAwsRdsInstance,
  createAwsRdsSnapshot,
  createAwsSnapshot,
  createAwsSubnet,
  createAwsVolume,
  createAwsVpc,
  deleteAwsBucket,
  deleteAwsBucketObject,
  deleteAwsInternetGateway,
  deleteAwsNatGateway,
  deleteAwsRouteTable,
  deleteAwsRdsInstance,
  deleteAwsRdsSnapshot,
  deleteAwsSnapshot,
  deleteAwsSubnet,
  deleteAwsVolume,
  deleteAwsVpc,
  describeAwsInstance,
  describeAwsRdsInstance,
  describeAwsRouteTable,
  detachAwsVolume,
  getAwsBucketObject,
  getAwsInventory,
  listAwsImages,
  listAwsBucketObjects,
  listAwsKeyPairs,
  listAwsRdsSnapshots,
  putAwsBucketObject,
  restoreAwsRdsInstanceFromSnapshot,
  runAwsRdsInstanceAction,
  runAwsInstanceAction,
  resizeAwsVolume,
  updateAwsSecurityGroupRule,
  updateAwsBucketVersioning,
} from '../services/awsApiClient.js';
import {
  getCachedAwsInventory,
  removeCachedAwsBucket,
  removeCachedAwsNetworkResource,
  removeCachedAwsRdsDatabase,
  removeCachedAwsSnapshot,
  removeCachedAwsVolume,
  setCachedAwsInventory,
  updateCachedAwsBucket,
  updateCachedAwsInstance,
  updateCachedAwsNetworkResource,
  updateCachedAwsRdsDatabase,
  updateCachedAwsSnapshot,
  updateCachedAwsVolume,
} from '../services/awsInventoryCache.js';
import { logger } from '../utils/logger.js';

function normalizedRegion(value) {
  const region = String(value || '').trim();
  return region && region !== 'all' ? region : 'all';
}

function auditUser(req) {
  return req.user?.username || 'unknown';
}

function handleAwsError(error, req, res) {
  logger.error('aws_request_failed', {
    requestId: req.id,
    path: req.originalUrl,
    statusCode: error.statusCode || 500,
    error: { message: error.message },
  });
  res.status(error.statusCode || 500).json({
    message: error.statusCode ? error.message : 'Unable to process AWS request.',
    requestId: req.id,
  });
}

function assertVerifiedConnector(connector) {
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected AWS connector before loading inventory.');
    error.statusCode = 400;
    throw error;
  }
}

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${label} is required.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

async function auditAws(entry, req) {
  await appendAuditLog({
    provider: 'aws',
    user: auditUser(req),
    ...entry,
  }).catch(() => undefined);
  await createJob(buildAwsJobEntry(entry, req)).catch(() => undefined);
}

function awsResourceTypeFromAction(action = '') {
  if (action.includes('rds')) {
    return action.includes('snapshot') ? 'rdsSnapshot' : 'rdsDatabase';
  }
  if (action.includes('s3')) {
    return action.includes('object') ? 's3Object' : 's3Bucket';
  }
  if (action.includes('ebs')) {
    return action.includes('snapshot') ? 'ebsSnapshot' : 'ebsVolume';
  }
  if (action.includes('vpc')) {
    return 'vpc';
  }
  if (action.includes('subnet')) {
    return 'subnet';
  }
  if (action.includes('route-table')) {
    return 'routeTable';
  }
  if (action.includes('internet-gateway')) {
    return 'internetGateway';
  }
  if (action.includes('nat-gateway')) {
    return 'natGateway';
  }
  if (action.includes('security-group')) {
    return 'securityGroup';
  }
  if (action.includes('key-pair')) {
    return 'keyPair';
  }
  return 'ec2Instance';
}

function awsResourceLabel(type, entry) {
  return entry.resourceName || entry.resourceId || entry.imageId || entry.snapshotId || entry.volumeId || entry.instanceId || entry.bucketName || entry.objectKey || type;
}

function buildAwsJobEntry(entry, req) {
  const resourceType = entry.resourceType || awsResourceTypeFromAction(entry.action);
  const resourceId = entry.resourceId || entry.imageId || entry.snapshotId || entry.volumeId || entry.instanceId || entry.bucketName || entry.objectKey || '';
  const resourceName = awsResourceLabel(resourceType, entry);
  const output = [
    entry.message ? { line: 1, text: entry.message } : null,
    entry.status === 'failed' && entry.message ? { line: 2, text: `ERROR: ${entry.message}` } : null,
  ].filter(Boolean);
  return {
    provider: 'aws',
    user: auditUser(req),
    connectorId: entry.connectorId,
    region: entry.region,
    action: entry.action,
    type: entry.action,
    resourceType,
    resourceId,
    resourceName,
    status: entry.status,
    message: entry.message,
    errorMessage: entry.status === 'failed' ? entry.message : '',
    description: `${entry.action} ${resourceName}`.trim(),
    linkedResource: {
      provider: 'aws',
      type: resourceType,
      id: resourceId,
      name: resourceName,
      region: entry.region || '',
    },
    retryable: false,
    cancelable: false,
    output,
    metadata: {
      imageId: entry.imageId,
      snapshotId: entry.snapshotId,
      volumeId: entry.volumeId,
      instanceId: entry.instanceId,
      bucketName: entry.bucketName,
      objectKey: entry.objectKey,
      sizeGb: entry.sizeGb,
      dbInstanceIdentifier: entry.dbInstanceIdentifier,
    },
  };
}

export async function getJobs(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const jobs = await listJobs({ provider: 'aws', limit });
    res.json({ data: { generatedAt: new Date().toISOString(), tasks: jobs } });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

function emptyCachedInventory(connector, region) {
  const now = new Date().toISOString();
  return {
    generatedAt: now,
    cached: true,
    cacheMiss: true,
    connector: {
      id: connector.id,
      name: connector.name,
      region: connector.region,
      accountId: connector.awsAccountId || '',
    },
    scan: {
      requestedRegion: region,
      scannedRegions: [],
    },
    summary: {
      regions: 0,
      instances: 0,
      runningInstances: 0,
      stoppedInstances: 0,
      vpcs: 0,
      subnets: 0,
      securityGroups: 0,
      routeTables: 0,
      internetGateways: 0,
      natGateways: 0,
      ebsVolumes: 0,
      ebsSnapshots: 0,
      s3Buckets: 0,
      rdsDatabases: 0,
      loadBalancers: 0,
      elasticIps: 0,
    },
    regions: [],
    instances: [],
    vpcs: [],
    subnets: [],
    securityGroups: [],
    routeTables: [],
    internetGateways: [],
    natGateways: [],
    ebsVolumes: [],
    ebsSnapshots: [],
    s3Buckets: [],
    rdsDatabases: [],
    loadBalancers: [],
    elasticIps: [],
    iamSummary: {},
    errors: [],
  };
}

export async function getInventory(req, res) {
  const region = normalizedRegion(req.query.region);
  const refresh = String(req.query.refresh || '').toLowerCase() === 'true';

  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);

    if (!refresh) {
      const cached = await getCachedAwsInventory(connector.id, region);
      if (cached) {
        res.json({
          data: {
            ...cached,
            generatedAt: new Date().toISOString(),
            cached: true,
            cacheMiss: false,
          },
        });
        return;
      }
      res.json({ data: emptyCachedInventory(connector, region) });
      return;
    }

    const data = await getAwsInventory(connector, { region });
    const cached = await setCachedAwsInventory(connector.id, region, {
      ...data,
      cached: false,
    });

    await auditAws({
      action: 'aws-inventory-scan',
      status: data.errors?.length ? 'completed-with-warnings' : 'succeeded',
      connectorId: connector.id,
      connectorName: connector.name,
      region,
      resourceCount: Object.values(data.summary || {}).reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0),
      message: data.errors?.length ? `Scan loaded with ${data.errors.length} warnings.` : 'AWS inventory scan completed.',
    }, req);

    res.json({ data: { ...cached, cached: false } });
  } catch (error) {
    await auditAws({
      action: 'aws-inventory-scan',
      status: 'failed',
      region,
      message: error.message,
    }, req);
    handleAwsError(error, req, res);
  }
}

export async function createInstance(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAwsInstance(connector, req.body || {});
    await updateCachedAwsInstance(connector.id, data.instance, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ec2-create', status: 'submitted', connectorId: connector.id, region: req.body?.region, resourceId: data.instance?.id, resourceName: data.instance?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ec2-create', status: 'failed', region: req.body?.region, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function getImages(req, res) {
  const region = String(req.query.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await listAwsImages(connector, {
      region: requireText(region, 'Region'),
      search: req.query.search,
    });
    res.json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ec2-list-images', status: 'failed', region, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function getKeyPairs(req, res) {
  const region = String(req.query.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await listAwsKeyPairs(connector, {
      region: requireText(region, 'Region'),
    });
    res.json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ec2-list-key-pairs', status: 'failed', region, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function createKeyPair(req, res) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAwsKeyPair(connector, {
      region: requireText(region, 'Region'),
      name: req.body?.name,
    });
    await auditAws({
      action: 'aws-ec2-create-key-pair',
      status: 'succeeded',
      connectorId: connector.id,
      region,
      resourceId: data.keyPair?.id,
      resourceName: data.keyPair?.name,
      message: 'AWS key pair created.',
    }, req);
    res.status(201).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ec2-create-key-pair', status: 'failed', region, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function runInstanceAction(req, res) {
  const action = String(req.params.action || '').toLowerCase();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await runAwsInstanceAction(connector, {
      region,
      instanceId: req.params.instanceId,
      action,
    });
    await updateCachedAwsInstance(connector.id, data.instance, [req.body?.scanRegion]);
    await auditAws({ action: `aws-ec2-${action}`, status: 'submitted', connectorId: connector.id, region, resourceId: req.params.instanceId, resourceName: req.body?.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: `aws-ec2-${action}`, status: 'failed', region: req.body?.region, resourceId: req.params.instanceId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function getInstanceStatus(req, res) {
  const region = String(req.query.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const instance = await describeAwsInstance(connector, {
      region: requireText(region, 'Region'),
      instanceId: req.params.instanceId,
    });
    await updateCachedAwsInstance(connector.id, instance, [req.query.scanRegion]);
    res.json({ data: { generatedAt: new Date().toISOString(), instance } });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

export async function getRouteTable(req, res) {
  const region = String(req.query.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const routeTable = await describeAwsRouteTable(connector, {
      region: requireText(region, 'Region'),
      routeTableId: req.params.routeTableId,
    });
    await updateCachedAwsNetworkResource(connector.id, routeTable, [req.query.scanRegion]);
    res.json({ data: { generatedAt: new Date().toISOString(), routeTable } });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

export async function getRdsInstance(req, res) {
  const region = String(req.query.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const database = await describeAwsRdsInstance(connector, {
      region: requireText(region, 'Region'),
      dbInstanceIdentifier: req.params.dbInstanceIdentifier,
    });
    await updateCachedAwsRdsDatabase(connector.id, database, [req.query.scanRegion]);
    res.json({ data: { generatedAt: new Date().toISOString(), database } });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

export async function getRdsSnapshots(req, res) {
  const region = String(req.query.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await listAwsRdsSnapshots(connector, {
      region: requireText(region, 'Region'),
      dbInstanceIdentifier: req.query.dbInstanceIdentifier,
      snapshotType: req.query.snapshotType || 'manual',
    });
    res.json({ data });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

export async function createRdsInstance(req, res) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAwsRdsInstance(connector, { ...req.body, region: requireText(region, 'Region') });
    await updateCachedAwsRdsDatabase(connector.id, data.database, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-rds-create', status: 'submitted', connectorId: connector.id, region, resourceId: data.database?.id, resourceName: data.database?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-rds-create', status: 'failed', region, resourceName: req.body?.dbInstanceIdentifier, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function runRdsAction(req, res) {
  const action = String(req.params.action || '').toLowerCase();
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await runAwsRdsInstanceAction(connector, {
      region: requireText(region, 'Region'),
      dbInstanceIdentifier: req.params.dbInstanceIdentifier,
      action,
    });
    await updateCachedAwsRdsDatabase(connector.id, data.database, [req.body?.scanRegion]);
    await auditAws({ action: `aws-rds-${action}`, status: 'submitted', connectorId: connector.id, region, resourceId: req.params.dbInstanceIdentifier, resourceName: req.body?.dbInstanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: `aws-rds-${action}`, status: 'failed', region, resourceId: req.params.dbInstanceIdentifier, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function createRdsSnapshot(req, res) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await createAwsRdsSnapshot(connector, {
      region: requireText(region, 'Region'),
      dbInstanceIdentifier: req.params.dbInstanceIdentifier,
      snapshotIdentifier: req.body?.snapshotIdentifier,
    });
    await auditAws({ action: 'aws-rds-create-snapshot', status: 'submitted', connectorId: connector.id, region, resourceId: data.snapshot?.id, resourceName: data.snapshot?.name, dbInstanceIdentifier: req.params.dbInstanceIdentifier, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-rds-create-snapshot', status: 'failed', region, resourceId: req.params.dbInstanceIdentifier, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function deleteRdsSnapshot(req, res) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const snapshotIdentifier = String(req.params.snapshotIdentifier || '').trim();
    const expected = String(req.body?.snapshotName || snapshotIdentifier || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!confirmation || (confirmation !== snapshotIdentifier && confirmation !== expected)) {
      const error = new Error('Type the RDS snapshot name or identifier to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }
    const data = await deleteAwsRdsSnapshot(connector, {
      region: requireText(region, 'Region'),
      snapshotIdentifier,
    });
    await auditAws({ action: 'aws-rds-delete-snapshot', status: 'submitted', connectorId: connector.id, region, resourceId: snapshotIdentifier, resourceName: req.body?.snapshotName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-rds-delete-snapshot', status: 'failed', region: req.body?.region, resourceId: req.params.snapshotIdentifier, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function restoreRdsInstance(req, res) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await restoreAwsRdsInstanceFromSnapshot(connector, { ...req.body, region: requireText(region, 'Region') });
    await updateCachedAwsRdsDatabase(connector.id, data.database, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-rds-restore-snapshot', status: 'submitted', connectorId: connector.id, region, resourceId: data.database?.id, resourceName: data.database?.name, snapshotIdentifier: req.body?.snapshotIdentifier, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-rds-restore-snapshot', status: 'failed', region, resourceName: req.body?.dbInstanceIdentifier, snapshotIdentifier: req.body?.snapshotIdentifier, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function deleteRdsInstance(req, res) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const expected = String(req.body?.dbInstanceName || req.params.dbInstanceIdentifier || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!confirmation || (confirmation !== req.params.dbInstanceIdentifier && confirmation !== expected)) {
      const error = new Error('Type the DB instance name or identifier to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }
    if (req.body?.skipFinalSnapshot === false && !String(req.body?.finalSnapshotIdentifier || '').trim()) {
      const error = new Error('Final snapshot identifier is required when final snapshot is enabled.');
      error.statusCode = 400;
      throw error;
    }
    const data = await deleteAwsRdsInstance(connector, {
      region: requireText(region, 'Region'),
      dbInstanceIdentifier: req.params.dbInstanceIdentifier,
      skipFinalSnapshot: req.body?.skipFinalSnapshot !== false,
      finalSnapshotIdentifier: req.body?.finalSnapshotIdentifier,
    });
    await removeCachedAwsRdsDatabase(connector.id, data.database, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-rds-delete', status: 'submitted', connectorId: connector.id, region, resourceId: req.params.dbInstanceIdentifier, resourceName: req.body?.dbInstanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-rds-delete', status: 'failed', region, resourceId: req.params.dbInstanceIdentifier, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function terminateInstance(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const expected = String(req.body?.instanceName || req.params.instanceId || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!confirmation || (confirmation !== req.params.instanceId && confirmation !== expected)) {
      const error = new Error('Type the instance name or instance ID to confirm termination.');
      error.statusCode = 400;
      throw error;
    }
    const data = await runAwsInstanceAction(connector, {
      region,
      instanceId: req.params.instanceId,
      action: 'terminate',
    });
    await updateCachedAwsInstance(connector.id, data.instance, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ec2-terminate', status: 'submitted', connectorId: connector.id, region, resourceId: req.params.instanceId, resourceName: req.body?.instanceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ec2-terminate', status: 'failed', region: req.body?.region, resourceId: req.params.instanceId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function createInstanceImage(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await createAwsImage(connector, {
      region,
      instanceId: req.params.instanceId,
      name: req.body?.name,
      description: req.body?.description,
      noReboot: req.body?.noReboot === true,
    });
    await auditAws({ action: 'aws-ec2-create-ami', status: 'submitted', connectorId: connector.id, region, resourceId: req.params.instanceId, imageId: data.imageId, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ec2-create-ami', status: 'failed', region: req.body?.region, resourceId: req.params.instanceId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function updateInstanceType(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await changeAwsInstanceType(connector, {
      region,
      instanceId: req.params.instanceId,
      instanceType: req.body?.instanceType,
    });
    await updateCachedAwsInstance(connector.id, data.instance, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ec2-change-instance-type', status: 'submitted', connectorId: connector.id, region, resourceId: req.params.instanceId, instanceType: req.body?.instanceType, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ec2-change-instance-type', status: 'failed', region: req.body?.region, resourceId: req.params.instanceId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function attachVolume(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await attachAwsVolume(connector, {
      region,
      instanceId: req.params.instanceId,
      volumeId: req.body?.volumeId,
      device: req.body?.device,
    });
    await updateCachedAwsVolume(connector.id, data.volume, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ebs-attach-volume', status: 'submitted', connectorId: connector.id, region, resourceId: req.body?.volumeId, instanceId: req.params.instanceId, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ebs-attach-volume', status: 'failed', region: req.body?.region, resourceId: req.body?.volumeId, instanceId: req.params.instanceId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function detachVolume(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await detachAwsVolume(connector, {
      region,
      instanceId: req.params.instanceId,
      volumeId: req.params.volumeId,
      device: req.body?.device,
      force: req.body?.force === true,
    });
    await updateCachedAwsVolume(connector.id, data.volume, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ebs-detach-volume', status: 'submitted', connectorId: connector.id, region, resourceId: req.params.volumeId, instanceId: req.params.instanceId, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ebs-detach-volume', status: 'failed', region: req.body?.region, resourceId: req.params.volumeId, instanceId: req.params.instanceId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

function awsDeleteConfirmationMatches(req, id, name, label) {
  const expected = String(name || id || '').trim();
  const confirmation = String(req.body?.confirmation || '').trim();
  if (!confirmation || (confirmation !== id && confirmation !== expected)) {
    const error = new Error(`Type the ${label} name or ID to confirm deletion.`);
    error.statusCode = 400;
    throw error;
  }
}

async function submitAwsNetworkCreate(req, res, actionName, serviceCall, resultKey) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await serviceCall(connector, { ...req.body, region: requireText(region, 'Region') });
    await updateCachedAwsNetworkResource(connector.id, data[resultKey], [req.body?.scanRegion]);
    await auditAws({ action: actionName, status: 'submitted', connectorId: connector.id, region, resourceId: data[resultKey]?.id, resourceName: data[resultKey]?.name, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: actionName, status: 'failed', region, resourceName: req.body?.name, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

async function submitAwsNetworkDelete(req, res, actionName, serviceCall, resultKey, idKey, label) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const resourceId = req.params[idKey];
    awsDeleteConfirmationMatches(req, resourceId, req.body?.resourceName, label);
    const data = await serviceCall(connector, {
      ...req.body,
      region: requireText(region, 'Region'),
      [idKey]: resourceId,
    });
    await removeCachedAwsNetworkResource(connector.id, data[resultKey], [req.body?.scanRegion]);
    await auditAws({ action: actionName, status: 'submitted', connectorId: connector.id, region, resourceId, resourceName: req.body?.resourceName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: actionName, status: 'failed', region, resourceId: req.params[idKey], message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function createVpc(req, res) {
  await submitAwsNetworkCreate(req, res, 'aws-vpc-create', createAwsVpc, 'vpc');
}

export async function deleteVpc(req, res) {
  await submitAwsNetworkDelete(req, res, 'aws-vpc-delete', deleteAwsVpc, 'vpc', 'vpcId', 'VPC');
}

export async function createSubnet(req, res) {
  await submitAwsNetworkCreate(req, res, 'aws-subnet-create', createAwsSubnet, 'subnet');
}

export async function deleteSubnet(req, res) {
  await submitAwsNetworkDelete(req, res, 'aws-subnet-delete', deleteAwsSubnet, 'subnet', 'subnetId', 'subnet');
}

export async function createRouteTable(req, res) {
  await submitAwsNetworkCreate(req, res, 'aws-route-table-create', createAwsRouteTable, 'routeTable');
}

export async function deleteRouteTable(req, res) {
  await submitAwsNetworkDelete(req, res, 'aws-route-table-delete', deleteAwsRouteTable, 'routeTable', 'routeTableId', 'route table');
}

export async function createInternetGateway(req, res) {
  await submitAwsNetworkCreate(req, res, 'aws-internet-gateway-create', createAwsInternetGateway, 'internetGateway');
}

export async function deleteInternetGateway(req, res) {
  await submitAwsNetworkDelete(req, res, 'aws-internet-gateway-delete', deleteAwsInternetGateway, 'internetGateway', 'internetGatewayId', 'internet gateway');
}

export async function createNatGateway(req, res) {
  await submitAwsNetworkCreate(req, res, 'aws-nat-gateway-create', createAwsNatGateway, 'natGateway');
}

export async function deleteNatGateway(req, res) {
  await submitAwsNetworkDelete(req, res, 'aws-nat-gateway-delete', deleteAwsNatGateway, 'natGateway', 'natGatewayId', 'NAT gateway');
}

export async function updateSecurityGroupRule(req, res) {
  const region = String(req.body?.region || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await updateAwsSecurityGroupRule(connector, { ...req.body, region: requireText(region, 'Region'), groupId: req.params.groupId });
    await updateCachedAwsNetworkResource(connector.id, data.securityGroup, [req.body?.scanRegion]);
    await auditAws({ action: `aws-security-group-rule-${req.body?.operation || 'update'}`, status: 'submitted', connectorId: connector.id, region, resourceId: req.params.groupId, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: `aws-security-group-rule-${req.body?.operation || 'update'}`, status: 'failed', region, resourceId: req.params.groupId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

function addMapNode(nodes, node) {
  if (!node?.id || nodes.has(node.id)) {
    return;
  }
  nodes.set(node.id, node);
}

function addMapEdge(edges, from, to, label) {
  if (!from || !to) {
    return;
  }
  const id = `${from}->${to}:${label}`;
  if (!edges.some((edge) => edge.id === id)) {
    edges.push({ id, from, to, label });
  }
}

export async function getNetworkMap(req, res) {
  const region = normalizedRegion(req.query.region);
  const vpcId = String(req.query.vpcId || '').trim();
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const cached = await getCachedAwsInventory(connector.id, region);
    if (!cached) {
      res.json({ data: { generatedAt: new Date().toISOString(), region, vpcId, nodes: [], edges: [], message: 'No cached AWS inventory exists for this region.' } });
      return;
    }

    const nodes = new Map();
    const edges = [];
    const vpcs = (cached.vpcs || []).filter((vpc) => !vpcId || vpc.id === vpcId);
    const allowedVpcIds = new Set(vpcs.map((vpc) => vpc.id).filter(Boolean));
    vpcs.forEach((vpc) => addMapNode(nodes, { id: vpc.id, type: 'vpc', label: vpc.name || vpc.id, region: vpc.region, status: vpc.status, cidrBlock: vpc.cidrBlock }));

    for (const subnet of cached.subnets || []) {
      if (allowedVpcIds.size && !allowedVpcIds.has(subnet.vpcId)) continue;
      addMapNode(nodes, { id: subnet.id, type: 'subnet', label: subnet.name || subnet.id, region: subnet.region, status: subnet.status, cidrBlock: subnet.cidrBlock });
      addMapEdge(edges, subnet.id, subnet.vpcId, 'belongs to');
    }
    for (const routeTable of cached.routeTables || []) {
      if (allowedVpcIds.size && !allowedVpcIds.has(routeTable.vpcId)) continue;
      addMapNode(nodes, { id: routeTable.id, type: 'routeTable', label: routeTable.name || routeTable.id, region: routeTable.region, status: routeTable.status });
      addMapEdge(edges, routeTable.id, routeTable.vpcId, 'routes for');
      for (const association of routeTable.associations || []) {
        addMapEdge(edges, association.subnetId || routeTable.vpcId, routeTable.id, association.main ? 'main route table' : 'associated route table');
      }
      for (const route of routeTable.routes || []) {
        if (!route.target || route.target === 'local') continue;
        addMapNode(nodes, { id: route.target, type: route.target.startsWith('igw-') ? 'internetGateway' : route.target.startsWith('nat-') ? 'natGateway' : 'routeTarget', label: route.target, region: routeTable.region, status: route.state });
        addMapEdge(edges, routeTable.id, route.target, route.destination || 'route');
      }
    }
    for (const gateway of cached.internetGateways || []) {
      if (allowedVpcIds.size && !allowedVpcIds.has(gateway.vpcId)) continue;
      addMapNode(nodes, { id: gateway.id, type: 'internetGateway', label: gateway.name || gateway.id, region: gateway.region, status: gateway.status });
      addMapEdge(edges, gateway.id, gateway.vpcId, 'attached to');
    }
    for (const gateway of cached.natGateways || []) {
      if (allowedVpcIds.size && !allowedVpcIds.has(gateway.vpcId)) continue;
      addMapNode(nodes, { id: gateway.id, type: 'natGateway', label: gateway.name || gateway.id, region: gateway.region, status: gateway.status });
      addMapEdge(edges, gateway.id, gateway.subnetId, 'runs in');
    }
    for (const group of cached.securityGroups || []) {
      if (allowedVpcIds.size && !allowedVpcIds.has(group.vpcId)) continue;
      addMapNode(nodes, { id: group.id, type: 'securityGroup', label: group.name || group.id, region: group.region, status: group.status });
      addMapEdge(edges, group.id, group.vpcId, 'protects');
    }
    for (const instance of cached.instances || []) {
      if (allowedVpcIds.size && !allowedVpcIds.has(instance.vpcId)) continue;
      addMapNode(nodes, { id: instance.id, type: 'ec2Instance', label: instance.name || instance.id, region: instance.region, status: instance.status });
      addMapEdge(edges, instance.id, instance.subnetId, 'attached to');
    }

    res.json({ data: { generatedAt: new Date().toISOString(), region, vpcId, nodes: Array.from(nodes.values()), edges } });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

export async function createVolume(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await createAwsVolume(connector, {
      ...req.body,
      region,
    });
    await updateCachedAwsVolume(connector.id, data.volume, [req.body?.scanRegion]);
    await auditAws({ action: req.body?.snapshotId ? 'aws-ebs-restore-volume' : 'aws-ebs-create-volume', status: 'submitted', connectorId: connector.id, region, resourceId: data.volume?.id, resourceName: data.volume?.name, snapshotId: req.body?.snapshotId, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: req.body?.snapshotId ? 'aws-ebs-restore-volume' : 'aws-ebs-create-volume', status: 'failed', region: req.body?.region, resourceName: req.body?.name, snapshotId: req.body?.snapshotId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function resizeVolume(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await resizeAwsVolume(connector, {
      region,
      volumeId: req.params.volumeId,
      sizeGb: req.body?.sizeGb,
    });
    await updateCachedAwsVolume(connector.id, data.volume, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ebs-resize-volume', status: 'submitted', connectorId: connector.id, region, resourceId: req.params.volumeId, sizeGb: req.body?.sizeGb, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ebs-resize-volume', status: 'failed', region: req.body?.region, resourceId: req.params.volumeId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function deleteVolume(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const expected = String(req.body?.volumeName || req.params.volumeId || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!confirmation || (confirmation !== req.params.volumeId && confirmation !== expected)) {
      const error = new Error('Type the volume name or volume ID to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }
    const data = await deleteAwsVolume(connector, {
      region,
      volumeId: req.params.volumeId,
    });
    await removeCachedAwsVolume(connector.id, data.volume, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ebs-delete-volume', status: 'submitted', connectorId: connector.id, region, resourceId: req.params.volumeId, resourceName: req.body?.volumeName, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ebs-delete-volume', status: 'failed', region: req.body?.region, resourceId: req.params.volumeId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function createSnapshot(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await createAwsSnapshot(connector, {
      region,
      volumeId: req.params.volumeId,
      name: req.body?.name,
      description: req.body?.description,
    });
    await updateCachedAwsSnapshot(connector.id, data.snapshot, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ebs-create-snapshot', status: 'submitted', connectorId: connector.id, region, resourceId: data.snapshot?.id, resourceName: data.snapshot?.name, volumeId: req.params.volumeId, message: data.message }, req);
    res.status(202).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ebs-create-snapshot', status: 'failed', region: req.body?.region, volumeId: req.params.volumeId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function deleteSnapshot(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const expected = String(req.body?.snapshotName || req.params.snapshotId || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!confirmation || (confirmation !== req.params.snapshotId && confirmation !== expected)) {
      const error = new Error('Type the snapshot name or snapshot ID to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }
    const data = await deleteAwsSnapshot(connector, {
      region,
      snapshotId: req.params.snapshotId,
    });
    await removeCachedAwsSnapshot(connector.id, data.snapshot, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-ebs-delete-snapshot', status: 'succeeded', connectorId: connector.id, region, resourceId: req.params.snapshotId, resourceName: req.body?.snapshotName, message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-ebs-delete-snapshot', status: 'failed', region: req.body?.region, resourceId: req.params.snapshotId, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function createBucket(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await createAwsBucket(connector, {
      region,
      bucketName: req.body?.bucketName,
    });
    await updateCachedAwsBucket(connector.id, data.bucket, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-s3-create-bucket', status: 'succeeded', connectorId: connector.id, region, resourceId: data.bucket?.id, resourceName: data.bucket?.name, message: data.message }, req);
    res.status(201).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-s3-create-bucket', status: 'failed', region: req.body?.region, resourceName: req.body?.bucketName, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function deleteBucket(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const expected = String(req.body?.bucketName || req.params.bucketName || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!confirmation || confirmation !== expected) {
      const error = new Error('Type the bucket name to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }
    const data = await deleteAwsBucket(connector, {
      region,
      bucketName: req.params.bucketName,
    });
    await removeCachedAwsBucket(connector.id, data.bucket, [req.body?.scanRegion]);
    await auditAws({ action: 'aws-s3-delete-bucket', status: 'succeeded', connectorId: connector.id, region, resourceId: req.params.bucketName, resourceName: req.params.bucketName, message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-s3-delete-bucket', status: 'failed', region: req.body?.region, resourceId: req.params.bucketName, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function updateBucketVersioning(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await updateAwsBucketVersioning(connector, {
      region,
      bucketName: req.params.bucketName,
      enabled: req.body?.enabled === true,
    });
    await updateCachedAwsBucket(connector.id, data.bucket, [req.body?.scanRegion]);
    await auditAws({ action: req.body?.enabled === true ? 'aws-s3-enable-versioning' : 'aws-s3-disable-versioning', status: 'succeeded', connectorId: connector.id, region, resourceId: req.params.bucketName, resourceName: req.params.bucketName, message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditAws({ action: req.body?.enabled === true ? 'aws-s3-enable-versioning' : 'aws-s3-disable-versioning', status: 'failed', region: req.body?.region, resourceId: req.params.bucketName, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function listBucketObjects(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await listAwsBucketObjects(connector, {
      region: requireText(req.query.region, 'Region'),
      bucketName: req.params.bucketName,
      prefix: req.query.prefix,
      maxKeys: req.query.maxKeys,
    });
    res.json({ data });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

export async function getBucketObject(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const data = await getAwsBucketObject(connector, {
      region: requireText(req.query.region, 'Region'),
      bucketName: req.params.bucketName,
      key: req.query.key,
    });
    res.json({ data });
  } catch (error) {
    handleAwsError(error, req, res);
  }
}

export async function putBucketObject(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const data = await putAwsBucketObject(connector, {
      region,
      bucketName: req.params.bucketName,
      key: req.body?.key,
      content: req.body?.content,
      contentType: req.body?.contentType,
    });
    await auditAws({ action: 'aws-s3-put-object', status: 'succeeded', connectorId: connector.id, region, resourceId: data.object?.id, resourceName: data.object?.key, bucketName: req.params.bucketName, message: data.message }, req);
    res.status(201).json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-s3-put-object', status: 'failed', region: req.body?.region, bucketName: req.params.bucketName, objectKey: req.body?.key, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}

export async function deleteBucketObject(req, res) {
  try {
    const connector = await getSelectedAwsConnectorForUse();
    assertVerifiedConnector(connector);
    const region = requireText(req.body?.region, 'Region');
    const key = requireText(req.body?.key, 'Object key');
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!confirmation || confirmation !== key) {
      const error = new Error('Type the object key to confirm deletion.');
      error.statusCode = 400;
      throw error;
    }
    const data = await deleteAwsBucketObject(connector, {
      region,
      bucketName: req.params.bucketName,
      key,
    });
    await auditAws({ action: 'aws-s3-delete-object', status: 'succeeded', connectorId: connector.id, region, resourceId: data.object?.id, resourceName: key, bucketName: req.params.bucketName, message: data.message }, req);
    res.json({ data });
  } catch (error) {
    await auditAws({ action: 'aws-s3-delete-object', status: 'failed', region: req.body?.region, bucketName: req.params.bucketName, objectKey: req.body?.key, message: error.message }, req);
    handleAwsError(error, req, res);
  }
}
