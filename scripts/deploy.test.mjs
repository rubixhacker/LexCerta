import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

test("deploy dry-run forwards the top-level environment to both Workers", () => {
	const output = runDeploy("--dry-run");

	assert.equal(dryRunCount(output), 2);
	assert.match(output, /env\.TELEMETRY_TRACES \(lexcerta-telemetry-traces\)/);
	assert.match(output, /Skipping remote D1 migrations during --dry-run\./);
});

test("deploy dry-run forwards an explicit test environment to both Workers", () => {
	const output = runDeploy("--env", "test", "--dry-run");

	assert.equal(dryRunCount(output), 2);
	assert.match(output, /env\.TELEMETRY_TRACES \(lexcerta-telemetry-traces-test\)/);
	assert.match(output, /Skipping remote D1 migrations during --dry-run\./);
});

test("deploys trace, remote migrations, and public Worker in order", () => {
	withFakeWrangler((environment, logPath) => {
		const result = runDeployScript(environment);

		assert.equal(result.status, 0);
		assert.deepEqual(readCommands(logPath), [
			["deploy", "--config", "wrangler.telemetry.jsonc", "--env="],
			["d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.jsonc", "--env="],
			["deploy", "--env="],
		]);
	});
});

test("stops before public deployment when remote migrations fail", () => {
	withFakeWrangler((environment, logPath) => {
		const result = runDeployScript(
			{ ...environment, WRANGLER_FAIL_COMMAND: "d1" },
			"--env",
			"test",
		);

		assert.equal(result.status, 23);
		assert.deepEqual(readCommands(logPath), [
			["deploy", "--config", "wrangler.telemetry.jsonc", "--env", "test"],
			[
				"d1",
				"migrations",
				"apply",
				"DB",
				"--remote",
				"--config",
				"wrangler.jsonc",
				"--env",
				"test",
			],
		]);
	});
});

function runDeploy(...argumentsToForward) {
	return execFileSync(npmCommand, ["run", "deploy", "--", ...argumentsToForward], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
	});
}

function dryRunCount(output) {
	return output.match(/--dry-run: exiting now\./g)?.length ?? 0;
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
	const bin = join(root, "node_modules", ".bin");
	const logPath = join(root, "commands.jsonl");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "fake-wrangler.cjs"), FAKE_WRANGLER);
	writeFileSync(
		join(bin, "wrangler"),
		'#!/bin/sh\nexec node "$(dirname "$0")/fake-wrangler.cjs" "$@"\n',
	);
	chmodSync(join(bin, "wrangler"), 0o755);
	writeFileSync(join(bin, "wrangler.cmd"), '@echo off\r\nnode "%~dp0fake-wrangler.cjs" %*\r\n');
	try {
		callback(
			{
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				WRANGLER_LOG: logPath,
			},
			logPath,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

function readCommands(logPath) {
	return readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

const FAKE_WRANGLER = `const { appendFileSync } = require("node:fs");
const argumentsForWrangler = process.argv.slice(2);
appendFileSync(process.env.WRANGLER_LOG, JSON.stringify(argumentsForWrangler) + "\\n");
if (argumentsForWrangler[0] === process.env.WRANGLER_FAIL_COMMAND) process.exit(23);
`;
