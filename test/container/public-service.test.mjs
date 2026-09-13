import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectPilot, runPilot } from "../../examples/pilot-client.ts";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdministration } from "../../build/postgres/keys.js";
import {
	PostgresCourtListenerCoordinator,
	initializeUpstreamBudget,
} from "../../build/postgres/coordinator.js";
import { createPostgresFixture } from "../postgres/fixture.mjs";
import { image, docker, until, verifyImage } from "./runtime-fixture.mjs";

test("the default image entrypoint fails safely without configuration or database connectivity", async () => {
	for (const environment of [
		[],
		[
			"LEXCERTA_ENVIRONMENT=staging",
			"GOOGLE_CLOUD_PROJECT=fixture-project",
			"LEXCERTA_DATABASE_HOST=ep-fixture-123.us-east-2.aws.neon.tech",
			"LEXCERTA_DATABASE_PASSWORD=synthetic-neon-fixture-password-32",
			`LEXCERTA_BUILD_ID=${"0".repeat(40)}`,
			"API_KEY_PEPPER=private-startup-pepper-sentinel-32",
			"COURTLISTENER_CREDENTIAL_ID=fixture",
			"COURTLISTENER_API_TOKEN=private-startup-token-sentinel",
		],
	]) {
		const began = performance.now();
		await assert.rejects(
			docker(
				"run",
				"--rm",
				"--platform",
				"linux/amd64",
				"--network",
				"none",
				"--memory",
				"1g",
				"--memory-swap",
				"1g",
				"--cpus",
				"1",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				...environment.flatMap((value) => ["-e", value]),
				image,
			),
			(error) => {
				assert.equal(error.code, 1);
				assert.equal(error.stdout, "");
				assert.equal(error.stderr, '{"event":"startup_failed"}\n');
				return true;
			},
		);
		assert.ok(performance.now() - began < 10_000);
	}
});

async function container(run) {
	const files = [
		"node/public-main.js",
		"node/service-http.js",
		"node/service-process.js",
		"postgres/keys.js",
		"node/public-http.js",
		"node/public-application.js",
		"node/neon-database.js",
		"node/runtime-config.js",
		"node/gcs-source-objects.js",
		"postgres/database.js",
	];
	const inspected = await verifyImage(files);
	const fixture = await createPostgresFixture();
	const directory = await mkdtemp(
		join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "lexcerta-container-"),
	);
	const name = `lexcerta-public-${randomUUID().slice(0, 8)}`;
	try {
		await chmod(directory, 0o755);
		await mkdir(join(directory, "container"));
		await mkdir(join(directory, "fixtures"));
		await copyFile(
			"test/container/public-fixture.mjs",
			join(directory, "container/public-fixture.mjs"),
		);
		await copyFile(
			"test/fixtures/gcs-wire-fixture.mjs",
			join(directory, "fixtures/gcs-wire-fixture.mjs"),
		);
		const pepper = "synthetic-container-fixture-pepper-value";
		const publicId = randomUUID();
		const token = `lc_test_${publicId}_${"A".repeat(43)}`;
		await new PostgresKeyAdministration(fixture.administration, "test", fixture.journal).issue({
			publicId,
			customerId: randomUUID(),
			environment: "test",
			actorSubject: "fixture-operator",
			hmacSha256Hex: createHmac("sha256", pepper).update(token).digest("hex"),
			minuteLimit: 10,
			dayLimit: 100,
		});
		const credentialId = randomUUID();
		await initializeUpstreamBudget(new PgDatabase(fixture.migration), credentialId);
		await fixture.migration.query(
			"UPDATE lexcerta.upstream_budgets SET enabled = true WHERE credential_id = $1",
			[credentialId],
		);
		const coordinator = new PostgresCourtListenerCoordinator(fixture.database, credentialId);
		const syncToken = randomUUID();
		await coordinator.beginQuotaSync({ now: new Date(), syncToken });
		await coordinator.recordQuotaSync({
			now: new Date(),
			syncToken,
			windows: ["user", "citations", "api_usage"].map((scope) => ({
				scope,
				limit: 100,
				remaining: 100,
				rate: "minute",
				windowSeconds: 60,
				resetAt: null,
			})),
		});
		const connection = new URL(fixture.publicConnection);
		connection.hostname = "host.docker.internal";
		await docker(
			"run",
			"--detach",
			"--platform",
			"linux/amd64",
			"--name",
			name,
			"--memory",
			"1g",
			"--memory-swap",
			"1g",
			"--cpus",
			"1",
			"--pids-limit",
			"128",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--add-host",
			"host.docker.internal:host-gateway",
			"-p",
			"127.0.0.1::8080",
			"--mount",
			`type=bind,source=${directory},target=/app/test,readonly`,
			"-e",
			`LEXCERTA_TEST_DATABASE_URL=${connection}`,
			"-e",
			"LEXCERTA_ENVIRONMENT=staging",
			"-e",
			"GOOGLE_CLOUD_PROJECT=fixture-project",
			"-e",
			"LEXCERTA_DATABASE_HOST=ep-fixture-123.us-east-2.aws.neon.tech",
			"-e",
			"LEXCERTA_DATABASE_PASSWORD=synthetic-neon-fixture-password-32",
			"-e",
			`LEXCERTA_BUILD_ID=${"0".repeat(40)}`,
			"-e",
			`API_KEY_PEPPER=${pepper}`,
			"-e",
			`COURTLISTENER_CREDENTIAL_ID=${credentialId}`,
			"-e",
			"COURTLISTENER_API_TOKEN=synthetic-upstream-token",
			image,
			"node",
			"test/container/public-fixture.mjs",
		);
		const mapped = (await docker("port", name, "8080/tcp")).split(":").at(-1);
		const limits = JSON.parse(await docker("inspect", name))[0].HostConfig;
		assert.equal(limits.Memory, 1_073_741_824);
		assert.equal(limits.MemorySwap, 1_073_741_824);
		assert.equal(limits.NanoCpus, 1_000_000_000);
		const url = new URL(`http://127.0.0.1:${mapped}/`);
		await until(async () => {
			const response = await fetch(new URL("/healthz", url)).catch(() => undefined);
			if (!response) return false;
			assert.deepEqual(await response.json(), { status: "ok", build: "0".repeat(40) });
			return true;
		});
		await run({ name, url, token, fixture, credentialId, logs: () => docker("logs", name) });
		console.log(
			JSON.stringify({
				image: inspected.Id,
				architecture: "amd64",
				memory_limit: 1_073_741_824,
				cpu_limit: 1,
				fixture_only: true,
			}),
		);
	} finally {
		const logs = await docker("logs", name).catch(() => "");
		await docker("rm", "--force", name).catch(() => undefined);
		await fixture.close();
		await rm(directory, { recursive: true, force: true });
		// Preserve count-only fixture evidence and enforce sentinel exclusion.
		assert.equal(logs.includes("Public container source sentinel."), false);
		assert.equal(logs.includes("synthetic-upstream-token"), false);
		assert.equal(logs.includes("synthetic-container-fixture-pepper-value"), false);
		assert.equal(logs.includes("lc_test_"), false);
	}
}

test("the amd64 service runs all three tools with HTTP/GCS fixtures and drains an active quote on SIGTERM", async () =>
	container(async ({ name, url, token, fixture, credentialId, logs }) => {
		const client = await connectPilot(url, token);
		try {
			const pending = runPilot(client, "410 U.S. 113", "Public container source sentinel.");
			await until(async () => (await logs()).includes("fixture_opinion_started"));
			const signalAt = performance.now();
			await docker("kill", "--signal", "SIGTERM", name);
			const result = await pending;
			assert.deepEqual(result.tools.tools.map(({ name }) => name).sort(), [
				"parse_citation",
				"verify_citation",
				"verify_quote",
			]);
			assert.equal(result.citation.structuredContent.outcome, "verified");
			assert.equal(result.quote.structuredContent.outcome, "verified");
			assert.equal(JSON.stringify(result).includes("Public container source sentinel."), false);
			assert.equal(await docker("wait", name), "0");
			assert.ok(performance.now() - signalAt < 10_000);
			const state = JSON.parse(await docker("inspect", name))[0].State;
			assert.equal(state.OOMKilled, false);
			const summary = (await logs())
				.split("\n")
				.find((line) => line.startsWith('{"fixture_closed"'));
			assert.ok(summary);
			const counts = JSON.parse(summary);
			assert.equal(counts.failures, 0);
			assert.ok(counts.object_requests >= 3);
			console.log(summary);
			assert.equal(
				(
					await fixture.publicPool.query(
						"SELECT 1 FROM lexcerta.upstream_attempts WHERE credential_id = $1 AND kind <> 'quota_sync'",
						[credentialId],
					)
				).rowCount,
				3,
			);
			assert.equal(
				(await fixture.publicPool.query("SELECT phase, generation FROM lexcerta.source_objects"))
					.rows[0].phase,
				"ready",
			);
		} finally {
			await client.close();
		}
	}));

test("SIGKILL preserves charged attempts and does not publish the interrupted opinion", async () =>
	container(async ({ name, url, token, fixture, credentialId, logs }) => {
		const client = await connectPilot(url, token);
		try {
			const rejected = assert.rejects(
				runPilot(client, "410 U.S. 113", "Public container source sentinel."),
			);
			await until(async () => (await logs()).includes("fixture_opinion_started"));
			assert.ok(
				Number(
					(
						await fixture.migration.query(
							"SELECT count(*) FROM pg_stat_activity WHERE usename = $1 AND application_name = 'lexcerta-container-public'",
							[fixture.publicRole],
						)
					).rows[0].count,
				) > 0,
				"the container must have real SQL connections before it is killed",
			);
			await docker("kill", "--signal", "SIGKILL", name);
			await rejected;
			assert.equal(await docker("wait", name), "137");
			assert.equal(JSON.parse(await docker("inspect", name))[0].State.OOMKilled, false);
			assert.equal(
				(
					await fixture.publicPool.query(
						"SELECT 1 FROM lexcerta.upstream_attempts WHERE credential_id = $1 AND kind <> 'quota_sync'",
						[credentialId],
					)
				).rowCount,
				3,
			);
			assert.equal(
				(
					await fixture.publicPool.query(
						"SELECT 1 FROM lexcerta.source_objects WHERE phase = 'ready'",
					)
				).rowCount,
				0,
			);
			await until(
				async () =>
					Number(
						(
							await fixture.migration.query(
								"SELECT count(*) FROM pg_stat_activity WHERE usename = $1 AND application_name = 'lexcerta-container-public'",
								[fixture.publicRole],
							)
						).rows[0].count,
					) === 0,
			);
		} finally {
			await client.close();
		}
	}));
