import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PgDatabase } from "../../build/postgres/database.js";
import { createPostgresFixture } from "./fixture.mjs";
let fixture;
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});

test("a bounded SQL retry rolls back the failed attempt before external dispatch", async () => {
	await fixture.migration.query("CREATE SEQUENCE lexcerta.retry_fixture");
	let attempts = 0;
	let dispatched = 0;
	await new PgDatabase(fixture.migration).transaction(async (transaction) => {
		attempts += 1;
		await transaction.query(
			"INSERT INTO lexcerta.citation_sources(citation) VALUES ('retry-fixture')",
		);
		await transaction.query(
			"DO $$ BEGIN IF nextval('lexcerta.retry_fixture') = 1 THEN RAISE EXCEPTION 'fixture serialization failure' USING ERRCODE = '40001'; END IF; END $$",
		);
	});
	dispatched += 1;
	assert.equal(attempts, 2);
	assert.equal(dispatched, 1);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.citation_sources WHERE citation = 'retry-fixture'",
			)
		).rowCount,
		1,
	);
});

test("constraints reject oversized source records and unsafe cache ceilings", async () => {
	await assert.rejects(
		fixture.migration.query("UPDATE lexcerta.cache_capacity SET max_opinions = 1001"),
		{ code: "23514" },
	);
	await assert.rejects(
		fixture.migration.query("UPDATE lexcerta.cache_capacity SET max_bytes = 268435457"),
		{ code: "23514" },
	);
	await assert.rejects(
		fixture.migration.query(
			"INSERT INTO lexcerta.opinion_sources(opinion_id, state) VALUES (1, $1)",
			[JSON.stringify({ unexpected: "a".repeat(8193) })],
		),
		{ code: "23514" },
	);
});
