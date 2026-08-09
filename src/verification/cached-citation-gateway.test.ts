import { describe, expect, it } from "vitest";
import type { CitationObservationStore } from "../cache/citation-observation-store.js";
import { DEFAULT_CITATION_SOURCE_CACHE_POLICY } from "./citation-source-cache.js";
import { createCachedCitationGateway } from "./cached-citation-gateway.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const RETRIEVED_AT = new Date(
	NOW.getTime() - DEFAULT_CITATION_SOURCE_CACHE_POLICY.positiveFreshnessMs,
);

function stalePositiveStore(): CitationObservationStore {
	return {
		read: async () => ({
			kind: "positive",
			positive: {
				kind: "positive",
				cluster: {
					id: 123,
					canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
				},
				retrievedAt: RETRIEVED_AT,
			},
		}),
		acquireLease: async () => {
			throw new Error("D1 unavailable");
		},
		fillLease: async () => ({ kind: "lease_unavailable" }),
		purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
		releaseLease: async () => ({ kind: "lease_unavailable" }),
	};
}

describe("cached citation gateway", () => {
	it("rechecks after acquiring a lease before deciding to call upstream", async () => {
		// Given: another owner filled and released the cache between this caller's first read and lease acquisition.
		let reads = 0;
		let releases = 0;
		const gateway = createCachedCitationGateway({
			now: () => NOW,
			ownerToken: () => "late-owner",
			store: {
				...stalePositiveStore(),
				read: async () => {
					reads += 1;
					return reads === 1
						? null
						: {
								kind: "positive",
								positive: {
									kind: "positive",
									cluster: {
										id: 456,
										canonicalUrl: "https://www.courtlistener.com/opinion/456/example/",
									},
									retrievedAt: NOW,
								},
							};
				},
				acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
				releaseLease: async () => {
					releases += 1;
					return { kind: "released" };
				},
			},
			upstream: {
				lookup: async () => {
					throw new Error("upstream must not run");
				},
			},
		});

		// When: the caller owns the lease after the first owner has completed its fill.
		const result = await gateway.lookup({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalizedCitation: "347 U.S. 483",
		});

		// Then: the durable fill wins and the unnecessary lease is released without an upstream request.
		expect(result).toMatchObject({ kind: "verified", freshness: "fresh", cluster: { id: 456 } });
		expect(releases).toBe(1);
	});

	it("rechecks a durable fill for a held lease without calling upstream", async () => {
		// Given: a waiter whose second D1 read sees the owner-filled positive state.
		let reads = 0;
		const gateway = createCachedCitationGateway({
			now: () => NOW,
			ownerToken: () => "waiter",
			store: {
				...stalePositiveStore(),
				read: async () => {
					reads += 1;
					return reads === 1
						? null
						: {
								kind: "positive",
								positive: {
									kind: "positive",
									cluster: {
										id: 456,
										canonicalUrl: "https://www.courtlistener.com/opinion/456/example/",
									},
									retrievedAt: NOW,
								},
							};
				},
				acquireLease: async () => ({ kind: "held", expiresAt: "2026-08-09T12:00:10.000Z" }),
			},
			upstream: {
				lookup: async () => {
					throw new Error("upstream must not run");
				},
			},
			waitForFill: async () => undefined,
		});

		// When: the bounded waiter rechecks after the lease owner fills D1.
		const result = await gateway.lookup({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalizedCitation: "347 U.S. 483",
		});

		// Then: it returns the filled evidence without a duplicate source request.
		expect(result).toMatchObject({ kind: "verified", freshness: "fresh", cluster: { id: 456 } });
	});

	it("observes an owner fill after the initial held-lease recheck delay", async () => {
		// Given: the held lease remains valid while its owner needs two recheck delays to fill D1.
		let currentTime = NOW;
		let filled = false;
		let upstreamCalls = 0;
		const waitDurations: number[] = [];
		const gateway = createCachedCitationGateway({
			now: () => currentTime,
			ownerToken: () => "waiter",
			store: {
				...stalePositiveStore(),
				read: async () =>
					filled
						? {
								kind: "positive",
								positive: {
									kind: "positive",
									cluster: {
										id: 456,
										canonicalUrl: "https://www.courtlistener.com/opinion/456/example/",
									},
									retrievedAt: currentTime,
								},
							}
						: null,
				acquireLease: async () => ({ kind: "held", expiresAt: "2026-08-09T12:00:00.200Z" }),
			},
			upstream: {
				lookup: async () => {
					upstreamCalls += 1;
					return { kind: "not_found", retrievedAt: currentTime.toISOString() };
				},
			},
			waitForFill: async (delayMilliseconds) => {
				waitDurations.push(delayMilliseconds);
				currentTime = new Date(currentTime.getTime() + delayMilliseconds);
				filled = waitDurations.length === 2;
			},
		});

		// When: the owner stores fresh evidence after more than one 50 ms recheck interval.
		const result = await gateway.lookup({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalizedCitation: "347 U.S. 483",
		});

		// Then: the waiter returns the owner fill and never duplicates the upstream request.
		expect(result).toMatchObject({ kind: "verified", freshness: "fresh", cluster: { id: 456 } });
		expect(waitDurations).toEqual([50, 100]);
		expect(upstreamCalls).toBe(0);
	});

	it("fails closed when a held lease expires without an owner fill", async () => {
		// Given: a held cache-miss lease whose owner never fills before its recorded expiry.
		let currentTime = NOW;
		const waitDurations: number[] = [];
		let upstreamCalls = 0;
		const gateway = createCachedCitationGateway({
			now: () => currentTime,
			ownerToken: () => "waiter",
			store: {
				...stalePositiveStore(),
				read: async () => null,
				acquireLease: async () => ({ kind: "held", expiresAt: "2026-08-09T12:00:00.300Z" }),
			},
			upstream: {
				lookup: async () => {
					upstreamCalls += 1;
					return { kind: "not_found", retrievedAt: currentTime.toISOString() };
				},
			},
			waitForFill: async (delayMilliseconds) => {
				waitDurations.push(delayMilliseconds);
				currentTime = new Date(currentTime.getTime() + delayMilliseconds);
			},
		});

		// When: the waiter reaches the held lease expiry without observing a durable fill.
		const result = await gateway.lookup({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalizedCitation: "347 U.S. 483",
		});

		// Then: it stops at the lease deadline and reports only an unavailable verification outcome.
		expect(result).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
		expect(waitDurations).toEqual([50, 100, 150]);
		expect(upstreamCalls).toBe(0);
	});

	it("retains stale positive provenance when the D1 lease acquisition fails", async () => {
		// Given: a retained positive that needs revalidation but whose D1 lease cannot be acquired.
		const gateway = createCachedCitationGateway({
			now: () => NOW,
			ownerToken: () => "owner",
			store: stalePositiveStore(),
			upstream: { lookup: async () => ({ kind: "indeterminate", reason: "upstream_unavailable" }) },
		});

		// When: a caller asks for the stale citation.
		const result = await gateway.lookup({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalizedCitation: "347 U.S. 483",
		});

		// Then: only explicit stale evidence with its original retrieval time is returned.
		expect(result).toEqual({
			kind: "verified",
			cluster: {
				id: 123,
				canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
			},
			freshness: "stale",
			retrievedAt: RETRIEVED_AT.toISOString(),
		});
	});

	it("retains stale positive provenance when the lease expires before fill", async () => {
		// Given: a lease owner that gets a successful source observation but loses its lease before storing it.
		const store = stalePositiveStore();
		const gateway = createCachedCitationGateway({
			now: () => NOW,
			ownerToken: () => "owner",
			store: {
				...store,
				acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
			},
			upstream: {
				lookup: async () => ({ kind: "not_found", retrievedAt: NOW.toISOString() }),
			},
		});

		// When: the owner loses its lease while filling the successful source observation.
		const result = await gateway.lookup({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalizedCitation: "347 U.S. 483",
		});

		// Then: it cannot accept the reversal and retains only the known stale positive.
		expect(result).toMatchObject({
			kind: "verified",
			freshness: "stale",
			retrievedAt: RETRIEVED_AT.toISOString(),
		});
	});
});
