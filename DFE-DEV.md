# DFE Development Guide

Quick reference for developing against the DFE fork of HyperDX.

## Prerequisites

Same as upstream HyperDX — see [CLAUDE.md](CLAUDE.md) for the full development
setup. The only difference is the Docker Compose invocation.

## Starting Infrastructure (FerretDB + ClickHouse)

The DFE compose override replaces MongoDB with FerretDB + PostgreSQL.

### Development (API runs locally, infra in Docker)

```bash
# Start ClickHouse + FerretDB (replaces mongo)
docker compose -f docker-compose.dev.yml -f docker-compose.dfe.yml up -d

# API and frontend run locally as normal
yarn dev
```

FerretDB binds to `localhost:27017` — the same port as upstream MongoDB. The
existing `MONGO_URI` in `.env.development` works as-is for unauthenticated
local dev. For authenticated connections:

```
MONGO_URI=mongodb://hyperdx:hyperdx@localhost:27017/hyperdx?authMechanism=PLAIN
```

### Production (all services in Docker)

```bash
docker compose -f docker-compose.yml -f docker-compose.dfe.yml up -d
```

The `app` service `MONGO_URI` is automatically overridden in
`docker-compose.dfe.yml`.

## Architecture

See [DFE-ARCHITECTURE.md](DFE-ARCHITECTURE.md) for the full design document
covering FerretDB, OIDC, Casbin RBAC, and the additive-only fork strategy.

## Branch

All DFE work is on the `dfe/pg-rbac-oidc` branch.

## FerretDB Notes

- FerretDB translates MongoDB wire protocol to SQL via PostgreSQL + DocumentDB
- The HyperDX application code is **completely unchanged**
- Mongoose, connect-mongo, passport-local-mongoose all work through FerretDB
- The PostgreSQL instance also serves as the backing store for Casbin RBAC
  policies (shared with the DFE Python UI)
- FerretDB image: `ghcr.io/ferretdb/ferretdb:2.7.0`
- PostgreSQL image: `ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0`

## Environment Files

| File | Purpose |
| --- | --- |
| `.env` | Upstream defaults (image versions, ports) |
| `.env.dfe` | DFE overrides (Casbin PG URL, auth mode) |
| `packages/api/.env.development` | Local API dev config |
| `docker-compose.dfe.yml` | DFE compose override |
