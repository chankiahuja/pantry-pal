# GS-205: Render staging PostgreSQL to Neon Free

This runbook applies to PantryPal development/staging only. It does not change live infrastructure, production, the staging URL, or the existing Render database. Do not put credentials, OTPs, connection strings with passwords, database dumps or customer data in GitHub, Git, screenshots or logs.

## Application configuration

The production Spring profile uses a non-blank `DB_URL` when it is present:

```text
DB_URL=jdbc:postgresql://<neon-host>/<database>?sslmode=require
DB_USER=<neon-role>
DB_PASSWORD=<neon-password>
SPRING_PROFILES_ACTIVE=production
```

`sslmode=require` is mandatory for this migration. Copy the hostname, database name, role and password from the Neon Console, and convert Neon’s `postgresql://...` URL to `jdbc:postgresql://...`. Preserve any additional provider query parameters that Neon supplies, URL-encoding password characters when they appear in a URL. Use the direct/unpooled endpoint for `pg_dump` and `pg_restore`; test the pooled endpoint separately before selecting it for application runtime.

When `DB_URL` is absent or empty, the application retains the existing Render-compatible fallback:

```text
jdbc:postgresql://${DB_HOST}:${DB_PORT}/${DB_NAME}
```

If both values are present, the non-blank `DB_URL` wins. If an operator supplies a direct `spring.datasource.url` override, it is also preserved for controlled local/test launches.

Flyway remains enabled with the existing versioned migrations. It validates and applies only pending migrations; it does not overwrite existing tables or data. Do not add a baseline or edit an applied migration.

## Before cutover

1. Confirm the staging service is on the accepted `GS-205` revision and record the current Render database name, PostgreSQL major version, region, size, expiry date, and the effective `DB_*` variable names. Re-check current Neon Free quotas, region, SSL behavior and Render outbound connectivity.
2. Create a Neon project on the Free plan in a region near the Render web service. Create/select the target database and role. Keep the direct endpoint and credentials in an approved password manager or protected local environment only.
3. Schedule a short staging write freeze. Stop or pause the staging web service during the final export so writes cannot occur after the backup point.
4. Install PostgreSQL client tools compatible with the source server major version. Set secrets in a local PowerShell session without printing them:

```powershell
$env:RENDER_DATABASE_URL = 'postgresql://USER:PASSWORD@RENDER_HOST:5432/DBNAME?sslmode=require'
$env:NEON_DATABASE_URL = 'postgresql://USER:PASSWORD@NEON_HOST/DBNAME?sslmode=require'
```

Do not save these values in a tracked file or paste them into command history, tickets or logs. If passwords contain URL-reserved characters, use correctly URL-encoded URLs or use libpq environment variables instead.

## Existing-data migration (default path)

Run from a secure directory outside the repository, with staging writes paused:

```powershell
pg_dump --dbname="$env:RENDER_DATABASE_URL" --format=custom --no-owner --no-acl --file='C:\secure\pantrypal-staging.dump'
pg_restore --list 'C:\secure\pantrypal-staging.dump' > 'C:\secure\pantrypal-staging.contents.txt'
if ($LASTEXITCODE -ne 0) { throw 'Backup listing failed' }

pg_restore --dbname="$env:NEON_DATABASE_URL" --no-owner --no-acl --exit-on-error --single-transaction --verbose 'C:\secure\pantrypal-staging.dump'
```

Before restoring, confirm the Neon database is empty or disposable. Do not restore over valuable data. Compare source and target table counts, Flyway history, sequences and representative records with `psql`; keep the results redacted. The existing isolated backup/restore drill in [GS-136](GS-136-BACKUP-RESTORE.md) is the reusable local verification tool, but it is not a substitute for validating this operator backup.

## Fresh Neon database (approval required)

Do not use this path without explicit owner approval recorded in the issue. It discards the current staging data rather than migrating it. Create an empty Neon database, configure the same `DB_URL`, `DB_USER` and `DB_PASSWORD`, and let Flyway create the schema on the first application start. Verify that all expected migrations are applied, then run the staging smoke tests. Retain the Render database until the owner accepts the fresh staging reset.

## Configure Render staging

In the Render dashboard, open the existing `pantrypal-staging` web service and Environment settings. Add or edit these protected values:

- `SPRING_PROFILES_ACTIVE=production`
- `DB_URL=jdbc:postgresql://<neon-host>/<database>?sslmode=require`
- `DB_USER=<neon-role>`
- `DB_PASSWORD=<neon-password>`
- Keep the existing `AUTH_OTP_SECRET`, `AUTH_COOKIE_SECURE=true`, and approved mail/support variables unchanged.

The checked-in [Render Blueprint](../render.yaml) marks `DB_URL`, `DB_USER` and `DB_PASSWORD` as `sync: false`. Render prompts for these values when a new Blueprint is first created; when an existing Blueprint is updated, Render ignores them, so they must be entered manually for a newly provisioned service and are preserved on later syncs. `DB_HOST`, `DB_PORT` and `DB_NAME` remain sourced from the existing Render database as a fallback. The `pantrypal-staging-db` resource remains in the Blueprint intentionally for rollback and legacy fallback; it is not used while a non-blank Neon `DB_URL` is configured. Do not remove or decommission the Render database during validation.

Save the protected values, trigger a redeploy/restart, and keep the existing staging URL. Inspect logs for authentication, DNS, TLS, Flyway, timeout and connection-pool errors.

## Verification after deployment

Run health/readiness and test, without logging secrets:

1. Confirm startup completes and Flyway reports a valid current schema with no unexpected pending or failed migrations.
2. Test login/OTP where available, inventory create/update/delete, shopping-list creation/editing/purchase completion, wishlist operations, and database writes after a restart.
3. Leave the service idle long enough for Neon compute suspension, then repeat a read and write to verify wake-up behavior.
4. Compare key table counts, representative records and identity sequences against the pre-cutover baseline.
5. Confirm the existing staging URL and API response behavior are unchanged.

Retain the Render database and verified backup for an agreed observation window. Decommissioning the old database requires separate approval and is outside this change.

## Rollback

If verification fails, stop staging writes and restore the complete saved Render database configuration before restarting:

- Remove or clear `DB_URL` so the split Render URL fallback is selected.
- Restore the original Render `DB_USER`.
- Restore the original Render `DB_PASSWORD`.
- Restore `DB_HOST`, `DB_PORT` and `DB_NAME` if they were changed during cutover.
- Leave `SPRING_PROFILES_ACTIVE=production`, `AUTH_OTP_SECRET`, `AUTH_COOKIE_SECURE` and the approved mail/support variables unchanged unless the saved pre-cutover configuration says otherwise.

Redeploy/restart and repeat the smoke tests. Any writes made to Neon after cutover will not automatically exist in Render; reconcile or explicitly discard them before rollback. Keep both databases until the owner accepts the result.

## Safety limits

Neon Free compute suspension, quotas, region availability and Render outbound networking must be checked against current provider terms. Free-tier behavior is not a production availability guarantee. This migration changes staging infrastructure only and introduces no HikariCP tuning or new dependencies.
