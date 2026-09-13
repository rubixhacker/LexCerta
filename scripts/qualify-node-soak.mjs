import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connectPilot } from "../examples/pilot-client.ts";
import { initializeUpstreamBudget } from "../build/postgres/coordinator.js";
import { PgDatabase } from "../build/postgres/database.js";
import { PostgresKeyAdministration } from "../build/postgres/keys.js";
import { docker, image, until, verifyImage } from "../test/container/runtime-fixture.mjs";
import {
	citation,
	marker,
	maximumQuote,
	missingQuote,
	prepareSoakSources,
} from "../test/container/soak-sources.mjs";
import { withObjects } from "../test/fixtures/gcs-wire-fixture.mjs";
import { createPostgresTlsFixture } from "../test/fixtures/postgres-tls-fixture.mjs";
import { createPostgresFixture } from "../test/postgres/fixture.mjs";

const args = process.argv.slice(2);
const smoke = args[0] === "--smoke";
if (smoke) args.shift();
assert.equal(args.length, 2, "provide --output PATH, optionally preceded by --smoke");
assert.equal(args[0], "--output");
const output = resolve(args[1]);
const durationMs = smoke ? 30_000 : 1_800_000;
const startedAt = new Date().toISOString();
const result = {
	started_at: startedAt,
	fixture_only: true,
	smoke,
	qualified: false,
	phase: "setup",
	measurements: {},
	scenarios: [],
	container_runs: [],
};
// Reserve a fresh artifact path before starting; never replace earlier evidence.
await writeFile(output, "", { flag: "wx" });
const fixture = await createPostgresFixture();
const directory = await mkdtemp(
	join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "lexcerta-soak-"),
);
const name = `lexcerta-soak-${randomUUID().slice(0, 8)}`;
const clients = [];
const latencies = new Map();
const names = ["parse_citation", "verify_citation", "verify_quote"];
let inFlight = 0;
let peakInFlight = 0;
let completed = 0;
let source;
let failure;
let wireResponseBytes = 0;
const pepper = "synthetic-soak-pepper-value-not-a-secret";
const credentialId = randomUUID();
let url;
const clientStates = [];
const tokens = [];

function phase(value) {
	result.phase = value;
	process.stdout.write(`${JSON.stringify({ phase: value, completed })}\n`);
}
function summary(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
	return {
		count: sorted.length,
		p50_ms: quantile(0.5),
		p95_ms: quantile(0.95),
		p99_ms: quantile(0.99),
		maximum_ms: sorted.at(-1) ?? 0,
	};
}
async function call(lane, label, id = 101, quote = missingQuote, options = {}) {
	const state = clientStates[lane];
	state.pad = options.pad ?? false;
	state.lastStatus = undefined;
	const tool = label === "parse" ? names[0] : label === "citation" ? names[1] : names[2];
	const began = performance.now();
	inFlight++;
	peakInFlight = Math.max(peakInFlight, inFlight);
	try {
		const response = await clients[lane].callTool(
			{
				name: tool,
				arguments: { citation: citation(id), ...(tool === "verify_quote" ? { quote } : {}) },
			},
			{ timeout: 60_000, ...(options.signal ? { signal: options.signal } : {}) },
		);
		assert.ok(response.structuredContent, `missing structured result in ${label}`);
		assert.equal(
			response.isError ?? false,
			response.structuredContent.outcome === "indeterminate" &&
				response.structuredContent.reason !== "unsupported_citation",
			`wrong MCP error flag in ${label}`,
		);
		const serialized = JSON.stringify(response);
		assert.equal(serialized.includes(marker), false, "source text appeared in evidence response");
		assert.equal(
			serialized.includes(maximumQuote),
			false,
			"query text appeared in evidence response",
		);
		return response.structuredContent;
	} finally {
		const elapsed = performance.now() - began;
		const samples = latencies.get(label) ?? [];
		samples.push(Math.round(elapsed));
		latencies.set(label, samples);
		completed++;
		inFlight--;
		state.pad = false;
		assert.ok(
			elapsed < 57_000,
			`request exceeded the 55s service bound plus 2s observation margin: ${label}`,
		);
	}
}
async function expectQuote(label, id, quote, outcome, extra = {}, options = {}) {
	const began = performance.now();
	if (outcome === "resource_unavailable") {
		await rejectedCall(call(0, label, id, quote, options));
		assert.equal(clientStates[0].lastStatus, 503, `wrong aggregate-limit status in ${label}`);
		result.scenarios.push({
			name: label,
			status: 503,
			elapsed_ms: Math.round(performance.now() - began),
		});
		return;
	}
	const value = await call(0, label, id, quote, options);
	assert.equal(value.outcome, outcome, `wrong evidence outcome in ${label}`);
	for (const [key, expected] of Object.entries(extra))
		assert.equal(value[key], expected, `wrong ${key} in ${label}`);
	if (id === 101 && outcome !== "indeterminate") {
		assert.equal(value.evidence.requiredOpinionCount, 100);
		assert.equal(value.evidence.searchedOpinionCount, 100);
		assert.equal(value.evidence.searchComplete, true);
		if (outcome === "verified") assert.equal(value.evidence.matchingOpinion.id, 101099);
	}
	result.scenarios.push({
		name: label,
		outcome,
		...(value.reason ? { reason: value.reason } : {}),
		elapsed_ms: Math.round(performance.now() - began),
	});
}
async function rejectedCall(promise) {
	await assert.rejects(promise, (error) => {
		// Expected cancellation/transport failures cannot hide a failed harness
		// assertion about evidence, privacy or the request deadline.
		assert.notEqual(error.name, "AssertionError");
		return true;
	});
}
async function readLogs() {
	const dockerArgs = [
		...(process.env.LEXCERTA_TEST_DOCKER_CONFIG
			? ["--config", process.env.LEXCERTA_TEST_DOCKER_CONFIG]
			: []),
		...(process.env.LEXCERTA_TEST_DOCKER_HOST
			? ["--host", process.env.LEXCERTA_TEST_DOCKER_HOST]
			: []),
		"logs",
		name,
	];
	const logs = await promisify(execFile)("docker", dockerArgs, {
		timeout: 30_000,
		maxBuffer: 64 * 1_048_576,
	});
	const text = logs.stdout + logs.stderr;
	for (const sentinel of [
		marker,
		maximumQuote,
		pepper,
		"synthetic-soak-upstream-token",
		"lc_test_",
		"PRIVATE KEY",
		"postgresql://",
	])
		assert.equal(text.includes(sentinel), false, "container log privacy check failed");
	await writeFile(`${output}.container.log`, text);
	return text
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}
async function startContainer(restart = false) {
	const began = performance.now();
	if (restart) await docker("start", name);
	else {
		await docker(
			"run",
			"--detach",
			"--platform",
			"linux/amd64",
			"--name",
			name,
			"--memory",
			"1g",
			"--memory-swap",
			"1g",
			"--cpus",
			"1",
			"--pids-limit",
			"128",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--tmpfs",
			"/tmp:rw,noexec,nosuid,size=8m,mode=1777",
			"--add-host",
			"host.docker.internal:host-gateway",
			"-p",
			"127.0.0.1::8080",
			"--mount",
			`type=bind,source=${directory},target=/app/test,readonly`,
			...[
				"LEXCERTA_ENVIRONMENT=staging",
				"GOOGLE_CLOUD_PROJECT=fixture-project",
				"LEXCERTA_DATABASE_HOST=ep-fixture-123.us-east-2.aws.neon.tech",
				"LEXCERTA_DATABASE_PASSWORD=synthetic-neon-private-password-32",
				`LEXCERTA_BUILD_ID=${"0".repeat(40)}`,
				`API_KEY_PEPPER=${pepper}`,
				`COURTLISTENER_CREDENTIAL_ID=${credentialId}`,
				"COURTLISTENER_API_TOKEN=synthetic-soak-upstream-token",
			].flatMap((value) => ["-e", value]),
			image,
			"node",
			"test/container/soak-fixture.mjs",
		);
	}
	const state = JSON.parse(await docker("inspect", name))[0];
	assert.equal(state.HostConfig.Memory, 1_073_741_824);
	assert.equal(state.HostConfig.MemorySwap, 1_073_741_824);
	assert.equal(state.HostConfig.NanoCpus, 1_000_000_000);
	url = new URL(`http://127.0.0.1:${(await docker("port", name, "8080/tcp")).split(":").at(-1)}/`);
	await until(async () => {
		const response = await fetch(new URL("/healthz", url)).catch(() => undefined);
		return response?.status === 200 && (await response.json()).build === "0".repeat(40);
	});
	result.container_runs.push({
		restart,
		startup_ms: Math.round(performance.now() - began),
		cpu: 1,
		memory_bytes: state.HostConfig.Memory,
	});
	for (let lane = 0; lane < 8; lane++) {
		const wireState = { pad: false };
		clientStates[lane] = wireState;
		clients[lane] = await connectPilot(url, tokens[lane], async (input, init) => {
			let request = new Request(input, init);
			if (wireState.pad && request.headers.get("mcp-method") === "tools/call") {
				const body = await request.text();
				const padding = 65_536 - Buffer.byteLength(body);
				assert.ok(padding >= 0);
				request = new Request(request.url, {
					method: request.method,
					headers: request.headers,
					body: body + " ".repeat(padding),
					signal: request.signal,
					redirect: "manual",
				});
				wireState.maximumBody = 65_536;
			}
			const response = await fetch(request);
			wireState.lastStatus = response.status;
			wireResponseBytes += Number(response.headers.get("content-length") ?? 0);
			return response;
		});
	}
}

try {
	const compiled = (await readdir("build", { recursive: true }))
		.filter((file) => file.endsWith(".js"))
		.sort();
	const inspected = await verifyImage(compiled);
	result.image = inspected.Id;
	result.compiled_sha256 = Object.fromEntries(
		await Promise.all(
			compiled.map(async (file) => [
				file,
				createHash("sha256")
					.update(await readFile(join("build", file)))
					.digest("hex"),
			]),
		),
	);
	await chmod(directory, 0o755);
	await mkdir(join(directory, "container"));
	await mkdir(join(directory, "fixtures"));
	for (const file of ["container/soak-fixture.mjs", "fixtures/postgres-tls-fixture.mjs"])
		await copyFile(`test/${file}`, join(directory, file));
	for (let lane = 0; lane < 8; lane++) {
		const publicId = randomUUID();
		const token = `lc_test_${publicId}_${"A".repeat(43)}`;
		tokens.push(token);
		await new PostgresKeyAdministration(fixture.administration, "test", fixture.journal).issue({
			publicId,
			customerId: `soak-organization-${lane % 3}`,
			environment: "test",
			actorSubject: "fixture-operator",
			hmacSha256Hex: createHmac("sha256", pepper).update(token).digest("hex"),
			minuteLimit: 600,
			dayLimit: 10000,
		});
	}
	await initializeUpstreamBudget(new PgDatabase(fixture.migration), credentialId);
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET enabled = true WHERE credential_id = $1",
		[credentialId],
	);
	await withObjects(async (gcs) => {
		source = await prepareSoakSources(fixture, gcs.objects);
		const tls = await createPostgresTlsFixture(fixture.publicConnection);
		try {
			const connection = new URL(fixture.publicConnection);
			connection.hostname = "host.docker.internal";
			await writeFile(
				join(directory, "container/soak-settings.json"),
				JSON.stringify({
					connection: String(connection),
					certificate: tls.certificate,
					sourcePort: source.port,
					objectsPort: Number(new URL(gcs.connection.endpoint).port),
				}),
			);
		} finally {
			await tls.close();
		}
		phase("cold-start-and-warmup");
		await startContainer();
		assert.deepEqual((await clients[0].listTools()).tools.map((tool) => tool.name).sort(), names);
		await expectQuote("warmup-hundred", 101, missingQuote, "not_found");
		await expectQuote("warmup-maximum", 102, maximumQuote, "verified", {}, { pad: true });
		assert.equal(clientStates[0].maximumBody, 65_536);
		await expectQuote("warmup-aggregate", 103, missingQuote, "resource_unavailable");
		// The real 3/min budget is now spent. A further quote must be denied
		// without a fourth data HTTP request, even though all bodies are cached.
		const dataBefore = source.state.requests.filter((request) => !request.usage).length;
		await expectQuote("upstream-cap", 101, marker, "indeterminate", { reason: "quota_unknown" });
		assert.equal(source.state.requests.filter((request) => !request.usage).length, dataBefore);
		phase(smoke ? "smoke-workload" : "thirty-minute-workload");
		const began = performance.now();
		const completedBeforeWorkload = completed;
		const sampleStartMs =
			(await readLogs()).filter((row) => row.soak_metric).at(-1)?.elapsed_ms ?? 0;
		const schedules = [
			["hundred-match", 101, marker, "verified"],
			["hundred-missing", 101, missingQuote, "not_found"],
			["maximum-html", 102, maximumQuote, "verified"],
			["aggregate-limit", 103, missingQuote, "resource_unavailable"],
			["oversized-upstream", 104, marker, "indeterminate", { reason: "incomplete" }],
			["slow-upstream", 105, marker, "indeterminate", { reason: "timeout" }],
			["maximum-upstream-json", 106, marker, "verified"],
			["hundred-repeat", 101, missingQuote, "not_found"],
			["deadline"],
			["abort"],
			["hundred-after-abort", 101, marker, "verified"],
			["maximum-repeat", 102, maximumQuote, "verified"],
			["too-many-opinions", 108, marker, "indeterminate", { reason: "incomplete" }],
			["hundred-final", 101, missingQuote, "not_found"],
		];
		let nextScenario = 0;
		const progress = setInterval(
			() =>
				process.stdout.write(
					`${JSON.stringify({ phase: result.phase, elapsed_seconds: Math.round((performance.now() - began) / 1000), completed, scenarios: nextScenario })}\n`,
				),
			60_000,
		);
		let stopWorkers = false;
		try {
			const workers = await Promise.allSettled(
				Array.from({ length: 8 }, async (_, lane) => {
					try {
						let count = 0;
						while (!stopWorkers && performance.now() - began < durationMs) {
							const requestAt = performance.now();
							if (
								lane === 0 &&
								!smoke &&
								nextScenario < schedules.length &&
								requestAt - began >= (nextScenario + 1) * 120_000
							) {
								const scenario = schedules[nextScenario++];
								if (scenario[0] === "deadline") {
									gcs.behavior.delayMs = 350;
									const started = performance.now();
									try {
										await rejectedCall(call(0, "deadline", 101, missingQuote));
									} finally {
										gcs.behavior.delayMs = 0;
									}
									assert.ok(performance.now() - started >= 54_000);
									assert.ok(
										clientStates[0].lastStatus === 504 || clientStates[0].lastStatus === undefined,
									);
									result.scenarios.push({
										name: "deadline",
										status: clientStates[0].lastStatus ?? "socket_closed",
										elapsed_ms: Math.round(performance.now() - started),
									});
								} else if (scenario[0] === "abort") {
									gcs.behavior.stall = true;
									const controller = new AbortController();
									const pending = rejectedCall(
										call(0, "abort", 101, marker, { signal: controller.signal }),
									);
									try {
										await until(async () => gcs.activeResponses.size > 0);
										controller.abort();
										await pending;
										await until(async () => gcs.activeResponses.size === 0);
									} finally {
										controller.abort();
										gcs.behavior.stall = false;
									}
									result.scenarios.push({ name: "abort", closed_object_responses: true });
								} else await expectQuote(...scenario);
							} else {
								const label = count++ % 2 ? "parse" : "citation";
								const value = await call(lane, label);
								assert.equal(
									value.outcome,
									label === "parse" ? "parsed" : "verified",
									`wrong sustained ${label} result`,
								);
							}
							// Eight independent workers, each capped at four starts/second,
							// remain below the real 600/min and 10000/day per-key limits.
							await delay(Math.max(0, 250 - (performance.now() - requestAt)));
						}
					} catch (error) {
						stopWorkers = true;
						throw error;
					}
				}),
			);
			const failed = workers.find((worker) => worker.status === "rejected");
			if (failed) throw failed.reason;
		} finally {
			clearInterval(progress);
		}
		const measuredMs = performance.now() - began;
		result.measurements.workload_ms = Math.round(measuredMs);
		result.measurements.workload_calls = completed - completedBeforeWorkload;
		assert.ok(measuredMs >= durationMs);
		assert.equal(peakInFlight, 8);
		if (!smoke) assert.equal(nextScenario, schedules.length);
		result.measurements.sustained_container_samples = (await readLogs()).filter(
			(row) => row.soak_metric && row.elapsed_ms > sampleStartMs,
		);
		if (!smoke) {
			phase("forced-termination-and-recovery");
			const pending = rejectedCall(call(0, "forced-kill", 107, marker));
			await until(async () => source.state.killStarted);
			await docker("kill", "--signal", "SIGKILL", name);
			await pending;
			assert.equal(await docker("wait", name), "137");
			assert.equal(JSON.parse(await docker("inspect", name))[0].State.OOMKilled, false);
			const interrupted = await fixture.migration.query(
				"SELECT body_key FROM lexcerta.opinion_sources WHERE opinion_id = 107000",
			);
			assert.equal(interrupted.rows[0]?.body_key ?? null, null);
			const charged = Number(
				(
					await fixture.migration.query(
						"SELECT count(*) FROM lexcerta.upstream_attempts WHERE kind <> 'quota_sync'",
					)
				).rows[0].count,
			);
			await Promise.all(clients.splice(0).map((client) => client.close()));
			await startContainer(true);
			source.state.releaseKill = true;
			assert.equal(
				Number(
					(
						await fixture.migration.query(
							"SELECT count(*) FROM lexcerta.upstream_attempts WHERE kind <> 'quota_sync'",
						)
					).rows[0].count,
				),
				charged,
			);
			// Real time passes; the fixture never rewrites admission clocks or caps.
			phase("recovery-awaiting-upstream-window");
			await delay(60_100);
			await expectQuote("recovered-after-kill", 107, marker, "verified");
			gcs.behavior.delayMs = 250;
			const draining = call(0, "term-drain", 107, marker);
			await until(async () => gcs.activeResponses.size > 0);
			await docker("kill", "--signal", "SIGTERM", name);
			assert.equal((await draining).outcome, "verified");
			gcs.behavior.delayMs = 0;
		} else await docker("kill", "--signal", "SIGTERM", name);
		assert.equal(await docker("wait", name), "0");
		assert.equal(JSON.parse(await docker("inspect", name))[0].State.OOMKilled, false);
		await until(
			async () =>
				!(await fixture.inspectActivity()).some(
					(row) => row.application_name === "lexcerta-public",
				),
		);
		const logs = await readLogs();
		const closed = logs.filter((row) => row.soak_closed).at(-1);
		assert.equal(closed?.sample_failure, false);
		assert.equal(closed.pool.total, 0);
		assert.equal(closed.pool.waiting, 0);
		assert.equal(source.state.failures, 0);
		result.upstream_http = source.state.requests;
		result.object_requests = gcs.requests.length;
		await source.close();
		source = undefined;
	});
	phase("audit");
	const admissions = (
		await fixture.migration.query(
			"SELECT max(minute_count)::integer AS maximum_minute, max(day_count)::integer AS maximum_day FROM (SELECT count(*) OVER (PARTITION BY public_id ORDER BY admitted_at RANGE BETWEEN INTERVAL '1 minute' PRECEDING AND CURRENT ROW) AS minute_count, count(*) OVER (PARTITION BY public_id) AS day_count FROM lexcerta.key_admissions) counted",
		)
	).rows[0];
	assert.ok(admissions.maximum_minute <= 600);
	assert.ok(admissions.maximum_day <= 10000);
	const attempts = (
		await fixture.migration.query(
			"SELECT reserved_at, completed_at, kind FROM lexcerta.upstream_attempts ORDER BY reserved_at",
		)
	).rows;
	const data = attempts.filter((attempt) => attempt.kind !== "quota_sync");
	for (const [milliseconds, limit] of [
		[60_000, 3],
		[3_600_000, 30],
		[86_400_000, 80],
	]) {
		for (const end of data)
			assert.ok(
				data.filter(
					(attempt) =>
						attempt.reserved_at <= end.reserved_at &&
						attempt.reserved_at > new Date(end.reserved_at.getTime() - milliseconds),
				).length <= limit,
				"upstream rolling cap exceeded",
			);
	}
	assert.ok(data.length >= result.upstream_http.filter((request) => !request.usage).length);
	result.admission_audit = admissions;
	result.upstream_audit = {
		charged_data: data.length,
		charged_sync: attempts.length - data.length,
		unfinished_data: data.filter((attempt) => attempt.completed_at === null).length,
	};
	const metrics = result.measurements.sustained_container_samples;
	assert.ok(metrics.length >= (durationMs / 1000) * 0.95);
	assert.ok(
		metrics.every((row) => row.pool.total <= 5 && row.pool.waiting <= 8 && row.pool.failures === 0),
	);
	assert.ok(
		metrics.every(
			(row) =>
				row.cgroup_events.oom === 0 &&
				row.cgroup_events.oom_kill === 0 &&
				row.cgroup_peak < 1_073_741_824,
		),
	);
	const median = (rows) => summary(rows.map((row) => row.rss)).p50_ms;
	const samplesPerWindow = smoke ? 10 : 300;
	const first = median(metrics.slice(0, samplesPerWindow));
	const last = median(metrics.slice(-samplesPerWindow));
	const tail = metrics.slice(-(smoke ? 20 : 900));
	const x = tail.map((row) => row.elapsed_ms / 60_000);
	const y = tail.map((row) => row.rss);
	const meanX = x.reduce((a, b) => a + b, 0) / x.length;
	const meanY = y.reduce((a, b) => a + b, 0) / y.length;
	const slope =
		x.reduce((sum, value, index) => sum + (value - meanX) * (y[index] - meanY), 0) /
		x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
	result.measurements.memory = {
		peak_cgroup_bytes: Math.max(...metrics.map((row) => row.cgroup_peak)),
		peak_rss_bytes: Math.max(...metrics.map((row) => row.rss)),
		first_window_median_rss: first,
		last_window_median_rss: last,
		tail_rss_slope_bytes_per_minute: Math.round(slope),
	};
	if (!smoke) {
		assert.ok(last - first <= 64 * 1_048_576, "unresolved RSS growth between five-minute windows");
		assert.ok(slope <= 1_048_576, "unresolved RSS growth in final fifteen minutes");
	}
	result.measurements.throughput_calls_per_second = Number(
		(result.measurements.workload_calls / (result.measurements.workload_ms / 1000)).toFixed(2),
	);
	result.measurements.peak_client_in_flight = peakInFlight;
	result.measurements.wire_response_bytes = wireResponseBytes;
	result.latency_by_scenario = Object.fromEntries(
		[...latencies].map(([label, values]) => [label, summary(values)]),
	);
	result.qualified = !smoke;
	phase(smoke ? "smoke-passed" : "fixture-soak-passed");
} catch (error) {
	failure = error;
	result.failure = {
		name: error.name,
		message: error.message,
		stack: error.stack
			?.split("\n")
			.filter((line) => line.trim().startsWith("at "))
			.slice(0, 6),
	};
	await readLogs().catch(() => undefined);
} finally {
	await Promise.allSettled(clients.map((client) => client.close()));
	await docker("rm", "--force", name).catch(() => undefined);
	await source?.close();
	await fixture.close();
	await rm(directory, { recursive: true, force: true });
	result.finished_at = new Date().toISOString();
	result.boundaries = [
		"Synthetic sources and local PostgreSQL with fixture TLS; no CourtListener load or live GCS/Neon/Cloud Run proof.",
		"Eight client workers offer at most four starts per second each, preserving actual per-key and upstream quotas. Offered concurrency is not eight continuously active quote searches.",
		"The fixture injects only storage/transport endpoints; the image supplies the public HTTP lifecycle, admission, MCP handler, evidence logic and normalizer.",
		"RSS is evaluated without forced garbage collection. Passing this bounded workload does not prove absence of all memory leaks or hosted cold-start performance.",
	];
	await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}
process.stdout.write(
	`${JSON.stringify({ qualified: result.qualified, smoke, phase: result.phase, output })}\n`,
);
if (failure) process.exitCode = 1;
