import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { peakHeapUsageSample } from "./worker-qualification-heap.mjs";
import { CONTROL_TARGET_ID, RUNNER_TARGET_ID } from "./worker-qualification-runner.mjs";

export const RESOURCE_GATES = {
	runnerPeakBytes: 128 * 1024 * 1024,
	runnerSampledCpuMilliseconds: 5_000,
	runnerWallMilliseconds: 5_000,
};

export const WORKLOAD_GATES = {
	codePoints: 10_000,
	scenarios: {
		cold_no_match_10000cp_100op: {
			behavior: "not_found",
			opinionOutboundCount: 100,
			totalOutboundCount: 103,
			d1StateRows: 100,
			r2ObjectCount: 100,
			cancelledOutboundCount: 0,
		},
		cold_late_match_10000cp_100op: {
			behavior: "verified",
			opinionOutboundCount: 100,
			totalOutboundCount: 103,
			d1StateRows: 100,
			r2ObjectCount: 100,
			cancelledOutboundCount: 0,
		},
		warm_reuse_late_match_10000cp_100op: {
			behavior: "verified",
			opinionOutboundCount: 0,
			totalOutboundCount: 1,
			d1StateRows: 100,
			r2ObjectCount: 100,
			cancelledOutboundCount: 0,
		},
	},
};

export function qualifyWorkerArtifact(root, artifactDirectory) {
	if (readdirSync(artifactDirectory).length > 0)
		throw new TypeError(
			`refusing to overwrite a non-empty artifact directory: ${artifactDirectory}`,
		);
	requireTrackedWorktreeAtHead(root);
	const outputDirectory = join(artifactDirectory, "bundle");
	mkdirSync(outputDirectory, { recursive: true });
	execFileSync(
		"./node_modules/.bin/wrangler",
		["deploy", "--dry-run", "--env=", "--outdir", outputDirectory],
		{ cwd: root, stdio: "pipe" },
	);
	const bundlePath = files(outputDirectory).find((file) => file.endsWith(".js"));
	if (bundlePath === undefined)
		throw new TypeError("Wrangler did not emit a JavaScript Worker bundle");
	const qualification = {
		bundle: {
			bytes: statSync(bundlePath).size,
			path: relative(artifactDirectory, bundlePath),
			sha256: sha256(readFileSync(bundlePath)),
		},
		build: {
			commit: output("git", ["rev-parse", "HEAD"], root),
			configurationSha256: sha256(readFileSync(join(root, "wrangler.jsonc"))),
			lockfileSha256: sha256(readFileSync(join(root, "package-lock.json"))),
		},
	};
	const manifestPath = join(artifactDirectory, "qualification-manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(qualification, null, 2)}\n`);
	return {
		...qualification,
		manifestPath: relative(artifactDirectory, manifestPath),
		manifestSha256: sha256(readFileSync(manifestPath)),
	};
}

export function evaluateResourceGates(measurements) {
	const workloadScenarioSet = workloadScenarioSetVerdict(measurements);
	const scenarios = measurements.map((measurement) => ({
		cdpNonIdleCpuSamples: positive(measurement.cdpNonIdleCpuSampleCount),
		cdpTargetIdentity: targetIdentity(measurement),
		runnerPeakBytes: heapUsageVerdict(measurement),
		runnerSampledCpuMilliseconds: verdict(
			measurement.cdpSampledCpuMilliseconds,
			RESOURCE_GATES.runnerSampledCpuMilliseconds,
		),
		runnerWallMilliseconds: verdict(
			measurement.wallMilliseconds,
			RESOURCE_GATES.runnerWallMilliseconds,
		),
		scenario: measurement.scenario,
		workloadSemantics: workloadSemanticsVerdict(measurement),
	}));
	return {
		scenarios,
		thresholds: RESOURCE_GATES,
		workloadScenarioSet,
		verdict:
			workloadScenarioSet.verdict === "pass" &&
			scenarios.length > 0 &&
			scenarios.every(
				(scenario) =>
					scenario.runnerPeakBytes.verdict === "pass" &&
					scenario.runnerSampledCpuMilliseconds.verdict === "pass" &&
					scenario.runnerWallMilliseconds.verdict === "pass" &&
					scenario.cdpNonIdleCpuSamples.verdict === "pass" &&
					scenario.cdpTargetIdentity.verdict === "pass" &&
					scenario.workloadSemantics.verdict === "pass",
			)
				? "pass"
				: "fail",
	};
}

function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? files(path) : [path];
	});
}

function output(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function requireTrackedWorktreeAtHead(root) {
	if (output("git", ["status", "--porcelain", "--untracked-files=no"], root) !== "")
		throw new TypeError("refusing qualification because tracked files differ from HEAD");
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function verdict(observed, limit) {
	const finiteObserved = Number.isFinite(observed) ? observed : null;
	return {
		limit,
		observed: finiteObserved,
		verdict: finiteObserved !== null && finiteObserved <= limit ? "pass" : "fail",
	};
}

function positive(observed) {
	const finiteObserved = Number.isFinite(observed) ? observed : null;
	return {
		observed: finiteObserved,
		verdict: finiteObserved !== null && finiteObserved > 0 ? "pass" : "fail",
	};
}

function targetIdentity(measurement) {
	const observed = {
		control: measurement.cdpControlTargetId ?? null,
		measurement: measurement.cdpMeasurementTargetId ?? null,
	};
	return {
		expected: { control: CONTROL_TARGET_ID, measurement: RUNNER_TARGET_ID },
		observed,
		verdict:
			observed.control === CONTROL_TARGET_ID && observed.measurement === RUNNER_TARGET_ID
				? "pass"
				: "fail",
	};
}

function heapUsageVerdict(measurement) {
	const peak = peakHeapUsageSample(measurement.cdpHeapUsageSamples);
	const observed =
		peak !== null &&
		measurement.cdpPeakObservedHeapBytes === peak.conservativeIsolateBytes &&
		rawPeakMatches(measurement.cdpPeakObservedHeap, peak)
			? peak.conservativeIsolateBytes
			: null;
	return verdict(observed, RESOURCE_GATES.runnerPeakBytes);
}

function workloadScenarioSetVerdict(measurements) {
	const expected = Object.keys(WORKLOAD_GATES.scenarios).sort();
	const observed = measurements.map((measurement) => measurement.scenario).sort();
	return {
		expected,
		observed,
		verdict:
			expected.length === observed.length && expected.every((id, index) => id === observed[index])
				? "pass"
				: "fail",
	};
}

function workloadSemanticsVerdict(measurement) {
	const expected = WORKLOAD_GATES.scenarios[measurement.scenario] ?? null;
	const observed = {
		behavior: measurement.behavior ?? null,
		codePoints: measurement.codePoints ?? null,
		opinionOutboundCount: measurement.opinionOutboundCount ?? null,
		totalOutboundCount: measurement.totalOutboundCount ?? null,
		d1StateRows: measurement.d1StateRows ?? null,
		r2ObjectCount: measurement.r2ObjectCount ?? null,
		cancelledOutboundCount: measurement.cancelledOutboundCount ?? null,
	};
	return {
		expected:
			expected === null
				? { codePoints: WORKLOAD_GATES.codePoints }
				: { ...expected, codePoints: WORKLOAD_GATES.codePoints },
		observed,
		verdict:
			expected !== null &&
			observed.codePoints === WORKLOAD_GATES.codePoints &&
			Object.keys(expected).every((field) => observed[field] === expected[field])
				? "pass"
				: "fail",
	};
}

function rawPeakMatches(observed, peak) {
	return (
		observed !== null &&
		typeof observed === "object" &&
		["backingStorageSize", "embedderHeapUsedSize", "totalSize", "usedSize"].every(
			(field) => observed[field] === peak[field],
		)
	);
}
