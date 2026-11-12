# Coordinated database backup and restore

This procedure captures and rehearses recovery of the shared PostgreSQL
instance. It includes the application and Keycloak schema in `inout`, both
Temporal databases, and PostgreSQL global roles. PostgreSQL is the persistence
boundary for application records, Keycloak users/credentials, and durable
workflow history. A dump of only `inout` is incomplete.

Use the exact deployed source revision, Compose files, image versions, and
protected configuration when restoring. This guide does not name an old commit:
record the revision and images that are actually deployed at backup time.

## What this recovery set includes

- `inout`: application tables in `public` and Keycloak tables in `keycloak`.
- `temporal` and `temporal_visibility`: workflow history and visibility data.
- PostgreSQL global roles, memberships, and password hashes.
- A separate, encrypted copy of the matching `.env`/secret-manager values,
  Compose overlays, custom Keycloak image inputs, and deployed software
  revision. Never put secret values in the Git repository or in this folder.

Redis is deliberately volatile in this project and is not captured here. It
contains quotas, leases, and application token-revocation markers. If Redis is
lost in an incident, keep browser/API access closed until the security team has
reviewed token revocation exposure and followed the deployment's session
recovery policy. Restoring PostgreSQL does not restore those Redis markers.
Prometheus history and renewable Caddy certificate volumes are also outside
this business-data recovery set.

## Take a coordinated backup

1. Schedule a maintenance window. Stop every writer and ingress while keeping
   `postgres-primary` running. Stop the scheduler/bootstrap service as well as
   the API and workflow components:

   ```text
   docker compose stop kong keycloak-admin app python-api temporal-worker backend-init keycloak temporal
   docker compose ps -a
   ```

   For a shared deployment, also stop the public Caddy edge using the same
   Compose file list used to deploy it. Confirm the stopped services remain
   stopped until all dumps are copied. Do not stop PostgreSQL. Wait for
   migrations and provisioning jobs to finish before the maintenance window;
   if the opt-in `demo-seed` profile is active, let it finish and leave it off
   during the backup.

2. Create a new, private backup folder on the host. The database dumps and
   globals file contain sensitive identity and business data; keep them in
   encrypted storage with access limited to recovery operators.

   PowerShell (set `$backupRoot` to an encrypted local volume or mounted
   encrypted backup location):

   ```powershell
   $backupRoot = 'E:\EncryptedBackups\inout'
   $backup = Join-Path $backupRoot (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
   New-Item -ItemType Directory -Path $backup
   ```

   macOS/Linux (set `backupRoot` to an encrypted volume or mounted encrypted
   backup location):

   ```sh
   backupRoot="/Volumes/EncryptedBackups/inout"
   backup="$backupRoot/$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$backup"
   ```

3. Use the PostgreSQL superuser to capture global roles, then one custom-format
   archive per database. `--create` stores each database's owner and creation
   settings in its archive. Keep ownership and ACLs; do not add `--no-owner` or
   `--no-acl`. This image listens on TCP port `1020` inside the container and
   does not provide the usual local Unix socket. Set `PGPASSWORD` from the
   container's existing environment and pass `-h 127.0.0.1 -p 1020` to every
   PostgreSQL client command.

   ```text
   docker compose exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dumpall -h 127.0.0.1 -p 1020 -U inout --globals-only --file=/tmp/roles.sql'
   docker compose exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -h 127.0.0.1 -p 1020 -U inout --format=custom --create --file=/tmp/inout.dump inout'
   docker compose exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -h 127.0.0.1 -p 1020 -U inout --format=custom --create --file=/tmp/temporal.dump temporal'
   docker compose exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -h 127.0.0.1 -p 1020 -U inout --format=custom --create --file=/tmp/temporal_visibility.dump temporal_visibility'
   ```

   Capture aggregate row counts while the writers are stopped, using the
   platform-specific commands in the next step. These counts contain no names
   or barcodes; compare them with the isolated restore before starting any
   recovered service.

4. Copy all four artifacts to the new host folder. In PowerShell, keep the
   `$backup` variable from step 2; in macOS/Linux, keep the `$backup` shell
   variable from step 2.

   ```text
   docker compose cp postgres-primary:/tmp/roles.sql "$backup/roles.sql"
   docker compose cp postgres-primary:/tmp/inout.dump "$backup/inout.dump"
   docker compose cp postgres-primary:/tmp/temporal.dump "$backup/temporal.dump"
   docker compose cp postgres-primary:/tmp/temporal_visibility.dump "$backup/temporal_visibility.dump"
   ```

   Record the source revision used to build the deployed images and the actual
   running image list next to the backup. Keep this metadata free of secrets.
   A dirty worktree or an unidentified image means the software revision is
   not reproducible; do not mark that set as handoff-ready.

   PowerShell:

   ```powershell
   $inoutSql = @'
   SELECT 'subjects=' || count(*) FROM public.subjects
   UNION ALL SELECT 'movements=' || count(*) FROM public.movements
   UNION ALL SELECT 'pending_permissions=' || count(*) FROM public.permission_requests WHERE data->>'status'='pending'
   UNION ALL SELECT 'pending_outbox=' || count(*) FROM public.event_outbox WHERE delivered_at IS NULL
   UNION ALL SELECT 'keycloak_users=' || count(*) FROM keycloak.user_entity
   ORDER BY 1;
   '@
   $temporalSql = @'
   SELECT 'open_workflows=' || count(*) FROM public.current_executions;
   '@
   $visibilitySql = @'
   SELECT 'visible_workflows=' || count(*) FROM public.executions_visibility;
   '@
   $psqlInout = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -p 1020 -U inout -d inout -At'
   $psqlTemporal = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -p 1020 -U inout -d temporal -At'
   $psqlVisibility = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -p 1020 -U inout -d temporal_visibility -At'
   $inoutSql | docker compose exec -T postgres-primary sh -c $psqlInout | Set-Content -Encoding utf8 (Join-Path $backup 'state-inout.txt')
   $temporalSql | docker compose exec -T postgres-primary sh -c $psqlTemporal | Set-Content -Encoding utf8 (Join-Path $backup 'state-temporal.txt')
   $visibilitySql | docker compose exec -T postgres-primary sh -c $psqlVisibility | Set-Content -Encoding utf8 (Join-Path $backup 'state-temporal-visibility.txt')
   if ($LASTEXITCODE -ne 0) { throw 'Could not capture PostgreSQL state counts' }
   git rev-parse HEAD | Set-Content -Encoding utf8 (Join-Path $backup 'source-commit.txt')
   git status --short | Set-Content -Encoding utf8 (Join-Path $backup 'source-status.txt')
   docker compose config --images | Set-Content -Encoding utf8 (Join-Path $backup 'compose-images.txt')
   docker compose images | Set-Content -Encoding utf8 (Join-Path $backup 'running-images.txt')
   ```

   macOS/Linux:

   ```sh
   docker compose exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -p 1020 -U inout -d inout -At' > "$backup/state-inout.txt" <<'SQL'
   SELECT 'subjects=' || count(*) FROM public.subjects
   UNION ALL SELECT 'movements=' || count(*) FROM public.movements
   UNION ALL SELECT 'pending_permissions=' || count(*) FROM public.permission_requests WHERE data->>'status'='pending'
   UNION ALL SELECT 'pending_outbox=' || count(*) FROM public.event_outbox WHERE delivered_at IS NULL
   UNION ALL SELECT 'keycloak_users=' || count(*) FROM keycloak.user_entity
   ORDER BY 1;
   SQL
   docker compose exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -p 1020 -U inout -d temporal -At' > "$backup/state-temporal.txt" <<'SQL'
   SELECT 'open_workflows=' || count(*) FROM public.current_executions;
   SQL
   docker compose exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -p 1020 -U inout -d temporal_visibility -At' > "$backup/state-temporal-visibility.txt" <<'SQL'
   SELECT 'visible_workflows=' || count(*) FROM public.executions_visibility;
   SQL
   git rev-parse HEAD > "$backup/source-commit.txt"
   git status --short > "$backup/source-status.txt"
   docker compose config --images > "$backup/compose-images.txt"
   docker compose images > "$backup/running-images.txt"
   ```

   Record the exact Compose overlay filenames, Temporal server/schema version,
   Keycloak image version, and secret-manager version identifiers as well. Keep
   the matching secret values in the organization's protected secret store,
   not in the backup folder or Git.

5. Generate SHA-256 checksums for the four database artifacts. Verify all four
   checksums before any restore.

   PowerShell:

   ```powershell
   $checksums = foreach ($name in 'roles.sql','inout.dump','temporal.dump','temporal_visibility.dump') {
     $hash = Get-FileHash (Join-Path $backup $name) -Algorithm SHA256
     [pscustomobject]@{ File = $name; SHA256 = $hash.Hash }
   }
   $checksums | Export-Csv -NoTypeInformation -Encoding utf8 (Join-Path $backup 'SHA256SUMS.csv')
   Import-Csv (Join-Path $backup 'SHA256SUMS.csv') | ForEach-Object {
     if ((Get-FileHash (Join-Path $backup $_.File) -Algorithm SHA256).Hash -ne $_.SHA256) { throw "Checksum mismatch: $($_.File)" }
   }
   ```

   macOS:

   ```sh
   (cd "$backup" && shasum -a 256 roles.sql inout.dump temporal.dump temporal_visibility.dump > SHA256SUMS)
   (cd "$backup" && shasum -a 256 -c SHA256SUMS)
   ```

   Linux:

   ```sh
   (cd "$backup" && sha256sum roles.sql inout.dump temporal.dump temporal_visibility.dump > SHA256SUMS)
   (cd "$backup" && sha256sum --check SHA256SUMS)
   ```

   Copy the completed folder to encrypted off-host storage. Restore persistent
   writers only after the dumps and checksums are complete. Remove the staged
   database files from the PostgreSQL container's temporary filesystem:

   ```text
   docker compose exec -T postgres-primary rm -f /tmp/roles.sql /tmp/inout.dump /tmp/temporal.dump /tmp/temporal_visibility.dump
   docker compose start temporal keycloak backend-init temporal-worker python-api app keycloak-admin kong
   ```

   Confirm normal health and logs. Restart Caddy separately for a shared
   deployment.

## Rehearse an isolated restore

Do this for each backup before relying on it for handoff. Restore into a fresh,
separately named Compose project, never the operational project's volume. The
recovery overlay gives the drill its own volume and networks, disables public
listeners, and prevents outbound traffic. Do not add `compose.shared.yaml` to
the drill. If the deployment uses a Temporal compatibility overlay, include
that exact overlay before `compose.restore-drill.yaml`.

The recovery overlay assigns fixed `/28` ranges under `10.254.250.0/24` to
every project network because Docker Desktop may exhaust its automatic address
pools. Reserve that `/24` for recovery drills and check it against the host's
VPN and LAN routes. If it overlaps, change every network range in
`compose.restore-drill.yaml` together. Set the overlay's `RESTORE_*_IMAGE`
overrides to the exact image tags or digests from the backup manifest; its
defaults are for the repository's local development tags.

The image overrides are `RESTORE_POSTGRES_IMAGE`, `RESTORE_REDIS_IMAGE`,
`RESTORE_KEYCLOAK_IMAGE`, `RESTORE_KEYCLOAK_ADMIN_IMAGE`, `RESTORE_KONG_IMAGE`,
`RESTORE_APP_IMAGE`, `RESTORE_BACKEND_INIT_IMAGE`, `RESTORE_DB_PROVISION_IMAGE`,
`RESTORE_PYTHON_API_IMAGE`, `RESTORE_TEMPORAL_WORKER_IMAGE`,
`RESTORE_TEMPORAL_NAMESPACE_IMAGE`, and `RESTORE_TEMPORAL_SCHEMA_IMAGE`.
Temporal server uses the digest pinned in the Compose file. Load the matching
images from the versioned registry or build them from the exact recorded source
revision before starting the recovery project; never use whatever `latest`
image happens to be available.

1. Verify the four SHA-256 checksums. Select a unique project name and a
   temporary random `RESTORE_ADMIN_PASSWORD` of at
   least 32 URL-safe characters. Keep that value only in the current shell or
   secret manager. Do not reuse any production database password.

   PowerShell:

   ```powershell
   $backup = '.data/backups/<backup-id>'
   $project = 'inout-restore-<unique-id>'
   $env:RESTORE_ADMIN_PASSWORD = '<temporary-random-secret>'
   ```

   macOS/Linux:

   ```sh
   backup='.data/backups/<backup-id>'
   project='inout-restore-<unique-id>'
   export RESTORE_ADMIN_PASSWORD='<temporary-random-secret>'
   ```

2. Start only PostgreSQL in the isolated project. This creates a fresh,
   project-scoped volume with a separate temporary recovery administrator and
   no host listener. Add the exact Temporal overlay, if applicable, before the
   recovery overlay in every command below.

   ```text
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml up -d --no-build --pull never --wait postgres-primary
   ```

3. Copy the four artifacts into the isolated container, then restore global
   roles first. Restore each database from its archive as the temporary
   recovery superuser. `pg_restore --create` recreates the original database
   names, owners, and ACLs.

   ```text
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml cp "$backup/roles.sql" postgres-primary:/tmp/roles.sql
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml cp "$backup/inout.dump" postgres-primary:/tmp/inout.dump
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml cp "$backup/temporal.dump" postgres-primary:/tmp/temporal.dump
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml cp "$backup/temporal_visibility.dump" postgres-primary:/tmp/temporal_visibility.dump
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml exec -T postgres-primary sh -c 'set -e; export PGPASSWORD="$POSTGRES_PASSWORD"; psql -h 127.0.0.1 -p 1020 -U recovery_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/roles.sql; pg_restore -h 127.0.0.1 -p 1020 -U recovery_admin --dbname=postgres --create --exit-on-error /tmp/inout.dump; pg_restore -h 127.0.0.1 -p 1020 -U recovery_admin --dbname=postgres --create --exit-on-error /tmp/temporal.dump; pg_restore -h 127.0.0.1 -p 1020 -U recovery_admin --dbname=postgres --create --exit-on-error /tmp/temporal_visibility.dump'
   ```

   Replace `<backup-id>` and `<unique-id>` in the shell variable assignments.
   If needed, insert the exact Temporal overlay as an additional `-f` before
   `compose.restore-drill.yaml` in each command.

4. Verify all three databases, restored roles, the app migration marker, and
   the presence of application, identity, and Temporal tables. Run the same
   aggregate-count queries from the backup step now and compare each result
   with `state-inout.txt`, `state-temporal.txt`, and
   `state-temporal-visibility.txt` before starting any recovered service.
   These commands use the recovery administrator password inside the container
   and connect over the configured TCP port.

   PowerShell:

   ```powershell
   function Invoke-RecoveryQuery($database, $sql) {
     $psql = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -p 1020 -U recovery_admin -d {0} -At' -f $database
     $result = $sql | docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml exec -T postgres-primary sh -c $psql
     if ($LASTEXITCODE -ne 0) { throw "Query failed for $database" }
     return $result
   }
   $databases = Invoke-RecoveryQuery 'postgres' @'
   SELECT datname FROM pg_database WHERE datname IN ('inout','temporal','temporal_visibility') ORDER BY datname;
   '@
   $roles = Invoke-RecoveryQuery 'postgres' @'
   SELECT rolname FROM pg_roles WHERE rolname IN ('inout_app','inout_migrator','inout_keycloak','inout_temporal') ORDER BY rolname;
   '@
   $appState = Invoke-RecoveryQuery 'inout' @'
   SELECT 'subjects=' || count(*) FROM public.subjects
   UNION ALL SELECT 'movements=' || count(*) FROM public.movements
   UNION ALL SELECT 'pending_permissions=' || count(*) FROM public.permission_requests WHERE data->>'status'='pending'
   UNION ALL SELECT 'pending_outbox=' || count(*) FROM public.event_outbox WHERE delivered_at IS NULL
   UNION ALL SELECT 'keycloak_users=' || count(*) FROM keycloak.user_entity
   ORDER BY 1;
   '@
   $temporalState = Invoke-RecoveryQuery 'temporal' @'
   SELECT 'open_workflows=' || count(*) FROM public.current_executions;
   '@
   $visibilityState = Invoke-RecoveryQuery 'temporal_visibility' @'
   SELECT 'visible_workflows=' || count(*) FROM public.executions_visibility;
   '@
   $appState | Set-Content -Encoding utf8 (Join-Path $backup 'restore-state-inout.txt')
   $temporalState | Set-Content -Encoding utf8 (Join-Path $backup 'restore-state-temporal.txt')
   $visibilityState | Set-Content -Encoding utf8 (Join-Path $backup 'restore-state-temporal-visibility.txt')
   if (Compare-Object (Get-Content (Join-Path $backup 'state-inout.txt')) (Get-Content (Join-Path $backup 'restore-state-inout.txt'))) { throw 'Application state mismatch' }
   if (Compare-Object (Get-Content (Join-Path $backup 'state-temporal.txt')) (Get-Content (Join-Path $backup 'restore-state-temporal.txt'))) { throw 'Temporal state mismatch' }
   if (Compare-Object (Get-Content (Join-Path $backup 'state-temporal-visibility.txt')) (Get-Content (Join-Path $backup 'restore-state-temporal-visibility.txt'))) { throw 'Temporal visibility state mismatch' }
   $databases
   $roles
   Invoke-RecoveryQuery 'inout' @'
   SELECT version_num FROM public.alembic_version;
   SELECT count(*) AS keycloak_tables FROM information_schema.tables WHERE table_schema='keycloak' AND table_type='BASE TABLE';
   '@
   Invoke-RecoveryQuery 'temporal' "SELECT count(*) AS public_tables FROM pg_tables WHERE schemaname='public';"
   Invoke-RecoveryQuery 'temporal_visibility' "SELECT count(*) AS public_tables FROM pg_tables WHERE schemaname='public';"
   ```

   macOS/Linux: use the same five SQL statements above with the standard
   `docker compose ... exec -T postgres-primary sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; psql -h 127.0.0.1 -p 1020 -U recovery_admin -d <database> -At'` connection. Pipe each SQL block to that command and compare the outputs with the saved `state-*.txt` files using `diff -u`. The database-name, role, migration-version, and table-count queries must return the expected values before starting services.

   The three database names, four service roles, Alembic version, and aggregate
   row counts must match the backup. Record the drill date,
   backup identifier, source commit, Compose/image revisions, command results,
   and operator. Never include secrets or real personal data in the drill log.

5. Start the application services in the isolated project only after the
   database checks pass, using the exact source revision and protected
   configuration from the backup. Do not start the `demo` profile. Confirm
   Keycloak, Temporal, the API, worker, scheduler, and app become healthy; check
   the worker logs for workflow replay errors. Use the known synthetic subject,
   movement, permission, presence row, and pending request recorded before the
   backup. Compare their identifiers and values against the before-backup
   evidence, then sign into the recovered app with the synthetic administrator
   or operator account whose Keycloak identity was included in the backup. For
   a pending request, verify both its `permission_requests` row and its
   `visitor-<request-id>` or `override-<request-id>` workflow in
   `temporal_visibility.executions_visibility`; aggregate table counts alone
   do not prove that a specific request survived. Do not use real-person
   records for entry or exit actions in a restore drill.

   Capture the following rows before the backup and after the restore. Replace
   each placeholder with a synthetic ID; redact or avoid printing names,
   credentials, tokens, and visitor details:

   ```sql
   SELECT s.id, s.kind, s.barcode, p.state, p.entry_building_id
   FROM subjects s LEFT JOIN presence_state p ON p.subject_id=s.id
   WHERE s.id='<synthetic-subject-id>';

   SELECT id, subject_id, direction, result, checkpoint_id
   FROM movements WHERE id='<synthetic-movement-id>';

   SELECT id, subject_id, data->'zones' AS zones
   FROM access_permissions WHERE subject_id='<synthetic-subject-id>';

   SELECT id, subject_id, data->>'status' AS status, data->>'type' AS type
   FROM permission_requests WHERE id='<synthetic-pending-request-id>';
   ```

   The pending request's workflow ID is `visitor-<request-id>` for a visitor
   or `override-<request-id>` for a manual permission override. Confirm that
   workflow ID, type, and open status in the `temporal_visibility` database's
   `executions_visibility` table before and after recovery. Save only the
   synthetic IDs, safe query output, sign-in outcome, and image/revision
   manifest as evidence.

   ```text
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml up -d --no-build --pull never --wait
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml ps -a
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml logs --tail=200 keycloak temporal backend-init python-api temporal-worker app kong
   ```

6. Stop the drill and remove **only its isolated volume** after recording the
   result. Confirm the project name before running this command. Never use the
   operational project name here.

   ```text
   docker compose -p $project -f compose.yaml -f compose.restore-drill.yaml down -v
   ```

## Recovery and cutover

For an incident, restore into a fresh project as above and keep the original
volume untouched. Complete the table/role checks and service replay checks
before routing users to the recovered service. Confirm the restored
`.env`/secret-manager versions, Keycloak image and custom provider, Compose
overlays, PostgreSQL major version, Temporal server/schema version, and worker
revision match the backup manifest. Do not run newer migrations or a Temporal
upgrade until the restored release is verified. Keep the old project isolated
and stopped until the new service is accepted; do not cut over DNS or public
traffic as part of a restore drill.

If Redis was also lost, apply the session recovery policy before reopening
access. Because revocation markers are volatile, restoring PostgreSQL alone
does not reconstitute previously revoked access tokens.

## Roll back a failed upgrade or cutover

Keep the last known-good coordinated database backup, its checksums, the exact
source revision, Compose overlays, image digests, and protected configuration
together as one recovery set. A code rollback by itself is safe only when the
new release has not applied a schema or Temporal change that the old images do
not understand.

1. Stop public ingress and all writers for the failed candidate. Preserve its
logs and database volume for diagnosis; do not delete or overwrite them.
2. If the previous app and worker versions are documented as compatible with
   the current schema and workflow histories, redeploy those exact images and
   Compose files without running newer migrations. Confirm login and the
   acceptance checks before reopening ingress.
3. If compatibility is unknown or a migration/workflow change prevents safe
   rollback, restore the pre-upgrade backup into a **new, isolated Compose
   project and fresh volume** using the matching source revision, image
   digests, schema, Temporal version, and protected configuration. Verify
   checksums, database state, Keycloak sign-in, pending workflow replay, and
   the acceptance checks before moving traffic.
4. Leave the failed candidate and original source volume untouched until the
   receiving owner approves recovery. Never restore over the source database
   or use `down -v` on the operational Compose project.

The rollback target is the coordinated pre-change backup plus its matching
code, image digests, Compose overlays, schema/workflow versions, and protected
secrets. If any member of that set cannot be matched, keep ingress closed and
do not improvise a mixed-version restore.

## Validation record

An isolated database restore and service replay was run on 11 November 2026
from source revision `127d659`. The source worktree was dirty, so this is a
procedure rehearsal rather than final-commit handoff evidence.

- The application/Keycloak database, both Temporal databases, and PostgreSQL
  global roles were dumped while writers were stopped. SHA-256 checksums matched
  after direct container-to-container transfer; no plaintext dump was written
  to the host.
- All three databases, four application roles, the Alembic version, and the
  application, Keycloak, Temporal, and visibility table checks restored
  successfully. Aggregate row counts matched the source snapshot.
- The recovered services started: PostgreSQL, Redis, Keycloak, both Kong
  gateways, app, Python API, Temporal, and worker. Health checks passed where
  defined; bootstrap/schema jobs exited successfully. The worker connected to
  its task queue and had no recent error or traceback in its logs.
- The rehearsal exposed and corrected two runbook gaps: PostgreSQL must be
  reached over TCP port `1020` with its in-container password, and the recovery
  overlay needs explicit network ranges when Docker's automatic pools are full.
  The first Keycloak attempt also used an image without the empty-bootstrap-env
  fix; after building the drill-only image from the current source, Keycloak
  became healthy.
- Encrypted off-host artifact copy and retrieval were not exercised because no
  encrypted backup destination was configured. Set one up and rerun the copy
  and restore from that destination. Repeat this rehearsal on the final clean
  commit with the exact recorded runtime images before treating it as handoff
  evidence.
- The recorded drill did not capture evidence of a successful app login or
  compare a specifically identified synthetic person's movement, permission,
  presence, and pending request/workflow before and after recovery. Its
  aggregate row-count check is useful but does not satisfy those acceptance
  points. Those checks are now explicit in step 5 above and remain pending a
  new isolated rehearsal.
