import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const RESOURCE_GATES = {
	coreEntryPeakBytes: 128 * 1024 * 1024,
	coreEntrySampledCpuMilliseconds: 5_000,
	coreEntryWallMilliseconds: 5_000,
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
	const scenarios = measurements.map((measurement) => ({
		coreEntryPeakBytes: verdict(
			measurement.cdpPeakObservedHeapBytes,
			RESOURCE_GATES.coreEntryPeakBytes,
		),
		coreEntrySampledCpuMilliseconds: verdict(
			measurement.cdpSampledCpuMilliseconds,
			RESOURCE_GATES.coreEntrySampledCpuMilliseconds,
		),
		coreEntryWallMilliseconds: verdict(
			measurement.wallMilliseconds,
			RESOURCE_GATES.coreEntryWallMilliseconds,
		),
		scenario: measurement.scenario,
	}));
	return {
		scenarios,
		thresholds: RESOURCE_GATES,
		verdict:
			scenarios.length > 0 &&
			scenarios.every(
				(scenario) =>
					scenario.coreEntryPeakBytes.verdict === "pass" &&
					scenario.coreEntrySampledCpuMilliseconds.verdict === "pass" &&
					scenario.coreEntryWallMilliseconds.verdict === "pass",
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
