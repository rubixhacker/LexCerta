# Database migrations

`npm run migrate` runs the SQL packaged with the Node image, followed by the runtime grants in `src/postgres/roles.ts`. It is a separate, bounded command. Public and operator startup do not migrate the database. Production provisioning and execution remain deployment gates; the results below use disposable local PostgreSQL.

## Bootstrap prerequisites

Prepare staging and production in separate Neon projects. Each project needs a dedicated `lexcerta` database owned by its restricted migration role. Create these identities through SQL using the bootstrap owner. Neon Console/API-created owner roles are unsuitable runtime identities because they inherit administrative privileges.

| Purpose | Staging role | Production role | Connection limit |
| --- | --- | --- | ---: |
| Public service | `lexcerta_staging_public` | `lexcerta_production_public` | 30 |
| Operator service | `lexcerta_staging_admin` | `lexcerta_production_admin` | 4 |
| Maintenance | `lexcerta_staging_job` | `lexcerta_production_job` | 2 |
| Migration | `lexcerta_staging_migrator` | `lexcerta_production_migrator` | 1 |

All four roles need `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` and `NOBYPASSRLS`. They must not inherit other roles; the migrator's implicit `pg_database_owner` membership is allowed. Use distinct generated passwords and environment-specific Secret Manager versions. Do not put passwords in migration files, Terraform state, command arguments or logs. The bootstrap owner remains outside the services and CI runtime identities.

Set the four connection limits explicitly. At least 57 ordinary connection slots must be configured: 37 across these role limits plus 20 for recovery and other work, after PostgreSQL's reserved connections are deducted. The migration checks this configured allowance; actual Neon capacity and competing provider sessions still need staging measurement. Process pools remain smaller at 5/2/2/1.

The bootstrap owner must be able to create the database with the migrator as owner, or transfer an empty dedicated database to it. PostgreSQL requires the caller to have `CREATEDB` and be able to `SET ROLE` to the new owner for an ownership transfer; the migrator itself does not need `CREATEDB`. Never transfer an unrelated database or fix this by promoting an application role. [PostgreSQL role creation](https://www.postgresql.org/docs/18/sql-createrole.html), [database ownership](https://www.postgresql.org/docs/18/sql-alterdatabase.html).

## Run the packaged command

Supply `LEXCERTA_ENVIRONMENT`, a 40-character `LEXCERTA_BUILD_ID`, the direct `LEXCERTA_DATABASE_HOST` and the migrator's `LEXCERTA_DATABASE_PASSWORD`. The database name and role names follow the fixed environment convention. TLS certificate and hostname verification remain enabled. This command needs no API-key pepper, CourtListener token, Google operator token or GCS access.

```sh
npm run build:node
npm run migrate
```

The container command is `node build/node/migration-main.js`. It accepts no extra arguments, arbitrary SQL or caller-selected migration directory. A deployment must run the same immutable image intended for the services and wait for a successful migration before admitting traffic. A local all-zero build identifier is fixture evidence only.

The migrator obtains a session advisory lock and checks ordered, checksummed history. Each new migration commits its DDL and history row together. Changed or missing applied files and out-of-order additions fail. The dedicated connection has a 90-second total bound, with five-second lock and 30-second statement timeouts inside DDL transactions. Online SQL retains its separate five-second total bound. Process cancellation closes the connection and releases the session lock; an in-flight server statement may take time to observe that disconnect.

Grant reconciliation runs under the same advisory lock in its own transaction. It removes excess table, column, sequence, function, schema and database grants from the three runtime roles and `PUBLIC`, then installs the explicit permissions. Global and schema-specific defaults are restricted, so a future table or function does not silently become public. The migrator rejects inherited administrative privileges or incorrect connection ceilings instead of changing role membership itself.

Migration `0004_recovery_replay.sql` adds a recovery seal and persistent restriction enforcement. When the database is sealed, grant reconciliation removes runtime permissions and commits without restoring them, including `CONNECT`. An unchanged migration cannot reopen a restored database. The [replay procedure](recovery-journal.md) explains the remaining reopening gates.

The public role cannot change key status, quotas, cache limits or removal markers. The operator can append audit events but cannot rewrite or read the audit table. Migration `0003_source_removal.sql` expands audit targets and defines an operator-only removal function with a fixed search path; it does not grant direct cache updates to the operator. Maintenance can perform its bounded retention work without issuing credentials or clearing tombstones. The public role retains source-object deletion for capacity recovery; only maintenance owns orphan-deletion marks. Tests use these production grant definitions rather than a parallel fixture-only list.

On success, stdout contains only `{"event":"migration_finished","applied":4}` with the actual newly applied count. An unchanged rerun reports zero while still repairing grant drift. Failures exit unsuccessfully with a constant startup or migration failure event. A schema migration may have committed before a later grant failure or lost acknowledgement; keep traffic closed, correct the prerequisite and rerun the same image. Checksums prevent committed DDL from being replayed. Do not remove history rows to force a retry.

## Local evidence and remaining gates

The [migration qualification record](qualification/node-migration-2026-09-12/migration-container-local.json) records 758 passing local checks: 642 repository checks, 106 real PostgreSQL tests and ten container tests. The packaged migrator creates the schema and grants over verified TLS, repeats safely, and rolls back interrupted DDL. Tests also cover grant drift, excess inherited roles, connection ceilings, default privileges, lost commit acknowledgements and cancellation during connection acquisition. The migration container ran at one CPU and 512 MiB as UID 1000; this is a short lifecycle check, not sustained-load qualification.

The subsequent [replay qualification](qualification/node-replay-2026-09-13/local.json) records 807 local checks on the four-migration runtime: 661 repository checks, 135 real PostgreSQL tests and eleven container tests. It repeats the packaged migration lifecycle and adds sealed grant repair and an actual local dump-and-restore drill. Each historical record retains its own image digest.

Bootstrap automation, actual Neon roles and ownership, Secret Manager rotation, deployment IAM, exact-image hosted CI and production approval remain open. Migration success does not reconcile post-restore revocations or source removals; a restored environment must remain closed until that separate recovery process completes.
