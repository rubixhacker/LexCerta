import { describe, expect, it } from "vitest";
import type { CitationObservationStore } from "../cache/citation-observation-store.js";
import { createCachedCitationGateway } from "../verification/cached-citation-gateway.js";
import { createExecutionFactCollector } from "./execution-facts.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const QUERY = { normalizedCitation: "347 U.S. 483", page: 483, reporter: "U.S.", volume: 347 };

describe("execution fact propagation", () => {
	it("reports a cold citation lookup as a cache miss after the upstream fill succeeds", async () => {
		// Given: an empty durable cache with a successful source observation ready to publish.
		const collector = createExecutionFactCollector();
		const gateway = createCachedCitationGateway({
			executionFacts: collector,
			now: () => NOW,
			ownerToken: () => "owner",
			store: coldCitationStore(),
			upstream: {
				lookup: async () => ({
					cluster: {
						canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
						id: 123,
					},
					freshness: "fresh",
					kind: "verified",
					retrievedAt: NOW.toISOString(),
				}),
			},
		});

		// When: the cache miss fetches and persists one verified citation observation.
		const result = await gateway.lookup(QUERY);

		// Then: the request remains a cache miss, even though the next request can reuse the fill.
		expect(result).toMatchObject({ kind: "verified" });
		expect(collector.snapshot()).toMatchObject({
			cacheStatus: "miss",
			freshness: "not_applicable",
		});
	});
});

function coldCitationStore(): CitationObservationStore {
	return {
		acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
		fillLease: async (input) => {
			if (input.observation.kind === "negative") {
				return {
					kind: "stored" as const,
					observation: {
						kind: "negative" as const,
						negative: { kind: "negative" as const, retrievedAt: input.now },
						superseded: null,
					},
				};
			}
			return {
				kind: "stored" as const,
				observation: {
					kind: "positive" as const,
					positive: { ...input.observation, retrievedAt: input.now },
				},
			};
		},
		purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
		read: async () => null,
		releaseLease: async () => ({ kind: "released" }),
	};
}
