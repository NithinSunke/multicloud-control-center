import { useEffect, useMemo, useState } from 'react';
import type { ResourceRecord } from '../types/dashboard';

type Column = {
  key: keyof ResourceRecord;
  label: string;
};

type ResourceTableProps = {
  title: string;
  rows: ResourceRecord[];
  columns: Column[];
  emptyText: string;
  onView?: (row: ResourceRecord) => void;
  filterColumns?: Array<{
    key: keyof ResourceRecord;
    label: string;
    allLabel?: string;
  }>;
};

function labelForValue(key: keyof ResourceRecord, value: string) {
  if (key === 'providerType' || key === 'resourceType') {
    const labels: Record<string, string> = {
      instance: 'Virtual Machine',
      blockVolume: 'Block Volume',
      bootVolume: 'Boot Volume',
      vcn: 'VCN',
      subnet: 'Subnet',
      bucket: 'Bucket',
      ec2Instance: 'EC2 Instance',
      securityGroup: 'Security Group',
      routeTable: 'Route Table',
      internetGateway: 'Internet Gateway',
      natGateway: 'NAT Gateway',
      ebsVolume: 'EBS Volume',
      ebsSnapshot: 'EBS Snapshot',
      s3Bucket: 'S3 Bucket',
      rdsDatabase: 'RDS Database',
      loadBalancer: 'Load Balancer',
      elasticIp: 'Elastic IP',
      iamSummary: 'IAM Summary',
      vnet: 'VNet',
      networkSecurityGroup: 'Network Security Group',
      publicIp: 'Public IP',
      appService: 'App Service',
      functionApp: 'Function App',
      containerApp: 'Container App',
      storageAccount: 'Storage Account',
      sqlServer: 'SQL Server',
      sqlDatabase: 'SQL Database',
      cosmosDbAccount: 'Cosmos DB Account',
      virtualMachine: 'Virtual Machine',
      managedDisk: 'Managed Disk',
      snapshot: 'Snapshot',
      image: 'Image',
      restorePointCollection: 'Restore Point Collection',
      restorePoint: 'Restore Point',
      project: 'Project',
      region: 'Region',
      zone: 'Zone',
      vpcNetwork: 'VPC Network',
      firewallRule: 'Firewall Rule',
      route: 'Route',
      cloudRouter: 'Cloud Router / NAT',
      externalIp: 'External IP',
      computeInstance: 'Compute Engine VM',
      disk: 'Disk',
      storageBucket: 'Cloud Storage Bucket',
      sqlInstance: 'Cloud SQL Instance',
      gkeCluster: 'GKE Cluster',
      serviceAccount: 'Service Account',
    };
    return labels[value] || value;
  }
  return value;
}

function valueFor(row: ResourceRecord, key: keyof ResourceRecord) {
  const value = row[key];
  if (typeof value === 'number') {
    if (key === 'cpu') {
      return `${Math.round(value * 100)}%`;
    }
    if (key === 'mem' || key === 'maxmem' || key === 'disk' || key === 'maxdisk') {
      return `${Math.round(value / 1024 / 1024 / 1024)} GB`;
    }
  }
  if (value === undefined || value === null || value === '') {
    return '-';
  }
  return labelForValue(key, String(value));
}

export function ResourceTable({ title, rows, columns, emptyText, onView, filterColumns = [] }: ResourceTableProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<keyof ResourceRecord>(columns[0]?.key || 'name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const statuses = useMemo(
    () => Array.from(new Set(rows.map((row) => row.status).filter(Boolean))) as string[],
    [rows],
  );
  const filterOptions = useMemo(
    () => filterColumns.map((filter) => ({
      ...filter,
      values: Array.from(new Set(rows.map((row) => row[filter.key]).filter(Boolean).map(String))).sort((left, right) =>
        labelForValue(filter.key, left).localeCompare(labelForValue(filter.key, right), undefined, { sensitivity: 'base' }),
      ),
    })),
    [filterColumns, rows],
  );

  useEffect(() => {
    if (statusFilter !== 'all' && !statuses.includes(statusFilter)) {
      setStatusFilter('all');
      setPage(1);
    }
  }, [statusFilter, statuses]);

  useEffect(() => {
    setColumnFilters((current) => {
      let changed = false;
      const next = { ...current };
      for (const [key, value] of Object.entries(current)) {
        const filter = filterOptions.find((item) => String(item.key) === key);
        if (value !== 'all' && filter && !filter.values.includes(value)) {
          next[key] = 'all';
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setPage(1);
  }, [filterOptions]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (statusFilter !== 'all' && row.status !== statusFilter) {
          return false;
        }
        for (const [key, value] of Object.entries(columnFilters)) {
          if (value !== 'all' && String(row[key as keyof ResourceRecord] ?? '') !== value) {
            return false;
          }
        }
        if (!normalizedQuery) {
          return true;
        }
        return Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => {
        const leftValue = left[sortKey] ?? '';
        const rightValue = right[sortKey] ?? '';
        const comparison = String(leftValue).localeCompare(String(rightValue), undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        return sortDirection === 'asc' ? comparison : -comparison;
      });
  }, [columnFilters, query, rows, sortDirection, sortKey, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filtersActive = Boolean(query.trim()) || statusFilter !== 'all' || Object.values(columnFilters).some((value) => value !== 'all');

  function sortBy(key: keyof ResourceRecord) {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection('asc');
  }

  return (
    <section className="pm-panel overflow-hidden p-0">
      <div className="flex flex-col gap-3 border-b border-slate-200 bg-gradient-to-r from-white to-cyan-50 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-950">{title}</h3>
          <p className="mt-1 text-xs font-medium text-slate-500">{filteredRows.length} resources shown</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <input
            className="pm-input"
            placeholder="Search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
          <select
            className="pm-input"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          {filterOptions.map((filter) => (
            <select
              className="pm-input"
              key={String(filter.key)}
              value={columnFilters[String(filter.key)] || 'all'}
              onChange={(event) => {
                setColumnFilters((current) => ({
                  ...current,
                  [String(filter.key)]: event.target.value,
                }));
                setPage(1);
              }}
            >
              <option value="all">{filter.allLabel || `All ${filter.label.toLowerCase()}`}</option>
              {filter.values.map((value) => (
                <option key={value} value={value}>
                  {labelForValue(filter.key, value)}
                </option>
              ))}
            </select>
          ))}
          <select
            className="pm-input"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            <option value={10}>10 rows</option>
            <option value={25}>25 rows</option>
            <option value={50}>50 rows</option>
          </select>
          {filtersActive ? (
            <button
              className="pm-button px-3 py-2 text-sm"
              onClick={() => {
                setQuery('');
                setStatusFilter('all');
                setColumnFilters({});
                setPage(1);
              }}
              type="button"
            >
              Clear Filters
            </button>
          ) : null}
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <div className="px-4 py-8 text-sm text-slate-600">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="pm-table" data-pagination-managed="react">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={String(column.key)}>
                    <button className="font-semibold" onClick={() => sortBy(column.key)} type="button">
                      {column.label}
                      {sortKey === column.key ? ` ${sortDirection === 'asc' ? '^' : 'v'}` : ''}
                    </button>
                  </th>
                ))}
                {onView ? <th>Details</th> : null}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, index) => (
                <tr key={`${row.id || row.vmid || row.name || row.node}-${index}`}>
                  {columns.map((column) => (
                    <td key={String(column.key)}>
                      {valueFor(row, column.key)}
                    </td>
                  ))}
                  {onView ? (
                    <td>
                      <button className="pm-button pm-button-compact" onClick={() => onView(row)} type="button">
                        View
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        <span>
          Page {currentPage} of {totalPages}
        </span>
        <div className="flex gap-2">
          <button
            className="pm-button px-3 py-1.5 text-xs"
            disabled={currentPage === 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className="pm-button px-3 py-1.5 text-xs"
            disabled={currentPage === totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            type="button"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
