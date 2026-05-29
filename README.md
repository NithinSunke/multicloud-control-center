# Multi Cloud Manager

Production-oriented Multi Cloud Manager web app with app-owned authentication, secure connector storage, resource dashboards, VM operations, storage management, console access, task logs, and audit logging.

## Stack

- Frontend: React, TypeScript, Vite, Tailwind CSS, React Context
- Backend: Node.js, Express, app-owned authentication, HTTP-only cookie sessions
- Tests: Jest + React Testing Library for frontend, Vitest + Supertest for backend
- Docker: Multi-stage frontend/backend build with Docker Compose

## Authentication

This phase uses app-owned authentication only. Proxmox credentials are not used for login.

Default local credentials:

- Username: `admin`
- Password: `change-me-in-production`

Use `ADMIN_PASSWORD_HASH` in production. `ADMIN_PASSWORD` is intended for local development only.

## Proxmox API Layer

All Proxmox calls go through the backend. The frontend should call only this app's `/api/*` routes.

Backend Proxmox service routes include:

- `GET /api/proxmox/nodes`
- `GET /api/proxmox/vms`
- `GET /api/proxmox/containers`
- `GET /api/proxmox/storage`
- `GET /api/proxmox/storage/config`
- `POST /api/proxmox/storage/config`
- `PUT /api/proxmox/storage/config/:storage`
- `DELETE /api/proxmox/storage/config/:storage`
- `GET /api/proxmox/storage/:node/:storage/content`
- `GET /api/proxmox/resources/:type/:node/:vmid/status`
- `POST /api/proxmox/resources/:type/:node/:vmid/start`
- `POST /api/proxmox/resources/:type/:node/:vmid/stop`
- `POST /api/proxmox/vms/:node/:vmid/clone`
- `DELETE /api/proxmox/resources/:type/:node/:vmid`
- `POST /api/proxmox/resources/:type/:node/:vmid/novnc`
- `GET /api/proxmox/tasks/:node/:upid`
- `GET /api/proxmox/tasks/:node/:upid/detail`
- `DELETE /api/proxmox/tasks/:node/:upid`

If `connectorId` is omitted, these routes use the selected connector. Connector secrets are decrypted only in memory during request execution and are never returned in API responses.

## Storage Management

The Storage tab lists Proxmox storage configuration, reported usage, and content for the selected verified connector. It supports create, edit, and delete for Proxmox storage configuration entries.

Deleting storage in this app removes the Proxmox storage configuration entry. It does not intentionally remove VM disks, ISO files, backups, or other data from the underlying storage location.

## Audit and Hardening

The Logs page includes an admin Audit log tab. It records login/logout, connector create/update/delete/verify, VM and container actions, clone/delete, storage create/update/delete, console sessions, and task-stop requests.

Security controls in the backend:

- HTTP-only cookie sessions; no auth tokens in browser storage.
- Helmet secure headers and a per-request `X-Request-Id`.
- Zod validation for auth, connector, resource, task, clone, and delete inputs.
- Central error handling for unhandled route errors and validation failures.
- Structured JSON logging with redaction for password, token, secret, ticket, authorization, and cookie fields.
- Audit entries are sanitized before writing to disk.

## Encrypted Data Backup and Restore

Connector data is stored under `DATA_DIR` in `proxmox-connectors.json`. Audit entries are stored in `audit-log.json`. OCI inventory snapshots and resource discovery rows are stored in PostgreSQL using `DATABASE_URL`. Connector secrets are encrypted with `ENCRYPTION_KEY`; the connector data file cannot be restored without the same key.

Backup:

```powershell
docker compose stop backend
docker run --rm -v multi-cloud-manager_backend-data:/data -v ${PWD}:/backup alpine tar czf /backup/multi-cloud-manager-data-backup.tgz -C /data .
docker compose exec -T postgres pg_dump -U multi_cloud_manager multi_cloud_manager > oci-inventory.sql
docker compose start backend
```

Restore:

```powershell
docker compose stop backend
docker run --rm -v multi-cloud-manager_backend-data:/data -v ${PWD}:/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/multi-cloud-manager-data-backup.tgz -C /data"
Get-Content .\oci-inventory.sql | docker compose exec -T postgres psql -U multi_cloud_manager multi_cloud_manager
docker compose start backend
```

Keep a separate secure copy of the exact `ENCRYPTION_KEY` used for the backup.

## Secret Rotation

- `ADMIN_PASSWORD_HASH`: generate a new bcrypt hash, update the environment, restart the backend, then confirm login. Prefer this over `ADMIN_PASSWORD`.
- `JWT_SECRET`: rotate to invalidate all active app sessions. Users must sign in again.
- `ENCRYPTION_KEY`: this protects saved Proxmox connector secrets. To rotate it safely, keep the old key available, export or recreate connector credentials, update `ENCRYPTION_KEY`, restart, then re-enter and verify each connector secret. Do not delete the old key until all connectors are verified.
- Proxmox API tokens: rotate in Proxmox first, then update the connector in this app and run Verify.
- `COOKIE_SECURE`: set to `true` when serving the app through HTTPS. Keep it `false` only for local HTTP testing.

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

## Docker

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open `http://localhost:8080`.

## Validation Commands

```powershell
cd backend
npm test

cd ../frontend
npm test -- --runInBand
npm run build

cd ..
docker compose build
docker compose up -d
```
