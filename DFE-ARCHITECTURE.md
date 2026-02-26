# HyperDX Architecture (v2)

A comprehensive architectural overview of the HyperDX v2 observability platform,
including production deployment with FerretDB + PostgreSQL.

HyperDX is an open-source observability platform built on ClickHouse that helps
engineers search, visualize, and monitor logs, metrics, traces, and session
replays. It is schema-agnostic, OpenTelemetry-native, and designed to run on top
of any ClickHouse cluster.

---

## Table of Contents

- [High-Level System Architecture](#high-level-system-architecture)
- [Production Deployment: FerretDB and PostgreSQL](#production-deployment-ferretdb-and-postgresql)
- [Monorepo Structure](#monorepo-structure)
- [Data Flow](#data-flow)
  - [Write Path (Telemetry Ingestion)](#write-path-telemetry-ingestion)
  - [Read Path (Query Execution)](#read-path-query-execution)
  - [Alert Evaluation](#alert-evaluation)
- [Service Topology](#service-topology)
- [Frontend Architecture](#frontend-architecture)
- [Backend Architecture](#backend-architecture)
- [Schema-Agnostic Design](#schema-agnostic-design)
- [ClickHouse Data Model](#clickhouse-data-model)
- [OTel Collector & OpAMP](#otel-collector--opamp)
- [Key Integrations](#key-integrations)
- [DFE: External OIDC Authentication](#dfe-external-oidc-authentication)
  - [Current Auth Model](#current-auth-model)
  - [Target Auth Model](#target-auth-model)
  - [Auth Flow with Envoy and OIDC](#auth-flow-with-envoy-and-oidc)
  - [Changes Required in HyperDX](#changes-required-in-hyperdx)
- [DFE: Authorization with Casbin](#dfe-authorization-with-casbin)
  - [Why Casbin](#why-casbin)
  - [RBAC Model with Tenants](#rbac-model-with-tenants)
  - [Policy Storage in PostgreSQL](#policy-storage-in-postgresql)
  - [Integration with Envoy OIDC and HyperDX](#integration-with-envoy-oidc-and-hyperdx)
  - [Policy Examples](#policy-examples)
- [DFE: FerretDB vs Direct PostgreSQL Migration](#dfe-ferretdb-vs-direct-postgresql-migration)

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

    subgraph "HyperDX Platform"
        subgraph "Ingestion"
            OTEL["OTel Collector<br/>(otelcontribcol)"]
        end

        subgraph "Storage"
            CH[("ClickHouse<br/>Telemetry Data")]
            FERRET["FerretDB<br/>(MongoDB wire protocol)"]
            PG[("PostgreSQL + DocumentDB<br/>Metadata")]
        end

        subgraph "Application"
            API["HyperDX API<br/>(Express.js)"]
            APP["HyperDX UI<br/>(Next.js)"]
            ALERTS["Alert Checker<br/>(Background Task)"]
        end
    end

    BROWSER["User Browser"]
    WEBHOOKS["Webhooks<br/>(Slack, etc.)"]

    SDK1 & SDK2 & SDK3 & SDK4 -->|"OTLP gRPC/HTTP"| OTEL
    OTEL -->|"Writes"| CH
    API <-->|"OpAMP"| OTEL
    API <-->|"MongoDB protocol"| FERRET
    FERRET -->|"SQL"| PG
    API -->|"Proxy"| CH
    ALERTS -->|"Queries"| CH
    ALERTS -->|"MongoDB protocol"| FERRET
    ALERTS -->|"Notifications"| WEBHOOKS
    BROWSER <-->|"HTTP"| APP
    BROWSER -->|"API Calls"| API
    BROWSER -->|"/api/clickhouse-proxy"| API
```

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

### Alert Evaluation

```mermaid
flowchart LR
    subgraph "check-alerts (Background Task)"
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
