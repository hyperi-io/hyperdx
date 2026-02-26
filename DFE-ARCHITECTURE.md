# DFE Platform — Embedded HyperDX Architecture

Architecture documentation for HyperDX as embedded within the DFE platform.

HyperDX v2 is an open-source observability frontend built on ClickHouse. Within
DFE, it serves as the **visualization and search layer** — engineers use it to
search logs, view traces, build dashboards, and replay sessions. Detection,
alerting, and response workflows are handled by the DFE platform's own rules
engine and hunt system.

DFE embeds HyperDX with an **additive-only fork strategy**: authentication is
handled externally via OIDC through Envoy, authorization is enforced by Casbin
(shared with the DFE Python UI), and MongoDB is replaced by FerretDB backed by
PostgreSQL. The HyperDX application code is left untouched to preserve clean
upstream merge compatibility.

This document is a combination of the following:  

- Derek's original
  - HyperDX-DF-Embed.pptx and docx
  - Embedding code from devex
  - DFE casbin RBAC code
- Summary review of the HyperDX code base

---

## Table of Contents

- [DFE Platform — Embedded HyperDX Architecture](#dfe-platform--embedded-hyperdx-architecture)
  - [Table of Contents](#table-of-contents)
  - [High-Level System Architecture](#high-level-system-architecture)
  - [Production Deployment: FerretDB and PostgreSQL](#production-deployment-ferretdb-and-postgresql)
    - [Why FerretDB](#why-ferretdb)
    - [Architecture with FerretDB](#architecture-with-ferretdb)
    - [Production Docker Compose](#production-docker-compose)
    - [Full Production Service Topology](#full-production-service-topology)
    - [What Stays the Same](#what-stays-the-same)
  - [Monorepo Structure](#monorepo-structure)
  - [Data Flow](#data-flow)
    - [Write Path (Telemetry Ingestion)](#write-path-telemetry-ingestion)
    - [Read Path (Query Execution)](#read-path-query-execution)
    - [Alert Evaluation (Disabled in DFE — See DFE Rules and Hunts)](#alert-evaluation-disabled-in-dfe--see-dfe-rules-and-hunts)
  - [Service Topology](#service-topology)
  - [Frontend Architecture](#frontend-architecture)
  - [Backend Architecture](#backend-architecture)
  - [Schema-Agnostic Design](#schema-agnostic-design)
  - [ClickHouse Data Model](#clickhouse-data-model)
  - [OTel Collector \& OpAMP](#otel-collector--opamp)
  - [Key Integrations](#key-integrations)
    - [Session Replay](#session-replay)
    - [Dashboards](#dashboards)
    - [Saved Searches](#saved-searches)
    - [AI Assistant](#ai-assistant)
  - [DFE: External OIDC Authentication](#dfe-external-oidc-authentication)
    - [Current Auth Model](#current-auth-model)
    - [Target Auth Model](#target-auth-model)
    - [Auth Flow with Envoy and OIDC](#auth-flow-with-envoy-and-oidc)
    - [Changes Required in HyperDX](#changes-required-in-hyperdx)
      - [1. New Auth Middleware: Trusted Header Authentication](#1-new-auth-middleware-trusted-header-authentication)
      - [2. User Auto-Provisioning](#2-user-auto-provisioning)
      - [3. Multi-Tenancy Fix](#3-multi-tenancy-fix)
      - [4. Team → ClickHouse User Mapping](#4-team--clickhouse-user-mapping)
      - [5. Disable or Gate Legacy Auth Routes](#5-disable-or-gate-legacy-auth-routes)
      - [6. Frontend Adjustments](#6-frontend-adjustments)
      - [Summary of New Config](#summary-of-new-config)
  - [DFE: Authorization with Casbin](#dfe-authorization-with-casbin)
    - [Why Casbin](#why-casbin)
    - [RBAC Model with Tenants](#rbac-model-with-tenants)
    - [Policy Storage in PostgreSQL](#policy-storage-in-postgresql)
      - [Shared Enforcer Pattern: Python Manages, Node.js Enforces](#shared-enforcer-pattern-python-manages-nodejs-enforces)
    - [Integration with Envoy OIDC and HyperDX](#integration-with-envoy-oidc-and-hyperdx)
      - [Express Middleware Chain](#express-middleware-chain)
    - [Policy Examples](#policy-examples)
      - [Viewer Can Read Dashboards But Not Create Alerts](#viewer-can-read-dashboards-but-not-create-alerts)
      - [Editor Can Manage Dashboards and Alerts But Not Connections](#editor-can-manage-dashboards-and-alerts-but-not-connections)
      - [Admin Has Full Access](#admin-has-full-access)
      - [User-Role Assignments (Group Definitions)](#user-role-assignments-group-definitions)
      - [HyperDX Resource-to-Route Mapping](#hyperdx-resource-to-route-mapping)
  - [DFE: Alerting — Disabled in Favour of DFE Rules and Hunts](#dfe-alerting--disabled-in-favour-of-dfe-rules-and-hunts)
    - [What Gets Disabled](#what-gets-disabled)
    - [How to Disable](#how-to-disable)
    - [Why Not Remove the Code?](#why-not-remove-the-code)
    - [DFE Rules and Hunts Replace Alerting](#dfe-rules-and-hunts-replace-alerting)
  - [DFE: Additive-Only Feasibility Assessment](#dfe-additive-only-feasibility-assessment)
    - [Per-Work-Stream Breakdown](#per-work-stream-breakdown)
      - [FerretDB: Fully Additive](#ferretdb-fully-additive)
      - [OIDC Identity Middleware: Effectively Additive](#oidc-identity-middleware-effectively-additive)
      - [Casbin RBAC: Fully Additive](#casbin-rbac-fully-additive)
      - [Multi-Tenancy: Additive With a Caveat](#multi-tenancy-additive-with-a-caveat)
      - [Alerting: Fully Additive (Disabled, Not Removed)](#alerting-fully-additive-disabled-not-removed)
      - [Frontend: Zero to Minimal Changes](#frontend-zero-to-minimal-changes)
    - [Honest Summary](#honest-summary)
  - [DFE: FerretDB vs Direct PostgreSQL Migration](#dfe-ferretdb-vs-direct-postgresql-migration)
    - [Option 1: FerretDB (Recommended)](#option-1-ferretdb-recommended)
    - [Option 2: Direct PostgreSQL Migration (Native)](#option-2-direct-postgresql-migration-native)
      - [Scope of a Direct Migration](#scope-of-a-direct-migration)
      - [The Fork Problem](#the-fork-problem)
      - [When Direct PostgreSQL Makes Sense](#when-direct-postgresql-makes-sense)
    - [Recommendation](#recommendation)
  - [DFE: Fork Strategy — Additive-Only Changes](#dfe-fork-strategy--additive-only-changes)
    - [Why This Matters](#why-this-matters)
    - [The Additive Pattern](#the-additive-pattern)
    - [Implementation: File-by-File](#implementation-file-by-file)
      - [1. New Files (zero conflict risk)](#1-new-files-zero-conflict-risk)
      - [2. Minimal Wiring (one file, one conditional block)](#2-minimal-wiring-one-file-one-conditional-block)
      - [3. Auth Middleware: Wrap, Don't Replace](#3-auth-middleware-wrap-dont-replace)
      - [4. Casbin Enforcement: Additive Middleware Layer](#4-casbin-enforcement-additive-middleware-layer)
      - [5. Multi-Tenancy: Additive Override](#5-multi-tenancy-additive-override)
    - [Merge Strategy](#merge-strategy)
    - [Summary: What Changes per Layer](#summary-what-changes-per-layer)
  - [DFE: Query-to-Rule Pipeline](#dfe-query-to-rule-pipeline)
    - [HyperDX Query Architecture](#hyperdx-query-architecture)
    - [Extraction Points for DFE Rules](#extraction-points-for-dfe-rules)
      - [1. Dashboard Tile Config (Structured)](#1-dashboard-tile-config-structured)
      - [2. Saved Search Config (Structured)](#2-saved-search-config-structured)
      - [3. Rendered SQL (Raw)](#3-rendered-sql-raw)
    - [Recommended Approach: API Endpoint for SQL Extraction](#recommended-approach-api-endpoint-for-sql-extraction)
    - [Frontend: Export to DFE Rule Button](#frontend-export-to-dfe-rule-button)
      - [Option A: Deep Link (Simpler, Recommended for v1)](#option-a-deep-link-simpler-recommended-for-v1)
      - [Option B: Direct Integration (More Seamless)](#option-b-direct-integration-more-seamless)
      - [Frontend Implementation](#frontend-implementation)
      - [Approach 1: Additive Only (Zero Upstream File Changes)](#approach-1-additive-only-zero-upstream-file-changes)
      - [Approach 2: Minimal Upstream Change (1-2 Files)](#approach-2-minimal-upstream-change-1-2-files)
    - [DFE Rule Engine Consumption](#dfe-rule-engine-consumption)
  - [DFE: Automated CI Upstream Sync](#dfe-automated-ci-upstream-sync)
    - [Sync Strategy](#sync-strategy)
    - [CI Pipeline Design](#ci-pipeline-design)
    - [Merge Conflict Detection and Handling](#merge-conflict-detection-and-handling)
    - [Version Pinning and Release Cadence](#version-pinning-and-release-cadence)

---

## High-Level System Architecture

```mermaid
graph TB
    subgraph "Instrumented Applications"
        SDK1["Browser SDK<br/>(rrweb + OTLP)"]
        SDK2["Node.js SDK"]
        SDK3["Python SDK"]
        SDK4["Other OTel SDKs"]
    end

    subgraph "DFE Platform"
        DFE_UI["DFE UI<br/>(Python)"]
        DFE_RULES["DFE Rules Engine<br/>(detection + hunts)"]
        CASBIN["Casbin<br/>(shared RBAC)"]
        ENVOY["Envoy<br/>(OIDC proxy)"]

        subgraph "Embedded HyperDX"
            subgraph "Ingestion"
                OTEL["OTel Collector<br/>(otelcontribcol)"]
            end

            subgraph "Storage"
                CH[("ClickHouse<br/>Telemetry Data")]
                FERRET["FerretDB<br/>(MongoDB wire protocol)"]
            end

            subgraph "Application"
                API["HyperDX API<br/>(Express.js)"]
                APP["HyperDX UI<br/>(Next.js)"]
            end
        end

        PG[("PostgreSQL + DocumentDB<br/>Metadata + Casbin policies")]
    end

    BROWSER["User Browser"]
    OIDC["OIDC Provider<br/>(Google / Entra ID)"]

    SDK1 & SDK2 & SDK3 & SDK4 -->|"OTLP gRPC/HTTP"| OTEL
    OTEL -->|"Writes"| CH
    API <-->|"OpAMP"| OTEL
    API <-->|"MongoDB protocol"| FERRET
    FERRET -->|"SQL"| PG
    API -->|"Proxy"| CH
    DFE_RULES -->|"Queries"| CH
    DFE_UI --> CASBIN
    API --> CASBIN
    CASBIN -->|"Policies"| PG
    BROWSER -->|"HTTPS"| ENVOY
    ENVOY -->|"OIDC"| OIDC
    ENVOY -->|"Identity headers"| API
    ENVOY -->|"Identity headers"| DFE_UI
    BROWSER --> DFE_UI
    BROWSER --> APP
```

The DFE platform embeds HyperDX as its visualization and search layer. Users
access HyperDX through Envoy, which handles OIDC authentication. Casbin
provides shared RBAC across both the DFE Python UI and HyperDX Node.js API,
backed by the same PostgreSQL instance. Detection and alerting are handled by
the DFE rules engine — HyperDX's built-in alerting is disabled.

---

## Production Deployment: FerretDB and PostgreSQL

For production, we replace MongoDB with
[FerretDB](https://www.ferretdb.com/) — an open-source proxy that speaks the
MongoDB wire protocol but stores data in PostgreSQL via the
[DocumentDB extension](https://github.com/FerretDB/documentdb). HyperDX requires
**zero code changes**; the Mongoose ODM, `connect-mongo` session store, and all
MongoDB queries work transparently through FerretDB.

### Why FerretDB

- **Drop-in replacement**: FerretDB implements the MongoDB 5.0+ wire protocol.
  Existing drivers, tools (mongosh, Compass, mongodump), and ODMs (Mongoose)
  connect to it with a standard `mongodb://` connection string.
- **PostgreSQL backend**: All document data is stored in PostgreSQL as JSONB via
  the DocumentDB extension, giving you PostgreSQL's mature ecosystem for backups,
  replication, monitoring, and operational tooling.
- **No vendor lock-in**: Apache 2.0 licensed, avoids MongoDB's SSPL.
- **No application migration needed**: HyperDX talks to FerretDB exactly as it
  would to MongoDB. The `MONGO_URI` just points at FerretDB instead.

### Architecture with FerretDB

```mermaid
graph LR
    subgraph "HyperDX Application"
        API["HyperDX API<br/>(Mongoose ODM)"]
        SESS["Session Store<br/>(connect-mongo)"]
    end

    subgraph "FerretDB Layer"
        FERRET["FerretDB Proxy<br/>:27017<br/>(MongoDB wire protocol)"]
    end

    subgraph "PostgreSQL"
        PG[("PostgreSQL 17<br/>+ DocumentDB Extension<br/>:5432")]
    end

    API -->|"mongodb://ferretdb:27017/hyperdx"| FERRET
    SESS -->|"mongodb://ferretdb:27017/hyperdx"| FERRET
    FERRET -->|"SQL over<br/>PostgreSQL protocol"| PG
```

HyperDX connects to FerretDB using a standard MongoDB connection string.
FerretDB translates MongoDB wire protocol operations into SQL and executes them
against PostgreSQL with the DocumentDB extension. The DocumentDB extension adds
native BSON support and document operations to PostgreSQL.

### Production Docker Compose

Replace the `db` service in `docker-compose.yml` with two services:

```yaml
services:
  postgres:
    image: ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0
    restart: on-failure
    environment:
      - POSTGRES_USER=hyperdx
      - POSTGRES_PASSWORD=hyperdx
      - POSTGRES_DB=postgres
    volumes:
      - .volumes/pg_data:/var/lib/postgresql/data
    networks:
      - internal

  ferretdb:
    image: ghcr.io/ferretdb/ferretdb:2.7.0
    restart: on-failure
    environment:
      - FERRETDB_POSTGRESQL_URL=postgres://hyperdx:hyperdx@postgres:5432/postgres
    depends_on:
      - postgres
    networks:
      - internal

  app:
    # ... existing app config, only change MONGO_URI:
    environment:
      MONGO_URI: 'mongodb://hyperdx:hyperdx@ferretdb:27017/hyperdx'
      # ... all other env vars unchanged
```

Key points:

- **`postgres`** runs PostgreSQL 17 with the DocumentDB extension pre-installed.
  `POSTGRES_DB` must be `postgres` (required by DocumentDB for `pg_cron`).
- **`ferretdb`** is a stateless proxy that translates MongoDB protocol to SQL.
  It connects to PostgreSQL via `FERRETDB_POSTGRESQL_URL`.
- **`app`** changes only `MONGO_URI` to point at FerretDB. All application code,
  Mongoose models, session storage, and alert checking work unchanged.
- Pin both image tags to matching versions (e.g. `17-0.107.0-ferretdb-2.7.0`
  and `ferretdb:2.7.0`) to avoid compatibility issues between DocumentDB and
  FerretDB releases.

### Full Production Service Topology

```mermaid
graph TB
    subgraph "Docker Compose Network (hdx-oss)"
        APP["app<br/>(HyperDX all-in-one)<br/>Ports: API + UI + OpAMP"]
        OTEL["otel-collector<br/>(OTel Contrib + OpAMP Supervisor)<br/>Ports: 4317, 4318, 24225"]
        CH["ch-server<br/>(ClickHouse 25.6)<br/>Ports: 8123, 9000"]
        FERRET["ferretdb<br/>(FerretDB 2.7)<br/>Port: 27017"]
        PG["postgres<br/>(PostgreSQL 17 + DocumentDB)<br/>Port: 5432"]
    end

    APP -->|"Queries (HTTP)"| CH
    APP -->|"Metadata (Mongoose)"| FERRET
    FERRET -->|"SQL"| PG
    APP <-->|"OpAMP (protobuf)"| OTEL
    OTEL -->|"Writes (TCP)"| CH
    OTEL -->|"Scrapes metrics"| CH

    EXT["External Traffic"] -->|":4317/:4318<br/>OTLP"| OTEL
    EXT -->|":8080<br/>UI + API"| APP
```

### What Stays the Same

Everything in HyperDX is unchanged:

- **Mongoose models** — User, Team, Dashboard, Alert, SavedSearch, Connection,
  Source, Webhook, etc. all work identically
- **Session store** — `connect-mongo` stores sessions via the same MongoDB
  protocol; FerretDB handles the translation
- **Passport.js auth** — `passport-local-mongoose` plugin works through Mongoose
- **Alert checker** — background task queries metadata through the same ODM layer
- **Migrations** — `migrate-mongo` runs against FerretDB the same way
- **All API routes and controllers** — no code changes required

---

## Monorepo Structure

```mermaid
graph LR
    subgraph "Monorepo (Yarn 4 Workspaces + Nx)"
        APP["packages/app<br/>Next.js Frontend"]
        API["packages/api<br/>Express Backend"]
        CU["packages/common-utils<br/>Shared Query Engine"]
        OC["packages/otel-collector<br/>Schema Migrations (Go)"]
    end

    APP -->|"imports"| CU
    API -->|"imports"| CU
```

| Package | Path | Role |
|---|---|---|
| `@hyperdx/app` | `packages/app` | Next.js frontend — search, dashboards, alerts, session replay |
| `@hyperdx/api` | `packages/api` | Express REST API + OpAMP server — auth, CRUD, ClickHouse proxy |
| `@hyperdx/common-utils` | `packages/common-utils` | Isomorphic TypeScript — query engine, Lucene→SQL parser, Zod types |
| `@hyperdx/otel-collector` | `packages/otel-collector` | Go binary for ClickHouse schema migrations (goose-based) |

Additional infrastructure lives in `docker/` (Compose files, OTel collector config, nginx proxy).

---

## Data Flow

### Write Path (Telemetry Ingestion)

```mermaid
flowchart LR
    subgraph "Sources"
        A1["App (OTLP gRPC)"]
        A2["App (OTLP HTTP)"]
        A3["App (Fluentd)"]
        A4["Browser (rrweb events)"]
    end

    subgraph "OTel Collector"
        direction TB
        RX["Receivers<br/>otlp, fluentforward"]
        TX["Processors<br/>transform, batch,<br/>memory_limiter"]
        RT["Routing Connector<br/>(logs)"]
        EX1["Exporter<br/>clickhouse"]
        EX2["Exporter<br/>clickhouse/rrweb"]
    end

    subgraph "ClickHouse"
        T1["otel_logs"]
        T2["otel_traces"]
        T3["otel_metrics_*"]
        T4["hyperdx_sessions"]
    end

    A1 -->|":4317"| RX
    A2 -->|":4318"| RX
    A3 -->|":24225"| RX
    A4 -->|":4318"| RX
    RX --> TX --> RT
    RT -->|"rr-web.event present"| EX2
    RT -->|"default"| EX1
    EX1 --> T1 & T2 & T3
    EX2 --> T4
```

Key details:

- **Receivers** accept OTLP (gRPC on 4317, HTTP on 4318) and Fluentd (24225)
- **Transform processor** parses JSON log bodies, infers severity, normalizes case
- **Routing connector** inspects log attributes — events with `rr-web.event` are
  routed to the session replay pipeline (`hyperdx_sessions` table)
- **ClickHouse exporter** writes to `otel_logs`, `otel_traces`, and five metric
  tables via the native TCP protocol (port 9000)

### Read Path (Query Execution)

```mermaid
sequenceDiagram
    participant Browser
    participant API as HyperDX API
    participant CH as ClickHouse

    Browser->>Browser: renderChartConfig(chartConfig)<br/>→ parameterized SQL
    Browser->>API: POST /api/clickhouse-proxy<br/>(SQL + connection ID)
    API->>API: Validate session<br/>Load Connection credentials
    API->>CH: Proxy HTTP request<br/>(injected auth headers)
    CH-->>API: Query results (JSON)
    API-->>Browser: Query results
```

The query engine (`renderChartConfig` in `common-utils`) runs **in the browser**,
generating parameterized ClickHouse SQL. The API acts as an authenticated proxy
— it never interprets the SQL, only validates the session and injects ClickHouse
credentials.

In **local mode** (single-user deployment), the browser queries ClickHouse
directly, bypassing the proxy entirely.

### Alert Evaluation (Disabled in DFE — See DFE Rules and Hunts)

> **DFE note:** The HyperDX alert checker is **not started** in DFE deployments.
> Detection and alerting are handled by the DFE platform's rules engine and hunt
> workflows, which query ClickHouse directly. The alert API routes are blocked
> via Casbin RBAC. The code below documents upstream HyperDX's built-in alerting
> for reference only.

```mermaid
flowchart LR
    subgraph "check-alerts (Background Task) — DISABLED IN DFE"
        LOAD["Load active alerts"]
        BUILD["Build ChartConfig<br/>from alert source"]
        QUERY["Execute query<br/>on ClickHouse"]
        EVAL["Compare result<br/>vs threshold"]
        FIRE["Send webhook<br/>notification"]
        HIST["Write AlertHistory"]
    end

    DB["FerretDB → PostgreSQL"] --> LOAD
    LOAD --> BUILD --> QUERY
    CH[("ClickHouse")] <--> QUERY
    QUERY --> EVAL
    EVAL -->|"Triggered"| FIRE --> HIST
    EVAL -->|"OK"| HIST
    FIRE --> WH["Slack / Generic /<br/>Incident.io Webhook"]
    HIST --> DB
```

The alert checker runs as a separate Node.js process on a per-minute schedule.
Each alert references either a Saved Search or a Dashboard tile, from which a
`ChartConfig` is derived and evaluated against ClickHouse. Webhook notifications
use Mustache templates with full alert context.

---

## Service Topology

```mermaid
graph TB
    subgraph "Docker Compose Network (hdx-oss)"
        APP["app<br/>(hyperdx-all-in-one)<br/>Ports: API + UI + OpAMP"]
        OTEL["otel-collector<br/>(OTel Contrib + OpAMP Supervisor)<br/>Ports: 4317, 4318, 24225"]
        CH["ch-server<br/>(ClickHouse 25.6)<br/>Ports: 8123 (HTTP), 9000 (TCP)"]
        FERRET["ferretdb<br/>(FerretDB 2.7)<br/>Port: 27017"]
        PG["postgres<br/>(PostgreSQL 17 + DocumentDB)<br/>Port: 5432"]
    end

    APP -->|"Queries (HTTP)"| CH
    APP -->|"Metadata (Mongoose)"| FERRET
    FERRET -->|"SQL"| PG
    APP <-->|"OpAMP (protobuf)"| OTEL
    OTEL -->|"Writes (TCP)"| CH
    OTEL -->|"Scrapes metrics"| CH

    EXT["External Traffic"] -->|":4317/:4318<br/>OTLP"| OTEL
    EXT -->|":8080<br/>UI + API"| APP
```

In production, five services run in a single Docker Compose network. The `app`
container bundles both the Next.js frontend and the Express API. FerretDB sits
between the app and PostgreSQL, translating MongoDB wire protocol to SQL
transparently. The OTel collector runs in **OpAMP supervisor mode** — it receives
its pipeline configuration dynamically from the API server.

---

## Frontend Architecture

```mermaid
graph TB
    subgraph "Next.js (Pages Router)"
        SEARCH["Search Page<br/>Log/Trace search"]
        DASH["Dashboard Page<br/>Chart tiles"]
        ALERTS["Alerts Page<br/>Alert management"]
        SESSIONS["Sessions Page<br/>Session replay"]
        SERVICES["Services Page<br/>APM overview"]
        SVCMAP["Service Map<br/>Trace topology"]
        CHART["Chart Explorer<br/>Ad-hoc charting"]
        CHSQL["SQL Page<br/>Direct ClickHouse SQL"]
    end

    subgraph "Core Components"
        NAV["AppNav<br/>Sidebar navigation"]
        TIMECHART["DBTimeChart<br/>Time-series visualization"]
        TABLE["DBTableChart<br/>Tabular data"]
        SIDEPANEL["DBRowSidePanel<br/>Log/trace detail"]
        WATERFALL["DBTraceWaterfallChart<br/>Span waterfall"]
        PLAYER["DOMPlayer<br/>rrweb session replay"]
        SQLEDITOR["SQLEditor<br/>CodeMirror SQL input"]
        SEARCHINPUT["SearchInputV2<br/>Lucene/SQL autocomplete"]
    end

    subgraph "State & Data"
        URL["URL Params<br/>(nuqs)"]
        TQ["TanStack Query<br/>(server state)"]
        CHC["ClickhouseClient<br/>(browser)"]
        API_HOOKS["API Hooks<br/>(ky + /api/*)"]
    end

    SEARCH & DASH & ALERTS & SESSIONS --> NAV
    SEARCH --> SEARCHINPUT & TABLE & SIDEPANEL
    DASH --> TIMECHART & TABLE
    SESSIONS --> PLAYER
    SERVICES --> TIMECHART
    SVCMAP --> WATERFALL

    TIMECHART & TABLE --> CHC
    CHC -->|"common-utils<br/>renderChartConfig"| CHC
    CHC -->|"/api/clickhouse-proxy"| API_HOOKS
    ALERTS --> API_HOOKS
    API_HOOKS --> TQ
    SEARCH & DASH --> URL
```

Key patterns:

- **URL-driven state**: All search filters, time ranges, and dashboard contexts
  are encoded in URL parameters (via `nuqs`), making every view deep-linkable
- **Server state**: TanStack Query manages all API data with custom hooks in
  `api.ts`, `dashboard.ts`, `savedSearch.ts`, `source.ts`, `sessions.ts`
- **Query engine in browser**: `renderChartConfig()` from `common-utils` runs
  client-side, generating parameterized SQL sent through the ClickHouse proxy
- **UI library**: Mantine components throughout, with Recharts and uPlot for
  charts, CodeMirror for SQL editing, and rrweb for session replay

---

## Backend Architecture

```mermaid
graph TB
    subgraph "Express API (packages/api)"
        MW["Middleware Stack<br/>compression → json → session → passport → CORS"]

        subgraph "Internal Routes (Session Auth)"
            R1["/health, /login, /register"]
            R2["/dashboards"]
            R3["/alerts"]
            R4["/saved-search"]
            R5["/connections"]
            R6["/sources"]
            R7["/clickhouse-proxy"]
            R8["/ai"]
            R9["/team, /me, /webhooks"]
        end

        subgraph "External API (Bearer Token)"
            E1["/api/v2/alerts"]
            E2["/api/v2/charts"]
            E3["/api/v2/dashboards"]
            E4["/api/v2/sources"]
        end

        subgraph "OpAMP Server"
            OPAMP["OpAMP Endpoint<br/>(separate port)"]
        end
    end

    MW --> R1 & R2 & R3 & R4 & R5 & R6 & R7 & R8 & R9
    MW --> E1 & E2 & E3 & E4

    R7 -->|"Reverse proxy"| CH[("ClickHouse")]
    R2 & R3 & R4 & R5 & R6 & R9 --> FERRET["FerretDB → PostgreSQL"]
    OPAMP <-->|"Protobuf"| COLLECTOR["OTel Collector"]
```

Authentication:

- **Internal routes** use Passport.js session auth (`passport-local-mongoose`)
  with sessions stored via `connect-mongo` (through FerretDB → PostgreSQL in
  production). In local mode (single user), authentication is bypassed entirely.
- **External API** (`/api/v2/*`) uses Bearer token auth matching the user's
  `accessKey` field. Rate limited to 100 req/min.

---

## Schema-Agnostic Design

The central architectural innovation: HyperDX is not tied to any specific table
schema. The **Source** model maps ClickHouse table columns to semantic roles via
SQL expressions.

```mermaid
graph LR
    subgraph "Configuration (FerretDB → PostgreSQL)"
        CONN["Connection<br/>host, user, password"]
        SRC_LOG["Source (Log)<br/>from: default.otel_logs"]
        SRC_TRACE["Source (Trace)<br/>from: default.otel_traces"]
        SRC_SESSION["Source (Session)<br/>from: default.hyperdx_sessions"]
        SRC_METRIC["Source (Metric)<br/>from: default.otel_metrics_*"]
    end

    subgraph "Expression Mapping"
        direction TB
        TS["timestampValueExpression<br/>→ TimestampTime"]
        BODY["bodyExpression<br/>→ Body"]
        SEV["severityTextExpression<br/>→ SeverityText"]
        TID["traceIdExpression<br/>→ TraceId"]
        SID["spanIdExpression<br/>→ SpanId"]
        SVC["serviceNameExpression<br/>→ ServiceName"]
    end

    subgraph "ClickHouse Tables"
        T1["otel_logs"]
        T2["otel_traces"]
        T3["hyperdx_sessions"]
        T4["otel_metrics_*"]
    end

    CONN --- SRC_LOG & SRC_TRACE & SRC_SESSION & SRC_METRIC
    SRC_LOG --> TS & BODY & SEV & TID
    SRC_LOG --> T1
    SRC_TRACE --> T2
    SRC_SESSION --> T3
    SRC_METRIC --> T4

    SRC_LOG <-.->|"cross-references"| SRC_TRACE
    SRC_LOG <-.->|"cross-references"| SRC_SESSION
```

Each Source has 20+ expression fields that map semantic concepts (timestamp,
body, severity, trace ID, span ID, service name, etc.) to arbitrary SQL
expressions over the underlying table. Sources cross-reference each other
(`logSourceId`, `traceSourceId`, `sessionSourceId`, `metricSourceId`), enabling
navigation between telemetry types.

This means HyperDX can work on top of **any** ClickHouse table — you point it at
your existing schema and map the columns.

---

## ClickHouse Data Model

```mermaid
erDiagram
    otel_logs {
        DateTime TimestampTime PK
        DateTime64 Timestamp
        String TraceId
        String SpanId
        UInt8 TraceFlags
        String SeverityText
        Int32 SeverityNumber
        String ServiceName
        String Body
        Map ResourceAttributes
        Map LogAttributes
        String ScopeName
    }

    otel_traces {
        DateTime Timestamp PK
        String TraceId
        String SpanId
        String ParentSpanId
        String ServiceName
        String SpanName
        String SpanKind
        String StatusCode
        Map ResourceAttributes
        Map SpanAttributes
        UInt64 Duration
        Map Events_Timestamp
        Map Events_Name
        Map Events_Attributes
        Map Links_TraceId
        Map Links_SpanId
    }

    hyperdx_sessions {
        DateTime TimestampTime PK
        String TraceId
        String Body
        String ServiceName
        Map ResourceAttributes
        Map LogAttributes
    }

    otel_metrics_gauge {
        DateTime TimeUnix PK
        String MetricName
        String ServiceName
        Float64 Value
        Map ResourceAttributes
        Map MetricAttributes
    }

    otel_logs ||--o{ otel_traces : "TraceId"
    otel_logs ||--o{ hyperdx_sessions : "rum.sessionId"
    otel_traces ||--o{ hyperdx_sessions : "rum.sessionId"
```

All tables use:
- **MergeTree** engine with ZSTD compression
- **Partitioning** by `toDate(Timestamp)`
- **TTL** based on timestamp for automatic data expiry
- **Bloom filter indexes** on attribute map keys/values for fast filtering
- **tokenbf_v1** full-text index on Body/SpanName for text search
- **Materialized columns** for frequently-accessed nested attributes (e.g.,
  Kubernetes metadata, `rum.sessionId`)

---

## OTel Collector & OpAMP

```mermaid
sequenceDiagram
    participant API as HyperDX API<br/>(OpAMP Server)
    participant SUP as OpAMP Supervisor
    participant COL as OTel Collector<br/>(child process)
    participant CH as ClickHouse

    Note over API,COL: Startup
    SUP->>API: AgentToServer (heartbeat)
    API->>API: buildOtelCollectorConfig()<br/>Generate full pipeline YAML
    API-->>SUP: ServerToAgent<br/>(RemoteConfig)
    SUP->>COL: Start with generated config

    Note over API,COL: Steady State
    loop Every heartbeat interval
        SUP->>API: AgentToServer (status)
        API-->>SUP: ServerToAgent (config if changed)
    end

    COL->>CH: Write telemetry data
    COL->>CH: Scrape Prometheus metrics
```

The OTel collector runs under an **OpAMP supervisor** that manages its lifecycle.
The HyperDX API dynamically generates the collector's full pipeline configuration
(receivers, processors, connectors, exporters, and service pipelines) based on
team settings. This enables:

- **Remote configuration** — pipeline changes without collector restarts
- **Auth enforcement** — collector can require API keys when
  `collectorAuthenticationEnforced` is enabled on the team
- **Session replay routing** — the routing connector separates rrweb events into
  a dedicated pipeline and table

In **standalone mode** (no OpAMP), the collector uses static config files from
`docker/otel-collector/config.yaml`.

---

## Key Integrations

### Session Replay

Browser SDKs capture DOM mutations as **rrweb** events, shipped as OTLP logs
with a `rr-web.event` attribute. The collector routes these to
`hyperdx_sessions`. The frontend reconstructs playback using rrweb's `Replayer`
class, correlated to logs and traces via `rum.sessionId`.

### Dashboards

Stored as documents (via FerretDB → PostgreSQL) as a set of **tiles**, each
containing a `SavedChartConfig` (source, display type, select/where/groupBy).
Dashboard-level filters apply across all tiles. Import/export is supported via
versioned JSON templates.

### Saved Searches

Persisted queries referencing a Source, with Lucene or SQL `where` clauses.
Stored as documents via FerretDB → PostgreSQL. Displayed in the sidebar
navigation grouped by tags. Can have associated alerts.

### AI Assistant

Uses the Vercel AI SDK with Anthropic as the provider. The backend introspects
ClickHouse table metadata to provide schema context, then returns structured
chart/search/table configurations that the frontend renders directly.

---

## DFE: External OIDC Authentication

### Current Auth Model

HyperDX ships with a simple, single-tenant auth model:

```mermaid
graph LR
    BROWSER["Browser"] -->|"POST /login/password<br/>(email + password)"| PASSPORT["Passport.js<br/>Local Strategy"]
    PASSPORT -->|"pbkdf2 verify"| MONGO["User doc<br/>(FerretDB → PG)"]
    PASSPORT -->|"Set session cookie"| SESSION["Express Session<br/>(connect-mongo)"]
    SESSION -->|"Subsequent requests<br/>cookie → deserializeUser"| API["HyperDX API"]
```

Key characteristics:

- **Passport.js local strategy** — email + password, hashed with pbkdf2 via
  `@hyperdx/passport-local-mongoose` (a private fork)
- **Single-tenant** — `getTeam()` does `Team.findOne({})` with no ID filter;
  the entire deployment assumes exactly one team
- **No RBAC** — every user on the team has identical, full access
- **Session-based** — Express sessions stored in MongoDB (30-day rolling cookie)
- **Manual registration** — first user creates the team via `/register/password`,
  subsequent users join via invite tokens (`/team/setup/:token`)
- **`allowedAuthMethods`** — exists on the Team model but only supports
  `['password']`; no API route to configure it; enforcement is inside the
  passport-local-mongoose fork

### Target Auth Model

```mermaid
graph LR
    subgraph "External Identity"
        OIDC["OIDC Provider<br/>(Google / Entra ID)"]
    end

    subgraph "K8s Ingress"
        ENVOY["Envoy Proxy<br/>(ext_authz / OAuth2 filter)"]
    end

    subgraph "HyperDX"
        API["HyperDX API<br/>(trusts identity headers)"]
        TEAM["Team<br/>(mapped from OIDC claims)"]
        CONN["Connection<br/>(team-specific CH user)"]
    end

    CH[("ClickHouse<br/>(per-team user)")]

    OIDC -->|"ID token"| ENVOY
    ENVOY -->|"X-Forwarded-Email<br/>X-Forwarded-Groups<br/>X-Forwarded-Access-Token"| API
    API --> TEAM --> CONN
    CONN -->|"team-specific<br/>CH credentials"| CH
```

The authentication boundary moves **out of HyperDX entirely**. Envoy handles
the OIDC flow (authorization code grant, token validation, refresh). HyperDX
receives pre-authenticated identity via trusted headers and maps it to teams
and ClickHouse connections.

### Auth Flow with Envoy and OIDC

```mermaid
sequenceDiagram
    participant User as Browser
    participant Envoy as Envoy (K8s Ingress)
    participant OIDC as OIDC Provider<br/>(Google/Entra)
    participant HDX as HyperDX API

    User->>Envoy: GET /search (no session)
    Envoy->>OIDC: Redirect to authorization endpoint
    OIDC->>User: Login prompt
    User->>OIDC: Credentials
    OIDC->>Envoy: Authorization code
    Envoy->>OIDC: Exchange code for tokens
    OIDC-->>Envoy: ID token + access token

    Note over Envoy: Validates token, extracts claims,<br/>sets identity headers

    Envoy->>HDX: GET /search<br/>X-Forwarded-Email: user@example.com<br/>X-Forwarded-Groups: team-sre,team-platform
    HDX->>HDX: Find or create User from email
    HDX->>HDX: Map groups → Team
    HDX->>HDX: Establish session (or stateless JWT)
    HDX-->>User: 200 (via Envoy)

    Note over User,HDX: Subsequent requests

    User->>Envoy: GET /api/dashboards (session cookie)
    Envoy->>Envoy: Validate token (still valid)
    Envoy->>HDX: Forward with identity headers
    HDX->>HDX: Resolve user → team → connection
    HDX-->>User: Dashboard data
```

### Changes Required in HyperDX

All changes are scoped to `packages/api`. The frontend, common-utils, and OTel
collector are unaffected.

#### 1. New Auth Middleware: Trusted Header Authentication

Replace `isUserAuthenticated` with a new middleware that:

- Reads identity from headers set by Envoy (e.g. `X-Forwarded-Email`,
  `X-Forwarded-Groups`, or a validated JWT in `Authorization`)
- Finds or auto-creates the User document from the email claim
- Maps group claims to a Team (find-or-create by group name)
- Sets `req.user` with the resolved User + Team
- Falls back to existing session auth if headers are absent (for backwards
  compatibility or local dev)

**Files to modify:**
- `packages/api/src/middleware/auth.ts` — add `isExternalAuthenticated` middleware
- `packages/api/src/api-app.ts` — conditionally use the new middleware based on
  config (e.g. `AUTH_MODE=oidc-proxy`)

#### 2. User Auto-Provisioning

Replace the manual register + invite flow with just-in-time provisioning:

- On first request from a new email, create the User document
- Assign to Team based on OIDC group claims (configurable mapping)
- Run `setupTeamDefaults()` for newly created teams (connections + sources)
- No registration page, no invite tokens needed

**Files to modify:**
- `packages/api/src/controllers/user.ts` — add `findOrCreateUserFromOIDC(email, groups)`
- `packages/api/src/controllers/team.ts` — fix `getTeam()` to filter by ID (not
  just `findOne({})`) and add `findOrCreateTeamByName(groupName)`

#### 3. Multi-Tenancy Fix

The current `getTeam()` returns the first team found. For multi-team support:

- All team lookups must filter by `_id` or name
- The `getConnections()` controller bug (returns all connections unscoped) must
  be fixed to filter by team
- Verify all routes properly scope data access to `req.user.team`

**Files to modify:**
- `packages/api/src/controllers/team.ts` — `getTeam()` must accept and filter by ID
- `packages/api/src/controllers/connection.ts` — `getConnections()` must filter by team

#### 4. Team → ClickHouse User Mapping

This already works — each Connection stores `username` + `password` scoped to a
Team. No code changes needed. Configuration-level: create a ClickHouse user per
team and configure each Team's Connection accordingly.

#### 5. Disable or Gate Legacy Auth Routes

The Passport.js login/register/invite routes should be disabled when running in
OIDC proxy mode to avoid confusion:

- `POST /login/password` — disabled
- `POST /register/password` — disabled
- `POST /team/setup/:token` — disabled
- `POST /team/invitation` — disabled

**Files to modify:**
- `packages/api/src/routers/api/root.ts` — gate routes behind `AUTH_MODE` config
- `packages/api/src/routers/api/team.ts` — gate invite routes

#### 6. Frontend Adjustments

Minimal changes — the frontend already redirects to `/search` when a session
exists:

- `LandingPage.tsx` — skip the register/login check when `AUTH_MODE=oidc-proxy`
  (Envoy will handle the redirect)
- `AuthPage.tsx` — hide or redirect (the login form is never shown; Envoy
  handles it)
- `TeamPage.tsx` — hide invite UI when running in OIDC mode

#### Summary of New Config

| Variable | Value | Purpose |
|---|---|---|
| `AUTH_MODE` | `oidc-proxy` | Enables trusted header auth, disables Passport routes |
| `AUTH_HEADER_EMAIL` | `X-Forwarded-Email` | Header containing authenticated user's email |
| `AUTH_HEADER_GROUPS` | `X-Forwarded-Groups` | Header containing comma-separated group/team claims |
| `AUTH_DEFAULT_TEAM` | (optional) | Default team name if no group header is present |

---

## DFE: Authorization with Casbin

HyperDX has no authorization model today — every authenticated user has full
access to everything in their team. We use [Casbin](https://casbin.org/) to add
proper RBAC with multi-tenant team scoping, backed by the same PostgreSQL
instance that FerretDB uses for metadata.

### Why Casbin

- **Declarative policy model** — access control rules are defined in a simple
  config file (PERM metamodel: Policy, Effect, Request, Matchers), not scattered
  through application code
- **RBAC with domains/tenants** — first-class support for multi-tenant RBAC
  where users have different roles in different teams
- **PostgreSQL adapter** — policies stored in the same PostgreSQL backing
  FerretDB, via [`casbin-pg-adapter`](https://github.com/touchifyapp/casbin-pg-adapter)
- **Express middleware** — [`casbin-express-authz`](https://github.com/node-casbin/express-authz)
  plugs directly into the existing Express route chain
- **Supports OIDC claims** — roles can be seeded from OIDC group claims passed
  through Envoy, or managed via a Casbin admin API
- **Model flexibility** — can start with simple RBAC and evolve to ABAC or
  custom models by changing the config file, not application code

### RBAC Model with Tenants

Casbin's RBAC with domains/tenants maps directly to HyperDX's team-scoped
architecture. A user has a role (admin, editor, viewer) within a specific team
(domain).

```ini
# rbac_with_tenants_model.conf

[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && r.obj == p.obj && r.act == p.act
```

Where:

- `sub` — user identity (email from OIDC, e.g. `alice@example.com`)
- `dom` — team/tenant (e.g. `team-sre`, `team-platform`)
- `obj` — resource type (e.g. `dashboards`, `alerts`, `connections`, `sources`,
  `saved-searches`, `team-settings`)
- `act` — action (e.g. `read`, `write`, `delete`, `admin`)

Roles:

| Role | Permissions |
| --- | --- |
| `viewer` | `read` on all resources |
| `editor` | `read` + `write` on dashboards, alerts, saved-searches |
| `admin` | All actions on all resources, including `connections`, `sources`, `team-settings` |

### Policy Storage in PostgreSQL

Casbin policies are stored in the same PostgreSQL instance that backs FerretDB,
using [`casbin-pg-adapter`](https://github.com/touchifyapp/casbin-pg-adapter)
for Node.js (HyperDX) and
[`casbin-sqlalchemy-adapter`](https://github.com/pycasbin/sqlalchemy-adapter)
for Python (parent UI). Both enforcers read and write the **same
`casbin_rule` table** — the table schema is identical across all Casbin
implementations.

```mermaid
graph LR
    subgraph "DFE Platform UI (Python)"
        PY_CASBIN["pycasbin Enforcer"]
    end

    subgraph "HyperDX (Node.js)"
        NODE_CASBIN["node-casbin Enforcer"]
        HDX["HyperDX API"]
        FERRET["FerretDB<br/>:27017"]
    end

    subgraph "PostgreSQL 17 + DocumentDB"
        CASBIN_DATA["casbin_rule table<br/>(shared RBAC policies)"]
        FERRET_DATA["FerretDB tables<br/>(HyperDX metadata:<br/>users, teams, dashboards, etc.)"]
    end

    PY_CASBIN -->|"sqlalchemy-adapter"| CASBIN_DATA
    NODE_CASBIN -->|"casbin-pg-adapter"| CASBIN_DATA
    HDX --> NODE_CASBIN
    HDX --> FERRET
    FERRET -->|"MongoDB protocol<br/>→ SQL"| FERRET_DATA
```

This is a key architectural advantage: the parent DFE platform UI (Python) owns
policy management — creating roles, assigning users to teams, managing
permissions — and HyperDX (Node.js) enforces those same policies at request
time. Both sides use the same model conf and the same `casbin_rule` rows.

The `casbin_rule` table stores policies as rows:

```sql
-- Casbin stores all policies in a single table with this schema:
-- (identical across pycasbin, node-casbin, go-casbin, etc.)
CREATE TABLE casbin_rule (
    id    SERIAL PRIMARY KEY,
    ptype VARCHAR(255),  -- "p" for policy, "g" for group/role
    v0    VARCHAR(255),
    v1    VARCHAR(255),
    v2    VARCHAR(255),
    v3    VARCHAR(255),
    v4    VARCHAR(255),
    v5    VARCHAR(255)
);

-- Example data:
-- ptype | v0              | v1           | v2              | v3
-- p     | admin           | team-sre     | *               | *
-- p     | editor          | team-sre     | dashboards      | read
-- p     | editor          | team-sre     | dashboards      | write
-- p     | editor          | team-sre     | alerts          | read
-- p     | editor          | team-sre     | alerts          | write
-- p     | viewer          | team-sre     | *               | read
-- g     | alice@acme.com  | admin        | team-sre        |
-- g     | bob@acme.com    | editor       | team-sre        |
-- g     | carol@acme.com  | viewer       | team-sre        |
-- g     | bob@acme.com    | admin        | team-platform   |
```

Note that a user can have different roles in different teams (Bob is `editor`
in `team-sre` but `admin` in `team-platform`).

#### Shared Enforcer Pattern: Python Manages, Node.js Enforces

The DFE platform UI (Python) is the **policy authority** — it handles:

- User onboarding (OIDC group → team + default role assignment)
- Role management UI (promote/demote users, create custom roles)
- Team provisioning (create team, assign default ClickHouse connection)
- Policy CRUD via `pycasbin` + `sqlalchemy-adapter`

HyperDX (Node.js) is a **policy consumer** — it only enforces:

- On each API request, call `enforcer.enforce(email, team, resource, action)`
- Periodically reload policies from PostgreSQL (Casbin adapters support this
  via `loadPolicy()` with a configurable interval, or use a watcher for
  real-time sync)
- Never modifies policies directly

This separation means HyperDX requires minimal code changes — just the
enforcement middleware — while all policy management stays in the Python
platform where it already exists.

### Integration with Envoy OIDC and HyperDX

The full auth + authz flow ties together Envoy (authentication), Casbin
(authorization), and the existing HyperDX data model:

```mermaid
sequenceDiagram
    participant User as Browser
    participant Envoy as Envoy<br/>(OIDC + ext_authz)
    participant HDX as HyperDX API
    participant Casbin as Casbin Enforcer
    participant DB as PostgreSQL

    User->>Envoy: GET /api/dashboards
    Envoy->>Envoy: Validate OIDC token<br/>Extract email + groups

    Envoy->>HDX: Forward request<br/>X-Forwarded-Email: alice@acme.com<br/>X-Forwarded-Groups: team-sre

    HDX->>HDX: Auth middleware:<br/>find/create User from email<br/>resolve Team from groups

    HDX->>Casbin: enforce("alice@acme.com",<br/>"team-sre", "dashboards", "read")
    Casbin->>DB: Load policies<br/>(cached after first load)
    DB-->>Casbin: Policy rules
    Casbin-->>HDX: ALLOW

    HDX->>HDX: Execute route handler<br/>(scoped to team-sre)
    HDX-->>User: 200 Dashboard data
```

On first authentication of a new user, the OIDC middleware:

1. Creates/finds the User in FerretDB
2. Maps OIDC group claims to Teams (find-or-create)
3. Seeds a default Casbin role assignment (e.g. `g, alice@acme.com, viewer, team-sre`)
   based on the OIDC groups — the first user in a team gets `admin`

Subsequent role changes are managed through a Casbin admin API or directly
in PostgreSQL.

#### Express Middleware Chain

The middleware stack in `api-app.ts` becomes:

```text
Request
  → Envoy (OIDC validation, sets headers)
  → Express
    → Session/cookie middleware (optional, for stateful sessions)
    → OIDC identity middleware (reads X-Forwarded-Email/Groups, resolves user + team)
    → Casbin authz middleware (enforces RBAC policy for the route)
    → Route handler
```

Implementation using `casbin-express-authz`:

```typescript
// Simplified — actual implementation in packages/api/src/middleware/

import { newEnforcer } from 'casbin';
import PostgresAdapter from 'casbin-pg-adapter';

// Initialize once at startup
const adapter = await PostgresAdapter.newAdapter({
  connectionString: process.env.CASBIN_PG_URL, // same PG as FerretDB
});
const enforcer = await newEnforcer('rbac_with_tenants_model.conf', adapter);

// Middleware: runs after OIDC identity middleware sets req.user
function casbinAuthz(resource: string, action: string) {
  return async (req, res, next) => {
    const { email } = req.user;
    const teamName = req.user.teamName; // resolved from OIDC groups
    const allowed = await enforcer.enforce(email, teamName, resource, action);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// Usage in routers:
router.get('/dashboards', casbinAuthz('dashboards', 'read'), getDashboards);
router.post('/dashboards', casbinAuthz('dashboards', 'write'), createDashboard);
router.delete('/connections/:id', casbinAuthz('connections', 'admin'), deleteConnection);
```

### Policy Examples

#### Viewer Can Read Dashboards But Not Create Alerts

```casbin
p, viewer, team-sre, dashboards, read
p, viewer, team-sre, saved-searches, read
p, viewer, team-sre, alerts, read
# No write/delete policies for viewer
```

#### Editor Can Manage Dashboards and Alerts But Not Connections

```casbin
p, editor, team-sre, dashboards, read
p, editor, team-sre, dashboards, write
p, editor, team-sre, dashboards, delete
p, editor, team-sre, alerts, read
p, editor, team-sre, alerts, write
p, editor, team-sre, alerts, delete
p, editor, team-sre, saved-searches, read
p, editor, team-sre, saved-searches, write
p, editor, team-sre, saved-searches, delete
# No access to connections, sources, or team-settings
```

#### Admin Has Full Access

```casbin
p, admin, team-sre, *, *
```

#### User-Role Assignments (Group Definitions)

```casbin
# Alice is admin on team-sre
g, alice@acme.com, admin, team-sre

# Bob is editor on team-sre, admin on team-platform
g, bob@acme.com, editor, team-sre
g, bob@acme.com, admin, team-platform

# Carol is viewer everywhere
g, carol@acme.com, viewer, team-sre
g, carol@acme.com, viewer, team-platform
```

#### HyperDX Resource-to-Route Mapping

| Resource | Routes | Notes |
| --- | --- | --- |
| `dashboards` | `/dashboards/*` | CRUD on dashboard tiles and filters |
| `alerts` | `/alerts/*` | Alert CRUD, silence, history |
| `saved-searches` | `/saved-search/*` | Saved query CRUD |
| `connections` | `/connections/*` | ClickHouse connection management (sensitive) |
| `sources` | `/sources/*` | Telemetry source configuration (sensitive) |
| `team-settings` | `/team/*` | Team name, API key rotation, CH settings, member management |
| `webhooks` | `/webhooks/*` | Webhook destination CRUD |
| `ai` | `/ai/*` | AI assistant access |
| `clickhouse` | `/clickhouse-proxy/*` | Direct ClickHouse query proxy |

---

## DFE: Alerting — Disabled in Favour of DFE Rules and Hunts

HyperDX includes a built-in alerting system (the `checkAlerts` background task,
Alert/AlertHistory models, webhook notifications). **We disable this entirely**
and use the DFE platform's own rules engine and hunt workflows instead.

### What Gets Disabled

| HyperDX Component | Status | Reason |
| --- | --- | --- |
| `checkAlerts` background task | **Disabled** — do not start this process | DFE rules engine replaces it |
| Alert model + AlertHistory model | **Unused** — data stays in FerretDB but is never written to | No cleanup needed |
| `/alerts` API routes | **Blocked by Casbin** — deny `alerts` resource for all roles | Or leave accessible read-only for viewing legacy alerts |
| `/webhooks` API routes | **Blocked by Casbin** — deny `webhooks` resource | DFE handles notifications |
| Alert UI in frontend | **Left in place** — just inaccessible via RBAC | No frontend code changes |
| Silence alert endpoint (`/ext/silence-alert/:token`) | **Dead** — no alerts fire, so no tokens are generated | No change needed |

### How to Disable

The `checkAlerts` task runs as a separate Node.js process
(`nx run @hyperdx/api:dev-task check-alerts`). In production it's started
alongside the main API. To disable:

1. **Don't start the task process** — remove the alert checker from the
   container entrypoint or process manager (Docker CMD, supervisor config, etc.)
2. **Casbin policy** — deny the `alerts` and `webhooks` resources for all roles,
   so the UI routes return 403 even if someone navigates to them:

```casbin
# No policy rules for alerts or webhooks — deny-by-default blocks them.
# Or explicitly if needed:
# p, deny, *, alerts, *
# p, deny, *, webhooks, *
```

### Why Not Remove the Code?

Additive-only principle. The alert models, controllers, routes, and frontend
components are all upstream code. If we delete or modify them, every upstream
merge that touches alerting (and upstream actively develops alerting features)
creates conflicts. By leaving the code in place but not running the task and
blocking API access via Casbin, we get the same result with zero fork
divergence.

### DFE Rules and Hunts Replace Alerting

The DFE platform provides:

- **Rules** — automated detection logic that queries ClickHouse directly from
  the Python platform, using the same team-scoped ClickHouse connection
  credentials. Rules are managed in the DFE UI, not in HyperDX.
- **Hunts** — interactive investigation workflows that combine queries across
  data sources. Hunts can reference HyperDX saved searches and dashboards via
  deep links.

HyperDX remains the **visualization and search layer** — users search logs,
view traces, build dashboards, and replay sessions. Detection and response
logic lives in the DFE platform.

---

## DFE: Additive-Only Feasibility Assessment

A realistic assessment of where the additive-only principle holds, where it
gets difficult, and what the actual upstream merge cost looks like.

### Per-Work-Stream Breakdown

#### FerretDB: Fully Additive

Zero upstream application files modified. The only changes are to Docker Compose
(infrastructure we own) and the `MONGO_URI` environment variable value.

Prior art: [FerretDB published a guide](https://blog.ferretdb.io/full-stack-observability-hyperdx-ferretdb/)
in July 2025 confirming HyperDX works with FerretDB as a drop-in MongoDB
replacement, with zero compatibility issues reported.

**Upstream merge cost: zero.**

#### OIDC Identity Middleware: Effectively Additive

All DFE logic lives in new files under `packages/api/src/dfe/`. The only
upstream file touched is `api-app.ts` with a single conditional block appended
to the end of the middleware stack.

The OIDC middleware **wraps** existing auth — it populates `req.user` the same
way Passport does, so the existing `isUserAuthenticated` middleware passes
through without modification. The `middleware/auth.ts` file is never touched.

**Upstream merge cost: trivial.** The conditional block in `api-app.ts` is at
the end of the file. Upstream changes to the middleware stack above it merge
cleanly. Only a major restructuring of `api-app.ts` (rare) would require a
manual rebase of the block.

#### Casbin RBAC: Fully Additive

All new files. The enforcement middleware is injected via the same conditional
block in `api-app.ts`. No router files are modified — the authorization check
runs globally before any route handler.

**Upstream merge cost: zero** for Casbin itself. When upstream adds new route
prefixes, the route-to-resource mapping in `dfe/middleware/casbin-authz.ts`
needs updating — but that's our file, not an upstream conflict.

#### Multi-Tenancy: Additive With a Caveat

The current `getTeam()` does `Team.findOne({})` — returns the only team. We
do **not** modify this function. Instead:

- Our OIDC middleware resolves the correct team and sets `req.user.team`
- All route handlers already read `req.user.team` via `getNonNullUserWithTeam()`
- For DFE-specific code, we use our own `dfe/controllers/team-provisioning.ts`
  which queries `Team.findOne({ _id: teamId })` — a new function, not a
  modification

**The risk:** If upstream adds a new controller that calls `getTeam()` directly
(no team ID filter), it returns data from an arbitrary team. This is mitigated
by Casbin enforcement upstream of the route handler — you can't reach the
handler without passing RBAC. But it's defense-in-depth, not a guarantee.

**What to do on each upstream merge:** grep for new calls to `getTeam()` in
upstream changes. If any appear in routes accessible through the DFE flow,
assess whether they need team scoping. This is a review-on-merge checklist
item.

**Upstream merge cost: zero code conflicts, but requires review of new
`getTeam()` calls.**

#### Alerting: Fully Additive (Disabled, Not Removed)

The `checkAlerts` task is not started. Casbin blocks the `/alerts` and
`/webhooks` routes. No upstream code is modified or deleted.

**Upstream merge cost: zero.** Upstream can add alert features freely — the
code merges in, it just never runs.

#### Frontend: Zero to Minimal Changes

Three scenarios and how they play out with zero frontend modifications:

1. **Login/register pages** — Envoy intercepts unauthenticated requests before
   they reach HyperDX and redirects to the OIDC provider. The login page is
   never served. No change needed.

2. **401 handling** — the frontend's `ky` client redirects to `/login` on 401.
   Envoy intercepts that `/login` request and starts the OIDC flow. Extra
   redirect hop but functionally correct. No change needed.

3. **Invite UI on TeamPage** — still shows "Invite Member" buttons. These are
   harmless in OIDC mode (invite tokens don't work for OIDC-provisioned users).
   Confusing but not broken. No change needed unless UI polish is desired.

**If UI polish is desired** (hiding invite buttons, showing role info), that
requires 1-2 small conditionals in upstream frontend files (`TeamPage.tsx`,
possibly `AuthPage.tsx`). These are in rendering logic, not structural code,
so upstream conflicts are unlikely but possible.

**Upstream merge cost: zero if we accept the cosmetic quirks. Trivial if we
add 1-2 conditionals.**

### Honest Summary

| Work Stream | Files modified in upstream | Truly additive? | Merge cost per release |
| --- | --- | --- | --- |
| FerretDB | 0 | Yes | Zero |
| OIDC middleware | 1 (`api-app.ts`) | Effectively yes | Trivial (one delimited block) |
| Casbin RBAC | 0 | Yes | Zero (review new routes) |
| Multi-tenancy | 0 | Yes (with review caveat) | Zero (review `getTeam()` calls) |
| Alerting disabled | 0 | Yes | Zero |
| Frontend | 0-2 (optional cosmetics) | Mostly | Zero to trivial |

**Realistic worst case per upstream merge:**

- `api-app.ts` conditional block: rebase if upstream restructures middleware
  stack (~1 per year frequency based on commit history)
- New route prefixes: update Casbin mapping in our `dfe/` code (no conflict)
- New `getTeam()` calls: review for multi-tenancy safety (no conflict)
- Frontend conditionals (if added): re-apply if upstream redesigns the page
  (infrequent)

**Total upstream files modified: 1** (`api-app.ts`), optionally **1-2** frontend
files for cosmetics.

**Total new files: ~8-10** in `packages/api/src/dfe/` plus Casbin model conf.

---

## DFE: FerretDB vs Direct PostgreSQL Migration

An assessment of the two approaches to removing the MongoDB dependency: using
FerretDB as a transparent proxy vs. migrating the application code to use
PostgreSQL directly.

### Option 1: FerretDB (Recommended)

FerretDB sits between HyperDX and PostgreSQL, translating the MongoDB wire
protocol to SQL. HyperDX application code is completely unchanged.

```mermaid
graph LR
    HDX["HyperDX API<br/>(Mongoose ODM)"] -->|"MongoDB protocol"| FERRET["FerretDB<br/>(proxy)"]
    FERRET -->|"SQL"| PG[("PostgreSQL<br/>+ DocumentDB ext")]
```

**Cost: Zero application changes**

| Factor | Assessment |
|---|---|
| Code changes | None — Mongoose, connect-mongo, passport-local-mongoose all work |
| Testing effort | Smoke test the existing suite against FerretDB |
| Risk | Low — FerretDB 2.x with DocumentDB extension is mature |
| Upstream compatibility | Full — can pull upstream HyperDX updates without merge conflicts |
| Operational overhead | One extra container (FerretDB proxy), ~50MB RAM, stateless |
| Performance | Slight overhead from protocol translation; metadata workload is light |
| Data portability | `mongodump`/`mongorestore` work through FerretDB for backup/migration |

**Key advantage: zero fork divergence.** Every upstream HyperDX release merges
cleanly because the application layer is identical. The only difference is the
Docker Compose infrastructure, which lives outside the application code.

### Option 2: Direct PostgreSQL Migration (Native)

Replace Mongoose with a PostgreSQL ORM (Prisma, Drizzle, or raw `pg`). Rewrite
all models, queries, and middleware to use SQL/PostgreSQL natively.

```mermaid
graph LR
    HDX["HyperDX API<br/>(Prisma / Drizzle)"] -->|"SQL"| PG[("PostgreSQL")]
```

**Cost: Major fork with ongoing maintenance burden**

| Factor | Assessment |
|---|---|
| Code changes | ~40+ files across models, controllers, routers, middleware, tasks, tests |
| Testing effort | Full rewrite of all integration tests; new test fixtures |
| Risk | High — subtle behavioral differences in query semantics, type coercion, etc. |
| Upstream compatibility | **Broken** — every upstream HyperDX release touching MongoDB code will conflict |
| Operational overhead | Simpler stack (no FerretDB proxy), one fewer container |
| Performance | Slightly better (no translation layer), but metadata workload is trivial |
| Data portability | Standard PostgreSQL tooling (pg_dump, logical replication) |

#### Scope of a Direct Migration

To quantify the fork cost, here is what would need to change:

**Models (13 files)** — `packages/api/src/models/`:
- Rewrite all Mongoose schemas to PostgreSQL table definitions
- Replace `Schema.Types.ObjectId` refs with foreign keys
- Replace `Schema.Types.Mixed` (dashboard tiles, alert channels) with JSONB columns
- Replace `MongooseMap` (webhook headers/params) with JSONB
- Reimplement TTL indexes as scheduled cleanup jobs or PostgreSQL row expiry
- Replace `passport-local-mongoose` plugin with custom password hashing +
  Passport.js local strategy against PostgreSQL
- Replace `connect-mongo` session store with `connect-pg-simple`

**Controllers (8+ files)** — `packages/api/src/controllers/`:
- Rewrite all Mongoose queries (`.find()`, `.findOne()`, `.findOneAndUpdate()`,
  `.create()`, `.aggregate()`) to SQL
- The three aggregation pipelines are the most complex rewrites:
  - `controllers/team.ts` — tag extraction (`$unwind` + `$group`)
  - `controllers/alertHistory.ts` — alert history grouping (`$group` + `$push` + `$sum`)
  - `tasks/checkAlerts/index.ts` — latest alert state (`$group` + `$first` + `$$ROOT`)
- Replace `.populate()` calls with SQL JOINs

**Routers (10+ files)** — `packages/api/src/routers/`:
- Update all routes that construct Mongoose queries
- Replace MongoDB ObjectId validation with UUID or integer ID validation

**Tests (10+ files)** — all `__tests__/` directories:
- Replace MongoDB test fixtures with PostgreSQL setup/teardown
- Replace `mongooseConnection.dropDatabase()` with PostgreSQL equivalents
- Update CI Docker Compose to use PostgreSQL instead of MongoDB

**Migrations** — replace `migrate-mongo` with a PostgreSQL migration tool
(e.g. `node-pg-migrate`, Prisma Migrate, or Drizzle Kit)

**Dependencies** — remove `mongoose`, `mongodb`, `connect-mongo`,
`@hyperdx/passport-local-mongoose`, `migrate-mongo`; add PostgreSQL ORM +
driver + session store

#### The Fork Problem

This is the critical consideration. HyperDX is actively developed — the
changelog shows frequent releases. A direct PostgreSQL migration creates a
**hard fork** at the data layer:

```mermaid
graph TB
    subgraph "Upstream HyperDX"
        U1["v2.8 — new dashboard feature<br/>(touches Dashboard model + controller)"]
        U2["v2.9 — alert improvements<br/>(touches Alert model + checkAlerts task)"]
        U3["v2.10 — new Source fields<br/>(touches Source model + controller)"]
    end

    subgraph "DFE Fork (Direct PG)"
        F1["Every model/controller<br/>is rewritten"]
        CONFLICT["Merge conflict on<br/>every upstream release<br/>touching data layer"]
    end

    subgraph "DFE Fork (FerretDB)"
        F2["Zero application changes"]
        CLEAN["Clean merge on<br/>every upstream release"]
    end

    U1 & U2 & U3 --> CONFLICT
    U1 & U2 & U3 --> CLEAN
```

With FerretDB, upstream merges are clean because nothing in the application
layer changes. With direct PostgreSQL, **every upstream release that touches
a model, controller, or test will require manual conflict resolution** — and
the data layer is the most frequently changed part of any application.

#### When Direct PostgreSQL Makes Sense

A direct migration would be justified if:

- HyperDX were a stable, rarely-updated dependency (it isn't — active development)
- The metadata workload were performance-critical (it isn't — light CRUD for
  config data; ClickHouse handles the heavy queries)
- FerretDB had significant compatibility gaps for this workload (it doesn't —
  HyperDX uses basic CRUD + three simple aggregation pipelines)
- You needed PostgreSQL-specific features in the metadata layer like full-text
  search, PostGIS, or advanced constraints (you don't)

### Recommendation

**Use FerretDB.** The engineering cost is zero, upstream compatibility is
preserved, and the metadata workload (users, teams, dashboards, alerts, saved
searches) is simple CRUD that FerretDB handles without issue. The one extra
container (~50MB RAM, stateless) is a trivially small cost compared to
maintaining a hard fork of the data layer across every upstream release.

Save the engineering effort for the OIDC auth integration, which is where
the real value lies and where the changes are scoped to a small, well-defined
surface area in the middleware and auth routes.

---

## DFE: Fork Strategy — Additive-Only Changes

The core principle: **never modify existing HyperDX files if we can add new
files instead.** This ensures `git merge upstream/main` produces zero conflicts
on the application code, regardless of how aggressively upstream HyperDX
evolves.

### Why This Matters

HyperDX is under active development. Every upstream release can touch models,
controllers, routers, middleware, and tests. If we modify those files, every
merge becomes a manual conflict resolution exercise. If we only add new files
and use configuration to wire them in, upstream changes flow through cleanly.

### The Additive Pattern

```mermaid
graph TB
    subgraph "Upstream HyperDX Files (NEVER modify)"
        AUTH_ORIG["middleware/auth.ts<br/>(isUserAuthenticated)"]
        APP_ORIG["api-app.ts<br/>(middleware stack)"]
        ROUTES_ORIG["routers/api/*.ts<br/>(route handlers)"]
        MODELS_ORIG["models/*.ts<br/>(Mongoose schemas)"]
    end

    subgraph "DFE Additions (NEW files only)"
        AUTH_DFE["middleware/dfe-auth.ts<br/>(isExternalAuthenticated)"]
        CASBIN_DFE["middleware/dfe-casbin.ts<br/>(casbinAuthz)"]
        CONFIG_DFE["config/dfe.ts<br/>(DFE-specific env vars)"]
        BOOT_DFE["dfe-bootstrap.ts<br/>(DFE startup hooks)"]
    end

    subgraph "Single Wiring Point (minimal edit)"
        APP_ORIG -->|"1 conditional<br/>import block"| AUTH_DFE
        APP_ORIG -->|"1 conditional<br/>middleware insert"| CASBIN_DFE
    end

    style AUTH_ORIG fill:#e8e8e8
    style APP_ORIG fill:#e8e8e8
    style ROUTES_ORIG fill:#e8e8e8
    style MODELS_ORIG fill:#e8e8e8
    style AUTH_DFE fill:#c8e6c9
    style CASBIN_DFE fill:#c8e6c9
    style CONFIG_DFE fill:#c8e6c9
    style BOOT_DFE fill:#c8e6c9
```

### Implementation: File-by-File

#### 1. New Files (zero conflict risk)

All DFE logic lives in new files under a `dfe/` namespace:

```text
packages/api/src/
  dfe/                          ← NEW directory, all DFE code here
    config.ts                   ← DFE env vars (AUTH_MODE, CASBIN_PG_URL, etc.)
    middleware/
      oidc-identity.ts          ← Reads Envoy headers, resolves user + team
      casbin-authz.ts           ← Casbin enforcement middleware
    controllers/
      user-provisioning.ts      ← Find-or-create user from OIDC claims
      team-provisioning.ts      ← Find-or-create team from OIDC groups
    bootstrap.ts                ← DFE startup: init Casbin enforcer, etc.
  rbac_with_tenants_model.conf  ← Casbin model file
```

These files are purely additive — upstream HyperDX will never create files in a
`dfe/` directory, so there is zero merge conflict risk.

#### 2. Minimal Wiring (one file, one conditional block)

The only upstream file that needs a small edit is `api-app.ts` — the Express
middleware stack. The change is a single conditional block:

```typescript
// In packages/api/src/api-app.ts — the ONLY modification to an upstream file

// Existing upstream code (untouched):
app.use(compression());
app.use(express.json({ limit: '32mb' }));
// ... session, passport, etc.

// DFE addition — a single conditional block, clearly marked:
// --- DFE START ---
if (dfeConfig.AUTH_MODE === 'oidc-proxy') {
  const { oidcIdentityMiddleware } = await import('./dfe/middleware/oidc-identity');
  const { casbinAuthzMiddleware } = await import('./dfe/middleware/casbin-authz');
  app.use(oidcIdentityMiddleware);
  app.use(casbinAuthzMiddleware);
}
// --- DFE END ---
```

This block:

- Is clearly delimited with `DFE START` / `DFE END` comments
- Uses dynamic `import()` so the DFE modules are never loaded unless the env
  var is set — zero impact on vanilla HyperDX
- Is a pure addition at the end of the middleware stack — it doesn't modify
  existing lines, so upstream changes to the middleware stack above it merge
  cleanly
- When `AUTH_MODE` is not set (default), HyperDX behaves exactly as upstream

#### 3. Auth Middleware: Wrap, Don't Replace

The existing `isUserAuthenticated` middleware in `middleware/auth.ts` is **not
modified**. Instead, the DFE OIDC middleware runs first in the stack and
populates `req.user` the same way Passport does. The existing
`isUserAuthenticated` then sees an already-authenticated request and passes
through:

```typescript
// packages/api/src/dfe/middleware/oidc-identity.ts (NEW file)

export async function oidcIdentityMiddleware(req, res, next) {
  const email = req.headers[dfeConfig.AUTH_HEADER_EMAIL];
  if (!email) {
    // No OIDC headers — fall through to existing Passport auth
    return next();
  }

  // Find or create user from OIDC identity
  const user = await findOrCreateUserFromOIDC(email, groups);

  // Set req.user exactly as Passport would — existing middleware is satisfied
  req.user = user;

  // Mark as authenticated for Passport's req.isAuthenticated() check
  req.login(user, { session: false }, (err) => {
    if (err) return next(err);
    next();
  });
}
```

The existing `isUserAuthenticated` in `middleware/auth.ts` calls
`req.isAuthenticated()` — since we've called `req.login()`, it returns `true`.
No modification to the upstream file needed.

#### 4. Casbin Enforcement: Additive Middleware Layer

Casbin runs **after** the identity middleware and **before** route handlers.
It's added to the Express stack via the conditional block in `api-app.ts` — no
modification to individual router files:

```typescript
// packages/api/src/dfe/middleware/casbin-authz.ts (NEW file)

// Map Express routes to Casbin resources
const ROUTE_RESOURCE_MAP = {
  '/dashboards': 'dashboards',
  '/alerts': 'alerts',
  '/saved-search': 'saved-searches',
  '/connections': 'connections',
  '/sources': 'sources',
  '/team': 'team-settings',
  '/webhooks': 'webhooks',
  '/ai': 'ai',
  '/clickhouse-proxy': 'clickhouse',
};

// Map HTTP methods to Casbin actions
const METHOD_ACTION_MAP = {
  GET: 'read',
  POST: 'write',
  PUT: 'write',
  PATCH: 'write',
  DELETE: 'delete',
};

export async function casbinAuthzMiddleware(req, res, next) {
  // Skip health check and public routes
  if (req.path === '/health' || req.path.startsWith('/ext/')) {
    return next();
  }

  const resource = resolveResource(req.path);
  const action = METHOD_ACTION_MAP[req.method] || 'read';
  const email = req.user?.email;
  const teamName = req.user?.teamName;

  if (!email || !teamName) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const allowed = await enforcer.enforce(email, teamName, resource, action);
  if (!allowed) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}
```

This sits in the middleware stack globally — individual routers like
`routers/api/dashboards.ts` are never modified.

#### 5. Multi-Tenancy: Additive Override

The current `getTeam()` does `Team.findOne({})` — it returns the only team.
Rather than modifying this function, the DFE OIDC middleware resolves the team
**before** any controller code runs and sets it on `req.user.team`. The existing
controller code already reads `req.user.team` to scope queries, so it works
without changes.

For the one edge case — `getConnections()` not filtering by team — the DFE
Casbin middleware prevents unauthorized access at a higher level (if you're not
in the team, the `enforce()` call fails before the route handler runs).

### Merge Strategy

```text
# Regular upstream sync workflow:
git remote add upstream https://github.com/hyperdxio/hyperdx.git
git fetch upstream
git merge upstream/main

# Expected result:
# - All upstream file changes merge cleanly (we didn't modify them)
# - The dfe/ directory is untouched by upstream (they don't have it)
# - The one conditional block in api-app.ts may occasionally need
#   a trivial rebase if upstream restructures the middleware stack
#   (rare, and easy to resolve since it's a clearly delimited block)
```

### Summary: What Changes per Layer

| Layer | Approach | Conflict risk |
| --- | --- | --- |
| **Infrastructure** (Docker Compose) | Replace `mongo` with `postgres` + `ferretdb` | None — infra files are ours |
| **Auth middleware** | New `dfe/middleware/` files + 1 conditional block in `api-app.ts` | Minimal — one clearly delimited insertion point |
| **Authorization** | New `dfe/middleware/casbin-authz.ts` + Casbin model conf | None — all new files |
| **User/team provisioning** | New `dfe/controllers/` files | None — all new files |
| **Mongoose models** | Unchanged | None — FerretDB handles this |
| **Controllers/routers** | Unchanged | None — Casbin enforcement is global middleware |
| **Frontend** | Unchanged (Envoy handles login redirect; existing session flow works) | None |
| **Tests** | New `dfe/__tests__/` for DFE-specific code | None — additive |

Total files modified in upstream HyperDX: **1** (`api-app.ts`, one conditional block).
Total new files: **~6-8** in `packages/api/src/dfe/`.

---

## DFE: Query-to-Rule Pipeline

A key DFE workflow: a user is exploring data in HyperDX (search page or
dashboard chart), finds something interesting, and wants to turn that query into
a DFE Rule that runs continuously. This section documents the query architecture
and the integration points Kay can use to build this flow.

### HyperDX Query Architecture

HyperDX stores queries as **structured config objects**, not raw SQL. SQL is
generated on-the-fly from these configs at render time.

```mermaid
graph LR
    subgraph "Frontend (Browser)"
        UI["Search Page / Dashboard Tile"]
        CONFIG["ChartConfig object<br/>(select, where, groupBy,<br/>source, granularity)"]
        RENDER["renderChartConfig()"]
        SQL_PREVIEW["ChartSQLPreview<br/>(copy-to-clipboard)"]
    end

    subgraph "Backend (API)"
        PROXY["ClickHouse Proxy<br/>(/api/clickhouse-proxy)"]
    end

    subgraph "ClickHouse"
        CH[("Query execution")]
    end

    UI --> CONFIG
    CONFIG --> RENDER
    RENDER -->|"ChSql → parameterizedQueryToSql()"| SQL_PREVIEW
    RENDER -->|"Raw SQL via proxy"| PROXY
    PROXY --> CH
```

The key types in the pipeline:

| Type | Location | Purpose |
| --- | --- | --- |
| `SavedChartConfig` | `common-utils/src/types.ts` | Stored config for a dashboard tile (source, select, where, groupBy, etc.) |
| `ChartConfigWithOptDateRange` | `common-utils/src/types.ts` | Runtime config with optional date range appended |
| `SavedSearch` | `api/src/models/savedSearch.ts` | Persisted query with source, select, where, whereLanguage, orderBy, filters |
| `ChSql` | `common-utils/src/clickhouse/index.ts` | Parameterized SQL template (`{ sql, params }`) |
| `renderChartConfig()` | `common-utils/src/core/renderChartConfig.ts` | Converts config → `ChSql` (the SQL generation engine) |
| `parameterizedQueryToSql()` | `common-utils/src/clickhouse/index.ts` | Fills parameters into `ChSql` → executable SQL string |

### Extraction Points for DFE Rules

There are three natural places to extract queries for DFE rules:

#### 1. Dashboard Tile Config (Structured)

Each dashboard tile stores a `SavedChartConfig` in MongoDB (via FerretDB). This
is the richest extraction point — it contains the full query definition
including aggregation functions, group-by clauses, and filters.

```typescript
// A dashboard tile's config (from GET /api/dashboards/:id)
{
  source: "6789abcdef012345",      // Source ID → maps to a CH table
  displayType: "line",
  select: [
    { aggFn: "count", valueExpression: "", alias: "error_count" },
  ],
  where: "SeverityText:error AND ServiceName:api-gateway",
  whereLanguage: "lucene",
  groupBy: [{ valueExpression: "ServiceName" }],
  granularity: "5m",
  // ... filters, having, orderBy, etc.
}
```

**Advantage**: Structured, machine-readable, includes aggregation semantics.
The DFE rule engine can interpret the config directly without parsing SQL.

#### 2. Saved Search Config (Structured)

Saved searches store a similar structure (source, select, where, orderBy,
filters). Available via `GET /api/saved-search`.

```typescript
// A saved search (from GET /api/saved-search)
{
  name: "API Gateway Errors",
  source: "6789abcdef012345",
  select: "Timestamp, SeverityText, Body",
  where: "SeverityText:error AND ServiceName:api-gateway",
  whereLanguage: "lucene",
  orderBy: "Timestamp DESC",
  filters: [],
}
```

**Advantage**: Simpler structure, user-named, already represents a "query worth
saving". Natural starting point for a rule.

#### 3. Rendered SQL (Raw)

The SQL that ClickHouse actually executes. Can be obtained by calling
`renderChartConfig()` + `parameterizedQueryToSql()` on any config. The frontend
already does this for the `ChartSQLPreview` component and has a copy button.

```sql
-- Rendered SQL from a dashboard tile
SELECT
  toStartOfInterval(TimestampTime, INTERVAL 300 SECOND) AS ts_bucket,
  ServiceName,
  count() AS error_count
FROM otel_logs
WHERE TimestampTime >= '2025-01-01 00:00:00'
  AND TimestampTime < '2025-01-02 00:00:00'
  AND hasToken(SeverityText, 'error')
  AND ServiceName = 'api-gateway'
GROUP BY ts_bucket, ServiceName
ORDER BY ts_bucket ASC
```

**Advantage**: Directly executable by the DFE Python rule engine against
ClickHouse (using the same team-scoped CH credentials). No translation needed.

### Recommended Approach: API Endpoint for SQL Extraction

Add a new DFE endpoint that accepts a chart config or saved search ID and
returns the rendered SQL. This is additive (new file in `dfe/`) and the
rendering logic already exists in `@hyperdx/common-utils`.

```typescript
// packages/api/src/dfe/routers/query-export.ts (NEW file)

import { renderChartConfig } from '@hyperdx/common-utils/dist/core/renderChartConfig';
import { parameterizedQueryToSql } from '@hyperdx/common-utils/dist/clickhouse';
import { getMetadata } from '@hyperdx/common-utils/dist/core/metadata';
import { format } from '@hyperdx/common-utils/dist/sqlFormatter';

router.post('/dfe/export-sql', async (req, res) => {
  const { teamId } = getNonNullUserWithTeam(req);
  const { chartConfig, savedSearchId, dateRange } = req.body;

  // Option A: Render from inline chart config
  // Option B: Load saved search by ID and build config from it

  const config = chartConfig ?? buildConfigFromSavedSearch(savedSearchId);
  const metadata = await getMetadata(clickhouseClient, source);
  const chSql = await renderChartConfig(config, metadata, querySettings);
  const sql = format(parameterizedQueryToSql(chSql));

  return res.json({
    sql,              // Formatted, executable SQL
    config,           // Original structured config (for DFE to interpret)
    source: {         // Source metadata for CH connection mapping
      name: source.name,
      kind: source.kind,
      tableName: source.from.tableName,
    },
    connectionId: source.connection,  // CH connection for this team
  });
});
```

This endpoint:

- Uses the exact same `renderChartConfig()` pipeline that HyperDX uses
  internally — the SQL is identical to what the user saw
- Returns both the structured config AND the rendered SQL — the DFE rule
  engine can use whichever is more convenient
- Includes source metadata so the DFE side knows which CH table and connection
  to target
- Is fully additive — new file in `dfe/routers/`, wired via the conditional
  block in `api-app.ts`

### Frontend: Export to DFE Rule Button

The user-facing flow adds an "Export to DFE Rule" action in the HyperDX UI
that sends the current query to the DFE rules system.

```mermaid
sequenceDiagram
    participant User as User (Browser)
    participant HDX as HyperDX Frontend
    participant API as HyperDX API<br/>(DFE endpoint)
    participant DFE as DFE Rules Engine<br/>(Python)

    User->>HDX: Click "Export to DFE Rule"<br/>on dashboard tile or search
    HDX->>API: POST /api/dfe/export-sql<br/>{ chartConfig, dateRange }
    API->>API: renderChartConfig() →<br/>parameterizedQueryToSql()
    API-->>HDX: { sql, config, source, connectionId }

    alt Option A: Deep link to DFE
        HDX->>User: Redirect to DFE Rule UI<br/>with query params pre-filled
        User->>DFE: DFE Rule creation page<br/>(SQL + metadata pre-populated)
    else Option B: Direct API call
        HDX->>DFE: POST /api/rules/create<br/>{ sql, schedule, thresholds }
        DFE-->>HDX: Rule created
        HDX->>User: "Rule created" confirmation
    end
```

Two implementation options:

#### Option A: Deep Link (Simpler, Recommended for v1)

The HyperDX button constructs a URL to the DFE Rule creation page with the SQL
and metadata encoded as query parameters. The DFE UI pre-populates the rule
form. No cross-service API calls needed.

```text
https://dfe.example.com/rules/new?
  sql=SELECT+count()+AS+error_count+FROM+otel_logs+WHERE+...
  &table=otel_logs
  &connection=team-sre
  &name=API+Gateway+Errors
```

#### Option B: Direct Integration (More Seamless)

The HyperDX frontend calls the DFE rules API directly (through Envoy, sharing
the same OIDC session) to create the rule in one click. Requires the DFE rules
API to accept a SQL-based rule definition.

#### Frontend Implementation

For the "Export to DFE Rule" button, two approaches depending on how much
frontend change is acceptable:

#### Approach 1: Additive Only (Zero Upstream File Changes)

Add a browser extension, bookmarklet, or DFE wrapper UI that reads the current
HyperDX page URL (which contains the full query state in URL parameters) and
extracts the query. The search page URL contains:

```text
/search?source=...&where=...&whereLanguage=...&select=...&orderBy=...
```

This is fully self-contained — the DFE wrapper parses the URL params and calls
the export endpoint.

#### Approach 2: Minimal Upstream Change (1-2 Files)

Add an "Export to DFE Rule" menu item to the existing chart context menu
(`DBDashboardPage.tsx`) and search results toolbar (`DBSearchPage.tsx`). These
are small UI additions (a menu item in an existing dropdown) that call the DFE
export endpoint.

Since these are in rendering code (not structural), upstream merge conflicts
are unlikely. The same `DFE START / DFE END` comment pattern keeps changes
identifiable.

### DFE Rule Engine Consumption

The DFE Python rules engine receives the exported SQL and can use it directly:

```python
# DFE Rule definition (Python side)
class Rule:
    name: str
    sql_template: str       # From HyperDX export, with date placeholders
    schedule: str           # cron expression (e.g., "*/5 * * * *")
    threshold: float
    threshold_type: str     # "above" or "below"
    ch_connection: str      # ClickHouse connection name (team-scoped)

    def evaluate(self, ch_client):
        # Replace date range placeholders with current window
        sql = self.sql_template.replace(
            "{START_TIME}", self.window_start()
        ).replace(
            "{END_TIME}", self.window_end()
        )
        result = ch_client.query(sql)
        return self.check_threshold(result)
```

The exported SQL from HyperDX uses hardcoded date ranges (from the user's
current view). The DFE rule engine needs to parameterise the timestamp filters
to make the query recurring. Two strategies:

1. **SQL rewriting** — parse the SQL and replace timestamp literals with
   placeholders. Straightforward since HyperDX always generates timestamp
   filters in a predictable pattern (`TimestampTime >= '...' AND
   TimestampTime < '...'`)

2. **Config-based** — use the structured `ChartConfig` instead of raw SQL.
   The config includes `granularity` and the date range is a separate field,
   so the DFE engine can call `renderChartConfig()` itself (if using a
   Node.js sidecar) or build SQL from the structured fields directly

The structured config approach is more robust for long-term maintenance, but
the SQL rewriting approach is simpler to implement initially and doesn't
require the Python side to understand HyperDX's config schema.

---

## DFE: Automated CI Upstream Sync

The goal: every time HyperDX publishes a new release, our fork automatically
merges the changes and validates them. Human intervention is only needed when
something breaks — and the CI tells us exactly what broke.

### Sync Strategy

```mermaid
graph TB
    subgraph "Upstream (hyperdxio/hyperdx)"
        UPSTREAM_MAIN["main branch<br/>(new releases)"]
    end

    subgraph "DFE Fork (our repo)"
        DFE_MAIN["main branch<br/>(production)"]
        SYNC_BRANCH["sync/upstream-vX.Y.Z<br/>(auto-created)"]
        DFE_FILES["dfe/ directory<br/>(our additions)"]
    end

    subgraph "CI Pipeline"
        DETECT["Detect new upstream<br/>release (scheduled/webhook)"]
        MERGE["git merge upstream/main<br/>(into sync branch)"]
        CHECK{{"Merge<br/>clean?"}}
        BUILD["Build + test<br/>(full suite)"]
        TEST_OK{{"Tests<br/>pass?"}}
        AUTO_PR["Auto-merge PR<br/>to main"]
        FAIL_PR["Create PR with<br/>conflict/failure details"]
    end

    UPSTREAM_MAIN -->|"new commits"| DETECT
    DETECT --> MERGE
    MERGE --> CHECK
    CHECK -->|"Yes"| BUILD
    CHECK -->|"No (conflict)"| FAIL_PR
    BUILD --> TEST_OK
    TEST_OK -->|"Yes"| AUTO_PR
    TEST_OK -->|"No"| FAIL_PR
    AUTO_PR --> DFE_MAIN
    FAIL_PR -->|"Human review"| DFE_MAIN

    style DFE_FILES fill:#c8e6c9
    style AUTO_PR fill:#c8e6c9
    style FAIL_PR fill:#ffcdd2
```

The fork tracks upstream `main` as a git remote. The CI pipeline:

1. Fetches upstream on a schedule (daily or on webhook)
2. Creates a `sync/upstream-{date}` branch from our `main`
3. Attempts `git merge upstream/main`
4. If clean: runs the full build + test suite
5. If tests pass: auto-merges to our `main`
6. If anything fails: creates a PR with details for human review

### CI Pipeline Design

```yaml
# .github/workflows/upstream-sync.yml

name: Upstream Sync

on:
  schedule:
    - cron: '0 6 * * 1-5'   # Weekdays at 6am UTC
  workflow_dispatch:          # Manual trigger

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Configure upstream remote
        run: |
          git remote add upstream https://github.com/hyperdxio/hyperdx.git
          git fetch upstream main

      - name: Check for new commits
        id: check
        run: |
          BEHIND=$(git rev-list HEAD..upstream/main --count)
          echo "behind=$BEHIND" >> "$GITHUB_OUTPUT"
          echo "Upstream is $BEHIND commits ahead"

      - name: Create sync branch and merge
        if: steps.check.outputs.behind > 0
        id: merge
        run: |
          BRANCH="sync/upstream-$(date +%Y%m%d)"
          git checkout -b "$BRANCH"
          git merge upstream/main --no-edit 2>&1 | tee merge-output.txt
          echo "branch=$BRANCH" >> "$GITHUB_OUTPUT"

      - name: Build and test
        if: steps.merge.outcome == 'success'
        run: |
          yarn install
          yarn build
          cd packages/api && yarn ci:int
          cd ../common-utils && yarn ci:unit
          cd ../app && yarn ci:unit

      - name: Auto-merge PR
        if: success()
        run: |
          git push origin "${{ steps.merge.outputs.branch }}"
          gh pr create \
            --title "sync: merge upstream $(date +%Y-%m-%d)" \
            --body "Automated upstream sync. All tests passed." \
            --base main
          gh pr merge --auto --merge

      - name: Create failure PR
        if: failure()
        run: |
          # Push whatever state we have (even with conflicts marked)
          git add -A
          git commit -m "sync: upstream merge (needs manual resolution)" \
            --allow-empty || true
          git push origin "${{ steps.merge.outputs.branch }}" || true
          gh pr create \
            --title "sync: upstream merge FAILED $(date +%Y-%m-%d)" \
            --body "$(cat merge-output.txt 2>/dev/null || echo 'See CI logs')" \
            --base main \
            --label "upstream-sync-failure"
```

### Merge Conflict Detection and Handling

Based on our additive-only strategy, conflicts should be extremely rare. The
CI pipeline includes specific checks for our known risk areas:

```yaml
      - name: Post-merge DFE integrity check
        run: |
          # 1. Verify our DFE conditional block still exists in api-app.ts
          grep -q "DFE START" packages/api/src/api-app.ts || \
            echo "::warning::DFE block missing from api-app.ts"

          # 2. Verify all DFE files are intact
          test -d packages/api/src/dfe || \
            echo "::error::dfe/ directory missing"

          # 3. Check for new getTeam() calls (multi-tenancy risk)
          NEW_GETTEAM=$(git diff HEAD~1..HEAD --name-only | \
            xargs grep -l "getTeam()" 2>/dev/null || true)
          if [ -n "$NEW_GETTEAM" ]; then
            echo "::warning::New getTeam() calls found: $NEW_GETTEAM"
          fi

          # 4. Check for new route prefixes not in Casbin map
          NEW_ROUTES=$(git diff HEAD~1..HEAD -- 'packages/api/src/routers/' | \
            grep -E "^\+.*router\.(get|post|put|patch|delete)" || true)
          if [ -n "$NEW_ROUTES" ]; then
            echo "::warning::New routes added — verify Casbin mapping"
          fi
```

Expected failure frequency based on HyperDX's commit history:

| Scenario | Frequency | Resolution |
| --- | --- | --- |
| Clean merge, all tests pass | ~95% of syncs | Fully automated |
| Clean merge, test regression (upstream bug) | ~3% | Report upstream, skip or pin |
| Conflict in `api-app.ts` (middleware restructure) | ~1-2 per year | Rebase DFE block (5 min) |
| New routes need Casbin mapping | ~2-3 per year | Update `dfe/middleware/casbin-authz.ts` |
| New `getTeam()` calls need review | ~1-2 per year | Review for multi-tenancy safety |

### Version Pinning and Release Cadence

The sync pipeline tracks upstream `main` continuously, but production deploys
are gated:

```text
Upstream main ──→ Auto-sync PR ──→ DFE main ──→ Staging ──→ Production
                  (daily)          (auto if clean)  (manual)   (manual)
```

**Tagging convention**: DFE releases are tagged as `dfe/vX.Y.Z` where `X.Y.Z`
matches the upstream HyperDX version at the time of the fork point. For
example, if we fork from HyperDX v2.8.0 and add our DFE layer, the tag is
`dfe/v2.8.0-dfe.1`. Subsequent DFE-only changes increment the DFE suffix:
`dfe/v2.8.0-dfe.2`. When upstream v2.9.0 merges cleanly, the next tag is
`dfe/v2.9.0-dfe.1`.

**Rollback strategy**: If an upstream sync introduces regressions:

1. Revert the sync merge commit on `main` (single commit revert)
2. Pin to the previous known-good upstream version
3. Investigate the regression on the sync branch
4. Re-merge once resolved (or skip that upstream version entirely)

**Upstream version equivalence**: The CI pipeline records which upstream commit
SHA our `main` branch includes. This is stored as a file in the repo:

```text
# .dfe-upstream-version
# Auto-updated by CI pipeline
upstream_repo=hyperdxio/hyperdx
upstream_sha=abc123def456
upstream_date=2025-07-15
dfe_version=dfe/v2.8.0-dfe.3
```

This makes it trivial to answer "which version of HyperDX are we running?" at
any point — critical for debugging and for communicating with upstream when
reporting issues.
