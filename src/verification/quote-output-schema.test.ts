import { describe, expect, it } from "vitest";
import { verifyQuoteOutputSchema } from "./quote-contract.js";

const verified = {
	outcome: "verified",
	contractVersion: "1",
	evidence: {
		source: "courtlistener",
		normalizedCitation: "347 U.S. 483",
		citationRetrievedAt: "2026-08-09T12:00:00.000Z",
		citationFreshness: "fresh",
		cluster: { id: 101, canonicalUrl: "https://www.courtlistener.com/opinion/101/example/" },
		searchedOpinionCount: 1,
		requiredOpinionCount: 1,
		searchComplete: true,
		searchedOpinions: [
			{
				id: 201,
				canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
				representation: "plain_text",
				retrievedAt: "2026-08-09T12:00:00.000Z",
				freshness: "fresh",
			},
		],
		matchingOpinion: {
			id: 201,
			canonicalUrl: "https://www.courtlistener.com/opinion/101/example/",
		},
		representation: "plain_text",
		retrievedAt: "2026-08-09T12:00:00.000Z",
		freshness: "fresh",
	},
};

describe("verifyQuoteOutputSchema", () => {
	it("rejects content leakage, untrusted URLs, and inconsistent retry shapes", () => {
		// Given: valid metadata-only output and adversarial variants.
		const variants = [
			verified,
			{ ...verified, quote: "leaked customer quote" },
			{ ...verified, evidence: { ...verified.evidence, excerpt: "leaked opinion excerpt" } },
			{ ...verified, evidence: { ...verified.evidence, text: "leaked opinion text" } },
			{
				...verified,
				evidence: {
					...verified.evidence,
					matchingOpinion: { id: 201, canonicalUrl: "http://attacker.invalid/" },
				},
			},
			{
				outcome: "indeterminate",
				contractVersion: "1",
				reason: "unsupported_citation",
				retry: { action: "retry_later" },
			},
			{
				outcome: "indeterminate",
				contractVersion: "1",
				reason: "incomplete",
				retry: { action: "use_supported_citation" },
			},
		];

		// When: parsing the public output variants.
		const results = variants.map((variant) => verifyQuoteOutputSchema.safeParse(variant));

		// Then: only the safe, internally consistent public contract is accepted.
		expect(results.map((result) => result.success)).toEqual([
			true,
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});
});
