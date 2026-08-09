import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CONTRACT_VERSION } from "./citation.js";
import {
	type CitationVerificationGateway,
	type VerifyCitationResult,
	verifyCitation,
	verifyCitationToolDefinition,
} from "./verify-citation.js";

const citationInput = z
	.string()
	.min(1)
	.max(256)
	.describe("Case-law citation in volume reporter page form.");

export const verifyQuoteInputSchema = z
	.object({
		citation: citationInput,
		quote: z
			.string()
			.min(20)
			.max(10000)
			.describe("Quoted judicial text to verify without returning its contents."),
	})
	.strict();

export const verificationIndeterminateOutputSchema = z
	.object({
		outcome: z.literal("indeterminate"),
		contractVersion: z.literal(CONTRACT_VERSION),
		reason: z.literal("verification_not_available"),
	})
	.strict();

export type IndeterminateVerificationResult = z.infer<typeof verificationIndeterminateOutputSchema>;

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
	outputSchema: verificationIndeterminateOutputSchema,
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

function quoteIndeterminate(): IndeterminateVerificationResult {
	return {
		outcome: "indeterminate",
		contractVersion: CONTRACT_VERSION,
		reason: "verification_not_available",
	};
}

function quoteToolResponse() {
	return {
		content: [{ type: "text" as const, text: "Verification is not yet available." }],
		structuredContent: quoteIndeterminate(),
		isError: true,
	};
}

export function registerVerificationTools(
	server: McpServer,
	gateway: CitationVerificationGateway,
): void {
	server.registerTool("verify_citation", verifyCitationToolDefinition, async ({ citation }) => {
		try {
			return citationToolResponse(await verifyCitation({ citation }, gateway));
		} catch {
			// no-excuse-ok: catch
			return citationToolResponse(unavailableCitation());
		}
	});
	server.registerTool("verify_quote", verifyQuoteToolDefinition, () => quoteToolResponse());
}
