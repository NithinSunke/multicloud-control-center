# MultiCloud Control Center (MC3)

MultiCloud Control Center is a production-oriented web application for managing private cloud and public cloud resources from one authenticated control plane.

The app currently supports Proxmox VE, Oracle Cloud Infrastructure, AWS, Azure, and GCP. It is designed around secure connector management, cached cloud inventory, operational workflows, job tracking, audit logging, and an ops-focused UI.

## What You Can Do With This App

- Sign in with app-owned administrator authentication.
- Store cloud connectors securely on the backend.
- Verify cloud connections before using them.
- Switch between cloud environments from a landing dashboard.
- Discover and cache cloud inventory in PostgreSQL.
- View dashboards, tables, filters, charts, and relationship maps.
- Manage compute, storage, network, database, DNS, backup, and object storage workflows where implemented.
- Track operations through provider job centers and audit logs.
- Use safety confirmation for destructive operations.
- Run the app locally or through Docker Compose.

## Supported Platforms

### Proxmox VE

- Connector management using password or API token authentication.
- Resource dashboard for nodes, virtual machines, containers, storage, CPU, memory, and uptime.
- VM and container actions: start, shutdown, stop, reboot, suspend where supported.
- noVNC console session creation through the backend.
- VM clone, delete, template conversion, backup, restore, and backup scheduler workflows.
- Storage configuration management.
- Network management including bridges, Linux network config, SDN zones, VNets, IPAM, apply configuration, and active/inactive state handling.
- Task viewer, live task logs, retry/cancel where supported, and audit logging.

### Oracle Cloud Infrastructure

- OCI connector management and verification.
- Region and compartment discovery with parent/child compartment selection.
- PostgreSQL-backed cached inventory for faster UI loading.
- Resources include instances, boot volumes, block volumes, backups, VCNs, subnets, gateways, DRGs, DNS zones, file systems, object storage, databases, and images.
- VM operations: start, stop, reboot, terminate, create custom image, move resource, create instance, resize shape.
- Volume management: boot volumes, block volumes, backups, restore, clone, resize, delete with safety checks.
- File storage, object storage, network, DNS, DRG, database, optimization, and relationship visualizer sections.

### AWS

- AWS connector management and verification.
- Cached inventory for regions, EC2, VPC, subnets, route tables, security groups, gateways, EBS, snapshots, S3, RDS, load balancers, Elastic IPs, and IAM summary.
- AWS dashboard and EC2 management.
- EC2 operations: create, start, stop, reboot, terminate, create AMI, change instance type, attach/detach volumes, view tags and IPs.
- EBS and S3 storage management, including bucket objects.
- VPC/network management, route tables, security group rules, internet/NAT gateways, and network visualizer.
- RDS list, create, start/stop where supported, snapshots, restore, and delete with safety confirmation.
- Optimization findings and AWS job/audit tracking.

### Azure

- Azure connector management using tenant ID, subscription ID, client ID, and client secret.
- Cached inventory for subscriptions, resource groups, regions, VNets, subnets, route tables, NSGs, public IPs, load balancers, app services, function apps, container apps, storage accounts, SQL, Cosmos DB, VMs, disks, snapshots, and tags.
- Azure dashboard with charts, scan status, region/resource group selectors, and compact resource tables.
- VM management: create, start, stop/deallocate, restart, resize, image/restore point, refresh status, delete, and audit entries.
- Storage management: storage accounts, blob containers, blobs, managed disks, snapshots, file shares, uploads, deletes, restore, and cache updates.
- Network management: VNets, subnets, route tables, routes, NSGs, NSG rules, public IPs, load balancers, NAT gateways, and private endpoints.
- Database management for Azure SQL, Cosmos DB, PostgreSQL flexible servers, and MySQL flexible servers where implemented.
- Optimization, job center, audit, and relationship views.

### GCP

- GCP connector management using service account project ID, client email, and encrypted private key.
- Cached inventory for projects, regions, zones, VPC networks, subnets, firewall rules, routes, Cloud NAT/routers, external IPs, Compute Engine VMs, disks, snapshots, images, buckets, Cloud SQL, GKE, service accounts, tags, and labels.
- GCP dashboard with resource totals, compute state, network/storage/database counts, charts, scan status, and public exposure summary.
- Compute management: create VM, start, stop, reset, delete, create machine image, disk snapshot, resize machine type, attach/detach disks, labels, networks, and IPs.
- Storage management: persistent disks and Cloud Storage buckets/objects.
- Network management: VPCs, subnets, firewall rules, routes, and external IPs.
- Cloud SQL management, optimization, job center, audit, and relationship view foundations.

## Application Architecture

```text
proxmox-manager/
├── frontend/
│   ├── src/
│   │   ├── components/        Reusable UI components, tables, drawers, consoles
│   │   ├── context/           App authentication context
│   │   ├── pages/             Login and main application views
│   │   ├── services/          Frontend API clients for backend routes
│   │   └── types/             TypeScript application types
│   ├── nginx.conf             Production static frontend proxy config
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── config/            Environment validation
│   │   ├── controllers/       HTTP handlers
│   │   ├── middleware/        Auth, validation, request context, errors
│   │   ├── routes/            API route definitions
│   │   ├── schemas/           Zod validation schemas
│   │   ├── services/          Provider clients, caches, jobs, audit, connectors
│   │   └── utils/             Logging and shared helpers
│   ├── data/                  Runtime connector/audit data volume, ignored by Git
│   └── package.json
├── docs/                      Production and hardening notes
├── Dockerfile                 Multi-stage frontend/backend Docker build
├── docker-compose.yml         Local production-like stack
└── README.md
```

## Runtime Architecture

```text
Browser
  |
  | HTTP-only cookie session
  v
Frontend container
  |
  | /api/* requests
  v
Backend Express API
  |
  +-- Auth/session validation
  +-- Connector secret encryption/decryption
  +-- Provider API clients
  +-- Job tracking and audit logging
  +-- Inventory cache reads/writes
  |
  v
PostgreSQL inventory cache
  |
  v
Cloud provider APIs
  Proxmox VE | OCI | AWS | Azure | GCP
```

The frontend never calls Proxmox, OCI, AWS, Azure, or GCP directly. All provider calls go through the backend so credentials remain server-side.

## Data Flow

1. Admin signs in to MC3.
2. Admin creates one or more cloud connectors.
3. Connector secrets are encrypted and stored only by the backend.
4. Admin verifies the connector.
5. Admin scans inventory when needed.
6. Backend fetches provider data, normalizes it, and stores the result in PostgreSQL.
7. UI reads cached inventory by default for faster loading.
8. Operations such as start, stop, resize, delete, backup, restore, and create submit backend jobs.
9. Job status and audit history are updated after each operation.

## Security Model

- App-owned admin authentication.
- HTTP-only cookie sessions.
- No auth tokens in browser localStorage.
- Connector secrets are encrypted at rest.
- Raw cloud secrets are never returned to the frontend.
- Secrets are decrypted only in memory during provider request execution.
- Zod input validation is used for API request payloads.
- Centralized error handling normalizes API failures.
- Structured logging redacts passwords, secrets, tokens, authorization headers, cookies, and private key material.
- Destructive actions require confirmation in the UI and backend validation.

## Inventory and Performance Model

The app uses PostgreSQL as the inventory cache for cloud discovery data. This avoids scanning every provider every time a page opens.

- Normal page loads read from the cache.
- Scans run only when explicitly requested.
- Scan status can show cached, running, partial, failed, and last scan time.
- Operations update affected cached records where implemented.
- Region, compartment, resource group, project, VCN/VPC, and resource filters are used to reduce UI noise.

## Backend API Areas

Main API groups:

- `/api/auth` - login, logout, current session
- `/api/connectors` - create, edit, delete, select, and verify connectors
- `/api/proxmox` - Proxmox inventory, operations, backups, console, storage, network, SDN, tasks
- `/api/oci` - OCI inventory, compute, storage, network, DNS, databases, object storage, file storage, optimization, resource maps
- `/api/aws` - AWS inventory, EC2, EBS, S3, VPC, RDS, optimization, jobs, network maps
- `/api/azure` - Azure inventory, compute, storage, networking, databases, jobs
- `/api/gcp` - GCP inventory, compute, storage, networking, Cloud SQL, jobs
- `/api/notifications` - alert settings and notification state

## Tech Stack

- Frontend: React, TypeScript, Vite, Tailwind CSS
- UI patterns: compact tables, filters, dropdown actions, detail drawers, relationship graphs
- Backend: Node.js, Express
- Validation: Zod
- Authentication: HTTP-only cookie sessions
- Database: PostgreSQL
- Testing: Jest, React Testing Library, Vitest, Supertest
- Deployment: Docker multi-stage build and Docker Compose

## Local Development

```powershell
Copy-Item .env.example .env

cd backend
npm install
npm run dev

cd ../frontend
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:4000`

## Docker Deployment

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:8080
```

Default local credentials:

- Username: `admin`
- Password: `change-me-in-production`

Change these before production use.

## Environment Variables

Important variables:

- `ADMIN_USERNAME` - local admin username
- `ADMIN_PASSWORD` - local development password fallback
- `ADMIN_PASSWORD_HASH` - production bcrypt password hash
- `JWT_SECRET` - session signing secret
- `ENCRYPTION_KEY` - connector secret encryption key
- `COOKIE_SECURE` - set to `true` behind HTTPS
- `DATABASE_URL` - PostgreSQL connection string
- `DATA_DIR` - backend runtime data directory
- `GCP_ALLOW_PAID_VM_CREATE` - guardrail for GCP VM creation

Use long random values for `JWT_SECRET` and `ENCRYPTION_KEY`. Keep a secure backup of `ENCRYPTION_KEY`; encrypted connector data cannot be restored without it.

## Backup and Restore

Connector metadata and audit files live in the backend data volume. Inventory data lives in PostgreSQL.

Backup:

```powershell
docker compose stop backend
docker run --rm -v multi-cloud-manager_backend-data:/data -v ${PWD}:/backup alpine tar czf /backup/mc3-backend-data.tgz -C /data .
docker compose exec -T postgres pg_dump -U multi_cloud_manager multi_cloud_manager > mc3-postgres.sql
docker compose start backend
```

Restore:

```powershell
docker compose stop backend
docker run --rm -v multi-cloud-manager_backend-data:/data -v ${PWD}:/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/mc3-backend-data.tgz -C /data"
Get-Content .\mc3-postgres.sql | docker compose exec -T postgres psql -U multi_cloud_manager multi_cloud_manager
docker compose start backend
```

## Validation Commands

Backend:

```powershell
cd backend
npm test
```

Frontend:

```powershell
cd frontend
npm test -- --runInBand
npm run build
```

Docker:

```powershell
docker compose build
docker compose up -d
```

## Production Notes

- Run behind HTTPS and set `COOKIE_SECURE=true`.
- Use `ADMIN_PASSWORD_HASH`, not plain `ADMIN_PASSWORD`, for production.
- Rotate provider credentials periodically.
- Use least-privilege cloud IAM roles where possible.
- Keep backups of PostgreSQL and backend data together.
- Treat every delete/terminate action as irreversible unless the cloud provider has its own recovery mechanism.
- Validate paid-resource guardrails before enabling create operations in production.
