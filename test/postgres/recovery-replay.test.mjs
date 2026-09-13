import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GcsRecoveryJournal } from "../../build/node/gcs-recovery-journal.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdministration, PostgresKeyAdmission } from "../../build/postgres/keys.js";
import { migratePostgres } from "../../build/postgres/migrations.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
import {
	RecoveryReplayUnavailable,
	replayRecoveryJournal,
} from "../../build/postgres/recovery-replay.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";
import { FixtureSourceObjects } from "./objects-fixture.mjs";

let fixture;
const pepper = "synthetic-replay-pepper";
const withJournal = (operation) => withObjects(operation, { paginate: true });
beforeEach(async () => {
	fixture = await createPostgresFixture();
});
afterEach(async () => {
	await fixture?.close();
});

async function issued(publicId = randomUUID()) {
	const token = `lc_test_${publicId}_${"A".repeat(43)}`;
	await new PostgresKeyAdministration(fixture.administration, "test", fixture.journal).issue({
		publicId,
		customerId: "synthetic-pilot",
		environment: "test",
		hmacSha256Hex: createHmac("sha256", pepper).update(token).digest("hex"),
		actorSubject: "synthetic-operator",
	});
	return { publicId, token };
}

async function isolate() {
	const name = new URL(fixture.migrationConnection).pathname.slice(1);
	await fixture.migration.query(
		`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC, ${fixture.publicRole}, ${fixture.adminRole}, ${fixture.jobRole}`,
	);
	const deadline = performance.now() + 4000;
	while ((await fixture.inspectActivity()).some((row) => row.usename !== fixture.migrationRole)) {
		assert.ok(performance.now() < deadline, "fixture runtime pools did not drain");
		await delay(25);
	}
}

function replay(reader, overrides = {}) {
	return replayRecoveryJournal({
		database: new PgDatabase(fixture.migration),
		roles: fixture.roleNames,
		environment: "staging",
		actorSubject: "verified-recovery-operator",
		reader,
		...overrides,
	});
}

async function state(publicId) {
	return (
		await fixture.migration.query("SELECT * FROM lexcerta.api_keys WHERE public_id = $1", [
			publicId,
		])
	).rows[0];
}

test("replay restores revocation and expiry ceilings, preserves stricter state and remains sealed after migration", async () =>
	withJournal(async ({ connection }) => {
		const revoke = await issued();
		const expire = await issued();
		const alreadyShort = await issued();
		const short = new Date(Date.now() + 60_000);
		await fixture.migration.query(
			"UPDATE lexcerta.api_keys SET expires_at = $2 WHERE public_id = $1",
			[alreadyShort.publicId, short],
		);
		const journal = new GcsRecoveryJournal("fixture", "staging", connection);
		await journal.append({ kind: "revoke_key", publicId: revoke.publicId });
		const ceiling = new Date(Date.now() + 2 * 86_400_000).toISOString();
		for (const key of [expire, alreadyShort])
			await journal.append({ kind: "expire_key", publicId: key.publicId, notAfter: ceiling });
		await isolate();
		const first = await replay(journal);
		assert.equal(first.outcome, "restrictions_replayed");
		assert.equal(first.records, 3);
		assert.equal(first.databaseSealed, true);
		assert.equal((await state(revoke.publicId)).status, "revoked");
		assert.equal((await state(expire.publicId)).expires_at.toISOString(), ceiling);
		assert.equal((await state(expire.publicId)).rotation_overlap_until, null);
		assert.equal(
			(await state(alreadyShort.publicId)).expires_at.toISOString(),
			short.toISOString(),
		);
		assert.deepEqual(await replay(journal), first);
		const audit = await fixture.migration.query(
			"SELECT actor_subject, retention_expires_at = occurred_at + interval '1 year' AS retained_year FROM lexcerta.admin_audit_events WHERE action = 'key_recovery_restricted'",
		);
		assert.equal(audit.rowCount, 2);
		assert.ok(
			audit.rows.every(
				(row) => row.actor_subject === "verified-recovery-operator" && row.retained_year,
			),
		);
		await migratePostgres(fixture.migration, "database/migrations", fixture.migrationRole, {
			roles: fixture.roleNames,
		});
		for (const pool of [fixture.publicPool, fixture.adminPool, fixture.jobPool])
			await assert.rejects(pool.query("SELECT 1"), { code: "42501" });
		const control = (await fixture.migration.query("SELECT * FROM lexcerta.recovery_control"))
			.rows[0];
		assert.ok(control.sealed_at);
		assert.equal(control.environment, "staging");
		// Fixture-only simulated approved reopening to exercise real admission.
		// The production replay path has no unseal or grant-restoration command.
		await fixture.migration.query(
			"UPDATE lexcerta.recovery_control SET sealed_at = NULL, environment = NULL",
		);
		await migratePostgres(fixture.migration, "database/migrations", fixture.migrationRole, {
			roles: fixture.roleNames,
		});
		const admission = new PostgresKeyAdmission(fixture.database, pepper, "test");
		assert.equal((await admission.admit(`Bearer ${revoke.token}`)).kind, "unauthorized");
		assert.equal((await admission.admit(`Bearer ${expire.token}`)).kind, "allowed");
	}));

test("absent key restrictions survive without credentials and prevent later reuse of either revoked or expiry-limited IDs", async () =>
	withJournal(async ({ connection }) => {
		await issued();
		const journal = new GcsRecoveryJournal("fixture", "staging", connection);
		for (const restriction of [
			{ kind: "revoke_key", publicId: "missing-revoked" },
			{ kind: "expire_key", publicId: "missing-expired", notAfter: "2026-09-19T03:00:00.000Z" },
		])
			await journal.append(restriction);
		await isolate();
		await replay(journal);
		for (const id of ["missing-revoked", "missing-expired"]) {
			assert.equal(await state(id), undefined);
			await assert.rejects(
				fixture.migration.query(
					"INSERT INTO lexcerta.api_keys(public_id,customer_id,environment,hmac_sha256_hex,status,issued_at,expires_at,minute_limit,day_limit,retention_expires_at) VALUES ($1,'synthetic-pilot','test',repeat('b',64),'active',clock_timestamp(),clock_timestamp()+interval '90 days',10,100,clock_timestamp()+interval '455 days')",
					[id],
				),
				{ code: "23514" },
			);
		}
		assert.equal(
			(await fixture.migration.query("SELECT * FROM lexcerta.recovered_key_restrictions")).rowCount,
			2,
		);
	}));

test("recovered keys cannot be revived, extended or renamed; expiry before issue revokes without violating SQL bounds", async () =>
	withJournal(async ({ connection }) => {
		const revoked = await issued();
		const expiry = await issued();
		const impossibleExpiry = await issued();
		const journal = new GcsRecoveryJournal("fixture", "staging", connection);
		await journal.append({ kind: "revoke_key", publicId: revoked.publicId });
		await journal.append({
			kind: "expire_key",
			publicId: expiry.publicId,
			notAfter: new Date(Date.now() + 86_400_000).toISOString(),
		});
		await journal.append({
			kind: "expire_key",
			publicId: impossibleExpiry.publicId,
			notAfter: "2020-01-01T00:00:00.000Z",
		});
		await isolate();
		await replay(journal);
		assert.equal((await state(impossibleExpiry.publicId)).status, "revoked");
		for (const [sql, id] of [
			[
				"UPDATE lexcerta.api_keys SET status='active',revoked_at=NULL WHERE public_id=$1",
				revoked.publicId,
			],
			[
				"UPDATE lexcerta.api_keys SET expires_at=expires_at+interval '2 days' WHERE public_id=$1",
				expiry.publicId,
			],
			["UPDATE lexcerta.api_keys SET public_id='renamed' WHERE public_id=$1", revoked.publicId],
			["UPDATE lexcerta.api_keys SET environment='production' WHERE public_id=$1", expiry.publicId],
		])
			await assert.rejects(fixture.migration.query(sql, [id]), { code: "23514" });
	}));

test("source replay retains prior evidence, creates absent tombstones and preserves deletion fences on retry", async () =>
	withJournal(async ({ connection }) => {
		const objects = new FixtureSourceObjects();
		const source = new PostgresOpinionSources(fixture.database, objects);
		const ownerToken = randomUUID();
		await source.acquireLease({ opinionId: 401, ownerToken, now: new Date() });
		await source.fillLease({
			ownerToken,
			now: new Date(),
			observation: {
				kind: "positive",
				provenance: {
					opinionId: 401,
					clusterId: 108713,
					canonicalUrl: "https://www.courtlistener.com/opinion/108713/fixture/",
				},
				representation: "plain_text",
				sourceText: "synthetic source replay sentinel",
			},
		});
		const before = (
			await fixture.migration.query("SELECT * FROM lexcerta.opinion_sources WHERE opinion_id=401")
		).rows[0];
		const journal = new GcsRecoveryJournal("fixture", "staging", connection);
		for (const opinionId of [401, 402]) await journal.append({ kind: "remove_opinion", opinionId });
		await isolate();
		await replay(journal);
		const rows = (
			await fixture.migration.query("SELECT * FROM lexcerta.opinion_sources ORDER BY opinion_id")
		).rows;
		assert.equal(rows.length, 2);
		assert.ok(
			rows.every((row) => row.removed_at && row.body_key === null && row.owner_token === null),
		);
		assert.deepEqual(rows[0].state, before.state);
		const token = randomUUID();
		await fixture.migration.query(
			"UPDATE lexcerta.source_objects SET delete_token=$1, delete_after=clock_timestamp()+interval '1 minute'",
			[token],
		);
		await replay(journal);
		assert.equal(
			(await fixture.migration.query("SELECT delete_token FROM lexcerta.source_objects")).rows[0]
				.delete_token,
			token,
		);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT * FROM lexcerta.admin_audit_events WHERE action='source_removed'",
				)
			).rowCount,
			2,
		);
		assert.equal(
			objects.values.size,
			1,
			"replay must leave physical collection to the fenced collector",
		);
	}));

test("connected or CONNECT-enabled targets fail before any external reads or persistent seal", async () => {
	let reads = 0;
	const reader = {
		async list() {
			reads++;
			return { objects: [], nextPageToken: null };
		},
	};
	await assert.rejects(replay(reader), RecoveryReplayUnavailable);
	const client = await fixture.publicPool.connect();
	try {
		const name = new URL(fixture.migrationConnection).pathname.slice(1);
		await fixture.migration.query(
			`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC, ${fixture.publicRole}, ${fixture.adminRole}, ${fixture.jobRole}`,
		);
		await assert.rejects(replay(reader), RecoveryReplayUnavailable);
	} finally {
		client.release();
	}
	assert.equal(reads, 0);
	assert.equal(
		(await fixture.migration.query("SELECT sealed_at FROM lexcerta.recovery_control")).rows[0]
			.sealed_at,
		null,
	);
});

test("foreign key environments fail closed and runtime identities cannot administer recovery state", async () => {
	await issued();
	for (const pool of [fixture.publicPool, fixture.adminPool, fixture.jobPool])
		for (const table of [
			"recovery_control",
			"recovery_runs",
			"recovery_receipts",
			"recovered_key_restrictions",
		])
			await assert.rejects(pool.query(`SELECT * FROM lexcerta.${table}`), { code: "42501" });
	await isolate();
	let reads = 0;
	const reader = {
		async list() {
			reads++;
			return { objects: [], nextPageToken: null };
		},
	};
	await assert.rejects(replay(reader, { environment: "production" }), RecoveryReplayUnavailable);
	assert.equal(reads, 0);
});

test("failed or cancelled object scanning leaves the database sealed without partial restrictions", async () => {
	await isolate();
	const controller = new AbortController();
	const reader = {
		async list(_token, signal) {
			const activity = await fixture.inspectActivity();
			assert.equal(
				activity.some((row) => row.state.includes("transaction")),
				false,
			);
			controller.abort();
			assert.equal(signal.aborted, true);
			return new Promise(() => {});
		},
	};
	await assert.rejects(replay(reader, { signal: controller.signal }), {
		message: "recovery replay unavailable; keep restored service closed",
	});
	assert.ok(
		(await fixture.migration.query("SELECT sealed_at FROM lexcerta.recovery_control")).rows[0]
			.sealed_at,
	);
	assert.equal(
		(await fixture.migration.query("SELECT * FROM lexcerta.recovery_receipts")).rowCount,
		0,
	);
	await assert.rejects(fixture.publicPool.query("SELECT 1"), { code: "42501" });
});

test("lost batch commit acknowledgement keeps its receipts and resumes idempotently", async () =>
	withJournal(async ({ connection }) => {
		const journal = new GcsRecoveryJournal("fixture", "staging", connection);
		for (let index = 0; index < 23; index++)
			await journal.append({ kind: "remove_opinion", opinionId: 500 + index });
		await isolate();
		let commits = 0;
		const failing = new PgDatabase(
			poolWithCommitFault(fixture.migration, {
				async onCommit() {
					commits++;
					if (commits === 5) throw new Error("synthetic lost batch acknowledgement");
				},
			}),
		);
		await assert.rejects(replay(journal, { database: failing }), RecoveryReplayUnavailable);
		const receipts = (await fixture.migration.query("SELECT * FROM lexcerta.recovery_receipts"))
			.rowCount;
		assert.equal(receipts, 10);
		const result = await replay(journal);
		assert.equal(result.records, 23);
		assert.equal(
			(await fixture.migration.query("SELECT * FROM lexcerta.recovery_receipts")).rowCount,
			23,
		);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT * FROM lexcerta.admin_audit_events WHERE action='source_removed'",
				)
			).rowCount,
			23,
		);
	}));

test("changed generation receipts cannot be silently overwritten by a later scan", async () =>
	withJournal(async ({ connection, values }) => {
		const journal = new GcsRecoveryJournal("fixture", "staging", connection);
		const object = await journal.append({ kind: "remove_opinion", opinionId: 600 });
		await isolate();
		await replay(journal);
		values.get(object.key).metadata.generation = "9999999999999999999";
		await assert.rejects(replay(journal), RecoveryReplayUnavailable);
		assert.equal(
			(await fixture.migration.query("SELECT generation FROM lexcerta.recovery_receipts")).rows[0]
				.generation,
			object.generation,
		);
	}));
