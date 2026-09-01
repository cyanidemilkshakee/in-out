# IN / OUT Management System

A PostgreSQL-backed Next.js application for recording and reviewing employee, visitor, and hardware movement through secured facility checkpoints.

| Role | Interface | Path |
|---|---|---|
| Administrator | Dashboard and operations console | `/admin` |
| Security staff | Checkpoint terminal | `/terminal` |

Both interfaces use the same PostgreSQL database through server-only Next.js API routes. A new empty database receives deterministic demonstration records on first use.

## Stack
 
 - Next.js 15 and React 19 (Frontend & Legacy API Proxy)
 - TypeScript
 - **Python 3.10+, FastAPI, and SQLAlchemy (New Core Backend)**
 - PostgreSQL 17 (Shared by TS and Python layers)
 - **Redis 5.0+ (Pub/Sub for Real-Time Dashboard)**
 - Alembic (Database Migrations)
 - Chart.js and react-chartjs-2
 - Lucide React
 - Route-scoped vanilla CSS and CSS Modules
 
 Node.js 22.5+ and `uv` (Python package manager) are required.

## Routes

| Path | Purpose |
|---|---|
| `/admin/dashboard` | Time-filtered KPIs, scan breakdowns, and recent movements |
| `/admin/logs` | Searchable movement ledger, alert workflow, and review notes |
| `/admin/registry` | Employee, visitor, hardware, alert, and permission registries |
| `/admin/permissions` | Permission assignments and request decisions |
| `/admin/alerts` | Active alerts and automated alert rules |
| `/admin/profile` | Admin identity, password, preferences, and account creation |
| `/terminal` | Checkpoint scanning, offline queue, and conflict resolution |

`/` and `/admin` redirect to the dashboard.

## Local development

Copy `.env.example` to `.env.local`, then start PostgreSQL, Redis, the Python backend, and the Next.js app:

```powershell
Copy-Item .env.example .env.local
npm install
npm run db:up

# In terminal 1: Start the Python FastAPI backend
cd backend
uv run uvicorn main:app --port 8000

# In terminal 2: Start the Next.js frontend
npm run dev
```

The Next.js development server is configured for `http://[::1]:1001`.
The Python API runs on `http://127.0.0.1:8000`.

`DATABASE_URL` is required by the server. The example file points to the local Compose database:

```text
postgresql://inout:inout@127.0.0.1:5432/inout
```

For a hosted database, replace that URL and enable TLS when required:

```text
PGSSL=true
PGSSL_REJECT_UNAUTHORIZED=true
```

Useful commands:

| Command | Purpose |
|---|---|
| `npm run db:up` | Start and health-check the local PostgreSQL database |
| `npm run db:down` | Stop the Compose services without deleting PostgreSQL data |
| `npm run db:migrate:sqlite` | Import the legacy SQLite database into PostgreSQL |
| `npm run dev` | Start persistent Turbopack development |
| `npm run dev:bounded` | Start Turbopack development with a 15-minute limit |
| `npm run dev:webpack` | Start persistent Webpack development |
| `npm run typecheck` | Validate TypeScript with a 2-minute limit |
| `npm run test:postgres` | Start the isolated PostgreSQL test service and run integration tests |
| `npm test` | Run integration tests against `TEST_DATABASE_URL` or local port 5433 |
| `npm run build` | Create the standalone production build with a 10-minute limit |
| `npm run start` | Start an existing persistent production build |

## Import the existing SQLite data

Run the importer before the application auto-seeds a new PostgreSQL database:

```powershell
npm run db:up
$env:DATABASE_URL="postgresql://inout:inout@127.0.0.1:5432/inout"
npm run db:migrate:sqlite -- .data/inout.sqlite
```

The importer:

- creates the PostgreSQL schema;
- copies subjects, movements, alerts, permissions, rules, audits, notes, and admin credentials in one transaction;
- verifies and reports destination row counts;
- refuses to write into a non-empty destination;
- leaves the SQLite file untouched as a backup.

To intentionally replace an already populated IN / OUT PostgreSQL database, append `--replace`. This truncates only this application's tables in the selected database:

```powershell
npm run db:migrate:sqlite -- .data/inout.sqlite --replace
```

Check `DATABASE_URL` carefully before using `--replace`.

## Integration tests

The tests reset a separate database and will never reset the development database unless explicitly pointed at it:

```powershell
npm run test:postgres
```

The default test URL is `postgresql://inout:inout@127.0.0.1:5433/inout_test`. Override it with `TEST_DATABASE_URL`.

## Seed access

The security terminal starts with these demonstration barcodes:

| Barcode | Subject |
|---|---|
| `test1` | Employee |
| `test2` | Visitor |
| `test3` | Hardware asset |

The seeded admin profile uses:

- Email: `admin@company.com`
- Password: `admin1234`

Change the password from `/admin/profile` after starting the app.

## Architecture

The system is currently undergoing a **Strangler Fig** migration from a pure-TypeScript monolithic API to a high-performance Python FastAPI service.

```text
app routes + frontend components
        | 
        v
frontend/context/DataContext.tsx  <------- (Live SSE Stream) -------+
        |                                                           |
        v                                                           |
services/httpDataService.ts                                         |
        |                                                           |
        v                                                           |
app/api/data (Next.js Reverse Proxy)                                |
        |                                                           |
        +-- [Legacy queries & Alerts] --> backend/dataRepository    |
        |                                        |                  |
        +-- [Scans, Movements, Registry]         v                  |
        |                                  PostgreSQL               |
        v                                        ^                  |
Python FastAPI (127.0.0.1:8000)                  |                  |
        |                                        |                  |
        +--> SQLAlchemy (models.py) -------------+                  |
        |                                                           |
        +--> Redis Pub/Sub (redis_client.py) -----------------------+
```

- `lib/types.ts` is the single source for domain and service-contract types.
- `backend/main.py` is the new Python FastAPI entry point.
- `backend/models.py` and `backend/schemas.py` manage the SQLAlchemy ORM and Pydantic validation.
- `app/api/data/route.ts` acts as a smart reverse-proxy, conditionally routing traffic to Python or the legacy TS layer.
- `frontend/context/DataContext.tsx` hooks into the Python Server-Sent Events (SSE) stream for live updates.

Flexible domain payloads use `jsonb`; relationships, timestamps, scan state, and filter fields remain typed columns with indexes. All SQL values are parameterized, and every multi-statement mutation uses one checked-out PostgreSQL client.

## Deployment via Docker

The entire hybrid stack is orchestrated using Docker Compose, making it the easiest and most consistent way to deploy the system in production.

Run the full stack:

```bash
docker compose up --build
```

The orchestration includes:
- **`app`**: The Next.js frontend and legacy API proxy (exposed on port `1001`).
- **`python-api`**: The high-performance FastAPI service (internal port `8000`).
- **`postgres-primary`**: The main PostgreSQL 17 database.
- **`postgres-replica`**: A read-replica for horizontal scaling.
- **`redis`**: Redis 7 for real-time pub/sub features and SSE presence streams.
- **`pgbouncer`**: Connection pooler for PostgreSQL.
- **`api-gateway`**: Nginx acting as a reverse proxy (exposed on port `8001` and `8443`).
- **`keycloak`** & **`step-ca`**: Identity and Certificate Authority services for mTLS.

Open `http://localhost:1001` to view the application. PostgreSQL data is stored in the persistent `pg-primary-data` and `pg-replica-data` volumes; the application images are stateless.

**Production Requirements**:
- Supply a strong `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, and `STEPCA_PASSWORD` via environment variables or a `.env` file. Do not use the example passwords outside local development.
- For external databases, override `DATABASE_URL` in the environment block.
- Ensure the `python-api` service has `ENV=production` set to enforce strict mTLS validation on the security terminal endpoints.

## Current limitations

- The API routes do not yet have authentication or authorization middleware.
- Schema initialization is idempotent, but future schema changes should use a versioned migration runner before production rollout.
- Offline mode queues movements in PostgreSQL but does not emulate a fully disconnected browser.
- Profile avatars are stored as data URLs; production storage should use an object store.

Before production use, add authenticated sessions, role checks, CSRF protection, rate limiting, automated backups, restore drills, and deployment-managed schema migrations.
