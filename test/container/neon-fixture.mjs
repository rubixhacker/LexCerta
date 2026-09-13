import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createNeonDatabase } from "../../build/node/neon-database.js";
import { createPostgresTlsFixture, neonConnection } from "../fixtures/postgres-tls-fixture.mjs";

const settings = JSON.parse(
	await readFile(new URL("./neon-settings.json", import.meta.url), "utf8"),
);
const wire = await createPostgresTlsFixture(settings.connection, {
	certificate: settings.certificate,
	dockerBackend: true,
});
let storage;
try {
	await assert.rejects(
		createNeonDatabase(neonConnection, "public", undefined, wire.poolFactory({ trusted: false })),
		{ message: "Database initialization unavailable" },
	);
	wire.delayMs = 1200;
	storage = await createNeonDatabase(neonConnection, "public", undefined, wire.poolFactory());
	const result = await storage.database.transaction((tx) => tx.query("SELECT 42 AS answer"));
	assert.equal(result.rows[0].answer, 42);
	await assert.rejects(
		storage.database.transaction((tx) => tx.query("DELETE FROM lexcerta.api_keys")),
		{ code: "42501" },
	);
	wire.disconnect();
	const droppedDeadline = performance.now() + 3000;
	while (storage.state.total !== 0) {
		assert.ok(performance.now() < droppedDeadline);
		await delay(20);
	}
	assert.equal(
		(
			await storage.database
				.withSignal(new AbortController().signal)
				.transaction((tx) => tx.query("SELECT 43 AS answer"))
		).rows[0].answer,
		43,
	);
	const idleDeadline = performance.now() + 12_000;
	while (storage.state.total !== 0 || wire.state.active !== 0) {
		assert.ok(performance.now() < idleDeadline);
		await delay(25);
	}
	assert.equal(wire.state.received, 3);
	console.log(
		JSON.stringify({
			fixture: "neon-tls",
			node: process.version,
			arch: process.arch,
			uid: process.getuid(),
			checks: 5,
			max_rss_kib: process.resourceUsage().maxRSS,
			source: "local-postgresql",
		}),
	);
} finally {
	await storage?.close();
	await wire.close();
}
