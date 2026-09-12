import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import {
	PostgresCourtListenerCoordinator,
	initializeUpstreamBudget,
} from "../../build/postgres/coordinator.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdministration, PostgresKeyAdmission } from "../../build/postgres/keys.js";
import { migratePostgres } from "../../build/postgres/migrations.js";
import { createPostgresFixture } from "./fixture.mjs";

let fixture;
let workers;
before(async () => {
	fixture = await createPostgresFixture();
	workers = await Promise.all([startProcess(), startProcess()]);
});
after(async () => {
	for (const worker of workers ?? []) worker.child.disconnect();
	await Promise.all((workers ?? []).map((worker) => once(worker.child, "exit")));
	await fixture?.close();
});

async function startProcess() {
	const child = fork(new URL("./process.mjs", import.meta.url), [], {
		env: { ...process.env, LEXCERTA_PROCESS_DATABASE_URL: fixture.publicConnection },
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	await once(child, "message");
	return {
		child,
		run(operation, input) {
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				const listener = (message) => {
					if (message.id !== id) return;
					child.off("message", listener);
					message.error ? reject(new Error(message.error)) : resolve(message.result);
				};
				child.on("message", listener);
				child.send({ id, operation, input });
			});
		},
	};
}

function material(publicId = randomUUID()) {
	const token = `lc_test_${publicId}_${"A".repeat(43)}`;
	return {
		token,
		input: {
			publicId,
			customerId: `customer-${publicId}`,
			environment: "test",
			hmacSha256Hex: createHmac("sha256", "postgres-test-pepper").update(token).digest("hex"),
			actorSubject: "fixture-operator",
			minuteLimit: 1,
			dayLimit: 1,
		},
	};
}
const admission = () => new PostgresKeyAdmission(fixture.database, "postgres-test-pepper", "test");
const admin = () => new PostgresKeyAdministration(fixture.administration);

async function budget() {
	const credentialId = randomUUID();
	await initializeUpstreamBudget(new PgDatabase(fixture.migration), credentialId);
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET enabled = true WHERE credential_id = $1",
		[credentialId],
	);
	const coordinator = new PostgresCourtListenerCoordinator(fixture.database, credentialId);
	const syncToken = randomUUID();
	assert.equal((await coordinator.beginQuotaSync({ now: new Date(0), syncToken })).kind, "started");
	assert.equal(
		(
			await coordinator.recordQuotaSync({
				now: new Date(0),
				syncToken,
				windows: ["user", "citations", "api_usage"].map((scope) => ({
					scope,
					limit: 100,
					remaining: 100,
					rate: "minute",
					windowSeconds: 60,
					resetAt: null,
				})),
			})
		).kind,
		"recorded",
	);
	return { coordinator, credentialId };
}

test("migrations are checksummed, idempotent and unavailable to the public identity", async () => {
	assert.deepEqual(
		await migratePostgres(fixture.migration, "database/migrations", fixture.migrationRole),
		[],
	);
	await assert.rejects(
		migratePostgres(fixture.publicPool, "database/migrations", fixture.migrationRole),
		/dedicated migration identity/,
	);
	await assert.rejects(
		fixture.publicPool.query("UPDATE lexcerta.api_keys SET status = 'revoked'"),
		{ code: "42501" },
	);
});

test("two independent processes cannot both admit the final key slot", async () => {
	const key = material();
	await admin().issue(key.input);
	const results = await Promise.all(
		workers.map((worker) => worker.run("key", { authorization: `Bearer ${key.token}` })),
	);
	assert.deepEqual(results.map((result) => result.kind).sort(), ["allowed", "exhausted"]);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT count(*)::int AS count FROM lexcerta.key_admissions WHERE public_id = $1",
				[key.input.publicId],
			)
		).rows[0].count,
		1,
	);
});

test("revocation and rotation share the admission lock and retain the seven-day overlap", async () => {
	const key = material();
	await admin().issue({ ...key.input, minuteLimit: 10, dayLimit: 100 });
	const next = material();
	await admin().rotate(key.input.publicId, next.input);
	await assert.rejects(admin().rotate(key.input.publicId, material().input), /already rotated/);
	assert.equal((await admission().admit(`Bearer ${key.token}`)).kind, "allowed");
	assert.equal((await admission().admit(`Bearer ${next.token}`)).kind, "allowed");
	await admin().revoke(key.input.publicId, "fixture-operator");
	assert.equal(
		(await workers[0].run("key", { authorization: `Bearer ${key.token}` })).kind,
		"unauthorized",
	);
	const row = (
		await fixture.migration.query(
			"SELECT expires_at - issued_at AS lifetime FROM lexcerta.api_keys WHERE public_id = $1",
			[next.input.publicId],
		)
	).rows[0];
	assert.equal(row.lifetime.days, 90);
});

test("authentication failures spend no allowance and missing lock state fails closed", async () => {
	const key = material();
	await admin().issue(key.input);
	assert.equal((await admission().admit(`Bearer ${key.token.slice(0, -1)}B`)).kind, "unauthorized");
	assert.equal((await admission().admit(`Bearer ${key.token}`)).kind, "allowed");
	await fixture.migration.query(
		"DELETE FROM lexcerta.api_key_admission_locks WHERE public_id = $1",
		[key.input.publicId],
	);
	await assert.rejects(admission().admit(`Bearer ${key.token}`), /authority unavailable/);
});

test("two processes reserve a single upstream slot and duplicate outcomes cannot refund it", async () => {
	const { coordinator, credentialId } = await budget();
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET max_minute = 1 WHERE credential_id = $1",
		[credentialId],
	);
	const results = await Promise.all(
		workers.map((worker) =>
			worker.run("reserve", { credentialId, endpoint: "citation", reservationToken: randomUUID() }),
		),
	);
	assert.deepEqual(results.map((result) => result.kind).sort(), ["quota_exhausted", "reserved"]);
	const reserved = results.find((result) => result.kind === "reserved");
	const outcome = {
		now: new Date(0),
		endpoint: "citation",
		reservationToken: reserved.token,
		outcome: { kind: "success" },
	};
	assert.equal((await coordinator.recordOutcome(outcome)).kind, "recorded");
	assert.equal((await coordinator.recordOutcome(outcome)).kind, "unknown_reservation");
	assert.equal(
		(
			await coordinator.admit({
				endpoint: outcome.endpoint,
				now: new Date(),
				reservationToken: randomUUID(),
			})
		).kind,
		"quota_exhausted",
	);
	assert.equal(
		(
			await coordinator.admit({
				endpoint: outcome.endpoint,
				now: new Date(),
				reservationToken: outcome.reservationToken,
			})
		).kind,
		"reservation_conflict",
	);
});

test("expired reservations remain spent and use database time instead of caller time", async () => {
	const { coordinator, credentialId } = await budget();
	const token = randomUUID();
	const result = await coordinator.admit({
		endpoint: "citation",
		now: new Date(0),
		reservationToken: token,
	});
	assert.equal(result.kind, "reserved");
	assert.ok(result.state.pendingReservations[0].leaseExpiresAt.getTime() > Date.now());
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET state = jsonb_set(state, '{pendingReservations,0,leaseExpiresAt}', to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE credential_id = $1",
		[credentialId],
	);
	assert.equal(
		(
			await coordinator.recordOutcome({
				endpoint: "citation",
				now: new Date(0),
				reservationToken: token,
				outcome: { kind: "success" },
			})
		).kind,
		"unknown_reservation",
	);
	assert.equal(
		(await coordinator.admit({ endpoint: "citation", now: new Date(0), reservationToken: token }))
			.kind,
		"reservation_conflict",
	);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT count(*)::int AS count FROM lexcerta.upstream_attempts WHERE credential_id = $1 AND kind = 'citation'",
				[credentialId],
			)
		).rows[0].count,
		1,
	);
});

test("missing and corrupt budget state cannot initialize itself on a public request", async () => {
	await assert.rejects(
		new PostgresCourtListenerCoordinator(fixture.database, randomUUID()).admit({
			endpoint: "citation",
			now: new Date(),
			reservationToken: randomUUID(),
		}),
		/unavailable/,
	);
	const { coordinator, credentialId } = await budget();
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET state = '{}' WHERE credential_id = $1",
		[credentialId],
	);
	await assert.rejects(
		coordinator.admit({ endpoint: "citation", now: new Date(), reservationToken: randomUUID() }),
	);
});

test("failed admin audit rolls back credentials, locks and customer identity together", async () => {
	const key = material();
	await assert.rejects(admin().issue({ ...key.input, actorSubject: "" }), { code: "23514" });
	assert.equal((await admission().admit(`Bearer ${key.token}`)).kind, "unauthorized");
	assert.equal(
		(
			await fixture.migration.query("SELECT 1 FROM lexcerta.customers WHERE id = $1", [
				key.input.customerId,
			])
		).rowCount,
		0,
	);
});

test("a limit change takes effect in another process without forgetting prior admissions", async () => {
	const key = material();
	await admin().issue({ ...key.input, minuteLimit: 10, dayLimit: 100 });
	assert.equal((await admission().admit(`Bearer ${key.token}`)).kind, "allowed");
	await admin().changeLimits(key.input.publicId, "fixture-operator", 1, 1);
	assert.equal(
		(await workers[0].run("key", { authorization: `Bearer ${key.token}` })).kind,
		"exhausted",
	);
});

test("two processes elect one half-open probe and a late completion cannot close the circuit", async () => {
	const { coordinator, credentialId } = await budget();
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET state = jsonb_set(state, '{circuits,citation}', $2::jsonb) WHERE credential_id = $1",
		[
			credentialId,
			JSON.stringify({ kind: "open", openForMilliseconds: 30000, retryAt: "2000-01-01T00:00:00Z" }),
		],
	);
	const results = await Promise.all(
		workers.map((worker) =>
			worker.run("reserve", { credentialId, endpoint: "citation", reservationToken: randomUUID() }),
		),
	);
	assert.deepEqual(results.map((result) => result.kind).sort(), ["probe_in_flight", "reserved"]);
	const token = results.find((result) => result.kind === "reserved").token;
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET state = jsonb_set(state, '{pendingReservations,0,leaseExpiresAt}', to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE credential_id = $1",
		[credentialId],
	);
	const late = await coordinator.recordOutcome({
		endpoint: "citation",
		reservationToken: token,
		outcome: { kind: "success" },
		now: new Date(0),
	});
	assert.equal(late.kind, "unknown_reservation");
	assert.equal(late.state.circuits.citation.kind, "open");
	assert.equal(
		(
			await workers[1].run("reserve", {
				credentialId,
				endpoint: "citation",
				reservationToken: randomUUID(),
			})
		).kind,
		"circuit_open",
	);
});

test("observed daily quota preserves the owner's twenty-attempt reserve", async () => {
	const credentialId = randomUUID();
	await initializeUpstreamBudget(new PgDatabase(fixture.migration), credentialId);
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET enabled = true WHERE credential_id = $1",
		[credentialId],
	);
	const coordinator = new PostgresCourtListenerCoordinator(fixture.database, credentialId);
	const syncToken = randomUUID();
	await coordinator.beginQuotaSync({ syncToken, now: new Date() });
	await coordinator.recordQuotaSync({
		syncToken,
		now: new Date(),
		windows: ["user", "citations", "api_usage"].map((scope) => ({
			scope,
			limit: 100,
			remaining: 21,
			rate: "day",
			windowSeconds: 86400,
			resetAt: null,
		})),
	});
	const results = await Promise.all(
		workers.map((worker) =>
			worker.run("reserve", { credentialId, endpoint: "citation", reservationToken: randomUUID() }),
		),
	);
	assert.deepEqual(results.map((result) => result.kind).sort(), ["quota_exhausted", "reserved"]);
});

test("lost COMMIT acknowledgements consume exactly one slot and never replay the transaction", async () => {
	const { poolWithCommitFault } = await import("./failure-fixture.mjs");
	const key = material();
	await admin().issue(key.input);
	let commits = 0;
	const ambiguous = new PgDatabase(
		poolWithCommitFault(fixture.publicPool, {
			onCommit() {
				commits += 1;
				throw new Error("lost commit acknowledgement");
			},
		}),
	);
	await assert.rejects(
		new PostgresKeyAdmission(ambiguous, "postgres-test-pepper", "test").admit(
			`Bearer ${key.token}`,
		),
		/lost commit/,
	);
	assert.equal(commits, 1);
	assert.equal(
		(await workers[0].run("key", { authorization: `Bearer ${key.token}` })).kind,
		"exhausted",
	);
	const { credentialId } = await budget();
	const token = randomUUID();
	await assert.rejects(
		new PostgresCourtListenerCoordinator(ambiguous, credentialId).admit({
			endpoint: "citation",
			reservationToken: token,
			now: new Date(),
		}),
		/lost commit/,
	);
	assert.equal(commits, 2);
	assert.equal(
		(
			await workers[1].run("reserve", {
				credentialId,
				endpoint: "citation",
				reservationToken: token,
			})
		).kind,
		"reservation_conflict",
	);
});

test("migration checksum changes and concurrent migration owners fail before applying SQL", async () => {
	const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = await mkdtemp(join(tmpdir(), "lexcerta-migration-fixture-"));
	try {
		await writeFile(
			join(directory, "0001_authority.sql"),
			`${await readFile("database/migrations/0001_authority.sql", "utf8")}\n-- changed after application\n`,
		);
		await assert.rejects(
			migratePostgres(fixture.migration, directory, fixture.migrationRole),
			/checksum changed/,
		);
		const lock = await fixture.publicPool.connect();
		try {
			await lock.query("SELECT pg_advisory_lock(746237100)");
			await assert.rejects(
				migratePostgres(fixture.migration, "database/migrations", fixture.migrationRole),
				/another migration/,
			);
		} finally {
			await lock.query("SELECT pg_advisory_unlock(746237100)");
			lock.release();
		}
	} finally {
		await rm(directory, { recursive: true });
	}
});
