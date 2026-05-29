import { getCachedOciInventoryFromResources } from './ociInventoryCache.js';

const RESOURCE_LIMIT = 260;

const graphTypes = {
  instance: { label: 'VM', group: 'compute' },
  bootVolume: { label: 'Boot Volume', group: 'storage' },
  blockVolume: { label: 'Block Volume', group: 'storage' },
  subnet: { label: 'Subnet', group: 'network' },
  vcn: { label: 'VCN', group: 'network' },
  routeTable: { label: 'Route Table', group: 'network' },
  internetGateway: { label: 'Internet Gateway', group: 'gateway' },
  natGateway: { label: 'NAT Gateway', group: 'gateway' },
  serviceGateway: { label: 'Service Gateway', group: 'gateway' },
  drgAttachment: { label: 'DRG Attachment', group: 'gateway' },
  dbSystem: { label: 'DB System', group: 'database' },
  autonomousDatabase: { label: 'Autonomous DB', group: 'database' },
  autonomousContainerDatabase: { label: 'Autonomous Container DB', group: 'database' },
  exadataInfrastructure: { label: 'Exadata', group: 'database' },
  blockVolumeBackup: { label: 'Block Volume Backup', group: 'backup' },
  bootVolumeBackup: { label: 'Boot Volume Backup', group: 'backup' },
  databaseBackup: { label: 'Database Backup', group: 'backup' },
};

function asString(value) {
  return String(value || '').trim();
}

function nodeKey(type, id) {
  return `${type}:${id}`;
}

function collectionRows(inventory = {}) {
  return [
    ['instance', inventory.instances || []],
    ['bootVolume', inventory.bootVolumes || []],
    ['blockVolume', inventory.blockVolumes || []],
    ['subnet', inventory.subnets || []],
    ['vcn', inventory.vcns || []],
    ['routeTable', inventory.routeTables || []],
    ['internetGateway', inventory.internetGateways || []],
    ['natGateway', inventory.natGateways || []],
    ['serviceGateway', inventory.serviceGateways || []],
    ['drgAttachment', inventory.drgAttachments || []],
    ['dbSystem', inventory.dbSystems || []],
    ['autonomousDatabase', inventory.autonomousDatabases || []],
    ['autonomousContainerDatabase', inventory.autonomousContainerDatabases || []],
    ['exadataInfrastructure', inventory.exadataInfrastructures || []],
    ['blockVolumeBackup', inventory.blockVolumeBackups || []],
    ['bootVolumeBackup', inventory.bootVolumeBackups || []],
    ['databaseBackup', inventory.databaseBackups || []],
  ];
}

function createNode(type, resource) {
  const id = asString(resource.id || resource.name);
  if (!id) {
    return null;
  }
  return {
    id: nodeKey(type, id),
    ocid: id,
    type,
    group: graphTypes[type]?.group || 'resource',
    label: asString(resource.name || resource.displayName || id),
    status: asString(resource.status || resource.lifecycleState || '-'),
    region: asString(resource.region),
    compartmentId: asString(resource.compartmentId),
    compartmentName: asString(resource.compartmentName),
    metadata: {
      availabilityDomain: asString(resource.availabilityDomain),
      shape: asString(resource.shape),
      cidrBlock: asString(resource.cidrBlock),
      privateIp: asString(resource.privateIp),
      publicIp: asString(resource.publicIp),
      vcnId: asString(resource.vcnId),
      subnetId: asString(resource.subnetId),
      routeTableId: asString(resource.routeTableId),
      sizeGb: asString(resource.sizeGb || resource.storageSizeGb),
      createdAt: asString(resource.createdAt),
      resourceKind: graphTypes[type]?.label || type,
    },
  };
}

function ipToInt(ip) {
  const parts = asString(ip).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((total, part) => ((total << 8) + part) >>> 0, 0);
}

function cidrContainsIp(cidr, ip) {
  const [baseIp, prefixValue] = asString(cidr).split('/');
  const base = ipToInt(baseIp);
  const target = ipToInt(ip);
  const prefix = Number(prefixValue);
  if (base === null || target === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (base & mask) === (target & mask);
}

function findSubnetForResource(resource, subnets) {
  const subnetId = asString(resource.subnetId);
  if (subnetId) {
    const exact = subnets.find((subnet) => asString(subnet.id) === subnetId);
    if (exact) {
      return { subnet: exact, confidence: 'direct' };
    }
  }

  const privateIp = asString(resource.privateIp);
  if (!privateIp) {
    return { subnet: null, confidence: '' };
  }

  const match = subnets.find((subnet) => {
    if (asString(subnet.region) && asString(resource.region) && asString(subnet.region) !== asString(resource.region)) {
      return false;
    }
    const cidrs = asString(subnet.cidrBlock).split(',').map((cidr) => cidr.trim()).filter(Boolean);
    return cidrs.some((cidr) => cidrContainsIp(cidr, privateIp));
  });
  return { subnet: match || null, confidence: match ? 'inferred' : '' };
}

function sameScope(left, right) {
  return asString(left.region) === asString(right.region)
    && asString(left.compartmentId) === asString(right.compartmentId)
    && (!asString(left.availabilityDomain) || !asString(right.availabilityDomain) || asString(left.availabilityDomain) === asString(right.availabilityDomain));
}

function addEdge(edges, from, to, label, confidence = 'direct') {
  if (!from || !to || from === to) {
    return;
  }
  const id = `${from}->${to}:${label}`;
  if (edges.has(id)) {
    return;
  }
  edges.set(id, { id, from, to, label, confidence });
}

function routeTargets(routeTable) {
  return (Array.isArray(routeTable.routeRules) ? routeTable.routeRules : [])
    .map((rule) => asString(rule.networkEntityId || rule.networkEntityIdRef || rule.gatewayId))
    .filter(Boolean);
}

function buildFullGraph(inventory) {
  const nodes = new Map();
  const byType = new Map();
  const edges = new Map();

  for (const [type, rows] of collectionRows(inventory)) {
    byType.set(type, rows);
    for (const resource of rows) {
      const node = createNode(type, resource);
      if (node) {
        nodes.set(node.id, node);
      }
    }
  }

  const instances = byType.get('instance') || [];
  const bootVolumes = byType.get('bootVolume') || [];
  const blockVolumes = byType.get('blockVolume') || [];
  const subnets = byType.get('subnet') || [];
  const vcns = byType.get('vcn') || [];
  const routeTables = byType.get('routeTable') || [];
  const gateways = [
    ...(byType.get('internetGateway') || []).map((item) => ({ ...item, __mapType: 'internetGateway' })),
    ...(byType.get('natGateway') || []).map((item) => ({ ...item, __mapType: 'natGateway' })),
    ...(byType.get('serviceGateway') || []).map((item) => ({ ...item, __mapType: 'serviceGateway' })),
    ...(byType.get('drgAttachment') || []).map((item) => ({ ...item, __mapType: 'drgAttachment' })),
  ];
  const databases = [
    ...(byType.get('dbSystem') || []).map((item) => ({ ...item, __mapType: 'dbSystem' })),
    ...(byType.get('autonomousDatabase') || []).map((item) => ({ ...item, __mapType: 'autonomousDatabase' })),
    ...(byType.get('autonomousContainerDatabase') || []).map((item) => ({ ...item, __mapType: 'autonomousContainerDatabase' })),
    ...(byType.get('exadataInfrastructure') || []).map((item) => ({ ...item, __mapType: 'exadataInfrastructure' })),
  ];
  const backups = [
    ...(byType.get('blockVolumeBackup') || []).map((item) => ({ ...item, __mapType: 'blockVolumeBackup' })),
    ...(byType.get('bootVolumeBackup') || []).map((item) => ({ ...item, __mapType: 'bootVolumeBackup' })),
    ...(byType.get('databaseBackup') || []).map((item) => ({ ...item, __mapType: 'databaseBackup' })),
  ];

  for (const instance of instances) {
    const instanceNode = nodeKey('instance', instance.id || instance.name);
    const bootMatches = bootVolumes
      .filter((volume) => asString(volume.instanceId || volume.attachedInstanceId || volume.sourceInstanceId) === asString(instance.id) || (!asString(volume.instanceId || volume.attachedInstanceId || volume.sourceInstanceId) && sameScope(instance, volume)))
      .slice(0, 2);
    for (const volume of bootMatches) {
      addEdge(edges, instanceNode, nodeKey('bootVolume', volume.id || volume.name), asString(volume.instanceId || volume.attachedInstanceId || volume.sourceInstanceId) ? 'boots from' : 'candidate boot volume', asString(volume.instanceId || volume.attachedInstanceId || volume.sourceInstanceId) ? 'direct' : 'inferred');
    }

    const blockMatches = blockVolumes
      .filter((volume) => asString(volume.instanceId || volume.attachedInstanceId || volume.attachedTo) === asString(instance.id) || (!asString(volume.instanceId || volume.attachedInstanceId || volume.attachedTo) && sameScope(instance, volume)))
      .slice(0, 3);
    for (const volume of blockMatches) {
      addEdge(edges, instanceNode, nodeKey('blockVolume', volume.id || volume.name), asString(volume.instanceId || volume.attachedInstanceId || volume.attachedTo) ? 'attached volume' : 'candidate data volume', asString(volume.instanceId || volume.attachedInstanceId || volume.attachedTo) ? 'direct' : 'inferred');
    }

    const { subnet, confidence } = findSubnetForResource(instance, subnets);
    if (subnet) {
      addEdge(edges, instanceNode, nodeKey('subnet', subnet.id || subnet.name), confidence === 'direct' ? 'attached to' : 'private IP in subnet', confidence);
    }
  }

  for (const database of databases) {
    const dbType = asString(database.resourceType || database.providerType || database.__mapType) || 'dbSystem';
    const dbNode = nodeKey(dbType, database.id || database.name);
    const { subnet, confidence } = findSubnetForResource(database, subnets);
    if (subnet) {
      addEdge(edges, dbNode, nodeKey('subnet', subnet.id || subnet.name), confidence === 'direct' ? 'uses subnet' : 'private IP in subnet', confidence);
    }
    for (const backup of backups.filter((item) => asString(item.databaseId || item.dbSystemId || item.sourceDatabaseId) === asString(database.id))) {
      const backupType = asString(backup.resourceType || backup.providerType || backup.__mapType) || 'databaseBackup';
      addEdge(edges, dbNode, nodeKey(backupType, backup.id || backup.name), 'has backup');
    }
  }

  for (const subnet of subnets) {
    if (subnet.vcnId) {
      addEdge(edges, nodeKey('subnet', subnet.id || subnet.name), nodeKey('vcn', subnet.vcnId), 'belongs to');
    }
    const routeTable = routeTables.find((table) => asString(table.id) === asString(subnet.routeTableId))
      || routeTables.find((table) => asString(table.vcnId) && asString(table.vcnId) === asString(subnet.vcnId));
    if (routeTable) {
      addEdge(edges, nodeKey('subnet', subnet.id || subnet.name), nodeKey('routeTable', routeTable.id || routeTable.name), subnet.routeTableId ? 'uses route table' : 'inferred route table', subnet.routeTableId ? 'direct' : 'inferred');
    }
  }

  for (const routeTable of routeTables) {
    if (routeTable.vcnId) {
      addEdge(edges, nodeKey('routeTable', routeTable.id || routeTable.name), nodeKey('vcn', routeTable.vcnId), 'belongs to');
    }
    const targets = routeTargets(routeTable);
    for (const targetId of targets) {
      const gateway = gateways.find((item) => asString(item.id) === targetId || asString(item.drgId) === targetId);
      if (gateway) {
        const gatewayType = asString(gateway.resourceType || gateway.providerType || gateway.__mapType || gateway.gatewayType) || 'internetGateway';
        addEdge(edges, nodeKey('routeTable', routeTable.id || routeTable.name), nodeKey(gatewayType, gateway.id || gateway.name), 'routes to');
      }
    }
  }

  for (const gateway of gateways) {
    const gatewayType = asString(gateway.resourceType || gateway.providerType || gateway.__mapType || gateway.gatewayType) || 'internetGateway';
    if (gateway.vcnId) {
      addEdge(edges, nodeKey(gatewayType, gateway.id || gateway.name), nodeKey('vcn', gateway.vcnId), 'attached to');
    }
  }

  for (const vcn of vcns) {
    for (const routeTable of routeTables.filter((table) => asString(table.vcnId) === asString(vcn.id))) {
      addEdge(edges, nodeKey('vcn', vcn.id || vcn.name), nodeKey('routeTable', routeTable.id || routeTable.name), 'has route table');
    }
  }

  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) };
}

function nodeMatches(node, filters) {
  if (filters.region !== 'all' && node.region !== filters.region) {
    return false;
  }
  if (filters.compartmentId && node.compartmentId !== filters.compartmentId) {
    return false;
  }
  if (filters.resourceType && node.type !== filters.resourceType && node.group !== filters.resourceType) {
    return false;
  }
  if (filters.resourceId && node.ocid !== filters.resourceId && node.id !== filters.resourceId) {
    return false;
  }
  if (filters.search) {
    const haystack = [
      node.label,
      node.type,
      node.group,
      node.status,
      node.region,
      node.compartmentName,
      node.compartmentId,
      node.ocid,
      ...Object.values(node.metadata || {}),
    ].join(' ').toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function filterGraph(graph, filters) {
  const hasFocusedFilter = Boolean(filters.compartmentId || filters.resourceType || filters.resourceId || filters.search || filters.vcnId);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  let selectedIds = new Set(graph.nodes.filter((node) => nodeMatches(node, filters)).map((node) => node.id));

  if (filters.vcnId) {
    const vcnNode = nodeKey('vcn', filters.vcnId);
    selectedIds = new Set([
      ...selectedIds,
      vcnNode,
      ...graph.nodes.filter((node) => node.metadata?.vcnId === filters.vcnId || node.ocid === filters.vcnId).map((node) => node.id),
    ]);
  }

  if (hasFocusedFilter) {
    for (const edge of graph.edges) {
      if (selectedIds.has(edge.from) || selectedIds.has(edge.to)) {
        selectedIds.add(edge.from);
        selectedIds.add(edge.to);
      }
    }
  }

  const scopedIds = hasFocusedFilter
    ? selectedIds
    : new Set(graph.nodes.filter((node) => filters.region === 'all' || node.region === filters.region).map((node) => node.id));

  const nodes = Array.from(scopedIds)
    .map((id) => nodesById.get(id))
    .filter(Boolean)
    .slice(0, RESOURCE_LIMIT);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  return { nodes, edges, truncated: scopedIds.size > RESOURCE_LIMIT };
}

export async function getOciResourceMap(connector, options = {}) {
  const filters = {
    region: asString(options.region) || 'all',
    compartmentId: asString(options.compartmentId),
    resourceType: asString(options.resourceType),
    resourceId: asString(options.resourceId),
    search: asString(options.search),
    vcnId: asString(options.vcnId),
  };
  const inventory = await getCachedOciInventoryFromResources(connector, filters.region);
  if (!inventory) {
    return {
      generatedAt: new Date().toISOString(),
      cached: false,
      filters,
      nodes: [],
      edges: [],
      summary: { nodes: 0, edges: 0, relationships: 0, truncated: false },
      message: 'No cached OCI inventory was found. Run discovery first, then open Resource Map.',
    };
  }

  const fullGraph = buildFullGraph(inventory);
  const graph = filterGraph(fullGraph, filters);
  return {
    generatedAt: new Date().toISOString(),
    cached: true,
    cachedAt: inventory.cachedAt || inventory.lastScannedAt || '',
    filters,
    nodes: graph.nodes,
    edges: graph.edges,
    summary: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      relationships: fullGraph.edges.length,
      truncated: graph.truncated,
    },
    message: graph.truncated ? `Showing first ${RESOURCE_LIMIT} resources. Narrow the region, compartment, VCN, or search filter.` : '',
  };
}
