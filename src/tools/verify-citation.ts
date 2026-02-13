import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CitationCache } from "../cache/citation-cache";
import type { CitationMatch, CourtListenerClient } from "../clients/courtlistener";
import { parseCitation } from "../parser/index";
import { createToolResponse } from "../types";

export function registerVerifyCitationTool(
	server: McpServer,
	client: CourtListenerClient,
	cache: CitationCache,
): void {
	server.registerTool(
		"verify_west_citation",
		{
			description:
				"Verify whether a West Reporter citation refers to a real case. Returns case metadata if verified, or a 'Hallucination Detected' error if the citation is fabricated. Distinguishes API failures and rate limits from verification failures.",
			inputSchema: {
				citation: z
					.string()
					.min(1)
					.describe("West Reporter citation to verify, e.g., '347 U.S. 483'"),
			},
		},
		async ({ citation }) => {
			// Step 1: Parse locally -- short-circuit before any API call
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

			// Step 1.5: Check cache -- serve instantly if already verified
			const cached = cache.get(normalized);
			if (cached) {
				return classifyMatches(cached.matches, citation, normalized);
			}

			// Step 2: Lookup via CourtListener
			const lookupResult = await client.lookupCitation(normalized);

			// Step 3: Classify response
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

			// status === "ok" -- cache before classifying (only ok responses)
			cache.set(normalized, { matches: lookupResult.matches });
			return classifyMatches(lookupResult.matches, citation, normalized);
		},
	);
}

/** Classify citation matches into verified/not_found response (shared by fresh and cached paths). */
function classifyMatches(matches: CitationMatch[], citation: string, normalized: string) {
	const verifiedMatch = matches.find((match) => match.status === 200 && match.clusters.length > 0);

	if (verifiedMatch) {
		const clusters = verifiedMatch.clusters.map((cluster) => ({
			caseName: cluster.case_name,
			court: cluster.docket.court,
			dateFiled: cluster.date_filed,
			citations: cluster.citations,
			courtListenerUrl: `https://www.courtlistener.com${cluster.absolute_url}`,
		}));

		const primary = clusters[0];
		return createToolResponse({
			valid: true,
			metadata: {
				status: "verified",
				caseName: primary.caseName,
				court: primary.court,
				dateFiled: primary.dateFiled,
				citations: primary.citations,
				courtListenerUrl: primary.courtListenerUrl,
				...(clusters.length > 1 ? { allMatches: clusters } : {}),
			},
			error: null,
		});
	}

	return createToolResponse({
		valid: false,
		metadata: { status: "not_found" },
		error: {
			code: "HALLUCINATION_DETECTED",
			message: `Citation "${citation}" not found in CourtListener database. This citation may be fabricated.`,
			details: {
				queriedCitation: citation,
				normalized,
			},
		},
	});
}
