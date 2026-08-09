import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const MATCH = "QUOTE_SENTINEL: equal justice under law.";

afterEach(() => vi.unstubAllGlobals());

describe("Issue 7 quote outcomes through real workerd bindings", () => {
	it("classifies a trusted empty cluster as source text unavailable", async () => {
		// Given: CourtListener returns a complete cluster with zero sub-opinions.
		const fixture = await setupQuoteWorker({ opinions: [] });

		// When: verify_quote traverses the direct cluster boundary.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: no opinion request is attempted and the public reason is source_text_unavailable.
		expect(body).toContain('"reason":"source_text_unavailable"');
		expect(fixture.outbound.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
	});

	it("searches every opinion before a complete not_found result", async () => {
		// Given: a two-opinion cluster whose selected sources have no matching canonical text.
		const fixture = await setupQuoteWorker({ opinions: [{ id: 2201 }, { id: 2202 }] });

		// When: verify_quote traverses the cluster through the coordinator.
		const response = await SELF.fetch(fixture.request(MATCH));

		// Then: no-match is returned only after both source opinions are read once.
		const body = JSON.stringify(await response.json());
		expect(body).toContain('"outcome":"not_found"');
		expect(body).toContain('"searchedOpinionCount":2');
		expect(body).toContain('"searchComplete":true');
		expect(fixture.outbound.map((request) => request.method)).toEqual([
			"GET",
			"POST",
			"GET",
			"GET",
			"GET",
		]);
	});

	it("stops at a later normalized match without source leakage or retry", async () => {
		// Given: the second opinion contains the requested quote only after entity and whitespace canonicalization.
		const fixture = await setupQuoteWorker({
			opinions: [
				{ id: 2201 },
				{
					id: 2202,
					body: {
						id: 2202,
						cluster: "https://www.courtlistener.com/api/rest/v4/clusters/108713/",
						html_with_citations: "<p>QUOTE_SENTINEL: equal&nbsp;justice under law.</p>",
						html: "<p>incorrect fallback</p>",
					},
				},
			],
		});

		// When: the Worker performs the quote verification.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: the second opinion verifies with the preferred representation after five total transmissions.
		expect(body).toContain('"outcome":"verified"');
		expect(body).toContain('"id":2202');
		expect(body).toContain('"representation":"html_with_citations"');
		expect(body).not.toContain(MATCH);
		expect(fixture.outbound).toHaveLength(5);
	});

	it.each([
		{
			expected: "source_text_unavailable",
			opinion: {
				body: { id: 2201, cluster: "https://www.courtlistener.com/api/rest/v4/clusters/108713/" },
				id: 2201,
			},
		},
		{ expected: "upstream_unavailable", opinion: { id: 2201, status: 503 } },
		{ expected: "incomplete", opinion: { id: 2201, status: 404 } },
		{ expected: "rate_limited", opinion: { id: 2201, status: 429 } },
	] as const)(
		"returns $expected after one failed source request without retry",
		async ({ expected, opinion }) => {
			// Given: a single required opinion has no text, a 5xx, or an explicit rate limit.
			const fixture = await setupQuoteWorker({ opinions: [opinion] });

			// When: the real Worker makes its one admitted source attempt.
			const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

			// Then: the sanitized indeterminate result preserves the failure class and makes no retry.
			expect(body).toContain(`"reason":"${expected}"`);
			expect(fixture.outbound).toHaveLength(4);
		},
	);

	it("does not begin citation or source requests when quota synchronization is blocked", async () => {
		// Given: CourtListener's durable quota snapshot reports all relevant budget windows blocked.
		const fixture = await setupQuoteWorker({ opinions: [{ id: 2201 }], usage: "blocked" });

		// When: an otherwise valid quote request enters the Worker.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: only the quota snapshot is transmitted and the citation source remains untouched.
		expect(body).toContain('"reason":"quota_unknown"');
		expect(fixture.outbound).toHaveLength(1);
	});

	it.each([
		{ count: 100, expected: "not_found", requests: 103 },
		{ count: 101, expected: "incomplete", requests: 3 },
	] as const)(
		"enforces the cluster source bound at $count opinions",
		async ({ count, expected, requests }) => {
			const fixture = await setupQuoteWorker({
				opinions: Array.from({ length: count }, (_, index) => ({ id: 2201 + index })),
				...(count === 100 ? { usage: "high" as const } : {}),
			});
			const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());
			expect(body).toContain(
				`\"${expected === "not_found" ? "outcome" : "reason"}\":\"${expected}\"`,
			);
			expect(fixture.outbound).toHaveLength(requests);
		},
	);
});
