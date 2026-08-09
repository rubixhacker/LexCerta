import { describe, expect, it } from "vitest";
import type { OpinionSourceStore } from "../cache/opinion-source-store.js";
import {
	type OpinionSourceCacheState,
	recordOpinionSourceObservation,
} from "../verification/opinion-source-cache.js";
import type { QuoteCluster } from "../verification/verify-quote.js";
import { readCachedCaseLawOpinion } from "./case-law-opinion-source.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
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

function positiveState(
	retrievedAt: Date,
): Extract<OpinionSourceCacheState, { readonly kind: "positive" }> {
	return {
		kind: "positive",
		positive: {
			kind: "positive",
			provenance: PROVENANCE,
			representation: "html_with_citations",
			contentHash: `sha256:${"a".repeat(64)}`,
			objectKey: `opinions/456/sha256-${"a".repeat(64)}`,
			retrievedAt,
		},
	};
}

describe("cached CourtListener opinion source", () => {
	it("reuses a fresh durable positive without fetching CourtListener", async () => {
		// Given: a fresh D1/R2-backed canonical opinion representation.
		const state = positiveState(NOW);
		let fetches = 0;
		const store: OpinionSourceStore = {
			read: async () => ({ kind: "positive", state, sourceText: "<p>cached source</p>" }),
			acquireLease: async () => ({ kind: "acquired", expiresAt: NOW.toISOString() }),
			fillLease: async () => ({ kind: "lease_unavailable" }),
			purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
			releaseLease: async () => ({ kind: "lease_unavailable" }),
		};

		// When: quote verification reads the trusted opinion URL.
		const result = await readCachedCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: CLUSTER.opinionUrls[0] ?? "" },
			{
				fetch: async () => {
					fetches += 1;
					return { kind: "missing" };
				},
				now: () => NOW,
				store,
				token: () => "owner-a",
			},
		);

		// Then: the cached representation is disclosed as fresh and no opinion GET occurs.
		expect(result).toEqual({
			kind: "found",
			opinion: {
				canonicalUrl: CLUSTER.canonicalUrl,
				clusterId: CLUSTER.id,
				freshness: "fresh",
				id: 456,
				retrievedAt: NOW.toISOString(),
				text: { html_with_citations: "<p>cached source</p>" },
			},
		});
		expect(fetches).toBe(0);
	});

	it("does not cache a found opinion with no usable representation", async () => {
		// Given: the trusted opinion exists but contains no canonical source representation.
		let fills = 0;
		let releases = 0;
		const store: OpinionSourceStore = {
			read: async () => null,
			acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
			fillLease: async () => {
				fills += 1;
				return { kind: "lease_unavailable" };
			},
			purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
			releaseLease: async () => {
				releases += 1;
				return { kind: "released" };
			},
		};

		// When: the admitted opinion GET returns only identity metadata.
		const result = await readCachedCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: CLUSTER.opinionUrls[0] ?? "" },
			{
				fetch: async () => ({ kind: "found", opinion: { clusterId: 123, id: 456 } }),
				now: () => NOW,
				store,
				token: () => "owner-a",
			},
		);

		// Then: incomplete source text is not persisted as negative evidence.
		expect(result).toEqual({ kind: "indeterminate", reason: "incomplete" });
		expect({ fills, releases }).toEqual({ fills: 0, releases: 1 });
	});

	it("fails closed on a corrupt durable read without spending upstream budget", async () => {
		// Given: the durable cache rejects its metadata or R2 integrity check.
		let fetches = 0;
		const store: OpinionSourceStore = {
			read: async () => {
				throw new TypeError("corrupt fixture");
			},
			acquireLease: async () => ({ kind: "acquired", expiresAt: NOW.toISOString() }),
			fillLease: async () => ({ kind: "lease_unavailable" }),
			purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
			releaseLease: async () => ({ kind: "lease_unavailable" }),
		};

		// When: the opinion is requested through the cache boundary.
		const result = await readCachedCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: CLUSTER.opinionUrls[0] ?? "" },
			{
				fetch: async () => {
					fetches += 1;
					return { kind: "missing" };
				},
				now: () => NOW,
				store,
				token: () => "owner-a",
			},
		);

		// Then: corrupt state is indeterminate and cannot trigger an opinion GET.
		expect(result).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
		expect(fetches).toBe(0);
	});

	it("suppresses retained stale text when a lost fill has a reversal winner", async () => {
		// Given: stale positive text and another owner that wins publication of a negative reversal.
		const staleAt = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000);
		const positive = positiveState(staleAt);
		let current: Awaited<ReturnType<OpinionSourceStore["read"]>> = {
			kind: "positive",
			state: positive,
			sourceText: "<p>retained stale source</p>",
		};
		const reversal = recordOpinionSourceObservation({
			now: NOW,
			state: positive,
			observation: { kind: "negative", provenance: PROVENANCE },
		});
		const store: OpinionSourceStore = {
			read: async () => current,
			acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
			fillLease: async () => {
				if (reversal.kind === "empty" || reversal.kind === "positive")
					return { kind: "lease_unavailable" };
				current = { kind: "state", state: reversal };
				return { kind: "lease_unavailable" };
			},
			purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
			releaseLease: async () => ({ kind: "released" }),
		};

		// When: this former owner observes the same successful negative but loses its lease fill.
		const result = await readCachedCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: CLUSTER.opinionUrls[0] ?? "" },
			{
				fetch: async () => ({ kind: "missing" }),
				now: () => NOW,
				store,
				token: () => "former-owner",
			},
		);

		// Then: the durable reversal wins and stale positive text cannot reappear.
		expect(result).toEqual({ kind: "indeterminate", reason: "source_changed" });
	});
});
