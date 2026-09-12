import { Pool } from "pg";
import { PostgresCourtListenerCoordinator } from "../../build/postgres/coordinator.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
import { DiskSourceObjects } from "./disk-objects-fixture.mjs";
import { poolWithCommitFault } from "./failure-fixture.mjs";
const pool = new Pool({ connectionString: process.env.LEXCERTA_PROCESS_DATABASE_URL, max: 1 });
async function boundary(phase) {
	process.send({ phase });
	await new Promise(() => {});
}
process.on("message", async ({ mode, credentialId, token, opinionId, directory, url }) => {
	try {
		let commits = 0;
		const wrapped = poolWithCommitFault(pool, {
			afterCommit: mode !== "before-reservation-commit",
			async onCommit() {
				commits += 1;
				if (
					(["before-reservation-commit", "after-reservation-commit"].includes(mode) &&
						commits === 1) ||
					(mode === "after-publication-commit" && commits === 3)
				)
					await boundary(mode);
			},
		});
		const database = new PgDatabase(wrapped);
		if (mode.includes("reservation") || mode === "dispatch") {
			const result = await new PostgresCourtListenerCoordinator(database, credentialId).admit({
				endpoint: "citation",
				reservationToken: token,
				now: new Date(),
			});
			if (result.kind !== "reserved") throw new Error(`reservation ${result.kind}`);
			if (mode === "dispatch") await fetch(url);
		} else {
			const objects = new DiskSourceObjects(directory, {
				upload: mode === "after-upload" ? () => boundary(mode) : undefined,
				deletion: mode === "after-deletion" ? () => boundary(mode) : undefined,
			});
			const store = new PostgresOpinionSources(database, objects);
			if (mode === "after-deletion") await store.collectGarbage();
			else {
				await store.acquireLease({ opinionId, ownerToken: token, now: new Date() });
				await store.fillLease({
					ownerToken: token,
					now: new Date(),
					observation: {
						kind: "positive",
						provenance: {
							opinionId,
							clusterId: 108713,
							canonicalUrl: "https://www.courtlistener.com/opinion/108713/example/",
						},
						representation: "plain_text",
						sourceText: "crash fixture opinion",
					},
				});
			}
		}
		process.send({ error: "boundary was not reached" });
	} catch (error) {
		process.send({ error: error.message });
	}
});
process.send({ ready: true });
