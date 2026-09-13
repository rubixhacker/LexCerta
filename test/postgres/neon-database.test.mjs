import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createNeonDatabase } from "../../build/node/neon-database.js";
import { PostgresUnavailableError } from "../../build/postgres/database.js";
import { createPostgresTlsFixture, neonConnection } from "../fixtures/postgres-tls-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";

let fixture;
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});

async function until(condition, timeout = 3000) {
	const deadline = performance.now() + timeout;
	while (!(await condition())) {
		assert.ok(performance.now() < deadline, "TLS fixture did not reach the expected state");
		await delay(10);
	}
}

test("TLS PostgreSQL authenticates a restricted role and preserves real transaction timeouts and grants", async () => {
	const wire = await createPostgresTlsFixture(fixture.publicConnection);
	let storage;
	try {
		storage = await createNeonDatabase(neonConnection, "public", undefined, wire.poolFactory());
		const result = await storage.database.transaction((tx) =>
			tx.query(`
			SELECT current_user AS role,
			current_setting('statement_timeout') AS statement,
			current_setting('lock_timeout') AS lock,
			current_setting('idle_in_transaction_session_timeout') AS idle,
			current_setting('transaction_timeout') AS transaction
		`),
		);
		assert.deepEqual(result.rows, [
			{ role: fixture.publicRole, statement: "2s", lock: "500ms", idle: "2s", transaction: "5s" },
		]);
		assert.equal(wire.state.encrypted, 1);
		await assert.rejects(
			storage.database.transaction((tx) => tx.query("DELETE FROM lexcerta.api_keys")),
			{ code: "42501" },
		);
		assert.equal((await storage.database.transaction((tx) => tx.query("SELECT 1"))).rowCount, 1);
	} finally {
		await storage?.close();
		await wire.close();
	}
});

for (const mode of ["untrusted", "wrong-host", "plaintext-only"]) {
	test(`database startup rejects ${mode} TLS without a plaintext fallback`, async () => {
		const wire = await createPostgresTlsFixture(
			fixture.publicConnection,
			mode === "wrong-host" ? { certificateHost: "different-host.invalid" } : {},
		);
		wire.refuseTls = mode === "plaintext-only";
		try {
			await assert.rejects(
				createNeonDatabase(
					neonConnection,
					"public",
					undefined,
					wire.poolFactory({ trusted: mode !== "untrusted" }),
				),
				{ message: "Database initialization unavailable" },
			);
			await until(() => wire.state.active === 0);
			assert.equal(wire.state.received, 1);
		} finally {
			await wire.close();
		}
	});
}

test("a delayed database can wake, lose its idle socket and reconnect under a request signal", async () => {
	const wire = await createPostgresTlsFixture(fixture.publicConnection);
	wire.delayMs = 1500;
	let storage;
	try {
		const began = performance.now();
		storage = await createNeonDatabase(neonConnection, "public", undefined, wire.poolFactory());
		assert.ok(performance.now() - began >= 1500);
		wire.disconnect();
		await until(() => storage.state.total === 0 && storage.state.failures === 1);
		const value = await storage.database
			.withSignal(new AbortController().signal)
			.transaction((tx) => tx.query("SELECT 42 AS answer"));
		assert.equal(value.rows[0].answer, 42);
		assert.equal(wire.state.received, 2);
		// Retain the production idle setting: no timer issues SQL to keep it warm.
		await until(() => storage.state.total === 0 && wire.state.active === 0, 12_000);
		await delay(50);
		assert.equal(wire.state.received, 2);
	} finally {
		await storage?.close();
		await wire.close();
	}
});

test("stalled activation closes its real socket within the four-second connection bound", async () => {
	const wire = await createPostgresTlsFixture(fixture.publicConnection);
	wire.delayMs = 20_000;
	try {
		const began = performance.now();
		await assert.rejects(
			createNeonDatabase(neonConnection, "public", undefined, wire.poolFactory()),
			{ message: "Database initialization unavailable" },
		);
		assert.ok(performance.now() - began >= 3500);
		assert.ok(performance.now() - began < 5500);
		await until(() => wire.state.active === 0);
		assert.equal(wire.state.received, 1);
	} finally {
		await wire.close();
	}
});

test("cancelling activation disposes a late authenticated connection without admitting work", async () => {
	const wire = await createPostgresTlsFixture(fixture.publicConnection);
	wire.delayMs = 1500;
	const controller = new AbortController();
	try {
		const pending = assert.rejects(
			createNeonDatabase(neonConnection, "public", controller.signal, wire.poolFactory()),
			{ message: "Database initialization unavailable" },
		);
		await until(() => wire.state.received === 1);
		controller.abort("private-password-sentinel");
		await pending;
		await until(() => wire.state.active === 0);
	} finally {
		await wire.close();
	}
});

test("database shutdown interrupts active SQL and rolls back its uncommitted writes", async () => {
	const wire = await createPostgresTlsFixture(fixture.publicConnection);
	let storage;
	try {
		storage = await createNeonDatabase(neonConnection, "public", undefined, wire.poolFactory());
		const started = Promise.withResolvers();
		const pending = assert.rejects(
			storage.database.transaction(async (tx) => {
				await tx.query("INSERT INTO lexcerta.citation_sources(citation) VALUES ('neon-shutdown')");
				const sleeping = tx.query("SELECT pg_sleep(1.5)");
				started.resolve();
				await sleeping;
			}),
			PostgresUnavailableError,
		);
		await started.promise;
		await storage.close();
		await pending;
		await until(() => wire.state.active === 0);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT 1 FROM lexcerta.citation_sources WHERE citation = 'neon-shutdown'",
				)
			).rowCount,
			0,
		);
		await storage.close();
	} finally {
		await storage?.close();
		await wire.close();
	}
});

test("an elevated database owner is rejected even after successful TLS authentication", async () => {
	const wire = await createPostgresTlsFixture(process.env.LEXCERTA_TEST_DATABASE_URL);
	try {
		await assert.rejects(
			createNeonDatabase(neonConnection, "public", undefined, wire.poolFactory()),
			{ message: "Database initialization unavailable" },
		);
		assert.equal(wire.state.encrypted, 1);
		await until(() => wire.state.active === 0);
	} finally {
		await wire.close();
	}
});
