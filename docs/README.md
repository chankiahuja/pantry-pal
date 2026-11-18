# Pantry Pal documentation index

> **Start here:** [Project README](../README.md) → [System architecture](ARCHITECTURE.md) → [Environment setup](ENVIRONMENT.md). Documents labeled **historical evidence** report specific past revisions or test runs; they are not current acceptance claims.

## Choose what to read

| Your goal | Start with | Status |
| --- | --- | --- |
| Understand Pantry Pal's features and limitations | [Project README](../README.md) | Current project overview |
| Understand components and data flow | [Architecture](ARCHITECTURE.md) | Current quick guide |
| Configure local development | [Environment](ENVIRONMENT.md) | Current quick guide |
| Understand email OTP authentication | [Email OTP flow](EMAIL-OTP-AUTH-FLOW.md) | Current quick guide |
| Understand generated API clients and `lib/` | [Shared library guide](LIB_FOLDER_GUIDE.md) | Current quick guide |
| Plan a controlled production deployment | [Production plan](GS-141-PRODUCTION-PLAN.md) | Preparation / release gates; verify current status before provisioning |
| Review account deletion and privacy gates | [Account deletion](GS-137-DATA-DELETION.md) | Release readiness and dated provider checks |
| Review backup and recovery procedures | [Backup and restore](GS-136-BACKUP-RESTORE.md) | Procedure and local-drill evidence; not production recovery certification |

## Technical references

| Document | Purpose | Status |
| --- | --- | --- |
| [Architecture technical reference](ARCHITECTURE-REFERENCE.md) | Extended diagrams, workflows and implementation rules | Detailed reference |
| [Architecture implementation notes](ARCHITECTURE-IMPLEMENTATION-NOTES.md) | Original implementation explanations | Historical snapshot; some statements predate current deployment |
| [Environment detailed reference](ENVIRONMENT-DETAILED-REFERENCE.md) | Full configuration defaults, operational procedures and provider assumptions | Preserved detailed snapshot; reverify dated provider details |
| [Email OTP detailed reference](EMAIL-OTP-AUTH-REFERENCE.md) | Full sequences, error outcomes and concurrency behavior | Detailed snapshot |
| [Shared library detailed reference](LIB_FOLDER_REFERENCE.md) | Original file-by-file inventory and older diagrams | Historical snapshot; consult source for current generated files |
| [OpenAPI specification](../lib/api-spec/openapi.yaml) | Machine-readable API contract | Current code-owned source of truth |

## Verification reports and change history

These documents are **dated evidence**, not promises that the same tests passed on every subsequent commit.

| Document | Focus | Evidence type |
| --- | --- | --- |
| [Adjustment workflow tests](ADJUSTMENT-WORKFLOW-TESTS.md) | Inventory adjustment, Undo and retry behavior | Historical test results |
| [GS-102 concurrent adjustments](GS-102-CONCURRENT-ADJUSTMENT-FIX.md) | Notification delivery and connection-pool contention | Incident and regression evidence |
| [GS-104 frontend bundle](GS-104-FRONTEND-BUNDLE.md) | Bundle measurements and route loading | Historical performance checks |
| [GS-106 country-code verification](GS-106-COUNTRY-CODE-VERIFICATION.md) | Opt-in mobile preview country selector | Historical UI checks, not SMS availability |
| [GS-110 auth concurrency](GS-110-AUTH-CONCURRENCY.md) | Auth bursts and database connection-pool behavior | Historical concurrency tests |
| [GS-113 expired alerts](GS-113-EXPIRED-ALERTS.md) | Expiry rules and alert presentation | Historical feature verification |
| [GS-114 email-only auth](GS-114-EMAIL-ONLY-AUTH.md) | Email login launch scope and account audit | Historical release check |
| [GS-138 acceptance results](GS-138-ACCEPTANCE-RESULTS.md) | Pilot browser and automated checks | Partial dated acceptance evidence |
| [GS-68 accessibility smoke](GS-68-RESPONSIVE-ACCESSIBILITY-SMOKE.md) | Responsive layouts and keyboard flows | Historical smoke checks |

## Documentation maintenance rules

1. **Current guides** should reflect the behavior checked into the branch. Confirm important claims against implementation and the OpenAPI contract.
2. **Dated evidence** should retain its original results and dates; add newer results separately rather than silently rewriting the record.
3. **Provider and deployment status** can change outside GitHub. Render service settings, SMTP delivery, DNS, backups and production acceptance require live verification.
4. **Detailed references** preserve implementation decisions and edge cases. Keep the concise guides approachable and link readers to technical depth.
5. For local development, begin with [Environment](ENVIRONMENT.md); for operational procedures or destructive tests, follow the documented safety limits and use isolated data.

For project-wide contributor guidance see [AGENTS.md](../AGENTS.md). For the broader app overview and branch/environment status, return to the [root README](../README.md).
