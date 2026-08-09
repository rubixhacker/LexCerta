import { describe, expect, it } from "vitest";
import type { ClusterCacheStore } from "../cache/cluster-cache-store.js";
import type { OpinionCacheStore } from "../cache/opinion-cache-store.js";
import type { CourtListenerCluster } from "../verification/verify-citation.js";
import { initialCourtListenerBudgetState } from "./budget.js";
import type { CourtListenerCaseLawApi } from "./case-law-api.js";
import { createCourtListenerCaseLawGateway } from "./case-law-gateway.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const OPINION_URL = "https://www.courtlistener.com/api/rest/v4/opinions/456/";
const CLUSTER: CourtListenerCluster = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	id: 123,
};

function store(overrides: Partial<ClusterCacheStore> = {}): ClusterCacheStore {
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

const opinions: OpinionCacheStore = {
	acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
	fillLease: async (input) => ({ kind: "stored", opinion: input.opinion }),
	read: async () => null,
	releaseLease: async () => ({ kind: "released" }),
};

function coordinator(): CourtListenerCoordinatorRpc {
	const state = initialCourtListenerBudgetState();
	return {
		admit: async () => ({ kind: "reserved", state, token: "reservation" }),
		beginQuotaSync: async () => ({ kind: "not_due", retryAt: NOW, state }),
		failQuotaSync: async () => ({ kind: "recorded", state }),
		recordOutcome: async () => ({ kind: "recorded", state }),
		recordQuotaSync: async () => ({ kind: "recorded", state }),
		recordQuotaSyncRateLimited: async () => ({ kind: "recorded", state }),
	};
}

function gateway(
	clusters: ClusterCacheStore,
	now: () => Date,
	waitForFill?: (delay: number) => Promise<void>,
	getCluster: CourtListenerCaseLawApi["getCluster"] = async () => {
		throw new Error("lease waiter must not fetch");
	},
) {
	return createCourtListenerCaseLawGateway({
		api: {
			getCluster,
			getOpinion: async () => ({ kind: "malformed_response" }),
		},
		clusters,
		coordinator: coordinator(),
		now,
		opinions,
		quotaApi: { getUsage: async () => ({ kind: "malformed_response" }) },
		token: () => "owner",
		...(waitForFill === undefined ? {} : { waitForFill }),
	});
}

function cached(freshUntil = new Date(NOW.getTime() + 60_000)) {
	return {
		canonicalUrl: CLUSTER.canonicalUrl,
		clusterId: CLUSTER.id,
		opinions: [{ id: 456, url: OPINION_URL }],
		retrievedAt: NOW,
		freshUntil,
	};
}

describe("CourtListener cluster cache leases", () => {
	it("waits through clipped exponential rechecks for a held cluster owner", async () => {
		// Given: the owner fills D1 after two bounded waits before expiry.
		let current = NOW;
		let reads = 0;
		const delays: number[] = [];
		const result = await gateway(
			store({
				acquireClusterLease: async () => ({ kind: "held", expiresAt: "2026-08-09T12:00:00.200Z" }),
				readCluster: async () => (++reads === 3 ? cached() : null),
			}),
			() => current,
			async (delay) => {
				delays.push(delay);
				current = new Date(current.getTime() + delay);
			},
		).readCluster(CLUSTER);

		// When: the waiter sees the durable fill before the lease deadline.
		// Then: it uses 50ms then 100ms rechecks and sends no duplicate GET.
		expect(result).toMatchObject({ kind: "found", cluster: { opinionUrls: [OPINION_URL] } });
		expect(delays).toEqual([50, 100]);
	});

	it("stops exactly at held lease expiry without fetching", async () => {
		// Given: the held owner never fills during its 150ms lease.
		let current = NOW;
		const delays: number[] = [];
		const result = await gateway(
			store({
				acquireClusterLease: async () => ({ kind: "held", expiresAt: "2026-08-09T12:00:00.150Z" }),
			}),
			() => current,
			async (delay) => {
				delays.push(delay);
				current = new Date(current.getTime() + delay);
			},
		).readCluster(CLUSTER);

		// When: the deadline is reached.
		// Then: the clipped final delay reaches exact expiry and outcome remains indeterminate.
		expect(result).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
		expect(delays).toEqual([50, 100]);
	});

	it("uses a fresh durable winner after an acquired cluster lease is lost", async () => {
		// Given: the former owner fetches once, loses fill, and a new owner stored a fresh winner.
		let reads = 0;
		const result = await gateway(
			store({
				fillClusterLease: async () => ({ kind: "lease_unavailable" }),
				readCluster: async () => (++reads === 3 ? cached() : null),
			}),
			() => NOW,
			undefined,
			async () => ({
				kind: "found",
				cluster: {
					canonicalUrl: CLUSTER.canonicalUrl,
					id: CLUSTER.id,
					subOpinions: [{ id: 456, url: OPINION_URL }],
				},
			}),
		).readCluster(CLUSTER);

		// When: the store refuses the former owner's lease fill.
		// Then: the stored winner, rather than the former source body, is returned.
		expect(result).toMatchObject({ kind: "found", cluster: { opinionUrls: [OPINION_URL] } });
	});

	it("rejects a stale snapshot after a lost cluster fill", async () => {
		// Given: only a stale durable snapshot remains after the former owner's failed fill.
		let reads = 0;
		const result = await gateway(
			store({
				fillClusterLease: async () => ({ kind: "lease_unavailable" }),
				readCluster: async () => (++reads === 3 ? cached(new Date(NOW.getTime() - 1)) : null),
			}),
			() => NOW,
			undefined,
			async () => ({
				kind: "found",
				cluster: { canonicalUrl: CLUSTER.canonicalUrl, id: CLUSTER.id, subOpinions: [] },
			}),
		).readCluster(CLUSTER);

		// When: no fresh winner can be proven from durable storage.
		// Then: stale membership cannot drive a complete quote search.
		expect(result).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
	});
});
