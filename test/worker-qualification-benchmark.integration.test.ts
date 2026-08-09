import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_BODY_BYTES } from "../src/courtlistener/response-body.js";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const MAX_CLUSTER_OPINIONS = 100;
const QUOTE_10K = "q".repeat(10_000);
const BENCHMARK_MARKER = "WORKER_QUALIFICATION_BENCHMARK=";
const CLUSTER_URL = "https://www.courtlistener.com/api/rest/v4/clusters/108713/";
const MAX_RESPONSE_PREFIX = "<p>";
const MAX_RESPONSE_SUFFIX = "</p>";

type BenchmarkRecord = {
	readonly behavior: "not_found" | "verified";
	readonly cancelledOutboundCount: number;
	readonly codePoints: number;
	readonly d1StateRows: number;
	readonly opinionOutboundCount: number;
	readonly r2ObjectCount: number;
	readonly responseBytes: number;
	readonly scenario: string;
	readonly totalOutboundCount: number;
	readonly wallMilliseconds: number;
};

afterEach(() => vi.unstubAllGlobals());

describe("workerd worker qualification benchmark", () => {
	it("qualifies a cold 10,000-code-point no-match against the complete 100-opinion cluster", async () => {
		// Given: a synthetic 100-opinion cluster with no source text matching the boundary quotation.
		const opinions = maximalOpinionFixtures(10_000);
		expect(opinionResponseBytes(opinions[0]?.bodyFactory?.())).toBe(MAX_RESPONSE_BODY_BYTES);
		const fixture = await setupQuoteWorker({ opinions, usage: "high" });

		// When: the real workerd Worker receives the largest valid quote-verification request cold.
		const startedAt = performance.now();
		const response = await SELF.fetch(fixture.request(QUOTE_10K));
		const responseBody = await response.text();
		const wallMilliseconds = performance.now() - startedAt;

		// Then: complete absence is reported only after every synthetic source is cached in D1/R2.
		expect(response.status).toBe(200);
		expect(responseBody).toContain('"outcome":"not_found"');
		expect(fixture.outbound).toHaveLength(103);
		await emitRecord({
			behavior: "not_found",
			fixture,
			cancelledOutboundStart: 0,
			outboundStart: 0,
			responseBody,
			scenario: "cold_no_match_10000cp_100op",
			wallMilliseconds,
		});
	}, 30_000);

	it("qualifies a cold D1/R2 fill for a 10,000-code-point late match in the complete 100-opinion cluster", async () => {
		// Given: a synthetic 100-opinion cluster whose final source is the only exact match.
		const opinions = maximalOpinionFixtures(20_000, QUOTE_10K);
		expect(opinionResponseBytes(opinions[MAX_CLUSTER_OPINIONS - 1]?.bodyFactory?.())).toBe(
			MAX_RESPONSE_BODY_BYTES,
		);
		const fixture = await setupQuoteWorker({ opinions, usage: "high" });

		// When: the real Worker fills durable evidence by finding the exact match only in the final source.
		const startedAt = performance.now();
		const response = await SELF.fetch(fixture.request(QUOTE_10K));
		const responseBody = await response.text();
		const wallMilliseconds = performance.now() - startedAt;

		// Then: the cold complete search verifies after 103 fixture-only outbound requests.
		expect(response.status).toBe(200);
		expect(responseBody).toContain('"outcome":"verified"');
		expect(fixture.outbound).toHaveLength(103);
		await emitRecord({
			behavior: "verified",
			fixture,
			cancelledOutboundStart: 0,
			outboundStart: 0,
			responseBody,
			scenario: "cold_late_match_10000cp_100op",
			wallMilliseconds,
		});
	}, 30_000);

	it("qualifies warm D1/R2 reuse for a 10,000-code-point late match in the complete 100-opinion cluster", async () => {
		// Given: synthetic durable evidence filled by a first late-match request over the maximum cluster.
		const opinions = maximalOpinionFixtures(30_000, QUOTE_10K);
		expect(opinionResponseBytes(opinions[MAX_CLUSTER_OPINIONS - 1]?.bodyFactory?.())).toBe(
			MAX_RESPONSE_BODY_BYTES,
		);
		const fixture = await setupQuoteWorker({ opinions, usage: "high" });
		await SELF.fetch(fixture.request(QUOTE_10K));
		const warmOutboundStart = fixture.outbound.length;
		const warmCancelledOutboundStart = fixture.cancelledOutboundCount();

		// When: the real Worker repeats the request with the same durable D1/R2 state.
		const startedAt = performance.now();
		const response = await SELF.fetch(fixture.request(QUOTE_10K));
		const responseBody = await response.text();
		const wallMilliseconds = performance.now() - startedAt;

		// Then: warm reuse verifies without a second opinion fetch and only the quota refresh remains.
		expect(response.status).toBe(200);
		expect(responseBody).toContain('"outcome":"verified"');
		expect(fixture.outbound.length - warmOutboundStart).toBe(1);
		await emitRecord({
			behavior: "verified",
			fixture,
			cancelledOutboundStart: warmCancelledOutboundStart,
			outboundStart: warmOutboundStart,
			responseBody,
			scenario: "warm_reuse_late_match_10000cp_100op",
			wallMilliseconds,
		});
	}, 30_000);
});

async function emitRecord(input: {
	readonly behavior: BenchmarkRecord["behavior"];
	readonly cancelledOutboundStart: number;
	readonly fixture: Awaited<ReturnType<typeof setupQuoteWorker>>;
	readonly outboundStart: number;
	readonly responseBody: string;
	readonly scenario: string;
	readonly wallMilliseconds: number;
}): Promise<void> {
	const responseBytes = new TextEncoder().encode(input.responseBody).byteLength;
	const outbound = input.fixture.outbound.slice(input.outboundStart);
	const opinionOutboundCount = outbound.filter((request) =>
		new URL(request.url).pathname.includes("/opinions/"),
	).length;
	const cancelledOutboundCount =
		input.fixture.cancelledOutboundCount() - input.cancelledOutboundStart;
	const d1StateRows = await countRows("opinion_source_states");
	const r2ObjectCount = (await env.OPINION_CACHE.list()).objects.length;
	const record: BenchmarkRecord = {
		behavior: input.behavior,
		cancelledOutboundCount,
		codePoints: Array.from(QUOTE_10K).length,
		d1StateRows,
		opinionOutboundCount,
		r2ObjectCount,
		responseBytes,
		scenario: input.scenario,
		totalOutboundCount: outbound.length,
		wallMilliseconds: input.wallMilliseconds,
	};
	console.log(`${BENCHMARK_MARKER}${JSON.stringify(record)}`);
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

async function countRows(table: "opinion_source_states"): Promise<number> {
	const result = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
		readonly count: number;
	}>();
	if (result === null) throw new TypeError(`missing count for ${table}`);
	return result.count;
}

function maximalOpinionFixtures(
	firstId: number,
	finalQuote = "",
): readonly {
	readonly bodyFactory: () => Record<string, unknown>;
	readonly id: number;
}[] {
	return Array.from({ length: MAX_CLUSTER_OPINIONS }, (_, index) => {
		const id = firstId + index;
		return {
			bodyFactory: () =>
				maximalOpinionBody(id, index === MAX_CLUSTER_OPINIONS - 1 ? finalQuote : ""),
			id,
		};
	});
}

function maximalOpinionBody(id: number, quote: string): Record<string, unknown> {
	const shortHtml = `${MAX_RESPONSE_PREFIX}${quote}${MAX_RESPONSE_SUFFIX}`;
	const fixed = { cluster: CLUSTER_URL, html_with_citations: shortHtml, id };
	const filler = "x".repeat(MAX_RESPONSE_BODY_BYTES - opinionResponseBytes(fixed));
	const body = {
		cluster: CLUSTER_URL,
		html_with_citations: `${MAX_RESPONSE_PREFIX}${filler}${quote}${MAX_RESPONSE_SUFFIX}`,
		id,
	};
	if (opinionResponseBytes(body) !== MAX_RESPONSE_BODY_BYTES)
		throw new TypeError("maximal opinion fixture does not reach the response bound");
	return body;
}

function opinionResponseBytes(body: Record<string, unknown> | undefined): number {
	if (body === undefined) throw new TypeError("missing benchmark opinion body");
	return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}
