import { describe, expect, it } from "vitest";
import { verifyQuote } from "./verify-quote.js";

const citationGateway = {
	lookup: async () => ({
		kind: "verified" as const,
		cluster: { id: 101, canonicalUrl: "https://www.courtlistener.com/opinion/101/example/" },
		freshness: "fresh" as const,
		retrievedAt: "2026-08-09T12:00:00.000Z",
	}),
};
const opinionUrls = [
	"https://www.courtlistener.com/api/rest/v4/opinions/201/",
	"https://www.courtlistener.com/api/rest/v4/opinions/202/",
] as const;

function quoteGateway(input: {
	readonly calls: string[];
	readonly failedUrl?: string;
	readonly text?: string;
}) {
	return {
		readCluster: async () => ({
			kind: "found" as const,
			cluster: {
				id: 101,
				canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
				opinionUrls,
			},
		}),
		readOpinion: async ({ opinionUrl }: { readonly opinionUrl: string }) => {
			input.calls.push(opinionUrl);
			if (opinionUrl === input.failedUrl)
				return { kind: "indeterminate" as const, reason: "upstream_unavailable" as const };
			return {
				kind: "found" as const,
				opinion: {
					id: opinionUrl.endsWith("202/") ? 202 : 201,
					clusterId: 101,
					canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
					text: { plain_text: input.text ?? "A different sufficiently long judicial opinion." },
					retrievedAt: "2026-08-09T12:00:00.000Z",
					freshness: "fresh" as const,
				},
			};
		},
	};
}

describe("verifyQuote complete-search semantics", () => {
	it("returns not_found only after every opinion was searched with complete metadata", async () => {
		// Given: two available opinions containing no exact normalized quotation.
		const calls: string[] = [];

		// When: all required opinions are searched.
		const result = await verifyQuote(
			{ citation: "347 U.S. 483", quote: "The requested exact long quotation." },
			citationGateway,
			quoteGateway({ calls }),
			{ maxOpinions: 2 },
		);

		// Then: a complete negative carries every searched opinion's metadata.
		expect(result.outcome).toBe("not_found");
		if (result.outcome === "not_found") {
			expect(result.evidence.searchComplete).toBe(true);
			expect(result.evidence.searchedOpinionCount).toBe(2);
			expect(result.evidence.requiredOpinionCount).toBe(2);
			expect(result.evidence.searchedOpinions).toHaveLength(2);
			expect(result.evidence.searchedOpinions.map((opinion) => opinion.id)).toEqual([201, 202]);
		}
		expect(calls).toEqual(opinionUrls);
	});

	it("never converts one failed required opinion into not_found", async () => {
		// Given: the second required opinion cannot be retrieved.
		const calls: string[] = [];

		// When: quote verification reaches that failed opinion.
		const result = await verifyQuote(
			{ citation: "347 U.S. 483", quote: "The requested exact long quotation." },
			citationGateway,
			quoteGateway({ calls, failedUrl: opinionUrls[1] }),
			{ maxOpinions: 2 },
		);

		// Then: the result preserves incompleteness rather than making a negative claim.
		expect(result).toMatchObject({ outcome: "indeterminate", reason: "upstream_unavailable" });
		expect(calls).toEqual(opinionUrls);
	});

	it("accepts exactly the configured bound and rejects an over-bound cluster before opinions", async () => {
		// Given: one cluster with two required opinions and independent request counters.
		const atLimitCalls: string[] = [];
		const overLimitCalls: string[] = [];

		// When: the same cluster is checked at the limit and one below it.
		const [atLimit, overLimit] = await Promise.all([
			verifyQuote(
				{ citation: "347 U.S. 483", quote: "The requested exact long quotation." },
				citationGateway,
				quoteGateway({ calls: atLimitCalls }),
				{ maxOpinions: 2 },
			),
			verifyQuote(
				{ citation: "347 U.S. 483", quote: "The requested exact long quotation." },
				citationGateway,
				quoteGateway({ calls: overLimitCalls }),
				{ maxOpinions: 1 },
			),
		]);

		// Then: only the allowed cluster reaches every required opinion.
		expect(atLimit.outcome).toBe("not_found");
		expect(overLimit).toMatchObject({ outcome: "indeterminate", reason: "cluster_limit_exceeded" });
		expect(atLimitCalls).toEqual(opinionUrls);
		expect(overLimitCalls).toEqual([]);
	});
});
