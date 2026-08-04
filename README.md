# IN / OUT Management System

A PostgreSQL-backed Next.js application for recording and reviewing employee, visitor, and hardware movement through secured facility checkpoints.

| Role | Interface | Path |
|---|---|---|
| Administrator | Dashboard and operations console | `/admin` |
| Security staff | Checkpoint terminal | `/terminal` |

Both interfaces use the same PostgreSQL database through server-only Next.js API routes. A new empty database receives deterministic demonstration records on first use.

## Stack

- Next.js 15 and React 19
- TypeScript
- PostgreSQL 17 with the `pg` connection pool
- Chart.js and react-chartjs-2
- Lucide React
- Route-scoped vanilla CSS and CSS Modules

Node.js 22.5 or newer is required.

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

Copy `.env.example` to `.env.local`, then start PostgreSQL and the app:

```powershell
Copy-Item .env.example .env.local
npm install
npm run db:up
npm run dev
```

The development server is configured for `http://[::1]:1001`.

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

```text
app routes + frontend components
        |
        v
frontend/context/DataContext.tsx
        |
        v
services/httpDataService.ts
        |
        v
app/api/data + app/api/profile
        |
        v
backend/dataRepository + backend/profileRepository
        |
        v
backend/database.ts (pooled transactions + schema initialization)
        |
        v
PostgreSQL
```

- `lib/types.ts` is the single source for domain and service-contract types.
- `frontend/components`, `frontend/context`, and `frontend/hooks` contain browser-facing UI and state.
- `backend/database.ts` owns pooling, transaction boundaries, password hashing, schema initialization, and first-run seeding.
- `backend/postgresSchema.cjs` defines the PostgreSQL schema and indexes shared by the app and migration tool.
- `backend/dataRepository.ts` owns movement, permission, alert, registry, synchronization, and note mutations.
- `backend/profileRepository.ts` owns admin profile and credential mutations.
- `backend/seedData.ts` generates coherent fixture history without shipping a large JSON payload to the browser.
- `lib/movementLogic.ts` and `lib/ruleEngine.ts` contain deterministic domain decisions.
- `frontend/context/DataContext.tsx` hydrates route-scoped data and merges mutation deltas.

Flexible domain payloads use `jsonb`; relationships, timestamps, scan state, and filter fields remain typed columns with indexes. All SQL values are parameterized, and every multi-statement mutation uses one checked-out PostgreSQL client.

## Docker

Run the full stack:

```bash
docker compose up -d --build --wait app
```

Open `http://localhost:1001`. PostgreSQL data is stored in the `postgres-data` volume; the application image is stateless.

For production, supply a strong `POSTGRES_PASSWORD` or an external `DATABASE_URL`. Do not use the example password outside local development.

## Current limitations

- The API routes do not yet have authentication or authorization middleware.
- Schema initialization is idempotent, but future schema changes should use a versioned migration runner before production rollout.
- Offline mode queues movements in PostgreSQL but does not emulate a fully disconnected browser.
- Profile avatars are stored as data URLs; production storage should use an object store.

Before production use, add authenticated sessions, role checks, CSRF protection, rate limiting, automated backups, restore drills, and deployment-managed schema migrations.
