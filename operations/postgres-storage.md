# PostgreSQL and GCS storage qualification

Recorded September 12, 2026. This is the replacement storage layer for the approved Cloud Run route. The public Node service, deployment identities and scheduled jobs are integrated separately; the retained Worker still uses its reference adapters.

## Storage boundary

PostgreSQL owns keys, rolling admission windows, upstream attempt reservations, source observations, publication leases and object inventory. GCS holds immutable UTF-8 opinion bodies. A cache miss is recoverable; losing authoritative quota or source-reversal history is not treated as a cache miss. Valkey adds no necessary capability at the three-organization pilot scale and remains deferred until measured read latency justifies another service.

Every authority decision uses database time after obtaining its row lock. SQL transactions have two-second statement, 250ms lock and five-second idle limits. Only serialization failures and deadlocks before COMMIT receive at most two SQL-only retries. A lost COMMIT acknowledgement discards the connection and fails the request without replay. HTTP, GCS I/O and body hashing occur outside SQL transactions and checked-out connections.

The admission lock has a separate table so the public identity can serialize with revocation without permission to change credential hashes or status. Administration creates the key, its admission lock and an audit event in one transaction. Defaults are 10 requests/minute, 100/day, 90-day expiry and a maximum seven-day rotation overlap.

Upstream state must already exist and be explicitly enabled. Missing or malformed state fails closed. Data attempts are durably charged before dispatch; completion never refunds them. Owner caps are 3/minute, 30/hour and 80/rolling day, and observed daily quota retains a reserve of at least 20. The API-usage probe has its own upstream accounting and is excluded from the owner's non-usage-attempt caps. Ten-second leases and the existing circuit/reversal transitions are preserved.

## Publication and retention

An object is registered and charged against capacity before upload. Its key includes the source, content hash, monotonic lease epoch and a random suffix. Uploads use `ifGenerationMatch=0`; bytes, SHA-256, metadata and exact generation are checked before the SQL pointer becomes visible. Reads validate them again and recheck the SQL pointer after object I/O. Missing/corrupt objects produce an unavailable check, never negative evidence.

The pinned GCS SDK converts `FileOptions.generation` through `Number`. A scoped public request interceptor preserves decimal generation strings for metadata, media and deletion requests. The real-SDK HTTP test uses generation `9007199254740993` to detect precision loss. Streamed bodies are bounded to 1 MiB and transfers time out after five seconds; checksums and application hashes protect the transfer and stored content.

Capacity is at most 1,000 opinion IDs and 256 MiB across registered uploading, ready and deleting objects. Bodies expire 30 days after acquisition; reads enforce expiry immediately. Cleanup claims at most 100 objects per batch, stops dispatch at its time budget and deletes by exact generation. A claimed row stays retryable after interruption. Public capacity recovery attempts one eviction and can return unavailable if it cannot finish within its lease. Body removal retains positive/reversal history so subsequent upstream misses cannot create an immediate definitive negative.

Tombstones invalidate leases and prevent future source acquisition. Orphan scans use bounded GCS pages and a 48-hour grace period, including late uploads and objects found after a database restore. SQL deletion marks fence registration during cleanup and survive a lost delete acknowledgement. The job must checkpoint the returned page token and restart from the beginning after a completed scan. A partial page is retried rather than skipped.

SQL retention deletes bounded batches: admission/attempt records after 48 hours; key records one calendar year after expiry/revocation; audit events one calendar year after occurrence. Customer identities disappear after their retained keys and audit events are gone. The 48-hour attempt ledger is also the duplicate-token retention window; dispatch tokens are unique per attempt and never deliberately reused. Source history/tombstones contain IDs, hashes and provenance rather than opinion bodies.

Read-path expiry is qualified locally. Actual scheduled deletion lag, orphan scan completion, IAM, restore behavior and physical GCS deletion remain staging gates. Buckets must disable soft deletion and versioning for this body-retention policy; a lifecycle rule is a backstop, not proof of punctual deletion. Cloud SQL's approved seven-day backup retention creates a documented lag for deleted database metadata. Restored environments must remain closed until retention and source-removal reconciliation have run. No production deletion guarantee is claimed from a local fixture.

## Migrations and qualification

`database/migrations` contains ordered, checksummed SQL. The runner checks an explicit migration identity and a dedicated advisory lock, rejects changed/missing applied files and out-of-order additions, and applies each file atomically. The first migration expands the schema. Future contracts must be separate migrations after the old application is no longer eligible for rollback. The service identity must never own schemas or run migrations.

Reproduce with Node 24.21.0 and a disposable PostgreSQL 18 instance on loopback:

```sh
npm ci
npm run check
export LEXCERTA_TEST_DATABASE_URL=postgresql://postgres:lexcerta-local-fixture@127.0.0.1:55439/lexcerta_fixture
npm run test:postgres
```

The fixture creates and removes only its randomly named databases/roles. It refuses non-loopback hosts. CI uses the pinned official PostgreSQL image `postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280`; the local instance reported PostgreSQL 18.6. Public/admin/job/migration role tests verify relevant privilege boundaries, including the public identity's inability to alter keys.

The 39 storage tests exercise real PostgreSQL with independent Node processes, last-slot contention, rotation/revocation, quota reserves, half-open probe election, duplicate/late completion, source reversal, fencing, corrupted objects, cache limits, orphan reconciliation and retention. SIGKILL cases stop processes before/after reservation commit, after actual loopback HTTP dispatch, after upload, after publication commit and after physical deletion. Lost database/object acknowledgements and a real SQL serialization error verify conservative recovery. The GCS tests run the pinned SDK over loopback HTTP; disk and memory object fixtures support crash/race testing. None establishes real GCS authorization or Cloud Run behavior.

The GCS SDK currently emits `MaxListenersExceededWarning` from its stream pipeline on the intentional overflow/stall cases. Those cases still reject within the bound and the fixture closes its sockets. The warnings remain visible; deployment qualification must check repeated-failure resource use rather than suppressing them.
