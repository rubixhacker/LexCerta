import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdministration } from "../../build/postgres/keys.js";
import { purgePostgresRetention } from "../../build/postgres/retention.js";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";
let fixture;
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});
async function issue() {
	const id = randomUUID();
	await new PostgresKeyAdministration(fixture.administration, "test", fixture.journal).issue({
		publicId: id,
		customerId: id,
		environment: "test",
		hmacSha256Hex: "a".repeat(64),
		actorSubject: "fixture",
	});
	return id;
}

test("bounded duplicate retention jobs remove due records and preserve live credentials", async () => {
	const due = await issue();
	const active = await issue();
	await fixture.migration.query(
		"UPDATE lexcerta.api_keys SET issued_at = clock_timestamp() - interval '2 years', expires_at = clock_timestamp() - interval '1 year', retention_expires_at = clock_timestamp() - interval '1 second' WHERE public_id = $1",
		[due],
	);
	await fixture.migration.query(
		"UPDATE lexcerta.admin_audit_events SET retention_expires_at = clock_timestamp() - interval '1 second' WHERE public_id = $1",
		[due],
	);
	await fixture.migration.query(
		"INSERT INTO lexcerta.key_admissions(public_id, admitted_at) VALUES ($1, clock_timestamp() - interval '49 hours'), ($1, clock_timestamp() - interval '1 hour')",
		[active],
	);
	await assert.rejects(fixture.publicPool.query("DELETE FROM lexcerta.api_keys"), {
		code: "42501",
	});
	await assert.rejects(
		fixture.jobPool.query("UPDATE lexcerta.api_keys SET hmac_sha256_hex = $1", ["b".repeat(64)]),
		{ code: "42501" },
	);
	await Promise.all([
		purgePostgresRetention(fixture.jobs, 1),
		purgePostgresRetention(fixture.jobs, 1),
	]);
	assert.equal(
		(await fixture.migration.query("SELECT 1 FROM lexcerta.api_keys WHERE public_id = $1", [due]))
			.rowCount,
		0,
	);
	assert.equal(
		(await fixture.migration.query("SELECT 1 FROM lexcerta.customers WHERE id = $1", [due]))
			.rowCount,
		0,
	);
	assert.equal(
		(
			await fixture.migration.query("SELECT 1 FROM lexcerta.api_keys WHERE public_id = $1", [
				active,
			])
		).rowCount,
		1,
	);
	assert.equal(
		(
			await fixture.migration.query("SELECT 1 FROM lexcerta.key_admissions WHERE public_id = $1", [
				active,
			])
		).rowCount,
		1,
	);
});

test("a lost retention commit acknowledgement is safely recoverable", async () => {
	const active = await issue();
	await fixture.migration.query(
		"INSERT INTO lexcerta.key_admissions(public_id, admitted_at) VALUES ($1, clock_timestamp() - interval '49 hours')",
		[active],
	);
	const failing = new PgDatabase(
		poolWithCommitFault(fixture.jobPool, {
			onCommit() {
				throw new Error("lost retention acknowledgement");
			},
		}),
	);
	await assert.rejects(purgePostgresRetention(failing), /lost retention/);
	assert.equal((await purgePostgresRetention(fixture.jobs)).admissions, 0);
	assert.equal(
		(
			await fixture.migration.query("SELECT 1 FROM lexcerta.api_keys WHERE public_id = $1", [
				active,
			])
		).rowCount,
		1,
	);
});

test("retention is atomic if its database transaction cannot commit", async () => {
	const active = await issue();
	await fixture.migration.query(
		"INSERT INTO lexcerta.key_admissions(public_id, admitted_at) VALUES ($1, clock_timestamp() - interval '49 hours')",
		[active],
	);
	const failing = new PgDatabase(
		poolWithCommitFault(fixture.jobPool, {
			afterCommit: false,
			onCommit() {
				throw new Error("commit unavailable");
			},
		}),
	);
	await assert.rejects(purgePostgresRetention(failing), /commit unavailable/);
	assert.equal(
		(
			await fixture.migration.query("SELECT 1 FROM lexcerta.key_admissions WHERE public_id = $1", [
				active,
			])
		).rowCount,
		1,
	);
	assert.equal((await purgePostgresRetention(fixture.jobs)).admissions, 1);
});
