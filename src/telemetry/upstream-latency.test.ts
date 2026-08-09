import { describe, expect, it } from "vitest";
import type { CitationObservationStore } from "../cache/citation-observation-store.js";
import { createCourtListenerApi } from "../courtlistener/api.js";
import { createCourtListenerCaseLawApi } from "../courtlistener/case-law-api.js";
import { createCachedCitationGateway } from "../verification/cached-citation-gateway.js";
import {
	createCourtListenerAttemptTiming,
	createExecutionFactCollector,
} from "./execution-facts.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const QUERY = { normalizedCitation: "347 U.S. 483", page: 483, reporter: "U.S.", volume: 347 };

describe("CourtListener upstream latency", () => {
	it("records only elapsed outbound time for a cold CourtListener lookup", async () => {
		// Given: a deterministic monotonic clock around one actual CourtListener transport attempt.
		const collector = createExecutionFactCollector();
		const api = createCourtListenerApi({
			attemptTiming: createCourtListenerAttemptTiming(collector, scriptedClock([100, 137])),
			token: "fixture-token",
			transport: async () => new Response(null, { status: 404 }),
		});

		// When: the API performs its sole cold citation lookup.
		const result = await api.lookupCitation({ normalized: QUERY.normalizedCitation });

		// Then: the collector records the transport duration and no request data.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(collector.snapshot().upstreamLatencyMs).toBe(37);
	});

	it("leaves upstream latency absent when fresh durable evidence satisfies the request", async () => {
		// Given: a fresh citation cache entry whose upstream gateway must never run.
		const collector = createExecutionFactCollector();
		const gateway = createCachedCitationGateway({
			executionFacts: collector,
			now: () => NOW,
			ownerToken: () => "owner",
			store: freshCitationStore(),
			upstream: { lookup: async () => ({ kind: "indeterminate", reason: "upstream_unavailable" }) },
		});

		// When: verification reuses the durable citation observation.
		await gateway.lookup(QUERY);

		// Then: no synthetic outbound-latency measurement exists.
		expect(collector.snapshot().upstreamLatencyMs).toBeUndefined();
	});

	it("records elapsed outbound time when the CourtListener transport fails", async () => {
		// Given: a failing transport measured by a deterministic monotonic clock.
		const collector = createExecutionFactCollector();
		const api = createCourtListenerApi({
			attemptTiming: createCourtListenerAttemptTiming(collector, scriptedClock([8, 31])),
			token: "fixture-token",
			transport: async () => Promise.reject(new TypeError("fixture transport failure")),
		});

		// When: its one outbound CourtListener attempt rejects.
		const result = await api.lookupCitation({ normalized: QUERY.normalizedCitation });

		// Then: the failure remains classified and contributes its measured attempt duration.
		expect(result).toEqual({ kind: "unavailable", failure: "transport" });
		expect(collector.snapshot().upstreamLatencyMs).toBe(23);
	});

	it("sums citation usage and lookup transport attempts without parsing time", async () => {
		// Given: a citation flow that obtains usage before its lookup through the same collector.
		const collector = createExecutionFactCollector();
		const api = createCourtListenerApi({
			attemptTiming: createCourtListenerAttemptTiming(collector, scriptedClock([10, 15, 20, 32])),
			token: "fixture-token",
			transport: async () => new Response(null, { status: 404 }),
		});

		// When: the flow performs both outbound calls in sequence.
		await api.getUsage();
		await api.lookupCitation({ normalized: QUERY.normalizedCitation });

		// Then: the telemetry fact is their 5ms plus 12ms awaiting time only.
		expect(collector.snapshot().upstreamLatencyMs).toBe(17);
	});

	it("sums case-law cluster and opinion transport attempts", async () => {
		// Given: a quote-source flow with one cluster request and one trusted opinion request.
		const collector = createExecutionFactCollector();
		const api = createCourtListenerCaseLawApi({
			attemptTiming: createCourtListenerAttemptTiming(collector, scriptedClock([3, 9, 12, 27])),
			token: "fixture-token",
			transport: async () => new Response(null, { status: 404 }),
		});

		// When: it obtains both source records from CourtListener.
		await api.getCluster(123);
		await api.getOpinion("https://www.courtlistener.com/api/rest/v4/opinions/456/");

		// Then: all 6ms plus 15ms of actual outbound time is retained.
		expect(collector.snapshot().upstreamLatencyMs).toBe(21);
	});
});

function scriptedClock(values: readonly number[]): () => number {
	let index = 0;
	return () => {
		const value = values[index];
		index += 1;
		if (value === undefined) throw new RangeError("unexpected clock read");
		return value;
	};
}

function freshCitationStore(): CitationObservationStore {
	return {
		acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
		fillLease: async () => ({ kind: "lease_unavailable" }),
		purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
		read: async () => ({
			kind: "positive",
			positive: {
				cluster: { canonicalUrl: "https://www.courtlistener.com/opinion/123/example/", id: 123 },
				kind: "positive",
				retrievedAt: NOW,
			},
		}),
		releaseLease: async () => ({ kind: "released" }),
	};
}
