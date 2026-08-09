import { describe, expect, it } from "vitest";
import type { CourtListenerCluster } from "../verification/verify-citation.js";
import { initialCourtListenerBudgetState } from "./budget.js";
import type { CourtListenerCaseLawApi } from "./case-law-api.js";
import { createCourtListenerCaseLawGateway } from "./case-law-gateway.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CLUSTER: CourtListenerCluster = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	id: 123,
};
const OPINION_URL = "https://www.courtlistener.com/api/rest/v4/opinions/456/";

function coordinator(events: string[]): CourtListenerCoordinatorRpc {
	const state = initialCourtListenerBudgetState();
	return {
		admit: async (input) => {
			events.push(`admit:${input.endpoint}`);
			return { kind: "reserved", state, token: crypto.randomUUID() };
		},
		beginQuotaSync: async () => ({ kind: "not_due", retryAt: NOW, state }),
		failQuotaSync: async () => ({ kind: "recorded", state }),
		recordOutcome: async (input) => {
			events.push(`record:${input.outcome.kind}`);
			return { kind: "recorded", state };
		},
		recordQuotaSync: async () => ({ kind: "recorded", state }),
		recordQuotaSyncRateLimited: async () => ({ kind: "recorded", state }),
	};
}

function gateway(api: CourtListenerCaseLawApi, events: string[]) {
	return createCourtListenerCaseLawGateway({
		api,
		coordinator: coordinator(events),
		now: () => NOW,
		quotaApi: { getUsage: async () => ({ kind: "malformed_response" }) },
		token: () => crypto.randomUUID(),
	});
}

describe("CourtListener case-law gateway", () => {
	it("admits and records each direct cluster and opinion GET", async () => {
		// Given: one complete cluster and one matching opinion source.
		const events: string[] = [];
		const source = gateway(
			{
				getCluster: async () => {
					events.push("cluster-get");
					return {
						kind: "found",
						cluster: {
							canonicalUrl: CLUSTER.canonicalUrl,
							id: CLUSTER.id,
							subOpinions: [{ id: 456, url: OPINION_URL }],
						},
					};
				},
				getOpinion: async () => {
					events.push("opinion-get");
					return {
						kind: "found",
						opinion: { clusterId: CLUSTER.id, htmlWithCitations: "<p>source</p>", id: 456 },
					};
				},
			},
			events,
		);

		// When: quote verification reads both direct primitives.
		const cluster = await source.readCluster(CLUSTER);
		if (cluster.kind !== "found") throw new TypeError("expected a complete cluster");
		const opinion = await source.readOpinion({ cluster: cluster.cluster, opinionUrl: OPINION_URL });

		// Then: every actual GET has its own immediate reservation and recorded outcome.
		expect(opinion).toMatchObject({ kind: "found", opinion: { id: 456 } });
		expect(opinion).not.toHaveProperty("opinion.freshness");
		expect(events).toEqual([
			"admit:case_law",
			"cluster-get",
			"record:success",
			"admit:case_law",
			"opinion-get",
			"record:success",
		]);
	});

	it("rejects cluster and opinion provenance mismatches as incomplete", async () => {
		// Given: source records that do not belong to the citation cluster.
		const source = gateway(
			{
				getCluster: async () => ({
					kind: "found",
					cluster: {
						canonicalUrl: "https://www.courtlistener.com/opinion/999/",
						id: 123,
						subOpinions: [],
					},
				}),
				getOpinion: async () => ({ kind: "found", opinion: { clusterId: 999, id: 456 } }),
			},
			[],
		);

		// When: each mismatched source is read through its public primitive.
		const cluster = await source.readCluster(CLUSTER);
		const opinion = await source.readOpinion({
			cluster: { ...CLUSTER, opinionUrls: [OPINION_URL] },
			opinionUrl: OPINION_URL,
		});

		// Then: neither mismatch can contribute conclusive quote evidence.
		expect(cluster).toEqual({ kind: "indeterminate", reason: "incomplete" });
		expect(opinion).toEqual({ kind: "indeterminate", reason: "incomplete" });
	});
});
