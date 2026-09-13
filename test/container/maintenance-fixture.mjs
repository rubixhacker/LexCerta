import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runMaintenanceProcess } from "../../build/node/maintenance-main.js";
import { createNeonDatabase } from "../../build/node/neon-database.js";
import { readMaintenanceHealth } from "../../build/postgres/maintenance.js";
import { runMaintenance } from "../../build/postgres/run-maintenance.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";
import { createPostgresTlsFixture, neonConnection } from "../fixtures/postgres-tls-fixture.mjs";

const settings = JSON.parse(
	await readFile(new URL("./maintenance-settings.json", import.meta.url), "utf8"),
);
const wire = await createPostgresTlsFixture(settings.connection, {
	certificate: settings.certificate,
	dockerBackend: true,
});
const pause = process.argv[2] === "pause-after-delete";
try {
	await withObjects(
		async ({ objects, values, behavior, requests }) => {
			behavior.nextPageToken = null;
			if (pause)
				values.set("opinions/maintenance-orphan", {
					bytes: Buffer.from("private-opinion-sentinel"),
					metadata: {
						name: "opinions/maintenance-orphan",
						generation: "9007199254740993",
						timeCreated: "2020-01-01T00:00:00.000Z",
					},
				});
			await runMaintenanceProcess(async (signal) => {
				const storage = await createNeonDatabase(neonConnection, "job", signal, wire.poolFactory());
				return {
					run: (runSignal) => runMaintenance(storage.database, objects.withSignal(runSignal)),
					health: () => readMaintenanceHealth(storage.database),
					async close() {
						await storage.close();
						assert.equal(storage.state.total, 0);
						process.stdout.write(
							`${JSON.stringify({ fixture_closed: true, node: process.version, arch: process.arch, uid: process.getuid(), max_rss_kib: process.resourceUsage().maxRSS, delete_requests: requests.filter((request) => request.method === "DELETE").length })}\n`,
						);
					},
				};
			});
		},
		{
			onDelete: async () => {
				if (!pause) return;
				process.stdout.write('{"fixture_deleted":true}\n');
				await new Promise(() => {});
			},
		},
	);
} finally {
	await wire.close();
}
