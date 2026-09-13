import { writeSync } from "node:fs";
import { readMaintenanceHealth } from "../postgres/maintenance.js";
import { runMaintenance } from "../postgres/run-maintenance.js";
import { createGcsSourceObjects } from "./gcs-source-objects.js";
import { createNeonDatabase } from "./neon-database.js";
import { readJobConfig } from "./runtime-config.js";
import { runTaskProcess } from "./task-process.js";

type JobResources = {
	run(signal: AbortSignal): Promise<Awaited<ReturnType<typeof runMaintenance>>>;
	health(): Promise<Awaited<ReturnType<typeof readMaintenanceHealth>>>;
	close(): Promise<void>;
};

async function initialize(signal: AbortSignal): Promise<JobResources> {
	const config = readJobConfig(process.env);
	const storage = await createNeonDatabase(config.database, "job", signal);
	const objects = createGcsSourceObjects(config.sourceBucket);
	return {
		run: (runSignal) => runMaintenance(storage.database, objects.withSignal(runSignal)),
		health: () => readMaintenanceHealth(storage.database),
		close: () => storage.close(),
	};
}

// Cloud Run Jobs supplies authenticated invocation and the attached job identity.
// This process exposes no HTTP route and accepts no caller-supplied cleanup scope.
export async function runMaintenanceProcess(
	create: (signal: AbortSignal) => Promise<JobResources> = initialize,
) {
	return runTaskProcess("maintenance", async (signal) => {
		const resources = await create(signal);
		return {
			async run(runSignal) {
				const result = await resources.run(runSignal);
				runSignal.throwIfAborted();
				const health = await resources.health();
				runSignal.throwIfAborted();
				writeSync(1, `${JSON.stringify({ event: "maintenance_finished", ...result, health })}\n`);
				return result.outcome === "partial" ? 1 : 0;
			},
			close: () => resources.close(),
		};
	});
}

if (import.meta.main) void runMaintenanceProcess();
