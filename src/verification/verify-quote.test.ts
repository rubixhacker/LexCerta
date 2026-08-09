import { describe, expect, it } from "vitest";
import { verifyQuote } from "./verify-quote.js";

describe("verifyQuote", () => {
	it("returns verified with metadata-only provenance when the first opinion contains an exact match", async () => {
		// Given: a supported citation and an opinion containing its requested quotation.
		const citationGateway = {
			lookup: async () => ({
				kind: "verified" as const,
				cluster: { id: 101, canonicalUrl: "https://www.courtlistener.com/opinion/101/example/" },
				freshness: "fresh" as const,
				retrievedAt: "2026-08-09T12:00:00.000Z",
			}),
		};
		const quoteGateway = {
			readCluster: async () => ({
				kind: "found" as const,
				cluster: {
					id: 101,
					canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
					opinionUrls: ["https://www.courtlistener.com/api/rest/v4/opinions/201/"] as const,
				},
			}),
			readOpinion: async () => ({
				kind: "found" as const,
				opinion: {
					id: 201,
					clusterId: 101,
					canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
					text: { html_with_citations: "<p>The Court holds that due process applies.</p>" },
					freshness: "fresh" as const,
					retrievedAt: "2026-08-09T12:00:00.000Z",
				},
			}),
		};

		// When: verification searches the cluster.
		const result = await verifyQuote(
			{ citation: "347 U.S. 483", quote: "The Court holds that due process applies." },
			citationGateway,
			quoteGateway,
			{ maxOpinions: 2 },
		);

		// Then: the outcome identifies supporting metadata without legal text.
		expect(result).toEqual({
			outcome: "verified",
			contractVersion: "1",
			evidence: {
				source: "courtlistener",
				normalizedCitation: "347 U.S. 483",
				citationRetrievedAt: "2026-08-09T12:00:00.000Z",
				citationFreshness: "fresh",
				cluster: { id: 101, canonicalUrl: "https://www.courtlistener.com/opinion/101/example/" },
				matchingOpinion: {
					id: 201,
					canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
				},
				representation: "html_with_citations",
				retrievedAt: "2026-08-09T12:00:00.000Z",
				freshness: "fresh",
				searchedOpinionCount: 1,
				requiredOpinionCount: 1,
				searchComplete: true,
				searchedOpinions: [
					{
						id: 201,
						canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
						representation: "html_with_citations",
						retrievedAt: "2026-08-09T12:00:00.000Z",
						freshness: "fresh",
					},
				],
			},
		});
	});

	it("returns source_text_unavailable for a cluster with no opinions", async () => {
		// Given: a verified citation whose required opinion list is empty.
		const citationGateway = {
			lookup: async () => ({
				kind: "verified" as const,
				cluster: { id: 101, canonicalUrl: "https://www.courtlistener.com/opinion/101/example/" },
				freshness: "fresh" as const,
				retrievedAt: "2026-08-09T12:00:00.000Z",
			}),
		};
		const quoteGateway = {
			readCluster: async () => ({
				kind: "found" as const,
				cluster: {
					id: 101,
					canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
					opinionUrls: [] as const,
				},
			}),
			readOpinion: async () => ({ kind: "indeterminate" as const, reason: "incomplete" as const }),
		};

		// When: quote verification processes that cluster.
		const result = await verifyQuote(
			{ citation: "347 U.S. 483", quote: "A sufficiently long quote to verify." },
			citationGateway,
			quoteGateway,
			{ maxOpinions: 2 },
		);

		// Then: it does not turn missing source text into a negative claim.
		expect(result).toEqual({
			outcome: "indeterminate",
			contractVersion: "1",
			reason: "source_text_unavailable",
			retry: { action: "retry_later" },
		});
	});

	it("stops after a later exact match and marks the partial positive search", async () => {
		// Given: a cluster whose second opinion matches and whose third must remain unread.
		const opinionUrls = [
			"https://www.courtlistener.com/api/rest/v4/opinions/201/",
			"https://www.courtlistener.com/api/rest/v4/opinions/202/",
			"https://www.courtlistener.com/api/rest/v4/opinions/203/",
		] as const;
		const requested: string[] = [];
		const citationGateway = {
			lookup: async () => ({
				kind: "verified" as const,
				cluster: { id: 101, canonicalUrl: "https://www.courtlistener.com/opinion/101/example/" },
				freshness: "fresh" as const,
				retrievedAt: "2026-08-09T12:00:00.000Z",
			}),
		};
		const quoteGateway = {
			readCluster: async () => ({
				kind: "found" as const,
				cluster: {
					id: 101,
					canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
					opinionUrls,
				},
			}),
			readOpinion: async ({ opinionUrl }: { readonly opinionUrl: string }) => {
				requested.push(opinionUrl);
				return {
					kind: "found" as const,
					opinion: {
						id: opinionUrl.endsWith("202/") ? 202 : 201,
						clusterId: 101,
						canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
						text: {
							plain_text: opinionUrl.endsWith("202/")
								? "The Court holds this precise long quotation."
								: "A different long opinion without a match.",
						},
						freshness: "fresh" as const,
						retrievedAt: "2026-08-09T12:00:00.000Z",
					},
				};
			},
		};

		// When: verification finds the match in the second required opinion.
		const result = await verifyQuote(
			{ citation: "347 U.S. 483", quote: "The Court holds this precise long quotation." },
			citationGateway,
			quoteGateway,
			{ maxOpinions: 3 },
		);

		// Then: only required opinions through the positive match are read.
		expect(result.outcome).toBe("verified");
		if (result.outcome === "verified") expect(result.evidence.searchComplete).toBe(false);
		expect(requested).toEqual(opinionUrls.slice(0, 2));
	});

	it("preserves supported-citation and retry-after guidance without source reads", async () => {
		// Given: an unsupported citation and a quota-delayed supported citation.
		const unavailableQuoteGateway = {
			readCluster: async () => ({ kind: "indeterminate" as const, reason: "incomplete" as const }),
			readOpinion: async () => ({ kind: "indeterminate" as const, reason: "incomplete" as const }),
		};

		// When: each public input reaches the citation state boundary.
		const [unsupported, delayed] = await Promise.all([
			verifyQuote(
				{ citation: "not a citation", quote: "A sufficiently long quote to verify." },
				{ lookup: async () => ({ kind: "indeterminate" as const, reason: "incomplete" as const }) },
				unavailableQuoteGateway,
				{ maxOpinions: 2 },
			),
			verifyQuote(
				{ citation: "347 U.S. 483", quote: "A sufficiently long quote to verify." },
				{
					lookup: async () => ({
						kind: "indeterminate" as const,
						reason: "rate_limited" as const,
						retryAfterSeconds: 42,
					}),
				},
				unavailableQuoteGateway,
				{ maxOpinions: 2 },
			),
		]);

		// Then: clients receive the precise safe next action and delay.
		expect(unsupported).toEqual({
			outcome: "indeterminate",
			contractVersion: "1",
			reason: "unsupported_citation",
			retry: { action: "use_supported_citation" },
		});
		expect(delayed).toEqual({
			outcome: "indeterminate",
			contractVersion: "1",
			reason: "rate_limited",
			retry: { action: "retry_later", retryAfterSeconds: 42 },
		});
	});
});
