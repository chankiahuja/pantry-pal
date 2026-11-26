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

If both values are present, the resolver order is: non-blank `DB_URL`, then a supplied non-blank `spring.datasource.url`, then the split `DB_HOST`/`DB_PORT`/`DB_NAME` fallback. Unset, empty, or whitespace-only `DB_URL` values are treated as absent. JDBC query parameters such as `sslmode=require` are preserved. Direct `spring.datasource.username` and `spring.datasource.password` values take precedence over the YAML mappings from `DB_USER` and `DB_PASSWORD`; otherwise those mappings preserve the existing Render configuration. Missing credentials fail with property names only and never log secret values.

Flyway remains enabled with the existing versioned migrations. It validates and applies only pending migrations; it does not overwrite existing tables or data. Do not add a baseline or edit an applied migration.

## Before cutover

1. Confirm the staging service is on the accepted `GS-205` revision and record the current Render database name, PostgreSQL major version, region, size, expiry date, and the effective `DB_*` variable names. Confirm that the Render expiry date covers the planned migration and rollback window; if it does not, document the recovery plan before cutover. Re-check current Neon Free quotas, region, SSL behavior and Render outbound connectivity.
2. Create a Neon project on the Free plan in a region near the Render web service. Create/select the target database and role. Keep the direct endpoint and credentials in an approved password manager or protected local environment only.
3. Schedule a short staging write freeze. Stop or pause the staging web service during the final export so writes cannot occur after the backup point.
4. Install PostgreSQL client tools compatible with the source server major version. Use password-free libpq URLs and a protected `PGPASSFILE`; never put a password in a connection string or process argument. Keep the Render and Neon URLs separate and use Neon’s direct/unpooled endpoint for the migration:

```powershell
function Read-SecretText([string] $Prompt) {
    $secureValue = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$env:RENDER_DATABASE_URL = Read-Host 'Password-free Render URL (for example postgresql://render_user@render-host:5432/pantrypal?sslmode=require)'
$env:NEON_DATABASE_URL = Read-Host 'Password-free Neon direct URL (for example postgresql://neon_user@ep-example.us-east-2.aws.neon.tech:5432/pantrypal?sslmode=require)'
$renderPassword = Read-SecretText 'Render database password (from password manager)'
$neonPassword = Read-SecretText 'Neon database password (from password manager)'

$renderUri = [Uri] $env:RENDER_DATABASE_URL
$neonUri = [Uri] $env:NEON_DATABASE_URL
$renderDatabase = $renderUri.AbsolutePath.TrimStart('/')
$neonDatabase = $neonUri.AbsolutePath.TrimStart('/')
$renderUser = [Uri]::UnescapeDataString($renderUri.UserInfo)
$neonUser = [Uri]::UnescapeDataString($neonUri.UserInfo)
$renderPort = if ($renderUri.Port -gt 0) { $renderUri.Port } else { 5432 }
$neonPort = if ($neonUri.Port -gt 0) { $neonUri.Port } else { 5432 }
$env:PGPASSFILE = Join-Path $env:TEMP ('pantrypal-pgpass-' + [Guid]::NewGuid().ToString('N'))
@(
    ('{0}:{1}:{2}:{3}:{4}' -f $renderUri.Host, $renderPort, $renderDatabase, $renderUser, $renderPassword)
    ('{0}:{1}:{2}:{3}:{4}' -f $neonUri.Host, $neonPort, $neonDatabase, $neonUser, $neonPassword)
) | Set-Content -LiteralPath $env:PGPASSFILE -Encoding ascii
Remove-Variable renderPassword, neonPassword

function Clear-PantryPalMigrationSecrets {
    $passFile = $env:PGPASSFILE
    Remove-Item Env:RENDER_DATABASE_URL, Env:NEON_DATABASE_URL, Env:PGPASSFILE -ErrorAction SilentlyContinue
    if ($passFile) { Remove-Item -LiteralPath $passFile -Force -ErrorAction SilentlyContinue }
    Remove-Variable renderPassword, neonPassword -Scope 1 -ErrorAction SilentlyContinue
}
trap { Clear-PantryPalMigrationSecrets; throw }
```

The URL values contain no passwords; the password file supplies credentials to libpq for `pg_dump`, `pg_restore` and `psql`. Restrict the temporary file to the current user if required by local policy. Do not save URLs, passwords, the password file or dumps in the repository, command history, tickets or logs. If a password contains `:` or another special character, `PGPASSFILE` avoids URL-encoding it. Do not use a `PGPASSWORD` process argument or environment variable.

## Existing-data migration (default path)

Run from a secure directory outside the repository, with staging writes paused. This block only creates the backup and never connects to Neon:

```powershell
pg_dump --dbname="$env:RENDER_DATABASE_URL" --format=custom --no-owner --no-acl --file='C:\secure\pantrypal-staging.dump'
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed; do not restore the archive' }
```

Inspect the archive before any target command:

```powershell
pg_restore --list 'C:\secure\pantrypal-staging.dump' > 'C:\secure\pantrypal-staging.contents.txt'
if ($LASTEXITCODE -ne 0) { throw 'Backup listing failed' }
```

## Confirm the restore target

The target must be empty or explicitly disposable. First inspect the intended Neon target, then require an explicit confirmation before restoring:

```powershell
psql "$env:NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_user, current_schema();"
if ($LASTEXITCODE -ne 0) { throw 'Neon target inspection failed' }

$confirmation = Read-Host 'Type NEON-EMPTY-OR-DISPOSABLE to authorize restore into this exact target'
if ($confirmation -cne 'NEON-EMPTY-OR-DISPOSABLE') { throw 'Restore cancelled; target was not confirmed' }
```

Do not restore over valuable data. Keep this confirmation block separate from the backup block so copying the backup commands cannot initiate a restore.

## Restore the archive

Run only after the target confirmation succeeds:

```powershell
pg_restore --dbname="$env:NEON_DATABASE_URL" --no-owner --no-acl --exit-on-error --single-transaction --verbose 'C:\secure\pantrypal-staging.dump'
if ($LASTEXITCODE -ne 0) { throw 'Restore failed' }
```

## Compare source and target

The same password-free URLs and `PGPASSFILE` remain available for both source and target checks. Run each command separately, redact output, and retain the comparison with the migration record:

```powershell
$verificationSql = @"
SELECT 'flyway' AS check_name, version, success FROM flyway_schema_history ORDER BY installed_rank;
SELECT 'row_counts' AS check_name, table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), true, false, '')))[1]::text::bigint AS row_count
  FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
SELECT 'sequences' AS check_name, schemaname, sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename;
"@

psql "$env:RENDER_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c $verificationSql > 'C:\secure\render-verification.txt'
if ($LASTEXITCODE -ne 0) { throw 'Render verification failed' }
psql "$env:NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c $verificationSql > 'C:\secure\neon-verification.txt'
if ($LASTEXITCODE -ne 0) { throw 'Neon verification failed' }

psql "$env:RENDER_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT id FROM accounts ORDER BY id LIMIT 5;" > 'C:\secure\render-representative-records.txt'
if ($LASTEXITCODE -ne 0) { throw 'Render representative-record check failed' }
psql "$env:NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT id FROM accounts ORDER BY id LIMIT 5;" > 'C:\secure\neon-representative-records.txt'
if ($LASTEXITCODE -ne 0) { throw 'Neon representative-record check failed' }
```

After the migration and verification, clear the password file and connection variables. This cleanup is also invoked by the `trap` after a command failure:

```powershell
Clear-PantryPalMigrationSecrets
Remove-Variable renderUri, neonUri, renderDatabase, neonDatabase, renderUser, neonUser, renderPort, neonPort, verificationSql, confirmation -ErrorAction SilentlyContinue
```

The existing isolated backup/restore drill in [GS-136](GS-136-BACKUP-RESTORE.md) is the reusable local verification tool, but it is not a substitute for validating this operator backup.

## Fresh Neon database (approval required)

Do not use this path without explicit owner approval recorded in the issue. It discards the current staging data rather than migrating it. Create an empty Neon database, configure the same `DB_URL`, `DB_USER` and `DB_PASSWORD`, and let Flyway create the schema on the first application start. Verify that all expected migrations are applied, then run the staging smoke tests. Retain the Render database until the owner accepts the fresh staging reset.

## Configure Render staging

In the Render dashboard, open the existing `pantrypal-staging` web service and Environment settings. Add or edit these protected values:

- `SPRING_PROFILES_ACTIVE=production`
- `DB_URL=jdbc:postgresql://<neon-host>/<database>?sslmode=require`
- `DB_USER=<neon-role>`
- `DB_PASSWORD=<neon-password>`
- Keep the existing `AUTH_OTP_SECRET`, `AUTH_COOKIE_SECURE=true`, and approved mail/support variables unchanged.

The checked-in [Render Blueprint](../render.yaml) marks `DB_URL`, `DB_USER` and `DB_PASSWORD` as `sync: false`. Render prompts for these values during initial Blueprint provisioning; when an existing Blueprint is updated, protected values are not replaced by sync, so missing values must be entered manually in the service Environment page. Render fallback therefore requires valid Render credentials to already be present or to be entered manually; the Blueprint no longer obtains username/password automatically. Before the first Blueprint sync with this change, or before replacing any protected credential, verify the effective Render settings and save the original credentials and connection settings securely. `DB_HOST`, `DB_PORT` and `DB_NAME` remain sourced from the existing Render database as a fallback. The `pantrypal-staging-db` resource remains in the Blueprint intentionally for rollback and legacy fallback; it is not used while a non-blank Neon `DB_URL` is configured. Do not remove or decommission the Render database during validation.

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

If verification fails, do not reopen staging until the rollback decision is complete:

1. Freeze staging writes.
2. Reconcile writes made only in Neon, or obtain explicit owner approval to discard them. They do not automatically exist in Render.
3. Confirm that the Render database is reachable and that its expiry date covers the rollback and observation window. If it does not, document the recovery plan before cutover; do not assume the free database will remain available.
4. In Render, remove or clear `DB_URL` and any direct `spring.datasource.url`, `spring.datasource.username` or `spring.datasource.password` override pointing to Neon.
5. Restore the saved Render `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` and `DB_NAME` values. Leave `SPRING_PROFILES_ACTIVE=production`, `AUTH_OTP_SECRET`, `AUTH_COOKIE_SECURE` and approved mail/support variables unchanged unless the saved pre-cutover configuration says otherwise.
6. Restart/redeploy and smoke-test against Render: login/OTP, representative reads, an approved write, Flyway status and the existing staging URL.
7. Reopen staging writes only after the smoke test passes and the owner accepts the reconciled/discarded Neon-write decision.

Keep both databases and the verified backup until the owner accepts the result. Render Free database expiry is a provider constraint; check the current expiry and recovery options before cutover.

## Safety limits

Neon Free compute suspension, quotas, region availability and Render outbound networking must be checked against current provider terms. Free-tier behavior is not a production availability guarantee. This migration changes staging infrastructure only and introduces no HikariCP tuning or new dependencies.
