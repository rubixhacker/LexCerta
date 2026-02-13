import { describe, expect, it } from "vitest";
import type { OpinionText } from "../../clients/courtlistener";
import { OpinionCache } from "../opinion-cache";

function makeOpinion(id: number, text: string): OpinionText {
	return {
		opinionId: id,
		type: "010combined",
		plainText: text,
		clusterId: 100,
	};
}

describe("OpinionCache", () => {
	it("returns undefined on cache miss and increments missCount", () => {
		const cache = new OpinionCache();
		const result = cache.get(999);

		expect(result).toBeUndefined();
		expect(cache.stats().misses).toBe(1);
	});

	it("returns cached value on hit and increments hitCount", () => {
		const cache = new OpinionCache();
		const opinions = [makeOpinion(1, "Some opinion text")];

		cache.set(100, { opinions });
		const result = cache.get(100);

		expect(result).toBeDefined();
		expect(result?.opinions).toEqual(opinions);
		expect(cache.stats().hits).toBe(1);
	});

	it("respects max entries and evicts oldest", () => {
		const cache = new OpinionCache(2);

		cache.set(1, { opinions: [makeOpinion(1, "First")] });
		cache.set(2, { opinions: [makeOpinion(2, "Second")] });
		cache.set(3, { opinions: [makeOpinion(3, "Third")] });

		// Entry 1 should be evicted
		expect(cache.get(1)).toBeUndefined();
		expect(cache.get(3)).toBeDefined();
		expect(cache.stats().size).toBe(2);
	});

	it("clear resets size and counters", () => {
		const cache = new OpinionCache();
		cache.set(1, { opinions: [makeOpinion(1, "Text")] });
		cache.get(1); // hit
		cache.get(999); // miss

		cache.clear();

		const stats = cache.stats();
		expect(stats.size).toBe(0);
		expect(stats.hits).toBe(0);
		expect(stats.misses).toBe(0);
	});

	it("stats returns correct shape", () => {
		const cache = new OpinionCache(200);
		const stats = cache.stats();

		expect(stats).toEqual({
			size: 0,
			maxSize: 200,
			hits: 0,
			misses: 0,
		});
	});
});
