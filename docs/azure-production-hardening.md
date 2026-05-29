# Azure Production Hardening

## Least Privilege Roles

Use a dedicated app registration/service principal per environment. Assign roles at the smallest practical scope, usually the resource group.

- Read-only inventory: `Reader`
- VM lifecycle: `Virtual Machine Contributor`
- VM disks and snapshots: `Disk Snapshot Contributor` or `Contributor` scoped to the resource group
- Network operations: `Network Contributor`
- Storage account and blob operations: `Storage Account Contributor` plus data-plane role such as `Storage Blob Data Contributor`
- Azure SQL operations: `SQL DB Contributor`
- Cosmos DB operations: `Cosmos DB Account Contributor`

Avoid subscription-wide `Owner` except for short bootstrap tasks. Remove it after role assignment is complete.

## Rate Limits and Retry Behavior

Azure Resource Manager calls use retry with exponential backoff for HTTP `429`, HTTP `5xx`, timeout, and transient connection reset errors. The app keeps scans cache-backed so the UI can read PostgreSQL without live Azure calls until the user starts a scan.

## Permission Diagnostics

When Azure returns an RBAC failure, the backend normalizes the error and shows the denied action and target scope. Fix the role assignment, wait a few minutes for RBAC propagation, then retry the operation.

## Secret Rotation

1. Create a new client secret in the Azure app registration.
2. Update the Azure connector in Multi Cloud Manager.
3. Verify the connector.
4. Delete the old client secret from Azure only after the app verifies successfully.

Connector secrets are stored only on the backend and encrypted at rest. Raw secrets must not be returned to the frontend or written to logs.

## Connector Data Backup and Restore

Back up PostgreSQL together with the encryption key used by the backend. A database backup without the matching encryption key cannot decrypt connector secrets.

Recommended backup items:

- PostgreSQL dump or volume snapshot
- Backend environment file or secret manager values
- Connector encryption key
- Docker Compose configuration

## Paid Resource Guardrails

Creation of billable resources should stay guarded by explicit user confirmation and backend feature flags. Keep VM creation, public IP/NAT gateway creation, and paid database creation disabled by default in production until governance approves them.
