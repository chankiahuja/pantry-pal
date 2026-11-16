# Environment and local development

> **Start here:** Run PantryPal locally with Spring Boot + H2, Docker Compose + PostgreSQL, or the browser-only demo. Advanced operational procedures are preserved in the [detailed environment reference](ENVIRONMENT-DETAILED-REFERENCE.md).

**Quick links:** [Run locally](#run-locally) · [Configuration](#configuration-at-a-glance) · [Deployment boundaries](#deployment-boundaries) · [Troubleshooting](#troubleshooting)

## Choose a runtime

| Mode | What you need | Where data lives | Authentication |
| --- | --- | --- | --- |
| **Full-stack local (default)** | Node.js 24, pnpm 10.26.1, JDK 17+, Mailpit | File-backed H2 | Real email OTP and server sessions |
| **Docker Compose** | Docker / Compose | PostgreSQL 17 volume | Real email OTP with included Mailpit |
| **Browser-only demo** | Node.js 24, pnpm 10.26.1 | Browser localStorage | Mock OTP `123456` (not a Spring session) |
| **Native PostgreSQL** | Full-stack tools + a PostgreSQL instance | Configured PostgreSQL database | Real email OTP and server sessions |

Docker builds with Java 21. The repository's Maven wrapper means global Maven installation is optional.

## Run locally

### Spring Boot + H2 (recommended first run)

1. Start Mailpit locally, using SMTP on `127.0.0.1:1025` and the inbox at `http://localhost:8025`:

   ```sh
   mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025
   ```

   On Windows PowerShell, an executable in the working directory may require `./mailpit.exe` (or `.\mailpit.exe`) instead.

2. From the repository root:

   ```sh
   npx pnpm@10.26.1 install
   npx pnpm@10.26.1 start
   ```

3. Open `http://localhost:8080`. The root start script builds React, loads an optional ignored root `.env`, and launches Spring Boot. Flyway initializes local H2; data persists across restarts.

**Windows:** Set `JAVA_HOME` to your actual JDK before launching (for example, `$env:JAVA_HOME = 'C:/Program Files/Java/jdk-17'`). If Mailpit is not installed, use Docker Compose or install it before testing full-stack email login.

### Docker Compose + PostgreSQL

```sh
docker compose up --build -d
```

Open `http://localhost:8080`; Mailpit is available at `http://localhost:8025`. Compose supplies PostgreSQL and Mailpit containers. Stop the services with `docker compose down`; the PostgreSQL volume remains. Stop native Mailpit first to avoid port conflicts.

### Browser-only demo

```sh
npx pnpm@10.26.1 install
npx pnpm@10.26.1 dev:mock
```

Open `http://localhost:5173`. This uses mock endpoints and localStorage, with no Spring API, SMTP or SSE connection. It is intended for UI exploration rather than validating real authentication or persistence.

### Native PostgreSQL or Vite hot reload

For PostgreSQL, set `SPRING_PROFILES_ACTIVE=postgres` and configure `DB_URL`, `DB_USER`, `DB_PASSWORD` before starting Spring. Local H2 data is **not** migrated automatically when switching profiles.

For hot reload, start Spring first and run `npx pnpm@10.26.1 dev` from the root. Vite runs on port 5173 and proxies `/api` (including SSE) to Spring on 8080.

## Configuration at a glance

The project includes [`.env.example`](../.env.example). The root `pnpm start` script reads an optional ignored root `.env`; launching Maven independently requires shell/IDE variables. Compose also reads the root `.env`.

| Group | Variables | Key rule |
| --- | --- | --- |
| Database | `SPRING_PROFILES_ACTIVE`, `PANTRYPAL_DATA_DIR`, `DB_URL`, `DB_USER`, `DB_PASSWORD` | H2 is default locally; PostgreSQL requires its profile |
| Application / Vite | `API_PORT`, `PORT`, `API_TARGET`, `BASE_PATH` | Spring defaults to 8080, Vite to 5173 |
| Email | `MAIL_HOST`, `MAIL_PORT`, `MAIL_FROM`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_SMTP_AUTH`, `MAIL_STARTTLS` | Mailpit for local testing; authenticated external SMTP requires TLS |
| Compose SMTP | `PANTRYPAL_SMTP_HOST`, `PANTRYPAL_SMTP_PORT` | Defaults to the Compose Mailpit service |
| Authentication | `AUTH_OTP_SECRET`, `AUTH_COOKIE_SECURE`, `AUTH_OTP_LIFETIME_SECONDS`, `AUTH_RESEND_COOLDOWN_SECONDS`, `AUTH_MAX_ATTEMPTS` | OTP defaults: 300 seconds / 30 seconds / 5 attempts; use a stable 32+ byte secret in deployment |
| Notifications | `EXPIRY_CHECK_MS` | Scheduler defaults to 60,000 ms |
| Support | `PANTRYPAL_SUPPORT_EMAIL`, `PANTRYPAL_SUPPORT_RESPONSE_TIME` | Do not claim mail delivery or a response promise unless configured and verified |
| Optional previews | `VITE_ENABLE_MOBILE_PREVIEW`, `DEMO_SEED_EMAIL` | Mobile flag only exposes an unauthenticated preview; no SMS |

All original defaults and extended configuration explanations remain in the [detailed reference](ENVIRONMENT-DETAILED-REFERENCE.md#variables).

## Deployment boundaries

| Area | Required distinction |
| --- | --- |
| **Render staging** | `render.yaml`: free Docker web service and free PostgreSQL in Oregon, on the staging integration branch `GS-134`; **not production** |
| **Proposed production** | `render.production.yaml`: separate Singapore resources and `main` branch; preparation does not prove deployment |
| **Production profile** | Includes PostgreSQL; requires HTTPS-safe cookies, a stable OTP secret and a trusted proxy |
| **Pre-launch operator gate** | Production configuration enables a separate HTTP Basic access gate; its code is not evidence of completed release acceptance |
| **SMTP and feedback** | Protected settings and live acceptance/inbox delivery must be verified; never expose credentials or disable required TLS |
| **Backup and account deletion** | Local restore tests do not establish production backup readiness or provider/mailbox deletion |

**Dated provider guidance:** The former guide contains Render Free-plan and SMTP port recommendations, including a possible port 2525 path. Those observations are **not live verification**. Re-check effective Render settings, SMTP/STARTTLS support and delivery before enabling public use; see the [detailed staging procedure](ENVIRONMENT-DETAILED-REFERENCE.md#render-staging-and-separate-production), [production plan](GS-141-PRODUCTION-PLAN.md), and [data deletion gates](GS-137-DATA-DELETION.md).

## Advanced operational procedures

| Task | Reference |
| --- | --- |
| Configure mobile preview and country selector | [Mobile preview opt-in](ENVIRONMENT-DETAILED-REFERENCE.md#mobile-preview-opt-in) |
| Claim legacy unowned records (operator-only) | [Legacy ownership procedure](ENVIRONMENT-DETAILED-REFERENCE.md#claiming-legacy-shared-pantry-data) |
| Production access gate, proxy and secret handling | [Production profile and access gate](ENVIRONMENT-DETAILED-REFERENCE.md#production-profile-and-reverse-proxy) |
| Run isolated PostgreSQL smoke tests | [Detailed PostgreSQL testing steps](ENVIRONMENT-DETAILED-REFERENCE.md#claiming-legacy-shared-pantry-data) |
| Backup/export and restore reconciliation | [Backup/restore runbook](GS-136-BACKUP-RESTORE.md) |
| Configure and validate email OTP | [Email OTP guide](EMAIL-OTP-AUTH-FLOW.md) |

**Never run destructive tests, legacy ownership SQL, or restore drills against staging, production or a normal application database.** Use isolated test databases and verified backups.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Mail code not received | Mailpit is running, `MAIL_HOST`/`MAIL_PORT` are correct, and SMTP delivery is configured; demo OTP does not arrive by email |
| Port 5432 or Mailpit ports in use | Stop the conflicting service or adjust both the host mapping and connection settings |
| Flyway rejects an old non-empty database | Start with a fresh Flyway-managed database; do not baseline Drizzle data blindly |
| Java/Maven wrapper fails | Check `JAVA_HOME`, JDK version and network access for Maven downloads |
| Alerts missing | Check stock/expiry data, UTC date rules, `/api/suggestions`, and SSE connectivity; polling is the fallback |
| Frontend changes not visible | Rebuild or restart the full-stack runtime; browser-only Vite supports hot reload |

**Limits:** Account-scoped inventory is implemented; household sharing is not. SSE is a process-local refresh mechanism, not a durable notification inbox. See [architecture](ARCHITECTURE.md) for the overall design.
