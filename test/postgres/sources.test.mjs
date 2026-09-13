import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createPostgresCitationStore } from "../../build/postgres/citations.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
import { PostgresSourceAdministration } from "../../build/postgres/source-administration.js";
import { createPostgresFixture } from "./fixture.mjs";
import { FixtureSourceObjects, deferred } from "./objects-fixture.mjs";
let fixture;
let child;
before(async () => {
	fixture = await createPostgresFixture();
	child = fork(new URL("./process.mjs", import.meta.url), [], {
		env: { ...process.env, LEXCERTA_PROCESS_DATABASE_URL: fixture.publicConnection },
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	await once(child, "message");
});
after(async () => {
	if (child) {
		child.disconnect();
		await once(child, "exit");
	}
	await fixture?.close();
});

function provenance(opinionId) {
	return {
		opinionId,
		clusterId: 108713,
		canonicalUrl: "https://www.courtlistener.com/opinion/108713/example/",
	};
}
async function fill(
	store,
	opinionId,
	sourceText = "fixture opinion text",
	ownerToken = randomUUID(),
) {
	const lease = await store.acquireLease({ opinionId, ownerToken, now: new Date(0) });
	assert.equal(lease.kind, "acquired");
	return store.fillLease({
		ownerToken,
		now: new Date(0),
		observation: {
			kind: "positive",
			provenance: provenance(opinionId),
			representation: "plain_text",
			sourceText,
		},
	});
}
async function expireLease(opinionId) {
	await fixture.migration.query(
		"UPDATE lexcerta.opinion_sources SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE opinion_id = $1",
		[opinionId],
	);
}
function childLease(opinionId, ownerToken) {
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const listener = (message) => {
			if (message.id !== id) return;
			child.off("message", listener);
			message.error ? reject(new Error(message.error)) : resolve(message.result);
		};
		child.on("message", listener);
		child.send({ id, operation: "opinionLease", input: { opinionId, ownerToken } });
	});
}

test("immutable publication verifies bytes and metadata without a database connection held during I/O", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	objects.onPut = () => assert.equal(fixture.publicPool.idleCount, fixture.publicPool.totalCount);
	assert.equal((await fill(store, 101)).kind, "stored");
	objects.onRead = () => assert.equal(fixture.publicPool.idleCount, fixture.publicPool.totalCount);
	const read = await store.read({ provenance: provenance(101) });
	assert.equal(read.kind, "positive");
	assert.equal(read.sourceText, "fixture opinion text");
	const row = (
		await fixture.migration.query(
			"SELECT acquired_at, expires_at FROM lexcerta.source_objects WHERE opinion_id = 101",
		)
	).rows[0];
	assert.equal(row.expires_at.getTime() - row.acquired_at.getTime(), 30 * 86400000);
});

test("missing, corrupt, wrong-generation and altered-metadata objects never produce evidence", async () => {
	for (const [id, corrupt] of [
		[102, (objects, key) => objects.values.delete(key)],
		[
			103,
			(objects, key) => {
				objects.values.get(key).bytes = new TextEncoder().encode("bad");
			},
		],
		[
			104,
			(objects, key) => {
				objects.values.get(key).generation = "999";
			},
		],
		[
			105,
			(objects, key) => {
				objects.values.get(key).metadata.clusterId = "999";
			},
		],
	]) {
		const objects = new FixtureSourceObjects();
		const store = new PostgresOpinionSources(fixture.database, objects);
		await fill(store, id);
		corrupt(objects, [...objects.values.keys()][0]);
		await assert.rejects(store.read({ provenance: provenance(id) }));
	}
});

test("a second process can steal an expired lease and fence an uploaded stale publisher", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	const uploaded = deferred();
	const release = deferred();
	objects.onPut = async () => {
		uploaded.resolve();
		await release.promise;
	};
	const stale = fill(store, 106);
	await uploaded.promise;
	await expireLease(106);
	assert.equal((await childLease(106, randomUUID())).kind, "acquired");
	release.resolve();
	assert.equal((await stale).kind, "lease_unavailable");
	assert.equal(await store.read({ provenance: provenance(106) }), null);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT body_key FROM lexcerta.opinion_sources WHERE opinion_id = 106",
			)
		).rows[0].body_key,
		null,
	);
});

test("tombstone and GC during upload prevent any subsequent publication or source retry", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	const uploaded = deferred();
	const release = deferred();
	objects.onPut = async () => {
		uploaded.resolve();
		await release.promise;
	};
	const publication = fill(store, 107);
	await uploaded.promise;
	await new PostgresSourceAdministration(fixture.administration, "test", fixture.journal).remove(
		107,
		"fixture-operator",
	);
	await store.collectGarbage();
	release.resolve();
	assert.equal((await publication).kind, "lease_unavailable");
	assert.equal(objects.values.size, 0);
	await assert.rejects(
		store.acquireLease({ opinionId: 107, ownerToken: randomUUID(), now: new Date() }),
		/removed/,
	);
	await assert.rejects(store.read({ provenance: provenance(107) }), /removed/);
});

test("read-path expiry and an eviction retain history without returning stale body evidence", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	await fill(store, 108);
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET expires_at = clock_timestamp() - interval '1 second' WHERE opinion_id = 108",
	);
	assert.equal(await store.read({ provenance: provenance(108) }), null);
	await store.collectGarbage();
	assert.equal(objects.values.size, 0);
	const ownerToken = randomUUID();
	await store.acquireLease({ opinionId: 108, ownerToken, now: new Date() });
	const result = await store.fillLease({
		ownerToken,
		now: new Date(),
		observation: { kind: "negative", provenance: provenance(108) },
	});
	assert.equal(result.state.kind, "reversal_pending");
	assert.equal((await store.read({ provenance: provenance(108) })).state.kind, "reversal_pending");
});

test("capacity pressure evicts immutable bodies within both byte and opinion ceilings", async () => {
	// This fixture database contains earlier cases; remove only its own cache rows.
	await fixture.migration.query("UPDATE lexcerta.opinion_sources SET body_key = NULL");
	await fixture.migration.query("DELETE FROM lexcerta.source_objects");
	await fixture.migration.query(
		"UPDATE lexcerta.cache_capacity SET max_opinions = 1, max_bytes = 12",
	);
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	await fill(store, 109, "first");
	assert.equal((await fill(store, 110, "second")).kind, "stored");
	assert.equal(objects.values.size, 1);
	assert.equal(await store.read({ provenance: provenance(109) }), null);
	assert.equal((await store.read({ provenance: provenance(110) })).sourceText, "second");
	const total = (
		await fixture.migration.query(
			"SELECT count(DISTINCT opinion_id)::int AS opinions, sum(byte_size)::int AS bytes FROM lexcerta.source_objects",
		)
	).rows[0];
	assert.equal(total.opinions, 1);
	assert.ok(total.bytes <= 12);
	await fixture.migration.query(
		"UPDATE lexcerta.cache_capacity SET max_opinions = 1000, max_bytes = 268435456",
	);
});

test("a changed generation cannot be deleted by a stale cleanup", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	await fill(store, 111);
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET expires_at = clock_timestamp() - interval '1 second' WHERE opinion_id = 111",
	);
	objects.onRemove = (key) => {
		objects.values.get(key).generation = "new-generation";
	};
	await assert.rejects(store.collectGarbage(), /precondition/);
	assert.equal(objects.values.size, 1);
	assert.equal(await store.read({ provenance: provenance(111) }), null);
});

test("citation contradiction and expired negative purge preserve reversal history", async () => {
	const store = createPostgresCitationStore(fixture.database);
	const citation = "347 U.S. 483";
	async function observe(observation) {
		const ownerToken = randomUUID();
		await store.acquireLease({ normalizedCitation: citation, ownerToken, now: new Date(0) });
		return store.fillLease({
			normalizedCitation: citation,
			ownerToken,
			now: new Date(0),
			observation,
		});
	}
	assert.equal(
		(
			await observe({
				kind: "positive",
				cluster: { id: 108713, canonicalUrl: provenance(1).canonicalUrl },
			})
		).observation.kind,
		"positive",
	);
	assert.equal((await observe({ kind: "negative" })).observation.kind, "reversal_pending");
	await fixture.migration.query(
		"UPDATE lexcerta.citation_sources SET state = jsonb_set(state, '{firstNegative,retrievedAt}', to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE citation = $1",
		[citation],
	);
	assert.equal((await observe({ kind: "negative" })).observation.kind, "negative");
	await fixture.migration.query(
		"UPDATE lexcerta.citation_sources SET state = jsonb_set(state, '{negative,retrievedAt}', to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE citation = $1",
		[citation],
	);
	const expected = await store.read({ normalizedCitation: citation });
	const ownerToken = randomUUID();
	await store.acquireLease({ normalizedCitation: citation, ownerToken, now: new Date() });
	assert.equal(
		(
			await store.purgeExpiredNegativeLease({
				normalizedCitation: citation,
				ownerToken,
				now: new Date(),
				expected,
			})
		).observation.kind,
		"reversal_pending",
	);
});

test("an upload arriving after its tombstone is removed becomes a collectible orphan", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	const beforeUpload = deferred();
	const release = deferred();
	objects.onBeforePut = async () => {
		beforeUpload.resolve();
		await release.promise;
	};
	const publication = fill(store, 112);
	await beforeUpload.promise;
	await new PostgresSourceAdministration(fixture.administration, "test", fixture.journal).remove(
		112,
		"fixture-operator",
	);
	await store.collectGarbage();
	release.resolve();
	assert.equal((await publication).kind, "lease_unavailable");
	assert.equal(objects.values.size, 1);
	assert.equal(
		(await new PostgresOpinionSources(fixture.jobs, objects).collectOrphans()).deleted,
		0,
	);
	for (const value of objects.values.values())
		value.createdAt = new Date(Date.now() - 49 * 3600000);
	assert.equal(
		(await new PostgresOpinionSources(fixture.jobs, objects).collectOrphans()).deleted,
		1,
	);
	assert.equal(objects.values.size, 0);
	await assert.rejects(store.read({ provenance: provenance(112) }), /removed/);
});

test("orphan reconciliation preserves registered and recently created objects", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	await fill(store, 113);
	for (const value of objects.values.values())
		value.createdAt = new Date(Date.now() - 49 * 3600000);
	await objects.put("opinions/unregistered-fixture", new TextEncoder().encode("recent"), {});
	const orphan = "opinions/old-fixture";
	await objects.put(orphan, new TextEncoder().encode("old"), {});
	objects.values.get(orphan).createdAt = new Date(Date.now() - 49 * 3600000);
	assert.equal(
		(await new PostgresOpinionSources(fixture.jobs, objects).collectOrphans()).deleted,
		1,
	);
	assert.equal(objects.values.size, 2);
	assert.equal((await store.read({ provenance: provenance(113) })).kind, "positive");
});

test("a read racing a replacement publication cannot return the prior body", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	await fill(store, 114, "prior");
	const started = deferred();
	const release = deferred();
	objects.onRead = async () => {
		started.resolve();
		await release.promise;
	};
	const reading = store.read({ provenance: provenance(114) });
	await started.promise;
	await fill(store, 114, "replacement");
	release.resolve();
	assert.equal(await reading, null);
	objects.onRead = undefined;
	assert.equal((await store.read({ provenance: provenance(114) })).sourceText, "replacement");
});

test("an orphan deletion with a lost acknowledgement remains recoverable even after the object disappears", async () => {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	const key = "opinions/lost-delete-ack";
	await objects.put(key, new TextEncoder().encode("fixture"), {});
	objects.values.get(key).createdAt = new Date(Date.now() - 49 * 3600000);
	const remove = objects.remove.bind(objects);
	objects.remove = async (...args) => {
		await remove(...args);
		throw new Error("lost delete acknowledgement");
	};
	await assert.rejects(
		new PostgresOpinionSources(fixture.jobs, objects).collectOrphans(),
		/lost delete/,
	);
	assert.equal(objects.values.size, 0);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.orphan_object_deletions WHERE object_key = $1",
				[key],
			)
		).rowCount,
		1,
	);
	objects.remove = remove;
	assert.equal(
		(await new PostgresOpinionSources(fixture.jobs, objects).collectOrphans()).deleted,
		1,
	);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.orphan_object_deletions WHERE object_key = $1",
				[key],
			)
		).rowCount,
		0,
	);
});
