import type { McpServer } from "@modelcontextprotocol/server";
import { CONTRACT_VERSION } from "./citation.js";
import type { VerifyQuoteResult } from "./quote-contract.js";
import {
	type CitationVerificationGateway,
	type VerifyCitationResult,
	verifyCitation,
	verifyCitationToolDefinition,
} from "./verify-citation.js";
import {
	type QuoteVerificationGateway,
	verifyQuote,
	verifyQuoteInputSchema,
	verifyQuoteOutputSchema,
} from "./verify-quote.js";

export const verifyQuoteToolDefinition = {
	title: "Verify quote",
	description:
		"Check for an exact, safely normalized quote in CourtListener opinion text. A match establishes text presence, not whether the opinion supports an argument or remains good law.",
	inputSchema: verifyQuoteInputSchema,
	outputSchema: verifyQuoteOutputSchema,
	annotations: {
		title: "Verify quote",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
} as const;

function unavailableVerification() {
	return {
		outcome: "indeterminate",
		contractVersion: CONTRACT_VERSION,
		reason: "upstream_unavailable",
		retry: { action: "retry_later" },
	} as const;
}

function citationText(result: VerifyCitationResult): string {
	switch (result.outcome) {
		case "verified":
			return "Citation verification completed.";
		case "not_found":
			return "No supporting citation was found in CourtListener.";
		case "indeterminate":
			return result.reason === "unsupported_citation"
				? "Citation syntax is not supported by LexCerta."
				: "Citation verification is temporarily unavailable.";
	}
}

function citationToolResponse(result: VerifyCitationResult) {
	return {
		content: [{ type: "text" as const, text: citationText(result) }],
		structuredContent: result,
		isError: result.outcome === "indeterminate" && result.reason !== "unsupported_citation",
	};
}

function quoteText(result: VerifyQuoteResult): string {
	switch (result.outcome) {
		case "verified":
			return "Quote verification completed.";
		case "not_found":
			return "No matching quote was found in the complete CourtListener search.";
		case "indeterminate":
			return result.reason === "unsupported_citation"
				? "Citation syntax is not supported by LexCerta."
				: "Quote verification is temporarily unavailable.";
	}
}

function quoteToolResponse(result: VerifyQuoteResult) {
	return {
		content: [{ type: "text" as const, text: quoteText(result) }],
		structuredContent: result,
		isError: result.outcome === "indeterminate" && result.reason !== "unsupported_citation",
	};
}

export function registerVerificationTools(
	server: McpServer,
	citationGateway: CitationVerificationGateway,
	quoteGateway: QuoteVerificationGateway,
): void {
	server.registerTool("verify_citation", verifyCitationToolDefinition, async ({ citation }) => {
		try {
			return citationToolResponse(await verifyCitation({ citation }, citationGateway));
		} catch {
			// Keep adapter errors and request content out of public responses.
			return citationToolResponse(unavailableVerification());
		}
	});
	server.registerTool("verify_quote", verifyQuoteToolDefinition, async ({ citation, quote }) => {
		try {
			return quoteToolResponse(
				await verifyQuote({ citation, quote }, citationGateway, quoteGateway, { maxOpinions: 100 }),
			);
		} catch {
			// Keep adapter errors and request content out of public responses.
			return quoteToolResponse(unavailableVerification());
		}
	});
}
