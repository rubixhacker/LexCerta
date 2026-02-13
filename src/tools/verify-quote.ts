import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpinionCache } from "../cache/opinion-cache.js";
import type { CitationCache } from "../cache/citation-cache.js";
import type { CourtListenerClient } from "../clients/courtlistener.js";
import { matchQuoteAcrossOpinions } from "../matching/fuzzy-match.js";
import { parseCitation } from "../parser/index.js";
import { createToolResponse } from "../types.js";

export function registerVerifyQuoteTool(
	server: McpServer,
	client: CourtListenerClient,
	citationCache: CitationCache,
	opinionCache: OpinionCache,
): void {
	server.registerTool(
		"verify_quote_integrity",
		{
			description:
				"Verify that a quoted passage actually appears in a cited court opinion. Returns a match score (0-100), classification (high/medium/low), and the best-matching excerpt from the opinion for comparison. First confirms the citation exists before fetching opinion text.",
			inputSchema: {
				citation: z
					.string()
					.min(1)
					.describe("West Reporter citation, e.g., '347 U.S. 483'"),
				text: z
					.string()
					.min(1)
					.describe("Quoted passage to verify against the opinion text"),
			},
		},
		async ({ citation, text }) => {
			// Step 1: Parse citation
			const parseResult = parseCitation(citation);
			if (!parseResult.ok) {
				return createToolResponse({
					valid: false,
					metadata: null,
					error: {
						code: "PARSE_ERROR",
						message: parseResult.error.message,
					},
				});
			}

			const normalized = parseResult.citation.normalized;

			// Step 2: Verify citation exists
			// Check citation cache first
			let verifiedCluster = null;
			const cached = citationCache.get(normalized);
			if (cached) {
				const verifiedMatch = cached.matches.find(
					(m) => m.status === 200 && m.clusters.length > 0,
				);
				if (verifiedMatch) {
					verifiedCluster = verifiedMatch.clusters[0];
				}
			} else {
				// Cache miss -- call API
				const lookupResult = await client.lookupCitation(normalized);

				if (lookupResult.status === "rate_limited") {
					return createToolResponse({
						valid: false,
						metadata: { status: "rate_limited" },
						error: {
							code: "RATE_LIMITED",
							message: "CourtListener API rate limit reached. Try again later.",
							details: { retryAfterMs: lookupResult.retryAfterMs },
						},
					});
				}

				if (lookupResult.status === "error") {
					return createToolResponse({
						valid: false,
						metadata: { status: "error" },
						error: {
							code: "API_ERROR",
							message:
								"CourtListener API is currently unavailable. This is NOT a citation verification failure.",
							details: { message: lookupResult.message },
						},
					});
				}

				// Cache the ok response
				citationCache.set(normalized, { matches: lookupResult.matches });

				const verifiedMatch = lookupResult.matches.find(
					(m) => m.status === 200 && m.clusters.length > 0,
				);
				if (verifiedMatch) {
					verifiedCluster = verifiedMatch.clusters[0];
				}
			}

			if (!verifiedCluster) {
				return createToolResponse({
					valid: false,
					metadata: { status: "citation_not_found" },
					error: {
						code: "CITATION_NOT_FOUND",
						message:
							"Cannot verify quote: citation not found in CourtListener database.",
					},
				});
			}

			// Step 3: Fetch opinion text
			// Extract cluster ID from absolute_url (e.g., "/opinion/12345/brown-v-board/" -> 12345)
			const urlMatch = verifiedCluster.absolute_url.match(/\/opinion\/(\d+)\//);
			if (!urlMatch) {
				return createToolResponse({
					valid: false,
					metadata: { status: "error" },
					error: {
						code: "API_ERROR",
						message: "Could not extract cluster ID from CourtListener URL.",
					},
				});
			}
			const clusterId = Number.parseInt(urlMatch[1], 10);

			// Check opinion cache first
			const cachedOpinions = opinionCache.get(clusterId);
			let opinions = cachedOpinions?.opinions;

			if (!opinions) {
				const opinionResult = await client.fetchClusterOpinions(clusterId);

				if (opinionResult.status === "rate_limited") {
					return createToolResponse({
						valid: false,
						metadata: { status: "rate_limited" },
						error: {
							code: "RATE_LIMITED",
							message: "CourtListener API rate limit reached. Try again later.",
							details: { retryAfterMs: opinionResult.retryAfterMs },
						},
					});
				}

				if (opinionResult.status === "error") {
					return createToolResponse({
						valid: false,
						metadata: { status: "error" },
						error: {
							code: "API_ERROR",
							message: "CourtListener API is currently unavailable.",
							details: { message: opinionResult.message },
						},
					});
				}

				if (opinionResult.status === "not_found") {
					return createToolResponse({
						valid: false,
						metadata: { status: "text_unavailable" },
						error: {
							code: "TEXT_UNAVAILABLE",
							message: "Opinion text not available for this citation.",
						},
					});
				}

				opinions = opinionResult.opinions;
				// Cache the opinions
				opinionCache.set(clusterId, { opinions });
			}

			if (opinions.length === 0) {
				return createToolResponse({
					valid: false,
					metadata: { status: "text_unavailable" },
					error: {
						code: "TEXT_UNAVAILABLE",
						message: "Opinion text not available for this citation.",
					},
				});
			}

			// Step 4: Fuzzy match
			const result = matchQuoteAcrossOpinions(text, opinions);

			// Step 5: Return result
			return createToolResponse({
				valid: result.score >= 70,
				metadata: {
					status: "quote_verified",
					matchScore: result.score,
					classification: result.classification,
					bestMatchExcerpt: result.bestMatchExcerpt,
					matchedOpinionType: result.matchedOpinionType,
					matchedOpinionId: result.matchedOpinionId,
					caseName: verifiedCluster.case_name,
					court: verifiedCluster.docket.court,
					...(result.shortQuoteWarning
						? {
								warning:
									"Quote is very short (<20 chars). Match score may be unreliable.",
							}
						: {}),
				},
				error:
					result.score < 70
						? {
								code: "QUOTE_NOT_FOUND",
								message: `Quote does not appear to match the cited opinion (score: ${result.score}/100).`,
								details: { bestMatchExcerpt: result.bestMatchExcerpt },
							}
						: null,
			});
		},
	);
}
