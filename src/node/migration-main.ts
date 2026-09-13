import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migratePostgres } from "../postgres/migrations.js";
import { databaseRoles } from "../postgres/roles.js";
import { createNeonDatabase } from "./neon-database.js";
import { readMigrationConfig } from "./runtime-config.js";
import { runTaskProcess } from "./task-process.js";

type MigrationResources = {
	run(signal: AbortSignal): Promise<readonly string[]>;
	close(): Promise<void>;
};

async function initialize(signal: AbortSignal): Promise<MigrationResources> {
	if (process.argv.length !== 2) throw new Error("Migration command accepts no arguments");
	const config = readMigrationConfig(process.env);
	const roles = databaseRoles(config.environment);
	const storage = await createNeonDatabase(config.database, "migrator", signal);
	return {
		run: (runSignal) =>
			migratePostgres(
				storage.database.pool,
				fileURLToPath(new URL("../../database/migrations/", import.meta.url)),
				roles.migrator,
				{ signal: runSignal, roles },
			),
		close: () => storage.close(),
	};
}

// Separate from service startup and from recurring maintenance. The deployed
// command has no caller-supplied schema path, role names or SQL argument.
export async function runMigrationProcess(
	create: (signal: AbortSignal) => Promise<MigrationResources> = initialize,
) {
	return runTaskProcess("migration", async (signal) => {
		const resources = await create(signal);
		return {
			async run(runSignal) {
				const applied = await resources.run(runSignal);
				runSignal.throwIfAborted();
				writeSync(
					1,
					`${JSON.stringify({ event: "migration_finished", applied: applied.length })}\n`,
				);
				return 0;
			},
			close: () => resources.close(),
		};
	});
}

if (import.meta.main) void runMigrationProcess();
