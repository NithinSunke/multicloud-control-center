import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import type { ProxmoxConnector } from './types/connectors';
import type { DashboardData } from './types/dashboard';
import type { AwsInventory } from './services/awsService';
import type { OciAllResourcesResponse } from './services/ociService';

jest.mock('recharts', () => {
  const React = require('react');
  const passthrough = (name: string) =>
    function RechartsMock({ children }: { children?: unknown }) {
      return React.createElement('div', { 'data-testid': name }, children);
    };

  return {
    Area: () => null,
    AreaChart: passthrough('area-chart'),
    Bar: () => null,
    BarChart: passthrough('bar-chart'),
    Cell: () => null,
    Pie: passthrough('pie'),
    PieChart: passthrough('pie-chart'),
    ResponsiveContainer: passthrough('responsive-container'),
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

jest.mock('@novnc/novnc', () => ({
  __esModule: true,
  default: class RfbMock {
    scaleViewport = false;
    resizeSession = false;
    viewOnly = false;
    constructor() {}
    addEventListener() {}
    disconnect() {}
    sendCtrlAltDel() {}
  },
}));

jest.setTimeout(45000);

const verifiedConnector: ProxmoxConnector = {
  id: 'connector-1',
  name: 'Production PVE',
  host: 'https://pve.local',
  port: 8006,
  realm: 'pam',
  username: 'root',
  authType: 'apiToken',
  apiTokenId: 'automation',
  tlsVerify: true,
  notes: '',
  status: 'verified',
  lastVerifiedAt: '2026-05-15T00:00:00.000Z',
  verificationMessage: 'Connection verified.',
  selected: true,
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
  secretPreview: '**** 1234',
  secretStored: true,
};

const verifiedOciConnector: ProxmoxConnector = {
  id: 'oci-1',
  provider: 'oci',
  name: 'Production OCI',
  host: '',
  port: 443,
  realm: '',
  username: '',
  authType: 'apiToken',
  apiTokenId: '',
  tenancyOcid: 'ocid1.tenancy.oc1..root',
  userOcid: 'ocid1.user.oc1..user',
  compartmentOcid: 'ocid1.tenancy.oc1..root',
  region: 'eu-frankfurt-1',
  fingerprint: 'aa:bb:cc:dd',
  tlsVerify: true,
  notes: '',
  status: 'verified',
  lastVerifiedAt: '2026-05-15T00:00:00.000Z',
  verificationMessage: 'Connected to OCI eu-frankfurt-1.',
  selected: true,
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
  secretPreview: '**** c:dd',
  secretStored: true,
};

const verifiedAwsConnector: ProxmoxConnector = {
  id: 'aws-1',
  provider: 'aws',
  name: 'Production AWS',
  host: '',
  port: 443,
  realm: '',
  username: '',
  authType: 'apiToken',
  apiTokenId: '',
  awsAccountId: '123456789012',
  awsAccessKeyId: 'AKIATESTKEY123456',
  region: 'us-east-1',
  tlsVerify: true,
  notes: '',
  status: 'verified',
  lastVerifiedAt: '2026-05-15T00:00:00.000Z',
  verificationMessage: 'Connected to AWS account 123456789012.',
  selected: true,
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
  secretPreview: '**** 3456',
  secretStored: true,
};

const ociInventory = {
  generatedAt: '2026-05-15T00:00:00.000Z',
  connector: { id: 'oci-1', name: 'Production OCI', region: 'eu-frankfurt-1', tenancyOcid: 'ocid1.tenancy.oc1..root' },
  summary: {
    regions: 2,
    compartments: 2,
    instances: 1,
    runningInstances: 1,
    stoppedInstances: 0,
    blockVolumes: 1,
    bootVolumes: 1,
    vcns: 1,
    subnets: 1,
    buckets: 1,
    dbSystems: 1,
    autonomousDatabases: 1,
    autonomousContainerDatabases: 1,
    exadataInfrastructures: 1,
  },
  regions: [
    { name: 'eu-frankfurt-1', key: 'FRA', status: 'READY', home: true },
    { name: 'us-ashburn-1', key: 'IAD', status: 'READY', home: false },
  ],
  compartments: [
    { id: 'root', name: 'Root tenancy', description: '', status: 'ACTIVE', parentCompartmentId: '' },
    { id: 'apps', name: 'apps', description: '', status: 'ACTIVE', parentCompartmentId: 'root' },
  ],
  instances: [
    { id: 'instance-1', name: 'oci-web-1', status: 'RUNNING', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', shape: 'VM.Standard.E4.Flex', availabilityDomain: 'FRA-AD-1', faultDomain: 'FAULT-DOMAIN-1', ocpus: 2, memoryGb: 16, publicIp: '203.0.113.10' },
  ],
  blockVolumes: [
    { id: 'volume-1', name: 'data-volume', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', sizeGb: 100, availabilityDomain: 'FRA-AD-1' },
  ],
  bootVolumes: [
    { id: 'boot-1', name: 'oci-web-1-boot', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', sizeGb: 50, availabilityDomain: 'FRA-AD-1' },
  ],
  vcns: [
    { id: 'vcn-1', name: 'prod-vcn', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentName: 'apps', cidrBlock: '10.0.0.0/16', dnsLabel: 'prod' },
  ],
  subnets: [
    { id: 'subnet-1', name: 'web-subnet', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', cidrBlock: '10.0.1.0/24', availabilityDomain: 'regional' },
  ],
  buckets: [
    { id: 'bucket-1', name: 'backups', region: 'eu-frankfurt-1', compartmentName: 'apps', namespace: 'tenantns', storageTier: 'Standard', publicAccessType: 'NoPublicAccess' },
  ],
  dbSystems: [
    { id: 'db-system-1', name: 'orders-db-system', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', availabilityDomain: 'FRA-AD-1', shape: 'VM.Standard2.2', dbVersion: '19c', databaseEdition: 'ENTERPRISE_EDITION', licenseModel: 'LICENSE_INCLUDED', storageSizeGb: 256, ocpus: 2 },
  ],
  autonomousDatabases: [
    { id: 'adb-1', name: 'analytics-adb', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', dbName: 'ANALYTICS', dbVersion: '23ai', workloadType: 'DW', storageSizeGb: 1024, ocpus: 4 },
  ],
  autonomousContainerDatabases: [
    { id: 'acdb-1', name: 'shared-acdb', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', dbVersion: '19c' },
  ],
  exadataInfrastructures: [
    { id: 'exadata-1', name: 'finance-exadata', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', availabilityDomain: 'FRA-AD-1', shape: 'Exadata.X9M' },
  ],
  errors: [],
};

const ociInstances = {
  generatedAt: '2026-05-15T00:01:00.000Z',
  region: 'eu-frankfurt-1',
  compartmentId: 'root',
  cached: true,
  cachedAt: '2026-05-15T00:01:00.000Z',
  lastScannedAt: '2026-05-15T00:01:00.000Z',
  instances: [
    { id: 'instance-1', name: 'oci-web-1', status: 'RUNNING', region: 'eu-frankfurt-1', compartmentName: 'Root tenancy', shape: 'VM.Standard.E4.Flex', availabilityDomain: 'FRA-AD-1', faultDomain: 'FAULT-DOMAIN-1' },
  ],
  errors: [],
};

const ociResources = {
  ...ociInstances,
  summary: {
    instances: 1,
    runningInstances: 1,
    stoppedInstances: 0,
    blockVolumes: 1,
    bootVolumes: 1,
    vcns: 1,
    subnets: 1,
    buckets: 1,
  },
  blockVolumes: ociInventory.blockVolumes,
  bootVolumes: ociInventory.bootVolumes,
  vcns: ociInventory.vcns,
  subnets: ociInventory.subnets,
  buckets: ociInventory.buckets,
  dbSystems: ociInventory.dbSystems,
  autonomousDatabases: ociInventory.autonomousDatabases,
  autonomousContainerDatabases: ociInventory.autonomousContainerDatabases,
  exadataInfrastructures: ociInventory.exadataInfrastructures,
};

const ociAllResources: OciAllResourcesResponse = {
  ...ociInventory,
  cached: true,
  cachedAt: '2026-05-15T00:02:00.000Z',
  lastScannedAt: '2026-05-15T00:02:00.000Z',
};

const awsInventory: AwsInventory = {
  generatedAt: '2026-05-15T00:04:00.000Z',
  cached: true,
  cachedAt: '2026-05-15T00:04:00.000Z',
  connector: { id: 'aws-1', name: 'Production AWS', region: 'us-east-1', accountId: '123456789012' },
  scan: { requestedRegion: 'all', scannedRegions: ['us-east-1'] },
  summary: {
    regions: 1,
    instances: 3,
    runningInstances: 2,
    stoppedInstances: 1,
    vpcs: 1,
    subnets: 1,
    securityGroups: 1,
    routeTables: 1,
    internetGateways: 1,
    natGateways: 1,
    ebsVolumes: 2,
    ebsSnapshots: 1,
    s3Buckets: 2,
    rdsDatabases: 2,
    loadBalancers: 1,
    elasticIps: 2,
  },
  regions: [{ name: 'us-east-1', endpoint: 'ec2.us-east-1.amazonaws.com', status: 'available' }],
  instances: [
    { id: 'i-123', name: 'aws-web-1', status: 'running', region: 'us-east-1', availabilityDomain: 'us-east-1a', shape: 't3.medium', vpcId: 'vpc-123', subnetId: 'subnet-123', privateIp: '10.0.1.10', publicIp: '198.51.100.10' },
    { id: 'i-stopped', name: 'aws-stopped-1', status: 'stopped', region: 'us-east-1', availabilityDomain: 'us-east-1a', shape: 't3.small', vpcId: 'vpc-123', subnetId: 'subnet-123', privateIp: '10.0.1.11' },
    { id: 'i-big', name: 'aws-big-1', status: 'running', region: 'us-east-1', availabilityDomain: 'us-east-1a', shape: 'm6i.2xlarge', vpcId: 'vpc-123', subnetId: 'subnet-123', privateIp: '10.0.1.12' },
  ],
  vpcs: [{ id: 'vpc-123', name: 'prod-vpc', status: 'available', region: 'us-east-1', cidrBlock: '10.0.0.0/16' }],
  subnets: [{ id: 'subnet-123', name: 'web-subnet', status: 'available', region: 'us-east-1', vpcId: 'vpc-123', cidrBlock: '10.0.1.0/24' }],
  securityGroups: [{ id: 'sg-123', name: 'web-sg', status: '-', region: 'us-east-1', vpcId: 'vpc-123', description: 'web access' }],
  routeTables: [{ id: 'rtb-123', name: 'public-routes', status: '-', region: 'us-east-1', vpcId: 'vpc-123' }],
  internetGateways: [{ id: 'igw-123', name: 'prod-igw', status: 'available', region: 'us-east-1', vpcId: 'vpc-123' }],
  natGateways: [{ id: 'nat-123', name: 'prod-nat', status: 'available', region: 'us-east-1', vpcId: 'vpc-123', subnetId: 'subnet-123' }],
  ebsVolumes: [
    { id: 'vol-123', name: 'app-data', status: 'available', region: 'us-east-1', availabilityDomain: 'us-east-1a', sizeGb: 100, type: 'gp3' },
    { id: 'vol-stopped', name: 'stopped-root', status: 'in-use', region: 'us-east-1', availabilityDomain: 'us-east-1a', sizeGb: 40, type: 'gp3', attachedInstanceId: 'i-stopped' },
  ],
  ebsSnapshots: [{ id: 'snap-123', name: 'app-data-snap', status: 'completed', region: 'us-east-1', sizeGb: 100, createdAt: '2026-03-01T00:00:00.000Z' }],
  s3Buckets: [
    { id: 'app-artifacts', name: 'app-artifacts', status: 'available', region: 'global' },
    { id: 'public-assets', name: 'public-assets', status: 'available', region: 'global', publicAccessStatus: 'Review' },
  ],
  rdsDatabases: [
    { id: 'db-123', name: 'orders-db', status: 'available', region: 'us-east-1', engine: 'postgres', dbVersion: '16.1', shape: 'db.t3.medium', storageSizeGb: 100, endpoint: 'orders-db.abc.us-east-1.rds.amazonaws.com' },
    { id: 'db-stopped', name: 'archive-db', status: 'stopped', region: 'us-east-1', engine: 'mysql', dbVersion: '8.0', shape: 'db.t3.small', storageSizeGb: 50, endpoint: 'archive-db.abc.us-east-1.rds.amazonaws.com' },
  ],
  loadBalancers: [{ id: 'lb-123', name: 'public-alb', status: 'active', region: 'us-east-1', type: 'application', scheme: 'internet-facing', vpcId: 'vpc-123', dnsName: 'public-alb.example.com' }],
  elasticIps: [
    { id: 'eipalloc-123', name: '198.51.100.20', status: 'associated', region: 'us-east-1', publicIp: '198.51.100.20', instanceId: 'i-123' },
    { id: 'eipalloc-unused', name: '198.51.100.21', status: 'available', region: 'us-east-1', publicIp: '198.51.100.21' },
  ],
  iamSummary: { Users: 3, Roles: 8, Groups: 2 },
  errors: [],
};

const fullDashboard: DashboardData = {
  generatedAt: '2026-05-15T00:00:00.000Z',
  summary: {
    clusterHealth: 'healthy',
    totalNodes: 1,
    onlineNodes: 1,
    totalVMs: 2,
    totalVMTemplates: 1,
    runningVMs: 1,
    stoppedVMs: 1,
    containers: 1,
    runningContainers: 1,
    cpuUsage: 0.42,
    memoryUsage: 0.5,
    storageUsage: 0.25,
  },
  charts: {
    cpu: [{ name: 'pve', usage: 42 }],
    memory: [{ name: 'pve', used: 8, total: 16, usage: 50 }],
    storage: [{ name: 'local', used: 25, total: 100, usage: 25 }],
    status: [
      { name: 'Running VMs', value: 1 },
      { name: 'Stopped VMs', value: 1 },
      { name: 'Running CTs', value: 1 },
      { name: 'Stopped CTs', value: 0 },
    ],
  },
  resources: {
    nodes: [{ node: 'pve', status: 'online', cpu: 0.42, mem: 8, maxmem: 16 }],
    vms: [
      { vmid: 100, name: 'app-server', node: 'pve', status: 'running', cpu: 0.2, mem: 4, maxmem: 16, uptime: 15129 },
      { vmid: 101, name: 'db-server', node: 'pve', status: 'stopped', cpu: 0, mem: 0, maxmem: 16, uptime: 0 },
    ],
    vmTemplates: [
      { vmid: 9000, name: 'ubuntu-template', node: 'pve', status: 'stopped', template: 1 },
    ],
    containers: [{ vmid: 200, name: 'nginx', node: 'pve', status: 'running', cpu: 0.1, mem: 2, maxmem: 4, uptime: 3600 }],
    storage: [{ storage: 'local', node: 'pve', status: 'available', disk: 25, maxdisk: 100 }],
    allCompute: [],
  },
};

function renderApp() {
  render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

async function enterPveEnvironment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /enter pve/i }));
}

async function enterOciEnvironment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /enter oci/i }));
}

async function enterAwsEnvironment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /enter aws/i }));
}

function getVmManagerRow(name: string) {
  const match = screen.getAllByText(name).find((element) => element.closest('.vm-manager-table'));
  const row = match?.closest('tr');
  if (!row) {
    throw new Error(`Unable to find VM manager row for ${name}`);
  }
  return row as HTMLElement;
}

function getContainerManagerRow(name: string) {
  const containerToolbarElement = screen.getByRole('toolbar', { name: /container commands/i });
  const containerCard = containerToolbarElement.closest('.vm-manager-card');
  const match = within(containerCard as HTMLElement).getAllByText(name).find((element) => element.closest('tr'));
  const row = match?.closest('tr');
  if (!row) {
    throw new Error(`Unable to find container manager row for ${name}`);
  }
  return row as HTMLElement;
}

async function selectVmManagerRow(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = getVmManagerRow(name);
  await user.click(row);
  return row;
}

async function selectContainerManagerRow(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = getContainerManagerRow(name);
  await user.click(row);
  return row;
}

function vmToolbar() {
  return within(screen.getByRole('toolbar', { name: /virtual machine commands/i }));
}

function containerToolbar() {
  return within(screen.getByRole('toolbar', { name: /container commands/i }));
}

function mockAuthenticatedApp({
  connectors = [],
  selectedConnectorId = null,
  selectedOciConnectorId = null,
  selectedAwsConnectorId = null,
  selectedAzureConnectorId = null,
  dashboard = null,
  dashboardError = '',
  pendingDashboard = false,
  ociAllResourcesData = ociAllResources,
  awsInventoryData = awsInventory,
}: {
  connectors?: ProxmoxConnector[];
  selectedConnectorId?: string | null;
  selectedOciConnectorId?: string | null;
  selectedAwsConnectorId?: string | null;
  selectedAzureConnectorId?: string | null;
  dashboard?: DashboardData | null;
  dashboardError?: string;
  pendingDashboard?: boolean;
  ociAllResourcesData?: OciAllResourcesResponse;
  awsInventoryData?: AwsInventory;
}) {
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith('/api/auth/me')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ user: { username: 'admin', roles: ['admin'] } }),
      } as Response);
    }

    if (url.endsWith('/api/connectors') && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          connector: {
            id: 'connector-new',
            provider: payload.provider || 'proxmox',
            name: payload.name,
            host: payload.host || '',
            port: payload.port || 443,
            realm: payload.realm || '',
            username: payload.username || '',
            authType: payload.authType || 'apiToken',
            apiTokenId: payload.apiTokenId || '',
            tenancyOcid: payload.tenancyOcid || '',
            userOcid: payload.userOcid || '',
            compartmentOcid: payload.compartmentOcid || '',
            awsAccountId: payload.awsAccountId || '',
            awsAccessKeyId: payload.awsAccessKeyId || '',
            azureTenantId: payload.azureTenantId || '',
            azureSubscriptionId: payload.azureSubscriptionId || '',
            azureClientId: payload.azureClientId || '',
            azureCloud: payload.azureCloud || 'public',
            azureSubscriptionName: payload.azureSubscriptionName || '',
            region: payload.region || '',
            fingerprint: payload.fingerprint || '',
            tlsVerify: payload.tlsVerify !== false,
            notes: payload.notes || '',
            status: 'ready',
            lastVerifiedAt: null,
            verificationMessage: '',
            selected: payload.provider === 'oci' || payload.provider === 'azure',
            createdAt: '2026-05-15T00:00:00.000Z',
            updatedAt: '2026-05-15T00:00:00.000Z',
            secretPreview: payload.provider === 'oci' ? '**** c:dd' : payload.provider === 'azure' ? '**** 3333' : '**** 1234',
            secretStored: true,
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/connectors')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ selectedConnectorId, selectedOciConnectorId, selectedAwsConnectorId, selectedAzureConnectorId, connectors }),
      } as Response);
    }

    if (url.includes('/api/aws/jobs')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T08:55:00.000Z',
            tasks: [
              {
                upid: 'AWS:job-1',
                provider: 'aws',
                node: 'AWS',
                user: 'admin',
                type: 'aws-ec2-start',
                action: 'aws-ec2-start',
                id: 'job-1',
                status: 'running',
                exitstatus: '',
                progress: 50,
                startedAt: '2026-05-15T08:54:00.000Z',
                endedAt: null,
                description: 'aws-ec2-start aws-web-1',
                message: 'AWS start request submitted.',
                resourceType: 'ec2Instance',
                resourceId: 'i-123',
                resourceName: 'aws-web-1',
                retryable: false,
                cancelable: false,
                linkedResource: {
                  provider: 'aws',
                  type: 'ec2Instance',
                  id: 'i-123',
                  name: 'aws-web-1',
                  region: 'us-east-1',
                },
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/inventory')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: awsInventoryData }),
      } as Response);
    }

    if (url.includes('/api/aws/images')) {
      const requestUrl = new URL(url, 'http://localhost');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:05:00.000Z',
            region: requestUrl.searchParams.get('region') || 'us-east-1',
            images: [
              {
                id: 'ami-0amazonlinux',
                name: 'Amazon Linux 2023 kernel-6.1 AMI',
                description: 'Amazon Linux 2023 AMI',
                status: 'available',
                region: requestUrl.searchParams.get('region') || 'us-east-1',
                architecture: 'x86_64',
                platform: 'Linux/UNIX',
                createdAt: '2026-05-15T00:00:00.000Z',
              },
              {
                id: 'ami-oldcustom',
                name: 'old-custom-ami',
                description: 'Old custom AMI',
                status: 'available',
                region: requestUrl.searchParams.get('region') || 'us-east-1',
                architecture: 'x86_64',
                platform: 'Linux/UNIX',
                ownerId: '123456789012',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                id: 'ami-0ubuntu',
                name: 'ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server',
                description: 'Ubuntu Server',
                status: 'available',
                region: requestUrl.searchParams.get('region') || 'us-east-1',
                architecture: 'x86_64',
                platform: 'Linux/UNIX',
                createdAt: '2026-05-10T00:00:00.000Z',
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/key-pairs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            message: 'AWS key pair created. Save the private key now; it cannot be retrieved again.',
            keyPair: {
              id: 'key-new',
              name: body.name,
              fingerprint: 'cc:dd',
              region: body.region,
            },
            privateKeyMaterial: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/key-pairs')) {
      const requestUrl = new URL(url, 'http://localhost');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:06:00.000Z',
            region: requestUrl.searchParams.get('region') || 'us-east-1',
            keyPairs: [
              {
                id: 'key-123',
                name: 'prod-key',
                fingerprint: 'aa:bb',
                region: requestUrl.searchParams.get('region') || 'us-east-1',
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/rds/snapshots/') && init?.method === 'DELETE') {
      const snapshotIdentifier = String(url).split('/rds/snapshots/')[1];
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'AWS RDS snapshot deletion requested.',
            snapshot: { id: snapshotIdentifier, name: snapshotIdentifier, status: 'deleting', region: 'us-east-1' },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/rds/snapshots')) {
      const requestUrl = new URL(url, 'http://localhost');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:08:00.000Z',
            region: requestUrl.searchParams.get('region') || 'us-east-1',
            snapshots: [
              { id: 'orders-db-snap', name: 'orders-db-snap', status: 'available', region: requestUrl.searchParams.get('region') || 'us-east-1', dbInstanceId: 'orders-db' },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/rds/instances') && url.includes('/actions/') && init?.method === 'POST') {
      const requestUrl = new URL(url, 'http://localhost');
      const dbInstanceIdentifier = requestUrl.pathname.split('/instances/')[1].split('/actions/')[0];
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'AWS RDS DB instance stop requested.',
            database: { id: dbInstanceIdentifier, name: 'orders-db', status: 'stopping', region: 'us-east-1' },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/rds/instances') && url.includes('/snapshots') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'AWS RDS snapshot creation requested.',
            snapshot: { id: body.snapshotIdentifier, name: body.snapshotIdentifier, status: 'creating', region: body.region },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/rds/instances') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'AWS RDS DB instance creation requested.',
            database: { id: body.dbInstanceIdentifier, name: body.dbInstanceIdentifier, status: 'creating', region: body.region, engine: body.engine },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/rds/restore') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'AWS RDS DB instance restore requested.',
            database: { id: body.dbInstanceIdentifier, name: body.dbInstanceIdentifier, status: 'creating', region: body.region },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/aws/rds/instances') && init?.method === 'DELETE') {
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({ data: { message: 'AWS RDS DB instance deletion requested.', database: { id: 'db-123', name: 'orders-db', status: 'deleting', region: 'us-east-1' } } }),
      } as Response);
    }

    if (url.includes('/api/oci/inventory')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: ociInventory }),
      } as Response);
    }

    if (url.includes('/api/oci/resources')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: ociResources }),
      } as Response);
    }

    if (url.includes('/api/oci/all-resources')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: ociAllResourcesData }),
      } as Response);
    }

    if (url.includes('/api/oci/availability-domains')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { generatedAt: '2026-05-15T00:03:30.000Z', region: 'eu-frankfurt-1', availabilityDomains: ['FRA-AD-1'] } }),
      } as Response);
    }

    if (url.includes('/api/oci/launch-options')) {
      const requestUrl = new URL(url, 'http://localhost');
      const networkCompartmentId = requestUrl.searchParams.get('networkCompartmentId') || 'apps';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:03:40.000Z',
            region: requestUrl.searchParams.get('region') || 'eu-frankfurt-1',
            compartmentId: requestUrl.searchParams.get('compartmentId') || 'apps',
            networkCompartmentId,
            availabilityDomains: ['FRA-AD-1'],
            shapes: [],
            images: [],
            subnets: [
              { id: 'subnet-1', name: 'web-subnet', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: networkCompartmentId, compartmentName: 'apps', cidrBlock: '10.0.1.0/24', availabilityDomain: 'regional' },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/dns')) {
      const dnsResponse = {
        generatedAt: '2026-05-24T12:30:00.000Z',
        region: 'eu-frankfurt-1',
        compartmentId: 'apps',
        publicZones: [
          { id: 'public-zone-1', name: 'example.com', status: 'ACTIVE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', providerType: 'dnsZone', resourceType: 'dnsZone', scope: 'GLOBAL', zoneType: 'PRIMARY' },
        ],
        privateZones: [
          { id: 'private-zone-1', name: 'internal.example.oraclevcn.com', status: 'ACTIVE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', providerType: 'dnsZone', resourceType: 'dnsZone', scope: 'PRIVATE', zoneType: 'PRIMARY', viewId: 'dns-view-1' },
        ],
        views: [
          { id: 'dns-view-1', name: 'apps-private-view', status: 'ACTIVE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', providerType: 'dnsView', resourceType: 'dnsView' },
        ],
        records: [
          { id: 'public-zone-1:www.example.com:A:203.0.113.20', name: 'www.example.com', status: 'ACTIVE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', providerType: 'dnsRecord', resourceType: 'dnsRecord', zoneId: 'public-zone-1', zoneName: 'example.com', scope: 'GLOBAL', domain: 'www.example.com', rtype: 'A', rdata: '203.0.113.20', ttl: 300 },
          { id: 'private-zone-1:app.internal.example.oraclevcn.com:A:10.0.1.10', name: 'app.internal.example.oraclevcn.com', status: 'ACTIVE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', providerType: 'dnsRecord', resourceType: 'dnsRecord', zoneId: 'private-zone-1', zoneName: 'internal.example.oraclevcn.com', scope: 'PRIVATE', domain: 'app.internal.example.oraclevcn.com', rtype: 'A', rdata: '10.0.1.10', ttl: 300 },
        ],
        errors: [],
      };
      if (url.includes('/api/oci/dns/views') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message: 'OCI DNS private view creation requested.',
              view: { id: 'dns-view-created-1', name: body.displayName, status: 'ACTIVE', region: body.region, compartmentId: body.compartmentId, compartmentName: 'apps', providerType: 'dnsView', resourceType: 'dnsView' },
            },
          }),
        } as Response);
      }
      if (url.includes('/api/oci/dns/zones/') && url.includes('/records') && (!init?.method || init.method === 'GET')) {
        const zoneId = String(url).split('/zones/')[1].split('/records')[0];
        const records = zoneId === 'private-zone-1'
          ? [dnsResponse.records[1]]
          : [dnsResponse.records[0]];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              generatedAt: '2026-05-24T12:31:00.000Z',
              region: 'eu-frankfurt-1',
              compartmentId: 'apps',
              zoneId,
              zoneName: zoneId === 'private-zone-1' ? 'internal.example.oraclevcn.com' : 'example.com',
              scope: zoneId === 'private-zone-1' ? 'PRIVATE' : 'GLOBAL',
              viewId: zoneId === 'private-zone-1' ? 'dns-view-1' : '',
              records,
              errors: [],
            },
          }),
        } as Response);
      }
      if (url.includes('/api/oci/dns/zones/') && url.includes('/records') && init?.method === 'DELETE') {
        const body = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              message: 'OCI DNS record deletion requested.',
              record: { id: `public-zone-1:${body.domain}:${body.rtype}`, zoneId: 'public-zone-1', domain: body.domain, rtype: body.rtype, status: 'DELETING' },
            },
          }),
        } as Response);
      }
      if (url.includes('/api/oci/dns/zones/') && url.includes('/records') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message: 'OCI DNS record update requested.',
              record: { id: `${String(url).split('/zones/')[1].split('/records')[0]}:${body.domain}:${body.rtype}:${body.rdata}`, name: body.domain, status: 'ACTIVE', region: body.region, compartmentId: body.compartmentId, compartmentName: 'apps', providerType: 'dnsRecord', resourceType: 'dnsRecord', zoneId: String(url).split('/zones/')[1].split('/records')[0], zoneName: body.zoneName, scope: body.scope, viewId: body.viewId, domain: body.domain, rtype: body.rtype, rdata: body.rdata, ttl: Number(body.ttl || 300) },
            },
          }),
        } as Response);
      }
      if (url.includes('/api/oci/dns/zones/') && init?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { message: 'OCI DNS zone deletion requested.', zone: { id: 'public-zone-1', name: 'example.com', status: 'DELETING' } } }),
        } as Response);
      }
      if (url.includes('/api/oci/dns/zones') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message: 'OCI DNS zone creation requested.',
              zone: { id: body.scope === 'PRIVATE' ? 'private-zone-created-1' : 'public-zone-created-1', name: body.name, status: 'ACTIVE', region: body.region, compartmentId: body.compartmentId, compartmentName: 'apps', providerType: 'dnsZone', resourceType: 'dnsZone', scope: body.scope, zoneType: 'PRIMARY', viewId: body.viewId || '' },
            },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: dnsResponse }),
      } as Response);
    }

    if (url.includes('/api/oci/network')) {
      const createdResponse = (key: string, resourceType: string, message: string) => {
        const body = JSON.parse(String(init?.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message,
              [key]: {
                id: `${resourceType}-created-1`,
                name: body.displayName,
                status: 'AVAILABLE',
                region: body.region,
                compartmentId: body.compartmentId,
                compartmentName: 'apps',
                providerType: resourceType,
                resourceType,
                cidrBlock: body.cidrBlock,
                vcnId: body.vcnId,
                rulesCount: key === 'routeTable' || key === 'securityList' ? 1 : 0,
              },
            },
          }),
        } as Response);
      };
      if (url.includes('/api/oci/network/vcns/') && init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { message: 'OCI VCN deletion requested.', vcn: { id: 'vcn-1', status: 'DELETING' } } }) } as Response);
      }
      if (url.includes('/api/oci/network/subnets/') && init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { message: 'OCI subnet deletion requested.', subnet: { id: 'subnet-1', status: 'DELETING' } } }) } as Response);
      }
      if (url.includes('/api/oci/network/vcns') && init?.method === 'POST') return createdResponse('vcn', 'vcn', 'OCI VCN creation requested.');
      if (url.includes('/api/oci/network/subnets') && init?.method === 'POST') return createdResponse('subnet', 'subnet', 'OCI subnet creation requested.');
      if (url.includes('/api/oci/network/gateways') && init?.method === 'POST') return createdResponse('gateway', 'internetGateway', 'OCI gateway creation requested.');
      if (url.includes('/api/oci/network/route-tables') && init?.method === 'POST') return createdResponse('routeTable', 'routeTable', 'OCI route table creation requested.');
      if (url.includes('/api/oci/network/security-lists') && init?.method === 'POST') return createdResponse('securityList', 'securityList', 'OCI security list creation requested.');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-24T12:00:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            vcns: [{ id: 'vcn-1', name: 'prod-vcn', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', providerType: 'vcn', resourceType: 'vcn', cidrBlock: '10.0.0.0/16', dnsLabel: 'prod' }],
            subnets: [{ id: 'subnet-1', name: 'web-subnet', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', providerType: 'subnet', resourceType: 'subnet', cidrBlock: '10.0.1.0/24', vcnId: 'vcn-1' }],
            internetGateways: [{ id: 'igw-1', name: 'prod-igw', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', providerType: 'internetGateway', resourceType: 'internetGateway', vcnId: 'vcn-1' }],
            natGateways: [],
            serviceGateways: [],
            drgs: [{ id: 'drg-1', name: 'prod-drg', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', providerType: 'drg', resourceType: 'drg' }],
            drgAttachments: [{ id: 'drg-attachment-1', name: 'prod-drg-attachment', status: 'ATTACHED', region: 'eu-frankfurt-1', compartmentId: 'apps', providerType: 'drgAttachment', resourceType: 'drgAttachment', vcnId: 'vcn-1', drgId: 'drg-1' }],
            remotePeeringConnections: [{ id: 'rpc-1', name: 'prod-rpc', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', providerType: 'remotePeeringConnection', resourceType: 'remotePeeringConnection', drgId: 'drg-1', peerRegionName: 'me-jeddah-1', peeringStatus: 'PEERED' }],
            routeTables: [{ id: 'rt-1', name: 'prod-routes', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', providerType: 'routeTable', resourceType: 'routeTable', vcnId: 'vcn-1', rulesCount: 1 }],
            securityLists: [{ id: 'sl-1', name: 'prod-security', status: 'AVAILABLE', region: 'eu-frankfurt-1', compartmentId: 'apps', providerType: 'securityList', resourceType: 'securityList', vcnId: 'vcn-1', rulesCount: 1 }],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/databases')) {
      if (url.includes('/api/oci/databases/autonomous/') && url.includes('/actions/') && init?.method === 'POST') {
        const action = String(url).split('/actions/')[1];
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message: `OCI Autonomous Database ${action} requested.`,
              database: { id: 'adb-1', name: 'analytics-adb', status: `${action.toUpperCase()}_REQUESTED`, providerType: 'autonomousDatabase', resourceType: 'autonomousDatabase', region: 'eu-frankfurt-1', compartmentId: 'apps' },
            },
          }),
        } as Response);
      }
      if (url.includes('/api/oci/databases/autonomous/') && url.includes('/clone') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message: 'OCI Autonomous Database clone requested.',
              database: {
                id: 'adb-clone-1',
                name: body.displayName,
                status: 'PROVISIONING',
                region: body.region,
                compartmentId: body.compartmentId,
                compartmentName: 'apps',
                providerType: 'autonomousDatabase',
                resourceType: 'autonomousDatabase',
                dbName: body.dbName,
              },
            },
          }),
        } as Response);
      }
      if (url.includes('/api/oci/databases/autonomous') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message: 'OCI Autonomous Database creation requested.',
              database: {
                id: 'adb-created-1',
                name: body.displayName,
                status: 'PROVISIONING',
                region: body.region,
                compartmentId: body.compartmentId,
                compartmentName: 'apps',
                providerType: 'autonomousDatabase',
                resourceType: 'autonomousDatabase',
                dbName: body.dbName,
                workloadType: body.dbWorkload,
                ocpus: body.computeCount,
                storageSizeGb: Number(body.dataStorageSizeInGBs || (Number(body.dataStorageSizeInTBs || 0) * 1024) || 20),
              },
            },
          }),
        } as Response);
      }
      if (init?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              message: 'OCI Autonomous Database deletion requested.',
              database: { id: String(url).split('/').pop(), name: 'analytics-adb', status: 'DELETING', providerType: 'autonomousDatabase', resourceType: 'autonomousDatabase' },
            },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-24T12:10:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            dbSystems: ociInventory.dbSystems,
            autonomousDatabases: ociInventory.autonomousDatabases,
            autonomousContainerDatabases: ociInventory.autonomousContainerDatabases,
            exadataInfrastructures: ociInventory.exadataInfrastructures,
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/object-storage')) {
      if (url.includes('/api/oci/object-storage/buckets') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              message: 'OCI bucket creation requested.',
              bucket: {
                id: `tenantns/${body.name}`,
                name: body.name,
                region: body.region,
                compartmentId: body.compartmentId,
                compartmentName: 'apps',
                namespace: 'tenantns',
                storageTier: body.storageTier,
                publicAccessType: body.publicAccessType,
                providerType: 'bucket',
                resourceType: 'bucket',
                status: 'ACTIVE',
              },
            },
          }),
        } as Response);
      }
      if (url.includes('/api/oci/object-storage/buckets/') && init?.method === 'DELETE') {
        const bucketName = decodeURIComponent(String(url).split('/').pop() || '');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              message: 'OCI bucket deletion requested.',
              bucket: { id: `tenantns/${bucketName}`, name: bucketName, namespace: 'tenantns', status: 'DELETING' },
            },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-24T10:00:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            namespace: 'tenantns',
            buckets: [
              { id: 'bucket-2', name: 'archive-logs', region: 'eu-frankfurt-1', compartmentId: 'apps', compartmentName: 'apps', namespace: 'tenantns', storageTier: 'Archive', publicAccessType: 'NoPublicAccess', providerType: 'bucket', resourceType: 'bucket' },
            ],
            privateEndpoints: [
              { id: 'object-pe-1', name: 'object-private-endpoint', region: 'eu-frankfurt-1', compartmentId: 'apps', providerType: 'objectPrivateEndpoint', resourceType: 'objectPrivateEndpoint', status: 'ACTIVE', subnetId: 'subnet-1', nsgIds: ['nsg-1'], accessTargetCount: 1 },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/volumes/block/volume-1/resize')) {
      const body = JSON.parse(String(init?.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'OCI volume resize requested.',
            volume: {
              id: 'volume-1',
              name: 'data-volume',
              status: 'AVAILABLE',
              region: body.region || 'eu-frankfurt-1',
              compartmentId: 'apps',
              compartmentName: 'apps',
              providerType: 'blockVolume',
              resourceType: 'blockVolume',
              sizeGb: Number(body.sizeGb),
              availabilityDomain: 'FRA-AD-1',
            },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/volumes/block/backups')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:03:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            volumeId: '',
            backups: [
              {
                id: 'volume-backup-1',
                name: 'data-volume-backup',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'blockVolumeBackup',
                resourceType: 'blockVolumeBackup',
                status: 'AVAILABLE',
                createdAt: '2026-05-15T00:03:00.000Z',
                sizeGb: 100,
                backupType: 'FULL',
                sourceVolumeId: 'volume-1',
              },
              {
                id: 'volume-backup-deleted-1',
                name: 'deleted-data-volume-backup',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'blockVolumeBackup',
                resourceType: 'blockVolumeBackup',
                status: 'TERMINATED',
                createdAt: '2026-05-14T00:03:00.000Z',
                sizeGb: 100,
                backupType: 'FULL',
                sourceVolumeId: 'volume-1',
              },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/volumes/boot/backups')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:04:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            volumeId: '',
            backups: [
              {
                id: 'boot-volume-backup-1',
                name: 'oci-web-1-boot-backup',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'bootVolumeBackup',
                resourceType: 'bootVolumeBackup',
                status: 'AVAILABLE',
                createdAt: '2026-05-15T00:04:00.000Z',
                sizeGb: 50,
                backupType: 'INCREMENTAL',
                sourceVolumeId: 'boot-1',
              },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/volume-groups/volumeGroupBackup')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:05:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            resourceType: 'volumeGroupBackup',
            resources: [
              {
                id: 'volume-group-backup-1',
                name: 'prod-volume-group-backup',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'volumeGroupBackup',
                resourceType: 'volumeGroupBackup',
                status: 'AVAILABLE',
                createdAt: '2026-05-15T00:05:00.000Z',
                sizeGb: 150,
                backupType: 'FULL',
                sourceVolumeGroupId: 'volume-group-1',
              },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/volume-groups/volumeGroupReplica')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:06:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            resourceType: 'volumeGroupReplica',
            resources: [
              {
                id: 'volume-group-replica-1',
                name: 'prod-volume-group-replica',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'volumeGroupReplica',
                resourceType: 'volumeGroupReplica',
                status: 'AVAILABLE',
                createdAt: '2026-05-15T00:06:00.000Z',
                sourceVolumeGroupId: 'volume-group-1',
                availabilityDomain: 'FRA-AD-1',
                destinationRegion: 'me-jeddah-1',
              },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/volume-groups/volumeGroup')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:04:30.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            resourceType: 'volumeGroup',
            resources: [
              {
                id: 'volume-group-1',
                name: 'prod-volume-group',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'volumeGroup',
                resourceType: 'volumeGroup',
                status: 'AVAILABLE',
                createdAt: '2026-05-15T00:04:30.000Z',
                availabilityDomain: 'FRA-AD-1',
                volumeIds: ['volume-1', 'boot-1'],
              },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/file-storage/file-systems') && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'OCI file system creation requested.',
            fileSystem: {
              id: 'file-system-created-1',
              name: payload.displayName,
              region: payload.region,
              compartmentId: payload.compartmentId,
              providerType: 'fileSystem',
              resourceType: 'fileSystem',
              status: 'CREATING',
              createdAt: '2026-05-15T00:11:00.000Z',
              availabilityDomain: payload.availabilityDomain,
            },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/file-storage/mount-targets') && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'OCI mount target creation requested.',
            mountTarget: {
              id: 'mount-target-created-1',
              name: payload.displayName,
              region: payload.region,
              compartmentId: payload.compartmentId,
              providerType: 'mountTarget',
              resourceType: 'mountTarget',
              status: 'CREATING',
              createdAt: '2026-05-15T00:12:00.000Z',
              availabilityDomain: payload.availabilityDomain,
              subnetId: payload.subnetId,
              exportSetId: 'export-set-created-1',
            },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/file-storage')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:07:00.000Z',
            region: 'eu-frankfurt-1',
            compartmentId: 'apps',
            fileSystems: [
              {
                id: 'file-system-1',
                name: 'shared-apps-fs',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'fileSystem',
                resourceType: 'fileSystem',
                status: 'ACTIVE',
                createdAt: '2026-05-15T00:07:00.000Z',
                availabilityDomain: 'FRA-AD-1',
                sizeGb: 10,
              },
            ],
            mountTargets: [
              {
                id: 'mount-target-1',
                name: 'apps-mount-target',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'mountTarget',
                resourceType: 'mountTarget',
                status: 'ACTIVE',
                createdAt: '2026-05-15T00:08:00.000Z',
                availabilityDomain: 'FRA-AD-1',
                subnetId: 'subnet-1',
                exportSetId: 'export-set-1',
              },
            ],
            exports: [
              {
                id: 'export-1',
                name: '/shared-apps',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'export',
                resourceType: 'export',
                status: 'ACTIVE',
                createdAt: '2026-05-15T00:09:00.000Z',
                fileSystemId: 'file-system-1',
                exportSetId: 'export-set-1',
                path: '/shared-apps',
              },
            ],
            snapshots: [
              {
                id: 'snapshot-1',
                name: 'shared-apps-snapshot',
                region: 'eu-frankfurt-1',
                compartmentId: 'apps',
                providerType: 'snapshot',
                resourceType: 'snapshot',
                status: 'ACTIVE',
                createdAt: '2026-05-15T00:10:00.000Z',
                fileSystemId: 'file-system-1',
              },
            ],
            errors: [],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/instances/instance-1') && init?.method === 'PUT') {
      const payload = JSON.parse(String(init.body || '{}'));
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({
          data: {
            message: 'OCI VM configuration update requested.',
            instance: {
              id: 'instance-1',
              name: payload.displayName,
              status: 'RUNNING',
              region: payload.region,
              compartmentId: 'apps',
              compartmentName: 'apps',
              providerType: 'instance',
              resourceType: 'instance',
              shape: payload.shape,
              ocpus: Number(payload.ocpus),
              memoryGb: Number(payload.memoryGb),
              availabilityDomain: 'FRA-AD-1',
              privateIp: '10.0.0.10',
              publicIp: '203.0.113.10',
            },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/oci/instances')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: ociInstances }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/dashboard')) {
      if (pendingDashboard) {
        return new Promise(() => undefined);
      }

      if (dashboardError) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: async () => ({ message: dashboardError }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: dashboard }),
      } as Response);
    }

    if (url.endsWith('/api/notifications')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T08:55:00.000Z',
            summary: { total: 1, unread: 1, critical: 1, warning: 0 },
            notifications: [
              {
                id: 'notification-1',
                createdAt: '2026-05-15T08:55:00.000Z',
                updatedAt: '2026-05-15T08:55:00.000Z',
                type: 'backup-failed',
                severity: 'critical',
                status: 'unread',
                title: 'Backup failed for VM 100',
                message: 'Backup task finished with status error.',
                node: 'pve',
                vmid: 100,
                resourceType: 'qemu',
                taskId: 'UPID:pve:backup',
                source: 'backup',
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/notifications/settings')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            message: init?.method === 'PUT' ? 'Notification settings saved.' : undefined,
            settings: {
              enabled: true,
              minSeverity: 'warning',
              resourceAlerts: {
                enabled: true,
                cpu: { warning: 80, critical: 90 },
                memory: { warning: 80, critical: 90 },
                storage: { warning: 80, critical: 90 },
              },
              email: {
                enabled: false,
                to: '',
                from: '',
                host: '',
                port: 587,
                secure: false,
                username: '',
                passwordPreview: '',
              },
              slack: { enabled: false, webhookPreview: '' },
              teams: { enabled: false, webhookPreview: '' },
              genericWebhook: { enabled: false, webhookPreview: '' },
            },
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/notifications/read-all')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { updated: 1 } }),
      } as Response);
    }

    if (url.endsWith('/api/notifications/notification-1/read')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            notification: {
              id: 'notification-1',
              createdAt: '2026-05-15T08:55:00.000Z',
              updatedAt: '2026-05-15T08:56:00.000Z',
              type: 'backup-failed',
              severity: 'critical',
              status: 'read',
              title: 'Backup failed for VM 100',
              message: 'Backup task finished with status error.',
              node: 'pve',
              vmid: 100,
              resourceType: 'qemu',
              taskId: 'UPID:pve:backup',
              source: 'backup',
            },
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/storage/config')) {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            data: {
              message: 'Storage nfs-backup created.',
              storage: { storage: 'nfs-backup', type: 'nfs', content: 'backup' },
            },
          }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:00:00.000Z',
            config: [
              {
                storage: 'local',
                type: 'dir',
                content: 'images,iso,vztmpl,backup',
                path: '/var/lib/vz',
                shared: 0,
                disable: 0,
              },
            ],
            resources: [{ storage: 'local', node: 'pve', disk: 25, maxdisk: 100 }],
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/nodes/pve/network') && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            message: 'Network vmbr2 created on pve. Apply pending network changes in Proxmox when ready.',
            network: {
              iface: 'vmbr2',
              type: 'bridge',
              active: false,
              autostart: true,
              method: 'manual',
              address: '',
              netmask: '',
              gateway: '',
              bridgePorts: '',
              vlanAware: true,
              comments: 'tenant bridge',
            },
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/nodes/pve/network')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:00:00.000Z',
            interfaces: [
              {
                iface: 'eno1',
                type: 'eth',
                active: true,
                autostart: true,
                method: 'manual',
                address: '',
                netmask: '',
                gateway: '',
                bridgePorts: '',
                vlanAware: false,
                comments: '',
              },
              {
                iface: 'eno2',
                type: 'eth',
                active: false,
                autostart: true,
                method: 'manual',
                address: '',
                netmask: '',
                gateway: '',
                bridgePorts: '',
                vlanAware: false,
                comments: '',
              },
              {
                iface: 'vmbr0',
                type: 'bridge',
                active: true,
                autostart: true,
                method: 'static',
                address: '192.168.1.10',
                netmask: '255.255.255.0',
                gateway: '192.168.1.1',
                bridgePorts: 'eno1',
                vlanAware: false,
                comments: 'management',
              },
            ],
            bridges: [
              { name: 'vmbr0', active: true, autostart: true, method: 'static', comments: '' },
              { name: 'vmbr1', active: false, autostart: false, method: 'manual', comments: '' },
            ],
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/nodes/pve/iso')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:00:00.000Z',
            volumes: [
              { volid: 'local:iso/debian.iso', name: 'debian.iso', storage: 'local', size: 1024, format: 'iso' },
            ],
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/nodes/pve/templates')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:00:00.000Z',
            volumes: [
              {
                volid: 'local:vztmpl/debian-12-standard.tar.zst',
                name: 'debian-12-standard.tar.zst',
                storage: 'local',
                size: 1024,
                format: 'tar.zst',
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/storage/pve/local/content')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T00:00:00.000Z',
            content: [{ volid: 'local:iso/debian.iso', content: 'iso', format: 'iso', size: 1024 }],
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/storage/config/local')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            message: init?.method === 'DELETE' ? 'Storage local configuration deleted.' : 'Storage local updated.',
            storage: { storage: 'local', type: 'dir', content: 'images,iso' },
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/logs/tasks')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T08:50:00.000Z',
            tasks: [
              {
                upid: 'UPID:pve:clone',
                node: 'pve',
                user: 'root@pam',
                type: 'clone',
                id: '205',
                status: 'running',
                exitstatus: '',
                startedAt: '2026-05-15T08:49:46.000Z',
                endedAt: null,
                description: 'VM/CT 205 - Clone',
              },
              {
                upid: 'UPID:pve:console',
                node: 'pve',
                user: 'root@pam',
                type: 'vncproxy',
                id: '109',
                status: 'OK',
                exitstatus: 'OK',
                startedAt: '2026-05-15T08:37:26.000Z',
                endedAt: '2026-05-15T08:38:04.000Z',
                description: 'VM/CT 109 - Console',
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/tasks/') && url.includes('/detail')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T08:50:00.000Z',
            task: {
              upid: 'UPID:pve:clone',
              node: 'pve',
              user: 'root@pam',
              type: 'clone',
              id: '205',
              status: 'stopped',
              exitstatus: 'OK',
              startedAt: '2026-05-15T08:49:46.000Z',
              endedAt: '2026-05-15T08:50:10.000Z',
              description: 'VM/CT 205 - Clone',
            },
            status: { status: 'stopped', exitstatus: 'OK' },
            output: [
              { line: 1, text: 'Logical volume successfully removed.' },
              { line: 2, text: 'TASK OK' },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/logs/cluster')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T08:50:00.000Z',
            entries: [
              {
                id: 'cluster-1',
                time: '2026-05-15T08:48:00.000Z',
                node: 'pve',
                user: 'root@pam',
                priority: 'info',
                message: 'starting task UPID:pve:clone',
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/audit-log')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          entries: [
            {
              id: 'audit-1',
              timestamp: '2026-05-15T08:51:00.000Z',
              action: 'connector-verify',
              status: 'succeeded',
              user: 'admin',
              connectorName: 'Production PVE',
              message: 'Connection verified.',
            },
          ],
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/resources/') && url.includes('/actions/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            action: 'stop',
            success: true,
            taskId: 'UPID:pve:1',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: { status: 'stopped' },
            message: 'stop completed for qemu 100.',
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/resources/') && url.endsWith('/console')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            sessionId: 'console-1',
            websocketPath: '/api/proxmox/console/console-1',
            expiresAt: '2026-05-15T01:00:00.000Z',
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/resources/qemu/pve/100/backups')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            generatedAt: '2026-05-15T09:00:00.000Z',
            backups: [
              {
                volid: 'pbs:backup/vzdump-qemu-100-2026_05_15-09_00_00.vma.zst',
                storage: 'pbs',
                content: 'backup',
                format: 'vma.zst',
                size: 1024,
                createdAt: '2026-05-15T09:00:00.000Z',
                notes: '',
                protected: false,
                vmid: 100,
              },
            ],
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/resources/qemu/pve/100/restore')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            action: 'restore',
            success: true,
            taskId: 'UPID:pve:restore',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: { node: 'pve', vmid: 120, name: 'app-server-restore', type: 'qemu' },
            message: 'Restore completed for VM 120.',
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/vms/') && url.endsWith('/clone')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            action: 'clone',
            success: true,
            taskId: 'UPID:pve:clone',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: { vmid: 120, name: 'app-server-clone' },
            message: 'Clone completed for VM 100 as 120.',
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/vms') && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            action: 'create',
            success: true,
            taskId: 'UPID:pve:create',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: { vmid: 130, name: 'new-vm' },
            message: 'VM 130 created.',
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/containers') && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            action: 'create-container',
            success: true,
            taskId: 'UPID:pve:create-container',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: { vmid: 131, name: 'web-ct' },
            message: 'Container 131 created.',
          },
        }),
      } as Response);
    }

    if (url.includes('/api/proxmox/vms/') && url.endsWith('/template')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            action: 'template',
            success: true,
            taskId: 'UPID:pve:template',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: { vmid: 101, name: 'db-server', template: 1 },
            message: 'VM 101 converted to a template.',
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/resources/qemu/pve/100')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            action: 'delete',
            success: true,
            taskId: 'UPID:pve:delete',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: null,
            message: 'Delete completed for VM 100.',
          },
        }),
      } as Response);
    }

    if (url.endsWith('/api/proxmox/resources/lxc/pve/200')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            action: 'delete',
            success: true,
            taskId: 'UPID:pve:delete-lxc',
            task: { status: 'stopped', exitstatus: 'OK' },
            resource: null,
            message: 'Delete completed for container 200.',
          },
        }),
      } as Response);
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) as jest.Mock;
}

beforeEach(() => {
  jest.resetAllMocks();
});

it('renders the login page when no session exists', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: async () => ({ message: 'Authentication required.' }),
  }) as jest.Mock;

  renderApp();

  expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
});

it('returns to login when a protected request reports an expired session', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    connectors: [verifiedOciConnector],
    selectedOciConnectorId: 'oci-1',
  });
  const authenticatedFetch = global.fetch as jest.Mock;
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/oci/inventory')) {
      return Promise.resolve({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Authentication required.' }),
      } as Response);
    }
    return authenticatedFetch(input, init);
  }) as jest.Mock;

  renderApp();

  await user.click(await screen.findByRole('button', { name: /enter oci/i }));

  expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
});

it('renders connector management in the Connectors tab for an authenticated session without connectors', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({});

  renderApp();

  expect(await screen.findByRole('heading', { name: /choose a cloud environment/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /manage azure connectors/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /enter azure/i })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /manage pve connectors/i }));

  expect(await screen.findByRole('button', { name: /add connector/i })).toBeInTheDocument();
  expect(await screen.findByText(/no connectors saved yet/i)).toBeInTheDocument();
});

it('creates an OCI connector without exposing the private key in the UI', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({});

  renderApp();

  await user.click(await screen.findByRole('button', { name: /manage oci connectors/i }));
  await user.selectOptions(screen.getByLabelText(/provider/i), 'oci');
  await user.type(screen.getByLabelText(/^name/i), 'Production OCI');
  await user.type(screen.getByLabelText(/region/i), 'us-ashburn-1');
  await user.type(screen.getByLabelText(/fingerprint/i), 'aa:bb:cc:dd');
  await user.type(screen.getByLabelText(/tenancy ocid/i), 'ocid1.tenancy.oc1..aaaa');
  await user.type(screen.getByLabelText(/user ocid/i), 'ocid1.user.oc1..bbbb');
  await user.type(screen.getByLabelText(/compartment ocid/i), 'ocid1.compartment.oc1..cccc');
  await user.type(screen.getByLabelText(/api signing private key/i), 'PRIVATE-KEY-CONTENT');

  await user.click(screen.getByRole('button', { name: /add connector/i }));

  expect(await screen.findByText(/connector saved/i)).toBeInTheDocument();
  expect(screen.getAllByText('Production OCI').length).toBeGreaterThan(0);
  expect(screen.getAllByText('OCI').length).toBeGreaterThan(0);
  expect(screen.getByText('us-ashburn-1')).toBeInTheDocument();
  expect(screen.queryByText('PRIVATE-KEY-CONTENT')).not.toBeInTheDocument();

  const createCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/connectors') && options?.method === 'POST',
  );
  expect(createCall).toBeTruthy();
  expect(createCall[1].body).toContain('"provider":"oci"');
  expect(createCall[1].body).toContain('"privateKey":"PRIVATE-KEY-CONTENT"');
});

it('creates an Azure connector without exposing the client secret in the UI', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({});

  renderApp();

  await user.click(await screen.findByRole('button', { name: /manage azure connectors/i }));
  await user.selectOptions(screen.getByLabelText(/provider/i), 'azure');
  await user.type(screen.getByLabelText(/^name/i), 'Production Azure');
  await user.selectOptions(screen.getByLabelText(/cloud environment/i), 'public');
  await user.type(screen.getByLabelText(/tenant id/i), '11111111-1111-1111-1111-111111111111');
  await user.type(screen.getByLabelText(/subscription id/i), '22222222-2222-2222-2222-222222222222');
  await user.type(screen.getByLabelText(/client id/i), '33333333-3333-3333-3333-333333333333');
  await user.type(screen.getByLabelText(/client secret/i), 'AZURE-CLIENT-SECRET');

  await user.click(screen.getByRole('button', { name: /add connector/i }));

  expect(await screen.findByText(/connector saved/i)).toBeInTheDocument();
  expect(screen.getAllByText('Production Azure').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Azure').length).toBeGreaterThan(0);
  expect(screen.queryByText('AZURE-CLIENT-SECRET')).not.toBeInTheDocument();

  const createCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/connectors') && options?.method === 'POST',
  );
  expect(createCall).toBeTruthy();
  expect(createCall[1].body).toContain('"provider":"azure"');
  expect(createCall[1].body).toContain('"azureClientSecret":"AZURE-CLIENT-SECRET"');
});

it('renders OCI overview as a visual dashboard with scoped filters', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);

  expect(await screen.findByRole('heading', { name: /oci dashboard/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /eu-frankfurt-1 \(home\)/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /us-ashburn-1/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/oci dashboard region/i)).toHaveValue('all');
  expect(screen.getByLabelText(/oci dashboard compartment/i)).toHaveValue('all');
  expect(screen.getAllByText('Root tenancy').length).toBeGreaterThan(0);
  expect(screen.getByRole('option', { name: /root tenancy \/ apps/i })).toBeInTheDocument();
  expect(screen.getByText('Resource mix')).toBeInTheDocument();
  expect(screen.getByText('Regional spread')).toBeInTheDocument();
  expect(screen.getByText('Top services')).toBeInTheDocument();
  expect(screen.getByText('Quick access')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /VM Management/i }).length).toBeGreaterThan(0);
  expect(screen.getByText('Provisioned Storage')).toBeInTheDocument();
});

it('renders read-only AWS inventory from the backend cache', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedAwsConnectorId: verifiedAwsConnector.id,
    connectors: [verifiedAwsConnector],
  });

  renderApp();

  await enterAwsEnvironment(user);

  expect(await screen.findByRole('heading', { name: /aws inventory dashboard/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/aws inventory region/i)).toHaveValue('all');
  expect(screen.getByText('Total Resources')).toBeInTheDocument();
  expect(screen.getByText('Resource mix')).toBeInTheDocument();
  expect(screen.getByText('Regional spread')).toBeInTheDocument();
  expect(screen.getByText('Public exposure summary')).toBeInTheDocument();
  expect(screen.getByText('Scan status')).toBeInTheDocument();
  expect(screen.queryByText('EC2 Instances')).not.toBeInTheDocument();
  expect(screen.getAllByText('prod-vpc').length).toBeGreaterThan(0);
  expect(screen.getAllByText('app-data').length).toBeGreaterThan(0);
  expect(screen.getByText('app-artifacts')).toBeInTheDocument();
  expect(screen.getByText('orders-db')).toBeInTheDocument();
  expect(screen.getAllByText('public-alb').length).toBeGreaterThan(0);
  expect(screen.getByText('Users')).toBeInTheDocument();

  await user.click(screen.getAllByRole('button', { name: /ec2 management/i })[0]);

  expect(await screen.findByRole('heading', { name: /ec2 management/i })).toBeInTheDocument();
  expect(screen.getByText('EC2 Instances')).toBeInTheDocument();
  expect(screen.getAllByText('aws-web-1').length).toBeGreaterThan(0);
  expect(screen.getAllByRole('button', { name: /^start$/i }).some((button) => button.hasAttribute('disabled'))).toBe(true);
  expect(screen.getAllByRole('button', { name: /^stop$/i }).some((button) => !button.hasAttribute('disabled'))).toBe(true);
  expect(screen.getAllByRole('button', { name: /^reboot$/i }).some((button) => !button.hasAttribute('disabled'))).toBe(true);

  await user.click(screen.getByRole('button', { name: /^create ec2 instance$/i }));

  expect(await screen.findByRole('heading', { name: /^create ec2 instance$/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/^region$/i)).toHaveValue('us-east-1');
  expect(await screen.findByRole('option', { name: /Amazon Linux 2023/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/^ami image$/i)).toHaveValue('ami-0amazonlinux');
  expect(screen.getByLabelText(/^subnet$/i)).toHaveValue('subnet-123');
  expect(screen.getByLabelText(/^security group$/i)).toHaveValue('sg-123');
  expect(await screen.findByRole('option', { name: /prod-key/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/^key pair$/i)).toHaveValue('prod-key');
  await user.type(screen.getByPlaceholderText('new-key-pair-name'), 'new-key');
  await user.click(screen.getByRole('button', { name: /^create key pair$/i }));
  expect(await screen.findByText(/save now/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/^key pair$/i)).toHaveValue('new-key');
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/aws/inventory'), expect.anything());
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/aws/images?region=us-east-1'), expect.anything());
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/aws/key-pairs?region=us-east-1'), expect.anything());
});

it('renders AWS database management with RDS details and safe actions', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedAwsConnectorId: verifiedAwsConnector.id,
    connectors: [verifiedAwsConnector],
  });

  renderApp();

  await enterAwsEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^database management$/i }));

  expect(await screen.findByRole('heading', { name: /^database management$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /create db instance/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /restore from snapshot/i })).toBeInTheDocument();
  expect(screen.getByText('RDS DB Instances')).toBeInTheDocument();
  expect(screen.getAllByText('orders-db').length).toBeGreaterThan(0);
  expect(screen.getAllByText('postgres').length).toBeGreaterThan(0);
  expect(screen.getByText('16.1')).toBeInTheDocument();
  expect(screen.getAllByText('100 GB').length).toBeGreaterThan(0);
  expect(screen.getByText('orders-db.abc.us-east-1.rds.amazonaws.com')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^start$/i }).some((button) => button.hasAttribute('disabled'))).toBe(true);
  expect(screen.getAllByRole('button', { name: /^stop$/i }).some((button) => !button.hasAttribute('disabled'))).toBe(true);

  await user.click(screen.getByRole('button', { name: /^load snapshots$/i }));
  expect(await screen.findByRole('option', { name: /orders-db-snap/i })).toBeInTheDocument();
  const snapshotsHeading = await screen.findByRole('heading', { name: /^rds snapshots$/i });
  const snapshotsSection = snapshotsHeading.closest('section') as HTMLElement;
  expect(within(snapshotsSection).getAllByText('orders-db-snap').length).toBeGreaterThan(0);
  expect(within(snapshotsSection).getByText('orders-db')).toBeInTheDocument();

  await user.click(within(snapshotsSection).getByRole('button', { name: /^delete$/i }));
  expect(await screen.findByRole('heading', { name: /^delete rds snapshot$/i })).toBeInTheDocument();
  await user.type(screen.getByPlaceholderText('orders-db-snap'), 'orders-db-snap');
  await user.click(screen.getByRole('button', { name: /^delete snapshot$/i }));
  expect(await screen.findByText(/rds snapshot deletion requested/i)).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/aws/rds/snapshots?region=us-east-1'), expect.anything());
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/aws/rds/snapshots/orders-db-snap'), expect.objectContaining({ method: 'DELETE' }));
});

it('renders AWS optimization findings from cached inventory', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedAwsConnectorId: verifiedAwsConnector.id,
    connectors: [verifiedAwsConnector],
  });

  renderApp();

  await enterAwsEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^optimization$/i }));

  expect(await screen.findByRole('heading', { name: /cost & waste insights/i })).toBeInTheDocument();
  expect(screen.getByText('Immediate Cleanup Candidates')).toBeInTheDocument();
  expect(screen.getByText('Retention and Database Review')).toBeInTheDocument();
  expect(screen.getByText('Oversized EC2 Candidates')).toBeInTheDocument();
  expect(screen.getAllByText('aws-stopped-1').length).toBeGreaterThan(0);
  expect(screen.getAllByText('app-data').length).toBeGreaterThan(0);
  expect(screen.getAllByText('public-assets').length).toBeGreaterThan(0);
  expect(screen.getAllByText('198.51.100.21').length).toBeGreaterThan(0);
  expect(screen.getAllByText('archive-db').length).toBeGreaterThan(0);
  expect(screen.getAllByText('aws-big-1').length).toBeGreaterThan(0);

  await user.click(screen.getByRole('button', { name: /^load amis$/i }));
  expect(await screen.findByText('old-custom-ami')).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/aws/images?region=us-east-1'), expect.anything());
});

it('renders all OCI resources with cross-region filters', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^all resources$/i }));

  expect(await screen.findByRole('heading', { name: /^all resources$/i })).toBeInTheDocument();
  expect(await screen.findByText('oci-web-1')).toBeInTheDocument();
  expect(screen.getByLabelText(/inventory freshness/i)).toBeInTheDocument();
  expect(screen.getByText(/Cached .* ago/i)).toBeInTheDocument();
  expect(screen.getByText('data-volume')).toBeInTheDocument();
  expect(screen.getByText('oci-web-1-boot')).toBeInTheDocument();
  expect(screen.getByText('prod-vcn')).toBeInTheDocument();
  expect(screen.getAllByText('web-subnet').length).toBeGreaterThan(0);
  expect(screen.getByText('backups')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /^all regions$/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /^all compartments$/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /^virtual machine$/i })).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/oci/all-resources'), expect.anything());
});

it('shows partial and failed-region freshness for OCI inventory warnings', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
    ociAllResourcesData: {
      ...ociAllResources,
      scan: {
        requestedRegion: 'all',
        homeRegion: 'eu-frankfurt-1',
        scannedRegions: ['eu-frankfurt-1'],
        compartmentScopeId: 'root',
        scannedCompartments: 2,
        scannedResourceCompartments: 1,
        totalResourceCompartments: 2,
        phase: 'Completed with warnings',
        partial: true,
      },
      errors: [
        { scope: 'instances', region: 'us-ashburn-1', message: 'Authorization failed or requested resource not found.' },
      ],
    },
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^all resources$/i }));

  expect((await screen.findAllByText('Partial results')).length).toBeGreaterThan(0);
  expect(screen.getByText('Region failed: us-ashburn-1')).toBeInTheDocument();
  expect(screen.getByText(/resources available/i)).toBeInTheDocument();
});

it('renders OCI optimization findings from cached inventory', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^optimization$/i }));

  expect(await screen.findByRole('heading', { name: /cost & waste insights/i })).toBeInTheDocument();
  expect(screen.getByText('Immediate Cleanup Candidates')).toBeInTheDocument();
  expect(screen.getByText('Oversized VM Candidates')).toBeInTheDocument();
  expect(screen.getByText('Storage and Backup Review')).toBeInTheDocument();
  expect(screen.getAllByText('oci-web-1').length).toBeGreaterThan(0);
  expect(screen.getAllByText('data-volume').length).toBeGreaterThan(0);
  expect(screen.getByText('Estimated from discovered inventory')).toBeInTheDocument();
  expect(screen.getByText('Estimate breakdown')).toBeInTheDocument();
  expect(screen.getAllByText(/\$2\.55\/mo/i).length).toBeGreaterThan(0);
  expect(screen.getByRole('combobox', { name: /optimization compartment/i })).toHaveValue('all');
});

it('edits OCI VM shape configuration from VM management', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^vm management$/i }));
  expect(await screen.findByText('oci-web-1')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^edit configuration$/i }));
  expect(await screen.findByRole('heading', { name: /edit instance configuration/i })).toBeInTheDocument();

  const nameInput = screen.getByLabelText(/^name$/i);
  await user.clear(nameInput);
  await user.type(nameInput, 'oci-web-resized');
  const ocpuInput = screen.getByLabelText(/number of ocpus/i);
  await user.clear(ocpuInput);
  await user.type(ocpuInput, '4');
  const memoryInput = screen.getByLabelText(/amount of memory/i);
  await user.clear(memoryInput);
  await user.type(memoryInput, '32');
  await user.click(screen.getByRole('button', { name: /^save configuration$/i }));

  expect(await screen.findByText('oci-web-resized')).toBeInTheDocument();
  expect(screen.getByText('32')).toBeInTheDocument();
  const updateCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/instances/instance-1') && options?.method === 'PUT',
  );
  expect(updateCall).toBeTruthy();
  expect(updateCall[1].body).toContain('"ocpus":"4"');
  expect(updateCall[1].body).toContain('"memoryGb":"32"');
});

it('renders OCI volume management as separate volume and backup categories', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^volume management$/i }));

  expect(await screen.findByRole('heading', { name: /^block volumes$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^boot volumes$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^block volume backups$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^boot volume backups$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^volume groups$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^volume group backups$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^volume group replicas$/i })).toBeInTheDocument();
  expect(screen.getByText('data-volume')).toBeInTheDocument();
  expect(screen.getByText('oci-web-1-boot')).toBeInTheDocument();
  expect(await screen.findByText('data-volume-backup')).toBeInTheDocument();
  expect(screen.getByText('oci-web-1-boot-backup')).toBeInTheDocument();
  expect(await screen.findByText('prod-volume-group')).toBeInTheDocument();
  expect(screen.getByText('prod-volume-group-backup')).toBeInTheDocument();
  expect(screen.getByText('prod-volume-group-replica')).toBeInTheDocument();
  const deletedBackupRow = screen.getByText('deleted-data-volume-backup').closest('tr');
  expect(deletedBackupRow).not.toBeNull();
  expect(within(deletedBackupRow as HTMLElement).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  expect(within(deletedBackupRow as HTMLElement).getByText('No action')).toBeInTheDocument();

  const volumeRow = screen.getByText('data-volume').closest('tr');
  expect(volumeRow).not.toBeNull();
  await user.click(within(volumeRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^increase storage$/i }));
  const sizeInput = screen.getByLabelText(/^new size gb$/i);
  fireEvent.change(sizeInput, { target: { value: '150' } });
  await user.click(screen.getByRole('button', { name: /^increase storage$/i }));

  await waitFor(() => {
    const resizeCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
      String(url).includes('/api/oci/volumes/block/volume-1/resize') && options?.method === 'PUT',
    );
    expect(resizeCall).toBeTruthy();
  });
  const resizeCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/volumes/block/volume-1/resize') && options?.method === 'PUT',
  );
  expect(resizeCall).toBeTruthy();
  expect(resizeCall[1].body).toContain('"sizeGb":"150"');
});

it('renders OCI object storage as a separate management section', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^object storage$/i }));

  expect(await screen.findByRole('heading', { name: /^object storage & archive storage$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^buckets$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^private endpoints$/i })).toBeInTheDocument();
  expect(screen.getByText('backups')).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText(/filter object storage by region/i), 'eu-frankfurt-1');
  await user.selectOptions(screen.getByLabelText(/filter object storage by compartment/i), 'apps');
  await user.click(screen.getByRole('button', { name: /refresh object storage/i }));

  expect(await screen.findByText('archive-logs')).toBeInTheDocument();
  expect(screen.getByText('object-private-endpoint')).toBeInTheDocument();
  const objectStorageCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
    String(url).includes('/api/oci/object-storage?region=eu-frankfurt-1&compartmentId=apps'),
  );
  expect(objectStorageCall).toBeTruthy();

  await user.click(screen.getByRole('button', { name: /^create bucket$/i }));
  await user.type(screen.getByLabelText(/^bucket name$/i), 'app-logs');
  await user.selectOptions(screen.getByLabelText(/^storage tier$/i), 'Archive');
  await user.click(screen.getAllByRole('button', { name: /^create bucket$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText('app-logs')).toBeInTheDocument();
  const createBucketCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/object-storage/buckets') && options?.method === 'POST',
  );
  expect(createBucketCall).toBeTruthy();
  expect(createBucketCall[1].body).toContain('"name":"app-logs"');

  const createdBucketRow = screen.getByText('app-logs').closest('tr');
  expect(createdBucketRow).not.toBeNull();
  await user.click(within(createdBucketRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^delete bucket$/i }));
  await user.type(screen.getByLabelText(/type bucket name to confirm/i), 'app-logs');
  await user.click(screen.getAllByRole('button', { name: /^delete bucket$/i }).at(-1) as HTMLElement);
  await waitFor(() => expect(screen.queryByText('app-logs')).not.toBeInTheDocument());
  const deleteBucketCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/object-storage/buckets/app-logs') && options?.method === 'DELETE',
  );
  expect(deleteBucketCall).toBeTruthy();
});

it('renders OCI database management as a separate section', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^database$/i }));
  expect(await screen.findByRole('heading', { name: /^oci database$/i })).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText(/filter databases by region/i), 'eu-frankfurt-1');
  await user.selectOptions(screen.getByLabelText(/filter databases by compartment/i), 'apps');
  await user.click(screen.getByRole('button', { name: /refresh databases/i }));

  expect(await screen.findByText('orders-db-system')).toBeInTheDocument();
  expect(screen.getByText('analytics-adb')).toBeInTheDocument();
  expect(screen.getByText('shared-acdb')).toBeInTheDocument();
  expect(screen.getByText('finance-exadata')).toBeInTheDocument();
  const databaseCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
    String(url).includes('/api/oci/databases?region=eu-frankfurt-1&compartmentId=apps'),
  );
  expect(databaseCall).toBeTruthy();

  await user.click(screen.getByRole('button', { name: /^create database$/i }));
  await user.type(screen.getByLabelText(/^display name$/i), 'apps-adb');
  await user.type(screen.getByLabelText(/^database name$/i), 'APPDB');
  await user.type(screen.getByLabelText(/^admin password$/i), 'DbPassword123#');
  await user.type(screen.getByLabelText(/^confirm admin password$/i), 'DbPassword123#');
  await user.click(screen.getAllByRole('button', { name: /^create database$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText('apps-adb')).toBeInTheDocument();
  const createDatabaseCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/databases/autonomous') && options?.method === 'POST',
  );
  expect(createDatabaseCall).toBeTruthy();
  expect(createDatabaseCall[1].body).toContain('"dbName":"APPDB"');

  const adbRow = screen.getByText('analytics-adb').closest('tr');
  expect(adbRow).not.toBeNull();
  await user.click(within(adbRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^terminate$/i }));
  await user.type(screen.getByLabelText(/type database name or ocid to confirm/i), 'analytics-adb');
  await user.click(screen.getAllByRole('button', { name: /^terminate$/i }).at(-1) as HTMLElement);
  await waitFor(() => expect(screen.queryByText('analytics-adb')).not.toBeInTheDocument());
  const deleteDatabaseCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/databases/adb-1') && options?.method === 'DELETE',
  );
  expect(deleteDatabaseCall).toBeTruthy();
});

it('renders OCI network management and creates core network resources', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^network$/i }));
  expect(await screen.findByRole('heading', { name: /^oci network$/i })).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText(/filter network by region/i), 'eu-frankfurt-1');
  await user.selectOptions(screen.getByLabelText(/filter network by compartment/i), 'apps');
  await user.click(screen.getByRole('button', { name: /refresh network/i }));

  expect((await screen.findAllByText('prod-vcn')).length).toBeGreaterThan(0);
  expect(screen.getByRole('region', { name: /network visualizer/i })).toBeInTheDocument();
  expect(screen.getByText(/regional routing map/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/find resource on map/i)).toBeInTheDocument();
  expect(screen.getAllByText('web-subnet').length).toBeGreaterThan(0);
  expect(screen.getByText('prod-drg-attachment')).toBeInTheDocument();
  expect(screen.getAllByText('prod-drg').length).toBeGreaterThan(0);
  expect(screen.getAllByText('prod-rpc').length).toBeGreaterThan(0);
  expect(screen.getByText('prod-igw')).toBeInTheDocument();
  expect(screen.getByText('prod-routes')).toBeInTheDocument();
  expect(screen.getByText('prod-security')).toBeInTheDocument();
  await user.type(screen.getByLabelText(/find resource on map/i), 'rpc');
  expect(screen.getByRole('button', { name: /prod-rpc remotePeeringConnection/i })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /prod-rpc remotePeeringConnection/i }));
  expect(screen.getByText('Remote Peering Connections')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^clear$/i }));

  await user.click(screen.getByRole('button', { name: /^create$/i }));
  await user.click(await screen.findByRole('button', { name: /^create vcn$/i }));
  await user.type(screen.getByLabelText(/^name$/i), 'apps-vcn');
  await user.type(screen.getByLabelText(/^cidr block$/i), '10.1.0.0/16');
  await user.click(screen.getAllByRole('button', { name: /^create$/i }).at(-1) as HTMLElement);
  expect((await screen.findAllByText('apps-vcn')).length).toBeGreaterThan(0);

  const createVcnCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/network/vcns') && options?.method === 'POST',
  );
  expect(createVcnCall).toBeTruthy();
  expect(createVcnCall[1].body).toContain('"cidrBlock":"10.1.0.0/16"');

  await user.click(screen.getByRole('button', { name: /^create$/i }));
  await user.click(await screen.findByRole('button', { name: /^vcn wizard$/i }));
  await user.type(screen.getByLabelText(/^vcn name$/i), 'wizard-vcn');
  await user.click(screen.getByRole('button', { name: /^next$/i }));
  await user.click(screen.getByRole('button', { name: /^next$/i }));
  await user.click(screen.getAllByRole('button', { name: /^create vcn$/i }).at(-1) as HTMLElement);
  expect((await screen.findAllByText('wizard-vcn')).length).toBeGreaterThan(0);
  const wizardSubnetCalls = (global.fetch as jest.Mock).mock.calls.filter(([url, options]) =>
    String(url).includes('/api/oci/network/subnets') && options?.method === 'POST',
  );
  const wizardRouteCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/network/route-tables') && options?.method === 'POST',
  );
  expect(wizardSubnetCalls.length).toBeGreaterThanOrEqual(2);
  expect(wizardRouteCall).toBeTruthy();

  await user.selectOptions(screen.getByLabelText(/filter network by vcn/i), 'vcn-1');
  expect(screen.getByLabelText(/filter network by vcn/i)).toHaveValue('vcn-1');

  const vcnRow = screen.getAllByText('prod-vcn').map((item) => item.closest('tr')).find((row) =>
    row && within(row as HTMLElement).queryAllByText('vcn-1').length > 0,
  );
  expect(vcnRow).not.toBeNull();
  await user.click(within(vcnRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^delete vcn$/i }));
  await user.type(screen.getByLabelText(/type vcn name or ocid/i), 'prod-vcn');
  await user.click(screen.getAllByRole('button', { name: /^delete vcn$/i }).at(-1) as HTMLElement);
  const deleteVcnCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/network/vcns/vcn-1') && options?.method === 'DELETE',
  );
  expect(deleteVcnCall).toBeTruthy();

  const subnetRow = screen.getAllByText('web-subnet').map((item) => item.closest('tr')).find(Boolean);
  expect(subnetRow).not.toBeNull();
  await user.click(within(subnetRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^delete subnet$/i }));
  await user.type(screen.getByLabelText(/type subnet name or ocid/i), 'web-subnet');
  await user.click(screen.getAllByRole('button', { name: /^delete subnet$/i }).at(-1) as HTMLElement);
  const deleteSubnetCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/network/subnets/subnet-1') && options?.method === 'DELETE',
  );
  expect(deleteSubnetCall).toBeTruthy();
});

it('renders OCI DNS management and manages zones, private views, and records', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^dns management$/i }));
  expect(await screen.findByRole('heading', { name: /^oci dns management$/i })).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText(/filter dns by region/i), 'eu-frankfurt-1');
  await user.selectOptions(screen.getByLabelText(/filter dns by compartment/i), 'apps');
  await user.click(screen.getByRole('button', { name: /refresh dns/i }));

  expect((await screen.findAllByText('example.com')).length).toBeGreaterThan(0);
  expect(screen.getAllByText('internal.example.oraclevcn.com').length).toBeGreaterThan(0);
  expect(screen.getByText('apps-private-view')).toBeInTheDocument();
  expect(screen.getByText('www.example.com')).toBeInTheDocument();
  expect(screen.getByText('app.internal.example.oraclevcn.com')).toBeInTheDocument();

  const existingPublicZoneRow = screen.getAllByText('example.com').map((item) => item.closest('tr')).find((row) =>
    row && within(row as HTMLElement).queryByText('public-zone-1'),
  );
  expect(existingPublicZoneRow).not.toBeNull();
  await user.click(within(existingPublicZoneRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^view records$/i }));
  const recordsHeading = await screen.findByRole('heading', { name: /^records for example.com$/i });
  const recordsModal = recordsHeading.closest('section') as HTMLElement;
  expect(recordsModal).toBeTruthy();
  expect(within(recordsModal).getByText('www.example.com')).toBeInTheDocument();
  expect(within(recordsModal).queryByText('app.internal.example.oraclevcn.com')).not.toBeInTheDocument();
  const viewRecordsCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/dns/zones/public-zone-1/records') && (!options?.method || options.method === 'GET'),
  );
  expect(viewRecordsCall).toBeTruthy();

  await user.click(within(recordsModal).getByRole('button', { name: /^close$/i }));
  expect(await screen.findByText('app.internal.example.oraclevcn.com')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^create$/i }));
  await user.click(await screen.findByRole('button', { name: /^create private view$/i }));
  await user.type(screen.getByLabelText(/^view name$/i), 'apps-private-view-new');
  await user.click(screen.getByRole('button', { name: /^create view$/i }));
  expect(await screen.findByText('apps-private-view-new')).toBeInTheDocument();
  const createViewCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/dns/views') && options?.method === 'POST',
  );
  expect(createViewCall).toBeTruthy();
  expect(createViewCall[1].body).toContain('"displayName":"apps-private-view-new"');

  await user.click(screen.getByRole('button', { name: /^create$/i }));
  await user.click(await screen.findByRole('button', { name: /^create public zone$/i }));
  await user.type(screen.getByLabelText(/^zone name$/i), 'apps.example.com');
  await user.click(screen.getByRole('button', { name: /^create zone$/i }));
  expect(await screen.findByText('apps.example.com')).toBeInTheDocument();
  const createPublicZoneCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/dns/zones') && options?.method === 'POST' && String(options.body).includes('"scope":"GLOBAL"'),
  );
  expect(createPublicZoneCall).toBeTruthy();

  const publicZoneRow = screen.getByText('apps.example.com').closest('tr');
  expect(publicZoneRow).not.toBeNull();
  await user.click(within(publicZoneRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^add record$/i }));
  await user.type(screen.getByLabelText(/^domain$/i), 'api.apps.example.com');
  await user.type(screen.getByLabelText(/^value$/i), '203.0.113.25');
  await user.click(screen.getByRole('button', { name: /^add record$/i }));
  expect(await screen.findByText('api.apps.example.com')).toBeInTheDocument();
  const upsertRecordCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/dns/zones/public-zone-created-1/records') && options?.method === 'PUT',
  );
  expect(upsertRecordCall).toBeTruthy();
  expect(upsertRecordCall[1].body).toContain('"rdata":"203.0.113.25"');

  const recordRow = screen.getByText('api.apps.example.com').closest('tr');
  expect(recordRow).not.toBeNull();
  await user.click(within(recordRow as HTMLElement).getByRole('button', { name: /^delete record$/i }));
  let deleteRecordButtons = screen.getAllByRole('button', { name: /^delete record$/i });
  expect(deleteRecordButtons[deleteRecordButtons.length - 1]).toBeDisabled();
  await user.type(screen.getByLabelText(/type the record domain/i), 'api.apps.example.com A');
  deleteRecordButtons = screen.getAllByRole('button', { name: /^delete record$/i });
  await user.click(deleteRecordButtons[deleteRecordButtons.length - 1]);
  await waitFor(() => expect(screen.queryByText('api.apps.example.com')).not.toBeInTheDocument());
  const deleteRecordCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/dns/zones/public-zone-created-1/records') && options?.method === 'DELETE',
  );
  expect(deleteRecordCall).toBeTruthy();
  expect(deleteRecordCall[1].body).toContain('"confirmation":"api.apps.example.com A"');

  await user.click(within(publicZoneRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(await screen.findByRole('button', { name: /^delete zone$/i }));
  expect(screen.getByRole('button', { name: /^delete zone$/i })).toBeDisabled();
  await user.type(screen.getByLabelText(/type zone name or ocid/i), 'apps.example.com');
  await user.click(screen.getByRole('button', { name: /^delete zone$/i }));
  await waitFor(() => expect(screen.queryByText('apps.example.com')).not.toBeInTheDocument());
  const deleteZoneCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).includes('/api/oci/dns/zones/public-zone-created-1') && options?.method === 'DELETE',
  );
  expect(deleteZoneCall).toBeTruthy();
});

it('renders OCI file system management categories for a selected scope', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    selectedOciConnectorId: verifiedOciConnector.id,
    connectors: [verifiedConnector, verifiedOciConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterOciEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^file system management$/i }));
  await user.selectOptions(screen.getByLabelText(/filter file systems by region/i), 'eu-frankfurt-1');
  await user.selectOptions(screen.getByLabelText(/filter file systems by compartment/i), 'apps');
  await user.click(screen.getByRole('button', { name: /refresh file systems/i }));

  expect(await screen.findByRole('heading', { name: /^file systems$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^mount targets$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^exports$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^snapshots$/i })).toBeInTheDocument();
  expect(await screen.findByText('shared-apps-fs')).toBeInTheDocument();
  expect(screen.getByText('apps-mount-target')).toBeInTheDocument();
  expect(screen.getAllByText('/shared-apps').length).toBeGreaterThan(0);
  expect(screen.getByText('shared-apps-snapshot')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^create file system$/i }));
  await user.type(screen.getByLabelText(/^name$/i), 'created-shared-fs');
  await user.click(screen.getAllByRole('button', { name: /^create file system$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText('created-shared-fs')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^create mount target$/i }));
  await user.type(screen.getByLabelText(/^name$/i), 'created-mount-target');
  await user.selectOptions(screen.getByLabelText(/^subnet compartment$/i), 'apps');
  expect(await screen.findByRole('option', { name: /web-subnet/i })).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText(/^subnet$/i), 'subnet-1');
  await user.click(screen.getAllByRole('button', { name: /^create mount target$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText('created-mount-target')).toBeInTheDocument();
});

it('does not load resources until the selected connector is verified', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: 'connector-1',
    connectors: [{ ...verifiedConnector, status: 'ready', selected: true }],
  });

  renderApp();

  await enterPveEnvironment(user);
  expect(await screen.findByText(/verify the selected connector to load resources/i)).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/proxmox/dashboard'), expect.anything());
});

it('renders dashboard summaries, charts, and resource tables for a verified connector', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  expect(await screen.findByText('Production PVE')).toBeInTheDocument();
  expect(await screen.findByText(/all servers healthy/i)).toBeInTheDocument();
  expect(screen.getByText('app-server')).toBeInTheDocument();
  expect(screen.getByText('ubuntu-template')).toBeInTheDocument();
  expect(screen.getByText('nginx')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /nodes/i })).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { name: /virtual machines/i }).length).toBeGreaterThan(0);
  expect(screen.getByRole('heading', { name: /virtual machine templates/i })).toBeInTheDocument();
  expect(screen.getByText(/resource consumption/i)).toBeInTheDocument();
  expect(screen.getByText(/cpu usage/i)).toBeInTheDocument();
  expect(screen.getByText(/memory usage/i)).toBeInTheDocument();
  expect(screen.getByText(/storage usage/i)).toBeInTheDocument();
});

it('renders empty chart and table states', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: {
      ...fullDashboard,
      charts: { cpu: [], memory: [], storage: [], status: fullDashboard.charts.status.map((item) => ({ ...item, value: 0 })) },
      resources: { nodes: [], vms: [], vmTemplates: [], containers: [], storage: [], allCompute: [] },
    },
  });

  renderApp();

  await enterPveEnvironment(user);
  expect(await screen.findByText(/resource consumption/i)).toBeInTheDocument();
  expect(screen.getByText(/cpu usage/i)).toBeInTheDocument();
  expect(screen.getByText(/memory usage/i)).toBeInTheDocument();
  expect(screen.getByText(/storage usage/i)).toBeInTheDocument();
  expect(screen.getByText(/no nodes found/i)).toBeInTheDocument();
  expect(screen.getByText(/no virtual machine templates found/i)).toBeInTheDocument();
});

it('renders loading and error dashboard states', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    pendingDashboard: true,
  });

  const { unmount } = render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );

  await enterPveEnvironment(user);
  expect(await screen.findByText(/loading proxmox resources/i)).toBeInTheDocument();
  unmount();

  const errorUser = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboardError: 'Unable to reach Proxmox.',
  });

  renderApp();

  await enterPveEnvironment(errorUser);
  expect(await screen.findByText(/unable to reach proxmox/i)).toBeInTheDocument();
});

it('renders operation button states and confirms disruptive actions', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));

  const runningRow = await selectVmManagerRow(user, 'app-server');
  expect(runningRow).toBeTruthy();
  expect(within(runningRow).getByText('20%')).toBeInTheDocument();
  expect(within(runningRow).getByText('25%')).toBeInTheDocument();
  expect(within(runningRow).getByText('04:12:09')).toBeInTheDocument();
  expect(vmToolbar().getByRole('button', { name: /^boot$/i })).toBeDisabled();
  expect(vmToolbar().getByRole('button', { name: /^power off$/i })).toBeEnabled();
  expect(vmToolbar().getByRole('button', { name: /^restart$/i })).toBeEnabled();
  expect(vmToolbar().getByRole('button', { name: 'Shutdown' })).toBeEnabled();
  expect(vmToolbar().getByRole('button', { name: 'Suspend' })).toBeEnabled();

  const stoppedRow = await selectVmManagerRow(user, 'db-server');
  expect(stoppedRow).toBeTruthy();
  expect(vmToolbar().getByRole('button', { name: /^boot$/i })).toBeEnabled();
  expect(vmToolbar().getByRole('button', { name: /^power off$/i })).toBeDisabled();
  expect(vmToolbar().getByRole('button', { name: 'Template' })).toBeEnabled();

  await selectVmManagerRow(user, 'app-server');
  expect(vmToolbar().getByRole('button', { name: 'Template' })).toBeDisabled();

  const containerRow = await selectContainerManagerRow(user, 'nginx');
  expect(containerRow).toBeTruthy();
  expect(within(containerRow).getByText('10%')).toBeInTheDocument();
  expect(within(containerRow).getByText('50%')).toBeInTheDocument();
  expect(within(containerRow).getByText('01:00:00')).toBeInTheDocument();
  expect(containerToolbar().getByRole('button', { name: /^boot$/i })).toBeDisabled();
  expect(containerToolbar().getByRole('button', { name: /^power off$/i })).toBeEnabled();
  expect(containerToolbar().getByRole('button', { name: /^restart$/i })).toBeEnabled();
  expect(containerToolbar().getByRole('button', { name: 'Shutdown' })).toBeEnabled();
  expect(containerToolbar().getByRole('button', { name: 'Suspend' })).toBeDisabled();

  await user.click(vmToolbar().getByRole('button', { name: /^power off$/i }));
  expect(await screen.findByRole('heading', { name: /confirm operation/i })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText(/stop completed for qemu 100/i)).toBeInTheDocument();
});

it('renders storage management as a separate tab and opens content view', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^storage$/i }));

  expect(await screen.findByRole('heading', { name: /storage configuration/i })).toBeInTheDocument();
  expect(await screen.findByText('local')).toBeInTheDocument();
  expect(screen.getByText('images,iso,vztmpl,backup')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^add storage$/i }));
  expect(await screen.findByRole('heading', { name: /new storage configuration/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'btrfs' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'esxi' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'glusterfs' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'iscsidirect' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'zfs' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^close$/i }));

  const storageRow = screen.getByText('images,iso,vztmpl,backup').closest('tr');
  expect(storageRow).toBeTruthy();
  await user.click(within(storageRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(screen.getByRole('button', { name: /^content$/i }));
  expect(await screen.findByRole('heading', { name: /local on pve/i })).toBeInTheDocument();
  expect(await screen.findByText('local:iso/debian.iso')).toBeInTheDocument();
});

it('requires matching storage ID before deleting storage configuration', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^storage$/i }));
  expect(await screen.findByText('local')).toBeInTheDocument();

  const storageRow = screen.getByText('images,iso,vztmpl,backup').closest('tr');
  expect(storageRow).toBeTruthy();
  await user.click(within(storageRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(screen.getByRole('button', { name: /^delete$/i }));
  expect(await screen.findByRole('heading', { name: /^local$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^delete storage$/i })).toBeDisabled();

  await user.type(screen.getByLabelText(/type storage id/i), 'wrong');
  expect(screen.getByRole('button', { name: /^delete storage$/i })).toBeDisabled();

  await user.clear(screen.getByLabelText(/type storage id/i));
  await user.type(screen.getByLabelText(/type storage id/i), 'local');
  expect(screen.getByRole('button', { name: /^delete storage$/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: /^delete storage$/i }));
  expect(await screen.findByText(/storage local configuration deleted/i)).toBeInTheDocument();

  const deleteCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/storage/config/local') && options?.method === 'DELETE',
  );
  expect(deleteCall).toBeTruthy();
  expect(deleteCall[1].body).toContain('"confirmation":"local"');
});

it('creates a Linux bridge from the Network tab', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^network$/i }));
  expect(await screen.findByRole('heading', { name: /node network configuration/i })).toBeInTheDocument();
  expect(await screen.findByText('vmbr0')).toBeInTheDocument();
  expect(screen.getAllByText('eno1').length).toBeGreaterThan(0);

  await user.click(screen.getByRole('button', { name: /^add network$/i }));
  expect(await screen.findByRole('heading', { name: /new linux bridge on pve/i })).toBeInTheDocument();

  const bridgeInput = screen.getByLabelText(/bridge name/i);
  await user.clear(bridgeInput);
  await user.type(bridgeInput, 'vmbr0');
  await user.click(screen.getByRole('button', { name: /^create network$/i }));
  expect((await screen.findAllByText(/interface vmbr0 already exists/i)).length).toBeGreaterThan(0);

  await user.clear(bridgeInput);
  await user.type(bridgeInput, 'vmbr2');
  await user.selectOptions(screen.getByLabelText(/bridge ports/i), 'eno2');
  await user.click(screen.getByLabelText(/vlan aware bridge/i));
  await user.type(screen.getByLabelText(/comments/i), 'tenant bridge');
  await user.click(screen.getByRole('button', { name: /^create network$/i }));

  expect(await screen.findByText(/network vmbr2 created on pve/i)).toBeInTheDocument();
  const createCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/nodes/pve/network') && options?.method === 'POST',
  );
  expect(createCall).toBeTruthy();
  expect(createCall[1].body).toContain('"iface":"vmbr2"');
  expect(createCall[1].body).toContain('"bridgePorts":"eno2"');
  expect(createCall[1].body).toContain('"vlanAware":true');
});

it('submits isolated bridge creation with bridgePorts none', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^network$/i }));
  await user.click(await screen.findByRole('button', { name: /^add network$/i }));

  const bridgeInput = screen.getByLabelText(/bridge name/i);
  await user.clear(bridgeInput);
  await user.type(bridgeInput, 'vmbr2');
  await user.selectOptions(screen.getByLabelText(/bridge ports/i), 'none');
  await user.click(screen.getByRole('button', { name: /^create network$/i }));

  const createCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/nodes/pve/network') && options?.method === 'POST',
  );
  expect(createCall).toBeTruthy();
  expect(createCall[1].body).toContain('"bridgePorts":"none"');
});

it('requires confirmation before converting a stopped VM to a template', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  const stoppedRow = await selectVmManagerRow(user, 'db-server');
  expect(stoppedRow).toBeTruthy();

  await user.click(vmToolbar().getByRole('button', { name: 'Template' }));
  expect(await screen.findByRole('heading', { name: /db-server on pve/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^convert to template$/i })).toBeDisabled();

  await user.type(screen.getByLabelText(/type vm name or vm id/i), 'wrong');
  expect(screen.getByRole('button', { name: /^convert to template$/i })).toBeDisabled();

  await user.clear(screen.getByLabelText(/type vm name or vm id/i));
  await user.type(screen.getByLabelText(/type vm name or vm id/i), 'db-server');
  expect(screen.getByRole('button', { name: /^convert to template$/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: /^convert to template$/i }));
  expect(await screen.findByText(/vm 101 converted to a template/i)).toBeInTheDocument();

  const templateCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/vms/pve/101/template') && options?.method === 'POST',
  );
  expect(templateCall).toBeTruthy();
  expect(templateCall[1].body).toContain('"confirmation":"db-server"');
});

it('launches a noVNC console session from the Operations tab', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  const runningRow = await selectVmManagerRow(user, 'app-server');
  expect(runningRow).toBeTruthy();

  await user.click(vmToolbar().getByRole('button', { name: /^vnc$/i }));

  expect(await screen.findByRole('heading', { name: /app-server on pve/i })).toBeInTheDocument();
  expect(screen.getByText(/vm console/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /fullscreen/i })).toBeInTheDocument();
  expect(JSON.stringify((global.fetch as jest.Mock).mock.calls)).not.toContain('super-secret-token');
});

it('validates and submits the VM clone modal from the Operations tab', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  const runningRow = await selectVmManagerRow(user, 'app-server');
  expect(runningRow).toBeTruthy();

  await user.click(vmToolbar().getByRole('button', { name: 'Clone' }));
  expect(await screen.findByRole('heading', { name: /app-server on pve/i })).toBeInTheDocument();

  const vmIdInput = screen.getByLabelText(/new vm id/i);
  await user.clear(vmIdInput);
  await user.type(vmIdInput, '101');
  await user.click(screen.getByRole('button', { name: /^clone vm$/i }));
  expect(await screen.findByText(/vm id 101 is already in use/i)).toBeInTheDocument();

  await user.clear(vmIdInput);
  await user.type(vmIdInput, '120');
  await user.click(screen.getByRole('button', { name: /^clone vm$/i }));
  expect(await screen.findByText(/clone completed for vm 100 as 120/i)).toBeInTheDocument();

  const cloneCall = (global.fetch as jest.Mock).mock.calls.find(([url]) => String(url).endsWith('/api/proxmox/vms/pve/100/clone'));
  expect(cloneCall).toBeTruthy();
  expect(cloneCall[1].body).toContain('"newid":120');
  expect(cloneCall[1].body).toContain('"storage":"local"');
});

it('restores a VM backup as a new VM ID with confirmation', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  const runningRow = await selectVmManagerRow(user, 'app-server');
  expect(runningRow).toBeTruthy();

  await user.click(vmToolbar().getByRole('button', { name: 'History' }));
  expect(await screen.findByRole('heading', { name: /app-server on pve/i })).toBeInTheDocument();
  expect(await screen.findByText(/vzdump-qemu-100/i)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^restore$/i }));
  expect((await screen.findAllByRole('heading', { name: /app-server/i })).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('button', { name: /^restore$/i }).at(-1) as HTMLElement).toBeDisabled();

  await user.click(screen.getByLabelText(/new vm\/ct id/i));
  const targetId = screen.getAllByLabelText(/target vm\/ct id/i)[0];
  await user.clear(targetId);
  await user.type(targetId, '120');
  const targetName = screen.getByLabelText(/target vm\/ct name/i);
  await user.clear(targetName);
  await user.type(targetName, 'app-server-restore');
  await user.type(screen.getByLabelText(/^type target vm\/ct id/i), '120');
  expect(screen.getAllByRole('button', { name: /^restore$/i }).at(-1) as HTMLElement).toBeEnabled();

  await user.click(screen.getAllByRole('button', { name: /^restore$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText(/restore completed for vm 120/i)).toBeInTheDocument();

  const restoreCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
    String(url).endsWith('/api/proxmox/resources/qemu/pve/100/restore'),
  );
  expect(restoreCall).toBeTruthy();
  expect(restoreCall[1].body).toContain('"restoreMode":"new"');
  expect(restoreCall[1].body).toContain('"targetVmid":120');
  expect(restoreCall[1].body).toContain('"targetName":"app-server-restore"');
  expect(restoreCall[1].body).toContain('"confirmation":"120"');
  expect(restoreCall[1].body).toContain('"force":false');
});

it('validates and submits the create VM modal from the Operations tab', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  await user.click(await screen.findByRole('button', { name: /^create vm$/i }));

  expect(await screen.findByRole('heading', { name: /new virtual machine/i })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: /vmbr1/i })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: /debian.iso/i })).toBeInTheDocument();
  const vmIdInput = screen.getByLabelText(/vm id/i);
  await user.clear(vmIdInput);
  await user.type(vmIdInput, '101');
  await user.click(screen.getAllByRole('button', { name: /^create vm$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText(/vm id 101 is already in use/i)).toBeInTheDocument();

  await user.clear(vmIdInput);
  await user.type(vmIdInput, '130');
  await user.type(screen.getByLabelText(/^vm name/i), 'new-vm');
  await user.click(screen.getAllByRole('button', { name: /^create vm$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText(/vm 130 created/i)).toBeInTheDocument();

  const createCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/vms') && options?.method === 'POST',
  );
  expect(createCall).toBeTruthy();
  expect(createCall[1].body).toContain('"vmid":130');
  expect(createCall[1].body).toContain('"name":"new-vm"');
  expect(createCall[1].body).toContain('"storage":"local"');
});

it('validates and submits the create container modal from the Operations tab', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  await user.click(await screen.findByRole('button', { name: /^create container$/i }));

  expect(await screen.findByRole('heading', { name: /new lxc container/i })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: /vmbr1/i })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: /debian-12-standard/i })).toBeInTheDocument();

  const containerIdInput = screen.getByLabelText(/container id/i);
  await user.clear(containerIdInput);
  await user.type(containerIdInput, '200');
  await user.click(screen.getAllByRole('button', { name: /^create container$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText(/vm\/ct id 200 is already in use/i)).toBeInTheDocument();

  await user.clear(containerIdInput);
  await user.type(containerIdInput, '131');
  await user.type(screen.getByLabelText(/^hostname/i), 'web-ct');
  await user.click(screen.getAllByRole('button', { name: /^create container$/i }).at(-1) as HTMLElement);
  expect(await screen.findByText(/container 131 created/i)).toBeInTheDocument();

  const createCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/containers') && options?.method === 'POST',
  );
  expect(createCall).toBeTruthy();
  expect(createCall[1].body).toContain('"vmid":131');
  expect(createCall[1].body).toContain('"hostname":"web-ct"');
  expect(createCall[1].body).toContain('"template":"local:vztmpl/debian-12-standard.tar.zst"');
  expect(createCall[1].body).toContain('"storage":"local"');
});

it('requires a matching VM name or ID before deleting a VM', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  const runningRow = await selectVmManagerRow(user, 'app-server');
  expect(runningRow).toBeTruthy();

  await user.click(vmToolbar().getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('heading', { name: /app-server on pve/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^delete vm$/i })).toBeDisabled();

  await user.type(screen.getByLabelText(/type vm name or id/i), 'wrong');
  expect(screen.getByRole('button', { name: /^delete vm$/i })).toBeDisabled();

  await user.clear(screen.getByLabelText(/type vm name or id/i));
  await user.type(screen.getByLabelText(/type vm name or id/i), 'app-server');
  expect(screen.getByRole('button', { name: /^delete vm$/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: /^delete vm$/i }));
  expect(await screen.findByText(/delete completed for vm 100/i)).toBeInTheDocument();

  const deleteCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/resources/qemu/pve/100') && options?.method === 'DELETE',
  );
  expect(deleteCall).toBeTruthy();
  expect(deleteCall[1].body).toContain('"confirmation":"app-server"');
  expect(deleteCall[1].body).toContain('"force":false');
});

it('requires a matching container name or ID before deleting a container', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^operations$/i }));
  const containerRow = await selectContainerManagerRow(user, 'nginx');
  expect(containerRow).toBeTruthy();

  await user.click(containerToolbar().getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('heading', { name: /nginx on pve/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^delete container$/i })).toBeDisabled();

  await user.type(screen.getByLabelText(/type container name or id/i), 'nginx');
  expect(screen.getByRole('button', { name: /^delete container$/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: /^delete container$/i }));
  expect(await screen.findByText(/delete completed for container 200/i)).toBeInTheDocument();

  const deleteCall = (global.fetch as jest.Mock).mock.calls.find(([url, options]) =>
    String(url).endsWith('/api/proxmox/resources/lxc/pve/200') && options?.method === 'DELETE',
  );
  expect(deleteCall).toBeTruthy();
  expect(deleteCall[1].body).toContain('"confirmation":"nginx"');
});

it('renders live Proxmox task and cluster log views', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^job center$/i }));

  expect(await screen.findByText('VM/CT 205 - Clone')).toBeInTheDocument();
  expect(screen.getByText('VM/CT 109 - Console')).toBeInTheDocument();
  expect(screen.getByText('aws-ec2-start aws-web-1')).toBeInTheDocument();
  expect(screen.getByText('50% progress')).toBeInTheDocument();
  expect(screen.getAllByText(/running/i).length).toBeGreaterThan(0);

  await user.click(screen.getByRole('button', { name: /cluster log/i }));
  expect(await screen.findByText('starting task UPID:pve:clone')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /audit log/i }));
  expect(await screen.findByText('connector-verify')).toBeInTheDocument();
  expect(screen.getByText('Production PVE')).toBeInTheDocument();
});

it('opens a task viewer with output and status details', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^job center$/i }));
  expect(await screen.findByText('VM/CT 205 - Clone')).toBeInTheDocument();

  const cloneTaskRow = screen.getByText('VM/CT 205 - Clone').closest('tr');
  expect(cloneTaskRow).toBeTruthy();
  await user.click(within(cloneTaskRow as HTMLElement).getByRole('button', { name: /^actions$/i }));
  await user.click(screen.getByRole('button', { name: /^view logs$/i }));
  expect(await screen.findByText('Task viewer')).toBeInTheDocument();
  expect(await screen.findByText(/TASK OK/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^download$/i })).toBeEnabled();
  expect(screen.getByRole('button', { name: /^stop$/i })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: /^status$/i }));
  expect(await screen.findByText('Exit status')).toBeInTheDocument();
  expect(screen.getAllByText('OK').length).toBeGreaterThan(0);
});

it('renders notifications and delivery settings', async () => {
  const user = userEvent.setup();
  mockAuthenticatedApp({
    selectedConnectorId: verifiedConnector.id,
    connectors: [verifiedConnector],
    dashboard: fullDashboard,
  });

  renderApp();

  await enterPveEnvironment(user);
  await user.click(await screen.findByRole('button', { name: /^notifications/i }));

  expect(await screen.findByRole('heading', { name: /operational alerts/i })).toBeInTheDocument();
  expect(screen.getAllByText('Backup failed for VM 100').length).toBeGreaterThan(0);
  expect(screen.getByText('Resource alert thresholds')).toBeInTheDocument();
  expect(screen.getAllByDisplayValue('80').length).toBeGreaterThan(0);
  expect(screen.getByText('Email')).toBeInTheDocument();
  expect(screen.getByText('Slack webhook')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^acknowledge$/i }));
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/notifications/notification-1/read'),
    expect.objectContaining({ method: 'PATCH' }),
  );

  await user.click(screen.getByRole('button', { name: /^save notification settings$/i }));
  expect(await screen.findByText(/notification settings saved/i)).toBeInTheDocument();
});


