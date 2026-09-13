import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readJobConfig } from "../../build/node/runtime-config.js";

async function child(mode, run) {
	const worker = spawn(
		process.execPath,
		[new URL("maintenance-process-fixture.mjs", import.meta.url).pathname, mode],
		{ env: { PATH: process.env.PATH } },
	);
	let stdout = "";
	let stderr = "";
	worker.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	worker.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = once(worker, "exit");
	try {
		await run({ worker, exited, stdout: () => stdout, stderr: () => stderr });
	} finally {
		if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
		await exited;
	}
}
async function until(predicate) {
	const deadline = performance.now() + 3000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, "job process did not reach the expected stage");
		await delay(20);
	}
}

test("maintenance configuration needs only its database identity and source bucket context", () => {
	const env = {
		LEXCERTA_ENVIRONMENT: "staging",
		GOOGLE_CLOUD_PROJECT: "fixture-project",
		LEXCERTA_BUILD_ID: "0".repeat(40),
		LEXCERTA_DATABASE_HOST: "ep-fixture-123.us-east-2.aws.neon.tech",
		LEXCERTA_DATABASE_PASSWORD: "synthetic-neon-fixture-password-32",
	};
	const config = readJobConfig(env);
	assert.equal(config.sourceBucket, "fixture-project-lexcerta-sources");
	assert.deepEqual(Object.keys(config).sort(), [
		"build",
		"database",
		"environment",
		"project",
		"sourceBucket",
	]);
	for (const name of Object.keys(env))
		assert.throws(() => readJobConfig({ ...env, [name]: undefined }), {
			message: "Maintenance configuration is missing or invalid",
		});
});

for (const outcome of ["complete", "partial", "busy", "idle"]) {
	test(`maintenance ${outcome} emits bounded progress and closes its resources`, async () =>
		child(outcome, async ({ exited, stdout, stderr }) => {
			assert.deepEqual(await exited, [outcome === "partial" ? 1 : 0, null]);
			const [event, closed] = stdout().trim().split("\n");
			assert.equal(closed, "storage-closed");
			const result = JSON.parse(event);
			assert.equal(result.event, "maintenance_finished");
			assert.equal(result.outcome, outcome);
			assert.equal(result.changed, 12);
			assert.deepEqual(Object.keys(result).sort(), [
				"batches",
				"changed",
				"cleanup",
				"event",
				"health",
				"lifecycle",
				"outcome",
			]);
			assert.equal(stderr(), "");
		}));
}

for (const mode of ["startup-failure", "run-failure", "health-failure", "unhandled", "uncaught"]) {
	test(`maintenance ${mode} fails with a constant event and no provider details`, async () =>
		child(mode, async ({ exited, stdout, stderr }) => {
			assert.deepEqual(await exited, [1, null]);
			assert.equal(
				stderr(),
				`${JSON.stringify({ event: mode === "startup-failure" ? "maintenance_startup_failed" : "maintenance_failed" })}\n`,
			);
			assert.equal(stdout().includes("maintenance_finished"), false);
			assert.equal((stdout() + stderr()).includes("sentinel"), false);
		}));
}

for (const mode of ["startup-abort", "late-startup", "running-abort", "late-completion"]) {
	test(`SIGTERM during ${mode} cannot report job completion`, async () =>
		child(mode, async ({ worker, exited, stdout, stderr }) => {
			await until(() => stdout().includes(mode.includes("startup") ? "initializing" : "running"));
			worker.kill("SIGTERM");
			assert.deepEqual(await exited, [1, null]);
			assert.equal(stdout().includes("maintenance_finished"), false);
			assert.equal(stdout().includes("storage-closed"), mode !== "startup-abort");
			assert.equal((stdout() + stderr()).includes("sentinel"), false);
		}));
}

test(
	"a hung close exits unsuccessfully within the shutdown backstop",
	{ timeout: 15000 },
	async () =>
		child("close-hangs", async ({ exited, stdout }) => {
			const started = performance.now();
			assert.deepEqual(await exited, [1, null]);
			assert.ok(performance.now() - started < 12000);
			assert.ok(stdout().includes("storage-closed"));
		}),
);
