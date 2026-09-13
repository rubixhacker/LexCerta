import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { GcsRecoveryJournal } from "../../build/node/gcs-recovery-journal.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
import { PostgresSourceAdministration } from "../../build/postgres/source-administration.js";
import { RecoveryJournalUnavailable } from "../../build/postgres/recovery-journal.js";
import { purgePostgresRetention } from "../../build/postgres/retention.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { FixtureSourceObjects } from "./objects-fixture.mjs";

let fixture;
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});
const administrator = (journal = fixture.journal, database = fixture.administration) =>
	new PostgresSourceAdministration(database, "test", journal);
const provenance = (opinionId) => ({
	opinionId,
	clusterId: 108713,
	canonicalUrl: "https://www.courtlistener.com/opinion/108713/fixture/",
});
async function source(opinionId) {
	const objects = new FixtureSourceObjects();
	const store = new PostgresOpinionSources(fixture.database, objects);
	const ownerToken = randomUUID();
	await store.acquireLease({ opinionId, ownerToken, now: new Date() });
	await store.fillLease({
		ownerToken,
		now: new Date(),
		observation: {
			kind: "positive",
			provenance: provenance(opinionId),
			representation: "plain_text",
			sourceText: "private-source-removal-sentinel",
		},
	});
	return { objects, store };
}
async function row(opinionId) {
	return (
		await fixture.migration.query("SELECT * FROM lexcerta.opinion_sources WHERE opinion_id = $1", [
			opinionId,
		])
	).rows[0];
}

test("source removal verifies an external record before disabling evidence, retains history and audits the verified actor", async () =>
	withObjects(async ({ connection }) => {
		const { store, objects } = await source(901);
		const before = await row(901);
		const journal = new GcsRecoveryJournal("fixture", "staging", connection);
		let receipt;
		const result = await administrator({
			environment: "staging",
			async append(restriction, signal) {
				assert.equal(fixture.adminPool.idleCount, fixture.adminPool.totalCount);
				assert.equal((await store.read({ provenance: provenance(901) })).kind, "positive");
				receipt = await journal.append(restriction, signal);
				assert.deepEqual((await journal.read(receipt)).restriction, {
					kind: "remove_opinion",
					opinionId: 901,
				});
				return receipt;
			},
		}).remove(901, "verified-operator-subject");
		assert.deepEqual(result, {
			opinionId: 901,
			status: "removed",
			removedAt: (await row(901)).removed_at.toISOString(),
			pendingDeletionObjects: 1,
		});
		const removed = await row(901);
		assert.deepEqual(removed.state, before.state);
		assert.equal(BigInt(removed.epoch), BigInt(before.epoch) + 1n);
		assert.equal(removed.body_key, null);
		assert.equal(removed.owner_token, null);
		assert.equal(removed.lease_expires_at, null);
		await assert.rejects(store.read({ provenance: provenance(901) }), /removed/);
		await assert.rejects(
			store.acquireLease({ opinionId: 901, ownerToken: randomUUID(), now: new Date() }),
			/removed/,
		);
		const audit = (
			await fixture.migration.query(
				"SELECT *, retention_expires_at = occurred_at + interval '1 year' AS retained_year FROM lexcerta.admin_audit_events WHERE opinion_id = 901",
			)
		).rows[0];
		assert.equal(audit.action, "source_removed");
		assert.equal(audit.actor_subject, "verified-operator-subject");
		assert.equal(audit.environment, "test");
		assert.equal(audit.customer_id, null);
		assert.equal(audit.public_id, null);
		assert.deepEqual(audit.metadata, {});
		assert.equal(audit.retained_year, true);
		assert.equal(objects.values.size, 1);
		assert.equal(await new PostgresOpinionSources(fixture.jobs, objects).collectGarbage(), 1);
		assert.equal(objects.values.size, 0);
		assert.deepEqual((await row(901)).state, before.state);
	}));

test("repeated removal reuses its journal and audit and preserves a collector's delete token", async () => {
	await source(902);
	const before = fixture.journal.records.size;
	const first = await administrator().remove(902, "first-operator");
	const epoch = (await row(902)).epoch;
	const token = randomUUID();
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET delete_token = $1, delete_after = clock_timestamp() + interval '1 minute' WHERE opinion_id = 902",
		[token],
	);
	const deletion = (
		await fixture.migration.query(
			"SELECT delete_token, delete_after FROM lexcerta.source_objects WHERE opinion_id = 902",
		)
	).rows[0];
	assert.deepEqual(await administrator().remove(902, "retry-operator"), first);
	assert.equal(fixture.journal.records.size, before + 1);
	assert.equal((await row(902)).epoch, epoch);
	assert.deepEqual(
		(
			await fixture.migration.query(
				"SELECT delete_token, delete_after FROM lexcerta.source_objects WHERE opinion_id = 902",
			)
		).rows[0],
		deletion,
	);
	const audits = await fixture.migration.query(
		"SELECT actor_subject FROM lexcerta.admin_audit_events WHERE opinion_id = 902",
	);
	assert.deepEqual(audits.rows, [{ actor_subject: "first-operator" }]);
});

test("an uncached opinion can be removed and its tombstone survives administrative retention", async () => {
	const result = await administrator().remove(903, "verified-operator");
	assert.equal(result.pendingDeletionObjects, 0);
	await fixture.migration.query(
		"UPDATE lexcerta.admin_audit_events SET retention_expires_at = clock_timestamp() - interval '1 second' WHERE opinion_id = 903",
	);
	await purgePostgresRetention(fixture.jobs);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.admin_audit_events WHERE opinion_id = 903",
			)
		).rowCount,
		0,
	);
	assert.equal((await row(903)).removed_at.toISOString(), result.removedAt);
	await assert.rejects(
		new PostgresOpinionSources(fixture.database, new FixtureSourceObjects()).acquireLease({
			opinionId: 903,
			ownerToken: randomUUID(),
			now: new Date(),
		}),
		/removed/,
	);
});

test("runtime grants deny direct removal/revival, source deletion and nonoperator function execution", async () => {
	await administrator().remove(904, "verified-operator");
	for (const pool of [fixture.publicPool, fixture.jobPool]) {
		await assert.rejects(
			pool.query("SELECT * FROM lexcerta.remove_opinion(904, 'forged', 'test')"),
			{ code: "42501" },
		);
	}
	for (const pool of [fixture.publicPool, fixture.jobPool, fixture.adminPool]) {
		await assert.rejects(
			pool.query("UPDATE lexcerta.opinion_sources SET removed_at = NULL WHERE opinion_id = 904"),
			{ code: "42501" },
		);
		await assert.rejects(
			pool.query("DELETE FROM lexcerta.opinion_sources WHERE opinion_id = 904"),
			{ code: "42501" },
		);
	}
	await assert.rejects(
		fixture.publicPool.query(
			"INSERT INTO lexcerta.opinion_sources(opinion_id, removed_at) VALUES (905, clock_timestamp())",
		),
		{ code: "42501" },
	);
	await assert.rejects(
		fixture.adminPool.query(
			"UPDATE lexcerta.source_objects SET phase = 'ready' WHERE opinion_id = 904",
		),
		{ code: "42501" },
	);
	assert.ok((await row(904)).removed_at);
});

test("definer function ignores caller search-path objects and rejects invalid SQL arguments", async () => {
	await fixture.migration.query(
		"CREATE SCHEMA fixture_shadow; CREATE FUNCTION fixture_shadow.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2000-01-01'::timestamptz $$",
	);
	await fixture.migration.query(
		`GRANT USAGE ON SCHEMA fixture_shadow TO ${fixture.adminRole}; GRANT EXECUTE ON FUNCTION fixture_shadow.clock_timestamp() TO ${fixture.adminRole}`,
	);
	const client = await fixture.adminPool.connect();
	try {
		await client.query("SET search_path = fixture_shadow, pg_catalog");
		assert.equal(
			(await client.query("SELECT clock_timestamp() AS now")).rows[0].now.getUTCFullYear(),
			2000,
		);
		const result = await client.query(
			"SELECT * FROM lexcerta.remove_opinion(906, 'verified-operator', 'test')",
		);
		assert.ok(result.rows[0].removed_at.getTime() > Date.now() - 10_000);
		for (const parameters of [
			[0, "operator", "test"],
			["9007199254740992", "operator", "test"],
			[907, "", "test"],
			[907, "operator", "staging"],
			[null, "operator", "test"],
		])
			await assert.rejects(
				client.query("SELECT * FROM lexcerta.remove_opinion($1,$2,$3)", parameters),
				{ code: "22023" },
			);
		assert.equal(await row(907), undefined);
	} finally {
		await client.query("RESET search_path");
		client.release();
	}
});

test("a journal outage cannot remove a source and a failed SQL audit leaves a replayable restriction", async () => {
	const unavailable = {
		environment: "staging",
		async append() {
			throw new Error("private-provider-sentinel");
		},
	};
	await assert.rejects(
		administrator(unavailable).remove(908, "operator"),
		RecoveryJournalUnavailable,
	);
	assert.equal(await row(908), undefined);
	await fixture.migration.query(
		"CREATE FUNCTION lexcerta.fixture_reject_source_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.opinion_id = 909 THEN RAISE EXCEPTION 'private-audit-sentinel'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_reject_source_audit BEFORE INSERT ON lexcerta.admin_audit_events FOR EACH ROW EXECUTE FUNCTION lexcerta.fixture_reject_source_audit()",
	);
	try {
		await assert.rejects(administrator().remove(909, "operator"), RecoveryJournalUnavailable);
		assert.equal(await row(909), undefined);
		assert.ok(
			[...fixture.journal.records.values()].some(
				(entry) => entry.record.restriction.opinionId === 909,
			),
		);
	} finally {
		await fixture.migration.query(
			"DROP TRIGGER fixture_reject_source_audit ON lexcerta.admin_audit_events; DROP FUNCTION lexcerta.fixture_reject_source_audit()",
		);
	}
	assert.equal((await administrator().remove(909, "operator")).status, "removed");
});

test("a lost removal COMMIT acknowledgement never repeats SQL and an explicit retry is idempotent", async () => {
	let commits = 0;
	const database = new PgDatabase(
		poolWithCommitFault(fixture.adminPool, {
			async onCommit() {
				commits++;
				throw new Error("synthetic lost acknowledgement");
			},
		}),
	);
	await assert.rejects(
		administrator(fixture.journal, database).remove(910, "operator"),
		RecoveryJournalUnavailable,
	);
	assert.equal(commits, 1);
	const first = await row(910);
	const recovered = await administrator().remove(910, "operator");
	assert.equal(recovered.removedAt, first.removed_at.toISOString());
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.admin_audit_events WHERE opinion_id = 910",
			)
		).rowCount,
		1,
	);
});

test("cancelled and cross-environment source operations cannot mutate SQL", async () => {
	assert.throws(() => administrator(fixture.productionJournal), RecoveryJournalUnavailable);
	const controller = new AbortController();
	const journal = {
		environment: "staging",
		async append(restriction, signal) {
			const receipt = await fixture.journal.append(restriction, signal);
			controller.abort();
			return receipt;
		},
	};
	await assert.rejects(
		new PostgresSourceAdministration(
			fixture.administration.withSignal(controller.signal),
			"test",
			journal,
			controller.signal,
		).remove(911, "operator"),
		RecoveryJournalUnavailable,
	);
	assert.equal(await row(911), undefined);
});
