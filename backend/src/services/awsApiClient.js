import https from 'https';
import { createHash, createHmac } from 'crypto';

const AWS_GLOBAL_REGION = 'us-east-1';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function amzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

function hostFor(service, region) {
  if (service === 'iam') {
    return 'iam.amazonaws.com';
  }
  if (service === 's3') {
    if (region && region !== AWS_GLOBAL_REGION) {
      return `s3.${region}.amazonaws.com`;
    }
    return 's3.amazonaws.com';
  }
  return `${service}.${region}.amazonaws.com`;
}

function splitPathAndQuery(path = '/') {
  const [pathname, rawQuery = ''] = String(path || '/').split('?');
  const params = new URLSearchParams(rawQuery);
  const canonicalQuery = Array.from(params.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return {
    pathname: pathname || '/',
    canonicalQuery,
  };
}

function encodeS3Key(key = '') {
  return String(key).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function signRequest({ connector, service, region, method, path, body = '', headers = {}, now = new Date() }) {
  const signingRegion = service === 'iam' ? AWS_GLOBAL_REGION : (region || AWS_GLOBAL_REGION);
  const host = hostFor(service, region);
  const { pathname, canonicalQuery } = splitPathAndQuery(path);
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const payloadHash = hash(body);
  const requestHeaders = {
    Host: host,
    'X-Amz-Date': date,
    'X-Amz-Content-Sha256': payloadHash,
    ...headers,
  };

  if (connector.awsSessionToken) {
    requestHeaders['X-Amz-Security-Token'] = connector.awsSessionToken;
  }

  const headerLookup = new Map(Object.entries(requestHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const signedHeaderNames = Array.from(headerLookup.keys()).sort();
  const canonicalHeaders = signedHeaderNames.map((key) => `${key}:${headerLookup.get(key)}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${signingRegion}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    credentialScope,
    hash(canonicalRequest),
  ].join('\n');
  const signature = hmac(signingKey(connector.awsSecretAccessKey, dateStamp, signingRegion, service), stringToSign, 'hex');

  return {
    host,
    headers: {
      ...requestHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${connector.awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function requestAws({ connector, service, region, method = 'POST', path = '/', body = '', headers = {}, request = https.request, timeoutMs = 12000 }) {
  return new Promise((resolve) => {
    let signed;
    try {
      signed = signRequest({ connector, service, region, method, path, body, headers });
    } catch (error) {
      resolve({ ok: false, message: error.message || 'Unable to sign AWS request.' });
      return;
    }

    const req = request(
      {
        protocol: 'https:',
        hostname: signed.host,
        path,
        method,
        timeout: timeoutMs,
        rejectUnauthorized: connector.tlsVerify !== false,
        headers: signed.headers,
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ ok: true, statusCode: response.statusCode, body: responseBody, headers: response.headers });
            return;
          }
          const code = tagValue(responseBody, 'Code');
          const message = tagValue(responseBody, 'Message') || responseBody.slice(0, 160);
          resolve({
            ok: false,
            statusCode: response.statusCode,
            message: message ? `AWS returned HTTP ${response.statusCode}: ${code ? `${code}: ` : ''}${message}` : `AWS returned HTTP ${response.statusCode}.`,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`AWS request timed out after ${Math.round(timeoutMs / 1000)}s.`)));
    req.on('error', (error) => resolve({ ok: false, message: error.message || 'Unable to reach AWS.' }));
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function queryBody(action, version, params = {}) {
  const body = new URLSearchParams({ Action: action, Version: version });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      body.set(key, String(value));
    }
  }
  return body.toString();
}

async function awsQuery(connector, { service, region, action, version, params = {}, errors, label, timeoutMs }) {
  const body = queryBody(action, version, params);
  const response = await requestAws({
    connector,
    service,
    region,
    body,
    timeoutMs,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      Accept: 'application/xml',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  if (!response.ok) {
    errors.push({ scope: label || action, region, message: response.message });
    return '';
  }
  return response.body;
}

async function awsQueryOrThrow(connector, { service = 'ec2', region, action, version = '2016-11-15', params = {}, timeoutMs }) {
  const errors = [];
  const xml = await awsQuery(connector, {
    service,
    region,
    action,
    version,
    params,
    errors,
    label: action,
    timeoutMs,
  });
  if (!xml) {
    const error = new Error(errors[0]?.message || `AWS ${action} request failed.`);
    error.statusCode = errors[0]?.message?.includes('Unauthorized') || errors[0]?.message?.includes('Auth') ? 401 : 502;
    throw error;
  }
  return xml;
}

async function awsQueryPages(connector, { tokenParam = 'NextToken', tokenTag = 'nextToken', maxPages = 20, ...options }) {
  const pages = [];
  let nextToken = '';
  for (let page = 0; page < maxPages; page += 1) {
    const xml = await awsQuery(connector, {
      ...options,
      params: {
        ...(options.params || {}),
        ...(nextToken ? { [tokenParam]: nextToken } : {}),
      },
    });
    if (!xml) {
      break;
    }
    pages.push(xml);
    nextToken = tagValue(xml, tokenTag) || tagValue(xml, 'NextToken') || tagValue(xml, 'Marker') || tagValue(xml, 'NextMarker');
    if (!nextToken) {
      break;
    }
  }
  return pages;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagValue(xml, tag) {
  const escaped = escapeRegExp(tag);
  const match = String(xml || '').match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`));
  return match ? decodeXml(match[1].trim()) : '';
}

function tagValues(xml, tag) {
  const escaped = escapeRegExp(tag);
  return Array.from(String(xml || '').matchAll(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, 'g')))
    .map((match) => decodeXml(match[1].trim()));
}

function tagBlocks(xml, tag) {
  const escaped = escapeRegExp(tag);
  return Array.from(String(xml || '').matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'g')))
    .map((match) => match[1]);
}

function section(xml, tag) {
  const escaped = escapeRegExp(tag);
  const match = String(xml || '').match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`));
  return match ? match[1] : '';
}

function itemsFromSection(xml, sectionTag, itemTag = 'item') {
  const body = section(xml, sectionTag);
  if (!body) {
    return [];
  }
  const escaped = escapeRegExp(itemTag);
  const tokenRegex = new RegExp(`<${escaped}(?:\\s[^>]*)?/?>|</${escaped}>`, 'g');
  const items = [];
  let depth = 0;
  let startIndex = -1;
  let match;

  while ((match = tokenRegex.exec(body)) !== null) {
    const token = match[0];
    const isClosing = token.startsWith('</');
    const isSelfClosing = token.endsWith('/>');

    if (!isClosing) {
      if (depth === 0) {
        startIndex = tokenRegex.lastIndex;
      }
      if (isSelfClosing) {
        if (depth === 0) {
          items.push('');
          startIndex = -1;
        }
        continue;
      }
      depth += 1;
      continue;
    }

    if (depth === 0) {
      continue;
    }
    depth -= 1;
    if (depth === 0 && startIndex >= 0) {
      items.push(body.slice(startIndex, match.index));
      startIndex = -1;
    }
  }

  return items;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function s3ObjectPath(bucketName, key = '') {
  const bucket = encodeURIComponent(String(bucketName || '').trim());
  const encodedKey = String(key || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return encodedKey ? `/${bucket}/${encodedKey}` : `/${bucket}`;
}

function nameFromTags(xml) {
  return itemsFromSection(xml, 'tagSet')
    .map((item) => ({ key: tagValue(item, 'key'), value: tagValue(item, 'value') }))
    .find((tag) => tag.key === 'Name')?.value || '';
}

function tagsFromXml(xml) {
  return itemsFromSection(xml, 'tagSet')
    .map((item) => ({ key: tagValue(item, 'key'), value: tagValue(item, 'value') }))
    .filter((tag) => tag.key);
}

function firstPrivateIp(xml) {
  return tagValue(itemsFromSection(xml, 'privateIpAddressesSet')[0] || '', 'privateIpAddress') || tagValue(xml, 'privateIpAddress');
}

function mapInstance(xml, region) {
  const id = tagValue(xml, 'instanceId');
  return {
    id,
    name: nameFromTags(xml) || id,
    status: tagValue(section(xml, 'instanceState'), 'name'),
    region,
    availabilityDomain: tagValue(xml, 'placement') ? tagValue(section(xml, 'placement'), 'availabilityZone') : tagValue(xml, 'availabilityZone'),
    shape: tagValue(xml, 'instanceType'),
    privateIp: firstPrivateIp(xml),
    publicIp: tagValue(xml, 'ipAddress') || tagValue(xml, 'publicIpAddress'),
    subnetId: tagValue(xml, 'subnetId'),
    vpcId: tagValue(xml, 'vpcId'),
    createdAt: tagValue(xml, 'launchTime'),
    tags: tagsFromXml(xml),
    providerType: 'ec2Instance',
    resourceType: 'ec2Instance',
  };
}

function mapSimpleNetwork(xml, region, idTag, fallbackNamePrefix, type, extra = {}) {
  const id = tagValue(xml, idTag);
  return {
    id,
    name: nameFromTags(xml) || id || fallbackNamePrefix,
    status: tagValue(xml, 'state') || tagValue(xml, 'attachmentState') || '-',
    region,
    providerType: type,
    resourceType: type,
    ...extra(xml),
  };
}

function routeRowsFromXml(xml) {
  return itemsFromSection(xml, 'routeSet').map((route) => ({
    destination: tagValue(route, 'destinationCidrBlock') || tagValue(route, 'destinationIpv6CidrBlock') || tagValue(route, 'destinationPrefixListId'),
    target: tagValue(route, 'gatewayId') || tagValue(route, 'natGatewayId') || tagValue(route, 'instanceId') || tagValue(route, 'networkInterfaceId') || tagValue(route, 'transitGatewayId') || tagValue(route, 'vpcPeeringConnectionId') || tagValue(route, 'egressOnlyInternetGatewayId'),
    state: tagValue(route, 'state'),
    origin: tagValue(route, 'origin'),
  })).filter((route) => route.destination || route.target);
}

function routeTableAssociationsFromXml(xml) {
  return itemsFromSection(xml, 'associationSet').map((association) => ({
    id: tagValue(association, 'routeTableAssociationId'),
    subnetId: tagValue(association, 'subnetId'),
    gatewayId: tagValue(association, 'gatewayId'),
    main: tagValue(association, 'main') === 'true',
    state: tagValue(section(association, 'associationState'), 'state'),
  })).filter((association) => association.id || association.subnetId || association.gatewayId || association.main);
}

function securityRuleRowsFromXml(xml, direction) {
  return itemsFromSection(xml, direction === 'egress' ? 'ipPermissionsEgress' : 'ipPermissions').map((permission) => ({
    direction,
    protocol: tagValue(permission, 'ipProtocol'),
    fromPort: tagValue(permission, 'fromPort'),
    toPort: tagValue(permission, 'toPort'),
    cidrBlocks: itemsFromSection(permission, 'ipRanges').map((range) => tagValue(range, 'cidrIp')).filter(Boolean),
    sourceGroups: itemsFromSection(permission, 'groups').map((group) => tagValue(group, 'groupId') || tagValue(group, 'groupName')).filter(Boolean),
  }));
}

function withNameTag(params, resourceType, name, offset = 1) {
  const tagName = String(name || '').trim();
  if (!tagName) {
    return params;
  }
  return {
    ...params,
    [`TagSpecification.${offset}.ResourceType`]: resourceType,
    [`TagSpecification.${offset}.Tag.1.Key`]: 'Name',
    [`TagSpecification.${offset}.Tag.1.Value`]: tagName,
  };
}

function mapVolume(xml, region) {
  const id = tagValue(xml, 'volumeId');
  return {
    id,
    name: nameFromTags(xml) || id,
    status: tagValue(xml, 'status'),
    region,
    availabilityDomain: tagValue(xml, 'availabilityZone'),
    sizeGb: tagValue(xml, 'size'),
    type: tagValue(xml, 'volumeType'),
    attachedInstanceId: tagValue(itemsFromSection(xml, 'attachmentSet')[0] || '', 'instanceId'),
    device: tagValue(itemsFromSection(xml, 'attachmentSet')[0] || '', 'device'),
    createdAt: tagValue(xml, 'createTime'),
    tags: tagsFromXml(xml),
    providerType: 'ebsVolume',
    resourceType: 'ebsVolume',
  };
}

function mapSnapshot(xml, region) {
  const id = tagValue(xml, 'snapshotId');
  return {
    id,
    name: nameFromTags(xml) || id,
    status: tagValue(xml, 'status'),
    region,
    sizeGb: tagValue(xml, 'volumeSize'),
    volumeId: tagValue(xml, 'volumeId'),
    createdAt: tagValue(xml, 'startTime'),
    description: tagValue(xml, 'description'),
    providerType: 'ebsSnapshot',
    resourceType: 'ebsSnapshot',
  };
}

function mapImage(xml, region) {
  const id = tagValue(xml, 'imageId');
  const name = tagValue(xml, 'name') || id;
  return {
    id,
    name,
    description: tagValue(xml, 'description'),
    status: tagValue(xml, 'imageState'),
    region,
    architecture: tagValue(xml, 'architecture'),
    platform: tagValue(xml, 'platformDetails') || tagValue(xml, 'platform') || 'Linux/UNIX',
    ownerId: tagValue(xml, 'imageOwnerId') || tagValue(xml, 'ownerId'),
    rootDeviceType: tagValue(xml, 'rootDeviceType'),
    virtualizationType: tagValue(xml, 'virtualizationType'),
    enaSupport: tagValue(xml, 'enaSupport'),
    createdAt: tagValue(xml, 'creationDate'),
    providerType: 'ami',
    resourceType: 'ami',
  };
}

export function parseEc2Instances(xml, region) {
  return itemsFromSection(xml, 'reservationSet')
    .flatMap((reservation) => itemsFromSection(reservation, 'instancesSet'))
    .map((item) => mapInstance(item, region));
}

function mapKeyPair(xml, region) {
  const name = tagValue(xml, 'keyName');
  return {
    id: tagValue(xml, 'keyPairId') || name,
    name,
    fingerprint: tagValue(xml, 'keyFingerprint'),
    region,
    providerType: 'keyPair',
    resourceType: 'keyPair',
  };
}

function mapAddress(xml, region) {
  const id = tagValue(xml, 'allocationId') || tagValue(xml, 'publicIp');
  return {
    id,
    name: tagValue(xml, 'publicIp'),
    status: tagValue(xml, 'associationId') ? 'associated' : 'available',
    region,
    publicIp: tagValue(xml, 'publicIp'),
    privateIp: tagValue(xml, 'privateIpAddress'),
    instanceId: tagValue(xml, 'instanceId'),
    providerType: 'elasticIp',
    resourceType: 'elasticIp',
  };
}

function mapRdsInstance(xml, region) {
  const id = tagValue(xml, 'DBInstanceIdentifier');
  const endpointXml = section(xml, 'Endpoint');
  return {
    id: tagValue(xml, 'DbiResourceId') || id,
    name: id,
    status: tagValue(xml, 'DBInstanceStatus'),
    region,
    shape: tagValue(xml, 'DBInstanceClass'),
    engine: tagValue(xml, 'Engine'),
    dbVersion: tagValue(xml, 'EngineVersion'),
    storageSizeGb: tagValue(xml, 'AllocatedStorage'),
    storageType: tagValue(xml, 'StorageType'),
    dbName: tagValue(xml, 'DBName'),
    endpoint: tagValue(endpointXml, 'Address'),
    port: tagValue(endpointXml, 'Port'),
    availabilityDomain: tagValue(xml, 'AvailabilityZone'),
    publiclyAccessible: tagValue(xml, 'PubliclyAccessible'),
    backupRetentionPeriod: tagValue(xml, 'BackupRetentionPeriod'),
    multiAz: tagValue(xml, 'MultiAZ'),
    vpcSecurityGroups: itemsFromSection(xml, 'VpcSecurityGroups', 'VpcSecurityGroupMembership').map((group) => ({
      id: tagValue(group, 'VpcSecurityGroupId'),
      status: tagValue(group, 'Status'),
    })).filter((group) => group.id),
    dbSubnetGroup: tagValue(section(xml, 'DBSubnetGroup'), 'DBSubnetGroupName'),
    createdAt: tagValue(xml, 'InstanceCreateTime'),
    providerType: 'rdsDatabase',
    resourceType: 'rdsDatabase',
  };
}

function mapRdsSnapshot(xml, region) {
  const id = tagValue(xml, 'DBSnapshotIdentifier');
  return {
    id,
    name: id,
    status: tagValue(xml, 'Status'),
    region,
    engine: tagValue(xml, 'Engine'),
    dbVersion: tagValue(xml, 'EngineVersion'),
    storageSizeGb: tagValue(xml, 'AllocatedStorage'),
    storageType: tagValue(xml, 'StorageType'),
    dbInstanceId: tagValue(xml, 'DBInstanceIdentifier'),
    instanceId: tagValue(xml, 'DBInstanceIdentifier'),
    snapshotType: tagValue(xml, 'SnapshotType'),
    createdAt: tagValue(xml, 'SnapshotCreateTime') || tagValue(xml, 'InstanceCreateTime'),
    providerType: 'rdsSnapshot',
    resourceType: 'rdsSnapshot',
  };
}

function mapLoadBalancer(xml, region) {
  const id = tagValue(xml, 'LoadBalancerArn') || tagValue(xml, 'DNSName');
  return {
    id,
    name: tagValue(xml, 'LoadBalancerName') || id,
    status: tagValue(section(xml, 'State'), 'Code'),
    region,
    dnsName: tagValue(xml, 'DNSName'),
    type: tagValue(xml, 'Type'),
    scheme: tagValue(xml, 'Scheme'),
    vpcId: tagValue(xml, 'VpcId'),
    createdAt: tagValue(xml, 'CreatedTime'),
    providerType: 'loadBalancer',
    resourceType: 'loadBalancer',
  };
}

function summaryFor(data) {
  return {
    regions: data.regions.length,
    instances: data.instances.length,
    runningInstances: data.instances.filter((item) => String(item.status || '').toLowerCase() === 'running').length,
    stoppedInstances: data.instances.filter((item) => ['stopped', 'stopping'].includes(String(item.status || '').toLowerCase())).length,
    vpcs: data.vpcs.length,
    subnets: data.subnets.length,
    securityGroups: data.securityGroups.length,
    routeTables: data.routeTables.length,
    internetGateways: data.internetGateways.length,
    natGateways: data.natGateways.length,
    ebsVolumes: data.ebsVolumes.length,
    ebsSnapshots: data.ebsSnapshots.length,
    s3Buckets: data.s3Buckets.length,
    rdsDatabases: data.rdsDatabases.length,
    loadBalancers: data.loadBalancers.length,
    elasticIps: data.elasticIps.length,
  };
}

async function discoverRegions(connector, errors) {
  const xml = await awsQuery(connector, {
    service: 'ec2',
    region: connector.region || AWS_GLOBAL_REGION,
    action: 'DescribeRegions',
    version: '2016-11-15',
    errors,
    label: 'regions',
  });
  const regions = itemsFromSection(xml, 'regionInfo').map((item) => ({
    name: tagValue(item, 'regionName'),
    endpoint: tagValue(item, 'regionEndpoint'),
    status: 'available',
  })).filter((region) => region.name);
  return regions.length ? regions : [{ name: connector.region || AWS_GLOBAL_REGION, endpoint: '', status: 'configured' }];
}

async function discoverRegionalResources(connector, region, errors) {
  const ec2Version = '2016-11-15';
  const [instancesXml, vpcsXml, subnetsXml, securityGroupsXml, routeTablesXml, internetGatewaysXml, natGatewaysXml, volumesXml, snapshotsXml, addressesXml, rdsXml, loadBalancersXml] = await Promise.all([
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeInstances', version: ec2Version, errors, label: 'instances' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeVpcs', version: ec2Version, errors, label: 'vpcs' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeSubnets', version: ec2Version, errors, label: 'subnets' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeSecurityGroups', version: ec2Version, errors, label: 'securityGroups' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeRouteTables', version: ec2Version, errors, label: 'routeTables' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeInternetGateways', version: ec2Version, errors, label: 'internetGateways' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeNatGateways', version: ec2Version, errors, label: 'natGateways' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeVolumes', version: ec2Version, errors, label: 'ebsVolumes' }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeSnapshots', version: ec2Version, params: { 'Owner.1': 'self' }, errors, label: 'ebsSnapshots', timeoutMs: 20000 }),
    awsQueryPages(connector, { service: 'ec2', region, action: 'DescribeAddresses', version: ec2Version, errors, label: 'elasticIps' }),
    awsQueryPages(connector, { service: 'rds', region, action: 'DescribeDBInstances', version: '2014-10-31', errors, label: 'rdsDatabases', tokenParam: 'Marker', tokenTag: 'Marker' }),
    awsQueryPages(connector, { service: 'elasticloadbalancing', region, action: 'DescribeLoadBalancers', version: '2015-12-01', errors, label: 'loadBalancers', tokenParam: 'Marker', tokenTag: 'NextMarker' }),
  ]);

  const instances = instancesXml.flatMap((xml) => parseEc2Instances(xml, region));
  const loadBalancerItems = [
    ...loadBalancersXml.flatMap((xml) => itemsFromSection(xml, 'LoadBalancers', 'member')),
    ...loadBalancersXml.flatMap((xml) => itemsFromSection(xml, 'loadBalancerDescriptions', 'member')),
  ];

  return {
    instances,
    vpcs: vpcsXml.flatMap((xml) => itemsFromSection(xml, 'vpcSet')).map((item) => mapSimpleNetwork(item, region, 'vpcId', 'vpc', 'vpc', (row) => ({ cidrBlock: tagValue(row, 'cidrBlock'), isDefault: tagValue(row, 'isDefault') }))),
    subnets: subnetsXml.flatMap((xml) => itemsFromSection(xml, 'subnetSet')).map((item) => mapSimpleNetwork(item, region, 'subnetId', 'subnet', 'subnet', (row) => ({ cidrBlock: tagValue(row, 'cidrBlock'), vpcId: tagValue(row, 'vpcId'), availabilityDomain: tagValue(row, 'availabilityZone'), availableIpAddressCount: tagValue(row, 'availableIpAddressCount'), mapPublicIpOnLaunch: tagValue(row, 'mapPublicIpOnLaunch') }))),
    securityGroups: securityGroupsXml.flatMap((xml) => itemsFromSection(xml, 'securityGroupInfo')).map((item) => mapSimpleNetwork(item, region, 'groupId', 'security-group', 'securityGroup', (row) => ({ vpcId: tagValue(row, 'vpcId'), description: tagValue(row, 'groupDescription'), name: tagValue(row, 'groupName') || tagValue(row, 'groupId'), ingressRules: securityRuleRowsFromXml(row, 'ingress'), egressRules: securityRuleRowsFromXml(row, 'egress') }))),
    routeTables: routeTablesXml.flatMap((xml) => itemsFromSection(xml, 'routeTableSet')).map((item) => mapSimpleNetwork(item, region, 'routeTableId', 'route-table', 'routeTable', (row) => ({ vpcId: tagValue(row, 'vpcId'), associations: routeTableAssociationsFromXml(row), routes: routeRowsFromXml(row) }))),
    internetGateways: internetGatewaysXml.flatMap((xml) => itemsFromSection(xml, 'internetGatewaySet')).map((item) => mapSimpleNetwork(item, region, 'internetGatewayId', 'internet-gateway', 'internetGateway', (row) => ({ vpcId: tagValue(itemsFromSection(row, 'attachmentSet')[0] || '', 'vpcId'), attachments: itemsFromSection(row, 'attachmentSet').map((attachment) => ({ vpcId: tagValue(attachment, 'vpcId'), state: tagValue(attachment, 'state') })) }))),
    natGateways: natGatewaysXml.flatMap((xml) => itemsFromSection(xml, 'natGatewaySet')).map((item) => mapSimpleNetwork(item, region, 'natGatewayId', 'nat-gateway', 'natGateway', (row) => ({ vpcId: tagValue(row, 'vpcId'), subnetId: tagValue(row, 'subnetId') }))),
    ebsVolumes: volumesXml.flatMap((xml) => itemsFromSection(xml, 'volumeSet')).map((item) => mapVolume(item, region)),
    ebsSnapshots: snapshotsXml.flatMap((xml) => itemsFromSection(xml, 'snapshotSet')).map((item) => mapSnapshot(item, region)),
    elasticIps: addressesXml.flatMap((xml) => itemsFromSection(xml, 'addressesSet')).map((item) => mapAddress(item, region)),
    rdsDatabases: rdsXml.flatMap((xml) => itemsFromSection(xml, 'DBInstances', 'DBInstance')).map((item) => mapRdsInstance(item, region)),
    loadBalancers: loadBalancerItems.map((item) => mapLoadBalancer(item, region)).filter((item) => item.id),
  };
}

async function discoverS3Buckets(connector, errors) {
  const response = await requestAws({
    connector,
    service: 's3',
    region: AWS_GLOBAL_REGION,
    method: 'GET',
    path: '/',
    headers: { Accept: 'application/xml' },
  });
  if (!response.ok) {
    errors.push({ scope: 's3Buckets', region: 'global', message: response.message });
    return [];
  }
  const buckets = itemsFromSection(response.body, 'Buckets', 'Bucket').map((item) => {
    const name = tagValue(item, 'Name');
    return {
      id: name,
      name,
      status: 'available',
      region: 'global',
      createdAt: tagValue(item, 'CreationDate'),
      providerType: 's3Bucket',
      resourceType: 's3Bucket',
    };
  }).filter((bucket) => bucket.name);
  const enriched = await Promise.all(buckets.map(async (bucket) => ({
    ...bucket,
    ...(await getAwsBucketMetadata(connector, { bucketName: bucket.name }).catch(() => ({}))),
  })));
  return enriched;
}

async function discoverIamSummary(connector, errors) {
  const xml = await awsQuery(connector, {
    service: 'iam',
    region: AWS_GLOBAL_REGION,
    action: 'GetAccountSummary',
    version: '2010-05-08',
    errors,
    label: 'iamSummary',
  });
  const summary = {};
  for (const member of itemsFromSection(xml, 'SummaryMap', 'entry')) {
    const key = tagValue(member, 'key');
    const value = Number(tagValue(member, 'value'));
    if (key) {
      summary[key] = Number.isFinite(value) ? value : tagValue(member, 'value');
    }
  }
  return summary;
}

export async function getAwsInventory(connector, options = {}) {
  const scanRegion = String(options.region || 'all').trim() || 'all';
  const errors = [];
  const discoveredRegions = await discoverRegions(connector, errors);
  const regionsToScan = scanRegion === 'all'
    ? discoveredRegions.map((region) => region.name)
    : [scanRegion];

  const data = {
    generatedAt: new Date().toISOString(),
    cached: false,
    connector: {
      id: connector.id,
      name: connector.name,
      region: connector.region,
      accountId: connector.awsAccountId || '',
    },
    scan: {
      requestedRegion: scanRegion,
      scannedRegions: regionsToScan,
    },
    regions: discoveredRegions,
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
    errors,
  };

  const regionalResults = await Promise.all(regionsToScan.map((region) => discoverRegionalResources(connector, region, errors)));
  for (const result of regionalResults) {
    for (const key of ['instances', 'vpcs', 'subnets', 'securityGroups', 'routeTables', 'internetGateways', 'natGateways', 'ebsVolumes', 'ebsSnapshots', 'rdsDatabases', 'loadBalancers', 'elasticIps']) {
      data[key].push(...result[key]);
    }
  }

  data.s3Buckets = await discoverS3Buckets(connector, errors);
  data.iamSummary = await discoverIamSummary(connector, errors);
  data.summary = summaryFor(data);
  return data;
}

export async function describeAwsInstance(connector, { region, instanceId }) {
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'DescribeInstances',
    params: { 'InstanceId.1': instanceId },
  });
  const instance = parseEc2Instances(xml, region)[0];
  if (!instance) {
    const error = new Error('AWS instance was not found.');
    error.statusCode = 404;
    throw error;
  }
  return instance;
}

export async function describeAwsVolume(connector, { region, volumeId }) {
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'DescribeVolumes',
    params: { 'VolumeId.1': volumeId },
  });
  const volumeXml = itemsFromSection(xml, 'volumeSet')[0];
  if (!volumeXml) {
    const error = new Error('AWS volume was not found.');
    error.statusCode = 404;
    throw error;
  }
  return mapVolume(volumeXml, region);
}

export async function describeAwsRouteTable(connector, { region, routeTableId }) {
  if (!region || !routeTableId) {
    const error = new Error('Region and route table ID are required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'DescribeRouteTables',
    params: { 'RouteTableId.1': routeTableId },
  });
  const routeTableXml = itemsFromSection(xml, 'routeTableSet')[0];
  if (!routeTableXml) {
    const error = new Error('AWS route table was not found.');
    error.statusCode = 404;
    throw error;
  }
  return mapSimpleNetwork(routeTableXml, region, 'routeTableId', 'route-table', 'routeTable', (row) => ({
    vpcId: tagValue(row, 'vpcId'),
    associations: routeTableAssociationsFromXml(row),
    routes: routeRowsFromXml(row),
  }));
}

export async function describeAwsRdsInstance(connector, { region, dbInstanceIdentifier }) {
  if (!region || !dbInstanceIdentifier) {
    const error = new Error('Region and DB instance identifier are required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    service: 'rds',
    region,
    action: 'DescribeDBInstances',
    version: '2014-10-31',
    params: { DBInstanceIdentifier: dbInstanceIdentifier },
  });
  const dbXml = itemsFromSection(xml, 'DBInstances', 'DBInstance')[0];
  if (!dbXml) {
    const error = new Error('AWS RDS DB instance was not found.');
    error.statusCode = 404;
    throw error;
  }
  return mapRdsInstance(dbXml, region);
}

export async function listAwsRdsSnapshots(connector, { region, dbInstanceIdentifier = '', snapshotType = 'manual' } = {}) {
  const normalizedRegion = String(region || '').trim();
  if (!normalizedRegion) {
    const error = new Error('Region is required.');
    error.statusCode = 400;
    throw error;
  }
  const params = {
    SnapshotType: snapshotType || 'manual',
    DBInstanceIdentifier: dbInstanceIdentifier || '',
  };
  const errors = [];
  const pages = await awsQueryPages(connector, {
    service: 'rds',
    region: normalizedRegion,
    action: 'DescribeDBSnapshots',
    version: '2014-10-31',
    params,
    errors,
    label: 'rdsSnapshots',
    tokenParam: 'Marker',
    tokenTag: 'Marker',
  });
  if (!pages.length && errors.length) {
    const error = new Error(errors[0].message || 'AWS RDS snapshot listing failed.');
    error.statusCode = errors[0].message?.includes('Unauthorized') || errors[0].message?.includes('Auth') ? 401 : 502;
    throw error;
  }
  return {
    generatedAt: new Date().toISOString(),
    region: normalizedRegion,
    snapshots: pages
      .flatMap((xml) => itemsFromSection(xml, 'DBSnapshots', 'DBSnapshot'))
      .map((item) => mapRdsSnapshot(item, normalizedRegion))
      .filter((snapshot) => snapshot.id)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
  };
}

export async function createAwsRdsInstance(connector, payload = {}) {
  const region = String(payload.region || '').trim();
  const dbInstanceIdentifier = String(payload.dbInstanceIdentifier || payload.name || '').trim();
  const dbInstanceClass = String(payload.dbInstanceClass || payload.shape || 'db.t3.micro').trim();
  const engine = String(payload.engine || 'postgres').trim();
  const allocatedStorage = Number(payload.allocatedStorage || payload.storageSizeGb || 20);
  const masterUsername = String(payload.masterUsername || '').trim();
  const masterUserPassword = String(payload.masterUserPassword || '').trim();
  const backupRetentionPeriod = payload.backupRetentionPeriod === undefined || payload.backupRetentionPeriod === ''
    ? 0
    : Number(payload.backupRetentionPeriod);
  if (!region || !dbInstanceIdentifier || !dbInstanceClass || !engine || !masterUsername || !masterUserPassword || !Number.isFinite(allocatedStorage) || allocatedStorage < 20) {
    const error = new Error('Region, DB identifier, class, engine, admin username/password, and storage of at least 20 GB are required.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(backupRetentionPeriod) || backupRetentionPeriod < 0 || backupRetentionPeriod > 35) {
    const error = new Error('Backup retention must be between 0 and 35 days.');
    error.statusCode = 400;
    throw error;
  }
  if (payload.multiAz === true && backupRetentionPeriod < 1) {
    const error = new Error('Multi-AZ RDS instances require automated backup retention of at least 1 day.');
    error.statusCode = 400;
    throw error;
  }
  const securityGroupIds = Array.isArray(payload.vpcSecurityGroupIds) ? payload.vpcSecurityGroupIds.filter(Boolean) : [];
  const params = {
    DBInstanceIdentifier: dbInstanceIdentifier,
    DBInstanceClass: dbInstanceClass,
    Engine: engine,
    EngineVersion: payload.engineVersion || '',
    AllocatedStorage: Math.round(allocatedStorage),
    MasterUsername: masterUsername,
    MasterUserPassword: masterUserPassword,
    DBName: payload.dbName || '',
    StorageType: payload.storageType || 'gp3',
    DBSubnetGroupName: payload.dbSubnetGroupName || '',
    PubliclyAccessible: payload.publiclyAccessible === true ? 'true' : 'false',
    BackupRetentionPeriod: backupRetentionPeriod,
    MultiAZ: payload.multiAz === true ? 'true' : '',
  };
  securityGroupIds.forEach((groupId, index) => {
    params[`VpcSecurityGroupIds.VpcSecurityGroupId.${index + 1}`] = groupId;
  });
  await awsQueryOrThrow(connector, {
    service: 'rds',
    region,
    action: 'CreateDBInstance',
    version: '2014-10-31',
    params,
    timeoutMs: 20000,
  });
  return {
    message: 'AWS RDS DB instance creation requested.',
    database: await describeAwsRdsInstance(connector, { region, dbInstanceIdentifier }).catch(() => ({
      id: dbInstanceIdentifier,
      name: dbInstanceIdentifier,
      status: 'creating',
      region,
      shape: dbInstanceClass,
      engine,
      dbVersion: payload.engineVersion || '',
      storageSizeGb: String(Math.round(allocatedStorage)),
      storageType: payload.storageType || 'gp3',
      providerType: 'rdsDatabase',
      resourceType: 'rdsDatabase',
    })),
  };
}

export async function runAwsRdsInstanceAction(connector, { region, dbInstanceIdentifier, action }) {
  if (!region || !dbInstanceIdentifier) {
    const error = new Error('Region and DB instance identifier are required.');
    error.statusCode = 400;
    throw error;
  }
  const actions = {
    start: 'StartDBInstance',
    stop: 'StopDBInstance',
  };
  const awsAction = actions[String(action || '').toLowerCase()];
  if (!awsAction) {
    const error = new Error('Unsupported AWS RDS action.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    service: 'rds',
    region,
    action: awsAction,
    version: '2014-10-31',
    params: { DBInstanceIdentifier: dbInstanceIdentifier },
  });
  return {
    message: `AWS RDS ${action} request submitted.`,
    database: await describeAwsRdsInstance(connector, { region, dbInstanceIdentifier }).catch(() => ({
      id: dbInstanceIdentifier,
      name: dbInstanceIdentifier,
      region,
      status: action === 'start' ? 'starting' : 'stopping',
      providerType: 'rdsDatabase',
      resourceType: 'rdsDatabase',
    })),
  };
}

export async function createAwsRdsSnapshot(connector, { region, dbInstanceIdentifier, snapshotIdentifier }) {
  if (!region || !dbInstanceIdentifier || !snapshotIdentifier) {
    const error = new Error('Region, DB instance identifier, and snapshot identifier are required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    service: 'rds',
    region,
    action: 'CreateDBSnapshot',
    version: '2014-10-31',
    params: {
      DBInstanceIdentifier: dbInstanceIdentifier,
      DBSnapshotIdentifier: snapshotIdentifier,
    },
  });
  const snapshotXml = itemsFromSection(xml, 'DBSnapshot')[0] || section(xml, 'DBSnapshot') || xml;
  const snapshot = typeof snapshotXml === 'string' ? mapRdsSnapshot(snapshotXml, region) : null;
  return {
    message: 'AWS RDS snapshot creation requested.',
    snapshot: snapshot?.id ? snapshot : {
      id: snapshotIdentifier,
      name: snapshotIdentifier,
      status: 'creating',
      region,
      dbInstanceId: dbInstanceIdentifier,
      providerType: 'rdsSnapshot',
      resourceType: 'rdsSnapshot',
    },
  };
}

export async function deleteAwsRdsSnapshot(connector, { region, snapshotIdentifier }) {
  if (!region || !snapshotIdentifier) {
    const error = new Error('Region and RDS snapshot identifier are required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    service: 'rds',
    region,
    action: 'DeleteDBSnapshot',
    version: '2014-10-31',
    params: {
      DBSnapshotIdentifier: snapshotIdentifier,
    },
  });
  const snapshotXml = itemsFromSection(xml, 'DBSnapshot')[0] || section(xml, 'DBSnapshot') || xml;
  const snapshot = typeof snapshotXml === 'string' ? mapRdsSnapshot(snapshotXml, region) : null;
  return {
    message: 'AWS RDS snapshot deletion requested.',
    snapshot: snapshot?.id ? snapshot : {
      id: snapshotIdentifier,
      name: snapshotIdentifier,
      status: 'deleting',
      region,
      providerType: 'rdsSnapshot',
      resourceType: 'rdsSnapshot',
    },
  };
}

export async function restoreAwsRdsInstanceFromSnapshot(connector, payload = {}) {
  const region = String(payload.region || '').trim();
  const dbInstanceIdentifier = String(payload.dbInstanceIdentifier || '').trim();
  const snapshotIdentifier = String(payload.snapshotIdentifier || '').trim();
  if (!region || !dbInstanceIdentifier || !snapshotIdentifier) {
    const error = new Error('Region, new DB instance identifier, and snapshot identifier are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    service: 'rds',
    region,
    action: 'RestoreDBInstanceFromDBSnapshot',
    version: '2014-10-31',
    params: {
      DBInstanceIdentifier: dbInstanceIdentifier,
      DBSnapshotIdentifier: snapshotIdentifier,
      DBInstanceClass: payload.dbInstanceClass || '',
      DBSubnetGroupName: payload.dbSubnetGroupName || '',
      PubliclyAccessible: payload.publiclyAccessible === true ? 'true' : '',
    },
    timeoutMs: 20000,
  });
  return {
    message: 'AWS RDS restore from snapshot requested.',
    database: await describeAwsRdsInstance(connector, { region, dbInstanceIdentifier }).catch(() => ({
      id: dbInstanceIdentifier,
      name: dbInstanceIdentifier,
      status: 'creating',
      region,
      snapshotId: snapshotIdentifier,
      providerType: 'rdsDatabase',
      resourceType: 'rdsDatabase',
    })),
  };
}

export async function deleteAwsRdsInstance(connector, { region, dbInstanceIdentifier, skipFinalSnapshot = true, finalSnapshotIdentifier = '' }) {
  if (!region || !dbInstanceIdentifier) {
    const error = new Error('Region and DB instance identifier are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    service: 'rds',
    region,
    action: 'DeleteDBInstance',
    version: '2014-10-31',
    params: {
      DBInstanceIdentifier: dbInstanceIdentifier,
      SkipFinalSnapshot: skipFinalSnapshot ? 'true' : 'false',
      FinalDBSnapshotIdentifier: skipFinalSnapshot ? '' : finalSnapshotIdentifier,
    },
  });
  return {
    message: 'AWS RDS DB instance deletion requested.',
    database: {
      id: dbInstanceIdentifier,
      name: dbInstanceIdentifier,
      region,
      status: 'deleting',
      providerType: 'rdsDatabase',
      resourceType: 'rdsDatabase',
    },
  };
}

export async function describeAwsSnapshot(connector, { region, snapshotId }) {
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'DescribeSnapshots',
    params: { 'SnapshotId.1': snapshotId },
  });
  const snapshotXml = itemsFromSection(xml, 'snapshotSet')[0];
  if (!snapshotXml) {
    const error = new Error('AWS snapshot was not found.');
    error.statusCode = 404;
    throw error;
  }
  return mapSnapshot(snapshotXml, region);
}

export async function runAwsInstanceAction(connector, { region, instanceId, action }) {
  const actions = {
    start: 'StartInstances',
    stop: 'StopInstances',
    reboot: 'RebootInstances',
    terminate: 'TerminateInstances',
  };
  const awsAction = actions[String(action || '').toLowerCase()];
  if (!awsAction) {
    const error = new Error('Unsupported AWS instance action.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: awsAction,
    params: { 'InstanceId.1': instanceId },
  });
  return {
    message: `AWS ${action} request submitted.`,
    instance: await describeAwsInstance(connector, { region, instanceId }).catch(() => ({
      id: instanceId,
      name: instanceId,
      region,
      status: action === 'start' ? 'pending' : action === 'terminate' ? 'shutting-down' : action === 'stop' ? 'stopping' : 'rebooting',
      providerType: 'ec2Instance',
      resourceType: 'ec2Instance',
    })),
  };
}

export async function createAwsInstance(connector, payload = {}) {
  const region = String(payload.region || '').trim();
  const imageId = String(payload.imageId || '').trim();
  const instanceType = String(payload.instanceType || '').trim();
  const subnetId = String(payload.subnetId || '').trim();
  if (!region || !imageId || !instanceType) {
    const error = new Error('Region, AMI ID, and instance type are required.');
    error.statusCode = 400;
    throw error;
  }

  const params = {
    ImageId: imageId,
    InstanceType: instanceType,
    MinCount: Number(payload.minCount || 1),
    MaxCount: Number(payload.maxCount || 1),
    SubnetId: subnetId,
    KeyName: String(payload.keyName || '').trim(),
  };
  const securityGroupIds = Array.isArray(payload.securityGroupIds) ? payload.securityGroupIds.filter(Boolean) : [];
  securityGroupIds.forEach((groupId, index) => {
    params[`SecurityGroupId.${index + 1}`] = groupId;
  });
  const name = String(payload.name || '').trim();
  if (name) {
    params['TagSpecification.1.ResourceType'] = 'instance';
    params['TagSpecification.1.Tag.1.Key'] = 'Name';
    params['TagSpecification.1.Tag.1.Value'] = name;
  }

  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'RunInstances',
    params,
    timeoutMs: 20000,
  });
  const instanceXml = itemsFromSection(xml, 'instancesSet')[0];
  const instance = instanceXml ? mapInstance(instanceXml, region) : null;
  return {
    message: 'AWS instance launch requested.',
    instance: instance || {
      id: tagValue(xml, 'instanceId') || name || imageId,
      name: name || tagValue(xml, 'instanceId') || 'New instance',
      status: 'pending',
      region,
      shape: instanceType,
      subnetId,
      providerType: 'ec2Instance',
      resourceType: 'ec2Instance',
    },
  };
}

function requiredNetworkScope(payload = {}) {
  const region = String(payload.region || '').trim();
  if (!region) {
    const error = new Error('Region is required.');
    error.statusCode = 400;
    throw error;
  }
  return region;
}

export async function createAwsVpc(connector, payload = {}) {
  const region = requiredNetworkScope(payload);
  const cidrBlock = String(payload.cidrBlock || '').trim();
  const name = String(payload.name || '').trim();
  if (!cidrBlock) {
    const error = new Error('VPC CIDR block is required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateVpc',
    params: withNameTag({ CidrBlock: cidrBlock }, 'vpc', name),
    timeoutMs: 20000,
  });
  const vpcXml = section(xml, 'vpc') || itemsFromSection(xml, 'vpcSet')[0] || xml;
  const vpc = mapSimpleNetwork(vpcXml, region, 'vpcId', name || 'vpc', 'vpc', (row) => ({ cidrBlock: tagValue(row, 'cidrBlock') || cidrBlock }));
  return {
    message: 'AWS VPC creation requested.',
    vpc: vpc.id ? vpc : {
      id: tagValue(xml, 'vpcId') || name || cidrBlock,
      name: name || tagValue(xml, 'vpcId') || 'New VPC',
      status: 'pending',
      region,
      cidrBlock,
      providerType: 'vpc',
      resourceType: 'vpc',
    },
  };
}

export async function deleteAwsVpc(connector, { region, vpcId } = {}) {
  if (!region || !vpcId) {
    const error = new Error('Region and VPC ID are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, { region, action: 'DeleteVpc', params: { VpcId: vpcId } });
  return {
    message: 'AWS VPC deletion requested.',
    vpc: { id: vpcId, name: vpcId, region, status: 'deleted', providerType: 'vpc', resourceType: 'vpc' },
  };
}

export async function createAwsSubnet(connector, payload = {}) {
  const region = requiredNetworkScope(payload);
  const vpcId = String(payload.vpcId || '').trim();
  const cidrBlock = String(payload.cidrBlock || '').trim();
  const availabilityZone = String(payload.availabilityZone || '').trim();
  const name = String(payload.name || '').trim();
  if (!vpcId || !cidrBlock) {
    const error = new Error('VPC ID and subnet CIDR block are required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateSubnet',
    params: withNameTag({
      VpcId: vpcId,
      CidrBlock: cidrBlock,
      AvailabilityZone: availabilityZone,
    }, 'subnet', name),
    timeoutMs: 20000,
  });
  const subnetXml = section(xml, 'subnet') || itemsFromSection(xml, 'subnetSet')[0] || xml;
  const subnet = mapSimpleNetwork(subnetXml, region, 'subnetId', name || 'subnet', 'subnet', (row) => ({
    vpcId: tagValue(row, 'vpcId') || vpcId,
    cidrBlock: tagValue(row, 'cidrBlock') || cidrBlock,
    availabilityDomain: tagValue(row, 'availabilityZone') || availabilityZone,
  }));
  return {
    message: 'AWS subnet creation requested.',
    subnet: subnet.id ? subnet : {
      id: tagValue(xml, 'subnetId') || name || cidrBlock,
      name: name || tagValue(xml, 'subnetId') || 'New subnet',
      status: 'pending',
      region,
      vpcId,
      cidrBlock,
      availabilityDomain: availabilityZone,
      providerType: 'subnet',
      resourceType: 'subnet',
    },
  };
}

export async function deleteAwsSubnet(connector, { region, subnetId } = {}) {
  if (!region || !subnetId) {
    const error = new Error('Region and subnet ID are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, { region, action: 'DeleteSubnet', params: { SubnetId: subnetId } });
  return {
    message: 'AWS subnet deletion requested.',
    subnet: { id: subnetId, name: subnetId, region, status: 'deleted', providerType: 'subnet', resourceType: 'subnet' },
  };
}

export async function createAwsRouteTable(connector, payload = {}) {
  const region = requiredNetworkScope(payload);
  const vpcId = String(payload.vpcId || '').trim();
  const name = String(payload.name || '').trim();
  if (!vpcId) {
    const error = new Error('VPC ID is required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateRouteTable',
    params: withNameTag({ VpcId: vpcId }, 'route-table', name),
  });
  const routeTableXml = section(xml, 'routeTable') || itemsFromSection(xml, 'routeTableSet')[0] || xml;
  const routeTable = mapSimpleNetwork(routeTableXml, region, 'routeTableId', name || 'route-table', 'routeTable', (row) => ({ vpcId: tagValue(row, 'vpcId') || vpcId, associations: routeTableAssociationsFromXml(row), routes: routeRowsFromXml(row) }));
  return {
    message: 'AWS route table creation requested.',
    routeTable: routeTable.id ? routeTable : {
      id: tagValue(xml, 'routeTableId') || name || vpcId,
      name: name || tagValue(xml, 'routeTableId') || 'New route table',
      status: 'available',
      region,
      vpcId,
      providerType: 'routeTable',
      resourceType: 'routeTable',
    },
  };
}

export async function deleteAwsRouteTable(connector, { region, routeTableId } = {}) {
  if (!region || !routeTableId) {
    const error = new Error('Region and route table ID are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, { region, action: 'DeleteRouteTable', params: { RouteTableId: routeTableId } });
  return {
    message: 'AWS route table deletion requested.',
    routeTable: { id: routeTableId, name: routeTableId, region, status: 'deleted', providerType: 'routeTable', resourceType: 'routeTable' },
  };
}

export async function createAwsInternetGateway(connector, payload = {}) {
  const region = requiredNetworkScope(payload);
  const name = String(payload.name || '').trim();
  const vpcId = String(payload.vpcId || '').trim();
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateInternetGateway',
    params: withNameTag({}, 'internet-gateway', name),
  });
  const internetGatewayId = tagValue(xml, 'internetGatewayId');
  if (vpcId && internetGatewayId) {
    await awsQueryOrThrow(connector, {
      region,
      action: 'AttachInternetGateway',
      params: { InternetGatewayId: internetGatewayId, VpcId: vpcId },
    });
  }
  return {
    message: vpcId ? 'AWS internet gateway created and attached.' : 'AWS internet gateway creation requested.',
    internetGateway: {
      id: internetGatewayId || name || 'internet-gateway',
      name: name || internetGatewayId || 'New internet gateway',
      status: vpcId ? 'attached' : 'available',
      region,
      vpcId,
      providerType: 'internetGateway',
      resourceType: 'internetGateway',
    },
  };
}

export async function deleteAwsInternetGateway(connector, { region, internetGatewayId, vpcId } = {}) {
  if (!region || !internetGatewayId) {
    const error = new Error('Region and internet gateway ID are required.');
    error.statusCode = 400;
    throw error;
  }
  if (vpcId) {
    await awsQueryOrThrow(connector, {
      region,
      action: 'DetachInternetGateway',
      params: { InternetGatewayId: internetGatewayId, VpcId: vpcId },
    });
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'DeleteInternetGateway',
    params: { InternetGatewayId: internetGatewayId },
  });
  return {
    message: 'AWS internet gateway deletion requested.',
    internetGateway: { id: internetGatewayId, name: internetGatewayId, region, vpcId, status: 'deleted', providerType: 'internetGateway', resourceType: 'internetGateway' },
  };
}

export async function createAwsNatGateway(connector, payload = {}) {
  const region = requiredNetworkScope(payload);
  const subnetId = String(payload.subnetId || '').trim();
  const allocationId = String(payload.allocationId || '').trim();
  const name = String(payload.name || '').trim();
  if (!subnetId || !allocationId) {
    const error = new Error('Subnet ID and Elastic IP allocation ID are required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateNatGateway',
    params: withNameTag({ SubnetId: subnetId, AllocationId: allocationId }, 'natgateway', name),
    timeoutMs: 20000,
  });
  const natGatewayId = tagValue(xml, 'natGatewayId');
  return {
    message: 'AWS NAT gateway creation requested.',
    natGateway: {
      id: natGatewayId || name || subnetId,
      name: name || natGatewayId || 'New NAT gateway',
      status: tagValue(xml, 'state') || 'pending',
      region,
      subnetId,
      vpcId: tagValue(xml, 'vpcId'),
      allocationId,
      providerType: 'natGateway',
      resourceType: 'natGateway',
    },
  };
}

export async function deleteAwsNatGateway(connector, { region, natGatewayId } = {}) {
  if (!region || !natGatewayId) {
    const error = new Error('Region and NAT gateway ID are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'DeleteNatGateway',
    params: { NatGatewayId: natGatewayId },
  });
  return {
    message: 'AWS NAT gateway deletion requested.',
    natGateway: { id: natGatewayId, name: natGatewayId, region, status: 'deleting', providerType: 'natGateway', resourceType: 'natGateway' },
  };
}

export async function updateAwsSecurityGroupRule(connector, payload = {}) {
  const region = requiredNetworkScope(payload);
  const groupId = String(payload.groupId || '').trim();
  const operation = String(payload.operation || '').toLowerCase();
  const direction = String(payload.direction || 'ingress').toLowerCase();
  const protocol = String(payload.protocol || 'tcp').trim();
  const cidrIp = String(payload.cidrIp || '').trim();
  const sourceGroupId = String(payload.sourceGroupId || '').trim();
  if (!groupId || !['authorize', 'revoke'].includes(operation) || !['ingress', 'egress'].includes(direction) || !protocol || (!cidrIp && !sourceGroupId)) {
    const error = new Error('Security group, operation, direction, protocol, and source are required.');
    error.statusCode = 400;
    throw error;
  }
  const action = `${operation === 'authorize' ? 'Authorize' : 'Revoke'}SecurityGroup${direction === 'egress' ? 'Egress' : 'Ingress'}`;
  const params = {
    GroupId: groupId,
    'IpPermissions.1.IpProtocol': protocol,
    'IpPermissions.1.FromPort': protocol === '-1' ? '' : payload.fromPort,
    'IpPermissions.1.ToPort': protocol === '-1' ? '' : payload.toPort,
    'IpPermissions.1.IpRanges.1.CidrIp': cidrIp,
    'IpPermissions.1.UserIdGroupPairs.1.GroupId': sourceGroupId,
    'IpPermissions.1.IpRanges.1.Description': String(payload.description || '').trim(),
  };
  await awsQueryOrThrow(connector, { region, action, params });
  return {
    message: `AWS security group rule ${operation === 'authorize' ? 'added' : 'removed'}.`,
    securityGroup: {
      id: groupId,
      name: groupId,
      region,
      status: 'updated',
      providerType: 'securityGroup',
      resourceType: 'securityGroup',
    },
  };
}

export async function listAwsImages(connector, { region, search = '', maxResults = 80 } = {}) {
  const normalizedRegion = String(region || '').trim();
  if (!normalizedRegion) {
    const error = new Error('Region is required.');
    error.statusCode = 400;
    throw error;
  }

  const query = String(search || '').trim();
  const params = {
    'Owner.1': 'amazon',
    'Owner.2': 'self',
    'Owner.3': '099720109477',
    'Filter.1.Name': 'state',
    'Filter.1.Value.1': 'available',
    'Filter.2.Name': 'root-device-type',
    'Filter.2.Value.1': 'ebs',
    'Filter.3.Name': 'virtualization-type',
    'Filter.3.Value.1': 'hvm',
    'Filter.4.Name': 'architecture',
    'Filter.4.Value.1': 'x86_64',
  };

  if (query) {
    params['Filter.5.Name'] = 'name';
    params['Filter.5.Value.1'] = `*${query}*`;
  } else {
    params['Filter.5.Name'] = 'name';
    params['Filter.5.Value.1'] = 'al2023-ami-2023*-x86_64';
    params['Filter.5.Value.2'] = 'amzn2-ami-hvm-*-x86_64-gp2';
    params['Filter.5.Value.3'] = 'ubuntu/images/hvm-ssd/ubuntu-*-amd64-server-*';
    params['Filter.5.Value.4'] = 'Windows_Server-2022-English-Full-Base-*';
  }

  const xml = await awsQueryOrThrow(connector, {
    region: normalizedRegion,
    action: 'DescribeImages',
    params,
    timeoutMs: 20000,
  });
  const images = itemsFromSection(xml, 'imagesSet')
    .map((item) => mapImage(item, normalizedRegion))
    .filter((image) => image.id)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, Math.max(1, Math.min(Number(maxResults) || 80, 200)));

  return {
    generatedAt: new Date().toISOString(),
    region: normalizedRegion,
    images,
  };
}

export async function listAwsKeyPairs(connector, { region } = {}) {
  const normalizedRegion = String(region || '').trim();
  if (!normalizedRegion) {
    const error = new Error('Region is required.');
    error.statusCode = 400;
    throw error;
  }

  const xml = await awsQueryOrThrow(connector, {
    region: normalizedRegion,
    action: 'DescribeKeyPairs',
    timeoutMs: 12000,
  });

  return {
    generatedAt: new Date().toISOString(),
    region: normalizedRegion,
    keyPairs: itemsFromSection(xml, 'keySet')
      .map((item) => mapKeyPair(item, normalizedRegion))
      .filter((keyPair) => keyPair.name)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function createAwsKeyPair(connector, { region, name } = {}) {
  const normalizedRegion = String(region || '').trim();
  const keyName = String(name || '').trim();
  if (!normalizedRegion || !keyName) {
    const error = new Error('Region and key pair name are required.');
    error.statusCode = 400;
    throw error;
  }

  const xml = await awsQueryOrThrow(connector, {
    region: normalizedRegion,
    action: 'CreateKeyPair',
    params: { KeyName: keyName },
    timeoutMs: 12000,
  });

  return {
    message: 'AWS key pair created. Save the private key now; it cannot be retrieved again.',
    keyPair: {
      id: tagValue(xml, 'keyPairId') || keyName,
      name: tagValue(xml, 'keyName') || keyName,
      fingerprint: tagValue(xml, 'keyFingerprint'),
      region: normalizedRegion,
      providerType: 'keyPair',
      resourceType: 'keyPair',
    },
    privateKeyMaterial: tagValue(xml, 'keyMaterial'),
  };
}

export async function createAwsImage(connector, { region, instanceId, name, description, noReboot = false }) {
  if (!region || !instanceId || !name) {
    const error = new Error('Region, instance ID, and image name are required.');
    error.statusCode = 400;
    throw error;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateImage',
    params: {
      InstanceId: instanceId,
      Name: name,
      Description: description || '',
      NoReboot: noReboot ? 'true' : 'false',
    },
  });
  return {
    message: 'AWS AMI creation requested.',
    imageId: tagValue(xml, 'imageId'),
  };
}

export async function changeAwsInstanceType(connector, { region, instanceId, instanceType }) {
  if (!region || !instanceId || !instanceType) {
    const error = new Error('Region, instance ID, and instance type are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'ModifyInstanceAttribute',
    params: {
      InstanceId: instanceId,
      'InstanceType.Value': instanceType,
    },
  });
  return {
    message: 'AWS instance type change requested.',
    instance: await describeAwsInstance(connector, { region, instanceId }).catch(() => ({
      id: instanceId,
      name: instanceId,
      region,
      shape: instanceType,
      providerType: 'ec2Instance',
      resourceType: 'ec2Instance',
    })),
  };
}

export async function attachAwsVolume(connector, { region, instanceId, volumeId, device }) {
  if (!region || !instanceId || !volumeId || !device) {
    const error = new Error('Region, instance ID, volume ID, and device are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'AttachVolume',
    params: {
      InstanceId: instanceId,
      VolumeId: volumeId,
      Device: device,
    },
  });
  return {
    message: 'AWS volume attach requested.',
    volume: await describeAwsVolume(connector, { region, volumeId }).catch(() => ({
      id: volumeId,
      name: volumeId,
      region,
      status: 'attaching',
      attachedInstanceId: instanceId,
      device,
      providerType: 'ebsVolume',
      resourceType: 'ebsVolume',
    })),
  };
}

export async function detachAwsVolume(connector, { region, instanceId, volumeId, device, force = false }) {
  if (!region || !volumeId) {
    const error = new Error('Region and volume ID are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'DetachVolume',
    params: {
      VolumeId: volumeId,
      InstanceId: instanceId || '',
      Device: device || '',
      Force: force ? 'true' : '',
    },
  });
  return {
    message: 'AWS volume detach requested.',
    volume: await describeAwsVolume(connector, { region, volumeId }).catch(() => ({
      id: volumeId,
      name: volumeId,
      region,
      status: 'detaching',
      attachedInstanceId: '',
      device: '',
      providerType: 'ebsVolume',
      resourceType: 'ebsVolume',
    })),
  };
}

export async function createAwsVolume(connector, payload = {}) {
  const region = String(payload.region || '').trim();
  const availabilityZone = String(payload.availabilityZone || '').trim();
  const size = Number(payload.sizeGb || payload.size || 0);
  const snapshotId = String(payload.snapshotId || '').trim();
  const volumeType = String(payload.volumeType || 'gp3').trim();
  const name = String(payload.name || '').trim();
  if (!region || !availabilityZone || (!snapshotId && (!Number.isFinite(size) || size < 1))) {
    const error = new Error('Region, availability zone, and size or snapshot are required.');
    error.statusCode = 400;
    throw error;
  }
  const params = {
    AvailabilityZone: availabilityZone,
    VolumeType: volumeType,
    Size: snapshotId ? '' : Math.round(size),
    SnapshotId: snapshotId,
  };
  if (name) {
    params['TagSpecification.1.ResourceType'] = 'volume';
    params['TagSpecification.1.Tag.1.Key'] = 'Name';
    params['TagSpecification.1.Tag.1.Value'] = name;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateVolume',
    params,
    timeoutMs: 20000,
  });
  const volumeXml = itemsFromSection(xml, 'volumeSet')[0] || xml;
  const volume = mapVolume(volumeXml, region);
  return {
    message: snapshotId ? 'AWS volume restore from snapshot requested.' : 'AWS EBS volume creation requested.',
    volume: volume.id ? volume : {
      id: tagValue(xml, 'volumeId') || name,
      name: name || tagValue(xml, 'volumeId') || 'New EBS volume',
      region,
      availabilityDomain: availabilityZone,
      sizeGb: snapshotId ? '' : String(Math.round(size)),
      type: volumeType,
      status: 'creating',
      providerType: 'ebsVolume',
      resourceType: 'ebsVolume',
    },
  };
}

export async function resizeAwsVolume(connector, { region, volumeId, sizeGb }) {
  const size = Number(sizeGb || 0);
  if (!region || !volumeId || !Number.isFinite(size) || size < 1) {
    const error = new Error('Region, volume ID, and valid size are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'ModifyVolume',
    params: { VolumeId: volumeId, Size: Math.round(size) },
  });
  return {
    message: 'AWS EBS volume resize requested.',
    volume: await describeAwsVolume(connector, { region, volumeId }).catch(() => ({
      id: volumeId,
      name: volumeId,
      region,
      sizeGb: String(Math.round(size)),
      status: 'modifying',
      providerType: 'ebsVolume',
      resourceType: 'ebsVolume',
    })),
  };
}

export async function deleteAwsVolume(connector, { region, volumeId }) {
  if (!region || !volumeId) {
    const error = new Error('Region and volume ID are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'DeleteVolume',
    params: { VolumeId: volumeId },
  });
  return {
    message: 'AWS EBS volume deletion requested.',
    volume: {
      id: volumeId,
      name: volumeId,
      region,
      status: 'deleting',
      providerType: 'ebsVolume',
      resourceType: 'ebsVolume',
    },
  };
}

export async function createAwsSnapshot(connector, { region, volumeId, description, name }) {
  if (!region || !volumeId) {
    const error = new Error('Region and volume ID are required.');
    error.statusCode = 400;
    throw error;
  }
  const params = {
    VolumeId: volumeId,
    Description: description || '',
  };
  if (name) {
    params['TagSpecification.1.ResourceType'] = 'snapshot';
    params['TagSpecification.1.Tag.1.Key'] = 'Name';
    params['TagSpecification.1.Tag.1.Value'] = name;
  }
  const xml = await awsQueryOrThrow(connector, {
    region,
    action: 'CreateSnapshot',
    params,
  });
  const snapshotXml = itemsFromSection(xml, 'snapshotSet')[0] || xml;
  const snapshot = mapSnapshot(snapshotXml, region);
  return {
    message: 'AWS EBS snapshot creation requested.',
    snapshot: snapshot.id ? snapshot : {
      id: tagValue(xml, 'snapshotId') || volumeId,
      name: name || tagValue(xml, 'snapshotId') || 'New snapshot',
      region,
      volumeId,
      status: 'pending',
      providerType: 'ebsSnapshot',
      resourceType: 'ebsSnapshot',
    },
  };
}

export async function deleteAwsSnapshot(connector, { region, snapshotId }) {
  if (!region || !snapshotId) {
    const error = new Error('Region and snapshot ID are required.');
    error.statusCode = 400;
    throw error;
  }
  await awsQueryOrThrow(connector, {
    region,
    action: 'DeleteSnapshot',
    params: { SnapshotId: snapshotId },
  });
  return {
    message: 'AWS EBS snapshot deleted.',
    snapshot: {
      id: snapshotId,
      name: snapshotId,
      region,
      status: 'deleted',
      providerType: 'ebsSnapshot',
      resourceType: 'ebsSnapshot',
    },
  };
}

async function requestS3OrThrow(connector, { region, method, path, body = '', headers = {}, timeoutMs = 12000 }) {
  const response = await requestAws({
    connector,
    service: 's3',
    region: region || AWS_GLOBAL_REGION,
    method,
    path,
    body,
    headers,
    timeoutMs,
  });
  if (!response.ok) {
    const error = new Error(response.message || 'AWS S3 request failed.');
    error.statusCode = response.statusCode || 502;
    throw error;
  }
  return response;
}

function mapS3Object(xml, bucketName, region) {
  const key = tagValue(xml, 'Key');
  return {
    id: `${bucketName}/${key}`,
    name: key,
    key,
    bucketName,
    region,
    status: tagValue(xml, 'StorageClass') || 'STANDARD',
    sizeBytes: tagValue(xml, 'Size'),
    eTag: tagValue(xml, 'ETag').replace(/^"|"$/g, ''),
    lastModified: tagValue(xml, 'LastModified'),
    providerType: 's3Object',
    resourceType: 's3Object',
  };
}

export async function getAwsBucketMetadata(connector, { bucketName, region = AWS_GLOBAL_REGION } = {}) {
  const bucket = String(bucketName || '').trim();
  if (!bucket) {
    return {};
  }
  let bucketRegion = region || AWS_GLOBAL_REGION;
  const location = await requestS3OrThrow(connector, {
    region: AWS_GLOBAL_REGION,
    method: 'GET',
    path: `/${encodeURIComponent(bucket)}?location=`,
  }).catch(() => null);
  if (location?.body) {
    const locationConstraint = tagValue(location.body, 'LocationConstraint');
    bucketRegion = locationConstraint === 'EU' ? 'eu-west-1' : (locationConstraint || AWS_GLOBAL_REGION);
  }
  const publicAccess = await requestS3OrThrow(connector, {
    region: bucketRegion,
    method: 'GET',
    path: `/${encodeURIComponent(bucket)}?publicAccessBlock=`,
  }).catch(() => null);
  const versioning = await requestS3OrThrow(connector, {
    region: bucketRegion,
    method: 'GET',
    path: `/${encodeURIComponent(bucket)}?versioning=`,
  }).catch(() => null);
  const blockPublicAcls = tagValue(publicAccess?.body || '', 'BlockPublicAcls');
  const ignorePublicAcls = tagValue(publicAccess?.body || '', 'IgnorePublicAcls');
  const blockPublicPolicy = tagValue(publicAccess?.body || '', 'BlockPublicPolicy');
  const restrictPublicBuckets = tagValue(publicAccess?.body || '', 'RestrictPublicBuckets');
  const allBlocked = [blockPublicAcls, ignorePublicAcls, blockPublicPolicy, restrictPublicBuckets].every((value) => value === 'true');
  return {
    region: bucketRegion,
    publicAccessStatus: publicAccess ? (allBlocked ? 'Blocked' : 'Review') : 'Unknown',
    versioning: tagValue(versioning?.body || '', 'Status') || 'Suspended',
  };
}

export async function createAwsBucket(connector, { region, bucketName }) {
  const normalizedRegion = String(region || AWS_GLOBAL_REGION).trim();
  const bucket = String(bucketName || '').trim();
  if (!bucket) {
    const error = new Error('Bucket name is required.');
    error.statusCode = 400;
    throw error;
  }
  const body = normalizedRegion === AWS_GLOBAL_REGION
    ? ''
    : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${normalizedRegion}</LocationConstraint></CreateBucketConfiguration>`;
  await requestS3OrThrow(connector, {
    region: normalizedRegion,
    method: 'PUT',
    path: `/${encodeURIComponent(bucket)}`,
    body,
    headers: body ? { 'Content-Type': 'application/xml' } : {},
  });
  return {
    message: 'AWS S3 bucket created.',
    bucket: {
      id: bucket,
      name: bucket,
      status: 'available',
      region: normalizedRegion,
      publicAccessStatus: 'Unknown',
      versioning: 'Suspended',
      providerType: 's3Bucket',
      resourceType: 's3Bucket',
    },
  };
}

export async function deleteAwsBucket(connector, { region, bucketName }) {
  const bucket = String(bucketName || '').trim();
  if (!bucket) {
    const error = new Error('Bucket name is required.');
    error.statusCode = 400;
    throw error;
  }
  await requestS3OrThrow(connector, {
    region: region || AWS_GLOBAL_REGION,
    method: 'DELETE',
    path: `/${encodeURIComponent(bucket)}`,
  });
  return {
    message: 'AWS S3 bucket deleted.',
    bucket: {
      id: bucket,
      name: bucket,
      status: 'deleted',
      region: region || AWS_GLOBAL_REGION,
      providerType: 's3Bucket',
      resourceType: 's3Bucket',
    },
  };
}

export async function updateAwsBucketVersioning(connector, { region, bucketName, enabled }) {
  const bucket = String(bucketName || '').trim();
  if (!bucket) {
    const error = new Error('Bucket name is required.');
    error.statusCode = 400;
    throw error;
  }
  const status = enabled ? 'Enabled' : 'Suspended';
  const body = `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`;
  await requestS3OrThrow(connector, {
    region: region || AWS_GLOBAL_REGION,
    method: 'PUT',
    path: `/${encodeURIComponent(bucket)}?versioning=`,
    body,
    headers: { 'Content-Type': 'application/xml' },
  });
  return {
    message: `AWS S3 bucket versioning ${enabled ? 'enabled' : 'disabled'}.`,
    bucket: {
      id: bucket,
      name: bucket,
      status: 'available',
      region: region || AWS_GLOBAL_REGION,
      versioning: status,
      providerType: 's3Bucket',
      resourceType: 's3Bucket',
    },
  };
}

export async function listAwsBucketObjects(connector, { region, bucketName, prefix = '', maxKeys = 100 } = {}) {
  const bucket = String(bucketName || '').trim();
  if (!bucket) {
    const error = new Error('Bucket name is required.');
    error.statusCode = 400;
    throw error;
  }
  const params = new URLSearchParams({
    'list-type': '2',
    'max-keys': String(Math.max(1, Math.min(Number(maxKeys) || 100, 1000))),
  });
  if (String(prefix || '').trim()) {
    params.set('prefix', String(prefix).trim());
  }
  const response = await requestS3OrThrow(connector, {
    region: region || AWS_GLOBAL_REGION,
    method: 'GET',
    path: `/${encodeURIComponent(bucket)}?${params.toString()}`,
    timeoutMs: 20000,
  });
  return {
    generatedAt: new Date().toISOString(),
    bucketName: bucket,
    region: region || AWS_GLOBAL_REGION,
    prefix: String(prefix || ''),
    objects: tagBlocks(response.body, 'Contents').map((item) => mapS3Object(item, bucket, region || AWS_GLOBAL_REGION)),
  };
}

export async function getAwsBucketObject(connector, { region, bucketName, key } = {}) {
  const bucket = String(bucketName || '').trim();
  const objectKey = String(key || '').trim();
  if (!bucket || !objectKey) {
    const error = new Error('Bucket name and object key are required.');
    error.statusCode = 400;
    throw error;
  }
  const response = await requestS3OrThrow(connector, {
    region: region || AWS_GLOBAL_REGION,
    method: 'GET',
    path: `/${encodeURIComponent(bucket)}/${encodeS3Key(objectKey)}`,
    timeoutMs: 20000,
  });
  return {
    generatedAt: new Date().toISOString(),
    bucketName: bucket,
    region: region || AWS_GLOBAL_REGION,
    object: {
      id: `${bucket}/${objectKey}`,
      name: objectKey,
      key: objectKey,
      bucketName: bucket,
      region: region || AWS_GLOBAL_REGION,
      contentType: response.headers?.['content-type'] || 'application/octet-stream',
      sizeBytes: response.headers?.['content-length'] || String(response.body.length),
      eTag: String(response.headers?.etag || '').replace(/^"|"$/g, ''),
      content: response.body,
      providerType: 's3Object',
      resourceType: 's3Object',
    },
  };
}

export async function putAwsBucketObject(connector, { region, bucketName, key, content = '', contentType = 'text/plain' } = {}) {
  const bucket = String(bucketName || '').trim();
  const objectKey = String(key || '').trim();
  if (!bucket || !objectKey) {
    const error = new Error('Bucket name and object key are required.');
    error.statusCode = 400;
    throw error;
  }
  await requestS3OrThrow(connector, {
    region: region || AWS_GLOBAL_REGION,
    method: 'PUT',
    path: `/${encodeURIComponent(bucket)}/${encodeS3Key(objectKey)}`,
    body: String(content || ''),
    headers: { 'Content-Type': contentType || 'text/plain' },
    timeoutMs: 20000,
  });
  return {
    message: 'AWS S3 object saved.',
    object: {
      id: `${bucket}/${objectKey}`,
      name: objectKey,
      key: objectKey,
      bucketName: bucket,
      region: region || AWS_GLOBAL_REGION,
      contentType: contentType || 'text/plain',
      sizeBytes: String(content || '').length,
      providerType: 's3Object',
      resourceType: 's3Object',
    },
  };
}

export async function deleteAwsBucketObject(connector, { region, bucketName, key } = {}) {
  const bucket = String(bucketName || '').trim();
  const objectKey = String(key || '').trim();
  if (!bucket || !objectKey) {
    const error = new Error('Bucket name and object key are required.');
    error.statusCode = 400;
    throw error;
  }
  await requestS3OrThrow(connector, {
    region: region || AWS_GLOBAL_REGION,
    method: 'DELETE',
    path: `/${encodeURIComponent(bucket)}/${encodeS3Key(objectKey)}`,
    timeoutMs: 20000,
  });
  return {
    message: 'AWS S3 object deleted.',
    object: {
      id: `${bucket}/${objectKey}`,
      name: objectKey,
      key: objectKey,
      bucketName: bucket,
      region: region || AWS_GLOBAL_REGION,
      providerType: 's3Object',
      resourceType: 's3Object',
    },
  };
}
