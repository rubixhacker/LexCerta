import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPostgresFixture } from "../postgres/fixture.mjs";
import { createPostgresTlsFixture } from "../fixtures/postgres-tls-fixture.mjs";
import { docker, image, verifyImage } from "./runtime-fixture.mjs";

test("the amd64 image verifies PostgreSQL TLS, delayed reconnect and idle shutdown at 512 MiB", async () => {
	const inspected = await verifyImage([
		"node/neon-database.js",
		"node/runtime-config.js",
		"postgres/database.js",
	]);
	const fixture = await createPostgresFixture();
	const name = `lexcerta-neon-${randomUUID().slice(0, 8)}`;
	const directory = await mkdtemp(
		join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "lexcerta-neon-container-"),
	);
	try {
		await chmod(directory, 0o755);
		await mkdir(join(directory, "container"));
		await mkdir(join(directory, "fixtures"));
		await copyFile(
			"test/container/neon-fixture.mjs",
			join(directory, "container/neon-fixture.mjs"),
		);
		await copyFile(
			"test/fixtures/postgres-tls-fixture.mjs",
			join(directory, "fixtures/postgres-tls-fixture.mjs"),
		);
		const wire = await createPostgresTlsFixture(fixture.publicConnection);
		try {
			const connection = new URL(fixture.publicConnection);
			connection.hostname = "host.docker.internal";
			await writeFile(
				join(directory, "container/neon-settings.json"),
				JSON.stringify({ connection: String(connection), certificate: wire.certificate }),
			);
		} finally {
			await wire.close();
		}
		await docker(
			"create",
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
			"test/container/neon-fixture.mjs",
		);
		const limits = JSON.parse(await docker("inspect", name))[0].HostConfig;
		assert.equal(limits.Memory, 536_870_912);
		assert.equal(limits.MemorySwap, 536_870_912);
		assert.equal(limits.NanoCpus, 1_000_000_000);
		const output = await docker("start", "--attach", name);
		const state = JSON.parse(await docker("inspect", name))[0].State;
		assert.equal(state.ExitCode, 0);
		assert.equal(state.OOMKilled, false);
		const result = JSON.parse(output);
		assert.equal(result.node, "v24.21.0");
		assert.equal(result.arch, "x64");
		assert.equal(result.uid, 1000);
		assert.equal(result.checks, 5);
		console.log(
			JSON.stringify({
				image: inspected.Id,
				...result,
				memory_limit: limits.Memory,
				cpu_limit: 1,
				fixture_only: true,
			}),
		);
	} finally {
		const logs = await docker("logs", name).catch(() => "");
		await docker("rm", "--force", name).catch(() => undefined);
		await fixture.close();
		await rm(directory, { recursive: true, force: true });
		for (const secret of [
			"local-fixture-only",
			"synthetic-neon-private-password",
			"PRIVATE KEY",
			"postgresql://",
		])
			assert.equal(logs.includes(secret), false);
	}
});
