import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuditLogEntry } from '../services/dashboardService';
import type { ResourceRecord } from '../types/dashboard';

type DetailTab = 'overview' | 'metrics' | 'attached' | 'actions' | 'audit' | 'backups' | 'tags';

type ResourceDetailPageProps = {
  actions?: ReactNode;
  auditLog: AuditLogEntry[];
  backupResources?: ResourceRecord[];
  inventory?: Record<string, unknown> | null;
  onBack: () => void;
  resource: ResourceRecord;
};

const detailTabs: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'attached', label: 'Attached resources' },
  { id: 'actions', label: 'Actions' },
  { id: 'audit', label: 'Audit history' },
  { id: 'backups', label: 'Backups' },
  { id: 'tags', label: 'Tags' },
];

function resourceLabel(resource: ResourceRecord) {
  return resource.name || resource.dbName || resource.hostname || resource.id || 'Resource';
}

function resourceKind(resource: ResourceRecord) {
  return resource.resourceType || resource.providerType || resource.type || 'resource';
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '-';
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function fieldRows(resource: ResourceRecord) {
  const provider = inferProviderFromResource(resource);
  const scopeLabel = provider === 'azure' ? 'Resource group' : provider === 'aws' ? 'Account / VPC scope' : 'Compartment';
  const idLabel = provider === 'azure' ? 'Azure resource ID' : provider === 'aws' ? 'Resource ID' : 'OCID';
  return [
    ['Name', resourceLabel(resource)],
    ['Type', resourceKind(resource)],
    ['State', resource.status || '-'],
    ['Region', resource.region || '-'],
    [scopeLabel, resource.resourceGroup || resource.compartmentName || resource.compartmentId || resource.accountId || resource.vpcId || '-'],
    ['Availability domain', resource.availabilityDomain || '-'],
    ['Shape / Edition', resource.shape || resource.databaseEdition || '-'],
    [idLabel, resource.id || '-'],
    ['Created', resource.createdAt || '-'],
  ];
}

function ipv4ToNumber(ip: string) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((total, part) => ((total << 8) + part) >>> 0, 0);
}

function ipv4InCidr(ip: string, cidr: string) {
  const [network, prefixText] = cidr.split('/');
  const ipNumber = ipv4ToNumber(ip);
  const networkNumber = ipv4ToNumber(network);
  const prefix = Number(prefixText);
  if (ipNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (networkNumber & mask);
}

function sumSizeGb(resources: ResourceRecord[]) {
  const total = resources.reduce((sum, item) => {
    const value = Number(item.sizeGb || item.storageSizeGb || 0);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return total ? total : '-';
}

function metricRows(resource: ResourceRecord, relatedResources: ResourceRecord[]) {
  const relatedBootVolumes = relatedResources.filter((item) => resourceKind(item) === 'bootVolume');
  const relatedBlockVolumes = relatedResources.filter((item) => resourceKind(item) === 'blockVolume');
  const primarySubnet = relatedResources.find((item) => resourceKind(item) === 'subnet');
  const primaryVcn = relatedResources.find((item) => resourceKind(item) === 'vcn');
  const baseRows: Array<[string, unknown]> = [
    ['Lifecycle state', resource.status || '-'],
    ['OCPU', resource.ocpus || resource.cpuCoreCount || '-'],
    ['Memory GB', resource.memoryGb || '-'],
    ['Storage GB', resource.storageSizeGb || resource.sizeGb || sumSizeGb([...relatedBootVolumes, ...relatedBlockVolumes])],
    ['Boot volume GB', sumSizeGb(relatedBootVolumes)],
    ['Block volume GB', sumSizeGb(relatedBlockVolumes)],
    ['CPU usage', typeof resource.cpu === 'number' ? `${Math.round(resource.cpu * 100)}%` : '-'],
    ['Memory bytes', resource.mem || '-'],
    ['Disk bytes', resource.disk || '-'],
    ['Uptime', resource.uptime || '-'],
    ['Private IP', resource.privateIp || '-'],
    ['Public IP', resource.publicIp || '-'],
    ['Subnet', primarySubnet?.name || primarySubnet?.cidrBlock || resource.subnetId || '-'],
    ['VCN', primaryVcn?.name || resource.vcnName || resource.vcnId || '-'],
    ['Availability domain', resource.availabilityDomain || '-'],
    ['Fault domain', resource.faultDomain || '-'],
    ['Created', resource.createdAt || '-'],
  ];
  const shown = new Set(baseRows.map(([label]) => label.toLowerCase()));
  const extraRows = Object.entries(resource)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) && stringifyValue(value) !== '-')
    .map(([key, value]) => [key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()), value] as [string, unknown])
    .filter(([label]) => !shown.has(label.toLowerCase()))
    .slice(0, 16);
  return [...baseRows, ...extraRows];
}

function flattenInventory(inventory?: Record<string, unknown> | null): ResourceRecord[] {
  if (!inventory) {
    return [];
  }
  if (Array.isArray(inventory.allResources)) {
    return inventory.allResources as ResourceRecord[];
  }
  return [
    'instances',
    'blockVolumes',
    'bootVolumes',
    'vcns',
    'vnets',
    'networks',
    'subnets',
    'internetGateways',
    'natGateways',
    'serviceGateways',
    'drgAttachments',
    'routeTables',
    'routes',
    'securityLists',
    'securityGroups',
    'firewallRules',
    'routers',
    'externalIps',
    'publicIps',
    'loadBalancers',
    'disks',
    'managedDisks',
    'snapshots',
    'images',
    'buckets',
    'storageAccounts',
    'dbSystems',
    'autonomousDatabases',
    'autonomousContainerDatabases',
    'exadataInfrastructures',
    'sqlInstances',
    'sqlDatabases',
    'rdsDatabases',
    'serviceAccounts',
  ].flatMap((key) => (Array.isArray(inventory[key]) ? inventory[key] as ResourceRecord[] : []));
}

function isDirectlyRelated(resource: ResourceRecord, candidate: ResourceRecord) {
  if (!resource.id || candidate.id === resource.id) {
    return false;
  }
  const id = String(resource.id);
  const candidateValues = [
    candidate.vcnId,
    candidate.subnetId,
    candidate.routeTableId,
    candidate.drgId,
    candidate.dbSystemId,
    candidate.zoneId,
    candidate.viewId,
    ...(candidate.securityListIds || []),
  ].filter(Boolean).map(String);
  const resourceValues = [
    resource.vcnId,
    resource.subnetId,
    resource.routeTableId,
    resource.drgId,
    resource.dbSystemId,
    resource.zoneId,
    resource.viewId,
    ...(resource.securityListIds || []),
  ].filter(Boolean).map(String);

  const resourceName = String(resource.name || '').toLowerCase();
  const candidateName = String(candidate.name || '').toLowerCase();
  const sameScope = Boolean(resource.region && candidate.region === resource.region)
    && Boolean(resource.compartmentId && candidate.compartmentId === resource.compartmentId);

  return candidateValues.includes(id)
    || Boolean(candidate.id && resourceValues.includes(String(candidate.id)))
    || Boolean(resource.subnetId && candidate.subnetId === resource.subnetId)
    || Boolean(resource.vcnId && candidate.vcnId === resource.vcnId && candidate.resourceType !== resource.resourceType)
    || Boolean(resourceKind(resource) === 'instance' && resourceName && sameScope && resource.availabilityDomain === candidate.availabilityDomain && candidateName.startsWith(`${resourceName} (`))
    || Boolean(resource.privateIp && candidate.cidrBlock && resource.region === candidate.region && ipv4InCidr(String(resource.privateIp), String(candidate.cidrBlock)));
}

function relatedResourcesFor(resource: ResourceRecord, inventory?: Record<string, unknown> | null) {
  const allResources = flattenInventory(inventory);
  const direct = allResources.filter((candidate) => isDirectlyRelated(resource, candidate));
  const directIds = new Set(direct.map((item) => item.id).filter(Boolean).map(String));
  const relatedVcnIds = new Set([
    resource.vcnId,
    ...direct.map((item) => item.vcnId),
    ...direct.filter((item) => resourceKind(item) === 'vcn').map((item) => item.id),
  ].filter(Boolean).map(String));
  const expanded = allResources.filter((candidate) => {
    if (!candidate.id || candidate.id === resource.id || directIds.has(candidate.id)) {
      return false;
    }
    return Boolean(relatedVcnIds.size && (
      (candidate.vcnId && relatedVcnIds.has(String(candidate.vcnId)))
      || (resourceKind(candidate) === 'vcn' && relatedVcnIds.has(String(candidate.id)))
    ));
  });
  return [...direct, ...expanded].slice(0, 40);
}

function inferProviderFromResource(resource: ResourceRecord) {
  const type = String(resource.resourceType || resource.providerType || resource.type || '').toLowerCase();
  const id = String(resource.id || '').toLowerCase();
  if (
    type.includes('gcp')
    || type.includes('computeinstance')
    || type.includes('vpcnetwork')
    || type.includes('firewallrule')
    || type.includes('cloudrouter')
    || type.includes('externalip')
    || type.includes('sqlinstance')
    || type.includes('sqldatabase')
    || type.includes('gkecluster')
    || type.includes('serviceaccount')
    || id.includes('googleapis.com/')
    || id.includes('/compute/v1/projects/')
    || id.includes('/sql/v1beta4/projects/')
    || id.startsWith('projects/')
  ) {
    return 'gcp';
  }
  if (
    type.includes('azure')
    || type.includes('virtualmachine')
    || type.includes('manageddisk')
    || type.includes('restorepoint')
    || type.includes('storageaccount')
    || type.includes('sqldatabase')
    || type.includes('cosmosdb')
    || id.includes('/providers/microsoft.')
    || id.startsWith('/subscriptions/')
  ) {
    return 'azure';
  }
  if (
    type.includes('ec2')
    || type.includes('ebs')
    || type.includes('vpc')
    || type.includes('s3')
    || type.includes('rds')
    || type.includes('elastic')
    || id.startsWith('i-')
    || id.startsWith('vol-')
    || id.startsWith('vpc-')
    || id.startsWith('subnet-')
  ) {
    return 'aws';
  }
  if (id.startsWith('ocid1.') || type.includes('oci') || ['instance', 'blockvolume', 'bootvolume', 'vcn', 'subnet', 'bucket'].includes(type)) {
    return 'oci';
  }
  return '';
}

function inferProviderFromAudit(entry: AuditLogEntry) {
  const provider = String(entry.provider || '').toLowerCase();
  if (provider) {
    return provider;
  }
  const action = String(entry.action || '').toLowerCase();
  if (action.startsWith('aws-')) {
    return 'aws';
  }
  if (action.startsWith('oci-')) {
    return 'oci';
  }
  if (action.startsWith('azure-')) {
    return 'azure';
  }
  return '';
}

function normalizeAuditValue(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function auditValues(entry: AuditLogEntry, keys: string[]) {
  return keys
    .map((key) => normalizeAuditValue(entry[key]))
    .filter(Boolean);
}

function auditMatchesResource(entry: AuditLogEntry, resource: ResourceRecord) {
  const resourceProvider = inferProviderFromResource(resource);
  const entryProvider = inferProviderFromAudit(entry);
  if (resourceProvider && entryProvider && resourceProvider !== entryProvider) {
    return false;
  }

  const resourceIds = [
    resource.id,
    resource.vmid,
  ].map(normalizeAuditValue).filter(Boolean);
  const entryIds = auditValues(entry, [
    'resourceId',
    'instanceId',
    'vmid',
    'imageId',
    'volumeId',
    'vcnId',
    'subnetId',
    'bucketName',
    'databaseId',
    'dbSystemId',
    'autonomousDatabaseId',
  ]);
  if (resourceIds.some((id) => entryIds.includes(id))) {
    return true;
  }

  const resourceNames = [
    resource.name,
    resource.dbName,
    resource.hostname,
  ].map(normalizeAuditValue).filter(Boolean);
  const entryNames = auditValues(entry, [
    'resourceName',
    'instanceName',
    'imageName',
    'volumeName',
    'vcnName',
    'subnetName',
    'bucketName',
    'databaseName',
    'dbName',
    'displayName',
  ]);
  return resourceNames.some((name) => entryNames.includes(name));
}

function tagsFor(resource: ResourceRecord) {
  const raw = resource as unknown as Record<string, unknown>;
  return ([
    ['Freeform tags', raw.freeformTags],
    ['Defined tags', raw.definedTags],
    ['System tags', raw.systemTags],
    ['Tags', raw.tags],
  ] as Array<[string, unknown]>).filter(([, value]) => value && stringifyValue(value) !== '{}');
}

function isRouteTable(resource: ResourceRecord) {
  return String(resource.resourceType || resource.providerType || resource.type || '').toLowerCase() === 'routetable';
}

function routeRulesFor(resource: ResourceRecord) {
  const raw = resource as unknown as {
    routes?: Array<{ destination?: string; target?: string; state?: string; origin?: string; destinationCidrBlock?: string; gatewayId?: string; natGatewayId?: string; networkEntityId?: string }>;
    routeRules?: Array<{ destination?: string; destinationType?: string; networkEntityId?: string; description?: string; routeType?: string }>;
  };
  const awsRoutes = (raw.routes || []).map((route) => ({
    destination: route.destination || route.destinationCidrBlock || '-',
    target: route.target || route.gatewayId || route.natGatewayId || route.networkEntityId || '-',
    type: route.origin || '-',
    state: route.state || '-',
  }));
  const ociRoutes = (raw.routeRules || []).map((route) => ({
    destination: route.destination || '-',
    target: route.networkEntityId || '-',
    type: route.destinationType || route.routeType || '-',
    state: route.description || '-',
  }));
  return [...awsRoutes, ...ociRoutes];
}

function routeAssociationsFor(resource: ResourceRecord) {
  return (resource.associations || []).map((association) => ({
    id: association.id || '-',
    subnetId: association.subnetId || '-',
    gatewayId: association.gatewayId || '-',
    main: association.main ? 'Yes' : 'No',
    state: association.state || '-',
  }));
}

export function ResourceDetailPage({ actions, auditLog, backupResources = [], inventory, onBack, resource }: ResourceDetailPageProps) {
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('overview');
  const relatedResources = useMemo(
    () => relatedResourcesFor(resource, inventory),
    [inventory, resource],
  );
  const matchingAudit = useMemo(
    () => auditLog.filter((entry) => auditMatchesResource(entry, resource)).slice(0, 20),
    [auditLog, resource],
  );
  const matchingBackups = useMemo(
    () => backupResources.filter((backup) => {
      const text = JSON.stringify(backup).toLowerCase();
      return [resource.id, resource.name].filter(Boolean).some((value) => text.includes(String(value).toLowerCase()));
    }),
    [backupResources, resource],
  );
  const tagRows = tagsFor(resource);

  return (
    <section className="space-y-4">
      <section className="pm-panel">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{resourceKind(resource)}</p>
            <h2 className="mt-1 break-words text-2xl font-semibold text-slate-950">{resourceLabel(resource)}</h2>
            <p className="mt-2 break-all text-sm text-slate-600">{resource.id || 'No resource ID available'}</p>
          </div>
          <button className="pm-button" onClick={onBack} type="button">Back to list</button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {detailTabs.map((tab) => (
            <button
              className={`rounded-md px-3 py-2 text-sm font-semibold ${activeDetailTab === tab.id ? 'bg-blue-700 text-white' : 'border border-slate-300 bg-white text-slate-700 hover:bg-blue-50 hover:text-blue-900'}`}
              key={tab.id}
              onClick={() => setActiveDetailTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </section>

      {activeDetailTab === 'overview' ? (
        <>
          <section className="pm-panel">
            <h3 className="text-base font-semibold text-slate-950">Overview</h3>
            <dl className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {fieldRows(resource).map(([label, value]) => (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3" key={label}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-1 break-words text-sm font-semibold text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {isRouteTable(resource) ? (
            <section className="pm-panel overflow-hidden p-0">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                <h3 className="text-base font-semibold text-slate-950">Routing Rules</h3>
                <p className="mt-1 text-xs text-slate-500">Destination, target, origin/type, and current route state from the route table.</p>
              </div>
              {routeRulesFor(resource).length ? (
                <div className="overflow-x-auto">
                  <table className="pm-table">
                    <thead><tr><th>Destination</th><th>Target</th><th>Type / Origin</th><th>State / Description</th></tr></thead>
                    <tbody>
                      {routeRulesFor(resource).map((route, index) => (
                        <tr key={`${route.destination}-${route.target}-${index}`}>
                          <td>{route.destination}</td>
                          <td className="max-w-[360px] truncate" title={route.target}>{route.target}</td>
                          <td>{route.type}</td>
                          <td>{route.state}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-4 py-8 text-sm text-slate-600">No routing rules are loaded for this route table. Use Refresh Inventory, then open the route table again.</div>
              )}
            </section>
          ) : null}

          {isRouteTable(resource) && routeAssociationsFor(resource).length ? (
            <section className="pm-panel overflow-hidden p-0">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                <h3 className="text-base font-semibold text-slate-950">Associations</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="pm-table">
                  <thead><tr><th>Association ID</th><th>Subnet</th><th>Gateway</th><th>Main</th><th>State</th></tr></thead>
                  <tbody>
                    {routeAssociationsFor(resource).map((association) => (
                      <tr key={`${association.id}-${association.subnetId}-${association.gatewayId}`}>
                        <td>{association.id}</td>
                        <td>{association.subnetId}</td>
                        <td>{association.gatewayId}</td>
                        <td>{association.main}</td>
                        <td>{association.state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {activeDetailTab === 'metrics' ? (
        <section className="pm-panel">
          <h3 className="text-base font-semibold text-slate-950">Metrics</h3>
          <dl className="mt-4 grid gap-3 md:grid-cols-3">
            {metricRows(resource, relatedResources).map(([label, value]) => (
              <div className="rounded-lg border border-slate-200 bg-white p-3" key={label}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-1 text-sm font-semibold text-slate-900">{stringifyValue(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {activeDetailTab === 'attached' ? (
        <section className="pm-panel overflow-hidden p-0">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <h3 className="text-base font-semibold text-slate-950">Attached Resources</h3>
          </div>
          {relatedResources.length ? (
            <div className="overflow-x-auto">
              <table className="pm-table">
                <thead><tr><th>Name</th><th>Type</th><th>State</th><th>Region</th><th>Compartment</th><th>OCID</th></tr></thead>
                <tbody>
                  {relatedResources.map((item) => (
                    <tr key={`${resourceKind(item)}:${item.id || item.name}`}>
                      <td>{resourceLabel(item)}</td>
                      <td>{resourceKind(item)}</td>
                      <td>{item.status || '-'}</td>
                      <td>{item.region || '-'}</td>
                      <td>{item.compartmentName || item.compartmentId || '-'}</td>
                      <td className="max-w-[320px] truncate" title={item.id}>{item.id || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-8 text-sm text-slate-600">No attached resources found in the cached inventory.</div>
          )}
        </section>
      ) : null}

      {activeDetailTab === 'actions' ? (
        <section className="pm-panel">
          <h3 className="text-base font-semibold text-slate-950">Actions</h3>
          <div className="mt-4 flex flex-wrap gap-2">{actions || <span className="text-sm text-slate-600">No actions are available for this resource type.</span>}</div>
        </section>
      ) : null}

      {activeDetailTab === 'audit' ? (
        <section className="pm-panel overflow-hidden p-0">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <h3 className="text-base font-semibold text-slate-950">Audit History</h3>
          </div>
          {matchingAudit.length ? (
            <div className="overflow-x-auto">
              <table className="pm-table">
                <thead><tr><th>Time</th><th>Action</th><th>Status</th><th>User</th><th>Message</th></tr></thead>
                <tbody>
                  {matchingAudit.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.timestamp}</td>
                      <td>{entry.action}</td>
                      <td>{entry.status}</td>
                      <td>{entry.user || '-'}</td>
                      <td>{entry.message || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-8 text-sm text-slate-600">No audit entries found for this resource.</div>
          )}
        </section>
      ) : null}

      {activeDetailTab === 'backups' ? (
        <section className="pm-panel overflow-hidden p-0">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <h3 className="text-base font-semibold text-slate-950">Backups</h3>
          </div>
          {matchingBackups.length ? (
            <div className="overflow-x-auto">
              <table className="pm-table">
                <thead><tr><th>Name</th><th>State</th><th>Type</th><th>Size GB</th><th>Created</th><th>OCID</th></tr></thead>
                <tbody>
                  {matchingBackups.map((backup) => (
                    <tr key={backup.id || backup.name}>
                      <td>{backup.name || '-'}</td>
                      <td>{backup.status || '-'}</td>
                      <td>{backup.resourceType || backup.type || '-'}</td>
                      <td>{backup.sizeGb || backup.storageSizeGb || '-'}</td>
                      <td>{backup.createdAt || '-'}</td>
                      <td className="max-w-[320px] truncate" title={backup.id}>{backup.id || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-8 text-sm text-slate-600">No backups are currently linked to this resource in the loaded catalog.</div>
          )}
        </section>
      ) : null}

      {activeDetailTab === 'tags' ? (
        <section className="pm-panel">
          <h3 className="text-base font-semibold text-slate-950">Tags</h3>
          {tagRows.length ? (
            <dl className="mt-4 grid gap-3">
              {tagRows.map(([label, value]) => (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3" key={label}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-1 break-words font-mono text-xs text-slate-800">{stringifyValue(value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-slate-600">No tags are available in the cached inventory for this resource.</p>
          )}
        </section>
      ) : null}
    </section>
  );
}
