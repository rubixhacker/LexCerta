import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NodeOpinionNormalizer } from "../build/node/opinion-normalizer.js";
import { EvidenceRequest, MAX_SOURCE_BYTES } from "../build/verification/evidence-request.js";
import { verifyQuote } from "../build/verification/verify-quote.js";

// This qualifies bounded source processing, not the unimplemented HTTP service,
// database, GCS, authentication, real upstream latency, or Cloud Run deployment.
const cgroup = async (name) => (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
assert.equal(process.versions.node, "24.21.0");
assert.equal(await cgroup("memory.max"), "1073741824", "Run with a 1 GiB container limit");
const [quota, period] = (await cgroup("cpu.max")).split(" ").map(Number);
assert.equal(quota / period, 1, "Run with one CPU");
const pool = new NodeOpinionNormalizer();
const quote = "Equal justice under law applies to every person.";
const cluster = { id: 123, canonicalUrl: "https://www.courtlistener.com/opinion/123/fixture/" };
const urls = Array.from(
	{ length: 100 },
	(_, index) => `https://www.courtlistener.com/api/rest/v4/opinions/${index + 1}/`,
);
const citation = {
	lookup: async () => ({
		kind: "verified",
		cluster,
		freshness: "fresh",
		retrievedAt: new Date().toISOString(),
	}),
};
let maxWorkers = 0;
let maxQueued = 0;
let peakRss = 0;
const sample = setInterval(() => {
	maxWorkers = Math.max(maxWorkers, pool.state.workers);
	maxQueued = Math.max(maxQueued, pool.state.queued);
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 5);
const report = {
	version: 1,
	startedAt: new Date().toISOString(),
	node: process.version,
	boundary:
		"Eight simultaneous quote-verification calls with synthetic cached source gateways and the real normalizer pool, one CPU and 1 GiB; no HTTP, database, GCS or deployed proof",
	scenarios: [],
};
async function batch(name, count, source, expected) {
	const start = performance.now();
	const results = await Promise.all(
		Array.from({ length: 8 }, async (_, requestIndex) => {
			const request = new EvidenceRequest();
			let readCount = 0;
			const gateway = {
				readCluster: async () => ({
					kind: "found",
					cluster: { ...cluster, opinionUrls: urls.slice(0, count) },
				}),
				readOpinion: async () => {
					const index = readCount++;
					return {
						kind: "found",
						opinion: {
							id: index + 1,
							clusterId: cluster.id,
							canonicalUrl: cluster.canonicalUrl,
							text: source(index, requestIndex),
							freshness: "fresh",
							retrievedAt: new Date().toISOString(),
						},
					};
				},
			};
			try {
				const result = await verifyQuote({ citation: "347 U.S. 483", quote }, citation, gateway, {
					maxOpinions: 100,
					request,
					normalize: pool.normalize,
				});
				return {
					outcome: result.outcome,
					reason: result.reason ?? null,
					sourceBytes: request.sourceBytes,
					readCount,
				};
			} finally {
				request.close();
			}
		}),
	);
	const passed = results.every((result) => expected(result));
	report.scenarios.push({
		name,
		concurrency: 8,
		elapsedMs: performance.now() - start,
		passed,
		results,
	});
	if (!passed) process.exitCode = 1;
}
try {
	await batch(
		"large-html-last-opinion-match",
		2,
		(index, requestIndex) => ({
			html: `<p>Request ${requestIndex}</p>${"<p>Ordinary source language with no matching quotation in this passage.</p>".repeat(12_000)}${index === 1 ? `<p>${quote}</p>` : ""}`,
		}),
		(result) => result.outcome === "verified" && result.readCount === 2,
	);
	await batch(
		"aggregate-cached-source-limit",
		100,
		(_index, requestIndex) => ({ plain_text: String(requestIndex).repeat(MAX_SOURCE_BYTES) }),
		(result) =>
			result.outcome === "indeterminate" &&
			result.reason === "incomplete" &&
			result.readCount === 17,
	);
	await batch(
		"excessive-html-structure",
		1,
		() => ({ html: `${"<i>x</i>".repeat(30_000)}${quote}` }),
		(result) =>
			result.outcome === "indeterminate" && ["incomplete", "timeout"].includes(result.reason),
	);
	await batch(
		"deep-html-bounded-traversal",
		1,
		() => ({ html: `${"<span>".repeat(3_000)}${quote}${"</span>".repeat(3_000)}` }),
		(result) =>
			result.outcome === "verified" ||
			(result.outcome === "indeterminate" && ["incomplete", "timeout"].includes(result.reason)),
	);
	assert.ok(maxWorkers <= 2);
	assert.ok(maxQueued <= 6);
} finally {
	clearInterval(sample);
	await pool.close();
	report.finishedAt = new Date().toISOString();
	report.maxWorkers = maxWorkers;
	report.maxQueued = maxQueued;
	report.peakRssBytes = Math.max(peakRss, process.memoryUsage().rss);
	report.cgroupPeakBytes = Number(await cgroup("memory.peak"));
	report.cgroupMemoryEvents = await cgroup("memory.events");
	report.passed =
		report.scenarios.length === 4 &&
		report.scenarios.every((scenario) => scenario.passed) &&
		maxWorkers <= 2 &&
		maxQueued <= 6;
	console.log(JSON.stringify(report, null, 2));
}
