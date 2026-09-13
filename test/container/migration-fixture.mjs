import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runMigrationProcess } from "../../build/node/migration-main.js";
import { createNeonDatabase } from "../../build/node/neon-database.js";
import { migratePostgres } from "../../build/postgres/migrations.js";
import { createPostgresTlsFixture, neonConnection } from "../fixtures/postgres-tls-fixture.mjs";

const settings = JSON.parse(
	await readFile(new URL("./migration-settings.json", import.meta.url), "utf8"),
);
const wire = await createPostgresTlsFixture(settings.connection, {
	certificate: settings.certificate,
	dockerBackend: true,
});
let directory = "database/migrations";
if (process.argv[2] === "slow-ddl") {
	directory = await mkdtemp("/tmp/lexcerta-migrations-");
	await cp("database/migrations", directory, { recursive: true });
	await writeFile(
		join(directory, "9000_fixture.sql"),
		"CREATE TABLE lexcerta.cancelled_container_migration(value text); SELECT pg_sleep(2);",
	);
}
try {
	await runMigrationProcess(async (signal) => {
		const storage = await createNeonDatabase(
			neonConnection,
			"migrator",
			signal,
			wire.poolFactory(),
		);
		return {
			run: (runSignal) =>
				migratePostgres(storage.database.pool, directory, settings.roles.migrator, {
					roles: settings.roles,
					signal: runSignal,
				}),
			async close() {
				await storage.close();
				assert.equal(storage.state.total, 0);
				process.stdout.write(
					`${JSON.stringify({ fixture_closed: true, node: process.version, arch: process.arch, uid: process.getuid(), max_rss_kib: process.resourceUsage().maxRSS })}\n`,
				);
			},
		};
	});
} finally {
	await wire.close();
}
