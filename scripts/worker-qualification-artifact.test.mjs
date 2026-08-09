import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateResourceGates, qualifyWorkerArtifact } from "./worker-qualification-artifact.mjs";
import { captureHeapUsageSample } from "./worker-qualification-heap.mjs";

const APPROVED_RUNNER_PEAK_BYTES = 128 * 1024 * 1024;
const APPROVED_RUNNER_SAMPLED_CPU_MILLISECONDS = 5_000;
const APPROVED_RUNNER_WALL_MILLISECONDS = 5_000;

test("passes exact resource limits and fails an exceeded runner measurement", () => {
	const atLimit = evaluateResourceGates(
		qualificationMeasurements().map((measurement) => ({
			...measurement,
			...heapMeasurement(APPROVED_RUNNER_PEAK_BYTES),
			cdpPeakObservedHeapBytes: APPROVED_RUNNER_PEAK_BYTES,
			cdpSampledCpuMilliseconds: APPROVED_RUNNER_SAMPLED_CPU_MILLISECONDS,
			wallMilliseconds: APPROVED_RUNNER_WALL_MILLISECONDS,
		})),
	);
	const overLimit = evaluateResourceGates(
		qualificationMeasurements().map((measurement) => ({
			...measurement,
			...heapMeasurement(APPROVED_RUNNER_PEAK_BYTES + 1),
			cdpPeakObservedHeapBytes: APPROVED_RUNNER_PEAK_BYTES + 1,
			cdpSampledCpuMilliseconds: APPROVED_RUNNER_SAMPLED_CPU_MILLISECONDS + 1,
			wallMilliseconds: APPROVED_RUNNER_WALL_MILLISECONDS + 1,
		})),
	);
	assert.equal(atLimit.verdict, "pass");
	assert.equal(overLimit.verdict, "fail");
	assert.equal(overLimit.scenarios[0]?.runnerPeakBytes.verdict, "fail");
	assert.equal(overLimit.scenarios[0]?.runnerSampledCpuMilliseconds.verdict, "fail");
	assert.equal(overLimit.scenarios[0]?.runnerWallMilliseconds.verdict, "fail");
});

test("fails a weakened maximum-workload benchmark record", () => {
	for (const field of [
		"codePoints",
		"opinionOutboundCount",
		"totalOutboundCount",
		"d1StateRows",
		"r2ObjectCount",
		"cancelledOutboundCount",
	]) {
		const measurements = qualificationMeasurements();
		measurements[0][field] = field === "cancelledOutboundCount" ? 1 : 9_999;
		const result = evaluateResourceGates(measurements);
		assert.equal(result.verdict, "fail", field);
		assert.equal(result.scenarios[0]?.workloadSemantics.verdict, "fail", field);
	}
});

test("fails a missing or duplicated canonical workload scenario", () => {
	const measurements = qualificationMeasurements();
	assert.equal(evaluateResourceGates(measurements.slice(0, 2)).verdict, "fail");
	assert.equal(
		evaluateResourceGates([...measurements.slice(0, 2), measurements[0]]).verdict,
		"fail",
	);
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
		assert.equal(result.scenarios[0]?.runnerPeakBytes.verdict, "fail");
	}
});

test("fails a missing or nonfinite runner measurement", () => {
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
		assert.equal(result.scenarios[0]?.runnerPeakBytes.observed, null);
	}
});

test("fails a measurement from the wrong target or without non-idle CPU samples", () => {
	// Given: otherwise valid resource measurements with an invalid target identity or idle-only CPU profile.
	const invalidMeasurements = [
		{ ...resourceMeasurement(), cdpMeasurementTargetId: "core:entry", cdpNonIdleCpuSampleCount: 1 },
		{
			...resourceMeasurement(),
			cdpMeasurementTargetId: "core:user:vitest-pool-workers-runner-",
			cdpNonIdleCpuSampleCount: 0,
		},
	];

	// When: the Worker resource qualification gate evaluates the measurements.
	const results = invalidMeasurements.map((measurement) => evaluateResourceGates([measurement]));

	// Then: only an exact runner profile containing useful CPU samples can qualify.
	for (const result of results) assert.equal(result.verdict, "fail");
});

test("fails when no runner measurement is emitted", () => {
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
		cdpControlTargetId: "core:entry",
		cdpMeasurementTargetId: "core:user:vitest-pool-workers-runner-",
		cdpNonIdleCpuSampleCount: 1,
		cdpSampledCpuMilliseconds: 1,
		scenario: "valid",
		wallMilliseconds: 1,
	};
}

function qualificationMeasurements() {
	return [
		qualificationMeasurement("cold_no_match_10000cp_100op", "not_found", 100, 103),
		qualificationMeasurement("cold_late_match_10000cp_100op", "verified", 100, 103),
		qualificationMeasurement("warm_reuse_late_match_10000cp_100op", "verified", 0, 1),
	];
}

function qualificationMeasurement(scenario, behavior, opinionOutboundCount, totalOutboundCount) {
	return {
		...resourceMeasurement(),
		behavior,
		codePoints: 10_000,
		d1StateRows: 100,
		opinionOutboundCount,
		r2ObjectCount: 100,
		scenario,
		totalOutboundCount,
		cancelledOutboundCount: 0,
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
