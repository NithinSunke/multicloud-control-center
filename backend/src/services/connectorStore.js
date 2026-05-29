import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const algorithm = 'aes-256-gcm';
const storeFileName = 'proxmox-connectors.json';
const encryptionSalt = 'multi-cloud-manager-connectors';
const legacyEncryptionSalt = 'proxmox-manager-connectors';
const legacyPasswordVerificationMessage =
  'Password connectors are saved but API token verification is required in Phase 2.';

function dataFilePath() {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), storeFileName);
}

function encryptionKey(salt = encryptionSalt) {
  const secret = process.env.ENCRYPTION_KEY || 'local-dev-encryption-key';
  return scryptSync(secret, salt, 32);
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return {
    value: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptWithSalt(payload, salt) {
  const decipher = createDecipheriv(algorithm, encryptionKey(salt), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.value, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function decrypt(payload) {
  try {
    return decryptWithSalt(payload, encryptionSalt);
  } catch (error) {
    if (legacyEncryptionSalt) {
      return decryptWithSalt(payload, legacyEncryptionSalt);
    }
    throw error;
  }
}

async function readStore() {
  try {
    const raw = await readFile(dataFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { selectedConnectorId: null, connectors: [] };
    }
    throw error;
  }
}

async function writeStore(store) {
  const target = dataFilePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(store, null, 2), 'utf8');
}

function maskSecret(secret) {
  if (!secret) {
    return '';
  }
  return `**** ${secret.slice(-4)}`;
}

function normalizePayload(payload) {
  const provider = payload.provider === 'oci'
    ? 'oci'
    : payload.provider === 'aws'
      ? 'aws'
      : payload.provider === 'azure'
        ? 'azure'
        : payload.provider === 'gcp'
          ? 'gcp'
          : 'proxmox';
  const authType = payload.authType === 'password' ? 'password' : 'apiToken';
  const azureCloud = ['public', 'gov', 'china'].includes(payload.azureCloud) ? payload.azureCloud : 'public';

  return {
    provider,
    name: String(payload.name || '').trim(),
    host: String(payload.host || '').trim(),
    port: Number(payload.port || 8006),
    realm: String(payload.realm || 'pam').trim(),
    username: String(payload.username || '').trim(),
    authType,
    password: String(payload.password || ''),
    apiTokenId: String(payload.apiTokenId || '').trim(),
    apiTokenSecret: String(payload.apiTokenSecret || ''),
    tenancyOcid: String(payload.tenancyOcid || '').trim(),
    userOcid: String(payload.userOcid || '').trim(),
    compartmentOcid: String(payload.compartmentOcid || payload.tenancyOcid || '').trim(),
    awsAccountId: String(payload.awsAccountId || '').trim(),
    awsAccessKeyId: String(payload.awsAccessKeyId || '').trim(),
    awsSecretAccessKey: String(payload.awsSecretAccessKey || ''),
    awsSessionToken: String(payload.awsSessionToken || ''),
    azureTenantId: String(payload.azureTenantId || '').trim(),
    azureSubscriptionId: String(payload.azureSubscriptionId || '').trim(),
    azureClientId: String(payload.azureClientId || '').trim(),
    azureClientSecret: String(payload.azureClientSecret || ''),
    azureCloud,
    gcpProjectId: String(payload.gcpProjectId || '').trim(),
    gcpClientEmail: String(payload.gcpClientEmail || '').trim(),
    gcpOrganizationId: String(payload.gcpOrganizationId || '').trim(),
    gcpBillingAccountId: String(payload.gcpBillingAccountId || '').trim(),
    region: String(payload.region || '').trim(),
    fingerprint: String(payload.fingerprint || '').trim(),
    privateKey: String(payload.privateKey || ''),
    privateKeyPassphrase: String(payload.privateKeyPassphrase || ''),
    tlsVerify: payload.tlsVerify !== false,
    notes: String(payload.notes || '').trim(),
  };
}

function validateConnector(payload, existingConnector) {
  const missing = [];
  if (!payload.name) missing.push('name');

  if (payload.provider === 'oci') {
    if (!payload.tenancyOcid) missing.push('tenancy OCID');
    if (!payload.userOcid) missing.push('user OCID');
    if (!payload.compartmentOcid) missing.push('compartment OCID');
    if (!payload.region) missing.push('region');
    if (!payload.fingerprint) missing.push('fingerprint');
    if (!existingConnector && !payload.privateKey) missing.push('private key');
  } else if (payload.provider === 'aws') {
    if (!payload.region) missing.push('region');
    if (!payload.awsAccessKeyId) missing.push('AWS access key ID');
    if (!existingConnector && !payload.awsSecretAccessKey) missing.push('AWS secret access key');
  } else if (payload.provider === 'azure') {
    if (!payload.azureTenantId) missing.push('Azure tenant ID');
    if (!payload.azureSubscriptionId) missing.push('Azure subscription ID');
    if (!payload.azureClientId) missing.push('Azure client ID');
    if (!existingConnector && !payload.azureClientSecret) missing.push('Azure client secret');
  } else if (payload.provider === 'gcp') {
    if (!payload.gcpProjectId) missing.push('GCP project ID');
    if (!payload.gcpClientEmail) missing.push('GCP service account email');
    if (!existingConnector && !payload.privateKey) missing.push('GCP private key');
  } else {
    if (!payload.host) missing.push('host');
    if (!payload.username) missing.push('username');
    if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) {
      missing.push('valid port');
    }
    if (payload.authType === 'apiToken') {
      if (!payload.apiTokenId) missing.push('API token ID');
      if (!existingConnector && !payload.apiTokenSecret) missing.push('API token secret');
    }
    if (payload.authType === 'password' && !existingConnector && !payload.password) {
      missing.push('password');
    }
  }

  if (missing.length > 0) {
    const error = new Error(`Missing ${missing.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
}

function connectorProvider(connector) {
  return connector.provider === 'oci'
    ? 'oci'
    : connector.provider === 'aws'
      ? 'aws'
      : connector.provider === 'azure'
        ? 'azure'
        : connector.provider === 'gcp'
          ? 'gcp'
          : 'proxmox';
}

function publicConnector(connector, selectedConnectorId) {
  const provider = connectorProvider(connector);
  const password = provider === 'proxmox' && connector.encryptedPassword ? decrypt(connector.encryptedPassword) : '';
  const apiTokenSecret = provider === 'proxmox' && connector.encryptedApiTokenSecret
    ? decrypt(connector.encryptedApiTokenSecret)
    : '';
  const hasLegacyVerificationMessage =
    connector.verificationMessage === legacyPasswordVerificationMessage;

  return {
    id: connector.id,
    provider,
    name: connector.name,
    host: connector.host,
    port: connector.port,
    realm: connector.realm,
    username: connector.username,
    authType: connector.authType,
    apiTokenId: connector.apiTokenId,
    tenancyOcid: connector.tenancyOcid || '',
    userOcid: connector.userOcid || '',
    compartmentOcid: connector.compartmentOcid || '',
    awsAccountId: connector.awsAccountId || '',
    awsAccessKeyId: connector.awsAccessKeyId || '',
    azureTenantId: connector.azureTenantId || '',
    azureSubscriptionId: connector.azureSubscriptionId || '',
    azureClientId: connector.azureClientId || '',
    azureCloud: connector.azureCloud || 'public',
    azureSubscriptionName: connector.azureSubscriptionName || '',
    gcpProjectId: connector.gcpProjectId || '',
    gcpProjectName: connector.gcpProjectName || '',
    gcpProjectNumber: connector.gcpProjectNumber || '',
    gcpClientEmail: connector.gcpClientEmail || '',
    gcpOrganizationId: connector.gcpOrganizationId || '',
    gcpBillingAccountId: connector.gcpBillingAccountId || '',
    region: connector.region || '',
    fingerprint: connector.fingerprint || '',
    tlsVerify: connector.tlsVerify,
    notes: connector.notes,
    status: hasLegacyVerificationMessage ? 'ready' : connector.status,
    lastVerifiedAt: hasLegacyVerificationMessage ? null : connector.lastVerifiedAt || null,
    verificationMessage: hasLegacyVerificationMessage ? '' : connector.verificationMessage || '',
    selected: connector.id === selectedConnectorId,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    secretPreview: provider === 'oci'
      ? maskSecret(connector.fingerprint || '')
      : provider === 'aws'
        ? maskSecret(connector.awsAccessKeyId || '')
        : provider === 'azure'
          ? maskSecret(connector.azureClientId || '')
          : provider === 'gcp'
            ? maskSecret(connector.gcpClientEmail || '')
            : connector.authType === 'password' ? maskSecret(password) : maskSecret(apiTokenSecret),
    secretStored: provider === 'oci'
      ? Boolean(connector.encryptedPrivateKey)
      : provider === 'aws'
        ? Boolean(connector.encryptedAwsSecretAccessKey)
        : provider === 'azure'
          ? Boolean(connector.encryptedAzureClientSecret)
          : provider === 'gcp'
            ? Boolean(connector.encryptedGcpPrivateKey)
            : Boolean(password || apiTokenSecret),
  };
}

function connectorWithSecrets(connector) {
  const provider = connectorProvider(connector);
  return {
    ...connector,
    provider,
    password: provider === 'proxmox' && connector.encryptedPassword ? decrypt(connector.encryptedPassword) : '',
    apiTokenSecret: provider === 'proxmox' && connector.encryptedApiTokenSecret
      ? decrypt(connector.encryptedApiTokenSecret)
      : '',
    privateKey:
      provider === 'oci' && connector.encryptedPrivateKey
        ? decrypt(connector.encryptedPrivateKey)
        : provider === 'gcp' && connector.encryptedGcpPrivateKey
          ? decrypt(connector.encryptedGcpPrivateKey)
          : '',
    privateKeyPassphrase: provider === 'oci' && connector.encryptedPrivateKeyPassphrase
      ? decrypt(connector.encryptedPrivateKeyPassphrase)
      : '',
    awsSecretAccessKey: provider === 'aws' && connector.encryptedAwsSecretAccessKey
      ? decrypt(connector.encryptedAwsSecretAccessKey)
      : '',
    awsSessionToken: provider === 'aws' && connector.encryptedAwsSessionToken
      ? decrypt(connector.encryptedAwsSessionToken)
      : '',
    azureClientSecret: provider === 'azure' && connector.encryptedAzureClientSecret
      ? decrypt(connector.encryptedAzureClientSecret)
      : '',
  };
}

export async function listConnectors() {
  const store = await readStore();
  return {
    selectedConnectorId: store.selectedConnectorId,
    selectedOciConnectorId: store.selectedOciConnectorId || null,
    selectedAwsConnectorId: store.selectedAwsConnectorId || null,
    selectedAzureConnectorId: store.selectedAzureConnectorId || null,
    selectedGcpConnectorId: store.selectedGcpConnectorId || null,
    connectors: store.connectors.map((connector) =>
      publicConnector(
        connector,
        connectorProvider(connector) === 'oci'
          ? store.selectedOciConnectorId
          : connectorProvider(connector) === 'aws'
            ? store.selectedAwsConnectorId
            : connectorProvider(connector) === 'azure'
              ? store.selectedAzureConnectorId
              : connectorProvider(connector) === 'gcp'
                ? store.selectedGcpConnectorId
                : store.selectedConnectorId,
      ),
    ),
  };
}

export async function createConnector(rawPayload) {
  const payload = normalizePayload(rawPayload);
  validateConnector(payload);

  const now = new Date().toISOString();
  const connector = {
    id: randomUUID(),
    provider: payload.provider,
    name: payload.name,
    host: payload.provider === 'proxmox' ? payload.host : '',
    port: payload.provider === 'proxmox' ? payload.port : 443,
    realm: payload.provider === 'proxmox' ? payload.realm : '',
    username: payload.provider === 'proxmox' ? payload.username : '',
    authType: payload.provider === 'proxmox' ? payload.authType : 'apiToken',
    apiTokenId: payload.provider === 'proxmox' && payload.authType === 'apiToken' ? payload.apiTokenId : '',
    encryptedPassword: payload.provider === 'proxmox' && payload.authType === 'password' ? encrypt(payload.password) : null,
    encryptedApiTokenSecret:
      payload.provider === 'proxmox' && payload.authType === 'apiToken' ? encrypt(payload.apiTokenSecret) : null,
    tenancyOcid: payload.provider === 'oci' ? payload.tenancyOcid : '',
    userOcid: payload.provider === 'oci' ? payload.userOcid : '',
    compartmentOcid: payload.provider === 'oci' ? payload.compartmentOcid : '',
    awsAccountId: payload.provider === 'aws' ? payload.awsAccountId : '',
    awsAccessKeyId: payload.provider === 'aws' ? payload.awsAccessKeyId : '',
    encryptedAwsSecretAccessKey: payload.provider === 'aws' ? encrypt(payload.awsSecretAccessKey) : null,
    encryptedAwsSessionToken:
      payload.provider === 'aws' && payload.awsSessionToken ? encrypt(payload.awsSessionToken) : null,
    azureTenantId: payload.provider === 'azure' ? payload.azureTenantId : '',
    azureSubscriptionId: payload.provider === 'azure' ? payload.azureSubscriptionId : '',
    azureClientId: payload.provider === 'azure' ? payload.azureClientId : '',
    azureCloud: payload.provider === 'azure' ? payload.azureCloud : '',
    azureSubscriptionName: '',
    encryptedAzureClientSecret: payload.provider === 'azure' ? encrypt(payload.azureClientSecret) : null,
    gcpProjectId: payload.provider === 'gcp' ? payload.gcpProjectId : '',
    gcpProjectName: '',
    gcpProjectNumber: '',
    gcpClientEmail: payload.provider === 'gcp' ? payload.gcpClientEmail : '',
    gcpOrganizationId: payload.provider === 'gcp' ? payload.gcpOrganizationId : '',
    gcpBillingAccountId: payload.provider === 'gcp' ? payload.gcpBillingAccountId : '',
    encryptedGcpPrivateKey: payload.provider === 'gcp' ? encrypt(payload.privateKey) : null,
    region: payload.provider === 'oci' || payload.provider === 'aws' ? payload.region : '',
    fingerprint: payload.provider === 'oci' ? payload.fingerprint : '',
    encryptedPrivateKey: payload.provider === 'oci' ? encrypt(payload.privateKey) : null,
    encryptedPrivateKeyPassphrase:
      payload.provider === 'oci' && payload.privateKeyPassphrase ? encrypt(payload.privateKeyPassphrase) : null,
    tlsVerify: payload.tlsVerify,
    notes: payload.notes,
    status: 'ready',
    lastVerifiedAt: null,
    verificationMessage: '',
    createdAt: now,
    updatedAt: now,
  };

  const store = await readStore();
  store.connectors.push(connector);
  if (payload.provider === 'oci' && !store.selectedOciConnectorId) {
    store.selectedOciConnectorId = connector.id;
  }
  if (payload.provider === 'aws' && !store.selectedAwsConnectorId) {
    store.selectedAwsConnectorId = connector.id;
  }
  if (payload.provider === 'azure' && !store.selectedAzureConnectorId) {
    store.selectedAzureConnectorId = connector.id;
  }
  if (payload.provider === 'gcp' && !store.selectedGcpConnectorId) {
    store.selectedGcpConnectorId = connector.id;
  }
  if (payload.provider === 'proxmox' && !store.selectedConnectorId) {
    store.selectedConnectorId = connector.id;
  }
  await writeStore(store);
  return publicConnector(
    connector,
    payload.provider === 'oci'
      ? store.selectedOciConnectorId
      : payload.provider === 'aws'
        ? store.selectedAwsConnectorId
        : payload.provider === 'azure'
          ? store.selectedAzureConnectorId
          : payload.provider === 'gcp'
            ? store.selectedGcpConnectorId
          : store.selectedConnectorId,
  );
}

export async function updateConnector(id, rawPayload) {
  const payload = normalizePayload(rawPayload);
  const store = await readStore();
  const index = store.connectors.findIndex((connector) => connector.id === id);

  if (index === -1) {
    const error = new Error('Connector not found.');
    error.statusCode = 404;
    throw error;
  }

  const existing = store.connectors[index];
  const existingProvider = connectorProvider(existing);
  validateConnector(payload, existingProvider === payload.provider ? existing : null);

  const updated = {
    ...existing,
    provider: payload.provider,
    name: payload.name,
    host: payload.provider === 'proxmox' ? payload.host : '',
    port: payload.provider === 'proxmox' ? payload.port : 443,
    realm: payload.provider === 'proxmox' ? payload.realm : '',
    username: payload.provider === 'proxmox' ? payload.username : '',
    authType: payload.provider === 'proxmox' ? payload.authType : 'apiToken',
    apiTokenId: payload.provider === 'proxmox' && payload.authType === 'apiToken' ? payload.apiTokenId : '',
    encryptedPassword:
      payload.provider === 'proxmox' && payload.authType === 'password'
        ? payload.password
          ? encrypt(payload.password)
          : existing.encryptedPassword
        : null,
    encryptedApiTokenSecret:
      payload.provider === 'proxmox' && payload.authType === 'apiToken'
        ? payload.apiTokenSecret
          ? encrypt(payload.apiTokenSecret)
          : existing.encryptedApiTokenSecret
        : null,
    tenancyOcid: payload.provider === 'oci' ? payload.tenancyOcid : '',
    userOcid: payload.provider === 'oci' ? payload.userOcid : '',
    compartmentOcid: payload.provider === 'oci' ? payload.compartmentOcid : '',
    awsAccountId: payload.provider === 'aws' ? payload.awsAccountId : '',
    awsAccessKeyId: payload.provider === 'aws' ? payload.awsAccessKeyId : '',
    encryptedAwsSecretAccessKey:
      payload.provider === 'aws'
        ? payload.awsSecretAccessKey
          ? encrypt(payload.awsSecretAccessKey)
          : existingProvider === 'aws' ? existing.encryptedAwsSecretAccessKey : null
        : null,
    encryptedAwsSessionToken:
      payload.provider === 'aws'
        ? payload.awsSessionToken
          ? encrypt(payload.awsSessionToken)
          : existingProvider === 'aws' ? existing.encryptedAwsSessionToken : null
        : null,
    azureTenantId: payload.provider === 'azure' ? payload.azureTenantId : '',
    azureSubscriptionId: payload.provider === 'azure' ? payload.azureSubscriptionId : '',
    azureClientId: payload.provider === 'azure' ? payload.azureClientId : '',
    azureCloud: payload.provider === 'azure' ? payload.azureCloud : '',
    azureSubscriptionName: payload.provider === 'azure' && existingProvider === 'azure' ? existing.azureSubscriptionName || '' : '',
    encryptedAzureClientSecret:
      payload.provider === 'azure'
        ? payload.azureClientSecret
          ? encrypt(payload.azureClientSecret)
          : existingProvider === 'azure' ? existing.encryptedAzureClientSecret : null
        : null,
    gcpProjectId: payload.provider === 'gcp' ? payload.gcpProjectId : '',
    gcpProjectName: payload.provider === 'gcp' && existingProvider === 'gcp' ? existing.gcpProjectName || '' : '',
    gcpProjectNumber: payload.provider === 'gcp' && existingProvider === 'gcp' ? existing.gcpProjectNumber || '' : '',
    gcpClientEmail: payload.provider === 'gcp' ? payload.gcpClientEmail : '',
    gcpOrganizationId: payload.provider === 'gcp' ? payload.gcpOrganizationId : '',
    gcpBillingAccountId: payload.provider === 'gcp' ? payload.gcpBillingAccountId : '',
    encryptedGcpPrivateKey:
      payload.provider === 'gcp'
        ? payload.privateKey
          ? encrypt(payload.privateKey)
          : existingProvider === 'gcp' ? existing.encryptedGcpPrivateKey : null
        : null,
    region: payload.provider === 'oci' || payload.provider === 'aws' ? payload.region : '',
    fingerprint: payload.provider === 'oci' ? payload.fingerprint : '',
    encryptedPrivateKey:
      payload.provider === 'oci'
        ? payload.privateKey
          ? encrypt(payload.privateKey)
          : existingProvider === 'oci' ? existing.encryptedPrivateKey : null
        : null,
    encryptedPrivateKeyPassphrase:
      payload.provider === 'oci'
        ? payload.privateKeyPassphrase
          ? encrypt(payload.privateKeyPassphrase)
          : existingProvider === 'oci' ? existing.encryptedPrivateKeyPassphrase : null
        : null,
    tlsVerify: payload.tlsVerify,
    notes: payload.notes,
    status: 'ready',
    lastVerifiedAt: null,
    verificationMessage: '',
    updatedAt: new Date().toISOString(),
  };

  store.connectors[index] = updated;
  if (existingProvider !== payload.provider) {
    if (existingProvider === 'proxmox' && store.selectedConnectorId === id) {
      store.selectedConnectorId = store.connectors.find((connector) => connector.id !== id && connectorProvider(connector) === 'proxmox')?.id || null;
    }
    if (existingProvider === 'oci' && store.selectedOciConnectorId === id) {
      store.selectedOciConnectorId = store.connectors.find((connector) => connector.id !== id && connectorProvider(connector) === 'oci')?.id || null;
    }
    if (existingProvider === 'aws' && store.selectedAwsConnectorId === id) {
      store.selectedAwsConnectorId = store.connectors.find((connector) => connector.id !== id && connectorProvider(connector) === 'aws')?.id || null;
    }
    if (existingProvider === 'azure' && store.selectedAzureConnectorId === id) {
      store.selectedAzureConnectorId = store.connectors.find((connector) => connector.id !== id && connectorProvider(connector) === 'azure')?.id || null;
    }
    if (existingProvider === 'gcp' && store.selectedGcpConnectorId === id) {
      store.selectedGcpConnectorId = store.connectors.find((connector) => connector.id !== id && connectorProvider(connector) === 'gcp')?.id || null;
    }
  }
  if (payload.provider === 'proxmox' && !store.selectedConnectorId) {
    store.selectedConnectorId = id;
  }
  if (payload.provider === 'oci' && !store.selectedOciConnectorId) {
    store.selectedOciConnectorId = id;
  }
  if (payload.provider === 'aws' && !store.selectedAwsConnectorId) {
    store.selectedAwsConnectorId = id;
  }
  if (payload.provider === 'azure' && !store.selectedAzureConnectorId) {
    store.selectedAzureConnectorId = id;
  }
  if (payload.provider === 'gcp' && !store.selectedGcpConnectorId) {
    store.selectedGcpConnectorId = id;
  }
  await writeStore(store);
  return publicConnector(
    updated,
    payload.provider === 'oci'
      ? store.selectedOciConnectorId
      : payload.provider === 'aws'
        ? store.selectedAwsConnectorId
        : payload.provider === 'azure'
          ? store.selectedAzureConnectorId
          : payload.provider === 'gcp'
            ? store.selectedGcpConnectorId
          : store.selectedConnectorId,
  );
}

export async function deleteConnector(id) {
  const store = await readStore();
  const nextConnectors = store.connectors.filter((connector) => connector.id !== id);

  if (nextConnectors.length === store.connectors.length) {
    const error = new Error('Connector not found.');
    error.statusCode = 404;
    throw error;
  }

  const selectedConnectorId =
    store.selectedConnectorId === id
      ? nextConnectors.find((connector) => connectorProvider(connector) === 'proxmox')?.id || null
      : store.selectedConnectorId;
  const selectedOciConnectorId =
    store.selectedOciConnectorId === id
      ? nextConnectors.find((connector) => connectorProvider(connector) === 'oci')?.id || null
      : store.selectedOciConnectorId || null;
  const selectedAwsConnectorId =
    store.selectedAwsConnectorId === id
      ? nextConnectors.find((connector) => connectorProvider(connector) === 'aws')?.id || null
      : store.selectedAwsConnectorId || null;
  const selectedAzureConnectorId =
    store.selectedAzureConnectorId === id
      ? nextConnectors.find((connector) => connectorProvider(connector) === 'azure')?.id || null
      : store.selectedAzureConnectorId || null;
  const selectedGcpConnectorId =
    store.selectedGcpConnectorId === id
      ? nextConnectors.find((connector) => connectorProvider(connector) === 'gcp')?.id || null
      : store.selectedGcpConnectorId || null;

  await writeStore({ connectors: nextConnectors, selectedConnectorId, selectedOciConnectorId, selectedAwsConnectorId, selectedAzureConnectorId, selectedGcpConnectorId });
}

export async function selectConnector(id) {
  const store = await readStore();
  const connector = store.connectors.find((item) => item.id === id);

  if (!connector) {
    const error = new Error('Connector not found.');
    error.statusCode = 404;
    throw error;
  }

  const provider = connectorProvider(connector);
  if (provider === 'oci') {
    store.selectedOciConnectorId = id;
  } else if (provider === 'aws') {
    store.selectedAwsConnectorId = id;
  } else if (provider === 'azure') {
    store.selectedAzureConnectorId = id;
  } else if (provider === 'gcp') {
    store.selectedGcpConnectorId = id;
  } else {
    store.selectedConnectorId = id;
  }
  await writeStore(store);
  return publicConnector(connector, id);
}

export async function getSelectedAzureConnectorForUse() {
  const store = await readStore();
  if (!store.selectedAzureConnectorId) {
    const error = new Error('No Azure connector selected.');
    error.statusCode = 400;
    throw error;
  }

  const connector = store.connectors.find((item) => item.id === store.selectedAzureConnectorId);
  if (!connector || connectorProvider(connector) !== 'azure') {
    const error = new Error('Selected Azure connector not found.');
    error.statusCode = 404;
    throw error;
  }

  return connectorWithSecrets(connector);
}

export async function getSelectedGcpConnectorForUse() {
  const store = await readStore();
  if (!store.selectedGcpConnectorId) {
    const error = new Error('No GCP connector selected.');
    error.statusCode = 400;
    throw error;
  }

  const connector = store.connectors.find((item) => item.id === store.selectedGcpConnectorId);
  if (!connector || connectorProvider(connector) !== 'gcp') {
    const error = new Error('Selected GCP connector not found.');
    error.statusCode = 404;
    throw error;
  }

  return connectorWithSecrets(connector);
}

export async function getConnectorForUse(id) {
  const store = await readStore();
  const connector = store.connectors.find((item) => item.id === id);

  if (!connector) {
    const error = new Error('Connector not found.');
    error.statusCode = 404;
    throw error;
  }

  return connectorWithSecrets(connector);
}

export async function getSelectedConnectorForUse() {
  const store = await readStore();
  if (!store.selectedConnectorId) {
    const error = new Error('No connector selected.');
    error.statusCode = 400;
    throw error;
  }

  const connector = store.connectors.find((item) => item.id === store.selectedConnectorId);
  if (!connector || connectorProvider(connector) !== 'proxmox') {
    const error = new Error('Selected connector not found.');
    error.statusCode = 404;
    throw error;
  }

  return connectorWithSecrets(connector);
}

export async function getSelectedOciConnectorForUse() {
  const store = await readStore();
  if (!store.selectedOciConnectorId) {
    const error = new Error('No OCI connector selected.');
    error.statusCode = 400;
    throw error;
  }

  const connector = store.connectors.find((item) => item.id === store.selectedOciConnectorId);
  if (!connector || connectorProvider(connector) !== 'oci') {
    const error = new Error('Selected OCI connector not found.');
    error.statusCode = 404;
    throw error;
  }

  return connectorWithSecrets(connector);
}

export async function getSelectedAwsConnectorForUse() {
  const store = await readStore();
  if (!store.selectedAwsConnectorId) {
    const error = new Error('No AWS connector selected.');
    error.statusCode = 400;
    throw error;
  }

  const connector = store.connectors.find((item) => item.id === store.selectedAwsConnectorId);
  if (!connector || connectorProvider(connector) !== 'aws') {
    const error = new Error('Selected AWS connector not found.');
    error.statusCode = 404;
    throw error;
  }

  return connectorWithSecrets(connector);
}

export async function updateConnectorVerification(id, result) {
  const store = await readStore();
  const index = store.connectors.findIndex((connector) => connector.id === id);

  if (index === -1) {
    const error = new Error('Connector not found.');
    error.statusCode = 404;
    throw error;
  }

  const updated = {
    ...store.connectors[index],
    awsAccountId:
      connectorProvider(store.connectors[index]) === 'aws' && result.accountId
        ? result.accountId
        : store.connectors[index].awsAccountId,
    azureSubscriptionName:
      connectorProvider(store.connectors[index]) === 'azure' && result.subscriptionName
        ? result.subscriptionName
        : store.connectors[index].azureSubscriptionName,
    gcpProjectName:
      connectorProvider(store.connectors[index]) === 'gcp' && result.projectName
        ? result.projectName
        : store.connectors[index].gcpProjectName,
    gcpProjectNumber:
      connectorProvider(store.connectors[index]) === 'gcp' && result.projectNumber
        ? String(result.projectNumber)
        : store.connectors[index].gcpProjectNumber,
    status: result.ok ? 'verified' : 'error',
    lastVerifiedAt: new Date().toISOString(),
    verificationMessage: result.message,
    updatedAt: new Date().toISOString(),
  };

  store.connectors[index] = updated;
  await writeStore(store);
  return publicConnector(
    updated,
    connectorProvider(updated) === 'oci'
      ? store.selectedOciConnectorId
      : connectorProvider(updated) === 'aws'
        ? store.selectedAwsConnectorId
        : connectorProvider(updated) === 'azure'
          ? store.selectedAzureConnectorId
          : connectorProvider(updated) === 'gcp'
            ? store.selectedGcpConnectorId
          : store.selectedConnectorId,
  );
}
