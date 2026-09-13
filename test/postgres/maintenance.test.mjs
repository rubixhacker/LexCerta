import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { PgDatabase } from "../../build/postgres/database.js";
import {
	claimMaintenance,
	MaintenanceLeaseLost,
	readMaintenanceHealth,
} from "../../build/postgres/maintenance.js";
import { runMaintenance } from "../../build/postgres/run-maintenance.js";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";
import { FixtureSourceObjects } from "./objects-fixture.mjs";

let fixture;
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});
beforeEach(async () => {
	await fixture.migration.query(
		"TRUNCATE lexcerta.maintenance_owner, lexcerta.maintenance_progress, lexcerta.customers, lexcerta.citation_sources, lexcerta.opinion_sources, lexcerta.orphan_object_deletions CASCADE",
	);
	await fixture.migration.query("INSERT INTO lexcerta.maintenance_owner(singleton) VALUES (true)");
	await fixture.migration.query(
		"INSERT INTO lexcerta.maintenance_progress(name) VALUES ('cleanup'), ('lifecycle')",
	);
});
async function acquired(database = fixture.jobs) {
	const result = await claimMaintenance(database);
	assert.equal(result.kind, "acquired");
	return result.lease;
}
async function expire() {
	await fixture.migration.query(
		"UPDATE lexcerta.maintenance_owner SET lease_expires_at = clock_timestamp() - interval '1 second'",
	);
}
async function progress(name) {
	return (
		await fixture.migration.query("SELECT * FROM lexcerta.maintenance_progress WHERE name = $1", [
			name,
		])
	).rows[0];
}
async function child(t) {
	const worker = fork(new URL("./maintenance-process.mjs", import.meta.url), [], {
		env: { PATH: process.env.PATH, LEXCERTA_PROCESS_DATABASE_URL: fixture.jobConnection },
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const exited = once(worker, "exit");
	t.after(async () => {
		if (worker.exitCode === null && worker.signalCode === null) worker.disconnect();
		await exited;
	});
	await once(worker, "message");
	return {
		worker,
		exited,
		rpc(operation) {
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				const listener = (message) => {
					if (message.id !== id) return;
					worker.off("message", listener);
					message.error ? reject(new Error(message.error)) : resolve(message.result);
				};
				worker.on("message", listener);
				worker.send({ id, operation });
			});
		},
	};
}

test("separate processes share one maintenance owner and a killed owner cannot erase its checkpoint", async (t) => {
	const first = await child(t);
	const second = await child(t);
	const results = await Promise.all([first.rpc("claim"), second.rpc("claim")]);
	assert.deepEqual([...results].sort(), ["acquired", "busy"]);
	const winner = results[0] === "acquired" ? first : second;
	const checkpoint = await winner.rpc("next");
	assert.equal(checkpoint.name, "cleanup");
	winner.worker.kill("SIGKILL");
	assert.deepEqual(await winner.exited, [null, "SIGKILL"]);
	assert.equal((await claimMaintenance(fixture.jobs)).kind, "busy");
	await expire();
	const replacement = await acquired();
	assert.equal((await replacement.next()).scheduled_for.toISOString(), checkpoint.scheduled_for);
	assert.equal(
		(await fixture.migration.query("SELECT epoch FROM lexcerta.maintenance_owner")).rows[0].epoch,
		"2",
	);
	await replacement.release("partial");
});

test("a replacement owner fences all stale writes, renewals, checkpoints and releases", async () => {
	const stale = await acquired();
	const expected = await stale.next();
	await expire();
	const current = await acquired();
	for (const operation of [
		() => stale.renew(),
		() => stale.next(),
		() => stale.checkpoint(expected, { kind: "complete" }),
		() => stale.release("failed"),
		() =>
			stale.database.transaction((tx) =>
				tx.query(
					"UPDATE lexcerta.maintenance_progress SET completed_for = clock_timestamp(), completed_at = clock_timestamp() WHERE name = 'cleanup'",
				),
			),
	])
		await assert.rejects(operation(), MaintenanceLeaseLost);
	assert.equal((await progress("cleanup")).completed_at, null);
	assert.equal((await current.next()).scheduled_for.getTime(), expected.scheduled_for.getTime());
	await current.release("partial");
});

test("ownership expiring during a transaction rolls back its writes", async () => {
	const lease = await acquired();
	await fixture.migration.query(
		"UPDATE lexcerta.maintenance_owner SET lease_expires_at = clock_timestamp() + interval '350 milliseconds'",
	);
	await assert.rejects(
		lease.database.transaction(async (tx) => {
			await tx.query(
				"UPDATE lexcerta.maintenance_progress SET scheduled_for = clock_timestamp() WHERE name = 'cleanup'",
			);
			await tx.query("SELECT pg_sleep(0.45)");
		}),
		MaintenanceLeaseLost,
	);
	assert.equal((await progress("cleanup")).scheduled_for, null);
});

test("completed duplicate runs remain idle and do not refresh the completion heartbeat", async () => {
	const objects = new FixtureSourceObjects();
	const result = await runMaintenance(fixture.jobs, objects);
	assert.equal(result.outcome, "complete");
	assert.equal(result.cleanup, 1);
	assert.equal(result.lifecycle, 1);
	const prior = (
		await fixture.migration.query("SELECT * FROM lexcerta.maintenance_progress ORDER BY name")
	).rows;
	assert.equal((await runMaintenance(fixture.jobs, objects)).outcome, "idle");
	assert.deepEqual(
		(await fixture.migration.query("SELECT * FROM lexcerta.maintenance_progress ORDER BY name"))
			.rows,
		prior,
	);
	const slots = (
		await fixture.migration.query(
			"SELECT date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS cleanup, (date_trunc('day', (clock_timestamp() AT TIME ZONE 'UTC') - interval '3 hours') + interval '3 hours') AT TIME ZONE 'UTC' AS lifecycle",
		)
	).rows[0];
	for (const row of prior) assert.equal(row.completed_for.getTime(), slots[row.name].getTime());
});

test("resuming an old slot completes it before recording the current scheduled slot", async () => {
	const lease = await acquired();
	await lease.next();
	await fixture.migration.query(
		"UPDATE lexcerta.maintenance_progress SET scheduled_for = scheduled_for - interval '3 hours' WHERE name = 'cleanup'",
	);
	const old = await lease.next();
	await lease.checkpoint(old, { kind: "complete" });
	assert.equal((await readMaintenanceHealth(fixture.jobs)).cleanup.overdue, true);
	const current = await lease.next();
	assert.equal(current.name, "cleanup");
	assert.equal(current.scheduled_for.getTime() - old.scheduled_for.getTime(), 3 * 3600000);
	await assert.rejects(lease.release("complete"), MaintenanceLeaseLost);
	await assert.rejects(lease.checkpoint(old, { kind: "complete" }), MaintenanceLeaseLost);
	await lease.release("partial");
});

test("a lost checkpoint acknowledgement resumes from the committed database progress", async () => {
	const lease = await acquired();
	const expected = await lease.next();
	await lease.release("partial");
	let fail = false;
	const database = new PgDatabase(
		poolWithCommitFault(fixture.jobPool, {
			onCommit() {
				if (fail) throw new Error("lost checkpoint acknowledgement");
			},
		}),
	);
	const uncertain = await acquired(database);
	fail = true;
	await assert.rejects(uncertain.checkpoint(expected, { kind: "complete" }), /lost checkpoint/);
	fail = false;
	assert.equal((await uncertain.next()).name, "lifecycle");
	await uncertain.release("partial");
});

test("missing or future progress fails conservatively and cannot report healthy completion", async () => {
	await fixture.migration.query("DELETE FROM lexcerta.maintenance_progress WHERE name = 'cleanup'");
	await assert.rejects(claimMaintenance(fixture.jobs), MaintenanceLeaseLost);
	await assert.rejects(readMaintenanceHealth(fixture.jobs), MaintenanceLeaseLost);
	await fixture.migration.query(
		"INSERT INTO lexcerta.maintenance_progress(name, completed_for, completed_at) VALUES ('cleanup', clock_timestamp() + interval '1 hour', clock_timestamp())",
	);
	await assert.rejects(claimMaintenance(fixture.jobs), MaintenanceLeaseLost);
});

test("a budget-limited run leaves pending work and an overdue heartbeat", async () => {
	await fixture.migration.query(
		"UPDATE lexcerta.maintenance_owner SET created_at = clock_timestamp() - interval '27 hours'",
	);
	const result = await runMaintenance(fixture.jobs, new FixtureSourceObjects(), 1);
	assert.equal(result.outcome, "partial");
	assert.equal(result.batches, 0);
	assert.deepEqual(await readMaintenanceHealth(fixture.jobs), {
		cleanup: { completedAt: null, overdue: true },
		lifecycle: { completedAt: null, overdue: true },
	});
	assert.equal(
		(await runMaintenance(fixture.jobs, new FixtureSourceObjects())).outcome,
		"complete",
	);
	for (const status of Object.values(await readMaintenanceHealth(fixture.jobs)))
		assert.equal(status.overdue, false);
});

test("locked retention rows prevent completion even when a skip-locked batch deletes nothing", async () => {
	await fixture.migration.query("INSERT INTO lexcerta.customers(id) VALUES ('fixture')");
	await fixture.migration.query(
		"INSERT INTO lexcerta.api_keys(public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, minute_limit, day_limit, retention_expires_at) VALUES ('fixture', 'fixture', 'test', $1, 'active', clock_timestamp(), clock_timestamp() + interval '90 days', 60, 1000, clock_timestamp() + interval '1 year')",
		["a".repeat(64)],
	);
	await fixture.migration.query(
		"INSERT INTO lexcerta.key_admissions(public_id, admitted_at) VALUES ('fixture', clock_timestamp() - interval '49 hours')",
	);
	const held = await fixture.jobPool.connect();
	try {
		await held.query("BEGIN");
		await held.query("SELECT * FROM lexcerta.key_admissions FOR UPDATE");
		assert.equal(
			(await runMaintenance(fixture.jobs, new FixtureSourceObjects())).outcome,
			"partial",
		);
		assert.equal((await progress("cleanup")).completed_at, null);
	} finally {
		await held.query("ROLLBACK");
		held.release();
	}
	assert.equal(
		(await runMaintenance(fixture.jobs, new FixtureSourceObjects())).outcome,
		"complete",
	);
	assert.equal(
		(await fixture.migration.query("SELECT * FROM lexcerta.key_admissions")).rowCount,
		0,
	);
});

test("job grants allow maintenance but deny credentials, quotas, cache ceilings and tombstone changes", async () => {
	for (const sql of [
		"UPDATE lexcerta.api_keys SET status = 'revoked', revoked_at = clock_timestamp()",
		"UPDATE lexcerta.api_keys SET hmac_sha256_hex = repeat('b', 64)",
		"UPDATE lexcerta.api_keys SET minute_limit = 600",
		"INSERT INTO lexcerta.api_keys(public_id) VALUES ('new-key')",
		"UPDATE lexcerta.upstream_budgets SET enabled = true",
		"INSERT INTO lexcerta.upstream_attempts(token) VALUES ('new-attempt')",
		"UPDATE lexcerta.cache_capacity SET max_bytes = 1",
		"UPDATE lexcerta.opinion_sources SET removed_at = NULL",
		"UPDATE lexcerta.opinion_sources SET owner_token = 'replacement'",
		"DELETE FROM lexcerta.maintenance_progress",
	])
		await assert.rejects(fixture.jobPool.query(sql), { code: "42501" });
	for (const pool of [fixture.publicPool, fixture.adminPool]) {
		await assert.rejects(pool.query("SELECT * FROM lexcerta.maintenance_owner"), { code: "42501" });
		await assert.rejects(
			pool.query("UPDATE lexcerta.maintenance_progress SET completed_at = clock_timestamp()"),
			{ code: "42501" },
		);
	}
});
