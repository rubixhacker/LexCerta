import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import {
	EXPECTED_URLS,
	FIXTURE_SOURCE_TEXT,
	PROTOCOL_VERSION,
	QUOTE,
	TOKEN,
	discoveryRequest,
	inspectWorker,
	quoteRequest,
	seedWorker,
	trap,
	workerUnderTest,
} from "./worker-bundle-conformance-fixtures.mjs";

export async function runBundleConformance(destination) {
	const root = resolve(process.cwd());
	const outdir = resolve(destination);
	if (relative(root, outdir).startsWith(".."))
		throw new TypeError("bundle conformance artifacts must remain inside the workspace");
	if (existsSync(outdir) && readdirSync(outdir).length > 0)
		throw new TypeError(`refusing to overwrite non-empty evidence directory: ${outdir}`);
	mkdirSync(outdir, { recursive: true });
	const bundleDir = join(outdir, "bundle");
	execFileSync(
		"./node_modules/.bin/wrangler",
		[
			"deploy",
			"--dry-run",
			"--env=",
			"--outdir",
			bundleDir,
			"--metafile",
			join(bundleDir, "meta.json"),
		],
		{ cwd: root, stdio: "pipe" },
	);
	const bundlePath = join(bundleDir, "worker.js");
	const bundle = readFileSync(bundlePath);
	const attemptedUrls = [];
	const unexpectedUrls = [];
	const compatibilityDate = readCompatibilityDate(join(root, "wrangler.jsonc"));
	const miniflare = new Miniflare({
		resourcePersistencePath: join(outdir, "miniflare-state"),
		workers: [
			seedWorker(root, compatibilityDate),
			inspectWorker(compatibilityDate),
			workerUnderTest({
				bundlePath,
				compatibilityDate,
				outboundService: (request) => trap(request, attemptedUrls, unexpectedUrls),
				root,
			}),
		],
	});
	try {
		await assertStatus(await miniflare.dispatchFetch("https://seed.bundle.test/"), 200, "D1 seed");
		const discoveryInput = discoveryRequest();
		const discovery = await miniflare.dispatchFetch(discoveryInput.url, discoveryInput.init);
		const discoveryBody = await discovery.text();
		await assertStatus(discovery, 200, "modern discovery");
		if (!discoveryBody.includes(PROTOCOL_VERSION))
			throw new TypeError("modern discovery version missing");
		const quoteInput = quoteRequest();
		const quote = await miniflare.dispatchFetch(quoteInput.url, quoteInput.init);
		const quoteBody = await quote.text();
		await assertStatus(quote, 200, "10,000-code-point quote");
		if (!quoteBody.includes('"outcome":"verified"')) throw new TypeError("quote was not verified");
		if (
			quoteBody.includes(QUOTE) ||
			quoteBody.includes(FIXTURE_SOURCE_TEXT) ||
			quoteBody.includes(TOKEN)
		)
			throw new TypeError("quote response disclosed fixture source text or credentials");
		const bindings = await (await miniflare.dispatchFetch("https://inspect.bundle.test/")).json();
		const report = {
			artifact: { bytes: bundle.byteLength, path: "bundle/worker.js", sha256: sha256(bundle) },
			bindings,
			harness: {
				bundleInput: "Wrangler emitted worker.js loaded by absolute scriptPath",
				runtime: "Miniflare workerd",
				storage: [
					"D1",
					"R2",
					"ApiKeyLimiter Durable Object",
					"CourtListenerCoordinator Durable Object",
				],
			},
			outbound: { attemptedUrls, expectedUrls: EXPECTED_URLS, unexpectedUrls },
			redaction: { credentialAbsent: true, fixtureSourceTextAbsent: true },
			scenarios: {
				discovery: { protocolVersion: PROTOCOL_VERSION, status: discovery.status },
				quote: { codePoints: Array.from(QUOTE).length, outcome: "verified", status: quote.status },
			},
		};
		assertBundleConformance(report);
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		if (
			serialized.includes(QUOTE) ||
			serialized.includes(FIXTURE_SOURCE_TEXT) ||
			serialized.includes(TOKEN)
		)
			throw new TypeError("evidence report disclosed fixture source text or credentials");
		writeFileSync(join(outdir, "bundle-conformance.json"), serialized);
		return report;
	} finally {
		await miniflare.dispose();
	}
}

export function assertBundleConformance(report) {
	if (report.outbound.unexpectedUrls.length > 0) throw new TypeError("unexpected outbound escape");
	if (
		JSON.stringify(report.outbound.attemptedUrls) !== JSON.stringify(report.outbound.expectedUrls)
	)
		throw new TypeError("fixture outbound sequence changed");
	if (report.scenarios.discovery.status !== 200 || report.scenarios.quote.outcome !== "verified")
		throw new TypeError("bundle scenarios did not pass");
	if (report.bindings.d1Rows < 1 || report.bindings.r2ObjectCount < 1)
		throw new TypeError("D1/R2 bindings were not exercised");
}

async function assertStatus(response, status, scenario) {
	if (response.status !== status)
		throw new TypeError(`${scenario} returned ${response.status}: ${await response.text()}`);
}

function readCompatibilityDate(path) {
	const date = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(readFileSync(path, "utf8"))?.[1];
	if (date === undefined) throw new TypeError("missing Wrangler compatibility date");
	return date;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outdir = process.argv[2] ?? ".omo/evidence/issue-10/bundle-conformance";
	const report = await runBundleConformance(outdir);
	process.stdout.write(`${resolve(outdir, "bundle-conformance.json")} ${report.artifact.sha256}\n`);
}
