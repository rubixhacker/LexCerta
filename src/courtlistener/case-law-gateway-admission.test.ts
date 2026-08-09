import { describe, expect, it } from "vitest";
import type { ClusterCacheStore } from "../cache/cluster-cache-store.js";
import type { OpinionCacheStore } from "../cache/opinion-cache-store.js";
import type { CourtListenerCluster } from "../verification/verify-citation.js";
import type { CourtListenerUsage } from "./api.js";
import type { BudgetDecision } from "./budget-contract.js";
import { initialCourtListenerBudgetState } from "./budget.js";
import { createCourtListenerCaseLawGateway } from "./case-law-gateway.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CLUSTER: CourtListenerCluster = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	id: 123,
};
const USAGE: readonly CourtListenerUsage[] = [
	{
		blocked: false,
		limit: 5,
		rate: "minute",
		remaining: 4,
		resetAt: null,
		scope: "user",
		used: 1,
		windowSeconds: 60,
	},
	{
		blocked: false,
		limit: 5,
		rate: "minute",
		remaining: 4,
		resetAt: null,
		scope: "citations",
		used: 1,
		windowSeconds: 60,
	},
	{
		blocked: false,
		limit: 5,
		rate: "minute",
		remaining: 4,
		resetAt: null,
		scope: "api_usage",
		used: 1,
		windowSeconds: 60,
	},
];

const clusters: ClusterCacheStore = {
	acquireClusterLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
	fillClusterLease: async (input) => ({
		kind: "stored",
		cluster: { ...input.cluster, freshUntil: new Date(NOW.getTime() + 60_000), retrievedAt: NOW },
	}),
	readCluster: async () => null,
	releaseClusterLease: async () => ({ kind: "released" }),
};
const opinions: OpinionCacheStore = {
	acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
	fillLease: async (input) => ({ kind: "stored", opinion: input.opinion }),
	read: async () => null,
	releaseLease: async () => ({ kind: "released" }),
};

function coordinator(
	decisions: readonly BudgetDecision[],
	events: string[],
): CourtListenerCoordinatorRpc {
	const state = initialCourtListenerBudgetState();
	let index = 0;
	return {
		admit: async () => {
			events.push("admit");
			return decisions[index++] ?? { kind: "reservation_capacity_exhausted", state };
		},
		beginQuotaSync: async () => {
			events.push("begin-sync");
			return { kind: "started", state };
		},
		failQuotaSync: async () => ({ kind: "recorded", state }),
		recordOutcome: async (input) => {
			events.push(`record:${input.outcome.kind}`);
			return { kind: "recorded", state };
		},
		recordQuotaSync: async () => {
			events.push("complete-sync");
			return { kind: "recorded", state };
		},
		recordQuotaSyncRateLimited: async () => ({ kind: "recorded", state }),
	};
}

describe("case-law gateway admissions", () => {
	it("syncs a cold coordinator before exactly one cluster GET", async () => {
		// Given: a citation cache hit reaches cold case-law quota state followed by an admitted reservation.
		const events: string[] = [];
		const state = initialCourtListenerBudgetState();
		const gateway = createCourtListenerCaseLawGateway({
			api: {
				getCluster: async () => {
					events.push("cluster-get");
					return { kind: "missing" };
				},
				getOpinion: async () => ({ kind: "malformed_response" }),
			},
			clusters,
			coordinator: coordinator(
				[
					{ kind: "sync_required", state },
					{ kind: "reserved", state, token: "reservation" },
				],
				events,
			),
			now: () => NOW,
			opinions,
			quotaApi: {
				getUsage: async () => {
					events.push("usage-get");
					return { kind: "usage", currentUsage: USAGE };
				},
			},
			token: () => "owner",
		});

		// When: the quote gateway reads the verified cluster.
		const result = await gateway.readCluster(CLUSTER);

		// Then: one usage sync precedes one new admission and exactly one source GET.
		expect(result).toEqual({ kind: "indeterminate", reason: "incomplete" });
		expect(events).toEqual([
			"admit",
			"begin-sync",
			"usage-get",
			"complete-sync",
			"admit",
			"cluster-get",
			"record:success",
		]);
	});

	it("preserves circuit retry guidance without calling the cluster API", async () => {
		// Given: case-law admission is circuit-open until a seven-second deadline.
		const state = initialCourtListenerBudgetState();
		const gateway = createCourtListenerCaseLawGateway({
			api: {
				getCluster: async () => {
					throw new Error("open circuit must not fetch");
				},
				getOpinion: async () => ({ kind: "malformed_response" }),
			},
			clusters,
			coordinator: coordinator(
				[{ kind: "circuit_open", retryAt: new Date(NOW.getTime() + 7_000), state }],
				[],
			),
			now: () => NOW,
			opinions,
			quotaApi: { getUsage: async () => ({ kind: "malformed_response" }) },
			token: () => "owner",
		});

		// When: the quote gateway reads the cluster while its circuit is open.
		// Then: the result retains actionable retry timing without transport.
		expect(await gateway.readCluster(CLUSTER)).toEqual({
			kind: "indeterminate",
			reason: "circuit_open",
			retryAfterSeconds: 7,
		});
	});
});
