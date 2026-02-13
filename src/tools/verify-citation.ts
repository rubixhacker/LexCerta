import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CourtListenerClient } from "../clients/courtlistener.js";
import { parseCitation } from "../parser/index.js";
import { createToolResponse } from "../types.js";

export function registerVerifyCitationTool(server: McpServer, client: CourtListenerClient): void {
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

			// Step 2: Lookup via CourtListener
			const lookupResult = await client.lookupCitation(parseResult.citation.normalized);

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

			// status === "ok" -- examine matches
			const verifiedMatch = lookupResult.matches.find(
				(match) => match.status === 200 && match.clusters.length > 0,
			);

			if (verifiedMatch) {
				const clusters = verifiedMatch.clusters.map((cluster) => ({
					caseName: cluster.case_name,
					court: cluster.docket.court,
					dateFiled: cluster.date_filed,
					citations: cluster.citations,
					courtListenerUrl: `https://www.courtlistener.com${cluster.absolute_url}`,
				}));

				// Return first cluster as primary metadata, include all if ambiguous
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

			// No match with status 200 and clusters -- hallucination
			return createToolResponse({
				valid: false,
				metadata: { status: "not_found" },
				error: {
					code: "HALLUCINATION_DETECTED",
					message: `Citation "${citation}" not found in CourtListener database. This citation may be fabricated.`,
					details: {
						queriedCitation: citation,
						normalized: parseResult.citation.normalized,
					},
				},
			});
		},
	);
}
