import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectCdp } from "./worker-qualification-cdp.mjs";
import {
	runWithWorkerQualificationCleanup,
	terminateChildProcess,
} from "./worker-qualification-cleanup.mjs";
import { captureHeapUsageSample, peakHeapUsageSample } from "./worker-qualification-heap.mjs";
import {
	WORKER_QUALIFICATION_HARNESS_RECORD_DEADLINE_MS,
	waitForRecord,
} from "./worker-qualification-record.mjs";
import {
	closeWorkerQualificationInspectors,
	runWithWorkerQualificationDeadline,
	selectWorkerQualificationTargets,
} from "./worker-qualification-runner.mjs";

const HEAP_SAMPLE_INTERVAL_MS = 20;
const TEST_FILE = "test/worker-qualification-benchmark.integration.test.ts";

export async function runWorkerQualificationScenario(input) {
	const timingPath = join(input.artifactDirectory, `${input.scenario.id}.time.csv`);
	const child = spawn(
		"/usr/bin/time",
		[
			"-o",
			timingPath,
			"-f",
			"%U,%S,%e,%M",
			"npm",
			"exec",
			"--",
			"vitest",
			"run",
			TEST_FILE,
			"--testNamePattern",
			input.scenario.pattern,
			"--inspectBrk",
			String(input.inspectorPort),
			"--no-file-parallelism",
			"--reporter=verbose",
		],
		{ cwd: input.root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	const deadline = Date.now() + WORKER_QUALIFICATION_HARNESS_RECORD_DEADLINE_MS;
	let output = "";
	let control;
	let measurement;
	let sampler;
	const exit = waitForExit(child);
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	return runWithWorkerQualificationCleanup({
		clearSampler: () => sampler !== undefined && clearInterval(sampler),
		closeInspector: () => closeWorkerQualificationInspectors(control, measurement),
		run: () =>
			runWithWorkerQualificationDeadline({
				clearTimer: clearTimeout,
				deadline,
				now: Date.now,
				run: async () => {
					const targets = await waitForWorkerQualificationTargets(input.inspectorPort, deadline);
					control = await connectCdp(targets.control.webSocketDebuggerUrl);
					measurement = await connectCdp(targets.measurement.webSocketDebuggerUrl);
					await measurement.call("Profiler.enable");
					await measurement.call("Profiler.setSamplingInterval", { interval: 100 });
					await measurement.call("HeapProfiler.enable");
					await measurement.call("HeapProfiler.startSampling", {
						includeObjectsCollectedByMajorGC: true,
						includeObjectsCollectedByMinorGC: true,
						samplingInterval: 1_024,
					});
					const initialHeap = captureHeapUsageSample(
						await measurement.call("Runtime.getHeapUsage"),
					);
					await measurement.call("Profiler.start");
					await control.call("Runtime.runIfWaitingForDebugger");
					const observedHeaps = [initialHeap];
					const samplingRequests = new Set();
					sampler = setInterval(() => {
						const samplingRequest = measurement
							.call("Runtime.getHeapUsage")
							.then(captureHeapUsageSample)
							.catch(() => captureHeapUsageSample(null))
							.then((sample) => observedHeaps.push(sample));
						samplingRequests.add(samplingRequest);
						void samplingRequest.finally(() => samplingRequests.delete(samplingRequest));
					}, HEAP_SAMPLE_INTERVAL_MS);
					const record = await waitForRecord({
						child,
						clearTimer: clearTimeout,
						deadline,
						now: Date.now,
						output: () => output,
						scenarioId: input.scenario.id,
						setTimer: setTimeout,
					});
					clearInterval(sampler);
					await Promise.all(samplingRequests);
					const [finalHeap, cpuProfile, allocationProfile] = await Promise.all([
						measurement.call("Runtime.getHeapUsage"),
						measurement.call("Profiler.stop"),
						measurement.call("HeapProfiler.stopSampling"),
					]);
					const nonIdleSamples = nonIdleCpuSampleCount(cpuProfile);
					if (nonIdleSamples === 0)
						throw new TypeError(
							`worker qualification ${input.scenario.id} has no non-idle CPU samples`,
						);
					observedHeaps.push(captureHeapUsageSample(finalHeap));
					const peakHeap = peakHeapUsageSample(observedHeaps);
					const completion = await exit;
					if (completion !== 0)
						throw new TypeError(
							`worker qualification ${input.scenario.id} failed with status ${completion}`,
						);
					const [userSeconds, systemSeconds, elapsedSeconds, maxResidentSetKiB] = readFileSync(
						timingPath,
						"utf8",
					)
						.trim()
						.split(",")
						.map(Number);
					return {
						...record,
						cdpControlTargetId: targets.control.id,
						cdpInspectorPort: input.inspectorPort,
						cdpMeasurementTargetId: targets.measurement.id,
						cdpNonIdleCpuSampleCount: nonIdleSamples,
						cdpSampledAllocationBytes: sampledAllocationBytes(allocationProfile),
						cdpSampledCpuMilliseconds: sampledCpuMilliseconds(cpuProfile),
						cdpHeapUsageSamples: observedHeaps,
						cdpPeakObservedHeap: rawHeapFields(peakHeap),
						cdpPeakObservedHeapBytes: peakHeap?.conservativeIsolateBytes ?? null,
						cdpProfileWindow:
							"Vitest runner from core:entry release until the sanitized benchmark marker",
						harnessCpuMilliseconds: (userSeconds + systemSeconds) * 1_000,
						harnessElapsedMilliseconds: elapsedSeconds * 1_000,
						harnessMaxResidentSetKiB: maxResidentSetKiB,
					};
				},
				scenarioId: input.scenario.id,
				setTimer: setTimeout,
			}),
		terminateChild: () => terminateChildProcess(child, exit),
	});
}

async function waitForWorkerQualificationTargets(port, deadline) {
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`);
			return selectWorkerQualificationTargets(await response.json());
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new TypeError(`workerd inspector targets did not appear on ${port}`);
}

function waitForExit(child) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

function sampledCpuMilliseconds(profile) {
	const names = profileNodeNames(profile);
	return (
		profile.profile.timeDeltas.reduce(
			(total, delta, index) =>
				names.get(profile.profile.samples[index]) === "(idle)" ? total : total + delta,
			0,
		) / 1_000
	);
}

function nonIdleCpuSampleCount(profile) {
	const names = profileNodeNames(profile);
	return profile.profile.samples.filter((id) => names.get(id) !== "(idle)").length;
}

function profileNodeNames(profile) {
	return new Map(profile.profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
}

function sampledAllocationBytes(profile) {
	return profile.profile.samples.reduce((total, sample) => total + sample.size, 0);
}

function rawHeapFields(sample) {
	const {
		backingStorageSize = null,
		embedderHeapUsedSize = null,
		totalSize = null,
		usedSize = null,
	} = sample ?? {};
	return { backingStorageSize, embedderHeapUsedSize, totalSize, usedSize };
}
