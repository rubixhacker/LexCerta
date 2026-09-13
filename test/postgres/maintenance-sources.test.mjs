import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { advanceMaintenance } from "../../build/postgres/maintenance-steps.js";
import { MaintenanceLeaseLost, claimMaintenance } from "../../build/postgres/maintenance.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
import { runMaintenance } from "../../build/postgres/run-maintenance.js";
import { PostgresSourceAdministration } from "../../build/postgres/source-administration.js";
import { createPostgresFixture } from "./fixture.mjs";
import { FixtureSourceObjects, deferred } from "./objects-fixture.mjs";

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
const historical = "2020-01-01T00:00:00.000Z";
function provenance(opinionId) {
	return {
		opinionId,
		clusterId: 108713,
		canonicalUrl: "https://www.courtlistener.com/opinion/108713/example/",
	};
}
async function publish(objects, id) {
	const store = new PostgresOpinionSources(fixture.database, objects);
	const ownerToken = randomUUID();
	assert.equal(
		(await store.acquireLease({ opinionId: id, ownerToken, now: new Date(0) })).kind,
		"acquired",
	);
	const result = await store.fillLease({
		ownerToken,
		now: new Date(0),
		observation: {
			kind: "positive",
			provenance: provenance(id),
			representation: "plain_text",
			sourceText: "fixture opinion text",
		},
	});
	assert.equal(result.kind, "stored");
	return result.state;
}
async function lifecycleAt(stage, database = fixture.jobs) {
	const claim = await claimMaintenance(database);
	assert.equal(claim.kind, "acquired");
	let progress = await claim.lease.next();
	await claim.lease.checkpoint(progress, { kind: "complete" });
	for (const next of ["citations", "opinions", "objects", "orphans"]) {
		progress = await claim.lease.next();
		if (progress.stage === stage) return claim.lease;
		await claim.lease.checkpoint(progress, { kind: "stage", stage: next });
	}
	return claim.lease;
}
async function row(table, key, value) {
	// All identifiers are hard-coded test call sites; values remain parameters.
	return (
		await fixture.migration.query(`SELECT * FROM lexcerta.${table} WHERE ${key} = $1`, [value])
	).rows[0];
}

test("paged expiry removes stale negatives and keeps fresh results, positive history and tombstones", async () => {
	const objects = new FixtureSourceObjects();
	const priorOpinion = (await publish(objects, 200)).positive;
	const liveOpinion = await publish(objects, 201);
	await new PostgresSourceAdministration(fixture.administration, "test", fixture.journal).remove(
		202,
		"fixture-operator",
	);
	const citationPositive = {
		kind: "positive",
		cluster: { id: 108713, canonicalUrl: provenance(200).canonicalUrl },
		retrievedAt: historical,
	};
	const citationNegative = {
		kind: "negative",
		negative: { kind: "negative", retrievedAt: historical },
		superseded: null,
	};
	await fixture.migration.query(
		"INSERT INTO lexcerta.citation_sources(citation, state) SELECT 'fixture-' || lpad(n::text, 3, '0'), $1::jsonb FROM generate_series(1, 105) n",
		[JSON.stringify(citationNegative)],
	);
	await fixture.migration.query(
		"INSERT INTO lexcerta.citation_sources(citation, state) VALUES ('history', $1), ('positive', $2), ('fresh', $3)",
		[
			JSON.stringify({ ...citationNegative, superseded: citationPositive }),
			JSON.stringify({ kind: "positive", positive: citationPositive }),
			JSON.stringify({
				...citationNegative,
				negative: { kind: "negative", retrievedAt: new Date().toISOString() },
			}),
		],
	);
	await fixture.migration.query(
		"INSERT INTO lexcerta.opinion_sources(opinion_id, state) SELECT n, jsonb_build_object('kind', 'negative', 'negative', jsonb_build_object('kind', 'negative', 'retrievedAt', $1::text, 'provenance', jsonb_build_object('opinionId', n, 'clusterId', 108713, 'canonicalUrl', $2::text)), 'superseded', null) FROM generate_series(1,105) n",
		[historical, provenance(200).canonicalUrl],
	);
	const opinionNegative = {
		kind: "negative",
		negative: { kind: "negative", retrievedAt: historical, provenance: provenance(200) },
		superseded: priorOpinion,
	};
	await fixture.migration.query(
		"UPDATE lexcerta.opinion_sources SET state = $1, body_key = NULL WHERE opinion_id = 200",
		[JSON.stringify(opinionNegative)],
	);
	const result = await runMaintenance(fixture.jobs, objects);
	assert.equal(result.outcome, "complete");
	assert.ok(result.batches >= 8, "more than one page per negative source kind was processed");
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.citation_sources WHERE citation LIKE 'fixture-%' AND state IS NOT NULL",
			)
		).rowCount,
		0,
	);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.opinion_sources WHERE opinion_id <= 105 AND state IS NOT NULL",
			)
		).rowCount,
		0,
	);
	assert.deepEqual((await row("citation_sources", "citation", "history")).state, {
		kind: "reversal_pending",
		superseded: citationPositive,
		firstNegative: citationNegative.negative,
	});
	assert.deepEqual((await row("citation_sources", "citation", "positive")).state, {
		kind: "positive",
		positive: citationPositive,
	});
	assert.equal((await row("citation_sources", "citation", "fresh")).state.kind, "negative");
	assert.deepEqual(
		(await row("opinion_sources", "opinion_id", 200)).state,
		JSON.parse(
			JSON.stringify({
				kind: "reversal_pending",
				superseded: priorOpinion,
				firstNegative: opinionNegative.negative,
			}),
		),
	);
	assert.deepEqual(
		(await row("opinion_sources", "opinion_id", 201)).state,
		JSON.parse(JSON.stringify(liveOpinion)),
	);
	assert.ok((await row("opinion_sources", "opinion_id", 202)).removed_at instanceof Date);
	assert.equal(
		(await fixture.migration.query("SELECT 1 FROM lexcerta.upstream_attempts")).rowCount,
		0,
	);
});

for (const kind of ["citation", "opinion"]) {
	test(`an expired ${kind} negative with an active publisher blocks the sweep without skipping its row`, async () => {
		const negative = {
			kind: "negative",
			negative: {
				kind: "negative",
				retrievedAt: historical,
				...(kind === "opinion" ? { provenance: provenance(1) } : {}),
			},
			superseded: null,
		};
		const table = kind === "citation" ? "citation_sources" : "opinion_sources";
		const key = kind === "citation" ? "citation" : "opinion_id";
		const id = kind === "citation" ? "fixture" : 1;
		await fixture.migration.query(
			`INSERT INTO lexcerta.${table}(${key}, state, owner_token, lease_expires_at) VALUES ($1, $2, 'publisher', clock_timestamp() + interval '10 seconds')`,
			[id, JSON.stringify(negative)],
		);
		const objects = new FixtureSourceObjects();
		assert.equal((await runMaintenance(fixture.jobs, objects)).outcome, "partial");
		const progress = await row("maintenance_progress", "name", "lifecycle");
		assert.equal(progress.stage, kind === "citation" ? "citations" : "opinions");
		assert.equal(progress[kind === "citation" ? "citation_cursor" : "opinion_cursor"], null);
		assert.deepEqual((await row(table, key, id)).state, negative);
		await fixture.migration.query(
			`UPDATE lexcerta.${table} SET lease_expires_at = clock_timestamp() - interval '1 second'`,
		);
		assert.equal((await runMaintenance(fixture.jobs, objects)).outcome, "complete");
		assert.equal((await row(table, key, id)).state, null);
	});
}

test("malformed negative provenance leaves the lifecycle incomplete without rewriting evidence", async () => {
	const negative = {
		kind: "negative",
		negative: { kind: "negative", retrievedAt: historical, provenance: provenance(999) },
		superseded: null,
	};
	await fixture.migration.query(
		"INSERT INTO lexcerta.opinion_sources(opinion_id, state) VALUES (1, $1)",
		[JSON.stringify(negative)],
	);
	await assert.rejects(
		runMaintenance(fixture.jobs, new FixtureSourceObjects()),
		/maintenance state unavailable/,
	);
	assert.deepEqual((await row("opinion_sources", "opinion_id", 1)).state, negative);
	assert.equal((await row("maintenance_progress", "name", "lifecycle")).completed_at, null);
	assert.equal(
		(await fixture.migration.query("SELECT outcome FROM lexcerta.maintenance_owner")).rows[0]
			.outcome,
		"failed",
	);
});

test("a lost object deletion acknowledgement remains incomplete until the deferred claim can be retried", async () => {
	const objects = new FixtureSourceObjects();
	const history = await publish(objects, 1);
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET expires_at = clock_timestamp() - interval '1 second'",
	);
	const remove = objects.remove.bind(objects);
	objects.remove = async (...args) => {
		await remove(...args);
		throw new Error("lost delete acknowledgement");
	};
	await assert.rejects(runMaintenance(fixture.jobs, objects), /lost delete/);
	assert.equal(objects.values.size, 0);
	objects.remove = remove;
	assert.equal((await runMaintenance(fixture.jobs, objects)).outcome, "partial");
	assert.equal((await row("maintenance_progress", "name", "lifecycle")).stage, "objects");
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET delete_after = clock_timestamp() - interval '1 second'",
	);
	assert.equal((await runMaintenance(fixture.jobs, objects)).outcome, "complete");
	assert.equal(
		(await fixture.migration.query("SELECT * FROM lexcerta.source_objects")).rowCount,
		0,
	);
	assert.deepEqual(
		(await row("opinion_sources", "opinion_id", 1)).state,
		JSON.parse(JSON.stringify(history)),
	);
});

test("losing ownership during object deletion prevents stale SQL finalization", async () => {
	const objects = new FixtureSourceObjects();
	await publish(objects, 1);
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET expires_at = clock_timestamp() - interval '1 second'",
	);
	const lease = await lifecycleAt("objects");
	const started = deferred();
	const release = deferred();
	objects.onRemove = async () => {
		assert.equal(
			fixture.jobPool.idleCount,
			fixture.jobPool.totalCount,
			"no SQL connection held during object I/O",
		);
		started.resolve();
		await release.promise;
	};
	const stale = advanceMaintenance(lease, await lease.next(), objects);
	const rejected = assert.rejects(stale, MaintenanceLeaseLost);
	await started.promise;
	await fixture.migration.query(
		"UPDATE lexcerta.maintenance_owner SET lease_expires_at = clock_timestamp() - interval '1 second'",
	);
	const replacement = await claimMaintenance(fixture.jobs);
	assert.equal(replacement.kind, "acquired");
	release.resolve();
	await rejected;
	assert.equal(
		(await fixture.migration.query("SELECT * FROM lexcerta.source_objects")).rowCount,
		1,
	);
	assert.equal((await replacement.lease.next()).stage, "objects");
	await replacement.lease.release("partial");
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET delete_after = clock_timestamp() - interval '1 second'",
	);
	objects.onRemove = undefined;
	assert.equal((await runMaintenance(fixture.jobs, objects)).outcome, "complete");
});

test("orphan pages resume after the checkpoint and retain registered and recent objects", async () => {
	const objects = new FixtureSourceObjects();
	await publish(objects, 1);
	for (const key of ["opinions/orphan-1", "opinions/orphan-2", "opinions/recent"])
		await objects.put(key, new TextEncoder().encode("fixture"), {});
	for (const [key, value] of objects.values)
		if (key !== "opinions/recent") value.createdAt = new Date(historical);
	const all = (await objects.list()).objects;
	const tokens = [];
	objects.list = async (token) => {
		tokens.push(token ?? null);
		assert.ok(token === undefined || token === "page-two");
		return token === undefined
			? { objects: all.slice(0, 2), nextPageToken: "page-two" }
			: { objects: all.slice(2), nextPageToken: null };
	};
	const lease = await lifecycleAt("orphans");
	assert.equal((await advanceMaintenance(lease, await lease.next(), objects)).completed, null);
	assert.equal((await lease.next()).orphan_page_token, "page-two");
	await lease.release("partial");
	assert.equal((await runMaintenance(fixture.jobs, objects)).outcome, "complete");
	assert.deepEqual(tokens, [null, "page-two"]);
	assert.equal(objects.values.size, 2);
	assert.equal(
		(
			await new PostgresOpinionSources(fixture.database, objects).read({
				provenance: provenance(1),
			})
		).kind,
		"positive",
	);
});

test("orphan deletion recovery drains more than one page of durable marks before completing", async () => {
	await fixture.migration.query(
		"INSERT INTO lexcerta.orphan_object_deletions(object_key, generation) SELECT 'opinions/absent-' || n, '1' FROM generate_series(1, 205) n",
	);
	const result = await runMaintenance(fixture.jobs, new FixtureSourceObjects());
	assert.equal(result.outcome, "complete");
	assert.equal(
		(await fixture.migration.query("SELECT * FROM lexcerta.orphan_object_deletions")).rowCount,
		0,
	);
});

test("slow scans of protected objects make durable progress within a page across bounded retries", async () => {
	const objects = new FixtureSourceObjects();
	for (let id = 1; id <= 6; id += 1) await publish(objects, id);
	for (const value of objects.values.values()) value.createdAt = new Date(historical);
	const delayed = {
		transaction: (operation) =>
			fixture.jobs.transaction((tx) =>
				operation({
					now: () => tx.now(),
					async query(sql, values) {
						if (sql === "SELECT 1 FROM lexcerta.source_objects WHERE object_key = $1")
							await tx.query("SELECT pg_sleep(0.05)");
						return tx.query(sql, values);
					},
				}),
			),
	};
	let lease = await lifecycleAt("orphans", delayed);
	let completed = false;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const result = await advanceMaintenance(lease, await lease.next(), objects, 100);
		await lease.release("partial");
		if (result.completed === "lifecycle") {
			completed = true;
			break;
		}
		const claim = await claimMaintenance(delayed);
		assert.equal(claim.kind, "acquired");
		lease = claim.lease;
	}
	assert.equal(completed, true, "retrying a bounded scan must eventually pass protected objects");
	assert.equal(objects.values.size, 6);
});

test("a within-page cursor distinguishes large generations of the same object name", async () => {
	const remaining = new Set(
		Array.from({ length: 6 }, (_, index) => String(9007199254740993n + BigInt(index))),
	);
	const objects = new FixtureSourceObjects();
	objects.list = async () => ({
		objects: [...remaining].reverse().map((generation) => ({
			key: "opinions/versioned-fixture",
			generation,
			createdAt: new Date(historical),
		})),
		nextPageToken: null,
	});
	objects.remove = async (key, generation) => {
		assert.equal(key, "opinions/versioned-fixture");
		remaining.delete(generation);
	};
	const delayed = {
		transaction: (operation) =>
			fixture.jobs.transaction((tx) =>
				operation({
					now: () => tx.now(),
					async query(sql, values) {
						if (sql === "SELECT 1 FROM lexcerta.source_objects WHERE object_key = $1")
							await tx.query("SELECT pg_sleep(0.05)");
						return tx.query(sql, values);
					},
				}),
			),
	};
	let lease = await lifecycleAt("orphans", delayed);
	let completed = false;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const result = await advanceMaintenance(lease, await lease.next(), objects, 100);
		await lease.release("partial");
		if (result.completed === "lifecycle") {
			completed = true;
			break;
		}
		const claim = await claimMaintenance(delayed);
		assert.equal(claim.kind, "acquired");
		lease = claim.lease;
	}
	assert.equal(completed, true);
	assert.equal(remaining.size, 0);
});
