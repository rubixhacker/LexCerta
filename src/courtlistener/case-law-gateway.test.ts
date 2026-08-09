import { describe, expect, it } from "vitest";
import type { ClusterCacheStore } from "../cache/cluster-cache-store.js";
import type { OpinionCacheStore } from "../cache/opinion-cache-store.js";
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

function cache(overrides: Partial<OpinionCacheStore> = {}): OpinionCacheStore {
	return {
		acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
		fillLease: async (input) => ({ kind: "stored", opinion: input.opinion }),
		read: async () => null,
		releaseLease: async () => ({ kind: "released" }),
		...overrides,
	};
}

function clusters(overrides: Partial<ClusterCacheStore> = {}): ClusterCacheStore {
	return {
		acquireClusterLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
		fillClusterLease: async (input) => ({
			kind: "stored",
			cluster: { ...input.cluster, freshUntil: new Date(NOW.getTime() + 60_000), retrievedAt: NOW },
		}),
		readCluster: async () => null,
		releaseClusterLease: async () => ({ kind: "released" }),
		...overrides,
	};
}

const quotaApi = { getUsage: async () => ({ kind: "malformed_response" as const }) };

function coordinator(events: string[]): CourtListenerCoordinatorRpc {
	const state = initialCourtListenerBudgetState();
	return {
		admit: async (input) => {
			events.push(`admit:${input.endpoint}`);
			return { kind: "reserved", state, token: "reservation" };
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

describe("CourtListener case-law gateway", () => {
	it("brackets the cluster GET with one case-law reservation and outcome", async () => {
		// Given: a trusted citation cluster and an admitted upstream cluster response.
		const events: string[] = [];
		const api: CourtListenerCaseLawApi = {
			getCluster: async () => {
				events.push("cluster");
				return {
					kind: "found",
					cluster: {
						canonicalUrl: CLUSTER.canonicalUrl,
						id: 123,
						subOpinions: [{ id: 456, url: OPINION_URL }],
					},
				};
			},
			getOpinion: async () => ({ kind: "malformed_response" }),
		};
		const gateway = createCourtListenerCaseLawGateway({
			api,
			clusters: clusters(),
			coordinator: coordinator(events),
			now: () => NOW,
			opinions: cache(),
			quotaApi,
			token: () => "owner",
		});

		// When: quote verification requests the cluster primitive.
		const result = await gateway.readCluster(CLUSTER);

		// Then: exactly the one actual GET is covered by an immediate case-law admission/outcome pair.
		expect(result).toEqual({
			kind: "found",
			cluster: { canonicalUrl: CLUSTER.canonicalUrl, id: 123, opinionUrls: [OPINION_URL] },
		});
		expect(events).toEqual(["admit:case_law", "cluster", "record:success"]);
	});

	it("returns a fresh durable cluster without a reservation or source GET", async () => {
		// Given: a fresh cluster snapshot in D1 and source adapters that would fail if called.
		const events: string[] = [];
		const gateway = createCourtListenerCaseLawGateway({
			api: {
				getCluster: async () => {
					throw new Error("fresh cache must avoid upstream");
				},
				getOpinion: async () => ({ kind: "malformed_response" }),
			},
			clusters: {
				...clusters(),
				readCluster: async () => ({
					canonicalUrl: CLUSTER.canonicalUrl,
					clusterId: CLUSTER.id,
					opinions: [{ id: 456, url: OPINION_URL }],
					retrievedAt: NOW,
					freshUntil: new Date(NOW.getTime() + 1),
				}),
			},
			coordinator: coordinator(events),
			now: () => NOW,
			opinions: cache(),
			quotaApi,
			token: () => "owner",
		});

		// When: quote verification requests the known cluster.
		const result = await gateway.readCluster(CLUSTER);

		// Then: the durable snapshot is returned with no CourtListener accounting activity.
		expect(result).toEqual({
			kind: "found",
			cluster: { canonicalUrl: CLUSTER.canonicalUrl, id: 123, opinionUrls: [OPINION_URL] },
		});
		expect(events).toEqual([]);
	});
});
