# Initial setup and first use

This guide covers a clean local deployment of InOut for one organization. The project models multiple zones or branches inside that organization; it is not a multi-organization SaaS deployment.

## 1. Prepare the local environment

1. Install and start Docker Desktop.
2. Copy `.env.example` to `.env` if `.env` does not exist.
3. Generate unique values for all secrets in `.env`. Keep the file local and do not commit or share it. In particular, `KEYCLOAK_ADMIN_PASSWORD` is used only to create the initial Keycloak master administrator when the Keycloak database is empty. Changing it later does not change an existing account's password.
4. Confirm the configured host ports are available. The default app is `http://app.localhost:1008`; the public identity login is `http://auth.localhost:1005`.

Read the Keycloak bootstrap password from `.env` locally when needed; do not paste it into chat or documentation. If any `.env` value has been shared or captured in a screenshot, replace it before the first launch.

## 2. Start the clean installation

From the repository root, run:

```powershell
docker compose up --build -d --wait
```

Compose starts PostgreSQL, provisions separate service roles, applies Alembic migrations, seeds reference records, initializes Temporal, starts the API and frontend, and starts the public and loopback-only Kong gateways after their dependencies are healthy. `backend-init` seeds reference data only.

The clean database receives:

- Zone A and Zone B.
- Checkpoint 1 (required Front Gate) and checkpoint 2 (optional Back Gate) in each zone.
- The built-in alert rules.
- The Keycloak `inout` realm, clients, and application roles.

It does not receive employees, visitors, hardware, permissions, movement history, or application login users. Demo and test seeds are separate modes and are not run by normal startup.

Check service status with `docker compose ps`. The app, Keycloak, PostgreSQL, Redis, Python API, public Kong, and `keycloak-admin` should report healthy; the Temporal server and worker should be running. The one-shot initialization jobs should exit with code 0.

## 3. Create the first application master-admin

Keycloak has a built-in `master` realm for administering the identity server. InOut application accounts live in the separate `inout` realm. An account in `master` does not automatically have an InOut application role.

1. The loopback-only Keycloak administration gateway starts with the normal Compose stack. If it was manually stopped, start it with:

   ```powershell
   docker compose up -d --wait keycloak-admin
   ```

2. Open `http://auth.localhost:1009/admin/master/console/` and sign in with `KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` from the local `.env`.
3. Select the `inout` realm. Create the designated first application administrator under **Users**, set a strong password, and turn **Temporary** off if the account should sign in immediately.
4. Assign the `master-admin` realm role to that user. This role inherits the application `zone-admin` role. Do not grant it to ordinary administrators or operators.
5. Configure and verify the realm's application sign-in and role mappings:

   ```powershell
   npm run keycloak:app-sign-in:apply
   npm run keycloak:app-sign-in:check
   npm run keycloak:account:repair
   npm run keycloak:master-admin:apply
   npm run keycloak:master-admin:check
   ```

6. Sign in to `http://app.localhost:1008` with the new `inout` user. If the account has a temporary password, InOut displays its inline **Change temporary password** form. Enter the temporary password, a new password and confirmation, plus an authenticator code when configured. The app's private Keycloak extension verifies and updates the credential without a browser redirect. Successful setup returns to ordinary app sign-in; sign in with the new password afterward. Signed-in users can also change their password from **Account and security → Password**. Other account controls remain previews while the organization chooses its long-term identity provider.

The administration gateway is bound to host loopback. Stop it when you do not need the provider console with `docker compose stop keycloak-admin`; restart it with `docker compose up -d --wait keycloak-admin`. The normal public identity listener continues to serve app sign-in while the admin gateway is stopped.

## 4. Configure the organization and begin using the app

The first application master-admin can use **Manage users** to create administrator login accounts, assign their application roles and zones, and create operators. Zone admins can use the same page to add operators, but only at checkpoints in their assigned zones. Require a front-gate checkpoint for each zone; create optional back gates or other checkpoints as the organization needs. Give zone-scoped administrators only the zones they manage. Operators need a checkpoint assignment to scan.

Then set up normal operations:

1. Use **Registry** to create employees, visitors, and hardware records.
2. Use **Permissions** to grant the appropriate zone and checkpoint access.
3. Sign in to `/terminal` as an assigned operator and scan a registered barcode.
4. Review movement history, alerts, and audit activity in the admin pages. Alert evaluation runs on the Temporal schedule; manual evaluation is also available to an administrator.

Creating a Keycloak login account and creating a Registry person are separate actions. An employee or visitor must have a Registry record and suitable permission to receive access decisions at the terminal.

## 5. Optional development fixtures

Normal startup does not seed mock people or assets. For local demonstrations only, the backend also provides `demo`, `additional`, and `test` seed modes. For example:

```powershell
docker compose run --rm --no-deps backend-init python seed.py demo
```

Do not run demo or test seed modes in an organization database.

## 6. Reset the disposable development PostgreSQL data

Only use this procedure for a disposable local environment. The Compose PostgreSQL volume contains the InOut, Keycloak, and Temporal databases. Removing it erases application records, identity accounts and settings, and workflow history. It does not remove the separate Prometheus volume.

Stop the stack, including the Keycloak administration gateway:

```powershell
docker compose down
```

Check that the intended volume belongs to this Compose project before deleting it:

```powershell
docker volume inspect --format '{{.Name}} {{index .Labels "com.docker.compose.project"}}' in-out_pg-primary-data
```

For this checkout, the expected project label is `in-out`. If the volume name or project label differs, inspect the project volumes and use the exact disposable development volume. Then remove only the PostgreSQL volume and start from empty state:

```powershell
docker volume rm in-out_pg-primary-data
docker compose up --build -d --wait
```

Do not use `docker compose down -v` for this reset: it removes every named volume in the Compose project, including observability data.

## Production deployment notes

- Replace every development secret with a unique production secret before first startup, and store it in a secret manager rather than source control.
- Back up PostgreSQL before upgrades. The named PostgreSQL volume is the persistence boundary for app, Keycloak, and Temporal data.
- Provision the first InOut `master-admin` deliberately through the `inout` realm. Keep Keycloak's server-level `master` administrator credentials separate and tightly controlled.
- The local HTTP and loopback gateway settings are for trusted development workstations. Configure production hostnames, TLS, network exposure, backups, and monitoring for the organization's deployment environment.
