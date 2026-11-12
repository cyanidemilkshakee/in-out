# Shared HTTPS deployment

This guide adds public browser access to the existing Compose services. It does not replace or remove the app, Kong, FastAPI, Keycloak, PostgreSQL, Redis, Temporal, or the worker. The default `compose.yaml` remains the local deployment; `compose.shared.yaml` adds only Caddy as the TLS edge.

**Deployment status:** the shared-host configuration is a prepared deployment package, not a verified live installation. The example hostnames below must be replaced with the actual Nivetti DNS names and TLS must be exercised on that host. Until HTTPS login, refresh, logout, temporary-password setup, operator scan, administrator approval, and restart persistence are verified there, shared production use is pending. Keep the local stack bound to loopback.

## Configure the host

Use two DNS names that resolve to the deployment host. Configure the same names in `.env` so Caddy's virtual hosts, Keycloak's advertised hostname, Auth.js sessions, and verified token issuers agree:

```dotenv
APP_PUBLIC_HOSTNAME=app.example.com
AUTH_URL=https://app.example.com
KEYCLOAK_PUBLIC_HOSTNAME=auth.example.com
KEYCLOAK_PUBLIC_URL=https://auth.example.com
KEYCLOAK_ADMIN_ORIGIN=
```

Replace the example hostnames. The DNS A/AAAA records must point to this server. Allow inbound TCP ports 80 and 443; UDP 443 is used for HTTP/3. Caddy obtains and renews the certificates and stores them in the `caddy-data` volume.

Choose an unused private Docker subnet for `SHARED_INGRESS_SUBNET` and put `SHARED_CADDY_IP` inside it. Kong trusts forwarded client addresses only from this Caddy IP; keep the pair aligned. The sample in `.env.example` is not guaranteed to be free on your host or VPN.

Keep `KEYCLOAK_ADMIN_ORIGIN` blank. The app and identity provider use these origins consistently:

- Caddy routes the app hostname to Kong's app listener and the identity hostname to Kong's Keycloak listener.
- Compose sets Keycloak's public hostname and app URL from `KEYCLOAK_PUBLIC_URL` and `AUTH_URL`.
- The app and FastAPI validate the Keycloak token issuer derived from `KEYCLOAK_PUBLIC_URL`; Keycloak signing-key reads remain on the private Docker address.
- `AUTH_URL` is the Auth.js session/callback origin and the base for invite links.
- The deployment command adds the exact HTTPS app callbacks, web origin, and logout URLs to the existing Keycloak client before opening Caddy.

The app, API, database, Redis, Temporal server, worker, and Keycloak maintenance gateway have no public host bindings. The remaining host ports in the default Compose setup bind to loopback. The Keycloak admin gateway must not be added to the public Caddy routes.

## Start or update

Keep `.env` out of Git. It contains database, Redis, gateway, Keycloak and app secrets. Use a secret manager or a host-readable environment file with restricted permissions; commit only `.env.example` placeholders. Do not put secrets in command arguments, screenshots, tickets, or pasted logs.

From the repository root, run:

```text
npm run deploy:shared
```

This checks the HTTPS origins and hostnames, builds and starts the existing private services, applies and verifies Keycloak callback and app sign-in settings, stops the loopback maintenance gateway, and then starts Caddy with both Compose files. It preserves named data volumes. On an update, it stops the existing Caddy edge while the new app and identity configuration is checked. If a check fails, public traffic remains stopped; fix `.env` or the Keycloak setup and rerun the command.

After an intentional stop, the normal start command is:

```text
docker compose -f compose.yaml -f compose.shared.yaml --profile shared up -d --wait
```

Before the first shared sign-in, configure Zoho's redirect URI as `https://auth.example.com/realms/inout/broker/zoho/endpoint`, replacing the sample hostname.

## Stop and inspect

Stop all services without deleting data:

```text
docker compose -f compose.yaml -f compose.shared.yaml --profile shared stop
```

To take the public edge offline while leaving the application services running:

```text
docker compose -f compose.yaml -f compose.shared.yaml --profile shared stop caddy
```

Inspect service state and follow logs:

```text
docker compose -f compose.yaml -f compose.shared.yaml --profile shared ps -a
docker compose -f compose.yaml -f compose.shared.yaml --profile shared logs -f --tail=200
```

For focused diagnostics, replace the final command with `logs --tail=200 caddy kong app keycloak python-api`. Review logs locally and redact hostnames, account details, and any accidental credentials before sharing them.

## Recovery

If HTTPS is unavailable, take the edge offline if needed, inspect Caddy and gateway logs, confirm both DNS records and firewall rules, and verify the host ports are not in use:

```text
docker compose -f compose.yaml -f compose.shared.yaml --profile shared stop caddy
docker compose -f compose.yaml -f compose.shared.yaml --profile shared logs --tail=200 caddy kong
docker compose -f compose.yaml -f compose.shared.yaml --profile shared ps -a
```

After fixing a transient service or host issue, restart the existing services without removing data:

```text
docker compose -f compose.yaml -f compose.shared.yaml --profile shared up -d --wait
```

If login redirects fail, confirm `AUTH_URL`, `APP_PUBLIC_HOSTNAME`, `KEYCLOAK_PUBLIC_URL`, and `KEYCLOAK_PUBLIC_HOSTNAME` still match the certificate and DNS names. Then run `npm run deploy:shared`; it reapplies and verifies the Keycloak callbacks, logout URLs, app base URL, and sign-in configuration before reopening Caddy. Do not change `KEYCLOAK_PUBLIC_URL` after users have tokens unless you plan the issuer change and sign-in recovery.

For application or identity data recovery, do not run `docker compose down -v`, remove named volumes, or reset the database. Follow the [coordinated backup and restore runbook](backup-restore.md). A complete restore must include PostgreSQL's application, Keycloak, and Temporal data plus matching protected configuration and runtime revisions; a Caddy certificate volume is renewable and is not a substitute for those backups.

## Local-only Keycloak maintenance

Run Keycloak maintenance scripts from the deployment host with `KEYCLOAK_ADMIN_ORIGIN` blank. They connect through the loopback-only `auth.localhost` admin listener using the administrator credentials in `.env`; they do not need a publicly reachable admin URL. A legacy `KEYCLOAK_ADMIN_CONSOLE_URL` may include `/admin/master/console/`; maintenance requests safely use only its `auth.localhost` origin. Start the gateway only for the maintenance window, run the needed script, then stop it:

```text
docker compose -f compose.yaml -f compose.shared.yaml up -d --wait keycloak-admin
npm run keycloak:public-urls:check
npm run keycloak:app-sign-in:check
docker compose -f compose.yaml -f compose.shared.yaml stop keycloak-admin
```

For browser administration from another workstation, use an SSH tunnel to the host's loopback port rather than publishing the admin gateway.

Never add the admin gateway, PostgreSQL, Redis, Temporal UI, or worker ports to the public proxy or firewall rules.
