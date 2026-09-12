import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { NodeOpinionNormalizer } from "../build/node/opinion-normalizer.js";
import { createPostgresFixture } from "../test/postgres/fixture.mjs";
import { CorpusReplayFixture } from "./corpus-replay-fixture.mjs";
import { syntheticVectors } from "./corpus-synthetic.mjs";

const { values } = parseArgs({
	options: {
		split: { type: "string", default: "development" },
		report: { type: "string" },
	},
});
assert.ok(
	["development", "holdout", "all"].includes(values.split),
	"Select development, holdout, or all",
);
assert.ok(values.report, "--report is required; existing reports are never overwritten");
assert.equal(syntheticVectors.length, 40);
for (const [outcome, count] of [
	["verified", 8],
	["not_found", 8],
	["indeterminate", 24],
])
	assert.equal(syntheticVectors.filter((vector) => vector.expected === outcome).length, count);

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const corpusRoot = new URL("../operations/qualification/corpus-2026-09-12/", import.meta.url);
const source = gunzipSync(await readFile(new URL("frozen/cases.jsonl.gz", corpusRoot)), {
	maxOutputLength: 8 * 1024 * 1024,
});
const sourceSha = sha(source);
assert.equal(sourceSha, "8375df8bb49c95b4cbc7090e375359165c0a2079dd20171d033e5b73ccdf8faa");
const annotationsBytes = await readFile(new URL("annotations.json", corpusRoot));
const annotations = JSON.parse(annotationsBytes).cases;
const cases = source
	.toString("utf8")
	.trimEnd()
	.split("\n")
	.map(JSON.parse)
	.filter((item) => values.split === "all" || item.split === values.split);
assert.equal(cases.length, values.split === "all" ? 60 : values.split === "holdout" ? 20 : 40);
const realVectors = cases.flatMap((item) => {
	const annotation = annotations.find((record) => record.clusterId === item.id);
	assert.ok(annotation);
	const base = {
		kind: "real-source",
		clusterId: item.id,
		citation: item.citation,
		canonicalUrl: item.canonicalUrl,
		split: item.split,
		stratum: item.stratum,
		attributes: item.attributes,
		matchingOpinionIds: annotation.matchingOpinionIds,
		// COLD exports plaintext, including literal entity spellings. These are
		// simulated plain_text envelopes, never claimed as captured API fields.
		opinions: item.opinions.map((opinion) => ({
			id: opinion.id,
			fields: { plain_text: opinion.text },
		})),
	};
	return [
		{
			...base,
			id: `${item.id}-citation`,
			category: "citation",
			tool: "verify_citation",
			expected: "verified",
		},
		{
			...base,
			id: `${item.id}-exact`,
			category: "exact-quote",
			quote: annotation.exactQuote,
			expected: "verified",
		},
		{
			...base,
			id: `${item.id}-altered`,
			category: "altered-quote",
			quote: annotation.alteredQuote,
			expected: "not_found",
		},
	];
});
const vectors = [...realVectors, ...(values.split === "holdout" ? [] : syntheticVectors)];
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trimEnd();
const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
	.split("\0")
	.filter((path) =>
		/^(src\/|scripts\/|test\/|database\/|package(?:-lock)?\.json$|tsconfig.*\.json$)/.test(path),
	);
const sourceFiles = await Promise.all(
	[...new Set(files)].sort().map(async (path) => ({ path, sha256: sha(await readFile(path)) })),
);
const compiledFiles = await Promise.all(
	(await readdir("build", { recursive: true }))
		.filter((path) => path.endsWith(".js"))
		.sort()
		.map(async (path) => ({ path: `build/${path}`, sha256: sha(await readFile(`build/${path}`)) })),
);
const report = {
	version: 1,
	status: "running",
	startedAt: new Date().toISOString(),
	split: values.split,
	boundary: {
		source: "Frozen real COLD plaintext and separately labelled invented contract records",
		upstream:
			"Simulated minimal CourtListener API envelopes; zero network fallback or live upstream attempts",
		storage:
			"Real local PostgreSQL 18 with fixture GCS generation storage and synthetic quota capacity",
		protocol:
			"Actual stateless SDK MCP handler invoked in process; no public HTTP service, authentication, Cloud Run, or external client proof",
		cache:
			"Fresh database; each case runs citation, exact quote, then altered quote sequentially, sharing its cache",
		memory:
			"Local process RSS including normalizer threads; not constrained-container or deployed capacity qualification",
	},
	provenance: {
		sourceSha256: sourceSha,
		annotationsSha256: sha(annotationsBytes),
		implementationHead: git("rev-parse", "HEAD"),
		implementationTree: git("rev-parse", "HEAD^{tree}"),
		workingTreeDirty: git("status", "--porcelain").length > 0,
		sourceFilesSha256: sha(JSON.stringify(sourceFiles)),
		sourceFiles,
		compiledFilesSha256: sha(JSON.stringify(compiledFiles)),
		compiledFiles,
		node: process.version,
		platform: process.platform,
		architecture: process.arch,
	},
	vectorCount: vectors.length,
	results: [],
};
// Reserve a new report before execution, preserving failed and first runs.
const output = await open(values.report, "wx");
await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
const normalizer = new NodeOpinionNormalizer();
let database;
let peakRssBytes = process.memoryUsage().rss;
const sampler = setInterval(() => {
	peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 10);
try {
	database = await createPostgresFixture();
	const replay = new CorpusReplayFixture(database, normalizer.normalize);
	for (const vector of vectors) {
		try {
			report.results.push(await replay.replay(vector));
		} catch (error) {
			// Never serialize an upstream body, submitted quote, SQL, or connection string.
			report.results.push({
				id: vector.id,
				kind: vector.kind,
				category: vector.category,
				split: vector.split ?? "synthetic",
				clusterId: vector.clusterId,
				stratum: vector.stratum ?? null,
				expected: vector.expected,
				outcome: "harness_error",
				passed: false,
				evidenceCorrect: false,
				errorType: error instanceof Error ? error.name : "unknown",
			});
		}
	}
	const tally = (rows) => ({
		total: rows.length,
		passed: rows.filter((row) => row.passed).length,
		verified: rows.filter((row) => row.outcome === "verified").length,
		notFound: rows.filter((row) => row.outcome === "not_found").length,
		indeterminate: rows.filter((row) => row.outcome === "indeterminate").length,
		errors: rows.filter((row) => !["verified", "not_found", "indeterminate"].includes(row.outcome))
			.length,
	});
	const real = report.results.filter((row) => row.kind === "real-source");
	const synthetic = report.results.filter((row) => row.kind === "synthetic");
	const classCounts = Object.fromEntries(
		["citation", "exact-quote", "altered-quote"].map((category) => [
			category,
			tally(real.filter((row) => row.category === category)),
		]),
	);
	const falsePositives = report.results.filter(
		(row) => row.outcome === "verified" && (row.expected !== "verified" || !row.evidenceCorrect),
	);
	const falseDefinitiveNegatives = report.results.filter(
		(row) => row.outcome === "not_found" && (row.expected !== "not_found" || !row.evidenceCorrect),
	);
	report.summary = {
		...tally(report.results),
		classCounts,
		synthetic: tally(synthetic),
		falsePositiveIds: falsePositives.map((row) => row.id),
		falseDefinitiveNegativeIds: falseDefinitiveNegatives.map((row) => row.id),
		strata: Object.fromEntries(
			["scotus", "federal", "state"].map((stratum) => [
				stratum,
				tally(real.filter((row) => row.stratum === stratum)),
			]),
		),
		attributes: Object.fromEntries(
			["ocr", "multipleOpinions", "post2018", "over64KiB"].map((attribute) => [
				attribute,
				tally(real.filter((row) => row.attributes?.[attribute])),
			]),
		),
		abstentionIds: real.filter((row) => row.outcome === "indeterminate").map((row) => row.id),
		failureIds: report.results.filter((row) => !row.passed).map((row) => row.id),
		maxElapsedMs: Math.max(...report.results.map((row) => row.elapsedMs ?? 0)),
	};
	const minimumPerClass = Math.ceil(cases.length * 0.95);
	report.gate = {
		minimumPerClass,
		passed:
			falsePositives.length === 0 &&
			falseDefinitiveNegatives.length === 0 &&
			synthetic.every((row) => row.passed) &&
			report.summary.errors === 0 &&
			Object.values(classCounts).every((count) => count.passed >= minimumPerClass),
		fullCorpusGate: values.split === "all",
		liveQualificationObserved: false,
	};
	report.status = "completed";
	if (!report.gate.passed) process.exitCode = 1;
} catch (error) {
	report.status = "harness_failed";
	report.errorType = error instanceof Error ? error.name : "unknown";
	process.exitCode = 1;
} finally {
	clearInterval(sampler);
	await normalizer.close();
	await database?.close();
	report.peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
	report.finishedAt = new Date().toISOString();
	await output.truncate(0);
	await output.write(`${JSON.stringify(report, null, 2)}\n`, 0, "utf8");
	await output.close();
}
console.log(
	JSON.stringify({
		status: report.status,
		split: report.split,
		summary: report.summary,
		gate: report.gate,
		report: values.report,
	}),
);
