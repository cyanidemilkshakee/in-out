# IN / OUT Management System

A database-backed Next.js prototype for recording and reviewing employee, visitor, and hardware movement through secured facility checkpoints.

The project has two connected interfaces:

| Role | Interface | Path |
|---|---|---|
| Administrator | Dashboard and operations console | `/admin` |
| Security staff | Checkpoint terminal | `/terminal` |

Both interfaces read and mutate the same local SQLite database through Next.js API routes. The database is seeded with deterministic demonstration records the first time it is opened.

## Stack

- Next.js 15 and React 19
- TypeScript
- Node.js built-in SQLite
- Chart.js and react-chartjs-2
- Lucide React
- Route-scoped vanilla CSS and CSS Modules

Node.js 22.5 or newer is required because the server uses `node:sqlite`.

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

```bash
npm install
npm run dev
```

The development server is configured for `http://[::1]:1001`.

Useful commands:

| Command | Purpose |
|---|---|
| `npm run dev` | Start persistent Turbopack development |
| `npm run dev:bounded` | Start Turbopack development with a 15-minute limit |
| `npm run dev:webpack` | Start persistent Webpack development |
| `npm run typecheck` | Validate TypeScript with a 2-minute limit |
| `npm test` | Compile and run backend integration tests; each stage has a 2-minute limit |
| `npm run build` | Create the standalone production build with a 10-minute limit |
| `npm run start` | Start an existing persistent production build |
| `npm run start:bounded` | Start an existing build with a 15-minute limit |

The default database path is `.data/inout.sqlite`. Override it with:

```bash
INOUT_DB_PATH=/absolute/path/inout.sqlite npm run dev
```

On PowerShell:

```powershell
$env:INOUT_DB_PATH="C:\data\inout.sqlite"
npm run dev
```

Delete the prototype database while the app is stopped to regenerate the deterministic fixture on the next start.

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
React pages and components
        |
        v
context/DataContext.tsx
        |
        v
services/httpDataService.ts
        |
        v
app/api/data + app/api/profile
        |
        v
server/dataRepository + server/profileRepository
        |
        v
.data/inout.sqlite
```

- `lib/types.ts` is the single source for domain and service-contract types.
- `server/database.ts` creates the relational schema, manages password hashing, and seeds an empty database.
- `server/dataRepository.ts` owns movement, permission, alert, registry, synchronization, and note mutations.
- `server/profileRepository.ts` owns admin profile and credential mutations.
- `server/seedData.ts` generates coherent fixture history without shipping a large JSON payload to the browser.
- `lib/movementLogic.ts` and `lib/ruleEngine.ts` contain deterministic domain decisions.
- `context/DataContext.tsx` fetches only the data slice needed by the active route.

The browser no longer imports fixture JSON or holds the canonical domain store. Mutations persist across browser refreshes and across the admin and terminal interfaces.

## Docker

```bash
docker build -t in-out-management .
docker run --rm -p 1001:1001 -v inout-data:/app/.data in-out-management
```

Open `http://localhost:1001`. The image runs as a non-root user and stores SQLite data in `/app/.data`.

## Prototype limitations

- The API routes do not yet have authentication or authorization middleware.
- SQLite is suitable for this local/mock phase, not a horizontally scaled multi-instance deployment.
- Schema-version changes currently rebuild and reseed the prototype database instead of running production migrations.
- Offline mode queues movements in the database but does not emulate a fully disconnected browser.
- Profile avatars are stored as data URLs; production storage should use an object store.

Before production use, add authenticated sessions, role checks, CSRF protection, rate limiting, durable migrations, backups, and a production database selected for the deployment topology.
