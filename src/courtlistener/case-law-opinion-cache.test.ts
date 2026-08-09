import { describe, expect, it } from "vitest";
import type { OpinionCacheStore } from "../cache/opinion-cache-store.js";
import type { QuoteCluster } from "../verification/verify-quote.js";
import { readCaseLawOpinion } from "./case-law-opinion-cache.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const OPINION_URL = "https://www.courtlistener.com/api/rest/v4/opinions/456/";
const CLUSTER: QuoteCluster = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	id: 123,
	opinionUrls: [OPINION_URL],
};

function cache(overrides: Partial<OpinionCacheStore> = {}): OpinionCacheStore {
	return {
		acquireLease: async () => ({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" }),
		fillLease: async (input) => ({ kind: "stored", opinion: input.opinion }),
		read: async () => null,
		releaseLease: async () => ({ kind: "released" }),
		...overrides,
	};
}

function input(overrides: Partial<Parameters<typeof readCaseLawOpinion>[1]> = {}) {
	return {
		fetch: async () => ({ kind: "malformed_response" as const }),
		now: () => NOW,
		opinions: cache(),
		token: () => "owner",
		...overrides,
	};
}

describe("CourtListener durable opinion cache", () => {
	it("returns a fresh selected representation without calling source", async () => {
		// Given: a fresh raw representation bound to the requested trusted cluster.
		const result = await readCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: OPINION_URL },
			input({
				fetch: async () => {
					throw new Error("fresh cache must avoid source");
				},
				opinions: cache({
					read: async () => ({
						canonicalUrl: CLUSTER.canonicalUrl,
						clusterId: CLUSTER.id,
						freshUntil: new Date(NOW.getTime() + 1),
						opinionId: 456,
						representation: "html_with_citations",
						retrievedAt: NOW,
						sourceText: "<p>Cached source</p>",
					}),
				}),
			}),
		);

		// When: the matching primitive reads the same opinion.
		// Then: no source request occurs and the representation remains authoritative raw source.
		expect(result).toMatchObject({
			kind: "found",
			opinion: { freshness: "fresh", text: { html_with_citations: "<p>Cached source</p>" } },
		});
	});

	it("waits through bounded exponential delays for a held owner fill", async () => {
		// Given: a held lease whose owner fills after the second recheck.
		let current = NOW;
		let reads = 0;
		const delays: number[] = [];
		const result = await readCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: OPINION_URL },
			input({
				fetch: async () => {
					throw new Error("waiter must not fetch");
				},
				now: () => current,
				opinions: cache({
					acquireLease: async () => ({ kind: "held", expiresAt: "2026-08-09T12:00:00.200Z" }),
					read: async () => {
						reads += 1;
						return reads === 3
							? {
									canonicalUrl: CLUSTER.canonicalUrl,
									clusterId: CLUSTER.id,
									freshUntil: new Date(NOW.getTime() + 60_000),
									opinionId: 456,
									representation: "plain_text" as const,
									retrievedAt: NOW,
									sourceText: "Owner-filled source",
								}
							: null;
					},
				}),
				waitForFill: async (delay) => {
					delays.push(delay);
					current = new Date(current.getTime() + delay);
				},
			}),
		);

		// When: the waiter observes the fill before expiry.
		// Then: it uses exponential delays and does not issue a duplicate opinion GET.
		expect(result).toMatchObject({
			kind: "found",
			opinion: { freshness: "fresh", text: { plain_text: "Owner-filled source" } },
		});
		expect(delays).toEqual([50, 100]);
	});

	it("uses a durable winner after its acquired opinion lease is lost", async () => {
		// Given: an owner fetches a source but loses its lease before fill, while the winner writes a row.
		let reads = 0;
		const result = await readCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: OPINION_URL },
			input({
				fetch: async () => ({
					kind: "found",
					opinion: { clusterId: 123, id: 456, plainText: "former-owner source" },
				}),
				opinions: cache({
					fillLease: async () => ({ kind: "lease_unavailable" }),
					read: async () => {
						reads += 1;
						return reads === 3
							? {
									canonicalUrl: CLUSTER.canonicalUrl,
									clusterId: 123,
									freshUntil: new Date(NOW.getTime() + 60_000),
									opinionId: 456,
									representation: "plain_text" as const,
									retrievedAt: NOW,
									sourceText: "winner source",
								}
							: null;
					},
				}),
			}),
		);

		// When: the former owner loses the fill race.
		// Then: its fetched body is discarded in favor of the durable winner.
		expect(result).toMatchObject({
			kind: "found",
			opinion: { text: { plain_text: "winner source" } },
		});
	});

	it("rejects a fresh cached row bound to another cluster", async () => {
		// Given: an opinion ID collision with a fresh cached row from another cluster.
		const result = await readCaseLawOpinion(
			{ cluster: CLUSTER, opinionUrl: OPINION_URL },
			input({
				opinions: cache({
					read: async () => ({
						canonicalUrl: "https://www.courtlistener.com/opinion/999/other/",
						clusterId: 999,
						freshUntil: new Date(NOW.getTime() + 60_000),
						opinionId: 456,
						representation: "plain_text",
						retrievedAt: NOW,
						sourceText: "poisoned",
					}),
				}),
			}),
		);

		// When: the trusted cluster asks for the shared opinion ID.
		// Then: the poisoned row cannot cross-bind and its fallback outcome stays indeterminate.
		expect(result).toEqual({ kind: "indeterminate", reason: "incomplete" });
	});
});
