import { describe, expect, it } from "vitest";
import type { CitationMatch } from "../../clients/courtlistener.js";
import { CitationCache } from "../citation-cache.js";

function makeLookup(citation = "347 U.S. 483"): { matches: CitationMatch[] } {
	return {
		matches: [
			{
				citation,
				normalized_citations: [citation],
				start_index: 0,
				end_index: citation.length,
				status: 200,
				error_message: "",
				clusters: [
					{
						absolute_url: "/opinion/12345/test-case/",
						case_name: "Test Case",
						case_name_short: "Test",
						date_filed: "1954-05-17",
						docket: { court: "Supreme Court", court_id: "scotus" },
						citations: [{ volume: 347, reporter: "U.S.", page: "483" }],
					},
				],
			},
		],
	};
}

describe("CitationCache", () => {
	it("get() returns undefined for unknown key and increments misses", () => {
		const cache = new CitationCache();
		const result = cache.get("999 U.S. 999");

		expect(result).toBeUndefined();
		expect(cache.stats().misses).toBe(1);
		expect(cache.stats().hits).toBe(0);
	});

	it("set() then get() returns cached value and increments hits", () => {
		const cache = new CitationCache();
		const lookup = makeLookup();

		cache.set("347 U.S. 483", lookup);
		const result = cache.get("347 U.S. 483");

		expect(result).toEqual(lookup);
		expect(cache.stats().hits).toBe(1);
		expect(cache.stats().misses).toBe(0);
	});

	it("stats() reflects size, hits, misses correctly after operations", () => {
		const cache = new CitationCache();

		cache.set("347 U.S. 483", makeLookup("347 U.S. 483"));
		cache.set("410 U.S. 113", makeLookup("410 U.S. 113"));
		cache.get("347 U.S. 483"); // hit
		cache.get("410 U.S. 113"); // hit
		cache.get("999 U.S. 999"); // miss

		const stats = cache.stats();
		expect(stats.size).toBe(2);
		expect(stats.maxSize).toBe(1000);
		expect(stats.hits).toBe(2);
		expect(stats.misses).toBe(1);
	});

	it("clear() resets cache and counters", () => {
		const cache = new CitationCache();
		cache.set("347 U.S. 483", makeLookup());
		cache.get("347 U.S. 483"); // hit
		cache.get("999 U.S. 999"); // miss

		cache.clear();

		const stats = cache.stats();
		expect(stats.size).toBe(0);
		expect(stats.hits).toBe(0);
		expect(stats.misses).toBe(0);
		expect(cache.get("347 U.S. 483")).toBeUndefined();
	});

	it("LRU eviction: oldest entry evicted when max exceeded", () => {
		const cache = new CitationCache(2);

		cache.set("1 U.S. 1", makeLookup("1 U.S. 1"));
		cache.set("2 U.S. 2", makeLookup("2 U.S. 2"));
		cache.set("3 U.S. 3", makeLookup("3 U.S. 3"));

		expect(cache.get("1 U.S. 1")).toBeUndefined(); // evicted
		expect(cache.get("2 U.S. 2")).toBeDefined();
		expect(cache.get("3 U.S. 3")).toBeDefined();
		expect(cache.stats().size).toBe(2);
	});

	it("get() performance: 1000 lookups complete in under 50ms", () => {
		const cache = new CitationCache();
		cache.set("347 U.S. 483", makeLookup());

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			cache.get("347 U.S. 483");
		}
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(50);
	});
});
