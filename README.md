# IN / OUT Management System

A Next.js application (frontend as of now) for recording, monitoring and managing employee, visitor, and hardware movement through secured facility checkpoints.

The application has two connected interfaces:

| Role | Interface | Path |
|---|---|---|
| Administrator | Admin console | `/admin` |
| Security staff | Checkpoint terminal | `/terminal` |

The current implementation uses an in-memory mock service and not a backend connected to a real database. Admin pages and the terminal share the same application state through React Context, so changes made in one interface are immediately visible in the other during the same browser session.

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 15 | App Router, layouts, and standalone production output |
| React 19 | Component and Context state model |
| TypeScript | Domain and service contract type safety |
| Chart.js and react-chartjs-2 | Dashboard and trend visualizations |
| Lucide React | Interface icons |
| Urbanist | Application typeface through `next/font` |
| Vanilla CSS | Design tokens, themes, responsive layout, and component styling |

## Routes

| Path | Purpose |
|---|---|
| `/admin` | Analytics dashboard and recent movements |
| `/admin/logs` | Movement ledger and detail review |
| `/admin/alerts` | Alert command view |
| `/admin/offline-sync` | Queue synchronization and conflict resolution |
| `/admin/checkpoints` | Checkpoint rules |
| `/admin/employees` | Employee directory |
| `/admin/visitors` | Visitor access and temporary IDs |
| `/admin/hardware` | Hardware custody |
| `/admin/profile` | Theme, notifications, and security preferences |
| `/terminal` | Security checkpoint terminal |

`/` redirects to `/admin`. The compatibility route `/admin/[view]` currently renders the dashboard.

## Current Limitations

- There is no backend, authentication service, or database yet.
- Domain state is in memory and resets on a full refresh.
- Offline mode simulates synchronization state; it does not disable the browser network.
- The mock scan engine runs in the browser through the injected mock service.
- Export buttons are presentational in the current phase.

## Project Structure

```text
app/
  admin/                         Admin dashboard and management routes
  terminal/                      Security checkpoint terminal
  layout.tsx                     Root layout and provider mount
  globals.css                    Global design tokens and component styles

components/
  admin/                         Admin tables and employee profile views
  analytics/                     Chart.js dashboard and trend components
  terminal/                      Terminal panels
  AppProviders.tsx               Application provider composition
  AppChrome.tsx                  Role-specific application shell

context/
  DataContext.tsx                Service, shared-state, and action contexts

services/
  dataService.ts                 API contract and request/response types
  mockDataService.ts             In-memory Phase 1 service implementation

lib/
  types.ts                       Shared domain types
  mockData.ts                    Seed people, assets, checkpoints, and alerts
  initialMovements.json          Seed movement ledger
  movementLogic.ts               Scan evaluation and presence transitions
  analyticsUtils.ts              Pure analytics derived from injected movements
```

## Installation

### Local Development

Requirements:

- Node.js 20 or newer
- npm

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

The configured development URL is `http://localhost:1001`. The development command binds to IPv6 localhost (`::1`), so `http://[::1]:1001` may be required on some systems.

Available scripts:

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Turbopack development server |
| `npm run dev:webpack` | Start the development server with Webpack |
| `npm run typecheck` | Run TypeScript validation without output |
| `npm run build` | Create the standalone production build |
| `npm run start` | Start an existing production build |

### Docker

Build the production image:

```bash
docker build -t in-out-management-frontend .
```

Run the container:

```bash
docker run -p 1001:1001 in-out-management-frontend
```

Open `http://localhost:1001`.

The multi-stage image installs dependencies, builds the Next.js standalone output, and runs it as the non-root `nextjs` user.

## Current Features

### Admin console

- Dashboard metrics, active alerts, drill-down charts, and recent movement activity
- Searchable, sortable, filterable, and paginated movement ledger
- Movement detail review and shared movement notes
- Alert status updates
- Employee directory and employee work-pattern profiles
- Temporary visitor ID creation and visitor access records
- Hardware custody and presence records
- Checkpoint rule listing
- Offline queue synchronization and conflict resolution
- Light and dark themes with profile security and notification preferences

### Checkpoint terminal

- Checkpoint selection and online/offline simulation
- Barcode-based employee, visitor, and hardware lookup
- Entry and exit decision evaluation
- Carried-hardware selection
- Recent activity, offline queue, and conflict panels
- Manual security review
- Shared movement, presence, and synchronization state with the admin console

Sample barcodes are available in the terminal:

| Barcode | Subject |
|---|---|
| `test1` | Employee |
| `test2` | Visitor |
| `test3` | Hardware asset |

## State Management and API Layer

The application uses React Context as its lightweight global state manager. Zustand is not currently required because the domain is small enough for a single provider, and Context avoids introducing another dependency.

Domain data is not stored in page-level `useState` hooks. Local component state is reserved for temporary UI concerns such as search text, filters, selected rows, open dialogs, chart ranges, and theme controls.

### Data flow

```text
lib/mockData.ts
       |
       v
services/MockDataService
       |
       v
context/DataProvider
       |
       +--> useDataState()   --> render shared domain data
       |
       +--> useDataActions() --> perform mutations and update shared state
       |
       +--> useDataService() --> access the injected service when needed
```

### Service contract

`services/dataService.ts` defines the `DataService` interface used by the component tree. It covers all current domain fetching and mutations.

Fetch operations:

- People
- Hardware assets
- Checkpoints
- Movement events
- Alerts
- Scan analytics
- Movement notes

Mutation operations:

- Create a temporary visitor
- Update a person
- Update a hardware asset
- Update an alert
- Record a terminal scan
- Save a movement or manual-review result
- Synchronize queued movements
- Resolve movement conflicts
- Add a movement note

`services/mockDataService.ts` is the Phase 1 in-memory implementation. It owns the mutable mock records and uses `lib/movementLogic.ts` for scan evaluation.

### Context boundaries

`context/DataContext.tsx` intentionally separates three contexts:

| Context | Responsibility |
|---|---|
| `DataServiceContext` | Supplies the injected `DataService` implementation |
| `DataStateContext` | Supplies the current application snapshot, loading state, and load error |
| `DataActionsContext` | Supplies stable mutation and refresh functions |

The public hooks are:

```ts
const data = useDataState();
const actions = useDataActions();
const service = useDataService();
```

Splitting actions from state means components that only dispatch mutations do not need to depend on the state object.

### Provider composition

`components/AppProviders.tsx` creates the current `MockDataService` and passes it to `DataProvider`. The root layout mounts `AppProviders` once, above both `/admin` and `/terminal`.

This placement provides session-level persistence across client-side navigation. A full browser refresh recreates the in-memory mock service and resets the data to its fixtures. Theme and profile preferences use browser storage separately from domain state.

### API injection

To connect a backend without rewriting components:

1. Create an HTTP implementation such as `HttpDataService` that implements `DataService`.
2. Implement each method with the corresponding API request.
3. Replace the mock service instance in `components/AppProviders.tsx`.
4. Optionally pass server-provided `initialData` to avoid an initial loading state.

The pages and components can continue using `useDataState()` and `useDataActions()` unchanged.

For a substantially larger application, consider Zustand when selector-based subscriptions, multiple independent stores, or more granular render control become necessary. The `DataService` interface should remain independent of the chosen state manager.
