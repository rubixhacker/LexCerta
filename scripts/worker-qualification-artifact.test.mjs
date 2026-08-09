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
import { captureHeapUsageSample } from "./worker-qualification-heap.mjs";

test("passes exact resource limits and fails either exceeded core-entry measurement", () => {
	const atLimit = evaluateResourceGates([
		{
			...heapMeasurement(RESOURCE_GATES.coreEntryPeakBytes),
			cdpPeakObservedHeapBytes: RESOURCE_GATES.coreEntryPeakBytes,
			cdpSampledCpuMilliseconds: RESOURCE_GATES.coreEntrySampledCpuMilliseconds,
			scenario: "at_limit",
			wallMilliseconds: RESOURCE_GATES.coreEntryWallMilliseconds,
		},
	]);
	const overLimit = evaluateResourceGates([
		{
			...heapMeasurement(RESOURCE_GATES.coreEntryPeakBytes + 1),
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

test("fails empty, invalid, or mismatched raw heap observations", () => {
	// Given: measurements whose reported peak is not backed by valid raw CDP samples.
	const invalidSample = captureHeapUsageSample({
		backingStorageSize: 0,
		embedderHeapUsedSize: 0,
		totalSize: Number.NaN,
		usedSize: 0,
	});
	const invalidMeasurements = [
		{ ...resourceMeasurement(), cdpHeapUsageSamples: [] },
		{ ...resourceMeasurement(), cdpHeapUsageSamples: [invalidSample] },
		{
			...resourceMeasurement(),
			cdpPeakObservedHeap: {
				...rawHeapFields(heapMeasurement(1).cdpHeapUsageSamples[0]),
				totalSize: 2,
			},
		},
	];

	// When: each measurement is evaluated against the 128 MiB memory gate.
	const results = invalidMeasurements.map((measurement) => evaluateResourceGates([measurement]));

	// Then: no absent, nonfinite, or tampered observation can pass qualification.
	for (const result of results) {
		assert.equal(result.verdict, "fail");
		assert.equal(result.scenarios[0]?.coreEntryPeakBytes.verdict, "fail");
	}
});

test("fails a missing or nonfinite core-entry measurement", () => {
	for (const observed of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = evaluateResourceGates([
			{
				...heapMeasurement(1),
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

function resourceMeasurement() {
	return {
		...heapMeasurement(1),
		cdpSampledCpuMilliseconds: 1,
		scenario: "valid",
		wallMilliseconds: 1,
	};
}

function heapMeasurement(totalSize) {
	const sample = captureHeapUsageSample({
		backingStorageSize: 0,
		embedderHeapUsedSize: 0,
		totalSize,
		usedSize: 0,
	});
	return {
		cdpHeapUsageSamples: [sample],
		cdpPeakObservedHeap: rawHeapFields(sample),
		cdpPeakObservedHeapBytes: sample.conservativeIsolateBytes,
	};
}

function rawHeapFields(sample) {
	const { backingStorageSize, embedderHeapUsedSize, totalSize, usedSize } = sample;
	return { backingStorageSize, embedderHeapUsedSize, totalSize, usedSize };
}
