import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

test("deploy dry-run forwards the top-level environment to both Workers", () => {
	const output = runDeploy("--dry-run");

	assert.equal(dryRunCount(output), 2);
	assert.match(output, /env\.TELEMETRY_TRACES \(lexcerta-telemetry-traces\)/);
});

test("deploy dry-run forwards an explicit test environment to both Workers", () => {
	const output = runDeploy("--env", "test", "--dry-run");

	assert.equal(dryRunCount(output), 2);
	assert.match(output, /env\.TELEMETRY_TRACES \(lexcerta-telemetry-traces-test\)/);
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
