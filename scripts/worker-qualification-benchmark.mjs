import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateResourceGates, qualifyWorkerArtifact } from "./worker-qualification-artifact.mjs";
import { availableInspectorPort } from "./worker-qualification-cleanup.mjs";
import { WORKER_QUALIFICATION_HARNESS_RECORD_DEADLINE_MS } from "./worker-qualification-record.mjs";
import { runWorkerQualificationScenario } from "./worker-qualification-scenario.mjs";

const ROOT = process.cwd();
const artifactDirectory = resolve(
	ROOT,
	process.env.WORKER_QUALIFICATION_ARTIFACT_DIR ??
		".omo/evidence/issue-10-worker-qualification/latest",
);
const scenarios = [
	{ id: "cold_no_match_10000cp_100op", pattern: "cold 10,000-code-point no-match" },
	{ id: "cold_late_match_10000cp_100op", pattern: "cold D1/R2 fill" },
	{ id: "warm_reuse_late_match_10000cp_100op", pattern: "warm D1/R2 reuse" },
];

mkdirSync(artifactDirectory, { recursive: true });
const qualification = qualifyWorkerArtifact(ROOT, artifactDirectory);
const measurements = [];
for (const scenario of scenarios) {
	measurements.push(
		await runWorkerQualificationScenario({
			artifactDirectory,
			inspectorPort: await availableInspectorPort(),
			root: ROOT,
			scenario,
		}),
	);
}
const gates = evaluateResourceGates(measurements);
const artifact = {
	qualification,
	capabilities: {
		memoryLimitQualification:
			"Local workerd does not enforce the production 128MiB memory limit. This harness compares the exact Vitest runner observed peak against the 128MiB gate; Issue #11 confirms deployment enforcement.",
		workerCpu: "V8 CDP Profiler sampled CPU time on the exact Vitest runner target",
		workerHeap:
			"V8 CDP Runtime.getHeapUsage raw samples and peak totalSize + embedderHeapUsedSize + backingStorageSize during the request profile window",
		workerAllocations:
			"V8 CDP HeapProfiler sampling allocation bytes during the request profile window",
		workerWallTime:
			"Worker performance.now request duration, a conservative bound for single-isolate CPU time",
	},
	harness: {
		recordDeadlineMilliseconds: WORKER_QUALIFICATION_HARNESS_RECORD_DEADLINE_MS,
		measurementScope:
			"Each scenario runs its named SELF.fetch integration test through the Worker graph with local D1, R2, and Durable Object bindings.",
		seam: "Vitest Cloudflare pool SELF.fetch against the normal worker entrypoint.",
		timingCsv: scenarios.map(({ id }) => `${id}.time.csv`),
	},
	gates,
	measurements,
	schemaVersion: 2,
};
writeFileSync(
	join(artifactDirectory, "worker-qualification-benchmark.json"),
	`${JSON.stringify(artifact, null, 2)}\n`,
);
process.stdout.write(`${join(artifactDirectory, "worker-qualification-benchmark.json")}\n`);
if (gates.verdict !== "pass") throw new TypeError("worker qualification resource gate failed");
