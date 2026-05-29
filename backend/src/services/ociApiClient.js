import https from 'https';
import { createHash, createSign, generateKeyPairSync } from 'crypto';

const serviceHosts = {
  identity: (region) => `identity.${region}.oraclecloud.com`,
  iaas: (region) => `iaas.${region}.oraclecloud.com`,
  objectstorage: (region) => `objectstorage.${region}.oraclecloud.com`,
  filestorage: (region) => `filestorage.${region}.oraclecloud.com`,
  dns: (region) => `dns.${region}.oraclecloud.com`,
  database: (region) => `database.${region}.oraclecloud.com`,
};

function normalizePrivateKey(privateKey) {
  return String(privateKey || '').replace(/\\n/g, '\n').trim();
}

function signHeaders({ connector, method, pathWithQuery, host, date, body = '', includeBodyHeaders = false }) {
  const keyId = `${connector.tenancyOcid}/${connector.userOcid}/${connector.fingerprint}`;
  const bodyHeaders = includeBodyHeaders
    ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-content-sha256': createHash('sha256').update(body).digest('base64'),
      }
    : {};
  const headerNames = includeBodyHeaders ? '(request-target) host date x-content-sha256 content-type content-length' : '(request-target) host date';
  const signingParts = [
    `(request-target): ${method.toLowerCase()} ${pathWithQuery}`,
    `host: ${host}`,
    `date: ${date}`,
  ];
  if (includeBodyHeaders) {
    signingParts.push(
      `x-content-sha256: ${bodyHeaders['x-content-sha256']}`,
      `content-type: ${bodyHeaders['Content-Type']}`,
      `content-length: ${bodyHeaders['Content-Length']}`,
    );
  }
  const signingString = signingParts.join('\n');
  const signer = createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(
    {
      key: normalizePrivateKey(connector.privateKey),
      passphrase: connector.privateKeyPassphrase || undefined,
    },
    'base64',
  );

  return {
    Authorization:
      `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames}",signature="${signature}"`,
    Date: date,
    Host: host,
    Accept: 'application/json',
    ...bodyHeaders,
  };
}

function normalizeOciItem(item) {
  const normalized = {};
  for (const [key, value] of Object.entries(item || {})) {
    normalized[key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return normalized;
}

function headerValue(headers, name) {
  if (!headers) {
    return '';
  }
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(name.toLowerCase()) || '';
  }
  return headers[name] || headers[name.toLowerCase()] || '';
}

function withQueryParam(pathWithQuery, key, value) {
  const separator = pathWithQuery.includes('?') ? '&' : '?';
  return `${pathWithQuery}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function sshWireString(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

function sshMpint(buffer) {
  let value = Buffer.from(buffer);
  while (value.length > 1 && value[0] === 0) {
    value = value.subarray(1);
  }
  if (value.length > 0 && (value[0] & 0x80)) {
    value = Buffer.concat([Buffer.from([0]), value]);
  }
  return sshWireString(value);
}

function rsaPublicKeyToOpenSsh(publicKey, comment) {
  const jwk = publicKey.export({ format: 'jwk' });
  const exponent = Buffer.from(jwk.e, 'base64url');
  const modulus = Buffer.from(jwk.n, 'base64url');
  const payload = Buffer.concat([
    sshWireString('ssh-rsa'),
    sshMpint(exponent),
    sshMpint(modulus),
  ]);
  return `ssh-rsa ${payload.toString('base64')} ${comment}`;
}

function requestJson(connector, { service, region, pathWithQuery, method = 'GET', body, request = https.request, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const host = serviceHosts[service](region);
    const date = new Date().toUTCString();
    const includeBodyHeaders = body !== undefined || ['POST', 'PUT', 'PATCH'].includes(String(method).toUpperCase());
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    let headers;
    try {
      headers = signHeaders({ connector, method, pathWithQuery, host, date, body: bodyText, includeBodyHeaders });
    } catch (error) {
      resolve({ ok: false, message: error.message || 'Unable to sign OCI request.' });
      return;
    }

    const req = request(
      {
        protocol: 'https:',
        hostname: host,
        method,
        path: pathWithQuery,
        timeout: timeoutMs,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers,
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              const parsed = JSON.parse(responseBody || 'null');
              resolve({
                ok: true,
                nextPage: headerValue(response.headers, 'opc-next-page'),
                payload: Array.isArray(parsed)
                  ? parsed.map(normalizeOciItem)
                  : parsed && typeof parsed === 'object'
                    ? normalizeOciItem(parsed)
                    : parsed,
              });
            } catch {
              resolve({ ok: true, nextPage: headerValue(response.headers, 'opc-next-page'), payload: null });
            }
            return;
          }

          let detail = '';
          try {
            const parsed = JSON.parse(responseBody || '{}');
            detail = parsed.message || parsed.code || '';
          } catch {
            detail = responseBody.slice(0, 120);
          }
          resolve({
            ok: false,
            statusCode: response.statusCode,
            message: detail ? `OCI returned HTTP ${response.statusCode}: ${detail}` : `OCI returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`OCI request timed out after ${Math.round(timeoutMs / 1000)}s.`)));
    req.on('error', (error) => resolve({ ok: false, message: error.message || 'Unable to reach OCI.' }));
    if (bodyText) {
      req.write(bodyText);
    }
    req.end();
  });
}

function isRetriableOciFailure(response) {
  if (!response || response.ok) {
    return false;
  }
  if ([429, 500, 502, 503, 504].includes(response.statusCode)) {
    return true;
  }
  return /timed out|ECONNRESET|ETIMEDOUT|socket hang up/i.test(response.message || '');
}

function retryDelayMs(response, attempt) {
  if (response?.statusCode === 429) {
    return Math.min(12000, 1200 * attempt * attempt);
  }
  return Math.min(5000, 500 * attempt);
}

async function requestList(connector, requestOptions, errors, label) {
  const rows = [];
  let page = '';
  let pageCount = 0;
  const maxAttempts = Math.max(1, Number(requestOptions.retryAttempts || 2));
  const pageLimit = String(requestOptions.limit || 1000);

  do {
    const pathWithLimit = requestOptions.pathWithQuery.includes('limit=')
      ? requestOptions.pathWithQuery
      : withQueryParam(requestOptions.pathWithQuery, 'limit', pageLimit);
    const pathWithQuery = page ? withQueryParam(pathWithLimit, 'page', page) : pathWithLimit;
    let response;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      response = await requestJson(connector, { ...requestOptions, pathWithQuery });
      if (response.ok || !isRetriableOciFailure(response) || attempt === maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
    }
    if (!response.ok) {
      if ((requestOptions.ignoreStatusCodes || []).includes(response.statusCode)) {
        return rows;
      }
      errors.push({
        scope: label,
        region: requestOptions.region,
        message: response.message,
      });
      return rows;
    }
    if (Array.isArray(response.payload)) {
      rows.push(...response.payload);
    } else if (Array.isArray(response.payload?.items)) {
      rows.push(...response.payload.items);
    }
    page = response.nextPage || '';
    pageCount += 1;
    if (pageCount >= 100) {
      errors.push({
        scope: label,
        region: requestOptions.region,
        message: 'Stopped after 100 OCI result pages. Narrow the scan scope to a compartment or region.',
      });
      break;
    }
  } while (page);

  return rows;
}

function compactOciErrors(errors) {
  const grouped = new Map();
  for (const error of errors || []) {
    const key = [error.scope || '', error.region || '', error.message || ''].join('|');
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    grouped.set(key, { ...error, count: 1 });
  }
  return Array.from(grouped.values()).map((error) => {
    if (error.count <= 1) {
      const { count, ...rest } = error;
      return rest;
    }
    const { count, ...rest } = error;
    return {
      ...rest,
      message: `${rest.message} (${count} compartments)`,
    };
  });
}

function scanBudgetExpired(deadline) {
  return deadline && Date.now() > deadline;
}

function scanStoppedMessage(options, maxScanMs) {
  const prefix = `OCI inventory scan stopped after ${Math.round(maxScanMs / 1000)}s.`;
  return options.region === 'all'
    ? `${prefix} Select a single region for a complete scan.`
    : `${prefix} Narrow the connector Compartment OCID or refresh again for a complete scan.`;
}

function regionName(region) {
  return region.regionName || region.name || region.regionKey || '';
}

function compartmentName(compartment, tenancyId) {
  return compartment.name || (compartment.id === tenancyId ? 'Root tenancy' : compartment.id);
}

async function discoverCompartments(connector, {
  tenancyId,
  scopeCompartmentId,
  homeRegion,
  request,
  requestTimeoutMs,
  errors,
}) {
  const compartmentMap = new Map();
  const addCompartment = (compartment) => {
    if (!compartment?.id) {
      return;
    }
    compartmentMap.set(compartment.id, {
      id: compartment.id,
      name: compartment.name || (compartment.id === tenancyId ? 'Root tenancy' : 'Selected compartment'),
      description: compartment.description || '',
      status: compartment.lifecycleState || 'ACTIVE',
      parentCompartmentId: compartment.compartmentId || compartment.parentCompartmentId || '',
    });
  };

  addCompartment({
    id: scopeCompartmentId,
    name: scopeCompartmentId === tenancyId ? 'Root tenancy' : 'Selected compartment',
    lifecycleState: 'ACTIVE',
  });

  if (scopeCompartmentId === tenancyId) {
    const childCompartments = await requestList(
      connector,
      {
        service: 'identity',
        region: homeRegion,
        pathWithQuery:
          `/20160918/compartments?compartmentId=${encodeURIComponent(tenancyId)}&compartmentIdInSubtree=true&accessLevel=ACCESSIBLE&lifecycleState=ACTIVE`,
        request,
        timeoutMs: requestTimeoutMs,
      },
      errors,
      'compartments',
    );
    childCompartments.forEach(addCompartment);
    return Array.from(compartmentMap.values());
  }

  const visited = new Set();
  async function walk(parentId) {
    if (visited.has(parentId)) {
      return;
    }
    visited.add(parentId);
    const children = await requestList(
      connector,
      {
        service: 'identity',
        region: homeRegion,
        pathWithQuery:
          `/20160918/compartments?compartmentId=${encodeURIComponent(parentId)}&accessLevel=ACCESSIBLE&lifecycleState=ACTIVE`,
        request,
        timeoutMs: requestTimeoutMs,
      },
      errors,
      'compartments',
    );
    children.forEach(addCompartment);
    for (const child of children) {
      if (child.id) {
        await walk(child.id);
      }
    }
  }

  await walk(scopeCompartmentId);
  return Array.from(compartmentMap.values());
}

function baseResource(item, { providerType, region, compartment }) {
  return {
    id: item.id,
    name: item.displayName || item.name || item.id,
    region,
    compartmentId: compartment.id,
    compartmentName: compartmentName(compartment),
    providerType,
    status: item.lifecycleState || item.status || '-',
    createdAt: item.timeCreated || '',
  };
}

function normalizeCustomImage(image, { region, compartmentId = '', imageId = '', sourceInstanceId = '', sourceInstanceName = '' } = {}) {
  return {
    id: image.id || imageId || '',
    name: image.displayName || image.name || image.id || imageId || '',
    region,
    compartmentId: image.compartmentId || compartmentId,
    providerType: 'customImage',
    resourceType: 'customImage',
    status: image.lifecycleState || image.status || '-',
    createdAt: image.timeCreated || '',
    sizeGb: image.sizeInMBs ? Math.round((Number(image.sizeInMBs) / 1024) * 10) / 10 : '',
    operatingSystem: image.operatingSystem || '',
    operatingSystemVersion: image.operatingSystemVersion || '',
    launchMode: image.launchMode || '',
    imageType: image.imageType || '',
    listingType: image.listingType || '',
    sourceInstanceId,
    sourceInstanceName,
  };
}

function normalizeLaunchImage(image, { region, compartmentId = '' } = {}) {
  return {
    id: image.id || '',
    name: image.displayName || image.name || image.id || '',
    region,
    compartmentId: image.compartmentId || compartmentId,
    status: image.lifecycleState || image.status || '-',
    operatingSystem: image.operatingSystem || '',
    operatingSystemVersion: image.operatingSystemVersion || '',
    imageType: image.imageType || '',
    listingType: image.listingType || '',
  };
}

function normalizeLaunchShape(shape) {
  return {
    name: shape.shape || shape.name || '',
    processorDescription: shape.processorDescription || '',
    ocpus: shape.ocpus || shape.ocpuOptions?.defaultPerOcpu || '',
    memoryGb: shape.memoryInGBs || shape.memoryOptions?.defaultPerOcpuInGBs || '',
    isFlexible: Boolean(shape.isFlexible || String(shape.shape || '').endsWith('.Flex')),
  };
}

function isCustomImageForCompartment(image, compartmentId) {
  if (!image?.id || image.compartmentId !== compartmentId) {
    return false;
  }
  const imageType = String(image.imageType || '').toUpperCase();
  const listingType = String(image.listingType || '').toUpperCase();
  if (imageType && imageType !== 'CUSTOM') {
    return false;
  }
  if (listingType && ['ORACLE', 'MARKETPLACE', 'COMMUNITY'].includes(listingType)) {
    return false;
  }
  return true;
}

async function enrichInstances(connector, { region, compartment, instances, request, requestTimeoutMs, errors }) {
  return Promise.all(instances.map(async (instance) => {
    let privateIp = '';
    let publicIp = '';
    const attachments = await requestList(
      connector,
      {
        service: 'iaas',
        region,
        pathWithQuery:
          `/20160918/vnicAttachments?compartmentId=${encodeURIComponent(compartment.id)}&instanceId=${encodeURIComponent(instance.id)}`,
        request,
        timeoutMs: requestTimeoutMs,
        retryAttempts: 3,
      },
      errors,
      'vnicAttachments',
    );

    for (const attachment of attachments) {
      if (!attachment.vnicId || (privateIp && publicIp)) {
        continue;
      }
      const vnic = await requestJson(connector, {
        service: 'iaas',
        region,
        pathWithQuery: `/20160918/vnics/${encodeURIComponent(attachment.vnicId)}`,
        request,
        timeoutMs: requestTimeoutMs,
      });
      if (!vnic.ok) {
        errors.push({ scope: 'vnics', region, message: vnic.message });
        continue;
      }
      privateIp = privateIp || vnic.payload?.privateIp || '';
      publicIp = publicIp || vnic.payload?.publicIp || '';
    }

    return {
      ...baseResource(instance, { providerType: 'instance', region, compartment }),
      shape: instance.shape || '',
      availabilityDomain: instance.availabilityDomain || '',
      faultDomain: instance.faultDomain || '',
      ocpus: instance.shapeConfig?.ocpus || instance.shapeConfig?.ocpuCount || '',
      memoryGb: instance.shapeConfig?.memoryInGBs || instance.shapeConfig?.memoryInGB || '',
      storageSizeGb: instance.sourceDetails?.bootVolumeSizeInGBs || instance.sourceDetails?.bootVolumeSizeInGB || '',
      privateIp,
      publicIp,
    };
  }));
}

function updateInventorySummary(inventory) {
  inventory.summary.instances = inventory.instances.length;
  inventory.summary.runningInstances = inventory.instances.filter((item) => item.status === 'RUNNING').length;
  inventory.summary.stoppedInstances = inventory.instances.filter((item) => ['STOPPED', 'STOPPING'].includes(item.status)).length;
  inventory.summary.blockVolumes = inventory.blockVolumes.length;
  inventory.summary.bootVolumes = inventory.bootVolumes.length;
  inventory.summary.vcns = inventory.vcns.length;
  inventory.summary.subnets = inventory.subnets.length;
  inventory.summary.internetGateways = (inventory.internetGateways || []).length;
  inventory.summary.natGateways = (inventory.natGateways || []).length;
  inventory.summary.serviceGateways = (inventory.serviceGateways || []).length;
  inventory.summary.drgAttachments = (inventory.drgAttachments || []).length;
  inventory.summary.routeTables = (inventory.routeTables || []).length;
  inventory.summary.securityLists = (inventory.securityLists || []).length;
  inventory.summary.buckets = inventory.buckets.length;
  inventory.summary.dbSystems = (inventory.dbSystems || []).length;
  inventory.summary.autonomousDatabases = (inventory.autonomousDatabases || []).length;
  inventory.summary.autonomousContainerDatabases = (inventory.autonomousContainerDatabases || []).length;
  inventory.summary.exadataInfrastructures = (inventory.exadataInfrastructures || []).length;
  inventory.scan.instanceScanComplete = inventory.scan.instanceScanComplete
    && !inventory.errors.some((error) => error.scope === 'instances');
  inventory.scan.partial = inventory.errors.some((error) => ['inventoryScan', 'instances'].includes(error.scope));
}

async function reportInventoryProgress(inventory, onProgress, progress = {}) {
  if (typeof onProgress !== 'function') {
    return;
  }
  updateInventorySummary(inventory);
  await onProgress({
    ...inventory,
    generatedAt: new Date().toISOString(),
    scan: {
      ...inventory.scan,
      ...progress,
      inProgress: progress.inProgress !== false,
    },
  });
}

export async function getOciInventory(connector, options = {}) {
  if (!connector.privateKey) {
    const error = new Error('OCI private key is not stored.');
    error.statusCode = 400;
    throw error;
  }
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected OCI connector before loading inventory.');
    error.statusCode = 400;
    throw error;
  }

  const errors = [];
  const homeRegion = connector.region;
  const tenancyId = connector.tenancyOcid;
  const scopeCompartmentId = connector.compartmentOcid || tenancyId;
  const requestedRegion = options.region && !['all', 'home'].includes(options.region) ? options.region : '';
  const homeOnly = options.region === 'home' || !options.region;
  const request = options.request || https.request;
  const requestTimeoutMs = Number(options.requestTimeoutMs || 20000);
  const maxScanMs = Number(options.maxScanMs || (options.region === 'all' ? 240000 : 180000));
  const compartmentConcurrency = Math.max(1, Math.min(8, Number(options.compartmentConcurrency || 5)));
  const scanDeadline = Date.now() + maxScanMs;
  const onProgress = options.onProgress;

  const subscribedRegions = await requestList(
    connector,
    {
      service: 'identity',
      region: homeRegion,
      pathWithQuery: `/20160918/tenancies/${encodeURIComponent(tenancyId)}/regionSubscriptions`,
      request,
      timeoutMs: requestTimeoutMs,
    },
    errors,
    'regionSubscriptions',
  );
  const regions = (subscribedRegions.length ? subscribedRegions : [{ regionName: homeRegion, status: 'READY' }])
    .filter((region) => String(region.status || 'READY').toUpperCase() !== 'INACTIVE')
    .map((region) => ({
      name: regionName(region),
      key: region.regionKey || '',
      status: region.status || 'READY',
      home: region.isHomeRegion === true || regionName(region) === homeRegion,
    }))
    .filter((region) => region.name);

  if (options.regionsOnly) {
    return {
      generatedAt: new Date().toISOString(),
      connector: {
        id: connector.id,
        name: connector.name,
        region: connector.region,
        tenancyOcid: connector.tenancyOcid,
      },
      summary: {
        regions: regions.length,
        compartments: 0,
        instances: 0,
        runningInstances: 0,
        stoppedInstances: 0,
        blockVolumes: 0,
        bootVolumes: 0,
        vcns: 0,
        subnets: 0,
        internetGateways: 0,
        natGateways: 0,
        serviceGateways: 0,
        drgAttachments: 0,
        routeTables: 0,
        securityLists: 0,
        buckets: 0,
        dbSystems: 0,
        autonomousDatabases: 0,
        autonomousContainerDatabases: 0,
        exadataInfrastructures: 0,
      },
      regions,
      compartments: [],
      instances: [],
      blockVolumes: [],
      bootVolumes: [],
      vcns: [],
      subnets: [],
      internetGateways: [],
      natGateways: [],
      serviceGateways: [],
      drgAttachments: [],
      routeTables: [],
      securityLists: [],
      buckets: [],
      dbSystems: [],
      autonomousDatabases: [],
      autonomousContainerDatabases: [],
      exadataInfrastructures: [],
      errors,
      scan: {
        requestedRegion: 'regions',
        homeRegion,
        scannedRegions: regions.map((region) => region.name),
        compartmentScopeId: scopeCompartmentId,
        scannedCompartments: 0,
        instanceScanComplete: true,
        partial: false,
      },
    };
  }

  if (options.identityOnly) {
    const compartments = await discoverCompartments(connector, {
      tenancyId,
      scopeCompartmentId,
      homeRegion,
      request,
      requestTimeoutMs,
      errors,
    });

    return {
      generatedAt: new Date().toISOString(),
      connector: {
        id: connector.id,
        name: connector.name,
        region: connector.region,
        tenancyOcid: connector.tenancyOcid,
      },
      summary: {
        regions: regions.length,
        compartments: compartments.length,
        instances: 0,
        runningInstances: 0,
        stoppedInstances: 0,
        blockVolumes: 0,
        bootVolumes: 0,
        vcns: 0,
        subnets: 0,
        internetGateways: 0,
        natGateways: 0,
        serviceGateways: 0,
        drgAttachments: 0,
        routeTables: 0,
        securityLists: 0,
        buckets: 0,
        dbSystems: 0,
        autonomousDatabases: 0,
        autonomousContainerDatabases: 0,
        exadataInfrastructures: 0,
      },
      regions,
      compartments,
      instances: [],
      blockVolumes: [],
      bootVolumes: [],
      vcns: [],
      subnets: [],
      internetGateways: [],
      natGateways: [],
      serviceGateways: [],
      drgAttachments: [],
      routeTables: [],
      securityLists: [],
      buckets: [],
      dbSystems: [],
      autonomousDatabases: [],
      autonomousContainerDatabases: [],
      exadataInfrastructures: [],
      errors,
      scan: {
        requestedRegion: 'identity',
        homeRegion,
        scannedRegions: regions.map((region) => region.name),
        compartmentScopeId: scopeCompartmentId,
        scannedCompartments: compartments.length,
        instanceScanComplete: true,
        partial: false,
      },
    };
  }

  const scanRegions = requestedRegion
    ? regions.filter((region) => region.name === requestedRegion)
    : homeOnly
      ? regions.filter((region) => region.name === homeRegion)
      : regions;
  if (requestedRegion && scanRegions.length === 0) {
    scanRegions.push({ name: requestedRegion, key: '', status: 'REQUESTED', home: requestedRegion === homeRegion });
  }

  const compartments = await discoverCompartments(connector, {
    tenancyId,
    scopeCompartmentId,
    homeRegion,
    request,
    requestTimeoutMs,
    errors,
  });

  const inventory = {
    generatedAt: new Date().toISOString(),
    connector: {
      id: connector.id,
      name: connector.name,
      region: connector.region,
      tenancyOcid: connector.tenancyOcid,
    },
    summary: {
      regions: regions.length,
      compartments: compartments.length,
      instances: 0,
      runningInstances: 0,
      stoppedInstances: 0,
      blockVolumes: 0,
      bootVolumes: 0,
      vcns: 0,
      subnets: 0,
      internetGateways: 0,
      natGateways: 0,
      serviceGateways: 0,
      drgAttachments: 0,
      routeTables: 0,
      securityLists: 0,
      buckets: 0,
      dbSystems: 0,
      autonomousDatabases: 0,
      autonomousContainerDatabases: 0,
      exadataInfrastructures: 0,
    },
    regions,
    compartments,
    instances: [],
    blockVolumes: [],
    bootVolumes: [],
    vcns: [],
    subnets: [],
    internetGateways: [],
    natGateways: [],
    serviceGateways: [],
    drgAttachments: [],
    routeTables: [],
    securityLists: [],
    buckets: [],
    dbSystems: [],
    autonomousDatabases: [],
    autonomousContainerDatabases: [],
    exadataInfrastructures: [],
    errors,
      scan: {
        requestedRegion: options.region || 'home',
        homeRegion,
        scannedRegions: scanRegions.map((region) => region.name),
        compartmentScopeId: scopeCompartmentId,
        scannedCompartments: compartments.length,
        scannedResourceCompartments: 0,
        totalResourceCompartments: scanRegions.length * compartments.length,
        instanceScanComplete: true,
        partial: false,
        inProgress: false,
      },
  };

  await reportInventoryProgress(inventory, onProgress, {
    phase: 'Discovered regions and compartments',
    currentRegion: '',
    currentCompartmentName: '',
    scannedResourceCompartments: 0,
    inProgress: true,
  });

  for (const region of scanRegions) {
    if (scanBudgetExpired(scanDeadline)) {
      errors.push({
        scope: 'inventoryScan',
        message: scanStoppedMessage(options, maxScanMs),
      });
      break;
    }

    const namespaceResponse = await requestJson(connector, {
      service: 'objectstorage',
      region: region.name,
      pathWithQuery: '/n/',
      request,
      timeoutMs: requestTimeoutMs,
    });
    const namespace = namespaceResponse.ok && typeof namespaceResponse.payload === 'string'
      ? namespaceResponse.payload
      : namespaceResponse.ok && namespaceResponse.payload?.namespace
        ? namespaceResponse.payload.namespace
        : '';
    if (!namespaceResponse.ok) {
      errors.push({ scope: 'objectStorageNamespace', region: region.name, message: namespaceResponse.message });
    }

    const availabilityDomains = await requestList(
      connector,
      {
        service: 'identity',
        region: region.name,
        pathWithQuery: `/20160918/availabilityDomains?compartmentId=${encodeURIComponent(tenancyId)}`,
        request,
        timeoutMs: requestTimeoutMs,
      },
      errors,
      'availabilityDomains',
    );

    for (let index = 0; index < compartments.length; index += compartmentConcurrency) {
      if (scanBudgetExpired(scanDeadline)) {
        errors.push({
          scope: 'inventoryScan',
          region: region.name,
          message: scanStoppedMessage(options, maxScanMs),
        });
        break;
      }

      await Promise.all(compartments.slice(index, index + compartmentConcurrency).map(async (compartment) => {
        if (scanBudgetExpired(scanDeadline)) {
          return;
        }

        const compartmentId = encodeURIComponent(compartment.id);
        const [instances, volumes, vcns, subnets, internetGateways, natGateways, serviceGateways, drgAttachments, routeTables, securityLists, dbSystems, autonomousDatabases, autonomousContainerDatabases, exadataInfrastructures] = await Promise.all([
          requestList(connector, {
            service: 'iaas',
            region: region.name,
            pathWithQuery: `/20160918/instances?compartmentId=${compartmentId}`,
            request,
            timeoutMs: requestTimeoutMs,
            retryAttempts: 6,
          }, errors, 'instances'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/volumes?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'volumes'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/vcns?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'vcns'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/subnets?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'subnets'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/internetGateways?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'internetGateways'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/natGateways?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'natGateways'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/serviceGateways?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'serviceGateways'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/drgAttachments?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'drgAttachments'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/routeTables?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'routeTables'),
          requestList(connector, { service: 'iaas', region: region.name, pathWithQuery: `/20160918/securityLists?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'securityLists'),
          requestList(connector, { service: 'database', region: region.name, pathWithQuery: `/20160918/dbSystems?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'dbSystems'),
          requestList(connector, { service: 'database', region: region.name, pathWithQuery: `/20160918/autonomousDatabases?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'autonomousDatabases'),
          requestList(connector, { service: 'database', region: region.name, pathWithQuery: `/20160918/autonomousContainerDatabases?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'autonomousContainerDatabases'),
          requestList(connector, { service: 'database', region: region.name, pathWithQuery: `/20160918/exadataInfrastructures?compartmentId=${compartmentId}`, request, timeoutMs: requestTimeoutMs }, errors, 'exadataInfrastructures'),
        ]);

        inventory.instances.push(...await enrichInstances(connector, {
          region: region.name,
          compartment,
          instances,
          request,
          requestTimeoutMs,
          errors,
        }));
        inventory.blockVolumes.push(...volumes.map((volume) => ({
          ...baseResource(volume, { providerType: 'blockVolume', region: region.name, compartment }),
          sizeGb: volume.sizeInGBs || volume.sizeInGB || '',
          availabilityDomain: volume.availabilityDomain || '',
        })));
        inventory.vcns.push(...vcns.map((vcn) => ({
          ...baseResource(vcn, { providerType: 'vcn', region: region.name, compartment }),
          cidrBlock: vcn.cidrBlock || '',
          dnsLabel: vcn.dnsLabel || '',
        })));
        inventory.subnets.push(...subnets.map((subnet) => ({
          ...baseResource(subnet, { providerType: 'subnet', region: region.name, compartment }),
          cidrBlock: subnet.cidrBlock || '',
          availabilityDomain: subnet.availabilityDomain || 'regional',
          vcnId: subnet.vcnId || '',
        })));
        inventory.internetGateways.push(...internetGateways.map((gateway) => ({
          ...baseResource(gateway, { providerType: 'internetGateway', region: region.name, compartment }),
          resourceType: 'internetGateway',
          vcnId: gateway.vcnId || '',
          routeTableId: gateway.routeTableId || '',
          gatewayType: 'internetGateway',
        })));
        inventory.natGateways.push(...natGateways.map((gateway) => ({
          ...baseResource(gateway, { providerType: 'natGateway', region: region.name, compartment }),
          resourceType: 'natGateway',
          vcnId: gateway.vcnId || '',
          routeTableId: gateway.routeTableId || '',
          publicIp: gateway.natIp || gateway.publicIp || '',
          gatewayType: 'natGateway',
        })));
        inventory.serviceGateways.push(...serviceGateways.map((gateway) => ({
          ...baseResource(gateway, { providerType: 'serviceGateway', region: region.name, compartment }),
          resourceType: 'serviceGateway',
          vcnId: gateway.vcnId || '',
          routeTableId: gateway.routeTableId || '',
          gatewayType: 'serviceGateway',
          services: Array.isArray(gateway.services) ? gateway.services : [],
        })));
        inventory.drgAttachments.push(...drgAttachments.map((attachment) => ({
          ...baseResource(attachment, { providerType: 'drgAttachment', region: region.name, compartment }),
          resourceType: 'drgAttachment',
          vcnId: attachment.vcnId || attachment.networkDetails?.id || '',
          drgId: attachment.drgId || '',
          routeTableId: attachment.routeTableId || attachment.drgRouteTableId || '',
          gatewayType: 'drgAttachment',
        })));
        inventory.routeTables.push(...routeTables.map((table) => ({
          ...baseResource(table, { providerType: 'routeTable', region: region.name, compartment }),
          resourceType: 'routeTable',
          vcnId: table.vcnId || '',
          routeRules: Array.isArray(table.routeRules) ? table.routeRules : [],
          rulesCount: Array.isArray(table.routeRules) ? table.routeRules.length : 0,
        })));
        inventory.securityLists.push(...securityLists.map((list) => ({
          ...baseResource(list, { providerType: 'securityList', region: region.name, compartment }),
          resourceType: 'securityList',
          vcnId: list.vcnId || '',
          ingressSecurityRules: Array.isArray(list.ingressSecurityRules) ? list.ingressSecurityRules : [],
          egressSecurityRules: Array.isArray(list.egressSecurityRules) ? list.egressSecurityRules : [],
          rulesCount: (list.ingressSecurityRules || list.egressSecurityRules || []).length,
        })));
        inventory.dbSystems.push(...dbSystems.map((item) =>
          normalizeOciDatabaseResource(item, { region: region.name, compartmentId: compartment.id, resourceType: 'dbSystem' }),
        ));
        inventory.autonomousDatabases.push(...autonomousDatabases.map((item) =>
          normalizeOciDatabaseResource(item, { region: region.name, compartmentId: compartment.id, resourceType: 'autonomousDatabase' }),
        ));
        inventory.autonomousContainerDatabases.push(...autonomousContainerDatabases.map((item) =>
          normalizeOciDatabaseResource(item, { region: region.name, compartmentId: compartment.id, resourceType: 'autonomousContainerDatabase' }),
        ));
        inventory.exadataInfrastructures.push(...exadataInfrastructures.map((item) =>
          normalizeOciDatabaseResource(item, { region: region.name, compartmentId: compartment.id, resourceType: 'exadataInfrastructure' }),
        ));

        const bootVolumeLists = await Promise.all(
          availabilityDomains.map((ad) =>
            requestList(
              connector,
              {
                service: 'iaas',
                region: region.name,
                pathWithQuery: `/20160918/bootVolumes?compartmentId=${compartmentId}&availabilityDomain=${encodeURIComponent(ad.name)}`,
                request,
                timeoutMs: requestTimeoutMs,
              },
              errors,
              'bootVolumes',
            ),
          ),
        );
        inventory.bootVolumes.push(...bootVolumeLists.flat().map((volume) => ({
          ...baseResource(volume, { providerType: 'bootVolume', region: region.name, compartment }),
          sizeGb: volume.sizeInGBs || volume.sizeInGB || '',
          availabilityDomain: volume.availabilityDomain || '',
        })));

        if (namespace) {
          const buckets = await requestList(
            connector,
            {
              service: 'objectstorage',
              region: region.name,
              pathWithQuery: `/n/${encodeURIComponent(namespace)}/b?compartmentId=${compartmentId}`,
              request,
              timeoutMs: requestTimeoutMs,
            },
            errors,
            'buckets',
          );
          inventory.buckets.push(...buckets.map((bucket) => normalizeOciBucket(bucket, {
            region: region.name,
            compartment,
            namespace,
          })));
        }
      }));

      inventory.scan.scannedResourceCompartments += Math.min(compartmentConcurrency, compartments.length - index);
      await reportInventoryProgress(inventory, onProgress, {
        phase: 'Scanning resources',
        currentRegion: region.name,
        currentCompartmentName: compartments[Math.min(index + compartmentConcurrency - 1, compartments.length - 1)]?.name || '',
        scannedResourceCompartments: inventory.scan.scannedResourceCompartments,
        inProgress: true,
      });
    }
  }

  updateInventorySummary(inventory);
  inventory.errors = compactOciErrors(inventory.errors);
  inventory.scan.partial = inventory.errors.length > 0;
  inventory.scan.instanceScanComplete = !inventory.errors.some((error) => ['inventoryScan', 'instances'].includes(error.scope));
  await reportInventoryProgress(inventory, onProgress, {
    phase: 'Scan complete',
    currentRegion: '',
    currentCompartmentName: '',
    scannedResourceCompartments: inventory.scan.totalResourceCompartments,
    inProgress: false,
  });

  return inventory;
}

export async function getOciInstances(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  if (!connector.privateKey) {
    const error = new Error('OCI private key is not stored.');
    error.statusCode = 400;
    throw error;
  }
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected OCI connector before loading instances.');
    error.statusCode = 400;
    throw error;
  }
  if (!region) {
    const error = new Error('OCI region is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!compartmentId) {
    const error = new Error('OCI compartment is required.');
    error.statusCode = 400;
    throw error;
  }

  const errors = [];
  const instances = await requestList(
    connector,
    {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/instances?compartmentId=${encodeURIComponent(compartmentId)}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 6,
    },
    errors,
    'instances',
  );
  const compartment = { id: compartmentId, name: compartmentId, lifecycleState: 'ACTIVE' };
  const enrichedInstances = await enrichInstances(connector, {
    region,
    compartment,
    instances,
    request,
    requestTimeoutMs,
    errors,
  });

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    cached: false,
    lastScannedAt: new Date().toISOString(),
    instances: enrichedInstances,
    errors,
  };
}

export async function getOciScopedResources(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  if (!connector.privateKey) {
    const error = new Error('OCI private key is not stored.');
    error.statusCode = 400;
    throw error;
  }
  if (connector.status !== 'verified') {
    const error = new Error('Verify the selected OCI connector before loading resources.');
    error.statusCode = 400;
    throw error;
  }
  if (!region) {
    const error = new Error('OCI region is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!compartmentId) {
    const error = new Error('OCI compartment is required.');
    error.statusCode = 400;
    throw error;
  }

  const errors = [];
  const compartment = { id: compartmentId, name: compartmentId, lifecycleState: 'ACTIVE' };
  const encodedCompartmentId = encodeURIComponent(compartmentId);

  const [
    instances,
    blockVolumes,
    vcns,
    subnets,
    internetGateways,
    natGateways,
    serviceGateways,
    drgAttachments,
    routeTables,
    securityLists,
    dbSystems,
    autonomousDatabases,
    autonomousContainerDatabases,
    exadataInfrastructures,
    availabilityDomains,
    namespaceResponse,
  ] = await Promise.all([
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/instances?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 6,
    }, errors, 'instances'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/volumes?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'blockVolumes'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/vcns?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'vcns'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/subnets?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'subnets'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/internetGateways?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'internetGateways'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/natGateways?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'natGateways'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/serviceGateways?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'serviceGateways'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/drgAttachments?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'drgAttachments'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/routeTables?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'routeTables'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/securityLists?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'securityLists'),
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/dbSystems?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'dbSystems'),
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/autonomousDatabases?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'autonomousDatabases'),
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/autonomousContainerDatabases?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'autonomousContainerDatabases'),
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/exadataInfrastructures?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'exadataInfrastructures'),
    requestList(connector, {
      service: 'identity',
      region,
      pathWithQuery: `/20160918/availabilityDomains?compartmentId=${encodeURIComponent(connector.tenancyOcid)}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'availabilityDomains'),
    requestJson(connector, {
      service: 'objectstorage',
      region,
      pathWithQuery: '/n/',
      request,
      timeoutMs: requestTimeoutMs,
    }),
  ]);

  const bootVolumeLists = await Promise.all(
    availabilityDomains.map((ad) =>
      requestList(connector, {
        service: 'iaas',
        region,
        pathWithQuery: `/20160918/bootVolumes?compartmentId=${encodedCompartmentId}&availabilityDomain=${encodeURIComponent(ad.name)}`,
        request,
        timeoutMs: requestTimeoutMs,
        retryAttempts: 4,
      }, errors, 'bootVolumes'),
    ),
  );

  const namespace = namespaceResponse.ok && typeof namespaceResponse.payload === 'string'
    ? namespaceResponse.payload
    : namespaceResponse.ok && namespaceResponse.payload?.namespace
      ? namespaceResponse.payload.namespace
      : '';
  if (!namespaceResponse.ok) {
    errors.push({ scope: 'objectStorageNamespace', region, message: namespaceResponse.message });
  }

  const buckets = namespace
    ? await requestList(connector, {
      service: 'objectstorage',
      region,
      pathWithQuery: `/n/${encodeURIComponent(namespace)}/b?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'buckets')
    : [];

  const now = new Date().toISOString();
  const enrichedInstances = await enrichInstances(connector, {
    region,
    compartment,
    instances,
    request,
    requestTimeoutMs,
    errors,
  });

  return {
    generatedAt: now,
    region,
    compartmentId,
    cached: false,
    lastScannedAt: now,
    summary: {
      instances: instances.length,
      runningInstances: instances.filter((item) => item.lifecycleState === 'RUNNING').length,
      stoppedInstances: instances.filter((item) => ['STOPPED', 'STOPPING'].includes(item.lifecycleState)).length,
      blockVolumes: blockVolumes.length,
      bootVolumes: bootVolumeLists.flat().length,
      vcns: vcns.length,
      subnets: subnets.length,
      internetGateways: internetGateways.length,
      natGateways: natGateways.length,
      serviceGateways: serviceGateways.length,
      drgAttachments: drgAttachments.length,
      routeTables: routeTables.length,
      securityLists: securityLists.length,
      buckets: buckets.length,
      dbSystems: dbSystems.length,
      autonomousDatabases: autonomousDatabases.length,
      autonomousContainerDatabases: autonomousContainerDatabases.length,
      exadataInfrastructures: exadataInfrastructures.length,
    },
    instances: enrichedInstances,
    blockVolumes: blockVolumes.map((volume) => ({
      ...baseResource(volume, { providerType: 'blockVolume', region, compartment }),
      sizeGb: volume.sizeInGBs || volume.sizeInGB || '',
      availabilityDomain: volume.availabilityDomain || '',
    })),
    bootVolumes: bootVolumeLists.flat().map((volume) => ({
      ...baseResource(volume, { providerType: 'bootVolume', region, compartment }),
      sizeGb: volume.sizeInGBs || volume.sizeInGB || '',
      availabilityDomain: volume.availabilityDomain || '',
    })),
    vcns: vcns.map((vcn) => ({
      ...baseResource(vcn, { providerType: 'vcn', region, compartment }),
      cidrBlock: vcn.cidrBlock || '',
      dnsLabel: vcn.dnsLabel || '',
    })),
    subnets: subnets.map((subnet) => ({
      ...baseResource(subnet, { providerType: 'subnet', region, compartment }),
      cidrBlock: subnet.cidrBlock || '',
      availabilityDomain: subnet.availabilityDomain || 'regional',
      vcnId: subnet.vcnId || '',
    })),
    internetGateways: internetGateways.map((gateway) => ({
      ...baseResource(gateway, { providerType: 'internetGateway', region, compartment }),
      resourceType: 'internetGateway',
      vcnId: gateway.vcnId || '',
      routeTableId: gateway.routeTableId || '',
      gatewayType: 'internetGateway',
    })),
    natGateways: natGateways.map((gateway) => ({
      ...baseResource(gateway, { providerType: 'natGateway', region, compartment }),
      resourceType: 'natGateway',
      vcnId: gateway.vcnId || '',
      routeTableId: gateway.routeTableId || '',
      publicIp: gateway.natIp || gateway.publicIp || '',
      gatewayType: 'natGateway',
    })),
    serviceGateways: serviceGateways.map((gateway) => ({
      ...baseResource(gateway, { providerType: 'serviceGateway', region, compartment }),
      resourceType: 'serviceGateway',
      vcnId: gateway.vcnId || '',
      routeTableId: gateway.routeTableId || '',
      gatewayType: 'serviceGateway',
      services: Array.isArray(gateway.services) ? gateway.services : [],
    })),
    drgAttachments: drgAttachments.map((attachment) => ({
      ...baseResource(attachment, { providerType: 'drgAttachment', region, compartment }),
      resourceType: 'drgAttachment',
      vcnId: attachment.vcnId || attachment.networkDetails?.id || '',
      drgId: attachment.drgId || '',
      routeTableId: attachment.routeTableId || attachment.drgRouteTableId || '',
      gatewayType: 'drgAttachment',
    })),
    routeTables: routeTables.map((table) => ({
      ...baseResource(table, { providerType: 'routeTable', region, compartment }),
      resourceType: 'routeTable',
      vcnId: table.vcnId || '',
      routeRules: Array.isArray(table.routeRules) ? table.routeRules : [],
      rulesCount: Array.isArray(table.routeRules) ? table.routeRules.length : 0,
    })),
    securityLists: securityLists.map((list) => ({
      ...baseResource(list, { providerType: 'securityList', region, compartment }),
      resourceType: 'securityList',
      vcnId: list.vcnId || '',
      ingressSecurityRules: Array.isArray(list.ingressSecurityRules) ? list.ingressSecurityRules : [],
      egressSecurityRules: Array.isArray(list.egressSecurityRules) ? list.egressSecurityRules : [],
      rulesCount: (list.ingressSecurityRules || list.egressSecurityRules || []).length,
    })),
    buckets: buckets.map((bucket) => ({
      ...normalizeOciBucket(bucket, { region, compartment, namespace }),
    })),
    dbSystems: dbSystems.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'dbSystem' })),
    autonomousDatabases: autonomousDatabases.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'autonomousDatabase' })),
    autonomousContainerDatabases: autonomousContainerDatabases.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'autonomousContainerDatabase' })),
    exadataInfrastructures: exadataInfrastructures.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'exadataInfrastructure' })),
    errors,
  };
}

export async function getOciAvailabilityDomains(connector, {
  region,
  request = https.request,
  requestTimeoutMs = 10000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI availability domains');
  assertRequired(region, 'OCI region is required.');

  const errors = [];
  const availabilityDomains = await requestList(connector, {
    service: 'identity',
    region,
    pathWithQuery: `/20160918/availabilityDomains?compartmentId=${encodeURIComponent(connector.tenancyOcid)}`,
    request,
    timeoutMs: requestTimeoutMs,
    retryAttempts: 4,
  }, errors, 'availabilityDomains');

  return {
    generatedAt: new Date().toISOString(),
    region,
    availabilityDomains: availabilityDomains
      .map((ad) => ad.name || ad.id || '')
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
    errors,
  };
}

export async function getOciLaunchOptions(connector, {
  region,
  compartmentId,
  networkCompartmentId = '',
  availabilityDomain = '',
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI launch options');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment is required.');

  const errors = [];
  const encodedCompartmentId = encodeURIComponent(compartmentId);
  const subnetCompartmentId = networkCompartmentId || compartmentId;
  const encodedSubnetCompartmentId = encodeURIComponent(subnetCompartmentId);
  const availabilityDomains = await requestList(connector, {
    service: 'identity',
    region,
    pathWithQuery: `/20160918/availabilityDomains?compartmentId=${encodeURIComponent(connector.tenancyOcid)}`,
    request,
    timeoutMs: requestTimeoutMs,
    retryAttempts: 4,
  }, errors, 'availabilityDomains');
  const selectedAd = availabilityDomain || availabilityDomains[0]?.name || '';
  const shapePath = selectedAd
    ? `/20160918/shapes?compartmentId=${encodedCompartmentId}&availabilityDomain=${encodeURIComponent(selectedAd)}`
    : `/20160918/shapes?compartmentId=${encodedCompartmentId}`;

  const [images, subnets, shapes] = await Promise.all([
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/images?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'images'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/subnets?compartmentId=${encodedSubnetCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'subnets'),
    requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: shapePath,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'shapes'),
  ]);

  const byShape = new Map();
  shapes.map(normalizeLaunchShape).forEach((shape) => {
    if (shape.name) {
      byShape.set(shape.name, shape);
    }
  });
  const bySubnet = new Map();
  subnets.forEach((subnet) => {
    if (subnet?.id) {
      bySubnet.set(subnet.id, subnet);
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    networkCompartmentId: subnetCompartmentId,
    availabilityDomains: availabilityDomains
      .map((ad) => ad.name || ad.id || '')
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
    shapes: Array.from(byShape.values()).sort((left, right) => left.name.localeCompare(right.name)),
    images: images
      .map((image) => normalizeLaunchImage(image, { region, compartmentId }))
      .filter((image) => image.id)
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    subnets: Array.from(bySubnet.values())
      .map((subnet) => {
        const subnetCompartment = {
          id: subnet.compartmentId || subnetCompartmentId,
          name: subnet.compartmentId || subnetCompartmentId,
          lifecycleState: 'ACTIVE',
        };
        return {
          ...baseResource(subnet, { providerType: 'subnet', region, compartment: subnetCompartment }),
          cidrBlock: subnet.cidrBlock || '',
          availabilityDomain: subnet.availabilityDomain || 'regional',
          vcnId: subnet.vcnId || '',
        };
      })
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    errors,
  };
}

function assertOciConnectorReady(connector, operation = 'manage OCI instances') {
  if (!connector.privateKey) {
    const error = new Error('OCI private key is not stored.');
    error.statusCode = 400;
    throw error;
  }
  if (connector.status !== 'verified') {
    const error = new Error(`Verify the selected OCI connector before you ${operation}.`);
    error.statusCode = 400;
    throw error;
  }
}

function assertRequired(value, message) {
  if (!String(value || '').trim()) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

async function runOciMutation(connector, { region, pathWithQuery, method = 'POST', body, successMessage, request = https.request, timeoutMs = 30000, service = 'iaas' }) {
  assertOciConnectorReady(connector);
  assertRequired(region, 'OCI region is required.');
  const response = await requestJson(connector, {
    service,
    region,
    pathWithQuery,
    method,
    body,
    request,
    timeoutMs,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'OCI operation failed.');
    error.statusCode = response.statusCode || 502;
    throw error;
  }
  return {
    generatedAt: new Date().toISOString(),
    message: successMessage,
    result: response.payload,
  };
}

export async function runOciInstanceAction(connector, { region, instanceId, action }) {
  const normalizedAction = String(action || '').toUpperCase();
  const actions = {
    start: 'START',
    stop: 'STOP',
    reboot: 'SOFTRESET',
    reset: 'RESET',
  };
  const ociAction = actions[normalizedAction.toLowerCase()];
  if (!ociAction) {
    const error = new Error('Unsupported OCI VM action.');
    error.statusCode = 400;
    throw error;
  }
  assertRequired(instanceId, 'OCI instance OCID is required.');
  return runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/instances/${encodeURIComponent(instanceId)}?action=${ociAction}`,
    method: 'POST',
    successMessage: `OCI VM ${normalizedAction.toLowerCase()} requested.`,
  });
}

export async function getOciInstanceStatus(connector, { region, instanceId }) {
  assertOciConnectorReady(connector, 'load OCI VM status');
  assertRequired(region, 'OCI region is required.');
  assertRequired(instanceId, 'OCI instance OCID is required.');

  const response = await requestJson(connector, {
    service: 'iaas',
    region,
    pathWithQuery: `/20160918/instances/${encodeURIComponent(instanceId)}`,
    method: 'GET',
    timeoutMs: 20000,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'Unable to load OCI VM status.');
    error.statusCode = response.statusCode || 502;
    throw error;
  }

  const instance = response.payload || {};
  return {
    generatedAt: new Date().toISOString(),
    instance: {
      id: instance.id || instanceId,
      name: instance.displayName || instance.name || instance.id || instanceId,
      region,
      compartmentId: instance.compartmentId || '',
      compartmentName: instance.compartmentId || '',
      providerType: 'instance',
      resourceType: 'instance',
      status: instance.lifecycleState || instance.status || '-',
      createdAt: instance.timeCreated || '',
      shape: instance.shape || '',
      availabilityDomain: instance.availabilityDomain || '',
      faultDomain: instance.faultDomain || '',
      ocpus: instance.shapeConfig?.ocpus || instance.shapeConfig?.ocpuCount || '',
      memoryGb: instance.shapeConfig?.memoryInGBs || instance.shapeConfig?.memoryInGB || '',
      storageSizeGb: instance.sourceDetails?.bootVolumeSizeInGBs || instance.sourceDetails?.bootVolumeSizeInGB || '',
    },
  };
}

function normalizeLaunchedInstance(instance, { region, input = {} } = {}) {
  return {
    id: instance.id || '',
    name: instance.displayName || input.displayName || instance.id || '',
    region,
    compartmentId: instance.compartmentId || input.compartmentId || '',
    compartmentName: instance.compartmentId || input.compartmentId || '',
    providerType: 'instance',
    resourceType: 'instance',
    status: instance.lifecycleState || instance.status || 'PROVISIONING',
    createdAt: instance.timeCreated || new Date().toISOString(),
    shape: instance.shape || input.shape || '',
    availabilityDomain: instance.availabilityDomain || input.availabilityDomain || '',
    ocpus: instance.shapeConfig?.ocpus || input.ocpus || '',
    memoryGb: instance.shapeConfig?.memoryInGBs || input.memoryGb || '',
    storageSizeGb: input.bootVolumeSizeGb || '',
  };
}

function normalizeOciVolume(volume, { region, input = {}, resourceType = 'blockVolume' } = {}) {
  return {
    id: volume.id || '',
    name: volume.displayName || input.displayName || volume.name || volume.id || '',
    region,
    compartmentId: volume.compartmentId || input.compartmentId || '',
    compartmentName: volume.compartmentId || input.compartmentId || '',
    providerType: resourceType,
    resourceType,
    status: volume.lifecycleState || volume.status || 'PROVISIONING',
    createdAt: volume.timeCreated || new Date().toISOString(),
    sizeGb: volume.sizeInGBs || volume.sizeInGB || input.sizeInGBs || input.sizeGb || '',
    availabilityDomain: volume.availabilityDomain || input.availabilityDomain || '',
  };
}

function volumeApi(resourceType) {
  return resourceType === 'bootVolume'
    ? { collection: 'bootVolumes', backupCollection: 'bootVolumeBackups', sourceType: 'bootVolume', backupSourceType: 'bootVolumeBackup', idField: 'bootVolumeId' }
    : { collection: 'volumes', backupCollection: 'volumeBackups', sourceType: 'volume', backupSourceType: 'volumeBackup', idField: 'volumeId' };
}

function normalizeOciVolumeBackup(backup, { region, resourceType = 'blockVolume', sourceVolumeId = '' } = {}) {
  const api = volumeApi(resourceType);
  return {
    id: backup.id || '',
    name: backup.displayName || backup.name || backup.id || '',
    region,
    compartmentId: backup.compartmentId || '',
    providerType: `${resourceType}Backup`,
    resourceType: `${resourceType}Backup`,
    status: backup.lifecycleState || backup.status || '',
    createdAt: backup.timeCreated || backup.createdAt || '',
    sizeGb: backup.sizeInGBs || backup.sizeInGB || '',
    backupType: backup.type || '',
    sourceVolumeId: backup[api.idField] || sourceVolumeId,
  };
}

function normalizeOciVolumeGroupResource(item, { region, compartmentId, resourceType } = {}) {
  return {
    id: item.id || '',
    name: item.displayName || item.name || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    providerType: resourceType,
    resourceType,
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
    sizeGb: item.sizeInGBs || item.sizeInGB || '',
    availabilityDomain: item.availabilityDomain || '',
    backupType: item.type || '',
    sourceVolumeGroupId: item.volumeGroupId || item.sourceVolumeGroupId || '',
    destinationRegion: item.destinationRegion || item.replicaRegion || '',
    volumeIds: Array.isArray(item.volumeIds) ? item.volumeIds : [],
  };
}

function normalizeOciFileStorageResource(item, { region, compartmentId, resourceType, fileSystemId = '' } = {}) {
  const exportOptions = Array.isArray(item.exportOptions) ? item.exportOptions : [];
  return {
    id: item.id || '',
    name: item.displayName || item.name || item.path || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    providerType: resourceType,
    resourceType,
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
    availabilityDomain: item.availabilityDomain || '',
    fileSystemId: item.fileSystemId || fileSystemId || '',
    mountTargetId: item.mountTargetId || '',
    exportSetId: item.exportSetId || '',
    path: item.path || '',
    sizeGb: item.meteredBytes ? Math.round(Number(item.meteredBytes) / 1024 ** 3) : '',
    capacityGb: item.provisionedSizeInGBs || item.capacityInGBs || '',
    subnetId: item.subnetId || '',
    privateIpIds: Array.isArray(item.privateIpIds) ? item.privateIpIds : [],
    exportOptionsCount: exportOptions.length,
  };
}

function normalizeOciObjectPrivateEndpoint(item, { region, compartmentId } = {}) {
  const accessTargets = Array.isArray(item.accessTargets) ? item.accessTargets : [];
  return {
    id: item.id || item.name || '',
    name: item.name || item.displayName || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    providerType: 'objectPrivateEndpoint',
    resourceType: 'objectPrivateEndpoint',
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
    subnetId: item.subnetId || '',
    nsgIds: Array.isArray(item.nsgIds) ? item.nsgIds : [],
    accessTargets,
    accessTargetCount: accessTargets.length,
    namespace: item.namespace || '',
    prefix: item.prefix || '',
  };
}

function normalizeOciBucket(bucket, { region, compartment, namespace }) {
  return {
    ...baseResource(bucket, { providerType: 'bucket', region, compartment }),
    id: bucket.id || `${namespace}/${bucket.name || bucket.displayName || ''}`,
    name: bucket.name || bucket.displayName || '',
    namespace,
    storageTier: bucket.storageTier || '',
    publicAccessType: bucket.publicAccessType || '',
    versioning: bucket.versioning || '',
    objectEventsEnabled: bucket.objectEventsEnabled ?? '',
  };
}

function normalizeOciNetworkResource(item, { region, compartmentId, resourceType } = {}) {
  const networkDetails = item.networkDetails || {};
  return {
    id: item.id || '',
    name: item.displayName || item.name || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    compartmentName: item.compartmentId || compartmentId || '',
    providerType: resourceType,
    resourceType,
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
    cidrBlock: item.cidrBlock || (Array.isArray(item.cidrBlocks) ? item.cidrBlocks.join(', ') : ''),
    dnsLabel: item.dnsLabel || '',
    vcnId: item.vcnId || (networkDetails.type === 'VCN' ? networkDetails.id : '') || '',
    routeTableId: item.routeTableId || '',
    securityListIds: Array.isArray(item.securityListIds) ? item.securityListIds : [],
    subnetId: item.subnetId || '',
    gatewayType: resourceType,
    drgId: item.drgId || '',
    networkDetails,
    peeringStatus: item.peeringStatus || '',
    peerId: item.peerId || '',
    peerRegionName: item.peerRegionName || '',
    publicIp: item.natIp || item.publicIp || '',
    services: Array.isArray(item.services) ? item.services : [],
    rulesCount: (item.routeRules || item.ingressSecurityRules || item.egressSecurityRules || []).length,
    routeRules: Array.isArray(item.routeRules) ? item.routeRules : [],
    ingressSecurityRules: Array.isArray(item.ingressSecurityRules) ? item.ingressSecurityRules : [],
    egressSecurityRules: Array.isArray(item.egressSecurityRules) ? item.egressSecurityRules : [],
  };
}

function normalizeOciDatabaseResource(item, { region, compartmentId, resourceType } = {}) {
  return {
    id: item.id || '',
    name: item.displayName || item.dbName || item.name || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    compartmentName: item.compartmentId || compartmentId || '',
    providerType: resourceType,
    resourceType,
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
    availabilityDomain: item.availabilityDomain || '',
    shape: item.shape || item.dbWorkload || item.computeModel || '',
    cpuCoreCount: item.cpuCoreCount || item.ocpuCount || item.computeCount || '',
    ocpus: item.ocpuCount || item.computeCount || item.cpuCoreCount || '',
    memoryGb: item.memorySizeInGBs || item.memorySizeInGB || '',
    storageSizeGb: item.dataStorageSizeInGBs || item.dataStorageSizeInTBs ? item.dataStorageSizeInGBs || `${Number(item.dataStorageSizeInTBs) * 1024}` : '',
    databaseEdition: item.databaseEdition || '',
    dbVersion: item.dbVersion || item.dbHome?.dbVersion || '',
    dbName: item.dbName || item.dbUniqueName || '',
    dbSystemId: item.dbSystemId || '',
    dbHomeId: item.dbHomeId || '',
    subnetId: item.subnetId || item.backupSubnetId || '',
    licenseModel: item.licenseModel || '',
    workloadType: item.dbWorkload || item.workloadType || '',
    dbNodeCount: item.nodeCount || item.dbNodeCount || '',
    hostname: item.hostname || item.hostnamePrefix || '',
  };
}

function normalizeOciDbNode(item, { region, compartmentId, dbSystemId } = {}) {
  return {
    id: item.id || '',
    name: item.hostname || item.displayName || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    compartmentName: item.compartmentId || compartmentId || '',
    providerType: 'dbNode',
    resourceType: 'dbNode',
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
    availabilityDomain: item.availabilityDomain || '',
    faultDomain: item.faultDomain || '',
    dbSystemId: item.dbSystemId || dbSystemId || '',
    hostname: item.hostname || '',
    shape: item.shape || '',
    privateIp: item.privateIp || '',
    publicIp: item.publicIp || '',
  };
}

function normalizeOciDnsZone(item, { region, compartmentId, scope = '' } = {}) {
  return {
    id: item.id || item.name || '',
    name: item.name || item.displayName || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    compartmentName: item.compartmentId || compartmentId || '',
    providerType: 'dnsZone',
    resourceType: 'dnsZone',
    scope: item.scope || scope || '',
    zoneType: item.zoneType || '',
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
    serial: item.serial || '',
    viewId: item.viewId || '',
    rawName: item.name || '',
  };
}

function normalizeOciDnsView(item, { region, compartmentId } = {}) {
  return {
    id: item.id || '',
    name: item.displayName || item.name || item.id || '',
    region,
    compartmentId: item.compartmentId || compartmentId || '',
    compartmentName: item.compartmentId || compartmentId || '',
    providerType: 'dnsView',
    resourceType: 'dnsView',
    status: item.lifecycleState || item.status || '',
    createdAt: item.timeCreated || item.createdAt || '',
  };
}

function normalizeOciDnsRecord(item, { region, compartmentId, zoneId = '', zoneName = '', scope = '', viewId = '' } = {}) {
  const domain = item.domain || item.name || '';
  const rtype = item.rtype || item.recordType || item.type || '';
  return {
    id: [zoneId || zoneName, domain, rtype, item.rdata || item.value || ''].filter(Boolean).join(':'),
    name: domain,
    region,
    compartmentId,
    compartmentName: compartmentId,
    providerType: 'dnsRecord',
    resourceType: 'dnsRecord',
    status: item.lifecycleState || item.status || 'ACTIVE',
    zoneId,
    zoneName,
    scope,
    viewId,
    domain,
    rtype,
    rdata: item.rdata || item.value || '',
    ttl: item.ttl || '',
  };
}

function dnsZoneQuery({ scope = 'GLOBAL', viewId = '' } = {}) {
  let query = `scope=${encodeURIComponent(scope)}`;
  if (String(scope).toUpperCase() === 'PRIVATE' && viewId) {
    query += `&viewId=${encodeURIComponent(viewId)}`;
  }
  return query;
}

function uniqueDnsRows(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const key = row.id || [row.zoneId, row.domain, row.rtype, row.rdata].filter(Boolean).join(':') || row.name;
    if (!key || !byKey.has(key)) {
      byKey.set(key || `${byKey.size}`, row);
    }
  }
  return Array.from(byKey.values());
}

export async function getOciDnsResources(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI DNS resources');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  if (['all', '*'].includes(String(compartmentId).toLowerCase())) {
    const errors = [];
    const compartments = await discoverCompartments(connector, {
      tenancyId: connector.tenancyOcid,
      scopeCompartmentId: connector.compartmentOcid || connector.tenancyOcid,
      homeRegion: connector.region,
      request,
      requestTimeoutMs,
      errors,
    });
    const results = [];
    const concurrency = 4;
    for (let index = 0; index < compartments.length; index += concurrency) {
      const batch = await Promise.all(compartments.slice(index, index + concurrency).map((compartment) =>
        getOciDnsResources(connector, {
          region,
          compartmentId: compartment.id,
          request,
          requestTimeoutMs,
        }),
      ));
      results.push(...batch);
    }
    return {
      generatedAt: new Date().toISOString(),
      region,
      compartmentId: 'all',
      scannedCompartments: compartments.length,
      publicZones: uniqueDnsRows(results.flatMap((result) => result.publicZones || [])),
      privateZones: uniqueDnsRows(results.flatMap((result) => result.privateZones || [])),
      views: uniqueDnsRows(results.flatMap((result) => result.views || [])),
      records: uniqueDnsRows(results.flatMap((result) => result.records || [])),
      errors: compactOciErrors([
        ...errors,
        ...results.flatMap((result) => result.errors || []),
      ]),
    };
  }

  const errors = [];
  const encodedCompartmentId = encodeURIComponent(compartmentId);
  const [publicZones, privateZones, views] = await Promise.all([
    requestList(connector, {
      service: 'dns',
      region,
      pathWithQuery: `/20180115/zones?compartmentId=${encodedCompartmentId}&scope=GLOBAL`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
      limit: 100,
    }, errors, 'dnsPublicZones'),
    requestList(connector, {
      service: 'dns',
      region,
      pathWithQuery: `/20180115/zones?compartmentId=${encodedCompartmentId}&scope=PRIVATE`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
      limit: 100,
    }, errors, 'dnsPrivateZones'),
    requestList(connector, {
      service: 'dns',
      region,
      pathWithQuery: `/20180115/views?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
      limit: 100,
    }, errors, 'dnsViews'),
  ]);

  const zones = [
    ...publicZones.map((zone) => normalizeOciDnsZone(zone, { region, compartmentId, scope: 'GLOBAL' })),
    ...privateZones.map((zone) => normalizeOciDnsZone(zone, { region, compartmentId, scope: 'PRIVATE' })),
  ];
  const recordLists = await Promise.all(zones.map((zone) =>
    requestList(connector, {
      service: 'dns',
      region,
      pathWithQuery: `/20180115/zones/${encodeURIComponent(zone.id || zone.name)}/records?${dnsZoneQuery({ scope: zone.scope, viewId: zone.viewId })}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 2,
      limit: 100,
    }, errors, `dnsRecords:${zone.name}`),
  ));

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    publicZones: zones.filter((zone) => zone.scope === 'GLOBAL'),
    privateZones: zones.filter((zone) => zone.scope === 'PRIVATE'),
    views: views.map((view) => normalizeOciDnsView(view, { region, compartmentId })),
    records: recordLists.flatMap((records, index) => records.map((record) => normalizeOciDnsRecord(record, {
      region,
      compartmentId,
      zoneId: zones[index]?.id || '',
      zoneName: zones[index]?.name || '',
      scope: zones[index]?.scope || '',
      viewId: zones[index]?.viewId || '',
    }))),
    errors,
  };
}

export async function createOciDnsView(connector, { region, compartmentId, displayName, request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI DNS private views');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(displayName, 'Private view name is required.');
  const data = await runOciMutation(connector, {
    service: 'dns',
    region,
    pathWithQuery: '/20180115/views',
    method: 'POST',
    body: { compartmentId, displayName: String(displayName).trim() },
    successMessage: 'OCI DNS private view creation requested.',
    request,
  });
  return { ...data, view: normalizeOciDnsView(data.result || {}, { region, compartmentId }) };
}

export async function getOciDnsZoneRecords(connector, { region, compartmentId = '', zoneId, zoneName = '', scope = 'GLOBAL', viewId = '', request = https.request, requestTimeoutMs = 20000 } = {}) {
  assertOciConnectorReady(connector, 'load OCI DNS zone records');
  assertRequired(region, 'OCI region is required.');
  assertRequired(zoneId, 'DNS zone is required.');
  const errors = [];
  const records = await requestList(connector, {
    service: 'dns',
    region,
    pathWithQuery: `/20180115/zones/${encodeURIComponent(zoneId)}/records?${dnsZoneQuery({ scope, viewId })}`,
    request,
    timeoutMs: requestTimeoutMs,
    retryAttempts: 3,
    limit: 100,
  }, errors, `dnsRecords:${zoneName || zoneId}`);

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    zoneId,
    zoneName,
    scope,
    viewId,
    records: records.map((record) => normalizeOciDnsRecord(record, {
      region,
      compartmentId,
      zoneId,
      zoneName,
      scope,
      viewId,
    })),
    errors,
  };
}

export async function createOciDnsZone(connector, { region, compartmentId, name, scope = 'GLOBAL', viewId = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI DNS zones');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(name, 'DNS zone name is required.');
  const normalizedScope = String(scope || 'GLOBAL').toUpperCase() === 'PRIVATE' ? 'PRIVATE' : 'GLOBAL';
  if (normalizedScope === 'PRIVATE') {
    assertRequired(viewId, 'Private view is required for private DNS zones.');
  }
  const body = { compartmentId, name: String(name).trim(), zoneType: 'PRIMARY', scope: normalizedScope };
  if (normalizedScope === 'PRIVATE') {
    body.viewId = viewId;
  }
  const data = await runOciMutation(connector, {
    service: 'dns',
    region,
    pathWithQuery: '/20180115/zones',
    method: 'POST',
    body,
    successMessage: 'OCI DNS zone creation requested.',
    request,
  });
  return { ...data, zone: normalizeOciDnsZone(data.result || {}, { region, compartmentId, scope: normalizedScope }) };
}

export async function deleteOciDnsZone(connector, { region, zoneId, zoneName = '', scope = 'GLOBAL', viewId = '', confirmation = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'delete OCI DNS zones');
  assertRequired(region, 'OCI region is required.');
  assertRequired(zoneId, 'DNS zone OCID or name is required.');
  if (String(confirmation || '').trim() !== zoneId && (!zoneName || String(confirmation || '').trim() !== zoneName)) {
    const error = new Error('Type the DNS zone name or OCID to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const data = await runOciMutation(connector, {
    service: 'dns',
    region,
    pathWithQuery: `/20180115/zones/${encodeURIComponent(zoneId)}?${dnsZoneQuery({ scope, viewId })}`,
    method: 'DELETE',
    successMessage: 'OCI DNS zone deletion requested.',
    request,
  });
  return { ...data, zone: { id: zoneId, name: zoneName, region, providerType: 'dnsZone', resourceType: 'dnsZone', scope, viewId, status: 'DELETING' } };
}

export async function upsertOciDnsRecord(connector, { region, compartmentId, zoneId, zoneName = '', scope = 'GLOBAL', viewId = '', domain, rtype, rdata, ttl = 300, request = https.request } = {}) {
  assertOciConnectorReady(connector, 'manage OCI DNS records');
  assertRequired(region, 'OCI region is required.');
  assertRequired(zoneId, 'DNS zone is required.');
  assertRequired(domain, 'DNS record domain is required.');
  assertRequired(rtype, 'DNS record type is required.');
  assertRequired(rdata, 'DNS record value is required.');
  const body = { items: [{ domain: String(domain).trim(), rtype: String(rtype).trim().toUpperCase(), rdata: String(rdata).trim(), ttl: Number(ttl || 300) }] };
  const data = await runOciMutation(connector, {
    service: 'dns',
    region,
    pathWithQuery: `/20180115/zones/${encodeURIComponent(zoneId)}/records/${encodeURIComponent(domain)}/${encodeURIComponent(String(rtype).toUpperCase())}?${dnsZoneQuery({ scope, viewId })}`,
    method: 'PUT',
    body,
    successMessage: 'OCI DNS record update requested.',
    request,
  });
  return { ...data, record: normalizeOciDnsRecord(body.items[0], { region, compartmentId, zoneId, zoneName, scope, viewId }) };
}

export async function deleteOciDnsRecord(connector, { region, zoneId, zoneName = '', scope = 'GLOBAL', viewId = '', domain, rtype, confirmation = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'delete OCI DNS records');
  assertRequired(region, 'OCI region is required.');
  assertRequired(zoneId, 'DNS zone is required.');
  assertRequired(domain, 'DNS record domain is required.');
  assertRequired(rtype, 'DNS record type is required.');
  const recordKey = `${String(domain).trim()} ${String(rtype).trim().toUpperCase()}`;
  const typed = String(confirmation || '').trim();
  if (typed !== recordKey && typed !== String(domain).trim()) {
    const error = new Error('Type the DNS record domain or "domain TYPE" to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const data = await runOciMutation(connector, {
    service: 'dns',
    region,
    pathWithQuery: `/20180115/zones/${encodeURIComponent(zoneId)}/records/${encodeURIComponent(domain)}/${encodeURIComponent(String(rtype).toUpperCase())}?${dnsZoneQuery({ scope, viewId })}`,
    method: 'DELETE',
    successMessage: 'OCI DNS record deletion requested.',
    request,
  });
  return { ...data, record: { id: [zoneId, domain, rtype].join(':'), zoneId, zoneName, domain, rtype: String(rtype).toUpperCase(), region, scope, viewId, status: 'DELETING' } };
}

export async function getOciVolumeBackups(connector, {
  region,
  resourceType = 'blockVolume',
  volumeId = '',
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI volume backups');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  const api = volumeApi(resourceType);
  const pathWithQuery = volumeId
    ? `/20160918/${api.backupCollection}?compartmentId=${encodeURIComponent(compartmentId)}&${api.idField}=${encodeURIComponent(volumeId)}`
    : `/20160918/${api.backupCollection}?compartmentId=${encodeURIComponent(compartmentId)}`;
  const errors = [];
  const backups = await requestList(connector, {
    service: 'iaas',
    region,
    pathWithQuery,
    request,
    timeoutMs: requestTimeoutMs,
    retryAttempts: 4,
  }, errors, api.backupCollection);

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    volumeId,
    backups: backups
      .map((backup) => normalizeOciVolumeBackup(backup, { region, resourceType, sourceVolumeId: volumeId }))
      .filter((backup) => backup.id)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
    errors,
  };
}

export async function getOciVolumeGroupResources(connector, {
  region,
  compartmentId,
  resourceType = 'volumeGroup',
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI volume group resources');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  const collectionByType = {
    volumeGroup: 'volumeGroups',
    volumeGroupBackup: 'volumeGroupBackups',
    volumeGroupReplica: 'volumeGroupReplicas',
  };
  const collection = collectionByType[resourceType] || collectionByType.volumeGroup;
  const errors = [];
  const rows = await requestList(connector, {
    service: 'iaas',
    region,
    pathWithQuery: `/20160918/${collection}?compartmentId=${encodeURIComponent(compartmentId)}`,
    request,
    timeoutMs: requestTimeoutMs,
    retryAttempts: 4,
  }, errors, collection);

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    resourceType,
    resources: rows
      .map((item) => normalizeOciVolumeGroupResource(item, { region, compartmentId, resourceType }))
      .filter((item) => item.id)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
    errors,
  };
}

export async function getOciFileStorageResources(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI file system resources');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  const errors = [];
  const encodedCompartmentId = encodeURIComponent(compartmentId);
  const availabilityDomains = await requestList(connector, {
    service: 'identity',
    region,
    pathWithQuery: `/20160918/availabilityDomains?compartmentId=${encodeURIComponent(connector.tenancyOcid)}`,
    request,
    timeoutMs: requestTimeoutMs,
    retryAttempts: 4,
  }, errors, 'availabilityDomains');

  const [fileSystemLists, mountTargetLists, exports] = await Promise.all([
    Promise.all(availabilityDomains.map((ad) =>
      requestList(connector, {
        service: 'filestorage',
        region,
        pathWithQuery: `/20171215/fileSystems?compartmentId=${encodedCompartmentId}&availabilityDomain=${encodeURIComponent(ad.name)}`,
        request,
        timeoutMs: requestTimeoutMs,
        retryAttempts: 4,
      }, errors, 'fileSystems'),
    )),
    Promise.all(availabilityDomains.map((ad) =>
      requestList(connector, {
        service: 'filestorage',
        region,
        pathWithQuery: `/20171215/mountTargets?compartmentId=${encodedCompartmentId}&availabilityDomain=${encodeURIComponent(ad.name)}`,
        request,
        timeoutMs: requestTimeoutMs,
        retryAttempts: 4,
      }, errors, 'mountTargets'),
    )),
    requestList(connector, {
      service: 'filestorage',
      region,
      pathWithQuery: `/20171215/exports?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'exports'),
  ]);

  const fileSystems = fileSystemLists.flat();
  const snapshotLists = await Promise.all(fileSystems.map((fileSystem) =>
    requestList(connector, {
      service: 'filestorage',
      region,
      pathWithQuery: `/20171215/snapshots?fileSystemId=${encodeURIComponent(fileSystem.id)}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'snapshots'),
  ));

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    fileSystems: fileSystems
      .map((item) => normalizeOciFileStorageResource(item, { region, compartmentId, resourceType: 'fileSystem' }))
      .filter((item) => item.id)
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    mountTargets: mountTargetLists.flat()
      .map((item) => normalizeOciFileStorageResource(item, { region, compartmentId, resourceType: 'mountTarget' }))
      .filter((item) => item.id)
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    exports: exports
      .map((item) => normalizeOciFileStorageResource(item, { region, compartmentId, resourceType: 'export' }))
      .filter((item) => item.id)
      .sort((left, right) => String(left.path || left.name || '').localeCompare(String(right.path || right.name || ''))),
    snapshots: snapshotLists.flat()
      .map((item) => normalizeOciFileStorageResource(item, { region, compartmentId, resourceType: 'snapshot', fileSystemId: item.fileSystemId }))
      .filter((item) => item.id)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
    errors,
  };
}

export async function getOciObjectStorageResources(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI Object Storage resources');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  const errors = [];
  const compartment = {
    id: compartmentId,
    name: compartmentId,
    lifecycleState: 'ACTIVE',
  };
  const namespaceResponse = await requestJson(connector, {
    service: 'objectstorage',
    region,
    pathWithQuery: '/n/',
    request,
    timeoutMs: requestTimeoutMs,
  });
  const namespace = namespaceResponse.ok && typeof namespaceResponse.payload === 'string'
    ? namespaceResponse.payload
    : namespaceResponse.ok && namespaceResponse.payload?.namespace
      ? namespaceResponse.payload.namespace
      : '';
  if (!namespaceResponse.ok) {
    errors.push({ scope: 'objectStorageNamespace', region, message: namespaceResponse.message });
  }

  const buckets = namespace
    ? await requestList(connector, {
      service: 'objectstorage',
      region,
      pathWithQuery: `/n/${encodeURIComponent(namespace)}/b?compartmentId=${encodeURIComponent(compartmentId)}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'buckets')
    : [];

  const privateEndpoints = namespace
    ? await requestList(connector, {
      service: 'objectstorage',
      region,
      pathWithQuery: `/n/${encodeURIComponent(namespace)}/privateEndpoints?compartmentId=${encodeURIComponent(compartmentId)}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
      ignoreStatusCodes: [404],
    }, errors, 'objectPrivateEndpoints')
    : [];

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    namespace,
    buckets: buckets
      .map((bucket) => normalizeOciBucket(bucket, { region, compartment, namespace }))
      .filter((bucket) => bucket.name || bucket.id)
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    privateEndpoints: privateEndpoints
      .map((endpoint) => normalizeOciObjectPrivateEndpoint(endpoint, { region, compartmentId }))
      .filter((endpoint) => endpoint.id || endpoint.name)
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    errors,
  };
}

export async function getOciDatabaseResources(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI Database resources');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  const errors = [];
  const encodedCompartmentId = encodeURIComponent(compartmentId);
  const [dbSystems, autonomousDatabases, autonomousContainerDatabases, exadataInfrastructures] = await Promise.all([
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/dbSystems?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'dbSystems'),
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/autonomousDatabases?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'autonomousDatabases'),
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/autonomousContainerDatabases?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'autonomousContainerDatabases'),
    requestList(connector, {
      service: 'database',
      region,
      pathWithQuery: `/20160918/exadataInfrastructures?compartmentId=${encodedCompartmentId}`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    }, errors, 'exadataInfrastructures'),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    dbSystems: dbSystems.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'dbSystem' })),
    autonomousDatabases: autonomousDatabases.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'autonomousDatabase' })),
    autonomousContainerDatabases: autonomousContainerDatabases.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'autonomousContainerDatabase' })),
    exadataInfrastructures: exadataInfrastructures.map((item) => normalizeOciDatabaseResource(item, { region, compartmentId, resourceType: 'exadataInfrastructure' })),
    errors,
  };
}

export async function createOciAutonomousDatabase(connector, {
  region,
  compartmentId,
  displayName,
  dbName,
  adminPassword,
  dbWorkload = 'OLTP',
  licenseModel = 'LICENSE_INCLUDED',
  computeCount,
  cpuCoreCount = '1',
  dataStorageSizeInGBs = '20',
  dataStorageSizeInTBs = '',
  isFreeTier = false,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'create OCI databases');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(displayName, 'Database display name is required.');
  assertRequired(dbName, 'Database name is required.');
  assertRequired(adminPassword, 'Admin password is required.');

  const normalizedDbName = String(dbName).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,13}$/.test(normalizedDbName)) {
    const error = new Error('Database name must start with a letter and use up to 14 letters, numbers, or underscores.');
    error.statusCode = 400;
    throw error;
  }

  const body = {
    compartmentId: String(compartmentId).trim(),
    displayName: String(displayName).trim(),
    dbName: normalizedDbName,
    adminPassword: String(adminPassword),
    dbWorkload: ['OLTP', 'DW', 'AJD', 'APEX'].includes(String(dbWorkload || '').toUpperCase())
      ? String(dbWorkload).toUpperCase()
      : 'OLTP',
    licenseModel: String(licenseModel || 'LICENSE_INCLUDED').trim(),
    isFreeTier: Boolean(isFreeTier),
  };

  if (!body.isFreeTier) {
    const ecpuCount = Number(computeCount ?? cpuCoreCount);
    if (!Number.isFinite(ecpuCount) || ecpuCount < 1) {
      const error = new Error('ECPU count must be at least 1.');
      error.statusCode = 400;
      throw error;
    }
    body.computeModel = 'ECPU';
    body.computeCount = ecpuCount;
    if (body.dbWorkload === 'DW') {
      const storageTb = dataStorageSizeInTBs !== ''
        ? Number(dataStorageSizeInTBs)
        : Math.ceil(Number(dataStorageSizeInGBs) / 1024);
      if (!Number.isFinite(storageTb) || storageTb < 1) {
        const error = new Error('Data Warehouse storage size must be at least 1 TB.');
        error.statusCode = 400;
        throw error;
      }
      body.dataStorageSizeInTBs = storageTb;
    } else {
      const storageGb = dataStorageSizeInGBs === '' && dataStorageSizeInTBs !== ''
        ? Number(dataStorageSizeInTBs) * 1024
        : Number(dataStorageSizeInGBs);
      if (!Number.isFinite(storageGb) || storageGb < 20) {
        const error = new Error('Storage size must be at least 20 GB.');
        error.statusCode = 400;
        throw error;
      }
      body.dataStorageSizeInGBs = storageGb;
    }
  }

  const data = await runOciMutation(connector, {
    service: 'database',
    region,
    pathWithQuery: '/20160918/autonomousDatabases',
    method: 'POST',
    body,
    successMessage: 'OCI Autonomous Database creation requested.',
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    database: normalizeOciDatabaseResource(data.result || {}, {
      region,
      compartmentId,
      resourceType: 'autonomousDatabase',
    }),
  };
}

export async function createOciDbSystem(connector, {
  region,
  compartmentId,
  availabilityDomain,
  displayName,
  hostnamePrefix,
  shape = 'VM.Standard2.1',
  subnetId,
  databaseEdition = 'ENTERPRISE_EDITION',
  licenseModel = 'LICENSE_INCLUDED',
  dbName,
  dbUniqueName = '',
  pdbName = '',
  dbVersion = '19c',
  adminPassword,
  sshPublicKeys = '',
  cpuCoreCount = '1',
  nodeCount = '1',
  dataStorageSizeInGBs = '256',
  storageManagement = 'LVM',
  storageVolumePerformanceMode = 'BALANCED',
  characterSet = 'AL32UTF8',
  ncharacterSet = 'AL16UTF16',
  sourceDbSystemId = '',
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'create OCI DB Systems');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(availabilityDomain, 'Availability domain is required.');
  assertRequired(displayName, 'DB System display name is required.');
  assertRequired(hostnamePrefix, 'Hostname prefix is required.');
  assertRequired(shape, 'DB System shape is required.');
  assertRequired(subnetId, 'Subnet OCID is required.');
  assertRequired(dbName, 'Database name is required.');
  assertRequired(dbVersion, 'Database version is required.');
  assertRequired(adminPassword, 'Admin password is required.');

  const normalizedDbName = String(dbName).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,7}$/.test(normalizedDbName)) {
    const error = new Error('DB System database name must start with a letter and use up to 8 letters, numbers, or underscores.');
    error.statusCode = 400;
    throw error;
  }
  const cpuCount = Number(cpuCoreCount);
  const nodes = Number(nodeCount);
  const storageGb = Number(dataStorageSizeInGBs);
  if (!Number.isFinite(cpuCount) || cpuCount < 1) {
    const error = new Error('CPU core count must be at least 1.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(nodes) || nodes < 1) {
    const error = new Error('Node count must be at least 1.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(storageGb) || storageGb < 256) {
    const error = new Error('DB System storage size must be at least 256 GB.');
    error.statusCode = 400;
    throw error;
  }

  const keys = String(sshPublicKeys || '')
    .split(/\r?\n/)
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    const error = new Error('At least one SSH public key is required.');
    error.statusCode = 400;
    throw error;
  }

  const body = {
    compartmentId: String(compartmentId).trim(),
    availabilityDomain: String(availabilityDomain).trim(),
    displayName: String(displayName).trim(),
    hostname: String(hostnamePrefix).trim(),
    shape: String(shape).trim(),
    subnetId: String(subnetId).trim(),
    databaseEdition: String(databaseEdition || 'ENTERPRISE_EDITION').trim(),
    licenseModel: String(licenseModel || 'LICENSE_INCLUDED').trim(),
    sshPublicKeys: keys,
    cpuCoreCount: cpuCount,
    nodeCount: nodes,
    dataStorageSizeInGBs: storageGb,
    storageManagement: String(storageManagement || 'LVM').trim().toUpperCase() === 'ASM' ? 'ASM' : 'LVM',
    storageVolumePerformanceMode: String(storageVolumePerformanceMode || 'BALANCED').trim().toUpperCase() === 'HIGH_PERFORMANCE' ? 'HIGH_PERFORMANCE' : 'BALANCED',
    dbHome: {
      dbVersion: String(dbVersion).trim(),
      database: {
        dbName: normalizedDbName,
        adminPassword: String(adminPassword),
        characterSet: String(characterSet || 'AL32UTF8').trim(),
        ncharacterSet: String(ncharacterSet || 'AL16UTF16').trim(),
      },
    },
  };
  if (dbUniqueName) {
    body.dbHome.database.dbUniqueName = String(dbUniqueName).trim();
  }
  if (pdbName) {
    body.dbHome.database.pdbName = String(pdbName).trim();
  }
  if (sourceDbSystemId) {
    body.sourceDbSystemId = String(sourceDbSystemId).trim();
  }

  const data = await runOciMutation(connector, {
    service: 'database',
    region,
    pathWithQuery: '/20160918/dbSystems',
    method: 'POST',
    body,
    successMessage: sourceDbSystemId ? 'OCI DB System clone requested.' : 'OCI DB System creation requested.',
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    database: normalizeOciDatabaseResource(data.result || {}, {
      region,
      compartmentId,
      resourceType: 'dbSystem',
    }),
  };
}

export async function getOciDbVersions(connector, {
  region,
  compartmentId,
  dbSystemShape = '',
  storageManagement = '',
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI DB versions');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  let pathWithQuery = `/20160918/dbVersions?compartmentId=${encodeURIComponent(compartmentId)}`;
  if (dbSystemShape) {
    pathWithQuery = withQueryParam(pathWithQuery, 'dbSystemShape', dbSystemShape);
  }
  if (storageManagement) {
    pathWithQuery = withQueryParam(pathWithQuery, 'storageManagement', storageManagement);
  }
  const errors = [];
  const rows = await requestList(connector, {
    service: 'database',
    region,
    pathWithQuery,
    request,
    timeoutMs: requestTimeoutMs,
  }, errors, 'dbVersions');
  const versions = rows
    .map((item) => ({
      version: item.version || item.dbVersion || item.name || '',
      isLatest: Boolean(item.isLatestForMajorVersion),
      supportsPdb: item.supportsPdb !== false,
    }))
    .filter((item) => item.version);
  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    versions,
    errors,
  };
}

export function generateOciSshKeyPair({ comment = '' } = {}) {
  const normalizedComment = String(comment || '').trim() || `ssh-key-${new Date().toISOString().slice(0, 10)}`;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  return {
    generatedAt: new Date().toISOString(),
    comment: normalizedComment,
    publicKey: rsaPublicKeyToOpenSsh(publicKey, normalizedComment),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

async function getOciDatabaseResource(connector, {
  region,
  databaseId,
  resourceType,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI database resource');
  assertRequired(region, 'OCI region is required.');
  assertRequired(databaseId, 'OCI database OCID is required.');

  const pathPrefix = resourceType === 'dbSystem'
    ? '/20160918/dbSystems'
    : '/20160918/autonomousDatabases';
  const response = await requestJson(connector, {
    service: 'database',
    region,
    pathWithQuery: `${pathPrefix}/${encodeURIComponent(databaseId)}`,
    method: 'GET',
    request,
    timeoutMs: 20000,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'Unable to load OCI database resource.');
    error.statusCode = response.statusCode || 502;
    throw error;
  }

  return {
    generatedAt: new Date().toISOString(),
    database: normalizeOciDatabaseResource(response.payload || {}, { region, resourceType }),
  };
}

export async function listOciDbSystemNodes(connector, {
  region,
  compartmentId,
  dbSystemId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'list OCI DB System nodes');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(dbSystemId, 'OCI DB System OCID is required.');
  const errors = [];
  const nodes = await requestList(connector, {
    service: 'database',
    region,
    pathWithQuery: `/20160918/dbNodes?compartmentId=${encodeURIComponent(compartmentId)}&dbSystemId=${encodeURIComponent(dbSystemId)}`,
    request,
    timeoutMs: requestTimeoutMs,
  }, errors, 'dbNodes');

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    dbSystemId,
    nodes: nodes.map((item) => normalizeOciDbNode(item, { region, compartmentId, dbSystemId })),
    errors,
  };
}

export async function runOciDbNodeAction(connector, {
  region,
  dbNodeId,
  action,
  request = https.request,
} = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!['start', 'stop'].includes(normalizedAction)) {
    const error = new Error('Unsupported DB node action.');
    error.statusCode = 400;
    throw error;
  }
  assertOciConnectorReady(connector, 'manage OCI DB System nodes');
  assertRequired(region, 'OCI region is required.');
  assertRequired(dbNodeId, 'OCI DB node OCID is required.');

  const data = await runOciMutation(connector, {
    service: 'database',
    region,
    pathWithQuery: `/20160918/dbNodes/${encodeURIComponent(dbNodeId)}?action=${normalizedAction.toUpperCase()}`,
    method: 'POST',
    successMessage: `OCI DB node ${normalizedAction} requested.`,
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    node: normalizeOciDbNode(data.result || { id: dbNodeId, lifecycleState: normalizedAction === 'start' ? 'STARTING' : 'STOPPING' }, {
      region,
    }),
  };
}

export async function updateOciDbSystem(connector, {
  region,
  dbSystemId,
  dataStorageSizeInGBs,
  sshPublicKeys,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'update OCI DB Systems');
  assertRequired(region, 'OCI region is required.');
  assertRequired(dbSystemId, 'OCI DB System OCID is required.');

  const body = {};
  if (dataStorageSizeInGBs !== undefined && dataStorageSizeInGBs !== '') {
    const storageGb = Number(dataStorageSizeInGBs);
    if (!Number.isFinite(storageGb) || storageGb < 256) {
      const error = new Error('DB System storage size must be at least 256 GB.');
      error.statusCode = 400;
      throw error;
    }
    body.dataStorageSizeInGBs = storageGb;
  }
  if (sshPublicKeys !== undefined) {
    const keys = String(sshPublicKeys || '')
      .split(/\r?\n/)
      .map((key) => key.trim())
      .filter(Boolean);
    if (keys.length === 0) {
      const error = new Error('At least one SSH public key is required.');
      error.statusCode = 400;
      throw error;
    }
    body.sshPublicKeys = keys;
  }
  if (Object.keys(body).length === 0) {
    const error = new Error('No DB System changes were provided.');
    error.statusCode = 400;
    throw error;
  }

  const data = await runOciMutation(connector, {
    service: 'database',
    region,
    pathWithQuery: `/20160918/dbSystems/${encodeURIComponent(dbSystemId)}`,
    method: 'PATCH',
    body,
    successMessage: 'OCI DB System update requested.',
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    database: normalizeOciDatabaseResource(data.result || { id: dbSystemId, lifecycleState: 'UPDATING' }, {
      region,
      resourceType: 'dbSystem',
    }),
  };
}

export async function deleteOciDatabaseResource(connector, {
  region,
  databaseId,
  databaseName = '',
  resourceType,
  confirmation = '',
  request = https.request,
} = {}) {
  const normalizedType = resourceType === 'dbSystem' ? 'dbSystem' : 'autonomousDatabase';
  assertOciConnectorReady(connector, 'delete OCI databases');
  assertRequired(region, 'OCI region is required.');
  assertRequired(databaseId, 'OCI database OCID is required.');

  const current = await getOciDatabaseResource(connector, {
    region,
    databaseId,
    resourceType: normalizedType,
    request,
  });
  const currentName = current.database.name || current.database.dbName || databaseName || databaseId;
  const typed = String(confirmation || '').trim();
  if (typed !== String(currentName).trim() && typed !== databaseId) {
    const error = new Error('Type the database name or OCID to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }

  const pathPrefix = normalizedType === 'dbSystem'
    ? '/20160918/dbSystems'
    : '/20160918/autonomousDatabases';
  const data = await runOciMutation(connector, {
    service: 'database',
    region,
    pathWithQuery: `${pathPrefix}/${encodeURIComponent(databaseId)}`,
    method: 'DELETE',
    successMessage: normalizedType === 'dbSystem' ? 'OCI DB System deletion requested.' : 'OCI Autonomous Database deletion requested.',
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    database: {
      ...current.database,
    status: 'DELETING',
    },
  };
}

export async function runOciAutonomousDatabaseAction(connector, {
  region,
  databaseId,
  action,
  restoreTimestamp = '',
  peerDbId = '',
  request = https.request,
} = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const allowedActions = ['start', 'stop', 'restore', 'switchover'];
  if (!allowedActions.includes(normalizedAction)) {
    const error = new Error('Unsupported Autonomous Database action.');
    error.statusCode = 400;
    throw error;
  }
  assertOciConnectorReady(connector, 'manage OCI Autonomous Databases');
  assertRequired(region, 'OCI region is required.');
  assertRequired(databaseId, 'OCI Autonomous Database OCID is required.');

  let body;
  if (normalizedAction === 'restore') {
    assertRequired(restoreTimestamp, 'Restore timestamp is required.');
    body = { timestamp: String(restoreTimestamp).trim() };
  }
  if (normalizedAction === 'switchover') {
    assertRequired(peerDbId, 'Peer Autonomous Database OCID is required for switchover.');
    body = { peerDbId: String(peerDbId).trim() };
  }

  const data = await runOciMutation(connector, {
    service: 'database',
    region,
    pathWithQuery: `/20160918/autonomousDatabases/${encodeURIComponent(databaseId)}/actions/${normalizedAction}`,
    method: 'POST',
    body,
    successMessage: `OCI Autonomous Database ${normalizedAction} requested.`,
    request,
    timeoutMs: 30000,
  });

  const statusByAction = {
    start: 'STARTING',
    stop: 'STOPPING',
    restore: 'RESTORE_IN_PROGRESS',
    switchover: 'SWITCHOVER_IN_PROGRESS',
  };
  return {
    ...data,
    database: normalizeOciDatabaseResource(data.result || { id: databaseId, lifecycleState: statusByAction[normalizedAction] }, {
      region,
      resourceType: 'autonomousDatabase',
    }),
  };
}

export async function cloneOciAutonomousDatabase(connector, {
  region,
  sourceDatabaseId,
  compartmentId,
  displayName,
  dbName,
  adminPassword,
  cloneType = 'FULL',
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'clone OCI Autonomous Databases');
  assertRequired(region, 'OCI region is required.');
  assertRequired(sourceDatabaseId, 'Source Autonomous Database OCID is required.');
  assertRequired(compartmentId, 'Target compartment OCID is required.');
  assertRequired(displayName, 'Clone display name is required.');
  assertRequired(dbName, 'Clone database name is required.');
  assertRequired(adminPassword, 'Admin password is required.');

  const normalizedDbName = String(dbName).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,13}$/.test(normalizedDbName)) {
    const error = new Error('Database name must start with a letter and use up to 14 letters, numbers, or underscores.');
    error.statusCode = 400;
    throw error;
  }

  const data = await runOciMutation(connector, {
    service: 'database',
    region,
    pathWithQuery: '/20160918/autonomousDatabases',
    method: 'POST',
    body: {
      compartmentId: String(compartmentId).trim(),
      sourceId: String(sourceDatabaseId).trim(),
      cloneType: String(cloneType || 'FULL').trim().toUpperCase() === 'METADATA' ? 'METADATA' : 'FULL',
      displayName: String(displayName).trim(),
      dbName: normalizedDbName,
      adminPassword: String(adminPassword),
    },
    successMessage: 'OCI Autonomous Database clone requested.',
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    database: normalizeOciDatabaseResource(data.result || {}, {
      region,
      compartmentId,
      resourceType: 'autonomousDatabase',
    }),
  };
}

export async function getOciNetworkResources(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI network resources');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  const errors = [];
  const encodedCompartmentId = encodeURIComponent(compartmentId);
  const list = (collection, label) => requestList(connector, {
    service: 'iaas',
    region,
    pathWithQuery: `/20160918/${collection}?compartmentId=${encodedCompartmentId}`,
    request,
    timeoutMs: requestTimeoutMs,
    retryAttempts: 4,
  }, errors, label);
  const [vcns, subnets, internetGateways, natGateways, serviceGateways, drgs, drgAttachments, remotePeeringConnections, routeTables, securityLists] = await Promise.all([
    list('vcns', 'vcns'),
    list('subnets', 'subnets'),
    list('internetGateways', 'internetGateways'),
    list('natGateways', 'natGateways'),
    list('serviceGateways', 'serviceGateways'),
    list('drgs', 'drgs'),
    list('drgAttachments', 'drgAttachments'),
    list('remotePeeringConnections', 'remotePeeringConnections'),
    list('routeTables', 'routeTables'),
    list('securityLists', 'securityLists'),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    vcns: vcns.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'vcn' })),
    subnets: subnets.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'subnet' })),
    internetGateways: internetGateways.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'internetGateway' })),
    natGateways: natGateways.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'natGateway' })),
    serviceGateways: serviceGateways.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'serviceGateway' })),
    drgs: drgs.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'drg' })),
    drgAttachments: drgAttachments.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'drgAttachment' })),
    remotePeeringConnections: remotePeeringConnections.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'remotePeeringConnection' })),
    routeTables: routeTables.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'routeTable' })),
    securityLists: securityLists.map((item) => normalizeOciNetworkResource(item, { region, compartmentId, resourceType: 'securityList' })),
    errors,
  };
}

function assertNameOrIdConfirmation({ confirmation = '', id, name = '', label }) {
  const typed = String(confirmation || '').trim();
  if (typed !== id && (!name || typed !== name)) {
    const error = new Error(`Type the ${label} name or OCID to confirm deletion.`);
    error.statusCode = 400;
    throw error;
  }
}

export async function createOciVcn(connector, { region, compartmentId, displayName, cidrBlock, dnsLabel = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI VCNs');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(displayName, 'VCN name is required.');
  assertRequired(cidrBlock, 'VCN CIDR block is required.');
  const body = { compartmentId, displayName: String(displayName).trim(), cidrBlock: String(cidrBlock).trim() };
  if (String(dnsLabel || '').trim()) {
    body.dnsLabel = String(dnsLabel).trim();
  }
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/vcns',
    method: 'POST',
    body,
    successMessage: 'OCI VCN creation requested.',
    request,
  });
  return { ...data, vcn: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType: 'vcn' }) };
}

export async function deleteOciVcn(connector, { region, vcnId, vcnName = '', confirmation = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'delete OCI VCNs');
  assertRequired(region, 'OCI region is required.');
  assertRequired(vcnId, 'OCI VCN OCID is required.');
  if (String(confirmation || '').trim() !== vcnId && (!vcnName || String(confirmation || '').trim() !== vcnName)) {
    const error = new Error('Type the VCN name or OCID to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/vcns/${encodeURIComponent(vcnId)}`,
    method: 'DELETE',
    successMessage: 'OCI VCN deletion requested.',
    request,
  });
  return { ...data, vcn: { id: vcnId, name: vcnName, region, providerType: 'vcn', resourceType: 'vcn', status: 'DELETING' } };
}

export async function createOciSubnet(connector, { region, compartmentId, vcnId, displayName, cidrBlock, availabilityDomain = '', routeTableId = '', securityListIds = [], request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI subnets');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(vcnId, 'VCN OCID is required.');
  assertRequired(displayName, 'Subnet name is required.');
  assertRequired(cidrBlock, 'Subnet CIDR block is required.');
  const body = { compartmentId, vcnId, displayName: String(displayName).trim(), cidrBlock: String(cidrBlock).trim() };
  if (availabilityDomain) body.availabilityDomain = availabilityDomain;
  if (routeTableId) body.routeTableId = routeTableId;
  if (Array.isArray(securityListIds) && securityListIds.length) body.securityListIds = securityListIds;
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/subnets',
    method: 'POST',
    body,
    successMessage: 'OCI subnet creation requested.',
    request,
  });
  return { ...data, subnet: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType: 'subnet' }) };
}

export async function deleteOciSubnet(connector, { region, subnetId, subnetName = '', confirmation = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'delete OCI subnets');
  assertRequired(region, 'OCI region is required.');
  assertRequired(subnetId, 'OCI subnet OCID is required.');
  if (String(confirmation || '').trim() !== subnetId && (!subnetName || String(confirmation || '').trim() !== subnetName)) {
    const error = new Error('Type the subnet name or OCID to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/subnets/${encodeURIComponent(subnetId)}`,
    method: 'DELETE',
    successMessage: 'OCI subnet deletion requested.',
    request,
  });
  return { ...data, subnet: { id: subnetId, name: subnetName, region, providerType: 'subnet', resourceType: 'subnet', status: 'DELETING' } };
}

export async function createOciGateway(connector, { region, compartmentId, vcnId, displayName, gatewayType = 'internetGateway', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI gateways');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(vcnId, 'VCN OCID is required.');
  assertRequired(displayName, 'Gateway name is required.');
  const collectionByType = {
    internetGateway: 'internetGateways',
    natGateway: 'natGateways',
    serviceGateway: 'serviceGateways',
  };
  const resourceType = collectionByType[gatewayType] ? gatewayType : 'internetGateway';
  const body = { compartmentId, vcnId, displayName: String(displayName).trim(), isEnabled: true };
  if (resourceType === 'serviceGateway') {
    const serviceErrors = [];
    const services = await requestList(connector, {
      service: 'iaas',
      region,
      pathWithQuery: '/20160918/services',
      request,
      timeoutMs: 20000,
    }, serviceErrors, 'services');
    if (serviceErrors.length || !services.length) {
      const error = new Error(serviceErrors[0]?.message || 'Unable to load OCI services for Service Gateway creation.');
      error.statusCode = 502;
      throw error;
    }
    const service = services.find((item) => /all.*services.*oracle services network/i.test(item.name || item.description || ''))
      || services.find((item) => /oracle services network/i.test(item.name || item.description || ''))
      || services[0];
    body.services = [{ serviceId: service.id }];
  }
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/${collectionByType[resourceType]}`,
    method: 'POST',
    body,
    successMessage: 'OCI gateway creation requested.',
    request,
  });
  return { ...data, gateway: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType }) };
}

export async function createOciDrg(connector, { region, compartmentId, displayName, request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI DRGs');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(displayName, 'DRG name is required.');
  const body = { compartmentId, displayName: String(displayName).trim() };
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/drgs',
    method: 'POST',
    body,
    successMessage: 'OCI DRG creation requested.',
    request,
  });
  return { ...data, drg: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType: 'drg' }) };
}

export async function deleteOciDrg(connector, { region, drgId, drgName = '', confirmation = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'delete OCI DRGs');
  assertRequired(region, 'OCI region is required.');
  assertRequired(drgId, 'OCI DRG OCID is required.');
  assertNameOrIdConfirmation({ confirmation, id: drgId, name: drgName, label: 'DRG' });
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/drgs/${encodeURIComponent(drgId)}`,
    method: 'DELETE',
    successMessage: 'OCI DRG deletion requested.',
    request,
  });
  return { ...data, drg: { id: drgId, name: drgName, region, providerType: 'drg', resourceType: 'drg', status: 'DELETING' } };
}

export async function createOciDrgAttachment(connector, { region, compartmentId, drgId, vcnId, displayName, request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI DRG attachments');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(drgId, 'DRG OCID is required.');
  assertRequired(vcnId, 'VCN OCID is required.');
  assertRequired(displayName, 'DRG attachment name is required.');
  const body = {
    compartmentId,
    drgId,
    displayName: String(displayName).trim(),
    networkDetails: {
      id: vcnId,
      type: 'VCN',
    },
  };
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/drgAttachments',
    method: 'POST',
    body,
    successMessage: 'OCI DRG VCN attachment creation requested.',
    request,
  });
  return { ...data, attachment: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType: 'drgAttachment' }) };
}

export async function deleteOciDrgAttachment(connector, { region, attachmentId, attachmentName = '', confirmation = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'delete OCI DRG attachments');
  assertRequired(region, 'OCI region is required.');
  assertRequired(attachmentId, 'OCI DRG attachment OCID is required.');
  assertNameOrIdConfirmation({ confirmation, id: attachmentId, name: attachmentName, label: 'DRG attachment' });
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/drgAttachments/${encodeURIComponent(attachmentId)}`,
    method: 'DELETE',
    successMessage: 'OCI DRG attachment deletion requested.',
    request,
  });
  return { ...data, attachment: { id: attachmentId, name: attachmentName, region, providerType: 'drgAttachment', resourceType: 'drgAttachment', status: 'DETACHING' } };
}

export async function createOciRemotePeeringConnection(connector, { region, compartmentId, drgId, displayName, request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI remote peering connections');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(drgId, 'DRG OCID is required.');
  assertRequired(displayName, 'Remote peering connection name is required.');
  const body = { compartmentId, drgId, displayName: String(displayName).trim() };
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/remotePeeringConnections',
    method: 'POST',
    body,
    successMessage: 'OCI remote peering connection creation requested.',
    request,
  });
  return { ...data, connection: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType: 'remotePeeringConnection' }) };
}

export async function connectOciRemotePeeringConnection(connector, { region, connectionId, peerId, peerRegionName, request = https.request } = {}) {
  assertOciConnectorReady(connector, 'connect OCI remote peering connections');
  assertRequired(region, 'OCI region is required.');
  assertRequired(connectionId, 'Remote peering connection OCID is required.');
  assertRequired(peerId, 'Peer remote peering connection OCID is required.');
  assertRequired(peerRegionName, 'Peer region is required.');
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/remotePeeringConnections/${encodeURIComponent(connectionId)}/actions/connect`,
    method: 'POST',
    body: { peerId, peerRegionName },
    successMessage: 'OCI remote peering connection request submitted.',
    request,
  });
  return {
    ...data,
    connection: normalizeOciNetworkResource(data.result || { id: connectionId, peerId, peerRegionName }, { region, resourceType: 'remotePeeringConnection' }),
  };
}

export async function deleteOciRemotePeeringConnection(connector, { region, connectionId, connectionName = '', confirmation = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'delete OCI remote peering connections');
  assertRequired(region, 'OCI region is required.');
  assertRequired(connectionId, 'Remote peering connection OCID is required.');
  assertNameOrIdConfirmation({ confirmation, id: connectionId, name: connectionName, label: 'remote peering connection' });
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/remotePeeringConnections/${encodeURIComponent(connectionId)}`,
    method: 'DELETE',
    successMessage: 'OCI remote peering connection deletion requested.',
    request,
  });
  return { ...data, connection: { id: connectionId, name: connectionName, region, providerType: 'remotePeeringConnection', resourceType: 'remotePeeringConnection', status: 'DELETING' } };
}

export async function createOciRouteTable(connector, { region, compartmentId, vcnId, displayName, destinationCidrBlock, networkEntityId, request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI route tables');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(vcnId, 'VCN OCID is required.');
  assertRequired(displayName, 'Route table name is required.');
  assertRequired(destinationCidrBlock, 'Destination CIDR block is required.');
  assertRequired(networkEntityId, 'Gateway or network entity OCID is required.');
  const body = { compartmentId, vcnId, displayName: String(displayName).trim(), routeRules: [{ destination: destinationCidrBlock, destinationType: 'CIDR_BLOCK', networkEntityId }] };
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/routeTables',
    method: 'POST',
    body,
    successMessage: 'OCI route table creation requested.',
    request,
  });
  return { ...data, routeTable: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType: 'routeTable' }) };
}

export async function createOciSecurityList(connector, { region, compartmentId, vcnId, displayName, direction = 'ingress', protocol = '6', source = '0.0.0.0/0', destination = '0.0.0.0/0', tcpPort = '', request = https.request } = {}) {
  assertOciConnectorReady(connector, 'create OCI security lists');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(vcnId, 'VCN OCID is required.');
  assertRequired(displayName, 'Security list name is required.');
  const tcpPorts = String(tcpPort || '')
    .split(',')
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  const rules = tcpPorts.length
    ? tcpPorts.map((port) => ({ protocol: String(protocol || '6'), tcpOptions: { destinationPortRange: { min: port, max: port } } }))
    : [{ protocol: String(protocol || '6') }];
  const body = { compartmentId, vcnId, displayName: String(displayName).trim(), ingressSecurityRules: [], egressSecurityRules: [] };
  if (direction === 'egress') {
    body.egressSecurityRules = rules.map((rule) => ({ ...rule, destination }));
  } else {
    body.ingressSecurityRules = rules.map((rule) => ({ ...rule, source }));
  }
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/securityLists',
    method: 'POST',
    body,
    successMessage: 'OCI security list creation requested.',
    request,
  });
  return { ...data, securityList: normalizeOciNetworkResource(data.result || {}, { region, compartmentId, resourceType: 'securityList' }) };
}

async function getObjectStorageNamespace(connector, { region, request = https.request, requestTimeoutMs = 20000 } = {}) {
  const namespaceResponse = await requestJson(connector, {
    service: 'objectstorage',
    region,
    pathWithQuery: '/n/',
    request,
    timeoutMs: requestTimeoutMs,
  });
  if (!namespaceResponse.ok) {
    const error = new Error(namespaceResponse.message || 'Unable to load OCI Object Storage namespace.');
    error.statusCode = namespaceResponse.statusCode || 502;
    throw error;
  }
  return typeof namespaceResponse.payload === 'string'
    ? namespaceResponse.payload
    : namespaceResponse.payload?.namespace || '';
}

export async function createOciBucket(connector, {
  region,
  compartmentId,
  name,
  storageTier = 'Standard',
  publicAccessType = 'NoPublicAccess',
  objectEventsEnabled = false,
  request = https.request,
  requestTimeoutMs = 30000,
} = {}) {
  assertOciConnectorReady(connector, 'create OCI buckets');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(name, 'Bucket name is required.');
  const namespace = await getObjectStorageNamespace(connector, { region, request, requestTimeoutMs });
  assertRequired(namespace, 'OCI Object Storage namespace is required.');
  const compartment = { id: compartmentId, name: compartmentId, lifecycleState: 'ACTIVE' };
  const data = await runOciMutation(connector, {
    service: 'objectstorage',
    region,
    pathWithQuery: `/n/${encodeURIComponent(namespace)}/b`,
    method: 'POST',
    body: {
      compartmentId,
      name: String(name).trim(),
      storageTier,
      publicAccessType,
      objectEventsEnabled: Boolean(objectEventsEnabled),
    },
    successMessage: 'OCI bucket creation requested.',
    request,
    timeoutMs: requestTimeoutMs,
  });
  return {
    ...data,
    bucket: normalizeOciBucket(data.result || { name }, { region, compartment, namespace }),
  };
}

export async function deleteOciBucket(connector, {
  region,
  compartmentId = '',
  bucketName,
  namespace = '',
  confirmation = '',
  request = https.request,
  requestTimeoutMs = 30000,
} = {}) {
  assertOciConnectorReady(connector, 'delete OCI buckets');
  assertRequired(region, 'OCI region is required.');
  assertRequired(bucketName, 'Bucket name is required.');
  const expected = String(bucketName || '').trim();
  if (String(confirmation || '').trim() !== expected) {
    const error = new Error('Type the bucket name to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }
  const resolvedNamespace = namespace || await getObjectStorageNamespace(connector, { region, request, requestTimeoutMs });
  assertRequired(resolvedNamespace, 'OCI Object Storage namespace is required.');
  const data = await runOciMutation(connector, {
    service: 'objectstorage',
    region,
    pathWithQuery: `/n/${encodeURIComponent(resolvedNamespace)}/b/${encodeURIComponent(bucketName)}`,
    method: 'DELETE',
    successMessage: 'OCI bucket deletion requested.',
    request,
    timeoutMs: requestTimeoutMs,
  });
  return {
    ...data,
    bucket: {
      id: `${resolvedNamespace}/${bucketName}`,
      name: bucketName,
      namespace: resolvedNamespace,
      region,
      compartmentId,
      providerType: 'bucket',
      resourceType: 'bucket',
      status: 'DELETING',
    },
  };
}

export async function createOciFileSystem(connector, {
  region,
  compartmentId,
  availabilityDomain,
  displayName,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'create OCI file systems');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(availabilityDomain, 'OCI availability domain is required.');
  assertRequired(displayName, 'File system name is required.');

  const data = await runOciMutation(connector, {
    service: 'filestorage',
    region,
    pathWithQuery: '/20171215/fileSystems',
    method: 'POST',
    body: {
      availabilityDomain,
      compartmentId,
      displayName: String(displayName).trim(),
    },
    successMessage: 'OCI file system creation requested.',
    request,
  });
  return {
    ...data,
    fileSystem: normalizeOciFileStorageResource(data.result || {}, {
      region,
      compartmentId,
      resourceType: 'fileSystem',
    }),
  };
}

export async function createOciMountTarget(connector, {
  region,
  compartmentId,
  availabilityDomain,
  subnetId,
  displayName,
  hostnameLabel = '',
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'create OCI mount targets');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(availabilityDomain, 'OCI availability domain is required.');
  assertRequired(subnetId, 'OCI subnet OCID is required.');
  assertRequired(displayName, 'Mount target name is required.');

  const body = {
    availabilityDomain,
    compartmentId,
    subnetId,
    displayName: String(displayName).trim(),
  };
  if (String(hostnameLabel || '').trim()) {
    body.hostnameLabel = String(hostnameLabel).trim();
  }
  const data = await runOciMutation(connector, {
    service: 'filestorage',
    region,
    pathWithQuery: '/20171215/mountTargets',
    method: 'POST',
    body,
    successMessage: 'OCI mount target creation requested.',
    request,
  });
  return {
    ...data,
    mountTarget: normalizeOciFileStorageResource(data.result || {}, {
      region,
      compartmentId,
      resourceType: 'mountTarget',
    }),
  };
}

export async function createOciVolumeBackup(connector, {
  region,
  resourceType = 'blockVolume',
  volumeId,
  volumeName = '',
  displayName,
  type = 'FULL',
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'create OCI volume backups');
  assertRequired(region, 'OCI region is required.');
  assertRequired(volumeId, 'OCI volume OCID is required.');
  const api = volumeApi(resourceType);
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/${api.backupCollection}`,
    method: 'POST',
    body: {
      [api.idField]: volumeId,
      displayName: String(displayName || `${volumeName || volumeId}-backup`).trim(),
      type: String(type || 'FULL').toUpperCase(),
    },
    successMessage: 'OCI volume backup requested.',
    request,
  });
  return {
    ...data,
    backup: {
      id: data.result?.id || '',
      name: data.result?.displayName || displayName || '',
      region,
      sourceVolumeId: volumeId,
      sourceVolumeName: volumeName,
      resourceType: `${resourceType}Backup`,
      status: data.result?.lifecycleState || 'CREATING',
      createdAt: data.result?.timeCreated || new Date().toISOString(),
    },
  };
}

export async function deleteOciVolumeBackup(connector, {
  region,
  resourceType = 'blockVolume',
  backupId,
  backupName = '',
  sourceVolumeId = '',
  confirmation = '',
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'delete OCI volume backups');
  assertRequired(region, 'OCI region is required.');
  assertRequired(backupId, 'OCI volume backup OCID is required.');
  const typed = String(confirmation || '').trim();
  const expectedName = String(backupName || '').trim();
  if (typed !== backupId && (!expectedName || typed !== expectedName)) {
    const error = new Error('Type the backup name or OCID to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }

  const api = volumeApi(resourceType);
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/${api.backupCollection}/${encodeURIComponent(backupId)}`,
    method: 'DELETE',
    successMessage: 'OCI volume backup deletion requested.',
    request,
  });
  return {
    ...data,
    backup: {
      id: backupId,
      name: backupName,
      region,
      sourceVolumeId,
      resourceType: `${resourceType}Backup`,
      status: 'DELETING',
    },
  };
}

export async function cloneOciVolume(connector, {
  region,
  resourceType = 'blockVolume',
  volumeId,
  displayName,
  compartmentId,
  availabilityDomain,
  sizeGb,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'clone OCI volumes');
  assertRequired(region, 'OCI region is required.');
  assertRequired(volumeId, 'OCI volume OCID is required.');
  assertRequired(displayName, 'New volume name is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(availabilityDomain, 'Availability domain is required.');
  const api = volumeApi(resourceType);
  const body = {
    compartmentId,
    availabilityDomain,
    displayName: String(displayName).trim(),
    sourceDetails: {
      type: api.sourceType,
      [api.idField]: volumeId,
    },
  };
  const size = Number(sizeGb);
  if (Number.isFinite(size) && size > 0) {
    body.sizeInGBs = size;
  }
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/${api.collection}`,
    method: 'POST',
    body,
    successMessage: 'OCI volume clone requested.',
    request,
  });
  return {
    ...data,
    volume: normalizeOciVolume(data.result || {}, { region, input: body, resourceType }),
  };
}

export async function restoreOciVolume(connector, {
  region,
  resourceType = 'blockVolume',
  backupId,
  displayName,
  compartmentId,
  availabilityDomain,
  sizeGb,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'restore OCI volumes');
  assertRequired(region, 'OCI region is required.');
  assertRequired(backupId, 'OCI volume backup OCID is required.');
  assertRequired(displayName, 'Restored volume name is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(availabilityDomain, 'Availability domain is required.');
  const api = volumeApi(resourceType);
  const body = {
    compartmentId,
    availabilityDomain,
    displayName: String(displayName).trim(),
    sourceDetails: {
      type: api.backupSourceType,
      id: backupId,
    },
  };
  const size = Number(sizeGb);
  if (Number.isFinite(size) && size > 0) {
    body.sizeInGBs = size;
  }
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/${api.collection}`,
    method: 'POST',
    body,
    successMessage: 'OCI volume restore requested.',
    request,
  });
  return {
    ...data,
    volume: normalizeOciVolume(data.result || {}, { region, input: body, resourceType }),
  };
}

export async function resizeOciVolume(connector, {
  region,
  resourceType = 'blockVolume',
  volumeId,
  volumeName = '',
  compartmentId = '',
  availabilityDomain = '',
  sizeGb,
  currentSizeGb,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'resize OCI volumes');
  assertRequired(region, 'OCI region is required.');
  assertRequired(volumeId, 'OCI volume OCID is required.');
  const size = Number(sizeGb);
  if (!Number.isFinite(size) || size <= 0) {
    const error = new Error('New volume size must be a positive number.');
    error.statusCode = 400;
    throw error;
  }
  const currentSize = Number(currentSizeGb);
  if (Number.isFinite(currentSize) && currentSize > 0 && size <= currentSize) {
    const error = new Error('New volume size must be larger than the current size.');
    error.statusCode = 400;
    throw error;
  }
  const api = volumeApi(resourceType);
  const body = { sizeInGBs: size };
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/${api.collection}/${encodeURIComponent(volumeId)}`,
    method: 'PUT',
    body,
    successMessage: 'OCI volume resize requested.',
    request,
  });
  return {
    ...data,
    volume: normalizeOciVolume(data.result || { id: volumeId }, {
      region,
      input: {
        ...body,
        displayName: volumeName,
        compartmentId,
        availabilityDomain,
      },
      resourceType,
    }),
  };
}

export async function createOciInstance(connector, {
  region,
  compartmentId,
  availabilityDomain,
  displayName,
  shape,
  imageId,
  subnetId,
  assignPublicIp = false,
  ocpus,
  memoryGb,
  bootVolumeSizeGb,
  sshPublicKey,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'create OCI VMs');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(availabilityDomain, 'Availability domain is required.');
  assertRequired(displayName, 'VM name is required.');
  assertRequired(shape, 'Shape is required.');
  assertRequired(imageId, 'Image OCID is required.');
  assertRequired(subnetId, 'Subnet OCID is required.');

  const body = {
    availabilityDomain: String(availabilityDomain).trim(),
    compartmentId: String(compartmentId).trim(),
    displayName: String(displayName).trim(),
    shape: String(shape).trim(),
    sourceDetails: {
      sourceType: 'image',
      imageId: String(imageId).trim(),
    },
    createVnicDetails: {
      subnetId: String(subnetId).trim(),
      assignPublicIp: Boolean(assignPublicIp),
    },
  };

  const bootSize = Number(bootVolumeSizeGb);
  if (Number.isFinite(bootSize) && bootSize > 0) {
    body.sourceDetails.bootVolumeSizeInGBs = bootSize;
  }
  const cpuCount = Number(ocpus);
  const memory = Number(memoryGb);
  if (Number.isFinite(cpuCount) && cpuCount > 0 && Number.isFinite(memory) && memory > 0) {
    body.shapeConfig = {
      ocpus: cpuCount,
      memoryInGBs: memory,
    };
  }
  if (String(sshPublicKey || '').trim()) {
    body.metadata = {
      ssh_authorized_keys: String(sshPublicKey).trim(),
    };
  }

  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/instances',
    method: 'POST',
    body,
    successMessage: 'OCI VM creation requested.',
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    instance: normalizeLaunchedInstance(data.result || {}, { region, input: body }),
  };
}

export async function updateOciInstance(connector, {
  region,
  instanceId,
  displayName,
  shape,
  ocpus,
  memoryGb,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'update OCI VMs');
  assertRequired(region, 'OCI region is required.');
  assertRequired(instanceId, 'OCI instance OCID is required.');
  assertRequired(displayName, 'VM name is required.');
  assertRequired(shape, 'Shape is required.');

  const cpuCount = Number(ocpus);
  const memory = Number(memoryGb);
  if (!Number.isFinite(cpuCount) || cpuCount <= 0) {
    const error = new Error('OCPU count must be greater than zero.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(memory) || memory <= 0) {
    const error = new Error('Memory must be greater than zero.');
    error.statusCode = 400;
    throw error;
  }

  const body = {
    displayName: String(displayName).trim(),
    shape: String(shape).trim(),
    shapeConfig: {
      ocpus: cpuCount,
      memoryInGBs: memory,
    },
  };
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/instances/${encodeURIComponent(instanceId)}`,
    method: 'PUT',
    body,
    successMessage: 'OCI VM configuration update requested.',
    request,
    timeoutMs: 30000,
  });

  return {
    ...data,
    instance: normalizeLaunchedInstance(data.result || {}, { region, input: body }),
  };
}

export async function getOciCustomImages(connector, {
  region,
  compartmentId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI custom images');
  assertRequired(region, 'OCI region is required.');
  assertRequired(compartmentId, 'OCI compartment OCID is required.');

  const errors = [];
  const images = await requestList(
    connector,
    {
      service: 'iaas',
      region,
      pathWithQuery: `/20160918/images?compartmentId=${encodeURIComponent(compartmentId)}&imageType=CUSTOM`,
      request,
      timeoutMs: requestTimeoutMs,
      retryAttempts: 4,
    },
    errors,
    'customImages',
  );

  return {
    generatedAt: new Date().toISOString(),
    region,
    compartmentId,
    images: images
      .filter((image) => isCustomImageForCompartment(image, compartmentId))
      .map((image) => normalizeCustomImage(image, { region })),
    errors,
  };
}

export async function getOciCustomImage(connector, {
  region,
  imageId,
  request = https.request,
  requestTimeoutMs = 20000,
} = {}) {
  assertOciConnectorReady(connector, 'load OCI custom image status');
  assertRequired(region, 'OCI region is required.');
  assertRequired(imageId, 'OCI custom image OCID is required.');

  const response = await requestJson(connector, {
    service: 'iaas',
    region,
    pathWithQuery: `/20160918/images/${encodeURIComponent(imageId)}`,
    method: 'GET',
    request,
    timeoutMs: requestTimeoutMs,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'Unable to load OCI custom image status.');
    error.statusCode = response.statusCode || 502;
    throw error;
  }

  return {
    generatedAt: new Date().toISOString(),
    image: normalizeCustomImage(response.payload || {}, { region, imageId }),
  };
}

export async function deleteOciCustomImage(connector, {
  region,
  imageId,
  confirmation,
  imageName,
  request = https.request,
} = {}) {
  assertOciConnectorReady(connector, 'delete OCI custom images');
  assertRequired(region, 'OCI region is required.');
  assertRequired(imageId, 'OCI custom image OCID is required.');

  const current = await getOciCustomImage(connector, { region, imageId, request });
  const currentName = current.image.name || imageName || imageId;
  const typed = String(confirmation || '').trim();
  if (typed !== String(currentName).trim() && typed !== imageId) {
    const error = new Error('Type the custom image name or OCID to confirm deletion.');
    error.statusCode = 400;
    throw error;
  }

  const status = String(current.image.status || '').toUpperCase();
  if (['CREATING', 'IMPORTING', 'EXPORTING'].includes(status)) {
    const error = new Error(`Custom image is ${status}. Wait until it is available or failed before deleting.`);
    error.statusCode = 409;
    throw error;
  }

  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/images/${encodeURIComponent(imageId)}`,
    method: 'DELETE',
    successMessage: 'OCI custom image deletion requested.',
    request,
  });

  return {
    ...data,
    image: current.image,
  };
}

export async function terminateOciInstance(connector, { region, instanceId, confirmation, instanceName }) {
  assertRequired(instanceId, 'OCI instance OCID is required.');
  if (String(confirmation || '').trim() !== String(instanceName || instanceId).trim() && String(confirmation || '').trim() !== instanceId) {
    const error = new Error('Type the VM name or OCID to confirm termination.');
    error.statusCode = 400;
    throw error;
  }
  return runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/instances/${encodeURIComponent(instanceId)}`,
    method: 'DELETE',
    successMessage: 'OCI VM termination requested.',
  });
}

export async function createOciInstanceImage(connector, { region, compartmentId, instanceId, displayName, request = https.request }) {
  assertRequired(compartmentId, 'OCI compartment OCID is required.');
  assertRequired(instanceId, 'OCI instance OCID is required.');
  assertRequired(displayName, 'Custom image name is required.');
  const data = await runOciMutation(connector, {
    region,
    pathWithQuery: '/20160918/images',
    method: 'POST',
    body: {
      compartmentId,
      instanceId,
      displayName: String(displayName).trim(),
    },
    successMessage: 'OCI custom image creation requested.',
    request,
  });
  return {
    ...data,
    image: normalizeCustomImage(data.result || {}, {
      region,
      compartmentId,
      sourceInstanceId: instanceId,
      sourceInstanceName: '',
    }),
  };
}

export async function moveOciInstance(connector, { region, instanceId, targetCompartmentId }) {
  assertRequired(instanceId, 'OCI instance OCID is required.');
  assertRequired(targetCompartmentId, 'Target compartment OCID is required.');
  return runOciMutation(connector, {
    region,
    pathWithQuery: `/20160918/instances/${encodeURIComponent(instanceId)}/actions/changeCompartment`,
    method: 'POST',
    body: {
      compartmentId: String(targetCompartmentId).trim(),
    },
    successMessage: 'OCI VM move requested.',
  });
}
