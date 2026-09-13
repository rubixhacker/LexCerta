# Maintenance jobs

Issue 35 now has an executable Node maintenance entry point: `npm run build:node` followed by `npm run start:maintenance`. It uses the restricted job database role and GCS object adapter. It makes no CourtListener calls, issues no keys and exposes no HTTP route. The entry point requires environment, project, build, direct Neon host and job database password; it needs neither the API-key pepper nor the upstream token. Database passwords and Google service identities remain separate.

This is local implementation and qualification. No Cloud Run Job, Scheduler identity, alert policy, Neon project or production grant has been provisioned by this work. The container and SQL tests cannot establish provider authorization, production retention or recovery readiness.

## Ownership and cadence

Migration `0002_maintenance.sql` expands the schema with one owner row and separate cleanup/lifecycle progress rows. Earlier public and operator images ignore these tables. The intended deployment runs one bounded Cloud Run task hourly. Cleanup is due each UTC hour; the lifecycle sweep is due once daily at 03:00 UTC. An unfinished sweep resumes its original slot before recording completion of the current slot. Dates come from PostgreSQL, not process clocks or scheduler payloads.

Claiming ownership increments an epoch and records a random token with a 90-second lease. Duplicate invocations return `busy`. The owner renews between bounded units, without a background heartbeat. Each maintenance SQL transaction locks and verifies that owner before and after its work. A lease that expires during a transaction causes rollback; a successor prevents stale writes, checkpoints and releases. No database connection or transaction is held across object I/O.

An already-dispatched object deletion can finish after the process loses ownership. Its durable deletion mark and exact generation protect publication; the stale process cannot finalize SQL or advance progress. The successor retries the durable mark, including when the object is already absent. This is recoverable execution, not an exactly-once claim about remote HTTP requests.

The runner stops dispatching new units within nine minutes, leaves time for in-flight operations and checkpoints, and records `partial` if it cannot finish. The process supplies an independent nine-minute cancellation deadline and ten-second exit backstop. SIGTERM/SIGINT abort current work; partial, cancelled and failed runs exit unsuccessfully. A lost COMMIT acknowledgement is not replayed. Database state determines recovery on the next run.

## Sweep and progress

Hourly cleanup removes bounded batches of admission and upstream-attempt records past their existing 48-hour cutoff. Daily lifecycle also applies key/audit/customer retention, sweeps negative citation and opinion states, collects expired or abandoned registered bodies, and scans GCS for old unregistered generations.

Negative scans use pages of 100 and durable citation/opinion cursors. An active publisher on an expired negative blocks the scan without advancing past that row. Expiry preserves any superseded positive observation as reversal history. Positive state and removal tombstones remain. Opinion provenance must agree across the negative and superseded observations and with the stored opinion ID. Malformed state fails the sweep without replacing evidence.

Registered object batches claim ten objects. Deleting rows whose retry time has not arrived still count as pending work. The orphan scan persists the provider page token plus the last processed name and generation within that page. Generations remain decimal strings and compare as integers without floating-point conversion. This permits bounded scans to advance through slow pages and multiple generations of one name. Outstanding deletion marks are recovered independently of listing cursors; more than 100 marks cannot cause false completion. Mutations to a provider listing are not a snapshot: new entries behind the cursor are considered on the next full daily pass, and the 48-hour orphan grace remains.

Completion requires finishing the current phases; deleting zero rows alone is insufficient. Locked retention rows, deferred object claims and unfinished orphan pages keep the job incomplete. Checkpoints are compared with the current database progress before advancing. The job role can update maintenance records and the required retention/cache columns, but cannot issue/revoke credentials, change hashes or quotas, remove tombstones, replace publication owners or raise cache ceilings. The [migration command](database-migrations.md) installs these grants from `src/postgres/roles.ts`; local fixtures use the same definitions. Actual Neon identities and permissions remain a staging gate.

## Monitoring and remaining deployment gates

Successful process output contains an event name, outcome, integer counts and completion timestamps. Failures emit constant event names; no raw provider error, source body, credential, object name or listing cursor is logged. `busy` and `idle` exits do not refresh the durable phase completion timestamps. A recent completion of an old slot cannot masquerade as current work.

The private health read marks cleanup overdue at two hours and lifecycle overdue at 26 hours, using completed scheduled slots. Missing or future progress fails conservatively. The [cloud configuration](../infrastructure/README.md) defines OAuth-authenticated Scheduler invocation, a dedicated attached identity, one task with bounded retries and alert policies for failed/overdue work and two hours without a healthy maintenance event. The missing-work query handles a time series that never existed. These are locally checked definitions, not installed or delivery-tested alerts. An absent job emits no event, so monitoring does not depend solely on a failure log from that job.

The current 48-hour SQL deletion cutoff with hourly dispatch permits roughly 49 hours of physical retention even on an otherwise healthy schedule, with additional lag after failures. It preserves the existing 48-hour duplicate-attempt ledger. A strict 48-hour physical deletion target is therefore not satisfied merely by installing this schedule; resolve that target and measure actual deletion lag before launch. Source reads independently enforce expiry. GCS versioning/soft deletion, lifecycle backstops and seven-day backup retention still require real provider configuration and inspection.

Cleanup does not implement restore reconciliation. A restored environment must remain closed until it has applied retention, source removals and revocations newer than the restore point from a durable external record. [Sealed SQL replay and a separate local dump-and-restore drill](recovery-journal.md) now pass, as does the [thirty-minute local full-service soak](node-soak.md). Complete provider restoration and reconciliation, production approval, upstream hosted-use permission and external pilot evidence remain open.

## Local qualification

The [maintenance qualification record](qualification/node-maintenance-2026-09-12/maintenance-container-local.json) preserves its earlier uncommitted image and compared compiled files. Its final checks passed: 639 repository checks, 95 real PostgreSQL tests and eight container tests, with zero dependency advisories. The job container ran as Node 24.21.0/x64/UID 1000 at one CPU and 512 MiB without extra swap. SIGKILL after an HTTP object deletion left a durable mark; a new container recovered it through verified PostgreSQL TLS and the GCS wire adapter, completed the original slot and treated the next invocation as idle. These are local protocol fixtures, not real Neon/GCS authorization or production durability proof.

The subsequent [migration qualification record](qualification/node-migration-2026-09-12/migration-container-local.json) covers the current shared task lifecycle and packaged grants, with 758 local checks. Maintenance recovery and the public/operator container cases passed again on that image; the older record remains historical.

The repository workflow now builds an amd64 fixture image and runs the container suite after PostgreSQL tests. Its YAML parses locally; hosted execution of this uncommitted change has not been observed.
