import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseCitation } from "../parser/index.js";
import { createToolResponse } from "../types.js";

export function registerParseCitationTool(server: McpServer): void {
	server.registerTool(
		"parse_citation",
		{
			description:
				"Parse a legal citation string into a structured object with volume, reporter, and page. Normalizes common West Reporter format variants to canonical Bluebook forms.",
			inputSchema: {
				citation: z
					.string()
					.min(1)
					.describe("Legal citation string to parse, e.g., '347 U.S. 483'"),
			},
		},
		async ({ citation }) => {
			const result = parseCitation(citation);
			if (result.ok) {
				return createToolResponse({
					valid: true,
					metadata: {
						volume: result.citation.volume,
						reporter: result.citation.reporter,
						page: result.citation.page,
						normalized: result.citation.normalized,
					},
					error: null,
				});
			}
			return createToolResponse({
				valid: false,
				metadata: null,
				error: {
					code: result.error.code,
					message: result.error.message,
				},
			});
		},
	);
}
