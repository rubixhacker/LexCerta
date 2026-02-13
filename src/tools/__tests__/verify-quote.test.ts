import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { CitationCache } from "../../cache/citation-cache.js";
import { OpinionCache } from "../../cache/opinion-cache.js";
import type {
	CitationMatch,
	CourtListenerClient,
	LookupResponse,
	OpinionTextResponse,
} from "../../clients/courtlistener.js";
import type { BestMatchResult } from "../../matching/fuzzy-match.js";
import { registerVerifyQuoteTool } from "../verify-quote.js";

vi.mock("../../matching/fuzzy-match.js", () => ({
	matchQuoteAcrossOpinions: vi.fn(),
}));

import { matchQuoteAcrossOpinions } from "../../matching/fuzzy-match.js";
const mockMatchQuote = vi.mocked(matchQuoteAcrossOpinions);

/** Standard verified cluster for reuse across tests */
const VERIFIED_CLUSTER: CitationMatch = {
	citation: "347 U.S. 483",
	normalized_citations: ["347 U.S. 483"],
	start_index: 0,
	end_index: 12,
	status: 200,
	error_message: "",
	clusters: [
		{
			absolute_url: "/opinion/12345/brown-v-board/",
			case_name: "Brown v. Board of Education",
			case_name_short: "Brown",
			date_filed: "1954-05-17",
			docket: { court: "Supreme Court of the United States", court_id: "scotus" },
			citations: [{ volume: 347, reporter: "U.S.", page: "483" }],
		},
	],
};

function captureHandler() {
	let capturedHandler: (args: { citation: string; text: string }) => Promise<unknown>;

	const mockServer = {
		registerTool: (
			_name: string,
			_schema: unknown,
			handler: (args: { citation: string; text: string }) => Promise<unknown>,
		) => {
			capturedHandler = handler;
		},
	} as unknown as McpServer;

	const mockClient = {
		lookupCitation: vi.fn<(citation: string) => Promise<LookupResponse>>(),
		fetchClusterOpinions: vi.fn<(clusterId: number) => Promise<OpinionTextResponse>>(),
	} as unknown as CourtListenerClient;

	const citationCache = new CitationCache();
	const opinionCache = new OpinionCache();

	registerVerifyQuoteTool(mockServer, mockClient, citationCache, opinionCache);

	return {
		// biome-ignore lint/style/noNonNullAssertion: handler is set synchronously in registerTool
		handler: capturedHandler!,
		mockClient,
		citationCache,
		opinionCache,
		lookupCitation: (mockClient as unknown as { lookupCitation: ReturnType<typeof vi.fn> })
			.lookupCitation,
		fetchClusterOpinions: (
			mockClient as unknown as { fetchClusterOpinions: ReturnType<typeof vi.fn> }
		).fetchClusterOpinions,
	};
}

function parseEnvelope(result: unknown) {
	const content = (result as { content: Array<{ text: string }> }).content;
	return JSON.parse(content[0].text);
}

describe("verify_quote_integrity tool", () => {
	it("1. returns PARSE_ERROR for unparseable citation", async () => {
		const { handler, lookupCitation } = captureHandler();

		const result = await handler({ citation: "not a citation", text: "some quote" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("PARSE_ERROR");
		expect(envelope.metadata).toBeNull();
		expect(lookupCitation).not.toHaveBeenCalled();
	});

	it("2. returns CITATION_NOT_FOUND when citation has no verified matches", async () => {
		const { handler, lookupCitation, fetchClusterOpinions } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [
				{
					citation: "999 U.S. 999",
					normalized_citations: [],
					start_index: 0,
					end_index: 12,
					status: 404,
					error_message: "Not found",
					clusters: [],
				} satisfies CitationMatch,
			],
		});

		const result = await handler({ citation: "999 U.S. 999", text: "some quote" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("CITATION_NOT_FOUND");
		expect(envelope.error.message).toContain("citation not found");
		expect(fetchClusterOpinions).not.toHaveBeenCalled();
	});

	it("3. returns RATE_LIMITED on citation lookup rate limit", async () => {
		const { handler, lookupCitation } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "rate_limited",
			retryAfterMs: 720,
		});

		const result = await handler({ citation: "347 U.S. 483", text: "some quote" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("RATE_LIMITED");
		expect(envelope.error.details.retryAfterMs).toBe(720);
	});

	it("4. returns RATE_LIMITED on opinion fetch rate limit", async () => {
		const { handler, lookupCitation, fetchClusterOpinions } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [VERIFIED_CLUSTER],
		});
		fetchClusterOpinions.mockResolvedValue({
			status: "rate_limited",
			retryAfterMs: 500,
		});

		const result = await handler({ citation: "347 U.S. 483", text: "some quote" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("RATE_LIMITED");
		expect(envelope.error.details.retryAfterMs).toBe(500);
	});

	it("5. returns TEXT_UNAVAILABLE when opinions are empty", async () => {
		const { handler, lookupCitation, fetchClusterOpinions } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [VERIFIED_CLUSTER],
		});
		fetchClusterOpinions.mockResolvedValue({
			status: "ok",
			opinions: [],
		});

		const result = await handler({ citation: "347 U.S. 483", text: "some quote" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("TEXT_UNAVAILABLE");
	});

	it("6. returns valid=true with high match score (95)", async () => {
		const { handler, lookupCitation, fetchClusterOpinions } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [VERIFIED_CLUSTER],
		});
		fetchClusterOpinions.mockResolvedValue({
			status: "ok",
			opinions: [
				{
					opinionId: 99,
					type: "010combined",
					plainText: "The opinion text here",
					clusterId: 12345,
				},
			],
		});
		mockMatchQuote.mockReturnValue({
			score: 95,
			classification: "high",
			bestMatchExcerpt: "The opinion text here",
			matchedOpinionId: 99,
			matchedOpinionType: "010combined",
		});

		const result = await handler({
			citation: "347 U.S. 483",
			text: "The opinion text here",
		});
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(true);
		expect(envelope.metadata.status).toBe("quote_verified");
		expect(envelope.metadata.matchScore).toBe(95);
		expect(envelope.metadata.classification).toBe("high");
		expect(envelope.metadata.bestMatchExcerpt).toBe("The opinion text here");
		expect(envelope.metadata.caseName).toBe("Brown v. Board of Education");
		expect(envelope.metadata.court).toBe("Supreme Court of the United States");
		expect(envelope.error).toBeNull();
	});

	it("7. returns valid=false with QUOTE_NOT_FOUND for low match (30)", async () => {
		const { handler, lookupCitation, fetchClusterOpinions } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [VERIFIED_CLUSTER],
		});
		fetchClusterOpinions.mockResolvedValue({
			status: "ok",
			opinions: [
				{
					opinionId: 99,
					type: "010combined",
					plainText: "Completely different text",
					clusterId: 12345,
				},
			],
		});
		mockMatchQuote.mockReturnValue({
			score: 30,
			classification: "low",
			bestMatchExcerpt: "Completely different text",
			matchedOpinionId: 99,
			matchedOpinionType: "010combined",
		});

		const result = await handler({
			citation: "347 U.S. 483",
			text: "A fabricated quote that never appeared",
		});
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("QUOTE_NOT_FOUND");
		expect(envelope.error.message).toContain("score: 30/100");
		expect(envelope.error.details.bestMatchExcerpt).toBe("Completely different text");
		expect(envelope.metadata.matchScore).toBe(30);
	});

	it("8. uses citation cache hit without calling lookupCitation", async () => {
		const { handler, lookupCitation, fetchClusterOpinions, citationCache } = captureHandler();

		// Pre-populate citation cache
		citationCache.set("347 U.S. 483", { matches: [VERIFIED_CLUSTER] });

		fetchClusterOpinions.mockResolvedValue({
			status: "ok",
			opinions: [
				{
					opinionId: 99,
					type: "010combined",
					plainText: "Opinion text",
					clusterId: 12345,
				},
			],
		});
		mockMatchQuote.mockReturnValue({
			score: 95,
			classification: "high",
			bestMatchExcerpt: "Opinion text",
			matchedOpinionId: 99,
			matchedOpinionType: "010combined",
		});

		const result = await handler({ citation: "347 U.S. 483", text: "Opinion text" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(true);
		expect(lookupCitation).not.toHaveBeenCalled();
		expect(fetchClusterOpinions).toHaveBeenCalledWith(12345);
	});

	it("9. uses opinion cache hit without calling fetchClusterOpinions", async () => {
		const { handler, lookupCitation, fetchClusterOpinions, opinionCache } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [VERIFIED_CLUSTER],
		});

		// Pre-populate opinion cache
		opinionCache.set(12345, {
			opinions: [
				{
					opinionId: 99,
					type: "010combined",
					plainText: "Cached opinion text",
					clusterId: 12345,
				},
			],
		});

		mockMatchQuote.mockReturnValue({
			score: 88,
			classification: "medium",
			bestMatchExcerpt: "Cached opinion text",
			matchedOpinionId: 99,
			matchedOpinionType: "010combined",
		});

		const result = await handler({ citation: "347 U.S. 483", text: "Cached opinion text" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(true);
		expect(fetchClusterOpinions).not.toHaveBeenCalled();
		expect(envelope.metadata.matchScore).toBe(88);
	});

	it("10. propagates short quote warning in metadata", async () => {
		const { handler, lookupCitation, fetchClusterOpinions } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [VERIFIED_CLUSTER],
		});
		fetchClusterOpinions.mockResolvedValue({
			status: "ok",
			opinions: [
				{
					opinionId: 99,
					type: "010combined",
					plainText: "Some text",
					clusterId: 12345,
				},
			],
		});
		mockMatchQuote.mockReturnValue({
			score: 92,
			classification: "high",
			bestMatchExcerpt: "Some text",
			matchedOpinionId: 99,
			matchedOpinionType: "010combined",
			shortQuoteWarning: true,
		} as BestMatchResult);

		const result = await handler({ citation: "347 U.S. 483", text: "short" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(true);
		expect(envelope.metadata.warning).toBe(
			"Quote is very short (<20 chars). Match score may be unreliable.",
		);
	});
});
