import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWorkerDeploymentPlan } from "./deploy.mjs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

test("deploy fails closed before invoking the rejected Worker deployment", () => {
	const result = runDeployCommand();

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Cloud Run delivery in Issue #11/);
});

test("blocked deployment invokes no legacy Worker command", () => {
	withFakeWrangler((environment, logPath) => {
		const result = runDeployScript(environment);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /Cloud Run delivery in Issue #11/);
		assert.equal(existsSync(logPath), false);
	});
});

test("Worker deployment plan preserves the telemetry, migration, and public command order", () => {
	const plan = createWorkerDeploymentPlan([]);

	assert.deepEqual(plan.telemetryDeployment, [
		"deploy",
		"--config",
		"wrangler.telemetry.jsonc",
		"--env=",
	]);
	assert.deepEqual(plan.remoteMigration, [
		"d1",
		"migrations",
		"apply",
		"DB",
		"--remote",
		"--config",
		"wrangler.jsonc",
		"--env=",
	]);
	assert.deepEqual(plan.publicDeployment, ["deploy", "--env="]);
	assert.equal(plan.skipRemoteMigration, false);
});

test("Worker deployment plan skips remote migrations during a dry run", () => {
	const plan = createWorkerDeploymentPlan(["--env", "test", "--dry-run"]);

	assert.deepEqual(plan.telemetryDeployment, [
		"deploy",
		"--config",
		"wrangler.telemetry.jsonc",
		"--env",
		"test",
		"--dry-run",
	]);
	assert.deepEqual(plan.remoteMigration, [
		"d1",
		"migrations",
		"apply",
		"DB",
		"--remote",
		"--config",
		"wrangler.jsonc",
		"--env",
		"test",
	]);
	assert.deepEqual(plan.publicDeployment, ["deploy", "--env", "test", "--dry-run"]);
	assert.equal(plan.skipRemoteMigration, true);
});

function runDeployCommand(...argumentsToForward) {
	return spawnSync(npmCommand, ["run", "deploy", "--", ...argumentsToForward], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
		stdio: "pipe",
	});
}

function runDeployScript(environment, ...argumentsToForward) {
	return spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./deploy.mjs", import.meta.url)), ...argumentsToForward],
		{
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
			env: environment,
			stdio: "pipe",
		},
	);
}

function withFakeWrangler(callback) {
	const root = mkdtempSync(join(tmpdir(), "lexcerta-deploy-"));
	const bin = join(root, "bin");
	const logPath = join(root, "commands.log");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "wrangler"),
		`#!/bin/sh\nprintf deploy >> "$LEXCERTA_FAKE_WRANGLER_LOG"\n`,
	);
	chmodSync(join(bin, "wrangler"), 0o755);
	try {
		callback(
			{
				...process.env,
				LEXCERTA_FAKE_WRANGLER_LOG: logPath,
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
			},
			logPath,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
