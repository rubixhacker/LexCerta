import { describe, expect, it } from "vitest";
import type { CitationObservationStore } from "../cache/citation-observation-store.js";
import type { OpinionSourceStore } from "../cache/opinion-source-store.js";
import type { CourtListenerApi } from "../courtlistener/api.js";
import type { CourtListenerCoordinatorRpc } from "../courtlistener/coordinator.js";
import type { BudgetDecision } from "../courtlistener/budget-contract.js";
import { initialCourtListenerBudgetState } from "../courtlistener/budget.js";
import { requestCaseLaw } from "../courtlistener/case-law-admission.js";
import { createCourtListenerCitationGateway } from "../courtlistener/gateway.js";
import { readCachedCaseLawOpinion } from "../courtlistener/case-law-opinion-source.js";
import { createCachedCitationGateway } from "../verification/cached-citation-gateway.js";
import { createExecutionFactCollector } from "./execution-facts.js";

describe("execution fact collector", () => {
	it("starts without unobserved cache, circuit, or upstream activity", () => {
		// Given: a new request-scoped collector before verification starts.
		const collector = createExecutionFactCollector();

		// When: the request finishes without reaching an evidence-source gateway.
		const facts = collector.snapshot();

		// Then: telemetry has no invented execution claims.
		expect(facts).toEqual({
			cacheStatus: "not_used",
			circuitStatus: "not_called",
			freshness: "not_applicable",
			upstreamStatus: "not_called",
		});
	});

	it("retains only the latest bounded evidence-source facts", () => {
		// Given: one request that reads stale cache evidence, then revalidates it successfully.
		const collector = createExecutionFactCollector();
		collector.observe({ kind: "cache", status: "hit", freshness: "stale" });
		collector.observe({ kind: "circuit", status: "closed" });
		collector.observe({ kind: "upstream", status: "success" });

		// When: a later source observation detects a retained-evidence contradiction.
		collector.observe({
			kind: "cache",
			status: "source_changed",
			freshness: "source_changed",
		});

		// Then: the snapshot is a fixed, identifier-free telemetry projection.
		expect(collector.snapshot()).toEqual({
			cacheStatus: "source_changed",
			circuitStatus: "closed",
			freshness: "source_changed",
			upstreamStatus: "success",
		});
	});

	it("keeps a cold-cache miss after a successful cache fill", () => {
		// Given: an empty durable cache followed by successful publication of the fetched evidence.
		const collector = createExecutionFactCollector();
		collector.observe({ kind: "cache", status: "miss", freshness: "not_applicable" });

		// When: the source-cache adapter reports the just-published fresh record.
		collector.observe({ kind: "cache", status: "hit", freshness: "fresh" });

		// Then: telemetry reports the actual cold request path rather than a synthetic cache hit.
		expect(collector.snapshot()).toMatchObject({
			cacheStatus: "miss",
			freshness: "not_applicable",
		});
	});

	it("observes a durable citation cache hit without exposing its evidence", async () => {
		// Given: fresh durable citation metadata and an observer scoped to this verification call.
		const collector = createExecutionFactCollector();
		const gateway = createCachedCitationGateway({
			executionFacts: collector,
			now: () => new Date("2026-08-09T12:00:00.000Z"),
			ownerToken: () => "owner",
			store: freshCitationStore(),
			upstream: { lookup: async () => ({ kind: "indeterminate", reason: "upstream_unavailable" }) },
		});

		// When: citation verification returns the retained fresh observation.
		await gateway.lookup({
			normalizedCitation: "347 U.S. 483",
			page: 483,
			reporter: "U.S.",
			volume: 347,
		});

		// Then: telemetry learns only that the cache was a fresh hit.
		expect(collector.snapshot()).toMatchObject({
			cacheStatus: "hit",
			freshness: "fresh",
			upstreamStatus: "not_called",
		});
	});

	it.each([
		[{ kind: "matched", clusters: [], normalizedCitation: "347 U.S. 483" }, "malformed_response"],
		[{ kind: "absent", normalizedCitation: "347 U.S. 483" }, "success"],
		[{ kind: "rate_limited" }, "rate_limited"],
		[{ kind: "unavailable", failure: "timeout" }, "timeout"],
		[{ kind: "unavailable", failure: "server" }, "server_error"],
	] as const)("observes the actual citation upstream %s status", async (source, upstreamStatus) => {
		// Given: an admitted citation request with one bounded CourtListener source outcome.
		const collector = createExecutionFactCollector();
		const gateway = createCourtListenerCitationGateway({
			api: citationApi(source),
			coordinator: reservedCoordinator(),
			executionFacts: collector,
			now: () => new Date("2026-08-09T12:00:00.000Z"),
			token: () => "opaque-token",
		});

		// When: the gateway performs its sole CourtListener attempt.
		await gateway.lookup({
			normalizedCitation: "347 U.S. 483",
			page: 483,
			reporter: "U.S.",
			volume: 347,
		});

		// Then: the observer gets the sanitized transport classification and closed circuit state.
		expect(collector.snapshot()).toMatchObject({ circuitStatus: "closed", upstreamStatus });
	});

	it.each([
		["quota_limited", "closed", "quota_limited", initialCourtListenerBudgetState()],
		[
			"circuit_open",
			"open",
			"not_called",
			{
				...initialCourtListenerBudgetState(),
				circuits: {
					case_law: { consecutiveFailures: 0, kind: "closed" },
					citation: {
						kind: "open",
						openForMilliseconds: 30_000,
						retryAt: new Date("2026-08-09T12:00:30.000Z"),
					},
				},
			},
		],
	] as const)(
		"observes a citation %s admission without fabricating an upstream attempt",
		async (kind, circuitStatus, upstreamStatus, state) => {
			// Given: an authoritative quota or circuit decision before a CourtListener request starts.
			const collector = createExecutionFactCollector();
			const retryAt = new Date("2026-08-09T12:00:30.000Z");
			const decision: BudgetDecision =
				kind === "quota_limited" ? { kind, retryAt, state } : { kind, retryAt, state };
			const gateway = createCourtListenerCitationGateway({
				api: citationApi({ kind: "absent", normalizedCitation: "347 U.S. 483" }),
				coordinator: coordinatorFor(decision),
				executionFacts: collector,
				now: () => new Date("2026-08-09T12:00:00.000Z"),
				token: () => "opaque-token",
			});

			// When: verification is rejected by the admission boundary.
			await gateway.lookup({
				normalizedCitation: "347 U.S. 483",
				page: 483,
				reporter: "U.S.",
				volume: 347,
			});

			// Then: quota and circuit facts distinguish refusal from an attempted request.
			expect(collector.snapshot()).toMatchObject({ circuitStatus, upstreamStatus });
		},
	);

	it("observes an opinion-cache hit without retaining its source text", async () => {
		// Given: a fresh durable opinion and a collector passed through quote-cache construction.
		const collector = createExecutionFactCollector();
		await readCachedCaseLawOpinion(
			{
				cluster: {
					canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
					id: 123,
					opinionUrls: ["https://www.courtlistener.com/api/rest/v4/opinions/456/"],
				},
				opinionUrl: "https://www.courtlistener.com/api/rest/v4/opinions/456/",
			},
			{
				executionFacts: collector,
				fetch: async () => ({ kind: "missing" }),
				now: () => new Date("2026-08-09T12:00:00.000Z"),
				store: freshOpinionStore(),
				token: () => "owner",
			},
		);

		// When: the quote path resolves its canonical source without a CourtListener request.
		const facts = collector.snapshot();

		// Then: fixed dimensions disclose the cache hit but cannot contain source content.
		expect(facts).toMatchObject({ cacheStatus: "hit", freshness: "fresh" });
		expect(JSON.stringify(facts)).not.toContain("LEGAL_TEXT_CANARY");
	});

	it("observes case-law admission and a malformed CourtListener response", async () => {
		// Given: a reserved case-law request whose sole source response is malformed.
		const collector = createExecutionFactCollector();
		const result = await requestCaseLaw(
			{
				coordinator: reservedCoordinator(),
				executionFacts: collector,
				now: () => new Date("2026-08-09T12:00:00.000Z"),
				quotaApi: { getUsage: async () => ({ kind: "malformed_response" }) },
				token: () => "opaque-token",
			},
			async () => ({ kind: "malformed_response" }),
		);

		// When: the request result returns through the case-law admission seam.
		const facts = collector.snapshot();

		// Then: it preserves the actual circuit and sanitized malformed-response statuses.
		expect(result).toEqual({ kind: "source", source: { kind: "malformed_response" } });
		expect(facts).toMatchObject({
			circuitStatus: "closed",
			upstreamStatus: "malformed_response",
		});
	});
});

function freshCitationStore(): CitationObservationStore {
	return {
		acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
		fillLease: async () => ({ kind: "lease_unavailable" }),
		purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
		read: async () => ({
			kind: "positive",
			positive: {
				cluster: {
					canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
					id: 123,
				},
				kind: "positive",
				retrievedAt: new Date("2026-08-09T12:00:00.000Z"),
			},
		}),
		releaseLease: async () => ({ kind: "lease_unavailable" }),
	};
}

function reservedCoordinator(): CourtListenerCoordinatorRpc {
	const state = initialCourtListenerBudgetState();
	return coordinatorFor({ kind: "reserved", state, token: "reservation" });
}

function coordinatorFor(decision: BudgetDecision): CourtListenerCoordinatorRpc {
	const state = decision.state;
	return {
		admit: async () => decision,
		beginQuotaSync: async () => ({ kind: "not_due", retryAt: new Date(0), state }),
		failQuotaSync: async () => ({ kind: "recorded", state }),
		recordOutcome: async () => ({ kind: "recorded", state }),
		recordQuotaSync: async () => ({ kind: "recorded", state }),
		recordQuotaSyncRateLimited: async () => ({ kind: "recorded", state }),
	};
}

function citationApi(
	lookup: Awaited<ReturnType<CourtListenerApi["lookupCitation"]>>,
): CourtListenerApi {
	return {
		getUsage: async () => ({ kind: "malformed_response" }),
		lookupCitation: async () => lookup,
	};
}

function freshOpinionStore(): OpinionSourceStore {
	const state = {
		kind: "positive" as const,
		positive: {
			contentHash: `sha256:${"a".repeat(64)}`,
			kind: "positive" as const,
			objectKey: `opinions/456/sha256-${"a".repeat(64)}`,
			provenance: {
				canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
				clusterId: 123,
				opinionId: 456,
			},
			representation: "html_with_citations" as const,
			retrievedAt: new Date("2026-08-09T12:00:00.000Z"),
		},
	};
	return {
		acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
		fillLease: async () => ({ kind: "lease_unavailable" }),
		purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
		read: async () => ({ kind: "positive", sourceText: "LEGAL_TEXT_CANARY", state }),
		releaseLease: async () => ({ kind: "released" }),
	};
}
