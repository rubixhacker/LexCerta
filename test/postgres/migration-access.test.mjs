import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { migratePostgres } from "../../build/postgres/migrations.js";
import {
	MigrationUnavailable,
	withMigrationConnection,
} from "../../build/postgres/migration-connection.js";
import { applyDatabaseGrants } from "../../build/postgres/roles.js";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";

let fixture;
beforeEach(async () => {
	fixture = await createPostgresFixture();
});
afterEach(async () => {
	await fixture?.close();
});
function configure(pool = fixture.migration, options = {}) {
	return migratePostgres(pool, "database/migrations", fixture.migrationRole, {
		roles: fixture.roleNames,
		...options,
	});
}
async function until(predicate) {
	const deadline = performance.now() + 4000;
	while (!(await predicate())) {
		assert.ok(performance.now() < deadline);
		await delay(20);
	}
}

test("deployable grants deny public budget/capacity administration and operator audit rewrites", async () => {
	for (const sql of [
		"UPDATE lexcerta.upstream_budgets SET enabled = true",
		"UPDATE lexcerta.upstream_budgets SET max_day = 80",
		"INSERT INTO lexcerta.upstream_budgets(credential_id) VALUES ('unauthorized')",
		"DELETE FROM lexcerta.upstream_attempts",
		"UPDATE lexcerta.upstream_attempts SET reserved_at = clock_timestamp()",
		"UPDATE lexcerta.cache_capacity SET max_bytes = 1",
		"INSERT INTO lexcerta.orphan_object_deletions(object_key, generation) VALUES ('opinions/unauthorized', '1')",
		"CREATE TABLE lexcerta.unauthorized(value text)",
		"CREATE TABLE public.unauthorized(value text)",
		"CREATE TEMP TABLE unauthorized(value text)",
	])
		await assert.rejects(fixture.publicPool.query(sql), { code: "42501" });
	for (const sql of [
		"UPDATE lexcerta.admin_audit_events SET actor_subject = 'rewrite'",
		"DELETE FROM lexcerta.admin_audit_events",
		"SELECT * FROM lexcerta.citation_sources",
	])
		await assert.rejects(fixture.adminPool.query(sql), { code: "42501" });
	assert.deepEqual(await configure(), []);
});

test("reapplying grants removes direct, column and PUBLIC privilege drift", async () => {
	await fixture.migration.query(
		`GRANT UPDATE (hmac_sha256_hex) ON lexcerta.api_keys TO ${fixture.publicRole}`,
	);
	await fixture.migration.query(
		`GRANT UPDATE ON lexcerta.admin_audit_events TO ${fixture.adminRole}`,
	);
	await fixture.migration.query("GRANT SELECT ON lexcerta.admin_audit_events TO PUBLIC");
	await fixture.publicPool.query("UPDATE lexcerta.api_keys SET hmac_sha256_hex = repeat('b',64)");
	await fixture.publicPool.query("SELECT * FROM lexcerta.admin_audit_events");
	await configure();
	await assert.rejects(
		fixture.publicPool.query("UPDATE lexcerta.api_keys SET hmac_sha256_hex = repeat('b',64)"),
		{ code: "42501" },
	);
	await assert.rejects(fixture.publicPool.query("SELECT * FROM lexcerta.admin_audit_events"), {
		code: "42501",
	});
	await assert.rejects(
		fixture.adminPool.query("UPDATE lexcerta.admin_audit_events SET actor_subject = 'rewrite'"),
		{ code: "42501" },
	);
});

test("new schema objects remain unavailable until explicitly granted", async () => {
	await fixture.migration.query(
		`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${fixture.publicRole}`,
	);
	await fixture.migration.query(
		`ALTER DEFAULT PRIVILEGES IN SCHEMA lexcerta GRANT EXECUTE ON FUNCTIONS TO ${fixture.publicRole}`,
	);
	await configure();
	await fixture.migration.query("CREATE TABLE lexcerta.future_private(value text)");
	await fixture.migration.query(
		"CREATE FUNCTION lexcerta.future_private_function() RETURNS int LANGUAGE SQL AS 'SELECT 42'",
	);
	for (const pool of [fixture.publicPool, fixture.adminPool, fixture.jobPool]) {
		await assert.rejects(pool.query("SELECT * FROM lexcerta.future_private"), { code: "42501" });
		await assert.rejects(pool.query("SELECT lexcerta.future_private_function()"), {
			code: "42501",
		});
	}
});

test("migration refuses a role connection ceiling that violates the deployment budget", async () => {
	await fixture.setRoleConnectionLimit(fixture.publicRole, 31);
	await assert.rejects(configure(), /connection limits are not configured/);
	await fixture.setRoleConnectionLimit(fixture.publicRole, 30);
	assert.deepEqual(await configure(), []);
	const rows = (
		await fixture.migration.query(
			"SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname = ANY($1::text[])",
			[Object.values(fixture.roleNames)],
		)
	).rows;
	for (const [purpose, limit] of Object.entries({ public: 30, admin: 4, job: 2, migrator: 1 }))
		assert.equal(
			rows.find((row) => row.rolname === fixture.roleNames[purpose]).rolconnlimit,
			limit,
		);
});

test("unexpected role inheritance prevents grant reconciliation without changing privileges", async () => {
	await fixture.setRoleMembership(fixture.publicRole, fixture.adminRole, true);
	await assert.rejects(configure(), /isolated restricted identities/);
	await fixture.setRoleMembership(fixture.publicRole, fixture.adminRole, false);
	assert.deepEqual(await configure(), []);
});

test("missing, reused and unsafe role names are rejected before any grant is changed", async () => {
	for (const roles of [
		{ ...fixture.roleNames, public: fixture.adminRole },
		{ ...fixture.roleNames, public: 'unsafe"; DROP SCHEMA lexcerta' },
		{ ...fixture.roleNames, public: "lexcerta_missing_fixture_role" },
	])
		await assert.rejects(configure(fixture.migration, { roles }));
	await assert.rejects(fixture.publicPool.query("SELECT * FROM lexcerta.maintenance_owner"), {
		code: "42501",
	});
	const client = await fixture.publicPool.connect();
	try {
		await assert.rejects(applyDatabaseGrants(client, fixture.roleNames), /migration identity/);
	} finally {
		client.release();
	}
});

test("a failed grant transaction retains the previously working permissions", async () => {
	const failing = poolWithCommitFault(fixture.migration, {
		afterCommit: false,
		onCommit() {
			throw new Error("grant commit unavailable");
		},
	});
	await assert.rejects(configure(failing), /grant commit unavailable/);
	await fixture.publicPool.query("SELECT * FROM lexcerta.api_keys");
	await assert.rejects(
		fixture.publicPool.query("UPDATE lexcerta.api_keys SET hmac_sha256_hex = repeat('b',64)"),
		{ code: "42501" },
	);
	assert.deepEqual(await configure(), []);
});

test("lost grant acknowledgement closes its connection and permits an idempotent retry", async () => {
	const failing = poolWithCommitFault(fixture.migration, {
		onCommit() {
			throw new Error("lost grant acknowledgement");
		},
	});
	await assert.rejects(configure(failing), /lost grant acknowledgement/);
	assert.equal(fixture.migration.totalCount, 0);
	assert.deepEqual(await configure(), []);
});

test("cancelled migration acquisition cannot start late SQL or retain the session lock", async () => {
	const held = await fixture.migration.connect();
	const controller = new AbortController();
	let ran = false;
	const pending = withMigrationConnection(
		fixture.migration,
		fixture.migrationRole,
		async () => {
			ran = true;
		},
		controller.signal,
	);
	const rejected = assert.rejects(pending, MigrationUnavailable);
	await until(() => fixture.migration.waitingCount === 1);
	controller.abort();
	await rejected;
	held.release();
	await until(() => fixture.migration.waitingCount === 0 && fixture.migration.totalCount === 0);
	assert.equal(ran, false);
	assert.deepEqual(await configure(), []);
});

test("cancelling active DDL rolls back schema and releases the migration advisory lock", async () => {
	const controller = new AbortController();
	const started = Promise.withResolvers();
	const pending = withMigrationConnection(
		fixture.migration,
		fixture.migrationRole,
		async (client) => {
			await client.query("BEGIN");
			await client.query("CREATE TABLE lexcerta.cancelled_migration(value int)");
			const query = client.query("SELECT pg_sleep(1)");
			started.resolve();
			await query;
			assert.fail("cancelled DDL continued");
		},
		controller.signal,
	);
	const rejected = assert.rejects(pending, MigrationUnavailable);
	await started.promise;
	controller.abort();
	await rejected;
	await until(
		async () =>
			!(await fixture.inspectActivity()).some((row) => row.usename === fixture.migrationRole),
	);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT to_regclass('lexcerta.cancelled_migration') AS relation",
			)
		).rows[0].relation,
		null,
	);
	assert.deepEqual(await configure(), []);
});

test("cancellation after a committed migration preserves its checksum and never replays DDL", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lexcerta-schema-fixture-"));
	const controller = new AbortController();
	try {
		await cp("database/migrations", directory, { recursive: true });
		await writeFile(
			// Keep fixture-only DDL after the production migration sequence.
			join(directory, "9000_fixture.sql"),
			"CREATE TABLE lexcerta.committed_migration(value int); INSERT INTO lexcerta.committed_migration VALUES (1);",
		);
		const ambiguous = poolWithCommitFault(fixture.migration, {
			onCommit() {
				controller.abort();
			},
		});
		await assert.rejects(
			migratePostgres(ambiguous, directory, fixture.migrationRole, { signal: controller.signal }),
			MigrationUnavailable,
		);
		assert.deepEqual(
			await migratePostgres(fixture.migration, directory, fixture.migrationRole),
			[],
		);
		assert.equal(
			(await fixture.migration.query("SELECT * FROM lexcerta.committed_migration")).rowCount,
			1,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
