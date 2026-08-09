import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	RESOURCE_GATES,
	evaluateResourceGates,
	qualifyWorkerArtifact,
} from "./worker-qualification-artifact.mjs";

test("passes exact resource limits and fails either exceeded core-entry measurement", () => {
	const atLimit = evaluateResourceGates([
		{
			cdpPeakObservedHeapBytes: RESOURCE_GATES.coreEntryPeakBytes,
			cdpSampledCpuMilliseconds: RESOURCE_GATES.coreEntrySampledCpuMilliseconds,
			scenario: "at_limit",
			wallMilliseconds: RESOURCE_GATES.coreEntryWallMilliseconds,
		},
	]);
	const overLimit = evaluateResourceGates([
		{
			cdpPeakObservedHeapBytes: RESOURCE_GATES.coreEntryPeakBytes + 1,
			cdpSampledCpuMilliseconds: RESOURCE_GATES.coreEntrySampledCpuMilliseconds + 1,
			scenario: "over_limit",
			wallMilliseconds: RESOURCE_GATES.coreEntryWallMilliseconds + 1,
		},
	]);
	assert.equal(atLimit.verdict, "pass");
	assert.equal(overLimit.verdict, "fail");
	assert.equal(overLimit.scenarios[0]?.coreEntryPeakBytes.verdict, "fail");
	assert.equal(overLimit.scenarios[0]?.coreEntrySampledCpuMilliseconds.verdict, "fail");
	assert.equal(overLimit.scenarios[0]?.coreEntryWallMilliseconds.verdict, "fail");
});

test("fails a missing or nonfinite core-entry measurement", () => {
	for (const observed of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = evaluateResourceGates([
			{
				cdpPeakObservedHeapBytes: observed,
				cdpSampledCpuMilliseconds: observed,
				scenario: "invalid",
				wallMilliseconds: observed,
			},
		]);
		assert.equal(result.verdict, "fail");
		assert.equal(result.scenarios[0]?.coreEntryPeakBytes.observed, null);
	}
});

test("fails when no core-entry measurement is emitted", () => {
	assert.equal(evaluateResourceGates([]).verdict, "fail");
});

test("refuses a stale artifact directory before running Wrangler", () => {
	const directory = mkdtempSync(join(tmpdir(), "lexcerta-artifact-"));
	try {
		writeFileSync(join(directory, "stale"), "evidence\n");
		assert.throws(
			() => qualifyWorkerArtifact(process.cwd(), directory),
			/non-empty artifact directory/,
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("refuses tracked or index divergence before emitting a bundle", () => {
	const repository = mkdtempSync(join(tmpdir(), "lexcerta-artifact-"));
	try {
		writeFileSync(join(repository, "tracked.txt"), "baseline\n");
		mkdirSync(join(repository, "artifact"));
		runGit(repository, ["init", "--quiet"]);
		runGit(repository, ["config", "user.email", "qualification@example.invalid"]);
		runGit(repository, ["config", "user.name", "Qualification"]);
		runGit(repository, ["add", "."]);
		runGit(repository, ["commit", "--quiet", "-m", "baseline"]);
		appendFileSync(join(repository, "tracked.txt"), "dirty\n");
		assert.throws(
			() => qualifyWorkerArtifact(repository, join(repository, "artifact")),
			/tracked files differ from HEAD/,
		);
	} finally {
		rmSync(repository, { force: true, recursive: true });
	}
});

function runGit(cwd, args) {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}
