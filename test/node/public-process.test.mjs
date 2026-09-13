import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function until(condition) {
	const deadline = performance.now() + 3000;
	while (!(await condition())) {
		assert.ok(performance.now() < deadline, "child process did not reach the expected stage");
		await delay(20);
	}
}

async function child(mode, run, port) {
	const process = spawn(
		globalThis.process.execPath,
		[new URL("public-process-fixture.mjs", import.meta.url).pathname, mode],
		{ env: { PATH: globalThis.process.env.PATH, ...(port ? { PORT: String(port) } : {}) } },
	);
	let stdout = "";
	let stderr = "";
	process.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	process.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = once(process, "exit");
	try {
		await run({ process, exited, stdout: () => stdout, stderr: () => stderr });
	} finally {
		if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
		await exited;
	}
}

for (const mode of ["startup-abort", "late-startup"]) {
	test(`SIGTERM cancels ${mode} and cleans up any resources that arrive later`, async () =>
		child(mode, async ({ process, exited, stdout, stderr }) => {
			await until(() => stdout().includes("initializing"));
			process.kill("SIGTERM");
			assert.deepEqual(await exited, [0, null]);
			assert.ok(stdout().includes("initialization-cancelled"));
			assert.equal(stdout().includes("storage-closed"), mode === "late-startup");
			assert.equal(stderr(), "");
		}));
}

test("process startup failure emits a constant event and exits unsuccessfully", async () =>
	child("failure", async ({ exited, stdout, stderr }) => {
		assert.deepEqual(await exited, [1, null]);
		assert.equal(stdout(), "");
		assert.equal(stderr(), '{"event":"startup_failed"}\n');
	}));

for (const mode of ["unhandled", "uncaught"]) {
	test(`${mode} process failures emit a constant event and exit without resuming service`, async () =>
		child(mode, async ({ exited, stdout, stderr }) => {
			assert.deepEqual(await exited, [1, null]);
			assert.equal(stdout(), "");
			assert.equal(stderr(), '{"event":"process_failed"}\n');
		}));
}

test("an occupied listening port closes initialized resources and exits unsuccessfully", async () => {
	const occupied = createServer();
	occupied.listen(0, "0.0.0.0");
	await once(occupied, "listening");
	try {
		await child(
			"service",
			async ({ exited, stdout, stderr }) => {
				assert.deepEqual(await exited, [1, null]);
				assert.equal(stdout(), "storage-closed\n");
				assert.equal(stderr(), "");
			},
			occupied.address().port,
		);
	} finally {
		await new Promise((resolve) => occupied.close(resolve));
	}
});

test("a listening service answers health and closes its resources on SIGTERM", async () => {
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const port = reservation.address().port;
	await new Promise((resolve) => reservation.close(resolve));
	await child(
		"service",
		async ({ process, exited, stdout, stderr }) => {
			let health;
			await until(async () => {
				health = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
				return health?.status === 200;
			});
			assert.deepEqual(await health.json(), { status: "ok", build: "0".repeat(40) });
			process.kill("SIGTERM");
			assert.deepEqual(await exited, [0, null]);
			assert.equal(stdout(), "storage-closed\n");
			assert.equal(stderr(), "");
		},
		port,
	);
});
