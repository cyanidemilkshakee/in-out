# IN / OUT Management System

Run the complete local system with Docker: Next.js frontend, FastAPI backend, PostgreSQL, Redis, Temporal, and Keycloak.

## Requirements

- Docker Desktop running
- Node.js 22.5+ (used once to generate `AUTH_SECRET`)

## Start the project

From the project folder, create your local configuration file:

```powershell
Copy-Item .env.example .env
```

Generate an Auth.js secret and write it directly into `.env`:

```powershell
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
(Get-Content .env) -replace '^AUTH_SECRET=.*$', "AUTH_SECRET=$secret" | Set-Content .env
```

Open `.env` and choose local values for these settings before the first start:

```env
POSTGRES_PASSWORD=choose-a-local-database-password
KEYCLOAK_ADMIN_USERNAME=admin
KEYCLOAK_ADMIN_PASSWORD=choose-a-keycloak-master-password
AUTH_SECRET=the-generated-secret
AUTH_URL=http://localhost:1001
```

These settings have different purposes:

| Setting | Used for | When it is used |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Password for the local PostgreSQL service | Docker services connecting to PostgreSQL |
| `KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` | Keycloak **master administrator** login | The first time Keycloak initializes its database |
| `AUTH_SECRET` | Signs the application's Auth.js session cookies | Every application start |
| `AUTH_URL` | The browser-facing application URL used for Keycloak callbacks | Every application start |

Application-user passwords are not entered in `.env`. Create those users and passwords in Keycloak after the services start.

Build and start all services:

```powershell
docker compose up --build -d
```

Check that services are running:

```powershell
docker compose ps
```

Open:

- Application: http://localhost:1001
- Keycloak administration console: http://localhost:8081/admin
- Temporal UI: http://localhost:8233

## First login and application user

Sign in to Keycloak at http://localhost:8081/admin with the `KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` values from `.env`.

Then create an application administrator:

1. Select the `inout` realm.
2. Go to **Users** and create a user.
3. In **Credentials**, set a password and turn **Temporary** off.
4. In **Role mapping**, assign the `admin` realm role.
5. Sign in to the application at http://localhost:1001 with that user.

Role access is intentionally separated:

| Keycloak realm role | Application area |
| --- | --- |
| `admin` | Admin dashboard at `/admin` |
| `operator` | Security terminal at `/terminal` |

Create an operator with the same steps, assigning the `operator` role instead. Assign each application user one of these roles. After changing a user's role, have that user sign out and sign in again so their session receives the new role.

## Users and data

Users created in Keycloak are shared only by people using the same Keycloak server and database. For example, users you create at your own `http://localhost:8081` are available to the application on your computer, but they are not copied to a guide's fresh clone and local Docker installation.

To let multiple people use the same accounts, they must all use one shared deployment with the same Keycloak and PostgreSQL database. For a project review, each reviewer should normally create their own local Keycloak master account and their own `inout` application administrator.

PostgreSQL is the persistent source of truth for both kinds of data in this Docker setup:

| Data | Owner | PostgreSQL location |
| --- | --- | --- |
| Application records such as people, hardware, scans, movements, and alerts | IN / OUT backend | Application tables in the default schema |
| Login users, password hashes, roles, and Keycloak sessions | Keycloak | `keycloak` schema |

The frontend does not maintain a separate user database. It signs users in through Keycloak, and the backend accepts access tokens only when they contain the required realm role. The application's `admin_accounts` table stores profile metadata; it does not control login passwords.

## Stop and restart

Stop the services while keeping database data:

```powershell
docker compose stop
```

Start them again:

```powershell
docker compose start
```

View logs when something fails to start:

```powershell
docker compose logs -f
```

Reset the entire local installation, including Keycloak users and database data:

```powershell
docker compose down -v
```

Run `docker compose up --build -d` again after a reset. The Keycloak bootstrap username and password are only used the first time its database is created.

## Why `-d` is used

`-d` means detached mode. Docker starts the services in the background, returns the PowerShell prompt immediately, and keeps the application running while you use the browser. Use `docker compose logs -f` to watch logs afterward.

Without `-d`, Docker prints live logs in the current terminal and keeps that terminal occupied until you press `Ctrl+C`. Pressing `Ctrl+C` also stops the stack, which is useful when diagnosing startup problems.

## Do not commit `.env`

`.env` holds local passwords and `AUTH_SECRET`; it is ignored by Git. Commit `.env.example` only.
