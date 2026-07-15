# IN / OUT Management System

A mock frontend for a physical checkpoint access-control system — tracking the inbound and outbound movement of employees, visitors, and hardware assets across secured zones in real-time.

---

## Overview

The IN/OUT Management System is a **Next.js 15** web application that simulates a complete **checkpoint access-control platform** for a physical facility. It provides two distinct interfaces for two types of users:

| Role | Interface | Path |
|---|---|---|
| Administrator | Admin Console | `/admin` |
| Security Guard | Scan Terminal | `/terminal` |

### How it works

When a person or asset arrives at a checkpoint, a barcode is scanned. The system evaluates the scan against a set of rules (zone permissions, access status, whether the subject is already inside, etc.) and produces one of these outcomes:

| Result | Meaning |
|---|---|
| ✅ **Success** | Entry or exit is approved |
| ⛔ **Denied** | Barcode not registered or not pre-approved |
| 🔁 **Duplicate** | Subject is already inside (on entry) or not logged in (on exit) |
| 🚫 **Restricted** | Subject's zone permissions don't cover this checkpoint |
| ⏳ **Expired** | Visitor's temporary barcode has expired |
| 👁 **Manual Review** | Flagged for a security officer to inspect |

The system also supports **offline mode**: scans taken while offline are queued locally and synced when connectivity is restored.

---

## Features

### Admin Console (`/admin`)
- **Dashboard** — Live metrics strip (total scans, entries, exits, approved, denied, restricted, active inside) with interactive charts (bar, doughnut, line via Chart.js)
- **Movement Logs** — Full searchable, sortable, filterable event log with configurable columns, pagination, and a slide-out detail drawer
- **Alerts** — Security alerts ranked by severity (critical / high / medium) with acknowledge & resolve actions
- **Employees** — Employee directory with access level and zone assignment management
- **Visitors** — Visitor management with pre-approval workflows and temporary barcode issuance
- **Hardware** — Asset registry (laptops, equipment, tools) with zone restrictions and ownership tracking
- **Scanners** — Scanner device health monitoring (online / offline / warning)
- **Checkpoints** — Checkpoint configuration (entry / exit / auto mode, zone assignment)
- **Offline Sync** — View and manage queued movement events pending synchronisation
- **Profile** — Administrator profile page

### Scan Terminal (`/terminal`)
- **Barcode scan input** — Type or paste a barcode to simulate a hardware scanner
- **Real-time decision panel** — Instantly shows the scan result, direction, subject identity, and reason
- **Subject panel** — Full subject profile card (name, type, access level, allowed zones, last movement)
- **Hardware picker** — Select hardware assets being carried through the checkpoint alongside a person
- **Activity feed** — Live scrolling timeline of recent scans at the terminal
- **Offline queue** — View events waiting to sync when connectivity returns
- **Conflict resolution** — Handle scans with conflicting sync states
- **Online / Offline toggle** — Simulate network connectivity loss to test offline behaviour
- **Checkpoint selector** — Switch the active checkpoint to simulate different access points

---

## Project Structure

```
.
├── app/
│   ├── admin/              # Admin console pages (dashboard, logs, alerts, employees, etc.)
│   ├── terminal/           # Scan terminal page
│   ├── dashboard/          # Dashboard route
│   ├── layout.tsx          # Root layout (Urbanist font, global CSS)
│   ├── page.tsx            # Root redirect → /admin
│   └── globals.css         # All application styles (design tokens, components, responsive)
│
├── components/
│   ├── admin/
│   │   └── Tables.tsx      # Movement log table, column controls, detail drawer
│   ├── analytics/
│   │   ├── DashboardCharts.tsx   # Chart.js charts (bar, doughnut, line, area)
│   │   └── DrillDownDoughnut.tsx # Interactive drill-down doughnut chart
│   ├── terminal/
│   │   └── Panels.tsx      # Terminal UI panels (decision, subject, hardware, queue, conflicts)
│   ├── AppChrome.tsx       # Shared top bar / page shell for both admin and terminal
│   ├── StatusPill.tsx      # Coloured result status badge component
│   └── ToastRegion.tsx     # Toast notification system
│
├── lib/
│   ├── types.ts            # All shared TypeScript types
│   ├── mockData.ts         # Seed data (people, hardware, checkpoints, scanners, events)
│   └── movementLogic.ts    # Core scan evaluation engine (barcode → decision)
│
├── Dockerfile              # Multi-stage Docker build (deps → builder → runner)
├── next.config.mjs         # Next.js config (standalone output, CSS optimisation)
└── package.json
```

---

## Tech Stack

| Technology | Purpose |
|---|---|
| [Next.js 15](https://nextjs.org/) | React framework with App Router, server components, standalone output |
| [React 19](https://react.dev/) | UI library |
| [TypeScript](https://www.typescriptlang.org/) | Type safety across the entire codebase |
| [Chart.js](https://www.chartjs.org/) + [react-chartjs-2](https://react-chartjs-2.js.org/) | Data visualisation (bar, doughnut, line charts) |
| [Lucide React](https://lucide.dev/) | Icon library |
| [Urbanist](https://fonts.google.com/specimen/Urbanist) | Google Fonts typeface (via `next/font`) |
| Vanilla CSS | All styling — no utility framework, uses CSS custom properties |

---

## Prerequisites

Ensure you have the following installed before running the project:

- **Node.js** v20 or higher
- **npm** (comes bundled with Node.js)
- **Docker** (only required for the Docker run method)

---

## Running with npm (Local Development)

### 1. Install dependencies

```bash
npm install
```

### 2. Start the development server

```bash
npm run dev
```

The app will be available at `http://localhost:1001`.

> The dev server binds to IPv6 localhost (`::1`) on port `1001` by default. If `http://localhost:1001` doesn't work in your browser, try `http://[::1]:1001`.

### 3. Build for production (optional)

```bash
npm run build
npm run start
```

### Other scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local development server with hot reload |
| `npm run build` | Build an optimised production bundle |
| `npm run start` | Start the production server (requires a build first) |
| `npm run typecheck` | Run TypeScript type checking without emitting files |

---

## Running with Docker

The project includes a production-ready **multi-stage Dockerfile** that produces a minimal image using Next.js's standalone output mode.

### 1. Build the Docker image

Run this from the root of the project directory:

```bash
docker build -t in-out-management-frontend .
```

### 2. Run the container

```bash
docker run -p 1001:1001 in-out-management-frontend
```

### 3. Open in your browser

```
http://localhost:1001
```

### Docker build stages

| Stage | Base | Purpose |
|---|---|---|
| `deps` | `node:20-alpine` | Install `node_modules` cleanly via `npm ci` |
| `builder` | `node:20-alpine` | Compile the Next.js production bundle |
| `runner` | `node:20-alpine` | Minimal production image — only the standalone output |

The final image runs as a non-root `nextjs` user for security.

---

## Notes

- **All data is mocked.** There is no backend or database. All movement events, people, hardware, alerts, and analytics are generated from `lib/mockData.ts` and held in React state. Refreshing the page resets all state.
- **The scan engine is client-side.** `lib/movementLogic.ts` contains the full barcode evaluation logic — zone checks, access status, duplicate detection, and offline queuing — all running in the browser.
- **Offline simulation** on the terminal page is a UI toggle only; it does not affect real network connectivity.
