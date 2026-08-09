import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
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

const citationInput = z
	.string()
	.min(1)
	.max(256)
	.describe("Case-law citation in volume reporter page form.");

export { verifyQuoteInputSchema } from "./verify-quote.js";

const quoteToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const verifyQuoteToolDefinition = {
	title: "Verify quote",
	description: "Verify quoted judicial text against evidence for a supported case-law citation.",
	inputSchema: verifyQuoteInputSchema,
	outputSchema: verifyQuoteOutputSchema,
	annotations: { title: "Verify quote", ...quoteToolAnnotations },
} as const;

function unavailableCitation(): VerifyCitationResult {
	return {
		outcome: "indeterminate",
		contractVersion: CONTRACT_VERSION,
		reason: "upstream_unavailable",
		retry: { action: "retry_later" },
	};
}

function citationText(result: VerifyCitationResult): string {
	switch (result.outcome) {
		case "verified":
			return "Citation verification completed.";
		case "not_found":
			return "No supporting citation was found in CourtListener.";
		case "indeterminate":
			switch (result.reason) {
				case "unsupported_citation":
					return "Citation syntax is not supported by LexCerta.";
				case "incomplete":
				case "timeout":
				case "upstream_unavailable":
				case "quota_unknown":
				case "source_changed":
				case "rate_limited":
				case "circuit_open":
					return "Citation verification is temporarily unavailable.";
			}
	}
}

function citationToolResponse(result: VerifyCitationResult) {
	return {
		content: [{ type: "text" as const, text: citationText(result) }],
		structuredContent: result,
		isError: result.outcome === "indeterminate" && result.reason !== "unsupported_citation",
	};
}

function quoteIndeterminate(): VerifyQuoteResult {
	return {
		outcome: "indeterminate",
		contractVersion: CONTRACT_VERSION,
		reason: "upstream_unavailable",
		retry: { action: "retry_later" },
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
			// no-excuse-ok: catch
			return citationToolResponse(unavailableCitation());
		}
	});
	server.registerTool("verify_quote", verifyQuoteToolDefinition, async ({ citation, quote }) => {
		try {
			return quoteToolResponse(
				await verifyQuote({ citation, quote }, citationGateway, quoteGateway, { maxOpinions: 100 }),
			);
		} catch {
			// no-excuse-ok: catch
			return quoteToolResponse(quoteIndeterminate());
		}
	});
}
