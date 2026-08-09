import { describe, expect, it } from "vitest";
import type { OpinionSourceReadResult, OpinionSourceStore } from "../cache/opinion-source-store.js";
import {
	type OpinionSourceCacheState,
	purgeExpiredOpinionNegative,
} from "../verification/opinion-source-cache.js";
import type { QuoteCluster } from "../verification/verify-quote.js";
import { readCachedCaseLawOpinion } from "./case-law-opinion-source.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const CLUSTER: QuoteCluster = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	id: 123,
	opinionUrls: ["https://www.courtlistener.com/api/rest/v4/opinions/456/"],
};
const PROVENANCE = {
	canonicalUrl: CLUSTER.canonicalUrl,
	clusterId: CLUSTER.id,
	opinionId: 456,
} as const;

function negative(
	superseded: Extract<OpinionSourceCacheState, { readonly kind: "positive" }>["positive"] | null,
): Extract<OpinionSourceCacheState, { readonly kind: "negative" }> {
	return {
		kind: "negative",
		negative: {
			kind: "negative",
			provenance: PROVENANCE,
			retrievedAt: new Date(NOW.getTime() - DAY),
		},
		superseded,
	};
}

function positive(): Extract<OpinionSourceCacheState, { readonly kind: "positive" }> {
	return {
		kind: "positive",
		positive: {
			kind: "positive",
			provenance: PROVENANCE,
			representation: "html_with_citations",
			contentHash: `sha256:${"a".repeat(64)}`,
			objectKey: "opinions/456/stale",
			retrievedAt: new Date(NOW.getTime() - 31 * DAY),
		},
	};
}

function read(state: OpinionSourceCacheState): OpinionSourceReadResult | null {
	if (state.kind === "empty") return null;
	if (state.kind === "positive")
		return { kind: "positive", state, sourceText: "PRIVATE STALE OPINION" };
	return { kind: "state", state };
}

function request(
	store: OpinionSourceStore,
	fetch: () => Promise<
		{ readonly kind: "missing" } | { readonly kind: "unavailable"; readonly failure: "server" }
	>,
) {
	return readCachedCaseLawOpinion(
		{ cluster: CLUSTER, opinionUrl: CLUSTER.opinionUrls[0] ?? "" },
		{ fetch, now: () => NOW, store, token: () => "owner" },
	);
}

describe("expired opinion negative integration", () => {
	it("purges an expired standalone negative before an unavailable upstream read", async () => {
		let state: OpinionSourceCacheState = negative(null);
		const events: string[] = [];
		const store: OpinionSourceStore = {
			read: async () => read(state),
			acquireLease: async () => ({ kind: "acquired", expiresAt: NOW.toISOString() }),
			purgeExpiredNegativeLease: async (input) => {
				events.push("purge");
				state = purgeExpiredOpinionNegative({ now: input.now, state: input.expected });
				return { kind: "purged", state: state.kind === "empty" ? null : state };
			},
			fillLease: async () => ({ kind: "lease_unavailable" }),
			releaseLease: async () => ({ kind: "released" }),
		};

		const result = await request(store, async () => {
			events.push("fetch");
			return { kind: "unavailable", failure: "server" };
		});

		expect(result).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
		expect(state).toEqual({ kind: "empty" });
		expect(events).toEqual(["purge", "fetch"]);
	});

	it("preserves a superseded positive as reversal pending before revalidation", async () => {
		let state: OpinionSourceCacheState = negative(positive().positive);
		let stateAtFetch: OpinionSourceCacheState | undefined;
		const store: OpinionSourceStore = {
			read: async () => read(state),
			acquireLease: async () => ({ kind: "acquired", expiresAt: NOW.toISOString() }),
			purgeExpiredNegativeLease: async (input) => {
				state = purgeExpiredOpinionNegative({ now: input.now, state: input.expected });
				return { kind: "purged", state: state.kind === "empty" ? null : state };
			},
			fillLease: async () => ({ kind: "lease_unavailable" }),
			releaseLease: async () => ({ kind: "released" }),
		};

		await request(store, async () => {
			stateAtFetch = state;
			return { kind: "unavailable", failure: "server" };
		});

		expect(stateAtFetch?.kind).toBe("reversal_pending");
		expect(state.kind).toBe("reversal_pending");
	});

	it.each(["lease_unavailable", "error"] as const)(
		"fails closed on purge %s without calling upstream",
		async (failure) => {
			let fetches = 0;
			const state = negative(null);
			const store: OpinionSourceStore = {
				read: async () => read(state),
				acquireLease: async () => ({ kind: "acquired", expiresAt: NOW.toISOString() }),
				purgeExpiredNegativeLease: async () => {
					if (failure === "error") throw new Error("D1 unavailable");
					return { kind: "lease_unavailable" };
				},
				fillLease: async () => ({ kind: "lease_unavailable" }),
				releaseLease: async () => ({ kind: "released" }),
			};

			const result = await request(store, async () => {
				fetches += 1;
				return { kind: "missing" };
			});

			expect(result).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
			expect(fetches).toBe(0);
		},
	);

	it("does not stale-fallback after a successful negative whose fill fails", async () => {
		const state = positive();
		const store: OpinionSourceStore = {
			read: async () => read(state),
			acquireLease: async () => ({ kind: "acquired", expiresAt: NOW.toISOString() }),
			purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
			fillLease: async () => {
				throw new Error("D1 write failed");
			},
			releaseLease: async () => ({ kind: "released" }),
		};

		const result = await request(store, async () => ({ kind: "missing" }));

		expect(result).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
	});
});
