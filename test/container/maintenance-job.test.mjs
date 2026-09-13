import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPostgresFixture } from "../postgres/fixture.mjs";
import { createPostgresTlsFixture } from "../fixtures/postgres-tls-fixture.mjs";
import { docker, image, until, verifyImage } from "./runtime-fixture.mjs";

test("maintenance entrypoint fails safely without configuration or database connectivity", async () => {
	const configuration = [
		"LEXCERTA_ENVIRONMENT=staging",
		"GOOGLE_CLOUD_PROJECT=fixture-project",
		`LEXCERTA_BUILD_ID=${"0".repeat(40)}`,
		"LEXCERTA_DATABASE_HOST=ep-fixture-123.us-east-2.aws.neon.tech",
		"LEXCERTA_DATABASE_PASSWORD=synthetic-maintenance-fixture-password",
	];
	for (const env of [[], configuration])
		await assert.rejects(
			docker(
				"run",
				"--rm",
				"--platform",
				"linux/amd64",
				"--network",
				"none",
				"--memory",
				"512m",
				"--memory-swap",
				"512m",
				"--cpus",
				"1",
				"--read-only",
				...env.flatMap((value) => ["-e", value]),
				image,
				"node",
				"build/node/maintenance-main.js",
			),
			(error) => {
				assert.equal(error.code, 1);
				assert.equal(error.stdout, "");
				assert.equal(error.stderr, '{"event":"maintenance_startup_failed"}\n');
				return true;
			},
		);
});

test("packaged maintenance resumes a killed deletion through verified PostgreSQL TLS and the GCS wire adapter", async () => {
	const inspected = await verifyImage([
		"node/maintenance-main.js",
		"node/task-process.js",
		"node/neon-database.js",
		"node/gcs-source-objects.js",
		"node/runtime-config.js",
		"postgres/database.js",
		"postgres/maintenance.js",
		"postgres/maintenance-steps.js",
		"postgres/run-maintenance.js",
		"postgres/retention.js",
		"postgres/opinions.js",
	]);
	// Check the packaged schema too: the job image must agree with its progress cursor.
	const { readFile } = await import("node:fs/promises");
	assert.equal(
		await docker(
			"run",
			"--rm",
			"--network",
			"none",
			image,
			"cat",
			"database/migrations/0002_maintenance.sql",
		),
		(await readFile("database/migrations/0002_maintenance.sql", "utf8")).trim(),
	);
	const fixture = await createPostgresFixture();
	const directory = await mkdtemp(
		join(
			process.platform === "darwin" ? "/private/tmp" : tmpdir(),
			"lexcerta-maintenance-container-",
		),
	);
	const names = [];
	try {
		await chmod(directory, 0o755);
		await mkdir(join(directory, "container"));
		await mkdir(join(directory, "fixtures"));
		for (const file of [
			"container/maintenance-fixture.mjs",
			"fixtures/postgres-tls-fixture.mjs",
			"fixtures/gcs-wire-fixture.mjs",
		])
			await copyFile(`test/${file}`, join(directory, file));
		const wire = await createPostgresTlsFixture(fixture.jobConnection);
		try {
			const connection = new URL(fixture.jobConnection);
			connection.hostname = "host.docker.internal";
			await writeFile(
				join(directory, "container/maintenance-settings.json"),
				JSON.stringify({ connection: String(connection), certificate: wire.certificate }),
			);
		} finally {
			await wire.close();
		}
		async function start(mode) {
			const name = `lexcerta-maintenance-${randomUUID().slice(0, 8)}`;
			names.push(name);
			await docker(
				"run",
				"--detach",
				"--platform",
				"linux/amd64",
				"--name",
				name,
				"--memory",
				"512m",
				"--memory-swap",
				"512m",
				"--cpus",
				"1",
				"--pids-limit",
				"128",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,size=8m,mode=1777",
				"--add-host",
				"host.docker.internal:host-gateway",
				"--mount",
				`type=bind,source=${directory},target=/app/test,readonly`,
				image,
				"node",
				"test/container/maintenance-fixture.mjs",
				mode,
			);
			return name;
		}
		const killed = await start("pause-after-delete");
		await until(async () => (await docker("logs", killed)).includes('"fixture_deleted":true'));
		const checkpoint = (
			await fixture.migration.query(
				"SELECT * FROM lexcerta.maintenance_progress WHERE name = 'lifecycle'",
			)
		).rows[0];
		assert.equal(checkpoint.stage, "orphans");
		assert.equal(checkpoint.completed_at, null);
		assert.equal(
			(await fixture.migration.query("SELECT * FROM lexcerta.orphan_object_deletions")).rowCount,
			1,
		);
		await docker("kill", "--signal", "SIGKILL", killed);
		assert.equal(await docker("wait", killed), "137");
		await until(
			async () => !(await fixture.inspectActivity()).some((row) => row.usename === fixture.jobRole),
		);
		await fixture.migration.query(
			"UPDATE lexcerta.maintenance_owner SET lease_expires_at = clock_timestamp() - interval '1 second'",
		);
		const resumed = await start("resume");
		assert.equal(await docker("wait", resumed), "0");
		const result = JSON.parse(
			(await docker("logs", resumed))
				.split("\n")
				.find((line) => line.startsWith('{"event":"maintenance_finished"')),
		);
		assert.equal(result.outcome, "complete");
		assert.equal(result.lifecycle, 1);
		assert.equal(result.cleanup, 0);
		assert.equal(
			(await fixture.migration.query("SELECT * FROM lexcerta.orphan_object_deletions")).rowCount,
			0,
		);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT completed_for FROM lexcerta.maintenance_progress WHERE name = 'lifecycle'",
				)
			).rows[0].completed_for.getTime(),
			checkpoint.scheduled_for.getTime(),
		);
		const duplicate = await start("resume");
		assert.equal(await docker("wait", duplicate), "0");
		assert.ok((await docker("logs", duplicate)).includes('"outcome":"idle"'));
		const state = JSON.parse(await docker("inspect", resumed))[0];
		assert.equal(state.State.OOMKilled, false);
		assert.equal(state.HostConfig.Memory, 536870912);
		assert.equal(state.HostConfig.MemorySwap, 536870912);
		assert.equal(state.HostConfig.NanoCpus, 1000000000);
		const closed = JSON.parse(
			(await docker("logs", resumed))
				.split("\n")
				.find((line) => line.startsWith('{"fixture_closed"')),
		);
		assert.equal(closed.node, "v24.21.0");
		assert.equal(closed.arch, "x64");
		assert.equal(closed.uid, 1000);
		assert.equal(closed.delete_requests, 1);
		console.log(
			JSON.stringify({
				image: inspected.Id,
				fixture: "maintenance-recovery",
				fixture_only: true,
				memory_limit: state.HostConfig.Memory,
				cpu_limit: 1,
				...closed,
			}),
		);
	} finally {
		const outputs = [];
		for (const name of names) {
			outputs.push(await docker("logs", name).catch(() => ""));
			await docker("rm", "--force", name).catch(() => undefined);
		}
		await fixture.close();
		await rm(directory, { recursive: true, force: true });
		for (const secret of [
			"private-opinion-sentinel",
			"synthetic-neon-private-password",
			"synthetic-fixture-token",
			"PRIVATE KEY",
			"postgresql://",
		])
			assert.equal(outputs.join("\n").includes(secret), false);
	}
});
