import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { GcsRecoveryJournal } from "../../build/node/gcs-recovery-journal.js";
import { PgDatabase } from "../../build/postgres/database.js";
import {
	KeyAdministrationConflict,
	PostgresKeyAdministration,
	PostgresKeyAdmission,
} from "../../build/postgres/keys.js";
import { RecoveryJournalUnavailable } from "../../build/postgres/recovery-journal.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";

let fixture;
const pepper = "synthetic-recovery-fixture-pepper";
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});
const admin = (journal = fixture.journal, database = fixture.administration) =>
	new PostgresKeyAdministration(database, "test", journal);
const admit = (token) =>
	new PostgresKeyAdmission(fixture.database, pepper, "test").admit(`Bearer ${token}`);
async function issued() {
	const publicId = randomUUID();
	const token = `lc_test_${publicId}_${"A".repeat(43)}`;
	await admin().issue({
		publicId,
		customerId: "synthetic-pilot",
		environment: "test",
		hmacSha256Hex: createHmac("sha256", pepper).update(token).digest("hex"),
		actorSubject: "synthetic-operator",
	});
	return { publicId, token };
}
async function row(publicId) {
	return (
		await fixture.migration.query(
			"SELECT status, expires_at, rotation_overlap_until, issued_at FROM lexcerta.api_keys WHERE public_id = $1",
			[publicId],
		)
	).rows[0];
}

test("revocation writes a verified external restriction before SQL changes, with no transaction held across object I/O", async () =>
	withObjects(async ({ connection }) => {
		const key = await issued();
		const store = new GcsRecoveryJournal("fixture", "staging", connection);
		let object;
		await admin({
			environment: "staging",
			async append(restriction, signal) {
				const activity = await fixture.inspectActivity();
				assert.equal(
					activity.some(
						(connection) =>
							connection.usename === fixture.adminRole && connection.state.includes("transaction"),
					),
					false,
				);
				assert.equal((await admit(key.token)).kind, "allowed");
				object = await store.append(restriction, signal);
				assert.deepEqual((await store.read(object)).restriction, {
					kind: "revoke_key",
					publicId: key.publicId,
				});
				assert.equal((await row(key.publicId)).status, "active");
				return object;
			},
		}).revoke(key.publicId, "synthetic-operator");
		assert.equal((await admit(key.token)).kind, "unauthorized");
		assert.ok(object);
	}));

test("unavailable journal prevents revocation and rotation from changing the database", async () => {
	const key = await issued();
	const before = await row(key.publicId);
	const blocked = admin({
		environment: "staging",
		async append() {
			throw new Error("synthetic secret provider error");
		},
	});
	await assert.rejects(
		blocked.revoke(key.publicId, "synthetic-operator"),
		RecoveryJournalUnavailable,
	);
	const nextId = randomUUID();
	await assert.rejects(
		blocked.rotate(key.publicId, {
			publicId: nextId,
			hmacSha256Hex: "b".repeat(64),
			actorSubject: "synthetic-operator",
		}),
		RecoveryJournalUnavailable,
	);
	assert.deepEqual(await row(key.publicId), before);
	assert.equal(await row(nextId), undefined);
	assert.equal((await admit(key.token)).kind, "allowed");
});

test("SQL audit failure leaves the external restriction intact and reports an uncertain outcome", async () =>
	withObjects(async ({ connection, values }) => {
		const key = await issued();
		const store = new GcsRecoveryJournal("fixture", "staging", connection);
		await assert.rejects(admin(store).revoke(key.publicId, ""), RecoveryJournalUnavailable);
		assert.equal((await row(key.publicId)).status, "active");
		assert.equal(values.size, 1);
		const receipt = await store.append({ kind: "revoke_key", publicId: key.publicId });
		assert.deepEqual((await store.read(receipt)).restriction, {
			kind: "revoke_key",
			publicId: key.publicId,
		});
		// Retry tightens the same ID; it cannot cancel the persisted restriction.
		await admin(store).revoke(key.publicId, "synthetic-operator");
		assert.equal(values.size, 1);
		assert.equal((await admit(key.token)).kind, "unauthorized");
	}));

test("rotation records the exact SQL expiry ceiling while preserving the bounded overlap", async () =>
	withObjects(async ({ connection }) => {
		const key = await issued();
		const store = new GcsRecoveryJournal("fixture", "staging", connection);
		const nextId = randomUUID();
		await admin(store).rotate(key.publicId, {
			publicId: nextId,
			hmacSha256Hex: "b".repeat(64),
			actorSubject: "synthetic-operator",
		});
		const prior = await row(key.publicId);
		const next = await row(nextId);
		const page = await store.list();
		assert.equal(page.objects.length, 1);
		assert.deepEqual((await store.read(page.objects[0])).restriction, {
			kind: "expire_key",
			publicId: key.publicId,
			notAfter: prior.expires_at.toISOString(),
		});
		assert.equal(prior.rotation_overlap_until.toISOString(), prior.expires_at.toISOString());
		assert.ok(prior.expires_at.getTime() > Date.now() + 6 * 86_400_000);
		assert.ok(prior.expires_at.getTime() <= Date.now() + 7 * 86_400_000);
		assert.equal(next.expires_at - next.issued_at, 90 * 86_400_000);
		assert.equal((await admit(key.token)).kind, "allowed");
	}));

test("lost SQL mutation COMMIT acknowledgement retains the journal and never retries", async () => {
	const key = await issued();
	let commits = 0;
	const database = new PgDatabase(
		poolWithCommitFault(fixture.adminPool, {
			async onCommit() {
				commits++;
				if (commits === 2) throw new Error("synthetic lost mutation acknowledgement");
			},
		}),
	);
	const count = fixture.journal.records.size;
	await assert.rejects(
		admin(fixture.journal, database).revoke(key.publicId, "synthetic-operator"),
		RecoveryJournalUnavailable,
	);
	assert.equal(commits, 2);
	assert.equal(fixture.journal.records.size, count + 1);
	assert.equal((await admit(key.token)).kind, "unauthorized");
});

test("rotation rollback preserves its external expiry restriction without creating a child", async () => {
	const key = await issued();
	const before = await row(key.publicId);
	const nextId = randomUUID();
	const priorRecords = new Set(fixture.journal.records.keys());
	await assert.rejects(
		admin().rotate(key.publicId, {
			publicId: nextId,
			hmacSha256Hex: "b".repeat(64),
			actorSubject: "",
		}),
		RecoveryJournalUnavailable,
	);
	assert.deepEqual(await row(key.publicId), before);
	assert.equal(await row(nextId), undefined);
	const added = [...fixture.journal.records.values()].filter(
		(entry) => !priorRecords.has(entry.key),
	);
	assert.equal(added.length, 1);
	assert.equal(added[0].record.restriction.kind, "expire_key");
	assert.equal(added[0].record.restriction.publicId, key.publicId);
});

test("cancellation after journal persistence cannot start the final SQL mutation", async () => {
	const key = await issued();
	const controller = new AbortController();
	const journal = {
		environment: "staging",
		async append(restriction, signal) {
			const receipt = await fixture.journal.append(restriction, signal);
			controller.abort();
			return receipt;
		},
	};
	const store = new PostgresKeyAdministration(
		fixture.administration.withSignal(controller.signal),
		"test",
		journal,
		controller.signal,
	);
	await assert.rejects(
		store.revoke(key.publicId, "synthetic-operator"),
		RecoveryJournalUnavailable,
	);
	assert.equal((await row(key.publicId)).status, "active");
	assert.ok(
		[...fixture.journal.records.values()].some(
			(entry) => entry.record.restriction.publicId === key.publicId,
		),
	);
});

test("preflight rejects unavailable or foreign keys before journal writes, and rejects a mismatched journal", async () => {
	const key = await issued();
	await fixture.migration.query(
		"UPDATE lexcerta.api_keys SET environment = 'production' WHERE public_id = $1",
		[key.publicId],
	);
	let calls = 0;
	const store = admin({
		environment: "staging",
		async append() {
			calls++;
			throw new Error("unexpected");
		},
	});
	await assert.rejects(store.revoke(key.publicId, "synthetic-operator"), KeyAdministrationConflict);
	await assert.rejects(store.revoke(randomUUID(), "synthetic-operator"), KeyAdministrationConflict);
	assert.equal(calls, 0);
	assert.throws(() => admin(fixture.productionJournal), RecoveryJournalUnavailable);
});
