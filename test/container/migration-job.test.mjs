import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPostgresTlsFixture } from "../fixtures/postgres-tls-fixture.mjs";
import { createPostgresFixture } from "../postgres/fixture.mjs";
import { docker, image, until, verifyImage } from "./runtime-fixture.mjs";

test("migration entrypoint rejects missing configuration, unavailable database and arbitrary arguments", async () => {
	const config = [
		"LEXCERTA_ENVIRONMENT=staging",
		`LEXCERTA_BUILD_ID=${"0".repeat(40)}`,
		"LEXCERTA_DATABASE_HOST=ep-fixture-123.us-east-2.aws.neon.tech",
		"LEXCERTA_DATABASE_PASSWORD=synthetic-migration-fixture-password",
	];
	for (const [env, args] of [
		[[], []],
		[config, []],
		[config, ["private-argument-sentinel"]],
	])
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
				"build/node/migration-main.js",
				...args,
			),
			(error) => {
				assert.equal(error.code, 1);
				assert.equal(error.stdout, "");
				assert.equal(error.stderr, '{"event":"migration_startup_failed"}\n');
				return true;
			},
		);
});

test("packaged migrator creates the schema and grants over TLS, repeats safely and rolls back interrupted DDL", async () => {
	const inspected = await verifyImage([
		"node/migration-main.js",
		"node/task-process.js",
		"node/neon-database.js",
		"node/runtime-config.js",
		"postgres/migrations.js",
		"postgres/migration-connection.js",
		"postgres/roles.js",
	]);
	for (const file of [
		"0001_authority.sql",
		"0002_maintenance.sql",
		"0003_source_removal.sql",
		"0004_recovery_replay.sql",
	])
		assert.equal(
			await docker("run", "--rm", "--network", "none", image, "cat", `database/migrations/${file}`),
			(await readFile(`database/migrations/${file}`, "utf8")).trim(),
		);
	const fixture = await createPostgresFixture({ initializeSchema: false });
	const directory = await mkdtemp(
		join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "lexcerta-migrator-container-"),
	);
	const names = [];
	try {
		await chmod(directory, 0o755);
		await mkdir(join(directory, "container"));
		await mkdir(join(directory, "fixtures"));
		for (const file of ["container/migration-fixture.mjs", "fixtures/postgres-tls-fixture.mjs"])
			await copyFile(`test/${file}`, join(directory, file));
		const wire = await createPostgresTlsFixture(fixture.migrationConnection);
		try {
			const connection = new URL(fixture.migrationConnection);
			connection.hostname = "host.docker.internal";
			await writeFile(
				join(directory, "container/migration-settings.json"),
				JSON.stringify({
					connection: String(connection),
					certificate: wire.certificate,
					roles: fixture.roleNames,
				}),
			);
		} finally {
			await wire.close();
		}
		async function start(mode) {
			// The migrator has one database connection across all processes. Let
			// fixture-only observation connections finish before starting a job.
			await until(
				async () =>
					!(await fixture.inspectActivity()).some((row) => row.usename === fixture.migrationRole),
			);
			const name = `lexcerta-migrator-${randomUUID().slice(0, 8)}`;
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
				"test/container/migration-fixture.mjs",
				mode,
			);
			return name;
		}
		for (const applied of [4, 0]) {
			const name = await start("migrate");
			assert.equal(await docker("wait", name), "0");
			assert.ok(
				(await docker("logs", name)).includes(
					JSON.stringify({ event: "migration_finished", applied }),
				),
			);
			assert.equal(JSON.parse(await docker("inspect", name))[0].State.OOMKilled, false);
		}
		await fixture.publicPool.query("SELECT * FROM lexcerta.api_keys");
		await assert.rejects(
			fixture.publicPool.query("UPDATE lexcerta.upstream_budgets SET enabled = true"),
			{ code: "42501" },
		);
		await assert.rejects(
			fixture.adminPool.query(
				"UPDATE lexcerta.admin_audit_events SET actor_subject = 'unauthorized'",
			),
			{ code: "42501" },
		);
		const interrupted = await start("slow-ddl");
		await until(async () =>
			(await fixture.inspectActivity()).some(
				(row) =>
					row.usename === fixture.migrationRole &&
					row.application_name === "lexcerta-migrator" &&
					row.wait_event === "PgSleep",
			),
		);
		const signalAt = performance.now();
		await docker("kill", "--signal", "SIGTERM", interrupted);
		assert.equal(await docker("wait", interrupted), "1");
		assert.ok(performance.now() - signalAt < 10000);
		await until(
			async () =>
				!(await fixture.inspectActivity()).some(
					(row) =>
						row.usename === fixture.migrationRole && row.application_name === "lexcerta-migrator",
				),
		);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT to_regclass('lexcerta.cancelled_container_migration') AS relation",
				)
			).rows[0].relation,
			null,
		);
		assert.equal(
			(await fixture.migration.query("SELECT * FROM public.lexcerta_migrations")).rowCount,
			4,
		);
		const retry = await start("migrate");
		assert.equal(await docker("wait", retry), "0");
		assert.ok((await docker("logs", retry)).includes('{"event":"migration_finished","applied":0}'));
		const state = JSON.parse(await docker("inspect", retry))[0];
		assert.equal(state.HostConfig.Memory, 536870912);
		assert.equal(state.HostConfig.MemorySwap, 536870912);
		assert.equal(state.HostConfig.NanoCpus, 1000000000);
		const closed = JSON.parse(
			(await docker("logs", retry))
				.split("\n")
				.find((line) => line.startsWith('{"fixture_closed"')),
		);
		assert.equal(closed.node, "v24.21.0");
		assert.equal(closed.arch, "x64");
		assert.equal(closed.uid, 1000);
		console.log(
			JSON.stringify({
				image: inspected.Id,
				fixture: "migration-lifecycle",
				fixture_only: true,
				memory_limit: state.HostConfig.Memory,
				cpu_limit: 1,
				...closed,
			}),
		);
	} finally {
		const logs = [];
		for (const name of names) {
			logs.push(await docker("logs", name).catch(() => ""));
			await docker("rm", "--force", name).catch(() => undefined);
		}
		await fixture.close();
		await rm(directory, { recursive: true, force: true });
		for (const secret of [
			"synthetic-neon-private-password",
			"PRIVATE KEY",
			"postgresql://",
			"local-fixture-only",
			"private-argument-sentinel",
		])
			assert.equal(logs.join("\n").includes(secret), false);
	}
});
