import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	PostgresCourtListenerCoordinator,
	initializeUpstreamBudget,
} from "../../build/postgres/coordinator.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
import { DiskSourceObjects } from "./disk-objects-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";
let fixture;
let directory;
const children = new Set();
before(async () => {
	fixture = await createPostgresFixture();
	directory = await mkdtemp(join(tmpdir(), "lexcerta-crash-objects-"));
});
after(async () => {
	await Promise.all([...children].map(kill));
	await fixture?.close();
	if (directory) await rm(directory, { recursive: true });
});
async function start() {
	const child = fork(new URL("./crash-process.mjs", import.meta.url), [], {
		env: { ...process.env, LEXCERTA_PROCESS_DATABASE_URL: fixture.publicConnection },
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	children.add(child);
	await once(child, "message");
	return child;
}
async function kill(child) {
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	children.delete(child);
}
async function crash(input) {
	const child = await start();
	const reached = once(child, "message");
	child.send({ ...input, directory });
	const [message] = await reached;
	await kill(child);
	assert.equal(message.phase, input.mode, message.error);
}
async function budget() {
	const credentialId = randomUUID();
	await initializeUpstreamBudget(new PgDatabase(fixture.migration), credentialId);
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET enabled = true, max_minute = 1 WHERE credential_id = $1",
		[credentialId],
	);
	const coordinator = new PostgresCourtListenerCoordinator(fixture.database, credentialId);
	const syncToken = randomUUID();
	await coordinator.beginQuotaSync({ syncToken, now: new Date() });
	await coordinator.recordQuotaSync({
		syncToken,
		now: new Date(),
		windows: ["user", "citations", "api_usage"].map((scope) => ({
			scope,
			limit: 100,
			remaining: 100,
			rate: "minute",
			windowSeconds: 60,
			resetAt: null,
		})),
	});
	return { credentialId, coordinator };
}
const provenance = (opinionId) => ({
	opinionId,
	clusterId: 108713,
	canonicalUrl: "https://www.courtlistener.com/opinion/108713/example/",
});

test("SIGKILL before reservation commit rolls back and after commit retains the spent slot", async () => {
	for (const mode of ["before-reservation-commit", "after-reservation-commit"]) {
		const { credentialId, coordinator } = await budget();
		await crash({ mode, credentialId, token: randomUUID() });
		const result = await coordinator.admit({
			endpoint: "citation",
			reservationToken: randomUUID(),
			now: new Date(),
		});
		assert.equal(
			result.kind,
			mode === "before-reservation-commit" ? "reserved" : "quota_exhausted",
		);
	}
});

test("SIGKILL after HTTP dispatch leaves the committed attempt spent", async () => {
	const { credentialId, coordinator } = await budget();
	let requests = 0;
	const server = createServer((_request, response) => {
		requests += 1;
		response.writeHead(200);
		response.flushHeaders();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const child = await start();
	const requested = once(server, "request");
	try {
		child.send({
			mode: "dispatch",
			credentialId,
			token: randomUUID(),
			url: `http://127.0.0.1:${server.address().port}`,
		});
		await requested;
		await kill(child);
		assert.equal(requests, 1);
		assert.equal(
			(
				await coordinator.admit({
					endpoint: "citation",
					reservationToken: randomUUID(),
					now: new Date(),
				})
			).kind,
			"quota_exhausted",
		);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("SIGKILL after upload leaves no authority and another process can collect the abandoned object", async () => {
	await crash({ mode: "after-upload", opinionId: 501, token: randomUUID() });
	const store = new PostgresOpinionSources(fixture.database, new DiskSourceObjects(directory));
	assert.equal(await store.read({ provenance: provenance(501) }), null);
	assert.equal((await readdir(directory)).length, 1);
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET acquired_at = clock_timestamp() - interval '49 hours', expires_at = clock_timestamp() + interval '1 hour' WHERE opinion_id = 501",
	);
	await store.collectGarbage();
	assert.equal((await readdir(directory)).length, 0);
	assert.equal(
		(await fixture.migration.query("SELECT 1 FROM lexcerta.source_objects WHERE opinion_id = 501"))
			.rowCount,
		0,
	);
});

test("SIGKILL after publication commit preserves verified evidence; death after deletion recovers cleanly", async () => {
	await crash({ mode: "after-publication-commit", opinionId: 502, token: randomUUID() });
	const store = new PostgresOpinionSources(fixture.database, new DiskSourceObjects(directory));
	assert.equal(
		(await store.read({ provenance: provenance(502) })).sourceText,
		"crash fixture opinion",
	);
	await store.tombstone(502);
	await crash({ mode: "after-deletion", opinionId: 502, token: randomUUID() });
	assert.equal((await readdir(directory)).length, 0);
	await assert.rejects(store.read({ provenance: provenance(502) }), /removed/);
	await fixture.migration.query(
		"UPDATE lexcerta.source_objects SET delete_after = clock_timestamp() - interval '1 second' WHERE opinion_id = 502",
	);
	await store.collectGarbage();
	assert.equal(
		(await fixture.migration.query("SELECT 1 FROM lexcerta.source_objects WHERE opinion_id = 502"))
			.rowCount,
		0,
	);
});
