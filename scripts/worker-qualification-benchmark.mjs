import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const MARKER = "WORKER_QUALIFICATION_BENCHMARK=";
const TEST_FILE = "test/worker-qualification-benchmark.integration.test.ts";
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
const measurements = [];
for (const [index, scenario] of scenarios.entries())
	measurements.push(await runScenario(scenario, 9_240 + index));
const artifact = {
	bundle: measureBundle(),
	capabilities: {
		memoryLimitQualification:
			"unsupported: local workerd does not enforce deployed Worker memory limits",
		workerCpu: "V8 CDP Profiler sampled CPU time on core:entry",
		workerHeap: "V8 CDP Runtime.getHeapUsage peak observed during the request profile window",
		workerAllocations:
			"V8 CDP HeapProfiler sampling allocation bytes during the request profile window",
	},
	harness: {
		measurementScope:
			"Each scenario runs its named SELF.fetch integration test through the Worker graph with local D1, R2, and Durable Object bindings.",
		seam: "Vitest Cloudflare pool SELF.fetch against the normal worker entrypoint.",
	},
	measurements,
	schemaVersion: 1,
};
writeFileSync(
	join(artifactDirectory, "worker-qualification-benchmark.json"),
	`${JSON.stringify(artifact, null, 2)}\n`,
);
process.stdout.write(`${join(artifactDirectory, "worker-qualification-benchmark.json")}\n`);

async function runScenario(scenario, inspectorPort) {
	const timingPath = join(artifactDirectory, `${scenario.id}.time.csv`);
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
			scenario.pattern,
			"--inspectBrk",
			String(inspectorPort),
			"--no-file-parallelism",
			"--reporter=verbose",
		],
		{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	const exit = waitForExit(child);
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	const core = await connect(await waitForCore(inspectorPort));
	await core.call("Profiler.enable");
	await core.call("Profiler.setSamplingInterval", { interval: 100 });
	await core.call("HeapProfiler.enable");
	await core.call("HeapProfiler.startSampling", {
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
		samplingInterval: 1_024,
	});
	const initialHeap = await core.call("Runtime.getHeapUsage");
	await core.call("Profiler.start");
	await core.call("Runtime.runIfWaitingForDebugger");
	const observedHeaps = [heapBytes(initialHeap)];
	const sampler = setInterval(() => {
		void core
			.call("Runtime.getHeapUsage")
			.then((heap) => observedHeaps.push(heapBytes(heap)))
			.catch(() => {});
	}, 20);
	const record = await waitForRecord(child, scenario.id, () => output);
	clearInterval(sampler);
	const [finalHeap, cpuProfile, allocationProfile] = await Promise.all([
		core.call("Runtime.getHeapUsage"),
		core.call("Profiler.stop"),
		core.call("HeapProfiler.stopSampling"),
	]);
	observedHeaps.push(heapBytes(finalHeap));
	core.close();
	const completion = await exit;
	if (completion !== 0)
		throw new TypeError(`worker qualification ${scenario.id} failed with status ${completion}`);
	const [userSeconds, systemSeconds, elapsedSeconds, maxResidentSetKiB] = readFileSync(
		timingPath,
		"utf8",
	)
		.trim()
		.split(",")
		.map(Number);
	return {
		...record,
		cdpNonIdleCpuSampleCount: nonIdleCpuSampleCount(cpuProfile),
		cdpSampledAllocationBytes: sampledAllocationBytes(allocationProfile),
		cdpSampledCpuMilliseconds: sampledCpuMilliseconds(cpuProfile),
		cdpPeakObservedHeapBytes: Math.max(...observedHeaps),
		cdpProfileWindow:
			"core:entry from Runtime.runIfWaitingForDebugger until the sanitized benchmark marker",
		harnessCpuMilliseconds: (userSeconds + systemSeconds) * 1_000,
		harnessElapsedMilliseconds: elapsedSeconds * 1_000,
		harnessMaxResidentSetKiB: maxResidentSetKiB,
	};
}

async function waitForCore(port) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			const core = targets.find((target) => target.id === "core:entry");
			if (core !== undefined) return core.webSocketDebuggerUrl;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new TypeError(`workerd inspector core:entry did not appear on ${port}`);
}

async function connect(url) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let sequence = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const resolve = pending.get(message.id);
		if (resolve !== undefined) {
			pending.delete(message.id);
			resolve(message);
		}
	});
	return {
		call: (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = ++sequence;
				pending.set(id, (message) =>
					message.error === undefined
						? resolve(message.result)
						: reject(new TypeError(JSON.stringify(message.error))),
				);
				socket.send(JSON.stringify({ id, method, params }));
			}),
		close: () => socket.close(),
	};
}

function waitForRecord(child, scenarioId, output) {
	return new Promise((resolve, reject) => {
		const check = () => {
			const line = output()
				.split("\n")
				.find((value) => value.includes(MARKER));
			if (line === undefined) return;
			const record = JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length).trim());
			if (record.scenario !== scenarioId)
				reject(new TypeError(`unexpected benchmark record for ${scenarioId}`));
			else resolve(record);
		};
		child.stdout.on("data", check);
		child.once("exit", () => {
			check();
			if (!output().includes(MARKER))
				reject(new TypeError(`missing benchmark record for ${scenarioId}`));
		});
		check();
	});
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

function heapBytes(heap) {
	return heap.usedSize + heap.embedderHeapUsedSize + heap.backingStorageSize;
}

function measureBundle() {
	const outputDirectory = join(artifactDirectory, "bundle");
	const result = spawnSync(
		"npm",
		["exec", "--", "wrangler", "deploy", "--dry-run", "--outdir", outputDirectory],
		{ cwd: ROOT, encoding: "utf8" },
	);
	if (result.error !== undefined || result.status !== 0)
		throw new TypeError("worker qualification bundle measurement failed");
	const paths = spawnSync("find", [outputDirectory, "-type", "f", "-print"], {
		encoding: "utf8",
	}).stdout.trim();
	const files = (paths === "" ? [] : paths.split("\n")).filter((path) => path.endsWith(".js"));
	for (const path of paths === "" ? [] : paths.split("\n")) {
		if (path.endsWith(".map")) rmSync(path, { force: true });
	}
	return {
		bytes: files.reduce((total, path) => total + statSync(path).size, 0),
		files: files.length,
	};
}

process.on("exit", () => {
	for (const scenario of scenarios)
		rmSync(join(artifactDirectory, `${scenario.id}.time.csv`), { force: true });
});
